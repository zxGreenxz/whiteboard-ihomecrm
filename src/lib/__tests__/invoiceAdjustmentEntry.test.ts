import { describe, expect, it } from 'vitest';
import { buildAdjustmentItems, pricingFromInvoice } from '@/lib/invoiceAdjustmentEntry';
import { decomposeInvoice } from '@/lib/invoiceEntry';
import type { InvoiceWithRelations } from '@/types/invoice';

const U = (n: number) => `dddd0000-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`;

const invoice = {
  id: U(1), billing_month: '2026-09', issue_date: '2026-09-01', due_date: '2026-09-10', notes: 'Cũ',
  discount_amount: 0, previous_debt: 0, electricity_prev_overridden: false,
  invoice_items: [
    { id: U(11), service_id: null, type: 'RENT', accounting_class: 'REVENUE', description: 'Tiền thuê phòng L01 (09/2026)', unit_price: 6_400_000, quantity: 1, coefficient: 1, sort_order: 0, previous_reading: null, current_reading: null, from_date: null, to_date: null },
    { id: U(12), service_id: U(90), type: 'SERVICE', accounting_class: 'REVENUE', description: 'Tiền điện (3467 → 3535)', unit_price: 3500, quantity: 68, coefficient: 1, sort_order: 1, previous_reading: 3467, current_reading: 3535, from_date: '2026-09-01', to_date: '2026-09-30' },
    { id: U(13), service_id: U(91), type: 'SERVICE', accounting_class: 'REVENUE', description: 'Tiền nước (3 người)', unit_price: 300_000, quantity: 1, coefficient: 1, sort_order: 2, previous_reading: null, current_reading: null, from_date: null, to_date: null },
    { id: U(14), service_id: null, type: 'OTHER', accounting_class: 'DEPOSIT', description: 'Cọc', unit_price: 2000, quantity: 2, coefficient: 0.5, sort_order: 4, previous_reading: 0, current_reading: 0, from_date: '2026-09-01', to_date: '2026-09-12' },
    { id: U(15), service_id: null, type: 'PENALTY', accounting_class: 'REVENUE', description: 'Phạt trễ', unit_price: 50_000, quantity: 1, coefficient: 1, sort_order: 3, previous_reading: null, current_reading: null, from_date: null, to_date: null },
  ],
} as unknown as InvoiceWithRelations;

describe('buildAdjustmentItems', () => {
  it('passes every untouched line through verbatim, including coefficient, readings, dates and order', () => {
    const d = decomposeInvoice(invoice);
    const items = buildAdjustmentItems(d.values, d);
    const byId = Object.fromEntries(items.map((i) => [i.id, i]));
    expect(byId[U(11)]).toMatchObject({ description: 'Tiền thuê phòng L01 (09/2026)', unit_price: 6_400_000, sort_order: 0 });
    expect(byId[U(12)]).toMatchObject({ service_id: U(90), unit_price: 3500, quantity: 68, previous_reading: 3467, current_reading: 3535, from_date: '2026-09-01', sort_order: 1 });
    expect(byId[U(13)]).toMatchObject({ service_id: U(91), unit_price: 300_000, quantity: 1, sort_order: 2 });
    expect(byId[U(14)]).toMatchObject({ type: 'OTHER', accounting_class: 'DEPOSIT', quantity: 2, coefficient: 0.5, previous_reading: 0, from_date: '2026-09-01', to_date: '2026-09-12', sort_order: 4 });
    expect(byId[U(15)]).toMatchObject({ type: 'PENALTY', unit_price: 50_000, sort_order: 3 });
    expect(items).toHaveLength(5);
  });

  it('rebuilds only the structured line that changed and keeps its id, service and order', () => {
    const d = decomposeInvoice(invoice);
    const items = buildAdjustmentItems({ ...d.values, current_reading: 3600, electric_amount: 133 * 3500 }, d);
    const electric = items.find((i) => i.id === U(12))!;
    expect(electric).toMatchObject({ service_id: U(90), description: 'Tiền điện (3467 → 3600)', unit_price: 3500, quantity: 133, previous_reading: 3467, current_reading: 3600, sort_order: 1, accounting_class: 'REVENUE' });
    expect(items.find((i) => i.id === U(11))).toMatchObject({ unit_price: 6_400_000 });
    expect(items.find((i) => i.id === U(14))).toMatchObject({ coefficient: 0.5, quantity: 2 });
  });

  it('edits a saved extra in place and appends new extras with null id after the last order', () => {
    const d = decomposeInvoice(invoice);
    const custom = d.values.custom_items.map((c) => (c.id === U(15) ? { ...c, unit_price: 80_000 } : c));
    custom.push({ type: 'OTHER', accounting_class: 'REVENUE', description: 'Gửi xe', quantity: 1, unit_price: 100_000 });
    const items = buildAdjustmentItems({ ...d.values, custom_items: custom }, d);
    expect(items.find((i) => i.id === U(15))).toMatchObject({ type: 'PENALTY', unit_price: 80_000, sort_order: 3 });
    const added = items.find((i) => i.id === null)!;
    expect(added).toMatchObject({ description: 'Gửi xe', unit_price: 100_000, accounting_class: 'REVENUE', coefficient: 1, sort_order: 5 });
    expect(new Set(items.map((i) => i.sort_order)).size).toBe(items.length);
  });

  it('rewrites an edited deposit as one full-amount line instead of scaling by the old coefficient', () => {
    const d = decomposeInvoice(invoice);
    const custom = d.values.custom_items.map((c) => (c.id === U(14) ? { ...c, unit_price: 3_000_000, quantity: 1, coefficient: 1 } : c));
    const items = buildAdjustmentItems({ ...d.values, custom_items: custom }, d);
    expect(items.find((i) => i.id === U(14))).toMatchObject({ accounting_class: 'DEPOSIT', unit_price: 3_000_000, quantity: 1, coefficient: 1, from_date: '2026-09-01', sort_order: 4 });
  });

  it('drops a structured line the user zeroed and removed extras', () => {
    const d = decomposeInvoice(invoice);
    const items = buildAdjustmentItems({ ...d.values, water_amount: 0, custom_items: d.values.custom_items.filter((c) => c.id !== U(15)) }, d);
    expect(items.map((i) => i.id)).toEqual([U(11), U(12), U(14)]);
  });
});

describe('pricingFromInvoice', () => {
  it('derives unit prices from the invoice itself', () => {
    const p = pricingFromInvoice(decomposeInvoice(invoice));
    expect(p).toMatchObject({ elec: 3500, water: 100_000, pdv: 150_000, sourceLabel: 'Đơn giá theo hoá đơn' });
  });
});
