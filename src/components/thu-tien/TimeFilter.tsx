import { Calendar as CalendarIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export type TimeFilterValue = 'all' | 'today' | 'date';

interface Props {
  value: TimeFilterValue;
  counts: Record<TimeFilterValue, number>;
  onChange: (v: TimeFilterValue) => void;
}

const OPTIONS: { id: TimeFilterValue; label: string }[] = [
  { id: 'all', label: 'Tất cả' },
  { id: 'today', label: 'Hôm nay' },
  { id: 'date', label: 'Chọn ngày' },
];

export function TimeFilter({ value, counts, onChange }: Props) {
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
              ? 'bg-emerald-600 text-white border-emerald-600'
              : 'bg-white text-zinc-600 border-zinc-200',
          )}
        >
          {o.id === 'date' && <CalendarIcon className="h-3.5 w-3.5" />}
          {o.label}
          {o.id !== 'date' && (
            <span
              className={cn(
                'rounded-full px-1.5 text-xs tabular-nums',
                value === o.id ? 'bg-white/20' : 'bg-zinc-100 text-zinc-500',
              )}
            >
              {counts[o.id]}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

export default TimeFilter;
