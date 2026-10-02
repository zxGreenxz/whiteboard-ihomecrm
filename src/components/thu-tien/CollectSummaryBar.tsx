import { ChevronRight } from 'lucide-react';
import { fmtShort } from '@/lib/collect';
import { SkeletonBar } from '@/components/loading/LoadingState';

interface Props {
  collectedSum: number;
  paidRooms: number;
  remainingSum: number;
  dueRooms: number;
  onOpenReport: () => void;
  /** Chưa có số liệu: vạch xám thay số (không in 0đ) — chủ chốt 02/10/2026. */
  loading?: boolean;
}

const VachSo = () => <SkeletonBar className="inline-block h-4 self-center" style={{ width: '3.5rem' }} />;
const VachPhong = () => <SkeletonBar className="inline-block h-2.5 self-center" style={{ width: '1.4rem' }} />;

/** Dải tổng kết 1 dòng — bấm để mở Báo cáo thu tiền. */
export function CollectSummaryBar({
  collectedSum,
  paidRooms,
  remainingSum,
  dueRooms,
  onOpenReport,
  loading = false,
}: Props) {
  return (
    <button type="button" className="cs clickable" onClick={onOpenReport}>
      <div className="cs-item">
        <span className="cs-dot" style={{ background: 'var(--c-paid)' }} />
        <span className="cs-k">Đã thu</span>
        {loading ? <VachSo /> : <span className="cs-v paid">{fmtShort(collectedSum)}</span>}
        {loading ? <VachPhong /> : <span className="cs-p">· {paidRooms}P</span>}
      </div>
      <span className="cs-div" />
      <div className="cs-item">
        <span className="cs-dot" style={{ background: 'var(--c-unpaid)' }} />
        <span className="cs-k">Phải thu</span>
        {loading ? <VachSo /> : <span className="cs-v due">{fmtShort(remainingSum)}</span>}
        {loading ? <VachPhong /> : <span className="cs-p">· {dueRooms}P</span>}
      </div>
      <span className="cs-report">
        <ChevronRight />
      </span>
    </button>
  );
}

export default CollectSummaryBar;
