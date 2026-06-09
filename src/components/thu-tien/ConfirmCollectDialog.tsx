import { Wallet } from 'lucide-react';
import { fmtFull, remainingOf } from '@/lib/collect';
import type { InvoiceWithRelations } from '@/types/invoice';

interface Props {
  invoice: InvoiceWithRelations | null;
  show: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Chống bấm nhầm "Thu đủ" ở ô phòng (.confirm + scrim riêng). */
export function ConfirmCollectDialog({ invoice, show, onConfirm, onCancel }: Props) {
  const code =
    invoice?.building?.name && invoice?.room?.name
      ? `${invoice.building.name} - ${invoice.room.name}`
      : invoice?.room?.name ?? '';

  return (
    <>
      <div className={'sheet-scrim' + (show ? ' show' : '')} onClick={onCancel} />
      <div className={'confirm' + (show ? ' show' : '')}>
        {invoice && (
          <>
            <div className="cf-ic">
              <Wallet />
            </div>
            <div className="cf-title">Xác nhận thu đủ?</div>
            <div className="cf-room">{code}</div>
            <div className="cf-amt">{fmtFull(remainingOf(invoice))}</div>
            <div className="cf-msg">Đánh dấu phòng này đã thu đủ tiền mặt.</div>
            <div className="cf-acts">
              <button type="button" className="cf-btn cancel" onClick={onCancel}>
                Hủy
              </button>
              <button type="button" className="cf-btn ok" onClick={onConfirm}>
                Thu đủ
              </button>
            </div>
          </>
        )}
      </div>
    </>
  );
}

export default ConfirmCollectDialog;
