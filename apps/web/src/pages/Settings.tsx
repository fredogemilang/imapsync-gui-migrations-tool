import { useEffect, useRef, useState } from 'react';
import { Settings as SettingsIcon } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api } from '@/lib/api';
import { CustomDropdown } from '@/components/ui/CustomDropdown';
import {
  HeaderBackLink,
  useHeaderLeft,
  useSidebarIcon,
  useSidebarTitle,
} from '@/components/Layout';

/**
 * Settings page — layout mirrors `mockup/template/partials/settings-content.html`:
 *
 *   App Settings:
 *     [ Show Passwords As: Obstructed ▼ ]                  (full-width)
 *
 *   Migration Settings:
 *     [ Simultaneous Migrations: 3 ▼ ]  (i)
 *     [ Delete Finished After:    1 Month ▼ ]  (i)
 *     [ Email Header Settings:    default ▼ ]  (i)
 *
 *   Security & Access:
 *     [ Account Password — ... ]  [ Change Password ]
 *
 * Auto-saves on each dropdown selection (PUT /api/settings), debounced
 * lightly to absorb rapid re-clicks. No separate "Save" button — matches
 * the mockup's behaviour and avoids the "did my change persist?" anxiety
 * common with explicit-save settings UIs.
 */

type SettingsState = {
  simultaneousMigrations: number;
  retentionDays: number;
  passwordDisplay: 'Obstructed' | 'Readable';
  emailHeaderSettings: 'default' | 'Strip Custom Headers' | 'Keep All Headers';
};

const DEFAULTS: SettingsState = {
  simultaneousMigrations: 3,
  retentionDays: 30,
  passwordDisplay: 'Obstructed',
  emailHeaderSettings: 'default',
};

export function Settings() {
  const [s, setS] = useState<SettingsState>(DEFAULTS);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Accumulates partial patches between debounced PUTs so quick successive
  // clicks (e.g. user changes A then B within 200ms) coalesce into a
  // single API call carrying both fields — avoids the closure-staleness
  // trap of building the payload from `s` inside the timer callback.
  const pendingPatchRef = useRef<Partial<SettingsState>>({});

  useHeaderLeft(<HeaderBackLink to="/" label="Back to Overview" />);
  useSidebarTitle('Settings');
  useSidebarIcon(SettingsIcon);

  useEffect(() => {
    api
      .getSettings()
      .then((r) => setS((p) => ({ ...p, ...r })))
      .catch(() => {
        /* fall back to DEFAULTS — settings page should never block */
      });
  }, []);

  /** Persist one or more keys. Debounced 200ms so a series of quick
   *  selections coalesces into a single PUT — the API would gladly
   *  accept N round-trips, this just keeps the network panel quiet. */
  const persist = (patch: Partial<SettingsState>) => {
    setS((prev) => ({ ...prev, ...patch }));
    pendingPatchRef.current = { ...pendingPatchRef.current, ...patch };
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(async () => {
      const payload = pendingPatchRef.current;
      pendingPatchRef.current = {};
      try {
        setError(null);
        await api.saveSettings(payload);
        setSavedAt(Date.now());
      } catch (e: any) {
        setError(e?.message ?? 'Failed to save settings');
      }
    }, 200);
  };

  return (
    <div className="max-w-3xl mx-auto space-y-8">
      {/* Save indicator (tiny floating toast at the top) */}
      {(savedAt || error) && (
        <div
          key={savedAt ?? 'err'}
          className={
            error
              ? 'text-red-700 font-bold text-sm bg-red-50 border border-red-200 rounded-xl px-4 py-2'
              : 'text-emerald-700 font-bold text-sm bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-2'
          }
        >
          {error ? `Save failed: ${error}` : 'Saved'}
        </div>
      )}

      {/* Section 1: App Settings */}
      <section className="space-y-4">
        <h3 className="text-primary-dark font-extrabold text-lg">App Settings:</h3>
        <CustomDropdown
          label="Show Passwords As"
          value={s.passwordDisplay}
          onChange={(v) => persist({ passwordDisplay: v })}
          options={[
            { value: 'Obstructed', label: 'Obstructed' },
            { value: 'Readable', label: 'Readable' },
          ]}
        />
      </section>

      {/* Section 2: Migration Settings */}
      <section className="space-y-4">
        <h3 className="text-primary-dark font-extrabold text-lg">Migration Settings:</h3>
        <div className="space-y-3">
          <DropdownWithInfo
            tooltip="How many mailboxes can be migrated at the exact same time. Higher values speed up large bulk migrations but require higher server bandwidth."
          >
            <CustomDropdown
              label="Number of Simultaneous Migrations"
              value={s.simultaneousMigrations}
              onChange={(v) => persist({ simultaneousMigrations: v })}
              options={[
                { value: 1, label: '1 Migration' },
                { value: 2, label: '2 Migrations' },
                { value: 3, label: '3 Migrations' },
                { value: 5, label: '5 Migrations' },
                { value: 10, label: '10 Migrations' },
              ]}
            />
          </DropdownWithInfo>

          <DropdownWithInfo
            tooltip="Automatically clear migration logs and temporary databases after the specified duration has passed since completion."
          >
            <CustomDropdown
              label="Delete Finished Migrations After"
              value={s.retentionDays}
              onChange={(v) => persist({ retentionDays: v })}
              options={[
                { value: 7, label: '1 Week' },
                { value: 30, label: '1 Month' },
                { value: 90, label: '3 Months' },
                { value: 365, label: '1 Year' },
                { value: 0, label: 'Never Delete' },
              ]}
            />
          </DropdownWithInfo>

          <DropdownWithInfo
            tooltip="Configure how metadata headers (e.g. Received, X-Mailer, SPF results) are processed and preserved during transmission."
          >
            <CustomDropdown
              label="Email Header Settings"
              value={s.emailHeaderSettings}
              onChange={(v) => persist({ emailHeaderSettings: v })}
              options={[
                { value: 'default', label: 'default' },
                { value: 'Strip Custom Headers', label: 'Strip Custom Headers' },
                { value: 'Keep All Headers', label: 'Keep All Headers' },
              ]}
            />
          </DropdownWithInfo>
        </div>
      </section>

      {/* Section 3: Security & Access */}
      <section className="space-y-4">
        <h3 className="text-primary-dark font-extrabold text-lg">Security &amp; Access:</h3>
        <div className="bg-white border border-slate-200/80 rounded-xl px-5 py-4 flex items-center justify-between shadow-sm hover:border-slate-300 transition-colors gap-4">
          <div className="flex flex-col gap-0.5 min-w-0">
            <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">
              Account Password
            </span>
            <span className="text-[15px] font-bold text-primary-dark">
              Update your administrator password
            </span>
          </div>
          <Link
            to="/change-password"
            className="bg-primary-dark hover:bg-primary text-white text-xs font-bold px-4 py-2.5 rounded-lg shadow transition-all active:scale-[0.98] no-underline shrink-0"
          >
            Change Password
          </Link>
        </div>
      </section>
    </div>
  );
}

/** Wraps a dropdown with the blue (i) tooltip badge on the right.
 *  Tooltip uses Tailwind `group-hover` so it works without JS state. */
function DropdownWithInfo({
  children,
  tooltip,
}: {
  children: React.ReactNode;
  tooltip: string;
}) {
  return (
    <div className="flex items-center gap-4">
      <div className="flex-1 min-w-0">{children}</div>
      <div className="relative group shrink-0">
        <div className="w-6 h-6 rounded-full bg-primary-dark flex items-center justify-center text-white text-xs font-serif font-bold italic cursor-pointer shadow-sm hover:scale-105 active:scale-95 transition-transform">
          i
        </div>
        <div className="absolute right-0 bottom-full mb-2 hidden group-hover:block w-64 bg-slate-900 text-white text-[11px] p-2.5 rounded-lg shadow-lg z-20 leading-relaxed font-medium normal-case font-sans">
          {tooltip}
        </div>
      </div>
    </div>
  );
}
