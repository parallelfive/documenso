import { processDocumentDataStorageCleanup } from '../../../server-only/document-data/process-document-data-storage-cleanup';
import type { JobRunIO } from '../../client/_internal/job';
import type { TCleanupDocumentDataStorageJobDefinition } from './cleanup-document-data-storage';

const CLEANUP_BATCH_SIZE = 100;

export const run = async ({
  io,
}: {
  payload: TCleanupDocumentDataStorageJobDefinition;
  io: JobRunIO;
}) => {
  const result = await processDocumentDataStorageCleanup({
    limit: CLEANUP_BATCH_SIZE,
  });

  io.logger.info({
    event: 'document-data-storage-cleanup-sweep-completed',
    ...result,
  });
};
