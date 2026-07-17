import type { TCreateDocumentMutationSchema } from './schema';

export const buildCreateDocumentMeta = ({
  meta,
  timezone,
  dateFormat,
}: {
  meta: TCreateDocumentMutationSchema['meta'];
  timezone: string | undefined;
  dateFormat: string | undefined;
}) => ({
  subject: meta.subject,
  message: meta.message,
  timezone,
  dateFormat,
  redirectUrl: meta.redirectUrl,
  signingOrder: meta.signingOrder,
  allowDictateNextSigner: meta.allowDictateNextSigner,
  language: meta.language,
  typedSignatureEnabled: meta.typedSignatureEnabled,
  uploadSignatureEnabled: meta.uploadSignatureEnabled,
  drawSignatureEnabled: meta.drawSignatureEnabled,
  distributionMethod: meta.distributionMethod,
  emailSettings: meta.emailSettings,
  envelopeExpirationPeriod: meta.envelopeExpirationPeriod,
});
