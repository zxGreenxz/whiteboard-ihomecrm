import { randomUUID } from "node:crypto";
import { z } from "zod";
import { LiveError, type LiveRecorder } from "./cameraLive.js";

export const playbackSpeeds = [1, 2, 4, 6, 8] as const;
export const playbackSpeedSchema = z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(6), z.literal(8)]);
export const playbackQualitySchema = z.enum(["sd", "hd", "fullhd", "original"]);
export type PlaybackQuality = z.infer<typeof playbackQualitySchema>;
const rangeSchema = z.object({ start: z.string().datetime({ offset: true }), end: z.string().datetime({ offset: true }), position: z.string().datetime({ offset: true }).optional(), speed: playbackSpeedSchema.optional(), quality: playbackQualitySchema.optional() }).strict();
export interface PlaybackRange { start: string; end: string; position?: string; speed?: number; quality?: PlaybackQuality }
export function playbackRange(value: unknown, now = Date.now()): PlaybackRange {
  const parsed = rangeSchema.safeParse(value);
  if (!parsed.success) throw new LiveError(400, "INVALID_PLAYBACK_RANGE");
  const start = Date.parse(parsed.data.start); const end = Date.parse(parsed.data.end);
  const position = parsed.data.position ? Date.parse(parsed.data.position) : start;
  if (start < Date.UTC(2000, 0, 1) || end <= start || end > now || end - start > 86400_000 || start % 1000 || end % 1000 || position % 1000 || position < start || position >= end) throw new LiveError(400, "INVALID_PLAYBACK_RANGE");
  return { start: new Date(start).toISOString(), end: new Date(end).toISOString(), ...(parsed.data.position ? { position: new Date(position).toISOString() } : {}), ...(parsed.data.speed === undefined ? {} : { speed: parsed.data.speed }), ...(parsed.data.quality === undefined ? {} : { quality: parsed.data.quality }) };
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
    async control(name: string, offset: number, speed: number, signal: AbortSignal) {
      const input = inputs.get(name);
      if (!input) throw new LiveError(409, "PLAYBACK_CONTROL_UNAVAILABLE");
      const revision = randomUUID();
      const bounded = AbortSignal.any([signal, AbortSignal.timeout(4000)]);
      const response = await request(`${api}/patch/${input}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, redirect: "error", signal: bounded,
        body: JSON.stringify({ rtspRangeType: "npt", rtspRangeStart: `${offset}s`, rtspScale: speed === 1 ? "" : String(speed), rtspPlaybackRevision: revision }) });
      await response.body?.cancel();
      if (!response.ok) throw new LiveError(502, "PLAYBACK_CONTROL_FAILED");
      // Config acceptance is asynchronous. Acknowledge only after the recorder accepted PLAY.
      while (!bounded.aborted) {
        const status = await request(`http://127.0.0.1:18897/v3/paths/static-sources/get/${input}`, { redirect: "error", signal: bounded });
        if (!status.ok) { await status.body?.cancel(); throw new LiveError(502, "PLAYBACK_CONTROL_FAILED"); }
        const info = z.object({ typeSpecific: z.object({ playbackRevision: z.string().optional() }).nullable().optional() }).parse(await status.json());
        if (info.typeSpecific?.playbackRevision === revision) return;
        await new Promise<void>((resolve) => { const timer = setTimeout(done, 25); function done() { clearTimeout(timer); bounded.removeEventListener("abort", done); resolve(); } bounded.addEventListener("abort", done, { once: true }); });
      }
      throw new LiveError(502, "PLAYBACK_CONTROL_FAILED");
    },
    async add(recorder: LiveRecorder, channel: number, range: PlaybackRange, thumbnail = false) {
      if (range.quality && !encoder) throw new LiveError(503, "PLAYBACK_QUALITY_UNAVAILABLE");
      const name = `playback-${randomUUID()}`;
      const input = range.quality ? name.replace("playback-", "playback-source-") : name;
      if (range.quality) inputs.set(name, input);
      const source = new URL("/cam/playback", recorder.rtspOrigin);
      source.username = recorder.username; source.password = recorder.password;
      source.search = new URLSearchParams({ channel: String(channel), subtype: "0", starttime: deviceTime(range.start), endtime: deviceTime(range.end) }).toString();
      try {
        await addPath(input, { source: source.href, sourceOnDemand: true, sourceOnDemandStartTimeout: "8s", sourceOnDemandCloseAfter: "1s", rtspTransport: "tcp", ...(range.quality || thumbnail ? { rtspPlaybackRevision: randomUUID() } : {}), ...(range.position ? { rtspRangeType: "npt", rtspRangeStart: `${(Date.parse(range.position) - Date.parse(range.start)) / 1000}s` } : {}), ...(range.speed && range.speed !== 1 ? { rtspScale: String(range.speed) } : {}), record: false, maxReaders: 1 });
        if (range.quality && encoder) {
          const profiles = { sd: [854, 480, 1800], hd: [1280, 720, 3000], fullhd: [1920, 1080, 4500], original: [0, 0, 6500] } as const;
          const [width, height, bitrate] = profiles[range.quality];
          const scale = width ? `,scale=w='min(${width},iw)':h='min(${height},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2` : ",scale=trunc(iw/2)*2:trunc(ih/2)*2";
          // Time-based keyframes stay frequent at every recorder speed without making all
          // normal-speed frames I-frames (which starves quality under a bounded bitrate).
          // Only generated UUIDs, a verified binary path and fixed options enter this command.
          // Accelerated recorder RTCP makes FFmpeg source PTS jump backwards. Use receive-clock
          // timestamps for browser playout; the UI estimates source time using the selected speed.
          // The recorder clock burned into each frame stays unchanged.
          const command = [encoder, "-hide_banner", "-loglevel", "error", "-nostdin", "-threads", "1", "-filter_threads", "1", "-rtsp_transport", "tcp", "-timeout", "10000000", "-probesize", "32768", "-analyzeduration", "1", "-i", `rtsp://127.0.0.1:18895/${input}`, "-map", "0:v:0", "-map", "0:a:0?", "-c:a", "libopus", "-ar", "48000", "-ac", "1", "-b:a", "32k", "-af", "asetpts=(RTCTIME-RTCSTART)/(TB*1000000),aresample=async=1:first_pts=0", "-c:v", "libx264", "-threads", "1", "-preset", "ultrafast", "-tune", "zerolatency", "-crf", "28", "-maxrate", `${bitrate}k`, "-bufsize", `${bitrate * 2}k`, "-pix_fmt", "yuv420p", "-g", "25", "-force_key_frames", "expr:gte(t,n_forced*0.5)", "-vf", `setpts=(RTCTIME-RTCSTART)/(TB*1000000)${scale}`, "-fps_mode", "passthrough", "-enc_time_base", "1:90000", "-f", "rtsp", "-rtsp_transport", "tcp", "-max_interleave_delta", "100000", "-muxdelay", "0.05", `rtsp://127.0.0.1:18895/${name}`].map((arg) => `'${arg.replace(/'/gu, `'\\''`)}'`).join(" ");
          await addPath(name, { source: "publisher", runOnDemand: command, runOnDemandRestart: false, runOnDemandStartTimeout: "10s", runOnDemandCloseAfter: "1s", record: false, maxReaders: 1 });
        }
        return name;
      } catch (error) { await remove(name); throw error; }
    },
  };
}
