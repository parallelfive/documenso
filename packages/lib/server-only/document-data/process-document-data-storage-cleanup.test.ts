import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DOCUMENT_DATA_STORAGE_DELETE_TIMEOUT_MS,
  processDocumentDataStorageCleanup,
} from './process-document-data-storage-cleanup';

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  queryRaw: vi.fn(),
  cleanupFindMany: vi.fn(),
  cleanupFindUnique: vi.fn(),
  cleanupDeleteMany: vi.fn(),
  cleanupUpdateMany: vi.fn(),
  documentDataFindUnique: vi.fn(),
  documentDataDeleteMany: vi.fn(),
  deleteS3File: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock('@documenso/prisma', () => ({
  prisma: {
    $transaction: mocks.transaction,
    documentDataStorageCleanup: {
      findMany: mocks.cleanupFindMany,
      findUnique: mocks.cleanupFindUnique,
      deleteMany: mocks.cleanupDeleteMany,
      updateMany: mocks.cleanupUpdateMany,
    },
  },
}));

vi.mock('../../universal/upload/server-actions', () => ({
  deleteS3File: mocks.deleteS3File,
}));

vi.mock('../../utils/logger', () => ({
  logger: {
    error: mocks.loggerError,
  },
}));

describe('processDocumentDataStorageCleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'));
    mocks.documentDataFindUnique.mockResolvedValue(null);
    mocks.documentDataDeleteMany.mockResolvedValue({ count: 1 });
    mocks.deleteS3File.mockResolvedValue(undefined);
    mocks.cleanupDeleteMany.mockResolvedValue({ count: 1 });
    mocks.cleanupUpdateMany.mockResolvedValue({ count: 1 });
    mocks.queryRaw.mockImplementation((query: TemplateStringsArray) =>
      query.join('').includes(`WHERE "type" = 'S3_PATH'::"DocumentDataType"`)
        ? []
        : [{}],
    );
    mocks.transaction.mockImplementation(
      async (callback: (tx: unknown) => Promise<unknown>) =>
        await callback({
          $queryRaw: mocks.queryRaw,
          documentData: {
            findUnique: mocks.documentDataFindUnique,
            deleteMany: mocks.documentDataDeleteMany,
          },
          documentDataStorageCleanup: {
            findUnique: mocks.cleanupFindUnique,
            deleteMany: mocks.cleanupDeleteMany,
            updateMany: mocks.cleanupUpdateMany,
          },
        }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('acknowledges a due task only after its object delete succeeds', async () => {
    const notBefore = new Date('2029-12-31T23:59:59.000Z');
    mocks.cleanupFindMany.mockResolvedValue([
      {
        id: 'cleanup-due',
        key: 'private/due.pdf',
        notBefore,
        attemptCount: 0,
      },
    ]);
    mocks.cleanupFindUnique.mockResolvedValue({
      id: 'cleanup-due',
      key: 'private/due.pdf',
      notBefore,
      documentDataId: null,
    });

    await expect(processDocumentDataStorageCleanup()).resolves.toEqual({
      selectedCount: 1,
      objectDeleteCount: 1,
      acknowledgedCount: 1,
      cancelledCount: 0,
      deferredCount: 0,
      failedCount: 0,
    });

    expect(
      mocks.queryRaw.mock.calls.filter(([query]: [TemplateStringsArray]) =>
        query.join('').includes(`WHERE "type" = 'S3_PATH'::"DocumentDataType"`),
      ),
    ).toHaveLength(1);
    expect(mocks.deleteS3File).toHaveBeenCalledWith('private/due.pdf', {
      requestTimeoutMs: DOCUMENT_DATA_STORAGE_DELETE_TIMEOUT_MS,
    });
    expect(mocks.cleanupDeleteMany).toHaveBeenCalledWith({
      where: {
        id: 'cleanup-due',
        notBefore: {
          lte: new Date('2030-01-01T00:00:00.000Z'),
        },
      },
    });
  });

  it('early-deletes a replayable key, retains its task, then deletes a replay after expiry', async () => {
    const notBefore = new Date('2030-01-01T01:05:00.000Z');
    const objects = new Set(['private/replayable.pdf']);
    mocks.deleteS3File.mockImplementation(async (key: string) => {
      await Promise.resolve();
      objects.delete(key);
    });
    mocks.cleanupFindMany
      .mockResolvedValueOnce([
        {
          id: 'cleanup-replayable',
          key: 'private/replayable.pdf',
          notBefore,
          attemptCount: 0,
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 'cleanup-replayable',
          key: 'private/replayable.pdf',
          notBefore,
          attemptCount: 0,
        },
      ]);
    mocks.cleanupFindUnique.mockResolvedValue({
      id: 'cleanup-replayable',
      key: 'private/replayable.pdf',
      notBefore,
      documentDataId: null,
    });

    await expect(
      processDocumentDataStorageCleanup({
        cleanupIds: ['cleanup-replayable'],
      }),
    ).resolves.toMatchObject({
      objectDeleteCount: 1,
      acknowledgedCount: 0,
    });

    expect(objects.has('private/replayable.pdf')).toBe(false);
    expect(mocks.cleanupDeleteMany).not.toHaveBeenCalled();
    expect(mocks.cleanupUpdateMany).toHaveBeenCalledWith({
      where: {
        id: 'cleanup-replayable',
        notBefore: {
          lte: notBefore,
        },
      },
      data: {
        earlyDeleteAttemptedAt: new Date('2030-01-01T00:00:00.000Z'),
      },
    });

    // A still-valid presigned PUT recreates the same key after the early delete.
    objects.add('private/replayable.pdf');
    vi.setSystemTime(new Date('2030-01-01T01:05:01.000Z'));

    await expect(processDocumentDataStorageCleanup()).resolves.toMatchObject({
      objectDeleteCount: 1,
      acknowledgedCount: 1,
    });

    expect(objects.has('private/replayable.pdf')).toBe(false);
    expect(mocks.cleanupDeleteMany).toHaveBeenCalledWith({
      where: {
        id: 'cleanup-replayable',
        notBefore: {
          lte: new Date('2030-01-01T01:05:01.000Z'),
        },
      },
    });
  });

  it('retains a failed task for retry and never logs its storage key', async () => {
    const notBefore = new Date('2029-12-31T23:59:59.000Z');
    mocks.cleanupFindMany.mockResolvedValue([
      {
        id: 'cleanup-failed',
        key: 'private/never-log-this.pdf',
        notBefore,
        attemptCount: 2,
      },
    ]);
    mocks.cleanupFindUnique.mockResolvedValue({
      id: 'cleanup-failed',
      key: 'private/never-log-this.pdf',
      notBefore,
      documentDataId: null,
    });
    mocks.deleteS3File.mockRejectedValue(new Error('object store unavailable'));

    await expect(processDocumentDataStorageCleanup()).resolves.toEqual({
      selectedCount: 1,
      objectDeleteCount: 0,
      acknowledgedCount: 0,
      cancelledCount: 0,
      deferredCount: 0,
      failedCount: 1,
    });

    expect(mocks.cleanupDeleteMany).not.toHaveBeenCalled();
    expect(mocks.cleanupUpdateMany).toHaveBeenCalledWith({
      where: {
        id: 'cleanup-failed',
      },
      data: {
        attemptCount: {
          increment: 1,
        },
        lastAttemptAt: new Date('2030-01-01T00:00:00.000Z'),
      },
    });
    expect(JSON.stringify(mocks.loggerError.mock.calls)).not.toContain(
      'private/never-log-this.pdf',
    );
  });

  it('defers a live shared key without deleting it or shortening its replay window', async () => {
    const originalNotBefore = new Date('2030-01-01T01:05:00.000Z');
    mocks.cleanupFindMany.mockResolvedValue([
      {
        id: 'cleanup-shared',
        key: 'private/shared.pdf',
        notBefore: originalNotBefore,
        attemptCount: 0,
      },
    ]);
    mocks.cleanupFindUnique.mockResolvedValue({
      id: 'cleanup-shared',
      key: 'private/shared.pdf',
      notBefore: originalNotBefore,
      documentDataId: null,
    });
    mocks.queryRaw.mockImplementation((query: TemplateStringsArray) =>
      query.join('').includes(`WHERE "type" = 'S3_PATH'::"DocumentDataType"`)
        ? [{ data: 'private/shared.pdf', initialData: 'private/shared.pdf' }]
        : [{}],
    );

    await expect(processDocumentDataStorageCleanup()).resolves.toEqual({
      selectedCount: 1,
      objectDeleteCount: 0,
      acknowledgedCount: 0,
      cancelledCount: 0,
      deferredCount: 1,
      failedCount: 0,
    });

    expect(mocks.deleteS3File).not.toHaveBeenCalled();
    expect(mocks.cleanupUpdateMany).toHaveBeenCalledWith({
      where: {
        id: 'cleanup-shared',
        notBefore: {
          lte: originalNotBefore,
        },
      },
      data: {
        notBefore: originalNotBefore,
        earlyDeleteAttemptedAt: new Date('2030-01-01T00:00:00.000Z'),
      },
    });
  });

  it('guards a no-live early marker with the current task generation cutoff', async () => {
    const selectedNotBefore = new Date('2030-01-01T01:05:00.000Z');
    mocks.cleanupFindMany.mockResolvedValue([
      {
        id: 'cleanup-no-live-generation',
        key: 'private/no-live-generation.pdf',
        notBefore: selectedNotBefore,
        attemptCount: 0,
      },
    ]);
    mocks.cleanupFindUnique.mockResolvedValue({
      id: 'cleanup-no-live-generation',
      key: 'private/no-live-generation.pdf',
      notBefore: selectedNotBefore,
      documentDataId: null,
    });

    await expect(processDocumentDataStorageCleanup()).resolves.toEqual({
      selectedCount: 1,
      objectDeleteCount: 1,
      acknowledgedCount: 0,
      cancelledCount: 0,
      deferredCount: 0,
      failedCount: 0,
    });

    expect(mocks.cleanupUpdateMany).toHaveBeenCalledWith({
      where: {
        id: 'cleanup-no-live-generation',
        notBefore: {
          lte: selectedNotBefore,
        },
      },
      data: {
        earlyDeleteAttemptedAt: new Date('2030-01-01T00:00:00.000Z'),
      },
    });
  });

  it('rereads and preserves a task whose cutoff was extended after selection', async () => {
    const selectedNotBefore = new Date('2029-12-31T23:59:59.000Z');
    const currentNotBefore = new Date('2030-01-01T01:05:00.000Z');
    mocks.cleanupFindMany.mockResolvedValue([
      {
        id: 'cleanup-extended',
        key: 'private/extended.pdf',
        notBefore: selectedNotBefore,
        attemptCount: 0,
      },
    ]);
    mocks.cleanupFindUnique.mockResolvedValue({
      id: 'cleanup-extended',
      key: 'private/extended.pdf',
      notBefore: currentNotBefore,
      documentDataId: null,
    });

    await expect(processDocumentDataStorageCleanup()).resolves.toEqual({
      selectedCount: 1,
      objectDeleteCount: 1,
      acknowledgedCount: 0,
      cancelledCount: 0,
      deferredCount: 0,
      failedCount: 0,
    });

    expect(mocks.cleanupDeleteMany).not.toHaveBeenCalled();
    expect(mocks.cleanupUpdateMany).toHaveBeenCalledWith({
      where: {
        id: 'cleanup-extended',
        notBefore: {
          lte: currentNotBefore,
        },
      },
      data: {
        earlyDeleteAttemptedAt: new Date('2030-01-01T00:00:00.000Z'),
      },
    });
  });
});
