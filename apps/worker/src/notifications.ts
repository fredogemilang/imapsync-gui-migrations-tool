import { randomUUID } from 'node:crypto';
import { db, notification } from './db.js';

/**
 * Worker-side notification emitter. Inserts a row into the `notification`
 * table which the API exposes via `/api/notifications`. The header bell
 * polls this list every 30s (plus on open) and shows the unread count.
 *
 * Fire-and-forget — failures here MUST NOT take down the migration. We
 * log and swallow so a Postgres hiccup at notification-write time
 * doesn't bubble up into an imapsync run.
 */

export type NotificationKind = 'success' | 'error' | 'warning' | 'info';

export type NotificationInput = {
  kind: NotificationKind;
  title: string;
  body?: string;
  /** Where in the SPA the user lands after clicking the notification.
   *  e.g. `/migrations/abc-123` or `/bulk/def-456`. */
  linkPath?: string | null;
  migrationId?: string | null;
  bulkId?: string | null;
};

export async function createNotification(input: NotificationInput): Promise<void> {
  try {
    await db.insert(notification).values({
      id: randomUUID(),
      kind: input.kind,
      title: input.title,
      body: input.body ?? '',
      linkPath: input.linkPath ?? null,
      migrationId: input.migrationId ?? null,
      bulkId: input.bulkId ?? null,
      createdAt: new Date(),
    });
  } catch (e) {
    console.error('[notifications] insert failed:', e);
  }
}
