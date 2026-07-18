import { DocumentDataType } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FileSizeLimitExceededError, getFileServerSide } from './get-file.server';

const mocks = vi.hoisted(() => ({
  getPresignGetUrl: vi.fn(),
}));

vi.mock('./server-actions', () => ({
  getPresignGetUrl: mocks.getPresignGetUrl,
}));

describe('getFileServerSide bounded reads', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getPresignGetUrl.mockResolvedValue({
      key: 'signed/document.pdf',
      url: 'https://objects.example.test/signed/document.pdf',
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('allows the exact BYTES limit and rejects +1 before encoding', async () => {
    await expect(
      getFileServerSide({ type: DocumentDataType.BYTES, data: '%PDF-' }, { maxBytes: 5 }),
    ).resolves.toEqual(new TextEncoder().encode('%PDF-'));

    await expect(
      getFileServerSide({ type: DocumentDataType.BYTES, data: '%PDF-x' }, { maxBytes: 5 }),
    ).rejects.toBeInstanceOf(FileSizeLimitExceededError);
  });

  it('allows the exact decoded BYTES_64 limit and rejects +1 before decoding', async () => {
    const exact = Buffer.from('%PDF-').toString('base64');
    const over = Buffer.from('%PDF-x').toString('base64');

    await expect(
      getFileServerSide({ type: DocumentDataType.BYTES_64, data: exact }, { maxBytes: 5 }),
    ).resolves.toEqual(new TextEncoder().encode('%PDF-'));

    await expect(
      getFileServerSide({ type: DocumentDataType.BYTES_64, data: over }, { maxBytes: 5 }),
    ).rejects.toBeInstanceOf(FileSizeLimitExceededError);
  });

  it('allows an exact S3 Content-Length and rejects a declared +1 before reading', async () => {
    const body = new TextEncoder().encode('%PDF-');
    const exactFetch = vi.fn().mockResolvedValue(
      new Response(body, {
        headers: { 'content-length': '5' },
      }),
    );
    vi.stubGlobal('fetch', exactFetch);

    await expect(
      getFileServerSide(
        { type: DocumentDataType.S3_PATH, data: 'signed/document.pdf' },
        { maxBytes: 5, timeoutMs: 1000 },
      ),
    ).resolves.toEqual(body);

    const oversizedCancel = vi.fn();
    const oversizedStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('%PDF-x'));
      },
      cancel: oversizedCancel,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(oversizedStream, {
          headers: { 'content-length': '6' },
        }),
      ),
    );

    await expect(
      getFileServerSide(
        { type: DocumentDataType.S3_PATH, data: 'signed/document.pdf' },
        { maxBytes: 5, timeoutMs: 1000 },
      ),
    ).rejects.toBeInstanceOf(FileSizeLimitExceededError);
    expect(oversizedCancel).toHaveBeenCalled();
  });

  it.each([
    ['missing', null],
    ['lying', '5'],
  ])('cancels a %s S3 length response when the stream crosses the cap', async (_label, length) => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('%PDF-'));
        controller.enqueue(new TextEncoder().encode('x'));
      },
      cancel,
    });
    const headers = new Headers();
    if (length !== null) headers.set('content-length', length);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream, { headers })));

    await expect(
      getFileServerSide(
        { type: DocumentDataType.S3_PATH, data: 'signed/document.pdf' },
        { maxBytes: 5, timeoutMs: 1000 },
      ),
    ).rejects.toBeInstanceOf(FileSizeLimitExceededError);
    expect(cancel).toHaveBeenCalled();
  });

  it('aborts a stalled S3 response-header request', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        await new Promise<void>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        });
        return new Response();
      }),
    );

    await expect(
      getFileServerSide(
        { type: DocumentDataType.S3_PATH, data: 'signed/document.pdf' },
        { maxBytes: 5, timeoutMs: 10 },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('cancels a stalled S3 response body at the timeout', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('%PDF'));
      },
      cancel,
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream)));

    await expect(
      getFileServerSide(
        { type: DocumentDataType.S3_PATH, data: 'signed/document.pdf' },
        { maxBytes: 5, timeoutMs: 10 },
      ),
    ).rejects.toThrow('File download timed out');
    expect(cancel).toHaveBeenCalled();
  });
});
