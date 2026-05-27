import { Queue } from 'bullmq';
import { redis } from './redis.js';

export const migrationQueue = new Queue('migration', { connection: redis });
export const bulkQueue = new Queue('bulk-migration', { connection: redis });
