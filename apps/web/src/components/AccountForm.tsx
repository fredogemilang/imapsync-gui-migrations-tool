import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

type AccountInput = {
  type: 'IMAP' | 'Microsoft' | 'Google' | 'Yahoo' | 'iCloud';
  host: string;
  port: number;
  security: 'SSL/TLS' | 'STARTTLS' | 'None';
  username: string;
  password: string;
};

const PROVIDERS: Array<{
  value: AccountInput['type'];
  label: string;
  defaults?: Partial<AccountInput>;
}> = [
  { value: 'IMAP', label: 'IMAP' },
  {
    value: 'Microsoft',
    label: 'Microsoft / Office 365',
    defaults: { host: 'outlook.office365.com', port: 993, security: 'SSL/TLS' },
  },
  {
    value: 'Google',
    label: 'Gmail / Google Workspace',
    defaults: { host: 'imap.gmail.com', port: 993, security: 'SSL/TLS' },
  },
  {
    value: 'Yahoo',
    label: 'Yahoo!',
    defaults: { host: 'imap.mail.yahoo.com', port: 993, security: 'SSL/TLS' },
  },
  {
    value: 'iCloud',
    label: 'iCloud / Apple',
    defaults: { host: 'imap.mail.me.com', port: 993, security: 'SSL/TLS' },
  },
];

export function AccountForm({
  title,
  value,
  onChange,
  error,
}: {
  title: string;
  value: AccountInput;
  onChange: (patch: Partial<AccountInput>) => void;
  error?: string;
}) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showProviderMenu, setShowProviderMenu] = useState(false);

  const currentProvider = PROVIDERS.find((p) => p.value === value.type) ?? PROVIDERS[0]!;

  return (
    <div className="space-y-6">
      <h3 className="text-primary-dark font-extrabold text-lg">{title}</h3>

      <div className="space-y-4">
        {/* Provider */}
        <div className="relative">
          <button
            type="button"
            onClick={() => setShowProviderMenu((v) => !v)}
            className="w-full text-left bg-white border border-slate-200/80 rounded-xl p-3 shadow-sm hover:border-primary/50 flex justify-between items-center"
          >
            <div>
              <div className="text-primary font-bold text-[11px]">Account Type</div>
              <div className="text-primary font-bold text-[14px]">{currentProvider.label}</div>
            </div>
            <ChevronDown
              className={cn(
                'h-4 w-4 text-slate-400 transition-transform',
                showProviderMenu && 'rotate-180',
              )}
            />
          </button>
          {showProviderMenu && (
            <div className="absolute left-0 right-0 mt-1 bg-white border border-slate-200 rounded-xl shadow-xl z-50 overflow-hidden">
              {PROVIDERS.map((p) => (
                <button
                  key={p.value}
                  type="button"
                  className="w-full text-left px-5 py-3 hover:bg-slate-50 text-primary-dark font-semibold text-[13.5px] border-b border-slate-100 last:border-0"
                  onClick={() => {
                    onChange({ type: p.value, ...(p.defaults ?? {}) });
                    setShowProviderMenu(false);
                  }}
                >
                  {p.label}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Email */}
        <Field
          label="Email"
          value={value.username}
          onChange={(v) => onChange({ username: v })}
          placeholder="user@example.com"
        />

        {/* Password */}
        <Field
          label="Password"
          value={value.password}
          onChange={(v) => onChange({ password: v })}
          type="password"
          placeholder="Your password"
        />

        {/* Mailserver */}
        <Field
          label="Mailserver (IMAP)"
          value={value.host}
          onChange={(v) => onChange({ host: v })}
          placeholder="imap.example.com"
          error={!!error}
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
            <div className="bg-white border border-slate-200/80 rounded-xl p-3">
              <label className="block text-primary font-bold text-[11px] mb-0.5">Security</label>
              <select
                value={value.security}
                onChange={(e) => onChange({ security: e.target.value as any })}
                className="w-full bg-transparent text-primary text-[14px] outline-none font-semibold"
              >
                <option>SSL/TLS</option>
                <option>STARTTLS</option>
                <option>None</option>
              </select>
            </div>
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
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  error?: boolean;
}) {
  return (
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
  );
}
