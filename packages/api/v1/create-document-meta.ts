import { isBizBuddyExternalId } from '@documenso/lib/constants/app';

import type { TCreateDocumentMutationSchema } from './schema';

export const buildCreateDocumentMeta = ({
  meta,
  externalId,
  timezone,
  dateFormat,
}: {
  meta: TCreateDocumentMutationSchema['meta'];
  externalId: TCreateDocumentMutationSchema['externalId'];
  timezone: string | undefined;
  dateFormat: string | undefined;
}) => ({
  subject: meta.subject,
  message: meta.message,
  timezone,
  dateFormat,
  redirectUrl: meta.redirectUrl,
  signingOrder: meta.signingOrder,
  // The schema rejects this for correlated documents. Force the persisted
  // value off as a second boundary in case an internal caller bypasses parsing.
  allowDictateNextSigner: isBizBuddyExternalId(externalId) ? false : meta.allowDictateNextSigner,
  language: meta.language,
  typedSignatureEnabled: meta.typedSignatureEnabled,
  uploadSignatureEnabled: meta.uploadSignatureEnabled,
  drawSignatureEnabled: meta.drawSignatureEnabled,
  distributionMethod: meta.distributionMethod,
  emailSettings: meta.emailSettings,
  envelopeExpirationPeriod: meta.envelopeExpirationPeriod,
});
