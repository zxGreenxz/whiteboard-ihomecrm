// Gọi AI cho trang "Báo chi nhanh" qua hàm máy chủ riêng `quick-entry` (supabase/functions/quick-entry).
//
//   readWithAi      — chữ/ảnh ⇒ JSON (aiSchema) qua 9router. Non-stream; model do MÁY CHỦ chọn theo
//                     chuỗi dự phòng (gửi "quick_entry:auto"). Trả sai khuôn ⇒ thử lại MỘT lần với header
//                     `x-quick-entry-skip` để máy chủ nhảy sang mô hình kế; lỗi thuộc người dùng (tắt,
//                     hết lượt, không quyền) thì dừng ngay.
//   transcribeAudio — ghi âm ⇒ chữ (OpenRouter qua /audio/transcriptions, language "vi").
//
// `fetchImpl` là fetch đã gắn JWT + x-organization-id + x-copilot-feature (makeCopilotFetch) —
// truyền vào để test không cần mạng. AI hỏng KHÔNG chặn ghi chi: mọi lỗi trả về AiErrorView.

import { QUICK_ENTRY_BASE } from "@/copilot/copilotConfig";
import { parseAiResult, type AiResult } from "@/lib/quickEntry/aiSchema";
import { classifyAiError, type AiErrorView } from "@/lib/quickEntry/errors";
import type { ChatMessage } from "@/lib/quickEntry/prompt";
import type { AudioFormat } from "./useVoiceRecorder";

/** Đúng bằng TRAN_MAX_TOKENS của hàm máy chủ (có test giữ hai số khớp): mức suy nghĩ cao/tối đa tiêu
 *  token suy nghĩ trong cùng trần này, xin ít là JSON bị cụt giữa chừng. */
export const QUICK_ENTRY_MAX_TOKENS = 4000;
/** Âm thanh thô tối đa — đúng bằng TRAN_AM_THANH_BYTES của hàm máy chủ (có test giữ hai số khớp).
 *  Đủ cho 30 giây kể cả khi trình duyệt bỏ qua gợi ý bitrate của bộ ghi âm. */
export const MAX_AUDIO_BYTES = 560_000;
const AUDIO_TOO_LONG = "Đoạn ghi âm quá dài để gửi. Nói ngắn hơn rồi thử lại.";

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type AiRead = { ok: true; value: AiResult; model: string | null } | { ok: false; error: AiErrorView };
/** `model` = mô hình máy chủ báo đã chép (header) — hiện cho người dùng so sánh các mô hình. */
export type TranscribeResult = { ok: true; text: string; model: string | null } | { ok: false; error: AiErrorView };

const isAbort = (e: unknown) => (e as { name?: string } | null)?.name === "AbortError";

async function errorOf(res: Response): Promise<AiErrorView> {
  let code: string | null = null;
  try {
    const body = (await res.json()) as { error?: { code?: unknown } } | null;
    code = typeof body?.error?.code === "string" ? body.error.code : null;
  } catch {
    // thân lỗi không phải JSON ⇒ phân loại theo mã HTTP
  }
  return classifyAiError({ status: res.status, code });
}

export async function readWithAi(opts: {
  messages: ChatMessage[];
  categoryCount: number;
  fetchImpl: FetchLike;
  signal?: AbortSignal;
  /** Mô hình người dùng chọn (id 9router kèm mức); máy chủ tự kiểm danh sách, id lạ ⇒ chuỗi mặc định. */
  model?: string;
}): Promise<AiRead> {
  let skip: number | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const headers = new Headers({ "Content-Type": "application/json" });
    if (skip !== null) headers.set("x-quick-entry-skip", String(skip));
    let res: Response;
    try {
      res = await opts.fetchImpl(`${QUICK_ENTRY_BASE}/chat/completions`, {
        method: "POST",
        headers,
        signal: opts.signal,
        body: JSON.stringify({
          model: opts.model ?? "quick_entry:auto",
          messages: opts.messages,
          stream: false,
          max_tokens: QUICK_ENTRY_MAX_TOKENS,
          response_format: { type: "json_object" },
        }),
      });
    } catch (e) {
      if (isAbort(e)) throw e;
      return { ok: false, error: classifyAiError({ status: 0, code: null }) };
    }
    if (!res.ok) return { ok: false, error: await errorOf(res) };
    let content = "";
    try {
      const body = (await res.json()) as { choices?: Array<{ message?: { content?: unknown } }> } | null;
      content = String(body?.choices?.[0]?.message?.content ?? "");
    } catch {
      // thân không phải JSON ⇒ coi như trả sai khuôn
    }
    const parsed = parseAiResult(content, opts.categoryCount);
    if (parsed.ok) return { ok: true, value: parsed.value, model: res.headers.get("x-quick-entry-model") };
    skip = Number(res.headers.get("x-quick-entry-index") ?? 0) + 1;
  }
  return { ok: false, error: classifyAiError({ status: 500, code: null }) };
}

async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export async function transcribeAudio(opts: {
  audio: { blob: Blob; format: AudioFormat };
  fetchImpl: FetchLike;
  signal?: AbortSignal;
  /** Mô hình chép giọng người dùng chọn; máy chủ tự kiểm danh sách, id lạ ⇒ chuỗi mặc định. */
  model?: string;
}): Promise<TranscribeResult> {
  // Câu báo "quá lớn" mặc định nói về ảnh — ở đường giọng nói phải nói về đoạn ghi âm.
  const audioError = (e: AiErrorView): AiErrorView => (e.kind === "too_large" ? { ...e, message: AUDIO_TOO_LONG } : e);
  if (opts.audio.blob.size > MAX_AUDIO_BYTES) {
    return { ok: false, error: audioError(classifyAiError({ status: 413, code: "payload_too_large" })) };
  }
  const data = await toBase64(opts.audio.blob);
  let res: Response;
  try {
    res = await opts.fetchImpl(`${QUICK_ENTRY_BASE}/audio/transcriptions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: opts.signal,
      body: JSON.stringify({ format: opts.audio.format, data, language: "vi", ...(opts.model ? { model: opts.model } : {}) }),
    });
  } catch (e) {
    if (isAbort(e)) throw e;
    return { ok: false, error: classifyAiError({ status: 0, code: null }) };
  }
  if (!res.ok) return { ok: false, error: audioError(await errorOf(res)) };
  let text = "";
  try {
    const body = (await res.json()) as { text?: unknown } | null;
    text = String(body?.text ?? "").trim();
  } catch {
    // thân không phải JSON
  }
  return text
    ? { ok: true, text, model: res.headers.get("x-quick-entry-model") }
    : { ok: false, error: classifyAiError({ status: 500, code: null }) };
}
