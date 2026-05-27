import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { env } from './env.js';
import { handleSingleMigration } from './jobs/single-migration.js';
import { handleBulkMigration } from './jobs/bulk-migration.js';
import { sweepOrphanTempfiles } from './imapsync.js';

const connection = new Redis({
  host: env.REDIS_HOST,
  port: env.REDIS_PORT,
  maxRetriesPerRequest: null,
});

const migrationWorker = new Worker('migration', handleSingleMigration, {
  connection,
  concurrency: env.WORKER_CONCURRENCY,
});

const bulkWorker = new Worker('bulk-migration', handleBulkMigration, {
  connection,
  concurrency: 1, // bulk handles its own internal concurrency
});

migrationWorker.on('failed', (job, err) => {
  console.error(`[migration] job ${job?.id} failed:`, err.message);
});
migrationWorker.on('completed', (job) => {
  console.log(`[migration] job ${job.id} completed`);
});
bulkWorker.on('failed', (job, err) => {
  console.error(`[bulk] job ${job?.id} failed:`, err.message);
});

// Safety net for finding #1: a previous worker crash / SIGKILL may have left
// plaintext password files on the imapsync-state volume. Sweep on boot.
void sweepOrphanTempfiles().then((n) => {
  if (n > 0) console.log(`[worker] swept ${n} orphan credential tempfile(s)`);
});

console.log(`[worker] started (concurrency=${env.WORKER_CONCURRENCY})`);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    console.log(`[worker] ${sig} received, shutting down`);
    await migrationWorker.close();
    await bulkWorker.close();
    process.exit(0);
  });
}
