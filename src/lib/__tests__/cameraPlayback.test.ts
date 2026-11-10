// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { PlaybackClock, PlaybackControls, playbackOpensAtNormalSpeed, playbackReachedEnd } from "@/lib/network-center/cameraPlayback";

describe("recording position", () => {
  it("resets the fallback clock when the same video element seeks", () => { const clock = new PlaybackClock(8, 8, 40); expect(clock.frame(undefined, 41)).toBe(8); });
  it("uses source RTP time instead of the real-time WebRTC clock, including timestamp wrap", () => {
    const clock = new PlaybackClock(8);
    expect(clock.seconds(10)).toBe(80);
    expect(clock.frame(0xffff0000, 10)).toBe(0);
    expect(clock.frame((0xffff0000 + 90000 * 76) % 2 ** 32, 19.5)).toBe(76);
    expect(clock.seconds(20)).toBe(76);
    expect(clock.frame((0xffff0000 + 90000 * 75) % 2 ** 32, 20)).toBe(76);
  });
  it("falls back to the requested speed when the browser has no RTP timestamp", () => {
    const clock = new PlaybackClock(6);
    expect(clock.frame(undefined, 2)).toBe(12); expect(clock.seconds(3)).toBe(18);
  });
  it("scales realtime SD/HD RTP while ignoring stale frames", () => {
    const clock = new PlaybackClock(8, 8);
    expect(clock.frame(90000, 0)).toBe(0);
    expect(clock.frame(90000 * 11, 10)).toBe(80);
    expect(clock.frame(90000 * 10, 11)).toBe(80);
    expect(clock.frame(90000 * 12, 11)).toBe(88);
  });
});

describe("end of the selected range", () => {
  it("hình đã ngừng khi mốc ước tính sát cuối khoảng xem ⇒ coi là xem hết; sai số cho phép tăng theo tốc độ", () => {
    const now = Date.parse("2026-11-10T05:30:15Z"); const to = Date.parse("2026-11-10T02:00:00Z");
    const at = (secondsBeforeEnd: number, speed: number, stalledMs: number, lastFrameAt = now - stalledMs) =>
      playbackReachedEnd({ cursor: to - secondsBeforeEnd * 1000, to, speed, lastFrameAt, now });
    // Đo thật trên production: 8× dừng ở −4 giây rồi không còn khung hình nào.
    expect(at(4, 8, 3000)).toBe(true);
    expect(at(13, 8, 3000)).toBe(true);
    expect(at(14, 8, 3000)).toBe(false);
    // Hình vẫn đang về, hoặc mới ngừng chưa đủ lâu ⇒ chưa kết luận.
    expect(at(4, 8, 0)).toBe(false);
    expect(at(4, 8, 2400)).toBe(false);
    // Ngừng giữa khoảng xem là mất mạng / đầu ghi lỗi, không phải xem hết.
    expect(at(600, 8, 30_000)).toBe(false);
    // Tốc độ thường: chỉ 3 giây cuối.
    expect(at(3, 1, 3000)).toBe(true);
    expect(at(4, 1, 3000)).toBe(false);
    // Chưa có khung hình nào (đang kết nối) thì không bao giờ là "xem hết".
    expect(at(1, 1, 60_000, 0)).toBe(false);
  });
});

describe("opening speed of a new stream", () => {
  it("chỉ luồng chuyển mã có lệnh tua mới mở ở 1× rồi lên tốc độ; chất lượng gốc và 1× mở thẳng", () => {
    for (const quality of ["sd", "hd", "fullhd"]) expect(playbackOpensAtNormalSpeed({ controlAvailable: true, speed: 8, quality })).toBe(true);
    expect(playbackOpensAtNormalSpeed({ controlAvailable: true, speed: 8, quality: "original" })).toBe(false);
    expect(playbackOpensAtNormalSpeed({ controlAvailable: true, speed: 1, quality: "sd" })).toBe(false);
    // Không có lệnh tua thì không còn cách nào lên tốc độ sau khi mở ⇒ giữ đường mở thẳng.
    expect(playbackOpensAtNormalSpeed({ controlAvailable: false, speed: 8, quality: "sd" })).toBe(false);
    // Không khai chất lượng (máy chủ không có bộ chuyển mã): luồng đầu ghi mở thẳng như trước.
    expect(playbackOpensAtNormalSpeed({ controlAvailable: true, speed: 8 })).toBe(false);
  });
});

describe("persistent playback commands", () => {
  it("coalesces rapid seeks and never applies stale acknowledgements or callbacks after stop", async () => {
    const finish: Array<() => void> = []; const apply = vi.fn(async () => new Promise<void>((resolve) => finish.push(resolve))); const done = vi.fn(); const failed = vi.fn();
    const queue = new PlaybackControls(apply,done,failed); queue.request(1000,1); queue.request(2000,4); queue.request(3000,8);
    expect(apply).toHaveBeenCalledOnce(); finish[0]!(); await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(2)); expect(done).not.toHaveBeenCalled(); expect(apply).toHaveBeenLastCalledWith(3000,8);
    finish[1]!(); await vi.waitFor(() => expect(done).toHaveBeenCalledWith(3000,8)); queue.request(4000,1); queue.cancel(); finish[2]!(); await Promise.resolve(); expect(done).toHaveBeenCalledOnce(); expect(failed).not.toHaveBeenCalled();
  });
});
