import {
  DocumentStatus,
  EnvelopeType,
  FieldType,
  RecipientRole,
  SigningStatus,
} from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppErrorCode } from '@documenso/lib/errors/app-error';

import { deleteEnvelopeField } from './delete-envelope-field-handler';

const mocks = vi.hoisted(() => ({
  fieldFindUnique: vi.fn(),
  fieldFindFirst: vi.fn(),
  envelopeFindUnique: vi.fn(),
  transaction: vi.fn(),
  getEnvelopeWhereInput: vi.fn(),
}));

vi.mock('@documenso/prisma', () => ({
  prisma: {
    field: {
      findUnique: mocks.fieldFindUnique,
      findFirst: mocks.fieldFindFirst,
      delete: vi.fn(),
    },
    envelope: {
      findUnique: mocks.envelopeFindUnique,
    },
    $transaction: mocks.transaction,
  },
}));

vi.mock('@documenso/lib/server-only/envelope/get-envelope-by-id', () => ({
  getEnvelopeWhereInput: mocks.getEnvelopeWhereInput,
}));

const field = {
  id: 201,
  secondaryId: 2201,
  envelopeId: 'envelope_01',
  envelopeItemId: 'item_01',
  recipientId: 101,
  type: FieldType.SIGNATURE,
  inserted: false,
};

const correlatedEnvelope = (status: DocumentStatus) => ({
  id: 'envelope_01',
  type: EnvelopeType.DOCUMENT,
  status,
  externalId: 'bizbuddy:envelope_01',
  completedAt: null,
  recipients: [
    {
      id: 101,
      email: 'signer@example.com',
      role: RecipientRole.SIGNER,
      signingStatus: SigningStatus.NOT_SIGNED,
      fields: [field],
    },
  ],
});

const requestMetadata = {
  requestMetadata: {},
  source: 'app' as const,
  auth: 'session' as const,
};

describe('deleteEnvelopeField native document delegation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fieldFindUnique.mockResolvedValue({ envelopeId: field.envelopeId });
    mocks.fieldFindFirst.mockResolvedValue(field);
    mocks.getEnvelopeWhereInput.mockResolvedValue({
      envelopeWhereInput: { id: field.envelopeId },
    });
  });

  it.each([DocumentStatus.DRAFT, DocumentStatus.PENDING])(
    'rejects a %s correlated field delete before opening a transaction',
    async (status) => {
      mocks.envelopeFindUnique.mockResolvedValue(correlatedEnvelope(status));

      await expect(
        deleteEnvelopeField({
          fieldId: field.id,
          userId: 7,
          teamId: 9,
          requestMetadata,
        }),
      ).rejects.toMatchObject({
        code: AppErrorCode.CONFLICT,
      });

      expect(mocks.transaction).not.toHaveBeenCalled();
    },
  );
});
