import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

export function Settings() {
  const [s, setS] = useState({
    simultaneousMigrations: 3,
    retentionDays: 30,
    passwordDisplay: 'Obstructed',
  });
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.getSettings().then((r) => setS((p) => ({ ...p, ...r })));
  }, []);

  const save = async () => {
    await api.saveSettings(s);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  return (
    <div className="max-w-3xl mx-auto space-y-8">
      <h2 className="text-primary-dark font-extrabold text-2xl">App Settings</h2>

      <div className="space-y-3">
        <Item label="Number of Simultaneous Migrations">
          <select
            value={s.simultaneousMigrations}
            onChange={(e) => setS({ ...s, simultaneousMigrations: Number(e.target.value) })}
            className="bg-white border border-slate-200/80 rounded-lg text-primary text-[15px] py-2 px-4 font-bold"
          >
            {[1, 2, 3, 5, 10].map((n) => (
              <option key={n} value={n}>
                {n} {n === 1 ? 'Migration' : 'Migrations'}
              </option>
            ))}
          </select>
        </Item>
        <Item label="Delete Finished Migrations After">
          <select
            value={s.retentionDays}
            onChange={(e) => setS({ ...s, retentionDays: Number(e.target.value) })}
            className="bg-white border border-slate-200/80 rounded-lg text-primary text-[15px] py-2 px-4 font-bold"
          >
            <option value={7}>1 Week</option>
            <option value={30}>1 Month</option>
            <option value={90}>3 Months</option>
            <option value={365}>1 Year</option>
          </select>
        </Item>
        <Item label="Show Passwords As">
          <select
            value={s.passwordDisplay}
            onChange={(e) => setS({ ...s, passwordDisplay: e.target.value })}
            className="bg-white border border-slate-200/80 rounded-lg text-primary text-[15px] py-2 px-4 font-bold"
          >
            <option>Obstructed</option>
            <option>Readable</option>
          </select>
        </Item>
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={save}
          className="bg-primary-container hover:bg-primary-dark text-white rounded-lg px-6 py-2.5 font-bold text-sm shadow-md"
        >
          Save
        </button>
        {saved && <span className="text-emerald-600 font-bold text-sm">Saved ✓</span>}
      </div>

      <div className="pt-6 border-t">
        <a
          href="/change-password"
          className="text-primary hover:text-primary-dark font-bold text-sm"
        >
          Change Password →
        </a>
      </div>
    </div>
  );
}

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-4">
      <div className="flex-1 bg-white border border-slate-200/80 rounded-xl px-5 py-4">
        <div className="text-slate-400 font-bold text-[11px] uppercase tracking-wider">{label}</div>
      </div>
      {children}
    </div>
  );
}
