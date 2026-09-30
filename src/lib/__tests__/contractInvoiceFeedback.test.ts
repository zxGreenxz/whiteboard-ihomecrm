import { describe, expect, it } from 'vitest';
import { validateFirstInvoiceRows } from '../contractInvoiceFeedback';
import type { FirstInvoiceItem } from '../firstInvoiceBuilder';

const row: FirstInvoiceItem = { id: 'rent-1', type: 'RENT', accounting_class: 'REVENUE',
  description: 'Tiền thuê', unit_price: 4_000_000, quantity: 1,
  from_date: '2026-09-01', to_date: '2026-09-30' };
const billing = { start_date: '2026-09-01', end_date: '2026-09-30' };

describe('first invoice local row validation', () => {
  it('identifies the exact row and editable amount/quantity', () => {
    expect(validateFirstInvoiceRows([{ ...row, unit_price: -1, quantity: 0 }], billing)).toEqual({
      'invoice_items.rent-1.unit_price': 'Đơn giá phải là số không âm hợp lệ.',
      'invoice_items.rent-1.quantity': 'Số lượng phải lớn hơn 0.',
    });
  });
  it('identifies incomplete or out of range row dates without leaking internal type', () => {
    expect(validateFirstInvoiceRows([{ ...row, to_date: null }], billing)).toHaveProperty('invoice_items.rent-1.period');
    expect(validateFirstInvoiceRows([{ ...row, from_date: '2026-08-31' }], billing)).toHaveProperty('invoice_items.rent-1.period');
  });
  it('accepts a row exactly on the first billing bounds', () => {
    expect(validateFirstInvoiceRows([row], billing)).toEqual({});
  });
});
