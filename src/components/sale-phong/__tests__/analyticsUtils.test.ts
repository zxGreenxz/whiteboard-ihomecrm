import { describe, it, expect } from "vitest";
import { parseUA, sourceLabel } from "../analyticsUtils";

describe("parseUA", () => {
  it("nhận ra trình duyệt in-app TRƯỚC khi rơi vào Safari/Chrome", () => {
    // Zalo iOS tự khai là Safari ở cuối chuỗi — bắt sai thứ tự là mất hẳn thông
    // tin quan trọng nhất của trang công khai (phần lớn khách đến từ link Zalo).
    const zalo =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 " +
      "(KHTML, like Gecko) Mobile/15E148 Zalo.1.2.3 Safari/604.1";
    expect(parseUA(zalo)).toBe("Zalo in-app");

    const fb =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 " +
      "[FBAN/FBIOS;FBAV/470.0]";
    expect(parseUA(fb)).toBe("Facebook in-app");
  });

  it("phân biệt Chrome Android với Safari iOS", () => {
    expect(
      parseUA("Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36"),
    ).toBe("Chrome (Android)");
    expect(
      parseUA("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1"),
    ).toBe("Safari (iOS)");
    expect(
      parseUA("Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 CriOS/126.0 Mobile/15E148 Safari/604.1"),
    ).toBe("Chrome (iOS)");
  });

  it("không có user-agent thì nói rõ là không biết", () => {
    expect(parseUA(null)).toBe("—");
    expect(parseUA("")).toBe("—");
    expect(parseUA("con-gi-do/1.0")).toBe("Khác");
  });
});

describe("sourceLabel", () => {
  it("dịch nguồn lỗi sang tiếng Việt, mặc định là lỗi của ứng dụng", () => {
    expect(sourceLabel("external")).toBe("Ngoài app");
    expect(sourceLabel("app")).toBe("Ứng dụng");
    expect(sourceLabel(null)).toBe("Ứng dụng");
  });
});
