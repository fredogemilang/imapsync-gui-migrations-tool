import { and, eq, sql } from 'drizzle-orm';
import type { Job } from 'bullmq';
import type { ChildProcess } from 'node:child_process';
import { Redis } from 'ioredis';
import { db, imapAccount, migration, migrationLog, syncRun } from '../db.js';
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

  // Open a sync_run row. Every per-run log line gets tagged with this id
  // so the UI can group history per run. trigger reflects how we got here:
  //   manual    → user clicked Sync Now
  //   m.syncMode → 'auto' (Auto Sync) or 'backup' (Backup Mode)
  const trigger: 'manual' | 'auto' | 'backup' = manual
    ? 'manual'
    : m.syncMode === 'backup'
      ? 'backup'
      : 'auto';
  const [run] = await db
    .insert(syncRun)
    .values({ migrationId: id, trigger, status: 'running' })
    .returning({ id: syncRun.id });
  const runId = run!.id;

  const publish = (data: object): void => {
    void pub.publish(`migration:${id}`, JSON.stringify({ syncTick: true, runId, ...data }));
  };

  publish({ kind: 'sync-status', running: true, manual, runId, trigger });
  publish({ kind: 'sync-run-started', runId, trigger });
  void db.insert(migrationLog).values({
    migrationId: id,
    syncRunId: runId,
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

  // Cancellation wiring — mirror of bulk-pair-sync. POST /sync/stop on
  // the API publishes a one-byte message on `migration-sync-cancel:<id>`
  // and we SIGTERM the running imapsync child here. Mark cancelledByUser
  // so the catch block can distinguish a user-initiated cancel (→ status
  // 'cancelled', no bell, no BullMQ retry) from a real failure.
  let cancelledByUser = false;
  const cancelChannel = `migration-sync-cancel:${id}`;
  const cancelSub = new Redis({
    host: env.REDIS_HOST,
    port: env.REDIS_PORT,
    maxRetriesPerRequest: null,
  });
  await cancelSub.subscribe(cancelChannel);
  cancelSub.on('message', (chan) => {
    if (chan !== cancelChannel) return;
    cancelledByUser = true;
    const ch = childRef.c;
    if (ch) {
      try {
        ch.kill('SIGTERM');
      } catch {
        // already exited
      }
      // Hard kill fallback after 10s if imapsync ignores SIGTERM.
      setTimeout(() => {
        try {
          ch.kill('SIGKILL');
        } catch {
          // already exited
        }
      }, 10_000).unref();
    }
  });
  // Per-run running totals. Aggregated from imapsync's `folder-stats` events
  // so the UI can show "synced N emails / M MB" once the run is done.
  let runEmails = 0;
  let runBytes = 0;

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
        // Namespace the imapsync state dir so a delta-sync tick can never
        // share pidfile / .pw1 / .pw2 with the initial single-migration job
        // (which uses just `id`). If the syncRunning guard ever fails to
        // engage (race, manual DB poke) the two children would otherwise
        // corrupt each other's tempfiles. Bulk pair sync uses the same
        // `-sync` suffix convention.
        migrationId: `${id}-sync`,
        dateFrom,
        dateTo,
        throttleBytesPerSecond: throttleBps,
        enableCache: settings.enableCache,
        reduceBandwidth: settings.reduceBandwidth,
        syncDuplicates: settings.syncDuplicates,
        emailHeaderSettings,
      },
      (ev) => {
        if (ev.kind === 'log') {
          void db
            .insert(migrationLog)
            .values({ migrationId: id, syncRunId: runId, level: ev.level, message: ev.message })
            .catch(() => {});
          // Stream individual lines so the YourMigration "live logs" panel
          // can render them without polling. Cheap — same channel as status.
          publish({ kind: 'sync-run-log', runId, level: ev.level, message: ev.message });
        } else if (ev.kind === 'folder-stats') {
          runEmails += ev.copied ?? 0;
          runBytes += ev.bytes ?? 0;
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
    const finishedAt = new Date();
    await db
      .update(migration)
      .set({
        syncRunning: false,
        lastSyncAt: finishedAt,
        // Roll the per-run delta up to the migration's lifetime counters so
        // the headline stats on the YourMigration card reflect everything
        // copied, not just the initial run.
        migratedEmails: sql`${migration.migratedEmails} + ${runEmails}`,
        migratedBytes: sql`${migration.migratedBytes} + ${runBytes}`,
      })
      .where(eq(migration.id, id));
    await db
      .update(syncRun)
      .set({
        status: 'success',
        finishedAt,
        migratedEmails: runEmails,
        migratedBytes: runBytes,
      })
      .where(eq(syncRun.id, runId));
    void db.insert(migrationLog).values({
      migrationId: id,
      syncRunId: runId,
      level: 'info',
      message: `Sync completed — ${runEmails} new emails, ${runBytes} bytes`,
    });
    publish({
      kind: 'sync-run-finished',
      runId,
      ok: true,
      migratedEmails: runEmails,
      migratedBytes: runBytes,
    });
    publish({ kind: 'sync-status', running: false, ok: true, manual, runId });
  } catch (e: any) {
    // Distinguish user-initiated cancel from a real failure: the former
    // is marked 'cancelled', skips the bell notification, and does NOT
    // rethrow (so BullMQ doesn't retry on next backoff tick).
    if (cancelledByUser) {
      const cancelMsg = 'Cancelled by user';
      const finishedAt = new Date();
      await db.update(migration).set({ syncRunning: false }).where(eq(migration.id, id));
      await db
        .update(syncRun)
        .set({
          status: 'cancelled',
          finishedAt,
          errorMessage: cancelMsg,
          migratedEmails: runEmails,
          migratedBytes: runBytes,
        })
        .where(eq(syncRun.id, runId));
      publish({ kind: 'sync-run-finished', runId, ok: false, error: 'cancelled' });
      publish({
        kind: 'sync-status',
        running: false,
        ok: false,
        error: 'cancelled',
        manual,
        runId,
      });
      void db.insert(migrationLog).values({
        migrationId: id,
        syncRunId: runId,
        level: 'warn',
        message: 'Sync cancelled by user',
      });
      return { cancelled: true };
    }

    const errorMessage = e?.message ?? 'imapsync exited with error';
    const finishedAt = new Date();
    await db.update(migration).set({ syncRunning: false }).where(eq(migration.id, id));
    await db
      .update(syncRun)
      .set({
        status: 'failed',
        finishedAt,
        errorMessage,
        // Keep whatever partial totals we tallied so the user can see
        // "synced 3 emails before failing" rather than a flat 0.
        migratedEmails: runEmails,
        migratedBytes: runBytes,
      })
      .where(eq(syncRun.id, runId));
    publish({ kind: 'sync-run-finished', runId, ok: false, error: errorMessage });
    publish({ kind: 'sync-status', running: false, ok: false, error: errorMessage, manual, runId });
    void db.insert(migrationLog).values({
      migrationId: id,
      syncRunId: runId,
      level: 'error',
      message: `Sync failed: ${errorMessage}`,
    });
    // Surface to the bell so the admin notices even if they never visit
    // the migration page. Successes are silent — too noisy.
    void createNotification({
      kind: 'error',
      title: manual ? 'Manual sync failed' : 'Scheduled sync failed',
      body: errorMessage,
      linkPath: `/migrations/${id}`,
      migrationId: id,
    });
    throw e;
  } finally {
    if (cleanupRef.fn) await cleanupRef.fn();
    // Tear down the cancel subscriber connection.
    await cancelSub.unsubscribe(cancelChannel).catch(() => {});
    await cancelSub.quit().catch(() => {});
  }
}
