import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { allocateAmountByMonth } from '../accrualAllocation';

const pad2 = (n: number) => String(n).padStart(2, '0');
const monthKey = (idx: number) => `${Math.floor(idx / 12)}-${pad2((idx % 12) + 1)}`;
const dateFromIdx = (idx: number, day: number) =>
  `${monthKey(idx)}-${pad2(day)}`;

// startIdx tuyệt đối (năm 2018–2035), span = số tháng thêm (0..47), 2 ngày trong tháng.
const periodArb = fc
  .record({
    startIdx: fc.integer({ min: 2018 * 12, max: 2035 * 12 + 11 }),
    span: fc.integer({ min: 0, max: 47 }),
    startDay: fc.integer({ min: 1, max: 28 }),
    endDay: fc.integer({ min: 1, max: 28 }),
  })
  .map(({ startIdx, span, startDay, endDay }) => ({
    startIdx,
    endIdx: startIdx + span,
    n: span + 1,
    startDate: dateFromIdx(startIdx, startDay),
    endDate: dateFromIdx(startIdx + span, endDay),
  }));

const amountArb = fc.integer({ min: 0, max: 1_000_000_000_000 });

describe('allocateAmountByMonth', () => {
  it('bảo toàn tổng: Σ phần == amount (amount nguyên)', () => {
    fc.assert(
      fc.property(amountArb, periodArb, (amount, p) => {
        const parts = allocateAmountByMonth(amount, p.startDate, p.endDate);
        const sum = parts.reduce((s, x) => s + x.amount, 0);
        expect(sum).toBe(amount);
      }),
    );
  });

  it('số phần == số tháng trong kỳ (year-month inclusive)', () => {
    fc.assert(
      fc.property(amountArb, periodArb, (amount, p) => {
        const parts = allocateAmountByMonth(amount, p.startDate, p.endDate);
        expect(parts.length).toBe(p.n);
      }),
    );
  });

  it('các tháng tăng dần, liên tục, đúng định dạng YYYY-MM', () => {
    fc.assert(
      fc.property(amountArb, periodArb, (amount, p) => {
        const parts = allocateAmountByMonth(amount, p.startDate, p.endDate);
        parts.forEach((part, i) => {
          expect(part.month).toMatch(/^\d{4}-\d{2}$/);
          expect(part.month).toBe(monthKey(p.startIdx + i));
        });
      }),
    );
  });

  it('bất biến theo ngày-trong-tháng (chỉ năm-tháng quyết định)', () => {
    fc.assert(
      fc.property(amountArb, periodArb, (amount, p) => {
        const a = allocateAmountByMonth(amount, p.startDate, p.endDate);
        const b = allocateAmountByMonth(
          amount,
          `${monthKey(p.startIdx)}-01`,
          `${monthKey(p.endIdx)}-28`,
        );
        expect(a).toEqual(b);
      }),
    );
  });

  it('chia đều: mỗi phần lệch avg ≤ 1 và không âm khi amount ≥ 0', () => {
    fc.assert(
      fc.property(amountArb, periodArb, (amount, p) => {
        const parts = allocateAmountByMonth(amount, p.startDate, p.endDate);
        const avg = amount / p.n;
        parts.forEach((part) => {
          expect(part.amount).toBeGreaterThanOrEqual(0);
          expect(Math.abs(part.amount - avg)).toBeLessThanOrEqual(1);
        });
      }),
    );
  });

  it('n === 1 (start==end cùng tháng) → đúng 1 phần == amount, không làm tròn', () => {
    fc.assert(
      fc.property(
        fc.float({ min: 0, max: 1_000_000_000, noNaN: true }),
        fc.integer({ min: 2018 * 12, max: 2035 * 12 + 11 }),
        (amount, idx) => {
          const parts = allocateAmountByMonth(
            amount,
            `${monthKey(idx)}-05`,
            `${monthKey(idx)}-20`,
          );
          expect(parts).toHaveLength(1);
          expect(parts[0].amount).toBe(amount);
          expect(parts[0].month).toBe(monthKey(idx));
        },
      ),
    );
  });

  it('determinism: gọi 2 lần ra kết quả y hệt', () => {
    fc.assert(
      fc.property(amountArb, periodArb, (amount, p) => {
        expect(allocateAmountByMonth(amount, p.startDate, p.endDate)).toEqual(
          allocateAmountByMonth(amount, p.startDate, p.endDate),
        );
      }),
    );
  });

  it('start/end null/rỗng → [] (caller fallback voucher_date)', () => {
    expect(allocateAmountByMonth(1000, null, null)).toEqual([]);
    expect(allocateAmountByMonth(1000, '2024-01-01', null)).toEqual([]);
    expect(allocateAmountByMonth(1000, null, '2024-01-31')).toEqual([]);
    expect(allocateAmountByMonth(1000, '', '')).toEqual([]);
  });

  it('end < start (data bẩn) → gom hết vào tháng start', () => {
    const parts = allocateAmountByMonth(900_000, '2024-03-01', '2024-01-31');
    expect(parts).toEqual([{ month: '2024-03', amount: 900_000 }]);
  });

  it('ví dụ thực tế: 3.000.000 cho Q1/2024 → 1.000.000/tháng', () => {
    const parts = allocateAmountByMonth(3_000_000, '2024-01-01', '2024-03-31');
    expect(parts).toEqual([
      { month: '2024-01', amount: 1_000_000 },
      { month: '2024-02', amount: 1_000_000 },
      { month: '2024-03', amount: 1_000_000 },
    ]);
  });
});
