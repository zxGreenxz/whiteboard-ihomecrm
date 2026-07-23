// =============================================================================
// PeriodCommissionModal — chi hoa hồng từ trang Đóng tiền Tập trung (10/07).
//
// Plan §12.7 (2026-07-23): BỎ shortcut create-then-approve ("Chi & duyệt").
//   • unpaid → form đầy đủ (số tiền/người nhận/bank/số TK/sổ/ngày) với MỘT nút
//       "Tạo phiếu Chờ duyệt" — chỉ TẠO phiếu UNAPPROVED (RPC
//       create_commission_voucher), KHÔNG gọi approve_voucher sau đó.
//   • draft (phiếu Chờ duyệt đã có) → modal chỉ hiển thị trạng thái và dẫn
//     sang trang Thu chi để duyệt — không duyệt tại đây, không gán sổ tại đây.
// Phiếu tồn tại ≠ "đã chi": chỉ hiển thị "Chờ duyệt" cho tới khi được duyệt
// ở Thu chi.
// =============================================================================

import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { X, HandCoins, FileText, Info, ExternalLink } from 'lucide-react';
import { toast } from 'sonner';
import { fmtFull } from '@/lib/collect';
import { useCreateCommissionVoucher } from '@/hooks/useCommissionVoucher';
import { type PeriodCommissionRow } from '@/hooks/usePeriodFees';
import { UtilityBookMenu } from './UtilityBookMenu';
import { BankSelect } from '@/components/income-expenses/BankSelect';

const formatVN = (n: number) => (n > 0 ? n.toLocaleString('vi-VN') : '');
const parseVN = (s: string) => { const d = s.replace(/\D/g, ''); return d ? parseInt(d, 10) : 0; };
const todayISO = () => new Date().toISOString().slice(0, 10);

interface Props {
  row: PeriodCommissionRow | null;
  myBooks: { id: string; name: string }[];
  defaultBookId: string | null;
  onClose: () => void;
}

export function PeriodCommissionModal({ row, myBooks, defaultBookId, onClose }: Props) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const createComm = useCreateCommissionVoucher();

  const [amount, setAmount] = useState(0);
  const [recipient, setRecipient] = useState('');
  const [bank, setBank] = useState<string | null>(null);
  const [accNumber, setAccNumber] = useState('');
  const [bookId, setBookId] = useState<string | null>(null);
  const [vdate, setVdate] = useState(todayISO());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!row) return;
    setAmount(row.status === 'draft' ? (row.voucherAmount ?? row.expectedAmount) : row.expectedAmount);
    setRecipient(''); setBank(null); setAccNumber('');
    setBookId(null); setVdate(todayISO()); setBusy(false);
  }, [row?.contractId, row?.status]);

  if (!row) return null;
  const isPendingMode = row.status === 'draft'; // phiếu Chờ duyệt đã tồn tại
  const chosenBook = bookId ?? defaultBookId;
  const doneAndClose = () => {
    qc.invalidateQueries({ queryKey: ['period-commissions'] });
    qc.invalidateQueries({ queryKey: ['income-expenses'] });
    qc.invalidateQueries({ queryKey: ['accounts-with-balance'] });
    onClose();
  };

  // Tạo phiếu Chờ duyệt (RPC create_commission_voucher — luôn UNAPPROVED).
  // KHÔNG có nhánh approve ngay sau khi tạo (plan §12.7).
  const createVoucher = async () => {
    if (amount <= 0) { toast.error('Nhập số tiền hoa hồng'); return; }
    setBusy(true);
    try {
      await createComm.mutateAsync({
        contract_id: row.contractId, contract_number: row.contractNumber,
        building_id: row.buildingId, room_id: row.roomId, tenant_id: null,
        account_id: chosenBook ?? null, voucher_date: vdate,
        kind: 'broker', amount,
        payer_name: row.tenantName || null,
        recipient_name: recipient.trim() || null,
        recipient_bank: bank, recipient_account_number: accNumber.trim() || null,
        item_description: `Hoa hồng môi giới HĐ ${row.contractNumber ?? ''} (${row.tierPercent ?? 0}% × ${row.months} tháng)`,
      });
      toast.success(`Đã tạo phiếu Chờ duyệt ${fmtFull(amount)} · HĐ ${row.contractNumber ?? ''} — duyệt tại trang Thu chi`);
      doneAndClose();
    } catch { /* toast lỗi từ mutation */ }
    finally { setBusy(false); }
  };

  // Phiếu Chờ duyệt đã có → dẫn sang Thu chi để duyệt (không duyệt tại đây).
  const goToIncomeExpense = () => {
    onClose();
    navigate('/income-expense');
  };

  return (
    <div className="ptt-modal">
      <div className="ptt-modal-scrim" onClick={onClose} />
      <div className="ptt-modal-card ptt-commmodal">
        <div className="ptt-modal-head">
          <span className="ptt-modal-ic"><HandCoins /></span>
          <div className="ptt-modal-h">
            <div className="ptt-modal-title">{isPendingMode ? 'Phiếu hoa hồng Chờ duyệt' : 'Chi hoa hồng môi giới'}</div>
            <div className="ptt-modal-sub">HĐ {row.contractNumber ?? '—'} · {row.buildingName} · {row.roomName ?? ''} · {row.tenantName}</div>
          </div>
          <button type="button" className="ptt-modal-x" onClick={onClose}><X /></button>
        </div>

        <div className="ptt-edit-body">
          {isPendingMode ? (
            <>
              <div className="ptt-draftpay-amt">
                <span className="ptt-field-lbl">Số tiền phiếu Chờ duyệt</span>
                <span className="ptt-draftpay-num">{fmtFull(row.voucherAmount ?? 0)}</span>
              </div>
              {row.accountIsEmpty ? (
                <div className="ptt-note info"><Info /><span>Phiếu chưa gán sổ quỹ — chọn sổ khi duyệt ở trang Thu chi.</span></div>
              ) : (
                <div className="ptt-note info"><Info /><span>Phiếu đã có sổ <b>{row.voucherAccountName ?? ''}</b> — khi duyệt ở Thu chi, tiền ghi vào sổ này.</span></div>
              )}
              <div className="ptt-note info"><FileText /><span>Phiếu đang <b>Chờ duyệt</b> (chưa vào sổ). Việc duyệt thực hiện ở trang <b>Thu chi</b>.</span></div>
            </>
          ) : (
            <>
              <div className="ptt-edit-row">
                <label className="ptt-field">
                  <span className="ptt-field-lbl">Số tiền HH ({row.tierPercent ?? 0}% × {row.months} th)</span>
                  <input className="ptt-field-in mono num" value={formatVN(amount)} inputMode="numeric" onChange={(e) => setAmount(parseVN(e.target.value))} />
                </label>
                <label className="ptt-field">
                  <span className="ptt-field-lbl">Ngày chi</span>
                  <input type="date" className="ptt-field-in" value={vdate} onChange={(e) => setVdate(e.target.value)} />
                </label>
              </div>
              <label className="ptt-field">
                <span className="ptt-field-lbl">Người nhận (môi giới)</span>
                <input className="ptt-field-in" value={recipient} placeholder="Tên người/đơn vị nhận HH" onChange={(e) => setRecipient(e.target.value)} />
              </label>
              <div className="ptt-edit-row">
                <label className="ptt-field">
                  <span className="ptt-field-lbl">Ngân hàng</span>
                  <BankSelect value={bank} onChange={setBank} className="ptt-bank" placeholder="Chọn ngân hàng (nếu CK)" />
                </label>
                <label className="ptt-field">
                  <span className="ptt-field-lbl">Số tài khoản</span>
                  <input className="ptt-field-in mono" value={accNumber} placeholder="STK người nhận" onChange={(e) => setAccNumber(e.target.value)} />
                </label>
              </div>
              <label className="ptt-field">
                <span className="ptt-field-lbl">Sổ quỹ ghi chi (tuỳ chọn — có thể gán khi duyệt)</span>
                <UtilityBookMenu accounts={myBooks} valueId={bookId} defaultId={defaultBookId} onPick={setBookId} />
              </label>
              <div className="ptt-note info"><FileText /><span>Phiếu tạo ra ở trạng thái <b>Chờ duyệt</b> (chưa vào sổ) — duyệt tại trang <b>Thu chi</b>. Mỗi HĐ chỉ chi HH 1 lần.</span></div>
            </>
          )}
        </div>

        <div className="ptt-modal-foot">
          {isPendingMode ? (
            <>
              <button type="button" className="ptt-btn ghost" onClick={onClose}>Đóng</button>
              <button type="button" className="ptt-btn go" onClick={goToIncomeExpense}>
                <ExternalLink />Mở Thu chi để duyệt
              </button>
            </>
          ) : (
            <>
              <button type="button" className="ptt-btn ghost" disabled={busy} onClick={onClose}>Huỷ</button>
              <button type="button" className="ptt-btn go" disabled={busy} onClick={createVoucher}>
                {busy ? <span className="ub-spin" /> : <FileText />}Tạo phiếu Chờ duyệt
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default PeriodCommissionModal;
