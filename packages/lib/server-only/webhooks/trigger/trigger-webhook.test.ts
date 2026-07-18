import { WebhookTriggerEvents } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { triggerWebhook } from './trigger-webhook';

const mocks = vi.hoisted(() => ({
  triggerJob: vi.fn(),
  getAllWebhooksByEventTrigger: vi.fn(),
}));

vi.mock('../../../jobs/client', () => ({
  jobs: {
    triggerJob: mocks.triggerJob,
  },
}));

vi.mock('../get-all-webhooks-by-event-trigger', () => ({
  getAllWebhooksByEventTrigger: mocks.getAllWebhooksByEventTrigger,
}));

describe('triggerWebhook capability boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAllWebhooksByEventTrigger.mockResolvedValue([{ id: 'webhook-1' }]);
    mocks.triggerJob.mockResolvedValue(undefined);
  });

  it('projects before BackgroundJob, Redis/BullMQ, and worker logging receive the payload', async () => {
    const canonicalRecipient = {
      id: 101,
      token: 'canonical-live-capability',
      email: 'signer@example.test',
      name: 'Sensitive Signer',
      authOptions: {
        token: 'recipient-auth-capability',
      },
      role: 'SIGNER',
      readStatus: 'OPENED',
      signingStatus: 'SIGNED',
      sendStatus: 'SENT',
      signedAt: new Date('2026-07-17T14:00:00.000Z'),
      expiresAt: new Date('2026-07-24T14:00:00.000Z'),
      rejectionReason: null,
    };
    const rawDocument = {
      id: 42,
      externalId: 'bizbuddy:11111111-1111-4111-8111-111111111111',
      status: 'COMPLETED',
      createdAt: new Date('2026-07-16T14:00:00.000Z'),
      updatedAt: new Date('2026-07-17T14:00:00.000Z'),
      completedAt: new Date('2026-07-17T14:00:00.000Z'),
      deletedAt: null,
      authOptions: { accessCode: 'document-auth-capability' },
      formValues: { answer: 'private-form-value' },
      documentMeta: {
        emailSettings: { token: 'email-settings-capability' },
      },
      recipients: [canonicalRecipient],
      Recipient: [
        {
          ...canonicalRecipient,
          token: 'legacy-live-capability',
          authOptions: { token: 'legacy-auth-capability' },
        },
      ],
    };

    const result = await triggerWebhook({
      event: WebhookTriggerEvents.DOCUMENT_COMPLETED,
      data: rawDocument,
      userId: 7,
      teamId: 9,
    });

    expect(result).toEqual({ matched: 1, enqueued: 1, failed: 0 });
    expect(mocks.triggerJob).toHaveBeenCalledWith({
      name: 'internal.execute-webhook',
      payload: {
        event: WebhookTriggerEvents.DOCUMENT_COMPLETED,
        webhookId: 'webhook-1',
        data: {
          id: 42,
          externalId: 'bizbuddy:11111111-1111-4111-8111-111111111111',
          status: 'COMPLETED',
          createdAt: '2026-07-16T14:00:00.000Z',
          updatedAt: '2026-07-17T14:00:00.000Z',
          completedAt: '2026-07-17T14:00:00.000Z',
          deletedAt: null,
          recipients: [
            {
              id: 101,
              role: 'SIGNER',
              readStatus: 'OPENED',
              signingStatus: 'SIGNED',
              sendStatus: 'SENT',
              signedAt: '2026-07-17T14:00:00.000Z',
              expiresAt: '2026-07-24T14:00:00.000Z',
            },
          ],
        },
      },
    });

    const queuedPayload = mocks.triggerJob.mock.calls[0][0].payload;
    expect(findForbiddenKeys(queuedPayload)).toEqual([]);
    const queuedJson = JSON.stringify(queuedPayload);
    for (const forbiddenValue of [
      'canonical-live-capability',
      'legacy-live-capability',
      'recipient-auth-capability',
      'legacy-auth-capability',
      'document-auth-capability',
      'private-form-value',
      'email-settings-capability',
      'signer@example.test',
      'Sensitive Signer',
    ]) {
      expect(queuedJson).not.toContain(forbiddenValue);
    }
  });

  it('projects once before fan-out and reports enqueue failures', async () => {
    mocks.getAllWebhooksByEventTrigger.mockResolvedValue([
      { id: 'webhook-1' },
      { id: 'webhook-2' },
    ]);
    mocks.triggerJob
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('queue unavailable'));

    const result = await triggerWebhook({
      event: WebhookTriggerEvents.DOCUMENT_COMPLETED,
      data: {
        id: 42,
        externalId: 'bizbuddy:11111111-1111-4111-8111-111111111111',
        status: 'COMPLETED',
        createdAt: '2026-07-16T14:00:00.000Z',
        updatedAt: '2026-07-17T14:00:00.000Z',
        completedAt: '2026-07-17T14:00:00.000Z',
        deletedAt: null,
        recipients: [],
      },
      userId: 7,
      teamId: 9,
    });

    expect(result).toEqual({ matched: 2, enqueued: 1, failed: 1 });
    expect(mocks.triggerJob).toHaveBeenCalledTimes(2);
    expect(mocks.triggerJob.mock.calls[0][0].payload.data).toBe(
      mocks.triggerJob.mock.calls[1][0].payload.data,
    );
  });

  it('reports strict projection failures without enqueueing or throwing after a durable mutation', async () => {
    const result = await triggerWebhook({
      event: WebhookTriggerEvents.DOCUMENT_COMPLETED,
      data: {
        id: 42,
        externalId: 'bizbuddy:not-a-uuid',
        status: 'COMPLETED',
        createdAt: 'not-a-timestamp',
        recipients: [],
      },
      userId: 7,
      teamId: 9,
    });

    expect(result).toEqual({ matched: 1, enqueued: 0, failed: 1 });
    expect(mocks.triggerJob).not.toHaveBeenCalled();
  });

  it('contains envelope-mapping failure inside the non-throwing post-commit boundary', async () => {
    const result = await triggerWebhook({
      event: WebhookTriggerEvents.DOCUMENT_COMPLETED,
      data: () => {
        throw new Error('corrupt secondary ID');
      },
      userId: 7,
      teamId: 9,
    });

    expect(result).toEqual({ matched: 1, enqueued: 0, failed: 1 });
    expect(mocks.triggerJob).not.toHaveBeenCalled();
  });

  it('reports webhook-discovery failure without turning a committed caller into a retry', async () => {
    mocks.getAllWebhooksByEventTrigger.mockRejectedValueOnce(new Error('database unavailable'));

    const result = await triggerWebhook({
      event: WebhookTriggerEvents.DOCUMENT_COMPLETED,
      data: {
        id: 42,
        status: 'COMPLETED',
        createdAt: '2026-07-16T14:00:00.000Z',
        recipients: [],
      },
      userId: 7,
      teamId: 9,
    });

    expect(result).toEqual({ matched: 0, enqueued: 0, failed: 1 });
    expect(mocks.triggerJob).not.toHaveBeenCalled();
  });
});

const FORBIDDEN_KEYS = new Set([
  'token',
  'authOptions',
  'formValues',
  'documentMeta',
  'emailSettings',
  'email',
  'name',
  'Recipient',
  'signingUrl',
]);

const findForbiddenKeys = (value: unknown, path = '$'): string[] => {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findForbiddenKeys(item, `${path}[${index}]`));
  }
  if (!value || typeof value !== 'object') return [];

  return Object.entries(value).flatMap(([key, nested]) => [
    ...(FORBIDDEN_KEYS.has(key) ? [`${path}.${key}`] : []),
    ...findForbiddenKeys(nested, `${path}.${key}`),
  ]);
};
