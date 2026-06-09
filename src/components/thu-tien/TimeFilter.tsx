import { Calendar as CalendarIcon } from 'lucide-react';

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
          {o.id !== 'date' && <span className="cnt">{counts[o.id]}</span>}
        </button>
      ))}
    </div>
  );
}

export default TimeFilter;
