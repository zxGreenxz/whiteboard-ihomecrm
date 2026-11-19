import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { dayOfWeek, daysInMonth, nChuan, toIso, workdaysInMonth } from "../v5Calendar";

// Fixture ĐÃ ĐỐI CHIẾU với SQL live (vn_workdays) ngày 2026-07-03:
//   T7/2026 = 27 ngày-làm (31 ngày − 4 CN, 0 lễ)
//   T9/2026 = 25 ngày-làm (30 − 4 CN − 1 lễ 02/09)
//
// PHẠM VI: file này ghim HÀNH VI TS vào các số đã đối chiếu một lần với SQL. Nó
// KHÔNG kiểm parity liên tục — SQL đổi thì nó không biết. Việc đó thuộc
// `npm run gate:v5-calendar-parity` (scripts/v5-calendar-parity.mjs), nay đã gọi
// THẲNG hàm TS ở đây qua vite-node thay vì so với một bản chép tay như trước.
// Hai thứ bù nhau: test ghim TS, gate so TS với SQL sống.
describe("v5Calendar — parity fixtures với SQL", () => {
  it("T7/2026 có 27 ngày-làm", () => {
    expect(workdaysInMonth(2026, 7, [])).toHaveLength(27);
  });
  it("T9/2026 có 25 ngày-làm (lễ 02/09)", () => {
    expect(workdaysInMonth(2026, 9, ["2026-09-02"])).toHaveLength(25);
  });
  it("N_chuẩn T7/2026 với 1 phép-duyệt = 26 (khớp SQL v5_n_chuan)", () => {
    expect(nChuan(2026, 7, [], ["2026-07-08"])).toBe(26);
  });
});

describe("v5Calendar — bất biến (property-based)", () => {
  const arbYm = fc.record({
    year: fc.integer({ min: 2024, max: 2030 }),
    month1: fc.integer({ min: 1, max: 12 }),
  });

  it("không có CN trong ngày-làm; tất cả thuộc đúng tháng", () => {
    fc.assert(
      fc.property(arbYm, ({ year, month1 }) => {
        const wd = workdaysInMonth(year, month1, []);
        expect(wd.every((d) => dayOfWeek(d) !== 0)).toBe(true);
        expect(wd.every((d) => d.startsWith(`${year}-${String(month1).padStart(2, "0")}`))).toBe(true);
      }),
    );
  });

  it("mỗi ngày lễ rơi vào T2–T7 giảm đúng 1 ngày-làm; lễ CN không giảm", () => {
    fc.assert(
      fc.property(arbYm, fc.integer({ min: 1, max: 28 }), ({ year, month1 }, day) => {
        const iso = toIso(year, month1, day);
        const base = workdaysInMonth(year, month1, []).length;
        const withHol = workdaysInMonth(year, month1, [iso]).length;
        expect(withHol).toBe(dayOfWeek(iso) === 0 ? base : base - 1);
      }),
    );
  });

  it("phép-duyệt giảm N_chuẩn đúng số ngày phép hợp lệ; phép trùng CN/lễ không trừ", () => {
    fc.assert(
      fc.property(arbYm, fc.integer({ min: 1, max: 28 }), ({ year, month1 }, day) => {
        const iso = toIso(year, month1, day);
        const base = nChuan(year, month1, [], []);
        const withLeave = nChuan(year, month1, [], [iso, iso]); // trùng lặp không trừ đôi
        expect(withLeave).toBe(dayOfWeek(iso) === 0 ? base : base - 1);
      }),
    );
  });

  it("daysInMonth đúng cho năm nhuận", () => {
    expect(daysInMonth(2028, 2)).toBe(29);
    expect(daysInMonth(2026, 2)).toBe(28);
  });
});
