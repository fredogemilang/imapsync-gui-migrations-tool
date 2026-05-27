import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Styled dropdown that matches the settings/server-config mockup
 * (card-shaped trigger with label-above-value, animated chevron, panel
 * below with check-marked options). Used in the Settings page in place
 * of native `<select>` for visual parity with the mockup.
 *
 * Keyboard-friendly:
 *   - Click trigger to open
 *   - Outside click closes
 *   - Escape closes
 *   - Selecting an option closes
 */
export function CustomDropdown<T extends string | number>({
  label,
  value,
  options,
  onChange,
  disabled = false,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', handler);
    window.addEventListener('keydown', keyHandler);
    return () => {
      window.removeEventListener('mousedown', handler);
      window.removeEventListener('keydown', keyHandler);
    };
  }, [open]);

  const selected = options.find((o) => o.value === value);

  return (
    <div ref={ref} className="relative w-full">
      <button
        type="button"
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
        className={cn(
          'w-full text-left bg-white border border-slate-200/80 rounded-xl px-5 py-4 flex items-center justify-between shadow-sm hover:border-slate-300 transition-colors focus:outline-none disabled:opacity-60 disabled:cursor-not-allowed',
        )}
      >
        <div className="flex flex-col gap-0.5 min-w-0 flex-1">
          <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">
            {label}
          </span>
          <span className="text-[15px] font-bold text-primary-dark truncate">
            {selected?.label ?? '—'}
          </span>
        </div>
        <ChevronDown
          className={cn(
            'h-4 w-4 text-slate-400 transition-transform duration-200 shrink-0 ml-2',
            open && 'rotate-180',
          )}
          strokeWidth={2.5}
        />
      </button>

      {open && (
        <div className="absolute left-0 right-0 mt-1.5 bg-white border border-slate-200/85 rounded-xl shadow-xl z-50 overflow-hidden flex flex-col">
          {options.map((opt) => {
            const active = opt.value === value;
            return (
              <button
                type="button"
                key={String(opt.value)}
                onClick={() => {
                  onChange(opt.value);
                  setOpen(false);
                }}
                className={cn(
                  'px-5 py-3 hover:bg-slate-50 cursor-pointer select-none transition-colors border-b border-slate-100 last:border-0 font-bold text-primary-dark text-[14px] flex items-center justify-between gap-2 text-left',
                  active && 'bg-slate-100/70',
                )}
              >
                <span>{opt.label}</span>
                {active && <Check className="h-4 w-4 text-primary-dark shrink-0" strokeWidth={3} />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
