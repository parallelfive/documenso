import { DocumentStatus, EnvelopeType } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { AppErrorCode } from '../../errors/app-error';
import { assertCorrelatedDocumentContentImmutable } from './assert-correlated-document-content-immutable';

describe('assertCorrelatedDocumentContentImmutable', () => {
  it.each([DocumentStatus.DRAFT, DocumentStatus.PENDING])(
    'rejects correlated content mutation in %s so a stale draft cannot race dispatch',
    (status) => {
      expect(() =>
        assertCorrelatedDocumentContentImmutable({
          type: EnvelopeType.DOCUMENT,
          externalId: 'bizbuddy:envelope_01',
          // Status is deliberately irrelevant: correlated source content is
          // immutable before and after the atomic DRAFT -> PENDING claim.
          ...{ status },
        }),
      ).toThrow(
        expect.objectContaining({
          code: AppErrorCode.CONFLICT,
        }),
      );
    },
  );

  it('retains native document and template item editing', () => {
    expect(() =>
      assertCorrelatedDocumentContentImmutable({
        type: EnvelopeType.DOCUMENT,
        externalId: 'native-document',
      }),
    ).not.toThrow();
    expect(() =>
      assertCorrelatedDocumentContentImmutable({
        type: EnvelopeType.TEMPLATE,
        externalId: 'bizbuddy:template',
      }),
    ).not.toThrow();
  });
});
