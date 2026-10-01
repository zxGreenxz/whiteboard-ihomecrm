// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { RecordedAudio } from "@/hooks/quick-entry/useVoiceRecorder";
import type { TranscribeResult } from "@/hooks/quick-entry/quickEntryAi";
import { classifyAiError } from "@/lib/quickEntry/errors";

// Bộ ghi âm được thay bằng bản điều khiển tay: test giữ callback để "nói xong" khi muốn.
const rec = vi.hoisted(() => ({
  supported: true,
  state: "idle" as "idle" | "requesting" | "recording" | "error",
  error: null as string | null,
  onDone: null as ((a: RecordedAudio) => void) | null,
  start: vi.fn(),
  stop: vi.fn(),
  cancel: vi.fn(),
}));
vi.mock("@/hooks/quick-entry/useVoiceRecorder", () => ({
  MAX_RECORD_SECONDS: 30,
  useVoiceRecorder: (onDone: (a: RecordedAudio) => void) => {
    rec.onDone = onDone;
    return { supported: rec.supported, state: rec.state, seconds: 0, error: rec.error, start: rec.start, stop: rec.stop, cancel: rec.cancel };
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
    transcribe: vi.fn(async (): Promise<TranscribeResult> => ({ ok: true, text: "sơn ba trăm nghìn", model: null })),
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

describe("QuickEntryComposer — giọng nói (chỉ OpenRouter, chủ chốt 01/10)", () => {
  it("chạm mic ⇒ ghi âm; nói xong ⇒ OpenRouter chép chữ VÀO Ô để soát, KHÔNG tự gửi", async () => {
    const { props, box } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Nói" }));
    expect(rec.start).toHaveBeenCalledTimes(1);
    await act(async () => rec.onDone?.(audio));
    expect(props.transcribe).toHaveBeenCalledWith(audio);
    expect(box.value).toBe("sơn ba trăm nghìn");
    expect(props.onSubmitText).not.toHaveBeenCalled();
  });

  it("trình duyệt CÓ nhận giọng cũng không dùng — luôn ghi âm gửi OpenRouter", () => {
    const Fake = vi.fn();
    vi.stubGlobal("webkitSpeechRecognition", Fake);
    vi.stubGlobal("SpeechRecognition", Fake);
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Nói" }));
    expect(rec.start).toHaveBeenCalledTimes(1);
    expect(Fake).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("OpenRouter lỗi ⇒ báo lỗi kèm gợi ý mic trên bàn phím", async () => {
    const transcribe = vi.fn(async (): Promise<TranscribeResult> => ({ ok: false, error: classifyAiError({ status: 503, code: "quick_entry_all_failed" }) }));
    setup({ transcribe });
    fireEvent.click(screen.getByRole("button", { name: "Nói" }));
    await act(async () => rec.onDone?.(audio));
    expect(screen.getByRole("status").textContent).toMatch(/Các mô hình AI đều đang lỗi.*micro trên bàn phím/);
  });

  it("giọng nói tắt cho phiên (transcribe = null) ⇒ không ghi âm, gợi ý mic trên bàn phím", () => {
    setup({ transcribe: null });
    fireEvent.click(screen.getByRole("button", { name: "Nói" }));
    expect(rec.start).not.toHaveBeenCalled();
    expect(screen.getByText(/micro trên bàn phím/)).toBeTruthy();
  });

  it("máy không ghi âm được ⇒ gợi ý mic trên bàn phím", () => {
    rec.supported = false;
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Nói" }));
    expect(rec.start).not.toHaveBeenCalled();
    expect(screen.getByText(/micro trên bàn phím/)).toBeTruthy();
  });

  it("bị từ chối quyền micro ⇒ hiện lời báo của bộ ghi âm", () => {
    rec.error = "Bạn chưa cho phép dùng micro cho trang này.";
    setup();
    expect(screen.getByRole("status").textContent).toContain("Bạn chưa cho phép dùng micro");
  });

  it("đang ghi âm ⇒ có nút Huỷ và Xong; Xong dừng ghi để gửi OpenRouter", () => {
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

describe("QuickEntryComposer — chọn mô hình AI để so sánh", () => {
  const choice = { stt: "google/chirp-3", readModel: "cx/gpt-6-luna", effort: "low" };

  it("bấm 'Mô hình AI' mở 3 ô chọn; đổi ô nào báo đúng lựa chọn mới", () => {
    const onModelChoiceChange = vi.fn();
    setup({ modelChoice: choice, onModelChoiceChange });
    expect(screen.queryByLabelText("Mô hình giọng nói")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Mô hình AI/ }));
    fireEvent.change(screen.getByLabelText("Mô hình giọng nói"), { target: { value: "deepgram/nova-3" } });
    expect(onModelChoiceChange).toHaveBeenLastCalledWith({ ...choice, stt: "deepgram/nova-3" });
    fireEvent.change(screen.getByLabelText("Mô hình đọc chữ"), { target: { value: "cx/gpt-6.1-sol" } });
    expect(onModelChoiceChange).toHaveBeenLastCalledWith({ ...choice, readModel: "cx/gpt-6.1-sol" });
    fireEvent.change(screen.getByLabelText("Mức suy nghĩ"), { target: { value: "ultra" } });
    expect(onModelChoiceChange).toHaveBeenLastCalledWith({ ...choice, effort: "ultra" });
  });

  it("đủ 5 mô hình giọng nói + 'Mặc định' đứng đầu; mức 9router không nhận với mô hình đang chọn bị khoá", () => {
    setup({ modelChoice: { ...choice, readModel: "cx/gpt-6-astra" }, onModelChoiceChange: vi.fn() });
    fireEvent.click(screen.getByRole("button", { name: /Mô hình AI/ }));
    const stt = screen.getByLabelText("Mô hình giọng nói") as HTMLSelectElement;
    expect(stt.options).toHaveLength(6);
    expect(stt.options[0].value).toBe("");
    const minimal = [...(screen.getByLabelText("Mức suy nghĩ") as HTMLSelectElement).options].find((o) => o.value === "minimal");
    expect(minimal?.disabled).toBe(true);
  });

  it("đổi sang mô hình không nhận mức đang chọn ⇒ mức về mặc định", () => {
    const onModelChoiceChange = vi.fn();
    setup({ modelChoice: { ...choice, effort: "minimal" }, onModelChoiceChange });
    fireEvent.click(screen.getByRole("button", { name: /Mô hình AI/ }));
    fireEvent.change(screen.getByLabelText("Mô hình đọc chữ"), { target: { value: "cx/gpt-6-astra" } });
    expect(onModelChoiceChange).toHaveBeenLastCalledWith({ ...choice, readModel: "cx/gpt-6-astra", effort: "low" });
  });

  it("chép giọng xong ⇒ hiện tên mô hình ĐÃ chép (để so sánh)", async () => {
    const transcribe = vi.fn(async (): Promise<TranscribeResult> => ({ ok: true, text: "bún bò 50k", model: "deepgram/nova-3" }));
    setup({ transcribe, modelChoice: choice, onModelChoiceChange: vi.fn() });
    await act(async () => {
      rec.onDone?.(audio);
    });
    expect(screen.getByText(/Chép bằng Deepgram Nova 3/)).toBeTruthy();
  });

  it("chưa chọn mô hình đọc (máy chủ chọn) ⇒ nhãn ghi 'mặc định', ô mức suy nghĩ bị khoá", () => {
    setup({ modelChoice: { stt: "", readModel: "", effort: "low" }, onModelChoiceChange: vi.fn() });
    const nut = screen.getByRole("button", { name: /Mô hình AI/ });
    expect(nut.textContent).toBe("Mô hình AI: mặc định · mặc định");
    fireEvent.click(nut);
    const read = screen.getByLabelText("Mô hình đọc chữ") as HTMLSelectElement;
    // Thiếu lựa chọn "" thì React tự hiện mô hình đầu danh sách trong khi máy chủ mới là bên chọn.
    expect(read.value).toBe("");
    expect(read.options[0].textContent).toBe("Mặc định (máy chủ chọn)");
    expect((screen.getByLabelText("Mức suy nghĩ") as HTMLSelectElement).disabled).toBe(true);
  });

  it("chạm vào ô nhập ⇒ bảng chọn tự thu gọn (bàn phím điện thoại không che hết thẻ)", () => {
    const { box } = setup({ modelChoice: choice, onModelChoiceChange: vi.fn() });
    fireEvent.click(screen.getByRole("button", { name: /Mô hình AI/ }));
    expect(screen.getByLabelText("Mô hình giọng nói")).toBeTruthy();
    fireEvent.focus(box);
    expect(screen.queryByLabelText("Mô hình giọng nói")).toBeNull();
  });

  it("không truyền lựa chọn mô hình ⇒ không có nút Mô hình AI", () => {
    setup();
    expect(screen.queryByRole("button", { name: /Mô hình AI/ })).toBeNull();
  });
});
