import { timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";

const formats = new Set(["mp3", "m4a", "aac", "ogg", "wav", "webm"]);
const models = new Set(["google/chirp-3", "elevenlabs/scribe-v2"]);
const maxBytes = 4 * 1024 * 1024;

/** Server-to-server STT only. The native worker verifies the paired owner before sending any audio. */
export async function transcribe(req: Request, env = (k: string) => Deno.env.get(k), send: typeof fetch = fetch) {
  if (req.method !== "POST") return new Response(null, { status: 405 });
  const expected = env("HERMES_OWNER_VOICE_TOKEN");
  const actual = Buffer.from(req.headers.get("authorization") ?? "");
  const server = Buffer.from("Bearer " + (expected ?? ""));
  if (!expected || !/^[a-f0-9]{64}$/.test(expected) || actual.length !== server.length || !timingSafeEqual(actual, server)) return new Response(null, { status: 403 });
  const format = req.headers.get("x-audio-format") ?? "";
  const model = req.headers.get("x-stt-model") ?? "";
  if (!formats.has(format) || !models.has(model)) return new Response(null, { status: 400 });
  const key = env("QUICK_ENTRY_OPENROUTER_KEY");
  if (!key) return new Response(null, { status: 503 });
  if (Number(req.headers.get("content-length")) > maxBytes) return new Response(null, { status: 413 });
  const reader = req.body?.getReader();
  if (!reader) return new Response(null, { status: 400 });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) { await reader.cancel(); return new Response(null, { status: 413 }); }
      chunks.push(value);
    }
  } catch { return new Response(null, { status: 400 }); }
  finally { reader.releaseLock(); }
  if (!length) return new Response(null, { status: 400 });
  try {
    const result = await send("https://openrouter.ai/api/v1/audio/transcriptions", {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(35_000),
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ model, language: "vi", input_audio: { format, data: Buffer.concat(chunks, length).toString("base64") } }),
    });
    if (!result.ok) { await result.body?.cancel(); return new Response(null, { status: 502 }); }
    const data = await result.json();
    return typeof data?.text === "string" && data.text.trim() && Buffer.byteLength(data.text) <= 8192
      ? Response.json({ text: data.text.trim() }, { headers: { "cache-control": "no-store" } })
      : new Response(null, { status: 422 });
  } catch { return new Response(null, { status: 502 }); }
}

if (import.meta.main) Deno.serve((req) => transcribe(req));
