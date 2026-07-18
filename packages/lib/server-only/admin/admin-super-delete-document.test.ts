import { DocumentStatus, SendStatus } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppErrorCode } from '../../errors/app-error';
import { adminSuperDeleteDocument } from './admin-super-delete-document';

const mocks = vi.hoisted(() => ({
  envelopeFindUnique: vi.fn(),
  transaction: vi.fn(),
  transactionCommitted: vi.fn(),
  auditCreate: vi.fn(),
  envelopeDelete: vi.fn(),
  getEmailContext: vi.fn(),
  getI18nInstance: vi.fn(),
  mailSend: vi.fn(),
  renderEmail: vi.fn(),
  lockEnvelopeDocumentDataForCleanup: vi.fn(),
  stageDocumentDataStorageCleanup: vi.fn(),
  processDocumentDataStorageCleanupAfterCommit: vi.fn(),
}));

vi.mock('@documenso/prisma', () => ({
  prisma: {
    envelope: {
      findUnique: mocks.envelopeFindUnique,
    },
    $transaction: mocks.transaction,
  },
}));

vi.mock('@documenso/email/mailer', () => ({
  mailer: {
    sendMail: mocks.mailSend,
  },
}));

vi.mock('@documenso/email/templates/document-cancel', () => ({
  default: () => null,
}));

vi.mock('@lingui/core/macro', () => ({
  msg: (strings: TemplateStringsArray) => strings.join(''),
}));

vi.mock('../../client-only/providers/i18n-server', () => ({
  getI18nInstance: mocks.getI18nInstance,
}));

vi.mock('../../constants/app', () => ({
  NEXT_PUBLIC_WEBAPP_URL: () => 'https://sign.example.test',
}));

vi.mock('../../types/document-email', () => ({
  extractDerivedDocumentEmailSettings: () => ({
    documentDeleted: true,
  }),
}));

vi.mock('../../utils/document-audit-logs', () => ({
  createDocumentAuditLogData: () => ({
    type: 'DOCUMENT_DELETED',
  }),
}));

vi.mock('../../utils/recipients', () => ({
  isRecipientEmailValidForSending: () => true,
}));

vi.mock('../../utils/render-email-with-i18n', () => ({
  renderEmailWithI18N: mocks.renderEmail,
}));

vi.mock('../email/get-email-context', () => ({
  getEmailContext: mocks.getEmailContext,
}));

vi.mock('../document-data/process-document-data-storage-cleanup', () => ({
  processDocumentDataStorageCleanupAfterCommit:
    mocks.processDocumentDataStorageCleanupAfterCommit,
}));

vi.mock('../document-data/stage-document-data-storage-cleanup', () => ({
  DOCUMENT_DATA_STORAGE_TRANSACTION_TIMEOUT_MS: 35_000,
  getDocumentDataPresignReplayNotBefore: () => new Date('2030-01-01T01:05:00.000Z'),
  lockEnvelopeDocumentDataForCleanup: mocks.lockEnvelopeDocumentDataForCleanup,
  stageDocumentDataStorageCleanup: mocks.stageDocumentDataStorageCleanup,
}));

const completedEnvelope = {
  id: 'envelope-completed',
  teamId: 9,
  title: 'Completed controlled agreement',
  status: DocumentStatus.COMPLETED,
  recipients: [
    {
      id: 101,
      email: 'recipient@example.test',
      name: 'Recipient',
      sendStatus: SendStatus.SENT,
    },
  ],
  documentMeta: null,
  user: {
    id: 7,
    email: 'owner@example.test',
    name: 'Owner',
  },
};

const options = {
  envelopeId: completedEnvelope.id,
  requestMetadata: {
    ipAddress: '127.0.0.1',
  },
};

describe('adminSuperDeleteDocument storage cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.envelopeFindUnique.mockResolvedValue(completedEnvelope);
    mocks.getEmailContext.mockResolvedValue({
      branding: {},
      settings: {
        documentLanguage: 'en',
      },
      senderEmail: 'sign@example.test',
      replyToEmail: 'reply@example.test',
    });
    mocks.getI18nInstance.mockResolvedValue({
      _: () => 'Document Cancelled',
    });
    mocks.renderEmail.mockResolvedValue('rendered');
    mocks.mailSend.mockResolvedValue(undefined);
    mocks.auditCreate.mockResolvedValue(undefined);
    mocks.envelopeDelete.mockResolvedValue(completedEnvelope);
    mocks.lockEnvelopeDocumentDataForCleanup.mockResolvedValue([
      'document-data-current',
      'document-data-signed',
    ]);
    mocks.stageDocumentDataStorageCleanup.mockResolvedValue([
      'cleanup-current',
      'cleanup-shared',
    ]);
    mocks.processDocumentDataStorageCleanupAfterCommit.mockResolvedValue(undefined);
    mocks.transaction.mockImplementation(
      async (callback: (tx: unknown) => Promise<unknown>) => {
        const result = await callback({
          documentAuditLog: {
            create: mocks.auditCreate,
          },
          envelope: {
            delete: mocks.envelopeDelete,
          },
        });

        mocks.transactionCommitted();

        return result;
      },
    );
  });

  it('hard-deletes a completed envelope and dispatches replay-safe cleanup only after commit', async () => {
    await expect(adminSuperDeleteDocument(options)).resolves.toBe(completedEnvelope);

    expect(mocks.mailSend).not.toHaveBeenCalled();
    expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), {
      timeout: 35_000,
    });
    expect(mocks.lockEnvelopeDocumentDataForCleanup).toHaveBeenCalledWith({
      tx: expect.any(Object),
      envelopeId: completedEnvelope.id,
    });
    expect(mocks.envelopeDelete).toHaveBeenCalledWith({
      where: {
        id: completedEnvelope.id,
      },
    });
    expect(mocks.auditCreate).toHaveBeenCalledTimes(1);
    expect(mocks.stageDocumentDataStorageCleanup).toHaveBeenCalledWith({
      tx: expect.any(Object),
      documentDataIds: ['document-data-current', 'document-data-signed'],
      notBefore: new Date('2030-01-01T01:05:00.000Z'),
    });
    expect(mocks.processDocumentDataStorageCleanupAfterCommit).toHaveBeenCalledWith({
      cleanupIds: ['cleanup-current', 'cleanup-shared'],
      envelopeId: completedEnvelope.id,
      event: 'document-admin-deleted',
    });
    expect(mocks.lockEnvelopeDocumentDataForCleanup.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.auditCreate.mock.invocationCallOrder[0],
    );
    expect(mocks.auditCreate.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.envelopeDelete.mock.invocationCallOrder[0],
    );
    expect(mocks.envelopeDelete.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.stageDocumentDataStorageCleanup.mock.invocationCallOrder[0],
    );
    expect(mocks.stageDocumentDataStorageCleanup.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.transactionCommitted.mock.invocationCallOrder[0],
    );
    expect(mocks.transactionCommitted.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.processDocumentDataStorageCleanupAfterCommit.mock.invocationCallOrder[0],
    );
  });

  it('rolls the envelope mutation back when cleanup staging fails and never processes an object', async () => {
    mocks.stageDocumentDataStorageCleanup.mockRejectedValueOnce(
      new Error('cleanup staging unavailable'),
    );

    await expect(adminSuperDeleteDocument(options)).rejects.toThrow('cleanup staging unavailable');

    expect(mocks.envelopeDelete).toHaveBeenCalledTimes(1);
    expect(mocks.transactionCommitted).not.toHaveBeenCalled();
    expect(mocks.processDocumentDataStorageCleanupAfterCommit).not.toHaveBeenCalled();
  });

  it('stops before mutation when the envelope/data lock fails', async () => {
    mocks.lockEnvelopeDocumentDataForCleanup.mockRejectedValueOnce(
      new Error('database lock unavailable'),
    );

    await expect(adminSuperDeleteDocument(options)).rejects.toThrow('database lock unavailable');

    expect(mocks.auditCreate).not.toHaveBeenCalled();
    expect(mocks.envelopeDelete).not.toHaveBeenCalled();
    expect(mocks.stageDocumentDataStorageCleanup).not.toHaveBeenCalled();
    expect(mocks.transactionCommitted).not.toHaveBeenCalled();
    expect(mocks.processDocumentDataStorageCleanupAfterCommit).not.toHaveBeenCalled();
  });

  it('does not stage cleanup when the atomic envelope delete loses a race', async () => {
    mocks.envelopeDelete.mockRejectedValueOnce({
      code: 'P2025',
    });

    await expect(adminSuperDeleteDocument(options)).rejects.toMatchObject({
      code: 'P2025',
    });

    expect(mocks.stageDocumentDataStorageCleanup).not.toHaveBeenCalled();
    expect(mocks.transactionCommitted).not.toHaveBeenCalled();
    expect(mocks.processDocumentDataStorageCleanupAfterCommit).not.toHaveBeenCalled();
  });

  it('preserves pending-recipient cancellation email failure as a pre-delete failure', async () => {
    mocks.envelopeFindUnique.mockResolvedValueOnce({
      ...completedEnvelope,
      status: DocumentStatus.PENDING,
    });
    mocks.mailSend.mockRejectedValueOnce(new Error('SMTP unavailable'));

    await expect(adminSuperDeleteDocument(options)).rejects.toThrow('SMTP unavailable');

    expect(mocks.mailSend).toHaveBeenCalledTimes(1);
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.lockEnvelopeDocumentDataForCleanup).not.toHaveBeenCalled();
    expect(mocks.envelopeDelete).not.toHaveBeenCalled();
    expect(mocks.processDocumentDataStorageCleanupAfterCommit).not.toHaveBeenCalled();
  });

  it('rejects a missing document before email or cleanup work', async () => {
    mocks.envelopeFindUnique.mockResolvedValueOnce(null);

    await expect(adminSuperDeleteDocument(options)).rejects.toMatchObject({
      code: AppErrorCode.NOT_FOUND,
    });

    expect(mocks.getEmailContext).not.toHaveBeenCalled();
    expect(mocks.mailSend).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.processDocumentDataStorageCleanupAfterCommit).not.toHaveBeenCalled();
  });
});
