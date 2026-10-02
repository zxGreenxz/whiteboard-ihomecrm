import { Calendar as CalendarIcon } from 'lucide-react';
import { SkeletonBar } from '@/components/loading/LoadingState';

export type TimeFilterValue = 'all' | 'today' | 'date';

interface Props {
  value: TimeFilterValue;
  counts: Record<TimeFilterValue, number>;
  onChange: (v: TimeFilterValue) => void;
  /** Chưa có số: vạch xám thay số đếm (không in 0) — chủ chốt 02/10/2026. */
  loading?: boolean;
}

const OPTIONS: { id: TimeFilterValue; label: string }[] = [
  { id: 'all', label: 'Tất cả' },
  { id: 'today', label: 'Hôm nay' },
  { id: 'date', label: 'Chọn ngày' },
];

export function TimeFilter({ value, counts, onChange, loading = false }: Props) {
  return (
    <div className="cfilters">
      {OPTIONS.map((o) => (
        <button
          key={o.id}
          type="button"
          className={'cchip' + (value === o.id ? ' on' : '')}
          onClick={() => onChange(o.id)}
        >
          {o.id === 'date' && <CalendarIcon />}
          {o.label}
          {o.id !== 'date' && <span className="cnt">{loading ? <SkeletonBar className="inline-block h-2.5 align-middle" style={{ width: '0.9rem' }} /> : counts[o.id]}</span>}
        </button>
      ))}
    </div>
  );
}

export default TimeFilter;
