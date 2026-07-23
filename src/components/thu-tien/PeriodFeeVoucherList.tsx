// =============================================================================
// PeriodFeeVoucherList + PeriodFeePayDraftModal + PeriodFeeDupConfirmModal
// — bộ modal per-voucher cho trang Đóng tiền Tập trung (dùng chung 2 surface).
//
//   • VoucherList: 1 ô có NHIỀU phiếu → liệt kê từng phiếu (ngày, tiền, sổ,
//     badge TỰ ĐỘNG/CHỜ DUYỆT, ảnh) với Sửa / Hủy / Thanh toán đúng TỪNG phiếu.
//   • PayDraftModal: thanh toán phiếu CHỜ DUYỆT (recurring draft-mode) — bắt buộc
//     chọn sổ + đính ảnh CK → duyệt nguyên tử qua pay_draft_fee_voucher.
//   • DupConfirmModal: xác nhận đóng THÊM khi kỳ đã có phiếu (chống trùng).
// =============================================================================

import { useEffect, useState } from 'react';
import { X, Edit3, Camera, Check, AlertTriangle, HandCoins, FileText } from 'lucide-react';
import { fmtFull } from '@/lib/collect';
import { UtilityBookMenu } from './UtilityBookMenu';
import { UtilityReceiptThumb } from './UtilityReceiptThumb';
import { BookIcon } from './utilityIcons';
import type { PeriodFeeVoucher } from '@/hooks/usePeriodFees';
import type { DraftPayTarget, DupConfirm } from '@/hooks/usePeriodFeeState';

const fmtDate = (d?: string | null) => (d ? d.slice(0, 10).split('-').reverse().join('/') : '');

// ── Danh sách phiếu của 1 ô ──────────────────────────────────────────────────
interface VoucherListProps {
  open: boolean;
  title: string;                       // "Quản Lý · 102LVT"
  vouchers: PeriodFeeVoucher[];
  canRecordPayment: boolean;
  onView: (attachments: string[]) => void;
  onEdit: (v: PeriodFeeVoucher) => void;
  onCancel: (v: PeriodFeeVoucher) => void;
  onPayDraft: (v: PeriodFeeVoucher) => void;
  onClose: () => void;
}

export function PeriodFeeVoucherList({ open, title, vouchers, canRecordPayment, onView, onEdit, onCancel, onPayDraft, onClose }: VoucherListProps) {
  if (!open) return null;
  const paid = vouchers.filter((v) => v.status === 'APPROVED');
  const total = paid.reduce((s, v) => s + v.amount, 0);
  return (
    <div className="ptt-modal">
      <div className="ptt-modal-scrim" onClick={onClose} />
      <div className="ptt-modal-card ptt-vlist">
        <div className="ptt-modal-head">
          <span className="ptt-modal-ic"><FileText /></span>
          <div className="ptt-modal-h">
            <div className="ptt-modal-title">Phiếu trong kỳ</div>
            <div className="ptt-modal-sub">{title} · {vouchers.length} phiếu · đã chi {fmtFull(total)}</div>
          </div>
          <button type="button" className="ptt-modal-x" onClick={onClose}><X /></button>
        </div>
        <div className="ptt-vlist-body">
          {vouchers.map((v) => (
            <div className="ptt-vrow" key={v.id}>
              <div className="ptt-vrow-main">
                <div className="ptt-vrow-l1">
                  <span className="ptt-vrow-amt">{fmtFull(v.amount)}</span>
                  {v.status === 'UNAPPROVED' && <span className="ptt-badge-draft">CHỜ DUYỆT</span>}
                  {v.isAuto && <span className="ptt-auto">TỰ ĐỘNG</span>}
                  {v.inBatch && <span className="ptt-badge-batch">PHIẾU TỔNG</span>}
                </div>
                <div className="ptt-vrow-l2">
                  <span>{fmtDate(v.date)}</span>
                  {v.creatorName && <span>· {v.creatorName}</span>}
                  <span className="ptt-vrow-book"><BookIcon size={12} />{v.accountName ?? 'chưa có sổ'}</span>
                </div>
              </div>
              <UtilityReceiptThumb attachments={v.attachments} onView={onView} size="sm" />
              <span className="ptt-vrow-acts">
                {v.status === 'UNAPPROVED' && (
                  <button type="button" className="ptt-vrow-pay" disabled={!canRecordPayment} onClick={() => onPayDraft(v)}>
                    <HandCoins />Thanh toán
                  </button>
                )}
                <button type="button" className="ptt-edit-btn" title="Sửa phiếu" onClick={() => onEdit(v)}><Edit3 /></button>
                {v.cancellable && (
                  <button type="button" className="ud-cancel" title="Hủy phiếu" disabled={!canRecordPayment} onClick={() => onCancel(v)}><X /></button>
                )}
              </span>
            </div>
          ))}
        </div>
        <div className="ptt-modal-foot">
          <button type="button" className="ptt-btn ghost" onClick={onClose}>Đóng</button>
        </div>
      </div>
    </div>
  );
}

// ── Thanh toán phiếu CHỜ DUYỆT ────────────────────────────────────────────────────
interface PayDraftProps {
  target: DraftPayTarget | null;
  myBooks: { id: string; name: string }[];
  defaultBookId: string | null;
  attachments: string[];            // ảnh sẽ lưu (cũ + mới thêm)
  uploading: boolean;
  busy: boolean;
  onAttach: () => void;
  onView: (attachments: string[]) => void;
  onClose: () => void;
  onSubmit: (accountId: string) => void;
}

export function PeriodFeePayDraftModal({ target, myBooks, defaultBookId, attachments, uploading, busy, onAttach, onView, onClose, onSubmit }: PayDraftProps) {
  const [accountId, setAccountId] = useState<string | null>(null);
  useEffect(() => { setAccountId(null); }, [target?.voucher.id]);
  if (!target) return null;
  const chosen = accountId ?? defaultBookId;
  return (
    <div className="ptt-modal">
      <div className="ptt-modal-scrim" onClick={onClose} />
      <div className="ptt-modal-card ptt-draftpay">
        <div className="ptt-modal-head">
          <span className="ptt-modal-ic"><HandCoins /></span>
          <div className="ptt-modal-h">
            <div className="ptt-modal-title">Thanh toán phiếu chờ duyệt</div>
            <div className="ptt-modal-sub">{target.categoryLabel} · {target.buildingName} · {fmtDate(target.voucher.date)}</div>
          </div>
          <button type="button" className="ptt-modal-x" onClick={onClose}><X /></button>
        </div>

        <div className="ptt-edit-body">
          <div className="ptt-draftpay-amt">
            <span className="ptt-field-lbl">Số tiền phiếu</span>
            <span className="ptt-draftpay-num">{fmtFull(target.voucher.amount)}</span>
            {target.voucher.isAuto && <span className="ptt-auto">TỰ ĐỘNG</span>}
          </div>

          <label className="ptt-field">
            <span className={'ptt-field-lbl' + (!chosen ? ' danger' : '')}>Sổ quỹ ghi chi (bắt buộc)</span>
            <UtilityBookMenu accounts={myBooks} valueId={accountId} defaultId={defaultBookId} onPick={setAccountId} />
          </label>

          <div className="ptt-field">
            <span className="ptt-field-lbl">Ảnh chứng từ / CK</span>
            <div className="ptt-edit-attach">
              <UtilityReceiptThumb attachments={attachments} onView={onView} size="md" />
              <button type="button" className="ptt-edit-addimg" disabled={uploading} onClick={onAttach}>
                {uploading ? <span className="ub-spin dark" /> : <Camera />}
                {attachments.length > 0 ? `Đã có ${attachments.length} ảnh — thêm nữa` : 'Thêm ảnh chứng từ'}
              </button>
            </div>
          </div>

          <div className="ptt-note info">
            <AlertTriangle />
            <span>Xác nhận sẽ <b>gán sổ + lưu ảnh + DUYỆT phiếu</b> — tiền được ghi vào sổ quỹ ngay.</span>
          </div>
        </div>

        <div className="ptt-modal-foot">
          <button type="button" className="ptt-btn ghost" onClick={onClose}>Hủy</button>
          <button type="button" className="ptt-btn go" disabled={busy || !chosen} onClick={() => chosen && onSubmit(chosen)}>
            {busy ? <span className="ub-spin" /> : <Check />}Thanh toán & duyệt
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Xác nhận đóng TRÙNG ──────────────────────────────────────────────────────
interface DupProps {
  target: DupConfirm | null;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}

export function PeriodFeeDupConfirmModal({ target, busy, onClose, onConfirm }: DupProps) {
  if (!target) return null;
  return (
    <div className="ptt-modal">
      <div className="ptt-modal-scrim" onClick={onClose} />
      <div className="ptt-modal-card ptt-dup">
        <div className="ptt-dup-ic"><AlertTriangle /></div>
        <div className="ptt-dup-title">Kỳ này đã có phiếu</div>
        <div className="ptt-dup-sub">
          Tòa <b>{target.buildingName}</b> đã có <b>{target.existingCount} phiếu</b> hạng mục này trong kỳ
          (tổng <b>{fmtFull(target.existingAmount)}</b>).
        </div>
        <div className="ptt-note warn"><AlertTriangle /><span>Vẫn đóng <b>THÊM {fmtFull(target.amount)}</b>? Phiếu mới sẽ cộng dồn vào tổng chi của kỳ.</span></div>
        <div className="ptt-modal-foot">
          <button type="button" className="ptt-btn ghost" onClick={onClose}>Không — giữ nguyên</button>
          <button type="button" className="ptt-btn go" disabled={busy} onClick={onConfirm}>
            {busy ? <span className="ub-spin" /> : <Check />}Đóng thêm
          </button>
        </div>
      </div>
    </div>
  );
}

export default PeriodFeeVoucherList;
