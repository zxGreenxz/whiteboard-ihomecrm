import { spawn } from "node:child_process";
import { LiveError, type LiveRecorder } from "./cameraLive.js";
import { playbackRange, type playbackSources } from "./cameraPlayback.js";

/** One decoded JPEG, in memory only. Recorder credentials never enter process arguments. */
export async function playbackThumbnail(sources: ReturnType<typeof playbackSources>, encoder: string, recorder: LiveRecorder, channel: number, start: string, end: string, signal: AbortSignal): Promise<string> {
  const range = playbackRange({ start, end });
  if (Date.parse(range.end) - Date.parse(range.start) > 20_000) throw new LiveError(400, "INVALID_PLAYBACK_RANGE");
  signal.throwIfAborted();
  const name = await sources.add(recorder, channel, range, true);
  try {
    signal.throwIfAborted();
    return await new Promise<string>((resolve, reject) => {
      const child = spawn(encoder, ["-hide_banner", "-loglevel", "error", "-nostdin", "-threads", "1", "-filter_threads", "1", "-rtsp_transport", "tcp", "-timeout", "3000000", "-probesize", "32768", "-analyzeduration", "1", "-i", `rtsp://127.0.0.1:18895/${name}`, "-an", "-frames:v", "1", "-vf", "scale=320:-2", "-c:v", "mjpeg", "-threads", "1", "-q:v", "5", "-f", "image2pipe", "pipe:1"], { stdio: ["ignore", "pipe", "ignore"] });
      const chunks: Buffer[] = []; let size = 0; let cancelled = false;
      const stop = () => { cancelled = true; child.kill("SIGKILL"); };
      const timer = setTimeout(stop, 5000);
      signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted) stop();
      child.stdout.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 131072) stop(); else chunks.push(chunk); });
      child.once("error", () => { cancelled = true; });
      // Wait for exit before releasing the source or admitting another preview.
      child.once("close", (code) => {
        clearTimeout(timer); signal.removeEventListener("abort", stop);
        const image = Buffer.concat(chunks);
        if (cancelled || code !== 0 || image.length < 4 || image[0] !== 0xff || image[1] !== 0xd8 || image.at(-2) !== 0xff || image.at(-1) !== 0xd9) reject(new LiveError(502, "RECORDING_UNAVAILABLE"));
        else resolve(image.toString("base64"));
      });
    });
  } finally { await sources.remove(name); }
}
