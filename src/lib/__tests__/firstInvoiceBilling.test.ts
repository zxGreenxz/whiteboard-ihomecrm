import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  computeFirstBillingMonth,
  validateFirstBillingPeriod,
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
