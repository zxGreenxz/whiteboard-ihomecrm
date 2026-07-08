// =============================================================================
// PeriodFeeEditModal — Sửa phiếu phí đã có. Vai trò xác định server-side; FE hiển
// thị theo isAdmin thật (không phải toggle demo):
//   • Admin  → sửa toàn bộ (số tiền, kỳ, sổ, ảnh, ghi chú).
//   • Manager→ chỉ thêm ảnh + gán sổ khi đang trống.
// =============================================================================

import { useEffect, useState } from 'react';
import { X, Edit3, Camera, Check, AlertTriangle, Info } from 'lucide-react';
import { UtilityBookMenu } from './UtilityBookMenu';
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
  onClose: () => void;
  onSave: (args: { amount?: number; periodStart?: string; periodEnd?: string; accountId?: string | null; notes?: string }) => void;
}

export function PeriodFeeEditModal({ target, isAdmin, myBooks, saving, uploading, onAttach, onClose, onSave }: Props) {
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
  }, [target?.voucherId]);

  if (!target) return null;

  const bookEmpty = target.accountIsEmpty;
  const canSetBook = isAdmin || bookEmpty; // manager: chỉ gán khi trống

  const handleSave = () => {
    onSave({
      amount: isAdmin ? amount : undefined,
      periodStart: isAdmin ? pStart : undefined,
      periodEnd: isAdmin ? pEnd : undefined,
      accountId: accountId, // null nếu không đổi
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
        </div>

        {target.accountIsEmpty && (
          <div className="ptt-note warn">
            <AlertTriangle />
            <span>Phiếu <b>"(tự động lập)"</b> — chưa gán sổ quỹ. Số dư sổ chỉ cập nhật sau khi gán sổ bên dưới.</span>
          </div>
        )}

        <div className="ptt-edit-body">
          <div className="ptt-edit-row">
            <label className="ptt-field">
              <span className="ptt-field-lbl">Số tiền</span>
              <input className="ptt-field-in mono num" value={formatVN(amount)} disabled={!isAdmin} inputMode="numeric" onChange={(e) => setAmount(parseVN(e.target.value))} />
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
                <input type="month" className="ptt-field-in" value={pStart} disabled={!isAdmin} onChange={(e) => setPStart(e.target.value)} />
                <span className="ptt-range-arrow">→</span>
                <input type="month" className="ptt-field-in" value={pEnd} disabled={!isAdmin} onChange={(e) => setPEnd(e.target.value)} />
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
          </div>

          {isAdmin && (
            <label className="ptt-field">
              <span className="ptt-field-lbl">Ghi chú</span>
              <input className="ptt-field-in" value={notes} placeholder="Ghi chú phiếu…" onChange={(e) => setNotes(e.target.value)} />
            </label>
          )}

          <div className="ptt-field">
            <span className="ptt-field-lbl">Ảnh phiếu chi</span>
            <div className="ptt-edit-attach">
              {(target.hasReceipt || target.attachments.length > 0) && <span className="ptt-edit-thumb"><Camera /></span>}
              <button type="button" className="ptt-edit-addimg" disabled={uploading} onClick={onAttach}>
                {uploading ? <span className="ub-spin dark" /> : <Camera />}
                {target.attachments.length > 0 ? `Đã thêm ${target.attachments.length} ảnh` : 'Thêm ảnh phiếu'}
              </button>
            </div>
          </div>

          {!isAdmin && (
            <div className="ptt-note info">
              <Info />
              <span>Quyền <b>Quản lý</b>: chỉ được <b>thêm ảnh phiếu</b> và <b>gán sổ quỹ khi đang trống</b>. Muốn sửa số tiền/kỳ/tòa cần quyền Admin.</span>
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
