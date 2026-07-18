import { RecipientRole } from '@prisma/client';

import { isBizBuddyExternalId } from '../../constants/app';
import { AppError, AppErrorCode } from '../../errors/app-error';
import {
  MAX_BIZBUDDY_ENVELOPE_RECIPIENTS,
  ZExecutionRecipientIdentitySchema,
} from '../../types/document-execution-profile';

type CorrelatedRecipientPopulationInput = {
  name: string;
  email: string;
  role: RecipientRole;
  signingOrder?: number | null;
  accessAuth?: readonly unknown[] | null;
  actionAuth?: readonly unknown[] | null;
};

/**
 * The Biz Buddy execution lease intentionally models signers and their
 * positive signing-order cohorts, but not recipient authentication settings.
 * Keep correlated recipient creation inside that exact product subset.
 */
export const assertCorrelatedDocumentRecipientPopulationAllowed = ({
  externalId,
  recipients,
}: {
  externalId: string | null | undefined;
  recipients: readonly CorrelatedRecipientPopulationInput[];
}) => {
  if (!isBizBuddyExternalId(externalId)) return;

  if (recipients.length < 1 || recipients.length > MAX_BIZBUDDY_ENVELOPE_RECIPIENTS) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: `Correlated documents require between 1 and ${MAX_BIZBUDDY_ENVELOPE_RECIPIENTS} recipients`,
    });
  }

  const hasUnsupportedRecipient = recipients.some(
    ({ name, email, role, signingOrder, accessAuth, actionAuth }) => {
      const hasInvalidSigningOrder =
        signingOrder !== null &&
        signingOrder !== undefined &&
        (!Number.isSafeInteger(signingOrder) || signingOrder <= 0);

      return (
        !ZExecutionRecipientIdentitySchema.safeParse({ name, email }).success ||
        role !== RecipientRole.SIGNER ||
        (accessAuth?.length ?? 0) > 0 ||
        (actionAuth?.length ?? 0) > 0 ||
        hasInvalidSigningOrder
      );
    },
  );

  if (hasUnsupportedRecipient) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message:
        'Correlated documents require representable signer identities without authentication and with positive signing orders only',
    });
  }
};
