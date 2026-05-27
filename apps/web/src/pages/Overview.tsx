import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, Plus, CheckCircle2, Clock, XCircle } from 'lucide-react';
import { api } from '@/lib/api';

export function Overview() {
  const [items, setItems] = useState<any[]>([]);

  useEffect(() => {
    api
      .listMigrations()
      .then(setItems)
      .catch(() => setItems([]));
  }, []);

  return (
    <div className="max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-primary-dark font-extrabold text-2xl">Your Migrations</h2>
        <Link
          to="/migrations/new"
          className="flex items-center gap-2 bg-primary-container hover:bg-primary-dark text-white rounded-lg px-4 py-2.5 font-bold text-sm shadow-md"
        >
          <Plus className="h-4 w-4" /> New Migration
        </Link>
      </div>
      {items.length === 0 ? (
        <div className="startup-card rounded-2xl p-10 text-center text-slate-500">
          <p className="font-bold mb-1">No migrations yet</p>
          <p className="text-sm">Click &ldquo;New Migration&rdquo; to start.</p>
        </div>
      ) : (
        items.map((m) => (
          <Link
            key={m.id}
            to={`/migrations/${m.id}`}
            className="startup-card rounded-2xl flex items-stretch mb-4 hover:-translate-y-1 hover:shadow-lg transition-all duration-300 overflow-hidden"
          >
            <div className="pl-6 pr-4 py-6 flex items-center">
              <StatusIcon status={m.status} />
            </div>
            <div className="flex-1 flex flex-col md:flex-row md:items-center py-3 md:py-0 min-w-0">
              <div className="flex-1 md:py-6 px-2 min-w-0">
                <div className="text-[10px] md:text-xs font-medium text-slate-400">
                  FROM {m.sourceHost}
                </div>
                <div className="text-[15px] text-primary font-medium truncate">
                  {m.sourceUsername}
                </div>
              </div>
              <ChevronRight className="hidden md:block h-5 w-5 text-slate-300 mx-4" />
              <div className="flex-1 md:py-6 px-2 min-w-0">
                <div className="text-[10px] md:text-xs font-medium text-slate-400">
                  TO {m.targetHost}
                </div>
                <div className="text-[15px] text-primary font-medium truncate">
                  {m.targetUsername}
                </div>
              </div>
              <div className="md:py-6 px-4 text-right">
                <div className="text-[10px] uppercase font-bold text-slate-400">Progress</div>
                <div className="text-primary-dark font-extrabold">{m.progressPercent}%</div>
              </div>
            </div>
            <div className="px-6 border-l border-slate-100 flex items-center bg-slate-50/50">
              <ChevronRight className="h-5 w-5 text-primary" />
            </div>
          </Link>
        ))
      )}
    </div>
  );
}

function StatusIcon({ status }: { status: string }) {
  if (status === 'completed')
    return (
      <div className="bg-emerald-500 rounded-full p-1.5">
        <CheckCircle2 className="h-4 w-4 text-white" />
      </div>
    );
  if (status === 'failed' || status === 'cancelled')
    return (
      <div className="bg-red-500 rounded-full p-1.5">
        <XCircle className="h-4 w-4 text-white" />
      </div>
    );
  return (
    <div className="bg-amber-500 rounded-full p-1.5">
      <Clock className="h-4 w-4 text-white" />
    </div>
  );
}
