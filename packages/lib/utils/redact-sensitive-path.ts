const SIGNING_CAPABILITY_PATH_PATTERN = /\/sign\/[^/?#]+/g;

/**
 * Signing tokens are bearer capabilities and must never enter request logs.
 */
export const redactSigningCapabilityFromPath = (path: string) =>
  path.replace(SIGNING_CAPABILITY_PATH_PATTERN, '/sign/[REDACTED]');
