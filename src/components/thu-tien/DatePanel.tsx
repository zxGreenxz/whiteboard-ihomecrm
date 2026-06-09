import { format } from 'date-fns';
import type { DateRange as RdpRange } from 'react-day-picker';
import { Calendar } from '@/components/ui/calendar';
import { cn } from '@/lib/utils';

export interface CollectDateRange {
  start: string; // YYYY-MM-DD
  end: string; // YYYY-MM-DD (== start khi chọn 1 ngày)
}

interface Props {
  mode: 'single' | 'range';
  onModeChange: (m: 'single' | 'range') => void;
  value: CollectDateRange;
  onChange: (r: CollectDateRange) => void;
  resultText: string;
}

const toDate = (iso: string): Date | undefined =>
  iso ? new Date(`${iso}T00:00:00`) : undefined;
const toISO = (d: Date): string => format(d, 'yyyy-MM-dd');

export function DatePanel({ mode, onModeChange, value, onChange, resultText }: Props) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-3 shadow-sm">
      <div className="mb-2 flex gap-2">
        {(['single', 'range'] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => onModeChange(m)}
            className={cn(
              'flex-1 rounded-lg border px-3 py-1.5 text-sm font-medium',
              mode === m
                ? 'bg-emerald-50 text-emerald-700 border-emerald-300'
                : 'bg-white text-zinc-600 border-zinc-200',
            )}
          >
            {m === 'single' ? 'Một ngày' : 'Khoảng ngày'}
          </button>
        ))}
      </div>

      <div className="flex justify-center">
        {mode === 'single' ? (
          <Calendar
            mode="single"
            selected={toDate(value.start)}
            onSelect={(d) => d && onChange({ start: toISO(d), end: toISO(d) })}
          />
        ) : (
          <Calendar
            mode="range"
            selected={{ from: toDate(value.start), to: toDate(value.end) }}
            onSelect={(r: RdpRange | undefined) => {
              const start = r?.from ? toISO(r.from) : value.start;
              const end = r?.to ? toISO(r.to) : start;
              onChange({ start, end });
            }}
          />
        )}
      </div>

      <div className="mt-1 text-center text-sm text-zinc-500">{resultText}</div>
    </div>
  );
}

export default DatePanel;
