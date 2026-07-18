import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import slugify from '@sindresorhus/slugify';
import path from 'node:path';

import { env } from '@documenso/lib/utils/env';

import { ONE_HOUR, ONE_SECOND } from '../../constants/time';
import { alphaid } from '../id';

export const getPresignPostUrl = async (fileName: string, contentType: string, userId?: number) => {
  const client = getS3Client();

  const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');

  // Get the basename and extension for the file
  const { name, ext } = path.parse(fileName);

  let slugified = slugify(name);

  // If the slugified name is empty or too long, generate a random string instead
  //
  // This is fine since we don't really need the filename in s3 since we store it
  // in the database and can always get the original filename from there.
  //
  // The slugified name can be empty when a string contains only CJK or other
  // special characters.
  if (slugified.length === 0 || slugified.length > 100) {
    slugified = alphaid(8);
  }

  let key = `${alphaid(12)}/${slugified}${ext}`;

  if (userId) {
    key = `${userId}/${key}`;
  }

  const putObjectCommand = new PutObjectCommand({
    Bucket: env('NEXT_PRIVATE_UPLOAD_BUCKET'),
    Key: key,
    ContentType: contentType,
  });

  const url = await getSignedUrl(client, putObjectCommand, {
    expiresIn: ONE_HOUR / ONE_SECOND,
  });

  return { key, url };
};

export const getAbsolutePresignPostUrl = async (key: string) => {
  const client = getS3Client();

  const { getSignedUrl: getS3SignedUrl } = await import('@aws-sdk/s3-request-presigner');

  const putObjectCommand = new PutObjectCommand({
    Bucket: env('NEXT_PRIVATE_UPLOAD_BUCKET'),
    Key: key,
  });

  const url = await getS3SignedUrl(client, putObjectCommand, {
    expiresIn: ONE_HOUR / ONE_SECOND,
  });

  return { key, url };
};

export const getPresignGetUrl = async (key: string) => {
  if (env('NEXT_PRIVATE_UPLOAD_DISTRIBUTION_DOMAIN')) {
    const distributionUrl = new URL(key, `${env('NEXT_PRIVATE_UPLOAD_DISTRIBUTION_DOMAIN')}`);

    const { getSignedUrl: getCloudfrontSignedUrl } = await import('@aws-sdk/cloudfront-signer');

    const url = getCloudfrontSignedUrl({
      url: distributionUrl.toString(),
      keyPairId: `${env('NEXT_PRIVATE_UPLOAD_DISTRIBUTION_KEY_ID')}`,
      privateKey: `${env('NEXT_PRIVATE_UPLOAD_DISTRIBUTION_KEY_CONTENTS')}`,
      dateLessThan: new Date(Date.now() + ONE_HOUR).toISOString(),
    });

    return { key, url };
  }

  const client = getS3Client();

  const { getSignedUrl: getS3SignedUrl } = await import('@aws-sdk/s3-request-presigner');

  const getObjectCommand = new GetObjectCommand({
    Bucket: env('NEXT_PRIVATE_UPLOAD_BUCKET'),
    Key: key,
  });

  const url = await getS3SignedUrl(client, getObjectCommand, {
    expiresIn: ONE_HOUR / ONE_SECOND,
  });

  return { key, url };
};

/**
 * Uploads a file to S3.
 */
export const uploadS3File = async (
  file: File,
  options: {
    onKeyAllocated?: (key: string) => Promise<void>;
    requestTimeoutMs?: number;
  } = {},
) => {
  const client = getS3Client();

  // Get the basename and extension for the file
  const { name, ext } = path.parse(file.name);

  const key = `${alphaid(12)}/${slugify(name)}${ext}`;

  await options.onKeyAllocated?.(key);

  const uploadStartedAt = Date.now();
  const fileBuffer = await file.arrayBuffer();
  const remainingTimeoutMs = options.requestTimeoutMs
    ? options.requestTimeoutMs - (Date.now() - uploadStartedAt)
    : undefined;

  if (remainingTimeoutMs !== undefined && remainingTimeoutMs <= 0) {
    throw new Error('S3 upload exceeded its request deadline');
  }

  const abortController = remainingTimeoutMs !== undefined ? new AbortController() : undefined;
  const timeout = abortController
    ? setTimeout(() => abortController.abort(), remainingTimeoutMs)
    : undefined;
  const putObjectCommand = new PutObjectCommand({
    Bucket: env('NEXT_PRIVATE_UPLOAD_BUCKET'),
    Key: key,
    Body: Buffer.from(fileBuffer),
    ContentType: file.type,
  });

  try {
    const response = abortController
      ? await client.send(putObjectCommand, {
          abortSignal: abortController.signal,
        })
      : await client.send(putObjectCommand);

    return { key, response };
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
};

export const deleteS3File = async (
  key: string,
  options: {
    requestTimeoutMs?: number;
  } = {},
) => {
  const client = getS3Client();
  const abortController = options.requestTimeoutMs ? new AbortController() : undefined;
  const timeout = abortController
    ? setTimeout(() => abortController.abort(), options.requestTimeoutMs)
    : undefined;
  const deleteObjectCommand = new DeleteObjectCommand({
    Bucket: env('NEXT_PRIVATE_UPLOAD_BUCKET'),
    Key: key,
  });

  try {
    if (abortController) {
      await client.send(deleteObjectCommand, {
        abortSignal: abortController.signal,
      });
    } else {
      await client.send(deleteObjectCommand);
    }
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
};

const getS3Client = () => {
  const NEXT_PUBLIC_UPLOAD_TRANSPORT = env('NEXT_PUBLIC_UPLOAD_TRANSPORT');

  if (NEXT_PUBLIC_UPLOAD_TRANSPORT !== 's3') {
    throw new Error('Invalid upload transport');
  }

  const hasCredentials =
    env('NEXT_PRIVATE_UPLOAD_ACCESS_KEY_ID') && env('NEXT_PRIVATE_UPLOAD_SECRET_ACCESS_KEY');

  return new S3Client({
    endpoint: env('NEXT_PRIVATE_UPLOAD_ENDPOINT') || undefined,
    forcePathStyle: env('NEXT_PRIVATE_UPLOAD_FORCE_PATH_STYLE') === 'true',
    region: env('NEXT_PRIVATE_UPLOAD_REGION') || 'us-east-1',
    // PutObject checksums are optional. Enabling them only when required keeps
    // a body-less presign from binding the empty CRC32 to a later nonempty
    // upload. Response checksum validation intentionally retains the SDK
    // default so downloads still validate supported object-store checksums.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    credentials: hasCredentials
      ? {
          accessKeyId: String(env('NEXT_PRIVATE_UPLOAD_ACCESS_KEY_ID')),
          secretAccessKey: String(env('NEXT_PRIVATE_UPLOAD_SECRET_ACCESS_KEY')),
        }
      : undefined,
  });
};
