import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

export type DropdownOption<T extends string | number> = {
  value: T;
  label: string;
  /** Optional left icon — provider logo for Account Type, undefined for plain dropdowns. */
  icon?: ReactNode;
};

type DropdownProps<T extends string | number> = {
  /** Small label rendered above the selected value inside the trigger. */
  label?: string;
  value: T;
  options: DropdownOption<T>[];
  onChange: (v: T) => void;
  disabled?: boolean;
  /** Trigger size: 'lg' = same as form field, 'sm' = compact (advanced settings) */
  size?: 'lg' | 'sm';
  className?: string;
};

/**
 * Reusable dropdown. Pattern from mockup partials/migrations-content.html:
 * - Trigger shows label (tiny) + selected value (bold), with chevron that
 *   rotates 180° when open.
 * - Panel lists options; selected option has a slate-tinted background and
 *   a checkmark on the right.
 * - Click outside closes the panel.
 */
export function Dropdown<T extends string | number>({
  label,
  value,
  options,
  onChange,
  disabled = false,
  size = 'lg',
  className,
}: DropdownProps<T>) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('click', onDoc);
    return () => document.removeEventListener('click', onDoc);
  }, []);

  const current = options.find((o) => o.value === value);

  return (
    <div ref={ref} className={cn('relative', disabled && 'opacity-50', className)}>
      <button
        type="button"
        disabled={disabled}
        onClick={(e) => {
          e.stopPropagation();
          if (!disabled) setOpen((v) => !v);
        }}
        className={cn(
          'w-full text-left bg-white border border-slate-200/80 rounded-xl shadow-sm hover:border-primary/50 transition-all select-none focus:outline-none flex items-center justify-between',
          size === 'lg' ? 'p-3' : 'py-2 px-3',
          disabled && 'cursor-not-allowed',
        )}
      >
        <div className="flex flex-col flex-1 min-w-0">
          {label && (
            <span className="block text-primary font-bold text-[11px] mb-0.5">{label}</span>
          )}
          <div className="flex items-center gap-2.5 min-w-0">
            {current?.icon && <span className="shrink-0 flex">{current.icon}</span>}
            <span className="text-primary font-bold text-[14px] truncate">
              {current?.label ?? '—'}
            </span>
          </div>
        </div>
        <ChevronDown
          className={cn(
            'h-4 w-4 text-slate-400 transition-transform duration-200 shrink-0',
            open && 'rotate-180',
          )}
        />
      </button>

      {open && (
        <div className="absolute left-0 right-0 mt-1 bg-white border border-slate-200/85 rounded-xl shadow-xl z-50 overflow-hidden flex flex-col">
          {options.map((opt) => {
            const selected = opt.value === value;
            return (
              <button
                type="button"
                key={String(opt.value)}
                onClick={(e) => {
                  e.stopPropagation();
                  onChange(opt.value);
                  setOpen(false);
                }}
                className={cn(
                  'flex items-center justify-between gap-3 px-5 py-3 cursor-pointer select-none transition-colors border-b border-slate-100 last:border-0 text-left',
                  selected ? 'bg-slate-100/70 hover:bg-slate-100' : 'hover:bg-slate-50',
                )}
              >
                <div className="flex items-center gap-3 min-w-0">
                  {opt.icon && <span className="shrink-0 flex">{opt.icon}</span>}
                  <span className="text-primary-dark font-semibold text-[13.5px] truncate">
                    {opt.label}
                  </span>
                </div>
                {selected && (
                  <Check className="h-4 w-4 text-primary-dark shrink-0" strokeWidth={3} />
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
