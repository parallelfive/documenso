import {
  DocumentSigningOrder,
  DocumentStatus,
  EnvelopeType,
  RecipientRole,
  SigningStatus,
} from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppErrorCode } from '../../errors/app-error';
import { assertV1ReminderRecipientsEligible, resendDocument } from './resend-document';

vi.mock('@lingui/core/macro', () => ({
  msg: (input: TemplateStringsArray | { message: string }, ...values: unknown[]) => {
    if ('message' in input) return input.message;

    return input.reduce((message, part, index) => `${message}${part}${values[index] ?? ''}`, '');
  },
}));

const mocks = vi.hoisted(() => ({
  userFindFirstOrThrow: vi.fn(),
  envelopeFindUnique: vi.fn(),
  recipientUpdateMany: vi.fn(),
  auditCreate: vi.fn(),
  mailSend: vi.fn(),
  getEnvelopeWhereInput: vi.fn(),
  getEmailContext: vi.fn(),
  getI18nInstance: vi.fn(),
  renderEmail: vi.fn(),
  triggerWebhook: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock('@documenso/prisma', () => ({
  prisma: {
    user: { findFirstOrThrow: mocks.userFindFirstOrThrow },
    envelope: { findUnique: mocks.envelopeFindUnique },
    recipient: { updateMany: mocks.recipientUpdateMany },
    documentAuditLog: { create: mocks.auditCreate },
  },
}));

vi.mock('@documenso/email/mailer', () => ({
  mailer: { sendMail: mocks.mailSend },
}));

vi.mock('@documenso/email/templates/document-invite', () => ({
  DocumentInviteEmailTemplate: () => null,
}));

vi.mock('../../client-only/providers/i18n-server', () => ({
  getI18nInstance: mocks.getI18nInstance,
}));

vi.mock('../../constants/app', () => ({
  NEXT_PUBLIC_WEBAPP_URL: () => 'https://sign.example.test',
  buildRecipientSigningLink: () => 'https://sign.example.test/sign/token',
  isBizBuddyExternalId: (externalId: string | null | undefined) =>
    externalId?.toLowerCase().startsWith('bizbuddy:') === true,
}));

vi.mock('../../types/document-email', () => ({
  extractDerivedDocumentEmailSettings: () => ({
    recipientSigningRequest: true,
  }),
}));

vi.mock('../../utils/document-audit-logs', () => ({
  createDocumentAuditLogData: (data: unknown) => data,
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

vi.mock('../envelope/get-envelope-by-id', () => ({
  getEnvelopeWhereInput: mocks.getEnvelopeWhereInput,
}));

vi.mock('../webhooks/trigger/trigger-webhook', () => ({
  triggerWebhook: mocks.triggerWebhook,
}));

const recipient = {
  id: 101,
  role: RecipientRole.SIGNER,
  signingOrder: 1,
  signingStatus: SigningStatus.NOT_SIGNED,
  email: 'recipient@example.test',
  name: 'Recipient',
  token: 'recipient-token',
};

const eligibilityEnvelope = (signingOrder: DocumentSigningOrder, recipients = [recipient]) => ({
  status: DocumentStatus.PENDING,
  documentMeta: { signingOrder },
  recipients,
});

describe('assertV1ReminderRecipientsEligible', () => {
  it('allows the current lowest-order sequential recipient', () => {
    expect(() =>
      assertV1ReminderRecipientsEligible(
        eligibilityEnvelope(DocumentSigningOrder.SEQUENTIAL, [
          { ...recipient, id: 202, signingOrder: 2 },
          recipient,
        ]),
        [recipient.id],
      ),
    ).not.toThrow();
  });

  it('rejects a later sequential recipient before email delivery', () => {
    expect(() =>
      assertV1ReminderRecipientsEligible(
        eligibilityEnvelope(DocumentSigningOrder.SEQUENTIAL, [
          recipient,
          { ...recipient, id: 202, signingOrder: 2 },
        ]),
        [202],
      ),
    ).toThrow(
      expect.objectContaining({
        code: AppErrorCode.CONFLICT,
      }),
    );
  });

  it('allows any exact unsigned non-CC recipient in parallel mode', () => {
    expect(() =>
      assertV1ReminderRecipientsEligible(
        eligibilityEnvelope(DocumentSigningOrder.PARALLEL, [
          recipient,
          { ...recipient, id: 202, signingOrder: 2 },
        ]),
        [202, recipient.id],
      ),
    ).not.toThrow();
  });

  it.each([
    { role: RecipientRole.CC, signingStatus: SigningStatus.NOT_SIGNED },
    { role: RecipientRole.SIGNER, signingStatus: SigningStatus.SIGNED },
  ])('rejects a non-actionable parallel recipient %#', (override) => {
    expect(() =>
      assertV1ReminderRecipientsEligible(
        eligibilityEnvelope(DocumentSigningOrder.PARALLEL, [{ ...recipient, ...override }]),
        [recipient.id],
      ),
    ).toThrow(
      expect.objectContaining({
        code: AppErrorCode.CONFLICT,
      }),
    );
  });
});

describe('resendDocument post-delivery audit handling', () => {
  const envelope = {
    ...eligibilityEnvelope(DocumentSigningOrder.PARALLEL),
    id: 'envelope_01',
    secondaryId: 'document_42',
    type: EnvelopeType.DOCUMENT,
    title: 'Reminder integrity',
    externalId: 'bizbuddy:decision-01',
    userId: 7,
    teamId: 9,
    documentMeta: {
      signingOrder: DocumentSigningOrder.PARALLEL,
      envelopeExpirationPeriod: null,
      subject: null,
      message: null,
    },
    team: {
      name: 'Governance Team',
      teamEmail: null,
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.userFindFirstOrThrow.mockResolvedValue({
      id: 7,
      email: 'owner@example.test',
      name: 'Owner',
    });
    mocks.getEnvelopeWhereInput.mockResolvedValue({
      envelopeWhereInput: { id: envelope.id },
    });
    mocks.envelopeFindUnique.mockResolvedValue(envelope);
    mocks.getEmailContext.mockResolvedValue({
      branding: {},
      emailLanguage: 'en',
      organisationType: 'PERSONAL',
      senderEmail: 'sign@example.test',
      replyToEmail: 'reply@example.test',
    });
    mocks.getI18nInstance.mockResolvedValue({ _: (value: unknown) => String(value) });
    mocks.renderEmail.mockResolvedValue('rendered');
    mocks.mailSend.mockResolvedValue(undefined);
    mocks.auditCreate.mockResolvedValue(undefined);
    mocks.triggerWebhook.mockResolvedValue({
      matched: 1,
      enqueued: 1,
      failed: 0,
    });
  });

  it('automatically preserves correlated reminder checks through a native-route call', async () => {
    const sequentialEnvelope = {
      ...envelope,
      documentMeta: {
        ...envelope.documentMeta,
        signingOrder: DocumentSigningOrder.SEQUENTIAL,
      },
      recipients: [
        recipient,
        {
          ...recipient,
          id: 202,
          signingOrder: 2,
          email: 'later@example.test',
          token: 'later-token',
        },
      ],
    };
    mocks.envelopeFindUnique.mockResolvedValueOnce(sequentialEnvelope);

    await expect(
      resendDocument({
        id: { type: 'envelopeId', id: envelope.id },
        userId: 7,
        recipients: [202],
        teamId: 9,
        requestMetadata: {
          requestMetadata: {},
          source: 'app',
          auth: 'session',
        },
      }),
    ).rejects.toMatchObject({
      code: AppErrorCode.CONFLICT,
    });

    expect(mocks.renderEmail).not.toHaveBeenCalled();
    expect(mocks.mailSend).not.toHaveBeenCalled();
    expect(mocks.triggerWebhook).not.toHaveBeenCalled();
  });

  it('preserves native non-correlated redistribute behavior when strict checks are not requested', async () => {
    const nativeSequentialEnvelope = {
      ...envelope,
      externalId: null,
      documentMeta: {
        ...envelope.documentMeta,
        signingOrder: DocumentSigningOrder.SEQUENTIAL,
      },
      recipients: [
        recipient,
        {
          ...recipient,
          id: 202,
          signingOrder: 2,
          email: 'later@example.test',
          token: 'later-token',
        },
      ],
    };
    mocks.envelopeFindUnique.mockResolvedValueOnce(nativeSequentialEnvelope);

    await expect(
      resendDocument({
        id: { type: 'envelopeId', id: envelope.id },
        userId: 7,
        recipients: [202],
        teamId: 9,
        requestMetadata: {
          requestMetadata: {},
          source: 'app',
          auth: 'session',
        },
      }),
    ).resolves.toBe(nativeSequentialEnvelope);

    expect(mocks.envelopeFindUnique).toHaveBeenCalledTimes(1);
    expect(mocks.mailSend).toHaveBeenCalledTimes(1);
    expect(mocks.triggerWebhook).toHaveBeenCalledTimes(1);
  });

  it('does not report a false resend failure after mail succeeds but audit persistence fails', async () => {
    mocks.auditCreate.mockRejectedValueOnce(new Error('database unavailable'));

    await expect(
      resendDocument({
        id: { type: 'envelopeId', id: envelope.id },
        userId: 7,
        recipients: [recipient.id],
        teamId: 9,
        requestMetadata: {
          requestMetadata: {},
          source: 'apiV1',
          auth: 'api',
        },
      }),
    ).resolves.toBe(envelope);

    expect(mocks.mailSend).toHaveBeenCalledTimes(1);
    expect(mocks.triggerWebhook).toHaveBeenCalledTimes(1);
    expect(mocks.loggerError).toHaveBeenCalledWith({
      event: 'document-reminder-email-audit-failed',
      envelopeId: envelope.id,
      recipientId: recipient.id,
      errorName: 'Error',
    });
    expect(mocks.loggerError.mock.calls[0][0]).not.toHaveProperty('recipientEmail');
  });

  it('sends no mail when cancellation commits before an implicit correlated final delivery check', async () => {
    mocks.envelopeFindUnique.mockResolvedValueOnce(envelope).mockResolvedValueOnce(null);

    await expect(
      resendDocument({
        id: { type: 'envelopeId', id: envelope.id },
        userId: 7,
        recipients: [recipient.id],
        teamId: 9,
        requestMetadata: {
          requestMetadata: {},
          source: 'apiV1',
          auth: 'api',
        },
      }),
    ).rejects.toMatchObject({
      code: AppErrorCode.CONFLICT,
    });

    expect(mocks.renderEmail).toHaveBeenCalledTimes(2);
    expect(mocks.mailSend).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
    expect(mocks.triggerWebhook).not.toHaveBeenCalled();
  });
});
