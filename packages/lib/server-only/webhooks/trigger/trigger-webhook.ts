import type { WebhookTriggerEvents } from '@prisma/client';

import { projectWebhookLifecycleDocument } from '../../../types/webhook-payload';
import { getAllWebhooksByEventTrigger } from '../get-all-webhooks-by-event-trigger';
import { enqueueWebhookDelivery } from './enqueue-webhook-delivery';

export type TriggerWebhookOptions = {
  event: WebhookTriggerEvents;
  /**
   * Use a thunk for envelope mapping performed after a durable mutation. The
   * central boundary catches both mapping and strict projection failures.
   */
  data: Record<string, unknown> | (() => Record<string, unknown>);
  userId: number;
  teamId: number;
};

export type TriggerWebhookResult = {
  matched: number;
  enqueued: number;
  failed: number;
};

export const triggerWebhook = async ({ event, data, userId, teamId }: TriggerWebhookOptions) => {
  let registeredWebhooks: Awaited<ReturnType<typeof getAllWebhooksByEventTrigger>>;

  try {
    registeredWebhooks = await getAllWebhooksByEventTrigger({ event, userId, teamId });
  } catch (err) {
    console.error('Webhook discovery failed', {
      event,
      errorName: err instanceof Error ? err.name : 'UnknownError',
    });
    return {
      matched: 0,
      enqueued: 0,
      failed: 1,
    };
  }

  if (registeredWebhooks.length === 0) {
    return {
      matched: 0,
      enqueued: 0,
      failed: 0,
    };
  }

  let lifecycleData: ReturnType<typeof projectWebhookLifecycleDocument>;

  try {
    // Project once before fan-out. Strict projection failure is counted against
    // every matched delivery, but cannot turn an already-committed document
    // transition into a false API/job failure.
    const rawData = typeof data === 'function' ? data() : data;
    lifecycleData = projectWebhookLifecycleDocument(rawData);
  } catch (err) {
    console.error('Webhook lifecycle projection failed', {
      event,
      errorName: err instanceof Error ? err.name : 'UnknownError',
      webhookCount: registeredWebhooks.length,
    });
    return {
      matched: registeredWebhooks.length,
      enqueued: 0,
      failed: registeredWebhooks.length,
    };
  }

  const results = await Promise.allSettled(
    registeredWebhooks.map(async (webhook) => {
      await enqueueWebhookDelivery({
        event,
        webhookId: webhook.id,
        data: lifecycleData,
      });
    }),
  );

  const failed = results.filter((result) => result.status === 'rejected').length;
  const result = {
    matched: registeredWebhooks.length,
    enqueued: registeredWebhooks.length - failed,
    failed,
  };

  if (failed > 0) {
    console.error('Webhook enqueue failed', {
      event,
      rejectedCount: failed,
      webhookCount: registeredWebhooks.length,
    });
  }

  return result;
};
