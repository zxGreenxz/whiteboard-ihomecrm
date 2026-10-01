// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useSpeechInput } from "../useSpeechInput";

class FakeRecognition {
  static last: FakeRecognition | null = null;
  lang = "";
  interimResults = true;
  continuous = true;
  onresult: ((e: { results: Array<Array<{ transcript: string }> & { isFinal: boolean }> }) => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  start = vi.fn();
  stop = vi.fn(() => this.onend?.());
  constructor() {
    FakeRecognition.last = this;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeRecognition.last = null;
});

describe("useSpeechInput (dự phòng: nhận giọng của trình duyệt)", () => {
  it("không có SpeechRecognition ⇒ supported = false", () => {
    const { result } = renderHook(() => useSpeechInput(vi.fn()));
    expect(result.current.supported).toBe(false);
  });

  it("tiếng Việt, một câu; có kết quả cuối ⇒ trả chữ", () => {
    vi.stubGlobal("webkitSpeechRecognition", FakeRecognition);
    const onText = vi.fn();
    const { result } = renderHook(() => useSpeechInput(onText));
    expect(result.current.supported).toBe(true);
    act(() => result.current.start());
    const rec = FakeRecognition.last!;
    expect(rec.lang).toBe("vi-VN");
    expect(rec.continuous).toBe(false);
    const final = Object.assign([{ transcript: "mua sơn ba trăm nghìn" }], { isFinal: true });
    act(() => rec.onresult?.({ results: [final] }));
    act(() => rec.onend?.());
    expect(onText).toHaveBeenCalledWith("mua sơn ba trăm nghìn");
    expect(result.current.listening).toBe(false);
  });

  it("bị từ chối quyền ⇒ báo lỗi, không gọi onText", () => {
    vi.stubGlobal("SpeechRecognition", FakeRecognition);
    const onText = vi.fn();
    const { result } = renderHook(() => useSpeechInput(onText));
    act(() => result.current.start());
    act(() => FakeRecognition.last!.onerror?.({ error: "not-allowed" }));
    act(() => FakeRecognition.last!.onend?.());
    expect(onText).not.toHaveBeenCalled();
    expect(result.current.error).toMatch(/micro/);
    expect(result.current.errorCode).toBe("not-allowed");
  });

  it("lần nghe sau xoá mã lỗi cũ", () => {
    vi.stubGlobal("webkitSpeechRecognition", FakeRecognition);
    const { result } = renderHook(() => useSpeechInput(vi.fn()));
    act(() => result.current.start());
    act(() => FakeRecognition.last!.onerror?.({ error: "no-speech" }));
    act(() => FakeRecognition.last!.onend?.());
    expect(result.current.errorCode).toBe("no-speech");
    act(() => result.current.start());
    expect(result.current.errorCode).toBeNull();
  });
});
