import type { WebhookTriggerEvents } from '@prisma/client';

import { prisma } from '@documenso/prisma';

import { TEAM_MEMBER_ROLE_PERMISSIONS_MAP } from '../../constants/teams';
import { AppError, AppErrorCode } from '../../errors/app-error';
import { buildTeamWhereQuery } from '../../utils/teams';
import { assertNotPrivateUrl } from './assert-webhook-url';

export type EditWebhookOptions = {
  id: string;
  data: {
    webhookUrl: string;
    eventTriggers: WebhookTriggerEvents[];
    secret: string | null;
    enabled: boolean;
  };
  userId: number;
  teamId: number;
};

export const editWebhook = async ({ id, data, userId, teamId }: EditWebhookOptions) => {
  const team = await prisma.team.findFirst({
    where: buildTeamWhereQuery({
      teamId,
      userId,
      roles: TEAM_MEMBER_ROLE_PERMISSIONS_MAP['MANAGE_TEAM'],
    }),
  });

  if (!team) {
    throw new AppError(AppErrorCode.NOT_FOUND, {
      message: 'Team not found',
    });
  }

  await assertNotPrivateUrl(data.webhookUrl);

  return await prisma.webhook.update({
    where: {
      id,
      team: buildTeamWhereQuery({
        teamId,
        userId,
        roles: TEAM_MEMBER_ROLE_PERMISSIONS_MAP['MANAGE_TEAM'],
      }),
    },
    data: {
      ...data,
    },
  });
};
