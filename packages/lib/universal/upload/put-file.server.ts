import { PDF } from '@libpdf/core';
import { DocumentDataType } from '@prisma/client';
import { base64 } from '@scure/base';
import { match } from 'ts-pattern';

import { env } from '@documenso/lib/utils/env';

import { ONE_MINUTE } from '../../constants/time';
import { AppError } from '../../errors/app-error';
import { createDocumentData } from '../../server-only/document-data/create-document-data';
import {
  createProvisionalInternalDocumentData,
  reserveInternalSnapshotStorageCleanup,
} from '../../server-only/document-data/stage-document-data-storage-cleanup';
import { normalizePdf } from '../../server-only/pdf/normalize-pdf';
import { logger } from '../../utils/logger';
import { deleteS3File, uploadS3File } from './server-actions';

type File = {
  name: string;
  type: string;
  arrayBuffer: () => Promise<ArrayBuffer>;
};

export const INTERNAL_SNAPSHOT_UPLOAD_TIMEOUT_MS = 5 * ONE_MINUTE;

/**
 * Uploads a document file to the appropriate storage location and creates
 * a document data record.
 */
export const putPdfFileServerSide = async (file: File, initialData?: string) => {
  return putPdfFile(file, initialData);
};

/**
 * Stores a PDF snapshot through server credentials under a fresh random key.
 * The key is never exposed through the client upload API.
 */
export const putInternalPdfSnapshotServerSide = async (file: File) => {
  return putPdfFile(file, undefined, true);
};

const putPdfFile = async (
  file: File,
  initialData?: string,
  cleanupExternalUploadOnDataFailure = false,
) => {
  const isEncryptedDocumentsAllowed = false; // Was feature flag.

  const arrayBuffer = await file.arrayBuffer();

  const pdf = await PDF.load(new Uint8Array(arrayBuffer)).catch((e) => {
    console.error(`PDF upload parse error: ${e.message}`);

    throw new AppError('INVALID_DOCUMENT_FILE');
  });

  if (!isEncryptedDocumentsAllowed && pdf.isEncrypted) {
    throw new AppError('INVALID_DOCUMENT_FILE');
  }

  if (!file.name.endsWith('.pdf')) {
    file.name = `${file.name}.pdf`;
  }

  const { type, data } = await putFileServerSide(
    file,
    cleanupExternalUploadOnDataFailure
      ? {
          onS3KeyAllocated: async (key) => {
            await reserveInternalSnapshotStorageCleanup({ key });
          },
          s3RequestTimeoutMs: INTERNAL_SNAPSHOT_UPLOAD_TIMEOUT_MS,
        }
      : undefined,
  );

  let createdData: Awaited<ReturnType<typeof createDocumentData>>;

  try {
    createdData =
      cleanupExternalUploadOnDataFailure && type === DocumentDataType.S3_PATH
        ? await createProvisionalInternalDocumentData({ type, data })
        : await createDocumentData({ type, data, initialData });
  } catch (error) {
    if (cleanupExternalUploadOnDataFailure && type === DocumentDataType.S3_PATH) {
      try {
        await deleteS3File(data);
      } catch (cleanupError) {
        logger.error({
          event: 'internal-pdf-snapshot-orphan-cleanup-failed',
          errorName: cleanupError instanceof Error ? cleanupError.name : 'UnknownError',
        });
      }
    }

    throw error;
  }

  return {
    documentData: createdData,
    filePageCount: pdf.getPageCount(),
  };
};

/**
 * Uploads a pdf file and normalizes it.
 */
export const putNormalizedPdfFileServerSide = async (
  file: File,
  options: { flattenForm?: boolean } = {},
) => {
  const buffer = Buffer.from(await file.arrayBuffer());

  const normalized = await normalizePdf(buffer, options);

  const fileName = file.name.endsWith('.pdf') ? file.name : `${file.name}.pdf`;

  const documentData = await putFileServerSide({
    name: fileName,
    type: 'application/pdf',
    arrayBuffer: async () => Promise.resolve(normalized),
  });

  return await createDocumentData({
    type: documentData.type,
    data: documentData.data,
  });
};

/**
 * Uploads a file to the appropriate storage location.
 */
export const putFileServerSide = async (
  file: File,
  options: {
    onS3KeyAllocated?: (key: string) => Promise<void>;
    s3RequestTimeoutMs?: number;
  } = {},
) => {
  const NEXT_PUBLIC_UPLOAD_TRANSPORT = env('NEXT_PUBLIC_UPLOAD_TRANSPORT');

  return await match(NEXT_PUBLIC_UPLOAD_TRANSPORT)
    .with('s3', async () => putFileInS3(file, options.onS3KeyAllocated, options.s3RequestTimeoutMs))
    .otherwise(async () => putFileInDatabase(file));
};

const putFileInDatabase = async (file: File) => {
  const contents = await file.arrayBuffer();

  const binaryData = new Uint8Array(contents);

  const asciiData = base64.encode(binaryData);

  return {
    type: DocumentDataType.BYTES_64,
    data: asciiData,
  };
};

const putFileInS3 = async (
  file: File,
  onS3KeyAllocated?: (key: string) => Promise<void>,
  requestTimeoutMs?: number,
) => {
  const buffer = await file.arrayBuffer();

  const blob = new Blob([buffer], { type: file.type });

  const newFile = new File([blob], file.name, {
    type: file.type,
  });

  const { key } = await uploadS3File(newFile, {
    onKeyAllocated: onS3KeyAllocated,
    requestTimeoutMs,
  });

  return {
    type: DocumentDataType.S3_PATH,
    data: key,
  };
};
