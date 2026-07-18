import { DocumentStatus, EnvelopeType } from '@prisma/client';

import { AppError, AppErrorCode } from '../../errors/app-error';

type DraftMutationTransaction = {
  envelope: {
    updateMany: (args: {
      where: {
        id: string;
        teamId: number;
        type: EnvelopeType;
        status: DocumentStatus;
        externalId?: string;
        recipients?: {
          none: Record<string, never>;
        };
      };
      data: {
        status: DocumentStatus;
      };
    }) => Promise<{ count: number }>;
  };
};

export type WithDocumentDraftMutationGuardOptions = {
  tx: DraftMutationTransaction;
  envelopeId: string;
  teamId: number;
  expectedExternalId?: string;
  requireNoRecipients?: boolean;
  transitionToPending?: boolean;
};

/**
 * Atomically locks a V1 document while it is still a draft, then runs the
 * supplied mutation in the same transaction. A no-op DRAFT update is used for
 * field mutations so concurrent dispatch waits for the fields to commit.
 */
export const withDocumentDraftMutationGuard = async <T>(
  {
    tx,
    envelopeId,
    teamId,
    expectedExternalId,
    requireNoRecipients = false,
    transitionToPending = false,
  }: WithDocumentDraftMutationGuardOptions,
  mutation: () => Promise<T>,
): Promise<T> => {
  const guardedUpdate = await tx.envelope.updateMany({
    where: {
      id: envelopeId,
      teamId,
      type: EnvelopeType.DOCUMENT,
      status: DocumentStatus.DRAFT,
      ...(expectedExternalId ? { externalId: expectedExternalId } : {}),
      ...(requireNoRecipients ? { recipients: { none: {} } } : {}),
    },
    data: {
      status: transitionToPending ? DocumentStatus.PENDING : DocumentStatus.DRAFT,
    },
  });

  if (guardedUpdate.count !== 1) {
    throw new AppError(AppErrorCode.CONFLICT, {
      message: 'Document is no longer a draft',
    });
  }

  return mutation();
};
