import {
  DocumentSigningOrder,
  FieldType,
  ReadStatus,
  RecipientRole,
  SendStatus,
  SigningStatus,
} from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { MAX_REJECTION_REASON_BYTES } from '@documenso/lib/types/rejection-reason';

import {
  ZCreateDocumentMutationResponseSchema,
  ZCreateDocumentMutationSchema,
  ZSuccessfulFieldCreationResponseSchema,
  ZSuccessfulGetDocumentResponseSchema,
  ZSuccessfulResponseSchema,
  ZSuccessfulSigningResponseSchema,
} from './schema';

vi.mock('@lingui/core/macro', () => ({
  msg: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((message, part, index) => `${message}${part}${values[index] ?? ''}`, ''),
}));

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

  it('rejects signer-visible attachments on a correlated document', () => {
    expect(
      ZCreateDocumentMutationSchema.safeParse({
        ...baseDocument,
        attachments: [
          {
            label: 'Mutable policy',
            data: 'https://example.test/policy',
          },
        ],
      }).success,
    ).toBe(false);

    expect(
      ZCreateDocumentMutationSchema.safeParse({
        ...baseDocument,
        externalId: 'native-document',
        attachments: [
          {
            label: 'Native policy',
            data: 'https://example.test/policy',
          },
        ],
      }).success,
    ).toBe(true);
  });

  it('rejects document authentication on a correlated document', () => {
    expect(
      ZCreateDocumentMutationSchema.safeParse({
        ...baseDocument,
        authOptions: {
          globalAccessAuth: 'ACCOUNT',
        },
      }).success,
    ).toBe(false);
  });

  it.each([{}, { signerName: 'Ada Lovelace' }])(
    'rejects defined form values on a correlated document: %j',
    (formValues) => {
      expect(
        ZCreateDocumentMutationSchema.safeParse({
          ...baseDocument,
          formValues,
        }).success,
      ).toBe(false);
    },
  );

  it('rejects next-signer identity replacement on a correlated document', () => {
    const result = ZCreateDocumentMutationSchema.safeParse({
      ...baseDocument,
      meta: {
        allowDictateNextSigner: true,
      },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({
          path: ['meta', 'allowDictateNextSigner'],
        }),
      );
    }

    expect(
      ZCreateDocumentMutationSchema.safeParse({
        ...baseDocument,
        externalId: 'native-document',
        meta: {
          allowDictateNextSigner: true,
        },
      }).success,
    ).toBe(true);
  });

  it.each([
    'bizbuddy:not-a-uuid',
    'BIZBUDDY:123e4567-e89b-42d3-a456-426614174000',
    'bizbuddy:123E4567-E89B-42D3-A456-426614174000',
  ])('rejects a non-canonical correlated external ID: %s', (externalId) => {
    expect(
      ZCreateDocumentMutationSchema.safeParse({
        ...baseDocument,
        externalId,
      }).success,
    ).toBe(false);
  });

  it.each([
    {
      label: 'non-signer recipient',
      recipient: {
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        role: RecipientRole.VIEWER,
      },
    },
    {
      label: 'zero signing order',
      recipient: {
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        role: RecipientRole.SIGNER,
        signingOrder: 0,
      },
    },
    {
      label: 'fractional signing order',
      recipient: {
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        role: RecipientRole.SIGNER,
        signingOrder: 1.5,
      },
    },
  ])('rejects a correlated $label', ({ recipient }) => {
    expect(
      ZCreateDocumentMutationSchema.safeParse({
        ...baseDocument,
        recipients: [recipient],
      }).success,
    ).toBe(false);
  });

  it('allows shared positive signer cohorts on a correlated document', () => {
    expect(
      ZCreateDocumentMutationSchema.safeParse({
        ...baseDocument,
        recipients: [
          { name: 'Ada Lovelace', email: 'ada@example.com', signingOrder: 1 },
          { name: 'Grace Hopper', email: 'grace@example.com', signingOrder: 1 },
        ],
      }).success,
    ).toBe(true);
  });

  it.each([1, 25])('accepts the correlated recipient boundary: %i', (recipientCount) => {
    expect(
      ZCreateDocumentMutationSchema.safeParse({
        ...baseDocument,
        recipients: Array.from({ length: recipientCount }, (_, index) => ({
          name: `Signer ${index + 1}`,
          email: `signer${index + 1}@example.com`,
        })),
      }).success,
    ).toBe(true);
  });

  it.each([0, 26])('rejects the correlated recipient boundary: %i', (recipientCount) => {
    expect(
      ZCreateDocumentMutationSchema.safeParse({
        ...baseDocument,
        recipients: Array.from({ length: recipientCount }, (_, index) => ({
          name: `Signer ${index + 1}`,
          email: `signer${index + 1}@example.com`,
        })),
      }).success,
    ).toBe(false);
  });

  it.each([
    { label: 'whitespace-only name', name: '   ', email: 'ada@example.com' },
    { label: 'overlong normalized name', name: 'a'.repeat(501), email: 'ada@example.com' },
    {
      label: 'overlong normalized email',
      name: 'Ada Lovelace',
      email: `${'a'.repeat(309)}@example.com`,
    },
  ])('rejects a correlated recipient with $label', ({ name, email }) => {
    expect(
      ZCreateDocumentMutationSchema.safeParse({
        ...baseDocument,
        recipients: [{ name, email }],
      }).success,
    ).toBe(false);
  });

  it('preserves native document authentication and recipient roles', () => {
    expect(
      ZCreateDocumentMutationSchema.safeParse({
        ...baseDocument,
        externalId: 'native-document',
        recipients: [
          {
            name: 'Ada Lovelace',
            email: 'ada@example.com',
            role: RecipientRole.VIEWER,
            signingOrder: 0,
          },
        ],
        authOptions: {
          globalActionAuth: 'ACCOUNT',
        },
        formValues: {
          signerName: 'Ada Lovelace',
        },
      }).success,
    ).toBe(true);
  });
});

const successfulDocument = {
  id: 42,
  externalId: 'bizbuddy:123e4567-e89b-42d3-a456-426614174000',
  userId: 3,
  teamId: 7,
  folderId: null,
  title: 'Operating agreement',
  status: 'DRAFT',
  createdAt: new Date('2026-07-17T10:00:00.000Z'),
  updatedAt: new Date('2026-07-17T10:00:00.000Z'),
  completedAt: null,
};

const successfulRecipient = {
  id: 12,
  documentId: 42,
  email: 'ada@example.com',
  name: 'Ada Lovelace',
  role: RecipientRole.SIGNER,
  signingOrder: null,
  token: 'recipient-capability',
  expiresAt: null,
  expirationNotifiedAt: null,
  signedAt: new Date('2026-07-17T10:05:00.000Z'),
  readStatus: ReadStatus.OPENED,
  signingStatus: SigningStatus.REJECTED,
  sendStatus: SendStatus.SENT,
  signingUrl: 'https://sign.example/sign/recipient-capability',
};

describe('API v1 provider response identity', () => {
  it('carries the authenticated team identity even when the document list is empty', () => {
    expect(
      ZSuccessfulResponseSchema.parse({
        teamId: 7,
        documents: [],
        totalPages: 0,
      }),
    ).toEqual({
      teamId: 7,
      documents: [],
      totalPages: 0,
    });
  });

  it('rejects a list row whose team differs from the authenticated top-level team', () => {
    expect(
      ZSuccessfulResponseSchema.safeParse({
        teamId: 7,
        documents: [{ ...successfulDocument, teamId: 8 }],
        totalPages: 1,
      }).success,
    ).toBe(false);
  });

  it('returns the authenticated team and exact external correlation after create', () => {
    const response = ZCreateDocumentMutationResponseSchema.parse({
      uploadUrl: 'https://garage.internal/documents/envelope.pdf?signature=opaque',
      documentId: 42,
      teamId: 7,
      externalId: successfulDocument.externalId,
      recipients: [],
    });

    expect(response).toMatchObject({
      documentId: 42,
      teamId: 7,
      externalId: successfulDocument.externalId,
    });
  });
});

describe('API v1 lifecycle response shapes', () => {
  it('exposes a nullable UTF-8-bounded rejection reason only on the authenticated exact GET', () => {
    const exactReason = 'a'.repeat(MAX_REJECTION_REASON_BYTES);
    const response = ZSuccessfulGetDocumentResponseSchema.parse({
      ...successfulDocument,
      status: 'REJECTED',
      signingOrder: DocumentSigningOrder.SEQUENTIAL,
      recipients: [{ ...successfulRecipient, rejectionReason: exactReason }],
      fields: [],
    });

    expect(response.recipients[0].rejectionReason).toBe(exactReason);
    expect(
      ZSuccessfulGetDocumentResponseSchema.safeParse({
        ...successfulDocument,
        status: 'REJECTED',
        signingOrder: DocumentSigningOrder.SEQUENTIAL,
        recipients: [
          {
            ...successfulRecipient,
            rejectionReason: 'a'.repeat(MAX_REJECTION_REASON_BYTES + 1),
          },
        ],
        fields: [],
      }).success,
    ).toBe(false);

    const sendResponse = ZSuccessfulSigningResponseSchema.parse({
      ...successfulDocument,
      status: 'PENDING',
      message: 'Document sent for signing successfully',
      recipients: [{ ...successfulRecipient, rejectionReason: 'must stay GET-only' }],
    });
    expect(sendResponse.recipients[0]).not.toHaveProperty('rejectionReason');
  });

  it('exposes only the bounded document-level signing order on exact GET', () => {
    const response = ZSuccessfulGetDocumentResponseSchema.parse({
      ...successfulDocument,
      signingOrder: DocumentSigningOrder.SEQUENTIAL,
      recipients: [],
      fields: [],
    });

    expect(response.signingOrder).toBe(DocumentSigningOrder.SEQUENTIAL);
    expect(
      ZSuccessfulGetDocumentResponseSchema.safeParse({
        ...successfulDocument,
        signingOrder: 'OUT_OF_BAND_MODE',
        recipients: [],
        fields: [],
      }).success,
    ).toBe(false);
  });

  it('keeps the standard send response on id and teamId, not a fabricated documentId', () => {
    const response = ZSuccessfulSigningResponseSchema.parse({
      ...successfulDocument,
      status: 'PENDING',
      message: 'Document sent for signing successfully',
      recipients: [],
    });

    expect(response.id).toBe(42);
    expect(response.teamId).toBe(7);
    expect('documentId' in response).toBe(false);
    expect(
      ZSuccessfulSigningResponseSchema.safeParse({
        ...successfulDocument,
        id: undefined,
        documentId: 42,
        message: 'Document sent for signing successfully',
        recipients: [],
      }).success,
    ).toBe(false);
  });

  it('keeps a scalar create-field request in the documented wrapper array', () => {
    const field = {
      id: 34,
      documentId: 42,
      recipientId: 12,
      type: FieldType.SIGNATURE,
      pageNumber: 1,
      pageX: 10,
      pageY: 20,
      pageWidth: 100,
      pageHeight: 40,
      customText: '',
      fieldMeta: undefined,
      inserted: false,
    };

    const response = ZSuccessfulFieldCreationResponseSchema.parse({
      fields: [field],
      documentId: 42,
    });

    expect(response).toEqual({ fields: [field], documentId: 42 });
    expect('id' in response).toBe(false);
    expect(
      ZSuccessfulFieldCreationResponseSchema.safeParse({
        id: 34,
        documentId: 42,
      }).success,
    ).toBe(false);
  });
});
