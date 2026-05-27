import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { scanFolders, testConnection } from '../lib/imap.js';

const ImapCfg = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(993),
  security: z.enum(['SSL/TLS', 'STARTTLS', 'None']).default('SSL/TLS'),
  username: z.string().min(1),
  password: z.string().min(1),
});

export async function imapRoutes(app: FastifyInstance) {
  app.post('/api/imap/test-connection', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const cfg = ImapCfg.parse(req.body);
    const result = await testConnection(cfg);
    if (!result.ok) return reply.code(400).send(result);
    return result;
  });

  app.post('/api/imap/scan-folders', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const cfg = ImapCfg.parse(req.body);
    try {
      const folders = await scanFolders(cfg);
      return { ok: true, folders };
    } catch (e: any) {
      return reply.code(400).send({ ok: false, error: e?.message ?? 'Scan failed' });
    }
  });
}
