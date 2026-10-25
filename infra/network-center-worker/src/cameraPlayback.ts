import { randomUUID } from "node:crypto";
import { z } from "zod";
import { LiveError, type LiveRecorder } from "./cameraLive.js";

export const playbackSpeeds = [1, 2, 4, 6, 8] as const;
export const playbackSpeedSchema = z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(6), z.literal(8)]);
export const playbackQualitySchema = z.enum(["sd", "hd"]);
const rangeSchema = z.object({ start: z.string().datetime({ offset: true }), end: z.string().datetime({ offset: true }), speed: playbackSpeedSchema.optional(), quality: playbackQualitySchema.optional() }).strict();
export interface PlaybackRange { start: string; end: string; speed?: number; quality?: "sd" | "hd" }
export function playbackRange(value: unknown, now = Date.now()): PlaybackRange {
  const parsed = rangeSchema.safeParse(value);
  if (!parsed.success) throw new LiveError(400, "INVALID_PLAYBACK_RANGE");
  const start = Date.parse(parsed.data.start); const end = Date.parse(parsed.data.end);
  if (start < Date.UTC(2000, 0, 1) || end <= start || end > now || end - start > 86400_000 || start % 1000 || end % 1000) throw new LiveError(400, "INVALID_PLAYBACK_RANGE");
  return { start: new Date(start).toISOString(), end: new Date(end).toISOString(), ...(parsed.data.speed === undefined ? {} : { speed: parsed.data.speed }), ...(parsed.data.quality === undefined ? {} : { quality: parsed.data.quality }) };
}
const deviceTime = (iso: string) => new Date(Date.parse(iso) + 7 * 3600_000).toISOString().slice(0, 19).replace(/[-:T]/gu, "_");
const api = "http://127.0.0.1:18897/v3/config/paths";

/** Credentials travel only to the loopback media API; never to the browser or argv. */
export function playbackSources(request: typeof fetch, fatal: () => void, encoder?: string) {
  if (encoder && !/^\/opt\/ihome-camera-live\/releases\/[a-f0-9]{40}\/ffmpeg$/u.test(encoder)) throw new Error("PLAYBACK_ENCODER_INVALID");
  const inputs = new Map<string, string>();
  const deletePath = async (name: string) => {
    try {
      const response = await request(`${api}/delete/${name}`, { method: "DELETE", redirect: "error", signal: AbortSignal.timeout(3000) });
      await response.body?.cancel();
      if (![200, 404].includes(response.status)) throw new Error("cleanup");
    } catch { fatal(); throw new LiveError(502, "MEDIA_CLEANUP_FAILED"); }
  };
  const remove = async (name: string) => {
    // Removing the output terminates its on-demand encoder before removing its input.
    await deletePath(name);
    const input = inputs.get(name);
    if (input) { await deletePath(input); inputs.delete(name); }
  };
  const addPath = async (name: string, body: Record<string, unknown>) => {
    const response = await request(`${api}/add/${name}`, { method: "POST", headers: { "Content-Type": "application/json" }, redirect: "error", signal: AbortSignal.timeout(3000), body: JSON.stringify(body) });
    await response.body?.cancel();
    if (response.status !== 200) throw new LiveError(502, "RECORDING_UNAVAILABLE");
  };
  return {
    remove,
    async add(recorder: LiveRecorder, channel: number, range: PlaybackRange) {
      if (range.quality && !encoder) throw new LiveError(503, "PLAYBACK_QUALITY_UNAVAILABLE");
      const name = `playback-${randomUUID()}`;
      const input = range.quality ? name.replace("playback-", "playback-source-") : name;
      if (range.quality) inputs.set(name, input);
      const source = new URL("/cam/playback", recorder.rtspOrigin);
      source.username = recorder.username; source.password = recorder.password;
      source.search = new URLSearchParams({ channel: String(channel), subtype: "0", starttime: deviceTime(range.start), endtime: deviceTime(range.end) }).toString();
      try {
        await addPath(input, { source: source.href, sourceOnDemand: true, sourceOnDemandStartTimeout: "8s", sourceOnDemandCloseAfter: "1s", rtspTransport: "tcp", ...(range.speed && range.speed !== 1 ? { rtspScale: String(range.speed) } : {}), record: false, maxReaders: 1 });
        if (range.quality && encoder) {
          const [width, height, bitrate] = range.quality === "sd" ? [854, 480, "900k"] : [1280, 720, "1800k"];
          // Fast playback only supplies sparse frames; every frame must be independently decodable
          // so joining a new WHEP session doesn't wait many seconds for the next keyframe.
          const keyframeInterval = (range.speed ?? 1) > 1 ? "1" : "25";
          // Only generated UUIDs, a verified binary path and fixed options enter this command.
          // Accelerated recorder RTCP makes FFmpeg source PTS jump backwards. Use receive-clock
          // timestamps for browser playout; the UI estimates source time using the selected speed.
          // The recorder clock burned into each frame stays unchanged.
          const command = [encoder, "-hide_banner", "-loglevel", "error", "-nostdin", "-threads", "1", "-filter_threads", "1", "-rtsp_transport", "tcp", "-timeout", "10000000", "-probesize", "262144", "-analyzeduration", "200000", "-i", `rtsp://127.0.0.1:18895/${input}`, "-an", "-c:v", "libx264", "-threads", "1", "-preset", "ultrafast", "-tune", "zerolatency", "-crf", "28", "-maxrate", String(bitrate), "-bufsize", String(bitrate), "-pix_fmt", "yuv420p", "-g", keyframeInterval, "-vf", `setpts=(RTCTIME-RTCSTART)/(TB*1000000),scale=w='min(${width},iw)':h='min(${height},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`, "-fps_mode", "passthrough", "-enc_time_base", "1:90000", "-f", "rtsp", "-rtsp_transport", "tcp", "-muxdelay", "0.05", `rtsp://127.0.0.1:18895/${name}`].map((arg) => `'${arg.replace(/'/gu, `'\\''`)}'`).join(" ");
          await addPath(name, { source: "publisher", runOnDemand: command, runOnDemandRestart: false, runOnDemandStartTimeout: "10s", runOnDemandCloseAfter: "1s", record: false, maxReaders: 1 });
        }
        return name;
      } catch (error) { await remove(name); throw error; }
    },
  };
}
