import { inArray } from 'drizzle-orm';
import { db, bulkMigration, migration } from '../db.js';
import { resolveRetentionDays } from '../app-settings.js';
import { createNotification } from '../notifications.js';

/**
 * Daily retention sweep — deletes finished single migrations and bulk
 * migrations older than the configured `retentionDays`. Cascade FKs on
 * the child tables (migration_folder, migration_log, bulk_pair) take
 * care of dependent rows.
 *
 * Settings page convention:
 *   - retentionDays = 0  →  "Never Delete" — skip silently
 *   - retentionDays = N  →  delete rows whose terminal-state timestamp
 *                            (finishedAt for migration, createdAt for
 *                            bulk_migration which lacks finishedAt)
 *                            is older than `now - N days`.
 *
 * Scheduled daily at worker boot via `upsertJobScheduler` — see
 * `apps/worker/src/index.ts` for the wiring.
 */

const SINGLE_TERMINAL = ['completed', 'failed', 'cancelled'] as const;
const BULK_TERMINAL = [
  'completed',
  'completed_with_errors',
  'failed',
  'cancelled',
] as const;

export async function handleRetentionSweep(): Promise<{
  skipped?: string;
  deletedMigrations: number;
  deletedBulks: number;
}> {
  const days = await resolveRetentionDays();
  if (days === 0) {
    return { skipped: 'never-delete', deletedMigrations: 0, deletedBulks: 0 };
  }

  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const cutoff = new Date(cutoffMs);

  // --- Single migrations ---
  // We can't easily express "COALESCE(finished_at, created_at) < cutoff" in
  // drizzle's typed builders so do a SELECT + filter + DELETE pattern. The
  // sweep runs daily on a small table so the extra round-trip is fine.
  const allTerminal = await db
    .select({
      id: migration.id,
      finishedAt: migration.finishedAt,
      createdAt: migration.createdAt,
    })
    .from(migration)
    .where(inArray(migration.status, SINGLE_TERMINAL as unknown as string[]));

  const toDeleteMigrationIds = allTerminal
    .filter((r) => {
      const ts = (r.finishedAt ?? r.createdAt)?.getTime();
      return typeof ts === 'number' && ts < cutoffMs;
    })
    .map((r) => r.id);

  let deletedMigrations = 0;
  if (toDeleteMigrationIds.length > 0) {
    await db.delete(migration).where(inArray(migration.id, toDeleteMigrationIds));
    deletedMigrations = toDeleteMigrationIds.length;
  }

  // --- Bulk migrations ---
  // bulk_migration doesn't have finishedAt yet — use createdAt as the
  // age basis. This means a very long bulk that finished recently could
  // be deleted if its create-date crosses the cutoff. Acceptable for now
  // since the cutoff is days-grained.
  const allBulkTerminal = await db
    .select({ id: bulkMigration.id, createdAt: bulkMigration.createdAt })
    .from(bulkMigration)
    .where(inArray(bulkMigration.status, BULK_TERMINAL as unknown as string[]));

  const toDeleteBulkIds = allBulkTerminal
    .filter((r) => r.createdAt && r.createdAt.getTime() < cutoffMs)
    .map((r) => r.id);

  let deletedBulks = 0;
  if (toDeleteBulkIds.length > 0) {
    await db.delete(bulkMigration).where(inArray(bulkMigration.id, toDeleteBulkIds));
    deletedBulks = toDeleteBulkIds.length;
  }

  if (deletedMigrations > 0 || deletedBulks > 0) {
    console.log(
      `[retention] cutoff=${cutoff.toISOString()} deletedMigrations=${deletedMigrations} deletedBulks=${deletedBulks}`,
    );
    const parts: string[] = [];
    if (deletedMigrations > 0)
      parts.push(`${deletedMigrations} migration${deletedMigrations === 1 ? '' : 's'}`);
    if (deletedBulks > 0)
      parts.push(`${deletedBulks} bulk migration${deletedBulks === 1 ? '' : 's'}`);
    void createNotification({
      kind: 'info',
      title: 'Retention cleanup',
      body: `Cleaned ${parts.join(' and ')} older than ${days} days.`,
      linkPath: '/',
    });
  }

  return { deletedMigrations, deletedBulks };
}
