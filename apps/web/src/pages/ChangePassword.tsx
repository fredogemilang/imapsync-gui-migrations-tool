import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, Circle, Eye, EyeOff, Lock, ShieldCheck } from 'lucide-react';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import {
  HeaderBackLink,
  useHeaderLeft,
  useSidebarIcon,
  useSidebarTitle,
} from '@/components/Layout';

/**
 * Change Password page — layout mirrors
 * `mockup/template/partials/change-password-content.html`:
 *
 *   - Title + intro paragraph (left-aligned on desktop, centered on mobile)
 *   - Card containing 3 framed password fields, each with eye-toggle
 *   - Live password requirements checklist (length / number / uppercase)
 *   - Inline mismatch error
 *   - Full-width primary "Update Password" button with shield icon
 *   - Success modal with bouncing checkmark + auto-redirect to /settings
 *
 * Live validation is purely client-side; the server enforces password
 * complexity again in `POST /api/auth/change-password`.
 */
export function ChangePassword() {
  const navigate = useNavigate();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNext, setShowNext] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [busy, setBusy] = useState(false);

  useHeaderLeft(<HeaderBackLink to="/settings" label="Back to Settings" />);
  useSidebarTitle('Change Password');
  useSidebarIcon(Lock);

  // Live requirement check — re-evaluated on every keystroke.
  const reqs = useMemo(
    () => ({
      length: next.length >= 8,
      number: /[0-9]/.test(next),
      upper: /[A-Z]/.test(next),
    }),
    [next],
  );
  const allMet = reqs.length && reqs.number && reqs.upper;

  // Mismatch error shown only when user has typed something into confirm
  // — avoid pre-emptive red for an empty field.
  const mismatch = confirm.length > 0 && confirm !== next;

  // After the success modal shows for a moment, redirect to /settings so
  // the user lands somewhere familiar (matches mockup's 2.5s delay).
  useEffect(() => {
    if (!success) return;
    const t = setTimeout(() => navigate('/settings'), 2200);
    return () => clearTimeout(t);
  }, [success, navigate]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!current) {
      setError('Please enter your current password.');
      return;
    }
    if (!allMet) {
      setError('Password does not meet all requirements.');
      return;
    }
    if (next !== confirm) {
      setError('New passwords do not match. Please verify.');
      return;
    }
    setBusy(true);
    try {
      await api.changePassword(current, next);
      setSuccess(true);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to update password');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-md mx-auto space-y-8">
      {/* Title + intro */}
      <div className="text-center md:text-left space-y-2">
        <h3 className="text-primary-dark font-extrabold text-2xl">Change Password</h3>
        <p className="text-slate-400 text-[14px]">
          Update your administrator account password. Keep it secure and complex to protect your
          server configurations.
        </p>
      </div>

      {/* Form card */}
      <form
        onSubmit={submit}
        className="bg-white border border-slate-200/80 rounded-2xl p-6 md:p-8 shadow-sm space-y-6"
      >
        <PasswordField
          label="Current Password"
          placeholder="Enter current password"
          value={current}
          onChange={setCurrent}
          show={showCurrent}
          onToggle={() => setShowCurrent((v) => !v)}
        />
        <PasswordField
          label="New Password"
          placeholder="Enter new password"
          value={next}
          onChange={setNext}
          show={showNext}
          onToggle={() => setShowNext((v) => !v)}
        />
        <PasswordField
          label="Confirm New Password"
          placeholder="Retype new password"
          value={confirm}
          onChange={setConfirm}
          show={showConfirm}
          onToggle={() => setShowConfirm((v) => !v)}
        />

        {/* Requirements checklist */}
        <div className="bg-slate-50 border border-slate-100 rounded-xl p-4 space-y-2.5">
          <span className="text-primary-dark font-bold text-[12px] block">
            Password Requirements:
          </span>
          <ul className="space-y-1.5 text-[12px]">
            <Requirement met={reqs.length} label="At least 8 characters long" />
            <Requirement met={reqs.number} label="Contains at least one number" />
            <Requirement met={reqs.upper} label="Contains an uppercase letter" />
          </ul>
        </div>

        {/* Mismatch / API error */}
        {mismatch && !error && (
          <div className="text-red-500 text-xs font-semibold text-center">
            New passwords do not match. Please verify.
          </div>
        )}
        {error && <div className="text-red-500 text-xs font-semibold text-center">{error}</div>}

        {/* Submit */}
        <button
          type="submit"
          disabled={busy}
          className="w-full bg-primary-dark hover:bg-primary text-white font-extrabold text-[15px] py-4 rounded-xl shadow-md transition-all active:scale-[0.99] flex items-center justify-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed"
        >
          <ShieldCheck className="h-5 w-5" strokeWidth={2} />
          <span>{busy ? 'Updating…' : 'Update Password'}</span>
        </button>
      </form>

      {success && <SuccessModal />}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Sub-components
// -----------------------------------------------------------------------------

function PasswordField({
  label,
  placeholder,
  value,
  onChange,
  show,
  onToggle,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  show: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="bg-white border border-slate-200/80 rounded-xl p-3 shadow-sm focus-within:border-primary/50 focus-within:ring-1 focus-within:ring-primary/10 transition-all">
      <label className="block text-primary-dark font-bold text-[11px] mb-0.5 uppercase tracking-wider">
        {label}
      </label>
      <div className="relative flex items-center justify-between">
        <input
          type={show ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          required
          className="w-full bg-transparent text-primary text-[14px] outline-none border-none placeholder-slate-400 py-0.5 pr-8"
        />
        <button
          type="button"
          onClick={onToggle}
          aria-label={show ? 'Hide password' : 'Show password'}
          className="absolute right-0 text-slate-400 hover:text-primary-dark transition-colors focus:outline-none"
        >
          {show ? (
            <EyeOff className="h-5 w-5" strokeWidth={2} />
          ) : (
            <Eye className="h-5 w-5" strokeWidth={2} />
          )}
        </button>
      </div>
    </div>
  );
}

function Requirement({ met, label }: { met: boolean; label: string }) {
  return (
    <li
      className={cn(
        'flex items-center gap-2 transition-colors',
        met ? 'text-green-600 font-semibold' : 'text-slate-400',
      )}
    >
      {met ? (
        <Check className="h-4 w-4 shrink-0" strokeWidth={3} />
      ) : (
        <Circle className="h-4 w-4 shrink-0" strokeWidth={2.5} />
      )}
      <span>{label}</span>
    </li>
  );
}

/** Success modal — frosted backdrop + bouncing green checkmark.
 *  Auto-dismisses via `useEffect` in parent after 2.2s. */
function SuccessModal() {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm" />
      <div className="relative bg-white rounded-2xl shadow-2xl p-8 max-w-sm w-full mx-4 z-10 text-center space-y-5">
        <div className="w-16 h-16 bg-green-50 border border-green-200 rounded-full flex items-center justify-center text-green-500 mx-auto animate-bounce">
          <Check className="h-8 w-8" strokeWidth={3} />
        </div>
        <div className="space-y-2">
          <h4 className="text-primary-dark font-extrabold text-xl">Success!</h4>
          <p className="text-slate-400 text-[14px]">
            Your administrator password has been updated successfully.
          </p>
        </div>
      </div>
    </div>
  );
}
