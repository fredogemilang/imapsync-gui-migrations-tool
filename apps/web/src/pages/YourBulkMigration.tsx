import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  Layers,
  Loader2,
  RefreshCw,
  Search,
  XCircle,
} from 'lucide-react';
import { api, type BulkSyncSession, type SyncLogRow } from '@/lib/api';
import { cn, formatBytes } from '@/lib/utils';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Switch } from '@/components/ui/Switch';
import { SyncHistoryPanel } from '@/components/SyncHistoryPanel';
import {
  HeaderBackLink,
  HeaderDelete,
  useFooter,
  useHeaderAction,
  useHeaderLeft,
  useSidebarIcon,
  useSidebarTitle,
} from '@/components/Layout';

/**
 * Bulk migration detail page (`/bulk/:id`). Mirror of `YourMigration`
 * but tailored to the bulk shape: instead of one source-target with a
 * folder list, we render a per-pair list with progress + status.
 *
 * Loaded from `GET /api/bulk-migrations/:id` which returns the bulk row
 * plus every `bulk_pair` row joined. While the bulk is still live we poll
 * every 4s so the pair stats stay current without needing to hold an SSE
 * connection on this read-only view (the live progress page handles SSE).
 */

type Pair = {
  id: number;
  sourceUsername: string;
  targetUsername: string;
  status: string;
  progressPercent: number;
  totalEmails: number;
  migratedEmails: number;
  migratedBytes?: number;
  failedEmails?: number;
  totalFolders?: number;
  foldersSynced?: number;
  exitCode?: number | null;
  syncEnabled?: boolean;
  backupEnabled?: boolean;
  error?: string | null;
};

type BulkData = {
  id: string;
  sourceHost: string;
  sourcePort: number;
  sourceSecurity: string;
  targetHost: string;
  targetPort: number;
  targetSecurity: string;
  status: string;
  settings: Record<string, any> | null;
  createdAt?: string;
  pairs: Pair[];
  /** API-computed health. 'degraded' when ≥1 pair is currently failing
   *  per the trigger-aware thresholds: any single manual Sync Now failure,
   *  OR 3 consecutive auto/backup failures. Auto-clears on next success. */
  syncHealth?: 'healthy' | 'degraded';
  failingSyncPairs?: { pairId: number; lastError: string | null; trigger: string }[];
  /** Currently-running session of ANY type (manual / auto / backup).
   *  Sync Now button is disabled while non-null; label adapts to the
   *  blocking session's type. */
  activeSession?: { id: string; type: 'manual' | 'auto' | 'backup' } | null;
  /** Back-compat alias kept for older clients. */
  activeManualSessionId?: string | null;
};

const LIVE_STATUSES = ['queued', 'scanning', 'running', 'paused'] as const;

export function YourBulkMigration() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState<BulkData | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [detailsFor, setDetailsFor] = useState<Pair | null>(null);

  useHeaderLeft(<HeaderBackLink to="/" label="Back to Overview" />);
  useSidebarTitle('Your Bulk Migration');
  useSidebarIcon(Layers);

  const refresh = async () => {
    if (!id) return;
    try {
      const d = (await api.getBulk(id)) as BulkData;
      setData(d);
      setFetchError(null);
    } catch (e: any) {
      setFetchError(e?.message ?? 'Failed to load bulk migration');
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Poll every 4s while the bulk is still live so the per-pair progress
  // bars stay current without needing a dedicated SSE connection here.
  const isLive = data && (LIVE_STATUSES as readonly string[]).includes(data.status);
  useEffect(() => {
    if (!isLive) return;
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLive]);

  // Once the bulk itself is past its initial migration the live-status
  // poll above stops. But the bulk row's `activeSession` field can still
  // change underneath us when a scheduled Auto Sync / Backup tick starts
  // or finishes — so we keep a slower poll (every 10s) so the Sync Now
  // button's disabled state stays accurate. Also keeps polling while a
  // session is in flight to catch the transition to idle.
  const hasActiveSession = !!data?.activeSession;
  useEffect(() => {
    if (isLive) return; // already polling at 4s
    const t = setInterval(refresh, hasActiveSession ? 5000 : 10000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLive, hasActiveSession]);

  // -------------------------------------------------------------------
  // Sync History — live SSE feed, keyed by pairId.
  //
  // We subscribe once to bulk:{id} and route incoming sync-run-* events
  // into per-pair buckets so the open PairDetailsModal can render live
  // log lines for the right pair without each modal opening its own
  // EventSource.
  // -------------------------------------------------------------------
  type LivePair = { runId: string | null; logs: SyncLogRow[]; refreshKey: number };
  const [livePairs, setLivePairs] = useState<Record<number, LivePair>>({});
  const livePairsRef = useRef<Record<number, LivePair>>({});

  useEffect(() => {
    if (!id) return;
    const es = new EventSource(`/api/bulk-migrations/${id}/events`, { withCredentials: true });
    es.addEventListener('progress', (e: MessageEvent) => {
      let payload: any;
      try {
        payload = JSON.parse(e.data);
      } catch {
        return;
      }
      if (!payload?.syncTick || typeof payload.pairId !== 'number') return;
      const pairId = payload.pairId as number;
      const prev: LivePair = livePairsRef.current[pairId] ?? {
        runId: null,
        logs: [],
        refreshKey: 0,
      };
      let next: LivePair = prev;
      if (payload.kind === 'sync-run-started') {
        next = { runId: payload.runId ?? null, logs: [], refreshKey: prev.refreshKey + 1 };
      } else if (payload.kind === 'sync-run-log' && prev.runId === payload.runId) {
        const row: SyncLogRow = {
          id: Date.now() + Math.random(),
          ts: new Date().toISOString(),
          level: payload.level ?? 'info',
          message: payload.message ?? '',
        };
        const logs = [...prev.logs, row].slice(-200);
        next = { ...prev, logs };
      } else if (payload.kind === 'sync-run-finished') {
        next = { ...prev, refreshKey: prev.refreshKey + 1 };
      } else {
        return;
      }
      livePairsRef.current = { ...livePairsRef.current, [pairId]: next };
      setLivePairs(livePairsRef.current);
    });
    return () => {
      es.close();
    };
  }, [id]);

  // ----- Delete handler --------------------------------------------------
  const onConfirmDelete = async () => {
    if (!id) return;
    setBusy(true);
    setDeleteError(null);
    try {
      await api.deleteBulk(id);
      setDeleteConfirmOpen(false);
      navigate('/', { replace: true });
    } catch (e: any) {
      setDeleteConfirmOpen(false);
      setDeleteError(e?.message ?? 'Delete failed');
    } finally {
      setBusy(false);
    }
  };

  useHeaderAction(<HeaderDelete onClick={() => setDeleteConfirmOpen(true)} />, [id]);

  // ----- Footer ----------------------------------------------------------
  useFooter(
    <button
      onClick={() => navigate('/')}
      className="w-full max-w-4xl bg-primary-container hover:bg-primary-dark text-white rounded-lg py-3.5 flex items-center justify-center font-bold text-[15px] shadow-md hover:shadow-lg transition-all duration-200 group cursor-pointer"
    >
      <div className="w-full flex items-center px-4 relative">
        <span className="absolute left-4 bg-white/25 rounded-full p-1 flex items-center justify-center group-hover:scale-105 transition-transform">
          <ArrowLeft className="h-4 w-4 text-white" />
        </span>
        <span className="flex-1 text-center font-bold">Back to Overview</span>
      </div>
    </button>,
    [],
  );

  // ----- Derived stats ---------------------------------------------------
  // "Completed" here means terminal success — clean completion OR
  // completed_with_errors (the pair landed in target with partial loss
  // documented in the modal). Both count as a successful run for the
  // headline X/Y metric.
  const stats = useMemo(() => {
    const pairs = data?.pairs ?? [];
    const totalPairs = pairs.length;
    const completedPairs = pairs.filter(
      (p) => p.status === 'completed' || p.status === 'completed_with_errors',
    ).length;
    const partialPairs = pairs.filter((p) => p.status === 'completed_with_errors').length;
    const failedPairs = pairs.filter((p) => p.status === 'failed').length;
    const cancelledPairs = pairs.filter((p) => p.status === 'cancelled').length;
    const totalEmails = pairs.reduce((a, p) => a + (p.totalEmails ?? 0), 0);
    const migratedEmails = pairs.reduce((a, p) => a + (p.migratedEmails ?? 0), 0);
    return {
      totalPairs,
      completedPairs,
      partialPairs,
      failedPairs,
      cancelledPairs,
      totalEmails,
      migratedEmails,
    };
  }, [data]);

  const filtered = useMemo(() => {
    const pairs = data?.pairs ?? [];
    if (!search.trim()) return pairs;
    const q = search.toLowerCase();
    return pairs.filter(
      (p) =>
        p.sourceUsername.toLowerCase().includes(q) || p.targetUsername.toLowerCase().includes(q),
    );
  }, [data, search]);

  // ----- Error / loading -------------------------------------------------
  if (fetchError) {
    return (
      <div className="max-w-3xl mx-auto p-8">
        <div className="border border-red-200 bg-red-50 rounded-xl p-6 flex items-start gap-4">
          <XCircle className="h-6 w-6 text-red-500 shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="text-red-700 font-bold text-sm mb-1">Could not load bulk migration</p>
            <p className="text-red-700/80 text-sm mb-4">{fetchError}</p>
            <div className="flex gap-2">
              <button
                onClick={refresh}
                className="px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white text-sm font-bold rounded-md"
              >
                Retry
              </button>
              <button
                onClick={() => navigate('/')}
                className="px-3 py-1.5 border border-red-300 text-red-700 text-sm font-bold rounded-md hover:bg-red-100"
              >
                Back to Overview
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="p-8 flex items-center gap-2 text-primary">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span className="font-semibold text-sm">Loading…</span>
      </div>
    );
  }

  const settings = (data.settings as any) ?? {};

  return (
    <div className="max-w-5xl mx-auto space-y-8">
      {/* Mobile title */}
      <div className="md:hidden px-2 mb-2">
        <h2 className="text-2xl font-bold text-primary-dark">Your Bulk Migration:</h2>
      </div>

      <StatusBanner data={data} onView={() => navigate(`/bulk/${id}/progress`)} />

      {/* Recent sync failures banner — distinct from the bulk's own status.
          The bulk itself may have finished cleanly months ago; this banner
          flags an ongoing Auto Sync / Backup tick problem that the user
          should investigate. Auto-clears as soon as any pair gets a
          successful sync run. */}
      {data.syncHealth === 'degraded' &&
        data.failingSyncPairs &&
        data.failingSyncPairs.length > 0 && (
          <SyncFailuresBanner
            failingPairs={data.failingSyncPairs}
            pairs={data.pairs}
            onClickPair={(pairId) => {
              const p = data.pairs.find((x) => x.id === pairId);
              if (p) setDetailsFor(p);
            }}
          />
        )}

      {/* Initial Migration card */}
      <div className="space-y-4">
        <h3 className="text-primary-dark font-extrabold text-lg">Initial Migration:</h3>

        <div className="border border-slate-200/80 rounded-xl bg-white shadow-sm overflow-hidden">
          <div className="p-6 md:p-8 flex flex-col lg:flex-row gap-8">
            {/* Left: details */}
            <div className="flex-1 space-y-5">
              <DetailRow label="From:">
                <div className="text-sm min-w-0">
                  <div className="text-slate-500 mb-0.5 truncate">{data.sourceHost}</div>
                  <div className="text-primary font-medium truncate">
                    {data.sourcePort} • {data.sourceSecurity}
                  </div>
                </div>
              </DetailRow>
              <DetailRow label="Mailboxes:">
                <div className="text-primary font-medium text-sm">
                  {stats.totalPairs.toLocaleString()}
                </div>
              </DetailRow>
              <DetailRow label="Emails:">
                <div className="text-primary font-medium text-sm">
                  {stats.totalEmails.toLocaleString()}
                </div>
              </DetailRow>
              <DetailRow label="To:">
                <div className="text-sm min-w-0">
                  <div className="text-slate-500 mb-0.5 truncate">{data.targetHost}</div>
                  <div className="text-primary font-medium truncate">
                    {data.targetPort} • {data.targetSecurity}
                  </div>
                </div>
              </DetailRow>
              {data.createdAt && (
                <DetailRow label="Started:" labelWidth="w-40">
                  <div className="text-primary font-medium text-sm">
                    {new Date(data.createdAt).toLocaleString()}
                  </div>
                </DetailRow>
              )}
            </div>

            {/* Right: stats + actions */}
            <div className="flex-1 flex flex-col justify-between lg:pl-10 lg:border-l border-slate-100">
              <div className="space-y-4">
                <StatBadge
                  value={`${stats.completedPairs}/${stats.totalPairs}`}
                  label={stats.totalPairs === 1 ? 'mailbox completed' : 'mailboxes completed'}
                />
                <StatBadge value={stats.migratedEmails.toLocaleString()} label="emails migrated" />
                {stats.partialPairs > 0 && (
                  <div className="flex items-center gap-3">
                    <div className="bg-amber-500 rounded-full p-0.5 flex items-center justify-center shrink-0">
                      <AlertTriangle className="h-4 w-4 text-white" strokeWidth={3} />
                    </div>
                    <div className="text-[15px] text-primary">
                      <span className="font-bold">{stats.partialPairs}</span> with errors
                    </div>
                  </div>
                )}
                {stats.failedPairs > 0 && (
                  <div className="flex items-center gap-3">
                    <div className="bg-red-500 rounded-full p-0.5 flex items-center justify-center shrink-0">
                      <XCircle className="h-4 w-4 text-white" strokeWidth={3} />
                    </div>
                    <div className="text-[15px] text-primary">
                      <span className="font-bold">{stats.failedPairs}</span> failed
                    </div>
                  </div>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-3 mt-8 lg:mt-0 justify-start lg:justify-end">
                <button
                  onClick={() => navigate(`/bulk/${id}/progress`)}
                  className="flex items-center gap-2 px-4 py-2 border border-primary/30 text-primary font-semibold text-sm rounded-lg hover:bg-primary/5 transition-colors shadow-sm"
                >
                  <RefreshCw className="h-5 w-5" />
                  Live Progress
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Mailbox pairs table */}
      <div className="space-y-4">
        <h3 className="text-primary-dark font-extrabold text-lg">Mailboxes:</h3>
        <div className="border border-slate-200/80 rounded-xl bg-white shadow-sm overflow-hidden flex flex-col">
          <div className="px-5 py-4 border-b border-slate-100 flex flex-col md:flex-row md:items-center justify-between gap-3 bg-slate-50/50">
            <div className="flex items-center space-x-2">
              <span className="font-extrabold text-primary-dark text-sm">Migration Pairs</span>
              <span className="bg-slate-200 text-slate-600 text-[11px] font-bold px-2 py-0.5 rounded-full">
                {stats.completedPairs}/{stats.totalPairs} completed
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

          <div className="overflow-x-auto max-h-[480px] overflow-y-auto">
            <table className="w-full text-left border-collapse min-w-[700px]">
              <thead>
                <tr className="bg-slate-50/20 border-b border-slate-100 text-slate-400 font-extrabold text-[10px] uppercase tracking-wider">
                  <th className="py-2.5 px-4 w-[5%] text-center">#</th>
                  <th className="py-2.5 px-4 w-[40%]">Mailbox</th>
                  <th className="py-2.5 px-4 w-[25%]">Progress</th>
                  <th className="py-2.5 px-4 w-[15%]">Status</th>
                  <th className="py-2.5 px-4 w-[10%] text-right">Emails</th>
                  <th className="py-2.5 px-4 w-[5%] text-center">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50 text-[13px]">
                {filtered.map((p, idx) => (
                  <PairRow key={p.id} index={idx + 1} pair={p} onDetails={() => setDetailsFor(p)} />
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
      </div>

      {/* Settings (editable — patches bulk.settings JSON via PATCH endpoint) */}
      <BulkSettingsCard
        bulkId={id!}
        settings={settings}
        activeSession={data.activeSession ?? null}
        onChange={(merged) => setData((d) => (d ? { ...d, settings: merged } : d))}
      />

      {/* Sync History — list recent batches (manual + auto/backup ticks).
          Click a row to open its live progress page. */}
      <SyncSessionsTable bulkId={id!} />

      {/* Modals */}
      {detailsFor && (
        <PairDetailsModal
          bulkId={id!}
          pair={detailsFor}
          live={livePairs[detailsFor.id]}
          onRetry={async (pairId) => {
            await api.retryBulkPair(id!, pairId);
            // Refresh so the pair flips to pending → running on next poll.
            await refresh();
          }}
          onClose={() => setDetailsFor(null)}
        />
      )}

      <ConfirmDialog
        open={deleteConfirmOpen}
        title="Delete this bulk migration?"
        description={
          <>
            This permanently removes the bulk migration <strong>and all its mailbox pairs</strong>.
            This cannot be undone.
          </>
        }
        variant="danger"
        confirmLabel="Delete bulk migration"
        busy={busy}
        onCancel={() => setDeleteConfirmOpen(false)}
        onConfirm={onConfirmDelete}
      />

      <ConfirmDialog
        open={deleteError !== null}
        title="Could not delete bulk migration"
        description={deleteError ?? ''}
        variant="danger"
        cancelLabel="OK"
        onCancel={() => setDeleteError(null)}
      />
    </div>
  );
}

// -----------------------------------------------------------------------------
// Sub-components
// -----------------------------------------------------------------------------

function DetailRow({
  label,
  labelWidth = 'w-32',
  children,
}: {
  label: string;
  labelWidth?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-start gap-1 sm:gap-4">
      <span className={cn('text-primary font-bold text-sm shrink-0', labelWidth)}>{label}</span>
      {children}
    </div>
  );
}

function StatBadge({ value, label }: { value: string | number; label: string }) {
  return (
    <div className="flex items-center gap-3">
      <div className="bg-emerald-500 rounded-full p-0.5 flex items-center justify-center shrink-0">
        <CheckCircle2 className="h-4 w-4 text-white" strokeWidth={3} />
      </div>
      <div className="text-[15px] text-primary">
        <span className="font-bold">{value}</span> {label}
      </div>
    </div>
  );
}

/**
 * Banner shown above the initial-migration card when one or more pairs
 * are currently failing per the trigger-aware threshold rules:
 *   - manual (Sync Now)        → threshold 1 (any single failure)
 *   - scheduled (auto/backup)  → threshold 3 (consecutive)
 *
 * Auto-clears as soon as a successful sync run lands. Click a pair link
 * to open its PairDetailsModal where the user can inspect Sync History.
 */
function SyncFailuresBanner({
  failingPairs,
  pairs,
  onClickPair,
}: {
  failingPairs: { pairId: number; lastError: string | null; trigger: string }[];
  pairs: Pair[];
  onClickPair: (pairId: number) => void;
}) {
  const pairById = new Map(pairs.map((p) => [p.id, p]));
  // Bucket by trigger so the subtitle explains WHY each pair is flagged.
  const manualFails = failingPairs.filter((f) => f.trigger === 'manual');
  const scheduledFails = failingPairs.filter((f) => f.trigger !== 'manual');
  const summaryParts: string[] = [];
  if (manualFails.length > 0) {
    summaryParts.push(
      `${manualFails.length} pair${manualFails.length === 1 ? '' : 's'} failed on the latest Sync Now`,
    );
  }
  if (scheduledFails.length > 0) {
    summaryParts.push(
      `${scheduledFails.length} pair${scheduledFails.length === 1 ? '' : 's'} failed 3+ consecutive scheduled syncs`,
    );
  }

  return (
    <div className="rounded-xl border p-4 md:p-5 flex items-start gap-3 bg-amber-50 border-amber-200">
      <AlertTriangle className="h-5 w-5 shrink-0 mt-0.5 text-amber-500" />
      <div className="flex-1 min-w-0">
        <p className="font-bold text-sm text-amber-800">
          Recent sync failures — {failingPairs.length} mailbox
          {failingPairs.length === 1 ? '' : 'es'} need attention
        </p>
        <p className="text-xs md:text-sm mt-0.5 text-amber-800 opacity-80 mb-3">
          {summaryParts.join(' · ')}. The initial migration is unaffected. Open Details → Sync
          History to inspect the error and decide whether to Retry or disable sync.
        </p>
        <ul className="space-y-1">
          {failingPairs.slice(0, 5).map((fp) => {
            const p = pairById.get(fp.pairId);
            const triggerLabel = fp.trigger === 'manual' ? 'Sync Now' : 'scheduled';
            return (
              <li key={fp.pairId} className="flex items-center gap-2 text-xs">
                <button
                  onClick={() => onClickPair(fp.pairId)}
                  className="font-bold text-amber-900 hover:underline truncate max-w-xs"
                >
                  {p?.sourceUsername ?? `pair #${fp.pairId}`}
                </button>
                <span className="text-amber-700/70 italic">({triggerLabel})</span>
                {fp.lastError && (
                  <span className="text-amber-700/70 truncate">— {fp.lastError}</span>
                )}
              </li>
            );
          })}
          {failingPairs.length > 5 && (
            <li className="text-xs text-amber-700/70 italic">
              …and {failingPairs.length - 5} more
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}

function StatusBanner({ data, onView }: { data: BulkData; onView: () => void }) {
  const status = data.status;
  if (status === 'completed') return null;

  const live = (LIVE_STATUSES as readonly string[]).includes(status);
  const failed = status === 'failed';
  const cancelled = status === 'cancelled';
  const partial = status === 'completed_with_errors';

  const palette = live
    ? {
        bg: 'bg-amber-50',
        border: 'border-amber-200',
        text: 'text-amber-800',
        accent: 'text-amber-500',
      }
    : failed
      ? { bg: 'bg-red-50', border: 'border-red-200', text: 'text-red-700', accent: 'text-red-500' }
      : partial
        ? {
            bg: 'bg-amber-50',
            border: 'border-amber-200',
            text: 'text-amber-800',
            accent: 'text-amber-500',
          }
        : {
            bg: 'bg-slate-50',
            border: 'border-slate-200',
            text: 'text-slate-700',
            accent: 'text-slate-500',
          };

  const Icon = live ? RefreshCw : failed ? XCircle : AlertTriangle;
  const title = live
    ? 'Bulk migration in progress'
    : failed
      ? 'Bulk migration failed'
      : cancelled
        ? 'Bulk migration cancelled'
        : partial
          ? 'Completed with errors'
          : `Bulk migration ${status}`;
  const subtitle = live
    ? 'The bulk transfer is still running — open the live progress view for real-time updates.'
    : failed
      ? 'All mailbox pairs failed to migrate. Inspect individual pairs for the underlying error.'
      : cancelled
        ? 'You stopped this bulk migration before it finished.'
        : partial
          ? 'Some mailbox pairs completed, others failed. Check the table below for per-pair status.'
          : 'Bulk migration is not complete. Stats below may be partial.';

  return (
    <div
      className={cn(
        'rounded-xl border p-4 md:p-5 flex items-start gap-3',
        palette.bg,
        palette.border,
      )}
    >
      <Icon className={cn('h-5 w-5 shrink-0 mt-0.5', palette.accent, live && 'animate-spin')} />
      <div className="flex-1 min-w-0">
        <p className={cn('font-bold text-sm', palette.text)}>{title}</p>
        <p className={cn('text-xs md:text-sm mt-0.5 break-words', palette.text, 'opacity-80')}>
          {subtitle}
        </p>
      </div>
      <button
        onClick={onView}
        className={cn(
          'shrink-0 self-center px-3 py-1.5 text-xs font-bold rounded-md border transition-colors',
          palette.border,
          palette.text,
          'hover:bg-white/60',
        )}
      >
        View progress
      </button>
    </div>
  );
}

function PairRow({ index, pair, onDetails }: { index: number; pair: Pair; onDetails: () => void }) {
  const pct = pair.progressPercent ?? 0;
  const status = pair.status ?? 'pending';
  const bar =
    status === 'completed'
      ? 'bg-emerald-500'
      : status === 'failed'
        ? 'bg-red-500'
        : status === 'cancelled'
          ? 'bg-slate-400'
          : 'bg-blue-500';

  return (
    <tr
      className={cn(
        'hover:bg-slate-50/65 transition-colors font-medium text-slate-700',
        pair.error && 'bg-red-50/30',
      )}
      title={pair.error ?? undefined}
    >
      <td className="py-2.5 px-4 text-center font-bold text-slate-400">{index}</td>
      <td className="py-2.5 px-4">
        <span className="block font-bold text-primary text-[13px] truncate">
          {pair.sourceUsername}
        </span>
        <span className="text-[10px] text-slate-400 truncate">→ {pair.targetUsername}</span>
      </td>
      <td className="py-2.5 px-4">
        <div className="flex items-center space-x-3">
          <div className="flex-1 bg-slate-100 rounded-full h-2 overflow-hidden border border-slate-200/50">
            <div
              className={cn('h-full transition-all duration-300', bar)}
              style={{ width: `${pct}%` }}
            />
          </div>
          <span className="text-[11px] font-bold text-slate-500 w-8 text-right">{pct}%</span>
        </div>
      </td>
      <td className="py-2.5 px-4">
        <PairStatusBadge status={status} />
      </td>
      <td className="py-2.5 px-4 text-right font-semibold text-slate-600">
        {(pair.migratedEmails ?? 0).toLocaleString()}
        {pair.totalEmails > 0 && `/${pair.totalEmails.toLocaleString()}`}
      </td>
      <td className="py-2.5 px-4 text-center">
        <button
          onClick={onDetails}
          className="bg-slate-100 hover:bg-slate-200 text-slate-500 font-bold text-[10px] px-2.5 py-1 rounded-full transition-colors"
        >
          Details
        </button>
      </td>
    </tr>
  );
}

function PairStatusBadge({ status }: { status: string }) {
  const meta = (() => {
    switch (status) {
      case 'completed':
        return {
          label: 'Completed',
          dot: 'bg-emerald-500',
          text: 'text-emerald-600',
          pulse: false,
        };
      case 'completed_with_errors':
        return {
          label: 'Completed (with errors)',
          dot: 'bg-amber-500',
          text: 'text-amber-600',
          pulse: false,
        };
      case 'failed':
        return { label: 'Failed', dot: 'bg-red-500', text: 'text-red-600', pulse: false };
      case 'cancelled':
        return { label: 'Stopped', dot: 'bg-slate-400', text: 'text-slate-500', pulse: false };
      case 'running':
      case 'scanning':
        return { label: 'Syncing', dot: 'bg-blue-500', text: 'text-blue-500', pulse: true };
      case 'pending':
      case 'queued':
      default:
        return { label: 'Queued', dot: 'bg-amber-500', text: 'text-amber-500', pulse: true };
    }
  })();
  return (
    <span className={cn('text-[11px] font-bold flex items-center gap-1.5', meta.text)}>
      <span className={cn('w-1.5 h-1.5 rounded-full', meta.dot, meta.pulse && 'animate-pulse')} />
      {meta.label}
    </span>
  );
}

function PairDetailsModal({
  bulkId,
  pair,
  live,
  onRetry,
  onClose,
}: {
  bulkId: string;
  pair: Pair;
  /** Live sync state for this pair (current run id + streamed log lines).
   *  Undefined when no sync run has been observed since the page loaded. */
  live?: { runId: string | null; logs: SyncLogRow[]; refreshKey: number };
  /** Invoked when the user clicks Retry on a failed / completed_with_errors
   *  pair. Parent triggers the API call and refreshes the bulk on return. */
  onRetry: (pairId: number) => Promise<void>;
  onClose: () => void;
}) {
  // ESC closes
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  const remaining = Math.max(0, pair.totalEmails - pair.migratedEmails);
  const [retryBusy, setRetryBusy] = useState(false);
  const [retryMsg, setRetryMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(
    null,
  );

  const canRetry = ['failed', 'completed_with_errors', 'cancelled'].includes(pair.status);

  const doRetry = async () => {
    setRetryBusy(true);
    setRetryMsg(null);
    try {
      await onRetry(pair.id);
      setRetryMsg({
        kind: 'success',
        text: 'Retry queued — the worker will re-run this pair shortly.',
      });
    } catch (e: any) {
      setRetryMsg({ kind: 'error', text: e?.message ?? 'Retry failed' });
    } finally {
      setRetryBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 md:p-6">
      <div onClick={onClose} className="absolute inset-0 bg-slate-900/50 backdrop-blur-md" />
      <div className="relative w-full max-w-3xl bg-white rounded-2xl shadow-2xl flex flex-col overflow-hidden z-10 max-h-[85vh]">
        <button
          onClick={onClose}
          aria-label="Close"
          className="absolute top-5 right-5 text-slate-400 hover:text-slate-600 transition-colors p-1.5 rounded-full hover:bg-slate-100"
        >
          <XCircle className="h-5 w-5" />
        </button>

        <div className="p-6 md:p-8 overflow-y-auto space-y-5">
          <h2 className="text-xl md:text-2xl font-bold text-primary-dark pr-8">
            Mailbox Pair Detail
          </h2>

          <div className="bg-primary/5 border border-primary/10 rounded-xl p-4 space-y-1">
            <p className="text-[10px] font-bold text-primary tracking-wider uppercase">From</p>
            <p className="text-sm font-bold text-primary-dark break-all">{pair.sourceUsername}</p>
            <p className="text-[10px] font-bold text-primary tracking-wider uppercase pt-2">To</p>
            <p className="text-sm font-bold text-primary-dark break-all">{pair.targetUsername}</p>
          </div>

          {/* Run summary metrics. Mirrors imapsync's end-of-run report so the
              user can see at a glance what actually happened, instead of
              reading the raw error string. Hidden columns degrade gracefully
              when the worker didn't capture them (pre-stats migrations). */}
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <KV label="Status">
              <PairStatusBadge status={pair.status} />
            </KV>
            <KV label="Progress">
              <span className="font-bold text-primary">{pair.progressPercent ?? 0}%</span>
            </KV>
            <KV label="Exit code">
              <span
                className={cn(
                  'font-bold',
                  pair.exitCode == null
                    ? 'text-slate-400'
                    : pair.exitCode === 0
                      ? 'text-emerald-600'
                      : 'text-amber-600',
                )}
              >
                {pair.exitCode == null ? '—' : pair.exitCode}
                {pair.exitCode === 0 && <span className="text-xs ml-1">(EX_OK)</span>}
                {pair.exitCode === 115 && <span className="text-xs ml-1">(FETCH)</span>}
              </span>
            </KV>
            <KV label="Folders synced">
              <span className="font-bold text-primary">
                {(pair.foldersSynced ?? 0).toLocaleString()}
                {pair.totalFolders ? `/${pair.totalFolders.toLocaleString()}` : ''}
              </span>
            </KV>
            <KV label="Messages migrated">
              <span className="font-bold text-primary">
                {(pair.migratedEmails ?? 0).toLocaleString()}
              </span>
            </KV>
            <KV label="Messages failed">
              <span
                className={cn(
                  'font-bold',
                  (pair.failedEmails ?? 0) > 0 ? 'text-amber-600' : 'text-primary',
                )}
              >
                {(pair.failedEmails ?? 0).toLocaleString()}
              </span>
            </KV>
            <KV label="Total emails (source)">
              <span className="font-bold text-primary">
                {(pair.totalEmails ?? 0).toLocaleString()}
              </span>
            </KV>
            <KV label="Remaining">
              <span className="font-bold text-primary">{remaining.toLocaleString()}</span>
            </KV>
            <KV label="Bytes transferred">
              <span className="font-bold text-primary">{formatBytes(pair.migratedBytes ?? 0)}</span>
            </KV>
            <KV label="Sync / Backup">
              <span className="text-primary text-xs font-bold">
                {pair.syncEnabled ? '✓ Sync' : '— Sync'} ·{' '}
                {pair.backupEnabled ? '✓ Backup' : '— Backup'}
              </span>
            </KV>
          </div>

          {pair.error && (
            <div className="bg-red-50 border border-red-200 rounded-xl p-4 space-y-1">
              <p className="text-xs font-bold text-red-700 tracking-wider uppercase">Error</p>
              <p className="text-sm text-red-700 break-words">{pair.error}</p>
            </div>
          )}

          {/* Retry button — only meaningful for terminal-failure states. A
              successful pair has nothing to retry; a running pair already is.
              The worker resets per-run counters on pickup and uses imapsync
              incremental, so already-copied messages won't double-copy. */}
          {canRetry && (
            <div className="space-y-2">
              <button
                onClick={doRetry}
                disabled={retryBusy}
                className="w-full bg-primary-container hover:bg-primary-dark text-white rounded-xl py-3 flex items-center justify-center font-bold text-sm shadow-sm cursor-pointer transition-colors duration-200 disabled:opacity-60 disabled:cursor-not-allowed"
              >
                <RefreshCw className={cn('h-4 w-4 mr-2', retryBusy && 'animate-spin')} />
                {retryBusy ? 'Queueing…' : 'Retry this pair'}
              </button>
              {retryMsg && (
                <p
                  className={cn(
                    'text-[12px] font-bold text-center',
                    retryMsg.kind === 'success' ? 'text-emerald-700' : 'text-red-700',
                  )}
                >
                  {retryMsg.text}
                </p>
              )}
            </div>
          )}

          {/* Initial Migration Log — captured by the bulk worker into
              bulk_pair_log (sync_run_id IS NULL). Shown for any pair that
              has started (running / terminal) so the user can debug what
              imapsync did line-by-line. */}
          {pair.status !== 'pending' && pair.status !== 'queued' && (
            <InitialMigrationLogPanel bulkId={bulkId} pairId={pair.id} />
          )}

          {/* Per-pair sync history. Available once the pair's initial copy
              has succeeded (clean OR with errors — sync ticks still meaningful). */}
          {(pair.status === 'completed' || pair.status === 'completed_with_errors') && (
            <SyncHistoryPanel
              scope={{ type: 'bulkPair', bulkId, pairId: pair.id }}
              liveRunId={live?.runId ?? null}
              liveLogs={live?.logs}
              refreshKey={live?.refreshKey}
            />
          )}
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

/**
 * Lazy-loaded panel rendering imapsync's stdout/stderr captured during the
 * INITIAL bulk migration run for one pair. Reuses the same visual idiom as
 * the sync-run log panel but doesn't paginate per-run (initial migration is
 * one continuous run from worker's POV). Auto-polls every 4s while the
 * pair is still running.
 */
function InitialMigrationLogPanel({ bulkId, pairId }: { bulkId: string; pairId: number }) {
  const [logs, setLogs] = useState<SyncLogRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const fetchLogs = async () => {
    try {
      const rows = await api.getBulkPairInitialLogs(bulkId, pairId);
      setLogs(rows);
      setError(null);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load logs');
    }
  };

  useEffect(() => {
    if (!open) return;
    void fetchLogs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <div className="space-y-2">
      <h3 className="text-primary-dark font-extrabold text-base">Initial Migration Log</h3>
      <div className="border border-slate-200/80 rounded-xl bg-white shadow-sm overflow-hidden">
        <button
          onClick={() => setOpen((v) => !v)}
          className="w-full px-5 py-3 flex items-center justify-between hover:bg-slate-50/60 text-left transition-colors"
        >
          <span className="text-sm font-bold text-primary-dark">
            {open ? 'Hide log lines' : 'Show log lines'}
          </span>
          <ChevronDown
            className={cn('h-4 w-4 text-slate-400 transition-transform', open && 'rotate-180')}
          />
        </button>
        {open && (
          <div className="bg-slate-50/60 px-5 py-4 border-t border-slate-100">
            {error ? (
              <p className="text-red-600 text-xs font-medium">Failed to load logs: {error}</p>
            ) : logs === null ? (
              <div className="flex items-center gap-2 text-slate-500 text-xs font-medium">
                <Loader2 className="h-3 w-3 animate-spin" />
                Loading logs…
              </div>
            ) : logs.length === 0 ? (
              <p className="text-slate-400 text-xs italic font-medium">
                No log lines captured for this pair&apos;s initial run.
              </p>
            ) : (
              <div className="max-h-72 overflow-y-auto font-mono text-[11px] leading-relaxed text-slate-700 space-y-0.5">
                {logs.map((l) => (
                  <div
                    key={l.id}
                    className={cn(
                      'flex gap-2',
                      l.level === 'error' && 'text-red-600',
                      l.level === 'warn' && 'text-amber-600',
                    )}
                  >
                    <span className="text-slate-400 shrink-0">
                      {new Date(l.ts).toLocaleTimeString()}
                    </span>
                    <span className="break-all whitespace-pre-wrap">{l.message}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function KV({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="bg-white border border-slate-200/80 rounded-lg p-3">
      <p className="text-[10px] font-bold text-slate-400 tracking-wider uppercase mb-1">{label}</p>
      <div className="text-sm">{children}</div>
    </div>
  );
}

/**
 * Mirror of `MigrationOptionsCard` from single-migration view, adapted for
 * bulk's "settings live on the bulk row + applied to every completed pair"
 * model. Layout matches the mockup at `bulk-migrations-step3.html`:
 *
 *   ┌─ Options: ─────────────────────────────────────────────────┐
 *   │  [ Auto Sync | Backup Mode ]   ← segmented control          │
 *   │  [⚪] description text                       [info]         │
 *   │  Backup interval: [Every day ▼]   ← only when Backup Mode   │
 *   │                                                              │
 *   │  [        Sync Now (primary)        ]                       │
 *   ├──── Advanced Settings (collapsible) ───────────────────── ▼ │
 *   │     Throttling  : [⚪] description           [GB/day ▼]    │
 *   │     Sync Dup    : [⚪] description                          │
 *   │     Enable Cache: [⚪] description                          │
 *   │     Reduce BW   : [⚪] description                          │
 *   └─────────────────────────────────────────────────────────────┘
 *
 * Unlike single-migration where the advanced rows are read-only (they
 * affect the initial run that already happened), here they ARE editable
 * because they apply to every future per-pair sync tick via the
 * `bulk-pair-sync` worker.
 */
/**
 * Sync History table at /bulk/:id. Each row = one sync session (Sync
 * Now batch, Auto Sync tick, or Backup Mode tick). Click navigates to
 * the per-session live progress page.
 *
 * Polls every 5s while there are any 'running' sessions (so finished
 * status flips visibly without a manual refresh); otherwise loads once.
 */
function SyncSessionsTable({ bulkId }: { bulkId: string }) {
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<BulkSyncSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchSessions = async () => {
    try {
      const rows = await api.listBulkSyncSessions(bulkId);
      setSessions(rows);
      setError(null);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load sync sessions');
    }
  };

  useEffect(() => {
    void fetchSessions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bulkId]);

  const hasRunning = (sessions ?? []).some((s) => s.status === 'running');
  useEffect(() => {
    if (!hasRunning) return;
    const t = setInterval(fetchSessions, 5000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasRunning]);

  return (
    <div className="space-y-4">
      <h3 className="text-primary-dark font-extrabold text-lg">Sync History:</h3>
      <div className="border border-slate-200/80 rounded-xl bg-white shadow-sm overflow-hidden">
        {error ? (
          <div className="p-5 text-sm text-red-700 bg-red-50">{error}</div>
        ) : sessions === null ? (
          <div className="p-5 flex items-center gap-2 text-slate-500 text-sm">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading sync sessions…
          </div>
        ) : sessions.length === 0 ? (
          <div className="p-8 text-center text-slate-400 italic text-sm font-medium">
            No sync sessions yet. Click <strong>Sync Now</strong> or enable Auto Sync / Backup Mode
            to start.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left min-w-[640px]">
              <thead>
                <tr className="bg-slate-50/20 border-b border-slate-100 text-slate-400 font-extrabold text-[10px] uppercase tracking-wider">
                  <th className="py-2.5 px-4">Type</th>
                  <th className="py-2.5 px-4">Status</th>
                  <th className="py-2.5 px-4">Started</th>
                  <th className="py-2.5 px-4">Finished</th>
                  <th className="py-2.5 px-4 text-right">Pairs</th>
                  <th className="py-2.5 px-4" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50 text-[13px]">
                {sessions.map((s) => (
                  <SessionRow
                    key={s.id}
                    session={s}
                    onClick={() => navigate(`/bulk/${bulkId}/sync/${s.id}/progress`)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function SessionRow({ session, onClick }: { session: BulkSyncSession; onClick: () => void }) {
  const typeLabel =
    session.type === 'manual'
      ? '1-time Sync'
      : session.type === 'backup'
        ? 'Backup Mode'
        : session.type === 'auto'
          ? 'Auto Sync'
          : session.type;
  return (
    <tr
      onClick={onClick}
      className="hover:bg-slate-50/65 cursor-pointer transition-colors font-medium text-slate-700"
    >
      <td className="py-3 px-4 font-bold text-primary text-[13px]">{typeLabel}</td>
      <td className="py-3 px-4">
        <SessionStatusInline status={session.status} />
      </td>
      <td className="py-3 px-4 text-slate-500 text-xs">
        {new Date(session.startedAt).toLocaleString()}
      </td>
      <td className="py-3 px-4 text-slate-500 text-xs">
        {session.finishedAt ? new Date(session.finishedAt).toLocaleString() : '—'}
      </td>
      <td className="py-3 px-4 text-right text-slate-600 text-xs font-bold">
        {session.finishedPairs}/{session.totalPairs}
        {session.failedPairs > 0 && (
          <span className="text-red-600 ml-1">({session.failedPairs} failed)</span>
        )}
      </td>
      <td className="py-3 px-4 text-right text-primary text-xs font-bold">View →</td>
    </tr>
  );
}

function SessionStatusInline({ status }: { status: string }) {
  const meta = (() => {
    switch (status) {
      case 'running':
        return { label: 'Running', dot: 'bg-blue-500', text: 'text-blue-600', pulse: true };
      case 'finished':
        return { label: 'Finished', dot: 'bg-emerald-500', text: 'text-emerald-600', pulse: false };
      case 'failed':
        return { label: 'Failed', dot: 'bg-red-500', text: 'text-red-600', pulse: false };
      case 'cancelled':
        return { label: 'Cancelled', dot: 'bg-slate-400', text: 'text-slate-500', pulse: false };
      default:
        return { label: status, dot: 'bg-slate-400', text: 'text-slate-500', pulse: false };
    }
  })();
  return (
    <span className={cn('text-[11px] font-bold flex items-center gap-1.5', meta.text)}>
      <span className={cn('w-1.5 h-1.5 rounded-full', meta.dot, meta.pulse && 'animate-pulse')} />
      {meta.label}
    </span>
  );
}

function BulkSettingsCard({
  bulkId,
  settings,
  activeSession,
  onChange,
}: {
  bulkId: string;
  settings: Record<string, any>;
  /** When non-null, a sync session of some type is in flight — Sync Now
   *  button is disabled and a "View live progress →" link points at it.
   *  Label adapts to the session type so the user knows what's blocking. */
  activeSession?: { id: string; type: 'manual' | 'auto' | 'backup' } | null;
  onChange: (merged: Record<string, any>) => void;
}) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncMsg, setSyncMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // Derive sync state — autoSync vs backupMode are mutually exclusive in
  // this UX (segmented control). When neither is true, sync is off.
  const syncEnabled = settings.autoSync === true || settings.backupMode === true;
  const currentMode: 'auto' | 'backup' = settings.backupMode === true ? 'backup' : 'auto';
  const initialInterval: 'daily' | 'weekly' | 'monthly' =
    settings.backupInterval === 'weekly' || settings.backupInterval === 'monthly'
      ? settings.backupInterval
      : 'daily';
  // Auto Sync interval — user-configurable (15min / 30min / 1h / 3h / 6h).
  // Default '1h' when settings.autoSyncInterval is unset (matches backend).
  const initialAutoInterval: '15min' | '30min' | '1h' | '3h' | '6h' =
    settings.autoSyncInterval === '15min' ||
    settings.autoSyncInterval === '30min' ||
    settings.autoSyncInterval === '3h' ||
    settings.autoSyncInterval === '6h'
      ? settings.autoSyncInterval
      : '1h';

  const [selectedMode, setSelectedMode] = useState<'auto' | 'backup'>(currentMode);
  const [selectedInterval, setSelectedInterval] = useState<'daily' | 'weekly' | 'monthly'>(
    initialInterval,
  );
  const [selectedAutoInterval, setSelectedAutoInterval] = useState<
    '15min' | '30min' | '1h' | '3h' | '6h'
  >(initialAutoInterval);

  // Keep segmented-control + interval in sync with server-truth when the
  // settings prop changes (post-PATCH refresh or polling tick).
  useEffect(() => {
    setSelectedMode(currentMode);
    setSelectedInterval(initialInterval);
    setSelectedAutoInterval(initialAutoInterval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.autoSync, settings.backupMode, settings.backupInterval, settings.autoSyncInterval]);

  /** Single source of truth for settings mutations. Optimistic update +
   *  PATCH; rollback on failure. The merged response from the server
   *  becomes the new authoritative state. */
  const patch = async (p: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    const prev = { ...settings };
    onChange({ ...settings, ...p });
    try {
      const r = await api.updateBulkSettings(bulkId, p);
      onChange(r.settings as Record<string, any>);
    } catch (e: any) {
      onChange(prev);
      setError(e?.message ?? 'Failed to save settings');
    } finally {
      setBusy(false);
    }
  };

  const toggleSync = async () => {
    if (syncEnabled) {
      // Disable both → no sync.
      await patch({ autoSync: false, backupMode: false });
    } else if (selectedMode === 'auto') {
      await patch({
        autoSync: true,
        backupMode: false,
        autoSyncInterval: selectedAutoInterval,
      });
    } else {
      await patch({
        autoSync: false,
        backupMode: true,
        backupInterval: selectedInterval,
      });
    }
  };

  const onModeChange = async (mode: 'auto' | 'backup') => {
    setSelectedMode(mode);
    if (syncEnabled) {
      // Swap mode immediately if sync is currently on.
      if (mode === 'auto') {
        await patch({
          autoSync: true,
          backupMode: false,
          autoSyncInterval: selectedAutoInterval,
        });
      } else {
        await patch({
          autoSync: false,
          backupMode: true,
          backupInterval: selectedInterval,
        });
      }
    }
  };

  const onIntervalChange = async (interval: 'daily' | 'weekly' | 'monthly') => {
    setSelectedInterval(interval);
    // Only re-arm scheduler when backup mode is actively selected.
    if (syncEnabled && selectedMode === 'backup') {
      await patch({ backupInterval: interval });
    }
  };

  const onAutoIntervalChange = async (interval: '15min' | '30min' | '1h' | '3h' | '6h') => {
    setSelectedAutoInterval(interval);
    // Re-arm only when Auto Sync is the live mode.
    if (syncEnabled && selectedMode === 'auto') {
      await patch({ autoSyncInterval: interval });
    }
  };

  const onSyncNow = async () => {
    setSyncBusy(true);
    setSyncMsg(null);
    try {
      const r = await api.bulkSyncNow(bulkId);
      // Jump straight into the live progress page for the new session so
      // the user sees the answer to "is it actually running?" immediately.
      navigate(`/bulk/${bulkId}/sync/${r.sessionId}/progress`);
    } catch (e: any) {
      setSyncMsg({ kind: 'error', text: e?.message ?? 'Sync Now failed' });
    } finally {
      setSyncBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <h3 className="text-primary-dark font-extrabold text-lg">Options:</h3>

      <div className="border border-slate-200/80 rounded-xl bg-white shadow-sm overflow-hidden">
        <div className="p-6 md:p-8 space-y-6">
          {/* Segmented control */}
          <div className="flex bg-slate-100/80 p-1 rounded-xl border border-slate-200/50">
            <button
              onClick={() => void onModeChange('auto')}
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
              onClick={() => void onModeChange('backup')}
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

          {/* Toggle row */}
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
                  ? 'Runs on the interval below for 10 days, per pair. Shorter intervals catch new mail faster but generate more IMAP load on source/target.'
                  : "Permanently keep target mailboxes in sync. Deletions in source won't affect target."}
              </div>
            </div>
          </div>

          {/* Auto Sync interval picker — only relevant for auto mode.
              Default 1h (matches backend). Shorter intervals = more load,
              longer = more latency. */}
          {selectedMode === 'auto' && (
            <div className="flex items-center justify-between border-b border-slate-100 pb-6 -mt-2">
              <span className="text-primary font-medium text-[14px]">Sync interval</span>
              <select
                value={selectedAutoInterval}
                disabled={busy}
                onChange={(e) =>
                  void onAutoIntervalChange(
                    e.target.value as '15min' | '30min' | '1h' | '3h' | '6h',
                  )
                }
                className="bg-white border border-slate-200/80 rounded-lg text-primary text-[14px] py-2 px-3 disabled:opacity-50"
              >
                <option value="15min">Every 15 minutes</option>
                <option value="30min">Every 30 minutes</option>
                <option value="1h">Every hour (recommended)</option>
                <option value="3h">Every 3 hours</option>
                <option value="6h">Every 6 hours</option>
              </select>
            </div>
          )}

          {/* Backup interval picker — only relevant for backup mode */}
          {selectedMode === 'backup' && (
            <div className="flex items-center justify-between border-b border-slate-100 pb-6 -mt-2">
              <span className="text-primary font-medium text-[14px]">Backup interval</span>
              <select
                value={selectedInterval}
                disabled={busy}
                onChange={(e) =>
                  void onIntervalChange(e.target.value as 'daily' | 'weekly' | 'monthly')
                }
                className="bg-white border border-slate-200/80 rounded-lg text-primary text-[14px] py-2 px-3 disabled:opacity-50"
              >
                <option value="daily">Every day</option>
                <option value="weekly">Every week</option>
                <option value="monthly">Every month</option>
              </select>
            </div>
          )}

          {/* Sync Now CTA.
              - Active session of ANY type (manual / auto / backup) →
                button disabled with type-aware label + "View live
                progress" link. Avoids overlap that would corrupt the
                per-pair imapsync state files (.pid, .pw1, .pw2).
              - Idle (no running session) → standard primary button. */}
          {activeSession ? (
            <div className="space-y-2">
              <button
                disabled
                title={
                  activeSession.type === 'manual'
                    ? 'A Sync Now batch is already running for this bulk.'
                    : activeSession.type === 'auto'
                      ? 'An Auto Sync tick is currently running. Wait for it to finish before triggering Sync Now.'
                      : 'A Backup Mode tick is currently running. Wait for it to finish before triggering Sync Now.'
                }
                className="w-full bg-slate-300 text-white rounded-xl py-3.5 flex items-center justify-center font-bold text-[15px] cursor-not-allowed"
              >
                <RefreshCw className="h-5 w-5 mr-2 animate-spin" strokeWidth={2.5} />
                {activeSession.type === 'manual'
                  ? 'Sync Now is running…'
                  : activeSession.type === 'auto'
                    ? 'Auto Sync tick running…'
                    : 'Backup Mode tick running…'}
              </button>
              <button
                onClick={() => navigate(`/bulk/${bulkId}/sync/${activeSession.id}/progress`)}
                className="w-full bg-white border border-primary/30 text-primary hover:bg-primary/5 rounded-xl py-2.5 flex items-center justify-center font-bold text-sm transition-colors"
              >
                View live progress →
              </button>
            </div>
          ) : (
            <button
              onClick={onSyncNow}
              disabled={syncBusy}
              className="w-full bg-primary-container hover:bg-primary-dark text-white rounded-xl py-3.5 flex items-center justify-center font-bold text-[15px] shadow-sm cursor-pointer transition-colors duration-200 disabled:opacity-60 disabled:cursor-not-allowed"
            >
              <RefreshCw
                className={cn('h-5 w-5 mr-2', syncBusy && 'animate-spin')}
                strokeWidth={2.5}
              />
              {syncBusy ? 'Queueing sync jobs…' : 'Sync Now'}
            </button>
          )}
          {syncMsg && (
            <p
              className={cn(
                'text-[12px] font-bold text-center -mt-2',
                syncMsg.kind === 'success' ? 'text-emerald-700' : 'text-red-700',
              )}
            >
              {syncMsg.text}
            </p>
          )}
          {error && <p className="text-[12px] font-bold text-red-700 text-center -mt-2">{error}</p>}
        </div>

        {/* Advanced Settings accordion */}
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
              checked={settings.throttleEnabled === true}
              description="Upload / Download Limit per Day"
              tooltip="Limit daily upload and download bandwidth to prevent high load on mail servers."
              busy={busy}
              onChange={(v) => void patch({ throttleEnabled: v })}
              right={
                <select
                  disabled={!settings.throttleEnabled || busy}
                  value={settings.throttleGbPerDay ?? 1}
                  onChange={(e) => void patch({ throttleGbPerDay: Number(e.target.value) })}
                  className="w-full md:w-48 bg-white border border-slate-200/80 rounded-lg text-primary text-[15px] py-2 pl-4 pr-10 disabled:opacity-50"
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
              checked={settings.syncDuplicates === true}
              description="Sync Duplicates from the Existing Address"
              tooltip="Check and copy duplicate emails if found in the destination folder."
              busy={busy}
              onChange={(v) => void patch({ syncDuplicates: v })}
            />
            <AdvancedRow
              label="Enable Cache"
              checked={settings.enableCache === true}
              description="Enable Cache for Large Mailboxes & Slow Mail Servers"
              tooltip="Speeds up the migration of huge mailboxes by caching the list of messages locally."
              busy={busy}
              onChange={(v) => void patch({ enableCache: v })}
            />
            <AdvancedRow
              label="Reduce Bandwidth"
              checked={settings.reduceBandwidth === true}
              description="Reduce Bandwidth Consumption Between Servers"
              tooltip="Reduce bandwidth consumption between source and destination mail servers."
              busy={busy}
              onChange={(v) => void patch({ reduceBandwidth: v })}
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
  busy,
  onChange,
  right,
  noBorder,
}: {
  label: string;
  checked: boolean;
  description: string;
  tooltip: string;
  busy: boolean;
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
        <Switch checked={checked} onCheckedChange={onChange} disabled={busy} />
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

// formatBytes is imported above but not used directly — keep the import for
// future stats (per-pair bytes). Re-exported here to silence the linter
// without removing the eventual hook.
void formatBytes;
