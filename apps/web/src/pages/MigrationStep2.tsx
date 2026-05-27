import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWizard } from '@/components/WizardContext';
import { api } from '@/lib/api';
import { SettingsPanel } from '@/components/SettingsPanel';
import { formatBytes } from '@/lib/utils';
import { ArrowRight, CheckCircle2, AlertTriangle } from 'lucide-react';

export function MigrationStep2() {
  const navigate = useNavigate();
  const { source, target, settings, setSettings } = useWizard();
  const [folders, setFolders] = useState<
    { name: string; totalEmails: number; totalBytes: number }[]
  >([]);
  const [showDetails, setShowDetails] = useState(false);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    api
      .scanFolders(source)
      .then((r) => setFolders(r.folders))
      .catch(() => setFolders([]));
    // intentional: scan only once on mount with the initial source from wizard
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const totalEmails = folders.reduce((a, f) => a + f.totalEmails, 0);
  const totalBytes = folders.reduce((a, f) => a + f.totalBytes, 0);

  const start = async () => {
    setCreating(true);
    try {
      const { id } = await api.createMigration({ source, target, settings });
      navigate(`/migrations/${id}/progress`);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="max-w-5xl mx-auto space-y-8 pb-32">
      <h3 className="text-primary-dark font-extrabold text-lg">Your Migration</h3>

      <div className="flex flex-col md:flex-row items-center gap-4 md:gap-6 justify-between relative">
        <AccountCard
          label="ORIGINAL ACCOUNT"
          username={source.username}
          size={formatBytes(totalBytes)}
          ok={`${totalEmails} emails, ${folders.length} folders`}
          onDetails={() => setShowDetails(true)}
        />
        <div className="bg-white rounded-full border border-slate-200 shadow-sm p-3 w-10 h-10 flex items-center justify-center">
          <ArrowRight className="h-5 w-5 text-primary" />
        </div>
        <AccountCard
          label="NEW ACCOUNT"
          username={target.username}
          size=""
          ok="Enough disk space"
          warn="Account ready"
        />
      </div>

      <SettingsPanel value={settings} onChange={setSettings} />

      {showDetails && <DetailsModal folders={folders} onClose={() => setShowDetails(false)} />}

      <div className="fixed bottom-[88px] md:bottom-0 inset-x-0 bg-white/80 backdrop-blur-md border-t pt-4 pb-6 px-4 md:px-10 z-10 md:ml-60 flex justify-center">
        <button
          onClick={start}
          disabled={creating}
          className="w-full max-w-4xl bg-primary-container hover:bg-primary-dark text-white rounded-lg py-3.5 font-bold text-[15px] shadow-md disabled:opacity-60"
        >
          {creating ? 'Starting…' : 'Start Your Migration'}
        </button>
      </div>
    </div>
  );
}

function AccountCard({
  label,
  username,
  size,
  ok,
  warn,
  onDetails,
}: {
  label: string;
  username: string;
  size?: string;
  ok?: string;
  warn?: string;
  onDetails?: () => void;
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
        {ok && (
          <div className="flex items-center text-[13px] font-semibold text-primary/80">
            <span className="bg-emerald-500 text-white rounded-full p-0.5 mr-2">
              <CheckCircle2 className="h-3.5 w-3.5" />
            </span>
            {ok}
            {onDetails && (
              <button
                onClick={onDetails}
                className="ml-3 bg-slate-200 hover:bg-slate-300 text-slate-600 font-bold text-[11px] px-2.5 py-1 rounded-full"
              >
                Details
              </button>
            )}
          </div>
        )}
        {warn && (
          <div className="flex items-center text-[13px] font-semibold text-primary/80">
            <span className="bg-amber-500 text-white rounded-full p-0.5 mr-2">
              <AlertTriangle className="h-3.5 w-3.5" />
            </span>
            {warn}
          </div>
        )}
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
          <h2 className="text-xl font-bold text-primary">Scanned Folders & Emails</h2>
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200 text-primary-dark">
                <th className="py-3 px-4 text-left font-bold">Folder</th>
                <th className="py-3 px-4 text-right font-bold w-32">Total Emails</th>
                <th className="py-3 px-4 text-right font-bold w-32">Size</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-primary">
              {folders.map((f, i) => (
                <tr key={i} className="hover:bg-slate-50/50">
                  <td className="py-3 px-4 font-semibold">{f.name}</td>
                  <td className="py-3 px-4 text-right">{f.totalEmails}</td>
                  <td className="py-3 px-4 text-right">{formatBytes(f.totalBytes)}</td>
                </tr>
              ))}
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
