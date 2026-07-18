import type { WebhookTriggerEvents } from '@prisma/client';

import { jobs } from '../../../jobs/client';
import type { WebhookLifecycleDocument } from '../../../types/webhook-payload';

/**
 * The only producer for `internal.execute-webhook`.
 *
 * Callers must project and strictly parse once before fan-out, so the generic
 * job provider can never persist, enqueue, or log a native payload.
 */
export const enqueueWebhookDelivery = async ({
  event,
  webhookId,
  data,
}: {
  event: WebhookTriggerEvents;
  webhookId: string;
  data: WebhookLifecycleDocument;
}) => {
  await jobs.triggerJob({
    name: 'internal.execute-webhook',
    payload: {
      event,
      webhookId,
      data,
    },
  });
};
