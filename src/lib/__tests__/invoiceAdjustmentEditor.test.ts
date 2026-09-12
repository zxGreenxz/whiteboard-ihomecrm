import { describe, expect, it } from 'vitest';
import { createAdjustmentSnapshot, buildAdjustmentRequest, createAdjustmentRetryKey, issuedInvoiceSchema } from '../invoiceAdjustmentEditor';
import { getInvoiceEditMode, canCancelInvoice } from '../invoiceUtils';
import type { InvoiceWithRelations } from '@/types/invoice';

export const invoice = {
  id: 'dddd0000-0000-4000-8000-000000000101', status: 'APPROVED', paid_amount: 0,
  adjustment_revision: 2, updated_at: '2026-09-12T10:00:00Z', discount_amount: 500,
  discount_notes: 'Giảm đã lưu', notes: 'Ghi chú đã lưu', total_amount: 4500, previous_debt: 0,
  invoice_items: [
    { id: 'dddd0000-0000-4000-8000-000000000111', type: 'SERVICE', accounting_class: 'NON_PNL', description: 'Điện', service_id: 'dddd0000-0000-4000-8000-000000000121', unit_price: 4000, quantity: 1.25, coefficient: 0.5, amount: 2500, previous_reading: 0, current_reading: 1.25, from_date: '2026-09-01', to_date: '2026-09-12', sort_order: 4 },
    { id: 'dddd0000-0000-4000-8000-000000000112', type: 'SERVICE', accounting_class: 'DEPOSIT', description: 'Điện', service_id: null, unit_price: 2500, quantity: 1, coefficient: 1, amount: 2500, previous_reading: null, current_reading: null, from_date: null, to_date: null, sort_order: 5 },
  ],
} as InvoiceWithRelations;

describe('issued invoice document', () => {
  it('notes-only preserves duplicate current lines, fractions, metadata and absent RENT', () => {
    const snapshot = createAdjustmentSnapshot(invoice);
    const request = buildAdjustmentRequest(snapshot, { ...snapshot.values, notes: 'Mới', reason: '  Bổ sung ghi chú  ' });
    expect(request.afterItems).toEqual(invoice.invoice_items?.map(({ amount, ...item }) => item));
    expect(request).toMatchObject({ notes: 'Mới', discountAmount: 500, discountNotes: 'Giảm đã lưu', reason: 'Bổ sung ghi chú', expectedRevision: 2, expectedPaidAmount: 0, expectedUpdatedAt: invoice.updated_at });
  });
  it('does not attach refetched tokens or current building defaults to an old form', () => {
    const source = structuredClone(invoice);
    const snapshot = createAdjustmentSnapshot(source);
    source.updated_at = 'later'; source.paid_amount = 4000; source.adjustment_revision = 3;
    source.invoice_items![0]!.unit_price = 9000;
    const request = buildAdjustmentRequest(snapshot, { ...snapshot.values, reason: 'Sửa giá' });
    expect(request.expectedRevision).toBe(2);
    expect(request.expectedPaidAmount).toBe(0);
    expect(request.afterItems[0]?.unit_price).toBe(4000);
  });
  it('one price change affects only its own line', () => {
    const snapshot = createAdjustmentSnapshot(invoice);
    snapshot.values.items[0]!.unit_price = 6000;
    const request = buildAdjustmentRequest(snapshot, { ...snapshot.values, reason: 'Sửa giá' });
    expect(request.afterItems[0]).toMatchObject({ unit_price: 6000, quantity: 1.25, coefficient: 0.5 });
    expect(request.afterItems[1]).toEqual(createAdjustmentSnapshot(invoice).values.items[1]);
  });
  it('preserves multiple RENT rows without flattening either price or quantity', () => {
    const source = { ...invoice, invoice_items: invoice.invoice_items!.map(item => ({ ...item, type: 'RENT' as const })) };
    const snapshot = createAdjustmentSnapshot(source);
    const request = buildAdjustmentRequest(snapshot, { ...snapshot.values, reason: 'Ghi chú thêm' });
    expect(request.afterItems.map(item => [item.type, item.unit_price, item.quantity, item.coefficient, item.id])).toEqual(source.invoice_items.map(item => [item.type, item.unit_price, item.quantity, item.coefficient, item.id]));
  });
  it('requires a separate trimmed 3..1000 character reason', () => {
    const values = createAdjustmentSnapshot(invoice).values;
    for (const reason of ['', ' ab ', 'x'.repeat(1001)]) expect(issuedInvoiceSchema.safeParse({ ...values, reason }).success).toBe(false);
    expect(issuedInvoiceSchema.safeParse({ ...values, reason: '  abc  ' }).success).toBe(true);
  });
  it('reuses retry keys for normalized payloads and rotates only for changed payloads', () => {
    const snapshot = createAdjustmentSnapshot(invoice);
    const key = createAdjustmentRetryKey();
    const first = buildAdjustmentRequest(snapshot, { ...snapshot.values, reason: 'Sửa giá' });
    expect(key(first)).toBe(key(buildAdjustmentRequest(snapshot, { ...snapshot.values, reason: '  Sửa giá  ' })));
    expect(key({ ...first, notes: 'Mới' })).not.toBe(key(first));
  });
  it.each(['APPROVED', 'PARTIAL_PAID', 'PAID', 'OVERDUE'] as const)('routes %s at paid=0 through adjustments after reversal', status => {
    expect(getInvoiceEditMode({ status, paid_amount: 0 })).toBe('adjustment');
  });
  it('keeps cancellation semantics and denies deleted/cancelled/revised draft documents', () => {
    expect(getInvoiceEditMode({ status: 'DRAFT', paid_amount: 0 })).toBe('draft');
    expect(getInvoiceEditMode({ status: 'DRAFT', adjustment_revision: 1 })).toBe('denied');
    expect(getInvoiceEditMode({ status: 'PAID', deleted_at: 'now' })).toBe('denied');
    expect(getInvoiceEditMode({ status: 'CANCELLED' })).toBe('denied');
    expect(canCancelInvoice({ status: 'APPROVED', paid_amount: 0 })).toBe(true);
    expect(canCancelInvoice({ status: 'PAID', paid_amount: 0 })).toBe(false);
  });
});
