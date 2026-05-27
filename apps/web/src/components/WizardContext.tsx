import { create } from 'zustand';

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
  set: (patch: Partial<State>) => void;
  setSource: (patch: Partial<AccountInput>) => void;
  setTarget: (patch: Partial<AccountInput>) => void;
  setSettings: (patch: Partial<Settings>) => void;
  reset: () => void;
};

const defaultAccount: AccountInput = {
  type: 'IMAP',
  host: '',
  port: 993,
  security: 'SSL/TLS',
  username: '',
  password: '',
};

const defaultSettings: Settings = {
  autoSync: false,
  backupMode: true,
  throttleEnabled: false,
  throttleGbPerDay: 1,
  syncDuplicates: true,
  enableCache: true,
  reduceBandwidth: false,
  dateFilterEnabled: false,
  dateFrom: '',
  dateTo: '',
};

export const useWizard = create<State>((set) => ({
  source: { ...defaultAccount },
  target: { ...defaultAccount },
  settings: { ...defaultSettings },
  set: (patch) => set(patch),
  setSource: (patch) => set((s) => ({ source: { ...s.source, ...patch } })),
  setTarget: (patch) => set((s) => ({ target: { ...s.target, ...patch } })),
  setSettings: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),
  reset: () =>
    set({
      source: { ...defaultAccount },
      target: { ...defaultAccount },
      settings: { ...defaultSettings },
    }),
}));
