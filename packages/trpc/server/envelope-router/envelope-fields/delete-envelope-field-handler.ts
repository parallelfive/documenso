import { EnvelopeType } from '@prisma/client';

import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { getEnvelopeWhereInput } from '@documenso/lib/server-only/envelope/get-envelope-by-id';
import { deleteDocumentField } from '@documenso/lib/server-only/field/delete-document-field';
import type { ApiRequestMetadata } from '@documenso/lib/universal/extract-request-metadata';
import { canRecipientFieldsBeModified } from '@documenso/lib/utils/recipients';
import { prisma } from '@documenso/prisma';

export type DeleteEnvelopeFieldOptions = {
  fieldId: number;
  userId: number;
  teamId: number;
  requestMetadata: ApiRequestMetadata;
};

/**
 * Native envelope-field deletion must share the document service boundary.
 * Templates retain their native deletion flow; documents delegate so
 * Biz Buddy-correlated drafts cannot bypass lifecycle and transaction guards.
 */
export const deleteEnvelopeField = async ({
  fieldId,
  userId,
  teamId,
  requestMetadata,
}: DeleteEnvelopeFieldOptions) => {
  const unsafeField = await prisma.field.findUnique({
    where: {
      id: fieldId,
    },
    select: {
      envelopeId: true,
    },
  });

  if (!unsafeField) {
    throw new AppError(AppErrorCode.NOT_FOUND, {
      message: 'Field not found',
    });
  }

  const { envelopeWhereInput } = await getEnvelopeWhereInput({
    id: {
      type: 'envelopeId',
      id: unsafeField.envelopeId,
    },
    type: null,
    userId,
    teamId,
  });

  const envelope = await prisma.envelope.findUnique({
    where: envelopeWhereInput,
    include: {
      recipients: {
        include: {
          fields: true,
        },
      },
    },
  });

  const recipientWithFields = envelope?.recipients.find((recipient) =>
    recipient.fields.some((field) => field.id === fieldId),
  );
  const fieldToDelete = recipientWithFields?.fields.find((field) => field.id === fieldId);

  if (!envelope || !recipientWithFields || !fieldToDelete) {
    throw new AppError(AppErrorCode.NOT_FOUND, {
      message: 'Field not found',
    });
  }

  if (envelope.type === EnvelopeType.DOCUMENT) {
    return deleteDocumentField({
      envelopeId: envelope.id,
      fieldId: fieldToDelete.id,
      userId,
      teamId,
      requestMetadata,
    });
  }

  if (envelope.completedAt) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'Envelope already complete',
    });
  }

  // Check whether the recipient associated with the field can have new fields created.
  if (!canRecipientFieldsBeModified(recipientWithFields, recipientWithFields.fields)) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'Recipient has already interacted with the document.',
    });
  }

  return prisma.field.delete({
    where: {
      id: fieldToDelete.id,
      envelopeId: envelope.id,
    },
  });
};
