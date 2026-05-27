import { z } from 'zod';

const Env = z.object({
  POSTGRES_HOST: z.string().default('localhost'),
  POSTGRES_PORT: z.coerce.number().default(5432),
  POSTGRES_USER: z.string().default('emt'),
  POSTGRES_PASSWORD: z.string().default('emt'),
  POSTGRES_DB: z.string().default('emt'),
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.coerce.number().default(6379),
  MASTER_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/),
  IMAPSYNC_STATE_DIR: z.string().default('/var/lib/imapsync'),
  WORKER_CONCURRENCY: z.coerce.number().default(3),
});

export const env = Env.parse(process.env);
