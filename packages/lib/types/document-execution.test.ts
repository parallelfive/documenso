import { DocumentSigningOrder, FieldType, RecipientRole } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import {
  ZExpectedDocumentExecutionSchema,
  matchesExpectedDocumentExecution,
  toDocumentExecutionSnapshot,
} from './document-execution';

const expectedExecution = {
  externalId: 'bizbuddy:decision-01',
  signingOrder: DocumentSigningOrder.SEQUENTIAL,
  expectedPdf: {
    sha256: 'a'.repeat(64),
    byteLength: 1_024,
  },
  recipients: [
    {
      id: 101,
      name: 'José Signer',
      email: 'signer@example.test',
      role: RecipientRole.SIGNER,
      signingOrder: 1,
    },
  ],
  fields: [
    {
      id: 201,
      recipientId: 101,
      type: FieldType.SIGNATURE,
      page: 1,
      positionX: 10,
      positionY: 20,
      width: 100,
      height: 40,
    },
  ],
};

const prismaExecutionRow = {
  externalId: expectedExecution.externalId,
  documentMeta: {
    signingOrder: expectedExecution.signingOrder,
  },
  recipients: [
    {
      ...expectedExecution.recipients[0],
      name: '  Jose\u0301 Signer  ',
      email: '  SIGNER@EXAMPLE.TEST ',
      token: 'must-never-enter-the-lease',
      authOptions: { actionAuth: ['PASSKEY'] },
      sendStatus: 'NOT_SENT',
    },
  ],
  fields: [
    {
      ...expectedExecution.fields[0],
      positionX: { toString: () => '10' },
      positionY: { toString: () => '20' },
      width: { toString: () => '100' },
      height: { toString: () => '40' },
      fieldMeta: { type: 'SIGNATURE' },
    },
  ],
};

describe('document execution lease', () => {
  it('maps realistic Prisma rows to a narrow, canonical, capability-free snapshot', () => {
    const snapshot = toDocumentExecutionSnapshot(prismaExecutionRow);

    expect(snapshot).toEqual({
      externalId: expectedExecution.externalId,
      signingOrder: expectedExecution.signingOrder,
      recipients: expectedExecution.recipients,
      fields: expectedExecution.fields,
    });
    expect(JSON.stringify(snapshot)).not.toContain('must-never-enter-the-lease');
    expect(matchesExpectedDocumentExecution(prismaExecutionRow, expectedExecution)).toBe(true);
  });

  it.each([
    {
      label: 'upper-case digest',
      expectedPdf: { ...expectedExecution.expectedPdf, sha256: 'A'.repeat(64) },
    },
    {
      label: 'short digest',
      expectedPdf: { ...expectedExecution.expectedPdf, sha256: 'a'.repeat(63) },
    },
    {
      label: 'zero length',
      expectedPdf: { ...expectedExecution.expectedPdf, byteLength: 0 },
    },
    {
      label: 'fractional length',
      expectedPdf: { ...expectedExecution.expectedPdf, byteLength: 1.5 },
    },
  ])('rejects an invalid PDF content lease: $label', ({ expectedPdf }) => {
    expect(
      ZExpectedDocumentExecutionSchema.safeParse({
        ...expectedExecution,
        expectedPdf,
      }).success,
    ).toBe(false);
  });

  it('normalizes expected names and emails before enforcing bounds', () => {
    const parsed = ZExpectedDocumentExecutionSchema.parse({
      ...expectedExecution,
      recipients: [
        {
          ...expectedExecution.recipients[0],
          name: '  Jose\u0301 Signer  ',
          email: '  SIGNER@EXAMPLE.TEST ',
        },
      ],
    });

    expect(parsed.recipients[0]).toMatchObject({
      name: 'José Signer',
      email: 'signer@example.test',
    });
  });

  it.each([1, 25])('accepts the correlated execution recipient boundary: %i', (recipientCount) => {
    expect(
      ZExpectedDocumentExecutionSchema.safeParse({
        ...expectedExecution,
        recipients: Array.from({ length: recipientCount }, (_, index) => ({
          ...expectedExecution.recipients[0],
          id: index + 1,
          name: `Signer ${index + 1}`,
          email: `signer${index + 1}@example.test`,
        })),
      }).success,
    ).toBe(true);
  });

  it.each([0, 26])('rejects the correlated execution recipient boundary: %i', (recipientCount) => {
    expect(
      ZExpectedDocumentExecutionSchema.safeParse({
        ...expectedExecution,
        recipients: Array.from({ length: recipientCount }, (_, index) => ({
          ...expectedExecution.recipients[0],
          id: index + 1,
          name: `Signer ${index + 1}`,
          email: `signer${index + 1}@example.test`,
        })),
      }).success,
    ).toBe(false);
  });

  it('preserves the native execution-lease recipient ceiling', () => {
    expect(
      ZExpectedDocumentExecutionSchema.safeParse({
        ...expectedExecution,
        externalId: 'native-document',
        recipients: Array.from({ length: 26 }, (_, index) => ({
          ...expectedExecution.recipients[0],
          id: index + 1,
          name: `Signer ${index + 1}`,
          email: `signer${index + 1}@example.test`,
        })),
      }).success,
    ).toBe(true);
  });

  it.each([
    {
      label: 'external correlation',
      execution: { ...expectedExecution, externalId: 'bizbuddy:other-decision' },
    },
    {
      label: 'recipient order',
      execution: {
        ...expectedExecution,
        recipients: [{ ...expectedExecution.recipients[0], signingOrder: 2 }],
      },
    },
    {
      label: 'field placement',
      execution: {
        ...expectedExecution,
        fields: [{ ...expectedExecution.fields[0], positionX: 11 }],
      },
    },
  ])('rejects a stale $label lease', ({ execution }) => {
    expect(matchesExpectedDocumentExecution(prismaExecutionRow, execution)).toBe(false);
  });
});
