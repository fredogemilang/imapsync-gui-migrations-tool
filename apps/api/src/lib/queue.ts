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
  AUTO_SYNC_3H: 3 * 60 * 60 * 1000,
  DAILY: 24 * 60 * 60 * 1000,
  WEEKLY: 7 * 24 * 60 * 60 * 1000,
  MONTHLY: 30 * 24 * 60 * 60 * 1000,
} as const;
