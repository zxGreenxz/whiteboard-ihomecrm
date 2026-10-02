import { SkeletonBar } from '@/components/loading/LoadingState';

export type StatusFilterValue = 'all' | 'paid' | 'unpaid';

interface Props {
  value: StatusFilterValue;
  counts: Record<StatusFilterValue, number>;
  onChange: (v: StatusFilterValue) => void;
  /** Chưa có số: vạch xám thay số đếm (không in 0) — chủ chốt 02/10/2026. */
  loading?: boolean;
}

const OPTIONS: { id: StatusFilterValue; label: string }[] = [
  { id: 'all', label: 'Tất cả' },
  { id: 'paid', label: 'Đã thu' },
  { id: 'unpaid', label: 'Chưa thu' },
];

export function StatusFilter({ value, counts, onChange, loading = false }: Props) {
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
          <span className="cnt">{loading ? <SkeletonBar className="inline-block h-2.5 align-middle" style={{ width: '0.9rem' }} /> : counts[o.id]}</span>
        </button>
      ))}
    </div>
  );
}

export default StatusFilter;
