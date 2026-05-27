import type { FastifyInstance } from 'fastify';
import argon2 from 'argon2';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { admin } from '../db/schema.js';

const LoginBody = z.object({ email: z.string().email(), password: z.string().min(1) });
const ChangePasswordBody = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8),
});

export async function authRoutes(app: FastifyInstance) {
  app.post(
    '/api/auth/login',
    {
      config: {
        // 10 attempts per IP per minute (Fastify rate-limit handles 429 itself)
        rateLimit: { max: 10, timeWindow: '1 minute' },
      },
    },
    async (req, reply) => {
      const body = LoginBody.parse(req.body);
      const [row] = await db.select().from(admin).where(eq(admin.email, body.email)).limit(1);
      if (!row || !(await argon2.verify(row.passwordHash, body.password))) {
        return reply.code(401).send({ error: 'Invalid credentials' });
      }
      const token = await reply.jwtSign({ sub: row.id, email: row.email });
      reply
        .setCookie('emt_session', token, {
          httpOnly: true,
          sameSite: 'lax',
          secure: process.env.NODE_ENV === 'production',
          path: '/',
          maxAge: 60 * 60 * 24 * 7,
        })
        .send({ ok: true, email: row.email });
    },
  );

  app.post('/api/auth/logout', async (_req, reply) => {
    reply.clearCookie('emt_session', { path: '/' }).send({ ok: true });
  });

  app.get('/api/auth/me', { preHandler: [app.requireAuth] }, async (req) => {
    return { email: (req.user as any).email };
  });

  app.post('/api/auth/change-password', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const body = ChangePasswordBody.parse(req.body);
    const id = (req.user as any).sub as number;
    const [row] = await db.select().from(admin).where(eq(admin.id, id)).limit(1);
    if (!row || !(await argon2.verify(row.passwordHash, body.currentPassword))) {
      return reply.code(400).send({ error: 'Current password is incorrect' });
    }
    const passwordHash = await argon2.hash(body.newPassword, { type: argon2.argon2id });
    await db.update(admin).set({ passwordHash }).where(eq(admin.id, id));
    return { ok: true };
  });
}
