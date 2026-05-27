import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

// ----- Constants ------------------------------------------------------------
// Mirror of the single-migration wizard: short idle expiry so the plaintext
// passwords we hold in sessionStorage don't sit there forever after the
// user walks away from their laptop.
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const STORAGE_KEY = 'emt-bulk-wizard';

// ----- Types ----------------------------------------------------------------

export type BulkServer = {
  host: string;
  port: number;
  security: 'SSL/TLS' | 'STARTTLS' | 'None';
  ignoreSsl: boolean;
};

export type BulkPair = {
  id: string;
  sourceUser: string;
  sourcePass: string;
  targetUser: string;
  targetPass: string;
  sync: boolean;
  backup: boolean;
};

export type BulkSettings = {
  autoSync: boolean;
  backupMode: boolean;
  /** Cadence for Backup Mode at the bulk level (applies to every pair). */
  backupInterval: 'monthly' | 'weekly' | 'daily';
  throttleEnabled: boolean;
  throttleGbPerDay: number;
  syncDuplicates: boolean;
  enableCache: boolean;
  reduceBandwidth: boolean;
  dateFilterEnabled: boolean;
  dateFrom: string;
  dateTo: string;
};

type State = {
  source: BulkServer;
  target: BulkServer;
  pairs: BulkPair[];
  settings: BulkSettings;
  /** Set when checkMailboxes passes in Step 1 — gates entry to Step 2. */
  validated: boolean;
  lastActivityAt: number;
  setSource: (s: BulkServer) => void;
  setTarget: (s: BulkServer) => void;
  setPairs: (p: BulkPair[]) => void;
  setSettings: (patch: Partial<BulkSettings>) => void;
  markValidated: () => void;
  reset: () => void;
};

// ----- Defaults -------------------------------------------------------------

const defaultServer = (): BulkServer => ({
  host: '',
  port: 993,
  security: 'SSL/TLS',
  ignoreSsl: false,
});

const defaultSettings: BulkSettings = {
  autoSync: false,
  backupMode: false,
  backupInterval: 'monthly',
  throttleEnabled: false,
  throttleGbPerDay: 1,
  syncDuplicates: false,
  enableCache: false,
  reduceBandwidth: false,
  dateFilterEnabled: false,
  dateFrom: '',
  dateTo: '',
};

function freshDefaults() {
  return {
    source: defaultServer(),
    target: defaultServer(),
    pairs: [] as BulkPair[],
    settings: { ...defaultSettings },
    validated: false,
    lastActivityAt: Date.now(),
  };
}

// ----- Idle-expiring sessionStorage (same pattern as single wizard) --------

const expiringSessionStorage = {
  getItem(name: string): string | null {
    const raw = sessionStorage.getItem(name);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as { state?: { lastActivityAt?: number } };
      const ts = parsed.state?.lastActivityAt;
      if (typeof ts === 'number' && Date.now() - ts > IDLE_TIMEOUT_MS) {
        sessionStorage.removeItem(name);
        return null;
      }
    } catch {
      sessionStorage.removeItem(name);
      return null;
    }
    return raw;
  },
  setItem(name: string, value: string): void {
    sessionStorage.setItem(name, value);
  },
  removeItem(name: string): void {
    sessionStorage.removeItem(name);
  },
};

// ----- Store ----------------------------------------------------------------

export const useBulkWizard = create<State>()(
  persist(
    (set) => ({
      ...freshDefaults(),
      setSource: (source) => set({ source, lastActivityAt: Date.now(), validated: false }),
      setTarget: (target) => set({ target, lastActivityAt: Date.now(), validated: false }),
      setPairs: (pairs) => set({ pairs, lastActivityAt: Date.now(), validated: false }),
      setSettings: (patch) =>
        set((s) => ({ settings: { ...s.settings, ...patch }, lastActivityAt: Date.now() })),
      markValidated: () => set({ validated: true, lastActivityAt: Date.now() }),
      reset: () => set(freshDefaults()),
    }),
    {
      name: STORAGE_KEY,
      storage: createJSONStorage(() => expiringSessionStorage),
    },
  ),
);
