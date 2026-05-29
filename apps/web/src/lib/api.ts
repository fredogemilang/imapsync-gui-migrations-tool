// API origin. Default empty string means SAME-ORIGIN — the browser hits
// `/api/*` on whatever domain served the page (Traefik then routes /api
// to the api container based on PathPrefix). This is the simplest setup
// and the recommended default.
//
// Override at BUILD time via `VITE_API_BASE` (Dockerfile ARG) when the
// web app is served from a different domain than the api, e.g.:
//   web → https://app.example.com
//   api → https://api.example.com  ← set VITE_API_BASE to this
// Don't include a trailing slash — paths like `/api/migrations` are
// concatenated as-is.
const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? '';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // IMPORTANT: only advertise application/json when we actually send a body.
  // Fastify's default JSON parser rejects empty-body requests when the
  // Content-Type header is set to application/json with the runtime error
  // "Body cannot be empty when content-type is set to 'application/json'".
  // This used to fire for every body-less mutation (logout, stop, resume,
  // disable sync, sync now, delete) — those endpoints look like they
  // happened to "work" only because the network errors were silently
  // ignored elsewhere.
  const hasBody = init?.body != null;
  const userHeaders = (init?.headers ?? {}) as Record<string, string>;
  const headers: Record<string, string> = { ...userHeaders };
  if (hasBody && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(BASE + path, {
    credentials: 'include',
    ...init,
    headers,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      message?: string;
    };
    // Surface the most informative field. Our handlers use `error: '...'`;
    // Fastify's default 404/error returns also include a `message` field
    // (e.g. "Route DELETE:/api/migrations/... not found") which is far
    // more diagnostic when the API server is on stale code. Join both when
    // they disagree so the user sees the full picture.
    const parts = [body.error, body.message].filter(
      (v, i, a): v is string => Boolean(v) && a.indexOf(v) === i,
    );
    throw new Error(parts.length ? parts.join(' — ') : `HTTP ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  login: (email: string, password: string) =>
    request<{ ok: boolean; email: string }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  logout: () => request('/api/auth/logout', { method: 'POST' }),
  me: () => request<{ email: string }>('/api/auth/me'),
  changePassword: (currentPassword: string, newPassword: string) =>
    request('/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    }),

  testConnection: (cfg: ImapCfg) =>
    request<{ ok: boolean; error?: string }>('/api/imap/test-connection', {
      method: 'POST',
      body: JSON.stringify(cfg),
    }),
  scanFolders: (cfg: ImapCfg) =>
    request<{ ok: boolean; folders: { name: string; totalEmails: number; totalBytes: number }[] }>(
      '/api/imap/scan-folders',
      { method: 'POST', body: JSON.stringify(cfg) },
    ),

  inspectAccount: (cfg: ImapCfg) =>
    request<{
      ok: boolean;
      folders: { name: string; totalEmails: number; totalBytes: number }[];
      folderCount: number;
      totalEmails: number;
      totalBytes: number;
      quota: { usedBytes: number; limitBytes: number } | null;
    }>('/api/imap/inspect', { method: 'POST', body: JSON.stringify(cfg) }),

  listMigrations: () => request<any[]>('/api/migrations'),
  getMigration: (id: string) => request<any>(`/api/migrations/${id}`),
  createMigration: (payload: any) =>
    request<{ id: string }>('/api/migrations', { method: 'POST', body: JSON.stringify(payload) }),
  stopMigration: (id: string) => request(`/api/migrations/${id}/stop`, { method: 'POST' }),
  resumeMigration: (id: string) => request(`/api/migrations/${id}/resume`, { method: 'POST' }),
  deleteMigration: (id: string) =>
    request<{ ok: boolean }>(`/api/migrations/${id}`, { method: 'DELETE' }),
  /** Deletes every migration in a terminal state (completed/failed/cancelled). */
  deleteFinishedMigrations: () =>
    request<{ ok: boolean; deleted: number }>('/api/migrations', { method: 'DELETE' }),
  getLogs: (id: string) => request<any[]>(`/api/migrations/${id}/logs`),

  enableSync: (
    id: string,
    mode: 'auto' | 'backup',
    interval?: '15min' | '30min' | '1h' | '3h' | '6h' | 'daily' | 'weekly' | 'monthly',
  ) =>
    request<{ ok: boolean; intervalMs: number; endsAt: string | null }>(
      `/api/migrations/${id}/sync/enable`,
      { method: 'POST', body: JSON.stringify({ mode, interval }) },
    ),
  disableSync: (id: string) => request(`/api/migrations/${id}/sync/disable`, { method: 'POST' }),
  syncNow: (id: string) => request(`/api/migrations/${id}/sync/now`, { method: 'POST' }),
  /** List sync runs for a single migration (latest 50, newest first). */
  listSyncRuns: (id: string) => request<SyncRun[]>(`/api/migrations/${id}/sync-runs`),
  /** Logs for one sync run, newest first. */
  getSyncRunLogs: (id: string, runId: string) =>
    request<SyncLogRow[]>(`/api/migrations/${id}/sync-runs/${runId}/logs`),

  listBulk: () => request<any[]>('/api/bulk-migrations'),
  getBulk: (id: string) => request<any>(`/api/bulk-migrations/${id}`),
  createBulk: (payload: any) =>
    request<{ id: string }>('/api/bulk-migrations', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  stopBulk: (id: string) =>
    request<{ ok: boolean }>(`/api/bulk-migrations/${id}/stop`, { method: 'POST' }),
  deleteBulk: (id: string) =>
    request<{ ok: boolean }>(`/api/bulk-migrations/${id}`, { method: 'DELETE' }),
  deleteFinishedBulks: () =>
    request<{ ok: boolean; deleted: number }>('/api/bulk-migrations', { method: 'DELETE' }),
  updateBulkSettings: (id: string, patch: Record<string, unknown>) =>
    request<{ ok: boolean; settings: Record<string, unknown> }>(
      `/api/bulk-migrations/${id}/settings`,
      { method: 'PATCH', body: JSON.stringify(patch) },
    ),
  bulkSyncNow: (id: string) =>
    request<{ ok: boolean; count: number; sessionId: string }>(
      `/api/bulk-migrations/${id}/sync/now`,
      { method: 'POST' },
    ),
  listBulkSyncSessions: (id: string) =>
    request<BulkSyncSession[]>(`/api/bulk-migrations/${id}/sync-sessions`),
  getBulkSyncSession: (id: string, sessionId: string) =>
    request<BulkSyncSession & { runs: BulkSyncSessionRun[] }>(
      `/api/bulk-migrations/${id}/sync-sessions/${sessionId}`,
    ),
  stopBulkSyncSession: (id: string, sessionId: string) =>
    request<{ ok: boolean; drained: number }>(
      `/api/bulk-migrations/${id}/sync-sessions/${sessionId}/stop`,
      { method: 'POST' },
    ),
  /** List sync runs for one bulk pair (latest 50, newest first). */
  listBulkPairSyncRuns: (bulkId: string, pairId: number) =>
    request<SyncRun[]>(`/api/bulk-migrations/${bulkId}/pairs/${pairId}/sync-runs`),
  /** Logs for one bulk pair sync run. */
  getBulkPairSyncRunLogs: (bulkId: string, pairId: number, runId: string) =>
    request<SyncLogRow[]>(`/api/bulk-migrations/${bulkId}/pairs/${pairId}/sync-runs/${runId}/logs`),
  /** Initial bulk migration logs for one pair (sync_run_id IS NULL). */
  getBulkPairInitialLogs: (bulkId: string, pairId: number) =>
    request<SyncLogRow[]>(`/api/bulk-migrations/${bulkId}/pairs/${pairId}/logs`),
  /** Retry one failed pair — enqueues a single-pair bulk-migration job. */
  retryBulkPair: (bulkId: string, pairId: number) =>
    request<{ ok: boolean }>(`/api/bulk-migrations/${bulkId}/pairs/${pairId}/retry`, {
      method: 'POST',
    }),

  getSettings: () => request<any>('/api/settings'),
  saveSettings: (payload: any) =>
    request('/api/settings', { method: 'PUT', body: JSON.stringify(payload) }),

  listNotifications: () =>
    request<
      {
        id: string;
        kind: 'success' | 'error' | 'warning' | 'info' | string;
        title: string;
        body: string;
        linkPath: string | null;
        readAt: string | null;
        createdAt: string;
      }[]
    >('/api/notifications'),
  unreadNotificationCount: () => request<{ count: number }>('/api/notifications/unread-count'),
  markNotificationRead: (id: string) =>
    request<{ ok: boolean }>(`/api/notifications/${id}/read`, { method: 'POST' }),
  markAllNotificationsRead: () =>
    request<{ ok: boolean; marked: number }>('/api/notifications/read-all', { method: 'POST' }),
};

export type ImapCfg = {
  host: string;
  port: number;
  security: 'SSL/TLS' | 'STARTTLS' | 'None';
  username: string;
  password: string;
};

/** Server-emitted sync run record. The shape matches the `sync_run` table
 *  row, with timestamps serialised as ISO strings over the wire. */
export type SyncRun = {
  id: string;
  migrationId: string | null;
  bulkId: string | null;
  bulkPairId: number | null;
  trigger: 'auto' | 'backup' | 'manual';
  status: 'running' | 'success' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  migratedEmails: number;
  migratedBytes: number;
  errorMessage: string | null;
};

/** Generic row shape for both `migration_log` and `bulk_pair_log`. The id
 *  type differs (text uuid for sync run logs vs serial int for both log
 *  tables) but UIs treat it opaquely so we keep it loose. */
export type SyncLogRow = {
  id: number;
  ts: string;
  level: string;
  message: string;
};

/** Bulk-level sync session — groups N per-pair sync runs that ran as
 *  one batch (Sync Now) or one tick cycle (Auto/Backup). */
export type BulkSyncSession = {
  id: string;
  bulkId: string;
  type: 'manual' | 'auto' | 'backup' | string;
  status: 'running' | 'finished' | 'failed' | 'cancelled' | string;
  startedAt: string;
  finishedAt: string | null;
  totalPairs: number;
  finishedPairs: number;
  failedPairs: number;
};

/** Per-pair sync_run row within a session, with the pair's source/target
 *  usernames joined in for the progress table. */
export type BulkSyncSessionRun = {
  id: string;
  bulkPairId: number;
  status: 'running' | 'success' | 'failed' | string;
  startedAt: string;
  finishedAt: string | null;
  migratedEmails: number;
  migratedBytes: number;
  errorMessage: string | null;
  sourceUsername: string | null;
  targetUsername: string | null;
};
