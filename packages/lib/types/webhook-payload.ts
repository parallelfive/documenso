import type { DocumentMeta, Envelope, Recipient } from '@prisma/client';
import {
  DocumentDistributionMethod,
  DocumentSigningOrder,
  DocumentSource,
  DocumentStatus,
  DocumentVisibility,
  EnvelopeType,
  ReadStatus,
  RecipientRole,
  SendStatus,
  SigningStatus,
  WebhookTriggerEvents,
} from '@prisma/client';
import { z } from 'zod';

import { isBizBuddyExternalId, isValidBizBuddyExternalId } from '../constants/app';
import { mapSecondaryIdToDocumentId, mapSecondaryIdToTemplateId } from '../utils/envelope';
import { MAX_BIZBUDDY_ENVELOPE_RECIPIENTS } from './document-execution-profile';

/**
 * Schema for recipient data in webhook payloads.
 */
export const ZWebhookRecipientSchema = z.object({
  id: z.number(),
  documentId: z.number().nullable(),
  templateId: z.number().nullable(),
  email: z.string(),
  name: z.string(),
  token: z.string(),
  documentDeletedAt: z.coerce.date().nullable(),
  expiresAt: z.coerce.date().nullable(),
  expirationNotifiedAt: z.coerce.date().nullable(),
  signedAt: z.coerce.date().nullable(),
  authOptions: z.any().nullable(),
  signingOrder: z.number().nullable(),
  rejectionReason: z.string().nullable(),
  role: z.nativeEnum(RecipientRole),
  readStatus: z.nativeEnum(ReadStatus),
  signingStatus: z.nativeEnum(SigningStatus),
  sendStatus: z.nativeEnum(SendStatus),
});

/**
 * Schema for document meta in webhook payloads.
 */
export const ZWebhookDocumentMetaSchema = z.object({
  id: z.string(),
  subject: z.string().nullable(),
  message: z.string().nullable(),
  timezone: z.string(),
  dateFormat: z.string(),
  redirectUrl: z.string().nullable(),
  signingOrder: z.nativeEnum(DocumentSigningOrder),
  allowDictateNextSigner: z.boolean(),
  typedSignatureEnabled: z.boolean(),
  uploadSignatureEnabled: z.boolean(),
  drawSignatureEnabled: z.boolean(),
  language: z.string(),
  distributionMethod: z.nativeEnum(DocumentDistributionMethod),
  emailSettings: z.any().nullable(),
});

/**
 * Schema for document data in webhook payloads.
 */
export const ZWebhookDocumentSchema = z.object({
  id: z.number(),
  externalId: z.string().nullable(),
  userId: z.number(),
  authOptions: z.any().nullable(),
  formValues: z.any().nullable(),
  visibility: z.nativeEnum(DocumentVisibility),
  title: z.string(),
  status: z.nativeEnum(DocumentStatus),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  completedAt: z.coerce.date().nullable(),
  deletedAt: z.coerce.date().nullable(),
  teamId: z.number().nullable(),
  templateId: z.number().nullable(),
  source: z.nativeEnum(DocumentSource),
  documentMeta: ZWebhookDocumentMetaSchema.nullable(),
  recipients: z.array(ZWebhookRecipientSchema),

  /**
   * Legacy field for backwards compatibility.
   */
  Recipient: z.array(ZWebhookRecipientSchema),
});

/**
 * Legacy unsafe delivery schema, retained only to recognize and redact
 * historical WebhookCall rows during manual resend. Current queue, worker,
 * wire, and history paths all use the strict lifecycle schemas below.
 */
export const ZWebhookPayloadSchema = z.object({
  event: z.nativeEnum(WebhookTriggerEvents),
  payload: ZWebhookDocumentSchema,
  createdAt: z.string(),
  webhookEndpoint: z.string(),
});

export type TWebhookRecipient = z.infer<typeof ZWebhookRecipientSchema>;
export type TWebhookDocument = z.infer<typeof ZWebhookDocumentSchema>;
export type WebhookPayload = z.infer<typeof ZWebhookPayloadSchema>;

export const MAX_BIZBUDDY_WEBHOOK_RECIPIENTS = MAX_BIZBUDDY_ENVELOPE_RECIPIENTS;
export const MAX_NATIVE_WEBHOOK_RECIPIENTS = 1_000;

const MAX_WEBHOOK_EXTERNAL_ID_LENGTH = 256;
const MAX_WEBHOOK_TIMESTAMP_LENGTH = 35;

const ZWebhookLifecycleIdSchema = z.number().int().positive().safe();
const ZWebhookLifecycleTimestampSchema = z
  .string()
  .max(MAX_WEBHOOK_TIMESTAMP_LENGTH)
  .datetime({ offset: true });
const ZWebhookLifecycleExternalIdSchema = z
  .string()
  .max(MAX_WEBHOOK_EXTERNAL_ID_LENGTH)
  .refine(
    (externalId) => !isBizBuddyExternalId(externalId) || isValidBizBuddyExternalId(externalId),
    {
      message: 'Malformed reserved Biz Buddy webhook namespace',
    },
  )
  .nullable();

export const ZWebhookLifecycleRecipientSchema = z
  .object({
    id: ZWebhookLifecycleIdSchema,
    role: z.nativeEnum(RecipientRole),
    readStatus: z.nativeEnum(ReadStatus),
    signingStatus: z.nativeEnum(SigningStatus),
    sendStatus: z.nativeEnum(SendStatus),
    signedAt: ZWebhookLifecycleTimestampSchema.nullable(),
    expiresAt: ZWebhookLifecycleTimestampSchema.nullable(),
  })
  .strict();

export const ZWebhookLifecycleDocumentSchema = z
  .object({
    id: ZWebhookLifecycleIdSchema,
    externalId: ZWebhookLifecycleExternalIdSchema,
    status: z.nativeEnum(DocumentStatus),
    createdAt: ZWebhookLifecycleTimestampSchema,
    updatedAt: ZWebhookLifecycleTimestampSchema,
    completedAt: ZWebhookLifecycleTimestampSchema.nullable(),
    deletedAt: ZWebhookLifecycleTimestampSchema.nullable(),
    recipients: z.array(ZWebhookLifecycleRecipientSchema).max(MAX_NATIVE_WEBHOOK_RECIPIENTS),
  })
  .strict()
  .superRefine((document, context) => {
    const recipientIds = new Set(document.recipients.map((recipient) => recipient.id));
    if (recipientIds.size !== document.recipients.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Webhook recipient ids must be unique',
        path: ['recipients'],
      });
    }

    if (
      isBizBuddyExternalId(document.externalId) &&
      document.recipients.length > MAX_BIZBUDDY_WEBHOOK_RECIPIENTS
    ) {
      context.addIssue({
        code: z.ZodIssueCode.too_big,
        type: 'array',
        maximum: MAX_BIZBUDDY_WEBHOOK_RECIPIENTS,
        inclusive: true,
        exact: false,
        message: `Biz Buddy webhook documents support at most ${MAX_BIZBUDDY_WEBHOOK_RECIPIENTS} recipients`,
        path: ['recipients'],
      });
    }
  });

export type WebhookLifecycleDocument = z.infer<typeof ZWebhookLifecycleDocumentSchema>;

/**
 * Safe, deliberately bounded history record for a webhook delivery.
 *
 * `evidenceVersion` also lets the manual-resend route distinguish these
 * redacted records from legacy rows that contain the full wire body.
 */
export const ZWebhookCallEvidenceSchema = z
  .object({
    evidenceVersion: z.literal(1),
    event: z.nativeEnum(WebhookTriggerEvents),
    payload: ZWebhookLifecycleDocumentSchema,
    createdAt: ZWebhookLifecycleTimestampSchema,
  })
  .strict();

export type WebhookCallEvidence = z.infer<typeof ZWebhookCallEvidenceSchema>;

/**
 * Projects a native document/template snapshot into the only lifecycle shape
 * the P5 fork may enqueue, log, send, or persist. Do not replace this with
 * recursive key deletion: future upstream fields must be excluded until they
 * are consciously classified as safe.
 */
export const projectWebhookLifecycleDocument = (payload: unknown): WebhookLifecycleDocument => {
  if (!isRecord(payload)) {
    throw new Error('Webhook payload is missing a valid document id');
  }

  const recipients = Array.isArray(payload.recipients)
    ? payload.recipients
    : Array.isArray(payload.Recipient)
      ? payload.Recipient
      : [];

  return ZWebhookLifecycleDocumentSchema.parse({
    id: payload.id,
    externalId: payload.externalId ?? null,
    status: payload.status,
    createdAt: normalizeLifecycleTimestamp(payload.createdAt),
    updatedAt: normalizeLifecycleTimestamp(payload.updatedAt),
    completedAt: normalizeLifecycleTimestamp(payload.completedAt),
    deletedAt: normalizeLifecycleTimestamp(payload.deletedAt),
    recipients: recipients.map((recipient) => {
      if (!isRecord(recipient)) return recipient;

      return {
        id: recipient.id,
        role: recipient.role,
        readStatus: recipient.readStatus,
        signingStatus: recipient.signingStatus,
        sendStatus: recipient.sendStatus,
        signedAt: normalizeLifecycleTimestamp(recipient.signedAt),
        expiresAt: normalizeLifecycleTimestamp(recipient.expiresAt),
      };
    }),
  });
};

export const projectWebhookCallEvidence = ({
  event,
  payload,
  createdAt,
}: {
  event: WebhookTriggerEvents;
  payload: unknown;
  createdAt: string;
}): WebhookCallEvidence => {
  return ZWebhookCallEvidenceSchema.parse({
    evidenceVersion: 1,
    event,
    payload: projectWebhookLifecycleDocument(payload),
    createdAt: normalizeLifecycleTimestamp(createdAt),
  });
};

/**
 * Resolves both new evidence rows and legacy full-body rows into the safe
 * lifecycle shape used by manual resend. Legacy capabilities are projected
 * away before the payload can enter the job system again.
 */
export const getSafeWebhookResendData = (requestBody: unknown): WebhookLifecycleDocument | null => {
  const evidence = ZWebhookCallEvidenceSchema.safeParse(requestBody);
  if (evidence.success) return evidence.data.payload;

  const legacy = ZWebhookPayloadSchema.safeParse(requestBody);
  if (!legacy.success) return null;

  try {
    return projectWebhookLifecycleDocument(legacy.data.payload);
  } catch {
    return null;
  }
};

export const mapEnvelopeToWebhookDocumentPayload = (
  envelope: Envelope & {
    recipients: Recipient[];
    documentMeta: DocumentMeta | null;
  },
): TWebhookDocument => {
  const { recipients: rawRecipients, documentMeta } = envelope;

  const legacyId =
    envelope.type === EnvelopeType.DOCUMENT
      ? mapSecondaryIdToDocumentId(envelope.secondaryId)
      : mapSecondaryIdToTemplateId(envelope.secondaryId);

  const mappedRecipients = rawRecipients.map((recipient) => ({
    id: recipient.id,
    documentId: envelope.type === EnvelopeType.DOCUMENT ? legacyId : null,
    templateId: envelope.type === EnvelopeType.TEMPLATE ? legacyId : null,
    email: recipient.email,
    name: recipient.name,
    token: recipient.token,
    documentDeletedAt: recipient.documentDeletedAt,
    expiresAt: recipient.expiresAt,
    expirationNotifiedAt: recipient.expirationNotifiedAt,
    signedAt: recipient.signedAt,
    authOptions: recipient.authOptions,
    signingOrder: recipient.signingOrder,
    rejectionReason: recipient.rejectionReason,
    role: recipient.role,
    readStatus: recipient.readStatus,
    signingStatus: recipient.signingStatus,
    sendStatus: recipient.sendStatus,
  }));

  return {
    id: legacyId,
    externalId: envelope.externalId,
    userId: envelope.userId,
    authOptions: envelope.authOptions,
    formValues: envelope.formValues,
    visibility: envelope.visibility,
    title: envelope.title,
    status: envelope.status,
    createdAt: envelope.createdAt,
    updatedAt: envelope.updatedAt,
    completedAt: envelope.completedAt,
    deletedAt: envelope.deletedAt,
    teamId: envelope.teamId,
    templateId: envelope.templateId,
    source: envelope.source,
    documentMeta: documentMeta
      ? {
          ...documentMeta,
          // Not sure why is optional in the prisma schema.
          timezone: 'Etc/UTC',
          dateFormat: 'yyyy-MM-dd hh:mm a',
        }
      : null,
    Recipient: mappedRecipients,
    recipients: mappedRecipients,
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const normalizeLifecycleTimestamp = (value: unknown): unknown => {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? value : value.toISOString();
  }

  return value ?? null;
};
