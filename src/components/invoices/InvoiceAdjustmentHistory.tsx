import { useRef, useState } from 'react';
import { z } from 'zod';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useInvoice, useReviewInvoiceAdjustment } from '@/hooks/useInvoices';
import { useMyPermissions } from '@/hooks/useMyPermissions';
import { canUse } from '@/lib/permissionPages';
import { InvoiceAdjustmentError } from '@/lib/invoiceAdjustmentRpc';
import type { InvoiceAdjustment, InvoiceWithRelations } from '@/types/invoice';

const money = (value: number) => new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(value);
const numeric = z.union([z.number(), z.string().min(1)]).transform(Number).refine(Number.isFinite);
const snapshotSchema = z.object({
  items: z.array(z.object({ description: z.string(), amount: numeric.optional(), unit_price: numeric.optional(), quantity: numeric.optional(), coefficient: numeric.optional(), accounting_class: z.string().optional(), from_date: z.string().nullable().optional(), to_date: z.string().nullable().optional() })),
  total_amount: numeric.optional(), discount_amount: numeric.optional(), previous_debt: numeric.optional(),
  notes: z.string().nullable().optional(), discount_notes: z.string().nullable().optional(),
});
function Snapshot({ data, total, label }: { data: Record<string, unknown>; total: number; label: string }) {
  const parsed = snapshotSchema.safeParse(data);
  return <details className="rounded border p-2" open><summary className="font-medium">{label} · {money(total)}</summary>
    {parsed.success ? <div className="mt-2 space-y-1 text-xs">
      {parsed.data.items.map((item, index) => <div key={index} className="flex justify-between gap-3"><span>{item.description}{item.accounting_class && item.accounting_class !== 'REVENUE' ? ` · ${item.accounting_class === 'DEPOSIT' ? 'Tiền cọc' : 'Ngoài doanh thu'}` : ''}{item.from_date && <small className="block">{item.from_date} → {item.to_date ?? '—'}</small>}</span><span className="whitespace-nowrap">{money(item.amount ?? (item.unit_price ?? 0) * (item.quantity ?? 1) * (item.coefficient ?? 1))}</span></div>)}
      <p>Giảm trừ: {money(parsed.data.discount_amount ?? 0)}{parsed.data.discount_notes ? ` · ${parsed.data.discount_notes}` : ''}</p>
      {!!parsed.data.previous_debt && <p>Nợ cũ: {money(parsed.data.previous_debt)}</p>}
      {parsed.data.notes && <p>Ghi chú: {parsed.data.notes}</p>}
    </div> : <p className="text-xs text-muted-foreground">Bản lưu lịch sử không có đủ chi tiết dòng; tổng tiền được giữ theo phiên bản.</p>}
  </details>;
}
const byRevision = (a: InvoiceAdjustment, b: InvoiceAdjustment) => a.revision - b.revision || a.adjusted_at.localeCompare(b.adjusted_at) || a.id.localeCompare(b.id);

/** One history for desktop/mobile. Review is limited to the exact current revision. */
export default function InvoiceAdjustmentHistory({ invoice }: { invoice: InvoiceWithRelations }) {
  const { data: permissions } = useMyPermissions();
  const mutation = useReviewInvoiceAdjustment();
  const { refetch } = useInvoice(invoice.id);
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);
  const inFlight = useRef(false);
  const history = (invoice.invoice_adjustments ?? []).slice().sort(byRevision);
  const original = history[0];
  if (!original) return null;
  const review = async (adjustment: InvoiceAdjustment) => {
    if (inFlight.current || stale || adjustment.revision !== invoice.adjustment_revision || !canUse(permissions, 'invoices', 'approve')) return;
    inFlight.current = true; setBusy(true); setError(null);
    try { await mutation.mutateAsync({ adjustmentId: adjustment.id, expectedRevision: adjustment.revision }); }
    catch (cause) {
      setError(cause instanceof Error ? cause : new InvoiceAdjustmentError({}));
      if (cause instanceof InvoiceAdjustmentError && cause.kind === 'conflict') setStale(true);
    } finally { inFlight.current = false; setBusy(false); }
  };
  const reload = async () => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true);
    try {
      const result = await refetch();
      if (result.error || !result.data) throw new Error('Chưa tải lại được lịch sử. Vui lòng thử lại.');
      setError(null); setStale(false);
    } catch (cause) { setError(cause instanceof Error ? cause : new InvoiceAdjustmentError({})); }
    finally { inFlight.current = false; setBusy(false); }
  };
  return <Card>
    <CardHeader><CardTitle>Lịch sử điều chỉnh</CardTitle></CardHeader>
    <CardContent className="space-y-3">
      <h3 className="font-medium">Hóa đơn gốc</h3>
      <Snapshot label="Bản gốc bất biến" data={original.before_snapshot} total={original.before_total} />
      <p className="text-sm">Hiện tại: phiên bản #{invoice.adjustment_revision ?? history.at(-1)?.revision} · <b>{money(invoice.total_amount)}</b></p>
      {history.map(adjustment => <section key={adjustment.id} data-revision={adjustment.revision} className="rounded border p-3 text-sm space-y-2">
        <div className="flex flex-wrap justify-between gap-2"><h3 className="font-medium">Điều chỉnh #{adjustment.revision}: {adjustment.reason}</h3><Badge variant={adjustment.review_status === 'CHECKED' ? 'default' : 'secondary'}>{adjustment.review_status === 'CHECKED' ? 'Đã kiểm tra' : 'Chưa kiểm tra'}</Badge></div>
        <p>{money(adjustment.before_total)} → {money(adjustment.after_total)} · Chênh lệch {money(adjustment.delta)}</p>
        <div className="grid gap-2 sm:grid-cols-2"><Snapshot label="Trước điều chỉnh" data={adjustment.before_snapshot} total={adjustment.before_total} /><Snapshot label="Sau điều chỉnh" data={adjustment.after_snapshot} total={adjustment.after_total} /></div>
        <p className="text-xs text-muted-foreground">Điều chỉnh lúc {new Date(adjustment.adjusted_at).toLocaleString('vi-VN')}{adjustment.checked_at ? ` · Kiểm tra lúc ${new Date(adjustment.checked_at).toLocaleString('vi-VN')}` : ''}</p>
        {adjustment.review_status === 'PENDING' && adjustment.revision === invoice.adjustment_revision && invoice.adjustment_review_status === 'PENDING' && canUse(permissions, 'invoices', 'approve') && <Button size="sm" disabled={busy || mutation.isPending || stale} onClick={() => review(adjustment)}>Xác nhận kiểm tra</Button>}
      </section>)}
      {error && <div role="alert" className="rounded border border-destructive p-3 text-sm"><p>{error.message}</p><Button variant="outline" disabled={busy} onClick={reload}>Tải lại lịch sử</Button></div>}
    </CardContent>
  </Card>;
}
