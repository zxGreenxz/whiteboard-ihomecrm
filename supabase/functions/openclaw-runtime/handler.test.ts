import { describe, expect, it, vi } from "vitest";

import { handleRuntimeRequest } from "./handler";
import {
  CHANNEL_WORK_KINDS,
  findRuntimeRoute,
  MAINTENANCE_WORK_KINDS,
  RUNTIME_ROUTES,
  validateInboundBatch,
  workKindIsAllowed,
} from "./schemas";

const ORGANIZATION_ID = "dddd0000-0000-4000-8000-000000000001";
const ACCOUNT_ID = "dddd1000-0000-4000-8000-000000000001";
const CELL_ID = "dddd2000-0000-4000-8000-000000000001";
const MAINTENANCE_ID = "dddd3000-0000-4000-8000-000000000001";

const channelPrincipal = {
  version: 1 as const,
  principalKind: "CHANNEL" as const,
  organizationId: ORGANIZATION_ID,
  accountId: ACCOUNT_ID,
  cellId: CELL_ID,
  credentialGeneration: 1,
  leaseGeneration: 1,
  fencingToken: 1,
  sessionGeneration: 1,
};

const maintenancePrincipal = {
  version: 1 as const,
  principalKind: "MAINTENANCE" as const,
  organizationId: ORGANIZATION_ID,
  maintenancePrincipalId: MAINTENANCE_ID,
  credentialGeneration: 1,
  leaseGeneration: 1,
  fencingToken: 1,
};

function runtimeRequest(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`https://edge.invalid/openclaw-runtime${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer runtime.token.value",
      "x-openclaw-timestamp": "1785062400",
      "x-openclaw-nonce": "dddd7000-0000-4000-8000-000000000001",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function dependencies(options: {
  rpc?: ReturnType<typeof vi.fn>;
  verify?: ReturnType<typeof vi.fn>;
  principal?: unknown;
  logger?: { error: ReturnType<typeof vi.fn> };
} = {}) {
  const rpc = options.rpc ?? vi.fn(() => Promise.resolve({ data: { version: 1 }, error: null }));
  const principal = options.principal ?? channelPrincipal;
  const verify = options.verify ??
    vi.fn(() => Promise.resolve({ principal, nonce: "n", operation: "op", bodySha256: "0".repeat(64) }));
  return {
    environment: {
      supabaseUrl: "https://tryymsxyyckgbrmmvozx.supabase.co",
      supabaseAnonKey: "anon",
      supabaseServiceRoleKey: "service",
      runtimeTokenSigningKey: "x".repeat(48),
      browserOrigins: ["https://ptcrm.vercel.app"],
    },
    createServiceClient: () => ({ rpc }),
    verifyRuntimeRequest: verify,
    logger: options.logger ?? { error: vi.fn() },
    requestIdFactory: () => "dddd9000-0000-4000-8000-000000000001",
    now: () => new Date("2026-08-01T00:00:00.000Z"),
    rpc,
    verify,
  };
}

describe("OpenClaw runtime route allowlist", () => {
  it("exposes exactly the nineteen approved runtime routes", () => {
    expect(RUNTIME_ROUTES.map((route) => route.path)).toEqual([
      "/v1/heartbeat",
      "/v1/qr/publish",
      "/v1/qr/result",
      "/v1/inbound/batch",
      "/v1/outbox/claim",
      "/v1/outbox/preflight",
      "/v1/outbox/authorize-send",
      "/v1/outbox/requeue",
      "/v1/outbox/complete",
      "/v1/work/claim",
      "/v1/work/complete",
      "/v1/work/create-outbox",
      "/v1/media/upload-ticket",
      "/v1/maintenance/work/claim",
      "/v1/maintenance/work/complete",
      "/v1/maintenance/media/upload-ticket",
      "/v1/maintenance/media/verify-ticket",
      "/v1/maintenance/retention/delete-ticket",
      "/v1/maintenance/retention/authorize-delete",
    ]);
  });

  it("binds every route to one public service facade and one principal audience", () => {
    for (const route of RUNTIME_ROUTES) {
      expect(route.facade, route.path).toMatch(/^openclaw_service_[a-z0-9_]+_v1$/);
      expect(["CHANNEL", "MAINTENANCE"], route.path).toContain(route.principalKind);
      expect(route.path.startsWith("/v1/maintenance/"), route.path).toBe(
        route.principalKind === "MAINTENANCE",
      );
    }
  });

  it("resolves only POST and rejects unmapped paths and methods", () => {
    expect(findRuntimeRoute("POST", "/v1/heartbeat")?.operation).toBe("heartbeat");
    expect(findRuntimeRoute("GET", "/v1/heartbeat")).toBeNull();
    expect(findRuntimeRoute("POST", "/v1/heartbeat/")).toBeNull();
    expect(findRuntimeRoute("POST", "/v1/admin")).toBeNull();
    expect(findRuntimeRoute("POST", "/v1/../v1/heartbeat")).toBeNull();
  });

  it("keeps send-work and maintenance-work kinds disjoint", () => {
    for (const kind of CHANNEL_WORK_KINDS) {
      expect(MAINTENANCE_WORK_KINDS).not.toContain(kind);
    }
    const channelClaim = findRuntimeRoute("POST", "/v1/work/claim")!;
    const maintenanceClaim = findRuntimeRoute("POST", "/v1/maintenance/work/claim")!;

    expect(workKindIsAllowed(channelClaim, ["INBOUND_AUTOMATION"])).toBe(true);
    expect(workKindIsAllowed(channelClaim, ["RETENTION_DELETE"])).toBe(false);
    expect(workKindIsAllowed(maintenanceClaim, ["AUDIT_ANCHOR"])).toBe(true);
    expect(workKindIsAllowed(maintenanceClaim, ["CRM_EVENT"])).toBe(false);
    expect(workKindIsAllowed(channelClaim, [])).toBe(false);
  });
});

describe("OpenClaw inbound batch validation", () => {
  const event = (overrides: Record<string, unknown> = {}) => ({
    organizationId: ORGANIZATION_ID,
    accountId: ACCOUNT_ID,
    providerEventId: "provider-event-1",
    payloadSha256: "a".repeat(64),
    ...overrides,
  });

  it("accepts a bounded single-tenant batch", () => {
    expect(validateInboundBatch({ events: [event()] }).ok).toBe(true);
  });

  it("rejects a batch above one hundred events", () => {
    const events = Array.from({ length: 101 }, (_unused, index) =>
      event({ providerEventId: `provider-event-${index}` }));
    expect(validateInboundBatch({ events })).toEqual({
      ok: false,
      reason: "BATCH_TOO_LARGE",
    });
  });

  it("rejects mixed organization or account identifiers", () => {
    expect(
      validateInboundBatch({
        events: [
          event(),
          event({
            organizationId: "aaaa0000-0000-4000-8000-000000000001",
            providerEventId: "provider-event-2",
          }),
        ],
      }),
    ).toEqual({ ok: false, reason: "BATCH_MIXED_TENANT" });
  });

  it("rejects a duplicate event id whose payload hash disagrees", () => {
    expect(
      validateInboundBatch({
        events: [event(), event({ payloadSha256: "b".repeat(64) })],
      }),
    ).toEqual({ ok: false, reason: "BATCH_DUPLICATE_CONFLICT" });
  });

  it("accepts an idempotent duplicate whose payload hash matches", () => {
    expect(validateInboundBatch({ events: [event(), event()] }).ok).toBe(true);
  });
});

describe("OpenClaw runtime API handler", () => {
  it("rejects an unmapped route before any database access", async () => {
    const dependency = dependencies();
    const response = await handleRuntimeRequest(
      runtimeRequest("/v1/admin/exec", { version: 1 }),
      dependency,
    );

    expect(response.status).toBe(404);
    expect(dependency.rpc).not.toHaveBeenCalled();
    expect(dependency.verify).not.toHaveBeenCalled();
  });

  it("rejects any browser Origin header on a runtime route", async () => {
    const dependency = dependencies();
    const response = await handleRuntimeRequest(
      runtimeRequest("/v1/heartbeat", { version: 1 }, { origin: "https://ptcrm.vercel.app" }),
      dependency,
    );

    expect(response.status).toBe(403);
    expect(dependency.rpc).not.toHaveBeenCalled();
  });

  it("calls the mapped facade with the verified principal envelope", async () => {
    const dependency = dependencies();
    const response = await handleRuntimeRequest(
      runtimeRequest("/v1/outbox/claim", { version: 1, claimToken: "token", limit: 5 }),
      dependency,
    );

    expect(response.status).toBe(200);
    expect(dependency.rpc).toHaveBeenCalledTimes(1);
    expect(dependency.rpc.mock.calls[0][0]).toBe("openclaw_service_claim_outbox_v1");
    const args = dependency.rpc.mock.calls[0][1] as Record<string, unknown>;
    expect(args.p_principal).toEqual(channelPrincipal);
    expect(args.p_request).toEqual({ version: 1, claimToken: "token", limit: 5 });
  });

  it("refuses a maintenance route when the token carries a channel principal", async () => {
    const dependency = dependencies({ principal: channelPrincipal });
    const response = await handleRuntimeRequest(
      runtimeRequest("/v1/maintenance/work/claim", {
        version: 1,
        requestedKinds: ["RETENTION_DELETE"],
      }),
      dependency,
    );

    expect(response.status).toBe(403);
    expect(dependency.rpc).not.toHaveBeenCalled();
  });

  it("refuses a channel route when the token carries a maintenance principal", async () => {
    const dependency = dependencies({ principal: maintenancePrincipal });
    const response = await handleRuntimeRequest(
      runtimeRequest("/v1/outbox/claim", { version: 1, claimToken: "token" }),
      dependency,
    );

    expect(response.status).toBe(403);
    expect(dependency.rpc).not.toHaveBeenCalled();
  });

  it("lets maintenance work run while no channel account is usable", async () => {
    const dependency = dependencies({ principal: maintenancePrincipal });
    const response = await handleRuntimeRequest(
      runtimeRequest("/v1/maintenance/work/claim", {
        version: 1,
        requestedKinds: ["AUDIT_ANCHOR"],
      }),
      dependency,
    );

    expect(response.status).toBe(200);
    expect(dependency.rpc.mock.calls[0][1].p_principal).toEqual(maintenancePrincipal);
  });

  it("refuses a work kind outside the route class", async () => {
    const dependency = dependencies();
    const response = await handleRuntimeRequest(
      runtimeRequest("/v1/work/claim", { version: 1, requestedKinds: ["RETENTION_DELETE"] }),
      dependency,
    );

    expect(response.status).toBe(403);
    expect(dependency.rpc).not.toHaveBeenCalled();
  });

  it("rejects an oversized or over-count inbound batch before the facade", async () => {
    const dependency = dependencies();
    const response = await handleRuntimeRequest(
      runtimeRequest("/v1/inbound/batch", {
        version: 1,
        events: Array.from({ length: 101 }, (_unused, index) => ({
          organizationId: ORGANIZATION_ID,
          accountId: ACCOUNT_ID,
          providerEventId: `event-${index}`,
          payloadSha256: "a".repeat(64),
        })),
      }),
      dependency,
    );

    expect(response.status).toBe(400);
    expect(dependency.rpc).not.toHaveBeenCalled();
  });

  it("rejects any secret-like field anywhere in a runtime body", async () => {
    const dependency = dependencies();
    for (const body of [
      { version: 1, credential: "root-secret" },
      { version: 1, nested: { deep: { apiKey: "abc" } } },
      { version: 1, list: [{ runtimeToken: "abc" }] },
    ]) {
      const response = await handleRuntimeRequest(
        runtimeRequest("/v1/heartbeat", body),
        dependency,
      );
      expect(response.status).toBe(400);
    }
    expect(dependency.rpc).not.toHaveBeenCalled();
  });

  it("maps an invalid or replayed token to 401 without touching the database", async () => {
    const verify = vi.fn(() => Promise.reject(new Error("nonce replay")));
    const dependency = dependencies({ verify });
    const response = await handleRuntimeRequest(
      runtimeRequest("/v1/heartbeat", { version: 1 }),
      dependency,
    );

    expect(response.status).toBe(401);
    expect(dependency.rpc).not.toHaveBeenCalled();
  });

  it("maps a stale fencing or session denial to 403 and never leaks SQL text", async () => {
    const rpc = vi.fn(() =>
      Promise.resolve({
        data: null,
        error: {
          code: "42501",
          message: "fencing token mismatch for cell dddd2000-0000-4000-8000-000000000001",
        },
      })
    );
    const dependency = dependencies({ rpc });
    const response = await handleRuntimeRequest(
      runtimeRequest("/v1/outbox/complete", { version: 1, outboxId: ACCOUNT_ID }),
      dependency,
    );
    const body = await response.text();

    expect(response.status).toBe(403);
    expect(body).not.toContain("fencing token mismatch");
  });

  it("maps a CAS conflict to 409 so the runtime retries instead of double sending", async () => {
    const rpc = vi.fn(() =>
      Promise.resolve({ data: null, error: { code: "40001", message: "CAS failed" } })
    );
    const dependency = dependencies({ rpc });
    const response = await handleRuntimeRequest(
      runtimeRequest("/v1/outbox/authorize-send", { version: 1, outboxId: ACCOUNT_ID }),
      dependency,
    );

    expect(response.status).toBe(409);
  });

  it("answers with no-store headers and never sets CORS on runtime routes", async () => {
    const dependency = dependencies();
    const response = await handleRuntimeRequest(
      runtimeRequest("/v1/heartbeat", { version: 1 }),
      dependency,
    );

    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});