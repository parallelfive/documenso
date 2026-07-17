import { DocumentDataType, DocumentStatus } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';

vi.mock('@lingui/core/macro', () => ({
  msg: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce(
      (message, part, index) => `${message}${part}${values[index] ?? ''}`,
      '',
    ),
}));

import {
  type DownloadEnvelope,
  downloadSignedDocumentData,
} from './download-document-data';
import { ApiContractV1 } from './contract';

const completedEnvelope: DownloadEnvelope = {
  teamId: 9,
  status: DocumentStatus.COMPLETED,
  envelopeItems: [
    {
      documentData: {
        type: DocumentDataType.BYTES_64,
        data: 'unused-in-test',
        initialData: 'unused-in-test',
      },
    },
  ],
};

const call = async (
  envelope: typeof completedEnvelope | null,
  file = Buffer.from('%PDF-1.7\nsigned'),
  maxBytes = 1024,
) =>
  downloadSignedDocumentData(
    { documentId: 42, userId: 7, teamId: 9 },
    {
      getEnvelope: vi.fn().mockResolvedValue(envelope),
      getFile: vi.fn().mockResolvedValue(file),
      maxBytes,
    },
  );

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
    const result = await call(completedEnvelope);

    expect(result.status).toBe(200);
    if (result.status !== 200) throw new Error('Expected PDF response');
    expect(result.body).toBeInstanceOf(Blob);
    expect(result.body.type).toBe('application/pdf');
    expect(Buffer.from(await result.body.arrayBuffer()).toString()).toBe(
      '%PDF-1.7\nsigned',
    );
  });

  it('fails closed for a document outside the authenticated user/team scope', async () => {
    await expect(call(null)).resolves.toEqual({
      status: 404,
      body: { message: 'Document not found' },
    });
  });

  it('rejects an owner-visible document from another team', async () => {
    await expect(
      call({
        ...completedEnvelope,
        teamId: 99,
      }),
    ).resolves.toEqual({
      status: 404,
      body: { message: 'Document not found' },
    });
  });

  it('maps only expected lookup denials to 404 and preserves internal failures as 500', async () => {
    const denied = vi
      .fn()
      .mockRejectedValue(
        new AppError(AppErrorCode.UNAUTHORIZED, { message: 'Not allowed' }),
      );
    const failed = vi.fn().mockRejectedValue(new Error('database unavailable'));
    const dependencies = {
      getFile: vi.fn().mockResolvedValue(Buffer.from('%PDF-1.7\nsigned')),
      maxBytes: 1024,
    };

    await expect(
      downloadSignedDocumentData(
        { documentId: 42, userId: 7, teamId: 9 },
        { ...dependencies, getEnvelope: denied },
      ),
    ).resolves.toEqual({
      status: 404,
      body: { message: 'Document not found' },
    });
    await expect(
      downloadSignedDocumentData(
        { documentId: 42, userId: 7, teamId: 9 },
        { ...dependencies, getEnvelope: failed },
      ),
    ).resolves.toEqual({
      status: 500,
      body: { message: 'Error downloading the document. Please try again.' },
    });
  });

  it('passes the authenticated user and team scope into the provider lookup', async () => {
    const getEnvelope = vi.fn().mockResolvedValue(completedEnvelope);

    await downloadSignedDocumentData(
      { documentId: 42, userId: 7, teamId: 9 },
      {
        getEnvelope,
        getFile: vi.fn().mockResolvedValue(Buffer.from('%PDF-1.7\nsigned')),
        maxBytes: 1024,
      },
    );

    expect(getEnvelope).toHaveBeenCalledWith({
      id: { type: 'documentId', id: 42 },
      type: 'DOCUMENT',
      userId: 7,
      teamId: 9,
    });
  });

  it.each([
    DocumentDataType.BYTES,
    DocumentDataType.BYTES_64,
    DocumentDataType.S3_PATH,
  ])('loads %s through the storage-agnostic file abstraction', async (type) => {
    const getFile = vi.fn().mockResolvedValue(Buffer.from('%PDF-1.7\nsigned'));
    const envelope: DownloadEnvelope = {
      ...completedEnvelope,
      envelopeItems: [
        {
          documentData: {
            ...completedEnvelope.envelopeItems[0].documentData,
            type,
          },
        },
      ],
    };

    await downloadSignedDocumentData(
      { documentId: 42, userId: 7, teamId: 9 },
      {
        getEnvelope: vi.fn().mockResolvedValue(envelope),
        getFile,
        maxBytes: 1024,
      },
    );

    expect(getFile).toHaveBeenCalledWith(envelope.envelopeItems[0].documentData);
  });

  it('rejects a non-completed document', async () => {
    await expect(
      call({
        ...completedEnvelope,
        status: DocumentStatus.PENDING,
      }),
    ).resolves.toEqual({
      status: 400,
      body: { message: 'Document is not completed yet.' },
    });
  });

  it('does not serve a rejected envelope as a fully signed PDF', async () => {
    await expect(
      call({
        ...completedEnvelope,
        status: DocumentStatus.REJECTED,
      }),
    ).resolves.toEqual({
      status: 400,
      body: { message: 'Document is not completed yet.' },
    });
  });

  it('rejects multi-item envelopes', async () => {
    await expect(
      call({
        ...completedEnvelope,
        envelopeItems: [
          ...completedEnvelope.envelopeItems,
          completedEnvelope.envelopeItems[0],
        ],
      }),
    ).resolves.toEqual({
      status: 400,
      body: { message: 'API V1 does not support items' },
    });
  });

  it('rejects oversized or invalid provider bytes', async () => {
    await expect(
      call(completedEnvelope, Buffer.from('%PDF-1.7\noversized'), 5),
    ).resolves.toEqual({
      status: 413,
      body: { message: 'Signed document exceeds the download size limit.' },
    });
    await expect(
      call(completedEnvelope, Buffer.from('not a pdf')),
    ).resolves.toEqual({
      status: 500,
      body: { message: 'Signed document data is invalid.' },
    });
  });
});
