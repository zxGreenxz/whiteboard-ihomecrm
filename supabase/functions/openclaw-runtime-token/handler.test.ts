import { describe, expect, it, vi } from "vitest";

import { handleRuntimeTokenRequest } from "./handler";
import {
  OPENCLAW_RUNTIME_TOKEN_MAX_TTL_SECONDS,
  principalSelectorFor,
  runtimeTokenRequestSchema,
} from "./schemas";

const ORGANIZATION_ID = "dddd0000-0000-4000-8000-000000000001";
const ACCOUNT_ID = "dddd1000-0000-4000-8000-000000000001";
const CELL_ID = "dddd2000-0000-4000-8000-000000000001";
const MAINTENANCE_ID = "dddd3000-0000-4000-8000-000000000001";
const RUNTIME_NONCE = "dddd7000-0000-4000-8000-000000000001";
const EXCHANGE_NONCE = "dddd7000-0000-4000-8000-000000000002";

const channelBody = {
  version: 1,
  principalKind: "CHANNEL",
  organizationId: ORGANIZATION_ID,
  accountId: ACCOUNT_ID,
  cellId: CELL_ID,
  localSessionGeneration: 4,
  runtimeMethod: "POST",
  runtimePath: "/v1/outbox/claim",
  runtimeTimestamp: 1_785_062_400,
  runtimeNonce: RUNTIME_NONCE,
  runtimeBodySha256: "a".repeat(64),
  exchangeNonce: EXCHANGE_NONCE,
};

const maintenanceBody = {
  version: 1,
  principalKind: "MAINTENANCE",
  organizationId: ORGANIZATION_ID,
  maintenancePrincipalId: MAINTENANCE_ID,
  runtimeMethod: "POST",
  runtimePath: "/v1/maintenance/work/claim",
  runtimeTimestamp: 1_785_062_400,
  runtimeNonce: RUNTIME_NONCE,
  runtimeBodySha256: "b".repeat(64),
  exchangeNonce: EXCHANGE_NONCE,
};

function tokenRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://edge.invalid/openclaw-runtime-token", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-openclaw-credential": "openclaw-runtime-root-credential-value-01",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function dependencies(options: {
  exchange?: ReturnType<typeof vi.fn>;
  logger?: { error: ReturnType<typeof vi.fn> };
} = {}) {
  const exchange = options.exchange ??
    vi.fn(() => Promise.resolve("issued.runtime.token"));
  return {
    environment: {
      supabaseUrl: "https://tryymsxyyckgbrmmvozx.supabase.co",
      supabaseAnonKey: "anon",
      supabaseServiceRoleKey: "service",
      runtimeTokenSigningKey: "x".repeat(48),
      browserOrigins: ["https://ptcrm.vercel.app"],
    },
    createServiceClient: () => ({
      rpc: vi.fn(() => Promise.resolve({ data: {}, error: null })),
    }),
    exchangeRuntimeCredential: exchange,
    logger: options.logger ?? { error: vi.fn() },
    requestIdFactory: () => "dddd9000-0000-4000-8000-000000000001",
    now: () => new Date("2026-08-01T00:00:00.000Z"),
    exchange,
  };
}

describe("OpenClaw runtime token schema", () => {
  it("caps the token lifetime at five minutes", () => {
    expect(OPENCLAW_RUNTIME_TOKEN_MAX_TTL_SECONDS).toBe(300);
  });

  it("accepts the two exchange shapes and nothing else", () => {
    expect(runtimeTokenRequestSchema.safeParse(channelBody).success).toBe(true);
    expect(runtimeTokenRequestSchema.safeParse(maintenanceBody).success).toBe(true);
    expect(runtimeTokenRequestSchema.safeParse({ ...channelBody, principalKind: "ADMIN" }).success)
      .toBe(false);
    expect(
      runtimeTokenRequestSchema.safeParse({ ...channelBody, maintenancePrincipalId: MAINTENANCE_ID })
        .success,
    ).toBe(false);
    expect(
      runtimeTokenRequestSchema.safeParse({ ...maintenanceBody, accountId: ACCOUNT_ID }).success,
    ).toBe(false);
  });

  it("refuses to reuse one nonce for the exchange and the runtime call", () => {
    expect(
      runtimeTokenRequestSchema.safeParse({ ...channelBody, exchangeNonce: RUNTIME_NONCE }).success,
    ).toBe(false);
  });

  it("requires an exact local session generation for channel exchanges only", () => {
    const { localSessionGeneration: _missing, ...withoutLocalGeneration } = channelBody;
    expect(runtimeTokenRequestSchema.safeParse(withoutLocalGeneration).success).toBe(false);
    expect(runtimeTokenRequestSchema.safeParse({
      ...channelBody,
      localSessionGeneration: 0,
    }).success).toBe(false);
    expect(runtimeTokenRequestSchema.safeParse({
      ...maintenanceBody,
      localSessionGeneration: 4,
    }).success).toBe(false);
  });

  it("derives a principal selector with no extra fields", () => {
    expect(principalSelectorFor(channelBody as never)).toEqual({
      organizationId: ORGANIZATION_ID,
      accountId: ACCOUNT_ID,
      cellId: CELL_ID,
    });
    expect(principalSelectorFor(maintenanceBody as never)).toEqual({
      organizationId: ORGANIZATION_ID,
      maintenancePrincipalId: MAINTENANCE_ID,
    });
  });
});

describe("OpenClaw runtime token handler", () => {
  it("exchanges a channel credential and returns a bounded token", async () => {
    const dependency = dependencies();
    const response = await handleRuntimeTokenRequest(tokenRequest(channelBody), dependency);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.result.token).toBe("issued.runtime.token");
    expect(body.result.expiresInSeconds).toBeLessThanOrEqual(
      OPENCLAW_RUNTIME_TOKEN_MAX_TTL_SECONDS,
    );
    expect(dependency.exchange).toHaveBeenCalledTimes(1);
    const call = dependency.exchange.mock.calls[0][0];
    expect(call.principalSelector).toEqual({
      organizationId: ORGANIZATION_ID,
      accountId: ACCOUNT_ID,
      cellId: CELL_ID,
    });
    expect(call.path).toBe("/v1/outbox/claim");
    expect(call.localSessionGeneration).toBe(4);
  });

  it("exchanges a maintenance credential without any channel account binding", async () => {
    const dependency = dependencies();
    const response = await handleRuntimeTokenRequest(tokenRequest(maintenanceBody), dependency);

    expect(response.status).toBe(200);
    const call = dependency.exchange.mock.calls[0][0];
    expect(call.principalSelector).toEqual({
      organizationId: ORGANIZATION_ID,
      maintenancePrincipalId: MAINTENANCE_ID,
    });
    expect(JSON.stringify(call.principalSelector)).not.toContain(ACCOUNT_ID);
  });

  it("requires the credential header and never accepts it in the body", async () => {
    const dependency = dependencies();
    const missing = await handleRuntimeTokenRequest(
      new Request("https://edge.invalid/openclaw-runtime-token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(channelBody),
      }),
      dependency,
    );
    expect(missing.status).toBe(401);

    const inBody = await handleRuntimeTokenRequest(
      new Request("https://edge.invalid/openclaw-runtime-token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...channelBody, credential: "root-secret" }),
      }),
      dependency,
    );
    expect(inBody.status).toBe(401);
    expect(dependency.exchange).not.toHaveBeenCalled();
  });

  it("rejects a browser Origin on the exchange endpoint", async () => {
    const dependency = dependencies();
    const response = await handleRuntimeTokenRequest(
      tokenRequest(channelBody, { origin: "https://ptcrm.vercel.app" }),
      dependency,
    );

    expect(response.status).toBe(403);
    expect(dependency.exchange).not.toHaveBeenCalled();
  });

  it("maps a disabled, revoked, or stale credential to one opaque denial", async () => {
    const codes: number[] = [];
    const bodies: string[] = [];
    for (const message of [
      "credential exchange denied",
      "credential exchange denied",
      "credential exchange denied",
    ]) {
      const exchange = vi.fn(() => Promise.reject(new Error(message)));
      const response = await handleRuntimeTokenRequest(
        tokenRequest(channelBody),
        dependencies({ exchange }),
      );
      codes.push(response.status);
      bodies.push((await response.json()).error.code);
    }

    expect(new Set(codes)).toEqual(new Set([403]));
    expect(new Set(bodies).size).toBe(1);
  });

  it("never echoes the credential into the response or the log", async () => {
    const logger = { error: vi.fn() };
    const exchange = vi.fn(() =>
      Promise.reject(new Error("credential openclaw-runtime-root-credential-value-01 rejected"))
    );
    const response = await handleRuntimeTokenRequest(
      tokenRequest(channelBody),
      dependencies({ exchange, logger }),
    );
    const raw = await response.text();
    const logged = JSON.stringify(logger.error.mock.calls);

    expect(raw).not.toContain("openclaw-runtime-root-credential-value-01");
    expect(logged).not.toContain("openclaw-runtime-root-credential-value-01");
  });

  it("rejects a runtime path outside the allowlisted shape", async () => {
    const dependency = dependencies();
    for (const runtimePath of ["/admin", "/v1/outbox/claim?x=1", "v1/outbox/claim"]) {
      const response = await handleRuntimeTokenRequest(
        tokenRequest({ ...channelBody, runtimePath }),
        dependency,
      );
      expect(response.status, runtimePath).toBe(400);
    }
    expect(dependency.exchange).not.toHaveBeenCalled();
  });

  it("answers with no-store headers", async () => {
    const response = await handleRuntimeTokenRequest(tokenRequest(channelBody), dependencies());

    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });
});
