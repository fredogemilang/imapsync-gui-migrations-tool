import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import type { Job } from 'bullmq';
import { db, imapAccount, migration, migrationFolder, migrationLog } from '../db.js';
import { decrypt } from '../crypto.js';
import { scanFolders } from '../imap-scan.js';
import { runImapsync, type ProgressEvent, type Security } from '../imapsync.js';
import { env } from '../env.js';

const pub = new Redis({ host: env.REDIS_HOST, port: env.REDIS_PORT, maxRetriesPerRequest: null });
const cancelSub = new Redis({
  host: env.REDIS_HOST,
  port: env.REDIS_PORT,
  maxRetriesPerRequest: null,
});

function parseDate(v: unknown): Date | null {
  if (!v) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'string') {
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

// Narrow DB string → Security literal at the boundary. Throws if a row was
// inserted with an unexpected value (defends against finding #8: future
// SQL-direct inserts bypassing API zod validation).
function asSecurity(s: string): Security {
  if (s === 'SSL/TLS' || s === 'STARTTLS' || s === 'None') return s;
  throw new Error(`Invalid security value in DB: ${JSON.stringify(s)}`);
}

export async function handleSingleMigration(job: Job<{ migrationId: string; resume?: boolean }>) {
  const id = job.data.migrationId;
  const [m] = await db.select().from(migration).where(eq(migration.id, id));
  if (!m) throw new Error(`Migration ${id} not found`);

  const [src] = await db.select().from(imapAccount).where(eq(imapAccount.id, m.sourceAccountId));
  const [tgt] = await db.select().from(imapAccount).where(eq(imapAccount.id, m.targetAccountId));
  if (!src || !tgt) throw new Error('Account not found');

  const srcCfg = {
    host: src.host,
    port: src.port,
    security: asSecurity(src.security),
    username: src.username,
    password: decrypt(src.passwordEnc),
  };
  const tgtCfg = {
    host: tgt.host,
    port: tgt.port,
    security: asSecurity(tgt.security),
    username: tgt.username,
    password: decrypt(tgt.passwordEnc),
  };

  // Fire-and-forget publish/log helpers — failure must NOT block migration flow.
  const publish = (data: object): void => {
    void pub.publish(`migration:${id}`, JSON.stringify(data));
  };
  const log = (level: string, message: string): void => {
    void db
      .insert(migrationLog)
      .values({ migrationId: id, level, message })
      .catch(() => {});
  };

  // --- Phase 1: scan source folders for counts ---
  await db
    .update(migration)
    .set({ status: 'scanning', startedAt: new Date() })
    .where(eq(migration.id, id));
  publish({ kind: 'status', status: 'scanning' });
  log('info', 'Scanning source folders');

  let folders: { name: string; totalEmails: number; totalBytes: number }[] = [];
  try {
    folders = await scanFolders(srcCfg);
  } catch (e: any) {
    await db
      .update(migration)
      .set({ status: 'failed', error: `Scan failed: ${e?.message}` })
      .where(eq(migration.id, id));
    publish({ kind: 'done', ok: false, error: e?.message });
    throw e;
  }

  const totalEmails = folders.reduce((a, f) => a + f.totalEmails, 0);
  const totalBytes = folders.reduce((a, f) => a + f.totalBytes, 0);

  if (!job.data.resume) {
    await db.delete(migrationFolder).where(eq(migrationFolder.migrationId, id));
    for (const f of folders) {
      await db.insert(migrationFolder).values({
        migrationId: id,
        name: f.name,
        totalEmails: f.totalEmails,
        totalBytes: f.totalBytes,
        migratedEmails: 0,
        status: 'pending',
      });
    }
  }
  await db.update(migration).set({ totalEmails, totalBytes }).where(eq(migration.id, id));
  publish({ kind: 'scan-complete', folders });

  // --- Phase 2: imapsync execution ---
  await db.update(migration).set({ status: 'running' }).where(eq(migration.id, id));
  publish({ kind: 'status', status: 'running' });

  const settings = (m.settings as any) ?? {};
  const throttleBps = settings.throttleEnabled
    ? Math.floor(((settings.throttleGbPerDay ?? 1) * 1024 ** 3) / 86400)
    : undefined;

  const dateFrom = settings.dateFilterEnabled ? parseDate(settings.dateFrom) : null;
  const dateTo = settings.dateFilterEnabled ? parseDate(settings.dateTo) : null;

  const cancelChannel = `migration-cancel:${id}`;
  let cancelled = false;
  let childRef: { kill: (signal?: NodeJS.Signals) => boolean } | null = null;

  const onCancelMsg = (chan: string) => {
    if (chan !== cancelChannel) return;
    cancelled = true;
    if (childRef) childRef.kill('SIGTERM');
    setTimeout(() => {
      if (childRef) childRef.kill('SIGKILL');
    }, 10_000).unref();
  };
  await cancelSub.subscribe(cancelChannel);
  cancelSub.on('message', onCancelMsg);

  type CleanupFn = () => Promise<void>;
  const cleanupRef: { fn: CleanupFn | null } = { fn: null };

  // Build a Promise whose resolve/reject we hand to the imapsync event callback.
  // (Avoid async Promise executor — anti-pattern: swallowed rejections.)
  let resolveDone!: () => void;
  let rejectDone!: (e: Error) => void;
  const done = new Promise<void>((res, rej) => {
    resolveDone = res;
    rejectDone = rej;
  });

  try {
    const handle = await runImapsync(
      {
        source: srcCfg,
        target: tgtCfg,
        migrationId: id,
        dateFrom,
        dateTo,
        throttleBytesPerSecond: throttleBps,
        enableCache: settings.enableCache,
        reduceBandwidth: settings.reduceBandwidth,
      },
      (ev: ProgressEvent) => {
        publish(ev);
        if (ev.kind === 'folder') {
          void db.update(migration).set({ currentFolder: ev.name }).where(eq(migration.id, id));
        } else if (ev.kind === 'percent') {
          void db
            .update(migration)
            .set({ progressPercent: ev.percent })
            .where(eq(migration.id, id));
        } else if (ev.kind === 'log') {
          log(ev.level, ev.message);
        } else if (ev.kind === 'done') {
          if (ev.ok) {
            void db
              .update(migration)
              .set({
                status: 'completed',
                progressPercent: 100,
                migratedEmails: totalEmails,
                finishedAt: new Date(),
              })
              .where(eq(migration.id, id))
              .then(() => resolveDone())
              .catch((err) => rejectDone(err as Error));
          } else if (cancelled) {
            void db
              .update(migration)
              .set({ status: 'cancelled', finishedAt: new Date() })
              .where(eq(migration.id, id))
              .then(() => resolveDone()) // graceful: cancellation is not a job-level failure
              .catch((err) => rejectDone(err as Error));
          } else {
            void db
              .update(migration)
              .set({ status: 'failed', error: ev.error, finishedAt: new Date() })
              .where(eq(migration.id, id))
              .finally(() => rejectDone(new Error(ev.error ?? 'imapsync failed')));
          }
        }
      },
    );
    childRef = handle.child;
    cleanupRef.fn = handle.cleanup;
    handle.child.on('error', (e) => rejectDone(e));
    await done;
  } finally {
    cancelSub.off('message', onCancelMsg);
    await cancelSub.unsubscribe(cancelChannel).catch(() => {});
    if (cleanupRef.fn) await cleanupRef.fn();
  }
}
