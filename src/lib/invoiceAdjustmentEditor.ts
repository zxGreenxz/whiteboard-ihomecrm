import { z } from 'zod';
import type { InvoiceWithRelations } from '@/types/invoice';
import { roundInvoiceTotal } from './invoiceUtils';

const nonNegative = z.number().finite().min(0, 'Giá trị phải từ 0 trở lên');
export const adjustmentItemSchema = z.object({
  id: z.string().uuid().nullable(),
  service_id: z.string().uuid().nullable(),
  type: z.enum(['RENT', 'SERVICE', 'PENALTY', 'DISCOUNT', 'OTHER']),
  accounting_class: z.enum(['REVENUE', 'DEPOSIT', 'NON_PNL']),
  description: z.string().refine(value => value.trim().length > 0, 'Nhập mô tả hạng mục'),
  unit_price: nonNegative, quantity: nonNegative, coefficient: nonNegative,
  previous_reading: nonNegative.nullable(), current_reading: nonNegative.nullable(),
  from_date: z.string().nullable(), to_date: z.string().nullable(), sort_order: z.number().int(),
});
export const issuedInvoiceSchema = z.object({
  items: z.array(adjustmentItemSchema).min(1, 'Cần ít nhất một hạng mục').max(500),
  discount_amount: nonNegative, discount_notes: z.string().nullable(), notes: z.string().nullable(),
  reason: z.string().trim().min(3, 'Lý do cần ít nhất 3 ký tự').max(1000, 'Lý do tối đa 1000 ký tự'),
});
export type IssuedInvoiceValues = z.infer<typeof issuedInvoiceSchema>;
export type AdjustmentItem = z.infer<typeof adjustmentItemSchema>;

/** Capture document and concurrency token together; no building/contract defaults. */
export function createAdjustmentSnapshot(invoice: InvoiceWithRelations) {
  return {
    invoiceId: invoice.id, expectedRevision: invoice.adjustment_revision ?? 0,
    expectedPaidAmount: invoice.paid_amount, expectedUpdatedAt: invoice.updated_at,
    total: invoice.total_amount, previousDebt: invoice.previous_debt ?? 0,
    values: {
      items: (invoice.invoice_items ?? []).slice().sort((a, b) => a.sort_order - b.sort_order || a.id.localeCompare(b.id)).map(item => ({
        id: item.id, service_id: item.service_id ?? null, type: item.type,
        accounting_class: item.accounting_class!, description: item.description,
        unit_price: item.unit_price, quantity: item.quantity, coefficient: item.coefficient ?? 1,
        previous_reading: item.previous_reading ?? null, current_reading: item.current_reading ?? null,
        from_date: item.from_date ?? null, to_date: item.to_date ?? null, sort_order: item.sort_order,
      })),
      discount_amount: invoice.discount_amount ?? 0, discount_notes: invoice.discount_notes ?? null,
      notes: invoice.notes ?? null, reason: '',
    } satisfies IssuedInvoiceValues,
  };
}
export type AdjustmentSnapshot = ReturnType<typeof createAdjustmentSnapshot>;
export function buildAdjustmentRequest(snapshot: AdjustmentSnapshot, values: IssuedInvoiceValues) {
  const data = issuedInvoiceSchema.parse(values);
  return {
    invoiceId: snapshot.invoiceId, afterItems: data.items, discountAmount: data.discount_amount,
    discountNotes: data.discount_notes, notes: data.notes, reason: data.reason,
    expectedRevision: snapshot.expectedRevision, expectedPaidAmount: snapshot.expectedPaidAmount,
    expectedUpdatedAt: snapshot.expectedUpdatedAt,
  };
}
export type AdjustmentRequest = ReturnType<typeof buildAdjustmentRequest>;
export function createAdjustmentRetryKey() {
  const keys = new Map<string, string>();
  return (request: AdjustmentRequest) => {
    const fingerprint = JSON.stringify(request);
    const previous = keys.get(fingerprint);
    if (previous) return previous;
    const key = `invoice-adjustment-${crypto.randomUUID()}`;
    keys.set(fingerprint, key);
    return key;
  };
}
export function adjustmentPreview(values: IssuedInvoiceValues, previousDebt: number) {
  const subtotal = values.items.reduce((sum, item) => sum + Math.round(item.unit_price * item.quantity * item.coefficient * 100) / 100, 0);
  return { subtotal, total: roundInvoiceTotal(subtotal - values.discount_amount + previousDebt) };
}
