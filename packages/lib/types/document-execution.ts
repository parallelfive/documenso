import { DocumentSigningOrder, FieldType, RecipientRole } from '@prisma/client';
import { z } from 'zod';

import { isBizBuddyExternalId } from '../constants/app';
import {
  MAX_BIZBUDDY_ENVELOPE_RECIPIENTS,
  MAX_DOCUMENT_EXECUTION_FIELDS,
  ZExecutionRecipientIdentitySchema,
  normalizeExecutionRecipientEmail,
  normalizeExecutionRecipientName,
} from './document-execution-profile';

export { normalizeExecutionRecipientEmail, normalizeExecutionRecipientName };

const ZExecutionRecipientSchema = ZExecutionRecipientIdentitySchema.extend({
  id: z.number().int().positive(),
  role: z.nativeEnum(RecipientRole),
  signingOrder: z.number().int().positive().nullable(),
}).strict();

const ZExecutionFieldSchema = z
  .object({
    id: z.number().int().positive(),
    recipientId: z.number().int().positive(),
    type: z.nativeEnum(FieldType),
    page: z.number().int().positive(),
    positionX: z.number().finite(),
    positionY: z.number().finite(),
    width: z.number().finite().positive(),
    height: z.number().finite().positive(),
  })
  .strict();

const ZExpectedExecutionPdfSchema = z
  .object({
    sha256: z.string().regex(/^[0-9a-f]{64}$/, 'PDF SHA-256 must be exact lower-case hex'),
    byteLength: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

const hasUniqueIds = (items: Array<{ id: number }>) =>
  new Set(items.map((item) => item.id)).size === items.length;

export const ZExpectedDocumentExecutionSchema = z
  .object({
    externalId: z.string().min(1).max(512),
    signingOrder: z.nativeEnum(DocumentSigningOrder),
    expectedPdf: ZExpectedExecutionPdfSchema,
    recipients: z.array(ZExecutionRecipientSchema).min(1).max(100),
    fields: z.array(ZExecutionFieldSchema).min(1).max(MAX_DOCUMENT_EXECUTION_FIELDS),
  })
  .strict()
  .superRefine(({ externalId, recipients, fields }, context) => {
    if (isBizBuddyExternalId(externalId) && recipients.length > MAX_BIZBUDDY_ENVELOPE_RECIPIENTS) {
      context.addIssue({
        code: z.ZodIssueCode.too_big,
        type: 'array',
        maximum: MAX_BIZBUDDY_ENVELOPE_RECIPIENTS,
        inclusive: true,
        exact: false,
        message: `Biz Buddy execution leases support at most ${MAX_BIZBUDDY_ENVELOPE_RECIPIENTS} recipients`,
        path: ['recipients'],
      });
    }

    if (!hasUniqueIds(recipients)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Execution recipients must have unique IDs',
        path: ['recipients'],
      });
    }

    if (!hasUniqueIds(fields)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Execution fields must have unique IDs',
        path: ['fields'],
      });
    }
  });

export type TExpectedDocumentExecution = z.infer<typeof ZExpectedDocumentExecutionSchema>;
export type TDocumentExecutionGraph = Omit<TExpectedDocumentExecution, 'expectedPdf'>;

type DocumentExecutionSource = {
  externalId: string | null;
  documentMeta: {
    signingOrder: DocumentSigningOrder;
  };
  recipients: Array<TExpectedDocumentExecution['recipients'][number]>;
  fields: Array<{
    id: number;
    recipientId: number | null;
    type: FieldType;
    page: number;
    positionX: number | { toString: () => string };
    positionY: number | { toString: () => string };
    width: number | { toString: () => string };
    height: number | { toString: () => string };
  }>;
};

export const canonicalizeExpectedDocumentExecution = (
  execution: TExpectedDocumentExecution,
): TExpectedDocumentExecution => ({
  externalId: execution.externalId,
  signingOrder: execution.signingOrder,
  expectedPdf: execution.expectedPdf,
  recipients: execution.recipients
    .map((recipient) => ({
      id: recipient.id,
      name: normalizeExecutionRecipientName(recipient.name),
      email: normalizeExecutionRecipientEmail(recipient.email),
      role: recipient.role,
      signingOrder: recipient.signingOrder,
    }))
    .sort((left, right) => left.id - right.id),
  fields: [...execution.fields].sort((left, right) => left.id - right.id),
});

export const toDocumentExecutionSnapshot = (
  source: DocumentExecutionSource,
): TDocumentExecutionGraph | null => {
  if (!source.externalId) {
    return null;
  }

  const fields: TDocumentExecutionGraph['fields'] = [];

  for (const field of source.fields) {
    if (field.recipientId === null) {
      return null;
    }

    fields.push({
      id: field.id,
      recipientId: field.recipientId,
      type: field.type,
      page: field.page,
      positionX: Number(field.positionX),
      positionY: Number(field.positionY),
      width: Number(field.width),
      height: Number(field.height),
    });
  }

  return canonicalizeDocumentExecutionGraph({
    externalId: source.externalId,
    signingOrder: source.documentMeta.signingOrder,
    recipients: source.recipients.map((recipient) => ({
      id: recipient.id,
      name: normalizeExecutionRecipientName(recipient.name),
      email: normalizeExecutionRecipientEmail(recipient.email),
      role: recipient.role,
      signingOrder: recipient.signingOrder,
    })),
    fields,
  });
};

const canonicalizeDocumentExecutionGraph = (
  execution: TDocumentExecutionGraph,
): TDocumentExecutionGraph => ({
  externalId: execution.externalId,
  signingOrder: execution.signingOrder,
  recipients: execution.recipients
    .map((recipient) => ({
      id: recipient.id,
      name: normalizeExecutionRecipientName(recipient.name),
      email: normalizeExecutionRecipientEmail(recipient.email),
      role: recipient.role,
      signingOrder: recipient.signingOrder,
    }))
    .sort((left, right) => left.id - right.id),
  fields: [...execution.fields].sort((left, right) => left.id - right.id),
});

export const matchesExpectedDocumentExecution = (
  source: DocumentExecutionSource,
  expectedExecution: TExpectedDocumentExecution,
) => {
  const actualExecution = toDocumentExecutionSnapshot(source);
  if (!actualExecution) return false;

  return (
    JSON.stringify(actualExecution) ===
    JSON.stringify(
      canonicalizeDocumentExecutionGraph({
        externalId: expectedExecution.externalId,
        signingOrder: expectedExecution.signingOrder,
        recipients: expectedExecution.recipients,
        fields: expectedExecution.fields,
      }),
    )
  );
};
