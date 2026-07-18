import { DocumentDataType } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { putInternalPdfSnapshotServerSide, putPdfFileServerSide } from './put-file.server';

const mocks = vi.hoisted(() => ({
  createDocumentData: vi.fn(),
  deleteS3File: vi.fn(),
  loggerError: vi.fn(),
  pdfLoad: vi.fn(),
  uploadS3File: vi.fn(),
}));

vi.mock('@libpdf/core', () => ({
  PDF: {
    load: mocks.pdfLoad,
  },
}));

vi.mock('../../server-only/document-data/create-document-data', () => ({
  createDocumentData: mocks.createDocumentData,
}));

vi.mock('../../server-only/pdf/normalize-pdf', () => ({
  normalizePdf: vi.fn(),
}));

vi.mock('../../utils/logger', () => ({
  logger: {
    error: mocks.loggerError,
  },
}));

vi.mock('./server-actions', () => ({
  deleteS3File: mocks.deleteS3File,
  uploadS3File: mocks.uploadS3File,
}));

const originalUploadTransport = process.env.NEXT_PUBLIC_UPLOAD_TRANSPORT;

const pdfFile = () =>
  new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'execution.pdf', {
    type: 'application/pdf',
  });

describe('putInternalPdfSnapshotServerSide orphan cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_UPLOAD_TRANSPORT = 's3';
    mocks.pdfLoad.mockResolvedValue({
      isEncrypted: false,
      getPageCount: () => 1,
    });
    mocks.uploadS3File.mockResolvedValue({ key: 'random/internal-snapshot.pdf' });
  });

  afterEach(() => {
    if (originalUploadTransport === undefined) {
      delete process.env.NEXT_PUBLIC_UPLOAD_TRANSPORT;
    } else {
      process.env.NEXT_PUBLIC_UPLOAD_TRANSPORT = originalUploadTransport;
    }
  });

  it('deletes its uploaded S3 object when the DocumentData insert fails', async () => {
    const insertError = new Error('database unavailable');
    mocks.createDocumentData.mockRejectedValue(insertError);
    mocks.deleteS3File.mockResolvedValue(undefined);

    await expect(putInternalPdfSnapshotServerSide(pdfFile())).rejects.toBe(insertError);

    expect(mocks.uploadS3File).toHaveBeenCalledTimes(1);
    expect(mocks.deleteS3File).toHaveBeenCalledWith('random/internal-snapshot.pdf');
  });

  it('never masks the original insert error when orphan deletion also fails', async () => {
    const insertError = new Error('database unavailable');
    mocks.createDocumentData.mockRejectedValue(insertError);
    mocks.deleteS3File.mockRejectedValue(new Error('object store unavailable'));

    await expect(putInternalPdfSnapshotServerSide(pdfFile())).rejects.toBe(insertError);

    expect(mocks.loggerError).toHaveBeenCalledWith({
      event: 'internal-pdf-snapshot-orphan-cleanup-failed',
      errorName: 'Error',
    });
  });

  it('does not change generic/native upload failure behavior', async () => {
    const insertError = new Error('database unavailable');
    mocks.createDocumentData.mockRejectedValue(insertError);

    await expect(putPdfFileServerSide(pdfFile())).rejects.toBe(insertError);

    expect(mocks.deleteS3File).not.toHaveBeenCalled();
  });

  it('returns the persisted snapshot without cleanup on success', async () => {
    const documentData = {
      id: 'document-data-1',
      type: DocumentDataType.S3_PATH,
      data: 'random/internal-snapshot.pdf',
      initialData: 'random/internal-snapshot.pdf',
    };
    mocks.createDocumentData.mockResolvedValue(documentData);

    await expect(putInternalPdfSnapshotServerSide(pdfFile())).resolves.toEqual({
      documentData,
      filePageCount: 1,
    });

    expect(mocks.deleteS3File).not.toHaveBeenCalled();
  });
});
