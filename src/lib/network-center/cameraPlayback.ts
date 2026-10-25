import { CameraLiveConnection, cameraPlaybackThumbnail, type CameraPlaybackQuality } from "./cameraLive";

/** WebRTC mediaTime advances at wall-clock speed. RTP advances at the recorder's speed. */
export class PlaybackClock {
  private previous: number | undefined;
  private elapsed = 0;
  constructor(private readonly speed: number, private readonly rtpSpeed = 1, private readonly mediaOrigin = 0) {}
  seconds(mediaTime: number) { return this.previous === undefined ? Math.max(0, mediaTime - this.mediaOrigin) * this.speed : this.elapsed; }
  frame(timestamp: number | undefined, mediaTime: number) {
    if (timestamp === undefined) return this.seconds(mediaTime);
    if (this.previous !== undefined) {
      const delta = (timestamp - this.previous + 2 ** 32) % 2 ** 32;
      if (delta > 2 ** 31) return this.elapsed; // Ignore reordered frames; accept a 32-bit wrap.
      this.elapsed += delta / 90000 * this.rtpSpeed;
    }
    this.previous = timestamp;
    return this.elapsed;
  }
}

export function cameraFrame(video: HTMLVideoElement | null, width = 960): string | undefined {
  if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;
  const canvas = document.createElement("canvas");
  canvas.width = Math.min(width, video.videoWidth); canvas.height = Math.round(canvas.width * video.videoHeight / video.videoWidth);
  try {
    const context = canvas.getContext("2d"); if (!context) return;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.75);
  } catch { return; }
}

/** A single authenticated, unrecorded stream lives only until its first decoded frame. */
export async function capturePlaybackFrame(recorderId: string, channel: number, time: number, end: number, signal: AbortSignal, quality?: CameraPlaybackQuality, direct = false): Promise<string> {
  if (signal.aborted) throw new Error("cancelled");
  if (direct) return cameraPlaybackThumbnail(recorderId, channel, time, end, signal);
  const video = document.createElement("video"); video.muted = true; video.playsInline = true;
  let resolve!: (image: string) => void; let reject!: (error: Error) => void;
  const image = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
  const abort = () => reject(new Error("cancelled"));
  const capture = () => { const frame = cameraFrame(video, 320); if (frame) resolve(frame); };
  let frameCallback: number | undefined;
  const connection = new CameraLiveConnection({ recorderId, channel, playback: { start: new Date(time).toISOString(), end: new Date(Math.min(time + 20_000, end)).toISOString(), ...(quality ? { quality } : {}) },
    onStream(stream) {
      if (signal.aborted || !stream) return;
      video.srcObject = stream;
      void video.play().catch(() => reject(new Error("playback")));
    },
    onState(state) { if (state === "error") reject(new Error("playback")); },
  });
  video.addEventListener("loadeddata", capture); video.addEventListener("timeupdate", capture);
  if (video.requestVideoFrameCallback) frameCallback = video.requestVideoFrameCallback(capture);
  const timeout = setTimeout(() => reject(new Error("timeout")), 12_000);
  signal.addEventListener("abort", abort, { once: true });
  void connection.start();
  try { return await image; }
  finally {
    clearTimeout(timeout); signal.removeEventListener("abort", abort);
    video.removeEventListener("loadeddata", capture); video.removeEventListener("timeupdate", capture);
    if (frameCallback !== undefined) video.cancelVideoFrameCallback(frameCallback);
    video.pause(); video.srcObject = null;
    await connection.stop();
  }
}

/** Finish an in-flight recorder command, then apply only the latest requested position. */
export class PlaybackControls {
  private pending: { time: number; speed: number; version: number } | undefined;
  private version = 0;
  private running = false;
  constructor(private readonly apply: (time: number, speed: number) => Promise<unknown>, private readonly done: (time: number, speed: number) => void, private readonly failed: (error: unknown, time: number, speed: number) => void) {}
  request(time: number, speed: number) { this.pending = { time, speed, version: ++this.version }; void this.run(); }
  cancel() { ++this.version; this.pending = undefined; }
  private async run() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.pending) {
        const next = this.pending; this.pending = undefined;
        try { await this.apply(next.time, next.speed); if (next.version === this.version) this.done(next.time, next.speed); }
        catch (error) { if (next.version === this.version) this.failed(error, next.time, next.speed); }
      }
    } finally { this.running = false; }
  }
}

export interface PlaybackPreview { time: number; image?: string; error?: boolean }
type PreviewRequest = { time: number; show: (preview: PlaybackPreview) => void; version: number };
/** Coalesce rapid dragging; never start another capture before the previous lease is released. */
export class PlaybackPreviews {
  private readonly cache = new Map<number, string>();
  private pending: PreviewRequest | undefined;
  private active: AbortController | undefined;
  private running = false;
  private version = 0;
  constructor(private readonly capture: (time: number, signal: AbortSignal) => Promise<string>) {}
  request(time: number, show: PreviewRequest["show"]) {
    const version = ++this.version;
    this.active?.abort(); this.pending = undefined;
    const image = this.cache.get(time);
    show({ time, ...(image ? { image } : {}) });
    if (image) return;
    this.pending = { time, show, version }; void this.run();
  }
  clear() { ++this.version; this.pending = undefined; this.active?.abort(); this.cache.clear(); }
  cancel() { ++this.version; this.pending = undefined; this.active?.abort(); }
  private async run() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.pending) {
        const next = this.pending; this.pending = undefined; const abort = new AbortController(); this.active = abort;
        try {
          const image = await this.capture(next.time, abort.signal);
          if (!abort.signal.aborted && next.version === this.version) {
            this.cache.set(next.time, image);
            if (this.cache.size > 24) this.cache.delete(this.cache.keys().next().value!);
            next.show({ time: next.time, image });
          }
        } catch { if (!abort.signal.aborted && next.version === this.version) next.show({ time: next.time, error: true }); }
        finally { if (this.active === abort) this.active = undefined; }
      }
    } finally { this.running = false; }
  }
}
