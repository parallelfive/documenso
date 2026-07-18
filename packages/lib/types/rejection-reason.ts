import { z } from 'zod';

export const MAX_REJECTION_REASON_BYTES = 2 * 1024;

export const ZRejectionReasonSchema = z
  .string()
  .refine((reason) => new TextEncoder().encode(reason).byteLength <= MAX_REJECTION_REASON_BYTES, {
    message: `Rejection reason must not exceed ${MAX_REJECTION_REASON_BYTES} UTF-8 bytes`,
  });
