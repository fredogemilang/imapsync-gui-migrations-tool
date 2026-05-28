import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowRight, Layers, Mail, Search } from 'lucide-react';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import {
  HeaderStepCounter,
  useFooter,
  useHeaderLeft,
  useSidebarIcon,
  useSidebarTitle,
} from '@/components/Layout';

/**
 * Bulk Migration — Step 3 (Live Progress).
 *
 * Renders the polished "bulk-migrations-step3" mockup view:
 *   - Header with type + total emails
 *   - Envelope flying animation panel with centered progress circle
 *   - Two-stat box (Total Emails Migrated, Time Remaining)
 *   - Active Mailbox Synchronizations table with per-pair progress bars,
 *     status badges, processed counts, and a search filter
 *   - Stop / Resume / View All Migrations buttons
 *
 * Data:
 *   - SSE `/api/bulk-migrations/:id/events` pushes per-pair progress + the
 *     overall `status` event. Initial snapshot embedded in the SSE handshake
 *     contains the bulk row + all pair rows.
 */

type Pair = {
  id: number;
  sourceUsername: string;
  targetUsername: string;
  status: string;
  progressPercent: number;
  totalEmails: number;
  migratedEmails: number;
  error?: string | null;
};

type Snapshot = {
  id: string;
  status: string;
  sourceHost: string;
  targetHost: string;
  pairs: Pair[];
};

export function BulkStep3() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [search, setSearch] = useState('');
  const [stopBusy, setStopBusy] = useState(false);
  // Smoothed avg of per-pair migration rate from SSE 'speed' events.
  const speedRef = useRef<number[]>([]);

  useHeaderLeft(<HeaderStepCounter current={3} total={3} />);
  useSidebarTitle('Step 03');
  useSidebarIcon(Layers);

  // ---- SSE wire-up -------------------------------------------------------
  useEffect(() => {
    if (!id) return;
    const es = new EventSource(`/api/bulk-migrations/${id}/events`, {
      withCredentials: true,
    } as any);
    es.addEventListener('snapshot', (e) => {
      const d = JSON.parse((e as MessageEvent).data) as Snapshot;
      setSnapshot(d);
    });
    es.addEventListener('progress', (e) => {
      const d = JSON.parse((e as MessageEvent).data);
      // Top-level bulk status event
      if (d.kind === 'status' && typeof d.status === 'string' && !d.pairId) {
        setSnapshot((s) => (s ? { ...s, status: d.status } : s));
        return;
      }
      // Per-pair events come with pairId set
      if (d.pairId) {
        setSnapshot((s) => {
          if (!s) return s;
          const pairs = s.pairs.map((p) => {
            if (p.id !== d.pairId) return p;
            const next = { ...p };
            if (d.kind === 'percent') {
              next.progressPercent = d.percent;
              if (next.totalEmails > 0)
                next.migratedEmails = Math.min(
                  next.totalEmails,
                  Math.floor((next.totalEmails * d.percent) / 100),
                );
            }
            if (d.kind === 'folder') {
              // We don't track per-folder here but the running counter is fine.
            }
            if (d.kind === 'speed') {
              const arr = speedRef.current;
              arr.push(d.emailsPerSec);
              if (arr.length > 20) arr.shift();
            }
            if (d.kind === 'folder-stats') {
              next.migratedEmails = (next.migratedEmails ?? 0) + (d.copied ?? 0);
            }
            if (d.kind === 'done') {
              if (d.ok) {
                next.status = 'completed';
                next.progressPercent = 100;
              } else if (d.error === 'cancelled') {
                next.status = 'cancelled';
              } else {
                next.status = 'failed';
                next.error = d.error ?? null;
              }
            }
            if (d.kind === 'log' && d.level === 'error') {
              next.error = d.message;
            }
            return next;
          });
          return { ...s, pairs };
        });
      }
    });
    return () => es.close();
  }, [id]);

  // ---- Derived stats -----------------------------------------------------
  const pairs = snapshot?.pairs ?? [];
  const totalEmails = pairs.reduce((a, p) => a + (p.totalEmails ?? 0), 0);
  const migratedEmails = pairs.reduce((a, p) => a + (p.migratedEmails ?? 0), 0);
  const completedCount = pairs.filter((p) => p.status === 'completed').length;
  const totalCount = pairs.length;
  // Overall progress = average per-pair percent (matches mockup's
  // "stage shifts as each mailbox advances" feel).
  const overallPercent =
    totalCount === 0
      ? 0
      : Math.round(pairs.reduce((a, p) => a + (p.progressPercent ?? 0), 0) / totalCount);

  const bulkStatus = snapshot?.status ?? 'queued';
  const completed = bulkStatus === 'completed' || bulkStatus === 'completed_with_errors';
  const failed = bulkStatus === 'failed';
  const cancelled = bulkStatus === 'cancelled';
  const finished = completed || failed || cancelled;
  const paused = cancelled;

  // Smoothed time remaining.
  const avgSpeed = (() => {
    const arr = speedRef.current;
    if (arr.length === 0) return 0;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  })();
  const remainingEmails = Math.max(0, totalEmails - migratedEmails);
  const secondsLeft = completed || avgSpeed <= 0 ? 0 : Math.ceil(remainingEmails / avgSpeed);

  // ---- Filter ------------------------------------------------------------
  const filtered = pairs.filter((p) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return p.sourceUsername.toLowerCase().includes(q) || p.targetUsername.toLowerCase().includes(q);
  });

  // ---- Stop / Resume -----------------------------------------------------
  const onStop = async () => {
    if (!id) return;
    setStopBusy(true);
    try {
      await api.stopBulk(id);
    } finally {
      setStopBusy(false);
    }
  };

  useFooter(
    finished ? (
      <button
        onClick={() => navigate('/')}
        className="w-full max-w-4xl bg-primary-container hover:bg-primary-dark text-white rounded-lg py-3 flex items-center justify-center font-bold text-[15px] shadow-md transition-all duration-200"
      >
        View All Migrations
        <ArrowRight className="h-4 w-4 ml-2" />
      </button>
    ) : (
      <button
        onClick={onStop}
        disabled={stopBusy || paused}
        className={cn(
          'px-8 py-2.5 font-bold text-sm rounded-lg shadow-sm transition-colors disabled:opacity-60 disabled:cursor-not-allowed',
          paused
            ? 'bg-primary-container hover:bg-primary-dark text-white'
            : 'border border-primary/20 hover:bg-slate-50 text-primary-dark bg-white',
        )}
      >
        {stopBusy ? '…' : paused ? 'Stopped' : 'Stop Migration'}
      </button>
    ),
    [finished, paused, stopBusy, id],
  );

  // ---- Circle geometry ---------------------------------------------------
  const circumference = 534.07;
  const offset = circumference - (circumference * overallPercent) / 100;

  return (
    <div className="max-w-5xl mx-auto space-y-8 pb-12">
      {/* Header */}
      <div className="space-y-2">
        <h2
          className={cn(
            'text-3xl font-black tracking-tight transition-all duration-300',
            failed ? 'text-red-700' : 'text-primary-dark',
          )}
        >
          {completed
            ? 'Bulk Migration Completed!'
            : failed
              ? 'Bulk Migration Failed'
              : cancelled
                ? 'Bulk Migration Stopped'
                : 'Migrating Your Mailboxes'}
        </h2>
        <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-6 text-sm font-semibold text-slate-600">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] tracking-wider uppercase font-bold text-slate-500">
              Migration Type
            </span>
            <span className="text-primary-dark font-black truncate">
              Bulk Import ({totalCount} Mailbox{totalCount === 1 ? '' : 'es'})
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] tracking-wider uppercase font-bold text-slate-500">
              Total Emails
            </span>
            <span className="text-primary-dark font-black truncate">
              {totalEmails.toLocaleString()}
            </span>
          </div>
        </div>
      </div>

      {/* Progress Circle + Envelope animation */}
      <div className="flex flex-col md:flex-row items-center justify-center min-h-[220px] relative overflow-hidden bg-slate-50/20 border border-slate-200/40 rounded-2xl p-6 py-8 shadow-sm">
        <EnvelopeStream hidden={completed || failed} paused={paused} />

        <div className="relative z-10 flex flex-col items-center">
          <div className="w-48 h-48 relative flex items-center justify-center">
            <svg className="w-full h-full transform -rotate-90" viewBox="0 0 200 200">
              <circle
                cx="100"
                cy="100"
                r="85"
                className="text-slate-200"
                strokeWidth="14"
                stroke="currentColor"
                fill="transparent"
              />
              <circle
                cx="100"
                cy="100"
                r="85"
                className={cn(
                  'transition-all duration-300',
                  failed ? 'text-red-500' : completed ? 'text-emerald-500' : 'text-blue-500',
                )}
                strokeWidth="14"
                strokeDasharray={circumference}
                strokeDashoffset={offset}
                strokeLinecap="round"
                stroke="currentColor"
                fill="transparent"
              />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center space-y-1">
              <Mail className="h-12 w-12 text-slate-400 drop-shadow-sm" strokeWidth={1.2} />
              <div className="flex items-baseline text-primary-dark">
                <span className="text-3xl font-black tracking-tight">{overallPercent}</span>
                <span className="text-lg font-bold ml-1">%</span>
              </div>
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                Overall progress
              </span>
            </div>
          </div>

          {completed && (
            <div className="mt-4 px-5 py-2 bg-white border border-slate-200/80 rounded-lg shadow-sm text-xs font-bold text-primary-dark">
              Bulk migration finished!
            </div>
          )}
          {failed && (
            <div className="mt-4 px-5 py-2 bg-red-50 border border-red-200 rounded-lg shadow-sm text-xs font-bold text-red-700">
              Bulk migration failed
            </div>
          )}
        </div>
      </div>

      {/* Stats */}
      <div className="max-w-md mx-auto bg-white border border-slate-200/80 rounded-xl shadow-sm overflow-hidden divide-y divide-slate-100">
        <div className="flex items-center justify-between p-4 px-6">
          <span className="text-xs md:text-sm font-bold text-primary-dark">
            Total Emails Migrated:
          </span>
          <span className="text-sm font-extrabold text-primary">
            {migratedEmails.toLocaleString()}
            {totalEmails > 0 && (
              <span className="text-slate-400 font-bold"> / {totalEmails.toLocaleString()}</span>
            )}
          </span>
        </div>
        <div className="flex items-center justify-between p-4 px-6">
          <span className="text-xs md:text-sm font-bold text-primary-dark">Time Remaining:</span>
          <span className="text-sm font-extrabold text-primary">{formatHMS(secondsLeft)}</span>
        </div>
      </div>

      {/* Active Mailbox Synchronizations */}
      <div className="border border-slate-200/80 rounded-xl bg-white shadow-sm overflow-hidden flex flex-col">
        <div className="px-5 py-4 border-b border-slate-100 flex flex-col md:flex-row md:items-center justify-between gap-3 bg-slate-50/50">
          <div className="flex items-center space-x-2">
            <span className="font-extrabold text-primary-dark text-sm">
              Active Mailbox Synchronizations
            </span>
            <span className="bg-slate-200 text-slate-600 text-[11px] font-bold px-2 py-0.5 rounded-full">
              {completedCount}/{totalCount} Completed
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

        <div className="overflow-x-auto max-h-[380px] overflow-y-auto">
          <table className="w-full text-left border-collapse min-w-[700px]">
            <thead>
              <tr className="bg-slate-50/20 border-b border-slate-100 text-slate-400 font-extrabold text-[10px] uppercase tracking-wider">
                <th className="py-2.5 px-4 w-[5%] text-center">#</th>
                <th className="py-2.5 px-4 w-[35%]">Mailbox Address</th>
                <th className="py-2.5 px-4 w-[35%]">Progress Bar</th>
                <th className="py-2.5 px-4 w-[15%]">Status</th>
                <th className="py-2.5 px-4 w-[10%] text-right">Processed</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50 text-[13px]">
              {filtered.map((p, idx) => (
                <PairProgressRow
                  key={p.id}
                  index={idx + 1}
                  pair={p}
                  sourceHost={snapshot?.sourceHost ?? ''}
                />
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td
                    colSpan={5}
                    className="py-8 text-center text-slate-400 italic font-medium text-sm"
                  >
                    No mailboxes match
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Sub-components
// -----------------------------------------------------------------------------

function PairProgressRow({
  index,
  pair,
  sourceHost,
}: {
  index: number;
  pair: Pair;
  sourceHost: string;
}) {
  const pct = pair.progressPercent ?? 0;
  const status = pair.status ?? 'queued';
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
        <span className="text-[10px] text-slate-400 truncate">
          Source: {sourceHost || '—'} • Target: {pair.targetUsername}
        </span>
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
        <StatusBadge status={status} />
      </td>
      <td className="py-2.5 px-4 text-right font-semibold text-slate-600">
        {(pair.migratedEmails ?? 0).toLocaleString()}
        {pair.totalEmails > 0 && `/${pair.totalEmails.toLocaleString()}`}
      </td>
    </tr>
  );
}

function StatusBadge({ status }: { status: string }) {
  // Map worker statuses to mockup-style label + colour.
  const meta = (() => {
    switch (status) {
      case 'completed':
        return {
          label: 'Completed',
          dot: 'bg-emerald-500',
          text: 'text-emerald-600',
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
      <span className={cn('w-1.5 h-1.5 rounded-full', meta.dot, meta.pulse && 'animate-pulse')} />{' '}
      {meta.label}
    </span>
  );
}

function EnvelopeStream({ hidden, paused }: { hidden: boolean; paused: boolean }) {
  const playState = paused ? 'paused' : 'running';
  return (
    <div
      className={cn(
        'absolute left-4 md:left-12 w-[35%] md:w-[42%] h-full flex flex-col justify-around py-6 overflow-hidden pointer-events-none transition-opacity duration-500',
        hidden && 'opacity-0',
      )}
      aria-hidden="true"
    >
      {[1, 2, 3].map((row) => (
        <div key={row} className="relative w-full h-8 flex items-center justify-end">
          <div
            className={cn(
              'absolute right-0 flex items-center',
              row === 1 && 'animate-envelope-1',
              row === 2 && 'animate-envelope-2',
              row === 3 && 'animate-envelope-3',
            )}
            style={{ animationPlayState: playState }}
          >
            <div
              className={cn(
                'flex flex-col gap-0.5 mr-2',
                row === 1 && 'opacity-30',
                row === 2 && 'opacity-35',
                row === 3 && 'opacity-25',
              )}
            >
              <div className="w-8 h-[1.5px] bg-slate-300 rounded-full" />
              <div className="w-11 h-[1.5px] bg-slate-300 rounded-full" />
            </div>
            <Mail className="h-8 w-8 text-slate-400/85 drop-shadow-sm" strokeWidth={1.2} />
          </div>
        </div>
      ))}
    </div>
  );
}

function formatHMS(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.min(99, Math.floor(s / 3600));
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(h)}h ${pad(m)}m ${pad(sec)}s`;
}
