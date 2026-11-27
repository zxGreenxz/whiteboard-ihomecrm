// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HOLD_TO_OPEN_MS, OPENED_RESET_MS } from "@/lib/door-access/holdToOpen";

import { useHoldToOpen } from "../useHoldToOpen";

/** Đồng hồ + khung hình giả: `advance(ms)` chạy mọi khung hình đến hạn theo nhịp 16 ms. */
let clock = 0;
let frames = new Map<number, FrameRequestCallback>();
let nextFrame = 1;

function advance(ms: number) {
  const end = clock + ms;
  while (clock < end) {
    clock = Math.min(end, clock + 16);
    const due = [...frames.entries()];
    frames = new Map();
    for (const [, callback] of due) callback(clock);
  }
}

const pointer = (button = 0) =>
  ({ button, pointerId: 1, currentTarget: { setPointerCapture: vi.fn() } }) as unknown as React.PointerEvent<HTMLElement>;
const key = (value: string, repeat = false) => ({ key: value, repeat, preventDefault: vi.fn() }) as unknown as React.KeyboardEvent<HTMLElement>;

beforeEach(() => {
  clock = 0;
  frames = new Map();
  nextFrame = 1;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = nextFrame++;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function setup(blocked = false) {
  const onFire = vi.fn();
  const hook = renderHook((props: { blocked: boolean }) => useHoldToOpen({ blocked: props.blocked, onFire, now: () => clock }), {
    initialProps: { blocked },
  });
  return { onFire, hook };
}

describe("useHoldToOpen", () => {
  it("giữ chạm 1 giây ⇒ gọi mở cửa đúng một lần", () => {
    const { onFire, hook } = setup();
    act(() => hook.result.current.handlers.onPointerDown(pointer()));
    act(() => advance(HOLD_TO_OPEN_MS - 100));
    expect(hook.result.current.state.phase).toBe("holding");
    expect(onFire).not.toHaveBeenCalled();
    act(() => advance(200));
    act(() => hook.result.current.handlers.onPointerUp(pointer()));
    expect(onFire).toHaveBeenCalledTimes(1);
    expect(hook.result.current.state.phase).toBe("sending");
  });

  it("buông sớm ⇒ không mở, nhắc giữ lâu hơn; không còn khung hình chạy ngầm", () => {
    const { onFire, hook } = setup();
    act(() => hook.result.current.handlers.onPointerDown(pointer()));
    act(() => advance(600));
    act(() => hook.result.current.handlers.onPointerUp(pointer()));
    act(() => advance(2000));
    expect(onFire).not.toHaveBeenCalled();
    expect(hook.result.current.state.phase).toBe("hint");
    expect(frames.size).toBe(0);
  });

  it("chuột phải không bắt đầu giữ", () => {
    const { onFire, hook } = setup();
    act(() => hook.result.current.handlers.onPointerDown(pointer(2)));
    act(() => advance(2000));
    expect(onFire).not.toHaveBeenCalled();
    expect(hook.result.current.state.phase).toBe("idle");
  });

  it("bàn phím: giữ Space đủ giờ thì mở; phím lặp không bắt đầu lại", () => {
    const { onFire, hook } = setup();
    act(() => hook.result.current.handlers.onKeyDown(key(" ")));
    act(() => advance(500));
    act(() => hook.result.current.handlers.onKeyDown(key(" ", true)));
    act(() => advance(600));
    act(() => hook.result.current.handlers.onKeyUp(key(" ")));
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it("bàn phím: Enter buông sớm là huỷ; phím khác bị bỏ qua", () => {
    const { onFire, hook } = setup();
    act(() => hook.result.current.handlers.onKeyDown(key("a")));
    expect(hook.result.current.state.phase).toBe("idle");
    act(() => hook.result.current.handlers.onKeyDown(key("Enter")));
    act(() => advance(300));
    act(() => hook.result.current.handlers.onKeyUp(key("Enter")));
    expect(onFire).not.toHaveBeenCalled();
    expect(hook.result.current.state.phase).toBe("hint");
  });

  it("mất tiêu điểm hoặc nút bị khoá giữa chừng ⇒ huỷ", () => {
    const { onFire, hook } = setup();
    act(() => hook.result.current.handlers.onPointerDown(pointer()));
    act(() => advance(400));
    act(() => hook.result.current.handlers.onBlur());
    act(() => advance(1000));
    expect(hook.result.current.state.phase).toBe("idle");

    act(() => hook.result.current.handlers.onPointerDown(pointer()));
    act(() => advance(400));
    hook.rerender({ blocked: true });
    act(() => advance(1000));
    expect(onFire).not.toHaveBeenCalled();
    expect(hook.result.current.state.phase).toBe("idle");
  });

  it("ngón trượt ra ngoài / mất giữ con trỏ khi đang giữ ⇒ huỷ, không mở", () => {
    const { onFire, hook } = setup();
    act(() => hook.result.current.handlers.onPointerDown(pointer()));
    act(() => advance(500));
    act(() => hook.result.current.handlers.onPointerLeave(pointer()));
    act(() => advance(1000));
    expect(hook.result.current.state.phase).toBe("idle");
    act(() => hook.result.current.handlers.onPointerDown(pointer()));
    act(() => advance(500));
    act(() => hook.result.current.handlers.onLostPointerCapture(pointer()));
    act(() => advance(1000));
    expect(onFire).not.toHaveBeenCalled();
    // Nhấc tay đúng cách rồi mới mất giữ con trỏ: không ảnh hưởng kết quả.
    act(() => hook.result.current.handlers.onPointerDown(pointer()));
    act(() => advance(1100));
    act(() => hook.result.current.handlers.onPointerUp(pointer()));
    act(() => hook.result.current.handlers.onLostPointerCapture(pointer()));
    expect(onFire).toHaveBeenCalledTimes(1);
    expect(hook.result.current.state.phase).toBe("sending");
  });

  it("trigger (sau bước xác nhận riêng) gửi một lần; nút khoá thì không", () => {
    const { onFire, hook } = setup();
    act(() => hook.result.current.trigger());
    expect(onFire).toHaveBeenCalledTimes(1);
    act(() => hook.result.current.trigger());
    expect(onFire).toHaveBeenCalledTimes(1);
    const locked = setup(true);
    act(() => locked.hook.result.current.trigger());
    expect(locked.onFire).not.toHaveBeenCalled();
  });

  it("nút khoá ⇒ chạm không làm gì", () => {
    const { onFire, hook } = setup(true);
    act(() => hook.result.current.handlers.onPointerDown(pointer()));
    act(() => advance(2000));
    expect(onFire).not.toHaveBeenCalled();
  });

  it("đã mở ⇒ 5 giây sau tự về sẵn sàng; chưa rõ ⇒ đứng yên cho tới Đã hiểu", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { onFire, hook } = setup();
    act(() => hook.result.current.handlers.onPointerDown(pointer()));
    act(() => advance(HOLD_TO_OPEN_MS + 20));
    act(() => hook.result.current.report({ kind: "opened", logPending: false }));
    expect(hook.result.current.state.phase).toBe("opened");
    act(() => vi.advanceTimersByTime(OPENED_RESET_MS));
    expect(hook.result.current.state.phase).toBe("idle");

    act(() => hook.result.current.handlers.onPointerDown(pointer()));
    act(() => advance(HOLD_TO_OPEN_MS + 20));
    act(() => hook.result.current.report({ kind: "unknown", message: "?", logPending: false }));
    act(() => vi.advanceTimersByTime(60_000));
    expect(hook.result.current.state.phase).toBe("unknown");
    // Giữ lại khi chưa bấm Đã hiểu: không gửi lệnh thứ ba.
    act(() => hook.result.current.handlers.onPointerDown(pointer()));
    act(() => advance(HOLD_TO_OPEN_MS * 2));
    expect(onFire).toHaveBeenCalledTimes(2);
    act(() => hook.result.current.reset());
    expect(hook.result.current.state.phase).toBe("idle");
  });
});
