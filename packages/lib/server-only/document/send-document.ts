import type {
  DocumentData,
  Envelope,
  EnvelopeItem,
  Field,
  Prisma,
  Recipient,
} from '@prisma/client';
import {
  DocumentDataType,
  DocumentSigningOrder,
  DocumentStatus,
  EnvelopeType,
  FieldType,
  RecipientRole,
  SendStatus,
  SigningStatus,
  WebhookTriggerEvents,
} from '@prisma/client';
import { createHash } from 'node:crypto';

import { APP_DOCUMENT_UPLOAD_SIZE_LIMIT, isBizBuddyExternalId } from '@documenso/lib/constants/app';
import { resolveExpiresAt } from '@documenso/lib/constants/envelope-expiration';
import { DOCUMENT_AUDIT_LOG_TYPE } from '@documenso/lib/types/document-audit-logs';
import type { ApiRequestMetadata } from '@documenso/lib/universal/extract-request-metadata';
import {
  createDocumentAuditLogData,
  diffDocumentMetaChanges,
} from '@documenso/lib/utils/document-audit-logs';
import { prisma } from '@documenso/prisma';
import { checkboxValidationSigns } from '@documenso/ui/primitives/document-flow/field-items-advanced-settings/constants';

import { validateCheckboxLength } from '../../advanced-fields-validation/validate-checkbox';
import { DIRECT_TEMPLATE_RECIPIENT_EMAIL } from '../../constants/direct-templates';
import { AppError, AppErrorCode } from '../../errors/app-error';
import { jobs } from '../../jobs/client';
import {
  type TDocumentEmailSettings,
  extractDerivedDocumentEmailSettings,
} from '../../types/document-email';
import {
  type TExpectedDocumentExecution,
  matchesExpectedDocumentExecution,
} from '../../types/document-execution';
import {
  ZCheckboxFieldMeta,
  ZDropdownFieldMeta,
  ZFieldAndMetaSchema,
  ZNumberFieldMeta,
  ZRadioFieldMeta,
  ZTextFieldMeta,
} from '../../types/field-meta';
import { mapEnvelopeToWebhookDocumentPayload } from '../../types/webhook-payload';
import {
  FileSizeLimitExceededError,
  getFileServerSide,
} from '../../universal/upload/get-file.server';
import {
  putInternalPdfSnapshotServerSide,
  putNormalizedPdfFileServerSide,
} from '../../universal/upload/put-file.server';
import { isDocumentCompleted } from '../../utils/document';
import { extractDocumentAuthMethods } from '../../utils/document-auth';
import { type EnvelopeIdOptions, mapSecondaryIdToDocumentId } from '../../utils/envelope';
import { toCheckboxCustomText, toRadioCustomText } from '../../utils/fields';
import { logger } from '../../utils/logger';
import {
  getRecipientsWithMissingFields,
  isRecipientEmailValidForSending,
} from '../../utils/recipients';
import { processDocumentDataStorageCleanupAfterCommit } from '../document-data/process-document-data-storage-cleanup';
import {
  getDocumentDataPresignReplayNotBefore,
  releaseProvisionalDocumentDataStorageCleanup,
  stageDocumentDataStorageCleanup,
} from '../document-data/stage-document-data-storage-cleanup';
import { getEnvelopeWhereInput } from '../envelope/get-envelope-by-id';
import { insertFormValuesInPdf } from '../pdf/insert-form-values-in-pdf';
import { triggerWebhook } from '../webhooks/trigger/trigger-webhook';
import { withDocumentDraftMutationGuard } from './with-document-draft-mutation-guard';

const MAX_ATOMIC_EXECUTION_PDF_BYTES = Math.max(1, APP_DOCUMENT_UPLOAD_SIZE_LIMIT) * 1024 * 1024;
const ATOMIC_EXECUTION_PDF_READ_TIMEOUT_MS = 30_000;

type PreparedExecutionPdfSnapshot = {
  sourceEnvelopeItemId: string;
  sourceDocumentDataId: string;
  documentData: DocumentData;
};

export type SendDocumentOptions = {
  id: EnvelopeIdOptions;
  userId: number;
  teamId: number;
  sendEmail?: boolean;
  documentEmailSettings?: TDocumentEmailSettings;
  expectedExecution?: TExpectedDocumentExecution;
  /**
   * API V1 dispatch is a one-way legal-state transition. Native callers keep
   * their existing resend-like semantics unless they opt into this guard.
   */
  requireDraftStatus?: boolean;
  requestMetadata: ApiRequestMetadata;
};

export const sendDocument = async ({
  id,
  userId,
  teamId,
  sendEmail,
  documentEmailSettings,
  expectedExecution,
  requireDraftStatus = false,
  requestMetadata,
}: SendDocumentOptions) => {
  const { envelopeWhereInput } = await getEnvelopeWhereInput({
    id,
    type: EnvelopeType.DOCUMENT,
    userId,
    teamId,
  });

  const envelope = await prisma.envelope.findFirst({
    where: envelopeWhereInput,
    include: {
      recipients: {
        orderBy: [{ signingOrder: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
      },
      fields: true,
      documentMeta: true,
      envelopeItems: {
        select: {
          id: true,
          documentData: {
            select: {
              type: true,
              id: true,
              data: true,
              initialData: true,
            },
          },
        },
      },
    },
  });

  if (!envelope) {
    throw new Error('Document not found');
  }

  if (envelope.recipients.length === 0) {
    throw new Error('Document has no recipients');
  }

  const mustUseAtomicExecution = requireDraftStatus || isBizBuddyExternalId(envelope.externalId);

  if (mustUseAtomicExecution && envelope.status !== DocumentStatus.DRAFT) {
    throw new AppError(AppErrorCode.CONFLICT, {
      message: 'Document is no longer a draft',
    });
  }

  if (isBizBuddyExternalId(envelope.externalId) && !expectedExecution) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'Expected execution lease is required for correlated documents',
    });
  }

  if (mustUseAtomicExecution && envelope.formValues) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'Form values are not supported by atomic V1 dispatch',
    });
  }

  if (!mustUseAtomicExecution && isDocumentCompleted(envelope.status)) {
    throw new Error('Can not send completed document');
  }

  const legacyDocumentId = mapSecondaryIdToDocumentId(envelope.secondaryId);

  if (envelope.envelopeItems.length === 0) {
    throw new Error('Missing envelope items');
  }

  if (envelope.formValues) {
    await Promise.all(
      envelope.envelopeItems.map(async (envelopeItem) => {
        await injectFormValuesIntoDocument(envelope, envelopeItem);
      }),
    );
  }

  // Validate that recipients with auth requirements have a valid email.
  envelope.recipients.forEach((recipient) => {
    const auth = extractDocumentAuthMethods({
      documentAuth: envelope.authOptions,
      recipientAuth: recipient.authOptions,
    });

    if (
      recipient.role !== RecipientRole.CC &&
      (auth.recipientAccessAuthRequired || auth.recipientActionAuthRequired) &&
      !isRecipientEmailValidForSending(recipient)
    ) {
      throw new AppError(AppErrorCode.INVALID_REQUEST, {
        message: `Recipient ${recipient.id} requires an email because they have auth requirements.`,
      });
    }
  });

  // Validate that recipients who require fields (e.g., signers need signature fields) have them.
  const recipientsWithMissingFields = getRecipientsWithMissingFields(
    envelope.recipients,
    envelope.fields,
  );

  if (recipientsWithMissingFields.length > 0) {
    const missingRecipientDescriptions = recipientsWithMissingFields
      .map((r) => (r.name ? `${r.name} (${r.email}, id: ${r.id})` : `${r.email} (id: ${r.id})`))
      .join(', ');

    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: `The following recipients are missing required fields: ${missingRecipientDescriptions}. Signers must have at least one signature field.`,
    });
  }

  let preparedExecutionPdfSnapshot: PreparedExecutionPdfSnapshot | null = null;
  let sourceStorageCleanupIds: string[] = [];

  if (isBizBuddyExternalId(envelope.externalId)) {
    if (!expectedExecution) {
      throw new AppError(AppErrorCode.INVALID_REQUEST, {
        message: 'Expected execution lease is required for correlated documents',
      });
    }

    if (envelope.internalVersion !== 1 || envelope.envelopeItems.length !== 1) {
      throw new AppError(AppErrorCode.CONFLICT, {
        message: 'Correlated execution requires exactly one V1 PDF item',
      });
    }

    if (expectedExecution.expectedPdf.byteLength > MAX_ATOMIC_EXECUTION_PDF_BYTES) {
      throw new AppError(AppErrorCode.INVALID_REQUEST, {
        message: 'Expected PDF exceeds the configured document size limit',
      });
    }

    const sourceEnvelopeItem = envelope.envelopeItems[0];
    let sourcePdf: Uint8Array;

    try {
      sourcePdf = await getFileServerSide(sourceEnvelopeItem.documentData, {
        maxBytes: expectedExecution.expectedPdf.byteLength,
        timeoutMs: ATOMIC_EXECUTION_PDF_READ_TIMEOUT_MS,
      });
    } catch (error) {
      if (error instanceof FileSizeLimitExceededError) {
        throw new AppError(AppErrorCode.CONFLICT, {
          message: 'Uploaded PDF does not match the expected execution content',
        });
      }

      throw error;
    }

    const actualSha256 = createHash('sha256').update(sourcePdf).digest('hex');

    if (
      sourcePdf.byteLength !== expectedExecution.expectedPdf.byteLength ||
      actualSha256 !== expectedExecution.expectedPdf.sha256
    ) {
      throw new AppError(AppErrorCode.CONFLICT, {
        message: 'Uploaded PDF does not match the expected execution content',
      });
    }

    const immutableBytes = Uint8Array.from(sourcePdf);
    const { documentData } = await putInternalPdfSnapshotServerSide({
      name: envelope.title,
      type: 'application/pdf',
      arrayBuffer: async () => await Promise.resolve(immutableBytes.buffer),
    });

    preparedExecutionPdfSnapshot = {
      sourceEnvelopeItemId: sourceEnvelopeItem.id,
      sourceDocumentDataId: sourceEnvelopeItem.documentData.id,
      documentData,
    };
  }

  const allRecipientsHaveNoActionToTake = envelope.recipients.every(
    (recipient) =>
      recipient.role === RecipientRole.CC || recipient.signingStatus === SigningStatus.SIGNED,
  );

  const assertLockedExecutionLease = async (tx: Prisma.TransactionClient) => {
    if (!expectedExecution) return;

    const lockedExecution = await tx.envelope.findUnique({
      where: {
        id: envelope.id,
      },
      select: {
        externalId: true,
        teamId: true,
        documentMeta: {
          select: {
            signingOrder: true,
          },
        },
        recipients: {
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
            signingOrder: true,
          },
        },
        fields: {
          select: {
            id: true,
            recipientId: true,
            type: true,
            page: true,
            positionX: true,
            positionY: true,
            width: true,
            height: true,
          },
        },
        envelopeItems: {
          select: {
            id: true,
            documentDataId: true,
          },
        },
      },
    });

    const lockedSourceItem = lockedExecution?.envelopeItems[0];

    if (
      !lockedExecution ||
      lockedExecution.teamId !== teamId ||
      !matchesExpectedDocumentExecution(lockedExecution, expectedExecution) ||
      (preparedExecutionPdfSnapshot !== null &&
        (lockedExecution.envelopeItems.length !== 1 ||
          lockedSourceItem?.id !== preparedExecutionPdfSnapshot.sourceEnvelopeItemId ||
          lockedSourceItem.documentDataId !== preparedExecutionPdfSnapshot.sourceDocumentDataId))
    ) {
      throw new AppError(AppErrorCode.CONFLICT, {
        message: 'Document execution lease no longer matches',
      });
    }
  };

  const attachPreparedExecutionPdfSnapshot = async (tx: Prisma.TransactionClient) => {
    if (!preparedExecutionPdfSnapshot) return;

    const attached = await tx.envelopeItem.updateMany({
      where: {
        id: preparedExecutionPdfSnapshot.sourceEnvelopeItemId,
        envelopeId: envelope.id,
        documentDataId: preparedExecutionPdfSnapshot.sourceDocumentDataId,
      },
      data: {
        documentDataId: preparedExecutionPdfSnapshot.documentData.id,
      },
    });

    if (attached.count !== 1) {
      throw new AppError(AppErrorCode.CONFLICT, {
        message: 'Document PDF changed before dispatch',
      });
    }

    if (preparedExecutionPdfSnapshot.documentData.type === DocumentDataType.S3_PATH) {
      await releaseProvisionalDocumentDataStorageCleanup({
        tx,
        documentDataId: preparedExecutionPdfSnapshot.documentData.id,
      });
    }

    sourceStorageCleanupIds = await stageDocumentDataStorageCleanup({
      tx,
      documentDataIds: [preparedExecutionPdfSnapshot.sourceDocumentDataId],
      notBefore: getDocumentDataPresignReplayNotBefore(),
    });
  };

  const cleanUpPreparedExecutionPdfSnapshot = async () => {
    if (!preparedExecutionPdfSnapshot) return;

    try {
      const cleanupIds = await prisma.$transaction(async (tx) =>
        stageDocumentDataStorageCleanup({
          tx,
          documentDataIds: [preparedExecutionPdfSnapshot.documentData.id],
          preserveExistingNotBefore: false,
        }),
      );

      await processDocumentDataStorageCleanupAfterCommit({
        cleanupIds,
        envelopeId: envelope.id,
        event: 'document-snapshot-abandoned',
      });
    } catch (error) {
      // Cleanup is best-effort and must never replace the dispatch error.
      logger.warn({
        message: 'Failed to clean up an unreferenced execution PDF snapshot',
        documentDataId: preparedExecutionPdfSnapshot.documentData.id,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
    }
  };

  if (allRecipientsHaveNoActionToTake) {
    let claimedEnvelope:
      | (Envelope & {
          documentMeta: typeof envelope.documentMeta;
          recipients: typeof envelope.recipients;
        })
      | null = null;

    if (mustUseAtomicExecution) {
      try {
        claimedEnvelope = await prisma.$transaction(async (tx) =>
          withDocumentDraftMutationGuard(
            {
              tx,
              envelopeId: envelope.id,
              teamId,
              expectedExternalId: isBizBuddyExternalId(envelope.externalId)
                ? envelope.externalId
                : undefined,
              transitionToPending: true,
            },
            async () => {
              await assertLockedExecutionLease(tx);
              await attachPreparedExecutionPdfSnapshot(tx);

              if (documentEmailSettings) {
                const updatedDocumentMeta = await tx.documentMeta.update({
                  where: {
                    id: envelope.documentMetaId,
                  },
                  data: {
                    emailSettings: documentEmailSettings,
                  },
                });
                const changes = diffDocumentMetaChanges(
                  envelope.documentMeta ?? {},
                  updatedDocumentMeta,
                );

                if (changes.length > 0) {
                  await tx.documentAuditLog.create({
                    data: createDocumentAuditLogData({
                      type: DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_META_UPDATED,
                      envelopeId: envelope.id,
                      metadata: requestMetadata,
                      data: {
                        changes,
                      },
                    }),
                  });
                }
              }

              return tx.envelope.findFirstOrThrow({
                where: {
                  id: envelope.id,
                },
                include: {
                  documentMeta: true,
                  recipients: true,
                },
              });
            },
          ),
        );
      } catch (error) {
        await cleanUpPreparedExecutionPdfSnapshot();
        throw error;
      }
    }

    await processDocumentDataStorageCleanupAfterCommit({
      cleanupIds: sourceStorageCleanupIds,
      envelopeId: envelope.id,
      event: 'document-source-retired',
    });

    await jobs.triggerJob({
      name: 'internal.seal-document',
      payload: {
        documentId: legacyDocumentId,
        requestMetadata: requestMetadata?.requestMetadata,
      },
    });

    // Keep the return type the same for the `sendDocument` method
    return (
      claimedEnvelope ??
      (await prisma.envelope.findFirstOrThrow({
        where: {
          id: envelope.id,
        },
        include: {
          documentMeta: true,
          recipients: true,
        },
      }))
    );
  }

  const fieldsToAutoInsert: { fieldId: number; customText: string }[] = [];

  // Validate and autoinsert fields for V2 envelopes.
  if (envelope.internalVersion === 2) {
    for (const unknownField of envelope.fields) {
      const recipient = envelope.recipients.find((r) => r.id === unknownField.recipientId);

      if (!recipient) {
        throw new AppError(AppErrorCode.NOT_FOUND, {
          message: 'Recipient not found',
        });
      }

      const fieldToAutoInsert = extractFieldAutoInsertValues(unknownField, recipient);

      // Only auto-insert fields if the recipient has not been sent the document yet.
      if (fieldToAutoInsert && recipient.sendStatus !== SendStatus.SENT) {
        fieldsToAutoInsert.push(fieldToAutoInsert);
      }
    }
  }

  const updatedEnvelope = await prisma
    .$transaction(async (tx) => {
      const mutateDocumentForSend = async () => {
        if (mustUseAtomicExecution) {
          await assertLockedExecutionLease(tx);
          await attachPreparedExecutionPdfSnapshot(tx);
        }

        if (documentEmailSettings) {
          const updatedDocumentMeta = await tx.documentMeta.update({
            where: {
              id: envelope.documentMetaId,
            },
            data: {
              emailSettings: documentEmailSettings,
            },
          });
          const changes = diffDocumentMetaChanges(envelope.documentMeta ?? {}, updatedDocumentMeta);

          if (changes.length > 0) {
            await tx.documentAuditLog.create({
              data: createDocumentAuditLogData({
                type: DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_META_UPDATED,
                envelopeId: envelope.id,
                metadata: requestMetadata,
                data: {
                  changes,
                },
              }),
            });
          }
        }

        if (envelope.status === DocumentStatus.DRAFT) {
          await tx.documentAuditLog.create({
            data: createDocumentAuditLogData({
              type: DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_SENT,
              envelopeId: envelope.id,
              metadata: requestMetadata,
              data: {},
            }),
          });
        }

        if (envelope.internalVersion === 2) {
          const autoInsertedFields = await Promise.all(
            fieldsToAutoInsert.map(async (field) => {
              // Warning: Only auto-insert fields if the recipient has not been sent the document yet.
              return await tx.field.update({
                where: {
                  id: field.fieldId,
                },
                data: {
                  customText: field.customText,
                  inserted: true,
                },
              });
            }),
          );

          await tx.documentAuditLog.create({
            data: createDocumentAuditLogData({
              type: DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_FIELDS_AUTO_INSERTED,
              envelopeId: envelope.id,
              data: {
                fields: autoInsertedFields.map((field) => ({
                  fieldId: field.id,
                  fieldType: field.type,
                  recipientId: field.recipientId,
                })),
              },
              // Don't put metadata or user here since it's a system event.
            }),
          });
        }

        const expiresAt = resolveExpiresAt(envelope.documentMeta?.envelopeExpirationPeriod ?? null);

        // Set expiresAt on each recipient that hasn't already signed/rejected.
        // Exclude CC recipients since they don't sign and shouldn't be subject to expiry.
        if (expiresAt) {
          await tx.recipient.updateMany({
            where: {
              envelopeId: envelope.id,
              signingStatus: {
                notIn: [SigningStatus.SIGNED, SigningStatus.REJECTED],
              },
              role: {
                not: RecipientRole.CC,
              },
            },
            data: {
              expiresAt,
              expirationNotifiedAt: null,
            },
          });
        }

        if (mustUseAtomicExecution) {
          return tx.envelope.findFirstOrThrow({
            where: {
              id: envelope.id,
            },
            include: {
              documentMeta: true,
              recipients: true,
            },
          });
        }

        return tx.envelope.update({
          where: {
            id: envelope.id,
          },
          data: {
            status: DocumentStatus.PENDING,
          },
          include: {
            documentMeta: true,
            recipients: true,
          },
        });
      };

      if (mustUseAtomicExecution) {
        return withDocumentDraftMutationGuard(
          {
            tx,
            envelopeId: envelope.id,
            teamId,
            expectedExternalId: isBizBuddyExternalId(envelope.externalId)
              ? envelope.externalId
              : undefined,
            transitionToPending: true,
          },
          mutateDocumentForSend,
        );
      }

      return mutateDocumentForSend();
    })
    .catch(async (error: unknown) => {
      await cleanUpPreparedExecutionPdfSnapshot();
      throw error;
    });

  await processDocumentDataStorageCleanupAfterCommit({
    cleanupIds: sourceStorageCleanupIds,
    envelopeId: envelope.id,
    event: 'document-source-retired',
  });

  const isRecipientSigningRequestEmailEnabled = extractDerivedDocumentEmailSettings(
    updatedEnvelope.documentMeta,
  ).recipientSigningRequest;
  const signingOrder = updatedEnvelope.documentMeta?.signingOrder || DocumentSigningOrder.PARALLEL;
  const recipientsToNotify =
    signingOrder === DocumentSigningOrder.SEQUENTIAL
      ? updatedEnvelope.recipients
          .filter(
            (recipient) =>
              recipient.signingStatus === SigningStatus.NOT_SIGNED &&
              recipient.role !== RecipientRole.CC &&
              recipient.sendStatus !== SendStatus.SENT,
          )
          .sort(
            (left, right) =>
              (left.signingOrder ?? Number.MAX_SAFE_INTEGER) -
                (right.signingOrder ?? Number.MAX_SAFE_INTEGER) || left.id - right.id,
          )
          .slice(0, 1)
      : updatedEnvelope.recipients;

  // Only send email if one of the following is true:
  // - It is explicitly set
  // - The email is enabled for signing requests AND sendEmail is undefined
  if (sendEmail || (isRecipientSigningRequestEmailEnabled && sendEmail === undefined)) {
    await Promise.all(
      recipientsToNotify.map(async (recipient) => {
        if (recipient.sendStatus === SendStatus.SENT || recipient.role === RecipientRole.CC) {
          return;
        }

        await jobs.triggerJob({
          name: 'send.signing.requested.email',
          payload: {
            userId,
            documentId: legacyDocumentId,
            recipientId: recipient.id,
            requestMetadata: requestMetadata?.requestMetadata,
          },
        });
      }),
    );
  }

  await triggerWebhook({
    event: WebhookTriggerEvents.DOCUMENT_SENT,
    data: () => mapEnvelopeToWebhookDocumentPayload(updatedEnvelope),
    userId,
    teamId,
  });

  return updatedEnvelope;
};

const injectFormValuesIntoDocument = async (
  envelope: Envelope,
  envelopeItem: Pick<EnvelopeItem, 'id'> & { documentData: DocumentData },
) => {
  const file = await getFileServerSide(envelopeItem.documentData);

  const prefilled = await insertFormValuesInPdf({
    pdf: Buffer.from(file),
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    formValues: envelope.formValues as Record<string, string | number | boolean>,
  });

  let fileName = envelope.title;

  if (!envelope.title.endsWith('.pdf')) {
    fileName = `${envelope.title}.pdf`;
  }

  const newDocumentData = await putNormalizedPdfFileServerSide({
    name: fileName,
    type: 'application/pdf',
    arrayBuffer: async () => Promise.resolve(prefilled),
  });

  await prisma.envelopeItem.update({
    where: {
      id: envelopeItem.id,
    },
    data: {
      documentDataId: newDocumentData.id,
    },
  });
};

/**
 * Extracts the auto insertion values for a given field.
 *
 * If field is not auto insertable, returns `null`.
 */
export const extractFieldAutoInsertValues = (
  unknownField: Field,
  recipient: Pick<Recipient, 'email'>,
): { fieldId: number; customText: string } | null => {
  const parsedField = ZFieldAndMetaSchema.safeParse(unknownField);

  if (parsedField.error) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'One or more fields have invalid metadata. Error: ' + parsedField.error.message,
    });
  }

  const field = parsedField.data;
  const fieldId = unknownField.id;

  // Auto insert email fields if the recipient has a valid email.
  if (
    field.type === FieldType.EMAIL &&
    isRecipientEmailValidForSending(recipient) &&
    recipient.email !== DIRECT_TEMPLATE_RECIPIENT_EMAIL
  ) {
    return {
      fieldId,
      customText: recipient.email,
    };
  }

  // Auto insert text fields with prefilled values.
  if (field.type === FieldType.TEXT) {
    const { text } = ZTextFieldMeta.parse(field.fieldMeta);

    if (text) {
      return {
        fieldId,
        customText: text,
      };
    }
  }

  // Auto insert number fields with prefilled values.
  if (field.type === FieldType.NUMBER) {
    const { value } = ZNumberFieldMeta.parse(field.fieldMeta);

    if (value) {
      return {
        fieldId,
        customText: value,
      };
    }
  }

  // Auto insert radio fields with the pre-checked value.
  if (field.type === FieldType.RADIO) {
    const { values = [] } = ZRadioFieldMeta.parse(field.fieldMeta);

    const checkedItemIndex = values.findIndex((value) => value.checked);

    if (checkedItemIndex !== -1) {
      return {
        fieldId,
        customText: toRadioCustomText(checkedItemIndex),
      };
    }
  }

  // Auto insert dropdown fields with the default value.
  if (field.type === FieldType.DROPDOWN) {
    const { defaultValue, values = [] } = ZDropdownFieldMeta.parse(field.fieldMeta);

    if (defaultValue && values.some((value) => value.value === defaultValue)) {
      return {
        fieldId,
        customText: defaultValue,
      };
    }
  }

  // Auto insert checkbox fields with the pre-checked values.
  if (field.type === FieldType.CHECKBOX) {
    const {
      values = [],
      validationRule,
      validationLength,
    } = ZCheckboxFieldMeta.parse(field.fieldMeta);

    const checkedIndices: number[] = [];

    values.forEach((value, i) => {
      if (value.checked) {
        checkedIndices.push(i);
      }
    });

    let isValid = true;

    if (validationRule && validationLength) {
      const validation = checkboxValidationSigns.find((sign) => sign.label === validationRule);

      if (!validation) {
        throw new AppError(AppErrorCode.INVALID_REQUEST, {
          message: 'Invalid checkbox validation rule',
        });
      }

      isValid = validateCheckboxLength(checkedIndices.length, validation.value, validationLength);
    }

    if (isValid && checkedIndices.length > 0) {
      return {
        fieldId,
        customText: toCheckboxCustomText(checkedIndices),
      };
    }
  }

  return null;
};
