import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ChevronRight, Plus, CheckCircle2, Clock, Layers, XCircle } from 'lucide-react';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import {
  useFooter,
  useHeaderAction,
  useSidebarTitle,
  HeaderDeleteFinished,
} from '@/components/Layout';

/**
 * Overview page — unified list of EVERY migration the admin has created,
 * whether single (`/api/migrations`) or bulk (`/api/bulk-migrations`).
 *
 * Both feeds are fetched in parallel on mount and merged client-side. We
 * preserve the per-feed `kind` so the renderer can route clicks to the
 * right detail page (`/migrations/:id` vs `/bulk/:id/progress`) and tweak
 * the row layout (bulk rows show pair counts instead of usernames).
 *
 * Status semantics differ slightly:
 *   - single: queued | scanning | running | paused | completed | failed | cancelled
 *   - bulk:   queued | running | completed | completed_with_errors | failed | cancelled
 * The StatusIcon below normalises both.
 */

const SINGLE_TERMINAL = ['completed', 'failed', 'cancelled'] as const;
const BULK_TERMINAL = ['completed', 'completed_with_errors', 'failed', 'cancelled'] as const;

type ListItem =
  | {
      kind: 'single';
      id: string;
      status: string;
      sourceHost?: string;
      sourceUsername?: string;
      targetHost?: string;
      targetUsername?: string;
      createdAt?: string;
    }
  | {
      kind: 'bulk';
      id: string;
      status: string;
      sourceHost: string;
      targetHost: string;
      pairCount: number;
      completedPairs: number;
      failedPairs: number;
      createdAt?: string;
    };

export function Overview() {
  const [items, setItems] = useState<ListItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [alertMsg, setAlertMsg] = useState<{ title: string; body: string } | null>(null);
  const navigate = useNavigate();

  const reload = async () => {
    try {
      const [singles, bulks] = await Promise.all([
        api.listMigrations().catch(() => []),
        api.listBulk().catch(() => []),
      ]);
      const merged: ListItem[] = [
        ...singles.map((m: any) => ({ ...m, kind: 'single' as const })),
        ...bulks.map((b: any) => ({ ...b, kind: 'bulk' as const })),
      ];
      // Sort newest-first. Both feeds expose createdAt as an ISO string —
      // fallback to the start of epoch if missing so the sort is stable.
      merged.sort((a, b) => {
        const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return tb - ta;
      });
      setItems(merged);
    } catch {
      setItems([]);
    }
  };

  useEffect(() => {
    void reload();
  }, []);

  useSidebarTitle('Your Migrations');

  // Wire the sticky footer "+ New Migration" button.
  useFooter(
    <button
      onClick={() => navigate('/migrations/new')}
      className="w-full max-w-4xl bg-primary-container hover:bg-primary-dark text-white rounded-lg py-3 flex items-center justify-center font-bold text-[15px] shadow-md hover:shadow-lg transition-all duration-200 group"
    >
      <div className="w-full flex items-center px-4 relative">
        <Plus
          className="h-5 w-5 absolute left-4 group-hover:scale-110 transition-transform"
          strokeWidth={2}
        />
        <span className="flex-1 text-center font-bold">New Migration</span>
      </div>
    </button>,
    [],
  );

  const finishedCount = items.filter((it) =>
    it.kind === 'single'
      ? (SINGLE_TERMINAL as readonly string[]).includes(it.status)
      : (BULK_TERMINAL as readonly string[]).includes(it.status),
  ).length;

  /** Delete every migration in a terminal state. Fires both DELETE endpoints
   *  (singles + bulks) in parallel so users see one click clean the whole
   *  list. Running migrations are intentionally left alone — Stop first. */
  const openDeleteConfirm = () => {
    if (finishedCount === 0) {
      setAlertMsg({
        title: 'Nothing to delete',
        body: 'No finished migrations are eligible for deletion. Running and queued migrations are skipped — stop them first.',
      });
      return;
    }
    setConfirmOpen(true);
  };

  const onConfirmDeleteFinished = async () => {
    setBusy(true);
    try {
      const [singleRes, bulkRes] = await Promise.all([
        api.deleteFinishedMigrations().catch((e) => ({ error: e?.message })),
        api.deleteFinishedBulks().catch((e) => ({ error: e?.message })),
      ]);
      setConfirmOpen(false);
      await reload();
      const singleErr = 'error' in singleRes ? singleRes.error : null;
      const bulkErr = 'error' in bulkRes ? bulkRes.error : null;
      if (singleErr || bulkErr) {
        setAlertMsg({
          title: 'Partial delete',
          body: [
            singleErr && `Single migrations: ${singleErr}`,
            bulkErr && `Bulk migrations: ${bulkErr}`,
          ]
            .filter(Boolean)
            .join(' · '),
        });
      }
    } catch (e: any) {
      setConfirmOpen(false);
      setAlertMsg({ title: 'Could not delete migrations', body: e?.message ?? 'Delete failed' });
    } finally {
      setBusy(false);
    }
  };

  useHeaderAction(<HeaderDeleteFinished onClick={openDeleteConfirm} />, [items]);

  return (
    <>
      {items.length === 0 ? (
        <div className="startup-card rounded-2xl p-10 text-center text-slate-500 max-w-5xl mx-auto">
          <p className="font-bold mb-1 text-primary-dark">No migrations yet</p>
          <p className="text-sm">Click &ldquo;New Migration&rdquo; below to start.</p>
        </div>
      ) : (
        items.map((it) =>
          it.kind === 'single' ? (
            <SingleRow key={`single-${it.id}`} item={it} />
          ) : (
            <BulkRow key={`bulk-${it.id}`} item={it} />
          ),
        )
      )}

      <ConfirmDialog
        open={confirmOpen}
        title="Delete all finished migrations?"
        description={
          <>
            This permanently removes <strong>{finishedCount}</strong>{' '}
            {finishedCount === 1 ? 'migration' : 'migrations'} (both single and bulk) along with
            their logs and folder records. Running and queued migrations are not affected. This
            cannot be undone.
          </>
        }
        variant="danger"
        confirmLabel={`Delete ${finishedCount}`}
        busy={busy}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={onConfirmDeleteFinished}
      />

      <ConfirmDialog
        open={alertMsg !== null}
        title={alertMsg?.title ?? ''}
        description={alertMsg?.body ?? ''}
        variant="info"
        cancelLabel="OK"
        onCancel={() => setAlertMsg(null)}
      />
    </>
  );
}

// -----------------------------------------------------------------------------
// Row components — keep both visually consistent with the mockup so the
// user can scan the list at a glance regardless of kind.
// -----------------------------------------------------------------------------

function SingleRow({ item }: { item: Extract<ListItem, { kind: 'single' }> }) {
  return (
    <Link
      to={`/migrations/${item.id}`}
      className="block startup-card rounded-2xl flex items-stretch mb-4 transition-transform hover:-translate-y-1 hover:shadow-lg duration-300 cursor-pointer overflow-hidden group max-w-5xl mx-auto no-underline"
    >
      <div className="pl-4 pr-3 md:pl-6 md:pr-4 py-4 md:py-6 flex items-center shrink-0">
        <StatusIcon status={item.status} />
      </div>
      <div className="flex-1 flex flex-col md:flex-row md:items-center py-3 md:py-0 min-w-0">
        <div className="flex-1 md:py-6 flex flex-col justify-center min-w-0 w-full px-2 md:px-0">
          <div className="flex items-center space-x-2 text-[10px] md:text-xs font-medium text-slate-400 mb-0.5 md:mb-1 tracking-wide min-w-0 w-full">
            <span className="shrink-0">FROM</span>
            <span className="text-slate-500 truncate min-w-0 flex-1">{item.sourceHost}</span>
          </div>
          <div className="text-[13px] md:text-[15px] text-primary font-medium truncate w-full">
            {item.sourceUsername}
          </div>
        </div>
        <div className="px-2 md:px-6 py-1 md:py-6 text-slate-300 hidden md:flex items-center shrink-0">
          <ChevronRight className="h-5 w-5" />
        </div>
        <div className="md:hidden py-1 flex items-center text-slate-300 ml-1">
          <ChevronRight className="h-3 w-3 rotate-90" />
        </div>
        <div className="flex-1 md:py-6 flex flex-col justify-center min-w-0 w-full px-2 md:px-0">
          <div className="flex items-center space-x-2 text-[10px] md:text-xs font-medium text-slate-400 mb-0.5 md:mb-1 tracking-wide min-w-0 w-full">
            <span className="shrink-0">TO</span>
            <span className="text-slate-500 truncate min-w-0 flex-1">{item.targetHost}</span>
          </div>
          <div className="text-[13px] md:text-[15px] text-primary font-medium truncate w-full">
            {item.targetUsername}
          </div>
        </div>
      </div>
      <div className="px-3 md:px-6 border-l border-slate-100 flex items-center justify-center bg-slate-50/50 group-hover:bg-slate-100/50 transition-colors shrink-0">
        <ChevronRight className="h-5 w-5 md:h-6 md:w-6 text-primary" />
      </div>
    </Link>
  );
}

function BulkRow({ item }: { item: Extract<ListItem, { kind: 'bulk' }> }) {
  const pairLabel = `${item.pairCount} mailbox${item.pairCount === 1 ? '' : 'es'}`;
  // Always land on the bulk detail page (`/bulk/:id`). That page surfaces
  // a "View progress" CTA for the live SSE view when the bulk is still
  // running — matching how single migrations route to `/migrations/:id`
  // and link out to `/migrations/:id/progress` when relevant.
  return (
    <Link
      to={`/bulk/${item.id}`}
      className="block startup-card rounded-2xl flex items-stretch mb-4 transition-transform hover:-translate-y-1 hover:shadow-lg duration-300 cursor-pointer overflow-hidden group max-w-5xl mx-auto no-underline"
    >
      <div className="pl-4 pr-3 md:pl-6 md:pr-4 py-4 md:py-6 flex items-center shrink-0">
        <StatusIcon status={item.status} />
      </div>
      <div className="flex-1 flex flex-col md:flex-row md:items-center py-3 md:py-0 min-w-0">
        <div className="flex-1 md:py-6 flex flex-col justify-center min-w-0 w-full px-2 md:px-0">
          <div className="flex items-center space-x-2 text-[10px] md:text-xs font-medium text-slate-400 mb-0.5 md:mb-1 tracking-wide min-w-0 w-full">
            <Layers className="h-3 w-3 text-primary shrink-0" strokeWidth={2.5} />
            <span className="shrink-0">BULK · {pairLabel}</span>
          </div>
          <div className="text-[13px] md:text-[15px] text-primary font-medium truncate w-full">
            {item.sourceHost}
          </div>
        </div>
        <div className="px-2 md:px-6 py-1 md:py-6 text-slate-300 hidden md:flex items-center shrink-0">
          <ChevronRight className="h-5 w-5" />
        </div>
        <div className="md:hidden py-1 flex items-center text-slate-300 ml-1">
          <ChevronRight className="h-3 w-3 rotate-90" />
        </div>
        <div className="flex-1 md:py-6 flex flex-col justify-center min-w-0 w-full px-2 md:px-0">
          <div className="flex items-center space-x-2 text-[10px] md:text-xs font-medium text-slate-400 mb-0.5 md:mb-1 tracking-wide min-w-0 w-full">
            <span className="shrink-0">TARGET</span>
            <span className="text-slate-500 truncate min-w-0 flex-1">{item.targetHost}</span>
          </div>
          <div className="text-[13px] md:text-[15px] text-primary font-medium truncate w-full">
            {item.completedPairs}/{item.pairCount} completed
            {item.failedPairs > 0 && (
              <span className="text-red-500 ml-2">· {item.failedPairs} failed</span>
            )}
          </div>
        </div>
      </div>
      <div className="px-3 md:px-6 border-l border-slate-100 flex items-center justify-center bg-slate-50/50 group-hover:bg-slate-100/50 transition-colors shrink-0">
        <ChevronRight className="h-5 w-5 md:h-6 md:w-6 text-primary" />
      </div>
    </Link>
  );
}

function StatusIcon({ status }: { status: string }) {
  // "completed" + bulk-only "completed_with_errors" → green check.
  if (status === 'completed' || status === 'completed_with_errors')
    return (
      <div
        className={cn(
          'rounded-full p-1.5 flex items-center justify-center shadow-sm',
          status === 'completed_with_errors' ? 'bg-amber-500' : 'bg-emerald-500',
        )}
      >
        <CheckCircle2 className="h-4 w-4 text-white" strokeWidth={3} />
      </div>
    );
  if (status === 'failed' || status === 'cancelled')
    return (
      <div className="bg-red-500 rounded-full p-1.5 flex items-center justify-center shadow-sm">
        <XCircle className="h-4 w-4 text-white" strokeWidth={3} />
      </div>
    );
  // queued / scanning / running / paused → amber Clock.
  return (
    <div className="bg-amber-500 rounded-full p-1.5 flex items-center justify-center shadow-sm">
      <Clock className="h-4 w-4 text-white" strokeWidth={3} />
    </div>
  );
}
