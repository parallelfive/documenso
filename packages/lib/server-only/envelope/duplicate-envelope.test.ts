import { DocumentDataType, EnvelopeType } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppErrorCode } from '../../errors/app-error';
import { duplicateEnvelope } from './duplicate-envelope';

const mocks = vi.hoisted(() => ({
  envelopeFindFirst: vi.fn(),
  transaction: vi.fn(),
  queryRaw: vi.fn(),
  sourceDocumentDataFindMany: vi.fn(),
  targetDocumentDataCreate: vi.fn(),
  documentMetaCreate: vi.fn(),
  targetEnvelopeCreate: vi.fn(),
  targetEnvelopeItemCreate: vi.fn(),
  getEnvelopeWhereInput: vi.fn(),
  incrementTemplateId: vi.fn(),
  lockDocumentDataStorageKeys: vi.fn(),
}));

vi.mock('@documenso/prisma', () => ({
  prisma: {
    envelope: {
      findFirst: mocks.envelopeFindFirst,
    },
    $transaction: mocks.transaction,
  },
}));

vi.mock('../document-data/stage-document-data-storage-cleanup', () => ({
  DOCUMENT_DATA_STORAGE_TRANSACTION_TIMEOUT_MS: 35_000,
  lockDocumentDataStorageKeys: mocks.lockDocumentDataStorageKeys,
}));

vi.mock('../envelope/get-envelope-by-id', () => ({
  getEnvelopeWhereInput: mocks.getEnvelopeWhereInput,
}));

vi.mock('../envelope/increment-id', () => ({
  incrementDocumentId: vi.fn(),
  incrementTemplateId: mocks.incrementTemplateId,
}));

vi.mock('../webhooks/trigger/trigger-webhook', () => ({
  triggerWebhook: vi.fn(),
}));

const sourceDocumentData = {
  id: 'source-data',
  type: DocumentDataType.S3_PATH,
  data: 'shared/current.pdf',
  initialData: 'shared/original.pdf',
};

const sourceEnvelope = {
  id: 'source-envelope',
  type: EnvelopeType.DOCUMENT,
  title: 'Source decision',
  userId: 7,
  teamId: 9,
  internalVersion: 2,
  templateType: null,
  publicTitle: null,
  publicDescription: null,
  authOptions: null,
  visibility: 'EVERYONE',
  documentMeta: {
    id: 'source-meta',
    emailSettings: null,
  },
  envelopeItems: [
    {
      id: 'source-item',
      title: 'Decision PDF',
      order: 1,
      documentData: sourceDocumentData,
    },
  ],
  recipients: [],
};

describe('duplicateEnvelope storage-reference linearization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getEnvelopeWhereInput.mockResolvedValue({
      envelopeWhereInput: {
        id: sourceEnvelope.id,
      },
    });
    mocks.envelopeFindFirst.mockResolvedValue(sourceEnvelope);
    mocks.incrementTemplateId.mockResolvedValue({
      templateId: 42,
      formattedTemplateId: 'template_42',
    });
    mocks.lockDocumentDataStorageKeys.mockResolvedValue(undefined);
    mocks.documentMetaCreate.mockResolvedValue({
      id: 'target-meta',
    });
    mocks.targetEnvelopeCreate.mockResolvedValue({
      id: 'target-envelope',
      type: EnvelopeType.TEMPLATE,
      recipients: [],
      documentMeta: {
        id: 'target-meta',
      },
    });
    mocks.targetDocumentDataCreate.mockResolvedValue({
      id: 'target-data',
    });
    mocks.targetEnvelopeItemCreate.mockResolvedValue({
      id: 'target-item',
    });
    mocks.transaction.mockImplementation(
      async (callback: (tx: unknown) => Promise<unknown>) =>
        await callback({
          $queryRaw: mocks.queryRaw,
          documentData: {
            findMany: mocks.sourceDocumentDataFindMany,
            create: mocks.targetDocumentDataCreate,
          },
          documentMeta: {
            create: mocks.documentMetaCreate,
          },
          envelope: {
            create: mocks.targetEnvelopeCreate,
          },
          envelopeItem: {
            create: mocks.targetEnvelopeItemCreate,
          },
        }),
    );
  });

  it('leaves no target partials when hard delete won the source row', async () => {
    mocks.queryRaw.mockResolvedValue([]);

    await expect(
      duplicateEnvelope({
        id: {
          type: 'envelopeId',
          id: sourceEnvelope.id,
        },
        userId: 7,
        teamId: 9,
        overrides: {
          duplicateAsTemplate: true,
          includeRecipients: false,
          includeFields: false,
        },
      }),
    ).rejects.toMatchObject({
      code: AppErrorCode.CONFLICT,
    });

    expect(mocks.lockDocumentDataStorageKeys).toHaveBeenCalledWith({
      tx: expect.any(Object),
      keys: [sourceDocumentData.data, sourceDocumentData.initialData],
    });
    expect(mocks.documentMetaCreate).not.toHaveBeenCalled();
    expect(mocks.targetEnvelopeCreate).not.toHaveBeenCalled();
    expect(mocks.targetDocumentDataCreate).not.toHaveBeenCalled();
    expect(mocks.targetEnvelopeItemCreate).not.toHaveBeenCalled();
  });

  it('rechecks the exact source then creates and attaches its shared-key copy atomically', async () => {
    mocks.queryRaw.mockResolvedValue([{ id: sourceDocumentData.id }]);
    mocks.sourceDocumentDataFindMany.mockResolvedValue([sourceDocumentData]);

    await expect(
      duplicateEnvelope({
        id: {
          type: 'envelopeId',
          id: sourceEnvelope.id,
        },
        userId: 7,
        teamId: 9,
        overrides: {
          duplicateAsTemplate: true,
          includeRecipients: false,
          includeFields: false,
        },
      }),
    ).resolves.toMatchObject({
      id: 'target-envelope',
      legacyId: {
        type: EnvelopeType.TEMPLATE,
        id: 42,
      },
    });

    expect(mocks.sourceDocumentDataFindMany).toHaveBeenCalledWith({
      where: {
        id: {
          in: [sourceDocumentData.id],
        },
      },
      select: {
        id: true,
        type: true,
        data: true,
        initialData: true,
      },
    });
    expect(mocks.targetDocumentDataCreate).toHaveBeenCalledWith({
      data: {
        type: DocumentDataType.S3_PATH,
        data: sourceDocumentData.initialData,
        initialData: sourceDocumentData.initialData,
      },
    });
    expect(mocks.targetEnvelopeItemCreate).toHaveBeenCalledWith({
      data: {
        id: expect.stringMatching(/^envelope_item_/),
        title: 'Decision PDF',
        order: 1,
        envelopeId: 'target-envelope',
        documentDataId: 'target-data',
      },
    });
    expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), {
      timeout: 35_000,
    });
    expect(mocks.targetDocumentDataCreate.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.targetEnvelopeItemCreate.mock.invocationCallOrder[0] ?? 0,
    );
  });
});
