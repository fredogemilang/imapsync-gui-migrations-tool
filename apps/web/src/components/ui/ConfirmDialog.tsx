import type { ReactNode } from 'react';
import { useEffect } from 'react';
import { AlertTriangle, Info, Loader2, X } from 'lucide-react';
import { cn } from '@/lib/utils';

type Variant = 'danger' | 'primary' | 'info';

/**
 * Modal confirmation / alert dialog. Replaces `window.confirm` and
 * `window.alert` so the app's destructive flows have a consistent,
 * brand-styled look.
 *
 * Two modes:
 *   - **Confirm** — both `onCancel` AND `onConfirm` provided. Renders a
 *     Cancel + primary action button. Use for destructive flows.
 *   - **Alert** — only `onCancel` provided (no `onConfirm`). Renders a
 *     single OK button. Use for "couldn't do X" / info messages.
 *
 * Closing on backdrop click and Escape is supported. While `busy` is true
 * the dialog refuses to dismiss — prevents an accidental click-away
 * mid-network-call.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  variant = 'primary',
  confirmLabel = 'Confirm',
  cancelLabel,
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description: ReactNode;
  variant?: Variant;
  confirmLabel?: string;
  /** Defaults to "Cancel" in confirm mode, "OK" in alert mode. */
  cancelLabel?: string;
  busy?: boolean;
  onConfirm?: () => void | Promise<void>;
  onCancel: () => void;
}) {
  // Escape closes when not busy.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onCancel();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, busy, onCancel]);

  if (!open) return null;

  const isAlert = !onConfirm;
  const resolvedCancelLabel = cancelLabel ?? (isAlert ? 'OK' : 'Cancel');

  const Icon = variant === 'danger' ? AlertTriangle : variant === 'info' ? Info : AlertTriangle;
  const iconWrap = cn(
    'rounded-full p-2 shrink-0 mt-0.5',
    variant === 'danger' && 'bg-red-100 text-red-600',
    variant === 'primary' && 'bg-amber-100 text-amber-600',
    variant === 'info' && 'bg-blue-100 text-blue-600',
  );
  const confirmBtn = cn(
    'px-4 py-2.5 rounded-lg font-bold text-sm text-white transition-colors shadow-sm disabled:opacity-60 disabled:cursor-not-allowed inline-flex items-center justify-center gap-2 min-w-[120px]',
    variant === 'danger' && 'bg-red-600 hover:bg-red-700',
    variant === 'primary' && 'bg-primary-container hover:bg-primary-dark',
    variant === 'info' && 'bg-primary-container hover:bg-primary-dark',
  );

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-[200] flex items-center justify-center p-4 md:p-6"
    >
      <div
        onClick={() => !busy && onCancel()}
        className="absolute inset-0 bg-slate-900/50 backdrop-blur-md"
      />
      <div className="relative w-full max-w-md bg-white rounded-2xl shadow-2xl overflow-hidden z-10">
        {/* Close X */}
        {!busy && (
          <button
            onClick={onCancel}
            aria-label="Close"
            className="absolute top-4 right-4 text-slate-400 hover:text-slate-600 transition-colors p-1.5 rounded-full hover:bg-slate-100 focus:outline-none"
          >
            <X className="h-5 w-5" />
          </button>
        )}

        <div className="p-6 md:p-7">
          <div className="flex items-start gap-4">
            <div className={iconWrap}>
              <Icon className="h-5 w-5" />
            </div>
            <div className="flex-1 min-w-0 pr-6">
              <h3 className="text-primary-dark font-extrabold text-base md:text-lg">{title}</h3>
              <div className="mt-1.5 text-slate-600 text-sm leading-relaxed break-words">
                {description}
              </div>
            </div>
          </div>

          <div className="mt-6 flex flex-col-reverse sm:flex-row sm:justify-end gap-2 sm:gap-3">
            <button
              onClick={onCancel}
              disabled={busy}
              className="px-4 py-2.5 rounded-lg font-bold text-sm border border-slate-200 bg-white text-primary hover:bg-slate-50 transition-colors disabled:opacity-60 disabled:cursor-not-allowed min-w-[100px]"
            >
              {resolvedCancelLabel}
            </button>
            {!isAlert && (
              <button
                onClick={() => onConfirm?.()}
                disabled={busy}
                className={confirmBtn}
              >
                {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                {confirmLabel}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
