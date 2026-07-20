// Test Phase 10E — salaryPeriod (canonical period helpers) + bigNum (format).
// Chốt: output GIỐNG TỪNG KÝ TỰ các bản copy-paste cũ ở MySalaryPage/
// ManagerSalaryPage/useManagerSalary (đã xoá), kể cả rollover tháng 12→1.
import { describe, expect, it } from "vitest";
import { currentPeriodMonth, shiftPeriodMonth, vnYmOf } from "@/lib/salaryPeriod";
import { bigNum, salFmt } from "@/components/salary/salaryFormat";

// Bản cũ (copy nguyên văn từ MySalaryPage trước 10E) làm oracle so sánh.
function oldShiftMonth(pm: string, delta: number): string {
  const [y, m] = pm.split("-").map((x) => parseInt(x, 10));
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

describe("shiftPeriodMonth — tương đương bản copy-paste cũ", () => {
  it("rollover 12 → 1 (tiến) và 1 → 12 (lùi) qua năm", () => {
    expect(shiftPeriodMonth("2026-12-01", 1)).toBe("2027-01-01");
    expect(shiftPeriodMonth("2026-01-01", -1)).toBe("2025-12-01");
    expect(shiftPeriodMonth("2026-12-01", 2)).toBe("2027-02-01");
    expect(shiftPeriodMonth("2026-01-01", -13)).toBe("2024-12-01");
  });
  it("khớp oracle bản cũ trên lưới tháng × delta", () => {
    for (let m = 1; m <= 12; m++) {
      const pm = `2026-${String(m).padStart(2, "0")}-01`;
      for (const d of [-25, -12, -1, 0, 1, 12, 25]) {
        expect(shiftPeriodMonth(pm, d)).toBe(oldShiftMonth(pm, d));
      }
    }
  });
  it("delta 0 giữ nguyên", () => {
    expect(shiftPeriodMonth("2026-07-01", 0)).toBe("2026-07-01");
  });
});

describe("currentPeriodMonth / vnYmOf — neo GIỜ VIỆT NAM", () => {
  // Trước 2026-07-20 hàm này dùng getFullYear()/getMonth() (giờ MÁY), nên trên
  // runner UTC hoặc máy đặt lệch múi giờ, vài giờ đầu ngày 1 nó trả về KỲ TRƯỚC.
  it("dạng YYYY-MM-01 theo giờ VN", () => {
    const expected = `${vnYmOf()}-01`;
    expect(currentPeriodMonth()).toBe(expected);
  });

  it("00:30 ngày 01/08 giờ VN (= 31/07 17:30Z) vẫn là kỳ 2026-08", () => {
    expect(vnYmOf(new Date("2026-07-31T17:30:00Z"))).toBe("2026-08");
  });

  it("23:30 ngày 31/07 giờ VN (= 31/07 16:30Z) vẫn là kỳ 2026-07", () => {
    expect(vnYmOf(new Date("2026-07-31T16:30:00Z"))).toBe("2026-07");
  });

  it("rollover năm: 00:10 ngày 01/01/2027 giờ VN", () => {
    expect(vnYmOf(new Date("2026-12-31T17:10:00Z"))).toBe("2027-01");
  });
});

describe("bigNum + salFmt — âm / 0 / lớn / decimal", () => {
  it("bigNum: 0, lớn, decimal round, âm giữ dấu trừ ASCII của toLocaleString", () => {
    expect(bigNum(0)).toBe("0");
    expect(bigNum(8_000_000)).toBe("8.000.000");
    expect(bigNum(1_234_567.6)).toBe("1.234.568");
    expect(bigNum(-2_500_000)).toBe("-2.500.000");
  });
  it("salFmt: âm dùng minus U+2212, null → —, decimal round", () => {
    expect(salFmt(8_000_000)).toBe("8.000.000₫");
    expect(salFmt(-1_500_000)).toBe("−1.500.000₫");
    expect(salFmt(0)).toBe("0₫");
    expect(salFmt(null)).toBe("—");
    expect(salFmt(999.4)).toBe("999₫");
  });
});
