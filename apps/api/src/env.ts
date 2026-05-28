import { z } from 'zod';

const Env = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  API_PORT: z.coerce.number().default(3000),
  POSTGRES_HOST: z.string().default('localhost'),
  POSTGRES_PORT: z.coerce.number().default(5432),
  POSTGRES_USER: z.string().default('emt'),
  POSTGRES_PASSWORD: z.string().default('emt'),
  POSTGRES_DB: z.string().default('emt'),
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.coerce.number().default(6379),
  JWT_SECRET: z.string().min(16),
  MASTER_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'MASTER_KEY must be 64 hex chars (32 bytes)'),
  ADMIN_EMAIL: z.string().email().default('admin@example.com'),
  ADMIN_INITIAL_PASSWORD: z.string().default('changeme'),
  /** Optional CORS origin for split-domain deployments. When unset, the
   *  API rejects all cross-origin requests in production (same-origin
   *  setup via Traefik is the recommended default). Set to e.g.
   *  `https://app.example.com` when the web frontend lives on a different
   *  hostname than the api. Use `*` only for trusted reverse proxies. */
  WEB_ORIGIN: z.string().optional(),
});

export const env = Env.parse(process.env);
