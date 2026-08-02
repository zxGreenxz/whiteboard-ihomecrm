import { describe, expect, it, vi } from "vitest";

import {
  HEARTBEAT_STALE_MS,
  WatchdogState,
  deriveRecordOperationId,
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

const KEY_GENERATION = 7;

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/gu, "+").replace(/_/gu, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function stateHarness() {
  const memory = new Map<string, unknown>();
  const durableState = {
    storage: {
      get: vi.fn(async (key: string) => memory.get(key)),
      put: vi.fn(async (key: string, value: unknown) => { memory.set(key, value); }),
    },
  } as unknown as DurableObjectState;
  const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const env = {
    OPENCLAW_WATCHDOG_EDGE_URL: "https://project.supabase.co/functions/v1/openclaw-watchdog",
    OPENCLAW_WATCHDOG_SIGNING_KEY_PKCS8_BASE64: base64(pkcs8),
    OPENCLAW_WATCHDOG_SIGNING_KEY_GENERATION: String(KEY_GENERATION),
    OPENCLAW_WATCHDOG_ORGANIZATION_ID: ORG,
    OPENCLAW_WATCHDOG_REPEAT_WINDOW_SECONDS: "180",
  } as WatchdogEnv;
  return { durableState, env, publicKey: pair.publicKey };
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
    const { durableState, env } = await stateHarness();
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
    const { durableState, env } = await stateHarness();
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

describe("Worker to Edge envelope authentication", () => {
  interface Captured {
    headers: Headers;
    body: string;
  }

  async function captureTick(): Promise<{ captured: Captured[]; publicKey: CryptoKey }> {
    const { durableState, env, publicKey } = await stateHarness();
    const watchdog = new WatchdogState(durableState, env);
    const captured: Captured[] = [];
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      captured.push({ headers: new Headers(init?.headers), body: String(init?.body) });
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return body.operation === "PROBE"
        ? Response.json(snapshot({ metrics: { ...snapshot().metrics, queueLagP95Seconds: 90 } }))
        : Response.json({ version: 1, recorded: 1 });
    });
    await watchdog.tick(Date.parse("2026-08-02T00:00:00.000Z"), fetcher);
    return { captured, publicKey };
  }

  it("signs every call with a verifiable Ed25519 envelope bound to body and operation", async () => {
    const { captured, publicKey } = await captureTick();
    expect(captured.length).toBeGreaterThanOrEqual(2);
    for (const call of captured) {
      const header = call.headers.get("x-openclaw-watchdog-envelope");
      const signature = call.headers.get("x-openclaw-watchdog-signature");
      expect(header).toBeTruthy();
      expect(signature).toMatch(/^[A-Za-z0-9_-]{86}$/u);
      const envelope = JSON.parse(new TextDecoder().decode(base64UrlDecode(header ?? ""))) as
        Record<string, unknown>;
      expect(envelope).toMatchObject({
        version: 1,
        audience: "openclaw-watchdog-edge",
        method: "POST",
        path: "/functions/v1/openclaw-watchdog",
        organizationId: ORG,
        keyGeneration: KEY_GENERATION,
      });
      const body = JSON.parse(call.body) as { operation: string };
      expect(envelope.operation).toBe(body.operation === "PROBE" ? "health.probe" : "health.record");
      expect(envelope.bodySha256).toBe(await sha256Hex(new TextEncoder().encode(call.body)));
      expect(envelope.nonce).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      );
      const valid = await crypto.subtle.verify(
        "Ed25519",
        publicKey,
        base64UrlDecode(signature ?? ""),
        new TextEncoder().encode(
          `ihome-openclaw-watchdog-envelope-v1\0${canonicalJson(envelope)}`,
        ),
      );
      expect(valid).toBe(true);
    }
  });

  it("sends no bearer credential and a fresh nonce per call", async () => {
    const { captured } = await captureTick();
    const nonces = new Set<string>();
    for (const call of captured) {
      expect(call.headers.get("authorization")).toBeNull();
      const envelope = JSON.parse(new TextDecoder().decode(
        base64UrlDecode(call.headers.get("x-openclaw-watchdog-envelope") ?? ""),
      )) as { nonce: string };
      nonces.add(envelope.nonce);
    }
    expect(nonces.size).toBe(captured.length);
  });

  it("refuses to start without a usable signing key generation", async () => {
    const { durableState, env } = await stateHarness();
    const watchdog = new WatchdogState(
      durableState,
      { ...env, OPENCLAW_WATCHDOG_SIGNING_KEY_GENERATION: "0" } as WatchdogEnv,
    );
    await expect(watchdog.tick(Date.parse("2026-08-02T00:00:00.000Z"), vi.fn()))
      .rejects.toThrow(/signing key/iu);
  });
});

describe("record operation identity", () => {
  const baseEvent = {
    accountId: null,
    cellId: null,
    severity: "ERROR" as const,
    healthKind: "QUEUE_LAG_HIGH",
    status: "OPEN" as const,
    fingerprint: "queue-lag:p95",
    observedAt: "2026-07-29T10:00:00.000Z",
    contentFreeMetrics: {},
  };
  const base = {
    organizationId: ORG,
    events: [baseEvent],
    controls: ["PAUSE_ALL_OUTBOUND_MEDIA"],
    notificationFingerprints: ["queue-lag:p95"],
    repeatWindow: 900,
  };

  it("is deterministic for identical pending effects so a retry cannot duplicate them", async () => {
    const first = await deriveRecordOperationId(base);
    const second = await deriveRecordOperationId({ ...base, events: [{ ...baseEvent }] });
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  });

  it("changes whenever the effects change", async () => {
    const first = await deriveRecordOperationId(base);
    for (const mutated of [
      { ...base, controls: [] },
      { ...base, notificationFingerprints: [] },
      { ...base, repeatWindow: 300 },
      { ...base, organizationId: "bbbb0000-0000-4000-8000-000000000001" },
      { ...base, events: [{ ...baseEvent, fingerprint: "queue-lag:other" }] },
    ]) {
      expect(await deriveRecordOperationId(mutated)).not.toBe(first);
    }
  });
});
