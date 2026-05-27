import { Mail } from 'lucide-react';
import type { DropdownOption } from '@/components/ui/Dropdown';

export type ProviderType = 'IMAP' | 'Microsoft' | 'Google' | 'Yahoo' | 'iCloud';

// ---- Provider logos (icons for the Account Type dropdown) -------------------

function ImapIcon() {
  return (
    <div className="w-5 h-5 flex items-center justify-center text-slate-400">
      <Mail className="h-4 w-4" strokeWidth={2.5} />
    </div>
  );
}

function MicrosoftIcon() {
  return (
    <div className="grid grid-cols-2 gap-0.5 w-5 h-5 shrink-0">
      <div className="bg-[#F25022]" />
      <div className="bg-[#7FBA00]" />
      <div className="bg-[#00A4EF]" />
      <div className="bg-[#FFB900]" />
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg className="h-5 w-5 shrink-0" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2z"
        fill="#F4B400"
      />
      <path
        d="M2 18V6c0-1.1.9-2 2-2h3l5 5 5-5h3c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2h-3v-7l-5 5-5-5v7H4c-1.1 0-2-.9-2-2z"
        fill="#DB4437"
      />
      <path d="M4 4h16c1.1 0 2 .9 2 2v1l-10 7L2 7V6c0-1.1.9-2 2-2z" fill="#4285F4" />
      <path d="M2 7v11c0 1.1.9 2 2 2h2v-9l-4-4z" fill="#0F9D58" />
    </svg>
  );
}

function YahooIcon() {
  return (
    <svg
      className="h-5 w-5 text-[#6001d2] shrink-0"
      fill="currentColor"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M12.586 12.35L17.785 4h-2.8L11.23 10.3 7.45 4H4.55l5.2 8.35v6.65h2.836v-6.65zm5.13-5.59h2.385v5.82H17.716V6.76zM17.716 14.54h2.385v2.385H17.716v-2.385z" />
    </svg>
  );
}

function ICloudIcon() {
  return (
    <svg
      className="h-5 w-5 text-[#5097f4] shrink-0"
      fill="currentColor"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96z" />
    </svg>
  );
}

/** Optional defaults applied when user selects a provider (host, port, security). */
export const PROVIDER_DEFAULTS: Record<
  ProviderType,
  Partial<{ host: string; port: number; security: 'SSL/TLS' | 'STARTTLS' | 'None' }>
> = {
  IMAP: {},
  Microsoft: { host: 'outlook.office365.com', port: 993, security: 'SSL/TLS' },
  Google: { host: 'imap.gmail.com', port: 993, security: 'SSL/TLS' },
  Yahoo: { host: 'imap.mail.yahoo.com', port: 993, security: 'SSL/TLS' },
  iCloud: { host: 'imap.mail.me.com', port: 993, security: 'SSL/TLS' },
};

/** Dropdown options for the Account Type field. */
export const PROVIDER_OPTIONS: DropdownOption<ProviderType>[] = [
  { value: 'IMAP', label: 'IMAP', icon: <ImapIcon /> },
  { value: 'Microsoft', label: 'Microsoft / Office 365', icon: <MicrosoftIcon /> },
  { value: 'Google', label: 'Gmail / Google Workspace', icon: <GoogleIcon /> },
  { value: 'Yahoo', label: 'Yahoo!', icon: <YahooIcon /> },
  { value: 'iCloud', label: 'iCloud / Apple', icon: <ICloudIcon /> },
];
