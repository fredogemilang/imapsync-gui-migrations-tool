import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Lock } from 'lucide-react';
import {
  useIsSourceValidated,
  useIsTargetValidated,
  useIsValidated,
  useWizard,
} from '@/components/WizardContext';
import { api } from '@/lib/api';
import { AccountForm, type AccountFieldErrors } from '@/components/AccountForm';
import {
  HeaderStepArrows,
  HeaderStepCounter,
  useFooter,
  useHeaderAction,
  useHeaderLeft,
  useSidebarIcon,
  useSidebarTitle,
} from '@/components/Layout';

// ----------------------------------------------------------------------------
// Pure client-side validation
// ----------------------------------------------------------------------------

// Loose email check — rejects 'foo', 'foo@bar', 'a b@c.com'; accepts unicode.
// Real validity is established by the IMAP login on the backend.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Hostname / FQDN — at least one label + dot + tld. Also accepts IPv4 since
// digits are allowed in labels.
//   imap.example.com   ✓
//   mx.kerjamail.co     ✓
//   192.168.1.10        ✓
//   foo                 ✗ (no dot)
//   imap example.com    ✗ (space)
//   foo@bar.com         ✗ (@)
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

type AccountInput = {
  type: 'IMAP' | 'Microsoft' | 'Google' | 'Yahoo' | 'iCloud';
  host: string;
  port: number;
  security: 'SSL/TLS' | 'STARTTLS' | 'None';
  username: string;
  password: string;
};

function clientErrorsFor(a: AccountInput): AccountFieldErrors {
  const errs: AccountFieldErrors = {};

  const email = a.username.trim();
  if (email === '') errs.username = 'Email is required';
  else if (!EMAIL_RE.test(email)) errs.username = 'Enter a valid email (e.g. mail@example.com)';

  if (a.password === '') errs.password = 'Password is required';

  const host = a.host.trim();
  if (host === '') errs.host = 'Mailserver is required';
  else if (!HOSTNAME_RE.test(host)) errs.host = 'Enter a valid hostname (e.g. imap.example.com)';

  return errs;
}

function hasAnyError(e: AccountFieldErrors): boolean {
  return !!(e.username || e.password || e.host);
}

// ----------------------------------------------------------------------------

export function MigrationStep1() {
  const navigate = useNavigate();
  const { source, target, markSourceValidated, markTargetValidated } = useWizard();
  const [checking, setChecking] = useState(false);
  // Server-side error per side (red box at bottom of column)
  const [errors, setErrors] = useState<{ source?: string; target?: string }>({});
  // True after the user has clicked Check Settings at least once. Before
  // that, we keep the form quiet — no red borders on a fresh empty page.
  // After it flips to true, fieldErrors below is DERIVED from current source/
  // target on every render, so typing into a field instantly updates its
  // error state (cleared when valid, shows different message when invalid).
  const [hasAttempted, setHasAttempted] = useState(false);

  const fieldErrors: { source: AccountFieldErrors; target: AccountFieldErrors } = hasAttempted
    ? { source: clientErrorsFor(source), target: clientErrorsFor(target) }
    : { source: {}, target: {} };

  // Per-side validation state (derived from zustand store, persists across
  // navigation, auto-invalidates when the user edits any field on that side).
  const sourceValidated = useIsSourceValidated();
  const targetValidated = useIsTargetValidated();
  const validated = useIsValidated();

  useHeaderLeft(<HeaderStepCounter current={1} total={3} />);
  // Back arrow disabled — step 1 IS the first wizard step.
  useHeaderAction(<HeaderStepArrows next={validated ? '/migrations/new/step2' : undefined} />, [
    validated,
  ]);
  useSidebarTitle('Step 01');
  useSidebarIcon(Lock);

  const checkSettings = async () => {
    // Phase 1: client-side validation (required + format).
    setHasAttempted(true);
    setErrors({});
    if (hasAnyError(clientErrorsFor(source)) || hasAnyError(clientErrorsFor(target))) return;

    // Phase 2: backend connection probe — only for sides that haven't already
    // been validated against their current values. If only the target was
    // edited since the last successful check, source is skipped here. If the
    // user edited source after it had passed, sourceValidated flips false
    // (snapshot mismatch) and it gets re-checked.
    setChecking(true);
    try {
      const sourcePromise = sourceValidated
        ? Promise.resolve({ ok: true as const })
        : api
            .testConnection(source)
            .catch((e) => ({ ok: false as const, error: e.message as string }));
      const targetPromise = targetValidated
        ? Promise.resolve({ ok: true as const })
        : api
            .testConnection(target)
            .catch((e) => ({ ok: false as const, error: e.message as string }));

      const [s, t] = await Promise.all([sourcePromise, targetPromise]);

      const errs: { source?: string; target?: string } = {};
      if (s.ok) markSourceValidated();
      else errs.source = s.error;
      if (t.ok) markTargetValidated();
      else errs.target = t.error;

      setErrors(errs);
      if (Object.keys(errs).length === 0) {
        navigate('/migrations/new/step2');
      }
    } finally {
      setChecking(false);
    }
  };

  useFooter(
    <button
      onClick={checkSettings}
      disabled={checking}
      className="w-full max-w-4xl bg-primary-container hover:bg-primary-dark text-white rounded-lg py-3.5 font-bold text-[15px] shadow-md disabled:opacity-60"
    >
      {checking ? 'Checking…' : 'Check Settings'}
    </button>,
    [checking, source, target],
  );

  return (
    <div className="max-w-5xl mx-auto space-y-8">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        <AccountForm
          title="Existing Address"
          value={source}
          onChange={(p) => useWizard.getState().setSource(p)}
          error={errors.source}
          success={sourceValidated ? `Authenticated as ${source.username}` : undefined}
          fieldErrors={fieldErrors.source}
        />
        <AccountForm
          title="New Address"
          value={target}
          onChange={(p) => useWizard.getState().setTarget(p)}
          error={errors.target}
          success={targetValidated ? `Authenticated as ${target.username}` : undefined}
          fieldErrors={fieldErrors.target}
        />
      </div>
    </div>
  );
}
