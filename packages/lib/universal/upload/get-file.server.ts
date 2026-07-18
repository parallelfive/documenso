import { DocumentDataType } from '@prisma/client';
import { base64 } from '@scure/base';
import { match } from 'ts-pattern';

import { getPresignGetUrl } from './server-actions';

export type GetFileOptions = {
  type: DocumentDataType;
  data: string;
};

export type GetFileReadLimits = {
  /**
   * Maximum decoded bytes. Omit to preserve the historical unbounded behavior
   * for existing internal callers.
   */
  maxBytes?: number;
  /**
   * Optional end-to-end timeout for the presigned object-store request,
   * including response-body streaming.
   */
  timeoutMs?: number;
};

export class FileSizeLimitExceededError extends Error {
  constructor() {
    super('File exceeds the configured size limit');
    this.name = 'FileSizeLimitExceededError';
  }
}

export const getFileServerSide = async (
  { type, data }: GetFileOptions,
  limits: GetFileReadLimits = {},
) => {
  validateLimits(limits);

  return await match(type)
    .with(DocumentDataType.BYTES, () => getFileFromBytes(data, limits.maxBytes))
    .with(DocumentDataType.BYTES_64, () => getFileFromBytes64(data, limits.maxBytes))
    .with(DocumentDataType.S3_PATH, async () => getFileFromS3(data, limits))
    .exhaustive();
};

const getFileFromBytes = (data: string, maxBytes?: number) => {
  if (maxBytes !== undefined && Buffer.byteLength(data, 'utf8') > maxBytes) {
    throw new FileSizeLimitExceededError();
  }

  const encoder = new TextEncoder();

  const binaryData = encoder.encode(data);

  return binaryData;
};

const getFileFromBytes64 = (data: string, maxBytes?: number) => {
  if (maxBytes !== undefined && decodedBase64ByteLength(data) > maxBytes) {
    throw new FileSizeLimitExceededError();
  }

  const binaryData = base64.decode(data);

  return binaryData;
};

const getFileFromS3 = async (key: string, limits: GetFileReadLimits) => {
  const { url } = await getPresignGetUrl(key);
  const controller = new AbortController();
  const timeout =
    limits.timeoutMs === undefined
      ? undefined
      : setTimeout(() => controller.abort(), limits.timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Failed to get file "${key}", failed with status code ${response.status}`);
    }

    if (limits.maxBytes === undefined) {
      return new Uint8Array(await response.arrayBuffer());
    }

    const declaredLength = parseContentLength(response.headers.get('content-length'));
    if (declaredLength !== null && declaredLength > limits.maxBytes) {
      await response.body?.cancel();
      throw new FileSizeLimitExceededError();
    }

    if (!response.body) return new Uint8Array();

    return await readBoundedStream(response.body, limits.maxBytes, controller.signal);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
};

const readBoundedStream = async (
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let reading = true;

  try {
    while (reading) {
      const { done, value } = await readWithAbort(reader.read(), signal);
      if (done) {
        reading = false;
        continue;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new FileSizeLimitExceededError();
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }

  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
};

const readWithAbort = async <T>(promise: Promise<T>, signal: AbortSignal): Promise<T> => {
  if (signal.aborted) throw new Error('File download timed out');

  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('File download timed out'));
    signal.addEventListener('abort', onAbort, { once: true });

    void promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
};

const decodedBase64ByteLength = (data: string): number => {
  if (data.length === 0) return 0;
  if (data.length % 4 !== 0) throw new Error('Invalid base64 file data');

  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return (data.length / 4) * 3 - padding;
};

const parseContentLength = (value: string | null): number | null => {
  if (value === null) return null;
  const length = Number(value);
  return Number.isSafeInteger(length) && length >= 0 ? length : null;
};

const validateLimits = ({ maxBytes, timeoutMs }: GetFileReadLimits) => {
  if (
    (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 0)) ||
    (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0))
  ) {
    throw new Error('Invalid file read limits');
  }
};
