import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '@/lib/api';

export function ChangePassword() {
  const navigate = useNavigate();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (next.length < 8) return setErr('Password must be at least 8 characters');
    if (next !== confirm) return setErr('Passwords do not match');
    try {
      await api.changePassword(current, next);
      setOk(true);
      setTimeout(() => navigate('/settings'), 1200);
    } catch (e: any) {
      setErr(e.message);
    }
  };

  return (
    <div className="max-w-md mx-auto space-y-6">
      <h2 className="text-primary-dark font-extrabold text-2xl">Change Password</h2>
      <form onSubmit={submit} className="space-y-4">
        <Input label="Current Password" type="password" value={current} onChange={setCurrent} />
        <Input label="New Password" type="password" value={next} onChange={setNext} />
        <Input label="Confirm New Password" type="password" value={confirm} onChange={setConfirm} />
        {err && <div className="bg-[#D32F2F] text-white rounded-xl p-3 text-sm">{err}</div>}
        {ok && (
          <div className="bg-emerald-500 text-white rounded-xl p-3 text-sm">Password updated.</div>
        )}
        <button
          type="submit"
          className="w-full bg-primary-container hover:bg-primary-dark text-white rounded-lg py-3 font-bold shadow-md"
        >
          Update Password
        </button>
      </form>
    </div>
  );
}

function Input({
  label,
  type,
  value,
  onChange,
}: {
  label: string;
  type: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="bg-white border border-slate-200/80 rounded-xl p-3">
      <label className="block text-primary font-bold text-[11px] mb-0.5">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full bg-transparent text-primary text-[14px] outline-none"
      />
    </div>
  );
}
