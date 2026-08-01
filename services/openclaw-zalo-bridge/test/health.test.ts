import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  evaluateReadiness,
  HEARTBEAT_STALE_MS,
  liveness,
} from "../src/health/snapshot.js";
import {
  AiCircuitBreaker,
  CircuitOpenError,
} from "../src/health/circuit-breaker.js";
import { HeartbeatLoop, HeartbeatSendError } from "../src/health/heartbeat.js";
import { FakeZaloAdapter } from "../src/testing/fake-zalo-adapter.js";
import { SqliteSpool } from "../src/spool/sqlite-spool.js";

const NOW = 1_785_062_400_000;

function readiness(overrides: Record<string, unknown> = {}) {
  return evaluateReadiness({
    spoolReady: true,
    channelPaused: false,
    runtimeTokenValid: true,
    modelProviderHealthy: true,
    lastHeartbeatAtMs: NOW - 1_000,
    nowMs: NOW,
    ...overrides,
  } as Parameters<typeof evaluateReadiness>[0]);
}

describe("Bridge health separation", () => {
  it("reports liveness without consulting dependencies", () => {
    expect(liveness()).toEqual({ status: "ok" });
  });

  it("reports all three readiness signals when healthy", () => {
    expect(readiness()).toEqual({
      inboundReady: true,
      outboundReady: true,
      aiReady: true,
      heartbeatStale: false,
    });
  });

  it("keeps inbound ready while a channel pause stops outbound", () => {
    const state = readiness({ channelPaused: true });
    expect(state.inboundReady).toBe(true);
    expect(state.outboundReady).toBe(false);
    expect(state.aiReady).toBe(false);
  });

  it("disables only AI when the model provider is unhealthy", () => {
    const state = readiness({ modelProviderHealthy: false });
    expect(state.inboundReady).toBe(true);
    expect(state.outboundReady).toBe(true);
    expect(state.aiReady).toBe(false);
  });

  it("marks the heartbeat stale after ninety seconds", () => {
    expect(readiness({ lastHeartbeatAtMs: NOW - HEARTBEAT_STALE_MS }).heartbeatStale).toBe(false);
    const stale = readiness({ lastHeartbeatAtMs: NOW - HEARTBEAT_STALE_MS - 1 });
    expect(stale.heartbeatStale).toBe(true);
    expect(stale.inboundReady).toBe(false);
  });

  it("fails closed when the runtime token is invalid or the spool is not ready", () => {
    expect(readiness({ runtimeTokenValid: false }).inboundReady).toBe(false);
    expect(readiness({ spoolReady: false }).inboundReady).toBe(false);
  });
});

describe("Runtime heartbeat loop", () => {
  it("uses the fixed ten-second cadence and can be stopped idempotently", () => {
    let scheduled: (() => void) | undefined;
    let intervalMs = 0;
    const cleared: unknown[] = [];
    const handle = { kind: "heartbeat" };
    const loop = new HeartbeatLoop({
      send: async () => undefined,
      now: () => NOW,
      setInterval: (callback, milliseconds) => {
        scheduled = callback;
        intervalMs = milliseconds;
        return handle;
      },
      clearInterval: (candidate) => cleared.push(candidate),
    });

    loop.start();
    loop.start();

    expect(intervalMs).toBe(10_000);
    expect(scheduled).toBeTypeOf("function");
    loop.stop();
    loop.stop();
    expect(cleared).toEqual([handle]);
  });

  it("records only successful heartbeats and never overlaps sends", async () => {
    let calls = 0;
    let release: (() => void) | undefined;
    let now = NOW;
    const loop = new HeartbeatLoop({
      send: async () => {
        calls += 1;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      },
      now: () => now,
    });

    const first = loop.pulse();
    const second = loop.pulse();
    expect(calls).toBe(1);
    expect(loop.snapshot()).toMatchObject({ inFlight: true, lastSuccessAtMs: null });
    release?.();
    await Promise.all([first, second]);
    expect(calls).toBe(1);
    expect(loop.snapshot()).toMatchObject({
      inFlight: false,
      lastAttemptAtMs: NOW,
      lastSuccessAtMs: NOW,
      consecutiveFailures: 0,
    });

    now += 30_000;
    const third = loop.pulse();
    expect(calls).toBe(2);
    release?.();
    await expect(third).resolves.toBeUndefined();
  });

  it("contains sender failures and exposes content-free failure state", async () => {
    const loop = new HeartbeatLoop({
      send: async () => {
        throw new Error("credential-that-must-not-be-stored");
      },
      now: () => NOW,
    });

    const error = await loop.pulse().catch((caught) => caught);
    expect(error).toBeInstanceOf(HeartbeatSendError);
    expect(String(error)).not.toContain("credential-that-must-not-be-stored");
    expect(loop.snapshot()).toEqual({
      running: false,
      inFlight: false,
      lastAttemptAtMs: NOW,
      lastSuccessAtMs: null,
      consecutiveFailures: 1,
    });
  });
});

describe("AI circuit breaker", () => {
  it("opens at the configured threshold without disabling manual non-AI sends", () => {
    const breaker = new AiCircuitBreaker({ failureThreshold: 2, resetAfterMs: 30_000 });
    breaker.recordFailure(NOW);
    expect(breaker.snapshot(NOW)).toMatchObject({ state: "CLOSED", failureCount: 1 });
    breaker.recordFailure(NOW + 1);

    expect(breaker.snapshot(NOW + 1)).toEqual({
      state: "OPEN",
      failureCount: 2,
      openedAtMs: NOW + 1,
      nextProbeAtMs: NOW + 30_001,
      aiAutomaticSendAllowed: false,
      manualNonAiSendAllowed: true,
    });
    expect(() => breaker.assertCanAttempt(NOW + 2)).toThrow(CircuitOpenError);
  });

  it("permits one half-open probe and closes only after that probe succeeds", () => {
    const breaker = new AiCircuitBreaker({ failureThreshold: 1, resetAfterMs: 30_000 });
    breaker.recordFailure(NOW);

    expect(breaker.canAttempt(NOW + 29_999)).toBe(false);
    expect(breaker.canAttempt(NOW + 30_000)).toBe(true);
    expect(breaker.canAttempt(NOW + 30_000)).toBe(false);
    expect(breaker.snapshot(NOW + 30_000).state).toBe("HALF_OPEN");

    breaker.recordSuccess();
    expect(breaker.snapshot(NOW + 30_001)).toMatchObject({
      state: "CLOSED",
      failureCount: 0,
      aiAutomaticSendAllowed: true,
      manualNonAiSendAllowed: true,
    });
  });

  it("reopens for a full reset window when the half-open probe fails", () => {
    const breaker = new AiCircuitBreaker({ failureThreshold: 1, resetAfterMs: 30_000 });
    breaker.recordFailure(NOW);
    expect(breaker.canAttempt(NOW + 30_000)).toBe(true);
    breaker.recordFailure(NOW + 30_001);

    expect(breaker.snapshot(NOW + 30_001)).toMatchObject({
      state: "OPEN",
      openedAtMs: NOW + 30_001,
      nextProbeAtMs: NOW + 60_001,
    });
  });
});

describe("Fake Zalo adapter determinism", () => {
  it("returns the configured QR and directory without any network", async () => {
    const adapter = new FakeZaloAdapter({
      qrPayload: "fake-qr",
      directory: [{ providerId: "peer-1", displayName: "Peer One" }],
      inbound: [],
      sendOutcomes: [],
    });

    expect(await adapter.requestQr()).toEqual({ qrPayload: "fake-qr", expiresInSeconds: 120 });
    expect(await adapter.listDirectory()).toEqual([
      { providerId: "peer-1", displayName: "Peer One" },
    ]);
  });

  it("replays the configured send outcomes in order", async () => {
    const adapter = new FakeZaloAdapter({
      qrPayload: "fake-qr",
      directory: [],
      inbound: [],
      sendOutcomes: ["SUCCESS", "PROVIDER_REJECT", "AMBIGUOUS_TIMEOUT"],
    });

    expect((await adapter.emitFakeOutcome({ text: "a" })).outcome).toBe("SUCCESS");
    const rejected = await adapter.emitFakeOutcome({ text: "b" });
    expect(rejected.outcome).toBe("PROVIDER_REJECT");
    expect(rejected.providerMessageId).toBeNull();
    const ambiguous = await adapter.emitFakeOutcome({ text: "c" });
    expect(ambiguous.outcome).toBe("AMBIGUOUS_TIMEOUT");
    expect(ambiguous.providerMessageId).toBeNull();
  });
});

describe("Inbound listener durability ordering", () => {
  let directory: string;
  let spool: SqliteSpool;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "openclaw-order-"));
    spool = new SqliteSpool(join(directory, "spool.db"));
  });

  afterEach(() => {
    spool.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("keeps dispatch at zero until the spool commit succeeds", async () => {
    const adapter = new FakeZaloAdapter({
      qrPayload: "fake-qr",
      directory: [],
      inbound: [
        {
          providerEventId: "provider-event-1",
          providerMessageId: "provider-message-1",
          eventKind: "MESSAGE",
          providerTimestamp: 1_785_062_400,
          payload: { text: "hello" },
        },
      ],
      sendOutcomes: [],
    });

    const observed: string[] = [];
    await adapter.deliverInbound((event) => {
      observed.push("listener-start");
      const result = spool.append({
        organizationId: "dddd0000-0000-4000-8000-000000000001",
        accountId: "dddd1000-0000-4000-8000-000000000001",
        cellId: "dddd2000-0000-4000-8000-000000000001",
        eventKind: event.eventKind,
        providerEventId: event.providerEventId,
        providerMessageId: event.providerMessageId,
        providerTimestamp: event.providerTimestamp,
        rawPayload: event.payload,
        normalizedPayload: event.payload,
      });
      // Only a committed row may advance the dispatch counter.
      if (result.outcome === "SPOOLED") {
        adapter.counters.dispatches += 1;
        observed.push("commit");
      }
    });

    expect(observed).toEqual(["listener-start", "commit"]);
    expect(adapter.counters.dispatches).toBe(1);
    expect(spool.countByState("SPOOLED")).toBe(1);
  });

  it("leaves dispatch and built-in reply at zero when the commit throws", async () => {
    const adapter = new FakeZaloAdapter({
      qrPayload: "fake-qr",
      directory: [],
      inbound: [
        {
          providerEventId: "provider-event-2",
          providerMessageId: "provider-message-2",
          eventKind: "MESSAGE",
          providerTimestamp: 1_785_062_400,
          payload: { text: "hello" },
        },
      ],
      sendOutcomes: [],
    });

    spool.close();

    await expect(
      adapter.deliverInbound((event) => {
        spool.append({
          organizationId: "dddd0000-0000-4000-8000-000000000001",
          accountId: "dddd1000-0000-4000-8000-000000000001",
          cellId: "dddd2000-0000-4000-8000-000000000001",
          eventKind: event.eventKind,
          providerEventId: event.providerEventId,
          providerMessageId: event.providerMessageId,
          providerTimestamp: event.providerTimestamp,
          rawPayload: event.payload,
          normalizedPayload: event.payload,
        });
        adapter.counters.dispatches += 1;
      }),
    ).rejects.toThrow();

    expect(adapter.counters.dispatches).toBe(0);
    expect(adapter.counters.builtInReplies).toBe(0);
    expect(adapter.counters.pairingNotifications).toBe(0);
    expect(adapter.counters.directProviderFrames).toBe(0);

    // Reopen to prove nothing was half-written.
    spool = new SqliteSpool(join(directory, "spool.db"));
    expect(spool.countByState("SPOOLED")).toBe(0);
  });
});
