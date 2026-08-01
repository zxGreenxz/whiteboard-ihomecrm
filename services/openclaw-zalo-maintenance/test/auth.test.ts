import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  authorizeMaintenance,
  channelStateAffectsMaintenance,
  createMaintenanceRuntimeClient,
  MAINTENANCE_WORK_KINDS,
  MaintenanceRuntimeApiError,
  type MaintenanceAuthState,
} from "../src/runtime-client.js";

const ORGANIZATION_ID = "dddd0000-0000-4000-8000-000000000001";
const MAINTENANCE_ID = "dddd3000-0000-4000-8000-000000000001";
const CLAIM_TOKEN = "claim-token-0123456789abcdef0123456789abcdef";
const NOW = 1_785_062_400_000;

function state(overrides: Partial<MaintenanceAuthState> = {}): MaintenanceAuthState {
  return {
    principal: {
      version: 1,
      principalKind: "MAINTENANCE",
      organizationId: ORGANIZATION_ID,
      maintenancePrincipalId: MAINTENANCE_ID,
      credentialGeneration: 2,
      leaseGeneration: 3,
      fencingToken: 4,
    },
    credentialEnabled: true,
    credentialRevoked: false,
    leaseStatus: "ACTIVE",
    leaseExpiresAtEpochMs: NOW + 60_000,
    currentCredentialGeneration: 2,
    currentLeaseGeneration: 3,
    currentFencingToken: 4,
    allowedScopes: ["maintenance.claim", "maintenance.complete"],
    ...overrides,
  };
}

function authorize(overrides: Record<string, unknown> = {}) {
  return authorizeMaintenance({
    state: state(),
    expectedOrganizationId: ORGANIZATION_ID,
    operation: "maintenance.claim",
    workKind: "RETENTION_DELETE",
    nowEpochMs: NOW,
    ...overrides,
  } as Parameters<typeof authorizeMaintenance>[0]);
}

describe("Maintenance principal authentication", () => {
  it("authorizes an organization-scoped maintenance credential", () => {
    expect(authorize()).toEqual({ allowed: true });
  });

  it("succeeds with no active Zalo account and an offline channel cell", () => {
    // There is no channel input at all in the decision, which is the invariant.
    expect(channelStateAffectsMaintenance()).toBe(false);
    expect(authorize()).toEqual({ allowed: true });
  });

  it("refuses a principal from another organization", () => {
    expect(
      authorize({ expectedOrganizationId: "aaaa0000-0000-4000-8000-000000000001" }).denial,
    ).toBe("WRONG_ORGANIZATION");
  });

  it("refuses a channel principal masquerading as maintenance", () => {
    expect(
      authorize({
        state: state({
          principal: {
            ...state().principal,
            principalKind: "CHANNEL" as never,
          },
        }),
      }).denial,
    ).toBe("WRONG_PRINCIPAL_KIND");
  });

  it("refuses a disabled or revoked credential", () => {
    expect(authorize({ state: state({ credentialEnabled: false }) }).denial)
      .toBe("CREDENTIAL_DISABLED");
    expect(authorize({ state: state({ credentialRevoked: true }) }).denial)
      .toBe("CREDENTIAL_REVOKED");
  });

  it("refuses a stale credential, lease, or fencing generation", () => {
    expect(authorize({ state: state({ currentCredentialGeneration: 3 }) }).denial)
      .toBe("STALE_CREDENTIAL_GENERATION");
    expect(authorize({ state: state({ currentLeaseGeneration: 4 }) }).denial)
      .toBe("STALE_LEASE_GENERATION");
    expect(authorize({ state: state({ currentFencingToken: 5 }) }).denial)
      .toBe("STALE_FENCING_TOKEN");
  });

  it("refuses an inactive or expired lease", () => {
    expect(authorize({ state: state({ leaseStatus: "EXPIRED" }) }).denial)
      .toBe("LEASE_NOT_ACTIVE");
    expect(authorize({ state: state({ leaseExpiresAtEpochMs: NOW }) }).denial)
      .toBe("LEASE_EXPIRED");
  });

  it("refuses an operation outside the granted scopes", () => {
    expect(
      authorize({ state: state({ allowedScopes: ["maintenance.claim"] }), operation: "maintenance.complete" })
        .denial,
    ).toBe("SCOPE_NOT_GRANTED");
  });

  it("refuses a send-work kind on a maintenance route", () => {
    for (const workKind of ["INBOUND_AUTOMATION", "SCHEDULE_OCCURRENCE", "CRM_EVENT"]) {
      expect(authorize({ workKind }).denial, workKind).toBe("WORK_KIND_FORBIDDEN");
    }
    for (const workKind of MAINTENANCE_WORK_KINDS) {
      expect(authorize({ workKind }), workKind).toEqual({ allowed: true });
    }
  });
});

describe("Maintenance runtime token exchange", () => {
  it("binds every in-flight fetch to the process shutdown signal", async () => {
    const controller = new AbortController();
    const fetch = vi.fn<typeof globalThis.fetch>();
    fetch
      .mockResolvedValueOnce(new Response(JSON.stringify({
        version: 1,
        requestId: "dddd7000-0000-4000-8000-000000000010",
        result: {
          version: 1,
          token: "short-lived-maintenance-token",
          expiresInSeconds: 60,
        },
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        version: 1,
        requestId: "dddd7000-0000-4000-8000-000000000011",
        result: {
          version: 1,
          items: [],
          unresolvedFailures: { retentionDelete: 0, auditAnchor: 0 },
        },
      }), { status: 200, headers: { "content-type": "application/json" } }));
    const nonces = [
      "dddd7000-0000-4000-8000-000000000001",
      "dddd7000-0000-4000-8000-000000000002",
    ];
    const client = createMaintenanceRuntimeClient({
      functionsBaseUrl: "https://project.supabase.co/functions/v1/",
      organizationId: ORGANIZATION_ID,
      maintenancePrincipalId: MAINTENANCE_ID,
      credential: "maintenance-root-credential-0123456789abcdef",
      fetch,
      nonce: () => nonces.shift()!,
      signal: controller.signal,
    });

    await client.post("/v1/maintenance/work/claim", {
      version: 1,
      claimToken: "claim-token-0123456789abcdef0123456789abcdef",
      limit: 1,
      leaseSeconds: 60,
      requestedKinds: ["RETENTION_DELETE"],
    });
    const requestSignals = fetch.mock.calls.map(([, init]) => init?.signal);
    controller.abort(new Error("maintenance shutdown"));

    expect(requestSignals).toHaveLength(2);
    expect(requestSignals.every((signal) => signal?.aborted === true)).toBe(true);
  });

  it("binds each canonical runtime body to a maintenance-only token exchange", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    fetch
      .mockResolvedValueOnce(new Response(JSON.stringify({
        version: 1,
        requestId: "dddd7000-0000-4000-8000-000000000010",
        result: {
          version: 1,
          token: "short-lived-maintenance-token",
          expiresInSeconds: 300,
        },
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        version: 1,
        requestId: "dddd7000-0000-4000-8000-000000000011",
        result: {
          version: 1,
          items: [],
          unresolvedFailures: { retentionDelete: 0, auditAnchor: 0 },
        },
      }), { status: 200, headers: { "content-type": "application/json" } }));
    const nonces = [
      "dddd7000-0000-4000-8000-000000000001",
      "dddd7000-0000-4000-8000-000000000002",
    ];
    const credential = "maintenance-root-credential-0123456789abcdef";
    const client = createMaintenanceRuntimeClient({
      functionsBaseUrl: "https://project.supabase.co/functions/v1/",
      organizationId: ORGANIZATION_ID,
      maintenancePrincipalId: MAINTENANCE_ID,
      credential,
      fetch,
      nowEpochSeconds: () => 1_785_062_400,
      nonce: () => nonces.shift()!,
    });
    const body = {
      version: 1,
      claimToken: "claim-token-0123456789abcdef0123456789abcdef",
      limit: 4,
      leaseSeconds: 30,
      requestedKinds: ["RETENTION_DELETE", "AUDIT_ANCHOR"],
    };
    const canonicalBody =
      '{"claimToken":"claim-token-0123456789abcdef0123456789abcdef",' +
      '"leaseSeconds":30,"limit":4,"requestedKinds":["RETENTION_DELETE","AUDIT_ANCHOR"],' +
      '"version":1}';

    await expect(client.post("/v1/maintenance/work/claim", body)).resolves.toEqual({
      version: 1,
      items: [],
      unresolvedFailures: { retentionDelete: 0, auditAnchor: 0 },
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    const [exchangeUrl, exchangeInit] = fetch.mock.calls[0]!;
    expect(String(exchangeUrl)).toBe("https://project.supabase.co/functions/v1/openclaw-runtime-token");
    const exchange = JSON.parse(String(exchangeInit?.body));
    expect(exchange).toEqual({
      version: 1,
      principalKind: "MAINTENANCE",
      organizationId: ORGANIZATION_ID,
      maintenancePrincipalId: MAINTENANCE_ID,
      runtimeMethod: "POST",
      runtimePath: "/v1/maintenance/work/claim",
      runtimeTimestamp: 1_785_062_400,
      runtimeNonce: "dddd7000-0000-4000-8000-000000000001",
      runtimeBodySha256: createHash("sha256").update(canonicalBody).digest("hex"),
      exchangeNonce: "dddd7000-0000-4000-8000-000000000002",
    });
    expect(new Headers(exchangeInit?.headers).get("x-openclaw-credential")).toBe(credential);
    expect(String(exchangeInit?.body)).not.toContain(credential);

    const [runtimeUrl, runtimeInit] = fetch.mock.calls[1]!;
    expect(String(runtimeUrl)).toBe(
      "https://project.supabase.co/functions/v1/openclaw-runtime/v1/maintenance/work/claim",
    );
    expect(new Headers(runtimeInit?.headers).get("authorization"))
      .toBe("Bearer short-lived-maintenance-token");
    expect(runtimeInit?.body).toBe(canonicalBody);
  });

  it("fails closed with a sanitized typed error on transport failure", async () => {
    const secret = "maintenance-root-credential-0123456789abcdef";
    const client = createMaintenanceRuntimeClient({
      functionsBaseUrl: "https://project.supabase.co/functions/v1/",
      organizationId: ORGANIZATION_ID,
      maintenancePrincipalId: MAINTENANCE_ID,
      credential: secret,
      fetch: vi.fn().mockRejectedValue(new Error(`network leaked ${secret}`)),
      nonce: vi.fn()
        .mockReturnValueOnce("dddd7000-0000-4000-8000-000000000001")
        .mockReturnValueOnce("dddd7000-0000-4000-8000-000000000002"),
    });

    const error = await client.post("/v1/maintenance/work/claim", {
      version: 1,
      claimToken: "claim-token-0123456789abcdef0123456789abcdef",
      limit: 1,
      leaseSeconds: 30,
      requestedKinds: ["RETENTION_DELETE"],
    }).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(MaintenanceRuntimeApiError);
    expect(String(error)).not.toContain(secret);
    expect((error as MaintenanceRuntimeApiError).stage).toBe("TOKEN_EXCHANGE");
  });

  it("rejects a token exchange result with non-canonical extra fields", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
      version: 1,
      requestId: "dddd7000-0000-4000-8000-000000000010",
      result: {
        version: 1,
        token: "short-lived-maintenance-token",
        expiresInSeconds: 300,
        accountId: "dddd1000-0000-4000-8000-000000000001",
      },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const client = createMaintenanceRuntimeClient({
      functionsBaseUrl: "https://project.supabase.co/functions/v1/",
      organizationId: ORGANIZATION_ID,
      maintenancePrincipalId: MAINTENANCE_ID,
      credential: "maintenance-root-credential-0123456789abcdef",
      fetch,
      nonce: vi.fn()
        .mockReturnValueOnce("dddd7000-0000-4000-8000-000000000001")
        .mockReturnValueOnce("dddd7000-0000-4000-8000-000000000002"),
    });

    await expect(client.post("/v1/maintenance/work/claim", {
      version: 1,
      claimToken: CLAIM_TOKEN,
      limit: 1,
      leaseSeconds: 30,
      requestedKinds: ["RETENTION_DELETE"],
    })).rejects.toThrow("token exchange result invalid");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("rejects a nonce reused by a later request before performing network I/O", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    fetch
      .mockResolvedValueOnce(new Response(JSON.stringify({
        version: 1,
        requestId: "dddd7000-0000-4000-8000-000000000010",
        result: {
          version: 1,
          token: "short-lived-maintenance-token",
          expiresInSeconds: 300,
        },
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        version: 1,
        requestId: "dddd7000-0000-4000-8000-000000000011",
        result: {
          version: 1,
          items: [],
          unresolvedFailures: { retentionDelete: 0, auditAnchor: 0 },
        },
      }), { status: 200, headers: { "content-type": "application/json" } }));
    const nonces = [
      "dddd7000-0000-4000-8000-000000000001",
      "dddd7000-0000-4000-8000-000000000002",
      "dddd7000-0000-4000-8000-000000000001",
      "dddd7000-0000-4000-8000-000000000003",
    ];
    const client = createMaintenanceRuntimeClient({
      functionsBaseUrl: "https://project.supabase.co/functions/v1/",
      organizationId: ORGANIZATION_ID,
      maintenancePrincipalId: MAINTENANCE_ID,
      credential: "maintenance-root-credential-0123456789abcdef",
      fetch,
      nonce: () => nonces.shift()!,
    });
    const body = {
      version: 1,
      claimToken: CLAIM_TOKEN,
      limit: 1,
      leaseSeconds: 30,
      requestedKinds: ["RETENTION_DELETE"],
    };

    await expect(client.post("/v1/maintenance/work/claim", body)).resolves.toEqual({
      version: 1,
      items: [],
      unresolvedFailures: { retentionDelete: 0, auditAnchor: 0 },
    });
    await expect(client.post("/v1/maintenance/work/claim", body))
      .rejects.toThrow("runtime nonces are invalid");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("rejects an oversized response from Content-Length without consuming its body", async () => {
    const response = new Response("{}", {
      status: 200,
      headers: {
        "content-length": String(1_048_577),
        "content-type": "application/json",
      },
    });
    const text = vi.spyOn(response, "text")
      .mockRejectedValue(new Error("oversized body must not be consumed"));
    const client = createMaintenanceRuntimeClient({
      functionsBaseUrl: "https://project.supabase.co/functions/v1/",
      organizationId: ORGANIZATION_ID,
      maintenancePrincipalId: MAINTENANCE_ID,
      credential: "maintenance-root-credential-0123456789abcdef",
      fetch: vi.fn().mockResolvedValue(response),
      nonce: vi.fn()
        .mockReturnValueOnce("dddd7000-0000-4000-8000-000000000001")
        .mockReturnValueOnce("dddd7000-0000-4000-8000-000000000002"),
    });

    await expect(client.post("/v1/maintenance/work/claim", {
      version: 1,
      claimToken: CLAIM_TOKEN,
      limit: 1,
      leaseSeconds: 30,
      requestedKinds: ["RETENTION_DELETE"],
    })).rejects.toThrow("response is too large");
    expect(text).not.toHaveBeenCalled();
  });

  it("cancels a chunked response as soon as its streamed byte limit is exceeded", async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(600_000));
      },
      cancel() {
        cancelled = true;
      },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const client = createMaintenanceRuntimeClient({
      functionsBaseUrl: "https://project.supabase.co/functions/v1/",
      organizationId: ORGANIZATION_ID,
      maintenancePrincipalId: MAINTENANCE_ID,
      credential: "maintenance-root-credential-0123456789abcdef",
      fetch: vi.fn().mockResolvedValue(response),
      nonce: vi.fn()
        .mockReturnValueOnce("dddd7000-0000-4000-8000-000000000001")
        .mockReturnValueOnce("dddd7000-0000-4000-8000-000000000002"),
    });

    await expect(client.post("/v1/maintenance/work/claim", {
      version: 1,
      claimToken: CLAIM_TOKEN,
      limit: 1,
      leaseSeconds: 30,
      requestedKinds: ["RETENTION_DELETE"],
    })).rejects.toThrow("response is too large");
    expect(cancelled).toBe(true);
  });

  it("sanitizes a response-stream failure after token-exchange headers arrive", async () => {
    const secret = "maintenance-root-credential-0123456789abcdef";
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error(`body stream leaked ${secret}`));
      },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const client = createMaintenanceRuntimeClient({
      functionsBaseUrl: "https://project.supabase.co/functions/v1/",
      organizationId: ORGANIZATION_ID,
      maintenancePrincipalId: MAINTENANCE_ID,
      credential: secret,
      fetch: vi.fn().mockResolvedValue(response),
      nonce: vi.fn()
        .mockReturnValueOnce("dddd7000-0000-4000-8000-000000000001")
        .mockReturnValueOnce("dddd7000-0000-4000-8000-000000000002"),
    });

    const error = await client.post("/v1/maintenance/work/claim", {
      version: 1,
      claimToken: CLAIM_TOKEN,
      limit: 1,
      leaseSeconds: 30,
      requestedKinds: ["RETENTION_DELETE"],
    }).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(MaintenanceRuntimeApiError);
    expect(String(error)).not.toContain(secret);
    expect(String(error)).toContain("response body failed");
  });
});
