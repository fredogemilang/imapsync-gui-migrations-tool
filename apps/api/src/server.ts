import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import argon2 from 'argon2';
import { env } from './env.js';
import { db } from './db/index.js';
import { admin } from './db/schema.js';
import { redis } from './lib/redis.js';
import { authRoutes } from './routes/auth.js';
import { imapRoutes } from './routes/imap.js';
import { migrationRoutes } from './routes/migrations.js';
import { bulkRoutes } from './routes/bulk.js';
import { settingsRoutes } from './routes/settings.js';
import { notificationRoutes } from './routes/notifications.js';

declare module 'fastify' {
  interface FastifyInstance {
    requireAuth: (req: any, reply: any) => Promise<void>;
  }
}

async function seedAdmin() {
  const existing = await db.select().from(admin).limit(1);
  if (existing.length === 0) {
    const passwordHash = await argon2.hash(env.ADMIN_INITIAL_PASSWORD, { type: argon2.argon2id });
    await db.insert(admin).values({ email: env.ADMIN_EMAIL, passwordHash });
    console.log(`[seed] admin created: ${env.ADMIN_EMAIL}`);
  }
}

async function main() {
  const app = Fastify({
    logger: { transport: env.NODE_ENV === 'development' ? { target: 'pino-pretty' } : undefined },
    bodyLimit: 5 * 1024 * 1024, // 5 MB — bulk CSV must fit, but no further
  });

  // CORS policy:
  //   - dev: reflect any origin (Vite dev server may serve from various
  //     ports / hostnames during local work)
  //   - prod default: no CORS — same-origin only (web + api share the
  //     Traefik-routed domain configured in Dokploy)
  //   - prod split-domain: set WEB_ORIGIN to e.g. https://app.example.com
  //     when web frontend lives on a different host than this api
  await app.register(cors, {
    origin: env.NODE_ENV === 'development' ? true : (env.WEB_ORIGIN ?? false),
    credentials: true,
  });
  await app.register(cookie);
  await app.register(jwt, {
    secret: env.JWT_SECRET,
    cookie: { cookieName: 'emt_session', signed: false },
  });
  // Rate limit storage backed by Redis so it survives api restart and works
  // across api replicas.
  await app.register(rateLimit, {
    global: false, // opt-in per route
    redis: redis as any,
    skipOnError: true,
  });

  app.decorate('requireAuth', async (req: any, reply: any) => {
    try {
      await req.jwtVerify();
    } catch {
      await reply.code(401).send({ error: 'Unauthorized' });
    }
  });

  // setErrorHandler MUST be registered BEFORE plugin/route registration so the
  // parent handler cascades into all encapsulated child contexts (Fastify
  // encapsulation rule).
  app.setErrorHandler((err, _req, reply) => {
    const status = (err as any).statusCode ?? 500;
    app.log.error({ err, status }, 'request errored');

    // Zod errors: duck-type on `.issues` to avoid `instanceof` failing across
    // multiple zod copies (drizzle and others may bundle their own).
    const zIssues = (err as any).issues;
    if (Array.isArray(zIssues) && zIssues.length > 0 && 'path' in (zIssues[0] ?? {})) {
      if (env.NODE_ENV === 'production') {
        return reply.code(400).send({ error: 'Invalid request' });
      }
      return reply.code(400).send({ error: 'Validation failed', issues: zIssues });
    }

    // Don't leak raw internals (e.g. "Invalid ciphertext", db errors) in prod.
    const message =
      status >= 500 && env.NODE_ENV === 'production' ? 'Internal Server Error' : err.message;
    reply.code(status >= 500 ? 500 : status).send({ error: message });
  });

  app.get('/api/health', async () => ({ ok: true, ts: Date.now() }));

  await app.register(authRoutes);
  await app.register(imapRoutes);
  await app.register(migrationRoutes);
  await app.register(bulkRoutes);
  await app.register(settingsRoutes);
  await app.register(notificationRoutes);

  await seedAdmin();
  await app.listen({ host: '0.0.0.0', port: env.API_PORT });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
