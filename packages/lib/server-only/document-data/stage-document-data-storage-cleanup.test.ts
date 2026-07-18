import { DocumentDataType, type Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import {
  lockEnvelopeDocumentDataForCleanup,
  releaseProvisionalDocumentDataStorageCleanup,
  stageDocumentDataStorageCleanup,
} from './stage-document-data-storage-cleanup';

const createTransaction = () => {
  const documentDataFindMany = vi.fn();
  const documentDataDeleteMany = vi.fn();
  const cleanupCreate = vi.fn();
  const cleanupUpdate = vi.fn();
  const cleanupFindUnique = vi.fn();
  const cleanupUpdateMany = vi.fn();
  const cleanupFindMany = vi.fn();
  const cleanupDeleteMany = vi.fn();
  const queryRaw = vi.fn().mockImplementation((query: TemplateStringsArray) =>
    query.join('').includes('FROM "DocumentData"') ? [] : [{ locked: 'locked' }],
  );

  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  const tx = {
    documentData: {
      findMany: documentDataFindMany,
      deleteMany: documentDataDeleteMany,
    },
    documentDataStorageCleanup: {
      create: cleanupCreate,
      update: cleanupUpdate,
      findUnique: cleanupFindUnique,
      updateMany: cleanupUpdateMany,
      findMany: cleanupFindMany,
      deleteMany: cleanupDeleteMany,
    },
    $queryRaw: queryRaw,
  } as unknown as Prisma.TransactionClient;

  return {
    tx,
    documentDataFindMany,
    documentDataDeleteMany,
    cleanupCreate,
    cleanupUpdate,
    cleanupFindUnique,
    cleanupUpdateMany,
    cleanupFindMany,
    cleanupDeleteMany,
    queryRaw,
  };
};

describe('stageDocumentDataStorageCleanup', () => {
  it('deletes unreferenced metadata and durably stages each unique S3 key', async () => {
    const mocks = createTransaction();
    const notBefore = new Date('2030-01-01T01:05:00.000Z');

    const documentData = {
      id: 'data-1',
      type: DocumentDataType.S3_PATH,
      data: 'private/current.pdf',
      initialData: 'private/original.pdf',
    };
    mocks.documentDataFindMany
      .mockResolvedValueOnce([documentData])
      .mockResolvedValueOnce([documentData]);
    mocks.documentDataDeleteMany.mockResolvedValue({ count: 1 });
    mocks.cleanupFindUnique.mockResolvedValue(null);
    mocks.cleanupCreate
      .mockResolvedValueOnce({ id: 'cleanup-1' })
      .mockResolvedValueOnce({ id: 'cleanup-2' });

    await expect(
      stageDocumentDataStorageCleanup({
        tx: mocks.tx,
        documentDataIds: ['data-1', 'data-1'],
        notBefore,
      }),
    ).resolves.toEqual(['cleanup-1', 'cleanup-2']);

    expect(mocks.documentDataDeleteMany).toHaveBeenCalledWith({
      where: {
        id: {
          in: ['data-1'],
        },
        envelopeItem: {
          is: null,
        },
      },
    });
    expect(mocks.cleanupCreate).toHaveBeenNthCalledWith(1, {
      data: {
        key: 'private/current.pdf',
        notBefore,
        earlyDeleteEnabled: true,
      },
      select: {
        id: true,
      },
    });
    expect(mocks.cleanupCreate).toHaveBeenNthCalledWith(2, {
      data: {
        key: 'private/original.pdf',
        notBefore,
        earlyDeleteEnabled: true,
      },
      select: {
        id: true,
      },
    });
  });

  it('never stages a physical key that another DocumentData row still references', async () => {
    const mocks = createTransaction();

    const retiredDocumentData = {
      id: 'retired-data',
      type: DocumentDataType.S3_PATH,
      data: 'shared/original.pdf',
      initialData: 'shared/original.pdf',
    };
    mocks.documentDataFindMany
      .mockResolvedValueOnce([retiredDocumentData])
      .mockResolvedValueOnce([retiredDocumentData]);
    mocks.queryRaw.mockImplementation((query: TemplateStringsArray) =>
      query.join('').includes('FROM "DocumentData"')
        ? [
            {
              data: 'signed/current.pdf',
              initialData: 'shared/original.pdf',
            },
          ]
        : [{ locked: 'locked' }],
    );
    mocks.documentDataDeleteMany.mockResolvedValue({ count: 1 });

    await expect(
      stageDocumentDataStorageCleanup({
        tx: mocks.tx,
        documentDataIds: ['retired-data'],
      }),
    ).resolves.toEqual([]);

    expect(mocks.cleanupCreate).not.toHaveBeenCalled();
    expect(mocks.cleanupFindUnique).not.toHaveBeenCalled();
  });

  it('removes database-backed content without copying it into the key-only outbox', async () => {
    const mocks = createTransaction();

    const documentData = {
      id: 'bytes-data',
      type: DocumentDataType.BYTES_64,
      data: 'base64-pdf-content',
      initialData: 'base64-pdf-content',
    };
    mocks.documentDataFindMany
      .mockResolvedValueOnce([documentData])
      .mockResolvedValueOnce([documentData]);
    mocks.documentDataDeleteMany.mockResolvedValue({ count: 1 });

    await expect(
      stageDocumentDataStorageCleanup({
        tx: mocks.tx,
        documentDataIds: ['bytes-data'],
      }),
    ).resolves.toEqual([]);

    expect(mocks.cleanupCreate).not.toHaveBeenCalled();
    expect(mocks.cleanupFindUnique).not.toHaveBeenCalled();
  });

  it('rolls back instead of losing metadata when its unreferenced guard changes', async () => {
    const mocks = createTransaction();

    const documentData = {
      id: 'raced-data',
      type: DocumentDataType.S3_PATH,
      data: 'private/raced.pdf',
      initialData: 'private/raced.pdf',
    };
    mocks.documentDataFindMany
      .mockResolvedValueOnce([documentData])
      .mockResolvedValueOnce([documentData]);
    mocks.documentDataDeleteMany.mockResolvedValue({ count: 0 });

    await expect(
      stageDocumentDataStorageCleanup({
        tx: mocks.tx,
        documentDataIds: ['raced-data'],
      }),
    ).rejects.toThrow('Document data cleanup lost its unreferenced-row guard');

    expect(mocks.cleanupCreate).not.toHaveBeenCalled();
  });

  it('atomically replaces an existing task generation while its key lock is held', async () => {
    const mocks = createTransaction();
    const existingNotBefore = new Date('2030-01-01T00:30:00.000Z');
    const requestedNotBefore = new Date('2030-01-01T01:05:00.000Z');
    const documentData = {
      id: 'existing-generation-data',
      type: DocumentDataType.S3_PATH,
      data: 'private/existing-generation.pdf',
      initialData: 'private/existing-generation.pdf',
    };
    mocks.documentDataFindMany
      .mockResolvedValueOnce([documentData])
      .mockResolvedValueOnce([documentData]);
    mocks.documentDataDeleteMany.mockResolvedValue({ count: 1 });
    mocks.cleanupFindUnique.mockResolvedValue({
      id: 'cleanup-existing',
      notBefore: existingNotBefore,
    });
    mocks.cleanupUpdate.mockResolvedValue({ id: 'cleanup-existing' });

    await expect(
      stageDocumentDataStorageCleanup({
        tx: mocks.tx,
        documentDataIds: [documentData.id],
        notBefore: requestedNotBefore,
      }),
    ).resolves.toEqual(['cleanup-existing']);

    expect(mocks.cleanupUpdate).toHaveBeenCalledWith({
      where: {
        id: 'cleanup-existing',
      },
      data: {
        documentDataId: null,
        earlyDeleteEnabled: true,
        earlyDeleteAttemptedAt: null,
        notBefore: requestedNotBefore,
      },
      select: {
        id: true,
      },
    });
    expect(mocks.cleanupCreate).not.toHaveBeenCalled();
  });
});

describe('releaseProvisionalDocumentDataStorageCleanup', () => {
  it('requires exactly one bound intent to be released in the attach transaction', async () => {
    const mocks = createTransaction();
    mocks.cleanupFindMany.mockResolvedValue([
      {
        id: 'cleanup-snapshot',
        key: 'private/snapshot.pdf',
      },
    ]);
    mocks.cleanupDeleteMany.mockResolvedValue({ count: 1 });

    await expect(
      releaseProvisionalDocumentDataStorageCleanup({
        tx: mocks.tx,
        documentDataId: 'snapshot-data',
      }),
    ).resolves.toBeUndefined();

    expect(mocks.cleanupDeleteMany).toHaveBeenCalledWith({
      where: {
        documentDataId: 'snapshot-data',
      },
    });
  });

  it('rejects a missing intent so snapshot attachment rolls back', async () => {
    const mocks = createTransaction();
    mocks.cleanupFindMany.mockResolvedValue([]);
    mocks.cleanupDeleteMany.mockResolvedValue({ count: 0 });

    await expect(
      releaseProvisionalDocumentDataStorageCleanup({
        tx: mocks.tx,
        documentDataId: 'snapshot-data',
      }),
    ).rejects.toThrow('Internal snapshot cleanup reservation was not released');
  });

  it('rejects duplicate bound intents instead of masking corruption', async () => {
    const mocks = createTransaction();
    mocks.cleanupFindMany.mockResolvedValue([
      { id: 'cleanup-1', key: 'private/snapshot.pdf' },
      { id: 'cleanup-2', key: 'private/snapshot-copy.pdf' },
    ]);

    await expect(
      releaseProvisionalDocumentDataStorageCleanup({
        tx: mocks.tx,
        documentDataId: 'snapshot-data',
      }),
    ).rejects.toThrow('Internal snapshot cleanup reservation was not released');

    expect(mocks.cleanupDeleteMany).not.toHaveBeenCalled();
  });
});

describe('lockEnvelopeDocumentDataForCleanup', () => {
  it('locks the envelope before returning the exact current item data IDs', async () => {
    const mocks = createTransaction();
    mocks.queryRaw
      .mockResolvedValueOnce([{ id: 'envelope-1' }])
      .mockResolvedValueOnce([
        { documentDataId: 'data-1' },
        { documentDataId: 'data-2' },
      ]);

    await expect(
      lockEnvelopeDocumentDataForCleanup({
        tx: mocks.tx,
        envelopeId: 'envelope-1',
      }),
    ).resolves.toEqual(['data-1', 'data-2']);

    expect(mocks.queryRaw).toHaveBeenCalledTimes(2);
  });

  it('does not inspect item data after a concurrent delete won the envelope lock', async () => {
    const mocks = createTransaction();
    mocks.queryRaw.mockResolvedValueOnce([]);

    await expect(
      lockEnvelopeDocumentDataForCleanup({
        tx: mocks.tx,
        envelopeId: 'envelope-1',
      }),
    ).resolves.toEqual([]);

    expect(mocks.queryRaw).toHaveBeenCalledTimes(1);
  });
});
