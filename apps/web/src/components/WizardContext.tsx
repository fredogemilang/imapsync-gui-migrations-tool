import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

// ----- Constants -------------------------------------------------------------

/** Wipe the wizard (incl. plaintext IMAP password) after this idle window.
 *  10 minutes balances "user stepped away briefly" (bathroom, phone) vs.
 *  "laptop left unattended at lunch — anyone walking by can read it". */
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;

const STORAGE_KEY = 'emt-wizard';

// ----- Types -----------------------------------------------------------------

type AccountInput = {
  type: 'IMAP' | 'Microsoft' | 'Google' | 'Yahoo' | 'iCloud';
  host: string;
  port: number;
  security: 'SSL/TLS' | 'STARTTLS' | 'None';
  username: string;
  password: string;
};

type Settings = {
  autoSync: boolean;
  backupMode: boolean;
  /** Cadence for Backup Mode. Ignored when backupMode is false. */
  backupInterval: 'daily' | 'weekly' | 'monthly';
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
  source: AccountInput;
  target: AccountInput;
  settings: Settings;
  validatedSource: AccountInput | null;
  validatedTarget: AccountInput | null;
  /** Timestamp of last user-initiated mutation. Used for idle expiry. */
  lastActivityAt: number;
  set: (patch: Partial<State>) => void;
  setSource: (patch: Partial<AccountInput>) => void;
  setTarget: (patch: Partial<AccountInput>) => void;
  setSettings: (patch: Partial<Settings>) => void;
  markSourceValidated: () => void;
  markTargetValidated: () => void;
  reset: () => void;
};

// ----- Defaults --------------------------------------------------------------

const defaultAccount: AccountInput = {
  type: 'IMAP',
  host: '',
  port: 993,
  security: 'SSL/TLS',
  username: '',
  password: '',
};

// All toggles default to OFF — out of the box we run imapsync with its
// vanilla defaults (skip duplicates via Message-Id, no throttle, no cache,
// no date filter, no auto/backup sync). User opts in per migration.
const defaultSettings: Settings = {
  autoSync: false,
  backupMode: false,
  backupInterval: 'daily',
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
    source: { ...defaultAccount },
    target: { ...defaultAccount },
    settings: { ...defaultSettings },
    validatedSource: null,
    validatedTarget: null,
    lastActivityAt: Date.now(),
  } as const;
}

// ----- Storage with idle-expiry ---------------------------------------------

/** sessionStorage wrapper that drops the persisted entry if it has been idle
 *  longer than IDLE_TIMEOUT_MS. Detected on read, so a fresh refresh after a
 *  long pause gets the default empty wizard back. */
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
      // unparseable — drop it
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

// ----- Store -----------------------------------------------------------------

// Persist the in-progress wizard to sessionStorage so a refresh during the
// migration flow doesn't dump the user back to step 1 with empty fields.
// sessionStorage (not localStorage) is intentional — it clears when the tab
// closes. Additionally we auto-wipe after IDLE_TIMEOUT_MS of inactivity to
// limit how long plaintext IMAP passwords sit at rest.
export const useWizard = create<State>()(
  persist(
    (set, get) => ({
      ...freshDefaults(),
      set: (patch) => set(patch),
      setSource: (patch) =>
        set((s) => ({ source: { ...s.source, ...patch }, lastActivityAt: Date.now() })),
      setTarget: (patch) =>
        set((s) => ({ target: { ...s.target, ...patch }, lastActivityAt: Date.now() })),
      setSettings: (patch) =>
        set((s) => ({ settings: { ...s.settings, ...patch }, lastActivityAt: Date.now() })),
      markSourceValidated: () => {
        const { source } = get();
        set({ validatedSource: { ...source }, lastActivityAt: Date.now() });
      },
      markTargetValidated: () => {
        const { target } = get();
        set({ validatedTarget: { ...target }, lastActivityAt: Date.now() });
      },
      reset: () => set(freshDefaults()),
    }),
    {
      name: STORAGE_KEY,
      storage: createJSONStorage(() => expiringSessionStorage),
    },
  ),
);

/** Start a polling loop that wipes the in-memory wizard state when the idle
 *  timeout has elapsed. Call once on app boot. Returns a teardown fn. */
export function startWizardIdleWatcher(): () => void {
  const handle = setInterval(() => {
    const { lastActivityAt, reset } = useWizard.getState();
    if (Date.now() - lastActivityAt > IDLE_TIMEOUT_MS) {
      reset();
      sessionStorage.removeItem(STORAGE_KEY);
    }
  }, 60_000); // check every minute
  return () => clearInterval(handle);
}

// ----- Derived selectors -----------------------------------------------------

function accountEqual(a: AccountInput, b: AccountInput): boolean {
  return (
    a.type === b.type &&
    a.host === b.host &&
    a.port === b.port &&
    a.security === b.security &&
    a.username === b.username &&
    a.password === b.password
  );
}

/** True iff the current source matches the last-validated source snapshot. */
export function useIsSourceValidated(): boolean {
  return useWizard((s) => s.validatedSource !== null && accountEqual(s.source, s.validatedSource));
}

/** True iff the current target matches the last-validated target snapshot. */
export function useIsTargetValidated(): boolean {
  return useWizard((s) => s.validatedTarget !== null && accountEqual(s.target, s.validatedTarget));
}

/** True iff BOTH sides are currently validated — gate for advancing to step 2. */
export function useIsValidated(): boolean {
  const a = useIsSourceValidated();
  const b = useIsTargetValidated();
  return a && b;
}
