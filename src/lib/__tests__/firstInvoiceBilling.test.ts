import { describe, it, expect } from 'vitest';
import { buildFirstInvoiceDiscount, buildFirstInvoiceItems, type FirstInvoiceBuilderInput } from '../firstInvoiceBuilder';

describe('first invoice amount builder', () => {
  it('marks revenue and deposit items explicitly and dates fixed services', () => {
    const items = buildFirstInvoiceItems({
      rent_price: 3_100_000,
      total_deposit: 4_000_000,
      deposit_paid: 1_000_000,
      include_deposit: true,
      start_billing_date: '2026-01-31',
      end_billing_date: '2026-03-01',
      services: [
        {
          service_id: 'service-1',
          name: 'Internet',
          unit_price: 310_000,
          pricing_type: 'DON_GIA_CO_DINH',
        },
      ],
    });

    expect(items.find((item) => item.type === 'RENT')).toEqual(
      expect.objectContaining({
        accounting_class: 'REVENUE',
        unit_price: 3_300_000,
      }),
    );
    expect(items.find((item) => item.type === 'SERVICE')).toEqual(
      expect.objectContaining({
        accounting_class: 'REVENUE',
        unit_price: 330_000,
        from_date: '2026-01-31',
        to_date: '2026-03-01',
      }),
    );
    expect(items.find((item) => item.accounting_class === 'DEPOSIT')).toEqual(
      expect.objectContaining({
        type: 'OTHER',
        unit_price: 3_000_000,
        quantity: 1,
      }),
    );
  });

  it('caps discount at revenue and never consumes the deposit amount', () => {
    const input: FirstInvoiceBuilderInput = {
      rent_price: 1_000_000,
      total_deposit: 4_000_000,
      deposit_paid: 0,
      include_deposit: true,
      start_billing_date: '2026-07-01',
      end_billing_date: '2026-07-31',
      discount_months: 1,
      discount_amount_per_month: 5_000_000,
      services: [],
    };
    const items = buildFirstInvoiceItems(input);
    expect(buildFirstInvoiceDiscount(input, items).amount).toBe(1_000_000);
  });
});

// A v2 month is selected by billing_month, never by the count of invoices.
describe('first invoice v2 rent support', () => {
  const schedule = {
    version: 2 as const, start_billing_month: '2026-09',
    segments: [{ month_count: 3, monthly_amount: '300000' }, { month_count: 9, monthly_amount: '100000' }],
  };
  const input = (start: string, end: string, rent = 3_000_000) => ({
    rent_price: rent, total_deposit: 4_000_000, deposit_paid: 0,
    start_billing_date: start, end_billing_date: end, services: [], rent_support: schedule,
  });
  it.each([
    ['2026-11-01', '2026-11-30', 300_000],
    ['2026-10-01', '2026-10-31', 300_000],
    ['2026-12-01', '2026-12-31', 100_000],
    ['2026-09-20', '2026-10-05', 300_000],
    ['2026-09-28', '2026-10-31', 300_000],
  ])('selects full support for canonical period %s–%s', (start, end, amount) => {
    const value = input(start, end);
    expect(buildFirstInvoiceDiscount(value, buildFirstInvoiceItems(value)).amount).toBe(amount);
  });
  it('keeps the commitment and requires review when revenue is 200000', () => {
    const value = input('2026-09-01', '2026-09-30', 200_000);
    expect(buildFirstInvoiceDiscount(value, buildFirstInvoiceItems(value))).toMatchObject({
      amount: 0, agreed_amount: '300000', state: 'NEEDS_REVIEW', issue: 'REVENUE_CAP_REVIEW',
    });
  });
});
