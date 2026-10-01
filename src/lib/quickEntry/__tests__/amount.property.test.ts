import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { findMoneyCandidates, MAX_AMOUNT_VND, normalizeForParse, pickAmount } from "../amount";

// Bộ đọc số thành chữ VIẾT RIÊNG cho test (không dùng code đang test) — cách đọc chuẩn
// tiếng Việt: "không trăm" ở nhóm giữa, "linh" khi hàng chục bằng 0, mốt/tư/lăm sau "mươi".
const DIG = ["không", "một", "hai", "ba", "bốn", "năm", "sáu", "bảy", "tám", "chín"];

function readGroup(n: number, full: boolean): string[] {
  const h = Math.floor(n / 100);
  const t = Math.floor((n % 100) / 10);
  const u = n % 10;
  const w: string[] = [];
  if (h > 0 || full) w.push(DIG[h], "trăm");
  if (t === 0) {
    if (u > 0) {
      if (h > 0 || full) w.push("linh");
      w.push(DIG[u]);
    }
  } else if (t === 1) {
    w.push("mười");
    if (u === 5) w.push("lăm");
    else if (u > 0) w.push(DIG[u]);
  } else {
    w.push(DIG[t], "mươi");
    if (u === 1) w.push("mốt");
    else if (u === 4) w.push("tư");
    else if (u === 5) w.push("lăm");
    else if (u > 0) w.push(DIG[u]);
  }
  return w;
}

/** n là bội của 1000, từ 1.000 tới 999.999.000. */
function readVnd(n: number): string {
  const millions = Math.floor(n / 1e6);
  const thousands = Math.floor((n % 1e6) / 1e3);
  const parts: string[] = [];
  if (millions > 0) parts.push(...readGroup(millions, false), "triệu");
  if (thousands > 0) parts.push(...readGroup(thousands, millions > 0), "nghìn");
  return parts.join(" ");
}

/** "1234567" → "1.234.567" — viết tay, không dùng Intl để khỏi phụ thuộc ICU của máy. */
function groupDots(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

const thousandsMultiple = fc.integer({ min: 1, max: 999_999 }).map((k) => k * 1000);

describe("amount — property", () => {
  it("bộ đọc chữ trong test đúng với vài mốc tính tay", () => {
    expect(readVnd(120_000)).toBe("một trăm hai mươi nghìn");
    expect(readVnd(1_050_000)).toBe("một triệu không trăm năm mươi nghìn");
    expect(readVnd(21_000)).toBe("hai mươi mốt nghìn");
    expect(readVnd(2_000_000)).toBe("hai triệu");
  });

  it("khứ hồi số → chữ tiếng Việt → số", () => {
    fc.assert(
      fc.property(thousandsMultiple, (n) => {
        expect(pickAmount(readVnd(n))?.value).toBe(n);
      }),
      { numRuns: 3000 },
    );
  });

  it("khứ hồi chữ HOA cho cùng kết quả", () => {
    fc.assert(
      fc.property(thousandsMultiple, (n) => {
        expect(pickAmount(readVnd(n).toUpperCase())?.value).toBe(n);
      }),
      { numRuns: 500 },
    );
  });

  it("khứ hồi `${k}k` → k nghìn", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 999_999 }), (k) => {
        expect(pickAmount(`${k}k`)?.value).toBe(k * 1000);
      }),
    );
  });

  it("khứ hồi phân nhóm có đuôi đ: 1.234.567đ", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1_000, max: 999_999_999 }), (n) => {
        expect(pickAmount(`${groupDots(n)}đ`)?.value).toBe(n);
      }),
    );
  });

  it("khứ hồi `${a}tr${bbb}` → a triệu + bbb nghìn", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 99 }), fc.integer({ min: 0, max: 999 }), (a, b) => {
        const text = `${a}tr${String(b).padStart(3, "0")}`;
        expect(pickAmount(text)?.value).toBe(a * 1_000_000 + b * 1000);
      }),
    );
  });

  it("hai khoản có đơn vị trong một câu được tìm đủ, đúng thứ tự", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 9_999 }), fc.integer({ min: 1, max: 9_999 }), (a, b) => {
        const values = findMoneyCandidates(`bóng đèn ${a}k, ống nước ${b}k`).map((c) => c.value);
        expect(values).toEqual([a * 1000, b * 1000]);
      }),
    );
  });

  it("chuỗi bất kỳ: không ném lỗi, mọi số là nguyên dương trong trần, vị trí hợp lệ", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme", maxLength: 80 }), (s) => {
        const norm = normalizeForParse(s);
        for (const c of findMoneyCandidates(s)) {
          expect(Number.isSafeInteger(c.value)).toBe(true);
          expect(c.value).toBeGreaterThan(0);
          expect(c.value).toBeLessThanOrEqual(MAX_AMOUNT_VND);
          expect(c.start).toBeGreaterThanOrEqual(0);
          expect(c.end).toBeLessThanOrEqual(norm.length);
          expect(c.start).toBeLessThan(c.end);
        }
      }),
      { numRuns: 2000 },
    );
  });
});
