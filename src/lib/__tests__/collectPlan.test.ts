import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { planCollect, planConflictsWithRemaining, type CollectPlanLine } from '../collectPlan';

const ok = (r: ReturnType<typeof planCollect>) => {
  if (!r.ok) throw new Error('expected ok, got error: ' + r.error);
  return r.plan;
};

describe('planCollect — multi-line', () => {
  it('1 dòng TM đúng số → không thối, không tròn', () => {
    const p = ok(planCollect({ lines: [{ method: 'TM', amount: 4_000_000 }], remaining: 4_000_000 }));
    expect(p).toMatchObject({ amountTm: 4_000_000, amountTk: 0, amountTt: 0, change: 0, keepAsCredit: false, rounding: 0 });
  });

  it('tách TM + TK đúng tổng', () => {
    const p = ok(planCollect({ lines: [{ method: 'TM', amount: 2_000_000 }, { method: 'TK', amount: 2_000_000 }], remaining: 4_000_000 }));
    expect(p).toMatchObject({ amountTm: 2_000_000, amountTk: 2_000_000, change: 0, rounding: 0 });
  });

  it('gộp nhiều dòng cùng phương thức', () => {
    const p = ok(planCollect({ lines: [{ method: 'TM', amount: 1_000_000 }, { method: 'TM', amount: 3_000_000 }], remaining: 4_000_000 }));
    expect(p.amountTm).toBe(4_000_000);
  });

  it('thu dư bằng TM → tiền thối = phần dư', () => {
    const p = ok(planCollect({ lines: [{ method: 'TM', amount: 5_000_000 }], remaining: 4_000_000 }));
    expect(p).toMatchObject({ amountTm: 5_000_000, change: 1_000_000, keepAsCredit: false, rounding: 0 });
  });

  it('thu dư + nợ khách (có hợp đồng) → giữ change, keepAsCredit=true', () => {
    const p = ok(planCollect({ lines: [{ method: 'TM', amount: 5_000_000 }], remaining: 4_000_000, keepAsCredit: true, hasContract: true }));
    expect(p).toMatchObject({ change: 1_000_000, keepAsCredit: true });
  });

  it('nợ khách nhưng KHÔNG có hợp đồng → lỗi', () => {
    const r = planCollect({ lines: [{ method: 'TM', amount: 5_000_000 }], remaining: 4_000_000, keepAsCredit: true, hasContract: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/hợp đồng/);
  });

  it('TK vượt remaining → chặn (chỉ TM mới thu dư)', () => {
    const r = planCollect({ lines: [{ method: 'TK', amount: 5_000_000 }], remaining: 4_000_000 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/TK\/TT vượt/);
  });

  it('TK đúng remaining + TM dư → thối phần TM dư', () => {
    // TK 4tr (=remaining), TM 1tr dư → tổng 5tr, overpay 1tr (qua TM)
    const p = ok(planCollect({ lines: [{ method: 'TK', amount: 4_000_000 }, { method: 'TM', amount: 1_000_000 }], remaining: 4_000_000 }));
    expect(p).toMatchObject({ amountTk: 4_000_000, amountTm: 1_000_000, change: 1_000_000 });
  });

  it('thu thiếu < 10K → làm tròn', () => {
    const p = ok(planCollect({ lines: [{ method: 'TM', amount: 3_995_000 }], remaining: 4_000_000 }));
    expect(p).toMatchObject({ change: 0, rounding: 5_000 });
  });

  it('thu thiếu ≥ 10K → không làm tròn (thu một phần)', () => {
    const p = ok(planCollect({ lines: [{ method: 'TM', amount: 3_000_000 }], remaining: 4_000_000 }));
    expect(p.rounding).toBe(0);
    expect(p.change).toBe(0);
  });

  it('tổng = 0 → lỗi', () => {
    const r = planCollect({ lines: [{ method: 'TM', amount: 0 }], remaining: 4_000_000 });
    expect(r.ok).toBe(false);
  });
});

describe('planCollect — cap (1-chạm)', () => {
  it('cap kéo tổng về remaining khi gõ dư', () => {
    const p = ok(planCollect({ lines: [{ method: 'TM', amount: 9_999_000 }], remaining: 4_000_000, cap: true }));
    expect(p).toMatchObject({ amountTm: 4_000_000, change: 0, rounding: 0 });
  });

  it('cap: thu một phần < 10K vẫn làm tròn', () => {
    const p = ok(planCollect({ lines: [{ method: 'TM', amount: 3_996_000 }], remaining: 4_000_000, cap: true }));
    expect(p.rounding).toBe(4_000);
  });
});

describe('planConflictsWithRemaining — chống race thu song song', () => {
  it('thối: số ròng = remaining mới → OK', () => {
    // total 5tr, thối 1tr → ròng 4tr; remaining mới vẫn 4tr
    expect(planConflictsWithRemaining(5_000_000, 1_000_000, false, 4_000_000)).toBe(false);
  });
  it('thối: người khác vừa thu (remaining tụt) → ròng vượt → CONFLICT', () => {
    // ròng 4tr nhưng remaining mới chỉ còn 3tr
    expect(planConflictsWithRemaining(5_000_000, 1_000_000, false, 3_000_000)).toBe(true);
  });
  it('thu thường thiếu một phần (ròng < remaining) → OK', () => {
    expect(planConflictsWithRemaining(3_000_000, 0, false, 4_000_000)).toBe(false);
  });
  it('1-chạm Thu đủ nhưng remaining đã tụt → CONFLICT', () => {
    expect(planConflictsWithRemaining(4_000_000, 0, false, 3_000_000)).toBe(true);
  });
  it('nợ khách: phần giữ = phần vượt remaining mới → OK', () => {
    // total 5tr, remaining 4tr → vượt 1tr = change
    expect(planConflictsWithRemaining(5_000_000, 1_000_000, true, 4_000_000)).toBe(false);
  });
  it('nợ khách: remaining tụt → vượt thực ≠ change → CONFLICT', () => {
    // remaining mới 3tr → vượt 2tr nhưng change chỉ 1tr → lệch credit
    expect(planConflictsWithRemaining(5_000_000, 1_000_000, true, 3_000_000)).toBe(true);
  });
});

describe('planCollect — invariants (property-based)', () => {
  const lineArb = fc.record({
    method: fc.constantFrom<'TM' | 'TK' | 'TT'>('TM', 'TK', 'TT'),
    amount: fc.integer({ min: 0, max: 20_000_000 }),
  });

  it('ok ⇒ change ≤ amountTm và tiền không âm', () => {
    fc.assert(
      fc.property(
        fc.array(lineArb, { minLength: 1, maxLength: 6 }),
        fc.integer({ min: 1, max: 20_000_000 }),
        fc.boolean(),
        (lines: CollectPlanLine[], remaining, keep) => {
          const r = planCollect({ lines, remaining, keepAsCredit: keep, hasContract: true });
          if (!r.ok) return;
          const p = r.plan;
          expect(p.change).toBeLessThanOrEqual(p.amountTm);
          expect(Math.min(p.amountTm, p.amountTk, p.amountTt, p.change, p.rounding)).toBeGreaterThanOrEqual(0);
          // thu dư và thu thiếu loại trừ nhau
          if (p.change > 0) expect(p.rounding).toBe(0);
        },
      ),
    );
  });
});
