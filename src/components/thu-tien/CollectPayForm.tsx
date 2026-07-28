// =============================================
// CollectPayForm — form thu tiền trong drawer chi tiết phòng.
// Tách nhiều dòng phương thức (TM/TK/TT, mỗi dòng vào đúng sổ riêng) +
// tiền thối / nợ khách khi tiền mặt thu DƯ (đúng như trang Hoá đơn) +
// ngày + ảnh chứng từ. Ghi chú dùng NoteEditor chung của drawer.
//
// Presentational: KHÔNG gọi mutation/upload. Tính tiền cuối cùng + validate
// nằm ở planCollect (drawer → useQuickCollect); form chỉ thu input + gợi ý.
// =============================================

import { useEffect, useMemo, useRef, useState } from 'react';
import { ImagePlus, Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import { useClipboardImagePaste } from '@/hooks/useClipboardImagePaste';
import { validateReceiptFile } from '@/lib/receiptUpload';
import type { CollectMethod } from '@/lib/cashAccount';
import { fmtFull, fmtShort, todayISO } from '@/lib/collect';
import { deriveOverpayPolicy } from '@/lib/collectPlan';

const formatVN = (n: number) => (n > 0 ? n.toLocaleString('vi-VN') : '');
const parseVN = (s: string): number => {
  const digits = s.replace(/\D/g, '');
  return digits ? parseInt(digits, 10) : 0;
};

interface PayLine {
  method: CollectMethod;
  amount: number;
}

export interface PayFormSubmit {
  lines: PayLine[];
  keepAsCredit: boolean;
  paymentDate: string;
  /** CHƯA upload — drawer upload trước khi gọi collect. */
  receiptFile: File | null;
}

/** Trạng thái form báo lên drawer — nút xanh dưới cùng dùng để hiển thị + submit. */
export interface PayFormState {
  total: number;
  overpay: number;
  /** Đang giữ nợ khách (đã có overpay). */
  keepAsCredit: boolean;
  canSubmit: boolean;
  /** Payload để thu; null nếu chưa hợp lệ. */
  payload: PayFormSubmit | null;
}

interface Props {
  remaining: number;
  methodAvailable: Record<CollectMethod, boolean>;
  /** Tên sổ "…Thối" để hiển thị; '' nếu chưa có. */
  changeAccountName?: string;
  /** Hoá đơn có hợp đồng → cho phép "Nợ khách". */
  canCredit: boolean;
  /** Báo trạng thái lên drawer (nút xanh dưới cùng submit). */
  onChange: (state: PayFormState) => void;
}

const ALL: CollectMethod[] = ['TM', 'TK', 'TT'];

export function CollectPayForm({
  remaining,
  methodAvailable,
  changeAccountName,
  canCredit,
  onChange,
}: Props) {
  const available = useMemo(() => ALL.filter((m) => methodAvailable[m]), [methodAvailable]);
  const firstMethod = available[0] ?? 'TM';

  const [lines, setLines] = useState<PayLine[]>([{ method: firstMethod, amount: remaining }]);
  const [keepAsCredit, setKeepAsCredit] = useState(false);
  const [paymentDate, setPaymentDate] = useState(todayISO());
  const [receiptFile, setReceiptFile] = useState<File | null>(null);
  const [receiptPreview, setReceiptPreview] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const wasForcedCreditRef = useRef(false);

  useEffect(() => () => { if (receiptPreview) URL.revokeObjectURL(receiptPreview); }, [receiptPreview]);

  // Đồng bộ method khi danh sách sổ khả dụng nạp trễ (accounts load sau mount):
  // dòng nào mang method không còn hợp lệ → kéo về method khả dụng đầu tiên.
  // Dep theo chuỗi join để tránh vòng lặp (available là mảng mới mỗi render).
  const availableKey = available.join(',');
  useEffect(() => {
    if (!available.length) return;
    setLines((prev) => {
      let changed = false;
      const next = prev.map((l) => {
        if (available.includes(l.method)) return l;
        changed = true;
        return { ...l, method: available[0] };
      });
      return changed ? next : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availableKey]);

  const total = lines.reduce((s, l) => s + (l.amount || 0), 0);
  const tmTotal = lines.filter((l) => l.method === 'TM').reduce((s, l) => s + (l.amount || 0), 0);
  const policy = deriveOverpayPolicy({
    total,
    amountTm: tmTotal,
    remaining,
    hasContract: canCredit,
  });
  const overpay = policy.overpay;
  const canAddLine = lines.length < available.length;
  const canSubmit = total > 0 && (!policy.mustKeepAsCredit || canCredit);

  useEffect(() => {
    if (policy.mustKeepAsCredit) {
      setKeepAsCredit(true);
      wasForcedCreditRef.current = true;
      return;
    }
    if (overpay === 0 || wasForcedCreditRef.current) {
      setKeepAsCredit(false);
      wasForcedCreditRef.current = false;
    }
  }, [policy.mustKeepAsCredit, overpay]);

  // Báo trạng thái lên drawer (nút xanh dưới cùng hiển thị tổng + submit).
  useEffect(() => {
    onChange({
      total,
      overpay,
      keepAsCredit: keepAsCredit && overpay > 0,
      canSubmit,
      payload: canSubmit ? { lines, keepAsCredit, paymentDate, receiptFile } : null,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [total, overpay, keepAsCredit, canSubmit, lines, paymentDate, receiptFile]);

  // Phương thức chọn được cho 1 dòng = available chưa dùng ở dòng khác + chính nó.
  // Luôn union method hiện tại để <select> không bao giờ có value ngoài options.
  const methodsForRow = (idx: number): CollectMethod[] => {
    const usedOther = new Set(lines.filter((_, i) => i !== idx).map((l) => l.method));
    const opts = available.filter((m) => !usedOther.has(m) || m === lines[idx].method);
    return opts.includes(lines[idx].method) ? opts : [lines[idx].method, ...opts];
  };

  const setLine = (idx: number, patch: Partial<PayLine>) =>
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  const removeLine = (idx: number) => setLines((prev) => prev.filter((_, i) => i !== idx));
  const addLine = () => {
    const used = new Set(lines.map((l) => l.method));
    const next = available.find((m) => !used.has(m));
    if (!next) return;
    const gap = Math.max(0, remaining - total);
    setLines((prev) => [...prev, { method: next, amount: gap }]);
  };

  const pickFile = (file?: File | null) => {
    if (!file) return;
    const invalid = validateReceiptFile(file);
    if (invalid) return toast.error(invalid);
    if (receiptPreview) URL.revokeObjectURL(receiptPreview);
    setReceiptFile(file);
    setReceiptPreview(URL.createObjectURL(file));
  };
  const clearFile = () => {
    if (receiptPreview) URL.revokeObjectURL(receiptPreview);
    setReceiptFile(null);
    setReceiptPreview('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  };
  const pasteHandlers = useClipboardImagePaste({
    onFiles: (files) => pickFile(files[0]),
    enabled: !receiptPreview,
  });

  const netToInvoice = total - overpay; // phần thực áp vào hóa đơn; dư giữ thành credit

  return (
    <div className="pf-form">
      {/* Danh sách dòng thanh toán */}
      <div className="pf-lines">
        {lines.map((line, idx) => (
          <div className="pf-line" key={idx}>
            <select
              className="pf-method"
              value={line.method}
              onChange={(e) => setLine(idx, { method: e.target.value as CollectMethod })}
            >
              {methodsForRow(idx).map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
            <input
              className="pf-amt"
              type="text"
              inputMode="numeric"
              placeholder="Số tiền"
              value={formatVN(line.amount)}
              onChange={(e) => setLine(idx, { amount: parseVN(e.target.value) })}
            />
            {lines.length > 1 && (
              <button type="button" className="pf-rm" title="Bỏ dòng" onClick={() => removeLine(idx)}>
                <X />
              </button>
            )}
          </div>
        ))}
        {canAddLine && (
          <button type="button" className="pf-add" onClick={addLine}>
            <Plus /> Thêm phương thức
          </button>
        )}
      </div>

      {/* Preset chỉ cho 1 dòng — tách nhiều phương thức thì gõ tay từng dòng,
          tránh preset ghi nhầm dòng 0 (sai phân bổ TM/TK/TT vào sổ). */}
      {lines.length === 1 && (
        <div className="kp-presets">
          <button type="button" className="kp-preset due" onClick={() => setLine(0, { amount: remaining })}>
            Đủ {fmtShort(remaining)}
          </button>
          {[500_000, 1_000_000, 2_000_000].map((v) => (
            <button key={v} type="button" className="kp-preset" onClick={() => setLine(0, { amount: v })}>
              {fmtShort(v)}
            </button>
          ))}
          <button type="button" className="kp-preset" onClick={() => setLine(0, { amount: 0 })}>
            Xóa
          </button>
        </div>
      )}

      {/* Tổng + đối chiếu */}
      <div className="pf-total">
        <span>Tổng thu</span>
        <b className={total > remaining ? 'over' : total < remaining ? 'under' : ''}>
          {fmtFull(total)} / {fmtFull(remaining)}
        </b>
      </div>

      {/* Cảnh báo / tiền thối / nợ khách */}
      {policy.mustKeepAsCredit && !canCredit ? (
        <p className="pf-hint err">Hóa đơn không có hợp đồng nên không thể giữ tiền dư TT/TK để trừ kỳ sau.</p>
      ) : overpay > 0 ? (
        <div className="pf-change">
          <div className="pf-change-row">
            <span>{keepAsCredit ? 'Giữ nợ khách' : 'Tiền thối'}</span>
            <b>{fmtFull(overpay)}</b>
          </div>
          {canCredit && (
            <label className="pf-credit">
              <input
                type="checkbox"
                checked={keepAsCredit}
                disabled={policy.mustKeepAsCredit}
                onChange={(e) => setKeepAsCredit(e.target.checked)}
              />
              <span>
                {policy.mustKeepAsCredit
                  ? 'Nợ khách — bắt buộc trừ kỳ sau'
                  : 'Nợ khách (trừ kỳ sau) thay vì thối lại'}
              </span>
            </label>
          )}
          <p className="pf-hint">
            {keepAsCredit
              ? `Thu đủ ${fmtFull(netToInvoice)} cho hoá đơn, giữ ${fmtFull(overpay)} làm credit trừ kỳ sau.`
              : `Thối lại khách ${fmtFull(overpay)}${changeAccountName ? ` · ghi sổ "${changeAccountName}"` : ''}.`}
          </p>
        </div>
      ) : null}

      <label className="pf-row">
        <span className="pf-lbl">Ngày thanh toán</span>
        <input
          className="pf-date"
          type="date"
          value={paymentDate}
          onChange={(e) => e.target.value && setPaymentDate(e.target.value)}
        />
      </label>

      {receiptPreview ? (
        <div className="pf-preview">
          <img src={receiptPreview} alt="Ảnh chứng từ" />
          <button type="button" className="pf-del" title="Xóa ảnh" onClick={clearFile}>
            <X />
          </button>
        </div>
      ) : (
        <div
          className={'pf-drop' + (dragOver ? ' over' : '')}
          onClick={() => fileInputRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); pickFile(e.dataTransfer.files?.[0]); }}
          {...pasteHandlers}
        >
          <ImagePlus />
          <span>Ảnh chứng từ — bấm chọn, kéo thả hoặc Ctrl+V</span>
        </div>
      )}
      <input ref={fileInputRef} type="file" accept="image/*" hidden onChange={(e) => pickFile(e.target.files?.[0])} />
    </div>
  );
}

export default CollectPayForm;
