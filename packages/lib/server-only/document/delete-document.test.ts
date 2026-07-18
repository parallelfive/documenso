import { DocumentStatus, EnvelopeType, SendStatus } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppErrorCode } from '../../errors/app-error';
import { deleteDocument } from './delete-document';

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  envelopeFindUnique: vi.fn(),
  transaction: vi.fn(),
  auditCreate: vi.fn(),
  envelopeDelete: vi.fn(),
  recipientUpdate: vi.fn(),
  getMemberRoles: vi.fn(),
  getEmailContext: vi.fn(),
  getI18nInstance: vi.fn(),
  mailSend: vi.fn(),
  renderEmail: vi.fn(),
  triggerWebhook: vi.fn(),
  loggerError: vi.fn(),
  lockEnvelopeDocumentDataForCleanup: vi.fn(),
  stageDocumentDataStorageCleanup: vi.fn(),
  processDocumentDataStorageCleanupAfterCommit: vi.fn(),
}));

vi.mock('@documenso/prisma', () => ({
  prisma: {
    user: { findUnique: mocks.userFindUnique },
    envelope: { findUnique: mocks.envelopeFindUnique },
    recipient: { update: mocks.recipientUpdate },
    $transaction: mocks.transaction,
  },
}));

vi.mock('@documenso/email/mailer', () => ({
  mailer: { sendMail: mocks.mailSend },
}));

vi.mock('@documenso/email/templates/document-cancel', () => ({
  default: () => null,
}));

vi.mock('../../client-only/providers/i18n-server', () => ({
  getI18nInstance: mocks.getI18nInstance,
}));

vi.mock('../../constants/app', () => ({
  NEXT_PUBLIC_WEBAPP_URL: () => 'https://sign.example.test',
  isBizBuddyExternalId: (externalId: string | null | undefined) =>
    externalId?.toLowerCase().startsWith('bizbuddy:') === true,
}));

vi.mock('../../types/document-email', () => ({
  extractDerivedDocumentEmailSettings: () => ({ documentDeleted: true }),
}));

vi.mock('../../utils/document-audit-logs', () => ({
  createDocumentAuditLogData: () => ({ type: 'DOCUMENT_DELETED' }),
}));

vi.mock('../../utils/logger', () => ({
  logger: { error: mocks.loggerError },
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
  getDocumentDataPresignReplayNotBefore: () => new Date('2030-01-01T01:05:00.000Z'),
  lockEnvelopeDocumentDataForCleanup: mocks.lockEnvelopeDocumentDataForCleanup,
  stageDocumentDataStorageCleanup: mocks.stageDocumentDataStorageCleanup,
}));

vi.mock('../team/get-member-roles', () => ({
  getMemberRoles: mocks.getMemberRoles,
}));

vi.mock('../webhooks/trigger/trigger-webhook', () => ({
  triggerWebhook: mocks.triggerWebhook,
}));

const envelope = {
  id: 'envelope_01',
  secondaryId: 'document_42',
  type: EnvelopeType.DOCUMENT,
  userId: 7,
  teamId: 9,
  title: 'Controlled cancellation',
  externalId: null,
  status: DocumentStatus.DRAFT,
  deletedAt: null,
  recipients: [
    {
      id: 101,
      email: 'recipient@example.test',
      name: 'Recipient',
      sendStatus: SendStatus.SENT,
      documentDeletedAt: null,
    },
  ],
  documentMeta: null,
};

const options = {
  id: { type: 'envelopeId' as const, id: envelope.id },
  userId: 7,
  teamId: 9,
  requestMetadata: {
    requestMetadata: {},
    source: 'apiV1' as const,
    auth: 'api' as const,
  },
};

describe('deleteDocument post-commit effects', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.userFindUnique.mockResolvedValue({
      id: 7,
      email: 'owner@example.test',
      name: 'Owner',
    });
    mocks.envelopeFindUnique.mockResolvedValue(envelope);
    mocks.getMemberRoles.mockResolvedValue(['ADMIN']);
    mocks.getEmailContext.mockResolvedValue({
      branding: {},
      emailLanguage: 'en',
      senderEmail: 'sign@example.test',
      replyToEmail: 'reply@example.test',
    });
    mocks.getI18nInstance.mockResolvedValue({ _: () => 'Document Cancelled' });
    mocks.renderEmail.mockResolvedValue('rendered');
    mocks.mailSend.mockResolvedValue(undefined);
    mocks.auditCreate.mockResolvedValue(undefined);
    mocks.envelopeDelete.mockResolvedValue(envelope);
    mocks.lockEnvelopeDocumentDataForCleanup.mockResolvedValue(['document-data-1']);
    mocks.stageDocumentDataStorageCleanup.mockResolvedValue(['cleanup-1']);
    mocks.processDocumentDataStorageCleanupAfterCommit.mockResolvedValue(undefined);
    mocks.transaction.mockImplementation((callback) =>
      callback({
        documentAuditLog: { create: mocks.auditCreate },
        envelope: { delete: mocks.envelopeDelete },
      }),
    );
    mocks.triggerWebhook.mockResolvedValue({
      matched: 1,
      enqueued: 1,
      failed: 0,
    });
  });

  it('returns the committed deletion when webhook enqueue is reported failed', async () => {
    mocks.triggerWebhook.mockResolvedValueOnce({
      matched: 1,
      enqueued: 0,
      failed: 1,
    });

    await expect(deleteDocument(options)).resolves.toBe(envelope);

    expect(mocks.envelopeDelete).toHaveBeenCalledWith({
      where: {
        id: envelope.id,
        status: { not: DocumentStatus.COMPLETED },
      },
    });
    expect(mocks.stageDocumentDataStorageCleanup).toHaveBeenCalledWith({
      tx: expect.any(Object),
      documentDataIds: ['document-data-1'],
      notBefore: new Date('2030-01-01T01:05:00.000Z'),
    });
    expect(mocks.processDocumentDataStorageCleanupAfterCommit).toHaveBeenCalledWith({
      cleanupIds: ['cleanup-1'],
      envelopeId: envelope.id,
      event: 'document-cancelled',
    });
    expect(mocks.envelopeDelete.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.stageDocumentDataStorageCleanup.mock.invocationCallOrder[0],
    );
    expect(mocks.stageDocumentDataStorageCleanup.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.processDocumentDataStorageCleanupAfterCommit.mock.invocationCallOrder[0],
    );
    expect(mocks.triggerWebhook).toHaveBeenCalledTimes(1);
  });

  it('attempts the webhook and returns success after a post-commit mail failure', async () => {
    mocks.mailSend.mockRejectedValueOnce(new Error('SMTP unavailable'));

    await expect(deleteDocument(options)).resolves.toBe(envelope);

    expect(mocks.envelopeDelete).toHaveBeenCalledTimes(1);
    expect(mocks.triggerWebhook).toHaveBeenCalledTimes(1);
    expect(mocks.loggerError).toHaveBeenCalledWith({
      event: 'document-delete-cancellation-email-failed',
      envelopeId: envelope.id,
      failedEmailCount: 1,
      attemptedEmailCount: 1,
    });
  });

  it('still rejects a genuine pre-commit database failure', async () => {
    mocks.transaction.mockRejectedValueOnce(new Error('database unavailable'));

    await expect(deleteDocument(options)).rejects.toThrow('database unavailable');
    expect(mocks.triggerWebhook).not.toHaveBeenCalled();
    expect(mocks.processDocumentDataStorageCleanupAfterCommit).not.toHaveBeenCalled();
  });

  it.each([DocumentStatus.COMPLETED, DocumentStatus.REJECTED])(
    'rejects an already-terminal %s V1 cancellation without mutation',
    async (status) => {
      mocks.envelopeFindUnique.mockResolvedValueOnce({
        ...envelope,
        status,
      });

      await expect(
        deleteDocument({
          ...options,
          requireCancellableStatus: true,
        }),
      ).rejects.toMatchObject({
        code: AppErrorCode.CONFLICT,
      });

      expect(mocks.getEmailContext).not.toHaveBeenCalled();
      expect(mocks.transaction).not.toHaveBeenCalled();
      expect(mocks.envelopeDelete).not.toHaveBeenCalled();
      expect(mocks.triggerWebhook).not.toHaveBeenCalled();
    },
  );

  it('automatically applies cancellable-state semantics to a correlated native-route delete', async () => {
    mocks.envelopeFindUnique.mockResolvedValueOnce({
      ...envelope,
      externalId: 'bizbuddy:decision-01',
      status: DocumentStatus.REJECTED,
    });

    await expect(deleteDocument(options)).rejects.toMatchObject({
      code: AppErrorCode.CONFLICT,
    });

    expect(mocks.getEmailContext).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.envelopeDelete).not.toHaveBeenCalled();
    expect(mocks.triggerWebhook).not.toHaveBeenCalled();
  });

  it('uses the atomic cancellable predicate for a correlated native-route delete race', async () => {
    mocks.envelopeFindUnique.mockResolvedValueOnce({
      ...envelope,
      externalId: 'bizbuddy:decision-01',
      status: DocumentStatus.PENDING,
    });
    mocks.envelopeDelete.mockRejectedValueOnce({ code: 'P2025' });

    await expect(deleteDocument(options)).rejects.toMatchObject({
      code: AppErrorCode.CONFLICT,
    });

    expect(mocks.envelopeDelete).toHaveBeenCalledWith({
      where: {
        id: envelope.id,
        status: {
          in: [DocumentStatus.DRAFT, DocumentStatus.PENDING],
        },
      },
    });
    expect(mocks.triggerWebhook).not.toHaveBeenCalled();
    expect(mocks.mailSend).not.toHaveBeenCalled();
    expect(mocks.stageDocumentDataStorageCleanup).not.toHaveBeenCalled();
    expect(mocks.processDocumentDataStorageCleanupAfterCommit).not.toHaveBeenCalled();
  });

  it.each([DocumentStatus.COMPLETED, DocumentStatus.REJECTED])(
    'maps a pending-to-%s cancellation race to conflict without deleting the terminal envelope',
    async () => {
      mocks.envelopeFindUnique.mockResolvedValueOnce({
        ...envelope,
        status: DocumentStatus.PENDING,
      });
      mocks.envelopeDelete.mockRejectedValueOnce({ code: 'P2025' });

      await expect(
        deleteDocument({
          ...options,
          requireCancellableStatus: true,
        }),
      ).rejects.toMatchObject({
        code: AppErrorCode.CONFLICT,
      });

      expect(mocks.envelopeDelete).toHaveBeenCalledWith({
        where: {
          id: envelope.id,
          status: {
            in: [DocumentStatus.DRAFT, DocumentStatus.PENDING],
          },
        },
      });
      expect(mocks.triggerWebhook).not.toHaveBeenCalled();
      expect(mocks.mailSend).not.toHaveBeenCalled();
      expect(mocks.stageDocumentDataStorageCleanup).not.toHaveBeenCalled();
      expect(mocks.processDocumentDataStorageCleanupAfterCommit).not.toHaveBeenCalled();
    },
  );
});
