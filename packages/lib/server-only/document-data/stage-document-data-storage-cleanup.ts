import { DocumentDataType, type Prisma } from '@prisma/client';

import { prisma } from '@documenso/prisma';

import { ONE_HOUR, ONE_MINUTE } from '../../constants/time';

export const DOCUMENT_DATA_PRESIGN_REPLAY_WINDOW_MS = ONE_HOUR + 5 * ONE_MINUTE;
export const INTERNAL_SNAPSHOT_ATTACH_GRACE_MS = 15 * ONE_MINUTE;

export const getDocumentDataPresignReplayNotBefore = () =>
  new Date(Date.now() + DOCUMENT_DATA_PRESIGN_REPLAY_WINDOW_MS);

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

  const candidateS3Keys = [
    ...new Set(
      unreferencedDocumentData
        .filter(({ type }) => type === DocumentDataType.S3_PATH)
        .flatMap(({ data, initialData }) => [data, initialData]),
    ),
  ];

  if (candidateS3Keys.length === 0) {
    return [];
  }

  // A key can be shared by a replacement row through initialData. Only the
  // final metadata reference may stage the physical object for deletion.
  const remainingReferences = await tx.documentData.findMany({
    where: {
      type: DocumentDataType.S3_PATH,
      OR: [
        {
          data: {
            in: candidateS3Keys,
          },
        },
        {
          initialData: {
            in: candidateS3Keys,
          },
        },
      ],
    },
    select: {
      data: true,
      initialData: true,
    },
  });

  const referencedS3Keys = new Set(
    remainingReferences.flatMap(({ data, initialData }) => [data, initialData]),
  );
  const unreferencedS3Keys = candidateS3Keys.filter((key) => !referencedS3Keys.has(key));

  if (unreferencedS3Keys.length === 0) {
    return [];
  }

  await tx.documentDataStorageCleanup.createMany({
    data: unreferencedS3Keys.map((key) => ({
      key,
      notBefore,
      earlyDeleteEnabled: true,
    })),
    skipDuplicates: true,
  });

  await tx.documentDataStorageCleanup.updateMany({
    where: {
      key: {
        in: unreferencedS3Keys,
      },
    },
    data: {
      documentDataId: null,
      earlyDeleteEnabled: true,
      earlyDeleteAttemptedAt: null,
      ...(!preserveExistingNotBefore ? { notBefore } : {}),
    },
  });

  if (preserveExistingNotBefore) {
    // A later cancellation can extend an existing task's mandatory
    // final-delete window, but can never shorten one.
    await tx.documentDataStorageCleanup.updateMany({
      where: {
        key: {
          in: unreferencedS3Keys,
        },
        notBefore: {
          lt: notBefore,
        },
      },
      data: {
        notBefore,
        earlyDeleteAttemptedAt: null,
      },
    });
  }

  const cleanupTasks = await tx.documentDataStorageCleanup.findMany({
    where: {
      key: {
        in: unreferencedS3Keys,
      },
    },
    select: {
      id: true,
    },
  });

  return cleanupTasks.map(({ id }) => id);
};

type CreateProvisionalInternalDocumentDataOptions = {
  type: DocumentDataType;
  data: string;
};

export const reserveInternalSnapshotStorageCleanup = async ({ key }: { key: string }) => {
  await prisma.documentDataStorageCleanup.create({
    data: {
      key,
      notBefore: new Date(Date.now() + INTERNAL_SNAPSHOT_ATTACH_GRACE_MS),
      earlyDeleteEnabled: false,
    },
  });
};

/**
 * Persists an internal snapshot and binds the cleanup intent that was
 * durably reserved before PutObject began.
 */
export const createProvisionalInternalDocumentData = async ({
  type,
  data,
}: CreateProvisionalInternalDocumentDataOptions) => {
  return await prisma.$transaction(async (tx) => {
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
  });
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
