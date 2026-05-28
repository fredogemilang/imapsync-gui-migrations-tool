import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ChevronDown,
  Check,
  Download,
  Info,
  Layers,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useFooter, useSidebarIcon, useSidebarTitle } from '@/components/Layout';
import { useBulkWizard } from '@/components/BulkWizardContext';

/**
 * Bulk migration creation page. Matches the mockup at
 * `mockup/template/bulk-migrations.html` + the inline content partial.
 *
 * Key behaviours:
 *   - Two server cards (source + target) with collapsible Advanced Settings
 *     (port + security dropdown + Ignore SSL Warnings checkbox)
 *   - "Access Data" tab — editable table of mailbox pairs with per-row
 *     Sync/Backup checkboxes and a delete button
 *   - "CSV Upload" tab — drag-drop OR click-to-browse; CSV is parsed
 *     CLIENT-SIDE (FileReader) and rows are merged into the table. Nothing
 *     about the file leaves the browser.
 *   - Backup Interval radios + quick-action buttons (Sync All / Backup
 *     All / Delete All)
 *   - "Check Mailboxes" performs a real `/api/imap/test-connection` against
 *     the first pair's source + target creds so the user gets a real-world
 *     validation before bulk submit. A live-log modal shows progress.
 *
 * What we don't yet do:
 *   - Worker doesn't act on per-row sync/backup yet; columns are stored
 *     for a future "auto-sync per pair" enhancement.
 */

type Security = 'SSL/TLS' | 'STARTTLS' | 'None';

type Server = {
  host: string;
  port: number;
  security: Security;
  ignoreSsl: boolean;
};

type Mailbox = {
  id: string;
  sourceUser: string;
  sourcePass: string;
  targetUser: string;
  targetPass: string;
  sync: boolean;
  backup: boolean;
};

type Tab = 'access-data' | 'csv-upload';
type BackupInterval = 'monthly' | 'weekly' | 'daily';

function newMailbox(over: Partial<Mailbox> = {}): Mailbox {
  return {
    id: crypto.randomUUID(),
    sourceUser: '',
    sourcePass: '',
    targetUser: '',
    targetPass: '',
    sync: false,
    backup: false,
    ...over,
  };
}

function initialMailboxes(): Mailbox[] {
  return [newMailbox(), newMailbox(), newMailbox()];
}

const defaultServer = (host = ''): Server => ({
  host,
  port: 993,
  security: 'SSL/TLS',
  ignoreSsl: false,
});

export function BulkStep1() {
  const navigate = useNavigate();
  const bulkWizard = useBulkWizard();

  // ----- Form state — seed from wizard store on mount so refreshing or
  // navigating back from Step 2 keeps the user's pairs intact (within the
  // 10-minute idle window).
  const [source, setSource] = useState<Server>(() =>
    bulkWizard.source.host ? bulkWizard.source : defaultServer(),
  );
  const [target, setTarget] = useState<Server>(() =>
    bulkWizard.target.host ? bulkWizard.target : defaultServer(),
  );
  const [mailboxes, setMailboxes] = useState<Mailbox[]>(() =>
    bulkWizard.pairs.length > 0 ? bulkWizard.pairs : initialMailboxes(),
  );
  const [tab, setTab] = useState<Tab>('access-data');
  const [backupInterval, setBackupInterval] = useState<BackupInterval>(
    bulkWizard.settings.backupInterval,
  );

  // Error states
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [targetError, setTargetError] = useState<string | null>(null);

  // CSV banners
  const [csvSuccess, setCsvSuccess] = useState<string | null>(null);
  const [csvError, setCsvError] = useState<string | null>(null);

  // Validation modal
  const [validating, setValidating] = useState(false);
  const [validationLogs, setValidationLogs] = useState<
    { text: string; kind: 'info' | 'error' | 'success' }[]
  >([]);
  /** When validation finishes with failures we keep the modal open so the
   *  user can read the log. `closable` flips on so the X / Close buttons
   *  appear; `submittedOnSuccess` flips when the bulk migration actually
   *  ships, used to suppress the inline Close button. */
  const [validationDone, setValidationDone] = useState<'idle' | 'failed' | 'success'>('idle');
  /** Per-row validation errors keyed by mailbox.id. Drives the red ring
   *  highlight on failed rows in the Access Data table. */
  const [rowErrors, setRowErrors] = useState<Record<string, { source?: string; target?: string }>>(
    {},
  );

  useSidebarTitle('Bulk Migration');
  useSidebarIcon(Layers);

  // ----- Derived ----------------------------------------------------------
  const validPairs = useMemo(
    () => mailboxes.filter((m) => m.sourceUser && m.sourcePass && m.targetUser && m.targetPass),
    [mailboxes],
  );

  // ----- Mailbox table operations ----------------------------------------
  const addRow = () => setMailboxes((rows) => [...rows, newMailbox()]);
  const removeRow = (id: string) =>
    setMailboxes((rows) => {
      const next = rows.filter((r) => r.id !== id);
      // Keep at least 1 row so the table never looks empty.
      return next.length === 0 ? [newMailbox()] : next;
    });
  const updateRow = (id: string, patch: Partial<Mailbox>) =>
    setMailboxes((rows) => rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const toggleAll = (key: 'sync' | 'backup') =>
    setMailboxes((rows) => {
      const allOn = rows.every((r) => r[key]);
      return rows.map((r) => ({ ...r, [key]: !allOn }));
    });
  const deleteAllRows = () => setMailboxes([newMailbox()]);

  // ----- CSV parsing (client-side only) -----------------------------------
  /** Parses a CSV with headers source_user, source_pass, target_user,
   *  target_pass, sync, backup. Returns either rows or an error message.
   *  Matches the mockup spec, plus is forgiving about quoted values and
   *  windows-style line endings. */
  const parseCSV = (text: string): { rows?: Mailbox[]; error?: string } => {
    const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
    if (lines.length < 2)
      return { error: 'CSV must contain a header row and at least one data row.' };

    const headers = (lines[0] ?? '').split(',').map((h) => h.trim().toLowerCase());
    const required = ['source_user', 'source_pass', 'target_user', 'target_pass'];
    const missing = required.filter((r) => !headers.includes(r));
    if (missing.length) return { error: `Missing required columns: ${missing.join(', ')}` };

    const truthy = (v: string | undefined): boolean => {
      if (!v) return false;
      const s = v.trim().toLowerCase();
      return s === '1' || s === 'true' || s === 'yes';
    };

    const rows: Mailbox[] = [];
    for (let i = 1; i < lines.length; i++) {
      const values = (lines[i] ?? '').split(',').map((v) => v.trim());
      const get = (k: string) => values[headers.indexOf(k)] ?? '';
      const su = get('source_user');
      const tu = get('target_user');
      if (!su && !tu) continue; // skip blank
      rows.push(
        newMailbox({
          sourceUser: su,
          sourcePass: get('source_pass'),
          targetUser: tu,
          targetPass: get('target_pass'),
          sync: truthy(get('sync')),
          backup: truthy(get('backup')),
        }),
      );
    }
    if (rows.length === 0) return { error: 'No valid data rows found in CSV.' };
    if (rows.length > 500) return { error: 'CSV exceeds the 500 entry limit.' };
    return { rows };
  };

  const handleCsvFile = (file: File) => {
    setCsvError(null);
    setCsvSuccess(null);
    if (!file.name.toLowerCase().endsWith('.csv')) {
      setCsvError('Invalid file type. Please upload a .csv file.');
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      const result = parseCSV(String(e.target?.result ?? ''));
      if (result.error) {
        setCsvError(result.error);
        return;
      }
      const rows = result.rows!;
      setMailboxes(rows);
      setCsvSuccess(
        `"${file.name}" imported — ${rows.length} ${rows.length === 1 ? 'entry' : 'entries'} loaded.`,
      );
      // Mockup auto-switches to Access Data so the user can review/edit.
      setTab('access-data');
    };
    reader.onerror = () => setCsvError('Failed to read the file. Please try again.');
    reader.readAsText(file);
  };

  /** Generates the same CSV template the mockup offers, downloaded via a
   *  blob URL so we don't need to round-trip the server. */
  const downloadSampleCsv = () => {
    const csv =
      'source_user,source_pass,target_user,target_pass,sync,backup\n' +
      'user1@source.com,pass1,user1@target.com,pass1,1,0\n' +
      'user2@source.com,pass2,user2@target.com,pass2,1,1\n';
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'bulk_migration_template.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  // ----- Reset & Validate -------------------------------------------------
  const resetAll = () => {
    setSource(defaultServer());
    setTarget(defaultServer());
    setMailboxes(initialMailboxes());
    setBackupInterval('monthly');
    setSourceError(null);
    setTargetError(null);
    setCsvSuccess(null);
    setCsvError(null);
  };

  /** Validate every mailbox pair against the live IMAP servers BEFORE
   *  submitting the bulk migration. Loops sequentially through `validPairs`
   *  calling `/api/imap/test-connection` for each pair's source and target
   *  credentials. Failed checks are recorded into `rowErrors` so the table
   *  can highlight them with a red ring; the modal stays open so the user
   *  can read the failure log and click Close to investigate.
   *
   *  This is intentionally per-pair (not a single "test pair[0]" sample) —
   *  the mockup advertises row-by-row credential validation and users will
   *  be confused if Row 2's bad password sneaks through and only blows up
   *  in the worker hours later. Sequential keeps the log readable; for
   *  large bulks (>50) consider parallelising with a concurrency limit. */
  const checkMailboxes = async () => {
    setSourceError(null);
    setTargetError(null);
    setRowErrors({});

    if (!source.host || !target.host) {
      setSourceError(!source.host ? 'Source server hostname is required.' : null);
      setTargetError(!target.host ? 'Target server hostname is required.' : null);
      return;
    }
    if (validPairs.length === 0) {
      setCsvError('Add at least one complete mailbox row before continuing.');
      return;
    }

    setValidating(true);
    setValidationDone('idle');
    setValidationLogs([]);

    const log = (text: string, kind: 'info' | 'error' | 'success' = 'info') =>
      setValidationLogs((arr) => [...arr, { text, kind }]);

    const failures: Record<string, { source?: string; target?: string }> = {};

    log(`Validating ${validPairs.length} mailbox pair${validPairs.length === 1 ? '' : 's'}…`);
    log(`Source: ${source.host}:${source.port} (${source.security})`);
    log(`Target: ${target.host}:${target.port} (${target.security})`);

    for (let i = 0; i < validPairs.length; i++) {
      const pair = validPairs[i]!;
      const rowLabel = `Row ${i + 1}`;

      // ---- Source credentials ----
      log(`${rowLabel}: Verifying ${pair.sourceUser} on ${source.host}…`);
      try {
        const src = await api.testConnection({
          host: source.host,
          port: source.port,
          security: source.security,
          username: pair.sourceUser,
          password: pair.sourcePass,
        });
        if (!src.ok) throw new Error(src.error ?? 'Authentication failed');
        log(`${rowLabel}: Source credentials OK.`, 'success');
      } catch (e: any) {
        const msg = e?.message ?? 'Connection failed';
        log(`${rowLabel}: Source failed — ${msg}`, 'error');
        failures[pair.id] = { ...failures[pair.id], source: msg };
        // Skip target check for this pair — already broken.
        continue;
      }

      // ---- Target credentials ----
      log(`${rowLabel}: Verifying ${pair.targetUser} on ${target.host}…`);
      try {
        const tgt = await api.testConnection({
          host: target.host,
          port: target.port,
          security: target.security,
          username: pair.targetUser,
          password: pair.targetPass,
        });
        if (!tgt.ok) throw new Error(tgt.error ?? 'Authentication failed');
        log(`${rowLabel}: Target credentials OK.`, 'success');
      } catch (e: any) {
        const msg = e?.message ?? 'Connection failed';
        log(`${rowLabel}: Target failed — ${msg}`, 'error');
        failures[pair.id] = { ...failures[pair.id], target: msg };
      }
    }

    // ---- Decision: succeed or stay open with failures ----
    const failedCount = Object.keys(failures).length;
    if (failedCount > 0) {
      setRowErrors(failures);
      log(
        `Validation failed for ${failedCount} ${failedCount === 1 ? 'row' : 'rows'}. Fix the highlighted entries and retry.`,
        'error',
      );
      setValidationDone('failed');
      // Leave `validating = true` so the modal stays open until the user
      // dismisses it. The Close button is rendered when validationDone !== 'idle'.
      return;
    }

    // Persist the validated form into the bulk wizard store so Step 2 can
    // pick it up without re-asking for passwords. We DON'T create the bulk
    // migration yet — that happens after the user reviews settings/filter
    // on Step 2 and clicks "Start Your Migration".
    log('All mailboxes validated. Continuing to review…', 'success');
    bulkWizard.setSource(source);
    bulkWizard.setTarget(target);
    bulkWizard.setPairs(
      validPairs.map((m) => ({
        id: m.id,
        sourceUser: m.sourceUser,
        sourcePass: m.sourcePass,
        targetUser: m.targetUser,
        targetPass: m.targetPass,
        sync: m.sync,
        backup: m.backup,
      })),
    );
    bulkWizard.setSettings({ backupInterval });
    bulkWizard.markValidated();
    setValidationDone('success');
    await pause(900);
    navigate('/bulk/new/step2');
  };

  /** User-initiated close of the validation modal after a run finished. */
  const closeValidationModal = () => {
    setValidating(false);
    setValidationDone('idle');
  };

  // Wire the sticky footer.
  useFooter(
    <div className="w-full flex flex-col items-center">
      <button
        onClick={checkMailboxes}
        disabled={validating}
        className="w-full max-w-4xl bg-primary-container hover:bg-primary-dark text-white rounded-lg py-3.5 flex items-center justify-center font-bold text-[15px] shadow-md hover:shadow-lg transition-all duration-200 group cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
      >
        <div className="w-full flex items-center px-4 relative">
          <Check
            className="h-5 w-5 absolute left-4 group-hover:scale-110 transition-transform text-white"
            strokeWidth={2.5}
          />
          <span className="flex-1 text-center font-bold">
            {validating ? 'Checking…' : 'Check Mailboxes'}
          </span>
        </div>
      </button>
      <button
        onClick={resetAll}
        disabled={validating}
        className="mt-3 text-slate-400 hover:text-primary text-xs font-bold transition-colors cursor-pointer select-none disabled:opacity-50"
      >
        Reset All
      </button>
    </div>,
    [validating, validPairs.length, source, target, backupInterval, mailboxes],
  );

  return (
    <div className="max-w-5xl mx-auto space-y-8">
      {/* Mobile title */}
      <div className="md:hidden px-2 mb-2">
        <h2 className="text-2xl font-bold text-primary-dark">Bulk Migration</h2>
      </div>

      {/* Section 1: Server Settings */}
      <div className="space-y-4">
        <h3 className="text-primary-dark font-extrabold text-lg">Server Settings:</h3>
        <div className="border border-slate-200/80 rounded-xl bg-white shadow-sm overflow-hidden">
          <div className="p-6 md:p-8">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <ServerCard
                label="Source Server (IMAP)*"
                value={source}
                onChange={setSource}
                error={sourceError}
                errorTitle="Source connection failed!"
                errorBody="Could not connect to source mail server. Please verify the hostname and credentials below."
              />
              <ServerCard
                label="Target Server (IMAP)*"
                value={target}
                onChange={setTarget}
                error={targetError}
                errorTitle="Target connection failed!"
                errorBody="Could not connect to target mail server. Please verify the hostname and credentials below."
              />
            </div>
          </div>
        </div>
      </div>

      {/* Section 2: Mailboxes */}
      <div className="space-y-4">
        <h3 className="text-primary-dark font-extrabold text-lg">Mailboxes:</h3>
        <div className="border border-slate-200/80 rounded-xl bg-white shadow-sm overflow-hidden">
          <div className="p-6 md:p-8 space-y-6">
            {/* Tabs */}
            <div className="flex bg-slate-100 p-1 rounded-xl border border-slate-200/50">
              <TabButton active={tab === 'access-data'} onClick={() => setTab('access-data')}>
                Access Data
              </TabButton>
              <TabButton active={tab === 'csv-upload'} onClick={() => setTab('csv-upload')}>
                CSV Upload
              </TabButton>
            </div>

            {/* Tab content: Access Data */}
            {tab === 'access-data' && (
              <div className="space-y-4">
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse min-w-[800px]">
                    <thead>
                      <tr className="border-b border-slate-200/60 text-primary-dark font-extrabold text-[12px] uppercase tracking-wider">
                        <th className="pb-3 pr-4 w-[25%]">Source User</th>
                        <th className="pb-3 pr-4 w-[20%]">Source Password</th>
                        <th className="pb-3 pr-4 w-[25%]">Target User</th>
                        <th className="pb-3 pr-4 w-[20%]">Target Password</th>
                        <th className="pb-3 pr-2 text-center w-[5%]">Sync</th>
                        <th className="pb-3 pr-2 text-center w-[5%]">Backup</th>
                        <th className="pb-3 w-[5%]"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {mailboxes.map((m) => (
                        <MailboxRow
                          key={m.id}
                          mb={m}
                          error={rowErrors[m.id]}
                          onChange={(patch) => updateRow(m.id, patch)}
                          onDelete={() => removeRow(m.id)}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="pt-2">
                  <button
                    onClick={addRow}
                    className="px-4 py-2.5 border border-primary/20 hover:bg-slate-50 text-primary-dark font-bold text-[13px] rounded-lg shadow-sm transition-colors flex items-center"
                  >
                    <Plus className="h-4 w-4 mr-1.5" strokeWidth={2.5} />
                    Add Entry
                  </button>
                </div>
              </div>
            )}

            {/* Tab content: CSV Upload */}
            {tab === 'csv-upload' && (
              <div className="space-y-6">
                {csvSuccess && (
                  <Banner kind="success" onClose={() => setCsvSuccess(null)}>
                    <p className="font-bold text-sm">{csvSuccess}</p>
                    <p className="text-emerald-600 text-xs font-medium">
                      Data has been populated in the Access Data tab. You can edit entries before
                      proceeding.
                    </p>
                  </Banner>
                )}
                {csvError && (
                  <Banner kind="error" onClose={() => setCsvError(null)}>
                    <p className="font-bold text-sm">{csvError}</p>
                  </Banner>
                )}

                <CsvDropzone onFile={handleCsvFile} />

                <div className="bg-primary/5 rounded-xl p-5 border border-primary/10 space-y-2">
                  <h4 className="font-bold text-primary text-sm flex items-center">
                    <Info className="h-4.5 w-4.5 mr-2" strokeWidth={2.5} />
                    CSV File Requirements
                  </h4>
                  <p className="text-slate-600 text-xs leading-relaxed font-semibold">
                    Your CSV file must include the following headers exactly:{' '}
                    {(
                      [
                        'source_user',
                        'source_pass',
                        'target_user',
                        'target_pass',
                        'sync',
                        'backup',
                      ] as const
                    ).map((c, i, arr) => (
                      <span key={c}>
                        <code className="bg-white/80 border border-slate-200 px-1.5 py-0.5 rounded text-primary font-mono text-[11px]">
                          {c}
                        </code>
                        {i < arr.length - 1 ? ', ' : '.'}
                      </span>
                    ))}
                  </p>
                  <div className="pt-2">
                    <button
                      onClick={downloadSampleCsv}
                      className="text-xs text-blue-500 hover:text-blue-600 font-bold flex items-center"
                    >
                      <Download className="h-4 w-4 mr-1" strokeWidth={2} />
                      Download Sample Template
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Mailboxes Footer Controls */}
            <div className="border-t border-slate-100 pt-6 flex flex-col lg:flex-row lg:items-center justify-between gap-6">
              <div className="flex items-center space-x-6 flex-wrap gap-y-2">
                <span className="font-extrabold text-primary text-[14px]">Backup Interval:</span>
                <div className="flex items-center space-x-5">
                  {(['monthly', 'weekly', 'daily'] as const).map((v) => (
                    <label
                      key={v}
                      className="flex items-center space-x-2 cursor-pointer select-none"
                    >
                      <input
                        type="radio"
                        name="backup-interval"
                        checked={backupInterval === v}
                        onChange={() => setBackupInterval(v)}
                        className="w-4 h-4 text-primary border-slate-300 cursor-pointer"
                      />
                      <span className="text-slate-600 font-bold text-xs capitalize">{v}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <QuickActionButton onClick={() => toggleAll('sync')}>
                  <RefreshCw className="h-4 w-4 mr-1" strokeWidth={2} />
                  Sync All
                </QuickActionButton>
                <QuickActionButton onClick={() => toggleAll('backup')}>
                  <Layers className="h-4 w-4 mr-1" strokeWidth={2} />
                  Backup All
                </QuickActionButton>
                <QuickActionButton onClick={deleteAllRows} danger>
                  <Trash2 className="h-4 w-4 mr-1" strokeWidth={2} />
                  Delete All
                </QuickActionButton>
              </div>
            </div>
          </div>
        </div>
      </div>

      <ValidationModal
        open={validating}
        logs={validationLogs}
        done={validationDone}
        onClose={closeValidationModal}
      />
    </div>
  );
}

// -----------------------------------------------------------------------------
// Server card (source / target with advanced settings + error box)
// -----------------------------------------------------------------------------

function ServerCard({
  label,
  value,
  onChange,
  error,
  errorTitle,
  errorBody,
}: {
  label: string;
  value: Server;
  onChange: (s: Server) => void;
  error: string | null;
  errorTitle: string;
  errorBody: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-4">
      <div
        className={cn(
          'bg-white border rounded-xl p-3 shadow-sm transition-colors',
          error
            ? 'border-red-500 ring-1 ring-red-500/10'
            : 'border-slate-200/80 focus-within:border-primary/50',
        )}
      >
        <label className="block text-slate-400 font-extrabold text-[10px] uppercase tracking-wider mb-1">
          {label}
        </label>
        <input
          type="text"
          placeholder="Mailserver Address"
          value={value.host}
          onChange={(e) => onChange({ ...value, host: e.target.value })}
          className="w-full bg-transparent text-primary font-bold text-[15px] outline-none placeholder:text-slate-300"
        />
      </div>

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full text-left bg-primary/5 px-4 py-3.5 border border-slate-200/60 rounded-xl flex items-center justify-between hover:bg-primary/10 transition-colors shadow-sm"
      >
        <span className="font-bold text-primary text-[14px]">Advanced Settings</span>
        <div className="bg-white rounded-full p-1 border border-slate-200/60 shadow-sm">
          <ChevronDown
            className={cn(
              'h-4 w-4 text-primary transition-transform duration-300',
              open && 'rotate-180',
            )}
            strokeWidth={2.5}
          />
        </div>
      </button>

      {open && (
        <div className="p-5 bg-slate-50/40 border border-slate-200/60 rounded-xl space-y-4 shadow-inner">
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-white border border-slate-200/80 rounded-xl p-3 shadow-sm">
              <label className="block text-primary-dark font-bold text-[11px] mb-0.5">Port</label>
              <input
                type="number"
                value={value.port}
                onChange={(e) => onChange({ ...value, port: Number(e.target.value) || 0 })}
                className="w-full bg-transparent text-primary font-bold text-[14px] outline-none"
              />
            </div>
            <div className="bg-white border border-slate-200/80 rounded-xl p-3 shadow-sm">
              <label className="block text-primary-dark font-bold text-[11px] mb-0.5">
                Security
              </label>
              <select
                value={value.security}
                onChange={(e) => onChange({ ...value, security: e.target.value as Security })}
                className="w-full bg-transparent text-primary text-[14px] font-semibold outline-none cursor-pointer"
              >
                <option value="SSL/TLS">SSL/TLS</option>
                <option value="STARTTLS">STARTTLS</option>
                <option value="None">None</option>
              </select>
            </div>
          </div>
          <label className="flex items-center space-x-3 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={value.ignoreSsl}
              onChange={(e) => onChange({ ...value, ignoreSsl: e.target.checked })}
              className="w-4 h-4 rounded text-primary border-slate-300 cursor-pointer"
            />
            <span className="text-slate-600 font-semibold text-xs">Ignore SSL Warnings</span>
          </label>
        </div>
      )}

      {error && (
        <div className="bg-[#D32F2F] text-white rounded-xl p-4 space-y-2.5 shadow-md text-[12px] leading-relaxed">
          <p className="font-bold text-[14px]">{errorTitle}</p>
          <p className="text-white/90 font-medium">{errorBody}</p>
          <div className="bg-white rounded-lg p-2.5 text-[11px] leading-normal text-slate-800">
            <p className="font-bold text-red-600 mb-0.5">Response:</p>
            <p className="text-red-600 italic break-words">&ldquo;{error}&rdquo;</p>
          </div>
        </div>
      )}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Mailbox row
// -----------------------------------------------------------------------------

function MailboxRow({
  mb,
  error,
  onChange,
  onDelete,
}: {
  mb: Mailbox;
  error?: { source?: string; target?: string };
  onChange: (patch: Partial<Mailbox>) => void;
  onDelete: () => void;
}) {
  const base =
    'w-full bg-white border rounded-lg py-2 px-3 text-sm text-primary font-medium focus:outline-none shadow-sm';
  const ok = 'border-slate-200 focus:border-primary/50';
  const bad = 'border-red-400 ring-1 ring-red-300 focus:border-red-500';
  const srcCls = cn(base, error?.source ? bad : ok);
  const tgtCls = cn(base, error?.target ? bad : ok);
  return (
    <tr
      className={cn(
        'border-b border-slate-100 last:border-0 hover:bg-slate-50/40 transition-colors',
        (error?.source || error?.target) && 'bg-red-50/30',
      )}
      title={
        error?.source
          ? `Source: ${error.source}`
          : error?.target
            ? `Target: ${error.target}`
            : undefined
      }
    >
      <td className="py-3 pr-4">
        <input
          type="text"
          placeholder="user@source.com"
          value={mb.sourceUser}
          onChange={(e) => onChange({ sourceUser: e.target.value })}
          className={srcCls}
        />
      </td>
      <td className="py-3 pr-4">
        <input
          type="password"
          placeholder="••••••••"
          value={mb.sourcePass}
          onChange={(e) => onChange({ sourcePass: e.target.value })}
          className={srcCls}
        />
      </td>
      <td className="py-3 pr-4">
        <input
          type="text"
          placeholder="user@target.com"
          value={mb.targetUser}
          onChange={(e) => onChange({ targetUser: e.target.value })}
          className={tgtCls}
        />
      </td>
      <td className="py-3 pr-4">
        <input
          type="password"
          placeholder="••••••••"
          value={mb.targetPass}
          onChange={(e) => onChange({ targetPass: e.target.value })}
          className={tgtCls}
        />
      </td>
      <td className="py-3 pr-2 text-center">
        <input
          type="checkbox"
          checked={mb.sync}
          onChange={(e) => onChange({ sync: e.target.checked })}
          className="w-4 h-4 rounded text-primary border-slate-300 cursor-pointer"
        />
      </td>
      <td className="py-3 pr-2 text-center">
        <input
          type="checkbox"
          checked={mb.backup}
          onChange={(e) => onChange({ backup: e.target.checked })}
          className="w-4 h-4 rounded text-primary border-slate-300 cursor-pointer"
        />
      </td>
      <td className="py-3 text-right">
        <button
          onClick={onDelete}
          aria-label="Delete row"
          className="p-1.5 text-slate-400 hover:text-red-500 rounded-lg hover:bg-red-50 transition-all"
        >
          <Trash2 className="h-4 w-4" strokeWidth={2} />
        </button>
      </td>
    </tr>
  );
}

// -----------------------------------------------------------------------------
// Misc sub-components
// -----------------------------------------------------------------------------

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex-1 py-2.5 text-sm rounded-lg transition-all',
        active
          ? 'bg-white shadow-sm text-primary font-bold border border-slate-100'
          : 'text-slate-500 font-semibold hover:text-primary',
      )}
    >
      {children}
    </button>
  );
}

function QuickActionButton({
  onClick,
  danger,
  children,
}: {
  onClick: () => void;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'px-4 py-2 border font-bold text-xs rounded-lg shadow-sm transition-colors flex items-center',
        danger
          ? 'border-red-200/80 hover:bg-red-50 text-red-600'
          : 'border-primary/20 hover:bg-slate-50 text-primary-dark',
      )}
    >
      {children}
    </button>
  );
}

function Banner({
  kind,
  onClose,
  children,
}: {
  kind: 'success' | 'error';
  onClose: () => void;
  children: React.ReactNode;
}) {
  const palette =
    kind === 'success'
      ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
      : 'bg-red-50 border-red-200 text-red-700';
  const iconBg = kind === 'success' ? 'bg-emerald-500' : 'bg-red-500';
  return (
    <div className={cn('border rounded-xl p-4 flex items-center justify-between', palette)}>
      <div className="flex items-center gap-3 flex-1 min-w-0">
        <div className={cn('rounded-full p-1 flex items-center justify-center shrink-0', iconBg)}>
          {kind === 'success' ? (
            <Check className="h-4 w-4 text-white" strokeWidth={3} />
          ) : (
            <X className="h-4 w-4 text-white" strokeWidth={3} />
          )}
        </div>
        <div className="flex-1 min-w-0">{children}</div>
      </div>
      <button
        onClick={onClose}
        aria-label="Dismiss"
        className="opacity-60 hover:opacity-100 p-1 shrink-0"
      >
        <X className="h-4 w-4" strokeWidth={2} />
      </button>
    </div>
  );
}

function CsvDropzone({ onFile }: { onFile: (f: File) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  return (
    <div
      onClick={() => inputRef.current?.click()}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={(e) => {
        e.preventDefault();
        setDragOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const f = e.dataTransfer.files?.[0];
        if (f) onFile(f);
      }}
      className={cn(
        'border-2 border-dashed rounded-2xl p-10 flex flex-col items-center justify-center space-y-3 cursor-pointer transition-all',
        dragOver
          ? 'border-primary/60 bg-primary/10'
          : 'border-slate-200 hover:border-primary/40 bg-slate-50/20 hover:bg-primary/5',
      )}
    >
      <div className="bg-primary/5 text-primary rounded-full p-4">
        <Upload className="h-8 w-8" strokeWidth={2} />
      </div>
      <div className="text-center">
        <p className="text-primary font-bold text-[15px]">
          Drag and drop your CSV file here, or{' '}
          <span className="text-blue-500 hover:underline">browse</span>
        </p>
        <p className="text-slate-400 text-xs mt-1 font-medium">
          Supports .csv files with up to 500 entries
        </p>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept=".csv,text/csv"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          // Reset so the same file can be re-uploaded if user wants to retry
          e.target.value = '';
        }}
      />
    </div>
  );
}

function ValidationModal({
  open,
  logs,
  done,
  onClose,
}: {
  open: boolean;
  logs: { text: string; kind: 'info' | 'error' | 'success' }[];
  done: 'idle' | 'failed' | 'success';
  onClose: () => void;
}) {
  const logsRef = useRef<HTMLDivElement>(null);
  // Auto-scroll to bottom on new log
  useEffect(() => {
    if (logsRef.current) logsRef.current.scrollTop = logsRef.current.scrollHeight;
  }, [logs]);

  if (!open) return null;
  const finished = done !== 'idle';
  const failed = done === 'failed';
  return (
    <div className="fixed inset-0 bg-slate-900/70 backdrop-blur-md flex items-center justify-center z-[100] p-4">
      <div className="relative bg-slate-900 border border-slate-800 rounded-3xl p-8 max-w-lg w-full mx-4 shadow-2xl">
        {/* Close X — only while a run has completed; we don't want the user
            killing the modal mid-validation and losing the state. */}
        {finished && (
          <button
            onClick={onClose}
            aria-label="Close"
            className="absolute top-4 right-4 text-slate-400 hover:text-white transition-colors p-1.5 rounded-full hover:bg-slate-800"
          >
            <X className="h-5 w-5" />
          </button>
        )}

        <div className="flex flex-col items-center text-center">
          {finished ? (
            <div
              className={cn(
                'h-12 w-12 mb-6 rounded-full flex items-center justify-center',
                failed ? 'bg-red-500/20' : 'bg-emerald-500/20',
              )}
            >
              {failed ? (
                <X className="h-7 w-7 text-red-400" strokeWidth={3} />
              ) : (
                <Check className="h-7 w-7 text-emerald-400" strokeWidth={3} />
              )}
            </div>
          ) : (
            <Loader2 className="h-12 w-12 text-white/90 mb-6 animate-spin" strokeWidth={2} />
          )}
          <div className="w-full space-y-4">
            <h3 className="font-bold text-lg md:text-xl tracking-wide text-white">
              {finished
                ? failed
                  ? 'Validation finished with errors'
                  : 'All mailboxes validated'
                : 'Validating configurations…'}
            </h3>
            <div
              ref={logsRef}
              className="bg-slate-950/60 rounded-xl p-4 text-[12px] text-slate-300 text-left font-mono space-y-2 max-h-64 overflow-y-auto"
            >
              {logs.length === 0 ? (
                <p className="text-slate-500 italic">Starting…</p>
              ) : (
                logs.map((l, i) => (
                  <p
                    key={i}
                    className={cn(
                      l.kind === 'error' && 'text-red-400 font-bold',
                      l.kind === 'success' && 'text-emerald-400 font-bold',
                      l.kind === 'info' && 'text-slate-300',
                    )}
                  >
                    {l.text}
                  </p>
                ))
              )}
            </div>
            {finished && (
              <button
                onClick={onClose}
                className={cn(
                  'w-full px-4 py-2.5 rounded-lg font-bold text-sm transition-colors',
                  failed
                    ? 'bg-red-600 hover:bg-red-700 text-white'
                    : 'bg-emerald-600 hover:bg-emerald-700 text-white',
                )}
              >
                {failed ? 'Close' : 'OK'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// Tiny promise sleep utility for staging the validation modal so the user
// can read the log lines as they print.
function pause(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
