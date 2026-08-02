import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { PRICE_BANDS } from "../PhongTrongParts";

// Dải giá tính bằng triệu/tháng (Room.price = rent_price VND / 1_000_000).
const bands = PRICE_BANDS.filter((b) => b.id !== "all");

describe("PRICE_BANDS (lọc khoảng giá phòng trống)", () => {
  it('có đúng 4 chip: Mọi giá, < 4tr, 4–5tr, > 5tr', () => {
    expect(PRICE_BANDS.map((b) => b.id)).toEqual(["all", "lt4", "4-5", "gt5"]);
  });

  it('"Mọi giá" nhận mọi giá', () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 200, noNaN: true }), (p) => {
        expect(PRICE_BANDS[0].test(p)).toBe(true);
      }),
    );
  });

  it("mỗi giá thuộc đúng 1 dải — không hở, không chồng lấn", () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 200, noNaN: true }), (p) => {
        expect(bands.filter((b) => b.test(p))).toHaveLength(1);
      }),
    );
  });

  it("biên: đúng 4tr và đúng 5tr thuộc dải 4–5tr", () => {
    expect(bands.find((b) => b.test(3.99))?.id).toBe("lt4");
    expect(bands.find((b) => b.test(4))?.id).toBe("4-5");
    expect(bands.find((b) => b.test(4.5))?.id).toBe("4-5");
    expect(bands.find((b) => b.test(5))?.id).toBe("4-5");
    expect(bands.find((b) => b.test(5.01))?.id).toBe("gt5");
  });
});
