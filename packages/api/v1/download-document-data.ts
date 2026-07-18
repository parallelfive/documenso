import { type DocumentDataType, DocumentStatus, EnvelopeType } from '@prisma/client';

import { APP_DOCUMENT_UPLOAD_SIZE_LIMIT } from '@documenso/lib/constants/app';
import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import {
  type GetEnvelopeByIdOptions,
  getEnvelopeWhereInput,
} from '@documenso/lib/server-only/envelope/get-envelope-by-id';
import {
  FileSizeLimitExceededError,
  type GetFileOptions,
  type GetFileReadLimits,
  getFileServerSide,
} from '@documenso/lib/universal/upload/get-file.server';
import { prisma } from '@documenso/prisma';

const BYTES_PER_MEBIBYTE = 1024 * 1024;

// Signed PDFs can grow slightly when Documenso inserts fields and its
// certificate. Preserve ten MiB of headroom over the configured upload cap
// while still bounding the trusted API response.
export const MAX_SIGNED_DOCUMENT_DOWNLOAD_BYTES =
  Math.min(Math.max(APP_DOCUMENT_UPLOAD_SIZE_LIMIT + 10, 10), 100) * BYTES_PER_MEBIBYTE;
export const SIGNED_DOCUMENT_DOWNLOAD_TIMEOUT_MS = 15_000;
export const MAX_SIGNED_DOCUMENT_S3_KEY_BYTES = 2048;

export interface DownloadEnvelope {
  teamId: number | null;
  status: DocumentStatus;
  envelopeItems: Array<{
    documentData: {
      id: string;
      type: DocumentDataType;
    };
  }>;
}

export interface StoredDocumentDataMetadata {
  type: DocumentDataType;
  encodedLength: bigint;
  base64Suffix: string | null;
  s3Key: string | null;
}

export interface DownloadDocumentDataDependencies {
  getEnvelope: (options: GetEnvelopeByIdOptions) => Promise<DownloadEnvelope | null>;
  getDocumentDataMetadata: (id: string) => Promise<StoredDocumentDataMetadata | null>;
  getDocumentData: (
    id: string,
    expectedType: DocumentDataType,
    maxBytes: number,
  ) => Promise<GetFileOptions | null>;
  getFile: (options: GetFileOptions, limits: GetFileReadLimits) => Promise<Uint8Array>;
  maxBytes: number;
  timeoutMs: number;
}

const defaultDependencies: DownloadDocumentDataDependencies = {
  getEnvelope: getDownloadEnvelopeMetadata,
  getDocumentDataMetadata: getStoredDocumentDataMetadata,
  getDocumentData: getBoundedStoredDocumentData,
  getFile: getFileServerSide,
  maxBytes: MAX_SIGNED_DOCUMENT_DOWNLOAD_BYTES,
  timeoutMs: SIGNED_DOCUMENT_DOWNLOAD_TIMEOUT_MS,
};

export const downloadSignedDocumentData = async (
  {
    documentId,
    userId,
    teamId,
  }: {
    documentId: number;
    userId: number;
    teamId: number;
  },
  dependencies: DownloadDocumentDataDependencies = defaultDependencies,
) => {
  try {
    let envelope: DownloadEnvelope | null;
    try {
      envelope = await dependencies.getEnvelope({
        id: {
          type: 'documentId',
          id: documentId,
        },
        type: EnvelopeType.DOCUMENT,
        userId,
        teamId,
      });
    } catch (error) {
      if (
        error instanceof AppError &&
        (error.code === AppErrorCode.NOT_FOUND || error.code === AppErrorCode.UNAUTHORIZED)
      ) {
        return {
          status: 404 as const,
          body: { message: 'Document not found' },
        };
      }
      throw error;
    }

    if (!envelope || envelope.teamId !== teamId) {
      return {
        status: 404 as const,
        body: { message: 'Document not found' },
      };
    }

    if (envelope.status !== DocumentStatus.COMPLETED) {
      return {
        status: 400 as const,
        body: { message: 'Document is not completed yet.' },
      };
    }

    if (envelope.envelopeItems.length !== 1) {
      return {
        status: 400 as const,
        body: { message: 'API V1 does not support items' },
      };
    }

    const documentDataReference = envelope.envelopeItems[0]?.documentData;
    if (!documentDataReference) {
      throw new Error('Document data reference is missing');
    }

    // Read only type/length/suffix (or the small S3 key) before selecting a
    // database-backed PDF string. This is the endpoint's pre-materialization
    // bound; getFileServerSide repeats the decoded cap after retrieval to
    // protect against races and lying object-store metadata.
    const storageMetadata = await dependencies.getDocumentDataMetadata(documentDataReference.id);
    if (!storageMetadata || storageMetadata.type !== documentDataReference.type) {
      throw new Error('Document data metadata is inconsistent');
    }

    const decodedBytes = decodedDocumentDataByteLength(storageMetadata);
    if (decodedBytes !== null && decodedBytes > BigInt(dependencies.maxBytes)) {
      return payloadTooLarge();
    }

    let documentData: GetFileOptions | null;
    if (storageMetadata.type === 'S3_PATH') {
      if (storageMetadata.encodedLength > BigInt(MAX_SIGNED_DOCUMENT_S3_KEY_BYTES)) {
        throw new Error('Document storage key exceeds the configured limit');
      }
      documentData =
        storageMetadata.s3Key === null
          ? null
          : {
              type: storageMetadata.type,
              data: storageMetadata.s3Key,
            };
    } else {
      documentData = await dependencies.getDocumentData(
        documentDataReference.id,
        storageMetadata.type,
        dependencies.maxBytes,
      );
      if (!documentData) {
        const latestMetadata = await dependencies.getDocumentDataMetadata(documentDataReference.id);
        if (latestMetadata?.type === storageMetadata.type) {
          const latestDecodedBytes = decodedDocumentDataByteLength(latestMetadata);
          if (latestDecodedBytes !== null && latestDecodedBytes > BigInt(dependencies.maxBytes)) {
            return payloadTooLarge();
          }
        }
      }
    }
    if (!documentData || documentData.type !== storageMetadata.type) {
      throw new Error('Document data is missing or changed');
    }

    const pdf = await dependencies.getFile(documentData, {
      maxBytes: dependencies.maxBytes,
      timeoutMs: dependencies.timeoutMs,
    });

    // Permit a small amount of transport preamble while rejecting an empty or
    // obviously non-PDF provider response before it crosses the trust boundary.
    const headerWindow = pdf.subarray(0, Math.min(pdf.byteLength, 1024));
    if (pdf.byteLength === 0 || !containsPdfHeader(headerWindow)) {
      return {
        status: 500 as const,
        body: { message: 'Signed document data is invalid.' },
      };
    }

    return {
      status: 200 as const,
      body: new Blob([pdf], { type: 'application/pdf' }),
    };
  } catch (error) {
    if (error instanceof FileSizeLimitExceededError) {
      return payloadTooLarge();
    }

    return {
      status: 500 as const,
      body: {
        message: 'Error downloading the document. Please try again.',
      },
    };
  }
};

async function getDownloadEnvelopeMetadata(
  options: GetEnvelopeByIdOptions,
): Promise<DownloadEnvelope | null> {
  const { envelopeWhereInput } = await getEnvelopeWhereInput(options);

  return prisma.envelope.findFirst({
    where: {
      AND: [envelopeWhereInput, { teamId: options.teamId }],
    },
    select: {
      teamId: true,
      status: true,
      envelopeItems: {
        orderBy: {
          order: 'asc',
        },
        select: {
          documentData: {
            select: {
              id: true,
              type: true,
            },
          },
        },
      },
    },
  });
}

export async function getStoredDocumentDataMetadata(
  id: string,
): Promise<StoredDocumentDataMetadata | null> {
  const rows = await prisma.$queryRaw<StoredDocumentDataMetadata[]>`
    SELECT
      "type",
      octet_length("data")::bigint AS "encodedLength",
      CASE
        WHEN "type" = 'BYTES_64'::"DocumentDataType" THEN right("data", 2)
        ELSE NULL
      END AS "base64Suffix",
      CASE
        WHEN "type" = 'S3_PATH'::"DocumentDataType"
          THEN left("data", ${MAX_SIGNED_DOCUMENT_S3_KEY_BYTES}::int)
        ELSE NULL
      END AS "s3Key"
    FROM "DocumentData"
    WHERE "id" = ${id}
    LIMIT 1
  `;

  return rows[0] ?? null;
}

export async function getBoundedStoredDocumentData(
  id: string,
  expectedType: DocumentDataType,
  maxBytes: number,
): Promise<GetFileOptions | null> {
  const rows = await prisma.$queryRaw<GetFileOptions[]>`
    SELECT "type", "data"
    FROM "DocumentData"
    WHERE "id" = ${id}
      AND "type" = ${expectedType}::"DocumentDataType"
      AND CASE
        WHEN "type" = 'BYTES'::"DocumentDataType"
          THEN octet_length("data")::bigint <= ${maxBytes}
        WHEN "type" = 'BYTES_64'::"DocumentDataType"
          THEN octet_length("data")::bigint % 4 = 0
            AND (
              (octet_length("data")::bigint / 4) * 3
              - CASE
                  WHEN right("data", 2) = '==' THEN 2
                  WHEN right("data", 1) = '=' THEN 1
                  ELSE 0
                END
            ) <= ${maxBytes}
        ELSE FALSE
      END
    LIMIT 1
  `;

  return rows[0] ?? null;
}

export const decodedDocumentDataByteLength = ({
  type,
  encodedLength,
  base64Suffix,
}: StoredDocumentDataMetadata): bigint | null => {
  if (encodedLength < 0n) throw new Error('Invalid stored document length');
  if (type === 'S3_PATH') return null;
  if (type === 'BYTES') return encodedLength;

  if (encodedLength === 0n) return 0n;
  if (encodedLength % 4n !== 0n || base64Suffix === null) {
    throw new Error('Invalid base64 document data');
  }

  const padding = base64Suffix.endsWith('==') ? 2n : base64Suffix.endsWith('=') ? 1n : 0n;
  return (encodedLength / 4n) * 3n - padding;
};

const containsPdfHeader = (bytes: Uint8Array): boolean => {
  const marker = [0x25, 0x50, 0x44, 0x46, 0x2d];
  for (let offset = 0; offset <= bytes.byteLength - marker.length; offset += 1) {
    if (marker.every((byte, index) => bytes[offset + index] === byte)) return true;
  }
  return false;
};

const payloadTooLarge = () => ({
  status: 413 as const,
  body: { message: 'Signed document exceeds the download size limit.' },
});
