import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { requireBrowserUser } from "./browser-auth";
import { buildCorsHeaders, requireNoBrowserOrigin } from "./cors";
import { parseOpenClawEnvironment } from "./env";
import { OpenClawHttpError } from "./errors";
import { errorResponse, readStrictJson } from "./http";
import {
  deriveRuntimeRequirement,
  exchangeRuntimeCredential,
  issueRuntimeToken,
  RuntimeClockDriftCircuit,
  verifyRuntimeRequest,
} from "./runtime-auth";

const ORGANIZATION_ID = "dddd0000-0000-4000-8000-000000000001";
const ACCOUNT_ID = "dddd1000-0000-4000-8000-000000000001";
const CELL_ID = "dddd2000-0000-4000-8000-000000000001";
const MAINTENANCE_ID = "dddd3000-0000-4000-8000-000000000001";
const SIGNING_KEY = new TextEncoder().encode(
  "task13-runtime-signing-key-32-bytes-minimum",
);

const channelPrincipal = {
  version: 1 as const,
  principalKind: "CHANNEL" as const,
  organizationId: ORGANIZATION_ID,
  accountId: ACCOUNT_ID,
  cellId: CELL_ID,
  credentialGeneration: 1,
  leaseGeneration: 2,
  fencingToken: 3,
  sessionGeneration: 4,
};

const maintenancePrincipal = {
  version: 1 as const,
  principalKind: "MAINTENANCE" as const,
  organizationId: ORGANIZATION_ID,
  maintenancePrincipalId: MAINTENANCE_ID,
  credentialGeneration: 5,
  leaseGeneration: 6,
  fencingToken: 7,
};

describe("OpenClaw shared runtime authentication", () => {
  it("derives channel and maintenance scope from exact routes", () => {
    expect(deriveRuntimeRequirement({
      method: "POST",
      path: "/v1/outbox/claim",
      body: {},
    })).toEqual({ operation: "outbox.claim", principalKind: "CHANNEL" });

    expect(deriveRuntimeRequirement({
      method: "POST",
      path: "/v1/maintenance/work/claim",
      body: { requestedKinds: ["RETENTION_DELETE", "AUDIT_ANCHOR"] },
    })).toEqual({
      operation: "maintenance.claim",
      principalKind: "MAINTENANCE",
    });

    expect(() => deriveRuntimeRequirement({
      method: "POST",
      path: "/v1/maintenance/work/claim",
      body: { requestedKinds: ["CRM_EVENT"] },
    })).toThrow(/maintenance work kind/i);
    expect(() => deriveRuntimeRequirement({
      method: "GET",
      path: "/v1/outbox/claim",
      body: {},
    })).toThrow(/route/i);
  });

  it("derives maintenance completion scope for every maintenance action route", () => {
    for (const path of [
      "/v1/maintenance/work/complete",
      "/v1/maintenance/media/upload-ticket",
      "/v1/maintenance/media/verify-ticket",
      "/v1/maintenance/retention/delete-ticket",
      "/v1/maintenance/retention/authorize-delete",
    ]) {
      expect(deriveRuntimeRequirement({ method: "POST", path, body: {} })).toEqual({
        operation: "maintenance.complete",
        principalKind: "MAINTENANCE",
      });
    }
  });

  it("exchanges a credential for a single request-bound five-minute token", async () => {
    const body = new TextEncoder().encode('{"limit":10}');
    const authenticateCredential = vi.fn(() => Promise.resolve(channelPrincipal));
    const token = await exchangeRuntimeCredential({
      credential: "root-owned-cell-credential-value",
      method: "POST",
      path: "/v1/outbox/claim",
      body,
      timestamp: 1_785_062_400,
      nonce: "00000000-0000-4000-8000-000000000001",
      principalSelector: {
        organizationId: ORGANIZATION_ID,
        accountId: ACCOUNT_ID,
        cellId: CELL_ID,
      },
      signingKey: SIGNING_KEY,
      nowEpochSeconds: 1_785_062_400,
      authenticateCredential,
    });
    const order: string[] = [];
    const revalidatePrincipal = vi.fn(() => {
      order.push("revalidate");
      return Promise.resolve(channelPrincipal);
    });
    const consumeNonce = vi.fn(() => {
      order.push("consume");
      return Promise.resolve();
    });

    const verified = await verifyRuntimeRequest({
      token,
      method: "POST",
      path: "/v1/outbox/claim",
      body,
      timestamp: 1_785_062_400,
      nonce: "00000000-0000-4000-8000-000000000001",
      signingKey: SIGNING_KEY,
      nowEpochSeconds: 1_785_062_401,
      revalidatePrincipal,
      consumeNonce,
    });

    expect(verified.operation).toBe("outbox.claim");
    expect(verified.principal).toEqual(channelPrincipal);
    expect(authenticateCredential).toHaveBeenCalledWith(
      "root-owned-cell-credential-value",
      {
        organizationId: ORGANIZATION_ID,
        accountId: ACCOUNT_ID,
        cellId: CELL_ID,
      },
      "outbox.claim",
    );
    expect(order).toEqual(["revalidate", "consume"]);
  });

  it("rejects invalid credential exchanges before credential lookup", async () => {
    const authenticateCredential = vi.fn(() => Promise.resolve(channelPrincipal));
    const base = {
      credential: "root-owned-cell-credential-value",
      method: "POST",
      path: "/v1/outbox/claim",
      body: new TextEncoder().encode("{}"),
      timestamp: 1_785_062_400,
      nonce: "00000000-0000-4000-8000-000000000001",
      principalSelector: {
        organizationId: ORGANIZATION_ID,
        accountId: ACCOUNT_ID,
        cellId: CELL_ID,
      },
      signingKey: SIGNING_KEY,
      nowEpochSeconds: 1_785_062_400,
      authenticateCredential,
    };

    for (const mutation of [
      { origin: "https://ptcrm.vercel.app" },
      { method: "GET" },
      { path: "/v1/not-allowed" },
      {
        path: "/v1/work/claim",
        routeBody: { requestedKinds: ["RETENTION_DELETE"] },
      },
      { timestamp: 1_785_062_461 },
      { nonce: "not-a-uuid" },
      { nowEpochSeconds: Number.NaN },
      { principalSelector: { ...base.principalSelector, extra: "forbidden" } },
    ]) {
      await expect(exchangeRuntimeCredential({ ...base, ...mutation }))
        .rejects.toBeInstanceOf(OpenClawHttpError);
    }
    expect(authenticateCredential).not.toHaveBeenCalled();
  });

  it("rejects binding, replay, and clock failures before authorization", async () => {
    const body = new TextEncoder().encode("{}");
    const token = await issueRuntimeToken({
      principal: channelPrincipal,
      method: "POST",
      path: "/v1/outbox/claim",
      body,
      timestamp: 1_785_062_400,
      nonce: "00000000-0000-4000-8000-000000000001",
      signingKey: SIGNING_KEY,
      nowEpochSeconds: 1_785_062_400,
      ttlSeconds: 300,
    });
    const revalidatePrincipal = vi.fn(() => Promise.resolve(channelPrincipal));
    const consumeNonce = vi.fn(async () => {});

    for (const mutation of [
      { path: "/v1/outbox/complete" },
      { body: new TextEncoder().encode('{"changed":true}') },
      { nonce: "00000000-0000-4000-8000-000000000002" },
      { timestamp: 1_785_062_461 },
    ]) {
      await expect(verifyRuntimeRequest({
        token,
        method: "POST",
        path: "/v1/outbox/claim",
        body,
        timestamp: 1_785_062_400,
        nonce: "00000000-0000-4000-8000-000000000001",
        signingKey: SIGNING_KEY,
        nowEpochSeconds: 1_785_062_400,
        revalidatePrincipal,
        consumeNonce,
        ...mutation,
      })).rejects.toThrow();
    }
    expect(revalidatePrincipal).not.toHaveBeenCalled();
    expect(consumeNonce).not.toHaveBeenCalled();

    const replay = vi.fn(() => Promise.reject(new Error("nonce replay")));
    await expect(verifyRuntimeRequest({
      token,
      method: "POST",
      path: "/v1/outbox/claim",
      body,
      timestamp: 1_785_062_400,
      nonce: "00000000-0000-4000-8000-000000000001",
      signingKey: SIGNING_KEY,
      nowEpochSeconds: 1_785_062_400,
      revalidatePrincipal,
      consumeNonce: replay,
    })).rejects.toThrow(/replay/i);
  });

  it("rejects malformed token encoding before principal or nonce access", async () => {
    const body = new TextEncoder().encode("{}");
    const token = await issueRuntimeToken({
      principal: channelPrincipal,
      method: "POST",
      path: "/v1/outbox/claim",
      body,
      timestamp: 1_785_062_400,
      nonce: "00000000-0000-4000-8000-000000000001",
      signingKey: SIGNING_KEY,
      nowEpochSeconds: 1_785_062_400,
    });
    const [header, payload] = token.split(".");
    const revalidatePrincipal = vi.fn(() => Promise.resolve(channelPrincipal));
    const consumeNonce = vi.fn(() => Promise.resolve());

    await expect(verifyRuntimeRequest({
      token: `${header}.${payload}.***`,
      method: "POST",
      path: "/v1/outbox/claim",
      body,
      timestamp: 1_785_062_400,
      nonce: "00000000-0000-4000-8000-000000000001",
      signingKey: SIGNING_KEY,
      nowEpochSeconds: 1_785_062_400,
      revalidatePrincipal,
      consumeNonce,
    })).rejects.toMatchObject({ code: "TOKEN_INVALID", status: 403 });
    expect(revalidatePrincipal).not.toHaveBeenCalled();
    expect(consumeNonce).not.toHaveBeenCalled();
  });

  it("rejects a non-finite verification clock before principal or nonce access", async () => {
    const body = new TextEncoder().encode("{}");
    const token = await issueRuntimeToken({
      principal: channelPrincipal,
      method: "POST",
      path: "/v1/outbox/claim",
      body,
      timestamp: 1_785_062_400,
      nonce: "00000000-0000-4000-8000-000000000001",
      signingKey: SIGNING_KEY,
      nowEpochSeconds: 1_785_062_400,
    });
    const revalidatePrincipal = vi.fn(() => Promise.resolve(channelPrincipal));
    const consumeNonce = vi.fn(() => Promise.resolve());

    await expect(verifyRuntimeRequest({
      token,
      method: "POST",
      path: "/v1/outbox/claim",
      body,
      timestamp: 1_785_062_400,
      nonce: "00000000-0000-4000-8000-000000000001",
      signingKey: SIGNING_KEY,
      nowEpochSeconds: Number.NaN,
      revalidatePrincipal,
      consumeNonce,
    })).rejects.toMatchObject({ code: "CLOCK_INVALID", status: 403 });
    expect(revalidatePrincipal).not.toHaveBeenCalled();
    expect(consumeNonce).not.toHaveBeenCalled();
  });

  it("never lets a channel token authorize maintenance work", async () => {
    const body = new TextEncoder().encode(
      '{"requestedKinds":["RETENTION_DELETE","AUDIT_ANCHOR"]}',
    );
    const maintenanceToken = await issueRuntimeToken({
      principal: maintenancePrincipal,
      method: "POST",
      path: "/v1/maintenance/work/claim",
      body,
      routeBody: { requestedKinds: ["RETENTION_DELETE", "AUDIT_ANCHOR"] },
      timestamp: 1_785_062_400,
      nonce: "00000000-0000-4000-8000-000000000010",
      signingKey: SIGNING_KEY,
      nowEpochSeconds: 1_785_062_400,
    });
    const channelToken = await issueRuntimeToken({
      principal: channelPrincipal,
      method: "POST",
      path: "/v1/outbox/claim",
      body: new TextEncoder().encode("{}"),
      timestamp: 1_785_062_400,
      nonce: "00000000-0000-4000-8000-000000000011",
      signingKey: SIGNING_KEY,
      nowEpochSeconds: 1_785_062_400,
    });

    await expect(verifyRuntimeRequest({
      token: channelToken,
      method: "POST",
      path: "/v1/maintenance/work/claim",
      body,
      routeBody: { requestedKinds: ["RETENTION_DELETE", "AUDIT_ANCHOR"] },
      timestamp: 1_785_062_400,
      nonce: "00000000-0000-4000-8000-000000000011",
      signingKey: SIGNING_KEY,
      nowEpochSeconds: 1_785_062_400,
      revalidatePrincipal: () => Promise.resolve(maintenancePrincipal),
      consumeNonce: async () => {},
    })).rejects.toThrow(/principal|route|binding/i);

    await expect(verifyRuntimeRequest({
      token: maintenanceToken,
      method: "POST",
      path: "/v1/maintenance/work/claim",
      body,
      routeBody: { requestedKinds: ["RETENTION_DELETE", "AUDIT_ANCHOR"] },
      timestamp: 1_785_062_400,
      nonce: "00000000-0000-4000-8000-000000000010",
      signingKey: SIGNING_KEY,
      nowEpochSeconds: 1_785_062_400,
      revalidatePrincipal: () => Promise.resolve(maintenancePrincipal),
      consumeNonce: async () => {},
    })).resolves.toMatchObject({ operation: "maintenance.claim" });
  });

  it("enforces strict JSON size, method, content type, and Zod objects", async () => {
    const schema = z.object({ operation: z.literal("PING") }).strict();
    await expect(readStrictJson(
      new Request("https://example.invalid", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": "20",
          "x-request-id": "00000000-0000-4000-8000-000000000099",
        },
        body: '{"operation":"PING"}',
      }),
      { method: "POST", maxBytes: 64, schema },
    )).resolves.toMatchObject({
      data: { operation: "PING" },
      requestId: "00000000-0000-4000-8000-000000000099",
    });

    for (const request of [
      new Request("https://example.invalid", { method: "GET" }),
      new Request("https://example.invalid", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "{}",
      }),
      new Request("https://example.invalid", {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": "65" },
        body: "{}",
      }),
      new Request("https://example.invalid", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operation: "PING", extra: "x".repeat(80) }),
      }),
      new Request("https://example.invalid", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"operation":"PING","extra":"x"}',
      }),
    ]) {
      await expect(readStrictJson(request, {
        method: "POST",
        maxBytes: 64,
        schema,
      })).rejects.toBeInstanceOf(OpenClawHttpError);
    }
  });

  it("uses exact CORS origins, Vary, request IDs, and redacted errors", async () => {
    expect(buildCorsHeaders(
      "https://ptcrm.vercel.app",
      ["https://ptcrm.vercel.app"],
    )).toMatchObject({
      "Access-Control-Allow-Origin": "https://ptcrm.vercel.app",
      Vary: "Origin",
    });
    expect(() => buildCorsHeaders(
      "https://evil.example",
      ["https://ptcrm.vercel.app"],
    )).toThrow(/origin/i);
    expect(() => requireNoBrowserOrigin("https://ptcrm.vercel.app"))
      .toThrow(/browser origin/i);

    const response = errorResponse(
      new OpenClawHttpError(
        400,
        "INVALID_REQUEST",
        "Authorization: Bearer secret-token claimToken=claim-secret",
      ),
      "00000000-0000-4000-8000-000000000099",
    );
    expect(response.headers.get("x-request-id")).toBe(
      "00000000-0000-4000-8000-000000000099",
    );
    const text = await response.text();
    expect(text).not.toContain("secret-token");
    expect(text).not.toContain("claim-secret");
  });

  it("verifies browser JWTs through auth.getUser and never trusts a body user", async () => {
    const getUser = vi.fn(() => Promise.resolve({
      data: { user: { id: "dddd9000-0000-4000-8000-000000000001" } },
      error: null,
    }));
    await expect(requireBrowserUser({ auth: { getUser } }))
      .resolves.toEqual({ id: "dddd9000-0000-4000-8000-000000000001" });
    expect(getUser).toHaveBeenCalledOnce();

    await expect(requireBrowserUser({
      auth: {
        getUser: () => Promise.resolve({
          data: { user: null },
          error: new Error("bad jwt"),
        }),
      },
    })).rejects.toThrow(/authentication/i);
  });

  it("loads exact origins and required secret names without wildcard fallback", () => {
    const parsed = parseOpenClawEnvironment({
      SUPABASE_URL: "https://tryymsxyyckgbrmmvozx.supabase.co",
      SUPABASE_ANON_KEY: "anon-key-value",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-value",
      OPENCLAW_RUNTIME_TOKEN_SIGNING_KEY: "runtime-key-value-at-least-32-bytes",
      OPENCLAW_BROWSER_ORIGINS: "https://ptcrm.vercel.app,https://crm.chillhome.io.vn",
    });
    expect(parsed.browserOrigins).toEqual([
      "https://ptcrm.vercel.app",
      "https://crm.chillhome.io.vn",
    ]);
    expect(() => parseOpenClawEnvironment({
      SUPABASE_URL: "https://tryymsxyyckgbrmmvozx.supabase.co",
      SUPABASE_ANON_KEY: "anon-key-value",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-value",
      OPENCLAW_RUNTIME_TOKEN_SIGNING_KEY: "runtime-key-value-at-least-32-bytes",
      OPENCLAW_BROWSER_ORIGINS: "*",
    })).toThrow(/origin/i);
  });

  it("opens the outbound circuit only after clock drift exceeds two seconds for two minutes", () => {
    const circuit = new RuntimeClockDriftCircuit();
    expect(circuit.observe({ localEpochSeconds: 100, databaseEpochSeconds: 103 }))
      .toEqual({ open: false, driftSeconds: 3 });
    expect(circuit.observe({ localEpochSeconds: 219, databaseEpochSeconds: 222 }))
      .toEqual({ open: false, driftSeconds: 3 });
    expect(circuit.observe({ localEpochSeconds: 220, databaseEpochSeconds: 223 }))
      .toEqual({ open: true, driftSeconds: 3 });
    expect(circuit.observe({ localEpochSeconds: 221, databaseEpochSeconds: 222 }))
      .toEqual({ open: false, driftSeconds: 1 });
  });

  it("uses the database clock to open the drift circuit when the local clock freezes", () => {
    const circuit = new RuntimeClockDriftCircuit();
    expect(circuit.observe({ localEpochSeconds: 100, databaseEpochSeconds: 103 }))
      .toEqual({ open: false, driftSeconds: 3 });
    expect(circuit.observe({ localEpochSeconds: 100, databaseEpochSeconds: 222 }))
      .toEqual({ open: false, driftSeconds: 122 });
    expect(circuit.observe({ localEpochSeconds: 100, databaseEpochSeconds: 223 }))
      .toEqual({ open: true, driftSeconds: 123 });
  });
});
