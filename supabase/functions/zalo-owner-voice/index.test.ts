import { transcribe } from "./index.ts";
import assert from "node:assert/strict";

const token = "a".repeat(64);
const env = (k: string) => k === "HERMES_OWNER_VOICE_TOKEN" ? token : k === "QUICK_ENTRY_OPENROUTER_KEY" ? "provider-fixture" : undefined;
function request(token: string, model = "google/chirp-3", size = 16) {
  return new Request("https://example.test/zalo-owner-voice", { method: "POST", body: new Uint8Array(size),
    headers: { Authorization: "Bearer " + token, "x-audio-format": "ogg", "x-stt-model": model } });
}
Deno.test("only the worker can transcribe bounded audio with a supported model", async () => {
  const denied = () => { throw Error("unexpected provider request"); };
  assert.equal((await transcribe(request("anon"), env, denied)).status, 403);
  assert.equal((await transcribe(request("b".repeat(64)), env, denied)).status, 403);
  assert.equal((await transcribe(request(token), () => undefined, denied)).status, 403);
  assert.equal((await transcribe(request(token, "other/model"), env, denied)).status, 400);
  assert.equal((await transcribe(request(token, "google/chirp-3", 4194305), env, denied)).status, 413);
  for (const model of ["google/chirp-3", "elevenlabs/scribe-v2"]) {
    const result = await transcribe(request(token, model), env, async (url, init) => {
      assert.equal(url, "https://openrouter.ai/api/v1/audio/transcriptions");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer provider-fixture");
      assert.equal(init?.redirect, "error");
      assert.deepEqual(JSON.parse(String(init?.body)), { model, language: "vi", input_audio: { format: "ogg", data: "AAAAAAAAAAAAAAAAAAAAAA==" } });
      return Response.json({ text: "Chào bạn" });
    });
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), { text: "Chào bạn" });
  }
});
