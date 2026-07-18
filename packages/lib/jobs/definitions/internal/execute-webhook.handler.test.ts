import { WebhookTriggerEvents } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { projectWebhookLifecycleDocument } from '../../../types/webhook-payload';
import type { JobRunIO } from '../../client/_internal/job';
import { run } from './execute-webhook.handler';

const mocks = vi.hoisted(() => ({
  executeWebhookCall: vi.fn(),
  findUniqueOrThrow: vi.fn(),
  createWebhookCall: vi.fn(),
}));

vi.mock('@documenso/lib/server-only/webhooks/execute-webhook-call', () => ({
  executeWebhookCall: mocks.executeWebhookCall,
}));

vi.mock('@documenso/prisma', () => ({
  prisma: {
    webhook: {
      findUniqueOrThrow: mocks.findUniqueOrThrow,
    },
    webhookCall: {
      create: mocks.createWebhookCall,
    },
  },
}));

describe('execute webhook job', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUniqueOrThrow.mockResolvedValue({
      id: 'webhook-1',
      webhookUrl: 'https://bizbuddy.example.test/api/documenso/webhook',
      secret: 'provider-shared-secret',
    });
    mocks.executeWebhookCall.mockResolvedValue({
      success: true,
      responseCode: 200,
      responseBody: { ok: true },
      responseHeaders: { 'content-type': 'application/json' },
    });
    mocks.createWebhookCall.mockResolvedValue({ id: 'call-1' });
  });

  it('delivers and persists only the capability-safe lifecycle projection', async () => {
    const recipient = {
      id: 501,
      documentId: 42,
      templateId: null,
      email: 'signer@example.test',
      name: 'Sensitive Signer',
      token: 'live-recipient-capability',
      documentDeletedAt: null,
      expiresAt: new Date('2026-07-24T12:00:00.000Z'),
      expirationNotifiedAt: null,
      signedAt: new Date('2026-07-17T12:00:00.000Z'),
      authOptions: {
        accessCode: 'recipient-auth-secret',
        nested: { token: 'nested-recipient-capability' },
      },
      signingOrder: 1,
      rejectionReason: null,
      role: 'SIGNER',
      readStatus: 'OPENED',
      signingStatus: 'SIGNED',
      sendStatus: 'SENT',
    };
    const data = {
      id: 42,
      externalId: 'bizbuddy:11111111-1111-4111-8111-111111111111',
      userId: 9,
      authOptions: {
        globalAccessCode: 'document-auth-secret',
      },
      formValues: {
        confidentialAnswer: 'document-form-secret',
      },
      visibility: 'EVERYONE',
      title: 'Sensitive document title',
      status: 'COMPLETED',
      createdAt: new Date('2026-07-16T12:00:00.000Z'),
      updatedAt: new Date('2026-07-17T12:00:00.000Z'),
      completedAt: new Date('2026-07-17T12:00:00.000Z'),
      deletedAt: null,
      teamId: 17,
      templateId: null,
      source: 'DOCUMENT',
      documentMeta: {
        id: 'meta-1',
        subject: 'Sensitive subject',
        message: 'Sensitive message',
        timezone: 'Etc/UTC',
        dateFormat: 'yyyy-MM-dd',
        redirectUrl: 'https://example.test/?token=redirect-capability',
        signingOrder: 'PARALLEL',
        allowDictateNextSigner: false,
        typedSignatureEnabled: true,
        uploadSignatureEnabled: true,
        drawSignatureEnabled: true,
        language: 'en',
        distributionMethod: 'EMAIL',
        emailSettings: {
          replyTo: 'private@example.test',
          token: 'email-settings-capability',
        },
      },
      recipients: [recipient],
      Recipient: [
        {
          ...recipient,
          token: 'legacy-recipient-capability',
          authOptions: { token: 'legacy-auth-capability' },
        },
      ],
    };

    const lifecycleData = projectWebhookLifecycleDocument(data);

    await run({
      payload: {
        event: WebhookTriggerEvents.DOCUMENT_COMPLETED,
        webhookId: 'webhook-1',
        data: lifecycleData,
      },
      io: createJobRunIO(),
    });

    const wireBody = mocks.executeWebhookCall.mock.calls[0][0].body;
    expect(wireBody).toMatchObject({
      event: WebhookTriggerEvents.DOCUMENT_COMPLETED,
      payload: lifecycleData,
      webhookEndpoint: 'https://bizbuddy.example.test/api/documenso/webhook',
    });
    expect(wireBody.payload).toBe(lifecycleData);
    expect(mocks.executeWebhookCall.mock.calls[0][0].secret).toBe('provider-shared-secret');
    expect(findForbiddenKeys(wireBody.payload)).toEqual([]);

    const persisted = mocks.createWebhookCall.mock.calls[0][0].data.requestBody;
    expect(persisted).toEqual({
      evidenceVersion: 1,
      event: WebhookTriggerEvents.DOCUMENT_COMPLETED,
      payload: {
        id: 42,
        externalId: 'bizbuddy:11111111-1111-4111-8111-111111111111',
        status: 'COMPLETED',
        createdAt: '2026-07-16T12:00:00.000Z',
        updatedAt: '2026-07-17T12:00:00.000Z',
        completedAt: '2026-07-17T12:00:00.000Z',
        deletedAt: null,
        recipients: [
          {
            id: 501,
            role: 'SIGNER',
            readStatus: 'OPENED',
            signingStatus: 'SIGNED',
            sendStatus: 'SENT',
            signedAt: '2026-07-17T12:00:00.000Z',
            expiresAt: '2026-07-24T12:00:00.000Z',
          },
        ],
      },
      createdAt: expect.any(String),
    });

    const forbiddenKeys = findForbiddenKeys(persisted);
    expect(forbiddenKeys).toEqual([]);

    const persistedJson = JSON.stringify(persisted);
    const wireJson = JSON.stringify(wireBody);
    for (const secret of [
      'live-recipient-capability',
      'legacy-recipient-capability',
      'nested-recipient-capability',
      'recipient-auth-secret',
      'legacy-auth-capability',
      'document-auth-secret',
      'document-form-secret',
      'email-settings-capability',
      'private@example.test',
      'Sensitive Signer',
      'signer@example.test',
      'redirect-capability',
    ]) {
      expect(persistedJson).not.toContain(secret);
      expect(wireJson).not.toContain(secret);
    }
    expect(persistedJson).not.toContain('provider-shared-secret');
  });
});

const FORBIDDEN_PERSISTED_KEYS = new Set([
  'token',
  'authOptions',
  'formValues',
  'documentMeta',
  'emailSettings',
  'email',
  'name',
  'webhookEndpoint',
  'secret',
  'signingUrl',
  'rejectionReason',
]);

const findForbiddenKeys = (value: unknown, path = '$'): string[] => {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findForbiddenKeys(item, `${path}[${index}]`));
  }
  if (!value || typeof value !== 'object') return [];

  return Object.entries(value).flatMap(([key, nested]) => [
    ...(FORBIDDEN_PERSISTED_KEYS.has(key) ? [`${path}.${key}`] : []),
    ...findForbiddenKeys(nested, `${path}.${key}`),
  ]);
};

const createJobRunIO = (): JobRunIO => ({
  runTask: async (_cacheKey, callback) => callback(),
  triggerJob: async () => {
    await Promise.resolve();
  },
  wait: async () => {
    await Promise.resolve();
  },
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    log: vi.fn(),
  },
});
