import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { desc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { imapAccount, migration, migrationFolder, migrationLog } from '../db/schema.js';
import { encrypt } from '../lib/crypto.js';
import { migrationQueue, syncQueue, syncJobId, SYNC_INTERVALS } from '../lib/queue.js';
import { redis, redisSub } from '../lib/redis.js';

/** Terminal states — safe to delete in bulk via "Delete Finished". */
const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'] as const;

const EnableSyncBody = z.object({
  mode: z.enum(['auto', 'backup']),
  /** Required for backup mode; ignored for auto (fixed 3h). */
  interval: z.enum(['daily', 'weekly', 'monthly']).optional(),
});

const ImapAccountInput = z.object({
  label: z.string().optional(),
  type: z.enum(['IMAP', 'Microsoft', 'Google', 'Yahoo', 'iCloud']).default('IMAP'),
  host: z.string().min(1),
  port: z.number().int().default(993),
  security: z.enum(['SSL/TLS', 'STARTTLS', 'None']).default('SSL/TLS'),
  username: z.string().min(1),
  password: z.string().min(1),
});

const Settings = z.object({
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
});

const CreateMigrationBody = z.object({
  source: ImapAccountInput,
  target: ImapAccountInput,
  settings: Settings.default({}),
});

async function insertAccount(input: z.infer<typeof ImapAccountInput>) {
  const [row] = await db
    .insert(imapAccount)
    .values({
      label: input.label,
      type: input.type,
      host: input.host,
      port: input.port,
      security: input.security,
      username: input.username,
      passwordEnc: encrypt(input.password),
    })
    .returning();
  return row!;
}

export async function migrationRoutes(app: FastifyInstance) {
  app.get('/api/migrations', { preHandler: [app.requireAuth] }, async () => {
    const rows = await db
      .select({
        id: migration.id,
        status: migration.status,
        progressPercent: migration.progressPercent,
        migratedEmails: migration.migratedEmails,
        totalEmails: migration.totalEmails,
        startedAt: migration.startedAt,
        finishedAt: migration.finishedAt,
        sourceHost: imapAccount.host,
        sourceUsername: imapAccount.username,
      })
      .from(migration)
      .leftJoin(imapAccount, eq(migration.sourceAccountId, imapAccount.id))
      .orderBy(desc(migration.createdAt));

    // also fetch target info in second pass to keep query simple
    const enriched = await Promise.all(
      rows.map(async (r) => {
        const [m] = await db.select().from(migration).where(eq(migration.id, r.id)).limit(1);
        const [tgt] = await db
          .select()
          .from(imapAccount)
          .where(eq(imapAccount.id, m!.targetAccountId))
          .limit(1);
        return {
          ...r,
          targetHost: tgt?.host,
          targetUsername: tgt?.username,
        };
      }),
    );
    return enriched;
  });

  app.get('/api/migrations/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const id = (req.params as any).id as string;
    const [m] = await db.select().from(migration).where(eq(migration.id, id)).limit(1);
    if (!m) return reply.code(404).send({ error: 'Not found' });
    const [src] = await db
      .select()
      .from(imapAccount)
      .where(eq(imapAccount.id, m.sourceAccountId))
      .limit(1);
    const [tgt] = await db
      .select()
      .from(imapAccount)
      .where(eq(imapAccount.id, m.targetAccountId))
      .limit(1);
    const folders = await db
      .select()
      .from(migrationFolder)
      .where(eq(migrationFolder.migrationId, id));
    return {
      ...m,
      source: src && { host: src.host, username: src.username, type: src.type },
      target: tgt && { host: tgt.host, username: tgt.username, type: tgt.type },
      folders,
    };
  });

  app.post('/api/migrations', { preHandler: [app.requireAuth] }, async (req) => {
    const body = CreateMigrationBody.parse(req.body);
    const srcAcc = await insertAccount(body.source);
    const tgtAcc = await insertAccount(body.target);
    const [row] = await db
      .insert(migration)
      .values({
        sourceAccountId: srcAcc.id,
        targetAccountId: tgtAcc.id,
        settings: body.settings,
        status: 'queued',
      })
      .returning();
    const job = await migrationQueue.add(
      'single',
      { migrationId: row!.id },
      { removeOnComplete: 50, removeOnFail: 100 },
    );
    await db.update(migration).set({ jobId: job.id! }).where(eq(migration.id, row!.id));
    return { id: row!.id };
  });

  app.post('/api/migrations/:id/stop', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const id = (req.params as any).id as string;
    const [m] = await db.select().from(migration).where(eq(migration.id, id)).limit(1);
    if (!m) return reply.code(404).send({ error: 'Not found' });

    // Refuse to "stop" a migration that's already in a terminal state — the UI
    // would otherwise flip into a paused-but-already-completed limbo.
    if (m.status === 'completed' || m.status === 'cancelled' || m.status === 'failed') {
      return reply.code(409).send({ error: `Migration is ${m.status}` });
    }

    // Tell the worker to SIGTERM the spawned imapsync child. The worker's
    // finally block updates status to 'cancelled' once the child exits.
    await redis.publish(`migration-cancel:${id}`, '1');
    // Also remove the queued/active job so it cannot be picked up later if
    // the worker hadn't started yet.
    if (m.jobId) {
      const job = await migrationQueue.getJob(m.jobId);
      if (job) {
        const state = await job.getState().catch(() => 'unknown');
        if (state !== 'active') {
          // For not-yet-active jobs, mark cancelled and remove immediately.
          // Also publish SSE events so any live client doesn't desync —
          // the worker won't emit anything since it never picked the job up.
          await db
            .update(migration)
            .set({ status: 'cancelled', finishedAt: new Date() })
            .where(eq(migration.id, id));
          await job.remove().catch(() => {});
          const sse = (data: object) => redis.publish(`migration:${id}`, JSON.stringify(data));
          await sse({ kind: 'status', status: 'cancelled' });
          await sse({ kind: 'done', ok: false, error: 'cancelled' });
        }
      }
    }
    return { ok: true };
  });

  app.post('/api/migrations/:id/resume', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const id = (req.params as any).id as string;
    const [m] = await db.select().from(migration).where(eq(migration.id, id)).limit(1);
    if (!m) return reply.code(404).send({ error: 'Not found' });

    // Refuse to resume a successfully completed migration. Re-running would
    // re-scan source and re-run imapsync — never what the user wants by
    // clicking a button. (failed / cancelled are legitimate resumes.)
    if (m.status === 'completed') {
      return reply.code(409).send({ error: 'Migration already completed' });
    }

    // Refuse to enqueue a duplicate job if one is already active/queued.
    if (m.jobId) {
      const existing = await migrationQueue.getJob(m.jobId);
      if (existing) {
        const state = await existing.getState().catch(() => 'unknown');
        if (state === 'active' || state === 'waiting' || state === 'delayed') {
          return reply.code(409).send({ error: `Migration already ${state}` });
        }
      }
    }
    const job = await migrationQueue.add(
      'single',
      { migrationId: id, resume: true },
      { removeOnComplete: 50, removeOnFail: 100 },
    );
    await db
      .update(migration)
      .set({ jobId: job.id!, status: 'queued' })
      .where(eq(migration.id, id));
    return { ok: true };
  });

  // -------- Delete --------------------------------------------------------

  // Delete a single migration. Tears down any active job + repeatable sync
  // schedule, then deletes the row (cascades migration_folder + migration_log).
  // Refuses to delete a still-running migration so the user doesn't orphan a
  // live imapsync child — Stop first, then Delete.
  app.delete('/api/migrations/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const id = (req.params as any).id as string;
    const [m] = await db.select().from(migration).where(eq(migration.id, id)).limit(1);
    if (!m) return reply.code(404).send({ error: 'Not found' });

    const live = (['queued', 'scanning', 'running', 'paused'] as const).includes(
      m.status as any,
    );
    if (live) {
      return reply.code(409).send({
        error: `Migration is ${m.status}. Stop it before deleting.`,
      });
    }

    // Best-effort cleanup of queue artefacts. Failures here are non-fatal —
    // the DB row delete is the source of truth.
    if (m.jobId) {
      const job = await migrationQueue.getJob(m.jobId).catch(() => null);
      if (job) await job.remove().catch(() => {});
    }
    await syncQueue.removeJobScheduler(syncJobId(id)).catch(() => {});

    await db.delete(migration).where(eq(migration.id, id));
    return { ok: true };
  });

  // Bulk delete — only terminal-state migrations (completed/failed/cancelled).
  // Returns the count of rows actually removed so the UI can confirm.
  app.delete('/api/migrations', { preHandler: [app.requireAuth] }, async () => {
    const rows = await db
      .select({ id: migration.id, jobId: migration.jobId })
      .from(migration)
      .where(inArray(migration.status, TERMINAL_STATUSES as unknown as string[]));

    // Cleanup queue artefacts per row (parallel, best-effort).
    await Promise.all(
      rows.map(async (r) => {
        if (r.jobId) {
          const job = await migrationQueue.getJob(r.jobId).catch(() => null);
          if (job) await job.remove().catch(() => {});
        }
        await syncQueue.removeJobScheduler(syncJobId(r.id)).catch(() => {});
      }),
    );

    if (rows.length === 0) return { ok: true, deleted: 0 };
    await db.delete(migration).where(
      inArray(
        migration.id,
        rows.map((r) => r.id),
      ),
    );
    return { ok: true, deleted: rows.length };
  });

  // -------- Sync (Auto Sync / Backup Mode / Sync Now) --------------------

  app.post(
    '/api/migrations/:id/sync/enable',
    { preHandler: [app.requireAuth] },
    async (req, reply) => {
      const id = (req.params as any).id as string;
      const body = EnableSyncBody.parse(req.body);
      const [m] = await db.select().from(migration).where(eq(migration.id, id)).limit(1);
      if (!m) return reply.code(404).send({ error: 'Not found' });
      if (m.status !== 'completed') {
        return reply.code(409).send({ error: 'Sync can only be enabled on a completed migration' });
      }

      let intervalMs: number;
      let endsAt: Date | null = null;
      if (body.mode === 'auto') {
        intervalMs = SYNC_INTERVALS.AUTO_SYNC_3H;
        endsAt = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000); // 10 days
      } else {
        // backup mode
        switch (body.interval) {
          case 'weekly':
            intervalMs = SYNC_INTERVALS.WEEKLY;
            break;
          case 'monthly':
            intervalMs = SYNC_INTERVALS.MONTHLY;
            break;
          case 'daily':
          default:
            intervalMs = SYNC_INTERVALS.DAILY;
        }
      }

      await db
        .update(migration)
        .set({
          syncMode: body.mode,
          syncIntervalMs: intervalMs,
          syncEndsAt: endsAt,
        })
        .where(eq(migration.id, id));

      // Replace any existing repeatable schedule for this migration.
      await syncQueue.removeJobScheduler(syncJobId(id)).catch(() => {});
      await syncQueue.upsertJobScheduler(
        syncJobId(id),
        { every: intervalMs, ...(endsAt ? { endDate: endsAt } : {}) },
        {
          name: 'scheduled-sync',
          data: { migrationId: id },
          opts: { removeOnComplete: 20, removeOnFail: 50 },
        },
      );

      return { ok: true, intervalMs, endsAt };
    },
  );

  app.post(
    '/api/migrations/:id/sync/disable',
    { preHandler: [app.requireAuth] },
    async (req, reply) => {
      const id = (req.params as any).id as string;
      const [m] = await db.select().from(migration).where(eq(migration.id, id)).limit(1);
      if (!m) return reply.code(404).send({ error: 'Not found' });

      await syncQueue.removeJobScheduler(syncJobId(id)).catch(() => {});
      await db
        .update(migration)
        .set({ syncMode: 'off', syncIntervalMs: null, syncEndsAt: null })
        .where(eq(migration.id, id));
      return { ok: true };
    },
  );

  app.post(
    '/api/migrations/:id/sync/now',
    { preHandler: [app.requireAuth] },
    async (req, reply) => {
      const id = (req.params as any).id as string;
      const [m] = await db.select().from(migration).where(eq(migration.id, id)).limit(1);
      if (!m) return reply.code(404).send({ error: 'Not found' });
      if (m.status !== 'completed') {
        return reply.code(409).send({ error: 'Sync Now requires a completed migration' });
      }
      if (m.syncRunning) {
        return reply.code(409).send({ error: 'A sync is already running' });
      }
      // One-off job — does NOT replace any repeatable schedule.
      await syncQueue.add(
        'manual-sync',
        { migrationId: id, manual: true },
        { removeOnComplete: 20, removeOnFail: 50 },
      );
      return { ok: true };
    },
  );

  app.get('/api/migrations/:id/logs', { preHandler: [app.requireAuth] }, async (req) => {
    const id = (req.params as any).id as string;
    const rows = await db
      .select()
      .from(migrationLog)
      .where(eq(migrationLog.migrationId, id))
      .orderBy(desc(migrationLog.ts))
      .limit(200);
    return rows;
  });

  // SSE progress stream
  app.get('/api/migrations/:id/events', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const id = (req.params as any).id as string;
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.setHeader('X-Accel-Buffering', 'no');
    reply.raw.flushHeaders();

    // send current snapshot
    const [m] = await db.select().from(migration).where(eq(migration.id, id)).limit(1);
    if (m) reply.raw.write(`event: snapshot\ndata: ${JSON.stringify(m)}\n\n`);

    const channel = `migration:${id}`;
    const handler = (chan: string, msg: string) => {
      if (chan === channel) reply.raw.write(`event: progress\ndata: ${msg}\n\n`);
    };
    await redisSub.subscribe(channel);
    redisSub.on('message', handler);

    const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), 15000);

    req.raw.on('close', async () => {
      clearInterval(heartbeat);
      redisSub.off('message', handler);
      await redisSub.unsubscribe(channel).catch(() => {});
    });
  });
}
