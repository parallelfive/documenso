import { z } from 'zod';

import { zEmail } from '../utils/zod';

/**
 * Shared representability limits for the immutable Biz Buddy execution graph.
 *
 * Keep these limits at the provider boundary as well as in the execution lease
 * and webhook projection so a correlated document can never enter a state that
 * one of those contracts cannot encode.
 */
export const MAX_BIZBUDDY_ENVELOPE_RECIPIENTS = 25;
export const MAX_DOCUMENT_EXECUTION_FIELDS = 1_000;
export const MAX_DOCUMENT_EXECUTION_RECIPIENT_NAME_LENGTH = 500;
export const MAX_DOCUMENT_EXECUTION_RECIPIENT_EMAIL_LENGTH = 320;

export const normalizeExecutionRecipientName = (name: string) => name.normalize('NFC').trim();
export const normalizeExecutionRecipientEmail = (email: string) => email.trim().toLowerCase();

export const ZExecutionRecipientIdentitySchema = z
  .object({
    name: z
      .string()
      .transform(normalizeExecutionRecipientName)
      .pipe(z.string().min(1).max(MAX_DOCUMENT_EXECUTION_RECIPIENT_NAME_LENGTH)),
    email: z
      .string()
      .transform(normalizeExecutionRecipientEmail)
      .pipe(zEmail().max(MAX_DOCUMENT_EXECUTION_RECIPIENT_EMAIL_LENGTH)),
  })
  .strict();
