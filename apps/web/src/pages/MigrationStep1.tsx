import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWizard } from '@/components/WizardContext';
import { api } from '@/lib/api';
import { AccountForm } from '@/components/AccountForm';

export function MigrationStep1() {
  const navigate = useNavigate();
  const { source, target } = useWizard();
  const [checking, setChecking] = useState(false);
  const [errors, setErrors] = useState<{ source?: string; target?: string }>({});

  const checkSettings = async () => {
    setChecking(true);
    setErrors({});
    try {
      const [s, t] = await Promise.all([
        api.testConnection(source).catch((e) => ({ ok: false, error: e.message })),
        api.testConnection(target).catch((e) => ({ ok: false, error: e.message })),
      ]);
      const errs: { source?: string; target?: string } = {};
      if (!s.ok) errs.source = (s as any).error;
      if (!t.ok) errs.target = (t as any).error;
      setErrors(errs);
      if (Object.keys(errs).length === 0) navigate('/migrations/new/step2');
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="max-w-5xl mx-auto space-y-8 pb-32 relative">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        <AccountForm
          title="Existing Address"
          value={source}
          onChange={(p) => useWizard.getState().setSource(p)}
          error={errors.source}
        />
        <AccountForm
          title="New Address"
          value={target}
          onChange={(p) => useWizard.getState().setTarget(p)}
          error={errors.target}
        />
      </div>
      <div className="fixed bottom-[88px] md:bottom-0 inset-x-0 bg-white/80 backdrop-blur-md border-t border-slate-200/60 pt-4 pb-6 flex flex-col items-center px-4 md:px-10 z-10 md:ml-60">
        <button
          onClick={checkSettings}
          disabled={checking}
          className="w-full max-w-4xl bg-primary-container hover:bg-primary-dark text-white rounded-lg py-3.5 font-bold text-[15px] shadow-md disabled:opacity-60"
        >
          {checking ? 'Checking…' : 'Check Settings'}
        </button>
      </div>
    </div>
  );
}
