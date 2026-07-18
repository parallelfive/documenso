import type { Field, Recipient } from '@prisma/client';

import { prisma } from '@documenso/prisma';

type ApiEnvelopeChild = Pick<Recipient, 'id' | 'envelopeId'> | Pick<Field, 'id' | 'envelopeId'>;

export interface GetExactApiEnvelopeChildDependencies {
  findRecipient: (id: number, envelopeId: string) => Promise<ApiEnvelopeChild | null>;
  findField: (id: number, envelopeId: string) => Promise<ApiEnvelopeChild | null>;
  findRecipientIds: (ids: number[], envelopeId: string) => Promise<number[]>;
}

const defaultDependencies: GetExactApiEnvelopeChildDependencies = {
  findRecipient: async (id, envelopeId) =>
    await prisma.recipient.findFirst({
      where: {
        id,
        envelopeId,
      },
      select: {
        id: true,
        envelopeId: true,
      },
    }),
  findField: async (id, envelopeId) =>
    await prisma.field.findFirst({
      where: {
        id,
        envelopeId,
      },
      select: {
        id: true,
        envelopeId: true,
      },
    }),
  findRecipientIds: async (ids, envelopeId) =>
    await prisma.recipient
      .findMany({
        where: {
          id: {
            in: ids,
          },
          envelopeId,
        },
        select: {
          id: true,
        },
      })
      .then((recipients) => recipients.map((recipient) => recipient.id)),
};

const isPositiveSafeInteger = (value: number) => Number.isSafeInteger(value) && value > 0;

export const getExactApiEnvelopeRecipient = async (
  envelopeId: string,
  recipientId: number,
  dependencies: GetExactApiEnvelopeChildDependencies = defaultDependencies,
) => {
  if (!isPositiveSafeInteger(recipientId)) {
    return null;
  }

  const recipient = await dependencies.findRecipient(recipientId, envelopeId);

  return recipient?.envelopeId === envelopeId ? recipient : null;
};

export const getExactApiEnvelopeField = async (
  envelopeId: string,
  fieldId: number,
  dependencies: GetExactApiEnvelopeChildDependencies = defaultDependencies,
) => {
  if (!isPositiveSafeInteger(fieldId)) {
    return null;
  }

  const field = await dependencies.findField(fieldId, envelopeId);

  return field?.envelopeId === envelopeId ? field : null;
};

export const hasExactApiEnvelopeRecipients = async (
  envelopeId: string,
  recipientIds: number[],
  dependencies: GetExactApiEnvelopeChildDependencies = defaultDependencies,
) => {
  const uniqueRecipientIds = [...new Set(recipientIds)];

  if (
    uniqueRecipientIds.length !== recipientIds.length ||
    uniqueRecipientIds.some((id) => !isPositiveSafeInteger(id))
  ) {
    return false;
  }

  const matchedIds = await dependencies.findRecipientIds(uniqueRecipientIds, envelopeId);

  return matchedIds.length === uniqueRecipientIds.length;
};
