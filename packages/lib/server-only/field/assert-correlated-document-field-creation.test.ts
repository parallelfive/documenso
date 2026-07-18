import { FieldType } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { AppErrorCode } from '../../errors/app-error';
import { assertCorrelatedDocumentFieldCreationAllowed } from './assert-correlated-document-field-creation';

const externalId = 'bizbuddy:11111111-1111-4111-8111-111111111111';
const validField = {
  type: FieldType.SIGNATURE,
  page: 1,
  positionX: 10,
  positionY: 20,
  width: 100,
  height: 40,
};

describe('assertCorrelatedDocumentFieldCreationAllowed', () => {
  it('allows the product coordinate-only signature field', () => {
    expect(() =>
      assertCorrelatedDocumentFieldCreationAllowed({
        externalId,
        fields: [validField],
      }),
    ).not.toThrow();
  });

  it('allows the exact field-capacity boundary', () => {
    expect(() =>
      assertCorrelatedDocumentFieldCreationAllowed({
        externalId,
        fields: [validField],
        existingFieldCount: 999,
      }),
    ).not.toThrow();
  });

  it('rejects a batch that would exceed field capacity', () => {
    expect(() =>
      assertCorrelatedDocumentFieldCreationAllowed({
        externalId,
        fields: [validField],
        existingFieldCount: 1_000,
      }),
    ).toThrow(expect.objectContaining({ code: AppErrorCode.INVALID_REQUEST }));
  });

  it.each([
    {
      label: 'advanced field type',
      field: { ...validField, type: FieldType.TEXT },
    },
    {
      label: 'signature metadata',
      field: { ...validField, fieldMeta: { type: 'signature' } },
    },
    {
      label: 'placeholder placement',
      field: { ...validField, placeholder: '{{signature}}' },
    },
    {
      label: 'custom text',
      field: { ...validField, customText: 'mutable' },
    },
    {
      label: 'inserted state',
      field: { ...validField, inserted: false },
    },
    {
      label: 'zero width',
      field: { ...validField, width: 0 },
    },
    {
      label: 'negative height',
      field: { ...validField, height: -1 },
    },
    {
      label: 'non-finite width',
      field: { ...validField, width: Number.POSITIVE_INFINITY },
    },
    {
      label: 'NaN height',
      field: { ...validField, height: Number.NaN },
    },
    {
      label: 'fractional page',
      field: { ...validField, page: 1.5 },
    },
    {
      label: 'non-finite position',
      field: { ...validField, positionX: Number.NEGATIVE_INFINITY },
    },
  ])('rejects correlated $label outside the lease', ({ field }) => {
    expect(() =>
      assertCorrelatedDocumentFieldCreationAllowed({
        externalId,
        fields: [field],
      }),
    ).toThrow(expect.objectContaining({ code: AppErrorCode.INVALID_REQUEST }));
  });

  it('preserves native field creation behavior', () => {
    expect(() =>
      assertCorrelatedDocumentFieldCreationAllowed({
        externalId: 'native-document',
        fields: [{ type: FieldType.TEXT, fieldMeta: { type: 'text' } }],
        existingFieldCount: 1_001,
      }),
    ).not.toThrow();
  });
});
