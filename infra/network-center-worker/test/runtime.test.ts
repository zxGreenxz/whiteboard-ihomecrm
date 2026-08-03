import { describe, expect, it } from "vitest";

import { ApiClientError } from "../src/apiClient.js";
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

  // For the whole F6 outage this log line said `{"error":"ApiClientError"}` and
  // nothing else, so the cause had to be recovered by correlating the container
  // log, the Edge log and the postgres log at matching millisecond timestamps.
  it("names the server's own failure in the cycle-failed log", async () => {
    const logged: Array<{ message: string; context?: unknown }> = [];
    const runtime = new WorkerRuntime({
      poll: async () => {
        throw new ApiClientError({
          code: "HTTP_400",
          retryable: false,
          status: 400,
          serverReason: "23514",
        });
      },
      commands: async () => {},
      heartbeat: async () => {},
      heartbeatStopped: async () => {},
      pollIntervalMs: 60_000,
      commandIntervalMs: 5_000,
      heartbeatIntervalMs: 30_000,
      sleep: async (_milliseconds, signal) => new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      }),
      logger: {
        info() {},
        warn() {},
        error(message, context) { logged.push({ message, context }); },
      },
    });

    const running = runtime.start();
    await Promise.resolve();
    await runtime.stop();
    await running;

    const failure = logged.find((entry) => entry.message === "poll cycle failed");
    expect(failure?.context).toMatchObject({
      error: "ApiClientError",
      code: "HTTP_400",
      status: 400,
      serverReason: "23514",
      consecutiveFailures: 1,
    });
  });

  it("adds no API fields when the failure is not an API failure", async () => {
    const logged: Array<{ message: string; context?: unknown }> = [];
    const runtime = new WorkerRuntime({
      poll: async () => { throw new RangeError("local failure"); },
      commands: async () => {},
      heartbeat: async () => {},
      heartbeatStopped: async () => {},
      pollIntervalMs: 60_000,
      commandIntervalMs: 5_000,
      heartbeatIntervalMs: 30_000,
      sleep: async (_milliseconds, signal) => new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      }),
      logger: {
        info() {},
        warn() {},
        error(message, context) { logged.push({ message, context }); },
      },
    });

    const running = runtime.start();
    await Promise.resolve();
    await runtime.stop();
    await running;

    const failure = logged.find((entry) => entry.message === "poll cycle failed");
    expect(failure?.context).toEqual({ error: "RangeError", consecutiveFailures: 1 });
  });
});
