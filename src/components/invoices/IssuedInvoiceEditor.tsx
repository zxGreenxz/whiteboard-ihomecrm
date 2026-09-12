import { lazy, Suspense, useRef, useState } from 'react';
import { Controller, useFieldArray, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useAdjustInvoice, useInvoice } from '@/hooks/useInvoices';
import { adjustmentPreview, buildAdjustmentRequest, createAdjustmentRetryKey, createAdjustmentSnapshot, issuedInvoiceSchema, type IssuedInvoiceValues } from '@/lib/invoiceAdjustmentEditor';
import { InvoiceAdjustmentError } from '@/lib/invoiceAdjustmentRpc';
import { getInvoiceEditMode } from '@/lib/invoiceUtils';
import type { InvoiceWithRelations } from '@/types/invoice';

const PaymentsSummaryDialog = lazy(() => import('./PaymentsSummaryDialog'));
const money = (value: number) => Number.isFinite(value) ? new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(value) : '—';
type Props = { invoice: InvoiceWithRelations; onOpenChange: (open: boolean) => void };

/** Mounted once per dialog opening. A refetch never rewrites the opening snapshot. */
export default function IssuedInvoiceEditor({ invoice, onOpenChange }: Props) {
  const [snapshot, setSnapshot] = useState(() => createAdjustmentSnapshot(invoice));
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const [paymentsOpen, setPaymentsOpen] = useState(false);
  const [stale, setStale] = useState(false);
  const inFlight = useRef(false);
  const retryKey = useRef(createAdjustmentRetryKey());
  const mutation = useAdjustInvoice();
  const { refetch } = useInvoice(invoice.id);
  const { register, control, handleSubmit, watch, reset, formState: { errors } } = useForm<IssuedInvoiceValues>({
    resolver: zodResolver(issuedInvoiceSchema), defaultValues: snapshot.values,
  });
  // `fieldKey` belongs to RHF; `id` remains the persisted invoice item identity.
  const { fields, append, remove } = useFieldArray({ control, name: 'items', keyName: 'fieldKey' });
  const values = watch();
  const preview = adjustmentPreview(values, snapshot.previousDebt);
  const submit = handleSubmit(async data => {
    if (inFlight.current || stale) return;
    inFlight.current = true; setBusy(true); setError(null);
    try {
      const request = buildAdjustmentRequest(snapshot, data);
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
      const fresh = createAdjustmentSnapshot(result.data);
      setSnapshot(fresh); reset(fresh.values); setError(null); setStale(false);
      retryKey.current = createAdjustmentRetryKey();
    } catch (cause) { setError(cause instanceof Error ? cause : new InvoiceAdjustmentError({})); }
    finally { inFlight.current = false; setBusy(false); }
  };
  return <>
    <Dialog open onOpenChange={open => { if (!inFlight.current) onOpenChange(open); }}>
      <DialogContent className="w-[calc(100vw-1rem)] max-w-4xl max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Điều chỉnh hóa đơn {invoice.invoice_number}</DialogTitle>
          <DialogDescription>Phiên bản hiện tại #{snapshot.expectedRevision}. Mỗi lần lưu tạo một phiên bản có lịch sử riêng.</DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">Tòa/phòng, hợp đồng, kỳ hóa đơn, ngày lập, hạn thanh toán và nguồn nợ được giữ cố định để bảo toàn liên kết chứng từ.</p>
        <p className="text-sm">{invoice.building?.name} / {invoice.room?.name} · Kỳ {invoice.billing_month} · Ngày lập {invoice.issue_date} · Hạn {invoice.due_date} · Nợ cũ {money(snapshot.previousDebt)}</p>
        <form onSubmit={submit} className="space-y-4">
          <fieldset disabled={busy || mutation.isPending} className="space-y-4">
            <div className="space-y-3">
              {fields.map((field, index) => <div key={field.fieldKey} className="rounded border p-3 space-y-2">
                <div className="flex justify-between items-center"><b>Hạng mục {index + 1}</b><Button type="button" variant="ghost" onClick={() => remove(index)}>Xóa hạng mục {index + 1}</Button></div>
                <Label htmlFor={`item-${index}-description`}>Mô tả {index + 1}</Label>
                <Input id={`item-${index}-description`} {...register(`items.${index}.description`)} />
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  <div><Label htmlFor={`item-${index}-type`}>Loại dòng</Label><Controller control={control} name={`items.${index}.type`} render={({ field: typeField }) => <Select value={typeField.value} onValueChange={typeField.onChange} disabled={busy}><SelectTrigger id={`item-${index}-type`}><SelectValue /></SelectTrigger><SelectContent>{[['RENT', 'Tiền thuê'], ['SERVICE', 'Dịch vụ'], ['PENALTY', 'Phạt'], ['DISCOUNT', 'Giảm giá'], ['OTHER', 'Khác']].map(([value, label]) => <SelectItem key={value} value={value!}>{label}</SelectItem>)}</SelectContent></Select>} /></div>
                  <div><Label htmlFor={`item-${index}-class`}>Phân loại kế toán</Label><Controller control={control} name={`items.${index}.accounting_class`} render={({ field: classField }) => <Select value={classField.value} onValueChange={classField.onChange} disabled={busy}><SelectTrigger id={`item-${index}-class`}><SelectValue placeholder="Chọn phân loại" /></SelectTrigger><SelectContent><SelectItem value="REVENUE">Doanh thu</SelectItem><SelectItem value="DEPOSIT">Tiền cọc</SelectItem><SelectItem value="NON_PNL">Ngoài doanh thu</SelectItem></SelectContent></Select>} /></div>
                  {(['unit_price', 'quantity', 'coefficient'] as const).map((key, i) => <label key={key} className="text-sm">{['Đơn giá', 'Số lượng', 'Hệ số'][i]} {index + 1}<Input type="number" step="any" min="0" {...register(`items.${index}.${key}`, { valueAsNumber: true })} /></label>)}
                  <div className="text-sm">Thành tiền<div className="font-semibold">{money((values.items[index]?.unit_price ?? 0) * (values.items[index]?.quantity ?? 0) * (values.items[index]?.coefficient ?? 0))}</div></div>
                </div>
                <details className="text-sm"><summary>Chỉ số và kỳ tính tiền</summary><div className="grid grid-cols-2 gap-3 mt-2">
                  {(['previous_reading', 'current_reading'] as const).map((key, i) => <label key={key}>{['Chỉ số đầu', 'Chỉ số cuối'][i]}<Input type="number" step="any" min="0" {...register(`items.${index}.${key}`, { setValueAs: value => value === '' || value == null ? null : Number(value) })} /></label>)}
                  {(['from_date', 'to_date'] as const).map((key, i) => <label key={key}>{['Từ ngày', 'Đến ngày'][i]}<Input type="date" {...register(`items.${index}.${key}`, { setValueAs: value => value || null })} /></label>)}
                </div><p className="mt-2 text-muted-foreground">Liên kết dịch vụ và thứ tự dòng được giữ theo hóa đơn hiện tại.</p></details>
                {errors.items?.[index] && <p role="alert" className="text-sm text-destructive">Kiểm tra mô tả, phân loại và các giá trị số của hạng mục {index + 1}.</p>}
              </div>)}
            </div>
            <Button type="button" variant="outline" onClick={() => append({ id: null, service_id: null, type: 'OTHER', accounting_class: 'REVENUE', description: '', unit_price: 0, quantity: 1, coefficient: 1, previous_reading: null, current_reading: null, from_date: null, to_date: null, sort_order: Math.max(-1, ...values.items.map(item => item.sort_order)) + 1 })}>Thêm hạng mục</Button>
            {errors.items?.message && <p role="alert" className="text-destructive">{errors.items.message}</p>}
            <div><Label htmlFor="issued-discount">Giảm trừ</Label><Input id="issued-discount" type="number" min="0" step="any" {...register('discount_amount', { valueAsNumber: true })} />{errors.discount_amount && <p role="alert">{errors.discount_amount.message}</p>}</div>
            <div><Label htmlFor="issued-discount-notes">Ghi chú giảm trừ</Label><Textarea id="issued-discount-notes" {...register('discount_notes')} /></div>
            <div><Label htmlFor="issued-notes">Ghi chú</Label><Textarea id="issued-notes" {...register('notes')} /></div>
            <div><Label htmlFor="issued-reason">Lý do điều chỉnh</Label><Textarea id="issued-reason" {...register('reason')} placeholder="Nêu lý do thay đổi (3–1000 ký tự)" />{errors.reason && <p role="alert" className="text-destructive">{errors.reason.message}</p>}</div>
          </fieldset>
          <div className="rounded bg-muted p-3 text-sm space-y-1"><p>Hiện tại / trước điều chỉnh: <b>{money(snapshot.total)}</b></p><p>Sau điều chỉnh (dự tính): <b>{money(preview.total)}</b></p><p>Chênh lệch: <b>{money(preview.total - snapshot.total)}</b></p><p>Đã thu: {money(snapshot.expectedPaidAmount)} · Còn phải thu dự tính: {money(preview.total - snapshot.expectedPaidAmount)}</p></div>
          {error && <div role="alert" className="rounded border border-destructive p-3 text-sm space-y-2"><p>{error.message}</p>{error instanceof InvoiceAdjustmentError && error.showPaymentHistory && <Button type="button" variant="link" onClick={() => setPaymentsOpen(true)}>Mở lịch sử thanh toán</Button>}<Button type="button" variant="outline" disabled={busy} onClick={reload}>Tải lại hóa đơn</Button><p className="text-muted-foreground">Tải lại sẽ bỏ nội dung chưa lưu và lấy phiên bản mới nhất.</p></div>}
          <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>Đóng</Button><Button type="submit" disabled={busy || mutation.isPending || stale}>{busy ? 'Đang lưu…' : 'Lưu điều chỉnh'}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
    {paymentsOpen && <Suspense fallback={null}><PaymentsSummaryDialog open onOpenChange={setPaymentsOpen} invoice={invoice} /></Suspense>}
  </>;
}
