import type { FastifyInstance } from 'fastify';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { notification } from '../db/schema.js';

/**
 * Notifications API.
 *
 * Worker writes rows directly to the `notification` table on noteworthy
 * events (see `apps/worker/src/notifications.ts`). The header bell polls
 * this list and shows the unread count + lets the user open them.
 *
 * Clicking a notification on the frontend should:
 *   1. POST /api/notifications/:id/read  (mark as read)
 *   2. Navigate to `linkPath` (e.g. /migrations/:id)
 *   3. Bell badge decrements on next poll
 *
 * No DELETE endpoint — read notifications stay in DB so future history
 * views / auditing remain possible; the bell just hides them by default.
 */

export async function notificationRoutes(app: FastifyInstance) {
  // List notifications. Default: unread only, newest first, capped at 50
  // so the bell can't grow unbounded. Pass `?all=1` to include read ones.
  app.get('/api/notifications', { preHandler: [app.requireAuth] }, async (req) => {
    const all = (req.query as { all?: string })?.all === '1';
    const rows = await db
      .select()
      .from(notification)
      .where(all ? undefined : isNull(notification.readAt))
      .orderBy(desc(notification.createdAt))
      .limit(50);
    return rows;
  });

  // Unread count — separate endpoint so the bell badge can poll cheaply.
  // Use SQL COUNT(*) so payload + query plan are O(1) regardless of how
  // many notifications have accumulated; otherwise polling every 30s
  // would transfer N UUIDs per request just to discard them client-side.
  app.get('/api/notifications/unread-count', { preHandler: [app.requireAuth] }, async () => {
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(notification)
      .where(isNull(notification.readAt));
    return { count: row?.count ?? 0 };
  });

  app.post('/api/notifications/:id/read', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const [row] = await db.select().from(notification).where(eq(notification.id, id)).limit(1);
    if (!row) return reply.code(404).send({ error: 'Not found' });
    if (!row.readAt) {
      await db
        .update(notification)
        .set({ readAt: new Date() })
        .where(and(eq(notification.id, id), isNull(notification.readAt)));
    }
    return { ok: true };
  });

  app.post('/api/notifications/read-all', { preHandler: [app.requireAuth] }, async () => {
    const r = await db
      .update(notification)
      .set({ readAt: new Date() })
      .where(isNull(notification.readAt))
      .returning({ id: notification.id });
    return { ok: true, marked: r.length };
  });
}
