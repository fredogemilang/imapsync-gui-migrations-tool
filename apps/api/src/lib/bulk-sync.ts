import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { bulkMigration, bulkPair } from '../db/schema.js';
import { bulkPairSyncJobId, bulkPairSyncQueue, SYNC_INTERVALS } from './queue.js';

/**
 * Bulk → per-pair sync orchestration.
 *
 * When a bulk migration's settings.autoSync or settings.backupMode flips
 * (either at PATCH time or right after the initial bulk run finishes),
 * we need to upsert a repeatable BullMQ schedule for EVERY completed
 * pair so each pair gets its own delta sync on the configured cadence.
 *
 * - Auto Sync wins-loses to Backup Mode (same as single migration —
 *   Backup is the "stronger" intent: no expiry, larger interval picker).
 * - Auto Sync = every 3h capped at 10 days.
 * - Backup Mode = every {backupInterval} forever (daily/weekly/monthly).
 *
 * Schedules are keyed by `bulk-pair-sync:${pairId}` so upserts replace any
 * earlier schedule for that pair cleanly.
 */

const AUTO_SYNC_INTERVAL = SYNC_INTERVALS.AUTO_SYNC_3H;
const AUTO_SYNC_DURATION = 10 * 24 * 60 * 60 * 1000;

function backupIntervalMs(interval: unknown): number {
  if (interval === 'weekly') return SYNC_INTERVALS.WEEKLY;
  if (interval === 'monthly') return SYNC_INTERVALS.MONTHLY;
  return SYNC_INTERVALS.DAILY; // 'daily' or unset → daily
}

/** Compute the (intervalMs, endsAt) tuple a bulk's settings should drive,
 *  or null when sync is fully disabled. */
function resolveSchedule(settings: Record<string, unknown>): {
  mode: 'auto' | 'backup';
  intervalMs: number;
  endsAt: Date | null;
} | null {
  const autoSync = settings.autoSync === true;
  const backupMode = settings.backupMode === true;
  if (!autoSync && !backupMode) return null;
  if (backupMode) {
    return { mode: 'backup', intervalMs: backupIntervalMs(settings.backupInterval), endsAt: null };
  }
  return {
    mode: 'auto',
    intervalMs: AUTO_SYNC_INTERVAL,
    endsAt: new Date(Date.now() + AUTO_SYNC_DURATION),
  };
}

/** Schedule (or remove) per-pair sync for every COMPLETED pair of a bulk
 *  migration, based on the bulk's current settings. Idempotent:
 *  - settings enabled  → upsertJobScheduler for each completed pair
 *  - settings disabled → removeJobScheduler for each pair (running or done)
 *
 *  Failures on individual schedule operations are logged and ignored —
 *  one stuck pair shouldn't block the rest. */
export async function reconcileBulkPairSyncs(bulkId: string): Promise<{
  scheduled: number;
  cleared: number;
}> {
  const [b] = await db.select().from(bulkMigration).where(eq(bulkMigration.id, bulkId)).limit(1);
  if (!b) return { scheduled: 0, cleared: 0 };

  const schedule = resolveSchedule((b.settings as Record<string, unknown>) ?? {});

  // We only schedule pairs that already finished — syncing an in-flight
  // pair would collide with its initial imapsync run.
  const pairs = await db
    .select({ id: bulkPair.id, status: bulkPair.status })
    .from(bulkPair)
    .where(eq(bulkPair.bulkId, bulkId));

  let scheduled = 0;
  let cleared = 0;

  for (const p of pairs) {
    const key = bulkPairSyncJobId(p.id);
    if (schedule && p.status === 'completed') {
      await bulkPairSyncQueue
        .upsertJobScheduler(
          key,
          { every: schedule.intervalMs, ...(schedule.endsAt ? { endDate: schedule.endsAt } : {}) },
          {
            name: 'bulk-pair-scheduled-sync',
            data: { bulkId, pairId: p.id, mode: schedule.mode },
            opts: { removeOnComplete: 20, removeOnFail: 50 },
          },
        )
        .then(() => {
          scheduled++;
        })
        .catch((e: unknown) => {
          console.error(`[bulk-sync] failed to schedule pair ${p.id}:`, e);
        });
    } else {
      await bulkPairSyncQueue
        .removeJobScheduler(key)
        .then((removed) => {
          if (removed) cleared++;
        })
        .catch(() => {
          // not present — fine
        });
    }
  }

  return { scheduled, cleared };
}

/** Enqueue a one-off "Sync Now" pass — used by the YourBulkMigration
 *  page's button. Fires for every completed pair, parallel. */
export async function enqueueBulkSyncNow(bulkId: string): Promise<number> {
  const pairs = await db
    .select({ id: bulkPair.id })
    .from(bulkPair)
    .where(and(eq(bulkPair.bulkId, bulkId), inArray(bulkPair.status, ['completed'])));
  await Promise.all(
    pairs.map((p) =>
      bulkPairSyncQueue.add(
        'bulk-pair-manual-sync',
        { bulkId, pairId: p.id, manual: true },
        { removeOnComplete: 20, removeOnFail: 50 },
      ),
    ),
  );
  return pairs.length;
}
