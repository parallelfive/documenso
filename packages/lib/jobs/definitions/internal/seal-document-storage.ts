import {
  type DocumentData,
  DocumentDataType,
  type DocumentStatus,
  type Envelope,
  type Prisma,
} from '@prisma/client';

import { prisma } from '@documenso/prisma';

import { AppError, AppErrorCode } from '../../../errors/app-error';
import {
  DOCUMENT_DATA_STORAGE_TRANSACTION_TIMEOUT_MS,
  getDocumentDataPresignReplayNotBefore,
  lockDocumentDataStorageKeys,
  releaseProvisionalDocumentDataStorageCleanup,
  stageDocumentDataStorageCleanup,
} from '../../../server-only/document-data/stage-document-data-storage-cleanup';

export type PreparedSealDocumentData = {
  envelopeItemId: string;
  oldDocumentData: Pick<DocumentData, 'id' | 'type' | 'data' | 'initialData'>;
  newDocumentData: DocumentData;
};

type CommitPreparedSealDocumentDataOptions = {
  envelope: Pick<Envelope, 'id' | 'status'>;
  finalEnvelopeStatus: DocumentStatus;
  preparedDocumentData: PreparedSealDocumentData[];
  envelopeCompletedAuditLog: Prisma.DocumentAuditLogUncheckedCreateInput;
};

/**
 * Atomically installs crash-safe sealed PDFs and retires their old metadata.
 *
 * Envelope-first ordering matches hard delete. Every storage key is then
 * locked in one global order before either source or prepared rows are read.
 */
export const commitPreparedSealDocumentData = async ({
  envelope,
  finalEnvelopeStatus,
  preparedDocumentData,
  envelopeCompletedAuditLog,
}: CommitPreparedSealDocumentDataOptions): Promise<string[]> =>
  await prisma.$transaction(
    async (tx) => {
      const lockedEnvelope = await tx.$queryRaw<Array<{ id: string; status: DocumentStatus }>>`
        SELECT "id", "status"
        FROM "Envelope"
        WHERE "id" = ${envelope.id}
        FOR UPDATE
      `;

      if (lockedEnvelope.length !== 1 || lockedEnvelope[0]?.status !== envelope.status) {
        throw new AppError(AppErrorCode.CONFLICT, {
          message: 'Document changed before it could be sealed',
        });
      }

      await lockDocumentDataStorageKeys({
        tx,
        keys: preparedDocumentData.flatMap(({ oldDocumentData, newDocumentData }) => [
          ...(oldDocumentData.type === DocumentDataType.S3_PATH
            ? [oldDocumentData.data, oldDocumentData.initialData]
            : []),
          ...(newDocumentData.type === DocumentDataType.S3_PATH
            ? [newDocumentData.data, newDocumentData.initialData]
            : []),
        ]),
      });

      const currentSourceDocumentData = await tx.documentData.findMany({
        where: {
          id: {
            in: preparedDocumentData.map(({ oldDocumentData }) => oldDocumentData.id),
          },
        },
        select: {
          id: true,
          type: true,
          data: true,
          initialData: true,
        },
      });
      const currentSourceDocumentDataById = new Map(
        currentSourceDocumentData.map((documentData) => [documentData.id, documentData]),
      );
      const currentPreparedDocumentData = await tx.documentData.findMany({
        where: {
          id: {
            in: preparedDocumentData.map(({ newDocumentData }) => newDocumentData.id),
          },
        },
        select: {
          id: true,
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
      const currentPreparedDocumentDataById = new Map(
        currentPreparedDocumentData.map((documentData) => [documentData.id, documentData]),
      );

      // Validate the entire batch before its first mutation. A duplicate job,
      // expired provisional row, or changed source therefore fails closed.
      for (const { oldDocumentData, newDocumentData } of preparedDocumentData) {
        const currentSource = currentSourceDocumentDataById.get(oldDocumentData.id);
        const currentPrepared = currentPreparedDocumentDataById.get(newDocumentData.id);

        if (
          !currentSource ||
          currentSource.type !== oldDocumentData.type ||
          currentSource.data !== oldDocumentData.data ||
          currentSource.initialData !== oldDocumentData.initialData
        ) {
          throw new AppError(AppErrorCode.CONFLICT, {
            message: 'Document PDF changed before it could be sealed',
          });
        }

        if (
          !currentPrepared ||
          currentPrepared.type !== newDocumentData.type ||
          currentPrepared.data !== newDocumentData.data ||
          currentPrepared.initialData !== newDocumentData.data ||
          currentPrepared.envelopeItem !== null
        ) {
          throw new AppError(AppErrorCode.CONFLICT, {
            message: 'Prepared document PDF changed before it could be sealed',
          });
        }
      }

      for (const { envelopeItemId, oldDocumentData, newDocumentData } of preparedDocumentData) {
        await tx.documentData.update({
          where: {
            id: newDocumentData.id,
          },
          data: {
            initialData: oldDocumentData.initialData,
          },
        });

        if (newDocumentData.type === DocumentDataType.S3_PATH) {
          await releaseProvisionalDocumentDataStorageCleanup({
            tx,
            documentDataId: newDocumentData.id,
          });
        }

        const attachedDocumentData = await tx.envelopeItem.updateMany({
          where: {
            id: envelopeItemId,
            envelopeId: envelope.id,
            documentDataId: oldDocumentData.id,
          },
          data: {
            documentDataId: newDocumentData.id,
          },
        });

        if (attachedDocumentData.count !== 1) {
          throw new AppError(AppErrorCode.CONFLICT, {
            message: 'Document PDF changed before it could be sealed',
          });
        }
      }

      const retiredSourceCleanupIds = await stageDocumentDataStorageCleanup({
        tx,
        documentDataIds: preparedDocumentData.map(({ oldDocumentData }) => oldDocumentData.id),
        notBefore: getDocumentDataPresignReplayNotBefore(),
      });

      await tx.envelope.update({
        where: {
          id: envelope.id,
        },
        data: {
          status: finalEnvelopeStatus,
          completedAt: new Date(),
        },
      });

      await tx.documentAuditLog.create({
        data: envelopeCompletedAuditLog,
      });

      return retiredSourceCleanupIds;
    },
    {
      timeout: DOCUMENT_DATA_STORAGE_TRANSACTION_TIMEOUT_MS,
    },
  );
