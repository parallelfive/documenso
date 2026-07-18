import { DocumentDataType, Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';

import { prisma } from '@documenso/prisma';

import { ONE_HOUR, ONE_MINUTE } from '../../constants/time';

export const DOCUMENT_DATA_PRESIGN_REPLAY_WINDOW_MS = ONE_HOUR + 5 * ONE_MINUTE;
export const INTERNAL_SNAPSHOT_ATTACH_GRACE_MS = 15 * ONE_MINUTE;
export const DOCUMENT_DATA_STORAGE_TRANSACTION_TIMEOUT_MS = 35_000;

export const getDocumentDataPresignReplayNotBefore = () =>
  new Date(Date.now() + DOCUMENT_DATA_PRESIGN_REPLAY_WINDOW_MS);

const getDocumentDataStorageKeyLockId = (key: string) =>
  createHash('sha256')
    .update('documenso:document-data-storage:')
    .update(key)
    .digest()
    .readBigInt64BE();

/**
 * Serializes every metadata-reference transition and physical delete for a
 * storage key. Only a one-way hash enters PostgreSQL; object keys never enter
 * advisory-lock statements or lock diagnostics.
 */
export const lockDocumentDataStorageKeys = async ({
  tx,
  keys,
}: {
  tx: Prisma.TransactionClient;
  keys: string[];
}) => {
  const lockIds = [...new Set(keys.map(getDocumentDataStorageKeyLockId))].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );

  for (const lockId of lockIds) {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(${lockId})::text AS "locked"`;
  }
};

/**
 * Uses a literal enum predicate so PostgreSQL can prove both partial indexes
 * apply even after a generic prepared-query plan replaces a custom plan.
 */
export const findLiveDocumentDataStorageReferences = async ({
  tx,
  keys,
}: {
  tx: Prisma.TransactionClient;
  keys: string[];
}): Promise<Array<{ data: string; initialData: string }>> => {
  const uniqueKeys = [...new Set(keys)];

  if (uniqueKeys.length === 0) {
    return [];
  }

  return await tx.$queryRaw<Array<{ data: string; initialData: string }>>`
    SELECT "data", "initialData"
    FROM "DocumentData"
    WHERE "type" = 'S3_PATH'::"DocumentDataType"
      AND "data" IN (${Prisma.join(uniqueKeys)})
    UNION ALL
    SELECT "data", "initialData"
    FROM "DocumentData"
    WHERE "type" = 'S3_PATH'::"DocumentDataType"
      AND "initialData" IN (${Prisma.join(uniqueKeys)})
  `;
};

type StageDocumentDataStorageCleanupOptions = {
  tx: Prisma.TransactionClient;
  documentDataIds: string[];
  notBefore?: Date;
  preserveExistingNotBefore?: boolean;
};

/**
 * Removes unreferenced DocumentData rows and durably stages their S3 objects
 * for deletion in the same transaction.
 *
 * The cleanup outbox is deliberately key-only: database-backed PDF content is
 * deleted with its DocumentData row and is never copied into the outbox.
 */
export const stageDocumentDataStorageCleanup = async ({
  tx,
  documentDataIds,
  notBefore = new Date(),
  preserveExistingNotBefore = true,
}: StageDocumentDataStorageCleanupOptions): Promise<string[]> => {
  const uniqueDocumentDataIds = [...new Set(documentDataIds)];

  if (uniqueDocumentDataIds.length === 0) {
    return [];
  }

  const candidateDocumentData = await tx.documentData.findMany({
    where: {
      id: {
        in: uniqueDocumentDataIds,
      },
      envelopeItem: {
        is: null,
      },
    },
    select: {
      id: true,
      type: true,
      data: true,
      initialData: true,
    },
  });

  if (candidateDocumentData.length === 0) {
    return [];
  }

  const candidateS3Keys = [
    ...new Set(
      candidateDocumentData
        .filter(({ type }) => type === DocumentDataType.S3_PATH)
        .flatMap(({ data, initialData }) => [data, initialData]),
    ),
  ];

  // Key locks are acquired before any row is deleted. Two transactions
  // retiring the final two references to the same key therefore linearize:
  // the second transaction observes the first commit and owns the obligation.
  await lockDocumentDataStorageKeys({
    tx,
    keys: candidateS3Keys,
  });

  const unreferencedDocumentData = await tx.documentData.findMany({
    where: {
      id: {
        in: uniqueDocumentDataIds,
      },
      envelopeItem: {
        is: null,
      },
    },
    select: {
      id: true,
      type: true,
      data: true,
      initialData: true,
    },
  });

  if (unreferencedDocumentData.length === 0) {
    return [];
  }

  const candidateDocumentDataById = new Map(candidateDocumentData.map((item) => [item.id, item]));

  for (const item of unreferencedDocumentData) {
    const candidate = candidateDocumentDataById.get(item.id);

    if (
      !candidate ||
      candidate.type !== item.type ||
      candidate.data !== item.data ||
      candidate.initialData !== item.initialData
    ) {
      throw new Error('Document data changed while acquiring storage cleanup locks');
    }
  }

  const lockedS3Keys = [
    ...new Set(
      unreferencedDocumentData
        .filter(({ type }) => type === DocumentDataType.S3_PATH)
        .flatMap(({ data, initialData }) => [data, initialData]),
    ),
  ];

  if (lockedS3Keys.some((key) => !candidateS3Keys.includes(key))) {
    throw new Error('Document data changed while acquiring storage cleanup locks');
  }

  const deletedDocumentData = await tx.documentData.deleteMany({
    where: {
      id: {
        in: unreferencedDocumentData.map(({ id }) => id),
      },
      envelopeItem: {
        is: null,
      },
    },
  });

  if (deletedDocumentData.count !== unreferencedDocumentData.length) {
    throw new Error('Document data cleanup lost its unreferenced-row guard');
  }

  if (lockedS3Keys.length === 0) {
    return [];
  }

  // A key can be shared by a replacement row through initialData. Only the
  // final metadata reference may stage the physical object for deletion.
  const remainingReferences = await findLiveDocumentDataStorageReferences({
    tx,
    keys: lockedS3Keys,
  });

  const referencedS3Keys = new Set(
    remainingReferences.flatMap(({ data, initialData }) => [data, initialData]),
  );
  const unreferencedS3Keys = lockedS3Keys.filter((key) => !referencedS3Keys.has(key));

  if (unreferencedS3Keys.length === 0) {
    return [];
  }

  const cleanupTaskIds: string[] = [];

  for (const key of unreferencedS3Keys) {
    const existingCleanup = await tx.documentDataStorageCleanup.findUnique({
      where: {
        key,
      },
      select: {
        id: true,
        notBefore: true,
      },
    });

    if (existingCleanup) {
      const nextNotBefore = preserveExistingNotBefore
        ? new Date(Math.max(existingCleanup.notBefore.getTime(), notBefore.getTime()))
        : notBefore;
      const updatedCleanup = await tx.documentDataStorageCleanup.update({
        where: {
          id: existingCleanup.id,
        },
        data: {
          documentDataId: null,
          earlyDeleteEnabled: true,
          earlyDeleteAttemptedAt: null,
          notBefore: nextNotBefore,
        },
        select: {
          id: true,
        },
      });

      cleanupTaskIds.push(updatedCleanup.id);
      continue;
    }

    const createdCleanup = await tx.documentDataStorageCleanup.create({
      data: {
        key,
        notBefore,
        earlyDeleteEnabled: true,
      },
      select: {
        id: true,
      },
    });

    cleanupTaskIds.push(createdCleanup.id);
  }

  return cleanupTaskIds;
};

type CreateProvisionalInternalDocumentDataOptions = {
  type: DocumentDataType;
  data: string;
};

export const reserveInternalSnapshotStorageCleanup = async ({ key }: { key: string }) => {
  await prisma.$transaction(
    async (tx) => {
      await lockDocumentDataStorageKeys({
        tx,
        keys: [key],
      });
      await tx.documentDataStorageCleanup.create({
        data: {
          key,
          notBefore: new Date(Date.now() + INTERNAL_SNAPSHOT_ATTACH_GRACE_MS),
          earlyDeleteEnabled: false,
        },
      });
    },
    {
      timeout: DOCUMENT_DATA_STORAGE_TRANSACTION_TIMEOUT_MS,
    },
  );
};

/**
 * Persists an internal snapshot and binds the cleanup intent that was
 * durably reserved before PutObject began.
 */
export const createProvisionalInternalDocumentData = async ({
  type,
  data,
}: CreateProvisionalInternalDocumentDataOptions) => {
  return await prisma.$transaction(
    async (tx) => {
      if (type === DocumentDataType.S3_PATH) {
        await lockDocumentDataStorageKeys({
          tx,
          keys: [data],
        });
      }

      const documentData = await tx.documentData.create({
        data: {
          type,
          data,
          initialData: data,
        },
      });

      if (type === DocumentDataType.S3_PATH) {
        const boundCleanup = await tx.documentDataStorageCleanup.updateMany({
          where: {
            key: data,
            documentDataId: null,
            earlyDeleteEnabled: false,
          },
          data: {
            documentDataId: documentData.id,
          },
        });

        if (boundCleanup.count !== 1) {
          throw new Error('Internal snapshot cleanup reservation was not available');
        }
      }

      return documentData;
    },
    {
      timeout: DOCUMENT_DATA_STORAGE_TRANSACTION_TIMEOUT_MS,
    },
  );
};

type ReleaseProvisionalDocumentDataStorageCleanupOptions = {
  tx: Prisma.TransactionClient;
  documentDataId: string;
};

/**
 * Successful attachment and provisional-intent cancellation share the same
 * transaction, so the sweeper can never observe a committed attached snapshot
 * with a live deletion intent.
 */
export const releaseProvisionalDocumentDataStorageCleanup = async ({
  tx,
  documentDataId,
}: ReleaseProvisionalDocumentDataStorageCleanupOptions) => {
  const cleanups = await tx.documentDataStorageCleanup.findMany({
    where: {
      documentDataId,
    },
    select: {
      id: true,
      key: true,
    },
    take: 2,
  });

  if (cleanups.length !== 1) {
    throw new Error('Internal snapshot cleanup reservation was not released');
  }

  const [cleanup] = cleanups;

  await lockDocumentDataStorageKeys({
    tx,
    keys: [cleanup.key],
  });

  const releasedCleanup = await tx.documentDataStorageCleanup.deleteMany({
    where: {
      documentDataId,
    },
  });

  if (releasedCleanup.count !== 1) {
    throw new Error('Internal snapshot cleanup reservation was not released');
  }
};

type LockEnvelopeDocumentDataForCleanupOptions = {
  tx: Prisma.TransactionClient;
  envelopeId: string;
};

/**
 * Locks the envelope and each current item before a hard delete captures the
 * attached DocumentData IDs. This serializes atomic send/status transitions
 * and prevents an item swap from escaping cleanup between the read and the
 * envelope cascade.
 */
export const lockEnvelopeDocumentDataForCleanup = async ({
  tx,
  envelopeId,
}: LockEnvelopeDocumentDataForCleanupOptions): Promise<string[]> => {
  const lockedEnvelope = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id"
    FROM "Envelope"
    WHERE "id" = ${envelopeId}
    FOR UPDATE
  `;

  if (lockedEnvelope.length === 0) {
    return [];
  }

  const lockedEnvelopeItems = await tx.$queryRaw<Array<{ documentDataId: string }>>`
    SELECT "documentDataId"
    FROM "EnvelopeItem"
    WHERE "envelopeId" = ${envelopeId}
    ORDER BY "id"
    FOR UPDATE
  `;

  return lockedEnvelopeItems.map(({ documentDataId }) => documentDataId);
};
