import { ImapFlow } from 'imapflow';

export type ImapConfig = {
  host: string;
  port: number;
  security: 'SSL/TLS' | 'STARTTLS' | 'None';
  username: string;
  password: string;
};

function buildClient(cfg: ImapConfig): ImapFlow {
  const secure = cfg.security === 'SSL/TLS';
  return new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure,
    auth: { user: cfg.username, pass: cfg.password },
    tls: { rejectUnauthorized: false },
    logger: false,
    socketTimeout: 30000,
  });
}

export async function testConnection(
  cfg: ImapConfig,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const client = buildClient(cfg);
  try {
    await client.connect();
    await client.logout();
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'Connection failed' };
  }
}

export type FolderInfo = { name: string; totalEmails: number; totalBytes: number };

/**
 * Scan folders for COUNT only — does NOT iterate per-message FETCH for sizes.
 * Per-message size fetch is O(N) and times out for any real-world mailbox
 * (50k+ messages). Size is calculated later by imapsync itself during
 * migration (--nofoldersizes still reports byte totals at the end).
 */
export async function scanFolders(cfg: ImapConfig): Promise<FolderInfo[]> {
  const client = buildClient(cfg);
  await client.connect();
  const result: FolderInfo[] = [];
  try {
    const list = await client.list();
    for (const box of list) {
      if (box.flags?.has('\\Noselect')) continue;
      try {
        const status = await client.status(box.path, { messages: true });
        result.push({ name: box.path, totalEmails: status.messages ?? 0, totalBytes: 0 });
      } catch {
        // skip inaccessible folder
      }
    }
  } finally {
    await client.logout().catch(() => {});
  }
  return result;
}
