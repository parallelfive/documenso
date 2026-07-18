import { WebhookTriggerEvents } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppError, AppErrorCode } from '../../errors/app-error';
import { createWebhook } from './create-webhook';
import { editWebhook } from './edit-webhook';

const mocks = vi.hoisted(() => ({
  assertNotPrivateUrl: vi.fn(),
  teamFindFirst: vi.fn(),
  webhookCreate: vi.fn(),
  webhookUpdate: vi.fn(),
}));

vi.mock('@documenso/prisma', () => ({
  prisma: {
    team: {
      findFirst: mocks.teamFindFirst,
    },
    webhook: {
      create: mocks.webhookCreate,
      update: mocks.webhookUpdate,
    },
  },
}));

vi.mock('./assert-webhook-url', () => ({
  assertNotPrivateUrl: mocks.assertNotPrivateUrl,
}));

const webhookUrl = 'http://host.docker.internal:3001/api/webhooks/documenso';
const webhookData = {
  webhookUrl,
  eventTriggers: [WebhookTriggerEvents.DOCUMENT_COMPLETED],
  secret: 'shared-secret',
  enabled: true,
};

describe('webhook registration URL validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.teamFindFirst.mockResolvedValue({ id: 9 });
    mocks.assertNotPrivateUrl.mockResolvedValue(undefined);
    mocks.webhookCreate.mockResolvedValue({ id: 'webhook-1' });
    mocks.webhookUpdate.mockResolvedValue({ id: 'webhook-1' });
  });

  it('validates create URLs through the async hardened policy before persistence', async () => {
    await createWebhook({
      ...webhookData,
      userId: 7,
      teamId: 9,
    });

    expect(mocks.assertNotPrivateUrl).toHaveBeenCalledWith(webhookUrl);
    expect(mocks.assertNotPrivateUrl.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.webhookCreate.mock.invocationCallOrder[0],
    );
  });

  it('does not create a webhook when the hardened policy rejects its URL', async () => {
    const validationError = new AppError(AppErrorCode.WEBHOOK_INVALID_REQUEST);
    mocks.assertNotPrivateUrl.mockRejectedValue(validationError);

    await expect(
      createWebhook({
        ...webhookData,
        userId: 7,
        teamId: 9,
      }),
    ).rejects.toBe(validationError);

    expect(mocks.webhookCreate).not.toHaveBeenCalled();
  });

  it('validates edit URLs through the async hardened policy before persistence', async () => {
    await editWebhook({
      id: 'webhook-1',
      data: webhookData,
      userId: 7,
      teamId: 9,
    });

    expect(mocks.assertNotPrivateUrl).toHaveBeenCalledWith(webhookUrl);
    expect(mocks.assertNotPrivateUrl.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.webhookUpdate.mock.invocationCallOrder[0],
    );
  });

  it('does not edit a webhook when the hardened policy rejects its URL', async () => {
    const validationError = new AppError(AppErrorCode.WEBHOOK_INVALID_REQUEST);
    mocks.assertNotPrivateUrl.mockRejectedValue(validationError);

    await expect(
      editWebhook({
        id: 'webhook-1',
        data: webhookData,
        userId: 7,
        teamId: 9,
      }),
    ).rejects.toBe(validationError);

    expect(mocks.webhookUpdate).not.toHaveBeenCalled();
  });

  it('checks edit permission before performing an externally observable DNS lookup', async () => {
    mocks.teamFindFirst.mockResolvedValue(null);

    await expect(
      editWebhook({
        id: 'webhook-1',
        data: webhookData,
        userId: 7,
        teamId: 9,
      }),
    ).rejects.toMatchObject({
      code: AppErrorCode.NOT_FOUND,
    });

    expect(mocks.assertNotPrivateUrl).not.toHaveBeenCalled();
    expect(mocks.webhookUpdate).not.toHaveBeenCalled();
  });
});
