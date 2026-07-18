import { EnvelopeType, type RecipientRole, SigningStatus } from '@prisma/client';

import { prisma } from '@documenso/prisma';

import { isBizBuddyExternalId } from '../../constants/app';
import { AppError, AppErrorCode } from '../../errors/app-error';

export type UpdateRecipientOptions = {
  id: number;
  name: string | undefined;
  email: string | undefined;
  role: RecipientRole | undefined;
};

export const updateRecipient = async ({ id, name, email, role }: UpdateRecipientOptions) => {
  const recipient = await prisma.recipient.findFirstOrThrow({
    where: {
      id,
    },
    include: {
      envelope: {
        select: {
          type: true,
          externalId: true,
        },
      },
    },
  });

  if (
    recipient.envelope.type === EnvelopeType.DOCUMENT &&
    isBizBuddyExternalId(recipient.envelope.externalId)
  ) {
    throw new AppError(AppErrorCode.CONFLICT, {
      message: 'Correlated document recipients are immutable from the admin surface',
    });
  }

  if (recipient.signingStatus === SigningStatus.SIGNED) {
    throw new Error('Cannot update a recipient that has already signed.');
  }

  return await prisma.recipient.update({
    where: {
      id,
    },
    data: {
      name,
      email,
      role,
    },
  });
};
