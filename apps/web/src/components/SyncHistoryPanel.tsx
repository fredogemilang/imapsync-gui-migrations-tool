import { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  Calendar,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Hand,
  History,
  Loader2,
  Mail,
  RefreshCw,
  XCircle,
} from 'lucide-react';
import { api, type SyncLogRow, type SyncRun } from '@/lib/api';
import { cn, formatBytes } from '@/lib/utils';

/**
 * Sync History panel — shared between YourMigration and YourBulkMigration.
 *
 * Renders the latest sync runs newest-first as a list. Each row is
 * collapsible: clicking expands an inline view that lazily fetches the run's
 * log lines. The currently-running row (if any) live-updates from the
 * caller's SSE stream — the parent page passes `liveLogs` and `liveRunId`
 * so we can append messages to that row's expanded panel without polling.
 *
 * Two flavours of data source, picked via the `scope` prop:
 *   • { type: 'migration', migrationId } — calls /api/migrations/:id/sync-runs[...]
 *   • { type: 'bulkPair', bulkId, pairId } — calls the bulk-pair-scoped endpoints
 *
 * `lastSyncAt` is shown as a "last synced N ago" header when the list is
 * non-empty; pass null/undefined to hide. `refreshKey` lets parents force a
 * reload when they detect a sync run has finished (e.g. via SSE).
 */
type Scope =
  | { type: 'migration'; migrationId: string }
  | { type: 'bulkPair'; bulkId: string; pairId: number };

export function SyncHistoryPanel({
  scope,
  lastSyncAt,
  liveRunId,
  liveLogs,
  refreshKey,
  title = 'Sync History',
}: {
  scope: Scope;
  lastSyncAt?: string | null;
  /** When set, treat this run as "live" — append liveLogs to its expanded
   *  panel and badge it as Running. Caller manages SSE; we just render. */
  liveRunId?: string | null;
  liveLogs?: SyncLogRow[];
  refreshKey?: number;
  title?: string;
}) {
  const [runs, setRuns] = useState<SyncRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loadingRuns, setLoadingRuns] = useState(false);

  const fetchRuns = async () => {
    setLoadingRuns(true);
    setError(null);
    try {
      const rows =
        scope.type === 'migration'
          ? await api.listSyncRuns(scope.migrationId)
          : await api.listBulkPairSyncRuns(scope.bulkId, scope.pairId);
      setRuns(rows);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load sync history');
    } finally {
      setLoadingRuns(false);
    }
  };

  // Extract the deps to plain locals so eslint-react-hooks can statically
  // check them (the inline ternary in the array trips the lint rule).
  const scopeKey = scope.type === 'migration' ? scope.migrationId : scope.bulkId;
  const scopeKey2 = scope.type === 'bulkPair' ? scope.pairId : null;
  useEffect(() => {
    void fetchRuns();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey, scopeKey2, refreshKey]);

  // Auto-poll every 5s while a run is in 'running' status so we eventually
  // get the finished row even if the SSE stream missed the final event.
  const hasRunning = (runs ?? []).some((r) => r.status === 'running');
  useEffect(() => {
    if (!hasRunning) return;
    const t = setInterval(fetchRuns, 5000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasRunning]);

  const toggle = (runId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(runId)) next.delete(runId);
      else next.add(runId);
      return next;
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-primary-dark font-extrabold text-lg flex items-center gap-2">
          <History className="h-5 w-5 text-primary/70" />
          {title}
        </h3>
        {lastSyncAt && (
          <div className="text-xs text-slate-500 font-medium flex items-center gap-1.5">
            <Calendar className="h-3.5 w-3.5" />
            Last synced {timeAgo(new Date(lastSyncAt))}
          </div>
        )}
      </div>

      <div className="border border-slate-200/80 rounded-xl bg-white shadow-sm overflow-hidden">
        {error ? (
          <div className="p-6 flex items-start gap-3 bg-red-50/40">
            <AlertCircle className="h-5 w-5 text-red-500 shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-red-700 font-bold text-sm">Could not load sync history</p>
              <p className="text-red-700/80 text-xs mt-1">{error}</p>
              <button
                onClick={fetchRuns}
                className="mt-2 px-3 py-1 bg-red-600 hover:bg-red-700 text-white text-xs font-bold rounded-md"
              >
                Retry
              </button>
            </div>
          </div>
        ) : runs === null && loadingRuns ? (
          <div className="p-6 flex items-center gap-2 text-primary/70">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="font-semibold text-sm">Loading sync history…</span>
          </div>
        ) : (runs ?? []).length === 0 ? (
          <div className="p-8 text-center">
            <History className="h-10 w-10 text-slate-300 mx-auto mb-3" strokeWidth={1.5} />
            <p className="text-slate-500 font-bold text-sm">No sync runs yet</p>
            <p className="text-slate-400 text-xs mt-1">
              Sync runs will appear here once Auto Sync, Backup Mode, or Sync Now triggers.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {(runs ?? []).map((r) => (
              <SyncRunRow
                key={r.id}
                run={r}
                expanded={expanded.has(r.id)}
                onToggle={() => toggle(r.id)}
                scope={scope}
                liveRunId={liveRunId}
                liveLogs={liveLogs}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// One sync run row — collapsed by default, expands to show inline log lines.
// ---------------------------------------------------------------------------

function SyncRunRow({
  run,
  expanded,
  onToggle,
  scope,
  liveRunId,
  liveLogs,
}: {
  run: SyncRun;
  expanded: boolean;
  onToggle: () => void;
  scope: Scope;
  liveRunId?: string | null;
  liveLogs?: SyncLogRow[];
}) {
  const isLive = run.status === 'running' || liveRunId === run.id;
  const duration =
    run.finishedAt && run.startedAt
      ? formatDuration(new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime())
      : isLive
        ? 'in progress…'
        : '—';

  return (
    <li>
      <button
        onClick={onToggle}
        className="w-full px-5 py-4 flex items-center gap-4 hover:bg-slate-50/60 text-left transition-colors"
      >
        <div className="shrink-0">
          {expanded ? (
            <ChevronDown className="h-4 w-4 text-slate-400" />
          ) : (
            <ChevronRight className="h-4 w-4 text-slate-400" />
          )}
        </div>
        <StatusBadge status={run.status} live={isLive} />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-bold text-primary-dark truncate">
            {new Date(run.startedAt).toLocaleString()}
            <span className="text-slate-400 font-medium ml-2 text-xs">
              · {timeAgo(new Date(run.startedAt))}
            </span>
          </div>
          <div className="text-xs text-slate-500 font-medium mt-0.5 flex items-center gap-3 flex-wrap">
            <span className="flex items-center gap-1">
              <TriggerIcon trigger={run.trigger} />
              {triggerLabel(run.trigger)}
            </span>
            <span>·</span>
            <span>Duration {duration}</span>
            {(run.status === 'success' || run.status === 'failed') && (
              <>
                <span>·</span>
                <span className="flex items-center gap-1">
                  <Mail className="h-3 w-3" />
                  {run.migratedEmails.toLocaleString()} new
                </span>
                <span>·</span>
                <span>{formatBytes(run.migratedBytes)}</span>
              </>
            )}
          </div>
          {run.status === 'failed' && run.errorMessage && (
            <div className="text-xs text-red-600 font-medium mt-1 truncate">{run.errorMessage}</div>
          )}
        </div>
      </button>
      {expanded && (
        <SyncRunLogs
          scope={scope}
          run={run}
          isLive={isLive}
          liveLogs={liveRunId === run.id ? liveLogs : undefined}
        />
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Lazily-loaded log panel for one expanded run.
// ---------------------------------------------------------------------------

function SyncRunLogs({
  scope,
  run,
  isLive,
  liveLogs,
}: {
  scope: Scope;
  run: SyncRun;
  isLive: boolean;
  liveLogs?: SyncLogRow[];
}) {
  const [logs, setLogs] = useState<SyncLogRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchLogs = async () => {
    try {
      const rows =
        scope.type === 'migration'
          ? await api.getSyncRunLogs(scope.migrationId, run.id)
          : await api.getBulkPairSyncRunLogs(scope.bulkId, scope.pairId, run.id);
      setLogs(rows);
      setError(null);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load logs');
    }
  };

  useEffect(() => {
    void fetchLogs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.id]);

  // While the run is live, refetch every 4s so server-stored logs catch up.
  // The live SSE-driven logs are also merged in below for snappier feel.
  useEffect(() => {
    if (!isLive) return;
    const t = setInterval(fetchLogs, 4000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLive]);

  // Merge server-stored logs with SSE-streamed live logs, deduped by
  // (ts + message). Server is the source of truth for ordering; live logs
  // appended at the start so the user sees the freshest line first.
  const merged = useMemo(() => {
    const base = logs ?? [];
    if (!liveLogs || liveLogs.length === 0) return base;
    const seen = new Set(base.map((l) => `${l.ts}|${l.message}`));
    const extras = liveLogs.filter((l) => !seen.has(`${l.ts}|${l.message}`));
    // Live logs come in chronological order; we display newest-first below.
    return [...extras.slice().reverse(), ...base];
  }, [logs, liveLogs]);

  return (
    <div className="bg-slate-50/60 px-5 py-4 border-t border-slate-100">
      {error ? (
        <p className="text-red-600 text-xs font-medium">Failed to load logs: {error}</p>
      ) : logs === null ? (
        <div className="flex items-center gap-2 text-slate-500 text-xs font-medium">
          <Loader2 className="h-3 w-3 animate-spin" />
          Loading logs…
        </div>
      ) : merged.length === 0 ? (
        <p className="text-slate-400 text-xs italic font-medium">
          {isLive ? 'Waiting for log output…' : 'No log lines captured for this run.'}
        </p>
      ) : (
        <div className="max-h-72 overflow-y-auto font-mono text-[11px] leading-relaxed text-slate-700 space-y-0.5">
          {merged.map((l, i) => (
            <div
              key={`${l.id ?? 'live'}-${i}`}
              className={cn(
                'flex gap-2',
                l.level === 'error' && 'text-red-600',
                l.level === 'warn' && 'text-amber-600',
              )}
            >
              <span className="text-slate-400 shrink-0">{new Date(l.ts).toLocaleTimeString()}</span>
              <span className="break-all whitespace-pre-wrap">{l.message}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small render helpers
// ---------------------------------------------------------------------------

function StatusBadge({ status, live }: { status: SyncRun['status']; live: boolean }) {
  if (live) {
    return (
      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 text-[11px] font-bold shrink-0">
        <RefreshCw className="h-3 w-3 animate-spin" />
        Running
      </span>
    );
  }
  if (status === 'success') {
    return (
      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 text-[11px] font-bold shrink-0">
        <CheckCircle2 className="h-3 w-3" />
        Success
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-red-100 text-red-700 text-[11px] font-bold shrink-0">
      <XCircle className="h-3 w-3" />
      Failed
    </span>
  );
}

function TriggerIcon({ trigger }: { trigger: SyncRun['trigger'] }) {
  if (trigger === 'manual') return <Hand className="h-3 w-3" />;
  return <RefreshCw className="h-3 w-3" />;
}

function triggerLabel(t: SyncRun['trigger']): string {
  switch (t) {
    case 'auto':
      return 'Auto Sync';
    case 'backup':
      return 'Backup Mode';
    case 'manual':
      return 'Manual';
    default:
      return t;
  }
}

function formatDuration(ms: number): string {
  if (ms < 0) return '—';
  if (ms < 1000) return `${ms} ms`;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  if (min < 60) return rem ? `${min}m ${rem}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m`;
}

function timeAgo(d: Date): string {
  const diff = Date.now() - d.getTime();
  if (diff < 0) return 'in the future';
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mo = Math.floor(day / 30);
  return `${mo}mo ago`;
}
