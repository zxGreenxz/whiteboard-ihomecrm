import { Check, MessageCircle } from 'lucide-react';
import {
  collectStatus,
  cellSubText,
  fmtK,
  paymentsInRange,
  repCustomer,
  todayISO,
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

/** Ô phòng = 1 hoá đơn (layout "Ô vừa" — .icell). Nền tô theo trạng thái thu. */
export function RoomCell({ inv, canRecordPayment, onOpen, onFull, onPart }: Props) {
  const st = collectStatus(inv);
  const rep = repCustomer(inv);
  // Phòng thu 1 phần: nhắc số tiền ĐÃ thu trong hôm nay phía trên nút Thu đủ.
  const todaySum = paymentsInRange(inv, todayISO(), todayISO()).sum;
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
          <div className="ic-sub">{cellSubText(inv)}</div>
        </div>
        {st === 'paid' ? (
          <span className="cell-done">
            <Check />
            Đủ
          </span>
        ) : canRecordPayment ? (
          <div className="cell-acts">
            {todaySum > 0 && <span className="cell-today">Thu hnay {fmtK(todaySum)}</span>}
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
