import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { addCycle } from '../recurring';

describe('addCycle', () => {
  it('MONTH: neo đúng ngày khi tháng đích đủ ngày', () => {
    expect(addCycle('2026-01-15', 'MONTH', 1)).toBe('2026-02-15');
    expect(addCycle('2026-01-15', 'MONTH', 2)).toBe('2026-03-15');
    expect(addCycle('2026-01-15', 'MONTH', 3)).toBe('2026-04-15');
  });

  it('MONTH: clamp cuối tháng NHƯNG không drift vĩnh viễn (31/01)', () => {
    expect(addCycle('2026-01-31', 'MONTH', 1)).toBe('2026-02-28'); // Feb ngắn → clamp
    expect(addCycle('2026-01-31', 'MONTH', 2)).toBe('2026-03-31'); // Mar đủ → về lại 31
    expect(addCycle('2026-01-31', 'MONTH', 3)).toBe('2026-04-30');
    expect(addCycle('2026-01-31', 'MONTH', 4)).toBe('2026-05-31');
  });

  it('WEEK: cộng 7*k ngày', () => {
    expect(addCycle('2026-06-02', 'WEEK', 1)).toBe('2026-06-09');
    expect(addCycle('2026-06-02', 'WEEK', 4)).toBe('2026-06-30');
  });

  it('QUARTER: bước 3 tháng, neo ngày', () => {
    expect(addCycle('2026-01-31', 'QUARTER', 1)).toBe('2026-04-30');
    expect(addCycle('2026-01-31', 'QUARTER', 2)).toBe('2026-07-31');
  });

  it('YEAR: 29/02 năm nhuận → 28/02 năm thường', () => {
    expect(addCycle('2024-02-29', 'YEAR', 1)).toBe('2025-02-28');
    expect(addCycle('2024-02-29', 'YEAR', 4)).toBe('2028-02-29'); // lại nhuận
  });

  it('NONE: giữ nguyên', () => {
    expect(addCycle('2026-06-02', 'NONE', 1)).toBe('2026-06-02');
  });

  it('property: MONTH luôn ra ngày = min(ngày gốc, số ngày tháng đích), strictly tăng theo k', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2020, max: 2035 }),
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 1, max: 28 }),
        fc.integer({ min: 1, max: 36 }),
        (y, m, d, k) => {
          const anchor = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
          const r1 = addCycle(anchor, 'MONTH', k);
          // ngày gốc <= 28 nên không bao giờ bị clamp → giữ nguyên ngày
          expect(r1.slice(8, 10)).toBe(String(d).padStart(2, '0'));
          // tăng đơn điệu theo k
          const r2 = addCycle(anchor, 'MONTH', k + 1);
          expect(r2 > r1).toBe(true);
        }
      )
    );
  });
});
