// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { RecordedAudio } from "@/hooks/quick-entry/useVoiceRecorder";
import type { TranscribeResult } from "@/hooks/quick-entry/quickEntryAi";
import { classifyAiError } from "@/lib/quickEntry/errors";

// Hai hook giọng nói được thay bằng bản điều khiển tay: test giữ callback để "nói xong" khi muốn.
const rec = vi.hoisted(() => ({
  supported: true,
  state: "idle" as "idle" | "requesting" | "recording" | "error",
  error: null as string | null,
  onDone: null as ((a: RecordedAudio) => void) | null,
  start: vi.fn(),
  stop: vi.fn(),
  cancel: vi.fn(),
}));
const sp = vi.hoisted(() => ({
  supported: false,
  listening: false,
  errorCode: null as string | null,
  error: null as string | null,
  onText: null as ((t: string) => void) | null,
  start: vi.fn(),
  stop: vi.fn(),
}));
vi.mock("@/hooks/quick-entry/useVoiceRecorder", () => ({
  MAX_RECORD_SECONDS: 30,
  useVoiceRecorder: (onDone: (a: RecordedAudio) => void) => {
    rec.onDone = onDone;
    return { supported: rec.supported, state: rec.state, seconds: 0, error: rec.error, start: rec.start, stop: rec.stop, cancel: rec.cancel };
  },
}));
vi.mock("@/hooks/quick-entry/useSpeechInput", () => ({
  useSpeechInput: (onText: (t: string) => void) => {
    sp.onText = onText;
    return { supported: sp.supported, listening: sp.listening, error: sp.error, errorCode: sp.errorCode, start: sp.start, stop: sp.stop };
  },
}));

import { QuickEntryComposer, type QuickEntryComposerProps } from "../QuickEntryComposer";

const audio: RecordedAudio = { blob: new Blob(["x"]), mimeType: "audio/webm", format: "webm", seconds: 3 };

function setup(over: Partial<QuickEntryComposerProps> = {}) {
  const props: QuickEntryComposerProps = {
    mode: "company",
    modes: ["company", "personal"],
    onModeChange: vi.fn(),
    onSubmitText: vi.fn(),
    onPhoto: vi.fn(),
    transcribe: vi.fn(async (): Promise<TranscribeResult> => ({ ok: true, text: "sơn ba trăm nghìn" })),
    ...over,
  };
  render(<QuickEntryComposer {...props} />);
  return {
    props,
    // Lúc đang ghi âm ô chữ nhường chỗ cho thanh ghi âm ⇒ tìm khi cần, không tìm sẵn.
    get box() {
      return screen.getByLabelText("Nội dung khoản chi") as HTMLTextAreaElement;
    },
  };
}

afterEach(() => {
  cleanup();
  Object.assign(rec, { supported: true, state: "idle", error: null, onDone: null });
  Object.assign(sp, { supported: false, listening: false, errorCode: null, error: null, onText: null });
  vi.clearAllMocks();
});

describe("QuickEntryComposer — gõ chữ", () => {
  it("Enter ⇒ gửi chữ đã cắt khoảng trắng và xoá ô", () => {
    const { props, box } = setup();
    fireEvent.change(box, { target: { value: "  102LVT sơn 300k  " } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(props.onSubmitText).toHaveBeenCalledWith("102LVT sơn 300k");
    expect(box.value).toBe("");
  });

  it("Shift+Enter xuống dòng, không gửi; đang gõ bộ gõ (IME) cũng không gửi", () => {
    const { props, box } = setup();
    fireEvent.change(box, { target: { value: "bún bò 50k" } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    fireEvent.keyDown(box, { key: "Enter", isComposing: true });
    expect(props.onSubmitText).not.toHaveBeenCalled();
  });

  it("ô trống ⇒ nút gửi không có, chỉ có mic", () => {
    setup();
    expect(screen.queryByRole("button", { name: "Gửi" })).toBeNull();
    expect(screen.getByRole("button", { name: "Nói" })).toBeTruthy();
  });
});

describe("QuickEntryComposer — giọng nói (trình duyệt trước, máy chủ sau)", () => {
  it("trình duyệt có nhận giọng (Chrome) ⇒ dùng trình duyệt TRƯỚC, không ghi âm gửi máy chủ; chữ vào ô, không tự gửi", () => {
    sp.supported = true;
    const { props, box } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Nói" }));
    expect(sp.start).toHaveBeenCalledTimes(1);
    expect(rec.start).not.toHaveBeenCalled();
    act(() => sp.onText?.("keo hai mươi nghìn"));
    expect(box.value).toBe("keo hai mươi nghìn");
    expect(props.onSubmitText).not.toHaveBeenCalled();
    expect(props.transcribe).not.toHaveBeenCalled();
  });

  it("trình duyệt bị chặn hẳn (app màn hình chính iPhone: service-not-allowed) ⇒ lần chạm sau ghi âm gửi máy chủ", async () => {
    sp.supported = true;
    sp.errorCode = "service-not-allowed";
    const { props, box } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Nói" }));
    expect(sp.start).not.toHaveBeenCalled();
    expect(rec.start).toHaveBeenCalledTimes(1);
    await act(async () => rec.onDone?.(audio));
    expect(props.transcribe).toHaveBeenCalledWith(audio);
    expect(box.value).toBe("sơn ba trăm nghìn");
  });

  it("lời báo trình duyệt bị chặn hiện ngay; chạm mic lần sau (đi máy chủ) thì lời cũ biến mất", () => {
    sp.supported = true;
    sp.errorCode = "service-not-allowed";
    sp.error = "Trình duyệt không cho nhận giọng ở đây.";
    setup();
    expect(screen.getByRole("status").textContent).toContain("Trình duyệt không cho nhận giọng ở đây.");
    fireEvent.click(screen.getByRole("button", { name: "Nói" }));
    expect(rec.start).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Trình duyệt không cho nhận giọng ở đây.")).toBeNull();
  });

  it("trình duyệt đang nghe ⇒ có dòng báo 'Đang nghe' và nút dừng", () => {
    sp.supported = true;
    sp.listening = true;
    setup();
    expect(screen.getByText(/Đang nghe… nói xong sẽ tự dừng/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Dừng nghe" }));
    expect(sp.stop).toHaveBeenCalledTimes(1);
  });

  it("lỗi tạm của trình duyệt (no-speech) ⇒ vẫn dùng trình duyệt, không chuyển sang máy chủ", () => {
    sp.supported = true;
    sp.errorCode = "no-speech";
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Nói" }));
    expect(sp.start).toHaveBeenCalledTimes(1);
    expect(rec.start).not.toHaveBeenCalled();
  });

  it("trình duyệt không có nhận giọng ⇒ ghi âm gửi máy chủ; chữ vào ô để soát, KHÔNG tự gửi", async () => {
    const { props, box } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Nói" }));
    expect(rec.start).toHaveBeenCalledTimes(1);
    await act(async () => rec.onDone?.(audio));
    expect(props.transcribe).toHaveBeenCalledWith(audio);
    expect(box.value).toBe("sơn ba trăm nghìn");
    expect(props.onSubmitText).not.toHaveBeenCalled();
  });

  it("máy chủ lỗi ⇒ báo lỗi kèm gợi ý mic trên bàn phím", async () => {
    const transcribe = vi.fn(async (): Promise<TranscribeResult> => ({ ok: false, error: classifyAiError({ status: 503, code: "quick_entry_all_failed" }) }));
    setup({ transcribe });
    fireEvent.click(screen.getByRole("button", { name: "Nói" }));
    await act(async () => rec.onDone?.(audio));
    expect(screen.getByRole("status").textContent).toMatch(/Các mô hình AI đều đang lỗi.*micro trên bàn phím/);
  });

  it("trình duyệt bị chặn và máy chủ chưa dùng được (AI tắt) ⇒ gợi ý mic trên bàn phím", () => {
    sp.supported = true;
    sp.errorCode = "service-not-allowed";
    setup({ transcribe: null });
    fireEvent.click(screen.getByRole("button", { name: "Nói" }));
    expect(sp.start).not.toHaveBeenCalled();
    expect(rec.start).not.toHaveBeenCalled();
    expect(screen.getByText(/micro trên bàn phím/)).toBeTruthy();
  });

  it("không đường nào nhận giọng được ⇒ gợi ý mic trên bàn phím", () => {
    rec.supported = false;
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Nói" }));
    expect(screen.getByText(/micro trên bàn phím/)).toBeTruthy();
  });

  it("đang ghi âm ⇒ có nút Huỷ và Xong; Xong dừng ghi để gửi máy chủ", () => {
    rec.state = "recording";
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Xong" }));
    expect(rec.stop).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Huỷ ghi âm" }));
    expect(rec.cancel).toHaveBeenCalledTimes(1);
  });
});

describe("QuickEntryComposer — ảnh và chế độ", () => {
  it("chọn ảnh ⇒ gửi file cho trang cha", () => {
    const { props } = setup();
    const file = new File(["img"], "bill.jpg", { type: "image/jpeg" });
    fireEvent.change(screen.getByLabelText("Chọn ảnh bill"), { target: { files: [file] } });
    expect(props.onPhoto).toHaveBeenCalledWith(file);
  });

  it("dán ảnh vào ô chữ ⇒ đọc như ảnh bill", () => {
    const { props, box } = setup();
    const file = new File(["img"], "shot.png", { type: "image/png" });
    fireEvent.paste(box, { clipboardData: { files: [file], items: [] } });
    expect(props.onPhoto).toHaveBeenCalledWith(file);
  });

  it("có hai quyền ⇒ công tắc Công ty/Cá nhân; chỉ một quyền ⇒ không có công tắc", () => {
    const { props } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Cá nhân" }));
    expect(props.onModeChange).toHaveBeenCalledWith("personal");
    cleanup();
    setup({ modes: ["personal"], mode: "personal" });
    expect(screen.queryByRole("group", { name: "Ghi vào" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cá nhân" })).toBeNull();
  });
});
