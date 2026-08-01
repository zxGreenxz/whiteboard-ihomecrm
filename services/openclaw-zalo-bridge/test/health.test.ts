import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  evaluateReadiness,
  HEARTBEAT_STALE_MS,
  liveness,
} from "../src/health/snapshot.js";
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

    expect((await adapter.send({ text: "a" })).outcome).toBe("SUCCESS");
    const rejected = await adapter.send({ text: "b" });
    expect(rejected.outcome).toBe("PROVIDER_REJECT");
    expect(rejected.providerMessageId).toBeNull();
    const ambiguous = await adapter.send({ text: "c" });
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