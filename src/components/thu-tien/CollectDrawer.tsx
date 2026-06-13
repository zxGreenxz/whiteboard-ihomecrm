import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Check, ChevronRight, Phone, StickyNote, Undo2 } from 'lucide-react';
import {
  collectStatus,
  STATUS_META,
  fmtBillingMonth,
  fmtFull,
  fmtShort,
  remainingOf,
  repCustomer,
  telUrl,
  latestPaymentId,
} from '@/lib/collect';
import { useQuickCollect } from '@/hooks/useQuickCollect';
import { useDeletePayment } from '@/hooks/useDeletePayment';
import { useUpdateInvoiceNote } from '@/hooks/useUpdateInvoiceNote';
import { uploadReceiptToStorage } from '@/lib/receiptUpload';
import type { CollectMethod } from '@/lib/cashAccount';
import { InvoiceDetailCard } from './InvoiceDetailCard';
import { CollectKeypad } from './CollectKeypad';
import { CollectPayForm, type PayFormState, type PayFormSubmit } from './CollectPayForm';
import { NoteEditor } from './NoteEditor';
import type { CollectorEntry } from '@/hooks/useInvoiceCollectors';
import type { InvoiceWithRelations } from '@/types/invoice';

interface Props {
  invoice: InvoiceWithRelations | null;
  show: boolean;
  /** keypad = mở từ nút "Thu 1P" (sheet gọn); view = tap ô (sheet đầy đủ). */
  mode: 'view' | 'keypad';
  /** Lịch sử ai thu bao nhiêu của hoá đơn đang mở. */
  collectors?: CollectorEntry[];
  canRecordPayment: boolean;
  /** Quyền hoàn tác phiếu thu (mặc định = canRecordPayment). */
  canUndo?: boolean;
  prev: InvoiceWithRelations | null;
  next: InvoiceWithRelations | null;
  onClose: () => void;
  onNavigate: (inv: InvoiceWithRelations) => void;
}

export function CollectDrawer({
  invoice,
  show,
  mode,
  collectors = [],
  canRecordPayment,
  canUndo = canRecordPayment,
  prev,
  next,
  onClose,
  onNavigate,
}: Props) {
  const { collect, accountIdFor, changeAccountName, isCollecting } = useQuickCollect();
  const deletePayment = useDeletePayment();
  const updateNote = useUpdateInvoiceNote();

  const compact = mode === 'keypad';
  // entered = null → mặc định "điền sẵn đúng số còn phải thu"; chuỗi = số (nghìn) tự nhập.
  const [entered, setEntered] = useState<string | null>(null);
  const [keepAsCredit, setKeepAsCredit] = useState(false);
  const [noteDraft, setNoteDraft] = useState('');
  const [uploading, setUploading] = useState(false);
  // Trạng thái form thu (báo lên từ CollectPayForm) — nút xanh dưới cùng submit.
  const [payState, setPayState] = useState<PayFormState | null>(null);

  useEffect(() => {
    setEntered(null);
    setKeepAsCredit(false);
    setPayState(null);
    setNoteDraft(invoice?.notes ?? '');
  }, [invoice?.id, mode]);

  // Giữ DOM khi đóng (chạy animation translateY); chỉ bỏ render khi đã unmount.
  if (!invoice) {
    return (
      <>
        <div className="sheet-scrim" />
        <div className="sheet" />
      </>
    );
  }

  const remaining = remainingOf(invoice);
  const st = collectStatus(invoice);
  const meta = STATUS_META[st];
  const rep = repCustomer(invoice);
  const code = invoice.room?.name ?? '?';
  const fullCode = invoice.building?.name ? `${invoice.building.name} - ${code}` : code;
  const badgeStyle = {
    background: `var(--c-${st}-bg)`,
    color: `var(--c-${st})`,
    border: `1px solid var(--c-${st}-line)`,
  };

  // Thu nhanh từ bàn phím (TM). Đúng/thiếu → đường 1-chạm (cap, tự làm tròn);
  // dư → đường nhiều dòng để cho phép thối lại / giữ nợ khách.
  const pristine = entered === null;
  const enteredVal = pristine
    ? Math.max(0, Math.round(remaining))
    : (parseInt(entered, 10) || 0) * 1000;
  const submitKeypad = async () => {
    if (enteredVal <= 0) return;
    try {
      const res =
        enteredVal > remaining
          ? await collect({
              invoice,
              lines: [{ method: 'TM' as const, amount: enteredVal }],
              keepAsCredit: keepAsCredit && !!invoice.contract_id,
              notes: noteDraft,
            })
          : await collect({ invoice, amount: enteredVal, notes: noteDraft });
      if (res.failures.length === 0) onClose();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const saveNote = () => {
    if ((invoice.notes ?? '') === noteDraft) return;
    updateNote.mutate({ invoice_id: invoice.id, notes: noteDraft });
  };

  const doUndo = () => {
    const pid = latestPaymentId(invoice);
    if (pid) deletePayment.mutate({ payment_id: pid });
  };

  const doCall = () => {
    if (rep.phone) window.location.href = telUrl(rep.phone);
  };

  // Form thu tiền (TM/TK/TT + ảnh): upload ảnh trước (fail → vẫn thu, báo
  // warning — precedent RecordPaymentDialog), rồi gọi collect như Thu đủ.
  const methodAvailable = {
    TM: !!accountIdFor(invoice, 'TM'),
    TK: !!accountIdFor(invoice, 'TK'),
    TT: !!accountIdFor(invoice, 'TT'),
  } as Record<CollectMethod, boolean>;

  const runPayForm = async ({ lines, keepAsCredit, paymentDate, receiptFile }: PayFormSubmit) => {
    try {
      let url: string | null = null;
      if (receiptFile) {
        setUploading(true);
        try {
          url = await uploadReceiptToStorage(receiptFile);
        } catch {
          toast.warning(
            'Không tải được ảnh chứng từ — phiếu thu sẽ ghi KHÔNG kèm ảnh (bổ sung sau ở trang Hoá đơn).',
          );
        } finally {
          setUploading(false);
        }
      }
      await collect({
        invoice,
        lines,
        keepAsCredit,
        notes: noteDraft,
        receiptImageUrl: url,
        paymentDate,
      });
      // Thu xong → invoice cập nhật (remaining 0) → form tự ẩn, hiện "Đã thu đủ".
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const keypad = (
    <CollectKeypad
      remaining={remaining}
      entered={entered}
      onEntered={setEntered}
      keepAsCredit={keepAsCredit}
      onKeepAsCreditChange={setKeepAsCredit}
      canCredit={!!invoice.contract_id}
      changeAccountName={changeAccountName}
      confirming={isCollecting}
      onConfirm={submitKeypad}
    />
  );

  // ── Sheet gọn (Thu 1P): chỉ bàn phím + ghi chú ──
  if (compact) {
    return (
      <>
        <div className={'sheet-scrim' + (show ? ' show' : '')} onClick={onClose} />
        <div className={'sheet compact' + (show ? ' show' : '')}>
          <div className="sheet-grab" />
          <div className="sheet-scroll">
            <div className="qp-head">
              <div className="qp-room">{code}</div>
              <div className="qp-rem">
                Còn phải thu <b>{fmtFull(remaining)}</b>
              </div>
            </div>
            {keypad}
            <div className="is-note">
              <div className="ib-lbl">Ghi chú</div>
              <NoteEditor value={noteDraft} onChange={setNoteDraft} />
            </div>
          </div>
        </div>
      </>
    );
  }

  // ── Sheet đầy đủ (tap ô) ──
  return (
    <>
      <div className={'sheet-scrim' + (show ? ' show' : '')} onClick={onClose} />
      <div className={'sheet' + (show ? ' show' : '')}>
        <div className="sheet-grab" />
        <div className="sheet-scroll">
          <div className="is-head">
            <div>
              <div className="is-room">{fullCode}</div>
              <div className="is-sub">Kỳ {fmtBillingMonth(invoice.billing_month)}</div>
            </div>
            <span className="is-statbadge" style={badgeStyle}>
              <i className="bd" style={{ background: `var(--c-${st})` }} />
              {meta.label}
            </span>
          </div>

          <InvoiceDetailCard invoice={invoice} collectors={collectors} />

          {canRecordPayment && st !== 'paid' && (
            <>
              <div className="is-note">
                <div className="ib-lbl">Ghi chú</div>
                <NoteEditor value={noteDraft} onChange={setNoteDraft} onBlur={saveNote} />
              </div>
              <CollectPayForm
                key={invoice.id}
                remaining={remaining}
                methodAvailable={methodAvailable}
                changeAccountName={changeAccountName}
                canCredit={!!invoice.contract_id}
                onChange={setPayState}
              />
            </>
          )}

          {/* Ghi chú chỉ-đọc khi đã thu đủ / không có quyền thu */}
          {(!canRecordPayment || st === 'paid') && noteDraft && (
            <div className="is-note">
              <div className="ib-lbl">Ghi chú</div>
              <div className="note-display">
                <StickyNote />
                {noteDraft}
              </div>
            </div>
          )}

          {canUndo && (invoice.paid_amount ?? 0) > 0 && (
            <div className="is-sub-actions">
              <button
                type="button"
                className="is-sub-btn undo"
                disabled={deletePayment.isPending}
                onClick={doUndo}
              >
                <Undo2 />
                Hoàn tác
              </button>
            </div>
          )}
        </div>

        <div className="is-actions">
          <button
            type="button"
            className="is-nav prev"
            disabled={!prev}
            onClick={() => prev && onNavigate(prev)}
          >
            <ChevronRight />
          </button>
          {st === 'paid' ? (
            <button type="button" className="btn-collect done">
              <Check />
              Đã thu đủ
            </button>
          ) : (
            <button
              type="button"
              className="btn-collect"
              disabled={!canRecordPayment || !payState?.canSubmit || isCollecting || uploading}
              onClick={() => payState?.payload && runPayForm(payState.payload)}
            >
              {uploading || isCollecting ? 'Đang ghi…' : `Thu ${fmtShort(payState?.total ?? remaining)}`}
              {payState && payState.overpay > 0 && (
                <small>
                  {payState.keepAsCredit ? 'nợ khách ' : 'thối '}
                  {fmtShort(payState.overpay)}
                </small>
              )}
            </button>
          )}
          <button type="button" className="is-icon call" disabled={!rep.phone} onClick={doCall}>
            <Phone />
          </button>
          <button
            type="button"
            className="is-nav"
            disabled={!next}
            onClick={() => next && onNavigate(next)}
          >
            <ChevronRight />
          </button>
        </div>
      </div>
    </>
  );
}

export default CollectDrawer;
