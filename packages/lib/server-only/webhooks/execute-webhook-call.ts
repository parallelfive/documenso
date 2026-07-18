import { Prisma } from '@prisma/client';
import type { IncomingMessage } from 'node:http';
import { request as httpRequest } from 'node:http';
import type { RequestOptions } from 'node:https';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';

import { type VettedWebhookTarget, resolveVettedWebhookTarget } from './assert-webhook-url';

const WEBHOOK_TIMEOUT_MS = 10_000;
export const MAX_WEBHOOK_RESPONSE_BYTES = 64 * 1024;

const SAFE_RESPONSE_HEADER_LIMITS = {
  'content-length': 20,
  'content-type': 256,
  date: 128,
  'retry-after': 128,
  'x-request-id': 128,
} as const;

const SENSITIVE_RESPONSE_KEYS = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
  'set-cookie',
  'x-api-key',
  'x-documenso-secret',
]);

export type WebhookCallResult = {
  success: boolean;
  responseCode: number;
  responseBody: Prisma.InputJsonValue | Prisma.JsonNullValueInput;
  responseHeaders: Record<string, string>;
};

const redactSecret = (value: string, secret: string | null) =>
  secret ? value.split(secret).join('[REDACTED]') : value;

const sanitizeResponseValue = (
  value: unknown,
  secret: string | null,
  depth = 0,
): Prisma.InputJsonValue | null => {
  if (depth > 20) return '[REDACTED: maximum nesting depth]';
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return redactSecret(value, secret);

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeResponseValue(item, secret, depth + 1));
  }

  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        SENSITIVE_RESPONSE_KEYS.has(key.toLowerCase())
          ? '[REDACTED]'
          : sanitizeResponseValue(nested, secret, depth + 1),
      ]),
    );
  }

  return String(value);
};

const parseAndSanitizeBody = (
  text: string,
  secret: string | null,
): Prisma.InputJsonValue | Prisma.JsonNullValueInput => {
  const redactedText = redactSecret(text, secret);

  try {
    const sanitized = sanitizeResponseValue(JSON.parse(redactedText), secret);
    return sanitized === null ? Prisma.JsonNull : sanitized;
  } catch {
    return redactedText;
  }
};

export const getSafeWebhookResponseHeaders = (
  headers: Headers,
  secret: string | null,
): Record<string, string> => {
  const safeHeaders: Record<string, string> = {};

  for (const [name, maxLength] of Object.entries(SAFE_RESPONSE_HEADER_LIMITS)) {
    const value = headers.get(name);
    if (value !== null && value.length <= maxLength) {
      safeHeaders[name] = redactSecret(value, secret);
    }
  }

  return safeHeaders;
};

const readWithAbort = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
) => {
  if (signal.aborted) throw new Error('Webhook request timed out');

  return await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
    const onAbort = () => reject(new Error('Webhook request timed out'));
    signal.addEventListener('abort', onAbort, { once: true });

    void reader.read().then(
      (result) => {
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
};

const readBoundedResponseBody = async (
  response: Response,
  signal: AbortSignal,
): Promise<
  | {
      truncated: false;
      text: string;
    }
  | {
      truncated: true;
    }
> => {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const parsedContentLength = Number(contentLength);
    if (Number.isFinite(parsedContentLength) && parsedContentLength > MAX_WEBHOOK_RESPONSE_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      return { truncated: true };
    }
  }

  if (!response.body) {
    return { truncated: false, text: '' };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    let streamComplete = false;
    while (!streamComplete) {
      const { done, value } = await readWithAbort(reader, signal);
      streamComplete = done;
      if (done) continue;
      if (!value) continue;

      totalBytes += value.byteLength;
      if (totalBytes > MAX_WEBHOOK_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        return { truncated: true };
      }

      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return {
    truncated: false,
    text: new TextDecoder().decode(body),
  };
};

const normalizeLookupHostname = (hostname: string) =>
  hostname
    .toLowerCase()
    .replace(/^\[(.*)\]$/, '$1')
    .replace(/\.+$/, '');

export const buildPinnedWebhookRequestOptions = (
  target: VettedWebhookTarget,
  signal: AbortSignal,
  secret: string | null,
  trustedCertificateAuthority?: string | Buffer,
): RequestOptions => ({
  method: 'POST',
  // A fresh socket per call prevents a pooled connection from escaping the
  // address pin. Connection close also makes cleanup explicit after body
  // completion/cancellation.
  agent: false,
  signal,
  rejectUnauthorized: true,
  ca: trustedCertificateAuthority,
  servername: isIP(target.normalizedHostname) === 0 ? target.normalizedHostname : undefined,
  headers: {
    'Content-Type': 'application/json',
    'X-Documenso-Secret': secret ?? '',
    Connection: 'close',
  },
  lookup: (hostname, options, callback) => {
    if (normalizeLookupHostname(hostname) !== target.normalizedHostname) {
      const error = Object.assign(new Error('Unexpected webhook socket lookup hostname'), {
        code: 'EPERM',
      });
      callback(error, '', 0);
      return;
    }

    if (options.all) {
      callback(null, [target.address]);
      return;
    }

    callback(null, target.address.address, target.address.family);
  },
});

export const requestVettedWebhookTarget = async (
  target: VettedWebhookTarget,
  body: string,
  secret: string | null,
  signal: AbortSignal,
  transportOptions?: {
    ca?: string | Buffer;
  },
): Promise<Response> =>
  await new Promise<Response>((resolve, reject) => {
    const request = target.url.protocol === 'https:' ? httpsRequest : httpRequest;
    const requestOptions = buildPinnedWebhookRequestOptions(
      target,
      signal,
      secret,
      transportOptions?.ca,
    );

    const clientRequest = request(target.url, requestOptions, (incoming: IncomingMessage) => {
      try {
        const headers = new Headers();

        for (const [name, value] of Object.entries(incoming.headers)) {
          if (Array.isArray(value)) {
            value.forEach((item) => headers.append(name, item));
          } else if (value !== undefined) {
            headers.set(name, value);
          }
        }

        const status = incoming.statusCode ?? 500;
        const hasNoResponseBody = status === 204 || status === 205 || status === 304;
        // Node's adapter preserves backpressure and propagates cancellation to
        // IncomingMessage. The DOM and Node stream declarations differ only in
        // their closed-promise typing in this TypeScript version.
        let responseBody: ReadableStream<Uint8Array> | null = null;

        if (!hasNoResponseBody) {
          // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
          responseBody = Readable.toWeb(incoming) as unknown as ReadableStream<Uint8Array>;
        }

        if (hasNoResponseBody) {
          incoming.resume();
        }

        resolve(
          new Response(responseBody, {
            status,
            statusText: incoming.statusMessage,
            headers,
          }),
        );
      } catch (error) {
        incoming.destroy();
        reject(error);
      }
    });

    clientRequest.once('error', reject);
    clientRequest.end(body);
  });

type ExecuteWebhookCallDependencies = {
  resolveTarget: typeof resolveVettedWebhookTarget;
  requestTarget: typeof requestVettedWebhookTarget;
};

const defaultDependencies: ExecuteWebhookCallDependencies = {
  resolveTarget: resolveVettedWebhookTarget,
  requestTarget: requestVettedWebhookTarget,
};

export const executeWebhookCall = async (
  options: {
    url: string;
    body: unknown;
    secret: string | null;
  },
  dependencies: ExecuteWebhookCallDependencies = defaultDependencies,
): Promise<WebhookCallResult> => {
  const { url, body, secret } = options;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);

  try {
    const target = await dependencies.resolveTarget(url);
    const response = await dependencies.requestTarget(
      target,
      JSON.stringify(body),
      secret,
      controller.signal,
    );

    const boundedBody = await readBoundedResponseBody(response, controller.signal);

    return {
      success: response.ok,
      responseCode: response.status,
      responseBody: boundedBody.truncated
        ? {
            truncated: true,
            reason: `Response exceeded ${MAX_WEBHOOK_RESPONSE_BYTES}-byte persistence limit`,
          }
        : parseAndSanitizeBody(boundedBody.text, secret),
      responseHeaders: getSafeWebhookResponseHeaders(response.headers, secret),
    };
  } catch {
    return {
      success: false,
      responseCode: 0,
      responseBody: 'Webhook request failed or timed out',
      responseHeaders: {},
    };
  } finally {
    clearTimeout(timeout);
  }
};
