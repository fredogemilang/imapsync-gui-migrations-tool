import { ImapFlow } from 'imapflow';

export type ImapConfig = {
  host: string;
  port: number;
  security: string;
  username: string;
  password: string;
};

export type FolderInfo = { name: string; totalEmails: number; totalBytes: number };

export async function scanFolders(cfg: ImapConfig): Promise<FolderInfo[]> {
  const client = new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.security === 'SSL/TLS',
    auth: { user: cfg.username, pass: cfg.password },
    tls: { rejectUnauthorized: false },
    logger: false,
    socketTimeout: 60000,
  });
  // Absorb async 'error' events from imapflow (socket timeouts after logout
  // etc.) — without this listener, Node would crash with "Unhandled 'error'
  // event" and kill the BullMQ worker mid-job.
  client.on('error', () => {});
  await client.connect();
  const out: FolderInfo[] = [];
  try {
    const list = await client.list();
    for (const box of list) {
      if (box.flags?.has('\\Noselect')) continue;
      try {
        // RFC 8438 STATUS=SIZE — imapflow types lag the spec but the runtime
        // forwards size verbatim to the server.
        const status = (await client.status(box.path, { messages: true, size: true } as any)) as {
          messages?: number;
          size?: number;
        };
        out.push({
          name: box.path,
          totalEmails: status.messages ?? 0,
          totalBytes: status.size ?? 0,
        });
      } catch {
        // skip unreadable folder
      }
    }
  } finally {
    await client.logout().catch(() => {});
  }
  return out;
}
