import type { WebhookTriggerEvents } from '@prisma/client';

import { projectWebhookLifecycleDocument } from '../../types/webhook-payload';
import { getWebhookById } from './get-webhook-by-id';
import { enqueueWebhookDelivery } from './trigger/enqueue-webhook-delivery';
import { generateSampleWebhookPayload } from './trigger/generate-sample-data';

export type TriggerTestWebhookOptions = {
  id: string;
  event: WebhookTriggerEvents;
  userId: number;
  teamId: number;
};

export const triggerTestWebhook = async ({
  id,
  event,
  userId,
  teamId,
}: TriggerTestWebhookOptions) => {
  const webhook = await getWebhookById({ id, userId, teamId });

  if (!webhook.enabled) {
    throw new Error('Webhook is disabled');
  }

  if (!webhook.eventTriggers.includes(event)) {
    throw new Error(`Webhook does not support event: ${event}`);
  }

  const samplePayload = generateSampleWebhookPayload(event, webhook.webhookUrl);

  try {
    const data = projectWebhookLifecycleDocument(samplePayload.payload);

    await enqueueWebhookDelivery({
      event,
      webhookId: webhook.id,
      data,
    });

    return { success: true, message: 'Test webhook triggered successfully' };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
};
