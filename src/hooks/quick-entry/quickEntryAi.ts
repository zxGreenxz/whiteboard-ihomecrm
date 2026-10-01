// Gọi AI cho trang "Báo chi nhanh" qua llm-proxy (feature `quick_entry`).
//
//   readWithAi      — chữ/ảnh ⇒ JSON (aiSchema). Non-stream; model do MÁY CHỦ chọn theo chuỗi dự
//                     phòng (gửi "quick_entry:auto"). Trả sai khuôn ⇒ thử lại MỘT lần với header
//                     `x-quick-entry-skip` để proxy nhảy sang mô hình kế; lỗi thuộc người dùng (tắt,
//                     hết lượt, không quyền) thì dừng ngay.
//   transcribeAudio — ghi âm ⇒ chữ (OpenRouter qua /audio/transcriptions, language "vi").
//
// `fetchImpl` là fetch đã gắn JWT + x-organization-id + x-copilot-feature (makeCopilotFetch) —
// truyền vào để test không cần mạng. AI hỏng KHÔNG chặn ghi chi: mọi lỗi trả về AiErrorView.

import { LLM_PROXY_BASE } from "@/copilot/copilotConfig";
import { parseAiResult, type AiResult } from "@/lib/quickEntry/aiSchema";
import { classifyAiError, type AiErrorView } from "@/lib/quickEntry/errors";
import type { ChatMessage } from "@/lib/quickEntry/prompt";
import type { AudioFormat } from "./useVoiceRecorder";

export const QUICK_ENTRY_MAX_TOKENS = 1500;
/** Âm thanh thô tối đa (~30 giây webm/mp4) — base64 vẫn dưới trần body 512 KiB của proxy. */
export const MAX_AUDIO_BYTES = 400_000;

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type AiRead = { ok: true; value: AiResult; model: string | null } | { ok: false; error: AiErrorView };
export type TranscribeResult = { ok: true; text: string } | { ok: false; error: AiErrorView };

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
}): Promise<AiRead> {
  let skip: number | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const headers = new Headers({ "Content-Type": "application/json" });
    if (skip !== null) headers.set("x-quick-entry-skip", String(skip));
    let res: Response;
    try {
      res = await opts.fetchImpl(`${LLM_PROXY_BASE}/chat/completions`, {
        method: "POST",
        headers,
        signal: opts.signal,
        body: JSON.stringify({
          model: "quick_entry:auto",
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
}): Promise<TranscribeResult> {
  if (opts.audio.blob.size > MAX_AUDIO_BYTES) {
    return { ok: false, error: classifyAiError({ status: 413, code: "payload_too_large" }) };
  }
  const data = await toBase64(opts.audio.blob);
  let res: Response;
  try {
    res = await opts.fetchImpl(`${LLM_PROXY_BASE}/audio/transcriptions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: opts.signal,
      body: JSON.stringify({ format: opts.audio.format, data, language: "vi" }),
    });
  } catch (e) {
    if (isAbort(e)) throw e;
    return { ok: false, error: classifyAiError({ status: 0, code: null }) };
  }
  if (!res.ok) return { ok: false, error: await errorOf(res) };
  let text = "";
  try {
    const body = (await res.json()) as { text?: unknown } | null;
    text = String(body?.text ?? "").trim();
  } catch {
    // thân không phải JSON
  }
  return text ? { ok: true, text } : { ok: false, error: classifyAiError({ status: 500, code: null }) };
}
