import { DocumentStatus, EnvelopeType, RecipientRole, SigningStatus } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppErrorCode } from '../../errors/app-error';
import { updateRecipient } from './update-recipient';

const mocks = vi.hoisted(() => ({
  findFirstOrThrow: vi.fn(),
  update: vi.fn(),
}));

vi.mock('@documenso/prisma', () => ({
  prisma: {
    recipient: {
      findFirstOrThrow: mocks.findFirstOrThrow,
      update: mocks.update,
    },
  },
}));

describe('admin updateRecipient correlated boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([DocumentStatus.DRAFT, DocumentStatus.PENDING])(
    'rejects correlated recipient mutation in %s without a stale-state race',
    async (status) => {
      mocks.findFirstOrThrow.mockResolvedValue({
        id: 101,
        role: RecipientRole.SIGNER,
        signingStatus: SigningStatus.NOT_SIGNED,
        envelope: {
          type: EnvelopeType.DOCUMENT,
          externalId: 'bizbuddy:envelope_01',
          status,
        },
      });

      await expect(
        updateRecipient({
          id: 101,
          name: 'Changed',
          email: undefined,
          role: undefined,
        }),
      ).rejects.toMatchObject({
        code: AppErrorCode.CONFLICT,
      });

      expect(mocks.update).not.toHaveBeenCalled();
    },
  );
});
