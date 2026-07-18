import { DocumentDataType } from '@prisma/client';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { prisma } from '@documenso/prisma';

import { processDocumentDataStorageCleanup } from './process-document-data-storage-cleanup';
import {
  createProvisionalInternalDocumentData,
  DOCUMENT_DATA_STORAGE_TRANSACTION_TIMEOUT_MS,
  lockDocumentDataStorageKeys,
  releaseProvisionalDocumentDataStorageCleanup,
  reserveInternalSnapshotStorageCleanup,
  stageDocumentDataStorageCleanup,
} from './stage-document-data-storage-cleanup';

const describeWithPostgres =
  process.env.DOCUMENSO_STORAGE_CLEANUP_POSTGRES === '1' ? describe.sequential : describe.skip;

describeWithPostgres('document-data cleanup outbox against PostgreSQL and S3 transport', () => {
  const deferred = <T = void>() => {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });

    return { promise, resolve, reject };
  };
  const storedObjects = new Set<string>();
  const deleteRequests: string[] = [];
  const databaseClient = new Client({
    connectionString: process.env.NEXT_PRIVATE_DATABASE_URL,
  });
  let objectStore: Server;
  let deleteBarrier:
    | {
        key: string;
        started: ReturnType<typeof deferred>;
        release: ReturnType<typeof deferred>;
      }
    | undefined;

  const waitForAdvisoryLockWaiter = async () => {
    const deadline = Date.now() + 5_000;

    while (Date.now() < deadline) {
      const waiting = await databaseClient.query<{ count: number }>(`
        SELECT COUNT(*)::int AS count
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND wait_event_type = 'Lock'
          AND wait_event = 'advisory'
      `);

      if ((waiting.rows[0]?.count ?? 0) > 0) {
        return;
      }

      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });
    }

    throw new Error('Timed out waiting for an advisory-lock waiter');
  };

  beforeAll(async () => {
    await databaseClient.connect();
    // Provider migration sessions are not guaranteed to use UTC. Prisma
    // DateTime columns are timestamp-without-time-zone and are decoded as UTC.
    await databaseClient.query(`SET TIME ZONE 'America/New_York'`);
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
      void (async () => {
        if (request.method !== 'DELETE' || !request.url) {
          response.writeHead(405);
          response.end();
          return;
        }

        const pathname = new URL(request.url, 'http://object-store.test').pathname;
        const bucketPrefix = '/documenso-documents/';
        const key = decodeURIComponent(pathname.slice(bucketPrefix.length));

        deleteRequests.push(key);

        if (deleteBarrier?.key === key) {
          deleteBarrier.started.resolve();
          await deleteBarrier.release.promise;
        }

        storedObjects.delete(key);

        response.writeHead(204, {
          'x-amz-request-id': 'cleanup-test',
        });
        response.end();
      })().catch(() => {
        response.destroy();
      });
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
    const storageReferenceIndexes = await databaseClient.query<{
      indexname: string;
      indexdef: string;
    }>(
      `SELECT indexname, indexdef
       FROM pg_indexes
       WHERE schemaname = current_schema()
         AND indexname IN ('DocumentData_s3_path_data_idx', 'DocumentData_s3_path_initialData_idx')
       ORDER BY indexname`,
    );

    expect(documentData.rows).toEqual([{ id: 'live-s3', data: 'live/current.pdf' }]);
    expect(cleanupTasks.rows.map(({ key }) => key)).toEqual([
      'orphan/current.pdf',
      'orphan/original.pdf',
    ]);
    expect(cleanupTasks.rows.every(({ notBefore }) => notBefore > new Date())).toBe(true);
    expect(JSON.stringify(cleanupTasks.rows)).not.toContain('SECRET_BASE64_PDF');
    expect(cleanupTasks.rows.map(({ key }) => key)).not.toContain('shared/original.pdf');
    expect(storageReferenceIndexes.rows.map(({ indexname }) => indexname)).toEqual([
      'DocumentData_s3_path_data_idx',
      'DocumentData_s3_path_initialData_idx',
    ]);
    expect(
      storageReferenceIndexes.rows.every(({ indexdef }) =>
        indexdef.includes(`WHERE (type = 'S3_PATH'::"DocumentDataType")`),
      ),
    ).toBe(true);

    // Give the generic planner a production-shaped cardinality. On the tiny
    // correctness fixture, either one-row partial index is cheap enough to scan
    // and filter, which does not demonstrate the intended lookup plan.
    await databaseClient.query(`
      INSERT INTO "DocumentData" ("id", "type", "data", "initialData")
      SELECT
        'plan-probe-' || probe,
        'S3_PATH',
        'plan/data-' || probe,
        'plan/initial-' || probe
      FROM generate_series(1, 5000) AS probe;
      ANALYZE "DocumentData";
    `);
    await databaseClient.query(`
      SET enable_seqscan = off;
      SET plan_cache_mode = force_generic_plan;
      PREPARE cleanup_reference_probe(text) AS
        SELECT "data", "initialData"
        FROM "DocumentData"
        WHERE "type" = 'S3_PATH'::"DocumentDataType"
          AND "data" IN ($1)
        UNION ALL
        SELECT "data", "initialData"
        FROM "DocumentData"
        WHERE "type" = 'S3_PATH'::"DocumentDataType"
          AND "initialData" IN ($1);
    `);
    const genericReferencePlan = await databaseClient.query(
      `EXPLAIN (FORMAT JSON) EXECUTE cleanup_reference_probe('shared/original.pdf')`,
    );
    await databaseClient.query(`
      DEALLOCATE cleanup_reference_probe;
      RESET plan_cache_mode;
      RESET enable_seqscan;
      DELETE FROM "DocumentData" WHERE "id" LIKE 'plan-probe-%';
      ANALYZE "DocumentData";
    `);

    const genericReferencePlanJson = JSON.stringify(genericReferencePlan.rows);
    expect(genericReferencePlanJson).toContain('DocumentData_s3_path_data_idx');
    expect(genericReferencePlanJson).toContain('DocumentData_s3_path_initialData_idx');
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

  it('serializes both last-reference delete orders into exactly one durable obligation', async () => {
    for (const firstId of ['shared-race-a', 'shared-race-b']) {
      const secondId = firstId === 'shared-race-a' ? 'shared-race-b' : 'shared-race-a';
      const key = `race/${firstId}-first.pdf`;
      await databaseClient.query(
        `INSERT INTO "DocumentData" ("id", "type", "data", "initialData")
         VALUES ($1, 'S3_PATH', $3, $3), ($2, 'S3_PATH', $3, $3)`,
        [firstId, secondId, key],
      );

      const firstHasLock = deferred();
      const releaseFirst = deferred();
      const firstStage = prisma.$transaction(
        async (tx) => {
          await lockDocumentDataStorageKeys({ tx, keys: [key] });
          firstHasLock.resolve();
          await releaseFirst.promise;

          return await stageDocumentDataStorageCleanup({
            tx,
            documentDataIds: [firstId],
          });
        },
        {
          timeout: DOCUMENT_DATA_STORAGE_TRANSACTION_TIMEOUT_MS,
        },
      );

      await firstHasLock.promise;

      const secondStage = prisma.$transaction(
        async (tx) =>
          await stageDocumentDataStorageCleanup({
            tx,
            documentDataIds: [secondId],
          }),
        {
          timeout: DOCUMENT_DATA_STORAGE_TRANSACTION_TIMEOUT_MS,
        },
      );

      await waitForAdvisoryLockWaiter();
      releaseFirst.resolve();

      const [firstCleanupIds, secondCleanupIds] = await Promise.all([firstStage, secondStage]);
      expect(firstCleanupIds).toEqual([]);
      expect(secondCleanupIds).toHaveLength(1);
      await expect(
        prisma.documentData.count({
          where: {
            OR: [{ data: key }, { initialData: key }],
          },
        }),
      ).resolves.toBe(0);
      await expect(
        prisma.documentDataStorageCleanup.count({
          where: {
            key,
          },
        }),
      ).resolves.toBe(1);

      await prisma.documentDataStorageCleanup.delete({
        where: {
          key,
        },
      });
    }
  }, 15_000);

  it('preserves a newly staged generation when an old due worker acknowledges first', async () => {
    const key = 'race/worker-ack-stage.pdf';
    const oldCleanup = await prisma.documentDataStorageCleanup.create({
      data: {
        key,
        notBefore: new Date(Date.now() - 1_000),
      },
    });
    storedObjects.add(key);
    deleteBarrier = {
      key,
      started: deferred(),
      release: deferred(),
    };

    try {
      const worker = processDocumentDataStorageCleanup({
        cleanupIds: [oldCleanup.id],
      });
      await deleteBarrier.started.promise;

      await prisma.documentData.create({
        data: {
          id: 'worker-ack-new-data',
          type: DocumentDataType.S3_PATH,
          data: key,
          initialData: key,
        },
      });
      const newStage = prisma.$transaction(
        async (tx) =>
          await stageDocumentDataStorageCleanup({
            tx,
            documentDataIds: ['worker-ack-new-data'],
            notBefore: new Date(Date.now() + 60_000),
          }),
        {
          timeout: DOCUMENT_DATA_STORAGE_TRANSACTION_TIMEOUT_MS,
        },
      );

      await waitForAdvisoryLockWaiter();
      deleteBarrier.release.resolve();

      await expect(worker).resolves.toMatchObject({
        acknowledgedCount: 1,
        failedCount: 0,
      });
      const newCleanupIds = await newStage;
      expect(newCleanupIds).toHaveLength(1);
      expect(newCleanupIds).not.toContain(oldCleanup.id);

      const retainedCleanup = await prisma.documentDataStorageCleanup.findUnique({
        where: {
          key,
        },
      });
      expect(retainedCleanup).toMatchObject({
        id: newCleanupIds[0],
        earlyDeleteAttemptedAt: null,
      });
    } finally {
      deleteBarrier?.release.resolve();
      deleteBarrier = undefined;
      await prisma.documentDataStorageCleanup.deleteMany({ where: { key } });
      await prisma.documentData.deleteMany({
        where: {
          OR: [{ data: key }, { initialData: key }],
        },
      });
      storedObjects.delete(key);
    }
  }, 15_000);

  it('lets a later stage reset a stale no-live early marker under the same key lock', async () => {
    const key = 'race/worker-early-stage.pdf';
    const selectedNotBefore = new Date(Date.now() + 60_000);
    const extendedNotBefore = new Date(Date.now() + 120_000);
    const cleanup = await prisma.documentDataStorageCleanup.create({
      data: {
        key,
        notBefore: selectedNotBefore,
      },
    });
    storedObjects.add(key);
    deleteBarrier = {
      key,
      started: deferred(),
      release: deferred(),
    };

    try {
      const worker = processDocumentDataStorageCleanup({
        cleanupIds: [cleanup.id],
      });
      await deleteBarrier.started.promise;

      await prisma.documentData.create({
        data: {
          id: 'worker-early-new-data',
          type: DocumentDataType.S3_PATH,
          data: key,
          initialData: key,
        },
      });
      const newStage = prisma.$transaction(
        async (tx) =>
          await stageDocumentDataStorageCleanup({
            tx,
            documentDataIds: ['worker-early-new-data'],
            notBefore: extendedNotBefore,
          }),
        {
          timeout: DOCUMENT_DATA_STORAGE_TRANSACTION_TIMEOUT_MS,
        },
      );

      await waitForAdvisoryLockWaiter();
      deleteBarrier.release.resolve();

      await expect(worker).resolves.toMatchObject({
        objectDeleteCount: 1,
        acknowledgedCount: 0,
        failedCount: 0,
      });
      await expect(newStage).resolves.toEqual([cleanup.id]);

      const retainedCleanup = await prisma.documentDataStorageCleanup.findUniqueOrThrow({
        where: {
          id: cleanup.id,
        },
      });
      expect(retainedCleanup.notBefore.getTime()).toBe(extendedNotBefore.getTime());
      expect(retainedCleanup.earlyDeleteAttemptedAt).toBeNull();
    } finally {
      deleteBarrier?.release.resolve();
      deleteBarrier = undefined;
      await prisma.documentDataStorageCleanup.deleteMany({ where: { key } });
      await prisma.documentData.deleteMany({
        where: {
          OR: [{ data: key }, { initialData: key }],
        },
      });
      storedObjects.delete(key);
    }
  }, 15_000);

  it('serializes provisional attachment against a due cleanup worker in both orders', async () => {
    const attachFirstKey = 'race/provisional-attach-first.pdf';
    await reserveInternalSnapshotStorageCleanup({ key: attachFirstKey });
    const attachFirstData = await createProvisionalInternalDocumentData({
      type: DocumentDataType.S3_PATH,
      data: attachFirstKey,
    });
    storedObjects.add(attachFirstKey);
    await databaseClient.query(
      `UPDATE "DocumentDataStorageCleanup"
       SET "notBefore" = CURRENT_TIMESTAMP - INTERVAL '1 second'
       WHERE "key" = $1`,
      [attachFirstKey],
    );

    const attachHasLock = deferred();
    const releaseAttach = deferred();
    const attachFirst = prisma.$transaction(
      async (tx) => {
        await lockDocumentDataStorageKeys({ tx, keys: [attachFirstKey] });
        attachHasLock.resolve();
        await releaseAttach.promise;
        await releaseProvisionalDocumentDataStorageCleanup({
          tx,
          documentDataId: attachFirstData.id,
        });
        await tx.$executeRaw`
          INSERT INTO "EnvelopeItem" ("id", "documentDataId")
          VALUES ('provisional-attach-first-item', ${attachFirstData.id})
        `;
      },
      {
        timeout: DOCUMENT_DATA_STORAGE_TRANSACTION_TIMEOUT_MS,
      },
    );

    await attachHasLock.promise;
    const blockedWorker = processDocumentDataStorageCleanup();
    await waitForAdvisoryLockWaiter();
    releaseAttach.resolve();
    await attachFirst;
    await expect(blockedWorker).resolves.toMatchObject({
      objectDeleteCount: 0,
      cancelledCount: 1,
      failedCount: 0,
    });
    expect(storedObjects.has(attachFirstKey)).toBe(true);

    const workerFirstKey = 'race/provisional-worker-first.pdf';
    await reserveInternalSnapshotStorageCleanup({ key: workerFirstKey });
    const workerFirstData = await createProvisionalInternalDocumentData({
      type: DocumentDataType.S3_PATH,
      data: workerFirstKey,
    });
    storedObjects.add(workerFirstKey);
    await databaseClient.query(
      `UPDATE "DocumentDataStorageCleanup"
       SET "notBefore" = CURRENT_TIMESTAMP - INTERVAL '1 second'
       WHERE "key" = $1`,
      [workerFirstKey],
    );
    deleteBarrier = {
      key: workerFirstKey,
      started: deferred(),
      release: deferred(),
    };

    try {
      const workerFirst = processDocumentDataStorageCleanup();
      await deleteBarrier.started.promise;

      const blockedAttach = prisma.$transaction(
        async (tx) => {
          await releaseProvisionalDocumentDataStorageCleanup({
            tx,
            documentDataId: workerFirstData.id,
          });
          await tx.$executeRaw`
            INSERT INTO "EnvelopeItem" ("id", "documentDataId")
            VALUES ('provisional-worker-first-item', ${workerFirstData.id})
          `;
        },
        {
          timeout: DOCUMENT_DATA_STORAGE_TRANSACTION_TIMEOUT_MS,
        },
      );

      await waitForAdvisoryLockWaiter();
      deleteBarrier.release.resolve();
      await expect(workerFirst).resolves.toMatchObject({
        acknowledgedCount: 1,
        failedCount: 0,
      });
      await expect(blockedAttach).rejects.toThrow(
        'Internal snapshot cleanup reservation was not released',
      );
      expect(storedObjects.has(workerFirstKey)).toBe(false);
      const workerFirstAttachment = await databaseClient.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM "EnvelopeItem" WHERE "id" = $1`,
        ['provisional-worker-first-item'],
      );
      expect(workerFirstAttachment.rows[0]?.count).toBe(0);
    } finally {
      deleteBarrier?.release.resolve();
      deleteBarrier = undefined;
      await prisma.envelopeItem.deleteMany({
        where: {
          id: {
            in: ['provisional-attach-first-item', 'provisional-worker-first-item'],
          },
        },
      });
      await prisma.documentData.deleteMany({
        where: {
          id: {
            in: [attachFirstData.id, workerFirstData.id],
          },
        },
      });
      await prisma.documentDataStorageCleanup.deleteMany({
        where: {
          key: {
            in: [attachFirstKey, workerFirstKey],
          },
        },
      });
      storedObjects.delete(attachFirstKey);
      storedObjects.delete(workerFirstKey);
    }
  }, 15_000);
});
