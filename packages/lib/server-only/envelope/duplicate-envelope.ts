import {
  DocumentDataType,
  DocumentSource,
  EnvelopeType,
  WebhookTriggerEvents,
} from '@prisma/client';
import pMap from 'p-map';
import { omit } from 'remeda';

import { prisma } from '@documenso/prisma';

import { AppError, AppErrorCode } from '../../errors/app-error';
import { mapEnvelopeToWebhookDocumentPayload } from '../../types/webhook-payload';
import { nanoid, prefixedId } from '../../universal/id';
import type { EnvelopeIdOptions } from '../../utils/envelope';
import {
  DOCUMENT_DATA_STORAGE_TRANSACTION_TIMEOUT_MS,
  lockDocumentDataStorageKeys,
} from '../document-data/stage-document-data-storage-cleanup';
import { getEnvelopeWhereInput } from '../envelope/get-envelope-by-id';
import { incrementDocumentId, incrementTemplateId } from '../envelope/increment-id';
import { triggerWebhook } from '../webhooks/trigger/trigger-webhook';

export interface DuplicateEnvelopeOptions {
  id: EnvelopeIdOptions;
  userId: number;
  teamId: number;
  overrides?: {
    duplicateAsTemplate?: boolean;
    includeRecipients?: boolean;
    includeFields?: boolean;
  };
}

export const duplicateEnvelope = async ({
  id,
  userId,
  teamId,
  overrides,
}: DuplicateEnvelopeOptions) => {
  const {
    duplicateAsTemplate = false,
    includeRecipients = true,
    includeFields = true,
  } = overrides ?? {};

  const { envelopeWhereInput } = await getEnvelopeWhereInput({
    id,
    type: null,
    userId,
    teamId,
  });

  const envelope = await prisma.envelope.findFirst({
    where: envelopeWhereInput,
    select: {
      type: true,
      title: true,
      userId: true,
      internalVersion: true,
      templateType: true,
      publicTitle: true,
      publicDescription: true,
      envelopeItems: {
        include: {
          documentData: {
            select: {
              id: true,
              data: true,
              initialData: true,
              type: true,
            },
          },
        },
      },
      authOptions: true,
      visibility: true,
      documentMeta: true,
      recipients: {
        select: {
          email: true,
          name: true,
          role: true,
          signingOrder: true,
          fields: true,
        },
      },
      teamId: true,
    },
  });

  if (!envelope) {
    throw new AppError(AppErrorCode.NOT_FOUND, {
      message: 'Document not found',
    });
  }

  if (duplicateAsTemplate && envelope.type !== EnvelopeType.DOCUMENT) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'Only documents can be saved as templates',
    });
  }

  const targetType = duplicateAsTemplate ? EnvelopeType.TEMPLATE : envelope.type;

  const { legacyNumberId, secondaryId } = await (targetType === EnvelopeType.DOCUMENT
    ? incrementDocumentId().then(({ documentId, formattedDocumentId }) => ({
        legacyNumberId: documentId,
        secondaryId: formattedDocumentId,
      }))
    : incrementTemplateId().then(({ templateId, formattedTemplateId }) => ({
        legacyNumberId: templateId,
        secondaryId: formattedTemplateId,
      })));

  const duplicatedTemplateType =
    envelope.templateType === 'ORGANISATION' && envelope.teamId !== teamId
      ? 'PRIVATE'
      : (envelope.templateType ?? undefined);

  // Key = original envelope item ID
  // Value = duplicated envelope item ID.
  const oldEnvelopeItemToNewEnvelopeItemIdMap: Record<string, string> = {};

  // Source-key locks and exact source-row locks are acquired before the target
  // exists. If cancellation won, this transaction leaves no partial copy. If
  // duplication won, cancellation sees the new reference before staging.
  const duplicatedEnvelope = await prisma.$transaction(
    async (tx) => {
      await lockDocumentDataStorageKeys({
        tx,
        keys: envelope.envelopeItems.flatMap(({ documentData }) =>
          documentData.type === DocumentDataType.S3_PATH
            ? [documentData.data, documentData.initialData]
            : [],
        ),
      });

      for (const documentDataId of [
        ...new Set(envelope.envelopeItems.map(({ documentData }) => documentData.id)),
      ].sort()) {
        const lockedSource = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id"
          FROM "DocumentData"
          WHERE "id" = ${documentDataId}
          FOR KEY SHARE
        `;

        if (lockedSource.length !== 1) {
          throw new AppError(AppErrorCode.CONFLICT, {
            message: 'Source document changed before it could be duplicated',
          });
        }
      }

      const currentSourceDocumentData = await tx.documentData.findMany({
        where: {
          id: {
            in: envelope.envelopeItems.map(({ documentData }) => documentData.id),
          },
        },
        select: {
          id: true,
          type: true,
          data: true,
          initialData: true,
        },
      });
      const currentSourceDocumentDataById = new Map(
        currentSourceDocumentData.map((documentData) => [documentData.id, documentData]),
      );

      for (const { documentData } of envelope.envelopeItems) {
        const current = currentSourceDocumentDataById.get(documentData.id);

        if (
          !current ||
          current.type !== documentData.type ||
          current.data !== documentData.data ||
          current.initialData !== documentData.initialData
        ) {
          throw new AppError(AppErrorCode.CONFLICT, {
            message: 'Source document changed before it could be duplicated',
          });
        }
      }

      const createdDocumentMeta = await tx.documentMeta.create({
        data: {
          ...omit(envelope.documentMeta, ['id']),
          emailSettings: envelope.documentMeta.emailSettings || undefined,
        },
      });

      const targetEnvelope = await tx.envelope.create({
        data: {
          id: prefixedId('envelope'),
          secondaryId,
          type: targetType,
          internalVersion: envelope.internalVersion,
          userId,
          teamId,
          title: envelope.title + ' (copy)',
          documentMetaId: createdDocumentMeta.id,
          authOptions: envelope.authOptions || undefined,
          visibility: envelope.visibility,
          templateType: duplicatedTemplateType,
          publicTitle: envelope.publicTitle ?? undefined,
          publicDescription: envelope.publicDescription ?? undefined,
          source:
            targetType === EnvelopeType.DOCUMENT
              ? DocumentSource.DOCUMENT
              : DocumentSource.TEMPLATE,
        },
        include: {
          recipients: true,
          documentMeta: true,
        },
      });

      for (const envelopeItem of envelope.envelopeItems) {
        const duplicatedDocumentData = await tx.documentData.create({
          data: {
            type: envelopeItem.documentData.type,
            data: envelopeItem.documentData.initialData,
            initialData: envelopeItem.documentData.initialData,
          },
        });

        const duplicatedEnvelopeItem = await tx.envelopeItem.create({
          data: {
            id: prefixedId('envelope_item'),
            title: envelopeItem.title,
            order: envelopeItem.order,
            envelopeId: targetEnvelope.id,
            documentDataId: duplicatedDocumentData.id,
          },
        });

        oldEnvelopeItemToNewEnvelopeItemIdMap[envelopeItem.id] = duplicatedEnvelopeItem.id;
      }

      return targetEnvelope;
    },
    {
      timeout: DOCUMENT_DATA_STORAGE_TRANSACTION_TIMEOUT_MS,
    },
  );

  if (includeRecipients) {
    await pMap(
      envelope.recipients,
      async (recipient) =>
        prisma.recipient.create({
          data: {
            envelopeId: duplicatedEnvelope.id,
            email: recipient.email,
            name: recipient.name,
            role: recipient.role,
            signingOrder: recipient.signingOrder,
            token: nanoid(),
            fields: includeFields
              ? {
                  createMany: {
                    data: recipient.fields.map((field) => ({
                      envelopeId: duplicatedEnvelope.id,
                      envelopeItemId: oldEnvelopeItemToNewEnvelopeItemIdMap[field.envelopeItemId],
                      type: field.type,
                      page: field.page,
                      positionX: field.positionX,
                      positionY: field.positionY,
                      width: field.width,
                      height: field.height,
                      customText: '',
                      inserted: false,
                      fieldMeta: field.fieldMeta as PrismaJson.FieldMeta,
                    })),
                  },
                }
              : undefined,
          },
        }),
      { concurrency: 5 },
    );
  }

  if (duplicatedEnvelope.type === EnvelopeType.DOCUMENT) {
    const refetchedEnvelope = await prisma.envelope.findFirstOrThrow({
      where: {
        id: duplicatedEnvelope.id,
      },
      include: {
        documentMeta: true,
        recipients: true,
      },
    });

    await triggerWebhook({
      event: WebhookTriggerEvents.DOCUMENT_CREATED,
      data: () => mapEnvelopeToWebhookDocumentPayload(refetchedEnvelope),
      userId: userId,
      teamId: teamId,
    });
  }

  return {
    id: duplicatedEnvelope.id,
    envelope: duplicatedEnvelope,
    legacyId: {
      type: duplicatedEnvelope.type,
      id: legacyNumberId,
    },
  };
};
