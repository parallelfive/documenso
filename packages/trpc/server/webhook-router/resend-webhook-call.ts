import { TEAM_MEMBER_ROLE_PERMISSIONS_MAP } from '@documenso/lib/constants/teams';
import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { enqueueWebhookDelivery } from '@documenso/lib/server-only/webhooks/trigger/enqueue-webhook-delivery';
import { getSafeWebhookResendData } from '@documenso/lib/types/webhook-payload';
import { buildTeamWhereQuery } from '@documenso/lib/utils/teams';
import { prisma } from '@documenso/prisma';

import { authenticatedProcedure } from '../trpc';
import {
  ZResendWebhookCallRequestSchema,
  ZResendWebhookCallResponseSchema,
} from './resend-webhook-call.types';

export const resendWebhookCallRoute = authenticatedProcedure
  .input(ZResendWebhookCallRequestSchema)
  .output(ZResendWebhookCallResponseSchema)
  .mutation(async ({ input, ctx }) => {
    const { teamId, user } = ctx;
    const { webhookId, webhookCallId } = input;

    ctx.logger.info({
      input: { webhookId, webhookCallId },
    });

    const webhookCall = await prisma.webhookCall.findFirst({
      where: {
        id: webhookCallId,
        webhook: {
          id: webhookId,
          team: buildTeamWhereQuery({
            teamId,
            userId: user.id,
            roles: TEAM_MEMBER_ROLE_PERMISSIONS_MAP.MANAGE_TEAM,
          }),
        },
      },
    });

    if (!webhookCall) {
      throw new AppError(AppErrorCode.NOT_FOUND);
    }

    const data = getSafeWebhookResendData(webhookCall.requestBody);
    if (!data) {
      throw new AppError(AppErrorCode.INVALID_BODY, {
        message: 'This webhook delivery does not contain valid lifecycle evidence',
      });
    }

    await enqueueWebhookDelivery({
      event: webhookCall.event,
      webhookId,
      data,
    });
  });
