import { useEffect, useState, type ReactNode } from 'react';
import { ChevronDown, RefreshCw } from 'lucide-react';
import { Switch } from '@/components/ui/Switch';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * Post-migration sync options panel. Used by:
 *   - `YourMigration` page (full migration detail view)
 *   - `MigrationStep3` page when status === 'completed' (inline celebration UI)
 *
 * Encapsulates the segmented control (Auto Sync / Backup Mode), the
 * sync-enabled toggle, the backup interval picker, Sync Now button, and
 * the read-only "Advanced Settings" accordion that mirrors what the user
 * picked back in Step 2.
 *
 * Wiring:
 *   - `data` is the migration row (must include syncMode, syncIntervalMs,
 *     syncRunning, settings). Pass the same shape returned by
 *     GET /api/migrations/:id.
 *   - `onRefresh` is invoked after each mutation so the parent can reload
 *     the row and propagate fresh server-truth back into `data`.
 */

/** Map a sync interval (ms) to one of the three labelled cadences. Used to
 *  hydrate the dropdown when the page first loads from data.syncIntervalMs. */
function intervalFromMs(ms: number | null | undefined): 'daily' | 'weekly' | 'monthly' {
  const DAY = 24 * 60 * 60 * 1000;
  if (!ms) return 'daily';
  if (ms >= 28 * DAY) return 'monthly';
  if (ms >= 6 * DAY) return 'weekly';
  return 'daily';
}

export function MigrationOptionsCard({
  data,
  id,
  busy,
  setBusy,
  onRefresh,
}: {
  data: any;
  id: string;
  busy: boolean;
  setBusy: (v: boolean) => void;
  onRefresh: () => Promise<void>;
}) {
  const syncEnabled = data.syncMode === 'auto' || data.syncMode === 'backup';
  const currentMode: 'auto' | 'backup' = data.syncMode === 'backup' ? 'backup' : 'auto';
  // Defaults to whatever the migration was created with (settings.backupInterval),
  // otherwise the row's current syncIntervalMs, otherwise 'daily'.
  const initialInterval: 'daily' | 'weekly' | 'monthly' =
    data.settings?.backupInterval ?? intervalFromMs(data.syncIntervalMs);

  const [selectedMode, setSelectedMode] = useState<'auto' | 'backup'>(currentMode);
  const [selectedInterval, setSelectedInterval] = useState<'daily' | 'weekly' | 'monthly'>(
    initialInterval,
  );
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // Keep local segmented-control state in sync with server-truth when `data`
  // refreshes (e.g. after sync now / enable / disable, or polling tick).
  // Without this, toggling in another tab would leave this view stale.
  useEffect(() => {
    setSelectedMode(currentMode);
    setSelectedInterval(initialInterval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.syncMode, data.syncIntervalMs]);

  // Settings from the migration's stored settings
  const settings = (data.settings as any) ?? {};

  const toggleSync = async () => {
    setBusy(true);
    try {
      if (syncEnabled) {
        await api.disableSync(id);
      } else {
        await api.enableSync(
          id,
          selectedMode,
          selectedMode === 'backup' ? selectedInterval : undefined,
        );
      }
      await onRefresh();
    } finally {
      setBusy(false);
    }
  };

  const onSyncNow = async () => {
    setBusy(true);
    try {
      await api.syncNow(id);
      await onRefresh();
    } finally {
      setBusy(false);
    }
  };

  const onModeChange = async (mode: 'auto' | 'backup') => {
    setSelectedMode(mode);
    if (syncEnabled) {
      // If sync is already enabled, switch mode immediately
      setBusy(true);
      try {
        await api.enableSync(id, mode, mode === 'backup' ? selectedInterval : undefined);
        await onRefresh();
      } finally {
        setBusy(false);
      }
    }
  };

  const onIntervalChange = async (interval: 'daily' | 'weekly' | 'monthly') => {
    setSelectedInterval(interval);
    // Only re-arm the scheduler when backup mode is currently active.
    // Otherwise we're just updating the picker preview.
    if (syncEnabled && selectedMode === 'backup') {
      setBusy(true);
      try {
        await api.enableSync(id, 'backup', interval);
        await onRefresh();
      } finally {
        setBusy(false);
      }
    }
  };

  return (
    <div className="space-y-4">
      <h3 className="text-primary-dark font-extrabold text-lg">Options:</h3>

      <div className="border border-slate-200/80 rounded-xl bg-white shadow-sm overflow-hidden">
        <div className="p-6 md:p-8 space-y-6">
          {/* Segmented Control */}
          <div className="flex bg-slate-100/80 p-1 rounded-xl border border-slate-200/50">
            <button
              onClick={() => onModeChange('auto')}
              className={cn(
                'flex-1 py-2.5 text-sm font-semibold rounded-lg transition-all',
                selectedMode === 'auto'
                  ? 'bg-white shadow-sm text-primary font-bold border border-slate-100'
                  : 'text-slate-500 hover:text-primary',
              )}
            >
              Auto Sync
            </button>
            <button
              onClick={() => onModeChange('backup')}
              className={cn(
                'flex-1 py-2.5 text-sm font-semibold rounded-lg transition-all',
                selectedMode === 'backup'
                  ? 'bg-white shadow-sm text-primary font-bold border border-slate-100'
                  : 'text-slate-500 hover:text-primary',
              )}
            >
              Backup Mode
            </button>
          </div>

          {/* Toggle Row */}
          <div
            className={cn(
              'flex items-center justify-between pb-6',
              selectedMode === 'backup' ? '' : 'border-b border-slate-100',
            )}
          >
            <div className="flex items-center gap-4">
              <Switch checked={syncEnabled} onCheckedChange={toggleSync} disabled={busy} />
              <span className="text-primary font-medium text-[15px]">
                {selectedMode === 'auto'
                  ? 'Automatically synchronize emails for 10 days'
                  : 'Permanently Sync Emails to Target Mailbox'}
              </span>
            </div>
            <div className="group relative">
              <div className="w-6 h-6 rounded-full bg-slate-100 border border-slate-200/60 flex items-center justify-center text-slate-500 shrink-0 cursor-help">
                <span className="text-xs font-bold font-serif italic">i</span>
              </div>
              <div className="hidden group-hover:block absolute right-0 bottom-full mb-2 w-64 bg-slate-900 text-white text-[11px] p-2.5 rounded-lg shadow-lg z-20 leading-relaxed font-medium">
                {selectedMode === 'auto'
                  ? 'Automatically synchronize your emails every 3 hours for 10 days after migration.'
                  : "Permanently keep your target mailbox in sync. Deletions in source won't affect target."}
              </div>
            </div>
          </div>

          {/* Backup interval picker — only relevant when Backup Mode is selected.
              Auto Sync has a fixed 3-hour cadence so we hide the dropdown there. */}
          {selectedMode === 'backup' && (
            <div className="flex items-center justify-between border-b border-slate-100 pb-6 -mt-2">
              <span className="text-primary font-medium text-[14px]">Backup interval</span>
              <select
                value={selectedInterval}
                disabled={busy}
                onChange={(e) =>
                  onIntervalChange(e.target.value as 'daily' | 'weekly' | 'monthly')
                }
                className="bg-white border border-slate-200/80 rounded-lg text-primary text-[14px] py-2 px-3 disabled:opacity-50"
              >
                <option value="daily">Every day</option>
                <option value="weekly">Every week</option>
                <option value="monthly">Every month</option>
              </select>
            </div>
          )}

          {/* Sync Now Button */}
          <button
            onClick={onSyncNow}
            disabled={busy || data.syncRunning}
            className="w-full bg-primary-container hover:bg-primary-dark text-white rounded-xl py-3.5 flex items-center justify-center font-bold text-[15px] shadow-sm cursor-pointer transition-colors duration-200 disabled:opacity-60 disabled:cursor-not-allowed"
          >
            <RefreshCw className={cn('h-5 w-5 mr-2', data.syncRunning && 'animate-spin')} />
            {data.syncRunning ? 'Syncing…' : 'Sync Now'}
          </button>
        </div>

        {/* Advanced Settings Accordion */}
        <button
          onClick={() => setAdvancedOpen((v) => !v)}
          className="w-full text-left bg-primary/5 px-6 py-5 border-t border-b border-slate-200/60 flex items-center justify-between hover:bg-primary/10 transition-colors"
        >
          <h3 className="font-bold text-primary text-[15px]">Advanced Settings</h3>
          <div className="bg-white rounded-full p-1 shadow-sm border border-slate-100">
            <ChevronDown
              className={cn(
                'h-5 w-5 text-primary transition-transform duration-300',
                advancedOpen && 'rotate-180',
              )}
            />
          </div>
        </button>

        {advancedOpen && (
          <div className="p-6 md:p-8 space-y-6 bg-white/50">
            <AdvancedRow
              label="Throttling"
              checked={settings.throttleEnabled ?? false}
              description="Upload / Download Limit per Day"
              tooltip="Limit daily upload and download bandwidth to prevent high load on mail servers."
              right={
                <div className="relative w-full md:w-48">
                  <select
                    disabled={!settings.throttleEnabled}
                    value={settings.throttleGbPerDay ?? 1}
                    onChange={() => {
                      /* read-only — settings reflect the migration's stored config */
                    }}
                    className="w-full bg-white border border-slate-200/80 rounded-lg text-primary text-[15px] py-2 pl-4 pr-10 disabled:opacity-50"
                  >
                    <option value={1}>Limit 1 GB/day</option>
                    <option value={2}>Limit 2 GB/day</option>
                    <option value={5}>Limit 5 GB/day</option>
                    <option value={10}>Limit 10 GB/day</option>
                  </select>
                </div>
              }
            />
            <AdvancedRow
              label="Sync Duplicates"
              checked={settings.syncDuplicates ?? false}
              description="Sync Duplicates from the Existing Address"
              tooltip="Check and copy duplicate emails if found in the destination folder."
            />
            <AdvancedRow
              label="Enable Cache"
              checked={settings.enableCache ?? false}
              description="Enable Cache for Large Mailboxes & Slow Mail Servers"
              tooltip="Speeds up the migration of huge mailboxes by caching the list of messages locally."
            />
            <AdvancedRow
              label="Reduce Bandwidth"
              checked={settings.reduceBandwidth ?? false}
              description="Reduce Bandwidth Consumption Between Servers"
              tooltip="Reduce bandwidth consumption between source and destination mail servers."
              noBorder
            />
          </div>
        )}
      </div>
    </div>
  );
}

function AdvancedRow({
  label,
  checked,
  description,
  tooltip,
  right,
  noBorder,
}: {
  label: string;
  checked: boolean;
  description: string;
  tooltip: string;
  right?: ReactNode;
  noBorder?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex flex-col md:flex-row md:items-center justify-between gap-4',
        !noBorder && 'border-b border-slate-100 pb-6',
      )}
    >
      <div className="flex items-center gap-4">
        <span className="text-primary font-bold text-[15px] w-32 shrink-0">{label}:</span>
        <Switch checked={checked} disabled />
        <span
          className={cn(
            'font-medium text-[15px] hidden md:block ml-4',
            checked ? 'text-primary' : 'text-slate-400',
          )}
        >
          {description}
        </span>
      </div>
      <div className="flex items-center gap-4 justify-between md:justify-end">
        <span
          className={cn(
            'font-medium text-[15px] block md:hidden',
            checked ? 'text-primary' : 'text-slate-400',
          )}
        >
          {description}
        </span>
        {right}
        <div className="group relative cursor-pointer">
          <div className="w-6 h-6 rounded-full bg-slate-100 border border-slate-200/60 flex items-center justify-center text-slate-500 shrink-0">
            <span className="text-xs font-bold font-serif italic">i</span>
          </div>
          <div className="hidden group-hover:block absolute right-0 bottom-full mb-2 w-64 bg-slate-900 text-white text-[11px] p-2.5 rounded-lg shadow-lg z-20 leading-relaxed font-medium normal-case font-sans">
            {tooltip}
          </div>
        </div>
      </div>
    </div>
  );
}
