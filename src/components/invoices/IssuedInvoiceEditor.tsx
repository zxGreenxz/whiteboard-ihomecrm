import { lazy, Suspense, useMemo, useRef, useState } from 'react';
import { useForm, type Resolver } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { useAdjustInvoice, useInvoice } from '@/hooks/useInvoices';
import {
  buildAdjustmentRequest,
  createAdjustmentRetryKey,
  createAdjustmentSnapshot,
  issuedInvoiceSchema,
} from '@/lib/invoiceAdjustmentEditor';
import { buildAdjustmentItems, pricingFromInvoice } from '@/lib/invoiceAdjustmentEntry';
import { InvoiceAdjustmentError } from '@/lib/invoiceAdjustmentRpc';
import {
  decomposeInvoice,
  findDepositIndex,
  firstEntryError,
  invoiceEntrySchema,
  type InvoiceEntryValues,
} from '@/lib/invoiceEntry';
import { getInvoiceEditMode } from '@/lib/invoiceUtils';
import type { InvoiceWithRelations } from '@/types/invoice';
import { InvoiceEntryShell } from './invoice-entry/InvoiceEntryShell';
import { useInvoiceEntry } from './invoice-entry/useInvoiceEntry';
import type { InvoiceEntryCurrent } from './invoice-entry/types';

const PaymentsSummaryDialog = lazy(() => import('./PaymentsSummaryDialog'));
type Props = { invoice: InvoiceWithRelations; onOpenChange: (open: boolean) => void };

// Kỳ / ngày lập / hạn giữ cố định và không gửi đi → không bắt buộc ở form này.
const adjustmentEntrySchema = invoiceEntrySchema.extend({
  billing_month: z.string().optional().default(''),
  issue_date: z.string().optional().default(''),
  due_date: z.string().optional().default(''),
  reason: issuedInvoiceSchema.shape.reason,
});
type AdjustmentEntryValues = InvoiceEntryValues & { reason: string };

function representativeName(invoice: InvoiceWithRelations): string {
  const ccs = invoice.contract?.contract_customers ?? [];
  const rep = ccs.find((c) => c.is_representative) ?? ccs[0];
  return rep?.customer?.full_name ?? invoice.tenant?.full_name ?? '';
}

/** Ảnh chụp lúc mở: tài liệu + token đồng thời + bản tách về form, đi cùng nhau. */
function openSnapshot(invoice: InvoiceWithRelations) {
  return { invoice, snapshot: createAdjustmentSnapshot(invoice), entry: decomposeInvoice(invoice) };
}

/**
 * Điều chỉnh hoá đơn đã duyệt / đã thanh toán — dùng bộ nhập liệu chung với
 * Tạo lẻ. Mounted once per dialog opening; a refetch never rewrites the opening
 * snapshot. Dòng không đụng đi vào RPC nguyên xi (buildAdjustmentItems).
 */
export default function IssuedInvoiceEditor({ invoice, onOpenChange }: Props) {
  const [opened, setOpened] = useState(() => openSnapshot(invoice));
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const [paymentsOpen, setPaymentsOpen] = useState(false);
  const [stale, setStale] = useState(false);
  const inFlight = useRef(false);
  const retryKey = useRef(createAdjustmentRetryKey());
  const mutation = useAdjustInvoice();
  const { refetch } = useInvoice(invoice.id);
  const { snapshot, entry } = opened;

  const form = useForm<AdjustmentEntryValues>({
    resolver: zodResolver(adjustmentEntrySchema) as Resolver<AdjustmentEntryValues>,
    defaultValues: { ...entry.values, reason: '' },
  });
  const { handleSubmit, reset, watch, setValue, formState: { errors } } = form;
  const pricing = useMemo(() => pricingFromInvoice(entry), [entry]);
  const ctl = useInvoiceEntry(form, { baseline: entry.values, baselineAmounts: entry.baseline, pricing });
  const reasonValue = watch('reason') ?? '';

  const current: InvoiceEntryCurrent = useMemo(() => {
    const b = entry.values;
    const depIdx = findDepositIndex(b.custom_items);
    const dep = depIdx >= 0 ? b.custom_items[depIdx] : null;
    return {
      paid: snapshot.expectedPaidAmount,
      rentPrice: b.rent_price,
      rentAmount: entry.baseline.rentAmount,
      deposit: dep ? dep.unit_price * dep.quantity * (dep.coefficient ?? 1) : 0,
      electric: b.electric_amount,
      prev: b.prev_reading,
      curr: b.current_reading,
      occupants: b.occupants,
      water: entry.baseline.waterAmount,
      pdv: entry.baseline.pdvAmount,
      total: snapshot.total,
    };
  }, [entry, snapshot]);

  const submit = handleSubmit(async (data) => {
    if (inFlight.current || stale) return;
    inFlight.current = true; setBusy(true); setError(null);
    try {
      const request = buildAdjustmentRequest(snapshot, {
        items: buildAdjustmentItems(data, entry),
        discount_amount: data.discount_amount || 0,
        discount_notes: data.discount_notes?.trim() ? data.discount_notes.trim() : null,
        notes: data.notes ?? null,
        reason: data.reason,
      });
      await mutation.mutateAsync({ ...request, idempotencyKey: retryKey.current(request) });
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause : new InvoiceAdjustmentError({}));
      if (cause instanceof InvoiceAdjustmentError && cause.kind === 'conflict') setStale(true);
    } finally { inFlight.current = false; setBusy(false); }
  });

  const reload = async () => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true);
    try {
      const result = await refetch();
      if (result.error || !result.data) throw new Error('Chưa tải lại được hóa đơn. Vui lòng thử lại.');
      if (getInvoiceEditMode(result.data) !== 'adjustment') throw new Error('Hóa đơn không còn cho phép điều chỉnh. Đóng hộp thoại và kiểm tra trạng thái.');
      const fresh = openSnapshot(result.data);
      setOpened(fresh); reset({ ...fresh.entry.values, reason: '' }); setError(null); setStale(false);
      retryKey.current = createAdjustmentRetryKey();
    } catch (cause) { setError(cause instanceof Error ? cause : new InvoiceAdjustmentError({})); }
    finally { inFlight.current = false; setBusy(false); }
  };

  const close = () => { if (!inFlight.current) onOpenChange(false); };
  const src = opened.invoice;

  return <>
    <InvoiceEntryShell
      open
      onOpenChange={(open) => { if (!inFlight.current) onOpenChange(open); }}
      onSubmit={submit}
      mode="edit"
      ctl={ctl}
      header={{
        title: 'Điều chỉnh hoá đơn',
        invoiceNo: src.invoice_number || src.id.slice(0, 8),
        building: src.building?.name ?? '',
        room: src.room?.name ?? '',
        rep: representativeName(src),
        lockNote: 'Toà/phòng · hợp đồng · kỳ · ngày lập · hạn thanh toán · nguồn nợ giữ cố định để bảo toàn liên kết chứng từ.',
      }}
      current={current}
      pricing={pricing}
      meterId={entry.sources.electric ? 'invoice' : null}
      debt={{ locked: true, sources: [], loading: false, canReload: false, onReload: () => {} }}
      creditBalance={0}
      defaultDepositAmount={0}
      ready
      lockedDates
      busy={busy || mutation.isPending}
      reason={{
        value: reasonValue,
        onChange: (s) => setValue('reason', s, { shouldValidate: !!errors.reason }),
        error: errors.reason?.message,
      }}
      validationError={firstEntryError(errors)}
      notice={error && (
        <div role="alert" className="space-y-2 rounded-[9px] border border-red-300 bg-red-50 p-3 text-sm text-red-800">
          <p>{error.message}</p>
          <div className="flex flex-wrap gap-2">
            {error instanceof InvoiceAdjustmentError && error.showPaymentHistory && (
              <Button type="button" variant="link" className="h-8 px-2" onClick={() => setPaymentsOpen(true)}>Mở lịch sử thanh toán</Button>
            )}
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={reload}>Tải lại hóa đơn</Button>
          </div>
          <p className="text-xs text-red-700/80">Tải lại sẽ bỏ nội dung chưa lưu và lấy phiên bản mới nhất.</p>
        </div>
      )}
      onResetAll={() => reset({ ...entry.values, reason: reasonValue })}
      onCancel={close}
      footNote={`Phiên bản hiện tại #${snapshot.expectedRevision}. Mỗi lần lưu tạo một phiên bản có lịch sử riêng.`}
      submit={{
        label: 'Lưu điều chỉnh',
        pendingLabel: 'Đang lưu…',
        pending: busy || mutation.isPending,
        disabled: stale,
      }}
    />
    {paymentsOpen && <Suspense fallback={null}><PaymentsSummaryDialog open onOpenChange={setPaymentsOpen} invoice={invoice} /></Suspense>}
  </>;
}
