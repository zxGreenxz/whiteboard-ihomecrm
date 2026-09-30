// =============================================
// CollectPayForm — form thu tiền trong drawer chi tiết phòng.
// Tách nhiều dòng phương thức (TM/TK/TT, mỗi dòng vào đúng sổ riêng) +
// tiền thối / nợ khách khi tiền mặt thu DƯ (đúng như trang Hoá đơn) +
// ngày + ảnh chứng từ. Ghi chú dùng NoteEditor chung của drawer.
//
// Sổ nhận theo hình thức do MÁY CHỦ quyết (đợt 1 sửa phiếu, 25/09/2026): TM = sổ
// tiền mặt riêng của người thu (hiện, không cho chọn); TK/TT = chọn trong danh
// sách của toà (mặc định sổ đầu, 1 sổ thì khoá). Hình thức chưa có sổ ⇒ báo câu
// hướng dẫn và KHÔNG cho thu (không rơi về sổ khác).
//
// Presentational: KHÔNG gọi mutation/upload. Tính tiền cuối cùng + validate
// nằm ở planCollect (drawer → useQuickCollect); form chỉ thu input + gợi ý.
// =============================================

import { useEffect, useId, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { focusFirstError } from '@/lib/formErrors';
import { ImagePlus, Plus, X } from 'lucide-react';
import { useClipboardImagePaste } from '@/hooks/useClipboardImagePaste';
import { missingReceivingBookMessage } from '@/hooks/useReceivingCashbooks';
import { validateReceiptFile } from '@/lib/receiptUpload';
import { fmtFull, fmtShort, todayISO } from '@/lib/collect';
import { deriveOverpayPolicy, planCollect, type CollectMethod } from '@/lib/collectPlan';
import { ChangeAmountInput } from './ChangeAmountInput';

const formatVN = (n: number) => (n > 0 ? n.toLocaleString('vi-VN') : '');
const parseVN = (s: string): number => {
  const digits = s.replace(/\D/g, '');
  return digits ? parseInt(digits, 10) : 0;
};

interface PayLine {
  method: CollectMethod;
  amount: number;
  /** Sổ nhận của dòng — luôn nằm trong `books[method]` (TM: sổ tiền mặt riêng). */
  accountId?: string;
}

/** Một sổ được nhận (từ get_receiving_cashbooks_v1). */
export interface PayFormBook {
  id: string;
  name: string;
  isDefault?: boolean;
}

export interface PayFormSubmit {
  lines: PayLine[];
  keepAsCredit: boolean;
  changeAmount?: number;
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
  /** Sổ được nhận theo từng hình thức (máy chủ quyết); TM = [sổ tiền mặt riêng]. */
  books: Record<CollectMethod, PayFormBook[]>;
  /** Câu báo khi một hình thức chưa có sổ nào (vd missingReceivingBookMessage). */
  missingBookMessage?: (method: CollectMethod) => string;
  /** Tên sổ "…Thối" để hiển thị; '' nếu chưa có. */
  changeAccountName?: string;
  /** Hoá đơn có hợp đồng → cho phép "Nợ khách". */
  canCredit: boolean;
  allowRounding?: boolean;
  /** Báo trạng thái lên drawer (nút xanh dưới cùng submit). */
  onChange: (state: PayFormState) => void;
  validationAttempt?: number;
  receiptError?: string;
  disabled?: boolean;
}

const ALL: CollectMethod[] = ['TM', 'TK', 'TT'];

const MAC_DINH_THIEU_SO = (method: CollectMethod) => missingReceivingBookMessage(method);

export function CollectPayForm({
  remaining,
  books,
  missingBookMessage = MAC_DINH_THIEU_SO,
  changeAccountName,
  canCredit,
  allowRounding = true,
  onChange,
  validationAttempt = 0,
  receiptError,
  disabled = false,
}: Props) {
  const validation = useForm<Record<string,string>>({shouldFocusError:false});
  const root = useRef<HTMLFieldSetElement>(null);
  const id = useId();
  const issueFor = (name:string) => validation.getFieldState(name,validation.formState).error?.message;
  const field = (name:string) => ({...validation.register(name),'aria-invalid':!!issueFor(name),'aria-describedby':issueFor(name)?`${id}-${name}`:undefined});
  const issue = (name:string) => issueFor(name) ? <p id={`${id}-${name}`} role="alert" className="pf-hint err">{issueFor(name)}</p> : null;
  // Sổ mặc định (đầu danh sách) của một hình thức — '' nếu chưa có sổ nào.
  const defaultBookOf = (method: CollectMethod) => books[method][0]?.id ?? '';

  // Dòng đầu luôn là TIỀN MẶT: thiếu sổ tiền mặt riêng thì báo để cài, chứ không
  // tự nhảy sang TK (tiền mặt bị ghi thành chuyển khoản là sai sổ).
  const [lines, setLines] = useState<PayLine[]>(() => [
    { method: 'TM', amount: remaining, accountId: defaultBookOf('TM') || undefined },
  ]);
  const [keepAsCredit, setKeepAsCredit] = useState(false);
  const [customChange, setCustomChange] = useState<number | null>(null);
  const [paymentDate, setPaymentDate] = useState(todayISO());
  const [receiptFile, setReceiptFile] = useState<File | null>(null);
  const [receiptPreview, setReceiptPreview] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const wasForcedCreditRef = useRef(false);

  useEffect(() => () => { if (receiptPreview) URL.revokeObjectURL(receiptPreview); }, [receiptPreview]);

  // Mỗi dòng luôn trỏ vào một sổ TRONG danh sách của hình thức của nó: danh sách
  // đổi (nạp lại, chủ vừa cài thêm/bớt sổ) thì dòng mang sổ không còn hợp lệ kéo
  // về sổ mặc định; hình thức chưa có sổ thì để trống (form báo và chặn thu).
  // Dep theo chuỗi id để không lặp vô hạn (books là object mới mỗi lần nạp).
  const booksKey = ALL.map((m) => `${m}:${books[m].map((b) => b.id).join('|')}`).join(';');
  useEffect(() => {
    setLines((prev) => {
      let changed = false;
      const next = prev.map((l) => {
        const list = books[l.method];
        if (l.accountId && list.some((b) => b.id === l.accountId)) return l;
        const fallback = list[0]?.id;
        if (l.accountId === fallback) return l;
        changed = true;
        return { ...l, accountId: fallback };
      });
      return changed ? next : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [booksKey]);

  const total = lines.reduce((s, l) => s + (l.amount || 0), 0);
  const tmTotal = lines.filter((l) => l.method === 'TM').reduce((s, l) => s + (l.amount || 0), 0);
  const policy = deriveOverpayPolicy({
    total,
    amountTm: tmTotal,
    remaining,
    hasContract: canCredit,
  });
  const overpay = policy.overpay;
  const effectiveCredit = overpay > 0 && (policy.mustKeepAsCredit || keepAsCredit);
  const actualChange = effectiveCredit ? 0 : (customChange ?? overpay);
  const checked = planCollect({ lines, remaining, hasContract: canCredit, keepAsCredit: effectiveCredit,
    changeAmount: effectiveCredit ? undefined : actualChange, allowRounding });
  const error = checked.ok === false && total > 0 ? checked.error : null;
  const rounding = checked.ok === true ? checked.plan.rounding : 0;
  const canAddLine = lines.length < ALL.length;
  // Câu chặn của từng dòng: hình thức chưa có sổ nhận nào ⇒ không thu được.
  const lineBlocks = lines.map((l) => (books[l.method].length ? null : missingBookMessage(l.method)));
  const booksOk = lineBlocks.every((b) => !b)
    && lines.every((l) => !!l.accountId && books[l.method].some((b) => b.id === l.accountId));
  const dateValid = /^\d{4}-\d{2}-\d{2}$/.test(paymentDate) && !Number.isNaN(new Date(`${paymentDate}T12:00:00`).getTime());
  const canSubmit = total > 0 && checked.ok === true && booksOk && dateValid;
  useEffect(() => {
    if (!validationAttempt) return;
    validation.clearErrors();
    const errors:Record<string,string>={};
    lines.forEach((line,index)=>{
      if (!books[line.method].some(book=>book.id===line.accountId)) errors[`lines.${index}.method`]=lineBlocks[index] || `Dòng ${index+1}: chọn sổ nhận tiền.`;
      if (total<=0 && line.amount<=0) errors[`lines.${index}.amount`]=`Dòng ${index+1}: nhập số tiền lớn hơn 0 đồng.`;
    });
    if (!dateValid) errors.paymentDate='Chọn ngày thực thu hợp lệ.';
    if (error && !Object.keys(errors).length) errors['lines.0.amount']=error;
    for (const [name,message] of Object.entries(errors)) validation.setError(name,{message});
    void focusFirstError(errors,{root:root.current});
  },[validationAttempt]);
  useEffect(()=>{
    if (!receiptError) return;
    validation.setError('receiptFile',{message:receiptError});
    void focusFirstError({receiptFile:receiptError},{root:root.current});
  },[receiptError]);

  const methodsKey = lines.map(line => line.method).join(',');
  useEffect(() => { setCustomChange(null); }, [total, tmTotal, remaining, effectiveCredit, methodsKey]);

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
      overpay: effectiveCredit ? overpay : actualChange,
      keepAsCredit: effectiveCredit,
      canSubmit,
      payload: canSubmit ? { lines, keepAsCredit: effectiveCredit, changeAmount: effectiveCredit ? undefined : actualChange, paymentDate, receiptFile } : null,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [total, overpay, actualChange, effectiveCredit, canSubmit, lines, paymentDate, receiptFile]);

  // Phương thức chọn được cho 1 dòng = hình thức chưa dùng ở dòng khác + chính nó.
  // Cả ba hình thức luôn được bày (kể cả chưa có sổ) để người thu thấy câu hướng
  // dẫn, thay vì ghi nhầm sang hình thức còn lại.
  const methodsForRow = (idx: number): CollectMethod[] => {
    const usedOther = new Set(lines.filter((_, i) => i !== idx).map((l) => l.method));
    return ALL.filter((m) => !usedOther.has(m) || m === lines[idx].method);
  };

  const setLine = (idx: number, patch: Partial<PayLine>) =>
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  const removeLine = (idx: number) => setLines((prev) => prev.filter((_, i) => i !== idx));
  const addLine = () => {
    const used = new Set(lines.map((l) => l.method));
    const unused = ALL.filter((m) => !used.has(m));
    // Ưu tiên hình thức đã có sổ nhận; không còn thì vẫn thêm để hiện câu hướng dẫn.
    const next = unused.find((m) => books[m].length > 0) ?? unused[0];
    if (!next) return;
    const gap = Math.max(0, remaining - total);
    setLines((prev) => [
      ...prev,
      { method: next, amount: gap, accountId: defaultBookOf(next) || undefined },
    ]);
  };

  const pickFile = (file?: File | null) => {
    if (!file || disabled) return;
    const invalid = validateReceiptFile(file);
    if (invalid) {
      validation.setError('receiptFile',{message:`${file.name}: ${invalid}`});
      void focusFirstError({receiptFile:invalid},{root:root.current});
      return;
    }
    validation.clearErrors('receiptFile');
    if (receiptPreview) URL.revokeObjectURL(receiptPreview);
    setReceiptFile(file);
    setReceiptPreview(URL.createObjectURL(file));
  };
  const clearFile = () => {
    if (disabled) return;
    validation.clearErrors('receiptFile');
    if (receiptPreview) URL.revokeObjectURL(receiptPreview);
    setReceiptFile(null);
    setReceiptPreview('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  };
  const pasteHandlers = useClipboardImagePaste({
    onFiles: (files) => pickFile(files[0]),
    enabled: !receiptPreview && !disabled,
  });

  const netToInvoice = Math.min(total - actualChange, remaining);

  return (
    <fieldset ref={root} disabled={disabled} className="pf-form m-0 min-w-0 border-0 p-0">
      {/* Danh sách dòng thanh toán */}
      <div className="pf-lines">
        {lines.map((line, idx) => {
          const list = books[line.method];
          return (
            <div key={idx} className="pf-lines">
              <div className={'pf-line' + (list.length ? ' has-book' : '')}>
                <select
                  {...field(`lines.${idx}.method`)}
                  className={'pf-method'+(issueFor(`lines.${idx}.method`)?' border-red-500':'')}
                  aria-label={`Hình thức dòng ${idx + 1}`}
                  value={line.method}
                  onChange={(e) => {
                    const method = e.target.value as CollectMethod;
                    setLine(idx, { method, accountId: defaultBookOf(method) || undefined });
                  }}
                >
                  {methodsForRow(idx).map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
                {list.length > 0 && (
                  // TM: sổ tiền mặt riêng — chỉ hiện, không cho chọn. TK/TT: chọn
                  // trong danh sách của toà; một sổ thì khoá.
                  <select
                    className="pf-book"
                    title={line.method === 'TM' ? 'Sổ tiền mặt riêng của người thu' : 'Sổ nhận tiền'}
                    aria-label={`Sổ nhận ${line.method}`}
                    value={line.accountId ?? ''}
                    disabled={line.method === 'TM' || list.length === 1}
                    onChange={(e) => setLine(idx, { accountId: e.target.value })}
                  >
                    {list.map((book) => (
                      <option key={book.id} value={book.id}>{book.name}</option>
                    ))}
                  </select>
                )}
                <input
                  {...field(`lines.${idx}.amount`)}
                  aria-label={`Số tiền dòng ${idx + 1}`}
                  className={'pf-amt'+(issueFor(`lines.${idx}.amount`)?' border-red-500':'')}
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
              {issue(`lines.${idx}.method`)}
              {issue(`lines.${idx}.amount`)}
              {lineBlocks[idx] && !issueFor(`lines.${idx}.method`) && <p className="pf-hint err" role="alert">{lineBlocks[idx]}</p>}
            </div>
          );
        })}
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
      ) : overpay > 0 || tmTotal > 0 ? (
        <div className="pf-change">
          <div className="pf-change-row">
            <span>{keepAsCredit ? 'Giữ nợ khách' : 'Tiền thối'}</span>
            {effectiveCredit ? <b>{fmtFull(overpay)}</b> : <ChangeAmountInput value={actualChange} onChange={setCustomChange} />}
          </div>
          {canCredit && overpay > 0 && (
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
              ? `Thu đủ ${fmtFull(netToInvoice)} cho hoá đơn, giữ ${fmtFull(overpay)} để trừ kỳ sau.`
              : `Thối lại khách ${fmtFull(actualChange)}${changeAccountName ? ` · ghi sổ "${changeAccountName}"` : ''}.`}
          </p>
        </div>
      ) : null}
      {rounding > 0 && <p className="kp-warn round">Bỏ qua {fmtFull(rounding)} — tính đóng đủ, lưu vào thống kê.</p>}
      {error && <p className="pf-hint err" role="alert">{error}</p>}
      {!error && total > 0 && rounding === 0 && remaining - netToInvoice > 0 && <p className="kp-warn under">Còn nợ {fmtFull(remaining - netToInvoice)}</p>}

      <label className="pf-row">
        <span className="pf-lbl">Ngày thanh toán</span>
        <input
          {...field('paymentDate')}
          className={'pf-date'+(issueFor('paymentDate')?' border-red-500':'')}
          type="date"
          value={paymentDate}
          onChange={(e) => setPaymentDate(e.target.value)}
        />
      </label>
      {issue('paymentDate')}

      {receiptPreview ? (
        <div className="pf-preview">
          <img src={receiptPreview} alt="Ảnh chứng từ" />
          <button {...field('receiptFile')} type="button" className="pf-del" title="Gỡ ảnh đang chọn" onClick={clearFile}>
            <X />
          </button>
        </div>
      ) : (
        <div
          {...field('receiptFile')}
          role="button" tabIndex={disabled ? -1 : 0} aria-disabled={disabled}
          className={'pf-drop' + (dragOver ? ' over' : '') + (issueFor('receiptFile')?' border-red-500':'')}
          onKeyDown={event => {if (!disabled && (event.key==='Enter'||event.key===' ')) {event.preventDefault();fileInputRef.current?.click();}}}
          onClick={() => { if (!disabled) fileInputRef.current?.click(); }}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); pickFile(e.dataTransfer.files?.[0]); }}
          {...pasteHandlers}
        >
          <ImagePlus />
          <span>Ảnh chứng từ — bấm chọn, kéo thả hoặc Ctrl+V</span>
        </div>
      )}
      {issue('receiptFile')}
      <input ref={fileInputRef} type="file" accept="image/*" hidden onChange={(e) => pickFile(e.target.files?.[0])} />
    </fieldset>
  );
}

export default CollectPayForm;
