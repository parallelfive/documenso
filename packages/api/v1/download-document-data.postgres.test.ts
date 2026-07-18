import { DocumentDataType } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { prisma } from '@documenso/prisma';

import {
  MAX_SIGNED_DOCUMENT_S3_KEY_BYTES,
  getBoundedStoredDocumentData,
  getStoredDocumentDataMetadata,
} from './download-document-data';

const describeWithPostgres =
  process.env.DOCUMENSO_BOUNDED_LOADER_POSTGRES === '1' ? describe : describe.skip;

describeWithPostgres('bounded document-data SQL against PostgreSQL', () => {
  beforeAll(async () => {
    await prisma.$executeRaw`
      CREATE TYPE "DocumentDataType" AS ENUM ('S3_PATH', 'BYTES', 'BYTES_64')
    `;
    await prisma.$executeRaw`
      CREATE TABLE "DocumentData" (
        "id" text PRIMARY KEY,
        "type" "DocumentDataType" NOT NULL,
        "data" text NOT NULL,
        "initialData" text NOT NULL
      )
    `;

    await prisma.$executeRaw`
      INSERT INTO "DocumentData" ("id", "type", "data", "initialData")
      VALUES
        ('bytes-exact', 'BYTES', '%PDF-', '%PDF-'),
        ('bytes-over', 'BYTES', '%PDF-x', '%PDF-x'),
        ('base64-exact', 'BYTES_64', 'JVBERi0=', 'JVBERi0='),
        ('base64-over', 'BYTES_64', 'JVBERi14', 'JVBERi14'),
        (
          's3-long-key',
          'S3_PATH',
          repeat('k', ${MAX_SIGNED_DOCUMENT_S3_KEY_BYTES + 1}::int),
          repeat('k', ${MAX_SIGNED_DOCUMENT_S3_KEY_BYTES + 1}::int)
        )
    `;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('returns only length/suffix and a bounded S3 key prefix', async () => {
    await expect(getStoredDocumentDataMetadata('bytes-exact')).resolves.toEqual({
      type: DocumentDataType.BYTES,
      encodedLength: 5n,
      base64Suffix: null,
      s3Key: null,
    });
    await expect(getStoredDocumentDataMetadata('base64-exact')).resolves.toEqual({
      type: DocumentDataType.BYTES_64,
      encodedLength: 8n,
      base64Suffix: '0=',
      s3Key: null,
    });

    const s3 = await getStoredDocumentDataMetadata('s3-long-key');
    expect(s3).toMatchObject({
      type: DocumentDataType.S3_PATH,
      encodedLength: BigInt(MAX_SIGNED_DOCUMENT_S3_KEY_BYTES + 1),
    });
    expect(s3?.s3Key).toHaveLength(MAX_SIGNED_DOCUMENT_S3_KEY_BYTES);
  });

  it.each([
    ['bytes-exact', DocumentDataType.BYTES],
    ['base64-exact', DocumentDataType.BYTES_64],
  ])('selects exact-limit %s data', async (id, type) => {
    await expect(getBoundedStoredDocumentData(id, type, 5)).resolves.toMatchObject({
      type,
    });
  });

  it.each([
    ['bytes-over', DocumentDataType.BYTES],
    ['base64-over', DocumentDataType.BYTES_64],
  ])('does not materialize +1 %s data', async (id, type) => {
    await expect(getBoundedStoredDocumentData(id, type, 5)).resolves.toBeNull();
  });

  it('requires the expected storage type in the guarded read', async () => {
    await expect(
      getBoundedStoredDocumentData('bytes-exact', DocumentDataType.BYTES_64, 5),
    ).resolves.toBeNull();
  });
});
