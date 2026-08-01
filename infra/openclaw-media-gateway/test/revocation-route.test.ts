import { describe, expect, it, vi } from "vitest";

import gateway from "../src/index";
import type { MediaGatewayEnv } from "../src/env";
import { raiseMinimumGeneration } from "../src/state-client";
import { TicketStateStore, type TicketStateStorage } from "../src/ticket-state";
import { verifyTicketRequest } from "../src/ticket-verifier";
import {
  ACCOUNT_ID,
  gatewayEnv,
  ORGANIZATION_ID,
  png,
  runtimeTicket,
  sha256Hex as sha256Bytes,
  signedTicketHeader,
  ticketKeys,
} from "./fixtures";

function base64(bytes: ArrayBuffer): string {
  return Buffer.from(bytes).toString("base64");
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Buffer.from(digest).toString("hex");
}

function createGenerationRevocationPropagator(input: {
  gatewayUrl: string;
  privateKeyPkcs8B64: string;
  keyGeneration: number;
  nowEpochSeconds: () => number;
  nonce: () => string;
  fetch: typeof fetch;
}) {
  return async (body: Record<string, unknown>) => {
    const { runtimeCommandId: _runtimeCommandId, ...wireBody } = body;
    const bodyText = canonical(wireBody);
    const envelope = {
      version: 1,
      audience: "openclaw-media-revocation",
      operation: "generation.revoke",
      timestamp: input.nowEpochSeconds(),
      nonce: input.nonce(),
      bodySha256: await sha256Hex(bodyText),
      keyGeneration: input.keyGeneration,
    };
    const privateKey = await crypto.subtle.importKey(
      "pkcs8",
      Buffer.from(input.privateKeyPkcs8B64, "base64"),
      { name: "Ed25519" },
      false,
      ["sign"],
    );
    const signature = new Uint8Array(await crypto.subtle.sign(
      "Ed25519",
      privateKey,
      new TextEncoder().encode(`ihome-openclaw-media-revocation-v1\0${canonical(envelope)}`),
    ));
    const response = await input.fetch(`${input.gatewayUrl}/v1/internal/revoke-generation`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-openclaw-revocation-envelope": base64Url(new TextEncoder().encode(canonical(envelope))),
        "x-openclaw-revocation-signature": base64Url(signature),
      },
      body: bodyText,
    });
    if (!response.ok) throw new Error("revocation propagation failed");
    const acknowledgement = await response.json<{ acknowledgementHash: string }>();
    return { acknowledgementHash: acknowledgement.acknowledgementHash };
  };
}

function fakeStateNamespace() {
  const maps = new Map<string, Map<string, unknown>>();
  const paths: string[] = [];
  return {
    idFromName: (name: string) => ({ name }),
    get: (id: { name: string }) => ({
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const map = maps.get(id.name) ?? new Map<string, unknown>();
        maps.set(id.name, map);
        const storage: TicketStateStorage = {
          get: async <T>(key: string) => map.get(key) as T | undefined,
          put: async <T>(key: string, value: T) => { map.set(key, value); },
          delete: async (key: string) => map.delete(key),
        };
        const store = new TicketStateStore(storage);
        const request = new Request(input, init);
        const path = new URL(request.url).pathname;
        paths.push(path);
        const body = await request.json() as Record<string, unknown>;
        if (path === "/apply-revocation") {
          return Response.json(await store.applyRevocation({
            organizationId: String(body.organizationId),
            principalKind: body.principalKind === "MAINTENANCE" ? "MAINTENANCE" : "CHANNEL",
            accountId: body.accountId === null ? null : String(body.accountId),
            cellId: body.cellId === null ? null : String(body.cellId),
            maintenancePrincipalId: body.maintenancePrincipalId === null
              ? null
              : String(body.maintenancePrincipalId),
            dimension: String(body.dimension) as "SESSION" | "CREDENTIAL" | "LEASE" | "CELL",
          }, String(body.nonce), Number(body.seenAtEpochSeconds),
          Number(body.minimumValidGeneration), String(body.revocationHash),
          body.acknowledgement as Record<string, unknown>));
        }
        if (path === "/consume-revocation-nonce") {
          return Response.json({ consumed: await store.consumeRevocationNonce(
            String(body.nonce), Number(body.seenAtEpochSeconds),
          ) });
        }
        if (path === "/raise-generation") {
          return Response.json({ generation: await store.raiseMinimumGeneration({
            organizationId: String(body.organizationId),
            principalKind: body.principalKind === "MAINTENANCE" ? "MAINTENANCE" : "CHANNEL",
            accountId: body.accountId === null ? null : String(body.accountId),
            cellId: body.cellId === null ? null : String(body.cellId),
            maintenancePrincipalId: body.maintenancePrincipalId === null
              ? null
              : String(body.maintenancePrincipalId),
            dimension: String(body.dimension) as "SESSION" | "CREDENTIAL" | "LEASE" | "CELL",
          }, Number(body.minimumValidGeneration)) });
        }
        if (path === "/minimum-generation") {
          return Response.json({ generation: await store.minimumGeneration({
            organizationId: String(body.organizationId),
            principalKind: body.principalKind === "MAINTENANCE" ? "MAINTENANCE" : "CHANNEL",
            accountId: body.accountId === null ? null : String(body.accountId),
            cellId: body.cellId === null ? null : String(body.cellId),
            maintenancePrincipalId: body.maintenancePrincipalId === null
              ? null
              : String(body.maintenancePrincipalId),
            dimension: String(body.dimension) as "SESSION" | "CREDENTIAL" | "LEASE" | "CELL",
          }) });
        }
        return new Response(null, { status: 404 });
      },
    }),
    maps,
    paths,
  };
}

describe("POST /v1/internal/revoke-generation", () => {
  it("composes the real Edge propagator with the Worker and durable generation floor", async () => {
    const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair;
    const state = fakeStateNamespace();
    const env = {
      TICKET_STATE: state,
      OPENCLAW_REVOCATION_PUBLIC_KEY_B64: base64(
        await crypto.subtle.exportKey("spki", keys.publicKey) as ArrayBuffer,
      ),
      OPENCLAW_REVOCATION_KEY_GENERATION: "3",
    } as unknown as MediaGatewayEnv;
    const privateKey = new Uint8Array(
      await crypto.subtle.exportKey("pkcs8", keys.privateKey) as ArrayBuffer,
    );
    const nowEpochSeconds = Math.floor(Date.now() / 1_000);
    const propagate = createGenerationRevocationPropagator({
      gatewayUrl: "https://openclaw-media.chillhome.io.vn",
      privateKeyPkcs8B64: Buffer.from(privateKey).toString("base64"),
      keyGeneration: 3,
      nowEpochSeconds: () => nowEpochSeconds,
      nonce: () => "dddd7000-0000-4000-8000-000000000010",
      fetch: (input, init) => gateway.fetch(new Request(input, init), env),
    });

    await expect(propagate({
      version: 1,
      organizationId: "dddd0000-0000-4000-8000-000000000001",
      principalKind: "CHANNEL",
      accountId: "dddd1000-0000-4000-8000-000000000001",
      cellId: "dddd2000-0000-4000-8000-000000000001",
      maintenancePrincipalId: null,
      runtimeCommandId: "dddd5000-0000-4000-8000-000000000010",
      revocationId: "dddd6000-0000-4000-8000-000000000010",
      revocationKind: "SESSION",
      revokedGeneration: 8,
      minimumValidGeneration: 9,
    })).resolves.toEqual({ acknowledgementHash: expect.stringMatching(/^[0-9a-f]{64}$/) });

    const tenantKey = "dddd0000-0000-4000-8000-000000000001:" +
      "dddd1000-0000-4000-8000-000000000001";
    expect(state.maps.get(tenantKey)?.get(
      "gen:SESSION:dddd0000-0000-4000-8000-000000000001:" +
        "dddd1000-0000-4000-8000-000000000001",
    )).toBe(9);
    expect(state.paths).toEqual(["/apply-revocation"]);
  });

  it("accepts a monotonic CELL generation gap and returns a stable replay acknowledgement", async () => {
    const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair;
    const state = fakeStateNamespace();
    const env = {
      TICKET_STATE: state,
      OPENCLAW_REVOCATION_PUBLIC_KEY_B64: base64(
        await crypto.subtle.exportKey("spki", keys.publicKey) as ArrayBuffer,
      ),
      OPENCLAW_REVOCATION_KEY_GENERATION: "3",
    } as unknown as MediaGatewayEnv;
    const nowEpochSeconds = Math.floor(Date.now() / 1_000);
    const propagate = createGenerationRevocationPropagator({
      gatewayUrl: "https://openclaw-media.chillhome.io.vn",
      privateKeyPkcs8B64: base64(
        await crypto.subtle.exportKey("pkcs8", keys.privateKey) as ArrayBuffer,
      ),
      keyGeneration: 3,
      nowEpochSeconds: () => nowEpochSeconds,
      nonce: () => "dddd7000-0000-4000-8000-000000000019",
      fetch: (input, init) => gateway.fetch(new Request(input, init), env),
    });
    const body = {
      version: 1,
      organizationId: ORGANIZATION_ID,
      principalKind: "CHANNEL",
      accountId: ACCOUNT_ID,
      cellId: "dddd2000-0000-4000-8000-000000000001",
      maintenancePrincipalId: null,
      revocationId: "dddd6000-0000-4000-8000-000000000019",
      revocationKind: "CELL",
      revokedGeneration: 4,
      minimumValidGeneration: 9,
    };

    const first = await propagate(body);
    await expect(propagate(body)).resolves.toEqual(first);
    const resigned = createGenerationRevocationPropagator({
      gatewayUrl: "https://openclaw-media.chillhome.io.vn",
      privateKeyPkcs8B64: base64(
        await crypto.subtle.exportKey("pkcs8", keys.privateKey) as ArrayBuffer,
      ),
      keyGeneration: 3,
      nowEpochSeconds: () => nowEpochSeconds + 1,
      nonce: () => "dddd7000-0000-4000-8000-000000000019",
      fetch: (input, init) => gateway.fetch(new Request(input, init), env),
    });
    await expect(resigned(body)).rejects.toThrow("revocation propagation failed");
    expect(state.maps.get(`${ORGANIZATION_ID}:${ACCOUNT_ID}`)?.get(
      `gen:CELL:${ORGANIZATION_ID}:${ACCOUNT_ID}:${body.cellId}`,
    )).toBe(9);
  });

  it.each([
    ["SESSION", "sessionGeneration"],
    ["CREDENTIAL", "credentialGeneration"],
    ["LEASE", "leaseGeneration"],
    ["CELL", "fencingToken"],
  ] as const)("immediately rejects an issued runtime ticket after %s is raised", async (
    dimension,
    claim,
  ) => {
    const keys = await ticketKeys();
    const fixture = await gatewayEnv(keys);
    const bytes = png();
    const ticket = await runtimeTicket(keys.privateKey, bytes, {
      sessionGeneration: 10,
      credentialGeneration: 10,
      leaseGeneration: 10,
      fencingToken: 10,
      [claim]: 5,
    });
    const request = () => new Request("https://openclaw-media.chillhome.io.vn/v1/object", {
      method: "PUT",
      headers: { "x-openclaw-media-ticket": ticket.header },
      body: bytes,
    });
    await expect(verifyTicketRequest(request(), fixture.env, "PUT", { consumeJti: false }))
      .resolves.toMatchObject({ jti: ticket.claims.jti });

    await raiseMinimumGeneration(fixture.env, {
      organizationId: ORGANIZATION_ID,
      principalKind: "CHANNEL",
      accountId: ACCOUNT_ID,
      cellId: ticket.claims.cellId ?? null,
      maintenancePrincipalId: null,
      dimension,
    }, 6);

    await expect(verifyTicketRequest(request(), fixture.env, "PUT", { consumeJti: false }))
      .rejects.toThrow("TICKET_GENERATION_REVOKED");
  });

  it.each([
    ["CREDENTIAL", "credentialGeneration"],
    ["LEASE", "leaseGeneration"],
    ["CELL", "fencingToken"],
  ] as const)("immediately rejects an issued maintenance ticket after %s is raised", async (
    dimension,
    claim,
  ) => {
    const keys = await ticketKeys();
    const fixture = await gatewayEnv(keys);
    const now = Math.floor(Date.now() / 1_000);
    const maintenancePrincipalId = "dddd2000-0000-4000-8000-000000000010";
    const auditRootId = "dddd4000-0000-4000-8000-000000000010";
    const bytes = new TextEncoder().encode("{}");
    const claims = {
      version: 1 as const,
      aud: "openclaw-media-gateway" as const,
      operation: "ANCHOR" as const,
      subject: "MAINTENANCE" as const,
      jti: crypto.randomUUID(),
      organizationId: ORGANIZATION_ID,
      accountId: null,
      objectKey: `v1/org/${ORGANIZATION_ID}/audit/2026-08-01/${auditRootId}.json`,
      sha256: await sha256Bytes(bytes),
      contentType: "application/json",
      contentLength: bytes.byteLength,
      sessionGeneration: 0,
      gatewayKeyGeneration: 1,
      receiptSigningKeyGeneration: 1,
      iat: now,
      exp: now + 60,
      maintenancePrincipalId,
      workItemId: "dddd3000-0000-4000-8000-000000000010",
      claimGeneration: 10,
      credentialGeneration: 10,
      leaseGeneration: 10,
      fencingToken: 10,
      auditRootId,
      rootHash: "a".repeat(64),
      signatureHash: "b".repeat(64),
      auditSigningKeyGeneration: 7,
      auditSigningPublicKeyHash: fixture.auditSigningPublicKeyHash,
      [claim]: 5,
    };
    const header = await signedTicketHeader(claims, keys.privateKey);
    const request = () => new Request("https://openclaw-media.chillhome.io.vn/v1/object", {
      method: "PUT",
      headers: { "x-openclaw-media-ticket": header },
      body: bytes,
    });
    await expect(verifyTicketRequest(request(), fixture.env, "ANCHOR", { consumeJti: false }))
      .resolves.toMatchObject({ jti: claims.jti });

    await raiseMinimumGeneration(fixture.env, {
      organizationId: ORGANIZATION_ID,
      principalKind: "MAINTENANCE",
      accountId: null,
      cellId: null,
      maintenancePrincipalId,
      dimension,
    }, 6);

    await expect(verifyTicketRequest(request(), fixture.env, "ANCHOR", { consumeJti: false }))
      .rejects.toThrow("TICKET_GENERATION_REVOKED");
  });

  it("keeps principal/dimension floors isolated while sharing channel SESSION across cells", async () => {
    const keys = await ticketKeys();
    const fixture = await gatewayEnv(keys);
    const bytes = png();
    const ticket = await runtimeTicket(keys.privateKey, bytes, {
      sessionGeneration: 5,
      credentialGeneration: 5,
      leaseGeneration: 5,
      fencingToken: 5,
    });
    const otherCellId = "dddd2000-0000-4000-8000-000000000099";
    const request = () => new Request("https://openclaw-media.chillhome.io.vn/v1/object", {
      method: "PUT",
      headers: { "x-openclaw-media-ticket": ticket.header },
      body: bytes,
    });
    const channelTarget = {
      organizationId: ORGANIZATION_ID,
      principalKind: "CHANNEL" as const,
      accountId: ACCOUNT_ID,
      cellId: otherCellId,
      maintenancePrincipalId: null,
    };
    await raiseMinimumGeneration(fixture.env, { ...channelTarget, dimension: "CREDENTIAL" }, 6);
    await expect(verifyTicketRequest(request(), fixture.env, "PUT", { consumeJti: false }))
      .resolves.toMatchObject({ jti: ticket.claims.jti });

    await raiseMinimumGeneration(fixture.env, {
      ...channelTarget,
      cellId: ticket.claims.cellId ?? null,
      dimension: "LEASE",
    }, 6);
    await expect(verifyTicketRequest(request(), fixture.env, "PUT", { consumeJti: false }))
      .rejects.toThrow("TICKET_GENERATION_REVOKED");

    const fresh = await runtimeTicket(keys.privateKey, bytes, {
      sessionGeneration: 5,
      credentialGeneration: 10,
      leaseGeneration: 10,
      fencingToken: 10,
    });
    const freshRequest = () => new Request("https://openclaw-media.chillhome.io.vn/v1/object", {
      method: "PUT",
      headers: { "x-openclaw-media-ticket": fresh.header },
      body: bytes,
    });
    await raiseMinimumGeneration(fixture.env, { ...channelTarget, dimension: "SESSION" }, 6);
    await expect(verifyTicketRequest(freshRequest(), fixture.env, "PUT", { consumeJti: false }))
      .rejects.toThrow("TICKET_GENERATION_REVOKED");
  });

  it("keeps maintenance floors isolated by principal and dimension", async () => {
    const keys = await ticketKeys();
    const fixture = await gatewayEnv(keys);
    const now = Math.floor(Date.now() / 1_000);
    const principalId = "dddd2000-0000-4000-8000-000000000040";
    const otherPrincipalId = "dddd2000-0000-4000-8000-000000000041";
    const auditRootId = "dddd4000-0000-4000-8000-000000000040";
    const bytes = new TextEncoder().encode("{}");
    const claims = {
      version: 1 as const,
      aud: "openclaw-media-gateway" as const,
      operation: "ANCHOR" as const,
      subject: "MAINTENANCE" as const,
      jti: crypto.randomUUID(),
      organizationId: ORGANIZATION_ID,
      accountId: null,
      objectKey: `v1/org/${ORGANIZATION_ID}/audit/2026-08-01/${auditRootId}.json`,
      sha256: await sha256Bytes(bytes),
      contentType: "application/json",
      contentLength: bytes.byteLength,
      sessionGeneration: 0,
      gatewayKeyGeneration: 1,
      receiptSigningKeyGeneration: 1,
      iat: now,
      exp: now + 60,
      maintenancePrincipalId: principalId,
      workItemId: "dddd3000-0000-4000-8000-000000000040",
      claimGeneration: 10,
      credentialGeneration: 5,
      leaseGeneration: 5,
      fencingToken: 5,
      auditRootId,
      rootHash: "a".repeat(64),
      signatureHash: "b".repeat(64),
      auditSigningKeyGeneration: 7,
      auditSigningPublicKeyHash: fixture.auditSigningPublicKeyHash,
    };
    const header = await signedTicketHeader(claims, keys.privateKey);
    const request = () => new Request("https://openclaw-media.chillhome.io.vn/v1/object", {
      method: "PUT",
      headers: { "x-openclaw-media-ticket": header },
      body: bytes,
    });
    const target = (maintenancePrincipalId: string) => ({
      organizationId: ORGANIZATION_ID,
      principalKind: "MAINTENANCE" as const,
      accountId: null,
      cellId: null,
      maintenancePrincipalId,
    });

    await raiseMinimumGeneration(fixture.env, {
      ...target(otherPrincipalId),
      dimension: "CREDENTIAL",
    }, 6);
    await raiseMinimumGeneration(fixture.env, {
      ...target(principalId),
      dimension: "LEASE",
    }, 5);
    await expect(verifyTicketRequest(request(), fixture.env, "ANCHOR", { consumeJti: false }))
      .resolves.toMatchObject({ jti: claims.jti });

    await raiseMinimumGeneration(fixture.env, {
      ...target(principalId),
      dimension: "CREDENTIAL",
    }, 6);
    await expect(verifyTicketRequest(request(), fixture.env, "ANCHOR", { consumeJti: false }))
      .rejects.toThrow("TICKET_GENERATION_REVOKED");
  });

  it("verifies Ed25519, consumes nonce, and raises the durable generation floor", async () => {
    const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair;
    const state = fakeStateNamespace();
    const env = {
      TICKET_STATE: state,
      OPENCLAW_REVOCATION_PUBLIC_KEY_B64: base64(
        await crypto.subtle.exportKey("spki", keys.publicKey) as ArrayBuffer,
      ),
      OPENCLAW_REVOCATION_KEY_GENERATION: "2",
    } as unknown as MediaGatewayEnv;
    const body = {
      version: 1,
      organizationId: "dddd0000-0000-4000-8000-000000000001",
      principalKind: "CHANNEL",
      accountId: "dddd1000-0000-4000-8000-000000000001",
      cellId: "dddd2000-0000-4000-8000-000000000001",
      maintenancePrincipalId: null,
      revocationId: "dddd6000-0000-4000-8000-000000000001",
      revocationKind: "SESSION",
      revokedGeneration: 4,
      minimumValidGeneration: 5,
    };
    const bodyText = canonical(body);
    const envelope = {
      version: 1,
      audience: "openclaw-media-revocation",
      operation: "generation.revoke",
      timestamp: Math.floor(Date.now() / 1_000),
      nonce: "dddd7000-0000-4000-8000-000000000001",
      bodySha256: await sha256Hex(bodyText),
      keyGeneration: 2,
    };
    const signature = new Uint8Array(await crypto.subtle.sign(
      "Ed25519",
      keys.privateKey,
      new TextEncoder().encode(`ihome-openclaw-media-revocation-v1\0${canonical(envelope)}`),
    ));
    const request = () => new Request(
      "https://openclaw-media.chillhome.io.vn/v1/internal/revoke-generation",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-openclaw-revocation-envelope": base64Url(new TextEncoder().encode(canonical(envelope))),
          "x-openclaw-revocation-signature": base64Url(signature),
        },
        body: bodyText,
      },
    );

    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const canonicalKey = env.OPENCLAW_REVOCATION_PUBLIC_KEY_B64;
    const lastDataIndex = canonicalKey.length - 2;
    const canonicalIndex = alphabet.indexOf(canonicalKey[lastDataIndex] ?? "");
    const nonCanonicalIndex = (canonicalIndex & ~3) | ((canonicalIndex + 1) & 3);
    env.OPENCLAW_REVOCATION_PUBLIC_KEY_B64 =
      `${canonicalKey.slice(0, lastDataIndex)}${alphabet[nonCanonicalIndex]}=`;
    expect((await gateway.fetch(request(), env)).status).toBe(500);
    env.OPENCLAW_REVOCATION_PUBLIC_KEY_B64 = canonicalKey;

    const first = await gateway.fetch(request(), env);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      version: 1,
      revocationId: body.revocationId,
      minimumValidGeneration: 5,
      acknowledgementHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    const key = `${body.organizationId}:${body.accountId}`;
    expect(state.maps.get(key)?.get(`gen:SESSION:${key}`)).toBe(5);

    const replay = await gateway.fetch(request(), env);
    expect(replay.status).toBe(200);
    expect(await replay.text()).toBe(JSON.stringify({
      version: 1,
      revocationId: body.revocationId,
      minimumValidGeneration: 5,
      acknowledgementHash: await sha256Hex(
        `ihome-openclaw-media-revocation-ack-v1\0${canonical({
          version: 1,
          revocationId: body.revocationId,
          minimumValidGeneration: 5,
        })}`,
      ),
    }));

    const nonCanonicalBody = {
      ...body,
      revocationId: "dddd6000-0000-4000-8000-000000000002",
      revokedGeneration: 5,
      minimumValidGeneration: 6,
    };
    const nonCanonicalBodyText = JSON.stringify(nonCanonicalBody, null, 2);
    const nonCanonicalEnvelope = {
      ...envelope,
      nonce: "dddd7000-0000-4000-8000-000000000002",
      bodySha256: await sha256Hex(nonCanonicalBodyText),
    };
    const nonCanonicalSignature = new Uint8Array(await crypto.subtle.sign(
      "Ed25519",
      keys.privateKey,
      new TextEncoder().encode(
        `ihome-openclaw-media-revocation-v1\0${canonical(nonCanonicalEnvelope)}`,
      ),
    ));
    const nonCanonical = await gateway.fetch(new Request(
      "https://openclaw-media.chillhome.io.vn/v1/internal/revoke-generation",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-openclaw-revocation-envelope": base64Url(
            new TextEncoder().encode(canonical(nonCanonicalEnvelope)),
          ),
          "x-openclaw-revocation-signature": base64Url(nonCanonicalSignature),
        },
        body: nonCanonicalBodyText,
      },
    ), env);
    expect(nonCanonical.status).toBe(403);
  });

  it("rejects browser origins and forged signatures without touching durable state", async () => {
    const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair;
    const state = fakeStateNamespace();
    const env = {
      TICKET_STATE: state,
      OPENCLAW_REVOCATION_PUBLIC_KEY_B64: base64(
        await crypto.subtle.exportKey("spki", keys.publicKey) as ArrayBuffer,
      ),
      OPENCLAW_REVOCATION_KEY_GENERATION: "1",
    } as unknown as MediaGatewayEnv;
    const response = await gateway.fetch(new Request(
      "https://openclaw-media.chillhome.io.vn/v1/internal/revoke-generation",
      { method: "POST", headers: { origin: "https://ptcrm.vercel.app" } },
    ), env);
    expect(response.status).toBe(403);
    expect(state.maps.size).toBe(0);
  });

  it("rejects unsupported MEDIA and maintenance SESSION revocations", async () => {
    const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair;
    const state = fakeStateNamespace();
    const env = {
      TICKET_STATE: state,
      OPENCLAW_REVOCATION_PUBLIC_KEY_B64: base64(
        await crypto.subtle.exportKey("spki", keys.publicKey) as ArrayBuffer,
      ),
      OPENCLAW_REVOCATION_KEY_GENERATION: "3",
    } as unknown as MediaGatewayEnv;
    const nowEpochSeconds = Math.floor(Date.now() / 1_000);
    let nonce = 20;
    const propagate = createGenerationRevocationPropagator({
      gatewayUrl: "https://openclaw-media.chillhome.io.vn",
      privateKeyPkcs8B64: base64(
        await crypto.subtle.exportKey("pkcs8", keys.privateKey) as ArrayBuffer,
      ),
      keyGeneration: 3,
      nowEpochSeconds: () => nowEpochSeconds,
      nonce: () => `dddd7000-0000-4000-8000-${String(nonce++).padStart(12, "0")}`,
      fetch: (input, init) => gateway.fetch(new Request(input, init), env),
    });
    const channel = {
      version: 1,
      organizationId: ORGANIZATION_ID,
      principalKind: "CHANNEL",
      accountId: ACCOUNT_ID,
      cellId: "dddd2000-0000-4000-8000-000000000001",
      maintenancePrincipalId: null,
      revocationId: "dddd6000-0000-4000-8000-000000000020",
      revocationKind: "MEDIA",
      revokedGeneration: 4,
      minimumValidGeneration: 5,
    };
    await expect(propagate(channel)).rejects.toThrow("revocation propagation failed");
    await expect(propagate({
      ...channel,
      principalKind: "MAINTENANCE",
      accountId: null,
      cellId: null,
      maintenancePrincipalId: "dddd2000-0000-4000-8000-000000000020",
      revocationId: "dddd6000-0000-4000-8000-000000000021",
      revocationKind: "SESSION",
    })).rejects.toThrow("revocation propagation failed");
    expect(state.maps.size).toBe(0);
  });

  it("cancels an oversized streamed body at 16 KiB", async () => {
    const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair;
    const state = fakeStateNamespace();
    const env = {
      TICKET_STATE: state,
      OPENCLAW_REVOCATION_PUBLIC_KEY_B64: base64(
        await crypto.subtle.exportKey("spki", keys.publicKey) as ArrayBuffer,
      ),
      OPENCLAW_REVOCATION_KEY_GENERATION: "1",
    } as unknown as MediaGatewayEnv;
    const bodyText = "a".repeat(20_000);
    const envelope = {
      version: 1,
      audience: "openclaw-media-revocation",
      operation: "generation.revoke",
      timestamp: Math.floor(Date.now() / 1_000),
      nonce: "dddd7000-0000-4000-8000-000000000030",
      bodySha256: await sha256Hex(bodyText),
      keyGeneration: 1,
    };
    const signature = new Uint8Array(await crypto.subtle.sign(
      "Ed25519",
      keys.privateKey,
      new TextEncoder().encode(`ihome-openclaw-media-revocation-v1\0${canonical(envelope)}`),
    ));
    const cancel = vi.fn();
    let offset = 0;
    const encoded = new TextEncoder().encode(bodyText);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= encoded.byteLength) return controller.close();
        const next = encoded.slice(offset, Math.min(offset + 4_096, encoded.byteLength));
        offset += next.byteLength;
        controller.enqueue(next);
      },
      cancel,
    }, { highWaterMark: 0 });
    const response = await gateway.fetch(new Request(
      "https://openclaw-media.chillhome.io.vn/v1/internal/revoke-generation",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-openclaw-revocation-envelope": base64Url(
            new TextEncoder().encode(canonical(envelope)),
          ),
          "x-openclaw-revocation-signature": base64Url(signature),
        },
        body,
        duplex: "half",
      } as RequestInit & { duplex: "half" },
    ), env);

    expect(response.status).toBe(403);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(state.maps.size).toBe(0);
  });

  it("fails closed on invalid revocation key material or generation", async () => {
    const request = () => new Request(
      "https://openclaw-media.chillhome.io.vn/v1/internal/revoke-generation",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-openclaw-revocation-envelope": base64Url(new TextEncoder().encode("{}")),
          "x-openclaw-revocation-signature": "a".repeat(86),
        },
        body: "{}",
      },
    );
    const baseEnv = {
      TICKET_STATE: fakeStateNamespace(),
      OPENCLAW_REVOCATION_PUBLIC_KEY_B64: "not-base64",
      OPENCLAW_REVOCATION_KEY_GENERATION: "1",
    } as unknown as MediaGatewayEnv;
    expect((await gateway.fetch(request(), baseEnv)).status).toBe(500);
    expect((await gateway.fetch(request(), {
      ...baseEnv,
      OPENCLAW_REVOCATION_KEY_GENERATION: "0",
    })).status).toBe(500);
  });
});
