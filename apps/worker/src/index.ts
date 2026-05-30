import { and, eq, lt, sql } from 'drizzle-orm';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { env } from './env.js';
import { db, migration, syncRun } from './db.js';
import { handleSingleMigration } from './jobs/single-migration.js';
import { handleBulkMigration } from './jobs/bulk-migration.js';
import { handleSyncJob } from './jobs/sync.js';
import { handleBulkPairSync } from './jobs/bulk-pair-sync.js';
import { handleRetentionSweep } from './jobs/retention.js';
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

const syncWorker = new Worker('sync', handleSyncJob, {
  connection,
  concurrency: env.WORKER_CONCURRENCY,
});

const bulkPairSyncWorker = new Worker('bulk-pair-sync', handleBulkPairSync, {
  connection,
  concurrency: env.WORKER_CONCURRENCY,
});

const retentionWorker = new Worker('retention', handleRetentionSweep, {
  connection,
  concurrency: 1,
});

syncWorker.on('failed', (job, err) => {
  console.error(`[sync] job ${job?.id} failed:`, err.message);
});
bulkPairSyncWorker.on('failed', (job, err) => {
  console.error(`[bulk-pair-sync] job ${job?.id} failed:`, err.message);
});
retentionWorker.on('failed', (job, err) => {
  console.error(`[retention] job ${job?.id} failed:`, err.message);
});

// Register the daily retention sweep on boot. `upsertJobScheduler` is
// idempotent — restarting the worker doesn't create duplicate schedules.
// The job dispatches every 24h; the handler short-circuits when
// app_setting.retentionDays is 0 ("Never Delete"). Also fires once
// shortly after boot so admins don't wait a full day to see the sweep
// kick in after deploying this code.
const retentionQueue = new Queue('retention', { connection });
void retentionQueue
  .upsertJobScheduler(
    'retention-daily',
    { every: 24 * 60 * 60 * 1000 },
    {
      name: 'retention-sweep',
      data: {},
      opts: { removeOnComplete: 5, removeOnFail: 20 },
    },
  )
  .catch((e) => console.error('[retention] schedule failed:', e));

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

// Reset stale `migration.syncRunning=true` flags on boot. The sync job
// handler sets this flag at start and clears it in success/catch paths,
// but a SIGKILL / OOM / container restart mid-run skips the clear and the
// row stays locked forever — POST /sync/now then returns 409 permanently
// and Auto Sync ticks are short-circuited. Since the worker is the only
// thing that owns this flag, on boot we KNOW no sync is genuinely running,
// so it's safe to reset every stale `true`.
void db
  .update(migration)
  .set({ syncRunning: false })
  .where(eq(migration.syncRunning, true))
  .then((res) => {
    const n = (res as unknown as { rowCount?: number }).rowCount;
    if (typeof n === 'number' && n > 0) {
      console.log(`[worker] reset ${n} stale migration.syncRunning flag(s)`);
    }
  })
  .catch((e) => console.error('[worker] syncRunning sweep failed:', e));

// Stale `sync_run.status='running'` boot sweep.
//
// Each handleSyncJob / handleBulkPairSync inserts a sync_run row at start
// and flips it to success/failed in finally. But a SIGKILL / OOM /
// container restart mid-run skips the flip and the row sticks at
// 'running' forever — UI shows "Running" with elapsed time growing
// indefinitely. Since the worker is the only writer, no row can
// genuinely be running across a worker restart, so it's safe to flip
// every stale row to 'failed' on boot.
//
// We exclude rows newer than 60 seconds defensively: in single-replica
// dev, the worker process is also the one that just rebooted, but in
// production with replicas=2 another worker may have JUST inserted a
// legitimately-running row a moment before this sweep fires.
void db
  .update(syncRun)
  .set({
    status: 'failed',
    finishedAt: new Date(),
    errorMessage: 'Orphaned — worker restarted while this sync was running',
  })
  .where(
    and(eq(syncRun.status, 'running'), lt(syncRun.startedAt, sql`NOW() - INTERVAL '60 seconds'`)),
  )
  .then((res) => {
    const n = (res as unknown as { rowCount?: number }).rowCount;
    if (typeof n === 'number' && n > 0) {
      console.log(`[worker] swept ${n} orphaned sync_run row(s)`);
    }
  })
  .catch((e) => console.error('[worker] sync_run sweep failed:', e));

// Stale `bulk_sync_session.status='running'` boot sweep.
//
// Sessions only flip out of 'running' when all their per-pair sync_runs
// finish (via tickSessionDone). If pair workers crashed mid-session and
// left sync_runs orphaned, the session ALSO stays at 'running' forever.
// After the sync_run sweep above marks orphans as 'failed', any session
// older than 1h whose pair rows are all terminal can be safely
// finalised: if at least one succeeded → 'finished', otherwise 'failed'.
void db
  .execute(
    sql`
      UPDATE bulk_sync_session ss
      SET status = CASE
            WHEN (SELECT COUNT(*) FROM sync_run sr
                  WHERE sr.session_id = ss.id AND sr.status = 'success') > 0
            THEN 'finished'
            ELSE 'failed'
          END,
          finished_at = NOW()
      WHERE ss.status = 'running'
        AND ss.started_at < NOW() - INTERVAL '1 hour'
        AND NOT EXISTS (
          SELECT 1 FROM sync_run sr
          WHERE sr.session_id = ss.id AND sr.status = 'running'
        )
    `,
  )
  .then((res) => {
    const n = (res as unknown as { rowCount?: number }).rowCount;
    if (typeof n === 'number' && n > 0) {
      console.log(`[worker] finalised ${n} stale bulk_sync_session(s)`);
    }
  })
  .catch((e) => console.error('[worker] bulk_sync_session sweep failed:', e));

console.log(`[worker] started (concurrency=${env.WORKER_CONCURRENCY})`);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    console.log(`[worker] ${sig} received, shutting down`);
    await migrationWorker.close();
    await bulkWorker.close();
    await syncWorker.close();
    await bulkPairSyncWorker.close();
    await retentionWorker.close();
    process.exit(0);
  });
}
