import { randomUUID } from "node:crypto";
import { z } from "zod";
import { LiveError, type LiveRecorder } from "./cameraLive.js";

const rangeSchema = z.object({ start: z.string().datetime({ offset: true }), end: z.string().datetime({ offset: true }) }).strict();
export interface PlaybackRange { start: string; end: string }
export function playbackRange(value: unknown, now = Date.now()): PlaybackRange {
  const parsed = rangeSchema.safeParse(value);
  if (!parsed.success) throw new LiveError(400, "INVALID_PLAYBACK_RANGE");
  const start = Date.parse(parsed.data.start); const end = Date.parse(parsed.data.end);
  if (start < Date.UTC(2000, 0, 1) || end <= start || end > now || end - start > 86400_000 || start % 1000 || end % 1000) throw new LiveError(400, "INVALID_PLAYBACK_RANGE");
  return { start: new Date(start).toISOString(), end: new Date(end).toISOString() };
}
const deviceTime = (iso: string) => new Date(Date.parse(iso) + 7 * 3600_000).toISOString().slice(0, 19).replace(/[-:T]/gu, "_");
const api = "http://127.0.0.1:18897/v3/config/paths";

/** Credentials travel only to the loopback media API; never to the browser or argv. */
export function playbackSources(request: typeof fetch, fatal: () => void) {
  const remove = async (name: string) => {
    try {
      const response = await request(`${api}/delete/${name}`, { method: "DELETE", redirect: "error", signal: AbortSignal.timeout(3000) });
      await response.body?.cancel();
      if (![200, 404].includes(response.status)) throw new Error("cleanup");
    } catch { fatal(); throw new LiveError(502, "MEDIA_CLEANUP_FAILED"); }
  };
  return {
    remove,
    async add(recorder: LiveRecorder, channel: number, range: PlaybackRange) {
      const name = `playback-${randomUUID()}`;
      const source = new URL("/cam/playback", recorder.rtspOrigin);
      source.username = recorder.username; source.password = recorder.password;
      source.search = new URLSearchParams({ channel: String(channel), subtype: "0", starttime: deviceTime(range.start), endtime: deviceTime(range.end) }).toString();
      try {
        const response = await request(`${api}/add/${name}`, {
          method: "POST", headers: { "Content-Type": "application/json" }, redirect: "error", signal: AbortSignal.timeout(3000),
          body: JSON.stringify({ source: source.href, sourceOnDemand: true, sourceOnDemandStartTimeout: "8s", sourceOnDemandCloseAfter: "1s", rtspTransport: "tcp", record: false, maxReaders: 1 }),
        });
        await response.body?.cancel();
        if (response.status !== 200) throw new LiveError(502, "RECORDING_UNAVAILABLE");
        return name;
      } catch (error) { await remove(name); throw error; }
    },
  };
}
