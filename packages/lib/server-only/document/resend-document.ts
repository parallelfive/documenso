import { createElement } from 'react';

import { msg } from '@lingui/core/macro';
import type { DocumentMeta, Envelope, Recipient } from '@prisma/client';
import {
  DocumentSigningOrder,
  DocumentStatus,
  EnvelopeType,
  OrganisationType,
  RecipientRole,
  SigningStatus,
  WebhookTriggerEvents,
} from '@prisma/client';

import { mailer } from '@documenso/email/mailer';
import { DocumentInviteEmailTemplate } from '@documenso/email/templates/document-invite';
import { resolveExpiresAt } from '@documenso/lib/constants/envelope-expiration';
import {
  RECIPIENT_ROLES_DESCRIPTION,
  RECIPIENT_ROLE_TO_EMAIL_TYPE,
} from '@documenso/lib/constants/recipient-roles';
import { DOCUMENT_AUDIT_LOG_TYPE } from '@documenso/lib/types/document-audit-logs';
import type { ApiRequestMetadata } from '@documenso/lib/universal/extract-request-metadata';
import { createDocumentAuditLogData } from '@documenso/lib/utils/document-audit-logs';
import { renderCustomEmailTemplate } from '@documenso/lib/utils/render-custom-email-template';
import { prisma } from '@documenso/prisma';

import { getI18nInstance } from '../../client-only/providers/i18n-server';
import {
  NEXT_PUBLIC_WEBAPP_URL,
  buildRecipientSigningLink,
  isBizBuddyExternalId,
} from '../../constants/app';
import { AppError, AppErrorCode } from '../../errors/app-error';
import { extractDerivedDocumentEmailSettings } from '../../types/document-email';
import { mapEnvelopeToWebhookDocumentPayload } from '../../types/webhook-payload';
import { isDocumentCompleted } from '../../utils/document';
import type { EnvelopeIdOptions } from '../../utils/envelope';
import { logger } from '../../utils/logger';
import { isRecipientEmailValidForSending } from '../../utils/recipients';
import { renderEmailWithI18N } from '../../utils/render-email-with-i18n';
import { getEmailContext } from '../email/get-email-context';
import { getEnvelopeWhereInput } from '../envelope/get-envelope-by-id';
import { triggerWebhook } from '../webhooks/trigger/trigger-webhook';

export type ResendDocumentOptions = {
  id: EnvelopeIdOptions;
  userId: number;
  recipients: number[];
  teamId: number;
  requestMetadata: ApiRequestMetadata;
  requireCurrentSigningOrder?: boolean;
};

type ReminderEligibilityEnvelope = Pick<Envelope, 'status'> & {
  documentMeta: Pick<DocumentMeta, 'signingOrder'>;
  recipients: Array<Pick<Recipient, 'id' | 'role' | 'signingOrder' | 'signingStatus'>>;
};

/**
 * V1 reminders preserve the dispatch order contract. Sequential envelopes may
 * remind only their current lowest-order actionable recipient; parallel
 * envelopes may remind any exact, unsigned non-CC recipient.
 */
export const assertV1ReminderRecipientsEligible = (
  envelope: ReminderEligibilityEnvelope,
  requestedRecipientIds: number[],
) => {
  const uniqueRequestedRecipientIds = [...new Set(requestedRecipientIds)];
  const actionableRecipients = envelope.recipients
    .filter(
      (recipient) =>
        recipient.signingStatus === SigningStatus.NOT_SIGNED && recipient.role !== RecipientRole.CC,
    )
    .sort(
      (left, right) =>
        (left.signingOrder ?? Number.MAX_SAFE_INTEGER) -
          (right.signingOrder ?? Number.MAX_SAFE_INTEGER) || left.id - right.id,
    );

  const hasInvalidRequest =
    uniqueRequestedRecipientIds.length === 0 ||
    uniqueRequestedRecipientIds.length !== requestedRecipientIds.length;

  const isEligible =
    !hasInvalidRequest &&
    (envelope.documentMeta.signingOrder === DocumentSigningOrder.SEQUENTIAL
      ? uniqueRequestedRecipientIds.length === 1 &&
        uniqueRequestedRecipientIds[0] === actionableRecipients[0]?.id
      : uniqueRequestedRecipientIds.every((recipientId) =>
          actionableRecipients.some((recipient) => recipient.id === recipientId),
        ));

  if (!isEligible) {
    throw new AppError(AppErrorCode.CONFLICT, {
      message: 'Recipient is not currently eligible for a reminder',
    });
  }
};

export const resendDocument = async ({
  id,
  userId,
  recipients,
  teamId,
  requestMetadata,
  requireCurrentSigningOrder = false,
}: ResendDocumentOptions) => {
  const user = await prisma.user.findFirstOrThrow({
    where: {
      id: userId,
    },
    select: {
      id: true,
      email: true,
      name: true,
    },
  });

  const { envelopeWhereInput } = await getEnvelopeWhereInput({
    id,
    type: EnvelopeType.DOCUMENT,
    userId,
    teamId,
  });

  const envelope = await prisma.envelope.findUnique({
    where: envelopeWhereInput,
    include: {
      recipients: true,
      documentMeta: true,
      team: {
        select: {
          teamEmail: true,
          name: true,
        },
      },
    },
  });

  if (!envelope) {
    throw new Error('Document not found');
  }

  // Correlated documents must retain API V1 reminder ordering and the final
  // cancellation recheck even when a native Documenso route invokes the shared
  // service without explicitly opting into those guarantees.
  const enforceCurrentSigningOrder =
    requireCurrentSigningOrder || isBizBuddyExternalId(envelope.externalId);

  if (envelope.recipients.length === 0) {
    throw new Error('Document has no recipients');
  }

  if (envelope.status === DocumentStatus.DRAFT) {
    throw new Error('Can not send draft document');
  }

  if (isDocumentCompleted(envelope.status)) {
    throw new Error('Can not send completed document');
  }

  if (enforceCurrentSigningOrder) {
    assertV1ReminderRecipientsEligible(envelope, recipients);
  }

  // Refresh the expiresAt on each resent recipient.
  const expiresAt = resolveExpiresAt(envelope.documentMeta?.envelopeExpirationPeriod ?? null);

  const recipientsToRemind = envelope.recipients.filter(
    (recipient) =>
      recipients.includes(recipient.id) &&
      recipient.signingStatus === SigningStatus.NOT_SIGNED &&
      recipient.role !== RecipientRole.CC,
  );

  // Extend the expiration deadline for recipients being resent.
  if (expiresAt && recipientsToRemind.length > 0) {
    await prisma.recipient.updateMany({
      where: {
        id: {
          in: recipientsToRemind.map((r) => r.id),
        },
      },
      data: {
        expiresAt,
        expirationNotifiedAt: null,
      },
    });
  }

  const isRecipientSigningRequestEmailEnabled = extractDerivedDocumentEmailSettings(
    envelope.documentMeta,
  ).recipientSigningRequest;

  if (!isRecipientSigningRequestEmailEnabled) {
    return envelope;
  }

  const { branding, emailLanguage, organisationType, senderEmail, replyToEmail } =
    await getEmailContext({
      emailType: 'RECIPIENT',
      source: {
        type: 'team',
        teamId: envelope.teamId,
      },
      meta: envelope.documentMeta,
    });

  await Promise.all(
    recipientsToRemind.map(async (recipient) => {
      if (recipient.role === RecipientRole.CC || !isRecipientEmailValidForSending(recipient)) {
        return;
      }

      const i18n = await getI18nInstance(emailLanguage);

      const recipientEmailType = RECIPIENT_ROLE_TO_EMAIL_TYPE[recipient.role];

      const { email, name } = recipient;
      const selfSigner = email === user.email;

      const recipientActionVerb = i18n
        ._(RECIPIENT_ROLES_DESCRIPTION[recipient.role].actionVerb)
        .toLowerCase();

      let emailMessage = envelope.documentMeta.message || '';
      let emailSubject = i18n._(msg`Reminder: Please ${recipientActionVerb} this document`);

      if (selfSigner) {
        emailMessage = i18n._(
          msg`You have initiated the document ${`"${envelope.title}"`} that requires you to ${recipientActionVerb} it.`,
        );
        emailSubject = i18n._(msg`Reminder: Please ${recipientActionVerb} your document`);
      }

      if (organisationType === OrganisationType.ORGANISATION) {
        emailSubject = i18n._(
          msg`Reminder: ${envelope.team.name} invited you to ${recipientActionVerb} a document`,
        );
        emailMessage =
          envelope.documentMeta.message ||
          i18n._(
            msg`${user.name || user.email} on behalf of "${envelope.team.name}" has invited you to ${recipientActionVerb} the document "${envelope.title}".`,
          );
      }

      const customEmailTemplate = {
        'signer.name': name,
        'signer.email': email,
        'document.name': envelope.title,
      };

      const assetBaseUrl = NEXT_PUBLIC_WEBAPP_URL() || 'http://localhost:3000';
      const signDocumentLink = buildRecipientSigningLink({
        externalId: envelope.externalId,
        recipientToken: recipient.token,
      });

      const template = createElement(DocumentInviteEmailTemplate, {
        documentName: envelope.title,
        inviterName: user.name || undefined,
        inviterEmail:
          organisationType === OrganisationType.ORGANISATION
            ? envelope.team?.teamEmail?.email || user.email
            : user.email,
        assetBaseUrl,
        signDocumentLink,
        customBody: renderCustomEmailTemplate(emailMessage, customEmailTemplate),
        role: recipient.role,
        selfSigner,
        organisationType,
        teamName: envelope.team?.name,
      });

      const [html, text] = await Promise.all([
        renderEmailWithI18N(template, {
          lang: emailLanguage,
          branding,
        }),
        renderEmailWithI18N(template, {
          lang: emailLanguage,
          branding,
          plainText: true,
        }),
      ]);

      // Linearization point for V1 reminder/cancellation overlap. Rendering is
      // side-effect free; the last database observation happens immediately
      // before transport so a cancellation that committed first sends no mail.
      if (enforceCurrentSigningOrder) {
        const latestEnvelope = await prisma.envelope.findUnique({
          where: envelopeWhereInput,
          include: {
            recipients: true,
            documentMeta: true,
          },
        });

        if (!latestEnvelope || latestEnvelope.status !== DocumentStatus.PENDING) {
          throw new AppError(AppErrorCode.CONFLICT, {
            message: 'Document is no longer eligible for a reminder',
          });
        }

        assertV1ReminderRecipientsEligible(latestEnvelope, recipients);
      }

      // Send email outside any transaction to avoid holding a connection
      // open during network I/O.
      await mailer.sendMail({
        to: {
          address: email,
          name,
        },
        from: senderEmail,
        replyTo: replyToEmail,
        subject: envelope.documentMeta.subject
          ? renderCustomEmailTemplate(
              i18n._(msg`Reminder: ${envelope.documentMeta.subject}`),
              customEmailTemplate,
            )
          : emailSubject,
        html,
        text,
      });

      try {
        await prisma.documentAuditLog.create({
          data: createDocumentAuditLogData({
            type: DOCUMENT_AUDIT_LOG_TYPE.EMAIL_SENT,
            envelopeId: envelope.id,
            metadata: requestMetadata,
            data: {
              emailType: recipientEmailType,
              recipientEmail: recipient.email,
              recipientName: recipient.name,
              recipientRole: recipient.role,
              recipientId: recipient.id,
              isResending: true,
            },
          }),
        });
      } catch (error) {
        // Delivery has already succeeded. Never return a false failure that
        // invites a duplicate manual resend; audit repair is operational work.
        logger.error({
          event: 'document-reminder-email-audit-failed',
          envelopeId: envelope.id,
          recipientId: recipient.id,
          errorName: error instanceof Error ? error.name : 'UnknownError',
        });
      }
    }),
  );

  await triggerWebhook({
    event: WebhookTriggerEvents.DOCUMENT_REMINDER_SENT,
    data: () => mapEnvelopeToWebhookDocumentPayload(envelope),
    userId: envelope.userId,
    teamId: envelope.teamId,
  });

  return envelope;
};
