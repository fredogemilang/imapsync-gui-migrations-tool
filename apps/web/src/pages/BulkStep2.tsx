import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ChevronDown,
  ChevronRight,
  Info,
  Layers,
  Loader2,
  Play,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import { api } from '@/lib/api';
import { cn, formatBytes } from '@/lib/utils';
import { Switch } from '@/components/ui/Switch';
import {
  HeaderStepArrows,
  HeaderStepCounter,
  useFooter,
  useHeaderAction,
  useHeaderLeft,
  useSidebarIcon,
  useSidebarTitle,
} from '@/components/Layout';
import { useBulkWizard, type BulkPair } from '@/components/BulkWizardContext';

/**
 * Bulk Migration — Step 2 (Review & Settings).
 *
 * Mirrors `mockup/template/partials/bulk-migrations-step2-content.html`.
 *
 * Data sources:
 *   - Pair credentials + server config: BulkWizardContext (populated by
 *     Step 1 after successful validation).
 *   - Per-pair inspect data (folder count, email count, size, overlap):
 *     fetched lazily via `/api/imap/inspect` on the Refresh Data click,
 *     and (always) when the user opens the Folder Details modal.
 *
 * Submit flow:
 *   "Start Your Migration" → POST /api/bulk-migrations with the wizard
 *   payload → reset() the wizard store (no plaintext passwords left in
 *   sessionStorage) → navigate to /bulk/:id/progress.
 */

type Inspect = {
  folderCount: number;
  totalEmails: number;
  totalBytes: number;
  folders: { name: string; totalEmails: number; totalBytes: number }[];
  /** Pre-existing emails in the target — surfaced as an amber warning chip. */
  targetExisting?: number;
};

type PairInspect = Inspect | { error: string } | null;

export function BulkStep2() {
  const navigate = useNavigate();
  const wizard = useBulkWizard();
  const [scanned, setScanned] = useState<Record<string, PairInspect>>({});
  const [scanning, setScanning] = useState(false);
  const [search, setSearch] = useState('');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [detailsFor, setDetailsFor] = useState<BulkPair | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  // We need this flag to suppress the "Step 2 needs validated wizard"
  // route guard during the brief window between `wizard.reset()` and
  // `navigate('/bulk/:id/progress')` in startMigration. Without it,
  // wizard.reset() flips `validated` to false → the guard fires first
  // and bounces the user back to Step 1.
  const submittingRef = useRef(false);

  useHeaderLeft(<HeaderStepCounter current={2} total={3} />);
  useHeaderAction(<HeaderStepArrows prev="/bulk/new" />);
  useSidebarTitle('Step 02');
  useSidebarIcon(Layers);

  // Route guard — Step 2 requires Step 1's validated snapshot.
  useEffect(() => {
    if (submittingRef.current) return;
    if (!wizard.validated || wizard.pairs.length === 0) {
      navigate('/bulk/new', { replace: true });
    }
  }, [wizard.validated, wizard.pairs.length, navigate]);

  // Kick off an initial parallel scan on mount. Parallel with concurrency
  // 3 so we don't hammer the source/target servers and trigger rate limits.
  useEffect(() => {
    if (wizard.pairs.length === 0) return;
    void runScan(wizard.pairs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Scans every pair's source mailbox via inspectAccount, with a small
   *  concurrency limit. Target overlap = total emails in target inbox
   *  before sync, shown as the amber chip in the mockup. */
  const runScan = async (pairs: BulkPair[]) => {
    setScanning(true);
    const CONCURRENCY = 3;
    const queue = [...pairs];
    const next = (): Promise<void> => {
      const p = queue.shift();
      if (!p) return Promise.resolve();
      return scanOne(p).then(next);
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, () => next()));
    setScanning(false);
  };

  const scanOne = async (p: BulkPair): Promise<void> => {
    try {
      const r = await api.inspectAccount({
        host: wizard.source.host,
        port: wizard.source.port,
        security: wizard.source.security,
        username: p.sourceUser,
        password: p.sourcePass,
      });
      // Best-effort: count target's existing emails too. Failures here
      // are non-fatal — we still know the source side which is what the
      // user actually cares about for the Ready badge.
      let targetExisting = 0;
      try {
        const t = await api.inspectAccount({
          host: wizard.target.host,
          port: wizard.target.port,
          security: wizard.target.security,
          username: p.targetUser,
          password: p.targetPass,
        });
        targetExisting = t.totalEmails;
      } catch {
        // ignore
      }
      setScanned((s) => ({
        ...s,
        [p.id]: {
          folderCount: r.folderCount,
          totalEmails: r.totalEmails,
          totalBytes: r.totalBytes,
          folders: r.folders,
          targetExisting,
        },
      }));
    } catch (e: any) {
      setScanned((s) => ({ ...s, [p.id]: { error: e?.message ?? 'Scan failed' } }));
    }
  };

  // ----- Summary stats ----------------------------------------------------
  const summary = useMemo(() => {
    const mailboxes = wizard.pairs.length;
    let emails = 0;
    let bytes = 0;
    let folders = 0;
    let ready = 0;
    for (const p of wizard.pairs) {
      const s = scanned[p.id];
      if (s && !('error' in s)) {
        emails += s.totalEmails;
        bytes += s.totalBytes;
        folders += s.folderCount;
        ready++;
      }
    }
    return { mailboxes, emails, bytes, folders, ready };
  }, [wizard.pairs, scanned]);

  // ----- Filter -----------------------------------------------------------
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return wizard.pairs;
    return wizard.pairs.filter(
      (p) => p.sourceUser.toLowerCase().includes(q) || p.targetUser.toLowerCase().includes(q),
    );
  }, [wizard.pairs, search]);

  // ----- Start migration --------------------------------------------------
  const startMigration = async () => {
    setStartError(null);
    setStarting(true);
    // Lock the route guard before we touch the wizard store — the
    // wizard.reset() at the end would otherwise race with navigate() and
    // the guard would win, bouncing the user back to Step 1.
    submittingRef.current = true;
    try {
      const { id } = await api.createBulk({
        sourceHost: wizard.source.host,
        sourcePort: wizard.source.port,
        sourceSecurity: wizard.source.security,
        targetHost: wizard.target.host,
        targetPort: wizard.target.port,
        targetSecurity: wizard.target.security,
        settings: {
          autoSync: wizard.settings.autoSync,
          backupMode: wizard.settings.backupMode,
          backupInterval: wizard.settings.backupInterval,
          throttleEnabled: wizard.settings.throttleEnabled,
          throttleGbPerDay: wizard.settings.throttleGbPerDay,
          syncDuplicates: wizard.settings.syncDuplicates,
          enableCache: wizard.settings.enableCache,
          reduceBandwidth: wizard.settings.reduceBandwidth,
          dateFilterEnabled: wizard.settings.dateFilterEnabled,
          dateFrom: wizard.settings.dateFrom,
          dateTo: wizard.settings.dateTo,
          ignoreSslSource: wizard.source.ignoreSsl,
          ignoreSslTarget: wizard.target.ignoreSsl,
        },
        pairs: wizard.pairs.map((p) => ({
          sourceUsername: p.sourceUser,
          sourcePassword: p.sourcePass,
          targetUsername: p.targetUser,
          targetPassword: p.targetPass,
          sync: p.sync,
          backup: p.backup,
        })),
      });
      // Bulk migration is now owned by the backend; clear the wizard so the
      // plaintext passwords don't sit in sessionStorage any longer.
      wizard.reset();
      navigate(`/bulk/${id}/progress`);
    } catch (e: any) {
      // Re-enable the route guard so a subsequent navigation away (or
      // wizard idle expiry) still kicks the user back correctly.
      submittingRef.current = false;
      setStartError(e?.message ?? 'Failed to start bulk migration');
    } finally {
      setStarting(false);
    }
  };

  useFooter(
    <button
      onClick={startMigration}
      disabled={starting || wizard.pairs.length === 0}
      className="w-full max-w-4xl bg-primary-container hover:bg-primary-dark text-white rounded-lg py-3.5 flex items-center justify-center font-bold text-[15px] shadow-md hover:shadow-lg transition-all duration-200 group cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
    >
      <div className="w-full flex items-center px-4 relative">
        <span className="absolute left-4 bg-white/25 rounded-full p-1 flex items-center justify-center group-hover:scale-105 transition-transform">
          <Play className="h-4 w-4 text-white fill-white" />
        </span>
        <span className="flex-1 text-center font-bold">
          {starting ? 'Starting…' : 'Start Your Migration'}
        </span>
      </div>
    </button>,
    [starting, wizard.pairs.length, wizard.settings, wizard.source, wizard.target],
  );

  if (!wizard.validated || wizard.pairs.length === 0) return null;

  return (
    <div className="max-w-5xl mx-auto space-y-8">
      <div className="flex items-center justify-between">
        <h3 className="text-primary-dark font-extrabold text-lg">Your Bulk Migration</h3>
        <button
          onClick={() => void runScan(wizard.pairs)}
          disabled={scanning}
          className="flex items-center gap-1.5 text-primary-dark hover:text-blue-700 font-semibold text-xs transition-colors disabled:opacity-50"
        >
          <RefreshCw className={cn('h-4 w-4', scanning && 'animate-spin')} strokeWidth={2.5} />
          {scanning ? 'Scanning…' : 'Refresh Data'}
        </button>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <SummaryCard label="Total Mailboxes" value={summary.mailboxes.toLocaleString()} />
        <SummaryCard label="Total Size" value={formatBytes(summary.bytes)} />
        <SummaryCard label="Total Emails" value={summary.emails.toLocaleString()} />
        <SummaryCard label="Total Folders" value={summary.folders.toLocaleString()} />
        <div className="col-span-2 md:col-span-1 bg-emerald-50 border border-emerald-200/60 rounded-xl p-4 shadow-sm flex flex-col justify-center">
          <span className="text-[10px] uppercase font-bold text-emerald-600 tracking-wider">
            Overall Status
          </span>
          <span className="text-sm font-extrabold text-emerald-700 mt-1 flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse" />
            {scanning ? 'Scanning…' : 'Ready to Sync'}
          </span>
        </div>
      </div>

      {/* Pairs list */}
      <div className="border border-slate-200/80 rounded-xl bg-white shadow-sm overflow-hidden flex flex-col">
        <div className="px-5 py-4 border-b border-slate-100 flex flex-col md:flex-row md:items-center justify-between gap-3 bg-slate-50/50">
          <div className="flex items-center space-x-2">
            <span className="font-extrabold text-primary-dark text-sm">Migration Pairs List</span>
            <span className="bg-slate-200 text-slate-600 text-[11px] font-bold px-2 py-0.5 rounded-full">
              {summary.ready}/{summary.mailboxes} Scanned
            </span>
          </div>
          <div className="relative">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search mailboxes…"
              className="w-full md:w-56 bg-white border border-slate-200 rounded-lg text-xs py-1.5 pl-8 pr-3 outline-none focus:border-primary/50 text-primary font-bold"
            />
            <Search className="h-4 w-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
          </div>
        </div>

        <div className="overflow-x-auto max-h-[420px] overflow-y-auto">
          <table className="w-full text-left border-collapse min-w-[700px]">
            <thead>
              <tr className="bg-slate-50/20 border-b border-slate-100 text-slate-400 font-extrabold text-[10px] uppercase tracking-wider">
                <th className="py-2.5 px-4 w-[5%] text-center">#</th>
                <th className="py-2.5 px-4 w-[35%]">Source Mailbox</th>
                <th className="py-2.5 px-2 w-[5%] text-center" />
                <th className="py-2.5 px-4 w-[35%]">Target Mailbox</th>
                <th className="py-2.5 px-4 w-[15%]">Status / Overlap</th>
                <th className="py-2.5 px-4 w-[5%] text-center">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50 text-[13px]">
              {filtered.map((p, idx) => (
                <PairRow
                  key={p.id}
                  index={idx + 1}
                  pair={p}
                  inspect={scanned[p.id] ?? null}
                  onDetails={() => setDetailsFor(p)}
                />
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td
                    colSpan={6}
                    className="py-8 text-center text-slate-400 italic font-medium text-sm"
                  >
                    No mailboxes match &ldquo;{search}&rdquo;
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Settings panel */}
      <SettingsSection
        settings={wizard.settings}
        onChange={wizard.setSettings}
        advancedOpen={advancedOpen}
        setAdvancedOpen={setAdvancedOpen}
      />

      {/* Filter panel */}
      <FilterSection settings={wizard.settings} onChange={wizard.setSettings} />

      {startError && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-red-700 text-sm font-semibold">
          {startError}
        </div>
      )}

      {detailsFor && (
        <DetailsModal
          pair={detailsFor}
          inspect={scanned[detailsFor.id] ?? null}
          onClose={() => setDetailsFor(null)}
        />
      )}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Sub-components
// -----------------------------------------------------------------------------

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white border border-slate-200/85 rounded-xl p-4 shadow-sm flex flex-col justify-center">
      <span className="text-[10px] uppercase font-bold text-slate-400 tracking-wider">{label}</span>
      <span className="text-xl font-extrabold text-primary-dark mt-1">{value}</span>
    </div>
  );
}

function PairRow({
  index,
  pair,
  inspect,
  onDetails,
}: {
  index: number;
  pair: BulkPair;
  inspect: PairInspect;
  onDetails: () => void;
}) {
  const hasInspect = inspect && !('error' in inspect);
  const error = inspect && 'error' in inspect ? inspect.error : null;
  const subText = hasInspect
    ? `${inspect.totalEmails.toLocaleString()} emails • ${formatBytes(inspect.totalBytes)} • ${inspect.folderCount} folders`
    : error
      ? error
      : 'Scanning…';

  return (
    <tr className="hover:bg-slate-50/65 transition-colors font-medium text-slate-700">
      <td className="py-2.5 px-4 text-center font-bold text-slate-400">{index}</td>
      <td className="py-2.5 px-4">
        <span className="block font-bold text-primary text-[13.5px] truncate">
          {pair.sourceUser}
        </span>
        <span className={cn('text-[11px] truncate', error ? 'text-red-500' : 'text-slate-400')}>
          {subText}
        </span>
      </td>
      <td className="py-2.5 px-2 text-center text-slate-400">
        <ChevronRight className="h-4 w-4 mx-auto" strokeWidth={2} />
      </td>
      <td className="py-2.5 px-4 font-bold text-primary-dark truncate">{pair.targetUser}</td>
      <td className="py-2.5 px-4">
        <div className="flex flex-col gap-0.5">
          {error ? (
            <span className="text-red-600 font-bold text-[11px] flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-red-500" /> Error
            </span>
          ) : (
            <span className="text-emerald-600 font-bold text-[11px] flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" /> Ready
            </span>
          )}
          {hasInspect &&
            (inspect.targetExisting && inspect.targetExisting > 0 ? (
              <span className="text-[10px] text-amber-600 font-semibold bg-amber-50 rounded px-1.5 py-0.5 w-max">
                {inspect.targetExisting} existing{' '}
                {inspect.targetExisting === 1 ? 'email' : 'emails'}
              </span>
            ) : (
              <span className="text-[10px] text-slate-400 font-medium">Empty target mailbox</span>
            ))}
        </div>
      </td>
      <td className="py-2.5 px-4 text-center">
        <button
          onClick={onDetails}
          disabled={!hasInspect}
          className="bg-slate-100 hover:bg-slate-200 text-slate-500 font-bold text-[10px] px-2.5 py-1 rounded-full transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Folder Details
        </button>
      </td>
    </tr>
  );
}

function SettingsSection({
  settings,
  onChange,
  advancedOpen,
  setAdvancedOpen,
}: {
  settings: ReturnType<typeof useBulkWizard.getState>['settings'];
  onChange: (p: Partial<ReturnType<typeof useBulkWizard.getState>['settings']>) => void;
  advancedOpen: boolean;
  setAdvancedOpen: (v: boolean) => void;
}) {
  return (
    <div className="space-y-4">
      <h3 className="text-primary-dark font-extrabold text-lg">Settings</h3>
      <div className="border border-slate-200/80 rounded-xl bg-white shadow-sm">
        <ToggleRow
          label="Auto Sync"
          description="Synchronize Emails for 10 Days"
          tooltip="Automatically synchronize your emails periodically after the initial migration is complete."
          checked={settings.autoSync}
          onChange={(v) => onChange({ autoSync: v })}
          rounded="t"
        />
        <ToggleRow
          label="Backup Mode"
          description="Permanently Sync Emails to Target Mailbox"
          tooltip="Keeps target mailbox in sync with source mailbox. Deletions in source won't delete in target."
          checked={settings.backupMode}
          onChange={(v) => onChange({ backupMode: v })}
          right={
            <select
              disabled={!settings.backupMode}
              value={settings.backupInterval}
              onChange={(e) =>
                onChange({ backupInterval: e.target.value as typeof settings.backupInterval })
              }
              title="How often to back up after the initial bulk migration"
              className="bg-white border border-slate-200/80 rounded-lg text-primary text-[14px] py-2 px-3 disabled:opacity-50"
            >
              <option value="daily">Every day</option>
              <option value="weekly">Every week</option>
              <option value="monthly">Every month</option>
            </select>
          }
        />
        <div className="rounded-b-xl">
          <button
            onClick={() => setAdvancedOpen(!advancedOpen)}
            className="w-full flex items-center justify-between bg-primary/5 px-6 py-5 cursor-pointer rounded-b-xl border-t border-slate-200/60 hover:bg-primary/10 transition-colors"
          >
            <h3 className="font-bold text-primary text-[15px]">Advanced Settings</h3>
            <div className="bg-white rounded-full p-1 shadow-sm border border-slate-100">
              <ChevronDown
                className={cn(
                  'h-5 w-5 text-primary transition-transform duration-300',
                  advancedOpen && 'rotate-180',
                )}
                strokeWidth={2.5}
              />
            </div>
          </button>
          {advancedOpen && (
            <div className="p-6 md:p-8 space-y-6 bg-white/50 rounded-b-xl border-t border-slate-200/60">
              <AdvancedRow
                label="Throttling"
                description="Upload / Download Limit per Day"
                tooltip="Limit daily upload and download bandwidth to prevent high load on mail servers."
                checked={settings.throttleEnabled}
                onChange={(v) => onChange({ throttleEnabled: v })}
                right={
                  <select
                    disabled={!settings.throttleEnabled}
                    value={settings.throttleGbPerDay}
                    onChange={(e) => onChange({ throttleGbPerDay: Number(e.target.value) })}
                    className="bg-white border border-slate-200/80 rounded-lg text-primary text-[14px] py-2 px-3 disabled:opacity-50"
                  >
                    <option value={1}>Limit 1 GB/day</option>
                    <option value={2}>Limit 2 GB/day</option>
                    <option value={5}>Limit 5 GB/day</option>
                    <option value={10}>Limit 10 GB/day</option>
                  </select>
                }
              />
              <AdvancedRow
                label="Sync Duplicates"
                description="Sync Duplicates from the Existing Address"
                tooltip="Check and copy duplicate emails if found in the destination folder."
                checked={settings.syncDuplicates}
                onChange={(v) => onChange({ syncDuplicates: v })}
              />
              <AdvancedRow
                label="Enable Cache"
                description="Enable Cache for Large Mailboxes & Slow Mail Servers"
                tooltip="Speeds up the migration of huge mailboxes by caching the list of messages locally."
                checked={settings.enableCache}
                onChange={(v) => onChange({ enableCache: v })}
              />
              <AdvancedRow
                label="Reduce Bandwidth"
                description="Reduce Bandwidth Consumption Between Servers"
                tooltip="Reduce bandwidth consumption between source and destination mail servers."
                checked={settings.reduceBandwidth}
                onChange={(v) => onChange({ reduceBandwidth: v })}
                noBorder
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function FilterSection({
  settings,
  onChange,
}: {
  settings: ReturnType<typeof useBulkWizard.getState>['settings'];
  onChange: (p: Partial<ReturnType<typeof useBulkWizard.getState>['settings']>) => void;
}) {
  return (
    <div className="space-y-4">
      <h3 className="text-primary-dark font-extrabold text-lg">Filter</h3>
      <div className="border border-slate-200/80 rounded-xl bg-white shadow-sm">
        <ToggleRow
          label="Date Filter"
          description="Migrate Emails Within a Certain Date Range"
          tooltip="Filter emails to migrate based on when they were received (e.g. only migrate emails from the last year)."
          checked={settings.dateFilterEnabled}
          onChange={(v) => onChange({ dateFilterEnabled: v })}
          rounded={settings.dateFilterEnabled ? 't' : 'all'}
        />
        {settings.dateFilterEnabled && (
          <div className="px-5 pb-5 pt-2 border-t border-slate-100/60 bg-slate-50/30 rounded-b-xl">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="bg-white border border-slate-200/80 rounded-xl p-3 shadow-sm">
                <label className="block text-primary-dark font-bold text-[11px] mb-0.5">
                  Start Date
                </label>
                <input
                  type="date"
                  value={settings.dateFrom}
                  onChange={(e) => onChange({ dateFrom: e.target.value })}
                  className="w-full bg-transparent text-primary text-[13px] font-semibold outline-none"
                />
              </div>
              <div className="bg-white border border-slate-200/80 rounded-xl p-3 shadow-sm">
                <label className="block text-primary-dark font-bold text-[11px] mb-0.5">
                  End Date
                </label>
                <input
                  type="date"
                  value={settings.dateTo}
                  onChange={(e) => onChange({ dateTo: e.target.value })}
                  className="w-full bg-transparent text-primary text-[13px] font-semibold outline-none"
                />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ToggleRow({
  label,
  description,
  tooltip,
  checked,
  onChange,
  rounded,
  right,
}: {
  label: string;
  description: string;
  tooltip: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  rounded?: 't' | 'b' | 'all';
  /** Optional secondary control rendered on the right (e.g. interval picker). */
  right?: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        'flex items-center justify-between px-5 py-4 border-b border-slate-100 hover:bg-slate-50/30 transition-colors gap-3',
        rounded === 't' && 'rounded-t-xl',
        rounded === 'b' && 'rounded-b-xl',
        rounded === 'all' && 'rounded-xl border-b-0',
      )}
    >
      <div className="flex items-center space-x-6 flex-1 min-w-0">
        <span className="font-extrabold text-primary text-[14px] w-28 shrink-0">{label}:</span>
        <Switch checked={checked} onCheckedChange={onChange} />
        <span
          className={cn(
            'font-semibold text-[13px] transition-colors',
            checked ? 'text-primary font-bold' : 'text-slate-400',
          )}
        >
          {description}
        </span>
      </div>
      <div className="flex items-center gap-3 shrink-0">
        {right}
        <div className="group relative cursor-pointer">
          <div className="bg-slate-100 hover:bg-slate-200 text-slate-400 hover:text-slate-600 rounded-full p-1 transition-colors">
            <Info className="h-4 w-4" strokeWidth={2.5} />
          </div>
          <div className="absolute right-0 bottom-full mb-2 hidden group-hover:block w-64 bg-slate-900 text-white text-[11px] p-2.5 rounded-lg shadow-lg z-20 leading-relaxed font-medium">
            {tooltip}
          </div>
        </div>
      </div>
    </div>
  );
}

function AdvancedRow({
  label,
  description,
  tooltip,
  checked,
  onChange,
  right,
  noBorder,
}: {
  label: string;
  description: string;
  tooltip: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  right?: React.ReactNode;
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
        <Switch checked={checked} onCheckedChange={onChange} />
        <span
          className={cn(
            'font-semibold text-[15px] hidden md:block ml-4 transition-colors',
            checked ? 'text-primary font-bold' : 'text-slate-400',
          )}
        >
          {description}
        </span>
      </div>
      <div className="flex items-center gap-4 justify-between md:justify-end">
        <span
          className={cn(
            'font-semibold text-[15px] block md:hidden transition-colors',
            checked ? 'text-primary font-bold' : 'text-slate-400',
          )}
        >
          {description}
        </span>
        {right}
        <div className="group relative cursor-pointer w-6 h-6 rounded-full bg-slate-100 border border-slate-200/60 flex items-center justify-center text-slate-500 shrink-0">
          <span className="text-xs font-bold font-serif italic">i</span>
          <div className="absolute right-0 bottom-full mb-2 hidden group-hover:block w-64 bg-slate-900 text-white text-[11px] p-2.5 rounded-lg shadow-lg z-20 leading-relaxed font-medium normal-case font-sans">
            {tooltip}
          </div>
        </div>
      </div>
    </div>
  );
}

function DetailsModal({
  pair,
  inspect,
  onClose,
}: {
  pair: BulkPair;
  inspect: PairInspect;
  onClose: () => void;
}) {
  const folders = inspect && !('error' in inspect) ? inspect.folders : [];
  // Escape closes
  const escRef = useRef(onClose);
  escRef.current = onClose;
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && escRef.current();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 md:p-6">
      <div onClick={onClose} className="absolute inset-0 bg-slate-900/50 backdrop-blur-md" />
      <div className="relative w-full max-w-2xl bg-white rounded-2xl shadow-2xl flex flex-col overflow-hidden z-10 max-h-[85vh]">
        <button
          onClick={onClose}
          aria-label="Close"
          className="absolute top-5 right-5 text-slate-400 hover:text-slate-600 transition-colors p-1.5 rounded-full hover:bg-slate-100"
        >
          <X className="h-5 w-5" />
        </button>

        <div className="p-6 md:p-8 overflow-y-auto space-y-6">
          <h2 className="text-xl md:text-2xl font-bold text-primary-dark pr-8">
            Scanned Folders &amp; Emails
          </h2>
          <div className="bg-primary/5 border border-primary/10 rounded-xl p-4 md:p-5">
            <p className="text-primary-dark font-bold text-sm mb-1">
              The folders listed below were detected in{' '}
              <span className="font-extrabold italic text-blue-600">{pair.sourceUser}</span>.
            </p>
            <p className="text-primary/70 text-xs md:text-sm leading-relaxed">
              Summary of all emails and structures found in the mailbox, ready to be migrated to
              the destination server.
            </p>
          </div>
          <div className="overflow-x-auto border border-slate-100 rounded-xl">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-primary-dark">
                  <th className="py-3 px-4 text-left font-bold">Folder</th>
                  <th className="py-3 px-4 text-right font-bold w-32">Total Emails</th>
                  <th className="py-3 px-4 text-right font-bold w-32">Size</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-primary">
                {folders.length === 0 && (
                  <tr>
                    <td colSpan={3} className="py-8 px-4 text-center text-slate-400 italic">
                      <Loader2 className="h-4 w-4 inline animate-spin mr-2" />
                      Scanning…
                    </td>
                  </tr>
                )}
                {folders.map((f) => {
                  const empty = f.totalEmails === 0;
                  return (
                    <tr key={f.name} className={cn('hover:bg-slate-50/50', empty && 'text-slate-400 italic')}>
                      <td className="py-3 px-4 font-semibold">{f.name}</td>
                      <td className="py-3 px-4 text-right">{f.totalEmails.toLocaleString()}</td>
                      <td className="py-3 px-4 text-right">
                        {f.totalBytes > 0 ? formatBytes(f.totalBytes) : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        <button
          onClick={onClose}
          className="w-full bg-primary hover:bg-primary-dark py-4 font-bold text-base text-white transition-colors"
        >
          OK
        </button>
      </div>
    </div>
  );
}
