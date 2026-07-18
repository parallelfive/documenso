import { WebhookTriggerEvents } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { triggerTestWebhook } from './trigger-test-webhook';

const mocks = vi.hoisted(() => ({
  getWebhookById: vi.fn(),
  enqueueWebhookDelivery: vi.fn(),
  generateSampleWebhookPayload: vi.fn(),
}));

vi.mock('./get-webhook-by-id', () => ({
  getWebhookById: mocks.getWebhookById,
}));

vi.mock('./trigger/enqueue-webhook-delivery', () => ({
  enqueueWebhookDelivery: mocks.enqueueWebhookDelivery,
}));

vi.mock('./trigger/generate-sample-data', () => ({
  generateSampleWebhookPayload: mocks.generateSampleWebhookPayload,
}));

describe('triggerTestWebhook exact target', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getWebhookById.mockResolvedValue({
      id: 'webhook-selected',
      enabled: true,
      eventTriggers: [WebhookTriggerEvents.DOCUMENT_COMPLETED],
      webhookUrl: 'https://example.test/webhook',
    });
    mocks.generateSampleWebhookPayload.mockReturnValue({
      payload: {
        id: 42,
        externalId: null,
        status: 'COMPLETED',
        createdAt: '2026-07-17T14:00:00.000Z',
        updatedAt: '2026-07-17T14:00:00.000Z',
        completedAt: null,
        deletedAt: null,
        recipients: [],
      },
    });
    mocks.enqueueWebhookDelivery.mockResolvedValue(undefined);
  });

  it('queues only the selected webhook ID instead of fanning out by event', async () => {
    await expect(
      triggerTestWebhook({
        id: 'webhook-selected',
        event: WebhookTriggerEvents.DOCUMENT_COMPLETED,
        userId: 7,
        teamId: 9,
      }),
    ).resolves.toEqual({
      success: true,
      message: 'Test webhook triggered successfully',
    });

    expect(mocks.enqueueWebhookDelivery).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueWebhookDelivery).toHaveBeenCalledWith({
      event: WebhookTriggerEvents.DOCUMENT_COMPLETED,
      webhookId: 'webhook-selected',
      data: {
        id: 42,
        externalId: null,
        status: 'COMPLETED',
        createdAt: '2026-07-17T14:00:00.000Z',
        updatedAt: '2026-07-17T14:00:00.000Z',
        completedAt: null,
        deletedAt: null,
        recipients: [],
      },
    });
  });

  it('surfaces exact-target enqueue failure to the trigger-only caller', async () => {
    mocks.enqueueWebhookDelivery.mockRejectedValueOnce(new Error('queue unavailable'));

    await expect(
      triggerTestWebhook({
        id: 'webhook-selected',
        event: WebhookTriggerEvents.DOCUMENT_COMPLETED,
        userId: 7,
        teamId: 9,
      }),
    ).resolves.toEqual({
      success: false,
      error: 'queue unavailable',
    });
  });
});
