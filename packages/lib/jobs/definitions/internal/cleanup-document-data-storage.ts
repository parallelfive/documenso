import { z } from 'zod';

import { type JobDefinition } from '../../client/_internal/job';

const CLEANUP_DOCUMENT_DATA_STORAGE_JOB_DEFINITION_ID = 'internal.cleanup-document-data-storage';

const CLEANUP_DOCUMENT_DATA_STORAGE_JOB_DEFINITION_SCHEMA = z.object({});

export type TCleanupDocumentDataStorageJobDefinition = z.infer<
  typeof CLEANUP_DOCUMENT_DATA_STORAGE_JOB_DEFINITION_SCHEMA
>;

export const CLEANUP_DOCUMENT_DATA_STORAGE_JOB_DEFINITION = {
  id: CLEANUP_DOCUMENT_DATA_STORAGE_JOB_DEFINITION_ID,
  name: 'Cleanup Document Data Storage',
  version: '1.0.0',
  trigger: {
    name: CLEANUP_DOCUMENT_DATA_STORAGE_JOB_DEFINITION_ID,
    schema: CLEANUP_DOCUMENT_DATA_STORAGE_JOB_DEFINITION_SCHEMA,
    cron: '*/15 * * * *',
  },
  handler: async ({ payload, io }) => {
    const handler = await import('./cleanup-document-data-storage.handler');

    await handler.run({ payload, io });
  },
} as const satisfies JobDefinition<
  typeof CLEANUP_DOCUMENT_DATA_STORAGE_JOB_DEFINITION_ID,
  TCleanupDocumentDataStorageJobDefinition
>;
