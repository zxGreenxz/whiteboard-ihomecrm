import { ChevronRight } from 'lucide-react';
import { fmtShort } from '@/lib/collect';

interface Props {
  collectedSum: number;
  paidRooms: number;
  remainingSum: number;
  dueRooms: number;
  onOpenReport: () => void;
}

/** Dải tổng kết 1 dòng — bấm để mở Báo cáo thu tiền. */
export function CollectSummaryBar({
  collectedSum,
  paidRooms,
  remainingSum,
  dueRooms,
  onOpenReport,
}: Props) {
  return (
    <button type="button" className="cs clickable" onClick={onOpenReport}>
      <div className="cs-item">
        <span className="cs-dot" style={{ background: 'var(--c-paid)' }} />
        <span className="cs-k">Đã thu</span>
        <span className="cs-v paid">{fmtShort(collectedSum)}</span>
        <span className="cs-p">· {paidRooms}P</span>
      </div>
      <span className="cs-div" />
      <div className="cs-item">
        <span className="cs-dot" style={{ background: 'var(--c-unpaid)' }} />
        <span className="cs-k">Phải thu</span>
        <span className="cs-v due">{fmtShort(remainingSum)}</span>
        <span className="cs-p">· {dueRooms}P</span>
      </div>
      <span className="cs-report">
        <ChevronRight />
      </span>
    </button>
  );
}

export default CollectSummaryBar;
