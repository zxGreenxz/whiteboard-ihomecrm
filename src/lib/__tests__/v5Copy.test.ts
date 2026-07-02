import { describe, expect, it } from "vitest";
import { V5_BANNED_SUBSTRINGS, v5Copy } from "../v5Copy";

// US-3.6: lint chuỗi cấm — gain-framing tuyệt đối trên MỌI copy v5.
// Mỗi hàm copy được gọi với tham số mẫu; kết quả không được chứa từ cấm.
function allSampleStrings(): { key: string; text: string }[] {
  const out: { key: string; text: string }[] = [];
  for (const [key, val] of Object.entries(v5Copy)) {
    if (typeof val === "string") {
      out.push({ key, text: val });
    } else if (typeof val === "function") {
      // gọi với bộ tham số mẫu đa dạng
      const fn = val as (...args: unknown[]) => string;
      const samples: unknown[][] = [
        [230_769, 5, 3, 600_000],
        [3_000_000, 26],
        ["65NTG", "17:00"],
        [4, 8, 13],
        ["2026-07-08"],
        [0, 0, 0, 0],
        ["full_month", 500_000],
        [true, 3, 12],
        [false, 2, 0],
      ];
      for (const args of samples) {
        try {
          const s = fn(...args);
          if (typeof s === "string") out.push({ key, text: s });
        } catch {
          /* bỏ qua bộ tham số không khớp chữ ký */
        }
      }
    }
  }
  return out;
}

describe("v5Copy — gain-framing lint (cấm −/mất/trừ/phạt/rớt)", () => {
  it("không chuỗi nào chứa từ cấm", () => {
    const violations: string[] = [];
    for (const { key, text } of allSampleStrings()) {
      for (const banned of V5_BANNED_SUBSTRINGS) {
        if (text.toLowerCase().includes(banned.toLowerCase())) {
          violations.push(`${key}: "${text}" chứa "${banned}"`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("mọi copy có số tiền realtime đều mang nhãn TẠM TÍNH", () => {
    expect(v5Copy.tickedToast(230_769, 5, 3, 600_000)).toContain("TẠM TÍNH");
    expect(v5Copy.tickedToastNoNext(230_769, 26)).toContain("TẠM TÍNH");
    expect(v5Copy.progressAttend(10, 27)).toContain("TẠM TÍNH");
  });

  it("mốc streak hiển thị DELTA (+500k), không hiển thị luỹ kế lẫn lộn (C13)", () => {
    expect(v5Copy.milestoneBanked(23, 500_000)).toContain("+500k");
    expect(v5Copy.milestoneBanked("full_month", 500_000)).toContain("Trọn tháng");
  });

  it("fail luôn là 'còn X ... nữa là đủ công'", () => {
    expect(v5Copy.failBanner(2)).toBe("Còn 2 mục nữa là đủ công hôm nay");
    expect(v5Copy.failBannerDwell(4)).toContain("nữa là đủ công");
  });
});
