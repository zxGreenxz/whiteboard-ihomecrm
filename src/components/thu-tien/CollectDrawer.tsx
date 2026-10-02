import { useEffect, useRef, useState } from 'react';
import { quickCollectFailureMessage } from '@/lib/quickCollectFeedback';
import { voucherOutcomeUnknown } from '@/lib/voucherFeedback';
import type { BulkPaymentResult } from '@/hooks/useBulkRecordPayment';
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
  latestLivePayment,
} from '@/lib/collect';
import { useQuickCollect } from '@/hooks/useQuickCollect';
import { useInvoiceItemsLite } from '@/hooks/useCollectionReport';
import { deriveInvoiceDepositDue } from '@/lib/paymentRecordRpc';
import {
  useDeletePayment,
  useCollectionReversalEligibility,
  COLLECTION_BLOCK_TEXT,
} from '@/hooks/useDeletePayment';
import { fetchRecentInvoiceCollections } from '@/hooks/useCollectionTenders';
import { useUpdateInvoiceNote } from '@/hooks/useUpdateInvoiceNote';
import { useInvoice } from '@/hooks/useInvoices';
import { useMyPermissions } from '@/hooks/useMyPermissions';
import { canUse } from '@/lib/permissionPages';
import { getInvoiceEditMode } from '@/lib/invoiceUtils';
import { duplicateCollectionQuestion, findRecentDuplicateCollection } from '@/lib/duplicateCollection';
import { REVISION_REASON_MAX, REVISION_REASON_MIN } from '@/lib/incomeExpenseRevision';
import EditInvoiceDialog from '@/components/invoices/EditInvoiceDialog';
import { Button } from '@/components/ui/button';
import { InlineSkeleton, LoadingState } from '@/components/loading/LoadingState';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { uploadReceiptToStorage } from '@/lib/receiptUpload';
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
  // Sổ quỹ + sổ nhận tiền chỉ tải khi sheet thực sự mở (drawer luôn mounted để
  // chạy animation); sổ nhận đọc theo toà của hoá đơn đang mở.
  const { collect, receiving, receivingBlockFor, changeAccountNameFor, isCollecting, reloadReceiving } =
    useQuickCollect({ invoice });
  const deletePayment = useDeletePayment();
  // Hoàn tác phải gõ lý do thật (≥ 8 ký tự) — ô lý do mở khi bấm "Hoàn tác".
  const [undoOpen, setUndoOpen] = useState(false);
  const [undoReason, setUndoReason] = useState('');
  const [undoReasonError, setUndoReasonError] = useState('');
  const undoReasonRef = useRef<HTMLTextAreaElement>(null);
  // Thu trùng: hỏi lại khi hoá đơn vừa có khoản thu CÙNG số tiền trong 30 phút.
  const [dupAsk, setDupAsk] = useState<{ question: string; run: () => Promise<void> } | null>(null);
  const [checkingDup, setCheckingDup] = useState(false);
  const updateNote = useUpdateInvoiceNote();
  const { data: permissions } = useMyPermissions();
  const canEditInvoice = canUse(permissions, 'invoices', 'edit');
  const [editNoteOpen, setEditNoteOpen] = useState(false);
  const { data: fullInvoice, isLoading: loadingInvoice, isError: invoiceError } = useInvoice(editNoteOpen ? invoice?.id : undefined);

  // Đợt 5: hỏi server xem khoản thu gần nhất có hoàn tác được không, để nút
  // "Hoàn tác" nói đúng lý do thay vì bấm rồi mới biết.
  const undoTarget = invoice ? latestLivePayment(invoice) : null;
  const { data: undoEligibility } = useCollectionReversalEligibility(
    undoTarget?.collection_id ? [undoTarget.collection_id] : [],
  );
  const undoRow = undoTarget?.collection_id
    ? undoEligibility?.[undoTarget.collection_id]
    : undefined;
  const undoBlock = undoRow?.mode === 'BLOCKED' ? (undoRow.reason_code ?? 'UNKNOWN') : null;

  const compact = mode === 'keypad';
  // Chi tiết hoá đơn nạp lazy — list /thu-tien không còn kéo invoice_items.
  const { data: lazyItems = [], isLoading: loadingItems, isError: itemsError } = useInvoiceItemsLite(
    invoice ? invoice.id : undefined,
  );
  // entered = null → mặc định "điền sẵn đúng số còn phải thu"; chuỗi = số (nghìn) tự nhập.
  const [entered, setEntered] = useState<string | null>(null);
  const [keepAsCredit, setKeepAsCredit] = useState(false);
  const [changeAmount, setChangeAmount] = useState<number | null>(null);
  const [noteDraft, setNoteDraft] = useState('');
  const [uploading, setUploading] = useState(false);
  // Trạng thái form thu (báo lên từ CollectPayForm) — nút xanh dưới cùng submit.
  const [payState, setPayState] = useState<PayFormState | null>(null);
  const [failure, setFailure] = useState('');
  const [receiptError, setReceiptError] = useState('');
  const [validationAttempt, setValidationAttempt] = useState(0);
  const blockedInvoices = useRef(new Map<string,string>());
  const uploadedFiles = useRef(new WeakMap<File,string>());
  const checkingRef = useRef(false);
  const writingRef = useRef(false);
  const [writing, setWriting] = useState(false);

  useEffect(() => {
    setEntered(null);
    setKeepAsCredit(false);
    setChangeAmount(null);
    setPayState(null);
    setNoteDraft(invoice?.notes ?? '');
    setEditNoteOpen(false);
    setUndoOpen(false);
    setUndoReason('');
    setUndoReasonError('');
    setDupAsk(null);
    setFailure(blockedInvoices.current.get(invoice?.id ?? '') ?? '');
    setReceiptError('');
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

  // Tên sổ thối org-scoped theo HĐ đang mở (invoice đã chắc chắn non-null tại đây).
  const changeAccountName = changeAccountNameFor(invoice);
  const remaining = remainingOf(invoice);
  const allowRounding = !loadingItems && !itemsError
    && deriveInvoiceDepositDue({ ...invoice, invoice_items: lazyItems }) === 0;
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
  const blocked = blockedInvoices.current.has(invoice.id);
  const busy = writing || checkingDup || isCollecting || uploading || deletePayment.isPending || !!dupAsk;
  const closeWhenIdle = () => { if (!busy && !writingRef.current && !checkingRef.current) onClose(); };
  const reportFailure = (error:unknown) => {
    const message = quickCollectFailureMessage(error);
    setFailure(message);
    if (voucherOutcomeUnknown(error)) blockedInvoices.current.set(invoice.id,message);
  };
  const readOutcome = (result:BulkPaymentResult):boolean => {
    if (!result || !Array.isArray(result.ok) || !Array.isArray(result.failures)) {reportFailure(new TypeError('Invalid collection result'));return false;}
    if (result.failures.length) {
      const message=result.failures.map(item => item.message).join(' ');
      setFailure(message);
      if (result.failures.some(item => item.outcomeUnknown)) blockedInvoices.current.set(invoice.id,message);
      return false;
    }
    if (!result.ok.includes(invoice.id)) {reportFailure(new TypeError('Unconfirmed invoice collection'));return false;}
    toast.success(`Đã ghi nhận khoản thu cho hóa đơn ${invoice.invoice_number || fullCode}.`);
    return true;
  };
  /**
   * Thu trùng (đợt 1 sửa phiếu): trước khi ghi, hoá đơn vừa có khoản thu CÒN HIỆU
   * LỰC cùng tổng tiền trong 30 phút ⇒ hỏi lại, nêu giờ thu + người thu. Không đọc
   * được lịch sử thu thì dừng và yêu cầu tải lại để tránh ghi nhận trùng.
   */
  const guardDuplicate = async (grossAmount: number, run: () => Promise<void>) => {
    if (checkingRef.current || writingRef.current || blocked) return;
    checkingRef.current = true;
    setFailure('');
    setCheckingDup(true);
    let question: string | null = null;
    try {
      const recent = await fetchRecentInvoiceCollections([invoice.id]);
      const dup = findRecentDuplicateCollection(recent, grossAmount, Date.now());
      if (dup) question = duplicateCollectionQuestion(dup);
    } catch (e) {
      console.error('Recent invoice collection check failed', e);
      setFailure('Chưa kiểm tra được các khoản thu gần đây. Tải lại hóa đơn để tránh ghi nhận trùng.');
      return;
    } finally {
      checkingRef.current = false;
      setCheckingDup(false);
    }
    if (question) {
      setDupAsk({ question, run });
      return;
    }
    await run();
  };

  const collectKeypad = async () => {
    if (writingRef.current || blocked) return;
    writingRef.current = true; setWriting(true);
    try {
      const res =
        enteredVal > remaining || (changeAmount ?? 0) > 0
          ? await collect({
              invoice,
              allowRounding,
              lines: [{ method: 'TM' as const, amount: enteredVal }],
              keepAsCredit: keepAsCredit && !!invoice.contract_id,
              changeAmount: keepAsCredit ? undefined : changeAmount ?? undefined,
              notes: noteDraft,
            })
          : await collect({ invoice, amount: enteredVal, notes: noteDraft, allowRounding });
      if (readOutcome(res)) onClose();
    } catch (e) {
      reportFailure(e);
    } finally {writingRef.current=false;setWriting(false);}
  };
  const submitKeypad = async () => {
    if (enteredVal <= 0) return;
    // Bàn phím là tiền mặt: thiếu sổ tiền mặt riêng thì chặn trước khi hỏi gì thêm.
    const blocked = receivingBlockFor('TM');
    if (blocked) {
      toast.error(blocked);
      return;
    }
    await guardDuplicate(enteredVal, collectKeypad);
  };

  const saveNote = () => {
    if (!canEditInvoice || getInvoiceEditMode(invoice) !== 'draft') return;
    if ((invoice.notes ?? '') === noteDraft) return;
    updateNote.mutate({ invoice_id: invoice.id, notes: noteDraft }, { onError: () => toast.error('Chưa lưu được ghi chú. Tải lại hóa đơn và thử lại.') });
  };

  // ĐỢT 5 — đường hoàn tác THỨ HAI (mobile Thu tiền). Trước đây bấm là chạy
  // luôn: không xác nhận, không lý do, không biết kỳ đã đóng hay chưa. Sau Đợt 5
  // server có thể CHẶN vì lợi nhuận/sổ quỹ đã chốt, nên hỏi trước và nói rõ vì
  // sao, thay vì để người dùng bấm rồi ăn một toast đỏ khó hiểu.
  // Đợt 1 sửa phiếu: bấm "Hoàn tác" chỉ MỞ ô lý do; ghi lý do thật (≥ 8 ký tự)
  // rồi mới xác nhận — thay cho câu điền sẵn không nói được vì sao tiền rời sổ.
  const undoReasonLength = undoReason.trim().length;
  const undoReasonOk = undoReasonLength >= REVISION_REASON_MIN && undoReasonLength <= REVISION_REASON_MAX;
  const openUndo = () => {
    if (!undoTarget) return;
    if (undoBlock) {
      toast.error(COLLECTION_BLOCK_TEXT[undoBlock]);
      return;
    }
    setUndoReason('');
    setUndoReasonError('');
    setUndoOpen(true);
  };
  const doUndo = () => {
    if (!undoTarget || undoBlock || deletePayment.isPending) return;
    if (!undoReasonOk) {
      setUndoReasonError(`Nhập lý do hoàn tác, ít nhất ${REVISION_REASON_MIN} ký tự và không quá ${REVISION_REASON_MAX} ký tự.`);
      undoReasonRef.current?.focus();
      undoReasonRef.current?.scrollIntoView?.({block:'center'});
      return;
    }
    setUndoReasonError('');
    deletePayment.mutate(
      {
        payment_id: undoTarget.id,
        collection_id: undoTarget.collection_id,
        reason: undoReason.trim(),
      },
      {
        onSuccess: () => {
          setUndoOpen(false);
          setUndoReason('');
    setUndoReasonError('');
        },
      },
    );
  };

  const doCall = () => {
    if (rep.phone) window.location.href = telUrl(rep.phone);
  };

  // Chứng từ đã chọn phải tải thành công trước khi ghi nhận khoản thu.
  const submitPayForm = (payload: PayFormSubmit) => {
    const gross = payload.lines.reduce((s, l) => s + (Number(l.amount) || 0), 0);
    return guardDuplicate(gross, () => runPayForm(payload));
  };

  const runPayForm = async ({ lines, keepAsCredit, changeAmount, paymentDate, receiptFile }: PayFormSubmit) => {
    if (writingRef.current || blocked) return;
    writingRef.current=true;setWriting(true);setReceiptError('');
    try {
      let url: string | null = receiptFile ? uploadedFiles.current.get(receiptFile) ?? null : null;
      if (receiptFile && !url) {
        setUploading(true);
        try {
          url = await uploadReceiptToStorage(receiptFile);
          if (!url) throw new TypeError('Missing receipt upload result');
          uploadedFiles.current.set(receiptFile,url);
        } catch (error) {
          console.error('Collection receipt upload failed',error);
          setReceiptError(`Chưa tải được chứng từ ${receiptFile.name}. Khoản thu chưa được gửi. Giữ ảnh và thử tải lại.`);
          return;
        } finally {
          setUploading(false);
        }
      }
      const result = await collect({
        invoice,
        allowRounding,
        lines,
        keepAsCredit,
        changeAmount,
        notes: noteDraft,
        receiptImageUrl: url,
        paymentDate,
        // Sổ nhận người thu chọn ở từng dòng (mỗi hình thức tối đa 1 dòng);
        // collect chỉ nhận sổ nằm trong danh sách máy chủ cho phép.
        accountOverrides: Object.fromEntries(
          lines
            .filter((line) => line.accountId)
            .map((line) => [line.method, line.accountId as string]),
        ),
      });
      readOutcome(result);
      // Thu xong → invoice cập nhật (remaining 0) → form tự ẩn, hiện "Đã thu đủ".
    } catch (e) {
      reportFailure(e);
    } finally {writingRef.current=false;setWriting(false);}
  };

  // Sổ nhận tiền (máy chủ): đang nạp / lỗi thì chưa cho thu, nói rõ vì sao. Đang nạp:
  // khối xám thay chỗ bàn phím/form thu (chủ chốt 02/10/2026) — vẫn chưa cho thu.
  const receivingStatus = receiving.error
    ? <div role="alert" className="pf-hint err">{receiving.error}<Button variant="outline" onClick={() => void reloadReceiving?.()}>Tải lại sổ nhận tiền</Button></div>
    : receiving.loading
      ? <LoadingState label="sổ nhận tiền" rows={4} className="px-[18px] pt-3" />
      : null;
  // Bàn phím chỉ thu tiền mặt ⇒ thiếu sổ tiền mặt riêng thì thay bằng câu hướng dẫn.
  const keypadBlock = receivingStatus ? null : receivingBlockFor('TM');
  const itemsStatus = itemsError
    ? <p role="status" className="pf-hint">Không tải được chi tiết hóa đơn. Vui lòng đóng và mở lại.</p>
    : <LoadingState label="chi tiết hóa đơn" rows={4} className="px-[18px] pt-3" />;

  const keypad = loadingItems || itemsError ? itemsStatus : receivingStatus ? receivingStatus : keypadBlock ? (
    <p role="alert" className="pf-hint err">{keypadBlock}</p>
  ) : (
    <CollectKeypad
      remaining={remaining}
      entered={entered}
      onEntered={value => { setEntered(value); setChangeAmount(null); }}
      changeAmount={changeAmount}
      onChangeAmount={setChangeAmount}
      keepAsCredit={keepAsCredit}
      onKeepAsCreditChange={value => { setKeepAsCredit(value); setChangeAmount(null); }}
      canCredit={!!invoice.contract_id}
      allowRounding={allowRounding}
      changeAccountName={changeAccountName}
      confirming={isCollecting || checkingDup || writing || blocked}
      onConfirm={submitKeypad}
    />
  );

  const dupDialog = (
    <AlertDialog open={!!dupAsk} onOpenChange={(v) => { if (!v) setDupAsk(null); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Có thể đang thu trùng</AlertDialogTitle>
          <AlertDialogDescription>{dupAsk?.question}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Không thu</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              const run = dupAsk?.run;
              setDupAsk(null);
              if (run) void run();
            }}
          >
            Vẫn thu tiếp
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  // ── Sheet gọn (Thu 1P): chỉ bàn phím + ghi chú ──
  if (compact) {
    return (
      <>
        <div className={'sheet-scrim' + (show ? ' show' : '')} onClick={closeWhenIdle} />
        <div className={'sheet compact' + (show ? ' show' : '')}>
          <div className="sheet-grab" />
          <div className="sheet-scroll">
            {failure && <p role="alert" className="pf-hint err">{failure}</p>}
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
        {dupDialog}
      </>
    );
  }

  // ── Sheet đầy đủ (tap ô) ──
  return (
    <>
      <div className={'sheet-scrim' + (show ? ' show' : '')} onClick={closeWhenIdle} />
      <div className={'sheet' + (show ? ' show' : '')}>
        <div className="sheet-grab" />
        <div className="sheet-scroll">
          {failure && <p role="alert" className="pf-hint err">{failure}</p>}
          {receiptError && <p role="alert" className="pf-hint err">{receiptError}</p>}
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

          <InvoiceDetailCard invoice={invoice} collectors={collectors} items={lazyItems} />

          {getInvoiceEditMode(invoice) === 'adjustment' && <div className="is-note">
            <div className="ib-lbl">Ghi chú hóa đơn</div>
            <p>{invoice.notes || 'Chưa có ghi chú'}</p>
            {canEditInvoice && <Button type="button" variant="link" disabled={loadingInvoice} onClick={() => setEditNoteOpen(true)}>Điều chỉnh ghi chú hóa đơn</Button>}
            {loadingInvoice && <InlineSkeleton label="hóa đơn đầy đủ" width="10rem" />}
            {invoiceError && <p role="alert">Chưa tải được hóa đơn. Đóng và mở lại để thử lại.</p>}
          </div>}

          {canRecordPayment && st !== 'paid' && (
            <>
              <div className="is-note">
                <div className="ib-lbl">{getInvoiceEditMode(invoice) === 'draft' && canEditInvoice ? 'Ghi chú hóa đơn nháp' : 'Ghi chú khoản thu'}</div>
                <NoteEditor value={noteDraft} onChange={setNoteDraft} onBlur={saveNote} />
                {getInvoiceEditMode(invoice) !== 'draft' && <p className="text-xs text-muted-foreground">Ghi chú này được lưu cùng khoản thu khi bấm Thu.</p>}
              </div>
              {loadingItems || itemsError ? itemsStatus : receivingStatus ?? <CollectPayForm
                key={invoice.id}
                remaining={remaining}
                books={receiving.books}
                missingBookMessage={(m) => receivingBlockFor(m) ?? ''}
                changeAccountName={changeAccountName}
                canCredit={!!invoice.contract_id}
                allowRounding={allowRounding}
                onChange={setPayState}
                validationAttempt={validationAttempt}
                receiptError={receiptError}
                disabled={busy || blocked}
              />}
            </>
          )}

          {/* Ghi chú chỉ-đọc khi đã thu đủ / không có quyền thu */}
          {getInvoiceEditMode(invoice) !== 'adjustment' && (!canRecordPayment || st === 'paid') && noteDraft && (
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
              {undoOpen && !undoBlock ? (
                <div className="ho-cancelbox" style={{ flexBasis: '100%' }}>
                  <textarea
                    ref={undoReasonRef}
                    className={"note-input" + (undoReasonError ? " border-red-500" : "")}
                    aria-invalid={!!undoReasonError}
                    aria-describedby={undoReasonError ? "collect-undo-reason-error" : undefined}
                    rows={2}
                    aria-label="Lý do hoàn tác"
                    maxLength={REVISION_REASON_MAX}
                    placeholder={`Lý do hoàn tác (bắt buộc, ít nhất ${REVISION_REASON_MIN} ký tự)…`}
                    value={undoReason}
                    onChange={(e) => setUndoReason(e.target.value)}
                    disabled={deletePayment.isPending}
                  />
                  {undoReasonError && <p id="collect-undo-reason-error" role="alert" className="pf-hint err">{undoReasonError}</p>}
                  <div className="ho-acts">
                    <button
                      type="button"
                      className="ho-btn danger"
                      disabled={deletePayment.isPending}
                      onClick={doUndo}
                    >
                      {deletePayment.isPending ? 'Đang hoàn tác…' : 'Xác nhận hoàn tác'}
                    </button>
                    <button
                      type="button"
                      className="ho-btn ghost"
                      disabled={deletePayment.isPending}
                      onClick={() => { setUndoOpen(false); setUndoReason(''); }}
                    >
                      Đóng
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  className="is-sub-btn undo"
                  disabled={deletePayment.isPending || !!undoBlock}
                  title={undoBlock ? COLLECTION_BLOCK_TEXT[undoBlock] : undefined}
                  onClick={openUndo}
                >
                  <Undo2 />
                  Hoàn tác
                </button>
              )}
              {undoBlock && (
                <div className="is-sub-hint">{COLLECTION_BLOCK_TEXT[undoBlock]}</div>
              )}
            </div>
          )}
        </div>

        <div className="is-actions">
          <button
            type="button"
            className="is-nav prev"
            disabled={!prev || busy}
            onClick={() => !busy && prev && onNavigate(prev)}
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
              disabled={!canRecordPayment || isCollecting || uploading || checkingDup || writing || blocked || loadingItems || itemsError || !!receivingStatus}
              onClick={() => { if (payState?.payload) void submitPayForm(payState.payload); else setValidationAttempt(value => value + 1); }}
            >
              {uploading || isCollecting ? 'Đang ghi…' : checkingDup ? 'Đang kiểm…' : `Thu ${fmtShort(payState?.total ?? remaining)}`}
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
            disabled={!next || busy}
            onClick={() => !busy && next && onNavigate(next)}
          >
            <ChevronRight />
          </button>
        </div>
      </div>
      {editNoteOpen && fullInvoice && <EditInvoiceDialog open onOpenChange={setEditNoteOpen} invoice={fullInvoice} />}
      {dupDialog}
    </>
  );
}

export default CollectDrawer;
