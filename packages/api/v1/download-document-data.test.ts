import { DocumentDataType, DocumentStatus } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { FileSizeLimitExceededError } from '@documenso/lib/universal/upload/get-file.server';

import { ApiContractV1 } from './contract';
import {
  type DownloadDocumentDataDependencies,
  type DownloadEnvelope,
  type StoredDocumentDataMetadata,
  decodedDocumentDataByteLength,
  downloadSignedDocumentData,
} from './download-document-data';

vi.mock('@lingui/core/macro', () => ({
  msg: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((message, part, index) => `${message}${part}${values[index] ?? ''}`, ''),
}));

const DATA_ID = 'document-data-1';

const completedEnvelope: DownloadEnvelope = {
  teamId: 9,
  status: DocumentStatus.COMPLETED,
  envelopeItems: [
    {
      documentData: {
        id: DATA_ID,
        type: DocumentDataType.BYTES_64,
      },
    },
  ],
};

const metadataFor = (type: DocumentDataType, decodedBytes = 14): StoredDocumentDataMetadata => {
  if (type === DocumentDataType.S3_PATH) {
    return {
      type,
      encodedLength: 19n,
      base64Suffix: null,
      s3Key: 'signed/document.pdf',
    };
  }

  if (type === DocumentDataType.BYTES) {
    return {
      type,
      encodedLength: BigInt(decodedBytes),
      base64Suffix: null,
      s3Key: null,
    };
  }

  const encoded = Buffer.alloc(decodedBytes).toString('base64');
  return {
    type,
    encodedLength: BigInt(encoded.length),
    base64Suffix: encoded.slice(-2),
    s3Key: null,
  };
};

const dependenciesFor = ({
  envelope = completedEnvelope,
  file = new TextEncoder().encode('%PDF-1.7\nsigned'),
  maxBytes = 1024,
  metadata,
}: {
  envelope?: DownloadEnvelope | null;
  file?: Uint8Array;
  maxBytes?: number;
  metadata?: StoredDocumentDataMetadata;
} = {}): DownloadDocumentDataDependencies => {
  const type = envelope?.envelopeItems[0]?.documentData.type ?? DocumentDataType.BYTES_64;
  const storageMetadata = metadata ?? metadataFor(type, file.byteLength);

  return {
    getEnvelope: vi.fn().mockResolvedValue(envelope),
    getDocumentDataMetadata: vi.fn().mockResolvedValue(storageMetadata),
    getDocumentData: vi.fn().mockResolvedValue({
      type,
      data: type === DocumentDataType.BYTES ? '%PDF-1.7\nsigned' : 'base64-data',
    }),
    getFile: vi.fn().mockResolvedValue(file),
    maxBytes,
    timeoutMs: 250,
  };
};

const call = async (options: Parameters<typeof dependenciesFor>[0] = {}) =>
  downloadSignedDocumentData({ documentId: 42, userId: 7, teamId: 9 }, dependenciesFor(options));

describe('downloadSignedDocumentData', () => {
  it('publishes the locked bearer-authenticated binary API contract', () => {
    const route = ApiContractV1.downloadSignedDocumentData;

    expect(route.method).toBe('GET');
    expect(route.path).toBe('/api/v1/documents/:id/download-data');
    expect(route.responses[200]).toMatchObject({
      contentType: 'application/pdf',
    });
  });

  it('returns a bounded raw PDF for a completed single-item document', async () => {
    const result = await call();

    expect(result.status).toBe(200);
    if (result.status !== 200) throw new Error('Expected PDF response');
    expect(result.body).toBeInstanceOf(Blob);
    expect(result.body.type).toBe('application/pdf');
    expect(Buffer.from(await result.body.arrayBuffer()).toString()).toBe('%PDF-1.7\nsigned');
  });

  it('fails closed outside the exact authenticated team scope', async () => {
    await expect(call({ envelope: null })).resolves.toEqual({
      status: 404,
      body: { message: 'Document not found' },
    });
    await expect(
      call({
        envelope: {
          ...completedEnvelope,
          teamId: 99,
        },
      }),
    ).resolves.toEqual({
      status: 404,
      body: { message: 'Document not found' },
    });
  });

  it('maps only expected lookup denials to 404 and preserves internal failures as 500', async () => {
    const denied = dependenciesFor();
    denied.getEnvelope = vi
      .fn()
      .mockRejectedValue(new AppError(AppErrorCode.UNAUTHORIZED, { message: 'Not allowed' }));
    const failed = dependenciesFor();
    failed.getEnvelope = vi.fn().mockRejectedValue(new Error('database unavailable'));

    await expect(
      downloadSignedDocumentData({ documentId: 42, userId: 7, teamId: 9 }, denied),
    ).resolves.toEqual({
      status: 404,
      body: { message: 'Document not found' },
    });
    await expect(
      downloadSignedDocumentData({ documentId: 42, userId: 7, teamId: 9 }, failed),
    ).resolves.toEqual({
      status: 500,
      body: { message: 'Error downloading the document. Please try again.' },
    });
  });

  it('passes authenticated scope into lookup and bounds the final loader', async () => {
    const dependencies = dependenciesFor();

    await downloadSignedDocumentData({ documentId: 42, userId: 7, teamId: 9 }, dependencies);

    expect(dependencies.getEnvelope).toHaveBeenCalledWith({
      id: { type: 'documentId', id: 42 },
      type: 'DOCUMENT',
      userId: 7,
      teamId: 9,
    });
    expect(dependencies.getFile).toHaveBeenCalledWith(
      expect.objectContaining({ type: DocumentDataType.BYTES_64 }),
      { maxBytes: 1024, timeoutMs: 250 },
    );
  });

  it.each([DocumentDataType.BYTES, DocumentDataType.BYTES_64, DocumentDataType.S3_PATH])(
    'loads %s through the bounded storage abstraction',
    async (type) => {
      const envelope: DownloadEnvelope = {
        ...completedEnvelope,
        envelopeItems: [
          {
            documentData: {
              id: DATA_ID,
              type,
            },
          },
        ],
      };
      const dependencies = dependenciesFor({ envelope });

      const result = await downloadSignedDocumentData(
        { documentId: 42, userId: 7, teamId: 9 },
        dependencies,
      );

      expect(result.status).toBe(200);
      if (type === DocumentDataType.S3_PATH) {
        expect(dependencies.getDocumentData).not.toHaveBeenCalled();
        expect(dependencies.getFile).toHaveBeenCalledWith(
          { type, data: 'signed/document.pdf' },
          expect.any(Object),
        );
      } else {
        expect(dependencies.getDocumentData).toHaveBeenCalledWith(DATA_ID, type, 1024);
      }
    },
  );

  it('rejects pending and rejected documents', async () => {
    for (const status of [DocumentStatus.PENDING, DocumentStatus.REJECTED]) {
      await expect(
        call({
          envelope: {
            ...completedEnvelope,
            status,
          },
        }),
      ).resolves.toEqual({
        status: 400,
        body: { message: 'Document is not completed yet.' },
      });
    }
  });

  it('rejects zero- and multi-item envelopes through the exact-one gate', async () => {
    for (const envelopeItems of [
      [],
      [completedEnvelope.envelopeItems[0], completedEnvelope.envelopeItems[0]],
    ]) {
      await expect(
        call({
          envelope: {
            ...completedEnvelope,
            envelopeItems,
          },
        }),
      ).resolves.toEqual({
        status: 400,
        body: { message: 'API V1 does not support items' },
      });
    }
  });

  it.each([
    {
      label: 'BYTES',
      exact: metadataFor(DocumentDataType.BYTES, 5),
      over: metadataFor(DocumentDataType.BYTES, 6),
    },
    {
      label: 'BYTES_64',
      exact: metadataFor(DocumentDataType.BYTES_64, 5),
      over: metadataFor(DocumentDataType.BYTES_64, 6),
    },
  ])(
    'preflights exact decoded $label bytes and rejects +1 before selecting data',
    async ({ exact, over }) => {
      const envelope: DownloadEnvelope = {
        ...completedEnvelope,
        envelopeItems: [
          {
            documentData: {
              id: DATA_ID,
              type: exact.type,
            },
          },
        ],
      };
      const exactDependencies = dependenciesFor({
        envelope,
        maxBytes: 5,
        metadata: exact,
        file: new TextEncoder().encode('%PDF-'),
      });
      const overDependencies = dependenciesFor({
        envelope,
        maxBytes: 5,
        metadata: over,
        file: new TextEncoder().encode('%PDF-x'),
      });

      await expect(
        downloadSignedDocumentData({ documentId: 42, userId: 7, teamId: 9 }, exactDependencies),
      ).resolves.toMatchObject({ status: 200 });
      await expect(
        downloadSignedDocumentData({ documentId: 42, userId: 7, teamId: 9 }, overDependencies),
      ).resolves.toEqual({
        status: 413,
        body: { message: 'Signed document exceeds the download size limit.' },
      });
      expect(overDependencies.getDocumentData).not.toHaveBeenCalled();
      expect(overDependencies.getFile).not.toHaveBeenCalled();
    },
  );

  it('rechecks metadata when the guarded DB fetch loses a size race', async () => {
    const dependencies = dependenciesFor({
      maxBytes: 5,
      metadata: metadataFor(DocumentDataType.BYTES_64, 5),
      file: new TextEncoder().encode('%PDF-'),
    });
    dependencies.getDocumentData = vi.fn().mockResolvedValue(null);
    dependencies.getDocumentDataMetadata = vi
      .fn()
      .mockResolvedValueOnce(metadataFor(DocumentDataType.BYTES_64, 5))
      .mockResolvedValueOnce(metadataFor(DocumentDataType.BYTES_64, 6));

    await expect(
      downloadSignedDocumentData({ documentId: 42, userId: 7, teamId: 9 }, dependencies),
    ).resolves.toEqual({
      status: 413,
      body: { message: 'Signed document exceeds the download size limit.' },
    });
    expect(dependencies.getFile).not.toHaveBeenCalled();
  });

  it('maps a post-preflight loader overflow to 413 and other loader failures to 500', async () => {
    const overflow = dependenciesFor();
    overflow.getFile = vi.fn().mockRejectedValue(new FileSizeLimitExceededError());
    const failure = dependenciesFor();
    failure.getFile = vi.fn().mockRejectedValue(new Error('object store unavailable'));

    await expect(
      downloadSignedDocumentData({ documentId: 42, userId: 7, teamId: 9 }, overflow),
    ).resolves.toEqual({
      status: 413,
      body: { message: 'Signed document exceeds the download size limit.' },
    });
    await expect(
      downloadSignedDocumentData({ documentId: 42, userId: 7, teamId: 9 }, failure),
    ).resolves.toEqual({
      status: 500,
      body: { message: 'Error downloading the document. Please try again.' },
    });
  });

  it('rejects an oversized S3 key before presign or fetch', async () => {
    const dependencies = dependenciesFor({
      envelope: {
        ...completedEnvelope,
        envelopeItems: [
          {
            documentData: {
              id: DATA_ID,
              type: DocumentDataType.S3_PATH,
            },
          },
        ],
      },
      metadata: {
        type: DocumentDataType.S3_PATH,
        encodedLength: 2049n,
        base64Suffix: null,
        s3Key: 'bounded-prefix-only',
      },
    });

    await expect(
      downloadSignedDocumentData({ documentId: 42, userId: 7, teamId: 9 }, dependencies),
    ).resolves.toEqual({
      status: 500,
      body: { message: 'Error downloading the document. Please try again.' },
    });
    expect(dependencies.getFile).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'offset 0', prefixBytes: 0, expectedStatus: 200 },
    { label: 'last valid offset 1019', prefixBytes: 1019, expectedStatus: 200 },
    { label: 'too-late offset 1020', prefixBytes: 1020, expectedStatus: 500 },
  ])(
    'validates the PDF marker within the first 1024 bytes at $label',
    async ({ prefixBytes, expectedStatus }) => {
      const file = new Uint8Array(prefixBytes + 5);
      file.fill(0x20, 0, prefixBytes);
      file.set(new TextEncoder().encode('%PDF-'), prefixBytes);

      await expect(call({ file, maxBytes: 2048 })).resolves.toMatchObject({
        status: expectedStatus,
      });
    },
  );
});

describe('decodedDocumentDataByteLength', () => {
  it('computes exact padded and unpadded base64 lengths', () => {
    expect(decodedDocumentDataByteLength(metadataFor(DocumentDataType.BYTES_64, 4))).toBe(4n);
    expect(decodedDocumentDataByteLength(metadataFor(DocumentDataType.BYTES_64, 5))).toBe(5n);
    expect(decodedDocumentDataByteLength(metadataFor(DocumentDataType.BYTES_64, 6))).toBe(6n);
  });
});
