const BASE = ''; // proxied via vite or same-origin in prod

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
    ...init,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as any).error ?? `HTTP ${res.status}`);
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

  listMigrations: () => request<any[]>('/api/migrations'),
  getMigration: (id: string) => request<any>(`/api/migrations/${id}`),
  createMigration: (payload: any) =>
    request<{ id: string }>('/api/migrations', { method: 'POST', body: JSON.stringify(payload) }),
  stopMigration: (id: string) => request(`/api/migrations/${id}/stop`, { method: 'POST' }),
  resumeMigration: (id: string) => request(`/api/migrations/${id}/resume`, { method: 'POST' }),
  getLogs: (id: string) => request<any[]>(`/api/migrations/${id}/logs`),

  listBulk: () => request<any[]>('/api/bulk-migrations'),
  getBulk: (id: string) => request<any>(`/api/bulk-migrations/${id}`),
  createBulk: (payload: any) =>
    request<{ id: string }>('/api/bulk-migrations', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  getSettings: () => request<any>('/api/settings'),
  saveSettings: (payload: any) =>
    request('/api/settings', { method: 'PUT', body: JSON.stringify(payload) }),
};

export type ImapCfg = {
  host: string;
  port: number;
  security: 'SSL/TLS' | 'STARTTLS' | 'None';
  username: string;
  password: string;
};
