// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBurstScheduler } from "@/lib/realtime/burstScheduler";

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("createBurstScheduler — nhịp gom cho kênh ngoài hub", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setVisibility("visible");
  });
  afterEach(() => vi.useRealTimers());

  it("gom một cụm thưa về một lần nhả sau debounce", () => {
    const flush = vi.fn();
    const s = createBurstScheduler({ debounceMs: 800, maxWaitMs: 2500, flush });
    s.poke();
    vi.advanceTimersByTime(500);
    s.poke();
    vi.advanceTimersByTime(799);
    expect(flush).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(flush).toHaveBeenCalledTimes(1);
    s.dispose();
  });

  it("bão không ngớt vẫn nhả ở trần chờ tính từ event đầu", () => {
    const flush = vi.fn();
    const s = createBurstScheduler({ debounceMs: 800, maxWaitMs: 2500, flush });
    for (let i = 0; i < 6; i += 1) {
      s.poke();
      vi.advanceTimersByTime(400);
    }
    // 6 × 400 = 2400 < 2500: chưa tới trần.
    expect(flush).not.toHaveBeenCalled();
    s.poke();
    vi.advanceTimersByTime(100);
    expect(flush).toHaveBeenCalledTimes(1);
    s.dispose();
  });

  it("tab ẩn: 20 event không nhả lần nào; hiện lại thì nhả ĐÚNG một lần", () => {
    const flush = vi.fn();
    const s = createBurstScheduler({ debounceMs: 800, maxWaitMs: 2500, flush });
    setVisibility("hidden");
    for (let i = 0; i < 20; i += 1) {
      s.poke();
      vi.advanceTimersByTime(1_000);
    }
    expect(flush).not.toHaveBeenCalled();
    setVisibility("visible");
    vi.advanceTimersByTime(0);
    expect(flush).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10_000);
    expect(flush).toHaveBeenCalledTimes(1);
    s.dispose();
  });

  it("tab ẩn đi SAU khi đã hẹn: timer tới hạn cũng không nhả, đợi hiện lại", () => {
    const flush = vi.fn();
    const s = createBurstScheduler({ debounceMs: 800, maxWaitMs: 2500, flush });
    s.poke();
    setVisibility("hidden");
    vi.advanceTimersByTime(5_000);
    expect(flush).not.toHaveBeenCalled();
    setVisibility("visible");
    vi.advanceTimersByTime(0);
    expect(flush).toHaveBeenCalledTimes(1);
    s.dispose();
  });

  it("hiện lại mà không có việc chờ thì không nhả", () => {
    const flush = vi.fn();
    const s = createBurstScheduler({ debounceMs: 800, maxWaitMs: 2500, flush });
    setVisibility("hidden");
    setVisibility("visible");
    vi.advanceTimersByTime(1_000);
    expect(flush).not.toHaveBeenCalled();
    s.dispose();
  });

  it("cancel bỏ việc chờ (một lượt bắt kịp đã phủ hết)", () => {
    const flush = vi.fn();
    const s = createBurstScheduler({ debounceMs: 800, maxWaitMs: 2500, flush });
    s.poke();
    s.cancel();
    vi.advanceTimersByTime(5_000);
    setVisibility("hidden");
    setVisibility("visible");
    vi.advanceTimersByTime(5_000);
    expect(flush).not.toHaveBeenCalled();
    s.dispose();
  });

  it("dispose({flush:true}) nhả việc tồn thay vì làm rơi; dispose trần thì bỏ", () => {
    const giu = vi.fn();
    const a = createBurstScheduler({ debounceMs: 5_000, maxWaitMs: 15_000, flush: giu });
    a.poke();
    a.dispose({ flush: true });
    expect(giu).toHaveBeenCalledTimes(1);
    a.poke();
    vi.advanceTimersByTime(20_000);
    expect(giu).toHaveBeenCalledTimes(1);

    const bo = vi.fn();
    const b = createBurstScheduler({ debounceMs: 5_000, maxWaitMs: 15_000, flush: bo });
    b.poke();
    b.dispose();
    vi.advanceTimersByTime(20_000);
    expect(bo).not.toHaveBeenCalled();
  });
});
