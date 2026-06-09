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
    <button
      type="button"
      onClick={onOpenReport}
      className="flex w-full items-center gap-2 rounded-xl border border-zinc-200 bg-white px-3 py-2.5 text-sm shadow-sm"
    >
      <span className="flex items-center gap-1.5">
        <span className="h-2 w-2 rounded-full bg-[#1f9d57]" />
        <span className="text-zinc-500">Đã thu</span>
        <span className="font-semibold tabular-nums text-[#1f9d57]">{fmtShort(collectedSum)}</span>
        <span className="text-zinc-400">· {paidRooms}P</span>
      </span>
      <span className="mx-1 h-4 w-px bg-zinc-200" />
      <span className="flex items-center gap-1.5">
        <span className="h-2 w-2 rounded-full bg-[#d6453f]" />
        <span className="text-zinc-500">Phải thu</span>
        <span className="font-semibold tabular-nums text-[#d6453f]">{fmtShort(remainingSum)}</span>
        <span className="text-zinc-400">· {dueRooms}P</span>
      </span>
      <ChevronRight className="ml-auto h-4 w-4 text-zinc-400" />
    </button>
  );
}

export default CollectSummaryBar;
