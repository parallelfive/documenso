import { RecipientRole } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { AppErrorCode } from '../../errors/app-error';
import { assertCorrelatedDocumentRecipientPopulationAllowed } from './assert-correlated-document-recipient-population';

const externalId = 'bizbuddy:11111111-1111-4111-8111-111111111111';
const validRecipient = (index = 1) => ({
  name: `Signer ${index}`,
  email: `signer${index}@example.test`,
  role: RecipientRole.SIGNER,
  signingOrder: 1,
});

describe('assertCorrelatedDocumentRecipientPopulationAllowed', () => {
  it('allows signer-only product cohorts with positive or parallel ordering', () => {
    expect(() =>
      assertCorrelatedDocumentRecipientPopulationAllowed({
        externalId,
        recipients: [
          validRecipient(1),
          validRecipient(2),
          { ...validRecipient(3), signingOrder: null },
        ],
      }),
    ).not.toThrow();
  });

  it.each([1, 25])('allows the correlated recipient boundary: %i', (recipientCount) => {
    expect(() =>
      assertCorrelatedDocumentRecipientPopulationAllowed({
        externalId,
        recipients: Array.from({ length: recipientCount }, (_, index) => validRecipient(index + 1)),
      }),
    ).not.toThrow();
  });

  it.each([0, 26])('rejects the correlated recipient boundary: %i', (recipientCount) => {
    expect(() =>
      assertCorrelatedDocumentRecipientPopulationAllowed({
        externalId,
        recipients: Array.from({ length: recipientCount }, (_, index) => validRecipient(index + 1)),
      }),
    ).toThrow(expect.objectContaining({ code: AppErrorCode.INVALID_REQUEST }));
  });

  it.each([
    {
      label: 'non-signer role',
      recipient: { ...validRecipient(), role: RecipientRole.VIEWER },
    },
    {
      label: 'access authentication',
      recipient: { ...validRecipient(), accessAuth: ['ACCOUNT'] },
    },
    {
      label: 'action authentication',
      recipient: { ...validRecipient(), actionAuth: ['PASSWORD'] },
    },
    {
      label: 'zero signing order',
      recipient: { ...validRecipient(), signingOrder: 0 },
    },
    {
      label: 'fractional signing order',
      recipient: { ...validRecipient(), signingOrder: 1.5 },
    },
    {
      label: 'whitespace-only name',
      recipient: { ...validRecipient(), name: '   ' },
    },
    {
      label: 'overlong normalized name',
      recipient: { ...validRecipient(), name: 'a'.repeat(501) },
    },
    {
      label: 'overlong normalized email',
      recipient: { ...validRecipient(), email: `${'a'.repeat(309)}@example.com` },
    },
  ])('rejects correlated $label outside the execution lease', ({ recipient }) => {
    expect(() =>
      assertCorrelatedDocumentRecipientPopulationAllowed({
        externalId,
        recipients: [recipient],
      }),
    ).toThrow(expect.objectContaining({ code: AppErrorCode.INVALID_REQUEST }));
  });

  it('preserves native recipient creation behavior', () => {
    expect(() =>
      assertCorrelatedDocumentRecipientPopulationAllowed({
        externalId: 'native-document',
        recipients: [
          {
            name: 'Native Viewer',
            email: 'native@example.test',
            role: RecipientRole.VIEWER,
            signingOrder: 0,
            accessAuth: ['ACCOUNT'],
            actionAuth: ['PASSWORD'],
          },
        ],
      }),
    ).not.toThrow();
  });
});
