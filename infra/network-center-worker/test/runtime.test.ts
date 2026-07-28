import { describe, expect, it } from "vitest";

import { WorkerRuntime } from "../src/main.js";

describe("worker lifecycle", () => {
  it("stops polling and command loops gracefully", async () => {
    const events: string[] = [];
    const sleepers: Array<() => void> = [];
    const runtime = new WorkerRuntime({
      poll: async () => { events.push("poll"); },
      commands: async () => { events.push("commands"); },
      heartbeat: async () => { events.push("heartbeat"); },
      heartbeatStopped: async () => { events.push("stopped"); },
      pollIntervalMs: 60_000,
      commandIntervalMs: 5_000,
      heartbeatIntervalMs: 30_000,
      sleep: async (_milliseconds, signal) => new Promise<void>((resolve) => {
        const done = () => { events.push("sleep-aborted"); resolve(); };
        signal.addEventListener("abort", done, { once: true });
        sleepers.push(done);
      }),
      logger: { info() {}, warn() {}, error() {} },
    });

    const running = runtime.start();
    await Promise.resolve();
    await runtime.stop();
    await running;

    expect(events).toContain("poll");
    expect(events).toContain("commands");
    expect(events).toContain("heartbeat");
    expect(events.at(-1)).toBe("stopped");
    expect(sleepers.length).toBeGreaterThan(0);
  });
});
