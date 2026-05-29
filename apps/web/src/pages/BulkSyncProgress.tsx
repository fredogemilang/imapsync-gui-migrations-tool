import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Hand,
  Layers,
  Loader2,
  RefreshCw,
  XCircle,
} from 'lucide-react';
import { api, type BulkSyncSession, type BulkSyncSessionRun } from '@/lib/api';
import { cn, formatBytes } from '@/lib/utils';
import {
  HeaderBackLink,
  useFooter,
  useHeaderLeft,
  useSidebarIcon,
  useSidebarTitle,
} from '@/components/Layout';

/**
 * Bulk Sync Progress — `/bulk/:id/sync/:sessionId/progress`.
 *
 * Live view of ONE sync session (Sync Now batch, Auto Sync tick, or
 * Backup tick). Shows the aggregate progress bar at top + a per-pair
 * table listing every pair in the session with its individual status,
 * duration, and counters.
 *
 * Refreshes from the API every 4s while session.status='running'; once
 * the session is finished/failed/cancelled the polling stops and the
 * snapshot is final. We don't subscribe to SSE here because the existing
 * bulk:{id} channel doesn't carry session-aggregate events — for a
 * session-only view, polling is simpler and good enough (rows update at
 * 4s granularity, plenty for a sync that takes minutes per pair).
 */

type SessionData = BulkSyncSession & { runs: BulkSyncSessionRun[] };

const TICK_MS = 4000;
const LIVE_STATUS = 'running';

export function BulkSyncProgress() {
  const { id, sessionId } = useParams();
  const navigate = useNavigate();
  const [session, setSession] = useState<SessionData | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);

  useHeaderLeft(<HeaderBackLink to={`/bulk/${id}`} label="Back to Bulk" />);
  useSidebarTitle('Sync Progress');
  useSidebarIcon(Layers);

  const refresh = async () => {
    if (!id || !sessionId) return;
    try {
      const d = await api.getBulkSyncSession(id, sessionId);
      setSession(d);
      setFetchError(null);
    } catch (e: any) {
      setFetchError(e?.message ?? 'Failed to load session');
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, sessionId]);

  // Poll while live; stop on terminal status to be kind to the API.
  const isLive = session?.status === LIVE_STATUS;
  useEffect(() => {
    if (!isLive) return;
    const t = setInterval(refresh, TICK_MS);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLive]);

  useFooter(
    <button
      onClick={() => navigate(`/bulk/${id}`)}
      className="w-full max-w-4xl bg-primary-container hover:bg-primary-dark text-white rounded-lg py-3.5 flex items-center justify-center font-bold text-[15px] shadow-md hover:shadow-lg transition-all duration-200 group cursor-pointer"
    >
      <div className="w-full flex items-center px-4 relative">
        <span className="absolute left-4 bg-white/25 rounded-full p-1 flex items-center justify-center group-hover:scale-105 transition-transform">
          <ArrowLeft className="h-4 w-4 text-white" />
        </span>
        <span className="flex-1 text-center font-bold">Back to Bulk</span>
      </div>
    </button>,
    [id],
  );

  if (fetchError) {
    return (
      <div className="max-w-3xl mx-auto p-8">
        <div className="border border-red-200 bg-red-50 rounded-xl p-6 flex items-start gap-4">
          <XCircle className="h-6 w-6 text-red-500 shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="text-red-700 font-bold text-sm mb-1">Could not load sync session</p>
            <p className="text-red-700/80 text-sm mb-4">{fetchError}</p>
            <button
              onClick={refresh}
              className="px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white text-sm font-bold rounded-md"
            >
              Retry
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="p-8 flex items-center gap-2 text-primary">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span className="font-semibold text-sm">Loading…</span>
      </div>
    );
  }

  const total = session.totalPairs;
  const finished = session.finishedPairs;
  const failed = session.failedPairs;
  // "Running" is the difference between what's been picked up by a
  // worker (= rows in session.runs) and what's already terminal.
  const startedRuns = session.runs.length;
  const running = Math.max(0, startedRuns - finished);
  const pending = Math.max(0, total - startedRuns);
  const percent = total > 0 ? Math.round((finished / total) * 100) : 0;
  const sumEmails = session.runs.reduce((a, r) => a + (r.migratedEmails ?? 0), 0);
  const sumBytes = session.runs.reduce((a, r) => a + (r.migratedBytes ?? 0), 0);

  return (
    <div className="max-w-5xl mx-auto space-y-8">
      {/* Mobile title */}
      <div className="md:hidden px-2 mb-2">
        <h2 className="text-2xl font-bold text-primary-dark">Sync Progress</h2>
      </div>

      {/* Header card with session metadata + aggregate progress bar */}
      <div className="border border-slate-200/80 rounded-xl bg-white shadow-sm overflow-hidden">
        <div className="p-6 md:p-8 space-y-5">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
            <div>
              <h3 className="text-primary-dark font-extrabold text-lg flex items-center gap-2">
                <TypeIcon type={session.type} />
                {typeLabel(session.type)}
              </h3>
              <p className="text-xs text-slate-500 font-medium mt-1">
                Started {new Date(session.startedAt).toLocaleString()}
                {session.finishedAt && (
                  <> · Finished {new Date(session.finishedAt).toLocaleString()}</>
                )}
              </p>
            </div>
            <SessionStatusBadge status={session.status} />
          </div>

          {/* Aggregate progress bar */}
          <div className="space-y-2">
            <div className="flex justify-between text-xs font-bold text-slate-500">
              <span>
                {finished}/{total} pairs finished
              </span>
              <span>{percent}%</span>
            </div>
            <div className="w-full bg-slate-100 rounded-full h-3 overflow-hidden border border-slate-200/50">
              <div
                className={cn(
                  'h-full transition-all duration-500',
                  isLive ? 'bg-blue-500' : failed > 0 ? 'bg-amber-500' : 'bg-emerald-500',
                )}
                style={{ width: `${percent}%` }}
              />
            </div>
          </div>

          {/* Quick stats row */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 pt-2">
            <StatBox label="Running" value={running} color="text-blue-600" />
            <StatBox label="Pending" value={pending} color="text-slate-500" />
            <StatBox
              label="Failed"
              value={failed}
              color={failed > 0 ? 'text-red-600' : 'text-slate-500'}
            />
            <StatBox
              label="Migrated"
              value={sumEmails.toLocaleString()}
              sublabel={formatBytes(sumBytes)}
              color="text-primary"
            />
          </div>
        </div>
      </div>

      {/* Per-pair runs table */}
      <div className="space-y-4">
        <h3 className="text-primary-dark font-extrabold text-lg">Mailboxes in this session:</h3>
        <div className="border border-slate-200/80 rounded-xl bg-white shadow-sm overflow-hidden">
          <div className="overflow-x-auto max-h-[480px] overflow-y-auto">
            <table className="w-full text-left border-collapse min-w-[700px]">
              <thead>
                <tr className="bg-slate-50/20 border-b border-slate-100 text-slate-400 font-extrabold text-[10px] uppercase tracking-wider">
                  <th className="py-2.5 px-4 w-[5%] text-center">#</th>
                  <th className="py-2.5 px-4 w-[35%]">Mailbox</th>
                  <th className="py-2.5 px-4 w-[15%]">Status</th>
                  <th className="py-2.5 px-4 w-[15%]">Duration</th>
                  <th className="py-2.5 px-4 w-[15%] text-right">New emails</th>
                  <th className="py-2.5 px-4 w-[15%] text-right">Bytes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50 text-[13px]">
                {session.runs.length === 0 ? (
                  <tr>
                    <td
                      colSpan={6}
                      className="py-8 text-center text-slate-400 italic font-medium text-sm"
                    >
                      {session.status === 'running'
                        ? 'Waiting for workers to pick up pair jobs…'
                        : 'No runs in this session.'}
                    </td>
                  </tr>
                ) : (
                  session.runs.map((run, idx) => <RunRow key={run.id} index={idx + 1} run={run} />)
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Subcomponents
// -----------------------------------------------------------------------------

function StatBox({
  label,
  value,
  sublabel,
  color,
}: {
  label: string;
  value: string | number;
  sublabel?: string;
  color: string;
}) {
  return (
    <div className="bg-slate-50/60 border border-slate-100 rounded-lg p-3">
      <p className="text-[10px] font-bold text-slate-400 tracking-wider uppercase">{label}</p>
      <p className={cn('text-lg font-extrabold mt-0.5', color)}>{value}</p>
      {sublabel && <p className="text-[10px] text-slate-500 font-medium">{sublabel}</p>}
    </div>
  );
}

function SessionStatusBadge({ status }: { status: string }) {
  const meta = (() => {
    switch (status) {
      case 'running':
        return {
          label: 'Running',
          icon: RefreshCw,
          color: 'bg-blue-100 text-blue-700',
          spin: true,
        };
      case 'finished':
        return {
          label: 'Finished',
          icon: CheckCircle2,
          color: 'bg-emerald-100 text-emerald-700',
          spin: false,
        };
      case 'failed':
        return {
          label: 'Failed',
          icon: XCircle,
          color: 'bg-red-100 text-red-700',
          spin: false,
        };
      case 'cancelled':
        return {
          label: 'Cancelled',
          icon: AlertTriangle,
          color: 'bg-slate-100 text-slate-700',
          spin: false,
        };
      default:
        return {
          label: status,
          icon: AlertTriangle,
          color: 'bg-slate-100 text-slate-700',
          spin: false,
        };
    }
  })();
  const Icon = meta.icon;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold',
        meta.color,
      )}
    >
      <Icon className={cn('h-3.5 w-3.5', meta.spin && 'animate-spin')} />
      {meta.label}
    </span>
  );
}

function TypeIcon({ type }: { type: string }) {
  if (type === 'manual') return <Hand className="h-5 w-5 text-primary/70" />;
  return <RefreshCw className="h-5 w-5 text-primary/70" />;
}

function typeLabel(type: string): string {
  switch (type) {
    case 'manual':
      return 'Manual Sync Now';
    case 'auto':
      return 'Auto Sync tick';
    case 'backup':
      return 'Backup Mode tick';
    default:
      return type;
  }
}

function RunRow({ index, run }: { index: number; run: BulkSyncSessionRun }) {
  const duration =
    run.startedAt && run.finishedAt
      ? formatDuration(new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime())
      : run.status === 'running'
        ? 'in progress…'
        : '—';

  return (
    <tr
      className={cn(
        'hover:bg-slate-50/65 transition-colors font-medium text-slate-700',
        run.status === 'failed' && 'bg-red-50/30',
      )}
      title={run.errorMessage ?? undefined}
    >
      <td className="py-2.5 px-4 text-center font-bold text-slate-400">{index}</td>
      <td className="py-2.5 px-4">
        <span className="block font-bold text-primary text-[13px] truncate">
          {run.sourceUsername ?? `pair #${run.bulkPairId}`}
        </span>
        {run.targetUsername && (
          <span className="text-[10px] text-slate-400 truncate">→ {run.targetUsername}</span>
        )}
      </td>
      <td className="py-2.5 px-4">
        <RunStatusBadge status={run.status} />
      </td>
      <td className="py-2.5 px-4 text-slate-500 text-xs">{duration}</td>
      <td className="py-2.5 px-4 text-right font-semibold text-slate-600">
        {(run.migratedEmails ?? 0).toLocaleString()}
      </td>
      <td className="py-2.5 px-4 text-right font-semibold text-slate-600">
        {formatBytes(run.migratedBytes ?? 0)}
      </td>
    </tr>
  );
}

function RunStatusBadge({ status }: { status: string }) {
  const meta = (() => {
    switch (status) {
      case 'success':
        return { label: 'Success', dot: 'bg-emerald-500', text: 'text-emerald-600', pulse: false };
      case 'failed':
        return { label: 'Failed', dot: 'bg-red-500', text: 'text-red-600', pulse: false };
      case 'running':
        return { label: 'Running', dot: 'bg-blue-500', text: 'text-blue-500', pulse: true };
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
