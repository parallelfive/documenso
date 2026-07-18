import { describe, expect, it } from 'vitest';

import { buildCreateDocumentMeta } from './create-document-meta';

describe('buildCreateDocumentMeta', () => {
  it('passes the API expiration period into the persisted envelope metadata', () => {
    expect(
      buildCreateDocumentMeta({
        meta: {
          subject: 'Please sign',
          message: 'Review and sign',
          envelopeExpirationPeriod: { unit: 'day', amount: 14 },
        },
        externalId: null,
        timezone: 'America/New_York',
        dateFormat: 'yyyy-MM-dd',
      }),
    ).toMatchObject({
      subject: 'Please sign',
      message: 'Review and sign',
      timezone: 'America/New_York',
      dateFormat: 'yyyy-MM-dd',
      envelopeExpirationPeriod: { unit: 'day', amount: 14 },
    });
  });

  it('forces next-signer identity replacement off for a correlated document', () => {
    expect(
      buildCreateDocumentMeta({
        meta: {
          allowDictateNextSigner: true,
        },
        externalId: 'bizbuddy:123e4567-e89b-42d3-a456-426614174000',
        timezone: 'America/New_York',
        dateFormat: 'yyyy-MM-dd',
      }).allowDictateNextSigner,
    ).toBe(false);
  });

  it('preserves native next-signer behavior', () => {
    expect(
      buildCreateDocumentMeta({
        meta: {
          allowDictateNextSigner: true,
        },
        externalId: 'native-document',
        timezone: 'America/New_York',
        dateFormat: 'yyyy-MM-dd',
      }).allowDictateNextSigner,
    ).toBe(true);
  });
});
