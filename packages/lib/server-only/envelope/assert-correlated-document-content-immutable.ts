import type { Envelope } from '@prisma/client';
import { EnvelopeType } from '@prisma/client';

import { isBizBuddyExternalId } from '../../constants/app';
import { AppError, AppErrorCode } from '../../errors/app-error';

/**
 * Biz Buddy creates the complete source PDF as part of document creation and
 * never uses the native item editor. Rejecting correlated item mutation in
 * every lifecycle state removes both post-dispatch changes and stale-DRAFT
 * races with the atomic send lease.
 */
export const assertCorrelatedDocumentContentImmutable = (
  envelope: Pick<Envelope, 'type' | 'externalId'>,
) => {
  if (envelope.type === EnvelopeType.DOCUMENT && isBizBuddyExternalId(envelope.externalId)) {
    throw new AppError(AppErrorCode.CONFLICT, {
      message: 'Correlated document content is immutable',
    });
  }
};
