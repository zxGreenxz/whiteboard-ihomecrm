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
    <div className="cfilters">
      {OPTIONS.map((o) => (
        <button
          key={o.id}
          type="button"
          className={'cchip' + (value === o.id ? ' on' : '')}
          onClick={() => onChange(o.id)}
        >
          {o.label}
          <span className="cnt">{counts[o.id]}</span>
        </button>
      ))}
    </div>
  );
}

export default StatusFilter;
