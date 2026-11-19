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

/**
 * Ảnh giữ tạm lúc chuyển mốc được gỡ khi `requestVideoFrameCallback` báo khung hình mới. Safari trên iPhone không báo
 * khung hình cho luồng này (chủ thử thật 10/11/2026: ảnh cũ che mãi video sau khi kéo thanh thời gian), nên sau chừng
 * này kể từ lúc đầu ghi nhận lệnh tua, `timeupdate` của video đang chạy cũng được phép gỡ ảnh.
 */
export const PLAYBACK_POSTER_FALLBACK_MS = 1200;
/** Hình ngừng lâu chừng này (đồng hồ thật) mới xét là luồng đã kết thúc. */
export const PLAYBACK_END_STALL_MS = 2500;
/**
 * Đầu ghi dừng phát đúng giờ kết thúc của khoảng xem, nhưng vị trí trên thanh thời gian chỉ là ƯỚC TÍNH: ở tốc độ cao
 * nó có thể dừng sớm vài giây so với cuối khoảng (đo trên production 10/11/2026: 8× dừng ở −4 giây), nên phép so
 * "đã tới cuối" không bao giờ đúng và trình xem treo chờ lỗi của cổng. Hình đã ngừng mà mốc đang sát cuối ⇒ coi là xem hết.
 * Sai số cho phép tăng theo tốc độ: 1× là 3 giây nội dung, 8× là 13,5 giây.
 */
export function playbackReachedEnd(input: { cursor: number; to: number; speed: number; lastFrameAt: number; now: number }): boolean {
  if (!(input.lastFrameAt > 0) || input.now - input.lastFrameAt < PLAYBACK_END_STALL_MS) return false;
  return input.cursor >= input.to - (Math.max(1, input.speed) * 1500 + 1500);
}

/**
 * Chất lượng phải chuyển mã ở máy chủ (khác "original"). Cổng không mở được luồng MỚI loại này thẳng ở tốc độ khác 1×:
 * đo trên production 10/11/2026, bộ chuyển mã chạy hết 10 giây chờ mà không phát được hình rồi bị tắt, trình duyệt chỉ
 * thấy rớt kết nối. Đổi tốc độ trên luồng ĐANG chạy thì xong trong nửa giây, còn chất lượng gốc mở thẳng 8× trong 1 giây.
 * Vì vậy luồng chuyển mã luôn mở ở 1× rồi xin tốc độ mong muốn bằng lệnh tua.
 */
export function playbackOpensAtNormalSpeed(input: { controlAvailable: boolean; speed: number; quality?: string }): boolean {
  return input.controlAvailable && input.speed !== 1 && input.quality !== undefined && input.quality !== "original";
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
