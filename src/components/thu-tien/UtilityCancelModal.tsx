// =============================================
// UtilityCancelModal — hộp thoại xác nhận "Hủy phiếu thanh toán?" (điện/nước).
// Port 100% từ mockup (khối cancelModal trong Đóng tiền Điện nước.dc.html).
// Overlay position:fixed → dùng chung cho cả desktop panel lẫn sheet mobile.
// =============================================

import { TriangleAlert, AlertCircle, X } from 'lucide-react';
import { fmtFull } from '@/lib/collect';
import { BookIcon } from './utilityIcons';

export interface CancelTarget {
  voucherId: string;
  bld: string;
  typeText: string; // 'điện' | 'nước'
  amount: number;
  dateText: string;
  timeText: string;
  by: string;
  book: string;
}

interface Props {
  target: CancelTarget | null;
  busy?: boolean;
  onClose: () => void;
  onConfirm: () => void;
}

export function UtilityCancelModal({ target, busy, onClose, onConfirm }: Props) {
  if (!target) return null;
  return (
    <div className="uc-overlay" role="dialog" aria-modal="true">
      <div className="uc-scrim" onClick={onClose} />
      <div className="uc-modal">
        <div className="uc-ic"><TriangleAlert /></div>
        <div className="uc-title">Hủy phiếu thanh toán?</div>
        <div className="uc-desc">
          Bạn sắp hủy phiếu chi <b>tiền {target.typeText}</b> của tòa{' '}
          <b className="uc-mono">{target.bld}</b>.
        </div>
        <div className="uc-box">
          <div className="uc-box-row">
            <span className="uc-box-l">Số tiền</span>
            <span className="uc-amt">{fmtFull(target.amount)}</span>
          </div>
          <div className="uc-meta">
            <span>{target.dateText}{target.timeText ? ` · ${target.timeText}` : ''}</span>
            {target.by && <><span>·</span><span>{target.by}</span></>}
            {target.book && (
              <span className="uc-book"><BookIcon size={13} />{target.book}</span>
            )}
          </div>
        </div>
        <div className="uc-warn">
          <AlertCircle />
          <span>
            Phiếu sẽ được gỡ khỏi sổ quỹ <b>{target.book || '—'}</b> và tòa quay lại trạng thái{' '}
            <b>chưa đóng</b>.
          </span>
        </div>
        <div className="uc-acts">
          <button type="button" className="uc-keep" onClick={onClose} disabled={busy}>Giữ lại</button>
          <button type="button" className="uc-del" onClick={onConfirm} disabled={busy}>
            {busy ? <span className="ub-spin" /> : <X />} Hủy phiếu
          </button>
        </div>
      </div>
    </div>
  );
}

export default UtilityCancelModal;
