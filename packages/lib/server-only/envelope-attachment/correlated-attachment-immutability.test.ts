import { DocumentStatus, EnvelopeType } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppErrorCode } from '../../errors/app-error';
import { createAttachment } from './create-attachment';
import { deleteAttachment } from './delete-attachment';
import { updateAttachment } from './update-attachment';

const mocks = vi.hoisted(() => ({
  envelopeFindFirst: vi.fn(),
  attachmentFindFirst: vi.fn(),
  attachmentCreate: vi.fn(),
  attachmentUpdate: vi.fn(),
  attachmentDelete: vi.fn(),
}));

vi.mock('@documenso/prisma', () => ({
  prisma: {
    envelope: {
      findFirst: mocks.envelopeFindFirst,
    },
    envelopeAttachment: {
      findFirst: mocks.attachmentFindFirst,
      create: mocks.attachmentCreate,
      update: mocks.attachmentUpdate,
      delete: mocks.attachmentDelete,
    },
  },
}));

const correlatedEnvelope = (status: DocumentStatus) => ({
  id: 'envelope_01',
  type: EnvelopeType.DOCUMENT,
  status,
  externalId: 'bizbuddy:envelope_01',
});

describe('correlated attachment immutability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([DocumentStatus.DRAFT, DocumentStatus.PENDING])(
    'rejects create, update, and delete in %s before mutating storage',
    async (status) => {
      const envelope = correlatedEnvelope(status);

      mocks.envelopeFindFirst.mockResolvedValue(envelope);
      mocks.attachmentFindFirst.mockResolvedValue({
        id: 'attachment_01',
        envelope,
      });

      const create = createAttachment({
        envelopeId: envelope.id,
        userId: 7,
        teamId: 9,
        data: {
          label: 'Policy',
          data: 'https://example.com/policy',
        },
      });
      const update = updateAttachment({
        id: 'attachment_01',
        userId: 7,
        teamId: 9,
        data: {
          label: 'Changed policy',
        },
      });
      const remove = deleteAttachment({
        id: 'attachment_01',
        userId: 7,
        teamId: 9,
      });

      await expect(create).rejects.toMatchObject({ code: AppErrorCode.CONFLICT });
      await expect(update).rejects.toMatchObject({ code: AppErrorCode.CONFLICT });
      await expect(remove).rejects.toMatchObject({ code: AppErrorCode.CONFLICT });

      expect(mocks.attachmentCreate).not.toHaveBeenCalled();
      expect(mocks.attachmentUpdate).not.toHaveBeenCalled();
      expect(mocks.attachmentDelete).not.toHaveBeenCalled();
    },
  );
});
