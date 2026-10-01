import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHOICE,
  READ_EFFORTS,
  READ_MODELS,
  READ_UNSUPPORTED,
  STT_OPTIONS,
  loadChoice,
  modelLabel,
  normalizeChoice,
  readModelId,
  saveChoice,
} from "../models";

const server = readFileSync(new URL("../../../../supabase/functions/quick-entry/index.ts", import.meta.url), "utf8");
const serverList = (name: string): string[] => {
  const m = new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\];`).exec(server);
  if (!m) throw new Error(`không thấy ${name} trong mã máy chủ`);
  return [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]);
};

describe("danh sách ô chọn khớp danh sách cho phép của hàm máy chủ quick-entry", () => {
  it("giọng nói, mô hình đọc, mức suy nghĩ, tổ hợp không hỗ trợ — y hệt", () => {
    expect(STT_OPTIONS.map((o) => o.id)).toEqual(serverList("STT_CHOICES"));
    expect(READ_MODELS.map((o) => o.id)).toEqual(serverList("READ_MODEL_CHOICES"));
    expect(READ_EFFORTS.map((o) => o.id)).toEqual(serverList("READ_EFFORTS"));
    expect([...READ_UNSUPPORTED]).toEqual(serverList("READ_UNSUPPORTED"));
  });

  it("mặc định của trang là mô hình đầu chuỗi mặc định của máy chủ", () => {
    expect(DEFAULT_CHOICE.stt).toBe(serverList("STT_MODELS_MAC_DINH")[0]);
    expect(readModelId(DEFAULT_CHOICE)).toBe(serverList("READ_MODELS_MAC_DINH")[0]);
  });
});

describe("readModelId / normalizeChoice", () => {
  it("mức tự động ⇒ id gốc; có mức ⇒ hậu tố (mức) như 9router", () => {
    expect(readModelId({ readModel: "cx/gpt-6.1-sol", effort: "" })).toBe("cx/gpt-6.1-sol");
    expect(readModelId({ readModel: "cx/gpt-6.1-sol", effort: "high" })).toBe("cx/gpt-6.1-sol(high)");
  });

  it("lựa chọn hỏng/cũ ⇒ mặc định; hợp lệ ⇒ giữ nguyên", () => {
    expect(normalizeChoice(null)).toEqual(DEFAULT_CHOICE);
    expect(normalizeChoice({ stt: "openai/gpt-4o-transcribe", readModel: "cx/gpt-reserve", effort: "turbo" })).toEqual(DEFAULT_CHOICE);
    const ok = { stt: "deepgram/nova-3", readModel: "cx/gpt-6-astra", effort: "ultra" };
    expect(normalizeChoice(ok)).toEqual(ok);
  });

  it("tổ hợp 9router không nhận (Astra + minimal) ⇒ đưa mức về mặc định, giữ mô hình", () => {
    expect(normalizeChoice({ stt: "google/chirp-3", readModel: "cx/gpt-6-astra", effort: "minimal" })).toEqual({
      stt: "google/chirp-3",
      readModel: "cx/gpt-6-astra",
      effort: DEFAULT_CHOICE.effort,
    });
  });
});

describe("modelLabel — tên dễ đọc cho mô hình máy chủ báo đã trả lời", () => {
  it("giọng nói, đọc + mức, id có tiền tố nhà cung cấp, id lạ", () => {
    expect(modelLabel("google/chirp-3")).toBe("Google Chirp 3");
    expect(modelLabel("cx/gpt-6-luna(low)")).toBe("GPT-6 Luna · thấp");
    expect(modelLabel("cx/gpt-6.1-sol")).toBe("GPT-6.1 Sol · tự động");
    expect(modelLabel("9router:cx/gpt-6-luna(low)")).toBe("GPT-6 Luna · thấp");
    expect(modelLabel("x/y")).toBe("x/y");
    expect(modelLabel(null)).toBe("");
  });
});

describe("loadChoice / saveChoice — nhớ theo người dùng trên máy", () => {
  it("lưu rồi đọc lại; người khác không thấy; chưa đăng nhập ⇒ mặc định", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    const choice = { stt: "openai/whisper-1", readModel: "cx/gpt-6-sol", effort: "medium" };
    saveChoice("u1", choice, storage);
    expect(loadChoice("u1", storage)).toEqual(choice);
    expect(loadChoice("u2", storage)).toEqual(DEFAULT_CHOICE);
    expect(loadChoice(null, storage)).toEqual(DEFAULT_CHOICE);
  });

  it("bộ nhớ trình duyệt hỏng/bị chặn ⇒ mặc định, không ném lỗi", () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(loadChoice("u1", broken)).toEqual(DEFAULT_CHOICE);
    expect(() => saveChoice("u1", DEFAULT_CHOICE, broken)).not.toThrow();
  });
});
