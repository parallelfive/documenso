import {
  DocumentDataType,
  DocumentStatus,
  EnvelopeType,
  RecipientRole,
  SigningStatus,
} from '@prisma/client';
import { tsr } from '@ts-rest/serverless/fetch';
import { match } from 'ts-pattern';

import { getServerLimits } from '@documenso/ee/server-only/limits/server';
import {
  NEXT_PUBLIC_WEBAPP_URL,
  isBizBuddyExternalId,
  isValidBizBuddyExternalId,
} from '@documenso/lib/constants/app';
import { DATE_FORMATS, DEFAULT_DOCUMENT_DATE_FORMAT } from '@documenso/lib/constants/date-formats';
import '@documenso/lib/constants/time-zones';
import { DEFAULT_DOCUMENT_TIME_ZONE, TIME_ZONES } from '@documenso/lib/constants/time-zones';
import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { createDocumentData } from '@documenso/lib/server-only/document-data/create-document-data';
import { deleteDocument } from '@documenso/lib/server-only/document/delete-document';
import { findDocuments } from '@documenso/lib/server-only/document/find-documents';
import { resendDocument } from '@documenso/lib/server-only/document/resend-document';
import { sendDocument } from '@documenso/lib/server-only/document/send-document';
import { withDocumentDraftMutationGuard } from '@documenso/lib/server-only/document/with-document-draft-mutation-guard';
import { createEnvelope } from '@documenso/lib/server-only/envelope/create-envelope';
import { getEnvelopeById } from '@documenso/lib/server-only/envelope/get-envelope-by-id';
import { assertCorrelatedDocumentFieldCreationAllowed } from '@documenso/lib/server-only/field/assert-correlated-document-field-creation';
import { deleteDocumentField } from '@documenso/lib/server-only/field/delete-document-field';
import { updateEnvelopeFields } from '@documenso/lib/server-only/field/update-envelope-fields';
import { insertFormValuesInPdf } from '@documenso/lib/server-only/pdf/insert-form-values-in-pdf';
import { deleteEnvelopeRecipient } from '@documenso/lib/server-only/recipient/delete-envelope-recipient';
import { setDocumentRecipients } from '@documenso/lib/server-only/recipient/set-document-recipients';
import { updateEnvelopeRecipients } from '@documenso/lib/server-only/recipient/update-envelope-recipients';
import { createDocumentFromTemplate } from '@documenso/lib/server-only/template/create-document-from-template';
import { deleteTemplate } from '@documenso/lib/server-only/template/delete-template';
import { findTemplates } from '@documenso/lib/server-only/template/find-templates';
import { getTemplateById } from '@documenso/lib/server-only/template/get-template-by-id';
import { ZRecipientAuthOptionsSchema } from '@documenso/lib/types/document-auth';
import { extractDerivedDocumentEmailSettings } from '@documenso/lib/types/document-email';
import {
  MAX_BIZBUDDY_ENVELOPE_RECIPIENTS,
  ZExecutionRecipientIdentitySchema,
} from '@documenso/lib/types/document-execution-profile';
import {
  ZCheckboxFieldMeta,
  ZDropdownFieldMeta,
  ZFieldMetaSchema,
  ZNumberFieldMeta,
  ZRadioFieldMeta,
  ZTextFieldMeta,
} from '@documenso/lib/types/field-meta';
import { ZRejectionReasonSchema } from '@documenso/lib/types/rejection-reason';
import { getFileServerSide } from '@documenso/lib/universal/upload/get-file.server';
import { putNormalizedPdfFileServerSide } from '@documenso/lib/universal/upload/put-file.server';
import {
  getPresignGetUrl,
  getPresignPostUrl,
} from '@documenso/lib/universal/upload/server-actions';
import { isDocumentCompleted } from '@documenso/lib/utils/document';
import { createDocumentAuditLogData } from '@documenso/lib/utils/document-audit-logs';
import {
  mapSecondaryIdToDocumentId,
  mapSecondaryIdToTemplateId,
} from '@documenso/lib/utils/envelope';
import { prisma } from '@documenso/prisma';

// P5 patch: admin REST handlers (org + user CRUD).
// See parallelfive/documenso P5_PATCHES.md § Patch 1.
import {
  handleAdminAddOrganisationMember,
  handleAdminCreateOrganisation,
  handleAdminCreateUser,
  handleAdminDeleteOrganisation,
  handleAdminGetOrganisation,
  handleAdminGetUser,
  handleAdminListOrganisations,
  handleAdminListUsers,
  handleAdminRemoveOrganisationMember,
  handleAdminUpdateOrganisation,
  handleAdminUpdateUser,
} from './admin/implementation';
import { ApiContractV1 } from './contract';
import { buildCreateDocumentMeta } from './create-document-meta';
import { mapApiV1DeleteDocumentError } from './delete-document-error';
import { downloadSignedDocumentData } from './download-document-data';
import {
  getExactApiEnvelopeField,
  getExactApiEnvelopeRecipient,
  hasExactApiEnvelopeRecipients,
} from './exact-envelope-child';
import { lookupExactTeamApiDocument, lookupExactTeamApiTemplate } from './exact-team-envelope';
import { getExactTeamApiDocument } from './get-document';
import { adminAuthenticatedMiddleware } from './middleware/admin-authenticated';
import { authenticatedMiddleware } from './middleware/authenticated';

export const ApiContractV1Implementation = tsr.router(ApiContractV1, {
  // ---------- P5 fork extension — admin REST surface ----------
  // Each handler is wrapped inline (rather than spread from a separate
  // const) so ts-rest's contract-driven type inference flows through to
  // the middleware's generic T (otherwise T solves to the bare constraint
  // and args.body/query/params type-error). See P5_PATCHES.md § Patch 1.
  adminCreateOrganisation: adminAuthenticatedMiddleware(async (args) =>
    handleAdminCreateOrganisation(args.body),
  ),
  adminListOrganisations: adminAuthenticatedMiddleware(async (args) =>
    handleAdminListOrganisations(args.query),
  ),
  adminGetOrganisation: adminAuthenticatedMiddleware(async (args) =>
    handleAdminGetOrganisation(args.params.organisationId),
  ),
  adminUpdateOrganisation: adminAuthenticatedMiddleware(async (args) =>
    handleAdminUpdateOrganisation(args.params.organisationId, args.body),
  ),
  adminDeleteOrganisation: adminAuthenticatedMiddleware(async (args) =>
    handleAdminDeleteOrganisation(args.params.organisationId),
  ),
  adminAddOrganisationMember: adminAuthenticatedMiddleware(async (args) =>
    handleAdminAddOrganisationMember(args.params.organisationId, args.body),
  ),
  adminRemoveOrganisationMember: adminAuthenticatedMiddleware(async (args) =>
    handleAdminRemoveOrganisationMember(args.params.organisationId, args.params.userId),
  ),
  adminCreateUser: adminAuthenticatedMiddleware(async (args) => handleAdminCreateUser(args.body)),
  adminListUsers: adminAuthenticatedMiddleware(async (args) => handleAdminListUsers(args.query)),
  adminGetUser: adminAuthenticatedMiddleware(async (args) =>
    handleAdminGetUser(args.params.userId),
  ),
  adminUpdateUser: adminAuthenticatedMiddleware(async (args) =>
    handleAdminUpdateUser(args.params.userId, args.body),
  ),

  getDocuments: authenticatedMiddleware(async (args, user, team) => {
    const page = Number(args.query.page) || 1;
    const perPage = Number(args.query.perPage) || 10;

    const { data: documents, totalPages } = await findDocuments({
      page,
      perPage,
      userId: user.id,
      teamId: team.id,
      folderId: args.query.folderId,
      exactTeamOnly: true,
      useWindowedCount: false,
    });

    return {
      status: 200,
      body: {
        teamId: team.id,
        documents: documents.map((document) => ({
          id: mapSecondaryIdToDocumentId(document.secondaryId),
          externalId: document.externalId,
          userId: document.userId,
          teamId: team.id,
          folderId: document.folderId,
          title: document.title,
          status: document.status,
          createdAt: document.createdAt,
          updatedAt: document.updatedAt,
          completedAt: document.completedAt,
        })),
        totalPages,
      },
    };
  }),

  getDocument: authenticatedMiddleware(async (args, user, team, { logger }) => {
    const { id: documentId } = args.params;

    logger.info({
      input: {
        id: documentId,
      },
    });

    const parsedDocumentId = Number(documentId);
    if (!Number.isSafeInteger(parsedDocumentId) || parsedDocumentId <= 0) {
      return {
        status: 404,
        body: { message: 'Document not found' },
      };
    }

    const lookup = await getExactTeamApiDocument({
      documentId: parsedDocumentId,
      userId: user.id,
      teamId: team.id,
    });
    if (lookup.status !== 200) return lookup;

    try {
      const envelope = lookup.envelope;

      const { fields, recipients } = envelope;

      const parsedMetaFields = fields.map((field) => {
        let parsedMetaOrNull = null;

        if (field.fieldMeta) {
          const result = ZFieldMetaSchema.safeParse(field.fieldMeta);

          if (!result.success) {
            throw new Error('Field meta parsing failed for field ' + field.id);
          }

          parsedMetaOrNull = result.data;
        }

        return {
          ...field,
          fieldMeta: parsedMetaOrNull,
        };
      });

      const legacyDocumentId = mapSecondaryIdToDocumentId(envelope.secondaryId);

      return {
        status: 200,
        body: {
          id: legacyDocumentId,
          externalId: envelope.externalId,
          userId: envelope.userId,
          teamId: team.id,
          folderId: envelope.folderId,
          title: envelope.title,
          status: envelope.status,
          signingOrder: envelope.documentMeta.signingOrder,
          createdAt: envelope.createdAt,
          updatedAt: envelope.updatedAt,
          completedAt: envelope.completedAt,
          recipients: recipients.map((recipient) => ({
            id: recipient.id,
            documentId: legacyDocumentId,
            email: recipient.email,
            name: recipient.name,
            role: recipient.role,
            signingOrder: recipient.signingOrder,
            token: recipient.token,
            signedAt: recipient.signedAt,
            rejectionReason: ZRejectionReasonSchema.nullable().parse(recipient.rejectionReason),
            readStatus: recipient.readStatus,
            signingStatus: recipient.signingStatus,
            sendStatus: recipient.sendStatus,
            signingUrl: `${NEXT_PUBLIC_WEBAPP_URL()}/sign/${recipient.token}`,
          })),
          fields: parsedMetaFields,
        },
      };
    } catch {
      return {
        status: 500,
        body: {
          message: 'Error retrieving the document. Please try again.',
        },
      };
    }
  }),

  downloadSignedDocument: authenticatedMiddleware(async (args, user, team, { logger }) => {
    const { id: documentId } = args.params;
    const { downloadOriginalDocument } = args.query;

    logger.info({
      input: {
        id: documentId,
      },
    });

    try {
      const envelopeLookup = await lookupExactTeamApiDocument(Number(documentId), user.id, team.id);
      if (envelopeLookup.status !== 200) return envelopeLookup;
      const guardedEnvelope = envelopeLookup.envelope;

      const envelope = await prisma.envelope.findFirst({
        where: {
          id: guardedEnvelope.id,
          teamId: team.id,
          type: EnvelopeType.DOCUMENT,
        },
        select: {
          status: true,
          envelopeItems: {
            select: {
              documentData: {
                select: {
                  type: true,
                  data: true,
                  initialData: true,
                },
              },
            },
          },
        },
      });

      const firstDocumentData = envelope?.envelopeItems[0]?.documentData;

      if (!envelope || !firstDocumentData) {
        return {
          status: 404,
          body: {
            message: 'Document not found',
          },
        };
      }

      // This error is done AFTER the get envelope so we can test access controls without S3.
      if (process.env.NEXT_PUBLIC_UPLOAD_TRANSPORT !== 's3') {
        return {
          status: 500,
          body: {
            message: 'Document downloads are only available when S3 storage is configured.',
          },
        };
      }

      if (DocumentDataType.S3_PATH !== firstDocumentData.type) {
        return {
          status: 400,
          body: {
            message: 'Invalid document data type',
          },
        };
      }

      if (!downloadOriginalDocument && !isDocumentCompleted(envelope.status)) {
        return {
          status: 400,
          body: {
            message: 'Document is not completed yet.',
          },
        };
      }

      if (envelope.envelopeItems.length !== 1) {
        return {
          status: 400,
          body: {
            message: 'API V1 does not support items',
          },
        };
      }

      const { url } = await getPresignGetUrl(
        downloadOriginalDocument ? firstDocumentData.initialData : firstDocumentData.data,
      );

      return {
        status: 200,
        body: { downloadUrl: url },
      };
    } catch (err) {
      return {
        status: 500,
        body: {
          message: 'Error downloading the document. Please try again.',
        },
      };
    }
  }),

  downloadSignedDocumentData: authenticatedMiddleware(async (args, user, team, { logger }) => {
    const documentId = Number(args.params.id);

    logger.info({
      input: {
        id: args.params.id,
      },
    });

    if (!Number.isSafeInteger(documentId) || documentId <= 0) {
      return {
        status: 404,
        body: { message: 'Document not found' },
      };
    }

    return downloadSignedDocumentData({
      documentId,
      userId: user.id,
      teamId: team.id,
    });
  }),

  deleteDocument: authenticatedMiddleware(async (args, user, team, { logger, metadata }) => {
    const { id: documentId } = args.params;

    logger.info({
      input: {
        id: documentId,
      },
    });

    try {
      const legacyDocumentId = Number(documentId);

      const envelopeLookup = await lookupExactTeamApiDocument(legacyDocumentId, user.id, team.id);
      if (envelopeLookup.status !== 200) return envelopeLookup;
      const envelope = envelopeLookup.envelope;

      const deletedDocument = await deleteDocument({
        id: {
          type: 'envelopeId',
          id: envelope.id,
        },
        userId: user.id,
        teamId: team.id,
        requestMetadata: metadata,
        requireCancellableStatus: true,
      });

      return {
        status: 200,
        body: {
          id: legacyDocumentId,
          externalId: deletedDocument.externalId,
          userId: deletedDocument.userId,
          teamId: team.id,
          folderId: deletedDocument.folderId,
          title: deletedDocument.title,
          status: deletedDocument.status,
          createdAt: deletedDocument.createdAt,
          updatedAt: deletedDocument.updatedAt,
          completedAt: deletedDocument.completedAt,
        },
      };
    } catch (err) {
      const response = mapApiV1DeleteDocumentError(err);

      if (response.status === 500) {
        logger.error({
          event: 'api-v1-delete-document-failed',
          errorName: err instanceof Error ? err.name : 'UnknownError',
        });
      }

      return response;
    }
  }),

  createDocument: authenticatedMiddleware(async (args, user, team, { metadata }) => {
    const { body } = args;

    try {
      if (process.env.NEXT_PUBLIC_UPLOAD_TRANSPORT !== 's3') {
        return {
          status: 500,
          body: {
            message: 'Create document is not available without S3 transport.',
          },
        };
      }

      if (isBizBuddyExternalId(body.externalId)) {
        if (!isValidBizBuddyExternalId(body.externalId)) {
          return {
            status: 400,
            body: {
              message: 'Biz Buddy external IDs must use the canonical bizbuddy:<UUID> format',
            },
          };
        }

        if ((body.attachments?.length ?? 0) > 0) {
          return {
            status: 400,
            body: {
              message: 'Correlated documents do not support attachments',
            },
          };
        }

        if (
          (body.authOptions?.globalAccessAuth.length ?? 0) > 0 ||
          (body.authOptions?.globalActionAuth.length ?? 0) > 0
        ) {
          return {
            status: 400,
            body: {
              message: 'Correlated documents do not support document authentication',
            },
          };
        }

        if (body.formValues !== undefined) {
          return {
            status: 400,
            body: {
              message: 'Correlated documents do not support form values',
            },
          };
        }

        if (body.meta.allowDictateNextSigner === true) {
          return {
            status: 400,
            body: {
              message: 'Correlated documents do not allow signers to replace recipient identity',
            },
          };
        }

        if (
          body.recipients.length < 1 ||
          body.recipients.length > MAX_BIZBUDDY_ENVELOPE_RECIPIENTS
        ) {
          return {
            status: 400,
            body: {
              message: `Correlated documents require between 1 and ${MAX_BIZBUDDY_ENVELOPE_RECIPIENTS} recipients`,
            },
          };
        }

        const hasUnsupportedRecipient = body.recipients.some(
          (recipient) =>
            !ZExecutionRecipientIdentitySchema.safeParse({
              name: recipient.name,
              email: recipient.email,
            }).success ||
            recipient.role !== RecipientRole.SIGNER ||
            (recipient.signingOrder !== null &&
              recipient.signingOrder !== undefined &&
              (!Number.isSafeInteger(recipient.signingOrder) || recipient.signingOrder <= 0)),
        );

        if (hasUnsupportedRecipient) {
          return {
            status: 400,
            body: {
              message:
                'Correlated documents support signer recipients with positive signing orders only',
            },
          };
        }
      }

      const { remaining } = await getServerLimits({ userId: user.id, teamId: team.id });

      if (remaining.documents <= 0) {
        return {
          status: 400,
          body: {
            message: 'You have reached the maximum number of documents allowed for this month',
          },
        };
      }

      const dateFormat = body.meta.dateFormat
        ? DATE_FORMATS.find((format) => format.value === body.meta.dateFormat)
        : DATE_FORMATS.find((format) => format.value === DEFAULT_DOCUMENT_DATE_FORMAT);

      if (body.meta.dateFormat && !dateFormat) {
        return {
          status: 400,
          body: {
            message: 'Invalid date format. Please provide a valid date format',
          },
        };
      }

      const timezone = body.meta.timezone
        ? TIME_ZONES.find((tz) => tz === body.meta.timezone)
        : DEFAULT_DOCUMENT_TIME_ZONE;

      const isTimeZoneValid = body.meta.timezone ? TIME_ZONES.includes(String(timezone)) : true;

      if (!isTimeZoneValid) {
        return {
          status: 400,
          body: {
            message: 'Invalid timezone. Please provide a valid timezone',
          },
        };
      }

      const fileName = body.title.endsWith('.pdf') ? body.title : `${body.title}.pdf`;

      const { url, key } = await getPresignPostUrl(fileName, 'application/pdf');

      const documentData = await createDocumentData({
        data: key,
        type: DocumentDataType.S3_PATH,
      });

      const envelope = await createEnvelope({
        userId: user.id,
        teamId: team.id,
        internalVersion: 1,
        data: {
          title: body.title,
          type: EnvelopeType.DOCUMENT,
          externalId: body.externalId || undefined,
          formValues: body.formValues,
          folderId: body.folderId,
          envelopeItems: [
            {
              documentDataId: documentData.id,
            },
          ],
          globalAccessAuth: body.authOptions?.globalAccessAuth,
          globalActionAuth: body.authOptions?.globalActionAuth,
        },
        attachments: body.attachments,
        meta: buildCreateDocumentMeta({
          meta: body.meta,
          externalId: body.externalId,
          timezone,
          dateFormat: dateFormat?.value,
        }),
        requestMetadata: metadata,
        allowReservedBizBuddyExternalId: true,
        bypassDefaultRecipients: isBizBuddyExternalId(body.externalId),
      });

      const legacyDocumentId = mapSecondaryIdToDocumentId(envelope.secondaryId);

      const { recipients } = await setDocumentRecipients({
        userId: user.id,
        teamId: team.id,
        id: {
          type: 'documentId',
          id: legacyDocumentId,
        },
        recipients: body.recipients,
        requestMetadata: metadata,
      });

      return {
        status: 200,
        body: {
          uploadUrl: url,
          documentId: legacyDocumentId,
          teamId: team.id,
          externalId: envelope.externalId,
          recipients: recipients.map((recipient) => ({
            recipientId: recipient.id,
            name: recipient.name,
            email: recipient.email,
            token: recipient.token,
            role: recipient.role,
            signingOrder: recipient.signingOrder,
            signingUrl: `${NEXT_PUBLIC_WEBAPP_URL()}/sign/${recipient.token}`,
          })),
        },
      };
    } catch (err) {
      return {
        status: 500,
        body: {
          message: 'An error has occured while uploading the file',
        },
      };
    }
  }),

  createTemplate: authenticatedMiddleware(async (args, user, team, { metadata }) => {
    const { body } = args;
    const {
      title,
      folderId,
      externalId,
      visibility,
      globalAccessAuth,
      globalActionAuth,
      publicTitle,
      publicDescription,
      type,
      meta,
      attachments,
    } = body;

    try {
      if (process.env.NEXT_PUBLIC_UPLOAD_TRANSPORT !== 's3') {
        return {
          status: 500,
          body: {
            message: 'Create template is not available without S3 transport.',
          },
        };
      }

      const dateFormat = meta?.dateFormat
        ? DATE_FORMATS.find((format) => format.value === meta?.dateFormat)
        : DATE_FORMATS.find((format) => format.value === DEFAULT_DOCUMENT_DATE_FORMAT);

      if (meta?.dateFormat && !dateFormat) {
        return {
          status: 400,
          body: {
            message: 'Invalid date format. Please provide a valid date format',
          },
        };
      }

      const timezone = meta?.timezone
        ? TIME_ZONES.find((tz) => tz === meta?.timezone)
        : DEFAULT_DOCUMENT_TIME_ZONE;

      const isTimeZoneValid = meta?.timezone ? TIME_ZONES.includes(String(timezone)) : true;

      if (!isTimeZoneValid) {
        return {
          status: 400,
          body: {
            message: 'Invalid timezone. Please provide a valid timezone',
          },
        };
      }

      const fileName = title?.endsWith('.pdf') ? title : `${title}.pdf`;

      const { url, key } = await getPresignPostUrl(fileName, 'application/pdf');

      const templateDocumentData = await createDocumentData({
        data: key,
        type: DocumentDataType.S3_PATH,
      });

      const createdTemplate = await createEnvelope({
        userId: user.id,
        teamId: team.id,
        internalVersion: 1,
        data: {
          type: EnvelopeType.TEMPLATE,
          envelopeItems: [
            {
              documentDataId: templateDocumentData.id,
            },
          ],
          templateType: type,
          title,
          folderId,
          externalId: externalId ?? undefined,
          visibility,
          globalAccessAuth,
          globalActionAuth,
          publicTitle,
          publicDescription,
        },
        meta,
        attachments,
        requestMetadata: metadata,
      });

      const fullTemplate = await getTemplateById({
        id: {
          type: 'envelopeId',
          id: createdTemplate.id,
        },
        userId: user.id,
        teamId: team.id,
      });

      return {
        status: 200,
        body: {
          uploadUrl: url,
          template: fullTemplate,
        },
      };
    } catch (err) {
      return {
        status: 404,
        body: {
          message: 'An error has occured while creating the template',
        },
      };
    }
  }),

  deleteTemplate: authenticatedMiddleware(async (args, user, team, { logger }) => {
    const { id: templateId } = args.params;

    logger.info({
      input: {
        id: templateId,
      },
    });

    try {
      const legacyTemplateId = Number(templateId);
      const templateLookup = await lookupExactTeamApiTemplate(legacyTemplateId, user.id, team.id);
      if (templateLookup.status !== 200) return templateLookup;
      const guardedTemplate = templateLookup.envelope;

      const deletedTemplate = await deleteTemplate({
        id: {
          type: 'envelopeId',
          id: guardedTemplate.id,
        },
        userId: user.id,
        teamId: team.id,
      });

      const deletedLegacyTemplateId = mapSecondaryIdToTemplateId(deletedTemplate.secondaryId);

      return {
        status: 200,
        body: {
          id: deletedLegacyTemplateId,
          externalId: deletedTemplate.externalId,
          type: deletedTemplate.templateType,
          title: deletedTemplate.title,
          userId: deletedTemplate.userId,
          teamId: deletedTemplate.teamId,
          createdAt: deletedTemplate.createdAt,
          updatedAt: deletedTemplate.updatedAt,
        },
      };
    } catch (err) {
      return {
        status: 404,
        body: {
          message: 'Template not found',
        },
      };
    }
  }),

  getTemplate: authenticatedMiddleware(async (args, user, team, { logger }) => {
    const { id: templateId } = args.params;

    logger.info({
      input: {
        id: templateId,
      },
    });

    try {
      const templateLookup = await lookupExactTeamApiTemplate(Number(templateId), user.id, team.id);
      if (templateLookup.status !== 200) return templateLookup;
      const guardedTemplate = templateLookup.envelope;

      const template = await getTemplateById({
        id: {
          type: 'envelopeId',
          id: guardedTemplate.id,
        },
        userId: user.id,
        teamId: team.id,
      });

      return {
        status: 200,
        body: {
          ...template,
          templateMeta: template.templateMeta
            ? {
                ...template.templateMeta,
                templateId: template.id,
              }
            : null,
          Field: template.fields.map((field) => ({
            ...field,
            fieldMeta: field.fieldMeta ? ZFieldMetaSchema.parse(field.fieldMeta) : null,
          })),
          Recipient: template.recipients,
        },
      };
    } catch (err) {
      return AppError.toRestAPIError(err);
    }
  }),

  getTemplates: authenticatedMiddleware(async (args, user, team) => {
    const page = Number(args.query.page) || 1;
    const perPage = Number(args.query.perPage) || 10;

    try {
      const { data: templates, totalPages } = await findTemplates({
        page,
        perPage,
        userId: user.id,
        teamId: team.id,
      });

      return {
        status: 200,
        body: {
          templates: templates.map((template) => ({
            id: mapSecondaryIdToTemplateId(template.secondaryId),
            externalId: template.externalId,
            type: template.templateType,
            title: template.title,
            userId: template.userId,
            teamId: template.teamId,
            createdAt: template.createdAt,
            updatedAt: template.updatedAt,
            directLink: template.directLink,
            Field: template.fields.map((field) => ({
              ...field,
              templateId: mapSecondaryIdToTemplateId(template.secondaryId),
              fieldMeta: field.fieldMeta ? ZFieldMetaSchema.parse(field.fieldMeta) : null,
            })),
            Recipient: template.recipients,
          })),
          totalPages,
        },
      };
    } catch (err) {
      return AppError.toRestAPIError(err);
    }
  }),

  createDocumentFromTemplate: authenticatedMiddleware(
    async (args, user, team, { logger, metadata }) => {
      const { body, params } = args;

      logger.info({
        input: {
          templateId: params.templateId,
        },
      });

      const { remaining } = await getServerLimits({ userId: user.id, teamId: team.id });

      if (remaining.documents <= 0) {
        return {
          status: 400,
          body: {
            message: 'You have reached the maximum number of documents allowed for this month',
          },
        };
      }

      const templateId = Number(params.templateId);

      const fileName = body.title.endsWith('.pdf') ? body.title : `${body.title}.pdf`;

      const templateLookup = await lookupExactTeamApiTemplate(templateId, user.id, team.id);
      if (templateLookup.status !== 200) return templateLookup;
      const guardedTemplate = templateLookup.envelope;

      try {
        const template = await getEnvelopeById({
          id: {
            type: 'envelopeId',
            id: guardedTemplate.id,
          },
          type: EnvelopeType.TEMPLATE,
          userId: user.id,
          teamId: team.id,
        });

        if (template.envelopeItems.length !== 1) {
          throw new Error('API V1 does not support templates with multiple documents');
        }

        // V1 API request schema uses indices for recipients
        // So we remap the recipients to attach the IDs
        const mappedRecipients = body.recipients.map((recipient, index) => {
          const existingRecipient = template.recipients.at(index);

          if (!existingRecipient) {
            throw new Error('Recipient not found.');
          }

          return {
            id: existingRecipient.id,
            name: recipient.name,
            email: recipient.email,
            signingOrder: recipient.signingOrder,
            role: recipient.role, // You probably shouldn't be able to change the role.
          };
        });

        const createdEnvelope = await createDocumentFromTemplate({
          id: {
            type: 'envelopeId',
            id: guardedTemplate.id,
          },
          externalId: body.externalId || null,
          userId: user.id,
          teamId: team.id,
          recipients: mappedRecipients,
          override: {
            ...body.meta,
            title: body.title,
          },
          attachments: body.attachments,
          formValues: body.formValues,
          requestMetadata: metadata,
        });

        const envelopeItems = await prisma.envelopeItem.findMany({
          where: {
            envelopeId: createdEnvelope.id,
          },
          include: {
            documentData: true,
          },
        });

        const firstEnvelopeItemData = envelopeItems[0].documentData;

        if (!firstEnvelopeItemData) {
          throw new Error('Document data not found.');
        }

        if (body.formValues) {
          const pdf = await getFileServerSide(firstEnvelopeItemData);

          const prefilled = await insertFormValuesInPdf({
            pdf: Buffer.from(pdf),
            formValues: body.formValues,
          });

          const newDocumentData = await putNormalizedPdfFileServerSide({
            name: fileName,
            type: 'application/pdf',
            arrayBuffer: async () => Promise.resolve(prefilled),
          });

          await prisma.envelopeItem.update({
            where: {
              id: firstEnvelopeItemData.id,
            },
            data: {
              title: body.title || fileName,
              documentDataId: newDocumentData.id,
            },
          });
        }

        if (body.authOptions || body.formValues) {
          await prisma.envelope.update({
            where: {
              id: createdEnvelope.id,
            },
            data: {
              formValues: body.formValues,
              authOptions: body.authOptions,
            },
          });
        }

        return {
          status: 200,
          body: {
            documentId: mapSecondaryIdToDocumentId(createdEnvelope.secondaryId),
            recipients: createdEnvelope.recipients.map((recipient) => ({
              recipientId: recipient.id,
              name: recipient.name,
              email: recipient.email,
              token: recipient.token,
              role: recipient.role,
              signingOrder: recipient.signingOrder,

              signingUrl: `${NEXT_PUBLIC_WEBAPP_URL()}/sign/${recipient.token}`,
            })),
          },
        };
      } catch (error) {
        return AppError.toRestAPIError(error);
      }
    },
  ),

  generateDocumentFromTemplate: authenticatedMiddleware(
    async (args, user, team, { logger, metadata }) => {
      const { body, params } = args;

      logger.info({
        input: {
          templateId: params.templateId,
        },
      });

      const { remaining } = await getServerLimits({ userId: user.id, teamId: team.id });

      if (remaining.documents <= 0) {
        return {
          status: 400,
          body: {
            message: 'You have reached the maximum number of documents allowed for this month',
          },
        };
      }

      const templateId = Number(params.templateId);

      let envelope: Awaited<ReturnType<typeof createDocumentFromTemplate>> | null = null;

      try {
        const templateLookup = await lookupExactTeamApiTemplate(templateId, user.id, team.id);
        if (templateLookup.status !== 200) return templateLookup;
        const guardedTemplate = templateLookup.envelope;

        envelope = await createDocumentFromTemplate({
          id: {
            type: 'envelopeId',
            id: guardedTemplate.id,
          },
          externalId: body.externalId || null,
          userId: user.id,
          teamId: team.id,
          recipients: body.recipients,
          prefillFields: body.prefillFields,
          folderId: body.folderId,
          override: {
            title: body.title,
            ...body.meta,
          },
          formValues: body.formValues,
          requestMetadata: metadata,
        });
      } catch (err) {
        return AppError.toRestAPIError(err);
      }

      if (body.authOptions) {
        await prisma.envelope.update({
          where: {
            id: envelope.id,
          },
          data: {
            authOptions: body.authOptions,
          },
        });
      }

      const legacyDocumentId = mapSecondaryIdToDocumentId(envelope.secondaryId);

      return {
        status: 200,
        body: {
          documentId: legacyDocumentId,
          recipients: envelope.recipients.map((recipient) => ({
            recipientId: recipient.id,
            name: recipient.name,
            email: recipient.email,
            token: recipient.token,
            role: recipient.role,
            signingOrder: recipient.signingOrder,
            signingUrl: `${NEXT_PUBLIC_WEBAPP_URL()}/sign/${recipient.token}`,
          })),
        },
      };
    },
  ),

  sendDocument: authenticatedMiddleware(async (args, user, team, { logger, metadata }) => {
    const { id: documentId } = args.params;
    const { sendEmail, sendCompletionEmails, expectedExecution } = args.body;

    logger.info({
      input: {
        id: documentId,
      },
    });

    try {
      const legacyDocumentId = Number(documentId);

      const envelopeLookup = await lookupExactTeamApiDocument(legacyDocumentId, user.id, team.id);
      if (envelopeLookup.status !== 200) return envelopeLookup;
      const guardedEnvelope = envelopeLookup.envelope;

      const envelope = await prisma.envelope.findFirst({
        where: {
          id: guardedEnvelope.id,
          teamId: team.id,
          type: EnvelopeType.DOCUMENT,
        },
        select: {
          id: true,
          status: true,
          documentMeta: true,
        },
      });

      if (!envelope) {
        return {
          status: 404,
          body: {
            message: 'Document not found',
          },
        };
      }

      if (envelope.status !== DocumentStatus.DRAFT) {
        throw new AppError(AppErrorCode.CONFLICT, {
          message: 'Document is no longer a draft',
        });
      }

      const emailSettings = extractDerivedDocumentEmailSettings(envelope.documentMeta);

      const { recipients, ...sentDocument } = await sendDocument({
        id: {
          type: 'envelopeId',
          id: envelope.id,
        },
        userId: user.id,
        teamId: team.id,
        sendEmail,
        expectedExecution,
        documentEmailSettings:
          typeof sendCompletionEmails === 'boolean'
            ? {
                ...emailSettings,
                documentCompleted: sendCompletionEmails,
                ownerDocumentCompleted: sendCompletionEmails,
              }
            : undefined,
        requireDraftStatus: true,
        requestMetadata: metadata,
      });

      return {
        status: 200,
        body: {
          message: 'Document sent for signing successfully',
          id: mapSecondaryIdToDocumentId(sentDocument.secondaryId),
          externalId: sentDocument.externalId,
          userId: sentDocument.userId,
          teamId: team.id,
          folderId: sentDocument.folderId,
          title: sentDocument.title,
          status: sentDocument.status,
          createdAt: sentDocument.createdAt,
          updatedAt: sentDocument.updatedAt,
          completedAt: sentDocument.completedAt,
          recipients: recipients.map((recipient) => ({
            ...recipient,
            signingUrl: `${NEXT_PUBLIC_WEBAPP_URL()}/sign/${recipient.token}`,
          })),
        },
      };
    } catch (err) {
      return AppError.toRestAPIError(err);
    }
  }),

  resendDocument: authenticatedMiddleware(async (args, user, team, { logger, metadata }) => {
    const { id: documentId } = args.params;
    const { recipients } = args.body;

    logger.info({
      input: {
        id: documentId,
      },
    });

    try {
      const envelopeLookup = await lookupExactTeamApiDocument(Number(documentId), user.id, team.id);
      if (envelopeLookup.status !== 200) return envelopeLookup;
      const guardedEnvelope = envelopeLookup.envelope;

      const recipientsBelongToEnvelope = await hasExactApiEnvelopeRecipients(
        guardedEnvelope.id,
        recipients,
      );
      if (!recipientsBelongToEnvelope) {
        return {
          status: 404,
          body: {
            message: 'Recipient not found',
          },
        };
      }

      await resendDocument({
        userId: user.id,
        id: {
          type: 'envelopeId',
          id: guardedEnvelope.id,
        },
        recipients,
        teamId: team.id,
        requestMetadata: metadata,
        requireCurrentSigningOrder: true,
      });

      return {
        status: 200,
        body: {
          message: 'Document resend successfully initiated',
        },
      };
    } catch (err) {
      if (err instanceof AppError && err.code === AppErrorCode.CONFLICT) {
        return AppError.toRestAPIError(err);
      }

      return {
        status: 500,
        body: {
          message: 'An error has occured while resending the document',
        },
      };
    }
  }),

  createRecipient: authenticatedMiddleware(async (args, user, team, { logger, metadata }) => {
    const { id: documentId } = args.params;
    const { name, email, role, authOptions, signingOrder } = args.body;

    logger.info({
      input: {
        id: documentId,
      },
    });

    const legacyDocumentId = Number(documentId);

    const envelopeLookup = await lookupExactTeamApiDocument(legacyDocumentId, user.id, team.id);
    if (envelopeLookup.status !== 200) return envelopeLookup;
    const guardedEnvelope = envelopeLookup.envelope;

    try {
      const envelope = await prisma.envelope.findFirst({
        where: {
          id: guardedEnvelope.id,
          teamId: team.id,
          type: EnvelopeType.DOCUMENT,
        },
        select: {
          id: true,
          status: true,
          recipients: {
            select: {
              email: true,
              name: true,
              role: true,
              signingOrder: true,
              authOptions: true,
            },
          },
        },
      });

      if (!envelope) {
        return {
          status: 404,
          body: {
            message: 'Document not found',
          },
        };
      }

      if (envelope.status !== DocumentStatus.DRAFT) {
        throw new AppError(AppErrorCode.CONFLICT, {
          message: 'Document is no longer a draft',
        });
      }

      const { recipients } = envelope;

      const recipientAlreadyExists = recipients.some((recipient) => recipient.email === email);

      if (recipientAlreadyExists) {
        return {
          status: 400,
          body: {
            message: 'Recipient already exists',
          },
        };
      }

      const { recipients: newRecipients } = await setDocumentRecipients({
        id: {
          type: 'envelopeId',
          id: envelope.id,
        },
        userId: user.id,
        teamId: team.id,
        recipients: [
          ...recipients.map((recipient) => ({
            email: recipient.email,
            name: recipient.name,
            role: recipient.role,
            signingOrder: recipient.signingOrder,
            actionAuth: ZRecipientAuthOptionsSchema.parse(recipient.authOptions)?.actionAuth ?? [],
          })),
          {
            email,
            name,
            role,
            signingOrder,
            actionAuth: authOptions?.actionAuth ?? [],
          },
        ],
        requestMetadata: metadata,
        requireDraftStatus: true,
      });

      const newRecipient = newRecipients.find((recipient) => recipient.email === email);

      if (!newRecipient) {
        throw new Error('Recipient not found');
      }

      return {
        status: 200,
        body: {
          ...newRecipient,
          documentId: Number(documentId),
          signingUrl: `${NEXT_PUBLIC_WEBAPP_URL()}/sign/${newRecipient.token}`,
        },
      };
    } catch (err) {
      if (err instanceof AppError) {
        return AppError.toRestAPIError(err);
      }

      return {
        status: 500,
        body: {
          message: 'An error has occured while creating the recipient',
        },
      };
    }
  }),

  updateRecipient: authenticatedMiddleware(async (args, user, team, { logger, metadata }) => {
    const { id: documentId, recipientId } = args.params;
    const { name, email, role, authOptions, signingOrder } = args.body;

    logger.info({
      input: {
        id: documentId,
        recipientId,
      },
    });

    const legacyDocumentId = Number(documentId);

    const envelopeLookup = await lookupExactTeamApiDocument(legacyDocumentId, user.id, team.id);
    if (envelopeLookup.status !== 200) return envelopeLookup;
    const guardedEnvelope = envelopeLookup.envelope;

    try {
      const envelope = await prisma.envelope.findFirst({
        where: {
          id: guardedEnvelope.id,
          teamId: team.id,
          type: EnvelopeType.DOCUMENT,
        },
        select: {
          id: true,
          status: true,
        },
      });

      if (!envelope) {
        return {
          status: 404,
          body: {
            message: 'Document not found',
          },
        };
      }

      if (envelope.status !== DocumentStatus.DRAFT) {
        throw new AppError(AppErrorCode.CONFLICT, {
          message: 'Document is no longer a draft',
        });
      }

      const recipient = await getExactApiEnvelopeRecipient(envelope.id, Number(recipientId));
      if (!recipient) {
        return {
          status: 404,
          body: {
            message: 'Recipient not found',
          },
        };
      }

      const updatedRecipient = await updateEnvelopeRecipients({
        userId: user.id,
        teamId: team.id,
        id: {
          type: 'envelopeId',
          id: envelope.id,
        },
        recipients: [
          {
            id: Number(recipientId),
            email,
            name,
            role,
            signingOrder,
            actionAuth: authOptions?.actionAuth ?? [],
          },
        ],
        requestMetadata: metadata,
        requireDraftStatus: true,
      })
        .then(({ recipients }) => recipients[0])
        .catch(null);

      if (!updatedRecipient) {
        return {
          status: 404,
          body: {
            message: 'Recipient not found',
          },
        };
      }

      return {
        status: 200,
        body: {
          ...updatedRecipient,
          documentId: Number(documentId),
          signingUrl: `${NEXT_PUBLIC_WEBAPP_URL()}/sign/${updatedRecipient.token}`,
        },
      };
    } catch (error) {
      return AppError.toRestAPIError(error);
    }
  }),

  deleteRecipient: authenticatedMiddleware(async (args, user, team, { logger, metadata }) => {
    const { id: documentId, recipientId } = args.params;

    logger.info({
      input: {
        id: documentId,
        recipientId,
      },
    });

    const envelopeLookup = await lookupExactTeamApiDocument(Number(documentId), user.id, team.id);
    if (envelopeLookup.status !== 200) return envelopeLookup;
    const guardedEnvelope = envelopeLookup.envelope;

    try {
      const recipient = await getExactApiEnvelopeRecipient(guardedEnvelope.id, Number(recipientId));
      if (!recipient) {
        return {
          status: 404,
          body: {
            message: 'Recipient not found',
          },
        };
      }

      const deletedRecipient = await deleteEnvelopeRecipient({
        userId: user.id,
        teamId: team.id,
        recipientId: Number(recipientId),
        envelopeId: guardedEnvelope.id,
        requestMetadata: {
          requestMetadata: metadata.requestMetadata,
          source: 'apiV1',
          auth: 'api',
          auditUser: {
            id: team.id,
            email: team.name,
            name: team.name,
          },
        },
        requireDraftStatus: true,
      });

      return {
        status: 200,
        body: {
          ...deletedRecipient,
          documentId: Number(documentId),
          signingUrl: '',
        },
      };
    } catch (error) {
      return AppError.toRestAPIError(error);
    }
  }),

  createField: authenticatedMiddleware(async (args, user, team, { logger, metadata }) => {
    const { id: documentId } = args.params;

    logger.info({
      input: {
        id: documentId,
      },
    });

    const fields = Array.isArray(args.body) ? args.body : [args.body];

    const envelopeLookup = await lookupExactTeamApiDocument(Number(documentId), user.id, team.id);
    if (envelopeLookup.status !== 200) return envelopeLookup;
    const guardedEnvelope = envelopeLookup.envelope;

    try {
      const envelope = await prisma.envelope.findFirst({
        where: {
          id: guardedEnvelope.id,
          teamId: team.id,
          type: EnvelopeType.DOCUMENT,
        },
        select: {
          id: true,
          secondaryId: true,
          status: true,
          externalId: true,
          envelopeItems: {
            select: { id: true },
          },
        },
      });

      if (!envelope) {
        return {
          status: 404,
          body: { message: 'Document not found' },
        };
      }

      const firstEnvelopeItemId = envelope.envelopeItems[0].id;

      if (!firstEnvelopeItemId) {
        throw new Error('Missing envelope item ID');
      }

      if (envelope.envelopeItems.length !== 1) {
        throw new Error('API V1 does not support multiple documents');
      }

      if (envelope.status !== DocumentStatus.DRAFT) {
        throw new AppError(AppErrorCode.CONFLICT, {
          message: 'Document is no longer a draft',
        });
      }

      assertCorrelatedDocumentFieldCreationAllowed({
        externalId: envelope.externalId,
        fields,
      });

      const createdFields = await prisma.$transaction(async (tx) => {
        return withDocumentDraftMutationGuard(
          {
            tx,
            envelopeId: envelope.id,
            teamId: team.id,
            ...(isBizBuddyExternalId(envelope.externalId)
              ? { expectedExternalId: envelope.externalId }
              : {}),
          },
          async () => {
            if (isBizBuddyExternalId(envelope.externalId)) {
              const existingFieldCount = await tx.field.count({
                where: {
                  envelopeId: envelope.id,
                },
              });

              assertCorrelatedDocumentFieldCreationAllowed({
                externalId: envelope.externalId,
                fields,
                existingFieldCount,
              });
            }

            return Promise.all(
              fields.map(async (fieldData) => {
                const {
                  recipientId,
                  type,
                  pageNumber,
                  pageWidth,
                  pageHeight,
                  pageX,
                  pageY,
                  fieldMeta,
                } = fieldData;

                if (pageNumber <= 0) {
                  throw new Error('Invalid page number');
                }

                const recipient = await tx.recipient.findFirst({
                  where: {
                    id: Number(recipientId),
                    envelopeId: envelope.id,
                  },
                });

                if (!recipient) {
                  throw new Error('Recipient not found');
                }

                if (recipient.signingStatus === SigningStatus.SIGNED) {
                  throw new Error('Recipient has already signed the document');
                }

                const advancedField = ['NUMBER', 'RADIO', 'CHECKBOX', 'DROPDOWN', 'TEXT'].includes(
                  type,
                );

                if (advancedField && !fieldMeta) {
                  throw new Error(
                    'Field meta is required for this type of field. Please provide the appropriate field meta object.',
                  );
                }

                if (fieldMeta && fieldMeta.type.toLowerCase() !== String(type).toLowerCase()) {
                  throw new Error('Field meta type does not match the field type');
                }

                const result = match(type)
                  .with('RADIO', () => ZRadioFieldMeta.safeParse(fieldMeta))
                  .with('CHECKBOX', () => ZCheckboxFieldMeta.safeParse(fieldMeta))
                  .with('DROPDOWN', () => ZDropdownFieldMeta.safeParse(fieldMeta))
                  .with('NUMBER', () => ZNumberFieldMeta.safeParse(fieldMeta))
                  .with('TEXT', () => ZTextFieldMeta.safeParse(fieldMeta))
                  .with('SIGNATURE', 'INITIALS', 'DATE', 'EMAIL', 'NAME', () => ({
                    success: true,
                    data: undefined,
                  }))
                  .with('FREE_SIGNATURE', () => ({
                    success: false,
                    error: 'FREE_SIGNATURE is not supported',
                    data: undefined,
                  }))
                  .exhaustive();

                if (!result.success) {
                  throw new Error('Field meta parsing failed');
                }

                const field = await tx.field.create({
                  data: {
                    envelopeId: envelope.id,
                    envelopeItemId: firstEnvelopeItemId,
                    recipientId: Number(recipientId),
                    type,
                    page: pageNumber,
                    positionX: pageX,
                    positionY: pageY,
                    width: pageWidth,
                    height: pageHeight,
                    customText: '',
                    inserted: false,
                    fieldMeta: result.data,
                  },
                  include: {
                    recipient: true,
                  },
                });

                await tx.documentAuditLog.create({
                  data: createDocumentAuditLogData({
                    type: 'FIELD_CREATED',
                    envelopeId: envelope.id,
                    user: {
                      id: team.id ?? user.id,
                      email: team?.name ?? user.email,
                      name: team ? '' : user.name,
                    },
                    data: {
                      fieldId: field.secondaryId,
                      fieldRecipientEmail: field.recipient?.email ?? '',
                      fieldRecipientId: recipientId,
                      fieldType: field.type,
                    },
                    requestMetadata: metadata.requestMetadata,
                  }),
                });

                return {
                  id: field.id,
                  documentId: mapSecondaryIdToDocumentId(envelope.secondaryId),
                  recipientId: field.recipientId ?? -1,
                  type: field.type,
                  pageNumber: field.page,
                  pageX: Number(field.positionX),
                  pageY: Number(field.positionY),
                  pageWidth: Number(field.width),
                  pageHeight: Number(field.height),
                  customText: field.customText,
                  fieldMeta: field.fieldMeta ? ZFieldMetaSchema.parse(field.fieldMeta) : undefined,
                  inserted: field.inserted,
                };
              }),
            );
          },
        );
      });

      return {
        status: 200,
        body: {
          fields: createdFields,
          documentId: Number(documentId),
        },
      };
    } catch (err) {
      return AppError.toRestAPIError(err);
    }
  }),

  updateField: authenticatedMiddleware(async (args, user, team, { logger, metadata }) => {
    const { id: documentId, fieldId } = args.params;
    const { recipientId, type, pageNumber, pageWidth, pageHeight, pageX, pageY, fieldMeta } =
      args.body;

    logger.info({
      input: {
        id: documentId,
        fieldId,
      },
    });

    const envelopeLookup = await lookupExactTeamApiDocument(Number(documentId), user.id, team.id);
    if (envelopeLookup.status !== 200) return envelopeLookup;
    const guardedEnvelope = envelopeLookup.envelope;

    try {
      const envelope = await prisma.envelope.findFirst({
        where: {
          id: guardedEnvelope.id,
          teamId: team.id,
          type: EnvelopeType.DOCUMENT,
        },
        select: {
          id: true,
          secondaryId: true,
          status: true,
          envelopeItems: {
            select: {
              id: true,
            },
          },
        },
      });

      if (!envelope) {
        return {
          status: 404,
          body: {
            message: 'Document not found',
          },
        };
      }

      const legacyDocumentId = mapSecondaryIdToDocumentId(envelope.secondaryId);

      const firstEnvelopeItemId = envelope.envelopeItems[0].id;

      if (!firstEnvelopeItemId) {
        throw new Error('Missing document data');
      }

      if (envelope.envelopeItems.length > 1) {
        throw new Error('API V1 does not support multiple documents');
      }

      if (envelope.status !== DocumentStatus.DRAFT) {
        throw new AppError(AppErrorCode.CONFLICT, {
          message: 'Document is no longer a draft',
        });
      }

      const field = await getExactApiEnvelopeField(envelope.id, Number(fieldId));
      if (!field) {
        return {
          status: 404,
          body: {
            message: 'Field not found',
          },
        };
      }

      const recipient = await prisma.recipient.findFirst({
        where: {
          id: Number(recipientId),
          envelopeId: envelope.id,
        },
      });

      if (!recipient) {
        return {
          status: 404,
          body: {
            message: 'Recipient not found',
          },
        };
      }

      if (recipient.signingStatus === SigningStatus.SIGNED) {
        return {
          status: 400,
          body: {
            message: 'Recipient has already signed the document',
          },
        };
      }

      const { fields } = await updateEnvelopeFields({
        userId: user.id,
        teamId: team.id,
        id: {
          type: 'envelopeId',
          id: envelope.id,
        },
        fields: [
          {
            id: Number(fieldId),
            type,
            pageNumber,
            pageX,
            pageY,
            width: pageWidth,
            height: pageHeight,
            fieldMeta: fieldMeta ? ZFieldMetaSchema.parse(fieldMeta) : undefined,
          },
        ],
        requestMetadata: {
          requestMetadata: metadata.requestMetadata,
          source: 'apiV1',
          auth: 'api',
          auditUser: {
            id: team.id,
            email: team.name,
            name: team.name,
          },
        },
        requireDraftStatus: true,
      });

      const updatedField = fields[0];

      return {
        status: 200,
        body: {
          id: updatedField.id,
          documentId: legacyDocumentId,
          recipientId: updatedField.recipientId ?? -1,
          type: updatedField.type,
          pageNumber: updatedField.page,
          pageX: Number(updatedField.positionX),
          pageY: Number(updatedField.positionY),
          pageWidth: Number(updatedField.width),
          pageHeight: Number(updatedField.height),
          customText: updatedField.customText,
          inserted: updatedField.inserted,
        },
      };
    } catch (error) {
      return AppError.toRestAPIError(error);
    }
  }),

  deleteField: authenticatedMiddleware(async (args, user, team, { logger, metadata }) => {
    const { id: documentId, fieldId } = args.params;

    logger.info({
      input: {
        id: documentId,
        fieldId,
      },
    });

    const envelopeLookup = await lookupExactTeamApiDocument(Number(documentId), user.id, team.id);
    if (envelopeLookup.status !== 200) return envelopeLookup;
    const guardedEnvelope = envelopeLookup.envelope;

    try {
      const field = await getExactApiEnvelopeField(guardedEnvelope.id, Number(fieldId));
      if (!field) {
        return {
          status: 404,
          body: {
            message: 'Field not found',
          },
        };
      }

      const deletedField = await deleteDocumentField({
        fieldId: Number(fieldId),
        userId: user.id,
        teamId: team.id,
        envelopeId: guardedEnvelope.id,
        requestMetadata: {
          requestMetadata: metadata.requestMetadata,
          source: 'apiV1',
          auth: 'api',
          auditUser: {
            id: team.id,
            email: team.name,
            name: team.name,
          },
        },
        requireDraftStatus: true,
      });

      const remappedField = {
        id: deletedField.id,
        documentId: Number(documentId),
        recipientId: deletedField.recipientId ?? -1,
        type: deletedField.type,
        pageNumber: deletedField.page,
        pageX: Number(deletedField.positionX),
        pageY: Number(deletedField.positionY),
        pageWidth: Number(deletedField.width),
        pageHeight: Number(deletedField.height),
        customText: deletedField.customText,
        inserted: deletedField.inserted,
      };

      return {
        status: 200,
        body: remappedField,
      };
    } catch (error) {
      return AppError.toRestAPIError(error);
    }
  }),
});
