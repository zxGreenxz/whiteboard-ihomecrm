// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { capNhatSoTrenIcon, dongMoiThongBaoHopThu, dongThongBaoDaDoc } from "@/lib/push/osNotifications";

const ID1 = "11111111-1111-4111-8111-111111111111";
const ID2 = "22222222-2222-4222-8222-222222222222";

function thongBao(tag: string) {
  return { tag, close: vi.fn() };
}

describe("đóng thông báo hệ điều hành theo trạng thái đã đọc", () => {
  let dangHien: ReturnType<typeof thongBao>[];

  beforeEach(() => {
    dangHien = [
      thongBao(`crm-${ID1}`),
      thongBao(`crm-${ID2}`),
      thongBao("crm-user-gop"),
      thongBao("lifecycle:delivery-1"),
      thongBao("personal-task:u1:t1"),
      thongBao(""),
    ];
    const registration = { getNotifications: vi.fn(async () => dangHien) };
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { getRegistration: vi.fn(async () => registration) },
    });
  });

  it("đọc một dòng chỉ đóng đúng tag crm-<id> của dòng đó", async () => {
    await expect(dongThongBaoDaDoc([ID1])).resolves.toBe(1);
    expect(dangHien[0]!.close).toHaveBeenCalledOnce();
    expect(dangHien[1]!.close).not.toHaveBeenCalled();
    expect(dangHien[2]!.close).not.toHaveBeenCalled();
  });

  it("chưa đọc về 0: đóng mọi thông báo hộp thư, KHÔNG đụng nhắc Việc của tôi", async () => {
    await expect(dongMoiThongBaoHopThu()).resolves.toBe(4);
    expect(dangHien[4]!.close).not.toHaveBeenCalled();
    expect(dangHien[5]!.close).not.toHaveBeenCalled();
  });

  it("trình duyệt không có service worker / lỗi đọc: không ném, trả 0", async () => {
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { getRegistration: vi.fn(async () => { throw new Error("PRIVATE"); }) },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(dongThongBaoDaDoc([ID1])).resolves.toBe(0);
    await expect(dongMoiThongBaoHopThu()).resolves.toBe(0);
    warn.mockRestore();
  });
});

describe("số trên icon PWA", () => {
  const nav = navigator as Navigator & { setAppBadge?: unknown; clearAppBadge?: unknown };

  afterEach(() => {
    delete nav.setAppBadge;
    delete nav.clearAppBadge;
  });

  it("có Badging API: >0 đặt số, 0 xoá số", () => {
    const set = vi.fn(async () => undefined);
    const clear = vi.fn(async () => undefined);
    Object.assign(nav, { setAppBadge: set, clearAppBadge: clear });
    capNhatSoTrenIcon(7);
    capNhatSoTrenIcon(0);
    expect(set).toHaveBeenCalledWith(7);
    expect(clear).toHaveBeenCalledOnce();
  });

  it("không có API hoặc API từ chối: lặng lẽ bỏ qua, không ném", async () => {
    expect(() => capNhatSoTrenIcon(3)).not.toThrow();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    Object.assign(nav, { setAppBadge: vi.fn(() => Promise.reject(new Error("NotAllowed"))) });
    expect(() => capNhatSoTrenIcon(3)).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
