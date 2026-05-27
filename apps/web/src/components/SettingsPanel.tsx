import { Switch } from '@/components/ui/Switch';
import { useState } from 'react';
import { ChevronDown, Info } from 'lucide-react';
import { cn } from '@/lib/utils';

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

export function SettingsPanel({
  value,
  onChange,
}: {
  value: Settings;
  onChange: (p: Partial<Settings>) => void;
}) {
  const [advancedOpen, setAdvancedOpen] = useState(false);

  return (
    <div className="space-y-4">
      <h3 className="text-primary-dark font-extrabold text-lg">Settings</h3>
      <div className="border border-slate-200/80 rounded-xl bg-white shadow-sm">
        <Row
          label="Auto Sync"
          checked={value.autoSync}
          onCheckedChange={(v) => onChange({ autoSync: v })}
          description="Synchronize Emails for 10 Days"
          tooltip="Automatically synchronize your emails periodically after the initial migration is complete."
        />
        <Row
          label="Backup Mode"
          checked={value.backupMode}
          onCheckedChange={(v) => onChange({ backupMode: v })}
          description="Permanently Sync Emails to Target Mailbox"
          tooltip="Keeps target mailbox in sync with source mailbox. Deletions in source won't delete in target."
          right={
            <select
              disabled={!value.backupMode}
              value={value.backupInterval}
              onChange={(e) =>
                onChange({ backupInterval: e.target.value as Settings['backupInterval'] })
              }
              className="bg-white border border-slate-200/80 rounded-lg text-primary text-[14px] py-2 px-3 disabled:opacity-50"
              title="How often to back up after the initial migration"
            >
              <option value="daily">Every day</option>
              <option value="weekly">Every week</option>
              <option value="monthly">Every month</option>
            </select>
          }
        />
        <div className="rounded-b-xl">
          <button
            onClick={() => setAdvancedOpen((v) => !v)}
            className="w-full flex items-center justify-between bg-primary/5 px-6 py-5 hover:bg-primary/10 border-t border-slate-200/60 rounded-b-xl"
          >
            <h3 className="font-bold text-primary text-[15px]">Advanced Settings</h3>
            <ChevronDown
              className={cn(
                'h-5 w-5 text-primary transition-transform',
                advancedOpen && 'rotate-180',
              )}
            />
          </button>
          {advancedOpen && (
            <div className="p-6 space-y-6 bg-white/50 border-t border-slate-200/60">
              <Row
                label="Throttling"
                checked={value.throttleEnabled}
                onCheckedChange={(v) => onChange({ throttleEnabled: v })}
                description="Upload / Download Limit per Day"
                tooltip="Limit daily bandwidth usage."
                right={
                  <select
                    disabled={!value.throttleEnabled}
                    value={value.throttleGbPerDay}
                    onChange={(e) => onChange({ throttleGbPerDay: Number(e.target.value) })}
                    className={cn(
                      'bg-white border border-slate-200/80 rounded-lg text-primary text-[14px] py-2 px-3 disabled:opacity-50',
                    )}
                  >
                    <option value={1}>Limit 1 GB/day</option>
                    <option value={2}>Limit 2 GB/day</option>
                    <option value={5}>Limit 5 GB/day</option>
                    <option value={10}>Limit 10 GB/day</option>
                  </select>
                }
              />
              <Row
                label="Sync Duplicates"
                checked={value.syncDuplicates}
                onCheckedChange={(v) => onChange({ syncDuplicates: v })}
                description="Sync Duplicates from the Existing Address"
                tooltip="Copy duplicates if found in destination folder."
              />
              <Row
                label="Enable Cache"
                checked={value.enableCache}
                onCheckedChange={(v) => onChange({ enableCache: v })}
                description="Enable Cache for Large Mailboxes & Slow Mail Servers"
                tooltip="Speeds up the migration of huge mailboxes."
              />
              <Row
                label="Reduce Bandwidth"
                checked={value.reduceBandwidth}
                onCheckedChange={(v) => onChange({ reduceBandwidth: v })}
                description="Reduce Bandwidth Consumption Between Servers"
                tooltip="Reduce bandwidth between source and destination."
              />
            </div>
          )}
        </div>
      </div>

      <h3 className="text-primary-dark font-extrabold text-lg pt-2">Filter</h3>
      <div className="border border-slate-200/80 rounded-xl bg-white shadow-sm">
        <Row
          label="Date Filter"
          checked={value.dateFilterEnabled}
          onCheckedChange={(v) => onChange({ dateFilterEnabled: v })}
          description="Migrate Emails Within a Certain Date Range"
          tooltip="Filter by received date."
        />
        {value.dateFilterEnabled && (
          <div className="px-5 pb-5 pt-2 border-t border-slate-100 grid grid-cols-2 gap-4 bg-slate-50/30 rounded-b-xl">
            <div className="bg-white border border-slate-200/80 rounded-xl p-3">
              <label className="block text-primary font-bold text-[11px] mb-0.5">Start Date</label>
              <input
                type="date"
                value={value.dateFrom}
                onChange={(e) => onChange({ dateFrom: e.target.value })}
                className="w-full bg-transparent text-primary text-[13px] outline-none"
              />
            </div>
            <div className="bg-white border border-slate-200/80 rounded-xl p-3">
              <label className="block text-primary font-bold text-[11px] mb-0.5">End Date</label>
              <input
                type="date"
                value={value.dateTo}
                onChange={(e) => onChange({ dateTo: e.target.value })}
                className="w-full bg-transparent text-primary text-[13px] outline-none"
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Row({
  label,
  description,
  tooltip,
  checked,
  onCheckedChange,
  right,
}: {
  label: string;
  description: string;
  tooltip: string;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  right?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 last:border-0 hover:bg-slate-50/30">
      <div className="flex items-center gap-6 flex-1">
        <span className="font-extrabold text-primary text-[14px] w-28 shrink-0">{label}:</span>
        <Switch checked={checked} onCheckedChange={onCheckedChange} />
        <span
          className={cn(
            'font-semibold text-[13px]',
            checked ? 'text-primary font-bold' : 'text-slate-400',
          )}
        >
          {description}
        </span>
      </div>
      <div className="flex items-center gap-3">
        {right}
        <div className="group relative">
          <Info className="h-4 w-4 text-slate-400 cursor-help" />
          <div className="hidden group-hover:block absolute right-0 bottom-full mb-2 w-64 bg-slate-900 text-white text-[11px] p-2.5 rounded-lg shadow-lg z-20">
            {tooltip}
          </div>
        </div>
      </div>
    </div>
  );
}
