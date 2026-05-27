import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, ArrowRight, CheckCircle2, Mail, XCircle } from 'lucide-react';
import { useIsValidated, useWizard } from '@/components/WizardContext';
import { api } from '@/lib/api';
import { SettingsPanel } from '@/components/SettingsPanel';
import { cn, formatBytes } from '@/lib/utils';
import {
  HeaderStepArrows,
  HeaderStepCounter,
  useFooter,
  useHeaderAction,
  useHeaderLeft,
  useSidebarIcon,
  useSidebarTitle,
} from '@/components/Layout';

type Inspect = {
  folderCount: number;
  totalEmails: number;
  totalBytes: number;
  quota: { usedBytes: number; limitBytes: number } | null;
};

export function MigrationStep2() {
  const navigate = useNavigate();
  const { source, target, settings, setSettings } = useWizard();
  const validated = useIsValidated();
  const [folders, setFolders] = useState<
    { name: string; totalEmails: number; totalBytes: number }[]
  >([]);
  const [targetInspect, setTargetInspect] = useState<Inspect | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [creating, setCreating] = useState(false);

  useHeaderLeft(<HeaderStepCounter current={2} total={3} />);
  useHeaderAction(<HeaderStepArrows prev="/migrations/new" />);
  useSidebarTitle('Step 02');
  useSidebarIcon(Mail);

  // Route guard — step 2 requires a successful Check Settings on step 1.
  // Direct URL access (no validated snapshot in the persisted wizard store)
  // bounces back. Refreshing AFTER a successful check is fine because the
  // store rehydrates from sessionStorage.
  useEffect(() => {
    if (!validated) navigate('/migrations/new', { replace: true });
  }, [validated, navigate]);

  useEffect(() => {
    if (!validated) return;
    api
      .scanFolders(source)
      .then((r) => setFolders(r.folders))
      .catch(() => setFolders([]));
    api
      .inspectAccount(target)
      .then((r) =>
        setTargetInspect({
          folderCount: r.folderCount,
          totalEmails: r.totalEmails,
          totalBytes: r.totalBytes,
          quota: r.quota,
        }),
      )
      .catch(() => setTargetInspect(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [validated]);

  const totalEmails = folders.reduce((a, f) => a + f.totalEmails, 0);
  const totalBytes = folders.reduce((a, f) => a + f.totalBytes, 0);

  const start = async () => {
    setCreating(true);
    try {
      const { id } = await api.createMigration({ source, target, settings });
      // Don't reset here — the wizard state should only be wiped once the
      // migration completes (or the idle timer fires). Resetting on start
      // causes the account data to disappear if the user navigates back.
      navigate(`/migrations/${id}/progress`);
    } finally {
      setCreating(false);
    }
  };

  const targetItems = targetStatusItems(targetInspect, totalBytes);
  const blocked = hasBlockingError(targetItems);

  useFooter(
    <button
      onClick={start}
      disabled={creating || blocked}
      title={blocked ? 'Cannot start — target has insufficient disk space' : undefined}
      className="w-full max-w-4xl bg-primary-container hover:bg-primary-dark text-white rounded-lg py-3.5 font-bold text-[15px] shadow-md disabled:opacity-60 disabled:cursor-not-allowed"
    >
      {creating ? 'Starting…' : blocked ? 'Cannot start — insufficient disk space' : 'Start Your Migration'}
    </button>,
    [creating, blocked, source, target, settings],
  );

  return (
    <div className="max-w-5xl mx-auto space-y-8">
      <h3 className="text-primary-dark font-extrabold text-lg">Your Migration</h3>

      <div className="flex flex-col md:flex-row items-center gap-4 md:gap-6 justify-between relative">
        <AccountCard
          label="ORIGINAL ACCOUNT"
          username={source.username}
          size={totalBytes > 0 ? formatBytes(totalBytes) : undefined}
          items={[
            {
              kind: 'ok',
              text: `${totalEmails} emails, ${folders.length} folders`,
              action: { label: 'Details', onClick: () => setShowDetails(true) },
            },
          ]}
        />
        <div className="bg-white rounded-full border border-slate-200 shadow-sm p-3 w-10 h-10 flex items-center justify-center">
          <ArrowRight className="h-5 w-5 text-primary" />
        </div>
        <AccountCard label="NEW ACCOUNT" username={target.username} items={targetItems} />
      </div>

      <SettingsPanel value={settings} onChange={setSettings} />

      {showDetails && <DetailsModal folders={folders} onClose={() => setShowDetails(false)} />}
    </div>
  );
}

type StatusItem = {
  kind: 'ok' | 'warn' | 'error';
  text: string;
  /** Optional secondary control rendered to the right of the status text. */
  action?: { label: string; onClick: () => void };
};

function targetStatusItems(inspect: Inspect | null, incomingBytes: number): StatusItem[] {
  if (!inspect) return [{ kind: 'ok', text: 'Inspecting…' }];

  const items: StatusItem[] = [];

  // Disk space check.
  if (inspect.quota) {
    const { usedBytes, limitBytes } = inspect.quota;
    const freeBytes = limitBytes - usedBytes;
    if (incomingBytes > 0 && incomingBytes > freeBytes) {
      // BLOCKING — quota known, won't fit.
      items.push({
        kind: 'error',
        text: `Insufficient disk space (${formatBytes(freeBytes)} free, need ${formatBytes(
          incomingBytes,
        )})`,
      });
    } else {
      items.push({
        kind: 'ok',
        text: `Enough disk space (${formatBytes(freeBytes)} free of ${formatBytes(limitBytes)})`,
      });
    }
  } else {
    // Non-blocking — server didn't advertise QUOTA. We can't verify, but the
    // migration should still be allowed to proceed (most servers are healthy).
    items.push({
      kind: 'warn',
      text: 'Disk space could not be verified (server does not report quota)',
    });
  }

  // Existing content check (non-blocking).
  if (inspect.totalEmails === 0) {
    // 0 emails is fine regardless of how many (empty) folders exist.
    items.push({
      kind: 'ok',
      text: inspect.folderCount <= 1
        ? 'Account is empty'
        : `Account contains 0 emails in ${inspect.folderCount} folders`,
    });
  } else {
    items.push({
      kind: 'warn',
      text: `Account already contains ${inspect.totalEmails} email${
        inspect.totalEmails === 1 ? '' : 's'
      } in ${inspect.folderCount} folder${inspect.folderCount === 1 ? '' : 's'}`,
    });
  }

  return items;
}

function hasBlockingError(items: StatusItem[]): boolean {
  return items.some((it) => it.kind === 'error');
}

function StatusBadge({ kind }: { kind: StatusItem['kind'] }) {
  if (kind === 'ok')
    return (
      <span className="bg-emerald-500 text-white rounded-full p-0.5 mr-2 shrink-0">
        <CheckCircle2 className="h-3.5 w-3.5" />
      </span>
    );
  if (kind === 'warn')
    return (
      <span className="bg-amber-500 text-white rounded-full p-0.5 mr-2 shrink-0">
        <AlertTriangle className="h-3.5 w-3.5" />
      </span>
    );
  return (
    <span className="bg-red-500 text-white rounded-full p-0.5 mr-2 shrink-0">
      <XCircle className="h-3.5 w-3.5" />
    </span>
  );
}

function AccountCard({
  label,
  username,
  size,
  items,
}: {
  label: string;
  username: string;
  size?: string;
  items: StatusItem[];
}) {
  return (
    <div className="bg-white border border-slate-200/85 rounded-xl shadow-sm overflow-hidden flex-1 w-full">
      <div className="bg-primary/5 px-5 py-4 flex items-center justify-between border-b border-slate-100">
        <div>
          <div className="text-primary font-bold text-[10px] tracking-wider uppercase">{label}</div>
          <div className="text-primary font-bold text-[15px]">{username}</div>
        </div>
        {size && (
          <div className="bg-blue-50 text-primary font-bold text-[12px] px-3 py-1.5 rounded-full">
            {size}
          </div>
        )}
      </div>
      <div className="p-5 space-y-3">
        {items.map((it, i) => (
          <div
            key={i}
            className={cn(
              'flex items-center text-[13px] font-semibold',
              it.kind === 'error' ? 'text-red-600' : 'text-primary/80',
            )}
          >
            <StatusBadge kind={it.kind} />
            <span className="flex-1">{it.text}</span>
            {it.action && (
              <button
                onClick={it.action.onClick}
                className="ml-3 bg-slate-200 hover:bg-slate-300 text-slate-600 font-bold text-[11px] px-2.5 py-1 rounded-full"
              >
                {it.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function DetailsModal({ folders, onClose }: { folders: any[]; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <div onClick={onClose} className="absolute inset-0 bg-slate-900/50 backdrop-blur-md" />
      <div className="relative w-full max-w-2xl bg-white rounded-2xl shadow-2xl overflow-hidden max-h-[85vh] flex flex-col">
        <div className="p-6 overflow-y-auto space-y-6">
          <h2 className="text-xl font-bold text-primary">Scanned Folders &amp; Emails</h2>
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200 text-primary-dark">
                <th className="py-3 px-4 text-left font-bold">Folder</th>
                <th className="py-3 px-4 text-right font-bold w-32">Total Emails</th>
                <th className="py-3 px-4 text-right font-bold w-32">Size</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-primary">
              {folders.map((f, i) => {
                const empty = f.totalEmails === 0;
                return (
                  <tr
                    key={i}
                    className={cn('hover:bg-slate-50/50', empty && 'text-slate-400 italic')}
                  >
                    <td className="py-3 px-4 font-semibold">{f.name}</td>
                    <td className="py-3 px-4 text-right">{f.totalEmails}</td>
                    <td className="py-3 px-4 text-right">
                      {f.totalBytes > 0 ? formatBytes(f.totalBytes) : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <button
          onClick={onClose}
          className="w-full bg-primary hover:bg-primary-dark py-4 font-bold text-white"
        >
          OK
        </button>
      </div>
    </div>
  );
}
