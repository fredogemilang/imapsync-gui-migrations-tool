import { and, eq } from 'drizzle-orm';
import type { Job } from 'bullmq';
import type { ChildProcess } from 'node:child_process';
import { Redis } from 'ioredis';
import { Queue } from 'bullmq';
import { db, bulkMigration, bulkPair } from '../db.js';
import { decrypt } from '../crypto.js';
import { runImapsync, type Security } from '../imapsync.js';
import { resolveEmailHeaderSetting } from '../app-settings.js';
import { createNotification } from '../notifications.js';
import { env } from '../env.js';

/**
 * Bulk pair delta-sync handler.
 *
 * Triggered by:
 *   - Repeatable BullMQ job armed by `reconcileBulkPairSyncs` after the
 *     bulk's settings.autoSync / backupMode flip on.
 *   - One-off jobs queued by `POST /api/bulk-migrations/:id/sync/now`.
 *
 * Mirrors `handleSyncJob` but uses bulk_pair credentials + bulk-level
 * server config instead of the migration row's stored accounts. Bulk
 * pairs don't materialise into the `migration` table — they live in
 * `bulk_pair` with encrypted per-pair credentials.
 *
 * Self-disables when:
 *   - bulk or pair vanished
 *   - pair never finished its initial run (status != 'completed') and not manual
 *   - bulk.settings says sync is off (and not manual)
 *
 * Failures bubble back to BullMQ for retry on the next tick.
 */

const pub = new Redis({ host: env.REDIS_HOST, port: env.REDIS_PORT, maxRetriesPerRequest: null });
// Used for removing our own schedule when it's been cancelled out from
// under us (settings flipped off between ticks).
const bulkPairSyncQueueRef = new Queue('bulk-pair-sync', {
  connection: new Redis({
    host: env.REDIS_HOST,
    port: env.REDIS_PORT,
    maxRetriesPerRequest: null,
  }),
});

function asSecurity(s: string): Security {
  if (s === 'SSL/TLS' || s === 'STARTTLS' || s === 'None') return s;
  throw new Error(`Invalid security value in DB: ${JSON.stringify(s)}`);
}

function parseDate(v: unknown): Date | null {
  if (!v) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'string') {
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

export async function handleBulkPairSync(
  job: Job<{ bulkId: string; pairId: number; manual?: boolean; mode?: 'auto' | 'backup' }>,
) {
  const { bulkId, pairId } = job.data;
  const manual = !!job.data.manual;

  const [b] = await db.select().from(bulkMigration).where(eq(bulkMigration.id, bulkId));
  if (!b) {
    // Bulk gone — drop the schedule so we stop retrying forever.
    await bulkPairSyncQueueRef.removeJobScheduler(`bulk-pair-sync:${pairId}`).catch(() => {});
    return { skipped: 'bulk-gone' };
  }
  const [pair] = await db
    .select()
    .from(bulkPair)
    .where(and(eq(bulkPair.id, pairId), eq(bulkPair.bulkId, bulkId)));
  if (!pair) {
    await bulkPairSyncQueueRef.removeJobScheduler(`bulk-pair-sync:${pairId}`).catch(() => {});
    return { skipped: 'pair-gone' };
  }

  // Don't try to sync a pair whose initial run never completed.
  if (pair.status !== 'completed' && !manual) {
    return { skipped: `pair-status-${pair.status}` };
  }

  const settings = (b.settings as Record<string, unknown> | null) ?? {};
  const autoSync = settings.autoSync === true;
  const backupMode = settings.backupMode === true;

  // Settings flipped off after we were scheduled — silently drop the
  // schedule. Manual one-offs bypass this check.
  if (!manual && !autoSync && !backupMode) {
    await bulkPairSyncQueueRef.removeJobScheduler(`bulk-pair-sync:${pairId}`).catch(() => {});
    return { skipped: 'sync-disabled' };
  }

  const throttleBps =
    settings.throttleEnabled === true
      ? Math.floor((((settings.throttleGbPerDay as number) ?? 1) * 1024 ** 3) / 86400)
      : undefined;
  const dateFrom = settings.dateFilterEnabled === true ? parseDate(settings.dateFrom) : null;
  const dateTo = settings.dateFilterEnabled === true ? parseDate(settings.dateTo) : null;
  const emailHeaderSettings = await resolveEmailHeaderSetting(settings);

  const publish = (data: object): void => {
    void pub.publish(`bulk:${bulkId}`, JSON.stringify({ pairId, syncTick: true, ...data }));
  };

  publish({ kind: 'sync-status', running: true, manual });

  let resolveDone!: () => void;
  let rejectDone!: (e: Error) => void;
  const done = new Promise<void>((res, rej) => {
    resolveDone = res;
    rejectDone = rej;
  });

  const cleanupRef: { fn: (() => Promise<void>) | null } = { fn: null };
  const childRef: { c: ChildProcess | null } = { c: null };

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
        // Use a stable per-pair migrationId namespace so imapsync state files
        // and pidfiles don't collide between the initial run and the sync
        // ticks. Suffix distinguishes the sync run from the original bulk
        // run (which used `bulk-${bulkId}-pair-${pairId}` directly).
        migrationId: `bulk-${bulkId}-pair-${pairId}-sync`,
        dateFrom,
        dateTo,
        throttleBytesPerSecond: throttleBps,
        enableCache: settings.enableCache === true,
        reduceBandwidth: settings.reduceBandwidth === true,
        syncDuplicates: settings.syncDuplicates === true,
        emailHeaderSettings,
      },
      (ev) => {
        if (ev.kind === 'done') {
          if (ev.ok) resolveDone();
          else rejectDone(new Error(ev.error ?? 'sync failed'));
        }
      },
    );
    childRef.c = handle.child;
    cleanupRef.fn = handle.cleanup;
    handle.child.on('error', (e) => rejectDone(e));
    await done;
    publish({ kind: 'sync-status', running: false, ok: true, manual });
    return { ok: true };
  } catch (e: any) {
    publish({ kind: 'sync-status', running: false, ok: false, error: e?.message, manual });
    void createNotification({
      kind: 'error',
      title: 'Pair sync failed',
      body: `${pair.sourceUsername}: ${e?.message ?? 'imapsync error'}`,
      linkPath: `/bulk/${bulkId}`,
      bulkId,
    });
    throw e;
  } finally {
    if (cleanupRef.fn) await cleanupRef.fn();
  }
}
