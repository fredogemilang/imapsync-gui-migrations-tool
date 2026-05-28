import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Download,
  Loader2,
  Mail,
  RefreshCw,
  Search,
  XCircle,
} from 'lucide-react';
import { api, type SyncLogRow } from '@/lib/api';
import { formatBytes, cn } from '@/lib/utils';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { MigrationOptionsCard } from '@/components/MigrationOptionsCard';
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

export function YourMigration() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState<any>(null);
  const [logs, setLogs] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useHeaderLeft(<HeaderBackLink to="/" label="Back to Overview" />);
  useSidebarTitle('Your Migration');
  useSidebarIcon(Mail);

  const refresh = async () => {
    if (!id) return;
    try {
      const m = await api.getMigration(id);
      setData(m);
      setFetchError(null);
      const l = await api.getLogs(id).catch(() => []);
      setLogs(l);
    } catch (e: any) {
      // 404 / network / auth — surface the error rather than getting stuck
      // on the "Loading…" splash forever.
      setFetchError(e?.message ?? 'Failed to load migration');
    }
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Poll every 5s while a sync is running so UI stays current.
  useEffect(() => {
    if (!data?.syncRunning) return;
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.syncRunning]);

  // ---------------------------------------------------------------------
  // Sync History — live SSE feed
  //
  // We subscribe to the same migration:{id} SSE channel used by the live
  // progress page, but here we only care about sync-run events. As log
  // lines arrive during an active run, we append them so the expanded
  // run panel in SyncHistoryPanel can show them without waiting for the
  // next poll.
  //
  // refreshKey is bumped whenever a sync-run-finished event fires, which
  // tells the panel to re-fetch its list (so the finished run flips from
  // Running → Success/Failed without manual reload).
  // ---------------------------------------------------------------------
  const [liveRunId, setLiveRunId] = useState<string | null>(null);
  const [liveLogs, setLiveLogs] = useState<SyncLogRow[]>([]);
  const [syncHistoryRefreshKey, setSyncHistoryRefreshKey] = useState(0);
  const liveLogsRef = useRef<SyncLogRow[]>([]);

  useEffect(() => {
    if (!id) return;
    const es = new EventSource(`/api/migrations/${id}/events`, { withCredentials: true });
    es.addEventListener('progress', (e: MessageEvent) => {
      let data: any;
      try {
        data = JSON.parse(e.data);
      } catch {
        return;
      }
      if (!data?.syncTick) return;
      if (data.kind === 'sync-run-started' && data.runId) {
        setLiveRunId(data.runId as string);
        liveLogsRef.current = [];
        setLiveLogs([]);
        // Force the panel to re-pull so the newly-inserted 'running' row
        // appears at the top.
        setSyncHistoryRefreshKey((k) => k + 1);
      } else if (data.kind === 'sync-run-log' && data.runId === liveRunId) {
        const row: SyncLogRow = {
          id: Date.now() + Math.random(),
          ts: new Date().toISOString(),
          level: data.level ?? 'info',
          message: data.message ?? '',
        };
        liveLogsRef.current = [...liveLogsRef.current, row];
        // Cap to last 200 to keep the DOM lean.
        if (liveLogsRef.current.length > 200) {
          liveLogsRef.current = liveLogsRef.current.slice(-200);
        }
        setLiveLogs(liveLogsRef.current);
      } else if (data.kind === 'sync-run-finished') {
        // Bump the panel refresh so it pulls the final status + counters.
        setSyncHistoryRefreshKey((k) => k + 1);
        // Keep liveRunId set briefly so the panel can still render the
        // accumulated live logs; clear on the next started event.
      }
    });
    // The browser hammers reconnect by default — that's fine; SSE is cheap.
    return () => {
      es.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // --- Delete handler ----------------------------------------------------
  // The header button opens a styled ConfirmDialog. On confirm we call the
  // API and redirect to Overview. The API refuses to delete a live
  // (queued/running/paused) migration — Stop first — and we surface that
  // error in a second alert-style dialog.
  const onConfirmDelete = async () => {
    if (!id) return;
    setBusy(true);
    setDeleteError(null);
    try {
      await api.deleteMigration(id);
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

  useFooter(
    <button
      onClick={() => navigate('/')}
      className="w-full max-w-4xl bg-primary-container hover:bg-primary-dark text-white rounded-lg py-3.5 flex items-center justify-center font-bold text-[15px] shadow-md hover:shadow-lg transition-all duration-200 group cursor-pointer"
    >
      <div className="w-full flex items-center px-4 relative">
        <span className="absolute left-4 bg-white/25 rounded-full p-1 flex items-center justify-center group-hover:scale-105 transition-transform">
          <ArrowLeft className="h-4.5 w-4.5 text-white" />
        </span>
        <span className="flex-1 text-center font-bold">Back to Overview</span>
      </div>
    </button>,
    [],
  );

  if (fetchError) {
    return (
      <div className="max-w-3xl mx-auto p-8">
        <div className="border border-red-200 bg-red-50 rounded-xl p-6 flex items-start gap-4">
          <XCircle className="h-6 w-6 text-red-500 shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="text-red-700 font-bold text-sm mb-1">Could not load migration</p>
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

  const downloadLogs = () => {
    const text = logs
      .map((l) => `[${new Date(l.ts).toLocaleString()}] [${l.level}] ${l.message}`)
      .join('\n');
    const blob = new Blob([text || 'No logs available.'], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `migration-${id}.log`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const totalFolders = (data.folders ?? []).length;

  return (
    <div className="max-w-5xl mx-auto space-y-8">
      {/* Mobile Title */}
      <div className="md:hidden px-2 mb-2">
        <h2 className="text-2xl font-bold text-primary-dark">Your Migration:</h2>
      </div>

      <StatusBanner data={data} onView={() => navigate(`/migrations/${id}/progress`)} />

      {/* Initial Migration Section */}
      <div className="space-y-4">
        <h3 className="text-primary-dark font-extrabold text-lg">Initial Migration:</h3>

        <div className="border border-slate-200/80 rounded-xl bg-white shadow-sm overflow-hidden">
          <div className="p-6 md:p-8 flex flex-col lg:flex-row gap-8">
            {/* Left Column: Details Grid */}
            <div className="flex-1 space-y-5">
              <DetailRow label="From:">
                <div className="text-sm min-w-0">
                  <div className="text-slate-500 mb-0.5 truncate">{data.source?.host}</div>
                  <div className="text-primary font-medium truncate">{data.source?.username}</div>
                </div>
              </DetailRow>
              <DetailRow label="Emails:">
                <div className="text-primary font-medium text-sm">{data.totalEmails ?? 0}</div>
              </DetailRow>
              <DetailRow label="Folders:">
                <div className="text-primary font-medium text-sm">{totalFolders}</div>
              </DetailRow>
              <DetailRow label="To:">
                <div className="text-sm min-w-0">
                  <div className="text-slate-500 mb-0.5 truncate">{data.target?.host}</div>
                  <div className="text-primary font-medium truncate">{data.target?.username}</div>
                </div>
              </DetailRow>
              {data.finishedAt && (
                <DetailRow label="Migration finished:" labelWidth="w-40">
                  <div className="text-primary font-medium text-sm">
                    {new Date(data.finishedAt).toLocaleString()}
                  </div>
                </DetailRow>
              )}
            </div>

            {/* Right Column: Stats & Actions */}
            <div className="flex-1 flex flex-col justify-between lg:pl-10 lg:border-l border-slate-100">
              <div className="space-y-4">
                <StatBadge value={data.migratedEmails ?? 0} label="emails migrated" />
                <StatBadge value={totalFolders} label="folders checked" />
                <StatBadge
                  value={formatBytes(data.migratedBytes ?? data.totalBytes ?? 0)}
                  label="migrated"
                />
              </div>

              {/* Action Buttons */}
              <div className="flex flex-wrap items-center gap-3 mt-8 lg:mt-0 justify-start lg:justify-end">
                <button
                  onClick={downloadLogs}
                  className="flex items-center gap-2 px-4 py-2 border border-primary/30 text-primary font-semibold text-sm rounded-lg hover:bg-primary/5 transition-colors shadow-sm"
                >
                  <Download className="h-5 w-5" />
                  Download Log Files
                </button>
                <button
                  onClick={() => setShowDetails(true)}
                  className="flex items-center gap-2 px-4 py-2 border border-primary/30 text-primary font-semibold text-sm rounded-lg hover:bg-primary/5 transition-colors shadow-sm"
                >
                  <Search className="h-5 w-5" />
                  Details
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Options Section (only when completed) */}
      {data.status === 'completed' && (
        <MigrationOptionsCard
          data={data}
          id={id!}
          busy={busy}
          setBusy={setBusy}
          onRefresh={refresh}
        />
      )}

      {/* Sync History — only meaningful once the initial migration has
          finished and (eventually) sync runs start landing. We render the
          panel regardless of whether any runs exist yet so the user gets
          a clear "no runs yet" empty state to understand what they'll see
          here later. */}
      {data.status === 'completed' && id && (
        <SyncHistoryPanel
          scope={{ type: 'migration', migrationId: id }}
          lastSyncAt={data.lastSyncAt}
          liveRunId={liveRunId}
          liveLogs={liveLogs}
          refreshKey={syncHistoryRefreshKey}
        />
      )}

      {/* Details Modal */}
      {showDetails && (
        <DetailsModal folders={data.folders ?? []} onClose={() => setShowDetails(false)} />
      )}

      {/* Confirmation modal — replaces the browser's confirm() dialog. */}
      <ConfirmDialog
        open={deleteConfirmOpen}
        title="Delete this migration?"
        description={
          <>
            This permanently removes the migration <strong>and its logs/folder records</strong>.
            Sync schedules tied to it will be cancelled. This cannot be undone.
          </>
        }
        variant="danger"
        confirmLabel="Delete migration"
        busy={busy}
        onCancel={() => setDeleteConfirmOpen(false)}
        onConfirm={onConfirmDelete}
      />

      {/* Error modal — surfaces API errors (e.g. "migration is still running"). */}
      <ConfirmDialog
        open={deleteError !== null}
        title="Could not delete migration"
        description={deleteError ?? ''}
        variant="danger"
        cancelLabel="OK"
        onCancel={() => setDeleteError(null)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

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

// Status banner shown above the Initial Migration card. Only renders for
// non-completed states so a happy completed migration looks identical to
// the mockup. For live states we offer a deep link to /progress so the
// user can watch real-time SSE; for terminal failures we surface the error
// message stored on the row.
function StatusBanner({ data, onView }: { data: any; onView: () => void }) {
  const status: string = data.status ?? 'queued';
  if (status === 'completed') return null;

  const live = ['queued', 'scanning', 'running', 'paused'].includes(status);
  const failed = status === 'failed';
  const cancelled = status === 'cancelled';

  const palette = live
    ? {
        bg: 'bg-amber-50',
        border: 'border-amber-200',
        text: 'text-amber-800',
        accent: 'text-amber-500',
      }
    : failed
      ? { bg: 'bg-red-50', border: 'border-red-200', text: 'text-red-700', accent: 'text-red-500' }
      : {
          bg: 'bg-slate-50',
          border: 'border-slate-200',
          text: 'text-slate-700',
          accent: 'text-slate-500',
        };

  const Icon = live ? RefreshCw : failed ? XCircle : AlertTriangle;
  const title = live
    ? 'Migration in progress'
    : failed
      ? 'Migration failed'
      : cancelled
        ? 'Migration cancelled'
        : `Migration ${status}`;
  const subtitle = live
    ? 'The initial copy is still running — open the progress view for live updates.'
    : data.error
      ? data.error
      : cancelled
        ? 'You stopped this migration before it finished. You can resume it from the progress view.'
        : 'Migration is not complete. Some stats below may be partial.';

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
      {(live || cancelled || failed) && (
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
      )}
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

// ---------------------------------------------------------------------------
// Details Modal
// ---------------------------------------------------------------------------

function DetailsModal({ folders, onClose }: { folders: any[]; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 md:p-6">
      <div onClick={onClose} className="absolute inset-0 bg-slate-900/50 backdrop-blur-md" />
      <div className="relative w-full max-w-4xl bg-white rounded-2xl shadow-2xl flex flex-col overflow-hidden z-10 max-h-[85vh]">
        {/* Close Button */}
        <button
          onClick={onClose}
          className="absolute top-5 right-5 text-slate-400 hover:text-slate-600 transition-colors p-1.5 rounded-full hover:bg-slate-100 focus:outline-none"
        >
          <svg
            className="h-6 w-6"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            viewBox="0 0 24 24"
          >
            <path d="M6 18L18 6M6 6l12 12" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>

        {/* Modal Body */}
        <div className="p-6 md:p-8 overflow-y-auto space-y-6">
          <h2 className="text-xl md:text-2xl font-bold text-primary-dark pr-8">
            Migrated Folders &amp; Emails
          </h2>

          {/* Info Box */}
          <div className="bg-primary/5 border border-primary/10 rounded-xl p-4 md:p-5">
            <p className="text-primary-dark font-bold text-sm mb-1">
              The folders listed below were transferred.
            </p>
            <p className="text-primary/70 text-xs md:text-sm leading-relaxed">
              For each folder, the specified number of emails were transferred, skipped (to prevent
              duplicates) or rejected by the new mail server (failed).
            </p>
          </div>

          {/* Folders Table */}
          <div className="overflow-x-auto border border-slate-100 rounded-xl">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-primary-dark">
                  <th className="py-3 px-4 text-left font-bold">Folder</th>
                  <th className="py-3 px-4 text-right font-bold w-32">Emails migrated</th>
                  <th className="py-3 px-4 text-right font-bold w-32">Emails skipped</th>
                  <th className="py-3 px-4 text-right font-bold w-32">Emails failed</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-primary">
                {folders.map((f: any) => {
                  const empty = f.totalEmails === 0;
                  const migrated = f.migratedEmails ?? 0;
                  const skipped = f.skippedEmails ?? 0;
                  // Prefer the parser-reported failure count. Fall back to the
                  // "everything not migrated/skipped" derivation only if the
                  // column is null (e.g. legacy row from before this feature
                  // landed) — newer rows ship `failedEmails`, even if zero.
                  const failed = f.failedEmails ?? Math.max(0, f.totalEmails - migrated - skipped);
                  return (
                    <tr
                      key={f.id ?? f.name}
                      className={cn(
                        'hover:bg-slate-50/50',
                        empty && 'text-slate-400',
                        !empty && f.totalEmails > 100 && 'font-bold bg-slate-50/20',
                      )}
                    >
                      <td
                        className={cn(
                          'py-3.5 px-4 font-semibold',
                          empty && 'italic text-slate-400',
                        )}
                      >
                        {f.name}
                      </td>
                      {empty ? (
                        <>
                          <td className="py-3.5 px-4 text-right font-medium" />
                          <td className="py-3.5 px-4 text-right font-medium" />
                          <td className="py-3.5 px-4 text-right font-medium italic text-slate-400">
                            Folder is empty
                          </td>
                        </>
                      ) : (
                        <>
                          <td
                            className={cn(
                              'py-3.5 px-4 text-right font-medium',
                              migrated > 100 && 'text-blue-600',
                            )}
                          >
                            {migrated}
                          </td>
                          <td className="py-3.5 px-4 text-right font-medium">{skipped}</td>
                          <td className="py-3.5 px-4 text-right font-medium">{failed}</td>
                        </>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* OK Button */}
        <button
          onClick={onClose}
          className="w-full bg-primary hover:bg-primary-dark py-4 font-bold text-base transition-colors duration-200 select-none text-white outline-none"
        >
          OK
        </button>
      </div>
    </div>
  );
}
