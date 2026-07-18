BEGIN;

-- This migration runs while the application is quiesced for the P5 provider
-- release. The backfill converts every already-unreferenced S3 DocumentData
-- row into a durable cleanup task without ever copying BYTES/BYTES_64 content.
CREATE TABLE "DocumentDataStorageCleanup" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "documentDataId" TEXT,
    "notBefore" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
    "earlyDeleteEnabled" BOOLEAN NOT NULL DEFAULT true,
    "earlyDeleteAttemptedAt" TIMESTAMP(3),
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),

    CONSTRAINT "DocumentDataStorageCleanup_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DocumentDataStorageCleanup_key_key"
ON "DocumentDataStorageCleanup"("key");

CREATE INDEX "DocumentDataStorageCleanup_notBefore_createdAt_idx"
ON "DocumentDataStorageCleanup"("notBefore", "createdAt");

CREATE UNIQUE INDEX "DocumentDataStorageCleanup_documentDataId_key"
ON "DocumentDataStorageCleanup"("documentDataId");

-- These must stay partial: BYTES/BYTES_64 rows can contain multi-megabyte PDF
-- payloads that are not valid btree index entries. Runtime cleanup probes only
-- S3_PATH keys through these two columns while holding a short key lock.
CREATE INDEX "DocumentData_s3_path_data_idx"
ON "DocumentData"("data")
WHERE "type" = 'S3_PATH'::"DocumentDataType";

CREATE INDEX "DocumentData_s3_path_initialData_idx"
ON "DocumentData"("initialData")
WHERE "type" = 'S3_PATH'::"DocumentDataType";

-- Lock both sides of the one-to-one relation for the short backfill. Normal
-- runtime cleanup uses row guards instead of relying on this migration lock.
LOCK TABLE "EnvelopeItem" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "DocumentData" IN SHARE ROW EXCLUSIVE MODE;

WITH orphan_keys AS (
    SELECT DISTINCT key
    FROM "DocumentData" AS orphan
    CROSS JOIN LATERAL (
        VALUES (orphan."data"), (orphan."initialData")
    ) AS stored(key)
    WHERE orphan."type" = 'S3_PATH'::"DocumentDataType"
      AND NOT EXISTS (
          SELECT 1
          FROM "EnvelopeItem"
          WHERE "EnvelopeItem"."documentDataId" = orphan."id"
      )
      AND NOT EXISTS (
          SELECT 1
          FROM "DocumentData" AS referenced
          INNER JOIN "EnvelopeItem"
            ON "EnvelopeItem"."documentDataId" = referenced."id"
          WHERE referenced."type" = 'S3_PATH'::"DocumentDataType"
            AND (
                referenced."data" = stored.key
                OR referenced."initialData" = stored.key
            )
      )
)
INSERT INTO "DocumentDataStorageCleanup" ("id", "key", "notBefore")
SELECT
    'legacy_' || md5(key) || md5(reverse(key)),
    key,
    (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') + INTERVAL '65 minutes'
FROM orphan_keys
ON CONFLICT ("key") DO NOTHING;

DELETE FROM "DocumentData"
WHERE NOT EXISTS (
    SELECT 1
    FROM "EnvelopeItem"
    WHERE "EnvelopeItem"."documentDataId" = "DocumentData"."id"
);

COMMIT;
