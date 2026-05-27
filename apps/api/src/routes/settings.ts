import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { appSetting } from '../db/schema.js';

const SettingsBody = z.object({
  simultaneousMigrations: z.number().int().min(1).max(20).optional(),
  retentionDays: z.number().int().min(1).max(365).optional(),
  passwordDisplay: z.enum(['Obstructed', 'Readable']).optional(),
});

export async function settingsRoutes(app: FastifyInstance) {
  app.get('/api/settings', { preHandler: [app.requireAuth] }, async () => {
    const rows = await db.select().from(appSetting);
    const out: Record<string, unknown> = {
      simultaneousMigrations: 3,
      retentionDays: 30,
      passwordDisplay: 'Obstructed',
    };
    for (const r of rows) out[r.key] = r.value;
    return out;
  });

  app.put('/api/settings', { preHandler: [app.requireAuth] }, async (req) => {
    const body = SettingsBody.parse(req.body);
    for (const [k, v] of Object.entries(body)) {
      if (v === undefined) continue;
      const existing = await db.select().from(appSetting).where(eq(appSetting.key, k));
      if (existing.length > 0) {
        await db
          .update(appSetting)
          .set({ value: v as any })
          .where(eq(appSetting.key, k));
      } else {
        await db.insert(appSetting).values({ key: k, value: v as any });
      }
    }
    return { ok: true };
  });
}
