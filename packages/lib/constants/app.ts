import { env } from '@documenso/lib/utils/env';

export const APP_DOCUMENT_UPLOAD_SIZE_LIMIT =
  Number(env('NEXT_PUBLIC_DOCUMENT_SIZE_UPLOAD_LIMIT')) || 50;

export const NEXT_PUBLIC_WEBAPP_URL = () =>
  env('NEXT_PUBLIC_WEBAPP_URL') ?? 'http://localhost:3000';

const stripTrailingSlashes = (value: string) => value.trim().replace(/\/+$/, '');
const BIZBUDDY_EXTERNAL_ID_PATTERN =
  /^bizbuddy:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;

/**
 * Biz Buddy owns this external-ID namespace. Treat it case-insensitively so
 * alternate casing cannot bypass lifecycle controls while still matching
 * callback projection.
 */
export const isBizBuddyExternalId = (externalId: string | null | undefined): externalId is string =>
  externalId?.toLowerCase().startsWith('bizbuddy:') === true;

export const isValidBizBuddyExternalId = (
  externalId: string | null | undefined,
): externalId is string =>
  externalId !== undefined && externalId !== null && BIZBUDDY_EXTERNAL_ID_PATTERN.test(externalId);

/**
 * Build the recipient-facing signing link.
 *
 * Biz Buddy documents carry their namespaced local envelope ID in `externalId`.
 * When the callback prefix is configured, that ID and Documenso's recipient
 * capability token are routed through Biz Buddy so it can enforce its
 * terminal-state and workspace-recipient gates before returning the signer to
 * Documenso.
 *
 * Documents without a Biz Buddy external ID keep Documenso's native signing
 * link, including when the callback prefix is configured.
 */
export const buildRecipientSigningLink = ({
  externalId,
  recipientToken,
  signingUrlPrefix = env('BIZBUDDY_SIGNING_URL_PREFIX'),
  webappUrl = NEXT_PUBLIC_WEBAPP_URL(),
}: {
  externalId: string | null | undefined;
  recipientToken: string;
  signingUrlPrefix?: string;
  webappUrl?: string;
}) => {
  const encodedRecipientToken = encodeURIComponent(recipientToken);

  const bizBuddyEnvelopeId = externalId?.match(BIZBUDDY_EXTERNAL_ID_PATTERN)?.[1];
  const callbackPrefix = signingUrlPrefix?.trim();

  if (!callbackPrefix || !bizBuddyEnvelopeId) {
    return `${stripTrailingSlashes(webappUrl)}/sign/${encodedRecipientToken}`;
  }

  // Accept either an origin/base path or a value already ending in `/sign`.
  // This keeps existing operator configuration compatible without ever
  // constructing `/sign/sign/...`.
  const callbackBase = stripTrailingSlashes(callbackPrefix).replace(/\/sign$/, '');

  return `${callbackBase}/sign/${bizBuddyEnvelopeId}?p=${encodedRecipientToken}`;
};

export const NEXT_PUBLIC_SIGNING_CONTACT_INFO = () =>
  env('NEXT_PUBLIC_SIGNING_CONTACT_INFO') ?? NEXT_PUBLIC_WEBAPP_URL();

export const NEXT_PRIVATE_USE_LEGACY_SIGNING_SUBFILTER = () =>
  env('NEXT_PRIVATE_USE_LEGACY_SIGNING_SUBFILTER') === 'true';

export const NEXT_PRIVATE_INTERNAL_WEBAPP_URL = () =>
  env('NEXT_PRIVATE_INTERNAL_WEBAPP_URL') ?? NEXT_PUBLIC_WEBAPP_URL();

export const IS_BILLING_ENABLED = () => env('NEXT_PUBLIC_FEATURE_BILLING_ENABLED') === 'true';

export const API_V2_BETA_URL = '/api/v2-beta';
export const API_V2_URL = '/api/v2';

export const SUPPORT_EMAIL = env('NEXT_PUBLIC_SUPPORT_EMAIL') ?? 'support@documenso.com';

export const USE_INTERNAL_URL_BROWSERLESS = () =>
  env('NEXT_PUBLIC_USE_INTERNAL_URL_BROWSERLESS') === 'true';

export const IS_AI_FEATURES_CONFIGURED = () =>
  !!env('GOOGLE_VERTEX_PROJECT_ID') && !!env('GOOGLE_VERTEX_API_KEY');

/**
 * Temporary flag to toggle between Playwright-based and Konva-based PDF generation
 * for audit logs during sealing.
 *
 * @deprecated This is a temporary flag and will be removed once Konva-based generation is stable.
 */
export const NEXT_PRIVATE_USE_PLAYWRIGHT_PDF = () =>
  env('NEXT_PRIVATE_USE_PLAYWRIGHT_PDF') === 'true';

export const NEXT_PRIVATE_SIGNING_TIMESTAMP_AUTHORITY = () =>
  env('NEXT_PRIVATE_SIGNING_TIMESTAMP_AUTHORITY');
