import { Check, MessageCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  collectStatus,
  STATUS_META,
  cellSubText,
  fmtK,
  repCustomer,
  zaloUrl,
} from '@/lib/collect';
import type { InvoiceWithRelations } from '@/types/invoice';

interface Props {
  inv: InvoiceWithRelations;
  canRecordPayment: boolean;
  onOpen: (inv: InvoiceWithRelations) => void;
  onFull: (inv: InvoiceWithRelations) => void;
  onPart: (inv: InvoiceWithRelations) => void;
}

/** Ô phòng = 1 hoá đơn (layout "Ô vừa"). Nền tô theo trạng thái thu. */
export function RoomCell({ inv, canRecordPayment, onOpen, onFull, onPart }: Props) {
  const st = collectStatus(inv);
  const meta = STATUS_META[st];
  const rep = repCustomer(inv);

  const stop = (e: React.MouseEvent) => e.stopPropagation();

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(inv)}
      className={cn('cursor-pointer rounded-xl border p-3 transition-transform active:scale-[0.99]', meta.cell)}
    >
      <div className="flex items-center justify-between gap-1">
        <span className="font-mono text-sm font-bold tabular-nums text-zinc-900">
          {inv.room?.name ?? '?'}
        </span>
        {rep.phone && (
          <button
            type="button"
            title={`Zalo ${rep.name}`.trim()}
            onClick={(e) => {
              stop(e);
              window.open(zaloUrl(rep.phone as string), '_blank');
            }}
            className="rounded-full p-1 text-[#0068ff] hover:bg-white/60"
          >
            <MessageCircle className="h-4 w-4" />
          </button>
        )}
      </div>

      <div className="mt-2 flex items-end justify-between gap-2">
        <div className="min-w-0">
          <div className={cn('font-mono text-lg font-bold tabular-nums', meta.text)}>
            {fmtK(inv.total_amount)}
          </div>
          <div className="truncate text-xs text-zinc-500">{cellSubText(inv)}</div>
        </div>

        {st === 'paid' ? (
          <span className="inline-flex items-center gap-1 text-sm font-medium text-[#1f9d57]">
            <Check className="h-4 w-4" />
            Đủ
          </span>
        ) : canRecordPayment ? (
          <div className="flex shrink-0 flex-col gap-1">
            <button
              type="button"
              onClick={(e) => {
                stop(e);
                onFull(inv);
              }}
              className="min-h-[44px] rounded-lg bg-emerald-600 px-3 text-xs font-semibold text-white active:bg-emerald-700"
            >
              Thu đủ
            </button>
            <button
              type="button"
              onClick={(e) => {
                stop(e);
                onPart(inv);
              }}
              className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-xs font-medium text-zinc-700"
            >
              Thu 1P
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default RoomCell;
