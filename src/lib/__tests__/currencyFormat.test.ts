import { describe, it, expect } from "vitest";
import { formatCurrency, formatVND } from "../utils";

// Snapshot cứng các cạnh: nếu ai đổi hành vi formatter, test này gãy TRƯỚC khi
// UI đổi text tiền hàng loạt. NB = non-breaking space (U+00A0) Intl chèn trước ₫.
const NB = " ";

describe("formatCurrency (₫ Intl)", () => {
  it("các cạnh", () => {
    expect(formatCurrency(0)).toBe(`0${NB}₫`);
    expect(formatCurrency(1500000)).toBe(`1.500.000${NB}₫`);
    expect(formatCurrency(-500000)).toBe(`-500.000${NB}₫`);
    expect(formatCurrency(1500000000)).toBe(`1.500.000.000${NB}₫`);
    // Intl VND làm tròn về số nguyên (maximumFractionDigits mặc định 0).
    expect(formatCurrency(1234.56)).toBe(`1.235${NB}₫`);
  });

  it("giá trị không hợp lệ → 0 ₫ (KHÔNG 'NaN ₫')", () => {
    expect(formatCurrency(NaN)).toBe(`0${NB}₫`);
    expect(formatCurrency(Infinity)).toBe(`0${NB}₫`);
    expect(formatCurrency(-Infinity)).toBe(`0${NB}₫`);
    expect(formatCurrency(undefined as any)).toBe(`0${NB}₫`);
    expect(formatCurrency(null as any)).toBe(`0${NB}₫`);
  });
});

describe("formatVND (đ thường)", () => {
  it("các cạnh", () => {
    expect(formatVND(0)).toBe("0 đ");
    expect(formatVND(1500000)).toBe("1.500.000 đ");
    expect(formatVND(-500000)).toBe("-500.000 đ");
    expect(formatVND(1500000000)).toBe("1.500.000.000 đ");
    expect(formatVND(null)).toBe("0 đ");
    expect(formatVND(undefined)).toBe("0 đ");
  });

  it("giá trị không hợp lệ + làm tròn khớp formatCurrency", () => {
    expect(formatVND(NaN as any)).toBe("0 đ");
    expect(formatVND(Infinity as any)).toBe("0 đ");
    expect(formatVND("abc" as any)).toBe("0 đ");
    expect(formatVND(1234.56)).toBe("1.235 đ");
    expect(formatVND(1234.4)).toBe("1.234 đ");
  });
});
