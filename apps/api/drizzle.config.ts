import type { Config } from 'drizzle-kit';

export default {
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    host: process.env.POSTGRES_HOST ?? 'localhost',
    port: Number(process.env.POSTGRES_PORT ?? 5432),
    user: process.env.POSTGRES_USER ?? 'emt',
    password: process.env.POSTGRES_PASSWORD ?? 'emt',
    database: process.env.POSTGRES_DB ?? 'emt',
    ssl: false,
  },
} satisfies Config;
