import { and, eq, inArray } from 'drizzle-orm';
import type { Job } from 'bullmq';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import type { ChildProcess } from 'node:child_process';
import { db, bulkMigration, bulkPair, bulkPairLog } from '../db.js';
import { decrypt } from '../crypto.js';
import { runImapsync, type Security } from '../imapsync.js';
import { resolveEmailHeaderSetting } from '../app-settings.js';
import { createNotification } from '../notifications.js';
import { env } from '../env.js';

// Constants mirrored from apps/api/src/lib/queue.ts. Kept in sync via the
// CI cross-package check (see check:crypto-sync style — same idea would
// apply here if drift becomes a problem).
const AUTO_SYNC_INTERVAL = 3 * 60 * 60 * 1000;
const AUTO_SYNC_DURATION = 10 * 24 * 60 * 60 * 1000;
const DAILY = 24 * 60 * 60 * 1000;
const WEEKLY = 7 * DAILY;
const MONTHLY = 30 * DAILY;

const bulkPairSyncQueue = new Queue('bulk-pair-sync', {
  connection: new Redis({
    host: env.REDIS_HOST,
    port: env.REDIS_PORT,
    maxRetriesPerRequest: null,
  }),
});

function backupIntervalMs(interval: unknown): number {
  if (interval === 'weekly') return WEEKLY;
  if (interval === 'monthly') return MONTHLY;
  return DAILY;
}

/** Worker-side equivalent of `apps/api/src/lib/bulk-sync.ts`. Schedules
 *  repeatable sync jobs for every completed pair when bulk.settings has
 *  autoSync or backupMode on. Called right after the bulk's initial run
 *  finishes (or NOT — if user didn't ask for sync, this is a no-op). */
async function applyPostBulkSync(bulkId: string): Promise<void> {
  const [b] = await db.select().from(bulkMigration).where(eq(bulkMigration.id, bulkId));
  if (!b) return;
  const settings = (b.settings as Record<string, unknown> | null) ?? {};
  const autoSync = settings.autoSync === true;
  const backupMode = settings.backupMode === true;
  if (!autoSync && !backupMode) return;

  const intervalMs = backupMode ? backupIntervalMs(settings.backupInterval) : AUTO_SYNC_INTERVAL;
  const endsAt = backupMode ? null : new Date(Date.now() + AUTO_SYNC_DURATION);
  const mode = backupMode ? 'backup' : 'auto';

  // Schedule for both 'completed' AND 'completed_with_errors' — a pair
  // that hit 26 unfetchable source messages out of 55k is still a valid
  // target for ongoing sync (most of its data made it across).
  const completedPairs = await db
    .select({ id: bulkPair.id })
    .from(bulkPair)
    .where(
      and(
        eq(bulkPair.bulkId, bulkId),
        inArray(bulkPair.status, ['completed', 'completed_with_errors']),
      ),
    );

  await Promise.all(
    completedPairs.map((p) =>
      bulkPairSyncQueue
        .upsertJobScheduler(
          `bulk-pair-sync:${p.id}`,
          { every: intervalMs, ...(endsAt ? { endDate: endsAt } : {}) },
          {
            name: 'bulk-pair-scheduled-sync',
            data: { bulkId, pairId: p.id, mode },
            opts: { removeOnComplete: 20, removeOnFail: 50 },
          },
        )
        .catch((e: unknown) => console.error(`[bulk-pair-sync] schedule pair ${p.id} failed:`, e)),
    ),
  );
}

const pub = new Redis({ host: env.REDIS_HOST, port: env.REDIS_PORT, maxRetriesPerRequest: null });
const cancelSub = new Redis({
  host: env.REDIS_HOST,
  port: env.REDIS_PORT,
  maxRetriesPerRequest: null,
});

const publish = (id: string, payload: object): void => {
  void pub.publish(`bulk:${id}`, JSON.stringify(payload));
};

function asSecurity(s: string): Security {
  if (s === 'SSL/TLS' || s === 'STARTTLS' || s === 'None') return s;
  throw new Error(`Invalid security value in DB: ${JSON.stringify(s)}`);
}

export async function handleBulkMigration(job: Job<{ bulkId: string; pairIds?: number[] }>) {
  const id = job.data.bulkId;
  // When `pairIds` is present, run only those specific pairs — used by the
  // "Retry failed pair" API endpoint to re-attempt one or a handful of
  // pairs without re-touching the rest of the bulk. Absent = full bulk
  // (the original first-deploy code path).
  const retryPairIds = Array.isArray(job.data.pairIds) ? job.data.pairIds : null;
  const isRetry = retryPairIds !== null;
  const [b] = await db.select().from(bulkMigration).where(eq(bulkMigration.id, id));
  if (!b) throw new Error(`Bulk migration ${id} not found`);

  const pairs = isRetry
    ? await db
        .select()
        .from(bulkPair)
        .where(and(eq(bulkPair.bulkId, id), inArray(bulkPair.id, retryPairIds!)))
    : await db.select().from(bulkPair).where(eq(bulkPair.bulkId, id));

  if (pairs.length === 0) {
    if (isRetry) {
      // Nothing to do — pair was deleted between enqueue and pickup.
      return;
    }
    throw new Error(`Bulk ${id} has no pairs`);
  }

  // Don't flip the bulk's headline status on a per-pair retry — the bulk
  // itself stays in its terminal state (completed_with_errors / failed).
  // Only the pair's row transitions.
  if (!isRetry) {
    await db.update(bulkMigration).set({ status: 'running' }).where(eq(bulkMigration.id, id));
    publish(id, { kind: 'status', status: 'running' });
  } else {
    publish(id, { kind: 'retry-started', pairIds: retryPairIds });
  }

  // Cancellation wiring — mirror of single-migration: subscribe to a
  // bulk-cancel channel and SIGTERM every currently-running pair's child.
  // Pending pairs in `queue` are drained; their DB rows are marked cancelled.
  const cancelChannel = `bulk-cancel:${id}`;
  let cancelled = false;
  const liveChildren = new Set<ChildProcess>();
  const onCancelMsg = (chan: string) => {
    if (chan !== cancelChannel) return;
    cancelled = true;
    for (const ch of liveChildren) {
      try {
        ch.kill('SIGTERM');
      } catch {
        // already exited
      }
    }
    // Hard kill fallback after 10s
    setTimeout(() => {
      for (const ch of liveChildren) {
        try {
          ch.kill('SIGKILL');
        } catch {
          // already exited
        }
      }
    }, 10_000).unref();
  };
  await cancelSub.subscribe(cancelChannel);
  cancelSub.on('message', onCancelMsg);

  const concurrency = Math.max(1, Math.min(env.WORKER_CONCURRENCY, pairs.length));
  const queue = [...pairs];
  const active: Promise<void>[] = [];

  // Bulk-level settings apply to every pair's initial imapsync run. Resolve
  // once (the email-header policy walks app_setting which is global anyway)
  // so we don't N-times round-trip Postgres.
  const bulkSettings = (b.settings as Record<string, unknown> | null) ?? {};
  const bulkThrottleBps =
    bulkSettings.throttleEnabled === true
      ? Math.floor((((bulkSettings.throttleGbPerDay as number) ?? 1) * 1024 ** 3) / 86400)
      : undefined;
  const bulkEmailHeaderSettings = await resolveEmailHeaderSetting(bulkSettings);

  let failedCount = 0;
  let succeededCount = 0;
  let cancelledCount = 0;

  const runOne = async (pair: (typeof pairs)[number]) => {
    if (cancelled) {
      await db
        .update(bulkPair)
        .set({ status: 'cancelled' })
        .where(eq(bulkPair.id, pair.id))
        .catch(() => {});
      cancelledCount++;
      return;
    }
    await db
      .update(bulkPair)
      .set({
        status: 'running',
        // Reset per-run counters so a retry starts clean (imapsync itself
        // is incremental on the wire, but our UI metrics shouldn't carry
        // over partial numbers from a prior failed attempt).
        migratedEmails: 0,
        migratedBytes: 0,
        failedEmails: 0,
        foldersSynced: 0,
        totalFolders: 0,
        exitCode: null,
        error: null,
        progressPercent: 0,
      })
      .where(eq(bulkPair.id, pair.id));
    const cleanupRef: { fn: (() => Promise<void>) | null } = { fn: null };
    const childRef: { c: ChildProcess | null } = { c: null };

    let resolveDone!: () => void;
    let rejectDone!: (e: Error) => void;
    const done = new Promise<void>((res, rej) => {
      resolveDone = res;
      rejectDone = rej;
    });

    // Per-pair running tallies, aggregated from imapsync event stream.
    let pairCopied = 0;
    let pairBytes = 0;
    let pairFailed = 0;
    let pairTotalFolders = 0;
    const foldersSeen = new Set<string>(); // each folder-stats event marks a folder synced

    try {
      const handle = await runImapsync(
        {
          source: {
            host: b.sourceHost,
            port: b.sourcePort,
            security: asSecurity(b.sourceSecurity),
            username: pair.sourceUsername,
            password: decrypt(pair.sourcePasswordEnc),
          },
          target: {
            host: b.targetHost,
            port: b.targetPort,
            security: asSecurity(b.targetSecurity),
            username: pair.targetUsername,
            password: decrypt(pair.targetPasswordEnc),
          },
          migrationId: `bulk-${id}-pair-${pair.id}`,
          throttleBytesPerSecond: bulkThrottleBps,
          enableCache: bulkSettings.enableCache === true,
          reduceBandwidth: bulkSettings.reduceBandwidth === true,
          syncDuplicates: bulkSettings.syncDuplicates === true,
          emailHeaderSettings: bulkEmailHeaderSettings,
        },
        (ev) => {
          publish(id, { pairId: pair.id, ...ev });
          if (ev.kind === 'log') {
            // Persist log line so the UI can render the Initial Migration
            // Log panel after the run. syncRunId is left NULL — this is
            // an initial-migration line, not a sync run.
            void db
              .insert(bulkPairLog)
              .values({ bulkPairId: pair.id, level: ev.level, message: ev.message })
              .catch(() => {});
          } else if (ev.kind === 'folder') {
            // imapsync reports total folder count on every folder event.
            // Latch the highest value we see.
            if (ev.total > pairTotalFolders) pairTotalFolders = ev.total;
          } else if (ev.kind === 'folder-stats') {
            pairCopied += ev.copied ?? 0;
            pairBytes += ev.bytes ?? 0;
            pairFailed += ev.failed ?? 0;
            foldersSeen.add(ev.name);
            // Snapshot the running totals so the modal can update without
            // waiting for run completion.
            void db
              .update(bulkPair)
              .set({
                migratedEmails: pairCopied,
                migratedBytes: pairBytes,
                failedEmails: pairFailed,
                foldersSynced: foldersSeen.size,
                totalFolders: pairTotalFolders,
              })
              .where(eq(bulkPair.id, pair.id))
              .catch(() => {});
          } else if (ev.kind === 'percent') {
            void db
              .update(bulkPair)
              .set({ progressPercent: ev.percent })
              .where(eq(bulkPair.id, pair.id));
          } else if (ev.kind === 'done') {
            const exitCode = ev.exitCode ?? null;
            // Decide the row's terminal status:
            //   ok=true           → completed
            //   cancelled flag    → cancelled
            //   ok=false + we got at least one copied msg/folder
            //                     → completed_with_errors (partial success)
            //   otherwise         → failed
            // Rationale: imapsync can exit 115 (EXIT_ERR_FETCH) when ALL it
            // failed were a handful of unfetchable source messages — the
            // bulk of the mailbox actually migrated. Surfacing that as a
            // flat "failed" hides 99.9% of the work the worker did.
            let nextStatus: 'completed' | 'completed_with_errors' | 'failed' | 'cancelled';
            if (cancelled || ev.error === 'cancelled') {
              nextStatus = 'cancelled';
            } else if (ev.ok) {
              nextStatus = 'completed';
            } else if (pairCopied > 0 || foldersSeen.size > 0) {
              nextStatus = 'completed_with_errors';
            } else {
              nextStatus = 'failed';
            }
            const errorMsg =
              nextStatus === 'completed' || nextStatus === 'cancelled'
                ? null
                : (ev.error ?? 'failed');
            const baseUpdate = {
              status: nextStatus,
              exitCode,
              error: errorMsg,
              // Final flush of running tallies so the persisted row is the
              // source of truth for the modal stats.
              migratedEmails: pairCopied,
              migratedBytes: pairBytes,
              failedEmails: pairFailed,
              foldersSynced: foldersSeen.size,
              totalFolders: pairTotalFolders,
              ...(nextStatus === 'completed' ? { progressPercent: 100 } : {}),
            };
            void db
              .update(bulkPair)
              .set(baseUpdate)
              .where(eq(bulkPair.id, pair.id))
              .then(() => {
                if (nextStatus === 'failed') rejectDone(new Error(ev.error ?? 'failed'));
                else resolveDone();
              })
              .catch((err) => rejectDone(err as Error));
          }
        },
      );
      cleanupRef.fn = handle.cleanup;
      childRef.c = handle.child;
      liveChildren.add(handle.child);
      handle.child.on('error', (e) => rejectDone(e));
      await done;
      // A completed_with_errors run still counts as "succeeded" for the
      // bulk-level aggregate: the user's data made it to the target.
      if (cancelled) cancelledCount++;
      else succeededCount++;
    } catch (e: any) {
      if (cancelled) {
        cancelledCount++;
      } else {
        failedCount++;
      }
      const msg = e?.message ?? String(e);
      await db
        .update(bulkPair)
        .set({ status: cancelled ? 'cancelled' : 'failed', error: cancelled ? null : msg })
        .where(eq(bulkPair.id, pair.id))
        .catch(() => {});
      publish(id, { pairId: pair.id, kind: 'log', level: 'error', message: msg });
    } finally {
      if (childRef.c) liveChildren.delete(childRef.c);
      if (cleanupRef.fn) await cleanupRef.fn();
    }
  };

  try {
    while (queue.length > 0 || active.length > 0) {
      // If cancelled, drain remaining queue — mark each as cancelled in DB
      // and skip dispatching new pairs.
      if (cancelled && queue.length > 0) {
        const remaining = queue.splice(0);
        const ids = remaining.map((p) => p.id);
        await db
          .update(bulkPair)
          .set({ status: 'cancelled' })
          .where(and(eq(bulkPair.bulkId, id), inArray(bulkPair.id, ids)))
          .catch(() => {});
        cancelledCount += remaining.length;
      }
      while (active.length < concurrency && queue.length > 0) {
        const pair = queue.shift()!;
        const p = runOne(pair).finally(() => {
          const i = active.indexOf(p);
          if (i >= 0) void active.splice(i, 1);
        });
        active.push(p);
      }
      if (active.length > 0) await Promise.race(active).catch(() => {});
    }
  } finally {
    cancelSub.off('message', onCancelMsg);
    await cancelSub.unsubscribe(cancelChannel).catch(() => {});
  }

  // For per-pair retries, leave the bulk-level status alone — the bulk
  // already finished long ago, and the retry job is just refreshing one
  // pair's row. Emit a status event so the UI can refetch the bulk + pairs.
  if (isRetry) {
    publish(id, {
      kind: 'retry-finished',
      pairIds: retryPairIds,
      succeeded: succeededCount,
      failed: failedCount,
    });
    return;
  }

  let finalStatus: 'completed' | 'completed_with_errors' | 'failed' | 'cancelled';
  if (cancelled) finalStatus = 'cancelled';
  else if (succeededCount === pairs.length) finalStatus = 'completed';
  else if (succeededCount === 0) finalStatus = 'failed';
  else finalStatus = 'completed_with_errors';

  await db.update(bulkMigration).set({ status: finalStatus }).where(eq(bulkMigration.id, id));
  publish(id, {
    kind: 'status',
    status: finalStatus,
    total: pairs.length,
    succeeded: succeededCount,
    failed: failedCount,
    cancelled: cancelledCount,
  });

  // If the user ticked Auto Sync or Backup Mode at bulk creation, arm
  // repeatable per-pair sync schedules now that we know which pairs
  // succeeded. Failures are logged but don't escalate — the bulk itself
  // already finished, and the user can re-arm via PATCH settings.
  if (finalStatus !== 'failed' && finalStatus !== 'cancelled') {
    await applyPostBulkSync(id).catch((e) =>
      console.error(`[bulk] applyPostBulkSync(${id}) failed:`, e),
    );
  }

  // Emit a notification summarising the bulk outcome. Cancelled is silent
  // (user explicitly stopped — no surprise to surface).
  const totalPairs = pairs.length;
  if (finalStatus === 'completed') {
    void createNotification({
      kind: 'success',
      title: 'Bulk migration completed',
      body: `${totalPairs} mailbox${totalPairs === 1 ? '' : 'es'} migrated successfully.`,
      linkPath: `/bulk/${id}`,
      bulkId: id,
    });
  } else if (finalStatus === 'completed_with_errors') {
    void createNotification({
      kind: 'warning',
      title: 'Bulk migration finished with errors',
      body: `${succeededCount}/${totalPairs} succeeded, ${failedCount} failed.`,
      linkPath: `/bulk/${id}`,
      bulkId: id,
    });
  } else if (finalStatus === 'failed') {
    void createNotification({
      kind: 'error',
      title: 'Bulk migration failed',
      body: `All ${totalPairs} mailbox${totalPairs === 1 ? '' : 'es'} failed to migrate.`,
      linkPath: `/bulk/${id}`,
      bulkId: id,
    });
  }

  if (finalStatus === 'failed') {
    throw new Error(`All ${pairs.length} pairs failed`);
  }
}
