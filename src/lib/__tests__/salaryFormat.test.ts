import { describe, expect, it } from "vitest";
import { bigNum, salFmt } from "@/components/salary/salaryFormat";

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
