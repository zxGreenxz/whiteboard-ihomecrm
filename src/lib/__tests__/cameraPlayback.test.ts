// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { PlaybackClock, PlaybackPreviews } from "@/lib/network-center/cameraPlayback";

describe("recording position", () => {
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
