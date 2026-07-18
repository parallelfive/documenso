import { createServer, type Server } from 'node:http';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  deleteS3File,
  getAbsolutePresignPostUrl,
  getPresignPostUrl,
  uploadS3File,
} from './server-actions';

type CapturedRequest = {
  method: string | undefined;
  url: string | undefined;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
};

describe('S3 upload checksum policy', () => {
  let server: Server;
  let endpoint: string;
  let capturedRequests: CapturedRequest[] = [];

  beforeAll(async () => {
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];

      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        capturedRequests.push({
          method: request.method,
          url: request.url,
          headers: request.headers,
          body: Buffer.concat(chunks),
        });

        const pathname = new URL(String(request.url), 'http://object-store.test').pathname;

        if (pathname.endsWith('/hung.pdf') || pathname.endsWith('/hung-delete.pdf')) {
          return;
        }

        response.writeHead(200, {
          'content-length': '0',
          etag: '"test-etag"',
        });
        response.end();
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });

    const address = server.address();

    if (!address || typeof address === 'string') {
      throw new Error('Failed to bind the test S3 server');
    }

    endpoint = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  beforeEach(() => {
    capturedRequests = [];
    vi.stubEnv('NEXT_PUBLIC_UPLOAD_TRANSPORT', 's3');
    vi.stubEnv('NEXT_PRIVATE_UPLOAD_ENDPOINT', endpoint);
    vi.stubEnv('NEXT_PRIVATE_UPLOAD_FORCE_PATH_STYLE', 'true');
    vi.stubEnv('NEXT_PRIVATE_UPLOAD_REGION', 'us-east-1');
    vi.stubEnv('NEXT_PRIVATE_UPLOAD_BUCKET', 'documenso-documents');
    vi.stubEnv('NEXT_PRIVATE_UPLOAD_ACCESS_KEY_ID', 'test-access-key');
    vi.stubEnv('NEXT_PRIVATE_UPLOAD_SECRET_ACCESS_KEY', 'test-secret-key');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    [
      'named upload',
      async () => (await getPresignPostUrl('decision.pdf', 'application/pdf')).url,
    ],
    [
      'absolute-key upload',
      async () => (await getAbsolutePresignPostUrl('existing/decision.pdf')).url,
    ],
  ])('does not bind an absent body checksum in a %s presign', async (_label, getUrl) => {
    const url = new URL(await getUrl());
    const queryNames = [...url.searchParams.keys()].map((name) => name.toLowerCase());

    expect(queryNames.filter((name) => name.includes('checksum'))).toEqual([]);
    expect(url.searchParams.get('X-Amz-Content-Sha256')).toBe('UNSIGNED-PAYLOAD');
  });

  it('still sends direct server uploads with the exact nonempty body', async () => {
    const pdf = Buffer.from('%PDF-1.7\nnonempty Garage upload\n');
    const file = new File([pdf], 'decision.pdf', {
      type: 'application/pdf',
    });

    const result = await uploadS3File(file);

    expect(result.response.$metadata.httpStatusCode).toBe(200);
    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0]).toMatchObject({
      method: 'PUT',
      body: pdf,
    });
    expect(new URL(String(capturedRequests[0]?.url), endpoint).pathname).toMatch(
      /^\/documenso-documents\/[a-zA-Z0-9_-]{12}\/decision\.pdf$/,
    );
    expect(capturedRequests[0]?.headers['content-type']).toBe('application/pdf');
    expect(
      Object.keys(capturedRequests[0]?.headers ?? {}).filter((name) =>
        name.toLowerCase().includes('checksum'),
      ),
    ).toEqual([]);
  });

  it('durably reserves an internal key before PutObject can begin', async () => {
    const file = new File([Buffer.from('%PDF-1.7\nreserved\n')], 'reserved.pdf', {
      type: 'application/pdf',
    });
    const events: string[] = [];

    await uploadS3File(file, {
      onKeyAllocated: async (key) => {
        await Promise.resolve();
        expect(key).toMatch(/^[a-zA-Z0-9_-]{12}\/reserved\.pdf$/);
        expect(capturedRequests).toHaveLength(0);
        events.push('reserved');
      },
    });

    events.push('uploaded');

    expect(events).toEqual(['reserved', 'uploaded']);
    expect(capturedRequests).toHaveLength(1);
  });

  it('does not issue PutObject when durable key reservation fails', async () => {
    const file = new File([Buffer.from('%PDF-1.7\nnever-uploaded\n')], 'blocked.pdf', {
      type: 'application/pdf',
    });
    const reservationError = new Error('cleanup database unavailable');

    await expect(
      uploadS3File(file, {
        onKeyAllocated: async () => await Promise.reject(reservationError),
      }),
    ).rejects.toBe(reservationError);

    expect(capturedRequests).toHaveLength(0);
  });

  it('counts a delayed successful reservation against the absolute upload deadline', async () => {
    const file = new File([Buffer.from('%PDF-1.7\nreservation-delayed\n')], 'delayed.pdf', {
      type: 'application/pdf',
    });
    const dateNow = vi
      .spyOn(Date, 'now')
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_101);

    try {
      await expect(
        uploadS3File(file, {
          onKeyAllocated: async () => await Promise.resolve(),
          requestTimeoutMs: 100,
        }),
      ).rejects.toThrow('S3 upload exceeded its request deadline');
    } finally {
      dateNow.mockRestore();
    }

    expect(capturedRequests).toHaveLength(0);
  });

  it('aborts a hung reserved PutObject before its cleanup grace can expire', async () => {
    const file = new File([Buffer.from('%PDF-1.7\nhung\n')], 'hung.pdf', {
      type: 'application/pdf',
    });
    let isReserved = false;

    await expect(
      uploadS3File(file, {
        onKeyAllocated: async () => {
          await Promise.resolve();
          isReserved = true;
        },
        requestTimeoutMs: 100,
      }),
    ).rejects.toMatchObject({
      name: 'AbortError',
    });

    expect(isReserved).toBe(true);
    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0]).toMatchObject({
      method: 'PUT',
    });
  });

  it('bounds cleanup DeleteObject without changing generic delete callers', async () => {
    await expect(
      deleteS3File('hung-delete.pdf', {
        requestTimeoutMs: 100,
      }),
    ).rejects.toMatchObject({
      name: 'AbortError',
    });

    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0]).toMatchObject({
      method: 'DELETE',
    });
  });
});
