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
  await client.connect();
  const out: FolderInfo[] = [];
  try {
    const list = await client.list();
    for (const box of list) {
      if (box.flags?.has('\\Noselect')) continue;
      try {
        const status = await client.status(box.path, { messages: true });
        // totalBytes deliberately 0: per-message FETCH for sizes is O(N) and
        // unusable on real mailboxes. imapsync reports byte totals during run.
        out.push({ name: box.path, totalEmails: status.messages ?? 0, totalBytes: 0 });
      } catch {
        // skip unreadable folder
      }
    }
  } finally {
    await client.logout().catch(() => {});
  }
  return out;
}
