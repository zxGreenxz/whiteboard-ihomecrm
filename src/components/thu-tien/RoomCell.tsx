import { Check, MessageCircle } from 'lucide-react';
import { collectStatus, cellSubTextNamed, fmtK, repCustomer, zaloUrl } from '@/lib/collect';
import type { InvoiceWithRelations } from '@/types/invoice';

interface Props {
  inv: InvoiceWithRelations;
  /** Tên người thu theo thứ tự thu (creator_name phiếu thu) — [] nếu chưa có dữ liệu. */
  collectors?: string[];
  canRecordPayment: boolean;
  onOpen: (inv: InvoiceWithRelations) => void;
  onFull: (inv: InvoiceWithRelations) => void;
  onPart: (inv: InvoiceWithRelations) => void;
}

/** Ô phòng = 1 hoá đơn (layout "Ô vừa" — .icell). Nền tô theo trạng thái thu. */
export function RoomCell({ inv, collectors = [], canRecordPayment, onOpen, onFull, onPart }: Props) {
  const st = collectStatus(inv);
  const rep = repCustomer(inv);
  const stop = (e: React.MouseEvent) => e.stopPropagation();

  return (
    <div className={'icell ' + st} onClick={() => onOpen(inv)}>
      <div className="it-top">
        <span className="ic-code">{inv.room?.name ?? '?'}</span>
        {rep.phone && (
          <button
            type="button"
            className="ic-chat"
            title={`Zalo ${rep.name}`.trim()}
            onClick={(e) => {
              stop(e);
              window.open(zaloUrl(rep.phone as string), '_blank');
            }}
          >
            <MessageCircle />
          </button>
        )}
      </div>
      <div className="it-main">
        <div className="it-amtwrap">
          <div className="ic-amt">{fmtK(inv.total_amount)}</div>
          <div className="ic-sub">{cellSubTextNamed(inv, collectors)}</div>
        </div>
        {st === 'paid' ? (
          <span className="cell-done">
            <Check />
            Đủ
          </span>
        ) : canRecordPayment ? (
          <div className="cell-acts">
            <button
              type="button"
              className="cell-btn full"
              onClick={(e) => {
                stop(e);
                onFull(inv);
              }}
            >
              Thu đủ
            </button>
            <button
              type="button"
              className="cell-btn part"
              onClick={(e) => {
                stop(e);
                onPart(inv);
              }}
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
