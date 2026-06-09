import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  Banknote,
  Check,
  ChevronLeft,
  ChevronRight,
  Phone,
  StickyNote,
  Undo2,
} from 'lucide-react';
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
} from '@/components/ui/drawer';
import { cn } from '@/lib/utils';
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
  open: boolean;
  /** keypad = mở từ nút "Thu 1P" (drawer gọn); view = tap ô (drawer đầy đủ). */
  mode: 'view' | 'keypad';
  canRecordPayment: boolean;
  prev: InvoiceWithRelations | null;
  next: InvoiceWithRelations | null;
  onOpenChange: (open: boolean) => void;
  onNavigate: (inv: InvoiceWithRelations) => void;
}

export function CollectDrawer({
  invoice,
  open,
  mode,
  canRecordPayment,
  prev,
  next,
  onOpenChange,
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

  if (!invoice) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerContent />
      </Drawer>
    );
  }

  const remaining = remainingOf(invoice);
  const st = collectStatus(invoice);
  const meta = STATUS_META[st];
  const rep = repCustomer(invoice);
  const code = invoice.room?.name ?? '?';
  const fullCode = invoice.building?.name ? `${invoice.building.name} - ${code}` : code;

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

  // ── Drawer gọn (Thu 1P): chỉ keypad + ghi chú ──
  if (compact) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerContent className="max-h-[92vh]">
          <div className="space-y-4 overflow-y-auto p-4 pb-6">
            <div className="flex items-baseline justify-between">
              <DrawerTitle className="font-mono text-lg">{code}</DrawerTitle>
              <DrawerDescription>
                Còn phải thu <b className="font-mono text-zinc-700">{fmtFull(remaining)}</b>
              </DrawerDescription>
            </div>
            <CollectKeypad
              remaining={remaining}
              entered={entered}
              onEntered={setEntered}
              confirming={isCollecting}
              onConfirm={() =>
                runCollect((parseInt(entered, 10) || 0) * 1000, () => onOpenChange(false))
              }
            />
            <div>
              <div className="mb-1 text-xs font-medium uppercase text-zinc-400">Ghi chú</div>
              <NoteEditor value={noteDraft} onChange={setNoteDraft} />
            </div>
          </div>
        </DrawerContent>
      </Drawer>
    );
  }

  // ── Drawer đầy đủ (tap ô) ──
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="max-h-[92vh]">
        <div className="flex-1 space-y-4 overflow-y-auto p-4">
          <div className="flex items-start justify-between gap-2">
            <div>
              <DrawerTitle className="font-mono text-xl">{fullCode}</DrawerTitle>
              <DrawerDescription>Kỳ {fmtBillingMonth(invoice.billing_month)}</DrawerDescription>
            </div>
            <span
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium',
                meta.cell,
                meta.text,
              )}
            >
              <span className={cn('h-1.5 w-1.5 rounded-full', meta.dot)} />
              {meta.label}
            </span>
          </div>

          <InvoiceDetailCard invoice={invoice} />

          {(noteOpen || noteDraft) && (
            <div>
              <div className="mb-1 text-xs font-medium uppercase text-zinc-400">Ghi chú</div>
              {noteOpen ? (
                <NoteEditor value={noteDraft} onChange={setNoteDraft} onBlur={saveNote} />
              ) : (
                <div className="flex items-start gap-2 rounded-lg bg-zinc-50 px-3 py-2 text-sm text-zinc-600">
                  <StickyNote className="mt-0.5 h-4 w-4 shrink-0 text-zinc-400" />
                  {noteDraft}
                </div>
              )}
            </div>
          )}

          {subMode === 'keypad' && canRecordPayment && (
            <CollectKeypad
              remaining={remaining}
              entered={entered}
              onEntered={setEntered}
              confirming={isCollecting}
              onConfirm={() =>
                runCollect((parseInt(entered, 10) || 0) * 1000, () => {
                  setSubMode('view');
                  setEntered('');
                })
              }
            />
          )}

          <div className="flex flex-wrap gap-2">
            {canRecordPayment && (
              <button
                type="button"
                onClick={() => setSubMode((m) => (m === 'keypad' ? 'view' : 'keypad'))}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium',
                  subMode === 'keypad'
                    ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
                    : 'border-zinc-200 text-zinc-700',
                )}
              >
                <Banknote className="h-4 w-4" />
                Thu một phần
              </button>
            )}
            <button
              type="button"
              onClick={() => setNoteOpen((v) => !v)}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium',
                noteOpen ? 'border-zinc-400 text-zinc-900' : 'border-zinc-200 text-zinc-700',
              )}
            >
              <StickyNote className="h-4 w-4" />
              Ghi chú
            </button>
            {canRecordPayment && (invoice.paid_amount ?? 0) > 0 && (
              <button
                type="button"
                onClick={doUndo}
                disabled={deletePayment.isPending}
                className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 px-3 py-2 text-sm font-medium text-red-600 disabled:opacity-50"
              >
                <Undo2 className="h-4 w-4" />
                Hoàn tác
              </button>
            )}
          </div>
        </div>

        {/* Thanh đáy: ‹ prev · Thu đủ · Gọi · next › */}
        <div className="flex items-center gap-2 border-t border-zinc-100 p-3">
          <button
            type="button"
            disabled={!prev}
            onClick={() => prev && onNavigate(prev)}
            className="rounded-lg border border-zinc-200 p-2.5 text-zinc-600 disabled:opacity-30"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          {st === 'paid' ? (
            <button
              type="button"
              disabled
              className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-zinc-100 py-3 text-sm font-semibold text-emerald-600"
            >
              <Check className="h-4 w-4" />
              Đã thu đủ
            </button>
          ) : (
            <button
              type="button"
              disabled={!canRecordPayment || isCollecting}
              onClick={() => runCollect(remaining, () => {})}
              className="flex flex-1 flex-col items-center justify-center rounded-xl bg-emerald-600 py-2 font-semibold text-white disabled:opacity-50 active:bg-emerald-700"
            >
              Thu đủ
              <span className="font-mono text-xs font-normal opacity-90">{fmtShort(remaining)}</span>
            </button>
          )}
          <button
            type="button"
            disabled={!rep.phone}
            onClick={doCall}
            className="rounded-lg border border-zinc-200 p-2.5 text-emerald-600 disabled:opacity-30"
          >
            <Phone className="h-5 w-5" />
          </button>
          <button
            type="button"
            disabled={!next}
            onClick={() => next && onNavigate(next)}
            className="rounded-lg border border-zinc-200 p-2.5 text-zinc-600 disabled:opacity-30"
          >
            <ChevronRight className="h-5 w-5" />
          </button>
        </div>
      </DrawerContent>
    </Drawer>
  );
}

export default CollectDrawer;
