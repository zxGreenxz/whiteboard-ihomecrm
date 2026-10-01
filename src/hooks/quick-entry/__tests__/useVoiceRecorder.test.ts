// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { formatOf, MAX_RECORD_SECONDS, pickMimeType, useVoiceRecorder } from "../useVoiceRecorder";

describe("pickMimeType / formatOf", () => {
  it("ưu tiên webm/opus; Safari đời cũ chỉ có mp4 ⇒ mp4", () => {
    expect(pickMimeType(() => true)).toBe("audio/webm;codecs=opus");
    expect(pickMimeType((t) => t === "audio/mp4")).toBe("audio/mp4");
    expect(pickMimeType(() => false)).toBeNull();
  });

  it("định dạng gửi máy chủ theo mime", () => {
    expect(formatOf("audio/webm;codecs=opus")).toBe("webm");
    expect(formatOf("audio/mp4")).toBe("mp4");
    expect(formatOf("audio/ogg;codecs=opus")).toBe("ogg");
    expect(formatOf("audio/wav")).toBeNull();
  });
});

class FakeRecorder {
  static instances: FakeRecorder[] = [];
  static isTypeSupported = (t: string) => t === "audio/mp4";
  state: "inactive" | "recording" = "inactive";
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(
    public stream: unknown,
    public opts: { mimeType: string },
  ) {
    FakeRecorder.instances.push(this);
  }
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["abc"], { type: this.opts.mimeType }) });
    this.onstop?.();
  }
}

const track = { stop: vi.fn() };
const getUserMedia = vi.fn();

beforeEach(() => {
  FakeRecorder.instances = [];
  track.stop.mockReset();
  getUserMedia.mockReset().mockResolvedValue({ getTracks: () => [track] });
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia }, configurable: true });
  Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useVoiceRecorder", () => {
  it("chạm để nói rồi dừng ⇒ trả âm thanh đúng định dạng và tắt micro", async () => {
    const onDone = vi.fn();
    const { result } = renderHook(() => useVoiceRecorder(onDone));
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.state).toBe("recording");
    expect(getUserMedia).toHaveBeenCalledWith({ audio: { echoCancellation: true, noiseSuppression: true } });
    act(() => result.current.stop());
    expect(onDone).toHaveBeenCalledOnce();
    expect(onDone.mock.calls[0][0]).toMatchObject({ mimeType: "audio/mp4", format: "mp4" });
    expect(track.stop).toHaveBeenCalled();
    expect(result.current.state).toBe("idle");
  });

  it(`tự dừng ở ${MAX_RECORD_SECONDS} giây`, async () => {
    vi.useFakeTimers();
    const onDone = vi.fn();
    const { result } = renderHook(() => useVoiceRecorder(onDone));
    await act(async () => {
      await result.current.start();
    });
    act(() => {
      vi.advanceTimersByTime((MAX_RECORD_SECONDS - 1) * 1000);
    });
    expect(onDone).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(onDone).toHaveBeenCalledOnce();
  });

  it("huỷ ⇒ không gửi gì, vẫn tắt micro", async () => {
    const onDone = vi.fn();
    const { result } = renderHook(() => useVoiceRecorder(onDone));
    await act(async () => {
      await result.current.start();
    });
    act(() => result.current.cancel());
    expect(onDone).not.toHaveBeenCalled();
    expect(track.stop).toHaveBeenCalled();
  });

  it("bị từ chối quyền micro ⇒ báo lỗi dễ hiểu", async () => {
    getUserMedia.mockRejectedValueOnce(Object.assign(new Error("denied"), { name: "NotAllowedError" }));
    const { result } = renderHook(() => useVoiceRecorder(vi.fn()));
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.state).toBe("error");
    expect(result.current.error).toMatch(/quyền micro/);
  });

  it("trình duyệt không có MediaRecorder ⇒ supported = false", () => {
    vi.stubGlobal("MediaRecorder", undefined);
    const { result } = renderHook(() => useVoiceRecorder(vi.fn()));
    expect(result.current.supported).toBe(false);
  });
});
