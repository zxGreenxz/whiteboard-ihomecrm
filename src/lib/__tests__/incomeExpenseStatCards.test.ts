import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  buildIncomeExpenseStatCards,
  type LayerTotals,
} from '../incomeExpenseStatCards';

/**
 * 3 thẻ thống kê trang Thu chi hiện thêm TRONG NGOẶC tổng đã gồm phiếu chờ xử lý
 * (chờ duyệt hoặc chưa chọn sổ quỹ). Toán tách khỏi UI để kiểm được bằng test.
 *
 * Tiền ở đây luôn KHÔNG ÂM: `income_expenses.total_amount` có CHECK
 * `total_amount >= 0` (20250120000001_create_income_expenses_table.sql:41) và
 * cash_* / pending_* đều là SUM của cột đó.
 */
const amount = () =>
  fc.double({ min: 0, max: 1e9, noNaN: true, noDefaultInfinity: true });

const totalsArb: fc.Arbitrary<LayerTotals> = fc.record({
  totalIncome: amount(),
  totalExpense: amount(),
  pendingIncome: amount(),
  pendingExpense: amount(),
});

describe('buildIncomeExpenseStatCards', () => {
  it('số trong ngoặc TỰ KIỂM CHỨNG: ngoặc Thu − ngoặc Chi = ngoặc Thu-chi', () => {
    fc.assert(
      fc.property(totalsArb, (t) => {
        const c = buildIncomeExpenseStatCards(t);
        expect(c.difference.withPending).toBeCloseTo(
          c.income.withPending - c.expense.withPending,
          5,
        );
      }),
      { numRuns: 200 },
    );
  });

  it('số lớn giữ nguyên nghĩa cũ: Thu − Chi = Thu-chi', () => {
    fc.assert(
      fc.property(totalsArb, (t) => {
        const c = buildIncomeExpenseStatCards(t);
        expect(c.income.value).toBeCloseTo(t.totalIncome, 5);
        expect(c.expense.value).toBeCloseTo(t.totalExpense, 5);
        expect(c.difference.value).toBeCloseTo(t.totalIncome - t.totalExpense, 5);
      }),
      { numRuns: 200 },
    );
  });

  it('không còn phiếu chờ ⇒ cả 3 thẻ hiện dấu ✓ và ngoặc bằng số lớn', () => {
    fc.assert(
      fc.property(amount(), amount(), (totalIncome, totalExpense) => {
        const c = buildIncomeExpenseStatCards({
          totalIncome,
          totalExpense,
          pendingIncome: 0,
          pendingExpense: 0,
        });
        for (const card of [c.income, c.expense, c.difference]) {
          expect(card.hasPending).toBe(false);
          expect(card.withPending).toBeCloseTo(card.value, 5);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('thẻ Thu-chi chỉ ✓ khi CẢ HAI vế hết phiếu chờ', () => {
    fc.assert(
      fc.property(totalsArb, (t) => {
        const c = buildIncomeExpenseStatCards(t);
        expect(c.income.hasPending).toBe(t.pendingIncome > 0);
        expect(c.expense.hasPending).toBe(t.pendingExpense > 0);
        expect(c.difference.hasPending).toBe(
          c.income.hasPending || c.expense.hasPending,
        );
      }),
      { numRuns: 200 },
    );
  });

  it('tiền không âm ⇒ ngoặc Thu/Chi không bao giờ nhỏ hơn số lớn', () => {
    fc.assert(
      fc.property(totalsArb, (t) => {
        const c = buildIncomeExpenseStatCards(t);
        expect(c.income.withPending).toBeGreaterThanOrEqual(c.income.value);
        expect(c.expense.withPending).toBeGreaterThanOrEqual(c.expense.value);
      }),
      { numRuns: 200 },
    );
  });

  it('phần chênh giữa ngoặc và số lớn của Thu + Chi = tổng dòng "Chờ xử lý"', () => {
    fc.assert(
      fc.property(totalsArb, (t) => {
        const c = buildIncomeExpenseStatCards(t);
        const pendingTotal = t.pendingIncome + t.pendingExpense;
        expect(
          c.income.withPending -
            c.income.value +
            (c.expense.withPending - c.expense.value),
        ).toBeCloseTo(pendingTotal, 5);
      }),
      { numRuns: 200 },
    );
  });

  it('ca cụ thể theo ảnh chụp màn hình của chủ', () => {
    const c = buildIncomeExpenseStatCards({
      totalIncome: 742_437_000,
      totalExpense: 117_055_000,
      pendingIncome: 0,
      pendingExpense: 383_984_934,
    });
    expect(c.income.value).toBe(742_437_000);
    expect(c.income.hasPending).toBe(false);
    expect(c.expense.value).toBe(117_055_000);
    expect(c.expense.withPending).toBe(501_039_934);
    expect(c.difference.value).toBe(625_382_000);
    expect(c.difference.withPending).toBe(241_397_066);
    expect(c.difference.hasPending).toBe(true);
  });

  it('✓ nói về TIỀN, không phải SỐ PHIẾU — phiếu chờ 0đ vẫn ra ✓', () => {
    // `total_amount` được phép bằng 0 (CHECK chỉ chặn số âm), nên có thể tồn tại
    // phiếu chờ xử lý trị giá 0đ: dòng "Chờ xử lý" đếm nó, còn thẻ vẫn ✓. Đó là
    // CHỦ Ý — ✓ ở đây nghĩa "duyệt hết cũng không đổi số này", và với phiếu 0đ
    // thì đúng thế. Lời chú trên UI phải nói theo nghĩa đó, không được nói
    // "không còn phiếu chờ xử lý".
    const c = buildIncomeExpenseStatCards({
      totalIncome: 1_000_000,
      totalExpense: 400_000,
      pendingIncome: 0,
      pendingExpense: 0,
    });
    expect(c.income.hasPending).toBe(false);
    expect(c.expense.hasPending).toBe(false);
    expect(c.difference.hasPending).toBe(false);
    expect(c.difference.withPending).toBe(c.difference.value);
  });

  it('giá trị thiếu/không hợp lệ coi như 0, không đẻ ra NaN', () => {
    const c = buildIncomeExpenseStatCards({
      totalIncome: 1000,
      totalExpense: Number.NaN,
      pendingIncome: undefined as unknown as number,
      pendingExpense: 500,
    });
    expect(c.expense.value).toBe(0);
    expect(c.expense.withPending).toBe(500);
    expect(c.income.withPending).toBe(1000);
    expect(c.difference.withPending).toBe(500);
  });
});
