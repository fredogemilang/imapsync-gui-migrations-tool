import { useState } from 'react';
import { CheckCircle2, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Dropdown, type DropdownOption } from '@/components/ui/Dropdown';
import { PROVIDER_DEFAULTS, PROVIDER_OPTIONS, type ProviderType } from '@/components/providers';

type AccountInput = {
  type: ProviderType;
  host: string;
  port: number;
  security: 'SSL/TLS' | 'STARTTLS' | 'None';
  username: string;
  password: string;
};

/** Per-field error message — presence means error. undefined = no error. */
export type AccountFieldErrors = {
  host?: string;
  username?: string;
  password?: string;
};

const SECURITY_OPTIONS: DropdownOption<'SSL/TLS' | 'STARTTLS' | 'None'>[] = [
  { value: 'SSL/TLS', label: 'SSL/TLS' },
  { value: 'STARTTLS', label: 'STARTTLS' },
  { value: 'None', label: 'None' },
];

export function AccountForm({
  title,
  value,
  onChange,
  error,
  success,
  fieldErrors,
}: {
  title: string;
  value: AccountInput;
  onChange: (patch: Partial<AccountInput>) => void;
  /** Server-side error message — shown as the large red box at the bottom. */
  error?: string;
  /** Success message — shown as a green box when this side has been verified. */
  success?: string;
  /** Per-field client-side validation messages — render a red border + hint. */
  fieldErrors?: AccountFieldErrors;
}) {
  const [showAdvanced, setShowAdvanced] = useState(false);

  return (
    <div className="space-y-6">
      <h3 className="text-primary-dark font-extrabold text-lg">{title}</h3>

      <div className="space-y-4">
        {/* Account Type */}
        <Dropdown<ProviderType>
          label="Account Type"
          value={value.type}
          options={PROVIDER_OPTIONS}
          onChange={(v) => {
            // Apply provider defaults (host/port/security) when switching.
            onChange({ type: v, ...PROVIDER_DEFAULTS[v] });
          }}
        />

        {/* Email */}
        <Field
          label="Email"
          value={value.username}
          onChange={(v) => onChange({ username: v })}
          placeholder="user@example.com"
          error={!!fieldErrors?.username}
          hint={fieldErrors?.username}
        />

        {/* Password */}
        <Field
          label="Password"
          value={value.password}
          onChange={(v) => onChange({ password: v })}
          type="password"
          placeholder="Your password"
          error={!!fieldErrors?.password}
          hint={fieldErrors?.password}
        />

        {/* Mailserver */}
        <Field
          label="Mailserver (IMAP)"
          value={value.host}
          onChange={(v) => onChange({ host: v })}
          placeholder="imap.example.com"
          error={!!error || !!fieldErrors?.host}
          hint={fieldErrors?.host}
        />

        {error && (
          <div className="bg-[#D32F2F] text-white rounded-xl p-5 space-y-4 shadow-lg text-[13px]">
            <p className="font-bold text-[15px]">Server connection failed!</p>
            <p>MailMigrate could not connect to your mail server. Please try again!</p>
            <div className="bg-white rounded-lg p-3 text-[12px]">
              <p className="font-bold text-red-600 mb-1">Server Response:</p>
              <p className="text-red-600 italic">{error}</p>
            </div>
          </div>
        )}

        {!error && success && (
          <div className="bg-emerald-50 border border-emerald-200 text-emerald-700 rounded-xl p-4 flex items-center gap-3 shadow-sm text-[13px]">
            <span className="bg-emerald-500 text-white rounded-full p-1 shrink-0">
              <CheckCircle2 className="h-4 w-4" strokeWidth={3} />
            </span>
            <div>
              <p className="font-bold text-[14px]">Connection verified</p>
              <p className="text-emerald-700/80">{success}</p>
            </div>
          </div>
        )}

        {/* Advanced */}
        <button
          type="button"
          onClick={() => setShowAdvanced((v) => !v)}
          className="w-full text-left bg-primary/5 px-4 py-3.5 border border-slate-200/60 rounded-xl flex items-center justify-between hover:bg-primary/10"
        >
          <span className="font-bold text-primary text-[14px]">Advanced Settings</span>
          <ChevronDown
            className={cn(
              'h-4 w-4 text-primary transition-transform',
              showAdvanced && 'rotate-180',
            )}
          />
        </button>
        {showAdvanced && (
          <div className="p-4 bg-slate-50/40 border border-slate-200/60 rounded-xl grid grid-cols-2 gap-3">
            <div className="bg-white border border-slate-200/80 rounded-xl p-3">
              <label className="block text-primary font-bold text-[11px] mb-0.5">Port</label>
              <input
                type="number"
                value={value.port}
                onChange={(e) => onChange({ port: Number(e.target.value) })}
                className="w-full bg-transparent text-primary text-[14px] outline-none"
              />
            </div>
            <Dropdown
              label="Security"
              value={value.security}
              options={SECURITY_OPTIONS}
              onChange={(v) => onChange({ security: v })}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
  error,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  error?: boolean;
  hint?: string;
}) {
  return (
    <div>
      <div
        className={cn(
          'bg-white border rounded-xl p-3 shadow-sm focus-within:border-primary/50 focus-within:ring-1 focus-within:ring-primary/10 transition-all',
          error ? 'border-red-500 ring-1 ring-red-500/10' : 'border-slate-200/80',
        )}
      >
        <label className="block text-primary font-bold text-[11px] mb-0.5">{label}</label>
        <input
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="w-full bg-transparent text-primary text-[14px] outline-none placeholder-slate-400 py-0.5"
        />
      </div>
      {hint && <p className="text-red-500 text-[11px] font-semibold mt-1 ml-1">{hint}</p>}
    </div>
  );
}
