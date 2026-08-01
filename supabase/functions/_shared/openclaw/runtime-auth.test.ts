import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { requireBrowserUser } from "./browser-auth";
import { buildCorsHeaders, requireNoBrowserOrigin } from "./cors";
import { parseOpenClawEnvironment } from "./env";
import { OpenClawHttpError } from "./errors";
import { errorResponse, readStrictJson } from "./http";
import {
  deriveRuntimeRequirement,
  deriveCredentialProofSha256,
  deriveCredentialExchangeRequestHash,
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
const CHANNEL_CREDENTIAL = "root-owned-cell-credential-value";
const MAINTENANCE_CREDENTIAL = "root-owned-maintenance-credential-value";
const EXCHANGE_NONCE = "00000000-0000-4000-8000-000000000099";

interface TestCredentialExchangeRpcInput {
  principal: Record<string, unknown>;
  envelope: {
    version: 1;
    operation: string;
    nonce: string;
    iat: string;
    exp: string;
    requestHash: string;
  };
  request: {
    version: 1;
    credentialProofSha256: string;
    requestedOperation: string;
    runtimeMethod: string;
    runtimePath: string;
    runtimeTimestamp: number;
    runtimeNonce: string;
    runtimeBodySha256: string;
    localSessionGeneration?: number;
  };
}

function independentCredentialProof(
  domain: string,
  credential: string,
): string {
  return createHash("sha256")
    .update(domain, "utf8")
    .update(Buffer.from([0]))
    .update(credential, "utf8")
    .digest("hex");
}

function independentCredentialExchangeRequestHash(
  operation: string,
  request: TestCredentialExchangeRpcInput["request"],
): string {
  const canonicalRequest = JSON.stringify(Object.fromEntries(
    Object.entries(request).sort(([left], [right]) => left.localeCompare(right)),
  ));
  return createHash("sha256")
    .update("ihome-openclaw-service-request-v1", "utf8")
    .update(Buffer.from([0]))
    .update(operation, "utf8")
    .update(Buffer.from([0]))
    .update(canonicalRequest, "utf8")
    .digest("hex");
}

function channelExchangeReceipt(
  input: TestCredentialExchangeRpcInput,
  overrides: Record<string, unknown> = {},
) {
  return {
    version: 1,
    principalKind: "CHANNEL",
    organizationId: ORGANIZATION_ID,
    accountId: ACCOUNT_ID,
    cellId: CELL_ID,
    credentialGeneration: "1",
    leaseGeneration: "2",
    fencingToken: "3",
    sessionGeneration: "4",
    localSessionGeneration: "4",
    authMode: "NORMAL",
    requestedOperation: input.request.requestedOperation,
    runtimeMethod: input.request.runtimeMethod,
    runtimePath: input.request.runtimePath,
    runtimeTimestamp: input.request.runtimeTimestamp,
    runtimeNonce: input.request.runtimeNonce,
    runtimeBodySha256: input.request.runtimeBodySha256,
    exchangeNonce: input.envelope.nonce,
    exchangeRequestHash: input.envelope.requestHash,
    authenticatedAt: new Date(1_785_062_400_000).toISOString(),
    leaseExpiresAt: new Date(1_785_063_000_000).toISOString(),
    ...overrides,
  };
}

function maintenanceExchangeReceipt(
  input: TestCredentialExchangeRpcInput,
  overrides: Record<string, unknown> = {},
) {
  return {
    version: 1,
    principalKind: "MAINTENANCE",
    organizationId: ORGANIZATION_ID,
    maintenancePrincipalId: MAINTENANCE_ID,
    credentialGeneration: "5",
    leaseGeneration: "6",
    fencingToken: "7",
    requestedOperation: input.request.requestedOperation,
    runtimeMethod: input.request.runtimeMethod,
    runtimePath: input.request.runtimePath,
    runtimeTimestamp: input.request.runtimeTimestamp,
    runtimeNonce: input.request.runtimeNonce,
    runtimeBodySha256: input.request.runtimeBodySha256,
    exchangeNonce: input.envelope.nonce,
    exchangeRequestHash: input.envelope.requestHash,
    authenticatedAt: new Date(1_785_062_400_000).toISOString(),
    leaseExpiresAt: new Date(1_785_063_000_000).toISOString(),
    ...overrides,
  };
}

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
  localSessionGeneration: 4,
  authMode: "NORMAL" as const,
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
  it("derives domain-separated channel and maintenance credential proofs", async () => {
    const channelProof = await deriveCredentialProofSha256(
      "CHANNEL",
      CHANNEL_CREDENTIAL,
    );
    const maintenanceProof = await deriveCredentialProofSha256(
      "MAINTENANCE",
      MAINTENANCE_CREDENTIAL,
    );

    expect(channelProof).toBe(independentCredentialProof(
      "ihome-openclaw-channel-credential-v1",
      CHANNEL_CREDENTIAL,
    ));
    expect(maintenanceProof).toBe(independentCredentialProof(
      "ihome-openclaw-maintenance-credential-v1",
      MAINTENANCE_CREDENTIAL,
    ));
    expect(await deriveCredentialProofSha256("CHANNEL", MAINTENANCE_CREDENTIAL))
      .not.toBe(maintenanceProof);
  });

  it("derives the SQL credential exchange request hash over the full runtime binding", async () => {
    const request: TestCredentialExchangeRpcInput["request"] = {
      version: 1,
      credentialProofSha256: independentCredentialProof(
        "ihome-openclaw-channel-credential-v1",
        CHANNEL_CREDENTIAL,
      ),
      requestedOperation: "outbox.claim",
      runtimeMethod: "POST",
      runtimePath: "/v1/outbox/claim",
      runtimeTimestamp: 1_785_062_400,
      runtimeNonce: "00000000-0000-4000-8000-000000000001",
      runtimeBodySha256: createHash("sha256").update('{"limit":10}').digest("hex"),
    };
    const operation = "openclaw_exchange_runtime_credential_v1";
    expect(await deriveCredentialExchangeRequestHash(operation, request)).toBe(
      independentCredentialExchangeRequestHash(operation, request),
    );
  });

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

  it("authorizes the declared work-context and media-upload-complete routes", () => {
    expect(deriveRuntimeRequirement({
      method: "POST",
      path: "/v1/work/context",
      body: {},
    })).toEqual({ operation: "work.context", principalKind: "CHANNEL" });
    expect(deriveRuntimeRequirement({
      method: "POST",
      path: "/v1/media/upload-complete",
      body: {},
    })).toEqual({ operation: "media.issue", principalKind: "CHANNEL" });
  });

  it("exchanges a credential for a single request-bound five-minute token", async () => {
    const body = new TextEncoder().encode('{"limit":10}');
    const authenticateCredential = vi.fn((input: TestCredentialExchangeRpcInput) =>
      Promise.resolve(channelExchangeReceipt(input)));
    const token = await exchangeRuntimeCredential({
      credential: CHANNEL_CREDENTIAL,
      method: "POST",
      path: "/v1/outbox/claim",
      body,
      timestamp: 1_785_062_400,
      nonce: "00000000-0000-4000-8000-000000000001",
      exchangeNonce: EXCHANGE_NONCE,
      localSessionGeneration: 4,
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
    const credentialProofSha256 = independentCredentialProof(
      "ihome-openclaw-channel-credential-v1",
      CHANNEL_CREDENTIAL,
    );
    const runtimeBodySha256 = createHash("sha256").update(body).digest("hex");
    const exchangeRequest = {
      version: 1 as const,
      credentialProofSha256,
      requestedOperation: "outbox.claim",
      runtimeMethod: "POST",
      runtimePath: "/v1/outbox/claim",
      runtimeTimestamp: 1_785_062_400,
      runtimeNonce: "00000000-0000-4000-8000-000000000001",
      runtimeBodySha256,
      localSessionGeneration: 4,
    };
    const exchangeOperation = "openclaw_exchange_runtime_credential_v1";
    const exchangeRequestHash = independentCredentialExchangeRequestHash(
      exchangeOperation,
      exchangeRequest,
    );
    expect(authenticateCredential).toHaveBeenCalledWith({
      principal: {
        version: 1,
        principalKind: "CHANNEL",
        organizationId: ORGANIZATION_ID,
        accountId: ACCOUNT_ID,
        cellId: CELL_ID,
      },
      envelope: {
        version: 1,
        operation: exchangeOperation,
        nonce: EXCHANGE_NONCE,
        iat: new Date(1_785_062_400_000).toISOString(),
        exp: new Date(1_785_062_700_000).toISOString(),
        requestHash: exchangeRequestHash,
      },
      request: exchangeRequest,
    });
    expect(order).toEqual(["revalidate", "consume"]);
  });

  it("exchanges an independent maintenance credential and receipt", async () => {
    const body = new TextEncoder().encode('{"requestedKinds":["RETENTION_DELETE"]}');
    const routeBody = { requestedKinds: ["RETENTION_DELETE"] };
    const authenticateCredential = vi.fn((input: TestCredentialExchangeRpcInput) =>
      Promise.resolve(maintenanceExchangeReceipt(input)));
    const token = await exchangeRuntimeCredential({
      credential: MAINTENANCE_CREDENTIAL,
      method: "POST",
      path: "/v1/maintenance/work/claim",
      body,
      routeBody,
      timestamp: 1_785_062_400,
      nonce: "00000000-0000-4000-8000-000000000010",
      exchangeNonce: "00000000-0000-4000-8000-000000000011",
      principalSelector: {
        organizationId: ORGANIZATION_ID,
        maintenancePrincipalId: MAINTENANCE_ID,
      },
      signingKey: SIGNING_KEY,
      nowEpochSeconds: 1_785_062_400,
      authenticateCredential,
    });

    const verification = await verifyRuntimeRequest({
      token,
      method: "POST",
      path: "/v1/maintenance/work/claim",
      body,
      routeBody,
      timestamp: 1_785_062_400,
      nonce: "00000000-0000-4000-8000-000000000010",
      signingKey: SIGNING_KEY,
      nowEpochSeconds: 1_785_062_401,
      revalidatePrincipal: () => Promise.resolve(maintenancePrincipal),
      consumeNonce: () => Promise.resolve(),
    });

    expect(verification.principal).toEqual(maintenancePrincipal);
    const rpcInput = authenticateCredential.mock.calls[0][0];
    expect(rpcInput.request.credentialProofSha256).toBe(
      independentCredentialProof(
        "ihome-openclaw-maintenance-credential-v1",
        MAINTENANCE_CREDENTIAL,
      ),
    );
    expect(rpcInput.principal).toEqual({
      version: 1,
      principalKind: "MAINTENANCE",
      organizationId: ORGANIZATION_ID,
      maintenancePrincipalId: MAINTENANCE_ID,
    });
  });

  it("rejects any DB receipt provenance or safe-integer mismatch", async () => {
    const base = {
      credential: CHANNEL_CREDENTIAL,
      method: "POST",
      path: "/v1/outbox/claim",
      body: new TextEncoder().encode("{}"),
      timestamp: 1_785_062_400,
      nonce: "00000000-0000-4000-8000-000000000020",
      exchangeNonce: "00000000-0000-4000-8000-000000000021",
      localSessionGeneration: 4,
      principalSelector: {
        organizationId: ORGANIZATION_ID,
        accountId: ACCOUNT_ID,
        cellId: CELL_ID,
      },
      signingKey: SIGNING_KEY,
      nowEpochSeconds: 1_785_062_400,
    };
    const mutations: Record<string, unknown>[] = [
      { organizationId: "dddd0000-0000-4000-8000-000000000002" },
      { requestedOperation: "outbox.complete" },
      { runtimePath: "/v1/outbox/complete" },
      { runtimeNonce: "00000000-0000-4000-8000-000000000022" },
      { exchangeNonce: "00000000-0000-4000-8000-000000000023" },
      { exchangeRequestHash: "0".repeat(64) },
      { authenticatedAt: "2000-01-01T00:00:00.000Z" },
      { leaseExpiresAt: new Date(1_785_062_400_000).toISOString() },
      { credentialGeneration: "9007199254740992" },
      { localSessionGeneration: "5" },
      { authMode: "COMMAND_TRANSITION" },
      { extra: "forbidden" },
    ];

    for (const mutation of mutations) {
      const authenticateCredential = vi.fn((input: TestCredentialExchangeRpcInput) =>
        Promise.resolve(channelExchangeReceipt(input, mutation)));
      await expect(exchangeRuntimeCredential({ ...base, authenticateCredential }))
        .rejects.toBeInstanceOf(OpenClawHttpError);
      expect(authenticateCredential).toHaveBeenCalledOnce();
    }
  });

  it("accepts command-transition authority only for an exact heartbeat binding", async () => {
    const body = new TextEncoder().encode('{"version":1}');
    const authenticateCredential = vi.fn((input: TestCredentialExchangeRpcInput) =>
      Promise.resolve(channelExchangeReceipt(input, {
        sessionGeneration: "4",
        localSessionGeneration: "3",
        authMode: "COMMAND_TRANSITION",
      })));
    const token = await exchangeRuntimeCredential({
      credential: CHANNEL_CREDENTIAL,
      method: "POST",
      path: "/v1/heartbeat",
      body,
      timestamp: 1_785_062_400,
      nonce: "00000000-0000-4000-8000-000000000024",
      exchangeNonce: "00000000-0000-4000-8000-000000000025",
      localSessionGeneration: 3,
      principalSelector: {
        organizationId: ORGANIZATION_ID,
        accountId: ACCOUNT_ID,
        cellId: CELL_ID,
      },
      signingKey: SIGNING_KEY,
      nowEpochSeconds: 1_785_062_400,
      authenticateCredential,
    });

    const verified = await verifyRuntimeRequest({
      token,
      method: "POST",
      path: "/v1/heartbeat",
      body,
      timestamp: 1_785_062_400,
      nonce: "00000000-0000-4000-8000-000000000024",
      signingKey: SIGNING_KEY,
      nowEpochSeconds: 1_785_062_401,
      revalidatePrincipal: (principal) => Promise.resolve(principal),
      consumeNonce: () => Promise.resolve(),
    });

    expect(verified.principal).toMatchObject({
      sessionGeneration: 4,
      localSessionGeneration: 3,
      authMode: "COMMAND_TRANSITION",
    });
    expect(authenticateCredential.mock.calls[0][0].request.localSessionGeneration).toBe(3);
  });

  it("rejects invalid credential exchanges before credential lookup", async () => {
    const authenticateCredential = vi.fn((input: TestCredentialExchangeRpcInput) =>
      Promise.resolve(channelExchangeReceipt(input)));
    const base = {
      credential: CHANNEL_CREDENTIAL,
      method: "POST",
      path: "/v1/outbox/claim",
      body: new TextEncoder().encode("{}"),
      timestamp: 1_785_062_400,
      nonce: "00000000-0000-4000-8000-000000000001",
      exchangeNonce: EXCHANGE_NONCE,
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
      { timestamp: 1_785_062_461 },
      { nonce: "not-a-uuid" },
      { exchangeNonce: "not-a-uuid" },
      { exchangeNonce: base.nonce },
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
