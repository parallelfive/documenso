import { FieldType } from '@prisma/client';

import { isBizBuddyExternalId } from '../../constants/app';
import { AppError, AppErrorCode } from '../../errors/app-error';
import { MAX_DOCUMENT_EXECUTION_FIELDS } from '../../types/document-execution-profile';

type CorrelatedFieldCreationInput = {
  type: FieldType;
  fieldMeta?: unknown;
  placeholder?: unknown;
  customText?: unknown;
  inserted?: unknown;
  page?: unknown;
  pageNumber?: unknown;
  positionX?: unknown;
  positionY?: unknown;
  pageX?: unknown;
  pageY?: unknown;
  width?: unknown;
  height?: unknown;
  pageWidth?: unknown;
  pageHeight?: unknown;
};

/**
 * Biz Buddy creates only coordinate-positioned signature fields. Keeping that
 * subset explicit prevents signer-visible metadata and advanced behavior from
 * sitting outside the execution lease.
 */
export const assertCorrelatedDocumentFieldCreationAllowed = ({
  externalId,
  fields,
  existingFieldCount = 0,
}: {
  externalId: string | null | undefined;
  fields: readonly CorrelatedFieldCreationInput[];
  existingFieldCount?: number;
}) => {
  if (!isBizBuddyExternalId(externalId)) return;

  if (
    !Number.isSafeInteger(existingFieldCount) ||
    existingFieldCount < 0 ||
    existingFieldCount + fields.length > MAX_DOCUMENT_EXECUTION_FIELDS
  ) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: `Correlated documents support at most ${MAX_DOCUMENT_EXECUTION_FIELDS} fields`,
    });
  }

  const hasUnsupportedField = fields.some((field) => {
    const page = field.page ?? field.pageNumber;
    const positionX = field.positionX ?? field.pageX;
    const positionY = field.positionY ?? field.pageY;
    const width = field.width ?? field.pageWidth;
    const height = field.height ?? field.pageHeight;

    return (
      field.type !== FieldType.SIGNATURE ||
      field.fieldMeta !== undefined ||
      'placeholder' in field ||
      'customText' in field ||
      'inserted' in field ||
      !Number.isSafeInteger(page) ||
      Number(page) <= 0 ||
      typeof positionX !== 'number' ||
      !Number.isFinite(positionX) ||
      typeof positionY !== 'number' ||
      !Number.isFinite(positionY) ||
      typeof width !== 'number' ||
      !Number.isFinite(width) ||
      width <= 0 ||
      typeof height !== 'number' ||
      !Number.isFinite(height) ||
      height <= 0
    );
  });

  if (hasUnsupportedField) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message:
        'Correlated documents support finite, positive coordinate signature fields without metadata only',
    });
  }
};
