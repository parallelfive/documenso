import {
  DocumentStatus,
  EnvelopeType,
  FieldType,
  RecipientRole,
  SigningStatus,
} from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppErrorCode } from '../errors/app-error';
import { updateEnvelope } from './envelope/update-envelope';
import { createEnvelopeFields } from './field/create-envelope-fields';
import { deleteDocumentField } from './field/delete-document-field';
import { updateEnvelopeFields } from './field/update-envelope-fields';
import { createEnvelopeRecipients } from './recipient/create-envelope-recipients';
import { deleteEnvelopeRecipient } from './recipient/delete-envelope-recipient';
import { setDocumentRecipients } from './recipient/set-document-recipients';
import { updateEnvelopeRecipients } from './recipient/update-envelope-recipients';

const mocks = vi.hoisted(() => ({
  envelopeFindFirst: vi.fn(),
  envelopeFindUnique: vi.fn(),
  fieldFindFirst: vi.fn(),
  userFindFirst: vi.fn(),
  userFindFirstOrThrow: vi.fn(),
  transaction: vi.fn(),
  getEnvelopeWhereInput: vi.fn(),
}));

vi.mock('@documenso/prisma', () => ({
  prisma: {
    envelope: {
      findFirst: mocks.envelopeFindFirst,
      findUnique: mocks.envelopeFindUnique,
    },
    field: { findFirst: mocks.fieldFindFirst },
    user: {
      findFirst: mocks.userFindFirst,
      findFirstOrThrow: mocks.userFindFirstOrThrow,
    },
    $transaction: mocks.transaction,
  },
}));

vi.mock('@libpdf/core', () => ({
  PDF: { load: vi.fn() },
}));

vi.mock('../client-only/providers/i18n-server', () => ({
  allI18nInstances: Promise.resolve({}),
  getI18nInstance: vi.fn(),
}));

vi.mock('./pdf/auto-place-fields', () => ({
  whiteoutRegions: vi.fn(),
}));

vi.mock('@lingui/core/macro', () => ({
  msg: (input: TemplateStringsArray | { message: string }, ...values: unknown[]) => {
    if ('message' in input) return input.message;

    return input.reduce((message, part, index) => `${message}${part}${values[index] ?? ''}`, '');
  },
}));

vi.mock('./envelope/get-envelope-by-id', () => ({
  getEnvelopeWhereInput: mocks.getEnvelopeWhereInput,
}));

vi.mock('./email/get-email-context', () => ({
  getEmailContext: vi.fn().mockResolvedValue({
    branding: {},
    emailLanguage: 'en',
    senderEmail: 'sender@example.test',
    replyToEmail: null,
  }),
}));

const pendingCorrelatedEnvelope = {
  id: 'envelope_01',
  type: EnvelopeType.DOCUMENT,
  status: DocumentStatus.PENDING,
  externalId: 'bizbuddy:decision-01',
  completedAt: null,
};

const requestMetadata = {
  requestMetadata: {},
  source: 'app' as const,
  auth: 'session' as const,
};

describe('native correlated document immutability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getEnvelopeWhereInput.mockResolvedValue({
      envelopeWhereInput: { id: pendingCorrelatedEnvelope.id },
      team: { currentTeamRole: 'ADMIN' },
    });
    mocks.envelopeFindFirst.mockResolvedValue(pendingCorrelatedEnvelope);
    mocks.envelopeFindUnique.mockResolvedValue(pendingCorrelatedEnvelope);
    mocks.fieldFindFirst.mockResolvedValue({
      id: 201,
      envelopeId: pendingCorrelatedEnvelope.id,
      recipientId: 101,
    });
    mocks.userFindFirst.mockResolvedValue({ id: 7 });
    mocks.userFindFirstOrThrow.mockResolvedValue({ id: 7 });
  });

  it.each([
    {
      operation: 'recipient create',
      run: async () =>
        await setDocumentRecipients({
          id: { type: 'envelopeId' as const, id: pendingCorrelatedEnvelope.id },
          userId: 7,
          teamId: 9,
          recipients: [],
          requestMetadata,
        }),
    },
    {
      operation: 'recipient append',
      run: async () =>
        await createEnvelopeRecipients({
          id: { type: 'envelopeId' as const, id: pendingCorrelatedEnvelope.id },
          userId: 7,
          teamId: 9,
          recipients: [],
          requestMetadata,
        }),
    },
    {
      operation: 'recipient update',
      run: async () =>
        await updateEnvelopeRecipients({
          id: { type: 'envelopeId' as const, id: pendingCorrelatedEnvelope.id },
          userId: 7,
          teamId: 9,
          recipients: [{ id: 101, name: 'Changed signer' }],
          requestMetadata,
        }),
    },
    {
      operation: 'recipient delete',
      run: async () =>
        await deleteEnvelopeRecipient({
          envelopeId: pendingCorrelatedEnvelope.id,
          recipientId: 101,
          userId: 7,
          teamId: 9,
          requestMetadata,
        }),
    },
    {
      operation: 'field create',
      run: async () =>
        await createEnvelopeFields({
          id: { type: 'envelopeId' as const, id: pendingCorrelatedEnvelope.id },
          userId: 7,
          teamId: 9,
          fields: [],
          requestMetadata,
        }),
    },
    {
      operation: 'field update',
      run: async () =>
        await updateEnvelopeFields({
          id: { type: 'envelopeId' as const, id: pendingCorrelatedEnvelope.id },
          userId: 7,
          teamId: 9,
          fields: [{ id: 201, pageX: 20 }],
          requestMetadata,
        }),
    },
    {
      operation: 'field delete',
      run: async () =>
        await deleteDocumentField({
          envelopeId: pendingCorrelatedEnvelope.id,
          fieldId: 201,
          userId: 7,
          teamId: 9,
          requestMetadata,
        }),
    },
    {
      operation: 'envelope metadata update',
      run: async () =>
        await updateEnvelope({
          id: { type: 'envelopeId' as const, id: pendingCorrelatedEnvelope.id },
          userId: 7,
          teamId: 9,
          data: { title: 'Changed after dispatch' },
          requestMetadata,
        }),
    },
  ])('rejects native $operation after dispatch before opening a transaction', async ({ run }) => {
    await expect(run()).rejects.toMatchObject({
      code: AppErrorCode.CONFLICT,
    });

    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it.each([null, 'native-document'])(
    'rejects changing the correlated external identity to %s while still draft',
    async (externalId) => {
      mocks.envelopeFindFirst.mockResolvedValueOnce({
        ...pendingCorrelatedEnvelope,
        status: DocumentStatus.DRAFT,
      });

      await expect(
        updateEnvelope({
          id: { type: 'envelopeId', id: pendingCorrelatedEnvelope.id },
          userId: 7,
          teamId: 9,
          data: { externalId },
          requestMetadata,
        }),
      ).rejects.toMatchObject({
        code: AppErrorCode.CONFLICT,
      });

      expect(mocks.transaction).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      operation: 'recipient append',
      run: async () =>
        createEnvelopeRecipients({
          id: { type: 'envelopeId' as const, id: pendingCorrelatedEnvelope.id },
          userId: 7,
          teamId: 9,
          recipients: [],
          requestMetadata,
        }),
    },
    {
      operation: 'recipient update',
      run: async () =>
        updateEnvelopeRecipients({
          id: { type: 'envelopeId' as const, id: pendingCorrelatedEnvelope.id },
          userId: 7,
          teamId: 9,
          recipients: [],
          requestMetadata,
        }),
    },
    {
      operation: 'recipient delete',
      run: async () =>
        deleteEnvelopeRecipient({
          envelopeId: pendingCorrelatedEnvelope.id,
          recipientId: 101,
          userId: 7,
          teamId: 9,
          requestMetadata,
        }),
    },
    {
      operation: 'field update',
      run: async () =>
        updateEnvelopeFields({
          id: { type: 'envelopeId' as const, id: pendingCorrelatedEnvelope.id },
          userId: 7,
          teamId: 9,
          fields: [],
          requestMetadata,
        }),
    },
    {
      operation: 'field delete',
      run: async () =>
        deleteDocumentField({
          envelopeId: pendingCorrelatedEnvelope.id,
          fieldId: 201,
          userId: 7,
          teamId: 9,
          requestMetadata,
        }),
    },
  ])('rejects correlated $operation from creation onward', async ({ run }) => {
    mocks.envelopeFindFirst.mockResolvedValueOnce({
      ...pendingCorrelatedEnvelope,
      status: DocumentStatus.DRAFT,
    });
    mocks.envelopeFindUnique.mockResolvedValueOnce({
      ...pendingCorrelatedEnvelope,
      status: DocumentStatus.DRAFT,
    });

    await expect(run()).rejects.toMatchObject({
      code: AppErrorCode.CONFLICT,
    });

    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('rejects replacing an already-populated correlated recipient graph while draft', async () => {
    mocks.envelopeFindFirst.mockReset().mockResolvedValue({
      ...pendingCorrelatedEnvelope,
      status: DocumentStatus.DRAFT,
      recipients: [{ id: 101 }],
    });

    await expect(
      setDocumentRecipients({
        id: { type: 'envelopeId', id: pendingCorrelatedEnvelope.id },
        userId: 7,
        teamId: 9,
        recipients: [],
        requestMetadata,
      }),
    ).rejects.toMatchObject({
      code: AppErrorCode.CONFLICT,
    });

    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('rejects a non-signer during initial correlated recipient population', async () => {
    mocks.envelopeFindFirst.mockReset().mockResolvedValue({
      ...pendingCorrelatedEnvelope,
      status: DocumentStatus.DRAFT,
      recipients: [],
    });

    await expect(
      setDocumentRecipients({
        id: { type: 'envelopeId', id: pendingCorrelatedEnvelope.id },
        userId: 7,
        teamId: 9,
        recipients: [
          {
            name: 'Viewer',
            email: 'viewer@example.test',
            role: RecipientRole.VIEWER,
          },
        ],
        requestMetadata,
      }),
    ).rejects.toMatchObject({
      code: AppErrorCode.INVALID_REQUEST,
    });

    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('rechecks recipient emptiness after acquiring the draft lock', async () => {
    const recipientUpsert = vi.fn();
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });

    mocks.envelopeFindFirst.mockReset().mockResolvedValue({
      ...pendingCorrelatedEnvelope,
      status: DocumentStatus.DRAFT,
      recipients: [],
      fields: [],
      documentMeta: null,
      title: 'Approval',
      team: {
        organisation: {
          organisationClaim: {
            flags: {
              cfr21: false,
            },
          },
        },
      },
    });
    mocks.transaction.mockImplementationOnce(
      async (callback: (tx: unknown) => Promise<unknown>) =>
        await callback({
          envelope: { updateMany },
          recipient: {
            count: vi.fn().mockResolvedValue(1),
            upsert: recipientUpsert,
          },
        }),
    );

    await expect(
      setDocumentRecipients({
        id: { type: 'envelopeId', id: pendingCorrelatedEnvelope.id },
        userId: 7,
        teamId: 9,
        recipients: [
          {
            name: 'Signer',
            email: 'signer@example.test',
            role: RecipientRole.SIGNER,
          },
        ],
        requestMetadata,
      }),
    ).rejects.toMatchObject({
      code: AppErrorCode.CONFLICT,
    });

    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(recipientUpsert).not.toHaveBeenCalled();
  });

  it('allows exactly the first correlated recipient population under the atomic guard', async () => {
    const createdRecipient = {
      id: 101,
      envelopeId: pendingCorrelatedEnvelope.id,
      name: 'Signer',
      email: 'signer@example.test',
      role: RecipientRole.SIGNER,
      signingOrder: 1,
      token: 'recipient-token',
      sendStatus: 'NOT_SENT',
      signingStatus: 'NOT_SIGNED',
      authOptions: {
        accessAuth: [],
        actionAuth: [],
      },
    };
    const recipientUpsert = vi.fn().mockResolvedValue(createdRecipient);
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });

    mocks.envelopeFindFirst.mockReset().mockResolvedValue({
      ...pendingCorrelatedEnvelope,
      secondaryId: 'document_42',
      status: DocumentStatus.DRAFT,
      recipients: [],
      fields: [],
      documentMeta: null,
      title: 'Approval',
      team: {
        organisation: {
          organisationClaim: {
            flags: {
              cfr21: false,
            },
          },
        },
      },
    });
    mocks.transaction.mockImplementationOnce(
      async (callback: (tx: unknown) => Promise<unknown>) =>
        await callback({
          envelope: { updateMany },
          recipient: {
            count: vi.fn().mockResolvedValue(0),
            upsert: recipientUpsert,
          },
          documentAuditLog: {
            create: vi.fn(),
          },
        }),
    );

    await expect(
      setDocumentRecipients({
        id: { type: 'envelopeId', id: pendingCorrelatedEnvelope.id },
        userId: 7,
        teamId: 9,
        recipients: [
          {
            name: createdRecipient.name,
            email: createdRecipient.email,
            role: createdRecipient.role,
            signingOrder: createdRecipient.signingOrder,
          },
        ],
        requestMetadata,
      }),
    ).resolves.toMatchObject({
      recipients: [
        {
          id: createdRecipient.id,
          email: createdRecipient.email,
        },
      ],
    });

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: pendingCorrelatedEnvelope.id,
        teamId: 9,
        type: EnvelopeType.DOCUMENT,
        status: DocumentStatus.DRAFT,
        externalId: pendingCorrelatedEnvelope.externalId,
        recipients: {
          none: {},
        },
      },
      data: {
        status: DocumentStatus.DRAFT,
      },
    });
    expect(recipientUpsert).toHaveBeenCalledTimes(1);
  });

  it('rechecks correlated field capacity under the draft lock before field mutation', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const fieldCount = vi.fn().mockResolvedValue(1_000);
    const fieldCreateManyAndReturn = vi.fn();

    mocks.envelopeFindFirst.mockReset().mockResolvedValue({
      ...pendingCorrelatedEnvelope,
      secondaryId: 'document_42',
      status: DocumentStatus.DRAFT,
      recipients: [
        {
          id: 101,
          email: 'signer@example.test',
          role: RecipientRole.SIGNER,
          signingStatus: SigningStatus.NOT_SIGNED,
        },
      ],
      fields: [],
      envelopeItems: [
        {
          id: 'item_01',
          documentData: {},
        },
      ],
    });
    mocks.transaction.mockImplementationOnce(
      async (callback: (tx: unknown) => Promise<unknown>) =>
        await callback({
          envelope: { updateMany },
          field: {
            count: fieldCount,
            createManyAndReturn: fieldCreateManyAndReturn,
          },
        }),
    );

    await expect(
      createEnvelopeFields({
        id: { type: 'envelopeId', id: pendingCorrelatedEnvelope.id },
        userId: 7,
        teamId: 9,
        fields: [
          {
            recipientId: 101,
            type: FieldType.SIGNATURE,
            page: 1,
            positionX: 10,
            positionY: 20,
            width: 100,
            height: 40,
          },
        ],
        requestMetadata,
      }),
    ).rejects.toMatchObject({
      code: AppErrorCode.INVALID_REQUEST,
    });

    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(fieldCount).toHaveBeenCalledWith({
      where: {
        envelopeId: pendingCorrelatedEnvelope.id,
      },
    });
    expect(fieldCreateManyAndReturn).not.toHaveBeenCalled();
  });
});
