import { type DocumentDataType, DocumentStatus, EnvelopeType } from '@prisma/client';

import { APP_DOCUMENT_UPLOAD_SIZE_LIMIT } from '@documenso/lib/constants/app';
import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { getEnvelopeById } from '@documenso/lib/server-only/envelope/get-envelope-by-id';
import {
  type GetFileOptions,
  getFileServerSide,
} from '@documenso/lib/universal/upload/get-file.server';

const BYTES_PER_MEBIBYTE = 1024 * 1024;

// Signed PDFs can grow slightly when Documenso inserts fields and its
// certificate. Preserve ten MiB of headroom over the configured upload cap
// while still bounding the trusted API response.
export const MAX_SIGNED_DOCUMENT_DOWNLOAD_BYTES =
  Math.min(Math.max(APP_DOCUMENT_UPLOAD_SIZE_LIMIT + 10, 10), 100) * BYTES_PER_MEBIBYTE;

export interface DownloadEnvelope {
  teamId: number | null;
  status: DocumentStatus;
  envelopeItems: Array<{
    documentData: {
      type: DocumentDataType;
      data: string;
      initialData: string;
    };
  }>;
}

export interface DownloadDocumentDataDependencies {
  getEnvelope: (options: Parameters<typeof getEnvelopeById>[0]) => Promise<DownloadEnvelope | null>;
  getFile: (options: GetFileOptions) => Promise<Uint8Array>;
  maxBytes: number;
}

const defaultDependencies: DownloadDocumentDataDependencies = {
  getEnvelope: async (options) => getEnvelopeById(options),
  getFile: getFileServerSide,
  maxBytes: MAX_SIGNED_DOCUMENT_DOWNLOAD_BYTES,
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

    const documentData = envelope?.envelopeItems[0]?.documentData;
    if (!envelope || envelope.teamId !== teamId || !documentData) {
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

    const file = await dependencies.getFile(documentData);
    const pdf = Buffer.from(file);

    if (pdf.byteLength > dependencies.maxBytes) {
      return {
        status: 413 as const,
        body: { message: 'Signed document exceeds the download size limit.' },
      };
    }

    // Permit a small amount of transport preamble while rejecting an empty or
    // obviously non-PDF provider response before it crosses the trust boundary.
    const headerWindow = pdf.subarray(0, Math.min(pdf.byteLength, 1024));
    if (pdf.byteLength === 0 || !headerWindow.includes(Buffer.from('%PDF-', 'ascii'))) {
      return {
        status: 500 as const,
        body: { message: 'Signed document data is invalid.' },
      };
    }

    return {
      status: 200 as const,
      body: new Blob([pdf], { type: 'application/pdf' }),
    };
  } catch {
    return {
      status: 500 as const,
      body: {
        message: 'Error downloading the document. Please try again.',
      },
    };
  }
};
