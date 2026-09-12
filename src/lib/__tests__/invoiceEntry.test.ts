import { describe, expect, it } from 'vitest';
import {
  buildInvoiceItems,
  computeEntryTotals,
  decomposeInvoice,
  diffEntryValues,
  findDepositIndex,
  isDepositItem,
  makeEntryValues,
  type InvoiceEntryValues,
} from '@/lib/invoiceEntry';
import type { InvoiceWithRelations } from '@/types/invoice';

const SERVICE_IDS = { elecServiceId: 'svc-elec', waterServiceId: 'svc-water', pdvServiceId: 'svc-pdv' };

function values(overrides: Partial<InvoiceEntryValues> = {}): InvoiceEntryValues {
  return makeEntryValues({
    billing_month: '2026-09',
    issue_date: '2026-09-01',
    due_date: '2026-09-10',
    rent_price: 3_000_000,
    occupants: 2,
    prev_reading: 100,
    current_reading: 150,
    electric_amount: 175_000,
    water_amount: 200_000,
    pdv_amount: 150_000,
    ...overrides,
  });
}

describe('deposit detection', () => {
  it('treats only OTHER + DEPOSIT as the canonical deposit line', () => {
    expect(isDepositItem({ type: 'OTHER', accounting_class: 'DEPOSIT', description: 'Tiền cọc', quantity: 1, unit_price: 1 })).toBe(true);
    expect(isDepositItem({ type: 'SERVICE', accounting_class: 'DEPOSIT', description: 'Nước bảo đảm', quantity: 1, unit_price: 1 })).toBe(false);
    expect(isDepositItem({ type: 'OTHER', accounting_class: 'REVENUE', description: 'Phí xử lý cọc', quantity: 1, unit_price: 1 })).toBe(false);
  });

  it('finds the first canonical deposit only', () => {
    const items = [
      { type: 'OTHER' as const, accounting_class: 'REVENUE' as const, description: 'Gửi xe', quantity: 1, unit_price: 100_000 },
      { type: 'OTHER' as const, accounting_class: 'DEPOSIT' as const, description: 'Tiền cọc', quantity: 1, unit_price: 2_000_000 },
      { type: 'OTHER' as const, accounting_class: 'DEPOSIT' as const, description: 'Cọc 2', quantity: 1, unit_price: 1 },
    ];
    expect(findDepositIndex(items)).toBe(1);
    expect(findDepositIndex([])).toBe(-1);
  });
});

describe('computeEntryTotals', () => {
  it('sums structured lines, extras and deposit, then rounds like the save path', () => {
    const t = computeEntryTotals(values({
      custom_items: [
        { type: 'OTHER', accounting_class: 'REVENUE', description: 'Gửi xe', quantity: 2, unit_price: 50_000 },
        { type: 'OTHER', accounting_class: 'DEPOSIT', description: 'Tiền cọc', quantity: 1, unit_price: 2_000_000 },
      ],
      discount_amount: 25_000,
      previous_debt: 1_234_567,
    }));
    expect(t.isProrated).toBe(false);
    expect(t.rent).toBe(3_000_000);
    expect(t.extras).toBe(100_000);
    expect(t.deposit).toBe(2_000_000);
    expect(t.subtotal).toBe(3_000_000 + 175_000 + 200_000 + 150_000 + 100_000 + 2_000_000);
    // 5.625.000 − 25.000 + 1.234.567 = 6.834.567 → phần lẻ 567 < 900 → tròn xuống.
    expect(t.total).toBe(6_834_000);
  });

  it('prorates rent, water and PDV by actual days but never electricity', () => {
    const t = computeEntryTotals(values({ period_start_date: '2026-09-01', period_end_date: '2026-09-15' }));
    expect(t.days).toBe(15);
    expect(t.isProrated).toBe(true);
    expect(t.rent).toBe(1_500_000);
    expect(t.water).toBe(100_000);
    expect(t.pdv).toBe(75_000);
    expect(t.electric).toBe(175_000);
  });

  it('never returns a negative total', () => {
    expect(computeEntryTotals(values({ discount_amount: 99_000_000 })).total).toBe(0);
  });
});

describe('buildInvoiceItems', () => {
  it('emits rent, electricity with readings, water per occupant, PDV and extras in order', () => {
    const items = buildInvoiceItems(values({
      custom_items: [
        { type: 'SERVICE', accounting_class: 'REVENUE', description: 'Gửi xe', quantity: 1, unit_price: 100_000, service_id: 'svc-park' },
        { type: 'OTHER', accounting_class: 'DEPOSIT', description: 'Tiền cọc', quantity: 1, unit_price: 2_000_000 },
      ],
    }), { ...SERVICE_IDS, rentDescription: 'Tiền thuê căn hộ 305' });

    expect(items.map((i) => i.description)).toEqual([
      'Tiền thuê căn hộ 305', 'Tiền điện (100 → 150)', 'Tiền nước (2 người)', 'Phí dịch vụ', 'Gửi xe', 'Tiền cọc',
    ]);
    expect(items.map((i) => i.sort_order)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(items[0]).toMatchObject({ type: 'RENT', accounting_class: 'REVENUE', unit_price: 3_000_000, quantity: 1, from_date: undefined, to_date: undefined });
    expect(items[1]).toMatchObject({
      type: 'SERVICE', service_id: 'svc-elec', unit_price: 3_500, quantity: 50,
      previous_reading: 100, current_reading: 150, from_date: '2026-09-01', to_date: '2026-09-30',
    });
    expect(items[2]).toMatchObject({ service_id: 'svc-water', unit_price: 100_000, quantity: 2 });
    expect(items[3]).toMatchObject({ service_id: 'svc-pdv', unit_price: 150_000, quantity: 1 });
    expect(items[4]).toMatchObject({ type: 'SERVICE', accounting_class: 'REVENUE', service_id: 'svc-park' });
    expect(items[5]).toMatchObject({ type: 'OTHER', accounting_class: 'DEPOSIT', unit_price: 2_000_000 });
  });

  it('keeps water as one line when the amount does not divide by occupants', () => {
    const [, , water] = buildInvoiceItems(values({ occupants: 3, water_amount: 100_000 }), SERVICE_IDS);
    expect(water).toMatchObject({ description: 'Tiền nước (3 người)', unit_price: 100_000, quantity: 1 });
  });

  it('skips zero electricity and zero water lines', () => {
    const items = buildInvoiceItems(values({ electric_amount: 0, water_amount: 0 }), SERVICE_IDS);
    expect(items.map((i) => i.description)).toEqual(['Tiền thuê', 'Phí dịch vụ']);
  });

  it('prorates by days and stamps the actual period on rent, water and PDV only', () => {
    const items = buildInvoiceItems(values({ period_start_date: '2026-09-16', period_end_date: '2026-09-30' }), SERVICE_IDS);
    expect(items[0]).toMatchObject({ description: 'Tiền thuê (15/30 ngày)', unit_price: 1_500_000, from_date: '2026-09-16', to_date: '2026-09-30' });
    expect(items[1]).toMatchObject({ description: 'Tiền điện (100 → 150)', from_date: '2026-09-01', to_date: '2026-09-30' });
    expect(items[2]).toMatchObject({ description: 'Tiền nước (2 người) (15/30 ngày)', unit_price: 50_000, quantity: 2, from_date: '2026-09-16' });
    expect(items[3]).toMatchObject({ description: 'Phí dịch vụ (15/30 ngày)', unit_price: 75_000, from_date: '2026-09-16' });
  });

  it('reuses the saved prorated amounts when neither price nor period changed', () => {
    const baseline = { rent_price: 3_000_000, water_amount: 200_000, pdv_amount: 150_000, days: 13, rentAmount: 1_299_999, waterAmount: 86_667, pdvAmount: 65_000 };
    const v = values({ period_start_date: '2026-09-01', period_end_date: '2026-09-13' });
    const untouched = buildInvoiceItems(v, { ...SERVICE_IDS, baseline, rentDescription: 'Tiền thuê (13/30 ngày)' });
    expect(untouched[0]).toMatchObject({ unit_price: 1_299_999, description: 'Tiền thuê (13/30 ngày)' });
    expect(untouched[2]).toMatchObject({ unit_price: 86_667, quantity: 1 });
    expect(untouched[3]).toMatchObject({ unit_price: 65_000 });

    const priceChanged = buildInvoiceItems({ ...v, rent_price: 3_300_000 }, { ...SERVICE_IDS, baseline, rentDescription: 'Tiền thuê (13/30 ngày)' });
    expect(priceChanged[0]).toMatchObject({ unit_price: 1_430_000, description: 'Tiền thuê (13/30 ngày)' });
    expect(priceChanged[2]).toMatchObject({ unit_price: 86_667 });

    const periodChanged = buildInvoiceItems({ ...v, period_end_date: '2026-09-15' }, { ...SERVICE_IDS, baseline, rentDescription: 'Tiền thuê (13/30 ngày)' });
    expect(periodChanged[0]).toMatchObject({ unit_price: 1_500_000, description: 'Tiền thuê (15/30 ngày)' });
  });
});

describe('decomposeInvoice', () => {
  const invoice = {
    id: 'inv', billing_month: '2026-09', issue_date: '2026-09-01', due_date: '2026-09-10', notes: 'Ghi chú',
    discount_amount: 10_000, discount_notes: 'KM', previous_debt: 5_000, electricity_prev_overridden: true,
    invoice_items: [
      { id: 'r', type: 'RENT', accounting_class: 'REVENUE', description: 'Tiền thuê căn hộ 305 (13/30 ngày)', unit_price: 1_300_000, quantity: 1, from_date: '2026-09-01', to_date: '2026-09-13' },
      { id: 'e', type: 'SERVICE', accounting_class: 'REVENUE', description: 'Tiền điện (100 → 150)', unit_price: 3_500, quantity: 50, previous_reading: 100, current_reading: 150 },
      { id: 'w', type: 'SERVICE', accounting_class: 'REVENUE', description: 'Tiền nước (3 người) (13/30 ngày)', unit_price: 130_000, quantity: 1, from_date: '2026-09-01', to_date: '2026-09-13' },
      { id: 'p', type: 'SERVICE', accounting_class: 'REVENUE', description: 'Phí dịch vụ (13/30 ngày)', unit_price: 65_000, quantity: 1, from_date: '2026-09-01', to_date: '2026-09-13' },
      { id: 'd', type: 'OTHER', accounting_class: 'DEPOSIT', description: 'Tiền cọc', unit_price: 2_200_000, quantity: 1 },
      { id: 'x', type: 'OTHER', accounting_class: 'REVENUE', description: 'Phí xử lý cọc', unit_price: 50_000, quantity: 1 },
    ],
  } as unknown as InvoiceWithRelations;

  it('recovers full monthly prices, the actual period and the saved amounts', () => {
    const { values: v, baseline, rentDescription } = decomposeInvoice(invoice);
    expect(v).toMatchObject({
      billing_month: '2026-09', rent_price: 3_000_000, occupants: 3, prev_reading: 100, current_reading: 150,
      prev_reading_overridden: true, electric_amount: 175_000, water_amount: 300_000, pdv_amount: 150_000,
      period_start_date: '2026-09-01', period_end_date: '2026-09-13', discount_amount: 10_000, previous_debt: 5_000,
    });
    expect(v.custom_items).toEqual([
      { type: 'OTHER', accounting_class: 'DEPOSIT', description: 'Tiền cọc', quantity: 1, unit_price: 2_200_000, service_id: undefined },
      { type: 'OTHER', accounting_class: 'REVENUE', description: 'Phí xử lý cọc', quantity: 1, unit_price: 50_000, service_id: undefined },
    ]);
    expect(baseline).toEqual({ rent_price: 3_000_000, water_amount: 300_000, pdv_amount: 150_000, days: 13, rentAmount: 1_300_000, waterAmount: 130_000, pdvAmount: 65_000 });
    expect(rentDescription).toBe('Tiền thuê căn hộ 305 (13/30 ngày)');
  });

  it('round-trips an untouched prorated invoice without changing any amount', () => {
    const { values: v, baseline, rentDescription } = decomposeInvoice(invoice);
    const items = buildInvoiceItems(v, { ...SERVICE_IDS, baseline, rentDescription });
    expect(items.map((i) => [i.description, i.unit_price * i.quantity])).toEqual([
      ['Tiền thuê căn hộ 305 (13/30 ngày)', 1_300_000],
      ['Tiền điện (100 → 150)', 175_000],
      ['Tiền nước (3 người) (13/30 ngày)', 130_000],
      ['Phí dịch vụ (13/30 ngày)', 65_000],
      ['Tiền cọc', 2_200_000],
      ['Phí xử lý cọc', 50_000],
    ]);
  });

  it('reads occupants from the water quantity when it is more than one', () => {
    const plain = { ...invoice, invoice_items: [
      { id: 'r', type: 'RENT', accounting_class: 'REVENUE', description: 'Tiền thuê', unit_price: 5_000_000, quantity: 1 },
      { id: 'w', type: 'SERVICE', accounting_class: 'REVENUE', description: 'Tiền nước (2 người)', unit_price: 100_000, quantity: 2 },
    ] } as unknown as InvoiceWithRelations;
    const { values: v, baseline } = decomposeInvoice(plain);
    expect(v).toMatchObject({ rent_price: 5_000_000, occupants: 2, water_amount: 200_000, pdv_amount: 0, electric_amount: 0, current_reading: null, period_start_date: null });
    expect(baseline.days).toBe(0);
  });
});

describe('diffEntryValues', () => {
  it('counts structured cells one by one, extras and the rest as one change each', () => {
    const base = values();
    expect(diffEntryValues(base, base)).toEqual({ fields: new Set(), extrasChanged: false, otherChanged: false, count: 0 });

    const d = diffEntryValues(values({
      rent_price: 3_100_000, current_reading: 160,
      custom_items: [{ type: 'OTHER', accounting_class: 'REVENUE', description: 'x', quantity: 1, unit_price: 1 }],
      discount_amount: 5, due_date: '2026-09-11',
    }), base);
    expect([...d.fields].sort()).toEqual(['current_reading', 'rent_price']);
    expect(d.extrasChanged).toBe(true);
    expect(d.otherChanged).toBe(true);
    expect(d.count).toBe(4);
  });

  it('ignores notes and helper flags', () => {
    const base = values();
    expect(diffEntryValues(values({ notes: 'khác', electric_overridden: true, water_overridden: true }), base).count).toBe(0);
  });
});
