import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/copilot/copilotConfig", () => ({
  QUICK_ENTRY_BASE: "https://proxy.test/functions/v1/quick-entry",
}));

import { MAX_AUDIO_BYTES, readWithAi, transcribeAudio } from "../quickEntryAi";

const good = JSON.stringify({ items: [{ desc: "bóng đèn", amount_vnd: 120_000, category: "c1", confidence: 0.9 }] });
const completion = (content: string) => ({ choices: [{ message: { content } }] });
const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const messages = [{ role: "user" as const, content: "mua bóng đèn 120k" }];

describe("readWithAi", () => {
  it("gửi đúng đường, ép non-stream + JSON, model do máy chủ chọn; đọc được ⇒ ok", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, completion(good), { "x-quick-entry-model": "9router:cx/gpt-6-luna(low)" }));
    const r = await readWithAi({ messages, categoryCount: 3, fetchImpl });
    expect(r.ok).toBe(true);
    expect(("value" in r ? r.value.items[0].amount_vnd : null)).toBe(120_000);
    expect(("model" in r ? r.model : null)).toBe("9router:cx/gpt-6-luna(low)");
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://proxy.test/functions/v1/quick-entry/chat/completions");
    expect(JSON.parse(init.body)).toMatchObject({ model: "quick_entry:auto", stream: false, response_format: { type: "json_object" } });
  });

  it("trả sai khuôn ⇒ thử lại MỘT lần với mô hình kế (skip = index + 1)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, completion("xin lỗi"), { "x-quick-entry-index": "0" }))
      .mockResolvedValueOnce(jsonResponse(200, completion(good), { "x-quick-entry-index": "1" }));
    const r = await readWithAi({ messages, categoryCount: 3, fetchImpl });
    expect(r.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(new Headers(fetchImpl.mock.calls[1][1].headers).get("x-quick-entry-skip")).toBe("1");
  });

  it("hai lần đều sai khuôn ⇒ báo 'chưa đọc được', không thử lần ba", async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementation(async () => jsonResponse(200, completion("Không đọc được ảnh."), { "x-quick-entry-index": "0" }));
    const r = await readWithAi({ messages, categoryCount: 3, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(r.ok).toBe(false);
  });

  it("AI bị tắt ⇒ trả trạng thái 'disabled', không thử lại", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(403, { error: { code: "quick_entry_disabled", message: "x" } }));
    const r = await readWithAi({ messages, categoryCount: 3, fetchImpl });
    expect(r.ok).toBe(false);
    expect(("error" in r ? r.error.kind : null)).toBe("disabled");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("có mô hình người dùng chọn ⇒ gửi đúng id đó (máy chủ tự kiểm danh sách); không có ⇒ quick_entry:auto", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => jsonResponse(200, completion(good)));
    await readWithAi({ messages, categoryCount: 3, fetchImpl, model: "cx/gpt-6.1-sol(high)" });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).model).toBe("cx/gpt-6.1-sol(high)");
    await readWithAi({ messages, categoryCount: 3, fetchImpl });
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body).model).toBe("quick_entry:auto");
  });

  it("mất mạng ⇒ 'network'", async () => {
    const fetchImpl = vi.fn().mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const r = await readWithAi({ messages, categoryCount: 3, fetchImpl });
    expect(("error" in r ? r.error.kind : null)).toBe("network");
  });
});

describe("transcribeAudio", () => {
  const audio = (bytes: number) => ({ blob: new Blob([new Uint8Array(bytes)], { type: "audio/mp4" }), format: "mp4" as const });

  it("gửi base64 + định dạng + language vi tới /audio/transcriptions; trả bản chữ", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { text: "mua bóng đèn một trăm hai mươi nghìn" }));
    const r = await transcribeAudio({ audio: audio(3), fetchImpl });
    expect(r).toEqual({ ok: true, text: "mua bóng đèn một trăm hai mươi nghìn", model: null });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://proxy.test/functions/v1/quick-entry/audio/transcriptions");
    expect(JSON.parse(init.body)).toEqual({ format: "mp4", data: "AAAA", language: "vi" });
  });

  it("gửi kèm mô hình người dùng chọn; trả về mô hình THẬT đã chép (header) để hiện cho người dùng so sánh", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { text: "bún bò 50k" }, { "x-quick-entry-model": "deepgram/nova-3" }));
    const r = await transcribeAudio({ audio: audio(3), fetchImpl, model: "openai/whisper-1" });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toMatchObject({ model: "openai/whisper-1" });
    expect(r).toEqual({ ok: true, text: "bún bò 50k", model: "deepgram/nova-3" });
  });

  it(`âm thanh quá ${MAX_AUDIO_BYTES} byte ⇒ 'too_large', không gửi`, async () => {
    const fetchImpl = vi.fn();
    const r = await transcribeAudio({ audio: audio(MAX_AUDIO_BYTES + 1), fetchImpl });
    expect(("error" in r ? r.error.kind : null)).toBe("too_large");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("quá cỡ — ở máy hay do máy chủ báo — câu báo nói về ghi âm, không nói về ảnh", async () => {
    const local = await transcribeAudio({ audio: audio(MAX_AUDIO_BYTES + 1), fetchImpl: vi.fn() });
    const server = await transcribeAudio({
      audio: audio(3),
      fetchImpl: vi.fn().mockResolvedValueOnce(jsonResponse(413, { error: { code: "payload_too_large" } })),
    });
    for (const r of [local, server]) {
      const message = "error" in r ? r.error.message : "";
      expect(message).toMatch(/ghi âm/i);
      expect(message).not.toMatch(/ảnh/i);
    }
  });

  it("trần âm thanh của trang đúng bằng trần của hàm máy chủ", () => {
    const server = readFileSync(new URL("../../../../supabase/functions/quick-entry/index.ts", import.meta.url), "utf8");
    const m = server.match(/export const TRAN_AM_THANH_BYTES = ([\d_]+);/);
    expect(m).not.toBeNull();
    expect(Number(m![1].replace(/_/g, ""))).toBe(MAX_AUDIO_BYTES);
  });

  it("máy chủ báo hết lượt ⇒ 'daily_cap'; trả chữ rỗng ⇒ 'unknown'", async () => {
    const capped = vi.fn().mockResolvedValueOnce(jsonResponse(403, { error: { code: "quick_entry_daily_cap" } }));
    expect(await transcribeAudio({ audio: audio(3), fetchImpl: capped })).toMatchObject({ ok: false, error: { kind: "daily_cap" } });
    const empty = vi.fn().mockResolvedValueOnce(jsonResponse(200, { text: "  " }));
    expect(await transcribeAudio({ audio: audio(3), fetchImpl: empty })).toMatchObject({ ok: false, error: { kind: "unknown" } });
  });
});
