import { WebhookTriggerEvents } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { handlerTriggerWebhooks } from './handler';

const mocks = vi.hoisted(() => ({
  triggerJob: vi.fn(),
  verify: vi.fn(),
  getAllWebhooksByEventTrigger: vi.fn(),
}));

vi.mock('../../../jobs/client', () => ({
  jobs: {
    triggerJob: mocks.triggerJob,
  },
}));

vi.mock('../../crypto/verify', () => ({
  verify: mocks.verify,
}));

vi.mock('../get-all-webhooks-by-event-trigger', () => ({
  getAllWebhooksByEventTrigger: mocks.getAllWebhooksByEventTrigger,
}));

describe('legacy webhook trigger handler capability boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.verify.mockReturnValue(true);
    mocks.getAllWebhooksByEventTrigger.mockResolvedValue([{ id: 'webhook-1' }]);
    mocks.triggerJob.mockResolvedValue(undefined);
  });

  it('projects the signed legacy request before enqueueing it', async () => {
    const body = {
      event: WebhookTriggerEvents.DOCUMENT_COMPLETED,
      userId: 7,
      teamId: 9,
      data: {
        id: 42,
        externalId: 'bizbuddy:11111111-1111-4111-8111-111111111111',
        status: 'COMPLETED',
        createdAt: '2026-07-16T14:00:00.000Z',
        updatedAt: '2026-07-17T14:00:00.000Z',
        completedAt: '2026-07-17T14:00:00.000Z',
        deletedAt: null,
        authOptions: { token: 'document-auth-capability' },
        recipients: [
          {
            id: 101,
            email: 'signer@example.test',
            name: 'Sensitive Signer',
            token: 'live-recipient-capability',
            authOptions: { token: 'recipient-auth-capability' },
            role: 'SIGNER',
            readStatus: 'OPENED',
            signingStatus: 'SIGNED',
            sendStatus: 'SENT',
            signedAt: '2026-07-17T14:00:00.000Z',
            expiresAt: '2026-07-24T14:00:00.000Z',
            rejectionReason: null,
          },
        ],
      },
    };

    const response = await handlerTriggerWebhooks(
      new Request('https://documenso.example.test/api/webhook/trigger', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-webhook-signature': 'valid-signature',
        },
        body: JSON.stringify(body),
      }),
    );

    expect(response.status).toBe(200);
    const queuedJson = JSON.stringify(mocks.triggerJob.mock.calls[0][0]);
    expect(queuedJson).not.toContain('live-recipient-capability');
    expect(queuedJson).not.toContain('recipient-auth-capability');
    expect(queuedJson).not.toContain('document-auth-capability');
    expect(queuedJson).not.toContain('signer@example.test');
    expect(queuedJson).not.toContain('Sensitive Signer');
    expect(mocks.triggerJob.mock.calls[0][0]).toMatchObject({
      name: 'internal.execute-webhook',
      payload: {
        event: WebhookTriggerEvents.DOCUMENT_COMPLETED,
        webhookId: 'webhook-1',
        data: {
          id: 42,
          recipients: [
            {
              id: 101,
              signingStatus: 'SIGNED',
            },
          ],
        },
      },
    });
  });

  it('rejects invalid lifecycle data before fan-out', async () => {
    const body = {
      event: WebhookTriggerEvents.DOCUMENT_COMPLETED,
      userId: 7,
      teamId: 9,
      data: {
        id: 42,
        externalId: 'bizbuddy:not-a-uuid',
        status: 'COMPLETED',
        createdAt: '2026-07-16T14:00:00.000Z',
        updatedAt: '2026-07-17T14:00:00.000Z',
        completedAt: '2026-07-17T14:00:00.000Z',
        deletedAt: null,
        recipients: [],
      },
    };

    const response = await handlerTriggerWebhooks(
      new Request('https://documenso.example.test/api/webhook/trigger', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-webhook-signature': 'valid-signature',
        },
        body: JSON.stringify(body),
      }),
    );

    expect(response.status).toBe(400);
    expect(mocks.triggerJob).not.toHaveBeenCalled();
  });

  it('returns 500 when any enqueue fails instead of silently reporting success', async () => {
    mocks.getAllWebhooksByEventTrigger.mockResolvedValue([
      { id: 'webhook-1' },
      { id: 'webhook-2' },
    ]);
    mocks.triggerJob
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('queue unavailable'));

    const body = {
      event: WebhookTriggerEvents.DOCUMENT_COMPLETED,
      userId: 7,
      teamId: 9,
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
    };

    const response = await handlerTriggerWebhooks(
      new Request('https://documenso.example.test/api/webhook/trigger', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-webhook-signature': 'valid-signature',
        },
        body: JSON.stringify(body),
      }),
    );

    expect(response.status).toBe(500);
    expect(mocks.triggerJob).toHaveBeenCalledTimes(2);
  });
});
