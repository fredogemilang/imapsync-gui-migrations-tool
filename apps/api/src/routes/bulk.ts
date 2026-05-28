import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { bulkMigration, bulkPair, bulkPairLog, syncRun } from '../db/schema.js';
import { encrypt } from '../lib/crypto.js';
import { bulkPairSyncJobId, bulkPairSyncQueue, bulkQueue } from '../lib/queue.js';
import { redis } from '../lib/redis.js';
import { subscribeSSE } from '../lib/sse-bus.js';
import { enqueueBulkSyncNow, reconcileBulkPairSyncs } from '../lib/bulk-sync.js';

const BULK_TERMINAL = ['completed', 'completed_with_errors', 'failed', 'cancelled'] as const;

const Pair = z.object({
  sourceUsername: z.string().min(1),
  sourcePassword: z.string().min(1),
  targetUsername: z.string().min(1),
  targetPassword: z.string().min(1),
  /** Captured from the per-row Sync/Backup checkboxes on the bulk page.
   *  The worker doesn't act on these yet — they're stored for a future
   *  enhancement that wires up post-migration auto-sync per pair. */
  sync: z.boolean().optional().default(false),
  backup: z.boolean().optional().default(false),
});

const CreateBulkBody = z.object({
  sourceHost: z.string().min(1),
  sourcePort: z.number().int().default(993),
  sourceSecurity: z.enum(['SSL/TLS', 'STARTTLS', 'None']).default('SSL/TLS'),
  targetHost: z.string().min(1),
  targetPort: z.number().int().default(993),
  targetSecurity: z.enum(['SSL/TLS', 'STARTTLS', 'None']).default('SSL/TLS'),
  pairs: z.array(Pair).min(1).max(1000),
  settings: z.record(z.any()).default({}),
});

export async function bulkRoutes(app: FastifyInstance) {
  app.get('/api/bulk-migrations', { preHandler: [app.requireAuth] }, async () => {
    const bulks = await db.select().from(bulkMigration).orderBy(desc(bulkMigration.createdAt));

    // Enrich each bulk row with its pair count + how many have completed
    // so the Overview can render a "3/10 completed" hint without an N+1
    // round-trip per row.
    if (bulks.length === 0) return [];
    const counts = await db
      .select({
        bulkId: bulkPair.bulkId,
        total: sql<number>`count(*)::int`,
        completed: sql<number>`sum(case when ${bulkPair.status} = 'completed' then 1 else 0 end)::int`,
        failed: sql<number>`sum(case when ${bulkPair.status} = 'failed' then 1 else 0 end)::int`,
      })
      .from(bulkPair)
      .where(
        inArray(
          bulkPair.bulkId,
          bulks.map((b) => b.id),
        ),
      )
      .groupBy(bulkPair.bulkId);
    const byId = new Map(counts.map((c) => [c.bulkId, c]));
    return bulks.map((b) => ({
      ...b,
      pairCount: byId.get(b.id)?.total ?? 0,
      completedPairs: byId.get(b.id)?.completed ?? 0,
      failedPairs: byId.get(b.id)?.failed ?? 0,
    }));
  });

  // Patch the bulk migration's settings JSON. Used by the YourBulkMigration
  // page to let the admin toggle Auto Sync / Backup Mode / advanced flags
  // after the bulk has finished. Merge-style: only the supplied keys are
  // overwritten so a partial PATCH doesn't blow away other fields.
  const SettingsPatch = z
    .object({
      autoSync: z.boolean().optional(),
      backupMode: z.boolean().optional(),
      backupInterval: z.enum(['daily', 'weekly', 'monthly']).optional(),
      throttleEnabled: z.boolean().optional(),
      throttleGbPerDay: z.number().optional(),
      syncDuplicates: z.boolean().optional(),
      enableCache: z.boolean().optional(),
      reduceBandwidth: z.boolean().optional(),
      dateFilterEnabled: z.boolean().optional(),
      dateFrom: z.string().optional(),
      dateTo: z.string().optional(),
    })
    .strict();

  app.patch(
    '/api/bulk-migrations/:id/settings',
    { preHandler: [app.requireAuth] },
    async (req, reply) => {
      const id = (req.params as any).id as string;
      const patch = SettingsPatch.parse(req.body);
      const [b] = await db.select().from(bulkMigration).where(eq(bulkMigration.id, id)).limit(1);
      if (!b) return reply.code(404).send({ error: 'Not found' });
      const merged = { ...(b.settings as object), ...patch };
      await db
        .update(bulkMigration)
        .set({ settings: merged as any })
        .where(eq(bulkMigration.id, id));
      // Re-arm per-pair sync schedules to match the new settings —
      // upserts new schedule when autoSync/backupMode is true, removes
      // when both are false. Fire-and-forget: a failure here doesn't
      // invalidate the settings write.
      void reconcileBulkPairSyncs(id).catch((e) =>
        console.error(`[bulk-sync] reconcile failed for ${id}:`, e),
      );
      return { ok: true, settings: merged };
    },
  );

  // One-off "Sync Now" — enqueues a sync job for every completed pair
  // (parallel). Returns the count so the UI can show "Syncing N mailboxes".
  app.post(
    '/api/bulk-migrations/:id/sync/now',
    { preHandler: [app.requireAuth] },
    async (req, reply) => {
      const id = (req.params as any).id as string;
      const [b] = await db.select().from(bulkMigration).where(eq(bulkMigration.id, id)).limit(1);
      if (!b) return reply.code(404).send({ error: 'Not found' });
      const count = await enqueueBulkSyncNow(id);
      if (count === 0) {
        return reply
          .code(409)
          .send({ error: 'No completed pairs to sync. Wait for the initial migration to finish.' });
      }
      return { ok: true, count };
    },
  );

  // Delete a single bulk migration. Refuses while still live so we don't
  // orphan in-flight imapsync children. Cleans up the BullMQ job before
  // deleting the row (cascades bulk_pair via FK).
  app.delete('/api/bulk-migrations/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const id = (req.params as any).id as string;
    const [b] = await db.select().from(bulkMigration).where(eq(bulkMigration.id, id)).limit(1);
    if (!b) return reply.code(404).send({ error: 'Not found' });

    if (b.status === 'queued' || b.status === 'running') {
      return reply
        .code(409)
        .send({ error: `Bulk migration is ${b.status}. Stop it before deleting.` });
    }

    // Proactively tear down any per-pair sync schedulers BEFORE we drop the
    // row (cascade FK would orphan them otherwise — they'd self-heal on the
    // next tick but until then BullMQ keeps firing the zombie schedules).
    const pairs = await db
      .select({ id: bulkPair.id })
      .from(bulkPair)
      .where(eq(bulkPair.bulkId, id));
    await Promise.all(
      pairs.map((p) =>
        bulkPairSyncQueue.removeJobScheduler(bulkPairSyncJobId(p.id)).catch(() => {}),
      ),
    );

    await db.delete(bulkMigration).where(eq(bulkMigration.id, id));
    return { ok: true };
  });

  // Bulk delete — only terminal-state bulk migrations
  // (completed / completed_with_errors / failed / cancelled).
  app.delete('/api/bulk-migrations', { preHandler: [app.requireAuth] }, async () => {
    const rows = await db
      .select({ id: bulkMigration.id })
      .from(bulkMigration)
      .where(inArray(bulkMigration.status, BULK_TERMINAL as unknown as string[]));
    if (rows.length === 0) return { ok: true, deleted: 0 };

    // Sweep per-pair schedulers BEFORE the cascade fires — see single-delete
    // above for rationale.
    const allPairs = await db
      .select({ id: bulkPair.id })
      .from(bulkPair)
      .where(
        inArray(
          bulkPair.bulkId,
          rows.map((r) => r.id),
        ),
      );
    await Promise.all(
      allPairs.map((p) =>
        bulkPairSyncQueue.removeJobScheduler(bulkPairSyncJobId(p.id)).catch(() => {}),
      ),
    );

    await db.delete(bulkMigration).where(
      inArray(
        bulkMigration.id,
        rows.map((r) => r.id),
      ),
    );
    return { ok: true, deleted: rows.length };
  });

  app.get('/api/bulk-migrations/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const id = (req.params as any).id as string;
    const [b] = await db.select().from(bulkMigration).where(eq(bulkMigration.id, id)).limit(1);
    if (!b) return reply.code(404).send({ error: 'Not found' });
    const pairs = await db.select().from(bulkPair).where(eq(bulkPair.bulkId, id));
    return { ...b, pairs };
  });

  // -------- Sync history (per-pair) ---------------------------------------
  // List of past sync runs for one pair, newest first. Capped at 50 — same
  // rationale as the single-migration endpoint. We scope by both bulkId
  // AND bulkPairId so a crafted URL can't pull runs across bulks.
  app.get(
    '/api/bulk-migrations/:id/pairs/:pairId/sync-runs',
    { preHandler: [app.requireAuth] },
    async (req) => {
      const { id, pairId } = req.params as any;
      const rows = await db
        .select()
        .from(syncRun)
        .where(and(eq(syncRun.bulkId, id), eq(syncRun.bulkPairId, Number(pairId))))
        .orderBy(desc(syncRun.startedAt))
        .limit(50);
      return rows;
    },
  );

  // Logs for one pair's sync run. Bulk pair logs live in `bulk_pair_log`
  // (separate from migration_log because pairs aren't migrations).
  app.get(
    '/api/bulk-migrations/:id/pairs/:pairId/sync-runs/:runId/logs',
    { preHandler: [app.requireAuth] },
    async (req) => {
      const { pairId, runId } = req.params as any;
      const rows = await db
        .select()
        .from(bulkPairLog)
        .where(and(eq(bulkPairLog.bulkPairId, Number(pairId)), eq(bulkPairLog.syncRunId, runId)))
        .orderBy(desc(bulkPairLog.ts))
        .limit(500);
      return rows;
    },
  );

  app.post('/api/bulk-migrations', { preHandler: [app.requireAuth] }, async (req) => {
    const body = CreateBulkBody.parse(req.body);
    const [b] = await db
      .insert(bulkMigration)
      .values({
        sourceHost: body.sourceHost,
        sourcePort: body.sourcePort,
        sourceSecurity: body.sourceSecurity,
        targetHost: body.targetHost,
        targetPort: body.targetPort,
        targetSecurity: body.targetSecurity,
        settings: body.settings as any,
        status: 'queued',
      })
      .returning();
    // Batch insert pairs in one statement (was N round-trips in a for-loop).
    if (body.pairs.length > 0) {
      await db.insert(bulkPair).values(
        body.pairs.map((p) => ({
          bulkId: b!.id,
          sourceUsername: p.sourceUsername,
          sourcePasswordEnc: encrypt(p.sourcePassword),
          targetUsername: p.targetUsername,
          targetPasswordEnc: encrypt(p.targetPassword),
          syncEnabled: p.sync,
          backupEnabled: p.backup,
        })),
      );
    }
    await bulkQueue.add('bulk', { bulkId: b!.id }, { removeOnComplete: 20, removeOnFail: 50 });
    return { id: b!.id };
  });

  app.post(
    '/api/bulk-migrations/:id/stop',
    { preHandler: [app.requireAuth] },
    async (req, reply) => {
      const id = (req.params as any).id as string;
      const [b] = await db.select().from(bulkMigration).where(eq(bulkMigration.id, id)).limit(1);
      if (!b) return reply.code(404).send({ error: 'Not found' });
      if (b.status !== 'queued' && b.status !== 'running') {
        return reply.code(409).send({ error: `Bulk migration is ${b.status}` });
      }
      // Tell the worker to SIGTERM every active pair and drain the queue.
      // The worker's onCancelMsg handler updates DB state for in-flight pairs;
      // we do NOT touch running/completed pair rows from here (would race the
      // worker's status writes).
      await redis.publish(`bulk-cancel:${id}`, '1');
      return { ok: true };
    },
  );

  // Mirror of the single-migration SSE channel — streams per-pair progress
  // and bulk-level status events to the BulkStep3 page. Initial snapshot is
  // the full bulk row + all pair rows so the page can render immediately
  // without a separate GET round-trip.
  app.get(
    '/api/bulk-migrations/:id/events',
    { preHandler: [app.requireAuth] },
    async (req, reply) => {
      const id = (req.params as any).id as string;
      reply.raw.setHeader('Content-Type', 'text/event-stream');
      reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
      reply.raw.setHeader('Connection', 'keep-alive');
      reply.raw.setHeader('X-Accel-Buffering', 'no');
      reply.raw.flushHeaders();

      const [b] = await db.select().from(bulkMigration).where(eq(bulkMigration.id, id)).limit(1);
      if (b) {
        const pairs = await db.select().from(bulkPair).where(eq(bulkPair.bulkId, id));
        reply.raw.write(`event: snapshot\ndata: ${JSON.stringify({ ...b, pairs })}\n\n`);
      }

      // Use refcounted SSE bus so concurrent watchers (e.g. one tab on
      // bulk progress + another on the bulk detail) don't kill each other
      // when one disconnects.
      const unsubscribe = await subscribeSSE(`bulk:${id}`, (msg) => {
        reply.raw.write(`event: progress\ndata: ${msg}\n\n`);
      });

      const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), 15000);
      req.raw.on('close', () => {
        clearInterval(heartbeat);
        void unsubscribe();
      });
    },
  );
}
