import { and, eq } from 'drizzle-orm';
import type { Job } from 'bullmq';
import type { ChildProcess } from 'node:child_process';
import { Redis } from 'ioredis';
import { db, imapAccount, migration, migrationLog } from '../db.js';
import { decrypt } from '../crypto.js';
import { runImapsync, type Security } from '../imapsync.js';
import { resolveEmailHeaderSetting } from '../app-settings.js';
import { createNotification } from '../notifications.js';
import { env } from '../env.js';

const pub = new Redis({ host: env.REDIS_HOST, port: env.REDIS_PORT, maxRetriesPerRequest: null });

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

/**
 * Delta sync job — runs imapsync against an existing migration. imapsync
 * naturally only copies messages not already in target (header-based dedup
 * unless syncDuplicates=true). Used for:
 *   - Auto Sync (every 3h, 10-day cap)
 *   - Backup Mode (every interval, forever)
 *   - "Sync Now" one-off
 *
 * Self-disables when:
 *   - migration row no longer exists / is cancelled
 *   - syncMode='off' (user disabled)
 *   - syncEndsAt has passed (auto-sync 10-day expiry)
 *   - syncRunning=true already (skip — prior tick still running)
 */
export async function handleSyncJob(job: Job<{ migrationId: string; manual?: boolean }>) {
  const id = job.data.migrationId;
  const manual = !!job.data.manual;
  const [m] = await db.select().from(migration).where(eq(migration.id, id));

  // Guard: migration vanished or in terminal failure → drop the schedule.
  if (!m || m.status === 'cancelled') {
    return { skipped: 'migration-gone' };
  }

  // Guard: scheduled sync requires syncMode to still be on. Manual is allowed
  // regardless (Sync Now is a one-off override).
  if (!manual && m.syncMode === 'off') {
    return { skipped: 'sync-disabled' };
  }

  // Guard: 10-day cap on Auto Sync.
  if (!manual && m.syncEndsAt && Date.now() >= m.syncEndsAt.getTime()) {
    await db
      .update(migration)
      .set({ syncMode: 'off', syncIntervalMs: null, syncEndsAt: null })
      .where(eq(migration.id, id));
    return { skipped: 'sync-expired' };
  }

  // Guard: skip if a prior tick is still running.
  if (m.syncRunning) {
    return { skipped: 'already-running' };
  }

  // Mark running (atomic-ish via WHERE)
  const updated = await db
    .update(migration)
    .set({ syncRunning: true })
    .where(and(eq(migration.id, id), eq(migration.syncRunning, false)));
  // drizzle returns row count via .returning() only; if we can't atomically
  // detect a race, just proceed — the cost of a double-run is acceptable
  // (imapsync's dedup makes it idempotent).
  void updated;

  const [src] = await db.select().from(imapAccount).where(eq(imapAccount.id, m.sourceAccountId));
  const [tgt] = await db.select().from(imapAccount).where(eq(imapAccount.id, m.targetAccountId));
  if (!src || !tgt) {
    await db.update(migration).set({ syncRunning: false }).where(eq(migration.id, id));
    throw new Error('Account vanished');
  }

  const settings = (m.settings as any) ?? {};
  const throttleBps = settings.throttleEnabled
    ? Math.floor(((settings.throttleGbPerDay ?? 1) * 1024 ** 3) / 86400)
    : undefined;
  const dateFrom = settings.dateFilterEnabled ? parseDate(settings.dateFrom) : null;
  const dateTo = settings.dateFilterEnabled ? parseDate(settings.dateTo) : null;
  const emailHeaderSettings = await resolveEmailHeaderSetting(settings);

  const publish = (data: object): void => {
    void pub.publish(`migration:${id}`, JSON.stringify({ syncTick: true, ...data }));
  };

  publish({ kind: 'sync-status', running: true, manual });
  void db.insert(migrationLog).values({
    migrationId: id,
    level: 'info',
    message: manual ? 'Manual Sync Now started' : `Scheduled sync (${m.syncMode}) started`,
  });

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
          host: src.host,
          port: src.port,
          security: asSecurity(src.security),
          username: src.username,
          password: decrypt(src.passwordEnc),
        },
        target: {
          host: tgt.host,
          port: tgt.port,
          security: asSecurity(tgt.security),
          username: tgt.username,
          password: decrypt(tgt.passwordEnc),
        },
        migrationId: id,
        dateFrom,
        dateTo,
        throttleBytesPerSecond: throttleBps,
        enableCache: settings.enableCache,
        reduceBandwidth: settings.reduceBandwidth,
        syncDuplicates: settings.syncDuplicates,
        emailHeaderSettings,
      },
      (ev) => {
        // Delta-sync progress is generally short; we just stream completion.
        if (ev.kind === 'log') {
          void db
            .insert(migrationLog)
            .values({ migrationId: id, level: ev.level, message: ev.message })
            .catch(() => {});
        } else if (ev.kind === 'done') {
          if (ev.ok) resolveDone();
          else rejectDone(new Error(ev.error ?? 'sync failed'));
        }
      },
    );
    childRef.c = handle.child;
    cleanupRef.fn = handle.cleanup;
    handle.child.on('error', (e) => rejectDone(e));
    await done;
    await db
      .update(migration)
      .set({ syncRunning: false, lastSyncAt: new Date() })
      .where(eq(migration.id, id));
    publish({ kind: 'sync-status', running: false, ok: true, manual });
  } catch (e: any) {
    await db.update(migration).set({ syncRunning: false }).where(eq(migration.id, id));
    publish({ kind: 'sync-status', running: false, ok: false, error: e?.message, manual });
    void db.insert(migrationLog).values({
      migrationId: id,
      level: 'error',
      message: `Sync failed: ${e?.message}`,
    });
    // Surface to the bell so the admin notices even if they never visit
    // the migration page. Successes are silent — too noisy.
    void createNotification({
      kind: 'error',
      title: manual ? 'Manual sync failed' : 'Scheduled sync failed',
      body: e?.message ?? 'imapsync exited with error',
      linkPath: `/migrations/${id}`,
      migrationId: id,
    });
    throw e;
  } finally {
    if (cleanupRef.fn) await cleanupRef.fn();
  }
}
