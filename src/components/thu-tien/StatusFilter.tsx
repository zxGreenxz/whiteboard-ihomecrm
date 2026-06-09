import { cn } from '@/lib/utils';

export type StatusFilterValue = 'all' | 'paid' | 'unpaid';

interface Props {
  value: StatusFilterValue;
  counts: Record<StatusFilterValue, number>;
  onChange: (v: StatusFilterValue) => void;
}

const OPTIONS: { id: StatusFilterValue; label: string }[] = [
  { id: 'all', label: 'Tất cả' },
  { id: 'paid', label: 'Đã thu' },
  { id: 'unpaid', label: 'Chưa thu' },
];

export function StatusFilter({ value, counts, onChange }: Props) {
  return (
    <div className="flex gap-2">
      {OPTIONS.map((o) => (
        <button
          key={o.id}
          type="button"
          onClick={() => onChange(o.id)}
          className={cn(
            'flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition-colors',
            value === o.id
              ? 'bg-zinc-900 text-white border-zinc-900'
              : 'bg-white text-zinc-600 border-zinc-200',
          )}
        >
          {o.label}
          <span
            className={cn(
              'rounded-full px-1.5 text-xs tabular-nums',
              value === o.id ? 'bg-white/20' : 'bg-zinc-100 text-zinc-500',
            )}
          >
            {counts[o.id]}
          </span>
        </button>
      ))}
    </div>
  );
}

export default StatusFilter;
