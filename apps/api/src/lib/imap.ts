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
  const client = new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure,
    auth: { user: cfg.username, pass: cfg.password },
    tls: { rejectUnauthorized: false },
    logger: false,
    socketTimeout: 30000,
  });
  // imapflow emits 'error' asynchronously (e.g. socket timeout AFTER logout).
  // Without a listener Node crashes with "Unhandled 'error' event" which
  // returns HTTP 500 to the user instead of our caught { ok:false, error }.
  // Attach a noop — the meaningful error path is already handled inside
  // testConnection / scanFolders via try/catch.
  client.on('error', () => {});
  return client;
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
    return { ok: false, error: formatImapError(e, cfg) };
  }
}

/** Build a useful, user-facing message from an imapflow error. */
function formatImapError(e: any, cfg: ImapConfig): string {
  // imapflow surfaces socket-level failures via `code` and IMAP auth/protocol
  // failures via `responseText` (the server's untagged reply).
  const code = e?.code;
  const respText = e?.responseText as string | undefined;
  const authFailure = e?.authenticationFailed === true;
  const message = e?.message as string | undefined;

  if (code === 'ENOTFOUND') return `DNS lookup failed for ${cfg.host}`;
  if (code === 'ECONNREFUSED') return `Connection refused by ${cfg.host}:${cfg.port}`;
  if (code === 'ETIMEDOUT' || /timeout/i.test(message ?? ''))
    return `Connection to ${cfg.host}:${cfg.port} timed out`;
  if (code === 'CERT_HAS_EXPIRED') return `TLS certificate on ${cfg.host} has expired`;
  if (code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || code === 'SELF_SIGNED_CERT_IN_CHAIN')
    return `TLS certificate on ${cfg.host} is self-signed`;

  if (authFailure) {
    return respText
      ? `Authentication failed: ${respText}`
      : 'Authentication failed — check username and password';
  }

  if (message === 'Command failed' && respText) {
    return `Authentication failed: ${respText}`;
  }
  if (respText) return respText;
  return message || 'Connection failed';
}

export type FolderInfo = { name: string; totalEmails: number; totalBytes: number };

export type InspectResult = {
  folders: FolderInfo[];
  folderCount: number;
  totalEmails: number;
  totalBytes: number;
  /** RFC 2087 STORAGE quota in bytes. `null` if server doesn't advertise QUOTA. */
  quota: { usedBytes: number; limitBytes: number } | null;
};

/**
 * Quick summary scan — used to inspect the TARGET account before migration.
 * Returns folder count, email count, total size (if STATUS=SIZE supported),
 * and storage quota (if QUOTA extension supported).
 */
export async function inspectAccount(cfg: ImapConfig): Promise<InspectResult> {
  const client = buildClient(cfg);
  await client.connect();
  const folders: FolderInfo[] = [];
  let quota: InspectResult['quota'] = null;
  try {
    const list = await client.list();
    for (const box of list) {
      if (box.flags?.has('\\Noselect')) continue;
      try {
        const status = (await client.status(box.path, { messages: true, size: true } as any)) as {
          messages?: number;
          size?: number;
        };
        folders.push({
          name: box.path,
          totalEmails: status.messages ?? 0,
          totalBytes: status.size ?? 0,
        });
      } catch {
        // skip inaccessible folder
      }
    }
    // RFC 2087 STORAGE quota — value is in KB per spec, convert to bytes.
    try {
      const q = (await (client as any).getQuota('INBOX').catch(() => null)) as {
        storage?: { usage?: number; limit?: number };
      } | null;
      const usage = q?.storage?.usage;
      const limit = q?.storage?.limit;
      if (typeof usage === 'number' && typeof limit === 'number' && limit > 0) {
        quota = { usedBytes: usage * 1024, limitBytes: limit * 1024 };
      }
    } catch {
      // server doesn't support QUOTA — leave null
    }
  } finally {
    await client.logout().catch(() => {});
  }
  return {
    folders,
    folderCount: folders.length,
    totalEmails: folders.reduce((a, f) => a + f.totalEmails, 0),
    totalBytes: folders.reduce((a, f) => a + f.totalBytes, 0),
    quota,
  };
}

/**
 * Scan folders for count and (when available) total size. Uses IMAP
 * STATUS extension (RFC 8438 — STATUS=SIZE) for O(1) size per folder
 * instead of the O(N) per-message FETCH we used to do. If the server
 * doesn't advertise STATUS=SIZE, `status.size` comes back undefined
 * and we leave totalBytes at 0.
 *
 * imapsync still reports authoritative byte totals during the actual
 * migration run.
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
        // RFC 8438 STATUS=SIZE — imapflow types lag the spec, but the
        // option/return field are forwarded to the server verbatim.
        const status = (await client.status(box.path, { messages: true, size: true } as any)) as {
          messages?: number;
          size?: number;
        };
        result.push({
          name: box.path,
          totalEmails: status.messages ?? 0,
          totalBytes: status.size ?? 0,
        });
      } catch {
        // skip inaccessible folder
      }
    }
  } finally {
    await client.logout().catch(() => {});
  }
  return result;
}
