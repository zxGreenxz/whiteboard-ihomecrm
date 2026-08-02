import { describe, expect, it, vi } from "vitest";

import {
  HEARTBEAT_STALE_MS,
  WatchdogState,
  evaluateSnapshot,
  type ProbeSnapshot,
  type WatchdogEnv,
} from "./index";

const ORG = "dddd0000-0000-4000-8000-000000000001";

function snapshot(overrides: Partial<ProbeSnapshot> = {}): ProbeSnapshot {
  return {
    version: 1,
    organizationId: ORG,
    observedAt: "2026-08-02T00:02:00.000Z",
    probeOk: true,
    heartbeatAt: "2026-08-02T00:01:59.000Z",
    metrics: {
      queueLagP95Seconds: 0,
      unknownCount10m: 0,
      unknownRate10m: 0,
      attempts10m: 0,
      adapterErrorRate5m: 0,
      reconnectCount10m: 0,
      cpuPercentOfCap: 0,
      ramPercentOfCap: 0,
      rootDiskUsedPercent: 0,
      spoolUsedPercent: 0,
      spoolOldestAgeSeconds: 0,
      spoolBytes: 0,
      mediaBacklog: 0,
      r2FailureCount5m: 0,
      supabaseEgressPercent: 0,
      r2StoragePercent: 0,
      r2RequestPercent: 0,
      vpsOutboundPercent: 0,
      transferQuotaPercent: 0,
    },
    ...overrides,
  };
}

function stateHarness() {
  const memory = new Map<string, unknown>();
  const durableState = {
    storage: {
      get: vi.fn(async (key: string) => memory.get(key)),
      put: vi.fn(async (key: string, value: unknown) => { memory.set(key, value); }),
    },
  } as unknown as DurableObjectState;
  const env = {
    OPENCLAW_WATCHDOG_EDGE_URL: "https://project.supabase.co/functions/v1/openclaw-watchdog",
    OPENCLAW_WATCHDOG_BEARER_TOKEN: "x".repeat(48),
    OPENCLAW_WATCHDOG_ORGANIZATION_ID: ORG,
    OPENCLAW_WATCHDOG_REPEAT_WINDOW_SECONDS: "180",
  } as WatchdogEnv;
  return { durableState, env };
}

describe("external OpenClaw watchdog", () => {
  it("marks a heartbeat stale only after the exact 90 second boundary", () => {
    const now = Date.parse("2026-08-02T00:02:00.000Z");
    expect(evaluateSnapshot(snapshot({ heartbeatAt: new Date(now - HEARTBEAT_STALE_MS).toISOString() }), now).events)
      .toHaveLength(0);
    expect(evaluateSnapshot(snapshot({ heartbeatAt: new Date(now - HEARTBEAT_STALE_MS - 1).toISOString() }), now).events)
      .toEqual([expect.objectContaining({ healthKind: "WATCHDOG_HEARTBEAT_STALE", status: "OPEN" })]);
  });

  it("enforces the 60/80/90/100 quota ladder and exact media controls", () => {
    const now = Date.parse("2026-08-02T00:02:00.000Z");
    const evaluated = evaluateSnapshot(snapshot({
      metrics: { ...snapshot().metrics, transferQuotaPercent: 100, supabaseEgressPercent: 60 },
    }), now);
    expect(evaluated.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ healthKind: "SUPABASE_EGRESS_QUOTA_60" }),
      expect.objectContaining({ healthKind: "TRANSFER_QUOTA_100" }),
    ]));
    expect(evaluated.controls).toEqual([
      "DISABLE_AUTOMATIC_VIDEO_FILE_CACHE",
      "PAUSE_NONCRITICAL_PROACTIVE_GROUP_MEDIA",
      "PAUSE_ALL_OUTBOUND_MEDIA",
    ]);
  });

  it("records one incident after three failures and notifies once per repeat window", async () => {
    const { durableState, env } = stateHarness();
    const watchdog = new WatchdogState(durableState, env);
    const bodies: Array<Record<string, unknown>> = [];
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://project.supabase.co/functions/v1/openclaw-watchdog");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      if (body.operation === "PROBE") return Response.json(snapshot({ probeOk: false, heartbeatAt: null }));
      return Response.json({ version: 1, recorded: 1, notified: 1 });
    });
    const start = Date.parse("2026-08-02T00:00:00.000Z");
    await watchdog.tick(start, fetcher);
    await watchdog.tick(start + 60_000, fetcher);
    await watchdog.tick(start + 120_000, fetcher);
    await watchdog.tick(start + 121_000, fetcher);

    const records = bodies.filter((body) => body.operation === "RECORD");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      events: [expect.objectContaining({ fingerprint: "heartbeat:stale", status: "OPEN" })],
      notification: { fingerprints: ["heartbeat:stale"], requiredWithinSeconds: 180 },
    });
  });

  it("calls no Gateway or host URL even when the probe fails", async () => {
    const { durableState, env } = stateHarness();
    const watchdog = new WatchdogState(durableState, env);
    const urls: string[] = [];
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      urls.push(String(url));
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return body.operation === "PROBE"
        ? Response.json(snapshot({ probeOk: false, heartbeatAt: null }))
        : Response.json({ version: 1, recorded: 1 });
    });
    const start = Date.parse("2026-08-02T00:00:00.000Z");
    await watchdog.tick(start, fetcher);
    await watchdog.tick(start + 60_000, fetcher);
    await watchdog.tick(start + 120_000, fetcher);
    expect(new Set(urls)).toEqual(new Set([env.OPENCLAW_WATCHDOG_EDGE_URL]));
    expect(urls.join(" ")).not.toMatch(/gateway|18789|openclaw\.mjs/iu);
  });
});
