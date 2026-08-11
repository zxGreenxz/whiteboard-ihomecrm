import { describe, expect, it } from 'vitest';

/**
 * Chốt chặn chống TRÔI cho `src/types/scripts-mjs.d.ts`.
 *
 * File khai báo đó viết tay, nên nó có thể nói một export tồn tại trong khi
 * `.mjs` đã đổi tên — và trình biên dịch sẽ im lặng, vì nó tin lời khai báo chứ
 * không đọc `.mjs`. Đúng lớp lỗi "bản chép trôi khỏi bản gốc".
 *
 * Test này nạp THẬT ba module rồi đối chiếu từng tên. Trôi một cái là đỏ ngay,
 * kèm tên cái bị trôi.
 */
const KHAI_BAO: Record<string, string[]> = {
  '../../../scripts/check-route-guards.mjs': ['collectRoutes', 'collectAllRoutes'],
  '../../../scripts/check-risk-classifier.mjs': ['globSangRegex', 'khopGlob', 'xepTier'],
  '../../../scripts/audit-finance-v2-rollout.mjs': ['parseAuditResponse', 'evaluateFinanceV2Audit'],
};

describe('khai báo kiểu cho script .mjs', () => {
  it('mọi export đã khai đều CÓ THẬT trong module', async () => {
    const thieu: string[] = [];
    for (const [duong, ten] of Object.entries(KHAI_BAO)) {
      const mod = (await import(/* @vite-ignore */ duong)) as Record<string, unknown>;
      for (const t of ten) {
        if (typeof mod[t] !== 'function') thieu.push(`${duong}#${t}`);
      }
    }
    expect(thieu).toEqual([]);
  });

  it('chống-xanh-rỗng: bộ đối chiếu thật sự có thứ để kiểm', () => {
    const tong = Object.values(KHAI_BAO).reduce((s, a) => s + a.length, 0);
    expect(Object.keys(KHAI_BAO).length).toBe(3);
    expect(tong).toBeGreaterThanOrEqual(7);
  });
});
