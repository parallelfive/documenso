import { projectWebhookLifecycleDocument } from '../../../types/webhook-payload';
import { verify } from '../../crypto/verify';
import { getAllWebhooksByEventTrigger } from '../get-all-webhooks-by-event-trigger';
import { enqueueWebhookDelivery } from './enqueue-webhook-delivery';
import { ZTriggerWebhookBodySchema } from './schema';

export type HandlerTriggerWebhooksResponse =
  | {
      success: true;
      message: string;
    }
  | {
      success: false;
      error: string;
    };

// Todo: [Webhooks] delete after deployment.
export const handlerTriggerWebhooks = async (req: Request) => {
  const signature = req.headers.get('x-webhook-signature');

  if (typeof signature !== 'string') {
    console.log('Missing signature');
    return Response.json({ success: false, error: 'Missing signature' }, { status: 400 });
  }

  const body = await req.json();

  const valid = verify(body, signature);

  if (!valid) {
    console.log('Invalid signature');
    return Response.json({ success: false, error: 'Invalid signature' }, { status: 400 });
  }

  const result = ZTriggerWebhookBodySchema.safeParse(body);

  if (!result.success) {
    console.log('Invalid request body');
    return Response.json({ success: false, error: 'Invalid request body' }, { status: 400 });
  }

  const { event, data, userId, teamId } = result.data;

  const allWebhooks = await getAllWebhooksByEventTrigger({ event, userId, teamId });

  let lifecycleData;
  try {
    lifecycleData = projectWebhookLifecycleDocument(data);
  } catch {
    console.error('Legacy webhook trigger lifecycle projection failed', { event });
    return Response.json({ success: false, error: 'Invalid lifecycle data' }, { status: 400 });
  }

  const enqueueResults = await Promise.allSettled(
    allWebhooks.map(async (webhook) => {
      await enqueueWebhookDelivery({
        event,
        webhookId: webhook.id,
        data: lifecycleData,
      });
    }),
  );

  const rejectedCount = enqueueResults.filter((enqueue) => enqueue.status === 'rejected').length;
  if (rejectedCount > 0) {
    console.error('Legacy webhook trigger enqueue failed', {
      event,
      rejectedCount,
      webhookCount: allWebhooks.length,
    });
    return Response.json({ success: false, error: 'Webhook enqueue failed' }, { status: 500 });
  }

  return Response.json(
    { success: true, message: 'Webhooks queued for execution' },
    { status: 200 },
  );
};
