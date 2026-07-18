import { createElement } from 'react';

import { msg } from '@lingui/core/macro';
import type { DocumentMeta, Envelope, Recipient, User } from '@prisma/client';
import { DocumentStatus, EnvelopeType, SendStatus, WebhookTriggerEvents } from '@prisma/client';

import { mailer } from '@documenso/email/mailer';
import DocumentCancelTemplate from '@documenso/email/templates/document-cancel';
import { prisma } from '@documenso/prisma';

import { getI18nInstance } from '../../client-only/providers/i18n-server';
import { NEXT_PUBLIC_WEBAPP_URL, isBizBuddyExternalId } from '../../constants/app';
import { AppError, AppErrorCode } from '../../errors/app-error';
import { DOCUMENT_AUDIT_LOG_TYPE } from '../../types/document-audit-logs';
import { extractDerivedDocumentEmailSettings } from '../../types/document-email';
import { mapEnvelopeToWebhookDocumentPayload } from '../../types/webhook-payload';
import type { ApiRequestMetadata } from '../../universal/extract-request-metadata';
import { isDocumentCompleted } from '../../utils/document';
import { createDocumentAuditLogData } from '../../utils/document-audit-logs';
import { type EnvelopeIdOptions, unsafeBuildEnvelopeIdQuery } from '../../utils/envelope';
import { logger } from '../../utils/logger';
import { isRecipientEmailValidForSending } from '../../utils/recipients';
import { renderEmailWithI18N } from '../../utils/render-email-with-i18n';
import { processDocumentDataStorageCleanupAfterCommit } from '../document-data/process-document-data-storage-cleanup';
import {
  DOCUMENT_DATA_STORAGE_TRANSACTION_TIMEOUT_MS,
  getDocumentDataPresignReplayNotBefore,
  lockEnvelopeDocumentDataForCleanup,
  stageDocumentDataStorageCleanup,
} from '../document-data/stage-document-data-storage-cleanup';
import { getEmailContext } from '../email/get-email-context';
import { getMemberRoles } from '../team/get-member-roles';
import { triggerWebhook } from '../webhooks/trigger/trigger-webhook';

export type DeleteDocumentOptions = {
  id: EnvelopeIdOptions;
  userId: number;
  teamId: number;
  requestMetadata: ApiRequestMetadata;
  /**
   * API V1 cancellation is a legal-state transition, not the native UI's
   * delete/hide operation. It may hard-delete only a draft or pending envelope.
   */
  requireCancellableStatus?: boolean;
};

export const deleteDocument = async ({
  id,
  userId,
  teamId,
  requestMetadata,
  requireCancellableStatus = false,
}: DeleteDocumentOptions) => {
  const user = await prisma.user.findUnique({
    where: {
      id: userId,
    },
  });

  if (!user) {
    throw new AppError(AppErrorCode.NOT_FOUND, {
      message: 'User not found',
    });
  }

  // Note: This is an unsafe request, we validate the ownership later in the function.
  const envelope = await prisma.envelope.findUnique({
    where: unsafeBuildEnvelopeIdQuery(id, EnvelopeType.DOCUMENT),
    include: {
      recipients: true,
      documentMeta: true,
    },
  });

  if (!envelope) {
    throw new AppError(AppErrorCode.NOT_FOUND, {
      message: 'Document not found',
    });
  }

  // Correlated documents must retain API V1 cancellation semantics even when
  // reached through a native Documenso route that does not opt into them.
  const enforceCancellableStatus =
    requireCancellableStatus || isBizBuddyExternalId(envelope.externalId);

  const isUserTeamMember = await getMemberRoles({
    teamId: envelope.teamId,
    reference: {
      type: 'User',
      id: userId,
    },
  })
    .then(() => true)
    .catch(() => false);

  const isUserOwner = envelope.userId === userId;
  const userRecipient = envelope.recipients.find((recipient) => recipient.email === user.email);

  if (!isUserOwner && !isUserTeamMember && !userRecipient) {
    throw new AppError(AppErrorCode.UNAUTHORIZED, {
      message: 'Not allowed',
    });
  }

  // Handle hard or soft deleting the actual document if user has permission.
  if (isUserOwner || isUserTeamMember) {
    await handleDocumentOwnerDelete({
      envelope,
      user,
      requestMetadata,
      requireCancellableStatus: enforceCancellableStatus,
    });

    await triggerWebhook({
      event: WebhookTriggerEvents.DOCUMENT_CANCELLED,
      data: () => mapEnvelopeToWebhookDocumentPayload(envelope),
      userId,
      teamId,
    });
  }

  // Continue to hide the document from the user if they are a recipient.
  // Dirty way of doing this but it's faster than refetching the document.
  if (userRecipient?.documentDeletedAt === null) {
    await prisma.recipient
      .update({
        where: {
          id: userRecipient.id,
        },
        data: {
          documentDeletedAt: new Date().toISOString(),
        },
      })
      .catch(() => {
        // Do nothing.
      });
  }

  return envelope;
};

type HandleDocumentOwnerDeleteOptions = {
  envelope: Envelope & {
    recipients: Recipient[];
    documentMeta: DocumentMeta | null;
  };
  user: User;
  requestMetadata: ApiRequestMetadata;
  requireCancellableStatus: boolean;
};

const handleDocumentOwnerDelete = async ({
  envelope,
  user,
  requestMetadata,
  requireCancellableStatus,
}: HandleDocumentOwnerDeleteOptions) => {
  if (
    requireCancellableStatus &&
    envelope.status !== DocumentStatus.DRAFT &&
    envelope.status !== DocumentStatus.PENDING
  ) {
    throw new AppError(AppErrorCode.CONFLICT, {
      message: 'Document can no longer be cancelled',
    });
  }

  if (envelope.deletedAt) {
    return;
  }

  const { branding, emailLanguage, senderEmail, replyToEmail } = await getEmailContext({
    emailType: 'RECIPIENT',
    source: {
      type: 'team',
      teamId: envelope.teamId,
    },
    meta: envelope.documentMeta,
  });

  // Soft delete completed documents.
  if (isDocumentCompleted(envelope.status)) {
    return await prisma.$transaction(async (tx) => {
      await tx.documentAuditLog.create({
        data: createDocumentAuditLogData({
          envelopeId: envelope.id,
          type: DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_DELETED,
          metadata: requestMetadata,
          data: {
            type: 'SOFT',
          },
        }),
      });

      return await tx.envelope.update({
        where: {
          id: envelope.id,
        },
        data: {
          deletedAt: new Date().toISOString(),
        },
      });
    });
  }

  // Hard delete draft and pending documents.
  let deletedEnvelope: Envelope;
  let storageCleanupIds: string[] = [];

  try {
    deletedEnvelope = await prisma.$transaction(
      async (tx) => {
        const documentDataIds = await lockEnvelopeDocumentDataForCleanup({
          tx,
          envelopeId: envelope.id,
        });

        // Currently redundant since deleting a document will delete the audit logs.
        // However may be useful if we disassociate audit logs and documents if required.
        await tx.documentAuditLog.create({
          data: createDocumentAuditLogData({
            envelopeId: envelope.id,
            type: DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_DELETED,
            metadata: requestMetadata,
            data: {
              type: 'HARD',
            },
          }),
        });

        const result = await tx.envelope.delete({
          where: {
            id: envelope.id,
            status: requireCancellableStatus
              ? {
                  in: [DocumentStatus.DRAFT, DocumentStatus.PENDING],
                }
              : {
                  not: DocumentStatus.COMPLETED,
                },
          },
        });

        storageCleanupIds = await stageDocumentDataStorageCleanup({
          tx,
          documentDataIds,
          notBefore: getDocumentDataPresignReplayNotBefore(),
        });

        return result;
      },
      {
        timeout: DOCUMENT_DATA_STORAGE_TRANSACTION_TIMEOUT_MS,
      },
    );
  } catch (error) {
    if (
      requireCancellableStatus &&
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'P2025'
    ) {
      throw new AppError(AppErrorCode.CONFLICT, {
        message: 'Document can no longer be cancelled',
      });
    }

    throw error;
  }

  await processDocumentDataStorageCleanupAfterCommit({
    cleanupIds: storageCleanupIds,
    envelopeId: envelope.id,
    event: 'document-cancelled',
  });

  const isEnvelopeDeleteEmailEnabled = extractDerivedDocumentEmailSettings(
    envelope.documentMeta,
  ).documentDeleted;

  if (!isEnvelopeDeleteEmailEnabled) {
    return deletedEnvelope;
  }

  // The delete is already committed. Attempt every cancellation email, report
  // aggregate failures without exposing recipient identity, and never convert
  // the successful deletion into a false API failure/retry.
  const emailResults = await Promise.allSettled(
    envelope.recipients.map(async (recipient) => {
      if (recipient.sendStatus !== SendStatus.SENT || !isRecipientEmailValidForSending(recipient)) {
        return;
      }

      const assetBaseUrl = NEXT_PUBLIC_WEBAPP_URL() || 'http://localhost:3000';

      const template = createElement(DocumentCancelTemplate, {
        documentName: envelope.title,
        inviterName: user.name || undefined,
        inviterEmail: user.email,
        assetBaseUrl,
      });

      const [html, text] = await Promise.all([
        renderEmailWithI18N(template, { lang: emailLanguage, branding }),
        renderEmailWithI18N(template, {
          lang: emailLanguage,
          branding,
          plainText: true,
        }),
      ]);

      const i18n = await getI18nInstance(emailLanguage);

      await mailer.sendMail({
        to: {
          address: recipient.email,
          name: recipient.name,
        },
        from: senderEmail,
        replyTo: replyToEmail,
        subject: i18n._(msg`Document Cancelled`),
        html,
        text,
      });
    }),
  );

  const failedEmailCount = emailResults.filter((result) => result.status === 'rejected').length;
  if (failedEmailCount > 0) {
    logger.error({
      event: 'document-delete-cancellation-email-failed',
      envelopeId: envelope.id,
      failedEmailCount,
      attemptedEmailCount: emailResults.length,
    });
  }

  return deletedEnvelope;
};
