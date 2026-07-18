import { describe, expect, it } from 'vitest';

import { redactSigningCapabilityFromPath } from './redact-sensitive-path';

describe('redactSigningCapabilityFromPath', () => {
  it.each([
    ['/sign/live-bearer-token', '/sign/[REDACTED]'],
    ['/sign/live-bearer-token/complete', '/sign/[REDACTED]/complete'],
    ['/embed/sign/live-bearer-token?mode=compact', '/embed/sign/[REDACTED]?mode=compact'],
  ])('redacts signing capability in %s', (input, expected) => {
    expect(redactSigningCapabilityFromPath(input)).toBe(expected);
  });

  it.each(['/signin', '/design/token', '/api/v1/documents/42'])(
    'preserves non-signing path %s',
    (path) => {
      expect(redactSigningCapabilityFromPath(path)).toBe(path);
    },
  );
});
