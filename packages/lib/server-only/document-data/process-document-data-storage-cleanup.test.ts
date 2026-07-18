import { DocumentDataType } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DOCUMENT_DATA_STORAGE_DELETE_TIMEOUT_MS,
  processDocumentDataStorageCleanup,
} from './process-document-data-storage-cleanup';

const mocks = vi.hoisted(() => ({
  cleanupFindMany: vi.fn(),
  cleanupFindUnique: vi.fn(),
  cleanupDeleteMany: vi.fn(),
  cleanupUpdateMany: vi.fn(),
  documentDataFindFirst: vi.fn(),
  deleteS3File: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock('@documenso/prisma', () => ({
  prisma: {
    documentData: {
      findFirst: mocks.documentDataFindFirst,
    },
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
    mocks.documentDataFindFirst.mockResolvedValue(null);
    mocks.deleteS3File.mockResolvedValue(undefined);
    mocks.cleanupDeleteMany.mockResolvedValue({ count: 1 });
    mocks.cleanupFindUnique.mockResolvedValue(null);
    mocks.cleanupUpdateMany.mockResolvedValue({ count: 1 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('acknowledges a due task only after its object delete succeeds', async () => {
    mocks.cleanupFindMany.mockResolvedValue([
      {
        id: 'cleanup-due',
        key: 'private/due.pdf',
        notBefore: new Date('2029-12-31T23:59:59.000Z'),
        attemptCount: 0,
      },
    ]);

    await expect(processDocumentDataStorageCleanup()).resolves.toEqual({
      selectedCount: 1,
      objectDeleteCount: 1,
      acknowledgedCount: 1,
      cancelledCount: 0,
      deferredCount: 0,
      failedCount: 0,
    });

    expect(mocks.documentDataFindFirst).toHaveBeenCalledWith({
      where: {
        type: DocumentDataType.S3_PATH,
        OR: [{ data: 'private/due.pdf' }, { initialData: 'private/due.pdf' }],
      },
      select: {
        id: true,
      },
    });
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
          notBefore: new Date('2030-01-01T01:05:00.000Z'),
          attemptCount: 0,
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 'cleanup-replayable',
          key: 'private/replayable.pdf',
          notBefore: new Date('2030-01-01T01:05:00.000Z'),
          attemptCount: 0,
        },
      ]);

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
    mocks.cleanupFindMany.mockResolvedValue([
      {
        id: 'cleanup-failed',
        key: 'private/never-log-this.pdf',
        notBefore: new Date('2029-12-31T23:59:59.000Z'),
        attemptCount: 2,
      },
    ]);
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
    mocks.documentDataFindFirst.mockResolvedValue({ id: 'live-data' });

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
          lt: originalNotBefore,
        },
      },
      data: {
        notBefore: originalNotBefore,
      },
    });
    expect(mocks.cleanupUpdateMany).toHaveBeenCalledWith({
      where: {
        id: 'cleanup-shared',
        notBefore: {
          lte: originalNotBefore,
        },
      },
      data: {
        earlyDeleteAttemptedAt: new Date('2030-01-01T00:00:00.000Z'),
      },
    });
  });

  it('keeps a concurrently extended live-reference generation early-eligible', async () => {
    const selectedNotBefore = new Date('2030-01-01T00:01:00.000Z');
    const referencedTaskNotBefore = new Date('2030-01-01T00:15:00.000Z');
    mocks.cleanupFindMany.mockResolvedValue([
      {
        id: 'cleanup-live-reference-extended',
        key: 'private/live-reference-extended.pdf',
        notBefore: selectedNotBefore,
        attemptCount: 0,
      },
    ]);
    mocks.documentDataFindFirst.mockResolvedValue({ id: 'live-data' });
    mocks.cleanupUpdateMany
      .mockResolvedValueOnce({ count: 1 })
      // A concurrent stage extended notBefore beyond this worker's generation.
      .mockResolvedValueOnce({ count: 0 });

    await expect(processDocumentDataStorageCleanup()).resolves.toEqual({
      selectedCount: 1,
      objectDeleteCount: 0,
      acknowledgedCount: 0,
      cancelledCount: 0,
      deferredCount: 1,
      failedCount: 0,
    });

    expect(mocks.cleanupUpdateMany).toHaveBeenNthCalledWith(2, {
      where: {
        id: 'cleanup-live-reference-extended',
        notBefore: {
          lte: referencedTaskNotBefore,
        },
      },
      data: {
        earlyDeleteAttemptedAt: new Date('2030-01-01T00:00:00.000Z'),
      },
    });
    expect(mocks.deleteS3File).not.toHaveBeenCalled();
  });

  it('retains a task whose replay cutoff was concurrently extended after selection', async () => {
    const selectedNotBefore = new Date('2029-12-31T23:59:59.000Z');
    mocks.cleanupFindMany.mockResolvedValue([
      {
        id: 'cleanup-extended',
        key: 'private/extended.pdf',
        notBefore: selectedNotBefore,
        attemptCount: 0,
      },
    ]);
    mocks.cleanupDeleteMany.mockResolvedValue({ count: 0 });
    mocks.cleanupFindUnique.mockResolvedValue({ id: 'cleanup-extended' });

    await expect(processDocumentDataStorageCleanup()).resolves.toEqual({
      selectedCount: 1,
      objectDeleteCount: 1,
      acknowledgedCount: 0,
      cancelledCount: 0,
      deferredCount: 0,
      failedCount: 0,
    });

    expect(mocks.cleanupDeleteMany).toHaveBeenCalledWith({
      where: {
        id: 'cleanup-extended',
        notBefore: {
          lte: new Date('2030-01-01T00:00:00.000Z'),
        },
      },
    });
    expect(mocks.cleanupFindUnique).toHaveBeenCalledWith({
      where: {
        id: 'cleanup-extended',
      },
      select: {
        id: true,
      },
    });
  });
});
