import { Queue } from 'bullmq';
import { redis } from './redis.js';

export const migrationQueue = new Queue('migration', { connection: redis });
export const bulkQueue = new Queue('bulk-migration', { connection: redis });
/** Periodic sync queue. Repeatable jobs for Auto Sync / Backup Mode;
 *  one-off jobs for "Sync Now". Each job is keyed by migrationId. */
export const syncQueue = new Queue('sync', { connection: redis });

/** Per-pair sync queue for bulk migrations. Mirrors `syncQueue` but each
 *  job represents one bulk_pair row instead of a top-level migration row.
 *  Job data: { bulkId, pairId, manual? }. Schedule key = bulkPairSyncJobId. */
export const bulkPairSyncQueue = new Queue('bulk-pair-sync', { connection: redis });

/** Stable jobId for the repeatable sync of a given migration. Used as
 *  `jobId` when adding so BullMQ replaces the prior schedule on update. */
export function syncJobId(migrationId: string): string {
  return `sync:${migrationId}`;
}

/** Stable scheduler key for the repeatable sync of a bulk_pair row. */
export function bulkPairSyncJobId(pairId: number): string {
  return `bulk-pair-sync:${pairId}`;
}

/** Interval shortcuts in milliseconds. */
export const SYNC_INTERVALS = {
  AUTO_SYNC_15M: 15 * 60 * 1000,
  AUTO_SYNC_30M: 30 * 60 * 1000,
  AUTO_SYNC_1H: 60 * 60 * 1000,
  AUTO_SYNC_3H: 3 * 60 * 60 * 1000,
  AUTO_SYNC_6H: 6 * 60 * 60 * 1000,
  DAILY: 24 * 60 * 60 * 1000,
  WEEKLY: 7 * 24 * 60 * 60 * 1000,
  MONTHLY: 30 * 24 * 60 * 60 * 1000,
} as const;

/** Default Auto Sync interval when settings.autoSyncInterval isn't set.
 *  Picked at 1h after observing 3h was too laggy for transition-window
 *  use cases (the user has 10 days of Auto Sync running and wants new
 *  mail to land on the target reasonably fast). */
export const DEFAULT_AUTO_SYNC_INTERVAL = SYNC_INTERVALS.AUTO_SYNC_1H;

/** Auto Sync interval enum → ms. Falls back to DEFAULT_AUTO_SYNC_INTERVAL
 *  for unknown/missing values so the UI can store strings without us
 *  hard-failing on legacy rows. */
export function autoSyncIntervalMs(
  interval: '15min' | '30min' | '1h' | '3h' | '6h' | undefined,
): number {
  switch (interval) {
    case '15min':
      return SYNC_INTERVALS.AUTO_SYNC_15M;
    case '30min':
      return SYNC_INTERVALS.AUTO_SYNC_30M;
    case '1h':
      return SYNC_INTERVALS.AUTO_SYNC_1H;
    case '3h':
      return SYNC_INTERVALS.AUTO_SYNC_3H;
    case '6h':
      return SYNC_INTERVALS.AUTO_SYNC_6H;
    default:
      return DEFAULT_AUTO_SYNC_INTERVAL;
  }
}
