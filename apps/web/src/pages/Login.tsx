import { useState } from 'react';
import { Mail } from 'lucide-react';
import { api } from '@/lib/api';

export function Login({ onSuccess }: { onSuccess: () => void }) {
  const [email, setEmail] = useState('admin@example.com');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    setLoading(true);
    try {
      await api.login(email, password);
      onSuccess();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <form onSubmit={submit} className="startup-card rounded-2xl p-8 w-full max-w-md space-y-5">
        <div className="flex items-center gap-3 mb-2">
          <div className="bg-primary text-white rounded-xl p-2.5">
            <Mail className="h-5 w-5" />
          </div>
          <h1 className="text-primary-dark font-extrabold text-xl">MailMigrate</h1>
        </div>
        <div className="bg-white border border-slate-200/80 rounded-xl p-3">
          <label className="block text-primary font-bold text-[11px] mb-0.5">Email</label>
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            type="email"
            required
            className="w-full bg-transparent text-primary text-[14px] outline-none"
          />
        </div>
        <div className="bg-white border border-slate-200/80 rounded-xl p-3">
          <label className="block text-primary font-bold text-[11px] mb-0.5">Password</label>
          <input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            type="password"
            required
            className="w-full bg-transparent text-primary text-[14px] outline-none"
          />
        </div>
        {err && (
          <div className="bg-[#D32F2F] text-white rounded-xl p-3 text-sm font-semibold">{err}</div>
        )}
        <button
          type="submit"
          disabled={loading}
          className="w-full bg-primary-container hover:bg-primary-dark text-white rounded-lg py-3.5 font-bold text-[15px] shadow-md disabled:opacity-60"
        >
          {loading ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
