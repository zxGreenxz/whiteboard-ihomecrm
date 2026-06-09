import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Check, ChevronRight, Phone, StickyNote, Undo2, Wallet } from 'lucide-react';
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
import { InvoiceDetailCard } from './InvoiceDetailCard';
import { CollectKeypad } from './CollectKeypad';
import { NoteEditor } from './NoteEditor';
import type { InvoiceWithRelations } from '@/types/invoice';

interface Props {
  invoice: InvoiceWithRelations | null;
  show: boolean;
  /** keypad = mở từ nút "Thu 1P" (sheet gọn); view = tap ô (sheet đầy đủ). */
  mode: 'view' | 'keypad';
  canRecordPayment: boolean;
  prev: InvoiceWithRelations | null;
  next: InvoiceWithRelations | null;
  onClose: () => void;
  onNavigate: (inv: InvoiceWithRelations) => void;
}

export function CollectDrawer({
  invoice,
  show,
  mode,
  canRecordPayment,
  prev,
  next,
  onClose,
  onNavigate,
}: Props) {
  const { collect, isCollecting } = useQuickCollect();
  const deletePayment = useDeletePayment();
  const updateNote = useUpdateInvoiceNote();

  const compact = mode === 'keypad';
  const [subMode, setSubMode] = useState<'view' | 'keypad'>('view');
  const [entered, setEntered] = useState('');
  const [noteDraft, setNoteDraft] = useState('');
  const [noteOpen, setNoteOpen] = useState(false);

  useEffect(() => {
    setSubMode('view');
    setEntered('');
    setNoteOpen(false);
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

  const runCollect = async (amount: number, onDone: () => void) => {
    try {
      const res = await collect({ invoice, amount, notes: noteDraft });
      if (res.failures.length === 0) onDone();
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

  const keypad = (
    <CollectKeypad
      remaining={remaining}
      entered={entered}
      onEntered={setEntered}
      confirming={isCollecting}
      onConfirm={() =>
        runCollect((parseInt(entered, 10) || 0) * 1000, () => {
          if (compact) onClose();
          else {
            setSubMode('view');
            setEntered('');
          }
        })
      }
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

          <InvoiceDetailCard invoice={invoice} />

          {(noteOpen || noteDraft) && (
            <div className="is-note">
              <div className="ib-lbl">Ghi chú</div>
              {noteOpen ? (
                <NoteEditor value={noteDraft} onChange={setNoteDraft} onBlur={saveNote} />
              ) : (
                <div className="note-display">
                  <StickyNote />
                  {noteDraft}
                </div>
              )}
            </div>
          )}

          {subMode === 'keypad' && canRecordPayment && keypad}

          <div className="is-sub-actions">
            {canRecordPayment && (
              <button
                type="button"
                className={'is-sub-btn' + (subMode === 'keypad' ? ' on' : '')}
                onClick={() => setSubMode((m) => (m === 'keypad' ? 'view' : 'keypad'))}
              >
                <Wallet />
                Thu một phần
              </button>
            )}
            <button
              type="button"
              className={'is-sub-btn' + (noteOpen ? ' on' : '')}
              onClick={() => setNoteOpen((v) => !v)}
            >
              <StickyNote />
              Ghi chú
            </button>
            {canRecordPayment && (invoice.paid_amount ?? 0) > 0 && (
              <button
                type="button"
                className="is-sub-btn undo"
                disabled={deletePayment.isPending}
                onClick={doUndo}
              >
                <Undo2 />
                Hoàn tác
              </button>
            )}
          </div>
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
              disabled={!canRecordPayment || isCollecting}
              onClick={() => runCollect(remaining, () => {})}
            >
              Thu đủ
              <small>{fmtShort(remaining)}</small>
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
