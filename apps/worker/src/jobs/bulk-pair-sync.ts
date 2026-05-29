import { and, desc, eq, gte, isNull, sql } from 'drizzle-orm';
import type { Job } from 'bullmq';
import type { ChildProcess } from 'node:child_process';
import { Redis } from 'ioredis';
import { Queue } from 'bullmq';
import { db, bulkMigration, bulkPair, bulkPairLog, bulkSyncSession, syncRun } from '../db.js';
import { decrypt } from '../crypto.js';
import { runImapsync, type Security } from '../imapsync.js';
import { resolveEmailHeaderSetting } from '../app-settings.js';
import { createNotification } from '../notifications.js';
import { env } from '../env.js';

/** Window for grouping auto/backup pair ticks into one session. A pair
 *  whose sync starts within 30 minutes of an existing running session of
 *  the same trigger joins that session; otherwise a new one is opened. */
const AUTO_SESSION_WINDOW_MS = 30 * 60 * 1000;

/**
 * Resolve the bulk-sync-session this pair-sync should attach to.
 *
 * - Manual Sync Now: caller passes sessionId in job data (API creates
 *   the session row up-front so the guard can check for an in-flight
 *   one). Just look it up and bump totalPairs counter.
 *
 * - Auto / Backup: per-pair schedules tick independently, so we lazily
 *   create-or-attach a session. Find a 'running' session of the same
 *   (bulkId, type) that started within AUTO_SESSION_WINDOW_MS — if yes,
 *   attach and bump totalPairs. If none, create a new session.
 *
 * Returns the session id (or null if we couldn't allocate, in which case
 * the run still proceeds — it just won't be grouped in the history).
 */
async function resolveSession(
  bulkId: string,
  type: 'manual' | 'auto' | 'backup',
  explicitSessionId: string | null,
): Promise<string | null> {
  if (explicitSessionId) {
    // Validate it still exists and is for this bulk — defensive against
    // stale job data after a session cascade-delete.
    const [existing] = await db
      .select({ id: bulkSyncSession.id })
      .from(bulkSyncSession)
      .where(and(eq(bulkSyncSession.id, explicitSessionId), eq(bulkSyncSession.bulkId, bulkId)))
      .limit(1);
    if (existing) {
      await db
        .update(bulkSyncSession)
        .set({ totalPairs: sql`${bulkSyncSession.totalPairs} + 1` })
        .where(eq(bulkSyncSession.id, explicitSessionId));
      return explicitSessionId;
    }
    // explicit id but row gone — fall through to lazy create.
  }
  // Lazy attach for auto/backup. Find an existing running session within
  // the window.
  const cutoff = new Date(Date.now() - AUTO_SESSION_WINDOW_MS);
  const [running] = await db
    .select({ id: bulkSyncSession.id })
    .from(bulkSyncSession)
    .where(
      and(
        eq(bulkSyncSession.bulkId, bulkId),
        eq(bulkSyncSession.type, type),
        eq(bulkSyncSession.status, 'running'),
        gte(bulkSyncSession.startedAt, cutoff),
      ),
    )
    .orderBy(desc(bulkSyncSession.startedAt))
    .limit(1);
  if (running) {
    await db
      .update(bulkSyncSession)
      .set({ totalPairs: sql`${bulkSyncSession.totalPairs} + 1` })
      .where(eq(bulkSyncSession.id, running.id));
    return running.id;
  }
  // No active session — open a new one.
  const [fresh] = await db
    .insert(bulkSyncSession)
    .values({ bulkId, type, status: 'running', totalPairs: 1 })
    .returning({ id: bulkSyncSession.id });
  return fresh?.id ?? null;
}

/**
 * Increment session counters when a pair sync finishes. If we've now
 * reached totalPairs (all pairs accounted for via success or failure),
 * mark the session 'finished' (or 'failed' if every pair failed).
 *
 * The arithmetic relies on totalPairs being set before the first pair
 * finishes — which holds because resolveSession bumps it on attach,
 * BEFORE the imapsync subprocess runs.
 */
async function tickSessionDone(sessionId: string | null, ok: boolean): Promise<void> {
  if (!sessionId) return;
  await db
    .update(bulkSyncSession)
    .set({
      finishedPairs: sql`${bulkSyncSession.finishedPairs} + 1`,
      ...(ok ? {} : { failedPairs: sql`${bulkSyncSession.failedPairs} + 1` }),
    })
    .where(eq(bulkSyncSession.id, sessionId));
  // Re-read to see whether we crossed the finish line.
  const [s] = await db
    .select()
    .from(bulkSyncSession)
    .where(eq(bulkSyncSession.id, sessionId))
    .limit(1);
  if (!s) return;
  if (s.finishedPairs >= s.totalPairs && s.totalPairs > 0) {
    await db
      .update(bulkSyncSession)
      .set({
        status: s.failedPairs >= s.totalPairs ? 'failed' : 'finished',
        finishedAt: new Date(),
      })
      .where(and(eq(bulkSyncSession.id, sessionId), eq(bulkSyncSession.status, 'running')));
  }
}

// Silence unused-import warnings for helpers exported only for tests.
void isNull;

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
  job: Job<{
    bulkId: string;
    pairId: number;
    manual?: boolean;
    mode?: 'auto' | 'backup';
    /** Set by the API's Sync Now path so all enqueued pair jobs roll up
     *  to the same session row. Auto/backup leave it undefined and the
     *  worker resolves a session lazily based on a time-window match. */
    sessionId?: string;
  }>,
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
  // 'completed_with_errors' is OK: most of its mailbox copied; the
  // sync tick can pick up new messages just like a clean 'completed' pair.
  if (pair.status !== 'completed' && pair.status !== 'completed_with_errors' && !manual) {
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

  // Open a sync_run row keyed by (bulkId, bulkPairId). Logs from this run
  // are tagged with the returned id so the UI can drill from pair → run →
  // log lines. Trigger derived from bulk-level settings (backupMode wins
  // when both are on — same precedence as the bulk worker's scheduling).
  const trigger: 'manual' | 'auto' | 'backup' = manual ? 'manual' : backupMode ? 'backup' : 'auto';
  // Resolve the bulk-level session this run belongs to. For manual the
  // session was created by the API at Sync Now time; for auto/backup we
  // lazily group within a 30-minute tick window.
  const sessionId = await resolveSession(bulkId, trigger, job.data.sessionId ?? null);
  const [run] = await db
    .insert(syncRun)
    .values({ bulkId, bulkPairId: pairId, sessionId, trigger, status: 'running' })
    .returning({ id: syncRun.id });
  const runId = run!.id;

  const publish = (data: object): void => {
    void pub.publish(`bulk:${bulkId}`, JSON.stringify({ pairId, syncTick: true, runId, ...data }));
  };

  publish({ kind: 'sync-status', running: true, manual, runId, trigger });
  publish({ kind: 'sync-run-started', runId, trigger });
  void db.insert(bulkPairLog).values({
    bulkPairId: pairId,
    syncRunId: runId,
    level: 'info',
    message: manual ? 'Manual Sync Now started' : `Scheduled sync (${trigger}) started`,
  });

  let resolveDone!: () => void;
  let rejectDone!: (e: Error) => void;
  const done = new Promise<void>((res, rej) => {
    resolveDone = res;
    rejectDone = rej;
  });

  const cleanupRef: { fn: (() => Promise<void>) | null } = { fn: null };
  const childRef: { c: ChildProcess | null } = { c: null };
  // Per-run running totals, aggregated from imapsync folder-stats events.
  let runEmails = 0;
  let runBytes = 0;

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
        if (ev.kind === 'log') {
          void db
            .insert(bulkPairLog)
            .values({
              bulkPairId: pairId,
              syncRunId: runId,
              level: ev.level,
              message: ev.message,
            })
            .catch(() => {});
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
      .update(syncRun)
      .set({
        status: 'success',
        finishedAt,
        migratedEmails: runEmails,
        migratedBytes: runBytes,
      })
      .where(eq(syncRun.id, runId));
    void db.insert(bulkPairLog).values({
      bulkPairId: pairId,
      syncRunId: runId,
      level: 'info',
      message: `Sync completed — ${runEmails} new emails, ${runBytes} bytes`,
    });
    publish({
      kind: 'sync-run-finished',
      runId,
      sessionId,
      ok: true,
      migratedEmails: runEmails,
      migratedBytes: runBytes,
    });
    publish({ kind: 'sync-status', running: false, ok: true, manual, runId, sessionId });
    await tickSessionDone(sessionId, true);
    return { ok: true };
  } catch (e: any) {
    const errorMessage = e?.message ?? 'imapsync error';
    await db
      .update(syncRun)
      .set({
        status: 'failed',
        finishedAt: new Date(),
        errorMessage,
        migratedEmails: runEmails,
        migratedBytes: runBytes,
      })
      .where(eq(syncRun.id, runId));
    void db.insert(bulkPairLog).values({
      bulkPairId: pairId,
      syncRunId: runId,
      level: 'error',
      message: `Sync failed: ${errorMessage}`,
    });
    publish({ kind: 'sync-run-finished', runId, sessionId, ok: false, error: errorMessage });
    publish({
      kind: 'sync-status',
      running: false,
      ok: false,
      error: errorMessage,
      manual,
      runId,
      sessionId,
    });
    await tickSessionDone(sessionId, false).catch(() => {});
    void createNotification({
      kind: 'error',
      title: 'Pair sync failed',
      body: `${pair.sourceUsername}: ${errorMessage}`,
      linkPath: `/bulk/${bulkId}`,
      bulkId,
    });
    throw e;
  } finally {
    if (cleanupRef.fn) await cleanupRef.fn();
  }
}
