// =============================================================================
// PeriodCommissionModal — chi hoa hồng từ trang Đóng tiền Tập trung (10/07).
//
// 2 chế độ theo trạng thái dòng:
//   • unpaid → form đầy đủ (số tiền/người nhận/bank/số TK/sổ/ngày) với 2 nút:
//       "Lưu nháp" (tạo phiếu NHÁP — RPC create_commission_voucher luôn nháp)
//       "Chi & duyệt" (tạo nháp + approve_voucher ngay — cần sổ).
//   • draft  → duyệt phiếu nháp ĐÃ CÓ: nếu thiếu sổ thì bắt chọn (ghi qua
//     update_period_fee) rồi approve. Không tạo phiếu mới (khoá 1 HĐ = 1 phiếu).
// =============================================================================

import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { X, Check, HandCoins, FileText, Info } from 'lucide-react';
import { toast } from 'sonner';
import { fmtFull } from '@/lib/collect';
import { useCreateCommissionVoucher } from '@/hooks/useCommissionVoucher';
import { useApproveVoucher } from '@/hooks/useIncomeExpenses';
import { useUpdatePeriodFee, type PeriodCommissionRow } from '@/hooks/usePeriodFees';
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
  const createComm = useCreateCommissionVoucher();
  const approveMut = useApproveVoucher();
  const updateFee = useUpdatePeriodFee();

  const [amount, setAmount] = useState(0);
  const [recipient, setRecipient] = useState('');
  const [bank, setBank] = useState<string | null>(null);
  const [accNumber, setAccNumber] = useState('');
  const [bookId, setBookId] = useState<string | null>(null);
  const [vdate, setVdate] = useState(todayISO());
  const [busy, setBusy] = useState<'draft' | 'approve' | null>(null);

  useEffect(() => {
    if (!row) return;
    setAmount(row.status === 'draft' ? (row.voucherAmount ?? row.expectedAmount) : row.expectedAmount);
    setRecipient(''); setBank(null); setAccNumber('');
    setBookId(null); setVdate(todayISO()); setBusy(null);
  }, [row?.contractId, row?.status]);

  if (!row) return null;
  const isDraftMode = row.status === 'draft';
  const chosenBook = bookId ?? defaultBookId;
  const doneAndClose = () => {
    qc.invalidateQueries({ queryKey: ['period-commissions'] });
    qc.invalidateQueries({ queryKey: ['income-expenses'] });
    qc.invalidateQueries({ queryKey: ['accounts-with-balance'] });
    onClose();
  };

  // Tạo phiếu (luôn NHÁP theo RPC); approveNow = duyệt ngay sau khi tạo.
  const createVoucher = async (approveNow: boolean) => {
    if (amount <= 0) { toast.error('Nhập số tiền hoa hồng'); return; }
    if (approveNow && !chosenBook) { toast.error('Chọn sổ quỹ để duyệt phiếu'); return; }
    setBusy(approveNow ? 'approve' : 'draft');
    try {
      const res = await createComm.mutateAsync({
        contract_id: row.contractId, contract_number: row.contractNumber,
        building_id: row.buildingId, room_id: row.roomId, tenant_id: null,
        account_id: chosenBook ?? null, voucher_date: vdate,
        kind: 'broker', amount,
        payer_name: row.tenantName || null,
        recipient_name: recipient.trim() || null,
        recipient_bank: bank, recipient_account_number: accNumber.trim() || null,
        item_description: `Hoa hồng môi giới HĐ ${row.contractNumber ?? ''} (${row.tierPercent ?? 0}% × ${row.months} tháng)`,
      });
      if (approveNow && res?.id) {
        await approveMut.mutateAsync(res.id);
        toast.success(`Đã chi & duyệt hoa hồng ${fmtFull(amount)} · HĐ ${row.contractNumber ?? ''}`);
      } else {
        toast.success(`Đã lưu NHÁP hoa hồng ${fmtFull(amount)} · HĐ ${row.contractNumber ?? ''}`);
      }
      doneAndClose();
    } catch { /* toast lỗi từ mutation */ }
    finally { setBusy(null); }
  };

  // Duyệt phiếu NHÁP đã có (gán sổ nếu thiếu).
  const approveExisting = async () => {
    if (!row.voucherId) return;
    if (row.accountIsEmpty && !chosenBook) { toast.error('Phiếu chưa có sổ — chọn sổ quỹ trước'); return; }
    setBusy('approve');
    try {
      if (row.accountIsEmpty && chosenBook) {
        await updateFee.mutateAsync({ voucherId: row.voucherId, accountId: chosenBook });
      }
      await approveMut.mutateAsync(row.voucherId);
      toast.success(`Đã duyệt phiếu hoa hồng · HĐ ${row.contractNumber ?? ''}`);
      doneAndClose();
    } catch { /* toast lỗi từ mutation */ }
    finally { setBusy(null); }
  };

  return (
    <div className="ptt-modal">
      <div className="ptt-modal-scrim" onClick={onClose} />
      <div className="ptt-modal-card ptt-commmodal">
        <div className="ptt-modal-head">
          <span className="ptt-modal-ic"><HandCoins /></span>
          <div className="ptt-modal-h">
            <div className="ptt-modal-title">{isDraftMode ? 'Duyệt phiếu hoa hồng (nháp)' : 'Chi hoa hồng môi giới'}</div>
            <div className="ptt-modal-sub">HĐ {row.contractNumber ?? '—'} · {row.buildingName} · {row.roomName ?? ''} · {row.tenantName}</div>
          </div>
          <button type="button" className="ptt-modal-x" onClick={onClose}><X /></button>
        </div>

        <div className="ptt-edit-body">
          {isDraftMode ? (
            <>
              <div className="ptt-draftpay-amt">
                <span className="ptt-field-lbl">Số tiền phiếu nháp</span>
                <span className="ptt-draftpay-num">{fmtFull(row.voucherAmount ?? 0)}</span>
              </div>
              {row.accountIsEmpty ? (
                <label className="ptt-field">
                  <span className={'ptt-field-lbl' + (!chosenBook ? ' danger' : '')}>Sổ quỹ ghi chi (phiếu đang trống)</span>
                  <UtilityBookMenu accounts={myBooks} valueId={bookId} defaultId={defaultBookId} onPick={setBookId} />
                </label>
              ) : (
                <div className="ptt-note info"><Info /><span>Phiếu đã có sổ <b>{row.voucherAccountName ?? ''}</b> — duyệt sẽ ghi tiền vào sổ này.</span></div>
              )}
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
                <span className="ptt-field-lbl">Sổ quỹ ghi chi</span>
                <UtilityBookMenu accounts={myBooks} valueId={bookId} defaultId={defaultBookId} onPick={setBookId} />
              </label>
              <div className="ptt-note info"><FileText /><span><b>Lưu nháp</b>: phiếu chờ duyệt (chưa vào sổ). <b>Chi &amp; duyệt</b>: ghi tiền vào sổ ngay. Mỗi HĐ chỉ chi HH 1 lần.</span></div>
            </>
          )}
        </div>

        <div className="ptt-modal-foot">
          {isDraftMode ? (
            <>
              <button type="button" className="ptt-btn ghost" onClick={onClose}>Đóng</button>
              <button type="button" className="ptt-btn go" disabled={busy != null} onClick={approveExisting}>
                {busy ? <span className="ub-spin" /> : <Check />}Duyệt phiếu
              </button>
            </>
          ) : (
            <>
              <button type="button" className="ptt-btn ghost" disabled={busy != null} onClick={() => createVoucher(false)}>
                {busy === 'draft' ? <span className="ub-spin dark" /> : null}Lưu nháp
              </button>
              <button type="button" className="ptt-btn go" disabled={busy != null} onClick={() => createVoucher(true)}>
                {busy === 'approve' ? <span className="ub-spin" /> : <Check />}Chi &amp; duyệt
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default PeriodCommissionModal;
