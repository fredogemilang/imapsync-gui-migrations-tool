import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { desc, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { imapAccount, migration, migrationFolder, migrationLog } from '../db/schema.js';
import { encrypt } from '../lib/crypto.js';
import { migrationQueue } from '../lib/queue.js';
import { redis, redisSub } from '../lib/redis.js';

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
