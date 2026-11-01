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
