import { describe, expect, it, vi } from 'vitest';

import {
  getExactApiEnvelopeField,
  getExactApiEnvelopeRecipient,
  hasExactApiEnvelopeRecipients,
} from './exact-envelope-child';

const dependencies = {
  findRecipient: vi.fn(),
  findField: vi.fn(),
  findRecipientIds: vi.fn(),
};

describe('API v1 envelope child binding', () => {
  it.each([
    {
      child: 'recipient',
      lookup: async () =>
        await getExactApiEnvelopeRecipient('envelope_expected', 12, {
          ...dependencies,
          findRecipient: vi.fn().mockResolvedValue({
            id: 12,
            envelopeId: 'envelope_other',
          }),
        }),
    },
    {
      child: 'field',
      lookup: async () =>
        await getExactApiEnvelopeField('envelope_expected', 34, {
          ...dependencies,
          findField: vi.fn().mockResolvedValue({
            id: 34,
            envelopeId: 'envelope_other',
          }),
        }),
    },
  ])('denies a $child whose path envelope does not match', async ({ lookup }) => {
    await expect(lookup()).resolves.toBeNull();
  });

  it('denies resend when any recipient belongs to another envelope', async () => {
    const findRecipientIds = vi.fn().mockResolvedValue([12]);

    const result = await hasExactApiEnvelopeRecipients('envelope_expected', [12, 13], {
      ...dependencies,
      findRecipientIds,
    });

    expect(result).toBe(false);
    expect(findRecipientIds).toHaveBeenCalledWith([12, 13], 'envelope_expected');
  });

  it.each([
    { label: 'duplicate', recipientIds: [12, 12] },
    { label: 'zero', recipientIds: [0] },
    { label: 'unsafe', recipientIds: [Number.MAX_SAFE_INTEGER + 1] },
  ])('rejects $label resend recipient ids before querying', async ({ recipientIds }) => {
    const findRecipientIds = vi.fn();

    const result = await hasExactApiEnvelopeRecipients('envelope_expected', recipientIds, {
      ...dependencies,
      findRecipientIds,
    });

    expect(result).toBe(false);
    expect(findRecipientIds).not.toHaveBeenCalled();
  });
});
