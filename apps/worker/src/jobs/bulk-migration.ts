import { and, eq, inArray } from 'drizzle-orm';
import type { Job } from 'bullmq';
import { Redis } from 'ioredis';
import type { ChildProcess } from 'node:child_process';
import { db, bulkMigration, bulkPair } from '../db.js';
import { decrypt } from '../crypto.js';
import { runImapsync, type Security } from '../imapsync.js';
import { env } from '../env.js';

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

  if (finalStatus === 'failed') {
    throw new Error(`All ${pairs.length} pairs failed`);
  }
}
