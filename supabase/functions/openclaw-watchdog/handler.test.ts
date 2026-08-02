import { describe, expect, it, vi } from "vitest";

import { canonicalJson, sha256Hex, utf8 } from "../_shared/openclaw/crypto";
import {
  handleWatchdogRequest,
  WATCHDOG_HEALTH_RPC,
  type WatchdogDependencies,
} from "./handler";
import {
  WATCHDOG_ENVELOPE_AUDIENCE,
  WATCHDOG_ENVELOPE_DOMAIN,
  WATCHDOG_ENVELOPE_PATH,
  type WatchdogEnvelope,
  type WatchdogEnvelopeKey,
} from "./schemas";

const ORG = "dddd0000-0000-4000-8000-000000000001";
const OTHER_ORG = "dddd0000-0000-4000-8000-000000000002";
const CELL = "dddd2000-0000-4000-8000-000000000001";
const EDGE_URL = `https://project.supabase.co${WATCHDOG_ENVELOPE_PATH}`;

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64Url(bytes: Uint8Array): string {
  return base64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

interface SigningKey {
  generation: number;
  privateKey: CryptoKey;
  registry: WatchdogEnvelopeKey;
}

async function signingKey(overrides: Partial<WatchdogEnvelopeKey> = {}): Promise<SigningKey> {
  const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  const generation = overrides.generation ?? 7;
  return {
    generation,
    privateKey: pair.privateKey,
    registry: {
      generation,
      organizationId: ORG,
      publicKeySpkiBase64: base64(spki),
      allowedOperations: ["health.probe", "health.record", "host.guard"],
      activatesAt: "2026-01-01T00:00:00.000Z",
      retiresAt: null,
      revokedAt: null,
      ...overrides,
    },
  };
}

const NOW = Date.parse("2026-08-02T00:00:00.000Z");

function dependencies(
  keys: SigningKey[],
  overrides: Partial<WatchdogDependencies> = {},
): WatchdogDependencies {
  const consumed = new Set<string>();
  return {
    envelopeKeys: Object.fromEntries(keys.map((key) => [String(key.generation), key.registry])),
    consumeEnvelopeNonce: vi.fn(async ({ nonce }: { nonce: string }) => {
      if (consumed.has(nonce)) return false;
      consumed.add(nonce);
      return true;
    }),
    now: () => new Date(NOW),
    probe: vi.fn(async (organizationId: string) => ({
      version: 1 as const,
      organizationId,
      observedAt: "2026-08-02T00:00:00.000Z",
      probeOk: true,
      heartbeatAt: "2026-08-01T23:59:59.000Z",
      metrics: {},
    })),
    recordHealth: vi.fn(async ({ events }: { events: unknown[] }) => ({ recorded: events.length })),
    applyCapacityControls: vi.fn(async () => undefined),
    notifyOwnerAdmins: vi.fn(async () => ({ push: 1, email: 1 })),
    requestIdFactory: () => "request-1",
    ...overrides,
  } as WatchdogDependencies;
}

let nonceCounter = 0;
function nextNonce(): string {
  nonceCounter += 1;
  return `dddd9000-0000-4000-8000-${String(nonceCounter).padStart(12, "0")}`;
}

async function envelopeFor(
  key: SigningKey,
  body: unknown,
  overrides: Partial<WatchdogEnvelope> = {},
): Promise<WatchdogEnvelope> {
  const raw = utf8(JSON.stringify(body));
  return {
    version: 1,
    audience: WATCHDOG_ENVELOPE_AUDIENCE,
    operation: "health.probe",
    method: "POST",
    path: WATCHDOG_ENVELOPE_PATH,
    organizationId: ORG,
    keyGeneration: key.generation,
    timestamp: Math.floor(NOW / 1_000),
    nonce: nextNonce(),
    bodySha256: await sha256Hex(raw),
    ...overrides,
  };
}

async function signedRequest(
  key: SigningKey,
  body: unknown,
  overrides: Partial<WatchdogEnvelope> = {},
  mutate: { body?: unknown; signature?: string; headers?: Record<string, string> } = {},
): Promise<Request> {
  const envelope = await envelopeFor(key, body, overrides);
  const signature = new Uint8Array(await crypto.subtle.sign(
    "Ed25519",
    key.privateKey,
    utf8(`${WATCHDOG_ENVELOPE_DOMAIN}\0${canonicalJson(envelope)}`),
  ));
  return new Request(EDGE_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-openclaw-watchdog-envelope": base64Url(utf8(canonicalJson(envelope))),
      "x-openclaw-watchdog-signature": mutate.signature ?? base64Url(signature),
      ...mutate.headers,
    },
    body: JSON.stringify(mutate.body ?? body),
  });
}

const probeBody = {
  version: 1,
  operation: "PROBE",
  organizationId: ORG,
  probeId: "dddd4000-0000-4000-8000-000000000001",
  observedAt: "2026-08-02T00:00:00.000Z",
};

const recordBody = {
  version: 1,
  operation: "RECORD",
  organizationId: ORG,
  operationId: "dddd4000-0000-4000-8000-000000000002",
  observedAt: "2026-08-02T00:00:00.000Z",
  events: [{
    accountId: null,
    cellId: null,
    severity: "CRITICAL",
    healthKind: "WATCHDOG_HEARTBEAT_STALE",
    status: "OPEN",
    fingerprint: "heartbeat:stale",
    observedAt: "2026-08-02T00:00:00.000Z",
    contentFreeMetrics: { heartbeatAgeSeconds: 91 },
  }],
  controls: ["PAUSE_ALL_OUTBOUND_MEDIA"],
  notification: { fingerprints: ["heartbeat:stale"], repeatWindow: 42, requiredWithinSeconds: 180 },
};

const hostGuardBody = {
  version: 1,
  operation: "HOST_GUARD",
  organizationId: ORG,
  operationId: "dddd4000-0000-4000-8000-000000000003",
  observedAt: "2026-08-02T00:00:00.000Z",
  cellId: CELL,
  state: "TRIPPED",
  fingerprint: "host-guard:ram",
  controls: ["PAUSE_OUTBOUND_AI_MEDIA"],
  contentFreeMetrics: { ramPercent: 76 },
};

function noDependencyRan(deps: WatchdogDependencies): void {
  expect(deps.probe).not.toHaveBeenCalled();
  expect(deps.recordHealth).not.toHaveBeenCalled();
  expect(deps.applyCapacityControls).not.toHaveBeenCalled();
  expect(deps.notifyOwnerAdmins).not.toHaveBeenCalled();
}

describe("openclaw-watchdog Edge handler", () => {
  it("exposes only the dedicated content-free probe operation", async () => {
    const key = await signingKey();
    const deps = dependencies([key]);
    const response = await handleWatchdogRequest(await signedRequest(key, probeBody), deps);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ version: 1, organizationId: ORG, probeOk: true });
    expect(deps.recordHealth).not.toHaveBeenCalled();
  });

  it("records through the narrow watchdog facade and notifies owner/admin once requested", async () => {
    expect(WATCHDOG_HEALTH_RPC).toBe("openclaw_service_record_watchdog_health_v1");
    const key = await signingKey();
    const deps = dependencies([key]);
    const response = await handleWatchdogRequest(
      await signedRequest(key, recordBody, { operation: "health.record" }),
      deps,
    );
    expect(response.status).toBe(200);
    expect(deps.recordHealth).toHaveBeenCalledTimes(1);
    expect(deps.applyCapacityControls).toHaveBeenCalledTimes(1);
    expect(deps.notifyOwnerAdmins).toHaveBeenCalledTimes(1);
  });

  it("accepts host guard pause but never grants automatic resume", async () => {
    const key = await signingKey();
    const deps = dependencies([key]);
    const response = await handleWatchdogRequest(
      await signedRequest(key, hostGuardBody, { operation: "host.guard" }),
      deps,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ manualResumeRequired: true });
    expect(deps.applyCapacityControls).toHaveBeenCalledWith(expect.objectContaining({
      controls: ["PAUSE_OUTBOUND_AI_MEDIA"],
    }));
  });

  it("allows a repeat-window notification without duplicating the incident row", async () => {
    const key = await signingKey();
    const deps = dependencies([key]);
    const body = {
      ...recordBody,
      operationId: "dddd4000-0000-4000-8000-000000000004",
      observedAt: "2026-08-02T00:15:00.000Z",
      events: [],
      controls: [],
      notification: { fingerprints: ["heartbeat:stale"], repeatWindow: 43, requiredWithinSeconds: 180 },
    };
    const response = await handleWatchdogRequest(
      await signedRequest(key, body, { operation: "health.record" }),
      deps,
    );
    expect(response.status).toBe(200);
    expect(deps.recordHealth).not.toHaveBeenCalled();
    expect(deps.notifyOwnerAdmins).toHaveBeenCalledTimes(1);
  });

  it("rejects browser origins and Gateway-shaped fields before dependencies", async () => {
    const key = await signingKey();
    const deps = dependencies([key]);
    const browser = await handleWatchdogRequest(
      await signedRequest(key, probeBody, {}, { headers: { origin: "https://ptcrm.vercel.app" } }),
      deps,
    );
    expect(browser.status).toBe(403);
    const gatewayBody = { ...probeBody, gatewayUrl: "http://cell:18789" };
    const gateway = await handleWatchdogRequest(await signedRequest(key, gatewayBody), deps);
    expect(gateway.status).toBe(400);
    expect(deps.probe).not.toHaveBeenCalled();
  });

  it("rejects a Supabase browser JWT presented as a bearer credential", async () => {
    const key = await signingKey();
    const deps = dependencies([key]);
    const response = await handleWatchdogRequest(
      await signedRequest(key, probeBody, {}, {
        headers: { authorization: `Bearer ${"e".repeat(180)}` },
      }),
      deps,
    );
    expect(response.status).toBe(401);
    noDependencyRan(deps);
  });

  it("rejects an unsigned request that carries no envelope at all", async () => {
    const key = await signingKey();
    const deps = dependencies([key]);
    const response = await handleWatchdogRequest(
      new Request(EDGE_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(probeBody),
      }),
      deps,
    );
    expect(response.status).toBe(401);
    noDependencyRan(deps);
  });

  it("rejects a forged signature made by a key outside the registry", async () => {
    const key = await signingKey();
    const forger = await signingKey({ generation: key.generation });
    const deps = dependencies([key]);
    const envelope = await envelopeFor(key, probeBody);
    const signature = new Uint8Array(await crypto.subtle.sign(
      "Ed25519",
      forger.privateKey,
      utf8(`${WATCHDOG_ENVELOPE_DOMAIN}\0${canonicalJson(envelope)}`),
    ));
    const response = await handleWatchdogRequest(
      new Request(EDGE_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-openclaw-watchdog-envelope": base64Url(utf8(canonicalJson(envelope))),
          "x-openclaw-watchdog-signature": base64Url(signature),
        },
        body: JSON.stringify(probeBody),
      }),
      deps,
    );
    expect(response.status).toBe(403);
    noDependencyRan(deps);
  });

  it("rejects a replayed envelope whose nonce was already consumed", async () => {
    const key = await signingKey();
    const deps = dependencies([key]);
    const request = await signedRequest(key, probeBody);
    const first = await handleWatchdogRequest(request.clone(), deps);
    expect(first.status).toBe(200);
    const replay = await handleWatchdogRequest(request, deps);
    expect(replay.status).toBe(403);
    expect(deps.probe).toHaveBeenCalledTimes(1);
  });

  it("rejects an envelope outside the sixty second clock window", async () => {
    const key = await signingKey();
    const deps = dependencies([key]);
    const stale = await handleWatchdogRequest(
      await signedRequest(key, probeBody, { timestamp: Math.floor(NOW / 1_000) - 61 }),
      deps,
    );
    expect(stale.status).toBe(403);
    const future = await handleWatchdogRequest(
      await signedRequest(key, probeBody, { timestamp: Math.floor(NOW / 1_000) + 61 }),
      deps,
    );
    expect(future.status).toBe(403);
    noDependencyRan(deps);
  });

  it("rejects a body swapped after the envelope was signed", async () => {
    const key = await signingKey();
    const deps = dependencies([key]);
    const response = await handleWatchdogRequest(
      await signedRequest(key, probeBody, {}, {
        body: { ...probeBody, probeId: "dddd4000-0000-4000-8000-00000000000f" },
      }),
      deps,
    );
    expect(response.status).toBe(403);
    noDependencyRan(deps);
  });

  it("rejects an envelope bound to a different operation than the body", async () => {
    const key = await signingKey();
    const deps = dependencies([key]);
    const response = await handleWatchdogRequest(
      await signedRequest(key, recordBody, { operation: "health.probe" }),
      deps,
    );
    expect(response.status).toBe(403);
    noDependencyRan(deps);
  });

  it("rejects an envelope bound to a foreign audience or path", async () => {
    const key = await signingKey();
    const deps = dependencies([key]);
    const audience = await handleWatchdogRequest(
      await signedRequest(key, probeBody, {
        audience: "openclaw-runtime-maintenance" as WatchdogEnvelope["audience"],
      }),
      deps,
    );
    expect(audience.status).toBe(403);
    const path = await handleWatchdogRequest(
      await signedRequest(key, probeBody, { path: "/functions/v1/openclaw-runtime" }),
      deps,
    );
    expect(path.status).toBe(403);
    noDependencyRan(deps);
  });

  it("rejects a retired, revoked, or unknown key generation", async () => {
    const current = await signingKey();
    const retired = await signingKey({ generation: 6, retiresAt: "2026-07-01T00:00:00.000Z" });
    const revoked = await signingKey({ generation: 5, revokedAt: "2026-07-15T00:00:00.000Z" });
    const deps = dependencies([current, retired, revoked]);
    for (const key of [retired, revoked]) {
      const response = await handleWatchdogRequest(await signedRequest(key, probeBody, {
        keyGeneration: key.generation,
      }), deps);
      expect(response.status).toBe(403);
    }
    const unknown = await signingKey({ generation: 99 });
    const response = await handleWatchdogRequest(
      await signedRequest(unknown, probeBody, { keyGeneration: 99 }),
      dependencies([current]),
    );
    expect(response.status).toBe(403);
    noDependencyRan(deps);
  });

  it("rejects a key generation signing outside its allowed operations", async () => {
    const hostKey = await signingKey({ generation: 8, allowedOperations: ["host.guard"] });
    const deps = dependencies([hostKey]);
    const response = await handleWatchdogRequest(
      await signedRequest(hostKey, recordBody, { operation: "health.record" }),
      deps,
    );
    expect(response.status).toBe(403);
    noDependencyRan(deps);
  });

  it("rejects a cross-organization payload signed by a valid key", async () => {
    const key = await signingKey();
    const deps = dependencies([key]);
    const foreignBody = { ...probeBody, organizationId: OTHER_ORG };
    const mismatch = await handleWatchdogRequest(await signedRequest(key, foreignBody), deps);
    expect(mismatch.status).toBe(403);
    const foreignEnvelope = await handleWatchdogRequest(
      await signedRequest(key, foreignBody, { organizationId: OTHER_ORG }),
      deps,
    );
    expect(foreignEnvelope.status).toBe(403);
    noDependencyRan(deps);
  });

  it("never logs the envelope, signature, or key material on failure", async () => {
    const key = await signingKey();
    const logger = { error: vi.fn() };
    const deps = dependencies([key], { logger });
    const request = await signedRequest(key, probeBody, { timestamp: Math.floor(NOW / 1_000) - 61 });
    const signature = request.headers.get("x-openclaw-watchdog-signature") ?? "";
    const envelope = request.headers.get("x-openclaw-watchdog-envelope") ?? "";
    const response = await handleWatchdogRequest(request, deps);
    expect(response.status).toBe(403);
    expect(logger.error).toHaveBeenCalled();
    const logged = JSON.stringify(logger.error.mock.calls);
    expect(logged).not.toContain(signature);
    expect(logged).not.toContain(envelope);
    expect(logged).not.toContain(key.registry.publicKeySpkiBase64);
  });
});
