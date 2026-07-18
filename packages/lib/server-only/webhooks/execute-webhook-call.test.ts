import { Prisma } from '@prisma/client';
import { createPrivateKey } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:https';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { VettedWebhookTarget } from './assert-webhook-url';
import {
  MAX_WEBHOOK_RESPONSE_BYTES,
  buildPinnedWebhookRequestOptions,
  executeWebhookCall,
  requestVettedWebhookTarget,
} from './execute-webhook-call';
import {
  WEBHOOK_TEST_CA,
  WEBHOOK_TEST_CERTIFICATE,
  WEBHOOK_TEST_PRIVATE_KEY_DER_BASE64,
} from './webhook-https-test-fixture';

const WEBHOOK_TEST_PRIVATE_KEY = createPrivateKey({
  key: Buffer.from(WEBHOOK_TEST_PRIVATE_KEY_DER_BASE64.replace(/\s/g, ''), 'base64'),
  format: 'der',
  type: 'pkcs8',
});
const WEBHOOK_TEST_PRIVATE_KEY_PEM = WEBHOOK_TEST_PRIVATE_KEY.export({
  format: 'pem',
  type: 'pkcs8',
});

const mocks = vi.hoisted(() => ({
  resolveTarget: vi.fn(),
  requestTarget: vi.fn(),
}));

const executeTestWebhookCall = async (options: Parameters<typeof executeWebhookCall>[0]) =>
  await executeWebhookCall(options, {
    resolveTarget: mocks.resolveTarget,
    requestTarget: mocks.requestTarget,
  });

describe('executeWebhookCall response persistence boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveTarget.mockResolvedValue({
      url: new URL('https://receiver.example.test/webhook'),
      normalizedHostname: 'receiver.example.test',
      address: { address: '93.184.216.34', family: 4 },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('persists only allowlisted bounded headers and redacts reflected secrets', async () => {
    mocks.requestTarget.mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          nested: {
            authorization: 'Bearer reflected',
            'x-documenso-secret': 'provider-secret',
            note: 'provider-secret appeared in text',
          },
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'x-request-id': 'request-provider-secret-123',
            authorization: 'Bearer reflected',
            'set-cookie': 'session=reflected',
            'x-documenso-secret': 'provider-secret',
            'x-untrusted': 'not persisted',
          },
        },
      ),
    );

    const result = await executeTestWebhookCall({
      url: 'https://receiver.example.test/webhook',
      body: { event: 'DOCUMENT_COMPLETED' },
      secret: 'provider-secret',
    });

    expect(result).toMatchObject({
      success: true,
      responseCode: 200,
      responseHeaders: {
        'content-type': 'application/json',
        'x-request-id': 'request-[REDACTED]-123',
      },
      responseBody: {
        ok: true,
        nested: {
          authorization: '[REDACTED]',
          'x-documenso-secret': '[REDACTED]',
          note: '[REDACTED] appeared in text',
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain('provider-secret');
    expect(result.responseHeaders).not.toHaveProperty('authorization');
    expect(result.responseHeaders).not.toHaveProperty('set-cookie');
    expect(result.responseHeaders).not.toHaveProperty('x-documenso-secret');
    expect(result.responseHeaders).not.toHaveProperty('x-untrusted');
  });

  it('accepts a response body at the exact byte limit', async () => {
    const body = 'a'.repeat(MAX_WEBHOOK_RESPONSE_BYTES);
    mocks.requestTarget.mockResolvedValue(
      new Response(body, {
        status: 200,
        headers: {
          'content-length': String(MAX_WEBHOOK_RESPONSE_BYTES),
        },
      }),
    );

    const result = await executeTestWebhookCall({
      url: 'https://receiver.example.test/webhook',
      body: {},
      secret: null,
    });

    expect(result.success).toBe(true);
    expect(result.responseBody).toBe(body);
  });

  it('stores top-level JSON null with Prisma semantics while preserving nested nulls', async () => {
    mocks.requestTarget
      .mockResolvedValueOnce(
        new Response('null', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response('{"nested":null}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

    const topLevel = await executeTestWebhookCall({
      url: 'https://receiver.example.test/webhook',
      body: {},
      secret: null,
    });
    const nested = await executeTestWebhookCall({
      url: 'https://receiver.example.test/webhook',
      body: {},
      secret: null,
    });

    expect(topLevel.responseBody).toBe(Prisma.JsonNull);
    expect(nested.responseBody).toEqual({ nested: null });
  });

  it.each([
    { label: 'declared', contentLength: String(MAX_WEBHOOK_RESPONSE_BYTES + 1) },
    { label: 'lying', contentLength: '1' },
  ])('does not persist a $label oversized response body', async ({ contentLength }) => {
    mocks.requestTarget.mockResolvedValue(
      new Response('a'.repeat(MAX_WEBHOOK_RESPONSE_BYTES + 1), {
        status: 200,
        headers: {
          'content-length': contentLength,
        },
      }),
    );

    const result = await executeTestWebhookCall({
      url: 'https://receiver.example.test/webhook',
      body: {},
      secret: null,
    });

    expect(result).toMatchObject({
      success: true,
      responseCode: 200,
      responseBody: {
        truncated: true,
      },
    });
    expect(JSON.stringify(result.responseBody).length).toBeLessThan(256);
  });

  it('times out a stalled response body and persists only a fixed error', async () => {
    vi.useFakeTimers();
    mocks.requestTarget.mockResolvedValue(
      new Response(
        new ReadableStream({
          pull: async () => {
            await new Promise<void>(() => {
              // Intentionally never resolves: the webhook deadline must cancel it.
            });
          },
        }),
        { status: 200 },
      ),
    );

    const resultPromise = executeTestWebhookCall({
      url: 'https://receiver.example.test/webhook',
      body: {},
      secret: 'provider-secret',
    });

    await vi.advanceTimersByTimeAsync(10_000);
    const result = await resultPromise;

    expect(result).toEqual({
      success: false,
      responseCode: 0,
      responseBody: 'Webhook request failed or timed out',
      responseHeaders: {},
    });
  });

  it('never opens a request when fail-closed resolution fails', async () => {
    mocks.resolveTarget.mockRejectedValueOnce(new Error('DNS resolution failed'));

    const result = await executeTestWebhookCall({
      url: 'https://receiver.example.test/webhook',
      body: {},
      secret: null,
    });

    expect(result).toEqual({
      success: false,
      responseCode: 0,
      responseBody: 'Webhook request failed or timed out',
      responseHeaders: {},
    });
    expect(mocks.requestTarget).not.toHaveBeenCalled();
  });
});

describe('pinned webhook transport options', () => {
  it('preserves the original TLS hostname while returning only the vetted address', async () => {
    const controller = new AbortController();
    const options = buildPinnedWebhookRequestOptions(
      {
        url: new URL('https://receiver.example.test:8443/webhook'),
        normalizedHostname: 'receiver.example.test',
        address: { address: '93.184.216.34', family: 4 },
      },
      controller.signal,
      'secret',
    );

    expect(options.agent).toBe(false);
    expect(options.rejectUnauthorized).toBe(true);
    expect(options.servername).toBe('receiver.example.test');
    expect(options.headers).toMatchObject({ Connection: 'close' });

    const resolved = await new Promise<{ address: string; family: number }>((resolve, reject) => {
      options.lookup?.(
        'receiver.example.test',
        { all: false, verbatim: true },
        (error, address, family) => {
          if (error) {
            reject(error);
            return;
          }

          if (typeof address !== 'string') {
            reject(new Error('Expected a single pinned address'));
            return;
          }

          resolve({ address, family: family ?? 0 });
        },
      );
    });

    expect(resolved).toEqual({ address: '93.184.216.34', family: 4 });
  });

  it('rejects an unexpected socket lookup hostname instead of resolving it ambiently', async () => {
    const options = buildPinnedWebhookRequestOptions(
      {
        url: new URL('https://receiver.example.test/webhook'),
        normalizedHostname: 'receiver.example.test',
        address: { address: '93.184.216.34', family: 4 },
      },
      new AbortController().signal,
      null,
    );

    const error = await new Promise<Error | null>((resolve) => {
      options.lookup?.('rebound.internal', { all: false, verbatim: true }, (lookupError) =>
        resolve(lookupError),
      );
    });

    expect(error).toMatchObject({ code: 'EPERM' });
  });
});

describe('pinned HTTPS webhook transport', () => {
  it('uses the vetted IP while preserving Host, SNI, certificate verification, and cleanup', async () => {
    const observed = {
      host: '',
      servername: '',
    };
    const sockets = new Set<import('node:net').Socket>();
    const server = createServer({
      key: WEBHOOK_TEST_PRIVATE_KEY_PEM,
      cert: WEBHOOK_TEST_CERTIFICATE,
    });

    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    server.on('secureConnection', (socket) => {
      observed.servername = socket.servername;
    });
    server.on('request', (request, response) => {
      observed.host = request.headers.host ?? '';
      request.resume();
      response.writeHead(204);
      response.end();
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });

    try {
      const address = server.address();

      if (!address || typeof address === 'string') {
        throw new Error('Expected HTTPS server to listen on a TCP address');
      }

      const port = address.port;
      const response = await requestVettedWebhookTarget(
        {
          url: new URL(`https://webhook.test:${port}/callback`),
          normalizedHostname: 'webhook.test',
          address: { address: '127.0.0.1', family: 4 },
        },
        '{"event":"DOCUMENT_COMPLETED"}',
        'secret',
        new AbortController().signal,
        { ca: WEBHOOK_TEST_CA },
      );

      expect(response.status).toBe(204);
      expect(response.body).toBeNull();
      expect(observed).toEqual({
        host: `webhook.test:${port}`,
        servername: 'webhook.test',
      });

      await expect(
        requestVettedWebhookTarget(
          {
            url: new URL(`https://wrong-host.test:${port}/callback`),
            normalizedHostname: 'wrong-host.test',
            address: { address: '127.0.0.1', family: 4 },
          },
          '{}',
          null,
          new AbortController().signal,
          { ca: WEBHOOK_TEST_CA },
        ),
      ).rejects.toThrow(/not cert's altnames|hostname/i);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }

    await vi.waitFor(() => expect(sockets.size).toBe(0), { timeout: 1_000 });
  });
});

describe('pinned transport response backpressure', () => {
  it('cancels a large chunked response at the persistence boundary and closes the socket', async () => {
    const sockets = new Set<import('node:net').Socket>();
    const server = createHttpServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });

      let chunksWritten = 0;
      const writeChunk = () => {
        while (chunksWritten < 256) {
          chunksWritten += 1;
          if (!response.write(Buffer.alloc(8 * 1024, 'a'))) {
            response.once('drain', writeChunk);
            return;
          }
        }

        response.end();
      };

      writeChunk();
    });

    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });

    try {
      const address = server.address();

      if (!address || typeof address === 'string') {
        throw new Error('Expected HTTP server to listen on a TCP address');
      }

      const port = address.port;
      const target: VettedWebhookTarget = {
        url: new URL(`http://webhook.test:${port}/chunked`),
        normalizedHostname: 'webhook.test',
        address: { address: '127.0.0.1', family: 4 },
      };
      mocks.resolveTarget.mockResolvedValue(target);
      const result = await executeWebhookCall(
        {
          url: target.url.toString(),
          body: {},
          secret: null,
        },
        {
          resolveTarget: mocks.resolveTarget,
          requestTarget: requestVettedWebhookTarget,
        },
      );

      expect(result).toMatchObject({
        success: true,
        responseCode: 200,
        responseBody: {
          truncated: true,
        },
      });
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }

    await vi.waitFor(() => expect(sockets.size).toBe(0), { timeout: 1_000 });
  });
});
