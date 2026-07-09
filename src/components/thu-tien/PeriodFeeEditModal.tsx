// =============================================================================
// PeriodFeeEditModal V2 — Sửa 1 phiếu CỤ THỂ (seed từ vouchers payload).
//   • Admin  → sửa toàn bộ (tiền, kỳ, sổ, ảnh, ghi chú). Phiếu NHIỀU DÒNG:
//     khoá tiền/kỳ (server cũng chặn) — sửa ở trang Thu chi.
//   • Manager→ chỉ thêm ảnh + gán sổ khi đang trống.
// Ảnh: hiện ảnh ĐANG CÓ (không bị đè mất khi thêm mới — merge ở hook).
// =============================================================================

import { useEffect, useState } from 'react';
import { X, Edit3, Camera, Check, AlertTriangle, Info } from 'lucide-react';
import { UtilityBookMenu } from './UtilityBookMenu';
import { UtilityReceiptThumb } from './UtilityReceiptThumb';
import type { FeeEditTarget } from '@/hooks/usePeriodFeeState';

const formatVN = (n: number) => (n > 0 ? n.toLocaleString('vi-VN') : '');
const parseVN = (s: string) => { const d = s.replace(/\D/g, ''); return d ? parseInt(d, 10) : 0; };

interface Props {
  target: FeeEditTarget | null;
  isAdmin: boolean;
  myBooks: { id: string; name: string }[];
  saving: boolean;
  uploading: boolean;
  onAttach: () => void;
  onView: (attachments: string[]) => void;
  onClose: () => void;
  onSave: (args: { amount?: number; periodStart?: string; periodEnd?: string; accountId?: string | null; notes?: string }) => void;
}

export function PeriodFeeEditModal({ target, isAdmin, myBooks, saving, uploading, onAttach, onView, onClose, onSave }: Props) {
  const [amount, setAmount] = useState(0);
  const [pStart, setPStart] = useState('');
  const [pEnd, setPEnd] = useState('');
  const [notes, setNotes] = useState('');
  const [accountId, setAccountId] = useState<string | null>(null);

  useEffect(() => {
    if (!target) return;
    setAmount(target.amount);
    setPStart(target.periodStart);
    setPEnd(target.periodEnd);
    setNotes(target.notes);
    setAccountId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.voucherId]);

  if (!target) return null;

  const bookEmpty = target.accountIsEmpty;
  const canSetBook = isAdmin || bookEmpty;
  const multiItem = target.itemCount > 1;
  const lockAmount = !isAdmin || multiItem;
  const allAtts = [...target.existingAttachments, ...target.newAttachments];

  const handleSave = () => {
    onSave({
      amount: isAdmin && !multiItem ? amount : undefined,
      periodStart: isAdmin && !multiItem ? pStart : undefined,
      periodEnd: isAdmin && !multiItem ? pEnd : undefined,
      accountId,
      notes: isAdmin ? notes : undefined,
    });
  };

  return (
    <div className="ptt-modal">
      <div className="ptt-modal-scrim" onClick={onClose} />
      <div className="ptt-modal-card ptt-edit">
        <div className="ptt-modal-head">
          <span className="ptt-modal-ic"><Edit3 /></span>
          <div className="ptt-modal-h"><div className="ptt-modal-title">Sửa phiếu chi</div><div className="ptt-modal-sub">{target.title}</div></div>
          <button type="button" className="ptt-modal-x" onClick={onClose}><X /></button>
        </div>

        <div className="ptt-edit-role">
          <span className="ptt-edit-role-lbl">Quyền</span>
          <span className={'ptt-edit-role-badge ' + (isAdmin ? 'admin' : 'mgr')}>
            {isAdmin ? 'Admin · sửa toàn bộ' : 'Quản lý · giới hạn'}
          </span>
          {target.isAuto && <span className="ptt-auto">TỰ ĐỘNG</span>}
        </div>

        {target.accountIsEmpty && (
          <div className="ptt-note warn">
            <AlertTriangle />
            <span>Phiếu <b>chưa gán sổ quỹ</b> — số dư sổ chỉ cập nhật sau khi gán sổ bên dưới.</span>
          </div>
        )}
        {multiItem && (
          <div className="ptt-note info">
            <Info />
            <span>Phiếu có <b>{target.itemCount} dòng hạng mục</b> — sửa số tiền/kỳ ở trang Thu chi; tại đây chỉ sửa sổ/ảnh/ghi chú.</span>
          </div>
        )}

        <div className="ptt-edit-body">
          <div className="ptt-edit-row">
            <label className="ptt-field">
              <span className="ptt-field-lbl">Số tiền</span>
              <input className="ptt-field-in mono num" value={formatVN(amount)} disabled={lockAmount} inputMode="numeric" onChange={(e) => setAmount(parseVN(e.target.value))} />
            </label>
            <label className="ptt-field">
              <span className="ptt-field-lbl">Tòa</span>
              <input className="ptt-field-in" value={target.buildingName} disabled />
            </label>
          </div>

          {target.multi && (
            <label className="ptt-field">
              <span className="ptt-field-lbl">Kỳ áp dụng</span>
              <span className="ptt-range">
                <input type="month" className="ptt-field-in" value={pStart} disabled={lockAmount} onChange={(e) => setPStart(e.target.value)} />
                <span className="ptt-range-arrow">→</span>
                <input type="month" className="ptt-field-in" value={pEnd} disabled={lockAmount} onChange={(e) => setPEnd(e.target.value)} />
              </span>
            </label>
          )}

          <div className="ptt-edit-row">
            <label className="ptt-field">
              <span className={'ptt-field-lbl' + (bookEmpty ? ' danger' : '')}>Sổ quỹ ghi chi {bookEmpty ? '· đang trống' : ''}</span>
              {canSetBook ? (
                <UtilityBookMenu accounts={myBooks} valueId={accountId} defaultId={null} onPick={(id) => setAccountId(id)} />
              ) : (
                <input className="ptt-field-in" value={target.bookName || '—'} disabled />
              )}
            </label>
            {!bookEmpty && canSetBook && (
              <label className="ptt-field">
                <span className="ptt-field-lbl">Sổ hiện tại</span>
                <input className="ptt-field-in" value={target.bookName || '—'} disabled />
              </label>
            )}
          </div>

          {isAdmin && (
            <label className="ptt-field">
              <span className="ptt-field-lbl">Ghi chú</span>
              <input className="ptt-field-in" value={notes} placeholder="Ghi chú phiếu…" onChange={(e) => setNotes(e.target.value)} />
            </label>
          )}

          <div className="ptt-field">
            <span className="ptt-field-lbl">Ảnh phiếu chi {allAtts.length > 0 ? `(${allAtts.length})` : ''}</span>
            <div className="ptt-edit-attach">
              <UtilityReceiptThumb attachments={allAtts} onView={onView} size="md" />
              <button type="button" className="ptt-edit-addimg" disabled={uploading} onClick={onAttach}>
                {uploading ? <span className="ub-spin dark" /> : <Camera />}
                {target.newAttachments.length > 0 ? `Đã thêm ${target.newAttachments.length} ảnh mới` : 'Thêm ảnh phiếu'}
              </button>
            </div>
          </div>

          {!isAdmin && (
            <div className="ptt-note info">
              <Info />
              <span>Quyền <b>Quản lý</b>: chỉ được <b>thêm ảnh phiếu</b> và <b>gán sổ quỹ khi đang trống</b>. Muốn sửa số tiền/kỳ cần quyền Admin.</span>
            </div>
          )}
        </div>

        <div className="ptt-modal-foot">
          <button type="button" className="ptt-btn ghost" onClick={onClose}>Hủy</button>
          <button type="button" className="ptt-btn go" disabled={saving} onClick={handleSave}>
            {saving ? <span className="ub-spin" /> : <Check />}Lưu thay đổi
          </button>
        </div>
      </div>
    </div>
  );
}

export default PeriodFeeEditModal;
