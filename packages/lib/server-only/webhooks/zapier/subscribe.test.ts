import { WebhookTriggerEvents } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { subscribeHandler } from './subscribe';

const mocks = vi.hoisted(() => ({
  assertNotPrivateUrl: vi.fn(),
  validateApiToken: vi.fn(),
  webhookCreate: vi.fn(),
}));

vi.mock('@documenso/prisma', () => ({
  prisma: {
    webhook: {
      create: mocks.webhookCreate,
    },
  },
}));

vi.mock('../assert-webhook-url', () => ({
  assertNotPrivateUrl: mocks.assertNotPrivateUrl,
}));

vi.mock('./validateApiToken', () => ({
  validateApiToken: mocks.validateApiToken,
}));

const request = () =>
  new Request('https://provider.example.test/api/zapier/subscribe', {
    method: 'POST',
    headers: {
      authorization: 'Bearer invalid-or-valid-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      webhookUrl: 'https://hooks.example.test/documenso',
      eventTrigger: WebhookTriggerEvents.DOCUMENT_COMPLETED,
    }),
  });

describe('subscribeHandler authorization ordering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.validateApiToken.mockResolvedValue({
      userId: 7,
      teamId: 9,
      user: { id: 7 },
    });
    mocks.assertNotPrivateUrl.mockResolvedValue(undefined);
    mocks.webhookCreate.mockResolvedValue({ id: 'webhook-1' });
  });

  it('rejects an invalid bearer before DNS validation or persistence', async () => {
    mocks.validateApiToken.mockRejectedValue(new Error('invalid token'));

    const response = await subscribeHandler(request());

    expect(response.status).toBe(401);
    expect(mocks.assertNotPrivateUrl).not.toHaveBeenCalled();
    expect(mocks.webhookCreate).not.toHaveBeenCalled();
  });

  it('validates the URL only after a valid bearer and before persistence', async () => {
    const response = await subscribeHandler(request());

    expect(response.status).toBe(200);
    expect(mocks.validateApiToken.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.assertNotPrivateUrl.mock.invocationCallOrder[0],
    );
    expect(mocks.assertNotPrivateUrl.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.webhookCreate.mock.invocationCallOrder[0],
    );
  });
});
