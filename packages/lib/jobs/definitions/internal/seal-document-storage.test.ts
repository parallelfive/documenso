import { DocumentDataType, DocumentStatus } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppErrorCode } from '../../../errors/app-error';
import {
  commitPreparedSealDocumentData,
  type PreparedSealDocumentData,
} from './seal-document-storage';

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  queryRaw: vi.fn(),
  documentDataFindMany: vi.fn(),
  documentDataUpdate: vi.fn(),
  envelopeItemUpdateMany: vi.fn(),
  envelopeUpdate: vi.fn(),
  documentAuditLogCreate: vi.fn(),
  lockDocumentDataStorageKeys: vi.fn(),
  releaseProvisionalDocumentDataStorageCleanup: vi.fn(),
  stageDocumentDataStorageCleanup: vi.fn(),
  getDocumentDataPresignReplayNotBefore: vi.fn(),
}));

vi.mock('@documenso/prisma', () => ({
  prisma: {
    $transaction: mocks.transaction,
  },
}));

vi.mock('../../../server-only/document-data/stage-document-data-storage-cleanup', () => ({
  DOCUMENT_DATA_STORAGE_TRANSACTION_TIMEOUT_MS: 35_000,
  getDocumentDataPresignReplayNotBefore: mocks.getDocumentDataPresignReplayNotBefore,
  lockDocumentDataStorageKeys: mocks.lockDocumentDataStorageKeys,
  releaseProvisionalDocumentDataStorageCleanup:
    mocks.releaseProvisionalDocumentDataStorageCleanup,
  stageDocumentDataStorageCleanup: mocks.stageDocumentDataStorageCleanup,
}));

const sourceDocumentData = {
  id: 'source-data-1',
  type: DocumentDataType.S3_PATH,
  data: 'source/current-1.pdf',
  initialData: 'source/original-1.pdf',
};

const preparedDocumentData = {
  id: 'prepared-data-1',
  type: DocumentDataType.S3_PATH,
  data: 'sealed/prepared-1.pdf',
  initialData: 'sealed/prepared-1.pdf',
};

const sourceDocumentData2 = {
  id: 'source-data-2',
  type: DocumentDataType.S3_PATH,
  data: 'source/current-2.pdf',
  initialData: 'source/original-2.pdf',
};

const preparedDocumentData2 = {
  id: 'prepared-data-2',
  type: DocumentDataType.S3_PATH,
  data: 'sealed/prepared-2.pdf',
  initialData: 'sealed/prepared-2.pdf',
};

const firstPreparedItem: PreparedSealDocumentData = {
  envelopeItemId: 'envelope-item-1',
  oldDocumentData: sourceDocumentData,
  newDocumentData: preparedDocumentData,
};

const secondPreparedItem: PreparedSealDocumentData = {
  envelopeItemId: 'envelope-item-2',
  oldDocumentData: sourceDocumentData2,
  newDocumentData: preparedDocumentData2,
};

const envelope = {
  id: 'envelope-1',
  status: DocumentStatus.PENDING,
};

const envelopeCompletedAuditLog = {
  envelopeId: envelope.id,
  type: 'DOCUMENT_COMPLETED',
  data: {},
};

describe('commitPreparedSealDocumentData', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    const tx = {
      $queryRaw: mocks.queryRaw,
      documentData: {
        findMany: mocks.documentDataFindMany,
        update: mocks.documentDataUpdate,
      },
      envelopeItem: {
        updateMany: mocks.envelopeItemUpdateMany,
      },
      envelope: {
        update: mocks.envelopeUpdate,
      },
      documentAuditLog: {
        create: mocks.documentAuditLogCreate,
      },
    };

    mocks.transaction.mockImplementation(
      async (callback: (transaction: typeof tx) => Promise<unknown>) => await callback(tx),
    );
    mocks.queryRaw.mockResolvedValue([{ id: envelope.id, status: envelope.status }]);
    mocks.lockDocumentDataStorageKeys.mockResolvedValue(undefined);
    mocks.documentDataUpdate.mockResolvedValue(preparedDocumentData);
    mocks.releaseProvisionalDocumentDataStorageCleanup.mockResolvedValue(undefined);
    mocks.envelopeItemUpdateMany.mockResolvedValue({ count: 1 });
    mocks.envelopeUpdate.mockResolvedValue(envelope);
    mocks.documentAuditLogCreate.mockResolvedValue(envelopeCompletedAuditLog);
    mocks.stageDocumentDataStorageCleanup.mockResolvedValue(['cleanup-source-1']);
    mocks.getDocumentDataPresignReplayNotBefore.mockReturnValue(
      new Date('2026-07-18T02:05:00.000Z'),
    );
  });

  it('fails closed without partial mutations when the source disappeared before commit', async () => {
    mocks.documentDataFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ ...preparedDocumentData, envelopeItem: null }]);

    await expect(
      commitPreparedSealDocumentData({
        envelope,
        finalEnvelopeStatus: DocumentStatus.COMPLETED,
        preparedDocumentData: [firstPreparedItem],
        envelopeCompletedAuditLog,
      }),
    ).rejects.toMatchObject({
      code: AppErrorCode.CONFLICT,
    });

    expect(mocks.lockDocumentDataStorageKeys).toHaveBeenCalledTimes(1);
    expect(mocks.lockDocumentDataStorageKeys).toHaveBeenCalledWith({
      tx: expect.any(Object),
      keys: [
        sourceDocumentData.data,
        sourceDocumentData.initialData,
        preparedDocumentData.data,
        preparedDocumentData.initialData,
      ],
    });
    expect(mocks.documentDataUpdate).not.toHaveBeenCalled();
    expect(mocks.releaseProvisionalDocumentDataStorageCleanup).not.toHaveBeenCalled();
    expect(mocks.envelopeItemUpdateMany).not.toHaveBeenCalled();
    expect(mocks.stageDocumentDataStorageCleanup).not.toHaveBeenCalled();
    expect(mocks.envelopeUpdate).not.toHaveBeenCalled();
    expect(mocks.documentAuditLogCreate).not.toHaveBeenCalled();
  });

  it('atomically installs a prepared PDF, releases its intent, and retires the source', async () => {
    mocks.documentDataFindMany
      .mockResolvedValueOnce([sourceDocumentData])
      .mockResolvedValueOnce([{ ...preparedDocumentData, envelopeItem: null }]);

    await expect(
      commitPreparedSealDocumentData({
        envelope,
        finalEnvelopeStatus: DocumentStatus.COMPLETED,
        preparedDocumentData: [firstPreparedItem],
        envelopeCompletedAuditLog,
      }),
    ).resolves.toEqual(['cleanup-source-1']);

    expect(mocks.documentDataUpdate).toHaveBeenCalledWith({
      where: {
        id: preparedDocumentData.id,
      },
      data: {
        initialData: sourceDocumentData.initialData,
      },
    });
    expect(mocks.releaseProvisionalDocumentDataStorageCleanup).toHaveBeenCalledWith({
      tx: expect.any(Object),
      documentDataId: preparedDocumentData.id,
    });
    expect(mocks.envelopeItemUpdateMany).toHaveBeenCalledWith({
      where: {
        id: firstPreparedItem.envelopeItemId,
        envelopeId: envelope.id,
        documentDataId: sourceDocumentData.id,
      },
      data: {
        documentDataId: preparedDocumentData.id,
      },
    });
    expect(mocks.stageDocumentDataStorageCleanup).toHaveBeenCalledWith({
      tx: expect.any(Object),
      documentDataIds: [sourceDocumentData.id],
      notBefore: new Date('2026-07-18T02:05:00.000Z'),
    });
    expect(mocks.envelopeUpdate).toHaveBeenCalledWith({
      where: {
        id: envelope.id,
      },
      data: {
        status: DocumentStatus.COMPLETED,
        completedAt: expect.any(Date),
      },
    });
    expect(mocks.documentAuditLogCreate).toHaveBeenCalledWith({
      data: envelopeCompletedAuditLog,
    });
    expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), {
      timeout: 35_000,
    });
    expect(
      mocks.releaseProvisionalDocumentDataStorageCleanup.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.envelopeItemUpdateMany.mock.invocationCallOrder[0] ?? 0);
  });

  it('validates every prepared row before mutation so a partial batch keeps every intent', async () => {
    mocks.documentDataFindMany
      .mockResolvedValueOnce([sourceDocumentData, sourceDocumentData2])
      .mockResolvedValueOnce([{ ...preparedDocumentData, envelopeItem: null }]);

    await expect(
      commitPreparedSealDocumentData({
        envelope,
        finalEnvelopeStatus: DocumentStatus.COMPLETED,
        preparedDocumentData: [firstPreparedItem, secondPreparedItem],
        envelopeCompletedAuditLog,
      }),
    ).rejects.toMatchObject({
      code: AppErrorCode.CONFLICT,
    });

    expect(mocks.lockDocumentDataStorageKeys).toHaveBeenCalledTimes(1);
    expect(mocks.lockDocumentDataStorageKeys).toHaveBeenCalledWith({
      tx: expect.any(Object),
      keys: [
        sourceDocumentData.data,
        sourceDocumentData.initialData,
        preparedDocumentData.data,
        preparedDocumentData.initialData,
        sourceDocumentData2.data,
        sourceDocumentData2.initialData,
        preparedDocumentData2.data,
        preparedDocumentData2.initialData,
      ],
    });
    expect(mocks.documentDataUpdate).not.toHaveBeenCalled();
    expect(mocks.releaseProvisionalDocumentDataStorageCleanup).not.toHaveBeenCalled();
    expect(mocks.envelopeItemUpdateMany).not.toHaveBeenCalled();
    expect(mocks.stageDocumentDataStorageCleanup).not.toHaveBeenCalled();
    expect(mocks.envelopeUpdate).not.toHaveBeenCalled();
    expect(mocks.documentAuditLogCreate).not.toHaveBeenCalled();
  });
});
