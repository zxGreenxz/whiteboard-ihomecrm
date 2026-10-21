import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GOM_THONG_BAO_MS,
  TRAN_CHO_THONG_BAO_MS,
  choConLaiThongBao,
  suKienCanLamMoi,
  taoBoGomThongBao,
} from "@/lib/notifications/realtimeSignal";

const dong = (over: Record<string, unknown> = {}) => ({
  id: "n1",
  status: "PENDING",
  subject: "Phiếu chờ duyệt",
  content: "3 phiếu",
  push_state: "QUEUED",
  push_attempts: 0,
  ...over,
});

describe("suKienCanLamMoi — lọc sự kiện của kênh notif", () => {
  it("INSERT và DELETE luôn làm mới", () => {
    expect(suKienCanLamMoi({ eventType: "INSERT", new: dong(), old: {} })).toBe(true);
    expect(suKienCanLamMoi({ eventType: "DELETE", new: {}, old: dong() })).toBe(true);
  });

  it("UPDATE chỉ đổi cột hàng đợi push (drain) thì bỏ qua", () => {
    expect(suKienCanLamMoi({
      eventType: "UPDATE",
      old: dong({ push_state: "QUEUED", push_attempts: 0 }),
      new: dong({ push_state: "SENDING", push_attempts: 1 }),
    })).toBe(false);
  });

  it("UPDATE đổi trạng thái đọc (máy khác đánh dấu) hoặc nội dung (dòng gộp E1) thì làm mới", () => {
    expect(suKienCanLamMoi({ eventType: "UPDATE", old: dong(), new: dong({ status: "READ" }) })).toBe(true);
    expect(suKienCanLamMoi({ eventType: "UPDATE", old: dong(), new: dong({ content: "4 phiếu" }) })).toBe(true);
    expect(suKienCanLamMoi({ eventType: "UPDATE", old: dong(), new: dong({ subject: "Khác" }) })).toBe(true);
    expect(suKienCanLamMoi({ eventType: "UPDATE", old: dong(), new: dong({ status: "CANCELLED" }) })).toBe(true);
  });

  it("old thiếu cột (replica identity DEFAULT) thì coi như ĐỔI — không bỏ lỡ", () => {
    expect(suKienCanLamMoi({ eventType: "UPDATE", old: { id: "n1" }, new: dong() })).toBe(true);
    expect(suKienCanLamMoi({ eventType: "UPDATE", old: null, new: dong() })).toBe(true);
  });

  it("payload lạ hoặc rỗng thì làm mới (an toàn hơn bỏ qua)", () => {
    expect(suKienCanLamMoi(undefined)).toBe(true);
    expect(suKienCanLamMoi({ eventType: "TRUNCATE" })).toBe(true);
  });
});

describe("taoBoGomThongBao — gom 300 ms, trần 1 s", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-21T08:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("một cụm markAll (500 UPDATE sát nhau) chỉ gây MỘT lần làm mới", () => {
    const lamMoi = vi.fn();
    const bo = taoBoGomThongBao(lamMoi);
    for (let i = 0; i < 500; i++) bo.day();
    expect(lamMoi).not.toHaveBeenCalled();
    vi.advanceTimersByTime(GOM_THONG_BAO_MS);
    expect(lamMoi).toHaveBeenCalledTimes(1);
  });

  it("bão kéo dài vẫn nhả số mới mỗi giây (không bị đẩy lùi vô hạn)", () => {
    const lamMoi = vi.fn();
    const bo = taoBoGomThongBao(lamMoi);
    // Mỗi 100 ms một sự kiện trong 3 giây.
    for (let t = 0; t < 3000; t += 100) {
      bo.day();
      vi.advanceTimersByTime(100);
    }
    expect(lamMoi.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(lamMoi.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it("huy() bỏ lần làm mới đang chờ", () => {
    const lamMoi = vi.fn();
    const bo = taoBoGomThongBao(lamMoi);
    bo.day();
    bo.huy();
    vi.advanceTimersByTime(TRAN_CHO_THONG_BAO_MS * 2);
    expect(lamMoi).not.toHaveBeenCalled();
  });

  it("choConLaiThongBao không vượt trần tính từ sự kiện đầu cụm", () => {
    expect(choConLaiThongBao(0, 0)).toBe(GOM_THONG_BAO_MS);
    expect(choConLaiThongBao(0, 900)).toBe(100);
    expect(choConLaiThongBao(0, 5000)).toBe(0);
  });
});
