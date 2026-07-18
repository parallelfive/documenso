import {
  DocumentDataType,
  DocumentSigningOrder,
  DocumentStatus,
  EnvelopeType,
  FieldType,
  RecipientRole,
  SendStatus,
  SigningStatus,
} from '@prisma/client';
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppErrorCode } from '../../errors/app-error';
import { sendDocument } from './send-document';

const mocks = vi.hoisted(() => ({
  envelopeFindFirst: vi.fn(),
  transaction: vi.fn(),
  envelopeUpdateMany: vi.fn(),
  envelopeFindUnique: vi.fn(),
  envelopeFindFirstOrThrow: vi.fn(),
  envelopeItemUpdateMany: vi.fn(),
  documentDataFindFirst: vi.fn(),
  documentDataDeleteMany: vi.fn(),
  auditCreate: vi.fn(),
  fieldUpdate: vi.fn(),
  recipientUpdateMany: vi.fn(),
  getEnvelopeWhereInput: vi.fn(),
  getFileServerSide: vi.fn(),
  putInternalPdfSnapshotServerSide: vi.fn(),
  deleteFile: vi.fn(),
  jobsTrigger: vi.fn(),
  triggerWebhook: vi.fn(),
}));

vi.mock('@documenso/prisma', () => ({
  prisma: {
    envelope: {
      findFirst: mocks.envelopeFindFirst,
    },
    documentData: {
      findFirst: mocks.documentDataFindFirst,
      deleteMany: mocks.documentDataDeleteMany,
    },
    $transaction: mocks.transaction,
  },
}));

vi.mock('../../universal/upload/get-file.server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../universal/upload/get-file.server')>()),
  getFileServerSide: mocks.getFileServerSide,
}));

vi.mock('../../universal/upload/put-file.server', () => ({
  putInternalPdfSnapshotServerSide: mocks.putInternalPdfSnapshotServerSide,
  putNormalizedPdfFileServerSide: vi.fn(),
}));

vi.mock('../../universal/upload/delete-file', () => ({
  deleteFile: mocks.deleteFile,
}));

vi.mock('../../jobs/client', () => ({
  jobs: { triggerJob: mocks.jobsTrigger },
}));

vi.mock('../../types/document-email', () => ({
  extractDerivedDocumentEmailSettings: () => ({
    recipientSigningRequest: true,
  }),
}));

vi.mock('../../utils/document-auth', () => ({
  extractDocumentAuthMethods: () => ({
    recipientAccessAuthRequired: false,
    recipientActionAuthRequired: false,
  }),
}));

vi.mock('../../utils/recipients', () => ({
  getRecipientsWithMissingFields: () => [],
  isRecipientEmailValidForSending: () => true,
}));

vi.mock('../envelope/get-envelope-by-id', () => ({
  getEnvelopeWhereInput: mocks.getEnvelopeWhereInput,
}));

vi.mock('../webhooks/trigger/trigger-webhook', () => ({
  triggerWebhook: mocks.triggerWebhook,
}));

vi.mock('@documenso/ui/primitives/document-flow/field-items-advanced-settings/constants', () => ({
  checkboxValidationSigns: [],
}));

const sourcePdf = Uint8Array.from(Buffer.from('%PDF-1.4\nexact legal source\n%%EOF'));
const sourcePdfSha256 = createHash('sha256').update(sourcePdf).digest('hex');

const sourceDocumentData = {
  id: 'data_source',
  type: DocumentDataType.S3_PATH,
  data: 'client-upload/source.pdf',
  initialData: 'client-upload/source.pdf',
};

const snapshotDocumentData = {
  id: 'data_snapshot',
  type: DocumentDataType.S3_PATH,
  data: 'internal-snapshot/source.pdf',
  initialData: 'internal-snapshot/source.pdf',
};

const recipient = {
  id: 101,
  name: 'Signer',
  email: 'signer@example.test',
  role: RecipientRole.SIGNER,
  signingOrder: 1,
  signingStatus: SigningStatus.NOT_SIGNED,
  sendStatus: SendStatus.NOT_SENT,
  authOptions: null,
  token: 'recipient-token',
};

const field = {
  id: 201,
  recipientId: recipient.id,
  type: FieldType.SIGNATURE,
  page: 1,
  positionX: 10,
  positionY: 20,
  width: 100,
  height: 40,
};

const envelope = {
  id: 'envelope_01',
  secondaryId: 'document_42',
  externalId: 'bizbuddy:11111111-1111-4111-8111-111111111111',
  teamId: 9,
  title: 'Approval.pdf',
  type: EnvelopeType.DOCUMENT,
  status: DocumentStatus.DRAFT,
  internalVersion: 1,
  documentMetaId: 'meta_01',
  documentMeta: {
    signingOrder: DocumentSigningOrder.SEQUENTIAL,
    envelopeExpirationPeriod: null,
  },
  recipients: [recipient],
  fields: [field],
  envelopeItems: [
    {
      id: 'item_01',
      documentData: sourceDocumentData,
    },
  ],
  formValues: null,
  authOptions: null,
};

const expectedExecution = {
  externalId: envelope.externalId,
  signingOrder: envelope.documentMeta.signingOrder,
  expectedPdf: {
    sha256: sourcePdfSha256,
    byteLength: sourcePdf.byteLength,
  },
  recipients: [
    {
      id: recipient.id,
      name: recipient.name,
      email: recipient.email,
      role: recipient.role,
      signingOrder: recipient.signingOrder,
    },
  ],
  fields: [field],
};

const requestMetadata = {
  requestMetadata: {},
  source: 'apiV1' as const,
  auth: 'api' as const,
};

const toLockedExecution = (
  currentEnvelope: typeof envelope = envelope,
  execution = expectedExecution,
) => ({
  externalId: execution.externalId,
  teamId: currentEnvelope.teamId,
  documentMeta: {
    signingOrder: execution.signingOrder,
  },
  recipients: execution.recipients,
  fields: execution.fields,
  envelopeItems: [
    {
      id: currentEnvelope.envelopeItems[0].id,
      documentDataId: currentEnvelope.envelopeItems[0].documentData.id,
    },
  ],
});

describe('sendDocument immutable atomic execution lease', () => {
  let capturedSnapshotBytes: Uint8Array;
  let attachedDocumentDataId: string;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedSnapshotBytes = new Uint8Array();
    attachedDocumentDataId = sourceDocumentData.id;

    mocks.getEnvelopeWhereInput.mockResolvedValue({
      envelopeWhereInput: { id: envelope.id },
    });
    mocks.envelopeFindFirst.mockResolvedValue(envelope);
    mocks.getFileServerSide.mockResolvedValue(Uint8Array.from(sourcePdf));
    mocks.putInternalPdfSnapshotServerSide.mockImplementation(
      async (file: { arrayBuffer: () => Promise<ArrayBuffer> }) => {
        capturedSnapshotBytes = new Uint8Array(await file.arrayBuffer());
        return {
          documentData: snapshotDocumentData,
          filePageCount: 1,
        };
      },
    );
    mocks.envelopeUpdateMany.mockResolvedValue({ count: 1 });
    mocks.envelopeFindUnique.mockResolvedValue(toLockedExecution());
    mocks.envelopeFindFirstOrThrow.mockResolvedValue(envelope);
    mocks.envelopeItemUpdateMany.mockImplementation(
      async ({ data }: { data: { documentDataId: string } }) => {
        attachedDocumentDataId = data.documentDataId;
        return await Promise.resolve({ count: 1 });
      },
    );
    mocks.documentDataFindFirst.mockResolvedValue({ id: snapshotDocumentData.id });
    mocks.documentDataDeleteMany.mockResolvedValue({ count: 1 });
    mocks.transaction.mockImplementation((callback) =>
      callback({
        envelope: {
          updateMany: mocks.envelopeUpdateMany,
          findUnique: mocks.envelopeFindUnique,
          findFirstOrThrow: mocks.envelopeFindFirstOrThrow,
        },
        envelopeItem: {
          updateMany: mocks.envelopeItemUpdateMany,
        },
        documentAuditLog: { create: mocks.auditCreate },
        field: { update: mocks.fieldUpdate },
        recipient: { updateMany: mocks.recipientUpdateMany },
      }),
    );
  });

  it('rejects a digest mismatch before snapshotting or claiming the draft', async () => {
    mocks.getFileServerSide.mockResolvedValue(
      Uint8Array.from(Buffer.from('%PDF-1.4\naltered legal source\n%%EOF')),
    );

    await expect(
      sendDocument({
        id: { type: 'envelopeId', id: envelope.id },
        userId: 7,
        teamId: envelope.teamId,
        sendEmail: false,
        expectedExecution,
        requireDraftStatus: true,
        requestMetadata,
      }),
    ).rejects.toMatchObject({
      code: AppErrorCode.CONFLICT,
    });

    expect(mocks.putInternalPdfSnapshotServerSide).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.jobsTrigger).not.toHaveBeenCalled();
  });

  it('rolls back a stale graph claim and cleans only its unreferenced internal snapshot', async () => {
    mocks.envelopeFindUnique.mockResolvedValue({
      ...toLockedExecution(),
      externalId: 'bizbuddy:changed-after-preflight',
    });

    await expect(
      sendDocument({
        id: { type: 'envelopeId', id: envelope.id },
        userId: 7,
        teamId: envelope.teamId,
        sendEmail: false,
        expectedExecution,
        requireDraftStatus: true,
        requestMetadata,
      }),
    ).rejects.toMatchObject({
      code: AppErrorCode.CONFLICT,
    });

    expect(mocks.envelopeUpdateMany).toHaveBeenCalledWith({
      where: {
        id: envelope.id,
        teamId: envelope.teamId,
        type: EnvelopeType.DOCUMENT,
        status: DocumentStatus.DRAFT,
        externalId: envelope.externalId,
      },
      data: {
        status: DocumentStatus.PENDING,
      },
    });
    expect(mocks.envelopeItemUpdateMany).not.toHaveBeenCalled();
    expect(mocks.documentDataDeleteMany).toHaveBeenCalledWith({
      where: {
        id: snapshotDocumentData.id,
        envelopeItem: null,
      },
    });
    expect(mocks.deleteFile).toHaveBeenCalledWith(snapshotDocumentData);
    expect(mocks.deleteFile.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.documentDataDeleteMany.mock.invocationCallOrder[0],
    );
    expect(mocks.auditCreate).not.toHaveBeenCalled();
    expect(mocks.jobsTrigger).not.toHaveBeenCalled();
    expect(mocks.triggerWebhook).not.toHaveBeenCalled();
  });

  it('atomically swaps the exact source item to a fresh internal-only snapshot', async () => {
    const replayableOriginalObject = Uint8Array.from(sourcePdf);
    mocks.getFileServerSide.mockImplementation(
      async () => await Promise.resolve(Uint8Array.from(replayableOriginalObject)),
    );

    await sendDocument({
      id: { type: 'envelopeId', id: envelope.id },
      userId: 7,
      teamId: envelope.teamId,
      sendEmail: false,
      expectedExecution,
      requireDraftStatus: true,
      requestMetadata,
    });

    expect(mocks.getFileServerSide).toHaveBeenCalledWith(sourceDocumentData, {
      maxBytes: sourcePdf.byteLength,
      timeoutMs: 30_000,
    });
    expect(capturedSnapshotBytes).toEqual(sourcePdf);
    expect(mocks.envelopeItemUpdateMany).toHaveBeenCalledWith({
      where: {
        id: envelope.envelopeItems[0].id,
        envelopeId: envelope.id,
        documentDataId: sourceDocumentData.id,
      },
      data: {
        documentDataId: snapshotDocumentData.id,
      },
    });
    expect(attachedDocumentDataId).toBe(snapshotDocumentData.id);

    // A retained client presign can still overwrite only the now-orphaned
    // original key; the bytes captured by the attached snapshot do not change.
    replayableOriginalObject.fill(0);
    expect(capturedSnapshotBytes).toEqual(sourcePdf);
    expect(mocks.documentDataDeleteMany).not.toHaveBeenCalled();
    expect(mocks.triggerWebhook).toHaveBeenCalledTimes(1);
  });

  it('never deletes snapshot bytes when cleanup observes an attached reference', async () => {
    mocks.envelopeUpdateMany.mockResolvedValue({ count: 0 });
    mocks.documentDataFindFirst.mockResolvedValue(null);

    await expect(
      sendDocument({
        id: { type: 'envelopeId', id: envelope.id },
        userId: 7,
        teamId: envelope.teamId,
        sendEmail: false,
        expectedExecution,
        requireDraftStatus: true,
        requestMetadata,
      }),
    ).rejects.toMatchObject({
      code: AppErrorCode.CONFLICT,
    });

    expect(mocks.documentDataFindFirst).toHaveBeenCalledTimes(1);
    expect(mocks.documentDataDeleteMany).not.toHaveBeenCalled();
    expect(mocks.deleteFile).not.toHaveBeenCalled();
  });

  it('attaches the snapshot before enqueueing the no-action seal branch', async () => {
    const noActionRecipient = {
      ...recipient,
      role: RecipientRole.CC,
      signingStatus: SigningStatus.SIGNED,
    };
    const noActionEnvelope = {
      ...envelope,
      recipients: [noActionRecipient],
    };
    const noActionExpectedExecution = {
      ...expectedExecution,
      recipients: [
        {
          id: noActionRecipient.id,
          name: noActionRecipient.name,
          email: noActionRecipient.email,
          role: noActionRecipient.role,
          signingOrder: noActionRecipient.signingOrder,
        },
      ],
    };

    mocks.envelopeFindFirst.mockResolvedValue(noActionEnvelope);
    mocks.envelopeFindUnique.mockResolvedValue(
      toLockedExecution(noActionEnvelope, noActionExpectedExecution),
    );
    mocks.envelopeFindFirstOrThrow.mockResolvedValue(noActionEnvelope);

    await sendDocument({
      id: { type: 'envelopeId', id: envelope.id },
      userId: 7,
      teamId: envelope.teamId,
      sendEmail: false,
      expectedExecution: noActionExpectedExecution,
      requireDraftStatus: true,
      requestMetadata,
    });

    expect(attachedDocumentDataId).toBe(snapshotDocumentData.id);
    expect(mocks.jobsTrigger).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'internal.seal-document',
      }),
    );
    expect(mocks.envelopeItemUpdateMany.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.jobsTrigger.mock.invocationCallOrder[0],
    );
  });

  it('rejects a native correlated send that omits the execution lease before reading bytes', async () => {
    await expect(
      sendDocument({
        id: { type: 'envelopeId', id: envelope.id },
        userId: 7,
        teamId: envelope.teamId,
        sendEmail: false,
        requestMetadata: {
          ...requestMetadata,
          source: 'app',
          auth: 'session',
        },
      }),
    ).rejects.toMatchObject({
      code: AppErrorCode.INVALID_REQUEST,
    });

    expect(mocks.getFileServerSide).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.jobsTrigger).not.toHaveBeenCalled();
  });
});
