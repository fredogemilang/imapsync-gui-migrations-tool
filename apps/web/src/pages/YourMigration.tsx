import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '@/lib/api';
import { formatBytes } from '@/lib/utils';

export function YourMigration() {
  const { id } = useParams();
  const [data, setData] = useState<any>(null);
  const [logs, setLogs] = useState<any[]>([]);

  useEffect(() => {
    if (!id) return;
    api.getMigration(id).then(setData);
    api
      .getLogs(id)
      .then(setLogs)
      .catch(() => {});
  }, [id]);

  if (!data) return <div className="p-8">Loading…</div>;

  return (
    <div className="max-w-5xl mx-auto space-y-8">
      <div className="flex items-center justify-between">
        <h2 className="text-primary-dark font-extrabold text-2xl">Migration Details</h2>
        <Link to="/" className="text-sm font-bold text-primary hover:text-primary-dark">
          ← Back
        </Link>
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <Card title="Source" body={`${data.source?.username}\n${data.source?.host}`} />
        <Card title="Target" body={`${data.target?.username}\n${data.target?.host}`} />
      </div>

      <div className="bg-white border border-slate-200/80 rounded-xl shadow-sm divide-y divide-slate-100">
        <Stat label="Status" value={data.status} />
        <Stat label="Progress" value={`${data.progressPercent}%`} />
        <Stat label="Total emails" value={`${data.migratedEmails} / ${data.totalEmails}`} />
        <Stat label="Total size" value={formatBytes(data.totalBytes)} />
      </div>

      <div>
        <h3 className="text-primary-dark font-extrabold text-lg mb-4">Folder breakdown</h3>
        <div className="overflow-x-auto border border-slate-100 rounded-xl">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 border-b text-primary-dark">
                <th className="py-3 px-4 text-left font-bold">Folder</th>
                <th className="py-3 px-4 text-right font-bold w-32">Total Emails</th>
                <th className="py-3 px-4 text-right font-bold w-32">Migrated</th>
                <th className="py-3 px-4 text-right font-bold w-32">Size</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-primary">
              {(data.folders ?? []).map((f: any) => (
                <tr key={f.id}>
                  <td className="py-3 px-4 font-semibold">{f.name}</td>
                  <td className="py-3 px-4 text-right">{f.totalEmails}</td>
                  <td className="py-3 px-4 text-right">{f.migratedEmails}</td>
                  <td className="py-3 px-4 text-right">{formatBytes(f.totalBytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div>
        <h3 className="text-primary-dark font-extrabold text-lg mb-4">Logs</h3>
        <div className="bg-slate-900 text-slate-100 rounded-xl p-4 text-xs font-mono max-h-72 overflow-y-auto">
          {logs.length === 0 ? (
            <div className="text-slate-500">No logs yet.</div>
          ) : (
            logs.map((l) => (
              <div
                key={l.id}
                className={
                  l.level === 'error' ? 'text-red-400' : l.level === 'warn' ? 'text-amber-300' : ''
                }
              >
                [{new Date(l.ts).toLocaleTimeString()}] {l.message}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function Card({ title, body }: { title: string; body: string }) {
  return (
    <div className="bg-white border border-slate-200/85 rounded-xl shadow-sm overflow-hidden">
      <div className="bg-primary/5 px-5 py-4 border-b">
        <div className="text-primary font-bold text-[10px] tracking-wider uppercase">{title}</div>
      </div>
      <pre className="p-5 text-sm text-primary font-semibold whitespace-pre-wrap">{body}</pre>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between p-4 px-6">
      <span className="text-sm font-bold text-primary-dark">{label}</span>
      <span className="text-sm font-extrabold text-primary">{value}</span>
    </div>
  );
}
