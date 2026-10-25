// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { PlaybackClock, PlaybackControls, PlaybackPreviews } from "@/lib/network-center/cameraPlayback";

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

describe("persistent playback commands", () => {
  it("coalesces rapid seeks and never applies stale acknowledgements or callbacks after stop", async () => {
    const finish: Array<() => void> = []; const apply = vi.fn(async () => new Promise<void>((resolve) => finish.push(resolve))); const done = vi.fn(); const failed = vi.fn();
    const queue = new PlaybackControls(apply,done,failed); queue.request(1000,1); queue.request(2000,4); queue.request(3000,8);
    expect(apply).toHaveBeenCalledOnce(); finish[0]!(); await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(2)); expect(done).not.toHaveBeenCalled(); expect(apply).toHaveBeenLastCalledWith(3000,8);
    finish[1]!(); await vi.waitFor(() => expect(done).toHaveBeenCalledWith(3000,8)); queue.request(4000,1); queue.cancel(); finish[2]!(); await Promise.resolve(); expect(done).toHaveBeenCalledOnce(); expect(failed).not.toHaveBeenCalled();
  });
});

describe("scrub preview queue", () => {
  it("serializes capture and cleanup, coalesces requests, rejects stale frames and caches the latest result", async () => {
    const finish: Array<(value: string) => void> = []; const signals: AbortSignal[] = [];
    const capture = vi.fn((_time: number, signal: AbortSignal) => { signals.push(signal); return new Promise<string>((resolve) => finish.push(resolve)); });
    const queue = new PlaybackPreviews(capture); const show = vi.fn();
    queue.request(1000, show); queue.request(2000, show); queue.request(3000, show);
    expect(capture).toHaveBeenCalledTimes(1); expect(signals[0]?.aborted).toBe(true);
    finish[0]!("stale"); await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(2));
    expect(capture.mock.calls[1]?.[0]).toBe(3000); expect(show).not.toHaveBeenCalledWith(expect.objectContaining({ image: "stale" }));
    finish[1]!("latest"); await vi.waitFor(() => expect(show).toHaveBeenLastCalledWith({ time: 3000, image: "latest" }));
    queue.request(3000, show); expect(capture).toHaveBeenCalledTimes(2); expect(show).toHaveBeenLastCalledWith({ time: 3000, image: "latest" });
    queue.clear(); queue.request(3000, show); expect(capture).toHaveBeenCalledTimes(3); queue.clear();
    finish[2]!("after-dispose"); await Promise.resolve(); expect(show).not.toHaveBeenCalledWith(expect.objectContaining({ image: "after-dispose" }));
  });
  it("bounds the cache and reports failures without mislabeling another time's image", async () => {
    const capture = vi.fn(async (time: number) => { if (time === 99) throw new Error("busy"); return String(time); });
    const queue = new PlaybackPreviews(capture); const show = vi.fn();
    for (let time = 0; time < 25; time++) { queue.request(time, show); await vi.waitFor(() => expect(show).toHaveBeenLastCalledWith({ time, image: String(time) })); }
    queue.request(0, show); await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(26));
    queue.request(99, show); await vi.waitFor(() => expect(show).toHaveBeenLastCalledWith({ time: 99, error: true }));
    queue.clear();
  });
});
