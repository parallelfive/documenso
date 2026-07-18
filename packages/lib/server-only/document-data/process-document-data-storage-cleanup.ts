import { DocumentDataType } from '@prisma/client';
import pMap from 'p-map';

import { prisma } from '@documenso/prisma';

import { ONE_MINUTE } from '../../constants/time';
import { deleteS3File } from '../../universal/upload/server-actions';
import { logger } from '../../utils/logger';
import {
  DOCUMENT_DATA_STORAGE_TRANSACTION_TIMEOUT_MS,
  findLiveDocumentDataStorageReferences,
  lockDocumentDataStorageKeys,
} from './stage-document-data-storage-cleanup';

const DEFAULT_CLEANUP_LIMIT = 100;
const MAX_CLEANUP_LIMIT = 500;
const CLEANUP_CONCURRENCY = 4;
const REFERENCED_TASK_RECHECK_MS = 15 * ONE_MINUTE;
export const DOCUMENT_DATA_STORAGE_DELETE_TIMEOUT_MS = 15_000;

export type ProcessDocumentDataStorageCleanupOptions = {
  cleanupIds?: string[];
  limit?: number;
};

export type ProcessDocumentDataStorageCleanupResult = {
  selectedCount: number;
  objectDeleteCount: number;
  acknowledgedCount: number;
  cancelledCount: number;
  deferredCount: number;
  failedCount: number;
};

/**
 * Drains a bounded set of durable S3 cleanup tasks.
 *
 * DeleteObject is idempotent. The outbox row is acknowledged only after the
 * object store succeeds, so a crash or database acknowledgement race safely
 * repeats the delete without losing the key required for retry.
 */
export const processDocumentDataStorageCleanup = async ({
  cleanupIds,
  limit = DEFAULT_CLEANUP_LIMIT,
}: ProcessDocumentDataStorageCleanupOptions = {}): Promise<ProcessDocumentDataStorageCleanupResult> => {
  const boundedLimit = Math.max(1, Math.min(Math.floor(limit), MAX_CLEANUP_LIMIT));
  const uniqueCleanupIds = cleanupIds ? [...new Set(cleanupIds)].slice(0, boundedLimit) : undefined;

  if (uniqueCleanupIds?.length === 0) {
    return {
      selectedCount: 0,
      objectDeleteCount: 0,
      acknowledgedCount: 0,
      cancelledCount: 0,
      deferredCount: 0,
      failedCount: 0,
    };
  }

  const startedAt = new Date();
  const cleanupTasks = await prisma.documentDataStorageCleanup.findMany({
    where: uniqueCleanupIds
      ? {
          id: {
            in: uniqueCleanupIds,
          },
        }
      : {
          OR: [
            {
              notBefore: {
                lte: startedAt,
              },
            },
            {
              earlyDeleteAttemptedAt: null,
              earlyDeleteEnabled: true,
            },
          ],
        },
    orderBy: [{ notBefore: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    take: boundedLimit,
    select: {
      id: true,
      key: true,
      notBefore: true,
      documentDataId: true,
      attemptCount: true,
    },
  });

  const results = await pMap(
    cleanupTasks,
    async (cleanupTask) => {
      try {
        return await prisma.$transaction(
          async (tx) => {
            await lockDocumentDataStorageKeys({
              tx,
              keys: [cleanupTask.key],
            });

            const currentCleanupTask = await tx.documentDataStorageCleanup.findUnique({
              where: {
                id: cleanupTask.id,
              },
              select: {
                id: true,
                key: true,
                notBefore: true,
                documentDataId: true,
              },
            });

            // Selection is intentionally outside the transaction. The key lock
            // may have allowed an older task to be acknowledged and replaced
            // before this worker entered; never act on that later generation.
            if (!currentCleanupTask || currentCleanupTask.key !== cleanupTask.key) {
              return 'cancelled' as const;
            }

            const provisionalDocumentDataId = currentCleanupTask.documentDataId;

            if (provisionalDocumentDataId) {
              const lockedDocumentData = await tx.$queryRaw<Array<{ id: string }>>`
                SELECT "id"
                FROM "DocumentData"
                WHERE "id" = ${provisionalDocumentDataId}
                FOR UPDATE
              `;

              if (lockedDocumentData.length === 0) {
                await tx.documentDataStorageCleanup.updateMany({
                  where: {
                    id: currentCleanupTask.id,
                    documentDataId: provisionalDocumentDataId,
                  },
                  data: {
                    documentDataId: null,
                    earlyDeleteEnabled: true,
                  },
                });
              } else {
                const provisionalDocumentData = await tx.documentData.findUnique({
                  where: {
                    id: provisionalDocumentDataId,
                  },
                  select: {
                    type: true,
                    data: true,
                    initialData: true,
                    envelopeItem: {
                      select: {
                        id: true,
                      },
                    },
                  },
                });

                const isMatchingUnattachedS3Data =
                  provisionalDocumentData?.type === DocumentDataType.S3_PATH &&
                  provisionalDocumentData.envelopeItem === null &&
                  (provisionalDocumentData.data === currentCleanupTask.key ||
                    provisionalDocumentData.initialData === currentCleanupTask.key);

                if (!isMatchingUnattachedS3Data) {
                  await tx.documentDataStorageCleanup.deleteMany({
                    where: {
                      id: currentCleanupTask.id,
                      documentDataId: provisionalDocumentDataId,
                    },
                  });

                  return 'cancelled' as const;
                }

                const retiredDocumentData = await tx.documentData.deleteMany({
                  where: {
                    id: provisionalDocumentDataId,
                    envelopeItem: {
                      is: null,
                    },
                  },
                });

                if (retiredDocumentData.count !== 1) {
                  throw new Error('Provisional snapshot cleanup lost its unreferenced-row guard');
                }

                await tx.documentDataStorageCleanup.updateMany({
                  where: {
                    id: currentCleanupTask.id,
                    documentDataId: provisionalDocumentDataId,
                  },
                  data: {
                    documentDataId: null,
                    earlyDeleteEnabled: true,
                  },
                });
              }
            }

            const liveReferences = await findLiveDocumentDataStorageReferences({
              tx,
              keys: [currentCleanupTask.key],
            });

            if (liveReferences.length > 0) {
              const referencedTaskNotBefore = new Date(
                Math.max(
                  currentCleanupTask.notBefore.getTime(),
                  Date.now() + REFERENCED_TASK_RECHECK_MS,
                ),
              );

              await tx.documentDataStorageCleanup.updateMany({
                where: {
                  id: currentCleanupTask.id,
                  notBefore: {
                    lte: referencedTaskNotBefore,
                  },
                },
                data: {
                  notBefore: referencedTaskNotBefore,
                  earlyDeleteAttemptedAt: new Date(),
                },
              });

              return 'deferred' as const;
            }

            await deleteS3File(currentCleanupTask.key, {
              requestTimeoutMs: DOCUMENT_DATA_STORAGE_DELETE_TIMEOUT_MS,
            });

            if (currentCleanupTask.notBefore <= startedAt) {
              const acknowledgedCleanup = await tx.documentDataStorageCleanup.deleteMany({
                where: {
                  id: currentCleanupTask.id,
                  notBefore: {
                    lte: startedAt,
                  },
                },
              });

              if (acknowledgedCleanup.count === 1) {
                return 'acknowledged' as const;
              }

              const retainedCleanup = await tx.documentDataStorageCleanup.findUnique({
                where: {
                  id: currentCleanupTask.id,
                },
                select: {
                  id: true,
                },
              });

              return retainedCleanup ? ('early-deleted' as const) : ('acknowledged' as const);
            }

            await tx.documentDataStorageCleanup.updateMany({
              where: {
                id: currentCleanupTask.id,
                notBefore: {
                  lte: currentCleanupTask.notBefore,
                },
              },
              data: {
                earlyDeleteAttemptedAt: new Date(),
              },
            });

            return 'early-deleted' as const;
          },
          {
            maxWait: DOCUMENT_DATA_STORAGE_TRANSACTION_TIMEOUT_MS,
            timeout: DOCUMENT_DATA_STORAGE_TRANSACTION_TIMEOUT_MS,
          },
        );
      } catch (error) {
        await prisma.documentDataStorageCleanup
          .updateMany({
            where: {
              id: cleanupTask.id,
            },
            data: {
              attemptCount: {
                increment: 1,
              },
              lastAttemptAt: new Date(),
            },
          })
          .catch(() => {
            // The task remains durable when the acknowledgement database is
            // unavailable. A later sweep will retry the idempotent delete.
          });

        logger.error({
          event: 'document-data-storage-cleanup-failed',
          cleanupId: cleanupTask.id,
          attemptNumber: cleanupTask.attemptCount + 1,
          errorName: error instanceof Error ? error.name : 'UnknownError',
        });

        return 'failed' as const;
      }
    },
    {
      concurrency: CLEANUP_CONCURRENCY,
      stopOnError: false,
    },
  );

  const acknowledgedCount = results.filter((result) => result === 'acknowledged').length;
  const cancelledCount = results.filter((result) => result === 'cancelled').length;
  const earlyDeletedCount = results.filter((result) => result === 'early-deleted').length;
  const deferredCount = results.filter((result) => result === 'deferred').length;
  const failedCount = results.filter((result) => result === 'failed').length;

  return {
    selectedCount: cleanupTasks.length,
    objectDeleteCount: acknowledgedCount + earlyDeletedCount,
    acknowledgedCount,
    cancelledCount,
    deferredCount,
    failedCount,
  };
};

type ProcessDocumentDataStorageCleanupAfterCommitOptions = {
  cleanupIds: string[];
  envelopeId: string;
  event:
    | 'document-admin-deleted'
    | 'document-cancelled'
    | 'document-snapshot-abandoned'
    | 'document-source-retired';
};

/**
 * Tries cleanup before returning from the legal transition, but never reports
 * a committed send/cancellation as rolled back. Failed work remains in the
 * durable outbox for the bounded scheduled sweeper.
 */
export const processDocumentDataStorageCleanupAfterCommit = async ({
  cleanupIds,
  envelopeId,
  event,
}: ProcessDocumentDataStorageCleanupAfterCommitOptions): Promise<void> => {
  if (cleanupIds.length === 0) {
    return;
  }

  try {
    await processDocumentDataStorageCleanup({
      cleanupIds,
      limit: cleanupIds.length,
    });
  } catch (error) {
    logger.error({
      event: 'document-data-storage-cleanup-dispatch-failed',
      sourceEvent: event,
      envelopeId,
      cleanupTaskCount: cleanupIds.length,
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
  }
};
