import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowRight, ChevronDown, Mail, Settings as SettingsIcon } from 'lucide-react';
import { api } from '@/lib/api';
import { formatBytes, cn } from '@/lib/utils';
import { MigrationOptionsCard } from '@/components/MigrationOptionsCard';
import {
  HeaderStepCounter,
  useFooter,
  useHeaderLeft,
  useSidebarIcon,
  useSidebarTitle,
} from '@/components/Layout';

/**
 * Real-time migration progress page (Step 3 of the wizard, and the page the
 * user lands on after Start Migration).
 *
 * Layout mirrors `mockup/template/partials/migrations-step3-content.html`:
 *   - Header with FROM/TO + dynamic title
 *   - Flying-envelope animation panel with a centered circular progress
 *   - Stats area: Emails Migrated, Time Remaining
 *   - Collapsible "Migration Details" accordion (folder, action, speed,
 *     mailserver speed badge)
 *   - Footer: Stop / Resume / View Migration Details depending on status
 *   - At 100%: hide envelopes, show "Migration finished!" badge, inline
 *     post-migration options panel (Auto Sync / Backup Mode / advanced)
 *
 * Live data:
 *   - SSE channel `/api/migrations/:id/events` pushes folder/percent/speed/
 *     status/done events from the worker via Redis pub/sub.
 *   - On completion we additionally refetch the full migration row so the
 *     inline options panel has accurate syncMode / syncIntervalMs.
 */
export function MigrationStep3() {
  const { id } = useParams();
  const navigate = useNavigate();

  // Live state from SSE
  const [percent, setPercent] = useState(0);
  const [snapshot, setSnapshot] = useState<any>(null);
  const [folder, setFolder] = useState<{ name: string; index: number; total: number } | null>(null);
  const [speed, setSpeed] = useState<{ emailsPerSec: number; bytesPerSec: number }>({
    emailsPerSec: 0,
    bytesPerSec: 0,
  });
  const [status, setStatus] = useState<string>('queued');
  const [migratedEmails, setMigratedEmails] = useState(0);

  // UI state
  const [stopBusy, setStopBusy] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);

  // Smoothed avg emails/sec across the last N samples — the raw SSE speed
  // fluctuates wildly between ticks (imapsync flushes per-second), so the
  // "time remaining" stat looks jittery if we use the raw value directly.
  const speedSamplesRef = useRef<number[]>([]);
  const SMOOTH_WINDOW = 10;

  useHeaderLeft(<HeaderStepCounter current={3} total={3} />);
  useSidebarTitle('Step 03');
  useSidebarIcon(SettingsIcon);

  // ----- SSE subscription -------------------------------------------------
  useEffect(() => {
    if (!id) return;
    const es = new EventSource(`/api/migrations/${id}/events`, { withCredentials: true } as any);
    es.addEventListener('snapshot', (e) => {
      const d = JSON.parse((e as MessageEvent).data);
      setSnapshot(d);
      setPercent(d.progressPercent ?? 0);
      setStatus(d.status);
      setMigratedEmails(d.migratedEmails ?? 0);
    });
    es.addEventListener('progress', (e) => {
      const d = JSON.parse((e as MessageEvent).data);
      if (d.kind === 'percent') setPercent(d.percent);
      if (d.kind === 'folder') setFolder({ name: d.name, index: d.index, total: d.total });
      if (d.kind === 'speed') {
        setSpeed({ emailsPerSec: d.emailsPerSec, bytesPerSec: d.bytesPerSec });
        // Track for smoothed time-remaining calculation.
        const arr = speedSamplesRef.current;
        arr.push(d.emailsPerSec);
        if (arr.length > SMOOTH_WINDOW) arr.shift();
      }
      if (d.kind === 'status') setStatus(d.status);
      if (d.kind === 'folder-stats') {
        // Worker emits this per folder; running total can be derived but the
        // SSE snapshot reseed below picks it up on next refresh.
      }
      if (d.kind === 'done') {
        setStatus(d.ok ? 'completed' : 'failed');
        if (d.ok) setPercent(100);
      }
    });
    return () => es.close();
  }, [id]);

  // ----- Refetch full migration row on completion -------------------------
  // SSE snapshot only fires at connection time; once status flips to
  // 'completed' we need fresh syncMode/syncIntervalMs/migratedBytes for the
  // inline options panel and stats.
  const [completedData, setCompletedData] = useState<any>(null);
  const completed = status === 'completed';
  const failed = status === 'failed';
  const cancelled = status === 'cancelled';

  const refreshCompleted = async () => {
    if (!id) return;
    const m = await api.getMigration(id).catch(() => null);
    if (m) setCompletedData(m);
  };

  useEffect(() => {
    if (!completed || !id) return;
    void refreshCompleted();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [completed, id]);

  // ----- Derived values ---------------------------------------------------
  const circumference = 534.07;
  const offset = circumference - (circumference * percent) / 100;
  const totalEmails = snapshot?.totalEmails ?? completedData?.totalEmails ?? 0;
  // Estimate migrated emails: prefer the explicit progress event count when
  // we get one (folder-stats updates the DB), else interpolate from percent.
  const migratedEstimate =
    migratedEmails > 0
      ? migratedEmails
      : Math.min(totalEmails, Math.floor((totalEmails * percent) / 100));

  // Smoothed time remaining
  const avgEmailsPerSec = (() => {
    const arr = speedSamplesRef.current;
    if (arr.length === 0) return speed.emailsPerSec;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  })();
  const remainingEmails = Math.max(0, totalEmails - migratedEstimate);
  const secondsLeft =
    completed || avgEmailsPerSec <= 0 ? 0 : Math.ceil(remainingEmails / avgEmailsPerSec);

  // Mailserver speed bucket — heuristic on raw bytes/sec.
  const mailserverSpeed: 'High' | 'Medium' | 'Low' | '—' = (() => {
    if (speed.bytesPerSec <= 0) return '—';
    if (speed.bytesPerSec > 200_000) return 'High';
    if (speed.bytesPerSec > 50_000) return 'Medium';
    return 'Low';
  })();

  // Folder Action — rotates through "Reading / Writing / Analyzing" so the
  // detail accordion feels alive even between concrete events. Locked to
  // "Finished" when complete.
  const FOLDER_ACTIONS = ['Reading Data…', 'Writing Data…', 'Analyzing Files…'] as const;
  const folderAction: string = completed
    ? 'Finished'
    : (FOLDER_ACTIONS[Math.floor(percent / 4) % FOLDER_ACTIONS.length] ?? 'Working…');

  // ----- Stop / Resume handlers ------------------------------------------
  // Stop sends SIGTERM to imapsync via the API → worker marks the migration
  // 'cancelled'. Resume enqueues a fresh BullMQ job with resume=true.
  const paused = cancelled;
  const onStopOrResume = async () => {
    if (!id) return;
    setStopBusy(true);
    try {
      if (paused) {
        await api.resumeMigration(id);
        setStatus('queued');
      } else {
        await api.stopMigration(id);
        // SSE 'done' event will flip status to cancelled; set optimistically.
        setStatus('cancelled');
      }
    } finally {
      setStopBusy(false);
    }
  };

  // ----- Footer -----------------------------------------------------------
  useFooter(
    completed ? (
      <button
        onClick={() => navigate('/')}
        className="w-full max-w-4xl bg-primary-container hover:bg-primary-dark text-white rounded-lg py-3 flex items-center justify-center font-bold text-[15px] shadow-md transition-all duration-200"
      >
        View All Migrations
        <ArrowRight className="h-4 w-4 ml-2" />
      </button>
    ) : (
      <button
        onClick={onStopOrResume}
        disabled={stopBusy}
        className={cn(
          'px-8 py-2.5 font-bold text-sm rounded-lg shadow-sm transition-colors select-none disabled:opacity-60 disabled:cursor-not-allowed',
          paused
            ? 'bg-primary-container hover:bg-primary-dark text-white'
            : 'border border-primary/20 hover:bg-slate-50 text-primary-dark bg-white',
        )}
      >
        {stopBusy ? '…' : paused ? 'Resume Migration' : 'Stop Migration'}
      </button>
    ),
    [completed, paused, stopBusy, id],
  );

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
            ? 'Migration Completed!'
            : failed
              ? 'Migration Failed'
              : cancelled
                ? 'Migration Stopped'
                : 'Migrating Your Emails'}
        </h2>
        {snapshot?.source && (
          <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-6 text-sm font-semibold text-slate-600">
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] tracking-wider uppercase font-bold text-slate-500">
                FROM
              </span>
              <span className="text-primary-dark font-black truncate">
                {snapshot.source.username}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] tracking-wider uppercase font-bold text-slate-500">
                TO
              </span>
              <span className="text-primary-dark font-black truncate">
                {snapshot.target.username}
              </span>
            </div>
          </div>
        )}
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
                <span className="text-3xl font-black tracking-tight">{percent}</span>
                <span className="text-lg font-bold ml-1">%</span>
              </div>
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                migrated
              </span>
            </div>
          </div>

          {/* Finished badge */}
          {completed && (
            <div className="mt-4 px-5 py-2 bg-white border border-slate-200/80 rounded-lg shadow-sm text-xs font-bold text-primary-dark transition-all duration-500">
              Your migration finished!
            </div>
          )}
          {failed && (
            <div className="mt-4 px-5 py-2 bg-red-50 border border-red-200 rounded-lg shadow-sm text-xs font-bold text-red-700">
              Migration failed
            </div>
          )}
        </div>
      </div>

      {/* Stats Area */}
      <div className="max-w-md mx-auto bg-white border border-slate-200/80 rounded-xl shadow-sm overflow-hidden divide-y divide-slate-100">
        <div className="flex items-center justify-between p-4 px-6">
          <span className="text-xs md:text-sm font-bold text-primary-dark">Emails Migrated:</span>
          <span className="text-sm font-extrabold text-primary">
            {migratedEstimate.toLocaleString()}
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

      {/* Migration Details accordion */}
      <div
        className={cn(
          'max-w-md mx-auto border border-slate-200/80 rounded-xl bg-white shadow-sm overflow-hidden transition-all duration-300',
          detailsOpen && 'shadow-md',
        )}
      >
        <button
          onClick={() => setDetailsOpen((v) => !v)}
          className="w-full text-left bg-slate-50/50 hover:bg-slate-50 px-6 py-4 flex items-center justify-between transition-colors select-none outline-none"
        >
          <span className="font-bold text-primary text-[14px]">Migration Details</span>
          <div className="bg-white rounded-full p-1 shadow-sm border border-slate-100/80">
            <ChevronDown
              className={cn(
                'h-4 w-4 text-primary transition-transform duration-300',
                detailsOpen && 'rotate-180',
              )}
              strokeWidth={2.5}
            />
          </div>
        </button>
        {detailsOpen && (
          <div className="p-5 border-t border-slate-100/80 bg-white space-y-3.5 text-[13px] font-semibold text-primary/80">
            <DetailRow
              label="Folder"
              value={folder ? `${folder.index}/${folder.total}` : '—'}
            />
            <DetailRow label="Current Folder" value={folder?.name ?? '—'} />
            <DetailRow label="Folder Action" value={folderAction} />

            <div className="py-1 flex items-center justify-center font-bold text-[10px] tracking-wider text-slate-300 uppercase select-none border-t border-slate-100">
              Migration Speed
            </div>

            <DetailRow
              label="Emails per Second"
              value={speed.emailsPerSec.toFixed(2)}
            />
            <DetailRow
              label="Data Volume per Second"
              value={formatBytes(speed.bytesPerSec)}
            />
            <div className="flex items-center justify-between">
              <span className="text-slate-400">Mailserver Speed</span>
              <MailserverSpeedBadge speed={mailserverSpeed} />
            </div>
          </div>
        )}
      </div>

      {/* View Migration Details button — only at 100% */}
      {completed && (
        <div className="flex justify-center pt-2">
          <button
            onClick={() => navigate(`/migrations/${id}`)}
            className="bg-blue-500 hover:bg-blue-600 text-white rounded-lg py-3 px-8 flex items-center justify-center font-bold text-[15px] shadow-md hover:shadow-lg transition-all duration-300"
          >
            View Migration Details
            <ArrowRight className="h-4 w-4 ml-2" strokeWidth={2.5} />
          </button>
        </div>
      )}

      {/* Inline post-migration options — only at 100%, hydrated from the
          freshly-fetched migration row so syncMode is correct. */}
      {completed && completedData && id && (
        <div className="pt-6 border-t border-slate-200/60">
          <MigrationOptionsCard
            data={completedData}
            id={id}
            busy={stopBusy}
            setBusy={setStopBusy}
            onRefresh={refreshCompleted}
          />
        </div>
      )}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Sub-components
// -----------------------------------------------------------------------------

/** Three envelope rows flying left → into the progress circle. CSS keyframes
 *  live in `style.css` (`animate-envelope-1/2/3`). When `paused` we just
 *  pause the animation; when `hidden` we fade the whole strip away. */
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

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-slate-400">{label}</span>
      <span className="text-primary">{value}</span>
    </div>
  );
}

function MailserverSpeedBadge({ speed }: { speed: 'High' | 'Medium' | 'Low' | '—' }) {
  const palette: Record<typeof speed, string> = {
    High: 'bg-emerald-500',
    Medium: 'bg-amber-500',
    Low: 'bg-red-400',
    '—': 'bg-slate-300',
  };
  return (
    <span
      className={cn(
        'text-white rounded-full px-2 py-0.5 text-[10px] font-bold tracking-wide uppercase shadow-sm',
        palette[speed],
      )}
    >
      {speed}
    </span>
  );
}

/** "01h 23m 45s" formatter. Caps at 99h to avoid weird overflow when the
 *  source server is slow and the ETA balloons. */
function formatHMS(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.min(99, Math.floor(s / 3600));
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(h)}h ${pad(m)}m ${pad(sec)}s`;
}
