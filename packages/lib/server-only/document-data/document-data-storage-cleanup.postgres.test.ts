import { DocumentDataType } from '@prisma/client';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { prisma } from '@documenso/prisma';

import { processDocumentDataStorageCleanup } from './process-document-data-storage-cleanup';
import {
  createProvisionalInternalDocumentData,
  reserveInternalSnapshotStorageCleanup,
} from './stage-document-data-storage-cleanup';

const describeWithPostgres =
  process.env.DOCUMENSO_STORAGE_CLEANUP_POSTGRES === '1' ? describe.sequential : describe.skip;

describeWithPostgres('document-data cleanup outbox against PostgreSQL and S3 transport', () => {
  const storedObjects = new Set<string>();
  const deleteRequests: string[] = [];
  const databaseClient = new Client({
    connectionString: process.env.NEXT_PRIVATE_DATABASE_URL,
  });
  let objectStore: Server;

  beforeAll(async () => {
    await databaseClient.connect();
    await databaseClient.query(`
      CREATE TYPE "DocumentDataType" AS ENUM ('S3_PATH', 'BYTES', 'BYTES_64');

      CREATE TABLE "DocumentData" (
        "id" TEXT PRIMARY KEY,
        "type" "DocumentDataType" NOT NULL,
        "data" TEXT NOT NULL,
        "initialData" TEXT NOT NULL
      );

      CREATE TABLE "EnvelopeItem" (
        "id" TEXT PRIMARY KEY,
        "documentDataId" TEXT NOT NULL UNIQUE
      );

      INSERT INTO "DocumentData" ("id", "type", "data", "initialData")
      VALUES
        ('orphan-s3', 'S3_PATH', 'orphan/current.pdf', 'orphan/original.pdf'),
        ('orphan-s3-duplicate', 'S3_PATH', 'orphan/current.pdf', 'orphan/current.pdf'),
        ('live-s3', 'S3_PATH', 'live/current.pdf', 'shared/original.pdf'),
        ('orphan-shared', 'S3_PATH', 'shared/original.pdf', 'shared/original.pdf'),
        ('orphan-bytes', 'BYTES_64', 'SECRET_BASE64_PDF', 'SECRET_BASE64_PDF');

      INSERT INTO "EnvelopeItem" ("id", "documentDataId")
      VALUES ('live-item', 'live-s3');
    `);

    const migration = await readFile(
      new URL(
        '../../../prisma/migrations/20260718010000_add_document_data_storage_cleanup/migration.sql',
        import.meta.url,
      ),
      'utf8',
    );

    await databaseClient.query(migration);

    objectStore = createServer((request, response) => {
      if (request.method !== 'DELETE' || !request.url) {
        response.writeHead(405);
        response.end();
        return;
      }

      const pathname = new URL(request.url, 'http://object-store.test').pathname;
      const bucketPrefix = '/documenso-documents/';
      const key = decodeURIComponent(pathname.slice(bucketPrefix.length));

      deleteRequests.push(key);
      storedObjects.delete(key);

      response.writeHead(204, {
        'x-amz-request-id': 'cleanup-test',
      });
      response.end();
    });

    await new Promise<void>((resolve, reject) => {
      objectStore.once('error', reject);
      objectStore.listen(0, '127.0.0.1', resolve);
    });

    const address = objectStore.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to bind cleanup test object store');
    }

    process.env.NEXT_PUBLIC_UPLOAD_TRANSPORT = 's3';
    process.env.NEXT_PRIVATE_UPLOAD_ENDPOINT = `http://127.0.0.1:${address.port}`;
    process.env.NEXT_PRIVATE_UPLOAD_FORCE_PATH_STYLE = 'true';
    process.env.NEXT_PRIVATE_UPLOAD_REGION = 'us-east-1';
    process.env.NEXT_PRIVATE_UPLOAD_BUCKET = 'documenso-documents';
    process.env.NEXT_PRIVATE_UPLOAD_ACCESS_KEY_ID = 'cleanup-test-access';
    process.env.NEXT_PRIVATE_UPLOAD_SECRET_ACCESS_KEY = 'cleanup-test-secret';
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await databaseClient.end();
    await new Promise<void>((resolve, reject) => {
      objectStore.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it('backfills unique orphan S3 keys, skips live-shared keys, and never copies BYTES content', async () => {
    const documentData = await databaseClient.query<{
      id: string;
      data: string;
    }>(`SELECT "id", "data" FROM "DocumentData" ORDER BY "id"`);
    const cleanupTasks = await databaseClient.query<{
      key: string;
      notBefore: Date;
    }>(
      `SELECT "key", "notBefore" FROM "DocumentDataStorageCleanup" ORDER BY "key"`,
    );

    expect(documentData.rows).toEqual([{ id: 'live-s3', data: 'live/current.pdf' }]);
    expect(cleanupTasks.rows.map(({ key }) => key)).toEqual([
      'orphan/current.pdf',
      'orphan/original.pdf',
    ]);
    expect(cleanupTasks.rows.every(({ notBefore }) => notBefore > new Date())).toBe(true);
    expect(JSON.stringify(cleanupTasks.rows)).not.toContain('SECRET_BASE64_PDF');
    expect(cleanupTasks.rows.map(({ key }) => key)).not.toContain('shared/original.pdf');
  });

  it('early-deletes backfilled objects, retains replay protection, then finally acknowledges', async () => {
    storedObjects.add('orphan/current.pdf');
    storedObjects.add('orphan/original.pdf');
    storedObjects.add('shared/original.pdf');

    await expect(processDocumentDataStorageCleanup()).resolves.toMatchObject({
      selectedCount: 2,
      objectDeleteCount: 2,
      acknowledgedCount: 0,
      failedCount: 0,
    });

    expect(storedObjects.has('orphan/current.pdf')).toBe(false);
    expect(storedObjects.has('orphan/original.pdf')).toBe(false);
    expect(storedObjects.has('shared/original.pdf')).toBe(true);

    const retainedTasks = await prisma.documentDataStorageCleanup.findMany();
    expect(retainedTasks).toHaveLength(2);
    expect(retainedTasks.every(({ earlyDeleteAttemptedAt }) => earlyDeleteAttemptedAt !== null)).toBe(
      true,
    );

    // Recreate one object as a still-valid presigned PUT could do.
    storedObjects.add('orphan/current.pdf');
    await databaseClient.query(
      `UPDATE "DocumentDataStorageCleanup" SET "notBefore" = CURRENT_TIMESTAMP - INTERVAL '1 second'`,
    );

    await expect(processDocumentDataStorageCleanup()).resolves.toMatchObject({
      selectedCount: 2,
      objectDeleteCount: 2,
      acknowledgedCount: 2,
      failedCount: 0,
    });

    expect(storedObjects.has('orphan/current.pdf')).toBe(false);
    await expect(prisma.documentDataStorageCleanup.count()).resolves.toBe(0);
  });

  it('recovers a crash before PutObject and a crash after provisional metadata binding', async () => {
    await reserveInternalSnapshotStorageCleanup({ key: 'snapshot/before-put.pdf' });
    await databaseClient.query(
      `UPDATE "DocumentDataStorageCleanup" SET "notBefore" = CURRENT_TIMESTAMP - INTERVAL '1 second'`,
    );

    await expect(processDocumentDataStorageCleanup()).resolves.toMatchObject({
      selectedCount: 1,
      acknowledgedCount: 1,
      failedCount: 0,
    });
    expect(deleteRequests).toContain('snapshot/before-put.pdf');

    await reserveInternalSnapshotStorageCleanup({ key: 'snapshot/after-bind.pdf' });
    const provisionalDocumentData = await createProvisionalInternalDocumentData({
      type: DocumentDataType.S3_PATH,
      data: 'snapshot/after-bind.pdf',
    });
    storedObjects.add('snapshot/after-bind.pdf');
    await databaseClient.query(
      `UPDATE "DocumentDataStorageCleanup" SET "notBefore" = CURRENT_TIMESTAMP - INTERVAL '1 second'`,
    );

    await expect(processDocumentDataStorageCleanup()).resolves.toMatchObject({
      selectedCount: 1,
      objectDeleteCount: 1,
      acknowledgedCount: 1,
      failedCount: 0,
    });

    expect(storedObjects.has('snapshot/after-bind.pdf')).toBe(false);
    await expect(
      prisma.documentData.findUnique({
        where: {
          id: provisionalDocumentData.id,
        },
      }),
    ).resolves.toBeNull();
    await expect(prisma.documentDataStorageCleanup.count()).resolves.toBe(0);
  });

  it('cancels a stale cleanup intent instead of deleting a newly attached key', async () => {
    await reserveInternalSnapshotStorageCleanup({ key: 'snapshot/attached.pdf' });
    const attachedDocumentData = await createProvisionalInternalDocumentData({
      type: DocumentDataType.S3_PATH,
      data: 'snapshot/attached.pdf',
    });
    storedObjects.add('snapshot/attached.pdf');
    await databaseClient.query(
      `INSERT INTO "EnvelopeItem" ("id", "documentDataId") VALUES ($1, $2)`,
      ['attached-item', attachedDocumentData.id],
    );
    await databaseClient.query(
      `UPDATE "DocumentDataStorageCleanup" SET "notBefore" = CURRENT_TIMESTAMP - INTERVAL '1 second'`,
    );

    await expect(processDocumentDataStorageCleanup()).resolves.toMatchObject({
      selectedCount: 1,
      objectDeleteCount: 0,
      acknowledgedCount: 0,
      cancelledCount: 1,
      failedCount: 0,
    });

    expect(storedObjects.has('snapshot/attached.pdf')).toBe(true);
    await expect(
      prisma.documentData.findUnique({
        where: {
          id: attachedDocumentData.id,
        },
      }),
    ).resolves.not.toBeNull();
    await expect(prisma.documentDataStorageCleanup.count()).resolves.toBe(0);

    await databaseClient.query(`DELETE FROM "EnvelopeItem" WHERE "id" = 'attached-item'`);
    await prisma.documentData.delete({ where: { id: attachedDocumentData.id } });
    storedObjects.delete('snapshot/attached.pdf');
  });
});
