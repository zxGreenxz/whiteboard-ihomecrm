// =============================================
// CollectPayForm — form thu tiền gọn trong drawer chi tiết phòng.
// Bản rút gọn của "Ghi nhận thanh toán" (trang Hoá đơn): chọn phương thức
// TM/TK/TT + số tiền + ngày + ảnh chứng từ. KHÔNG có tiền thối/nợ khách
// (trang thu-tien cap số thu ≤ remaining). Ghi chú dùng NoteEditor chung
// của drawer (noteDraft) — form này không tự chứa ô ghi chú.
//
// Presentational: KHÔNG gọi mutation/upload — drawer orchestrate qua
// onSubmit({amount, method, paymentDate, receiptFile}).
// =============================================

import { useEffect, useRef, useState } from 'react';
import { ImagePlus, X } from 'lucide-react';
import { toast } from 'sonner';
import { useClipboardImagePaste } from '@/hooks/useClipboardImagePaste';
import { validateReceiptFile } from '@/lib/receiptUpload';
import type { CollectMethod } from '@/lib/cashAccount';
import { fmtShort, todayISO } from '@/lib/collect';

const formatVN = (n: number) => (n > 0 ? n.toLocaleString('vi-VN') : '');
const parseVN = (s: string): number => {
  const digits = s.replace(/\D/g, '');
  return digits ? parseInt(digits, 10) : 0;
};

export interface PayFormSubmit {
  amount: number;
  method: CollectMethod;
  paymentDate: string;
  /** CHƯA upload — drawer upload trước khi gọi collect. */
  receiptFile: File | null;
}

interface Props {
  remaining: number;
  methodAvailable: Record<CollectMethod, boolean>;
  submitting: boolean;
  onSubmit: (data: PayFormSubmit) => void;
}

const METHODS: CollectMethod[] = ['TM', 'TK', 'TT'];

export function CollectPayForm({ remaining, methodAvailable, submitting, onSubmit }: Props) {
  const [method, setMethod] = useState<CollectMethod>('TM');
  const [amountText, setAmountText] = useState(formatVN(remaining));
  const [paymentDate, setPaymentDate] = useState(todayISO());
  const [receiptFile, setReceiptFile] = useState<File | null>(null);
  const [receiptPreview, setReceiptPreview] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Revoke objectURL khi đổi ảnh / unmount.
  useEffect(() => () => { if (receiptPreview) URL.revokeObjectURL(receiptPreview); }, [receiptPreview]);

  const amount = parseVN(amountText);

  const setAmount = (n: number) => setAmountText(formatVN(Math.max(0, n)));

  const pickFile = (file?: File | null) => {
    if (!file) return;
    const invalid = validateReceiptFile(file);
    if (invalid) {
      toast.error(invalid);
      return;
    }
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

  const unavailableSelected = !methodAvailable[method];
  const canSubmit = amount > 0 && !submitting && !unavailableSelected;

  return (
    <div className="pf-form">
      <div className="pf-methods cfilters">
        {METHODS.map((m) => (
          <button
            key={m}
            type="button"
            className={'cchip' + (method === m ? ' on' : '') + (methodAvailable[m] ? '' : ' dis')}
            onClick={() => methodAvailable[m] && setMethod(m)}
          >
            {m}
          </button>
        ))}
      </div>
      {(!methodAvailable.TK || !methodAvailable.TT) && (
        <p className="pf-hint">
          {[!methodAvailable.TK ? 'TK' : null, !methodAvailable.TT ? 'TT' : null]
            .filter(Boolean)
            .join(' & ')}{' '}
          chưa dùng được — tòa chưa cấu hình sổ quỹ mặc định (Cài đặt → Tòa nhà).
        </p>
      )}

      <input
        className="pf-amt"
        type="text"
        inputMode="numeric"
        placeholder="Số tiền thu"
        value={amountText}
        onChange={(e) => setAmountText(formatVN(parseVN(e.target.value)))}
        onBlur={() => amount > remaining && setAmount(remaining)}
      />
      <div className="kp-presets">
        <button type="button" className="kp-preset due" onClick={() => setAmount(remaining)}>
          Đủ {fmtShort(remaining)}
        </button>
        {[500_000, 1_000_000, 2_000_000].map((v) => (
          <button key={v} type="button" className="kp-preset" onClick={() => setAmount(v)}>
            {fmtShort(v)}
          </button>
        ))}
        <button type="button" className="kp-preset" onClick={() => setAmount(0)}>
          Xóa
        </button>
      </div>

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
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            pickFile(e.dataTransfer.files?.[0]);
          }}
          {...pasteHandlers}
        >
          <ImagePlus />
          <span>Ảnh chứng từ — bấm chọn, kéo thả hoặc Ctrl+V</span>
        </div>
      )}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => pickFile(e.target.files?.[0])}
      />

      <button
        type="button"
        className="kp-confirm"
        disabled={!canSubmit}
        onClick={() => onSubmit({ amount, method, paymentDate, receiptFile })}
      >
        {submitting ? 'Đang ghi…' : `Xác nhận thu ${amount > 0 ? fmtShort(amount) : ''} ${method}`}
      </button>
    </div>
  );
}

export default CollectPayForm;
