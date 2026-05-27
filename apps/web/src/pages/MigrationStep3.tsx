import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowRight, Mail } from 'lucide-react';
import { api } from '@/lib/api';
import { formatBytes } from '@/lib/utils';

export function MigrationStep3() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [percent, setPercent] = useState(0);
  const [snapshot, setSnapshot] = useState<any>(null);
  const [folder, setFolder] = useState<{ name: string; index: number; total: number } | null>(null);
  const [speed, setSpeed] = useState<{ emailsPerSec: number; bytesPerSec: number }>({
    emailsPerSec: 0,
    bytesPerSec: 0,
  });
  const [status, setStatus] = useState<string>('queued');
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (!id) return;
    const es = new EventSource(`/api/migrations/${id}/events`, { withCredentials: true } as any);
    es.addEventListener('snapshot', (e) => {
      const d = JSON.parse((e as MessageEvent).data);
      setSnapshot(d);
      setPercent(d.progressPercent ?? 0);
      setStatus(d.status);
    });
    es.addEventListener('progress', (e) => {
      const d = JSON.parse((e as MessageEvent).data);
      if (d.kind === 'percent') setPercent(d.percent);
      if (d.kind === 'folder') setFolder({ name: d.name, index: d.index, total: d.total });
      if (d.kind === 'speed')
        setSpeed({ emailsPerSec: d.emailsPerSec, bytesPerSec: d.bytesPerSec });
      if (d.kind === 'status') setStatus(d.status);
      if (d.kind === 'done') {
        setStatus(d.ok ? 'completed' : 'failed');
        if (d.ok) setPercent(100);
      }
    });
    return () => es.close();
  }, [id]);

  const circumference = 534.07;
  const offset = circumference - (circumference * percent) / 100;
  const completed = status === 'completed';

  const toggleStop = async () => {
    if (!id) return;
    if (paused) {
      await api.resumeMigration(id);
      setPaused(false);
    } else {
      await api.stopMigration(id);
      setPaused(true);
    }
  };

  return (
    <div className="max-w-5xl mx-auto space-y-8 pb-12">
      <div className="space-y-2">
        <h2 className="text-3xl font-black text-primary-dark">
          {completed ? 'Migration Completed!' : 'Migrating Your Emails'}
        </h2>
        {snapshot?.source && (
          <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-6 text-sm font-semibold text-slate-600">
            <div>
              <span className="text-[10px] uppercase font-bold text-slate-500">FROM</span>{' '}
              <span className="text-primary-dark font-black ml-2">{snapshot.source.username}</span>
            </div>
            <div>
              <span className="text-[10px] uppercase font-bold text-slate-500">TO</span>{' '}
              <span className="text-primary-dark font-black ml-2">{snapshot.target.username}</span>
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center justify-center min-h-[220px] relative bg-slate-50/20 border border-slate-200/40 rounded-2xl p-6">
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
              className="text-blue-500 transition-all duration-300"
              strokeWidth="14"
              strokeDasharray={circumference}
              strokeDashoffset={offset}
              strokeLinecap="round"
              stroke="currentColor"
              fill="transparent"
            />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <Mail className="h-12 w-12 text-slate-400" strokeWidth={1.2} />
            <div className="flex items-baseline text-primary-dark mt-1">
              <span className="text-3xl font-black">{percent}</span>
              <span className="text-lg font-bold ml-1">%</span>
            </div>
            <span className="text-[10px] font-bold text-slate-400 uppercase">migrated</span>
          </div>
        </div>
      </div>

      <div className="max-w-md mx-auto bg-white border border-slate-200/80 rounded-xl shadow-sm divide-y divide-slate-100">
        <Stat label="Status" value={status} />
        <Stat
          label="Current Folder"
          value={folder ? `${folder.name} (${folder.index}/${folder.total})` : '—'}
        />
        <Stat label="Emails / sec" value={speed.emailsPerSec.toFixed(2)} />
        <Stat label="Data / sec" value={formatBytes(speed.bytesPerSec)} />
      </div>

      <div className="flex justify-center gap-3">
        {!completed && (
          <button
            onClick={toggleStop}
            className="px-8 py-2.5 border border-primary/20 hover:bg-slate-50 text-primary-dark font-bold text-sm rounded-lg shadow-sm"
          >
            {paused ? 'Resume Migration' : 'Stop Migration'}
          </button>
        )}
        {completed && (
          <button
            onClick={() => navigate(`/migrations/${id}`)}
            className="bg-blue-500 hover:bg-blue-600 text-white rounded-lg py-3 px-8 font-bold text-[15px] shadow-md flex items-center gap-2"
          >
            View Migration Details <ArrowRight className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between p-4 px-6">
      <span className="text-xs md:text-sm font-bold text-primary-dark">{label}:</span>
      <span className="text-sm font-extrabold text-primary">{value}</span>
    </div>
  );
}
