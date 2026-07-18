import { describe, expect, it } from 'vitest';

import { ZWebhookUrlSchema } from './schema';

describe('ZWebhookUrlSchema', () => {
  it('leaves a syntactically valid development callback for async SSRF validation', () => {
    expect(ZWebhookUrlSchema.parse('http://host.docker.internal:3001/api/webhooks/documenso')).toBe(
      'http://host.docker.internal:3001/api/webhooks/documenso',
    );
  });

  it('still rejects malformed URLs synchronously', () => {
    expect(ZWebhookUrlSchema.safeParse('not-a-url').success).toBe(false);
  });
});
