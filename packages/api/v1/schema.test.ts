import { describe, expect, it, vi } from 'vitest';

vi.mock('@lingui/core/macro', () => ({
  msg: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce(
      (message, part, index) => `${message}${part}${values[index] ?? ''}`,
      '',
    ),
}));

import { ZCreateDocumentMutationSchema } from './schema';

const baseDocument = {
  title: 'Operating agreement',
  externalId: 'bizbuddy:123e4567-e89b-42d3-a456-426614174000',
  recipients: [{ name: 'Ada Lovelace', email: 'ada@example.com' }],
};

describe('ZCreateDocumentMutationSchema', () => {
  it('accepts a bounded envelope expiration period in create-document metadata', () => {
    const parsed = ZCreateDocumentMutationSchema.parse({
      ...baseDocument,
      meta: {
        envelopeExpirationPeriod: { unit: 'day', amount: 30 },
      },
    });

    expect(parsed.meta.envelopeExpirationPeriod).toEqual({ unit: 'day', amount: 30 });
  });

  it('rejects invalid envelope expiration periods', () => {
    expect(() =>
      ZCreateDocumentMutationSchema.parse({
        ...baseDocument,
        meta: {
          envelopeExpirationPeriod: { unit: 'day', amount: 0 },
        },
      }),
    ).toThrow();
  });
});
