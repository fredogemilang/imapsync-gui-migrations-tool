import { cn } from '@/lib/utils';

export function Switch({
  checked,
  onCheckedChange,
}: {
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        'w-10 h-6 rounded-full relative shrink-0 transition-colors shadow-inner border',
        checked ? 'bg-success border-emerald-600/30' : 'bg-slate-200 border-slate-300/50',
      )}
    >
      <span
        className={cn(
          'absolute top-1 w-4 h-4 bg-white rounded-full shadow-sm transition-all',
          checked ? 'right-1' : 'left-1',
        )}
      />
    </button>
  );
}
