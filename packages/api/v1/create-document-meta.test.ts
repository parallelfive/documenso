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
});
