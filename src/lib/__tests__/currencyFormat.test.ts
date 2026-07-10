import { describe, it, expect } from "vitest";
import { formatCurrency, formatVND } from "../utils";

// Snapshot cứng các cạnh: nếu ai đổi hành vi formatter, test này gãy TRƯỚC khi
// UI đổi text tiền hàng loạt.   = non-breaking space Intl chèn trước ₫.
describe("formatCurrency (₫ Intl)", () => {
  it("các cạnh", () => {
    expect(formatCurrency(0)).toBe("0 ₫");
    expect(formatCurrency(1500000)).toBe("1.500.000 ₫");
    expect(formatCurrency(-500000)).toBe("-500.000 ₫");
    expect(formatCurrency(1500000000)).toBe("1.500.000.000 ₫");
    // Intl VND làm tròn về số nguyên (maximumFractionDigits mặc định 0).
    expect(formatCurrency(1234.56)).toBe("1.235 ₫");
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
});
