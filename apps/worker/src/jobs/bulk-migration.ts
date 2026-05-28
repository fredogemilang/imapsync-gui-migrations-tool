import { and, eq, inArray } from 'drizzle-orm';
import type { Job } from 'bullmq';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import type { ChildProcess } from 'node:child_process';
import { db, bulkMigration, bulkPair } from '../db.js';
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

  const completedPairs = await db
    .select({ id: bulkPair.id })
    .from(bulkPair)
    .where(and(eq(bulkPair.bulkId, bulkId), eq(bulkPair.status, 'completed')));

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

export async function handleBulkMigration(job: Job<{ bulkId: string }>) {
  const id = job.data.bulkId;
  const [b] = await db.select().from(bulkMigration).where(eq(bulkMigration.id, id));
  if (!b) throw new Error(`Bulk migration ${id} not found`);

  const pairs = await db.select().from(bulkPair).where(eq(bulkPair.bulkId, id));
  await db.update(bulkMigration).set({ status: 'running' }).where(eq(bulkMigration.id, id));
  publish(id, { kind: 'status', status: 'running' });

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
    await db.update(bulkPair).set({ status: 'running' }).where(eq(bulkPair.id, pair.id));
    const cleanupRef: { fn: (() => Promise<void>) | null } = { fn: null };
    const childRef: { c: ChildProcess | null } = { c: null };

    let resolveDone!: () => void;
    let rejectDone!: (e: Error) => void;
    const done = new Promise<void>((res, rej) => {
      resolveDone = res;
      rejectDone = rej;
    });

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
          if (ev.kind === 'percent') {
            void db
              .update(bulkPair)
              .set({ progressPercent: ev.percent })
              .where(eq(bulkPair.id, pair.id));
          } else if (ev.kind === 'done') {
            if (ev.ok) {
              void db
                .update(bulkPair)
                .set({ status: 'completed', progressPercent: 100 })
                .where(eq(bulkPair.id, pair.id))
                .then(() => resolveDone())
                .catch((err) => rejectDone(err as Error));
            } else if (cancelled || ev.error === 'cancelled') {
              void db
                .update(bulkPair)
                .set({ status: 'cancelled' })
                .where(eq(bulkPair.id, pair.id))
                .then(() => {
                  resolveDone();
                })
                .catch((err) => rejectDone(err as Error));
            } else {
              void db
                .update(bulkPair)
                .set({ status: 'failed', error: ev.error ?? 'failed' })
                .where(eq(bulkPair.id, pair.id))
                .finally(() => rejectDone(new Error(ev.error ?? 'failed')));
            }
          }
        },
      );
      cleanupRef.fn = handle.cleanup;
      childRef.c = handle.child;
      liveChildren.add(handle.child);
      handle.child.on('error', (e) => rejectDone(e));
      await done;
      // success or cancellation both count as "ran" — distinguish below
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
