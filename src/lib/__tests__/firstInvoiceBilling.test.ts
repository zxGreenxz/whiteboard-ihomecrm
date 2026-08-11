import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  buildFirstInvoiceDiscount,
  buildFirstInvoiceItems,
  calculateProratedRent,
  computeFirstBillingMonth,
  normalizeFirstBillingPeriod,
  validateFirstBillingPeriod,
  type FirstInvoiceBuilderInput,
} from '../firstInvoiceBuilder';

// Quy tắc: billing_month = THÁNG DƯƠNG LỊCH phủ TRỌN muộn nhất trong [from,to];
// không tháng nào trọn → tháng của `from`.
describe('computeFirstBillingMonth', () => {
  it('4 ví dụ chốt theo yêu cầu chủ nhà', () => {
    expect(computeFirstBillingMonth('2026-05-20', '2026-05-31')).toBe('2026-05'); // hết T5
    expect(computeFirstBillingMonth('2026-05-20', '2026-06-05')).toBe('2026-05'); // T6 mới 5 ngày
    expect(computeFirstBillingMonth('2026-05-28', '2026-06-30')).toBe('2026-06'); // T6 trọn
    expect(computeFirstBillingMonth('2026-05-28', '2026-07-05')).toBe('2026-06'); // T6 trọn, T7 đệm
  });

  it('vào đầu tháng, thu trọn tháng đó → chính tháng đó', () => {
    expect(computeFirstBillingMonth('2026-06-01', '2026-06-30')).toBe('2026-06');
    expect(computeFirstBillingMonth('2026-06-05', '2026-06-30')).toBe('2026-06'); // L03 thực tế
  });

  it('qua năm: 20/12–31/01 → 2026-01 (tháng 1 chưa trọn vì hết 31/01 ok) — kiểm biên', () => {
    // 28/12/2025 → 31/01/2026: tháng 1/2026 phủ trọn (01→31).
    expect(computeFirstBillingMonth('2025-12-28', '2026-01-31')).toBe('2026-01');
    // 20/12 → 05/01: không tháng nào trọn → tháng của from.
    expect(computeFirstBillingMonth('2025-12-20', '2026-01-05')).toBe('2025-12');
  });

  it('thiếu `to` → tháng của `from`; data bẩn (to<from) → tháng của from', () => {
    expect(computeFirstBillingMonth('2026-05-20', undefined)).toBe('2026-05');
    expect(computeFirstBillingMonth('2026-05-20', '')).toBe('2026-05');
    expect(computeFirstBillingMonth('2026-05-20', '2026-05-10')).toBe('2026-05');
  });

  it('property: kết quả luôn nằm trong [tháng(from), tháng(to)] và ≥ tháng(from)', () => {
    const day = fc.integer({ min: 1, max: 28 });
    fc.assert(
      fc.property(
        fc.integer({ min: 2024, max: 2030 }),
        fc.integer({ min: 1, max: 12 }),
        day,
        fc.integer({ min: 0, max: 60 }), // số ngày cộng thêm cho `to`
        (y, m, d, addDays) => {
          const from = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
          const fromMs = Date.UTC(y, m - 1, d);
          const toDate = new Date(fromMs + addDays * 86400000);
          const to = toDate.toISOString().slice(0, 10);
          const res = computeFirstBillingMonth(from, to);
          const fromKey = from.slice(0, 7);
          const toKey = to.slice(0, 7);
          // 'YYYY-MM' so từ điển đúng thứ tự thời gian.
          expect(res >= fromKey).toBe(true);
          expect(res <= toKey).toBe(true);
        },
      ),
    );
  });
});

describe('validateFirstBillingPeriod', () => {
  it('20/5–30/5 → lỗi (tháng 5 chưa đủ tới 31/5)', () => {
    expect(validateFirstBillingPeriod('2026-05-20', '2026-05-30').ok).toBe(false);
  });

  it('các kỳ hợp lệ', () => {
    expect(validateFirstBillingPeriod('2026-05-20', '2026-05-31').ok).toBe(true);
    expect(validateFirstBillingPeriod('2026-05-20', '2026-06-05').ok).toBe(true);
    expect(validateFirstBillingPeriod('2026-05-28', '2026-06-30').ok).toBe(true);
  });

  it('to < from → lỗi', () => {
    expect(validateFirstBillingPeriod('2026-05-20', '2026-05-10').ok).toBe(false);
  });

  it('thiếu from hoặc to → hợp lệ (chưa ràng buộc)', () => {
    expect(validateFirstBillingPeriod(undefined, '2026-05-31').ok).toBe(true);
    expect(validateFirstBillingPeriod('2026-05-20', undefined).ok).toBe(true);
    expect(validateFirstBillingPeriod('2026-05-20', '').ok).toBe(true);
  });

  it('property: hợp lệ ⟺ to ≥ ngày cuối tháng của from', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2024, max: 2030 }),
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 1, max: 28 }),
        fc.integer({ min: 0, max: 75 }),
        (y, m, d, addDays) => {
          const from = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
          const to = new Date(Date.UTC(y, m - 1, d) + addDays * 86400000)
            .toISOString()
            .slice(0, 10);
          const endOfStartMonth = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
          const expected = to >= endOfStartMonth;
          expect(validateFirstBillingPeriod(from, to).ok).toBe(expected);
        },
      ),
    );
  });
});

describe('first invoice amount builder', () => {
  it('prorates each calendar month with that month own day count', () => {
    expect(
      calculateProratedRent(3_100_000, '2026-01-31', '2026-03-01'),
    ).toBe(3_300_000);
  });

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

describe('billing normalization and long periods', () => {
  it('normalizes timestamps and mirrors the RPC fallback for an omitted end', () => {
    expect(
      normalizeFirstBillingPeriod(
        undefined,
        undefined,
        '2026-07-22T09:30:00+07:00',
      ),
    ).toEqual({ start_date: '2026-07-22', end_date: '2026-07-22' });
  });

  it('finds the latest full billing month beyond the former 24 month cap', () => {
    expect(computeFirstBillingMonth('2024-01-15', '2027-02-28')).toBe(
      '2027-02',
    );
  });
});
