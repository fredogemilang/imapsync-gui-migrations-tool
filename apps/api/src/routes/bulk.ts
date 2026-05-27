import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { desc, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { bulkMigration, bulkPair } from '../db/schema.js';
import { encrypt } from '../lib/crypto.js';
import { bulkQueue } from '../lib/queue.js';
import { redis } from '../lib/redis.js';

const Pair = z.object({
  sourceUsername: z.string().min(1),
  sourcePassword: z.string().min(1),
  targetUsername: z.string().min(1),
  targetPassword: z.string().min(1),
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
    return db.select().from(bulkMigration).orderBy(desc(bulkMigration.createdAt));
  });

  app.get('/api/bulk-migrations/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const id = (req.params as any).id as string;
    const [b] = await db.select().from(bulkMigration).where(eq(bulkMigration.id, id)).limit(1);
    if (!b) return reply.code(404).send({ error: 'Not found' });
    const pairs = await db.select().from(bulkPair).where(eq(bulkPair.bulkId, id));
    return { ...b, pairs };
  });

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
}
