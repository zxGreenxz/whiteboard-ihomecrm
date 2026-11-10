import { spawn } from "node:child_process";
import { z } from "zod";
import { LiveError } from "./cameraLive.js";
import { ports } from "./cameraLivePorts.js";

/** Longest wait for a first decoded picture: one key-frame interval of a sub stream, with margin. */
export const LIVE_DECODE_WAIT_MS = 10_000;
const DECODABLE_MS = 10 * 60_000;
const UNDECODABLE_MS = 30_000;
/** Below this the recorder sent no real video during the wait: an unavailable camera, not an undecodable one. */
const MEDIA_BYTES = 16_384;

/**
 * A recorder with stream encryption switched on answers RTSP normally and then sends video nobody can decode:
 * MediaMTX reports the source as ready, WHEP answers 201 and the viewer waits on a black tile. Decoding one frame
 * here is the only proof. Encryption is recorder-wide, so one decoded frame clears every channel of that recorder
 * for a while and concurrent starts share one decoder process; a refusal is remembered per stream only.
 * The decoder reads a loopback URL: no credential reaches its arguments.
 */
export function liveDecodeCheck(encoder: string, request: typeof fetch, now: () => number = Date.now) {
  const decodable = new Map<string, number>();
  const undecodable = new Map<string, number>();
  const running = new Map<string, Promise<boolean | undefined>>();
  const decodes = (name: string) => new Promise<boolean>((resolve) => {
    const child = spawn(encoder, ["-hide_banner", "-loglevel", "error", "-nostdin", "-threads", "1", "-rtsp_transport", "tcp", "-timeout", "5000000", "-i", `rtsp://127.0.0.1:${ports.rtsp}/${name}`, "-an", "-frames:v", "1", "-f", "null", "-"], { stdio: "ignore" });
    const timer = setTimeout(() => child.kill("SIGKILL"), LIVE_DECODE_WAIT_MS);
    child.once("error", () => { clearTimeout(timer); resolve(false); });
    // Wait for exit before answering, so a refused viewer never leaves a decoder behind.
    child.once("close", (code) => { clearTimeout(timer); resolve(code === 0); });
  });
  const receiving = async (name: string) => {
    try {
      const response = await request(`http://127.0.0.1:${ports.api}/v3/paths/get/${name}`, { redirect: "error", signal: AbortSignal.timeout(2000) });
      if (!response.ok) { await response.body?.cancel(); return false; }
      return z.object({ inboundBytes: z.number() }).parse(await response.json()).inboundBytes >= MEDIA_BYTES;
    } catch { return false; }
  };
  /** Resolves when the stream may be offered; throws LIVE_STREAM_UNDECODABLE when video arrives but no frame decodes. */
  return async function assertDecodable(recorderId: string, name: string): Promise<void> {
    if ((decodable.get(recorderId) ?? 0) > now()) return;
    if ((undecodable.get(name) ?? 0) > now()) throw new LiveError(502, "LIVE_STREAM_UNDECODABLE");
    let probe = running.get(recorderId);
    if (!probe) {
      probe = (async () => {
        if (await decodes(name)) { decodable.set(recorderId, now() + DECODABLE_MS); return true; }
        // No decoded frame from a recorder that is not sending video is the ordinary CAMERA_UNAVAILABLE path.
        if (!await receiving(name)) return undefined;
        for (const [key, until] of undecodable) if (until <= now()) undecodable.delete(key);
        undecodable.set(name, now() + UNDECODABLE_MS); return false;
      })().finally(() => running.delete(recorderId));
      running.set(recorderId, probe);
    }
    if (await probe === false) throw new LiveError(502, "LIVE_STREAM_UNDECODABLE");
  };
}
