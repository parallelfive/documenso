import { describe, expect, it } from 'vitest';

import { MAX_REJECTION_REASON_BYTES, ZRejectionReasonSchema } from './rejection-reason';

describe('ZRejectionReasonSchema', () => {
  it('accepts the exact UTF-8 byte boundary', () => {
    expect(ZRejectionReasonSchema.safeParse('a'.repeat(MAX_REJECTION_REASON_BYTES)).success).toBe(
      true,
    );
  });

  it('rejects one byte above the UTF-8 boundary', () => {
    expect(
      ZRejectionReasonSchema.safeParse('a'.repeat(MAX_REJECTION_REASON_BYTES + 1)).success,
    ).toBe(false);
  });

  it('measures multibyte input in UTF-8 bytes rather than JavaScript code units', () => {
    expect(ZRejectionReasonSchema.safeParse('😀'.repeat(512)).success).toBe(true);
    expect(ZRejectionReasonSchema.safeParse('😀'.repeat(513)).success).toBe(false);
  });
});
