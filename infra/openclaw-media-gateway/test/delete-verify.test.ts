import { afterEach, describe, expect, it, vi } from "vitest";

import type { MediaGatewayEnv } from "../src/env";
import gateway from "../src/index";
import { receiptClaimHash } from "../src/receipts";
import type { MediaTicketClaims } from "../src/ticket";
import {
  acquireObjectMutationOrWait,
  beginWorkflow,
  getWorkState,
  markWorkInProgress,
  raiseMinimumGeneration,
  releaseObjectMutation,
} from "../src/state-client";
import {
  base64,
  base64Url,
  canonical,
  gatewayEnv,
  OBJECT_KEY,
  ORGANIZATION_ID,
  png,
  receiptKeys,
  runtimeTicket,
  sha256Hex,
  signedTicketHeader,
  ticketKeys,
} from "./fixtures";

const MAINTENANCE_PRINCIPAL_ID = "dddd2000-0000-4000-8000-000000000010";
const WORK_ITEM_ID = "dddd3000-0000-4000-8000-000000000010";
const AUDIT_ROOT_ID = "dddd4000-0000-4000-8000-000000000010";
const DELETE_AUTHORIZATION_JTI = "dddd7000-0000-4000-8000-000000000010";

afterEach(() => vi.useRealTimers());

function decodeBase64Url(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64url"));
}

async function maintenanceTicket(
  privateKey: CryptoKey,
  bytes: Uint8Array,
  overrides: Record<string, unknown> = {},
): Promise<{ claims: MediaTicketClaims & Record<string, unknown>; header: string }> {
  const base = await runtimeTicket(privateKey, bytes, {
    subject: "MAINTENANCE",
    operation: "DELETE",
    accountId: null,
    sessionGeneration: 0,
    deletePhase: "FINAL_DELETE",
    quarantineVersion: 2,
    finalDeleteNotBefore: Math.floor(Date.now() / 1_000) - 1,
  });
  const claims = {
    ...base.claims,
    maintenancePrincipalId: MAINTENANCE_PRINCIPAL_ID,
    workItemId: WORK_ITEM_ID,
    claimGeneration: 3,
    credentialGeneration: 4,
    leaseGeneration: 5,
    fencingToken: 6,
    holdVersion: 0,
    ...overrides,
  } as MediaTicketClaims & Record<string, unknown>;
  if (claims.operation === "ANCHOR" || claims.operation === "ANCHOR_VERIFY") {
    delete claims.deletePhase;
    delete claims.quarantineVersion;
    delete claims.finalDeleteNotBefore;
    delete claims.holdVersion;
  }
  return { claims, header: await signedTicketHeader(claims, privateKey) };
}

async function deleteAuthorization(
  privateKey: CryptoKey,
  ticket: MediaTicketClaims & Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): Promise<{ claims: Record<string, unknown>; header: string }> {
  const now = new Date();
  const claims = {
    version: 1,
    authorizationKind: "RETENTION_FINAL_DELETE",
    organizationId: ticket.organizationId,
    maintenancePrincipalId: ticket.maintenancePrincipalId,
    workItemId: ticket.workItemId,
    claimGeneration: ticket.claimGeneration,
    credentialGeneration: ticket.credentialGeneration,
    leaseGeneration: ticket.leaseGeneration,
    fencingToken: ticket.fencingToken,
    objectKey: ticket.objectKey,
    deletePhase: "FINAL_DELETE",
    holdVersion: ticket.holdVersion,
    quarantineVersion: ticket.quarantineVersion,
    deleteTicketJti: ticket.jti,
    authorizationJti: DELETE_AUTHORIZATION_JTI,
    iat: now.toISOString(),
    exp: new Date(now.getTime() + 5_000).toISOString(),
    gatewaySigningKeyGeneration: ticket.gatewayKeyGeneration,
    ...overrides,
  };
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(
      `ihome-openclaw-retention-authorization-v1\0${canonical(claims)}`,
    ),
  );
  return {
    claims,
    header: base64Url(new TextEncoder().encode(canonical({
      ...claims,
      signature: base64Url(signature),
    }))),
  };
}

async function recoveryMaintenanceTicket(
  privateKey: CryptoKey,
  bytes: Uint8Array,
  original: MediaTicketClaims & Record<string, unknown>,
  overrides: Record<string, unknown>,
): Promise<{ claims: MediaTicketClaims & Record<string, unknown>; header: string }> {
  const fresh = await maintenanceTicket(privateKey, bytes, overrides);
  const claims = {
    ...fresh.claims,
    recoveryGeneration: 2,
    frozenClaim: {
      maintenancePrincipalId: original.maintenancePrincipalId,
      credentialGeneration: original.credentialGeneration,
      leaseGeneration: original.leaseGeneration,
      fencingToken: original.fencingToken,
      claimGeneration: original.claimGeneration,
    },
  } as MediaTicketClaims & Record<string, unknown>;
  delete claims.claimGeneration;
  return { claims, header: await signedTicketHeader(claims, privateKey) };
}

async function recoveryDeleteAuthorization(
  privateKey: CryptoKey,
  ticket: MediaTicketClaims & Record<string, unknown>,
): Promise<{ claims: Record<string, unknown>; header: string }> {
  const now = new Date();
  const claims = {
    version: 1,
    authorizationKind: "RETENTION_FINAL_DELETE",
    organizationId: ticket.organizationId,
    maintenancePrincipalId: ticket.maintenancePrincipalId,
    workItemId: ticket.workItemId,
    credentialGeneration: ticket.credentialGeneration,
    leaseGeneration: ticket.leaseGeneration,
    fencingToken: ticket.fencingToken,
    recoveryKind: ticket.recoveryKind,
    recoveryGeneration: ticket.recoveryGeneration,
    replacesTicketJti: ticket.replacesTicketJti,
    replacesDeleteAuthorizationJti: ticket.replacesDeleteAuthorizationJti,
    frozenClaim: ticket.frozenClaim,
    objectKey: ticket.objectKey,
    deletePhase: "FINAL_DELETE",
    holdVersion: ticket.holdVersion,
    quarantineVersion: ticket.quarantineVersion,
    deleteTicketJti: ticket.jti,
    authorizationJti: "dddd7000-0000-4000-8000-000000000013",
    iat: now.toISOString(),
    exp: new Date(now.getTime() + 5_000).toISOString(),
    gatewaySigningKeyGeneration: ticket.gatewayKeyGeneration,
  };
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(
      `ihome-openclaw-retention-authorization-v1\0${canonical(claims)}`,
    ),
  );
  return {
    claims,
    header: base64Url(new TextEncoder().encode(canonical({
      ...claims,
      signature: base64Url(signature),
    }))),
  };
}

function deleteRequest(ticket: string, authorization: string): Request {
  return new Request("https://openclaw-media.chillhome.io.vn/v1/object", {
    method: "DELETE",
    headers: {
      "x-openclaw-media-ticket": ticket,
      "x-openclaw-delete-authorization": authorization,
    },
  });
}

function hideNextWorkStateRead(env: MediaGatewayEnv): void {
  const original = env.TICKET_STATE;
  let hidden = false;
  env.TICKET_STATE = {
    idFromName: (name: string) => original.idFromName(name),
    get: (id: DurableObjectId) => {
      const stub = original.get(id);
      return {
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = new URL(input instanceof Request ? input.url : String(input));
          if (!hidden && url.pathname === "/work-state") {
            hidden = true;
            return Response.json({ work: null });
          }
          return await stub.fetch(input, init);
        },
      } as DurableObjectStub;
    },
  } as DurableObjectNamespace;
}

async function retireReceiptSigner(env: MediaGatewayEnv): Promise<void> {
  const rotated = await receiptKeys();
  const spki = new Uint8Array(
    await crypto.subtle.exportKey("spki", rotated.publicKey) as ArrayBuffer,
  );
  env.OPENCLAW_RECEIPT_PRIVATE_KEY_B64 = base64(
    await crypto.subtle.exportKey("pkcs8", rotated.privateKey) as ArrayBuffer,
  );
  env.OPENCLAW_RECEIPT_PUBLIC_KEY_SHA256 = await sha256Hex(spki);
  env.OPENCLAW_RECEIPT_KEY_GENERATION = "2";
  env.OPENCLAW_RECEIPT_RECOVERY_KEYRING_JSON = "[]";
}

async function rotateAuditVerifier(
  env: MediaGatewayEnv,
  emergencyRevoked = false,
): Promise<void> {
  const oldPublicKeyB64 = env.OPENCLAW_AUDIT_PUBLIC_KEY_B64;
  const oldPublicKeySha256 = env.OPENCLAW_AUDIT_PUBLIC_KEY_SHA256;
  const rotated = await receiptKeys();
  const rotatedSpki = new Uint8Array(
    await crypto.subtle.exportKey("spki", rotated.publicKey) as ArrayBuffer,
  );
  env.OPENCLAW_AUDIT_PUBLIC_KEY_B64 = base64(rotatedSpki);
  env.OPENCLAW_AUDIT_PUBLIC_KEY_SHA256 = await sha256Hex(rotatedSpki);
  env.OPENCLAW_AUDIT_KEY_GENERATION = "8";
  const configuration = env as unknown as Record<string, string>;
  configuration.OPENCLAW_AUDIT_KEY_NOT_BEFORE_EPOCH_SECONDS = "0";
  configuration.OPENCLAW_AUDIT_KEY_NOT_AFTER_EPOCH_SECONDS = "4102444800";
  configuration.OPENCLAW_AUDIT_KEY_EMERGENCY_REVOKED = "false";
  configuration.OPENCLAW_AUDIT_RECOVERY_KEYRING_JSON = JSON.stringify([{
    generation: 7,
    publicKeyB64: oldPublicKeyB64,
    publicKeySha256: oldPublicKeySha256,
    notBeforeEpochSeconds: 0,
    notAfterEpochSeconds: 4102444800,
    emergencyRevoked,
  }]);
}

async function deleteWorkflowHashes(
  ticket: MediaTicketClaims & Record<string, unknown>,
  authorization: Record<string, unknown>,
): Promise<{ claimHash: string; replayHash: string }> {
  return {
    replayHash: await receiptClaimHash({
      kind: "RETENTION_FINAL_DELETE_REPLAY",
      organizationId: ticket.organizationId,
      maintenancePrincipalId: ticket.maintenancePrincipalId,
      workItemId: ticket.workItemId,
      objectKey: ticket.objectKey,
      sha256: ticket.sha256,
      contentType: ticket.contentType,
      contentLength: ticket.contentLength,
      deletePhase: ticket.deletePhase,
      quarantineVersion: authorization.quarantineVersion,
      holdVersion: authorization.holdVersion,
      finalDeleteNotBefore: ticket.finalDeleteNotBefore,
    }),
    claimHash: await receiptClaimHash({
      kind: "RETENTION_FINAL_DELETE",
      organizationId: ticket.organizationId,
      maintenancePrincipalId: ticket.maintenancePrincipalId,
      workItemId: ticket.workItemId,
      claimGeneration: ticket.claimGeneration,
      credentialGeneration: ticket.credentialGeneration,
      leaseGeneration: ticket.leaseGeneration,
      fencingToken: ticket.fencingToken,
      objectKey: ticket.objectKey,
      sha256: ticket.sha256,
      contentType: ticket.contentType,
      contentLength: ticket.contentLength,
      deletePhase: ticket.deletePhase,
      quarantineVersion: authorization.quarantineVersion,
      holdVersion: authorization.holdVersion,
      finalDeleteNotBefore: ticket.finalDeleteNotBefore,
      deleteTicketJti: ticket.jti,
      deleteAuthorizationJti: authorization.authorizationJti,
      receiptSigningKeyGeneration: ticket.receiptSigningKeyGeneration,
    }),
  };
}

async function verifyWorkflowHashes(
  ticket: MediaTicketClaims & Record<string, unknown>,
): Promise<{ claimHash: string; replayHash: string }> {
  return {
    replayHash: await receiptClaimHash({
      kind: "AUDIT_ANCHOR_VERIFY_REPLAY",
      organizationId: ticket.organizationId,
      maintenancePrincipalId: ticket.maintenancePrincipalId,
      workItemId: ticket.workItemId,
      objectKey: ticket.objectKey,
      sha256: ticket.sha256,
      contentType: ticket.contentType,
      contentLength: ticket.contentLength,
      auditRootId: ticket.auditRootId,
      rootHash: ticket.rootHash,
      signatureHash: ticket.signatureHash,
      auditSigningKeyGeneration: ticket.auditSigningKeyGeneration,
      auditSigningPublicKeyHash: ticket.auditSigningPublicKeyHash,
    }),
    claimHash: await receiptClaimHash({
      kind: "AUDIT_ANCHOR_VERIFY",
      organizationId: ticket.organizationId,
      maintenancePrincipalId: ticket.maintenancePrincipalId,
      workItemId: ticket.workItemId,
      claimGeneration: ticket.claimGeneration,
      credentialGeneration: ticket.credentialGeneration,
      leaseGeneration: ticket.leaseGeneration,
      fencingToken: ticket.fencingToken,
      objectKey: ticket.objectKey,
      sha256: ticket.sha256,
      contentType: ticket.contentType,
      contentLength: ticket.contentLength,
      auditRootId: ticket.auditRootId,
      rootHash: ticket.rootHash,
      signatureHash: ticket.signatureHash,
      auditSigningKeyGeneration: ticket.auditSigningKeyGeneration,
      auditSigningPublicKeyHash: ticket.auditSigningPublicKeyHash,
      verifyTicketJti: ticket.jti,
      receiptSigningKeyGeneration: ticket.receiptSigningKeyGeneration,
    }),
  };
}

async function expectReceiptSignature(
  receipt: Record<string, unknown>,
  publicKey: CryptoKey,
  domain: string,
): Promise<void> {
  const { signature, ...claims } = receipt;
  expect(typeof signature).toBe("string");
  await expect(crypto.subtle.verify(
    "Ed25519",
    publicKey,
    decodeBase64Url(String(signature)),
    new TextEncoder().encode(`${domain}\0${canonical(claims)}`),
  )).resolves.toBe(true);
}

async function signedAuditDocument(
  privateKey: CryptoKey,
  rootOverrides: Record<string, unknown> = {},
  documentOverrides: Record<string, unknown> = {},
): Promise<{ bytes: Uint8Array; signatureHash: string }> {
  const root = {
    version: 1,
    organizationId: ORGANIZATION_ID,
    rootDate: "2026-08-01",
    firstSequence: 10,
    lastSequence: 12,
    eventCount: 3,
    previousRootHash: "c".repeat(64),
    merkleRootHash: "d".repeat(64),
    rootHash: "a".repeat(64),
    auditSigningKeyGeneration: 7,
    ...rootOverrides,
  };
  const canonicalRootJson = canonical(root);
  const signatureBytes = new Uint8Array(await crypto.subtle.sign(
    "Ed25519",
    privateKey,
    new TextEncoder().encode(`ihome-openclaw-audit-root-v1\0${canonicalRootJson}`),
  ));
  const signatureHash = await sha256Hex(signatureBytes);
  const document = {
    version: 1,
    signingDomain: "ihome-openclaw-audit-root-v1\0",
    root,
    canonicalRootJson,
    signature: base64Url(signatureBytes),
    signatureHash,
    ...documentOverrides,
  };
  return { bytes: new TextEncoder().encode(canonical(document)), signatureHash };
}

describe("DELETE /v1/object", () => {
  it("returns an explicit 410 when an authenticated expired delete has no workflow", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T00:00:00.000Z"));
    const keys = await ticketKeys();
    const fixture = await gatewayEnv(keys);
    const bytes = png();
    const ticket = await maintenanceTicket(keys.privateKey, bytes);
    const authorization = await deleteAuthorization(keys.privateKey, ticket.claims);
    vi.setSystemTime(new Date("2026-08-01T00:02:00.000Z"));

    const response = await gateway.fetch(
      deleteRequest(ticket.header, authorization.header),
      fixture.env,
    );

    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({ error: { code: "TICKET_EXPIRED_NO_WORK" } });
    expect(fixture.r2.deletes).toEqual([]);
  });

  it("admits a SQL-shaped delete recovery with current floors and signs frozen lineage", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T00:00:00.000Z"));
    const keys = await ticketKeys();
    const fixture = await gatewayEnv(keys);
    const bytes = png();
    const original = await maintenanceTicket(keys.privateKey, bytes);
    const originalAuthorization = await deleteAuthorization(keys.privateKey, original.claims);
    vi.setSystemTime(new Date("2026-08-01T00:02:00.000Z"));
    expect((await gateway.fetch(
      deleteRequest(original.header, originalAuthorization.header),
      fixture.env,
    )).status).toBe(410);
    const current = {
      maintenancePrincipalId: "dddd2000-0000-4000-8000-000000000011",
      credentialGeneration: 13,
      leaseGeneration: 14,
      fencingToken: 15,
    };
    for (const [dimension, generation] of [
      ["CREDENTIAL", current.credentialGeneration],
      ["LEASE", current.leaseGeneration],
      ["CELL", current.fencingToken],
    ] as const) {
      await raiseMinimumGeneration(fixture.env, {
        organizationId: ORGANIZATION_ID,
        principalKind: "MAINTENANCE",
        accountId: null,
        cellId: null,
        maintenancePrincipalId: current.maintenancePrincipalId,
        dimension,
      }, generation);
    }
    const recovery = await recoveryMaintenanceTicket(keys.privateKey, bytes, original.claims, {
      ...current,
      operation: "DELETE",
      jti: "dddd7000-0000-4000-8000-000000000011",
      recoveryKind: "RETENTION_DELETE_AUTHORIZED",
      replacesTicketJti: original.claims.jti,
      replacesDeleteAuthorizationJti: originalAuthorization.claims.authorizationJti,
    });
    const authorization = await recoveryDeleteAuthorization(keys.privateKey, recovery.claims);

    const response = await gateway.fetch(
      deleteRequest(recovery.header, authorization.header),
      fixture.env,
    );
    const receipt = await response.json<Record<string, unknown>>();

    expect(response.status).toBe(200);
    expect(receipt).toMatchObject({
      maintenancePrincipalId: original.claims.maintenancePrincipalId,
      claimGeneration: original.claims.claimGeneration,
      credentialGeneration: original.claims.credentialGeneration,
      leaseGeneration: original.claims.leaseGeneration,
      fencingToken: original.claims.fencingToken,
      deleteTicketJti: recovery.claims.jti,
      deleteAuthorizationJti: authorization.claims.authorizationJti,
    });
  });

  it("maps an atomic maintenance generation rejection to 403 before delete", async () => {
    const keys = await ticketKeys();
    const fixture = await gatewayEnv(keys);
    const bytes = png();
    await fixture.r2.bucket.put(OBJECT_KEY, bytes);
    const ticket = await maintenanceTicket(keys.privateKey, bytes);
    const authorization = await deleteAuthorization(keys.privateKey, ticket.claims);
    await raiseMinimumGeneration(fixture.env, {
      organizationId: ORGANIZATION_ID,
      principalKind: "MAINTENANCE",
      accountId: null,
      cellId: null,
      maintenancePrincipalId: MAINTENANCE_PRINCIPAL_ID,
      dimension: "CREDENTIAL",
    }, 5);

    const response = await gateway.fetch(
      deleteRequest(ticket.header, authorization.header),
      fixture.env,
    );

    expect(response.status).toBe(403);
    expect(fixture.r2.objects.has(OBJECT_KEY)).toBe(true);
  });

  it("deletes an exact immutable object and returns a full signed retention receipt", async () => {
    const keys = await ticketKeys();
    const fixture = await gatewayEnv(keys);
    const bytes = png();
    await fixture.r2.bucket.put(OBJECT_KEY, bytes);
    const ticket = await maintenanceTicket(keys.privateKey, bytes);
    const authorization = await deleteAuthorization(keys.privateKey, ticket.claims);

    const response = await gateway.fetch(
      deleteRequest(ticket.header, authorization.header),
      fixture.env,
    );
    const receipt = await response.json<Record<string, unknown>>();

    expect(response.status).toBe(200);
    expect(receipt).toMatchObject({
      version: 1,
      receiptKind: "RETENTION_FINAL_DELETE",
      organizationId: ORGANIZATION_ID,
      maintenancePrincipalId: MAINTENANCE_PRINCIPAL_ID,
      workItemId: WORK_ITEM_ID,
      claimGeneration: 3,
      objectKey: OBJECT_KEY,
      deletePhase: "FINAL_DELETE",
      deleteTicketJti: ticket.claims.jti,
      deleteAuthorizationJti: DELETE_AUTHORIZATION_JTI,
      proofJti: DELETE_AUTHORIZATION_JTI,
      objectStatus: "DELETED",
      r2VersionOrEtag: "version-1",
      gatewaySigningKeyGeneration: 1,
    });
    expect(fixture.r2.objects.has(OBJECT_KEY)).toBe(false);
    await expectReceiptSignature(
      receipt,
      fixture.signingKeys.publicKey,
      "ihome-openclaw-retention-receipt-v1",
    );
  });

  it("uses the receipt Ed25519 generation independently from the ticket ES256 generation", async () => {
    const keys = await ticketKeys();
    const fixture = await gatewayEnv(keys);
    fixture.env.OPENCLAW_RECEIPT_KEY_GENERATION = "9";
    const bytes = png();
    await fixture.r2.bucket.put(OBJECT_KEY, bytes);
    const ticket = await maintenanceTicket(keys.privateKey, bytes, {
      receiptSigningKeyGeneration: 9,
    });
    const authorization = await deleteAuthorization(keys.privateKey, ticket.claims);

    const response = await gateway.fetch(
      deleteRequest(ticket.header, authorization.header),
      fixture.env,
    );
    const receipt = await response.json<Record<string, unknown>>();

    expect(response.status).toBe(200);
    expect(ticket.claims.gatewayKeyGeneration).toBe(1);
    expect(ticket.claims.receiptSigningKeyGeneration).toBe(9);
    expect(authorization.claims.gatewaySigningKeyGeneration).toBe(1);
    expect(receipt.gatewaySigningKeyGeneration).toBe(9);
    await expectReceiptSignature(
      receipt,
      fixture.signingKeys.publicKey,
      "ihome-openclaw-retention-receipt-v1",
    );
  });

  it("rejects a delete before mutation when the frozen receipt key is unavailable", async () => {
    const keys = await ticketKeys();
    const fixture = await gatewayEnv(keys);
    fixture.env.OPENCLAW_RECEIPT_KEY_GENERATION = "9";
    const bytes = png();
    await fixture.r2.bucket.put(OBJECT_KEY, bytes);
    const ticket = await maintenanceTicket(keys.privateKey, bytes);
    const authorization = await deleteAuthorization(keys.privateKey, ticket.claims);

    const response = await gateway.fetch(
      deleteRequest(ticket.header, authorization.header),
      fixture.env,
    );

    expect(response.status).toBe(403);
    expect(fixture.r2.objects.has(OBJECT_KEY)).toBe(true);
    expect(fixture.r2.deletes).toEqual([]);
  });

  it("does not sign a delete receipt with an out-of-contract R2 version", async () => {
    const keys = await ticketKeys();
    const fixture = await gatewayEnv(keys);
    const bytes = png();
    await fixture.r2.bucket.put(OBJECT_KEY, bytes);
    const ticket = await maintenanceTicket(keys.privateKey, bytes);
    const authorization = await deleteAuthorization(keys.privateKey, ticket.claims);
    const originalHead = fixture.env.MEDIA.head.bind(fixture.env.MEDIA);
    fixture.env.MEDIA.head = async (key) => {
      const object = await originalHead(key);
      return object ? { ...object, version: "v".repeat(513) } as R2Object : null;
    };

    const response = await gateway.fetch(
      deleteRequest(ticket.header, authorization.header),
      fixture.env,
    );

    expect(response.status).toBe(500);
    expect(fixture.r2.objects.has(OBJECT_KEY)).toBe(true);
  });

  it("returns byte-identical stored evidence on retry without deleting twice", async () => {
    const keys = await ticketKeys();
    const fixture = await gatewayEnv(keys);
    const bytes = png();
    await fixture.r2.bucket.put(OBJECT_KEY, bytes);
    const ticket = await maintenanceTicket(keys.privateKey, bytes);
    const authorization = await deleteAuthorization(keys.privateKey, ticket.claims);
    const makeRequest = () => deleteRequest(ticket.header, authorization.header);

    const first = await gateway.fetch(makeRequest(), fixture.env);
    const firstBody = await first.text();
    const retry = await gateway.fetch(makeRequest(), fixture.env);
    const retryBody = await retry.text();

    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(retryBody).toBe(firstBody);
    expect(fixture.r2.deletes).toEqual([OBJECT_KEY]);
  });

  it("replays stored evidence after the ticket and authorization expire", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T00:00:00.000Z"));
    const keys = await ticketKeys();
    const fixture = await gatewayEnv(keys);
    const bytes = png();
    await fixture.r2.bucket.put(OBJECT_KEY, bytes);
    const ticket = await maintenanceTicket(keys.privateKey, bytes);
    const authorization = await deleteAuthorization(keys.privateKey, ticket.claims);
    const first = await gateway.fetch(
      deleteRequest(ticket.header, authorization.header),
      fixture.env,
    );
    const firstBody = await first.text();

    vi.setSystemTime(new Date("2026-08-01T00:02:00.000Z"));
    const replay = await gateway.fetch(
      deleteRequest(ticket.header, authorization.header),
      fixture.env,
    );

    expect(replay.status).toBe(200);
    expect(await replay.text()).toBe(firstBody);
    expect(fixture.r2.deletes).toEqual([OBJECT_KEY]);
  });

  it("replays a stored receipt before object locking or retired-signer preparation", async () => {
    const keys = await ticketKeys();
    const fixture = await gatewayEnv(keys);
    const bytes = png();
    await fixture.r2.bucket.put(OBJECT_KEY, bytes);
    const ticket = await maintenanceTicket(keys.privateKey, bytes);
    const authorization = await deleteAuthorization(keys.privateKey, ticket.claims);
    const makeRequest = () => deleteRequest(ticket.header, authorization.header);
    const first = await gateway.fetch(makeRequest(), fixture.env);
    const firstBody = await first.text();
    expect(first.status).toBe(200);

    await retireReceiptSigner(fixture.env);
    const blocker = "delete-replay-blocker";
    await acquireObjectMutationOrWait(fixture.env, OBJECT_KEY, "DELETE", blocker);
    try {
      const replay = await gateway.fetch(makeRequest(), fixture.env);
      expect(replay.status).toBe(200);
      expect(await replay.text()).toBe(firstBody);
    } finally {
      await releaseObjectMutation(fixture.env, OBJECT_KEY, blocker);
    }
  });

  it("replays DELETE receipt when the first state read races and the signer is revoked", async () => {
    const keys = await ticketKeys();
    const fixture = await gatewayEnv(keys);
    const bytes = png();
    await fixture.r2.bucket.put(OBJECT_KEY, bytes);
    const ticket = await maintenanceTicket(keys.privateKey, bytes);
    const authorization = await deleteAuthorization(keys.privateKey, ticket.claims);
    const makeRequest = () => deleteRequest(ticket.header, authorization.header);
    const first = await gateway.fetch(makeRequest(), fixture.env);
    const firstBody = await first.text();
    expect(first.status).toBe(200);
    hideNextWorkStateRead(fixture.env);
    fixture.env.OPENCLAW_RECEIPT_KEY_EMERGENCY_REVOKED = "true";

    const replay = await gateway.fetch(makeRequest(), fixture.env);

    expect(replay.status).toBe(200);
    expect(await replay.text()).toBe(firstBody);
  });

  it("rejects reuse of a consumed delete ticket jti by another work claim", async () => {
    const keys = await ticketKeys();
    const fixture = await gatewayEnv(keys);
    const bytes = png();
    await fixture.r2.bucket.put(OBJECT_KEY, bytes);
    const ticket = await maintenanceTicket(keys.privateKey, bytes);
    const authorization = await deleteAuthorization(keys.privateKey, ticket.claims);
    expect((await gateway.fetch(
      deleteRequest(ticket.header, authorization.header),
      fixture.env,
    )).status).toBe(200);

    const otherWork = await maintenanceTicket(keys.privateKey, bytes, {
      jti: ticket.claims.jti,
      workItemId: "dddd3000-0000-4000-8000-000000000011",
    });
    const otherAuthorization = await deleteAuthorization(keys.privateKey, otherWork.claims, {
      workItemId: otherWork.claims.workItemId,
      authorizationJti: "dddd7000-0000-4000-8000-000000000011",
    });
    const replay = await gateway.fetch(
      deleteRequest(otherWork.header, otherAuthorization.header),
      fixture.env,
    );

    expect(replay.status).toBe(409);
  });

  it("stores one byte-identical receipt for concurrent copies of the same ticket and proof", async () => {
    const keys = await ticketKeys();
    const fixture = await gatewayEnv(keys);
    const bytes = png();
    await fixture.r2.bucket.put(OBJECT_KEY, bytes);
    const ticket = await maintenanceTicket(keys.privateKey, bytes);
    const authorization = await deleteAuthorization(keys.privateKey, ticket.claims);
    const originalDelete = fixture.env.MEDIA.delete.bind(fixture.env.MEDIA);
    let deleteCallsEntered = 0;
    let releaseDeletes!: () => void;
    const bothDeletesEntered = new Promise<void>((resolve) => { releaseDeletes = resolve; });
    fixture.env.MEDIA.delete = async (key) => {
      deleteCallsEntered += 1;
      if (deleteCallsEntered === 2) releaseDeletes();
      await Promise.race([
        bothDeletesEntered,
        new Promise<void>((resolve) => setTimeout(resolve, 20)),
      ]);
      await originalDelete(key);
    };

    const responses = await Promise.all([
      gateway.fetch(deleteRequest(ticket.header, authorization.header), fixture.env),
      gateway.fetch(deleteRequest(ticket.header, authorization.header), fixture.env),
    ]);
    const bodies = await Promise.all(responses.map((response) => response.text()));

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(bodies[1]).toBe(bodies[0]);
    expect(fixture.r2.deletes).toEqual([OBJECT_KEY]);
  });

  it("recovers after R2 deleted the object but the mutation response was lost", async () => {
    const keys = await ticketKeys();
    const fixture = await gatewayEnv(keys);
    const bytes = png();
    await fixture.r2.bucket.put(OBJECT_KEY, bytes);
    const ticket = await maintenanceTicket(keys.privateKey, bytes);
    const authorization = await deleteAuthorization(keys.privateKey, ticket.claims);
    const originalDelete = fixture.env.MEDIA.delete.bind(fixture.env.MEDIA);
    let failAfterDelete = true;
    fixture.env.MEDIA.delete = async (key) => {
      await originalDelete(key);
      if (failAfterDelete) {
        failAfterDelete = false;
        throw new Error("simulated lost R2 acknowledgement");
      }
    };

    const failed = await gateway.fetch(
      deleteRequest(ticket.header, authorization.header),
      fixture.env,
    );
    expect(failed.status).toBe(500);
    expect(fixture.r2.objects.has(OBJECT_KEY)).toBe(false);

    const recovered = await gateway.fetch(
      deleteRequest(ticket.header, authorization.header),
      fixture.env,
    );
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({
      objectStatus: "DELETED",
      r2VersionOrEtag: "version-1",
    });
    expect(fixture.r2.deletes).toEqual([OBJECT_KEY]);
  });

  it("rejects cross-lineage NOT_FOUND receipt replay after a maintenance reclaim", async () => {
    const keys = await ticketKeys();
    const fixture = await gatewayEnv(keys);
    const bytes = png();
    const ticket = await maintenanceTicket(keys.privateKey, bytes);
    const authorization = await deleteAuthorization(keys.privateKey, ticket.claims);
    const missing = await gateway.fetch(
      deleteRequest(ticket.header, authorization.header),
      fixture.env,
    );
    const missingBody = await missing.text();
    expect(missing.status).toBe(200);
    expect(JSON.parse(missingBody)).toMatchObject({
      objectStatus: "NOT_FOUND",
      r2VersionOrEtag: null,
    });

    const reclaimed = await maintenanceTicket(keys.privateKey, bytes, { claimGeneration: 4 });
    const reclaimedAuthorization = await deleteAuthorization(keys.privateKey, reclaimed.claims, {
      claimGeneration: 4,
      authorizationJti: "dddd7000-0000-4000-8000-000000000011",
    });
    const replay = await gateway.fetch(
      deleteRequest(reclaimed.header, reclaimedAuthorization.header),
      fixture.env,
    );
    expect(replay.status).toBe(409);
    expect(await replay.json()).toEqual({ error: { code: "WORK_CLAIM_CONFLICT" } });
  });

  it("does not persist AUTHORIZED work before signer readiness or bypass a later floor rise", async () => {
    const keys = await ticketKeys();
    const fixture = await gatewayEnv(keys);
    const bytes = png();
    await fixture.r2.bucket.put(OBJECT_KEY, bytes);
    const ticket = await maintenanceTicket(keys.privateKey, bytes);
    const authorization = await deleteAuthorization(keys.privateKey, ticket.claims);
    fixture.env.OPENCLAW_RECEIPT_KEY_NOT_BEFORE_EPOCH_SECONDS = String(
      Math.floor(Date.now() / 1_000) + 60,
    );

    const parked = await gateway.fetch(
      deleteRequest(ticket.header, authorization.header),
      fixture.env,
    );
    expect(parked.status).toBe(403);
    expect(await parked.json()).toEqual({
      error: { code: "RECEIPT_SIGNING_KEY_UNAVAILABLE" },
    });
    expect(await getWorkState(
      fixture.env,
      ORGANIZATION_ID,
      null,
      `DELETE:${WORK_ITEM_ID}`,
    )).toBeNull();
    const uploadProbe = "signer-before-tombstone-probe";
    await expect(acquireObjectMutationOrWait(
      fixture.env,
      OBJECT_KEY,
      "UPLOAD",
      uploadProbe,
    )).resolves.toBeUndefined();
    await releaseObjectMutation(fixture.env, OBJECT_KEY, uploadProbe);

    fixture.env.OPENCLAW_RECEIPT_KEY_NOT_BEFORE_EPOCH_SECONDS = "0";
    await raiseMinimumGeneration(fixture.env, {
      organizationId: ORGANIZATION_ID,
      principalKind: "MAINTENANCE",
      accountId: null,
      cellId: null,
      maintenancePrincipalId: MAINTENANCE_PRINCIPAL_ID,
      dimension: "LEASE",
    }, 6);
    const continued = await gateway.fetch(
      deleteRequest(ticket.header, authorization.header),
      fixture.env,
    );
    expect(continued.status).toBe(403);
    expect(await continued.json()).toEqual({
      error: { code: "TICKET_GENERATION_REVOKED" },
    });
    expect(fixture.r2.objects.has(OBJECT_KEY)).toBe(true);
  });

  it("persists DELETE_IN_PROGRESS before HEAD so an exact retry survives a floor rise", async () => {
    const keys = await ticketKeys();
    const fixture = await gatewayEnv(keys);
    const bytes = png();
    await fixture.r2.bucket.put(OBJECT_KEY, bytes);
    const ticket = await maintenanceTicket(keys.privateKey, bytes);
    const authorization = await deleteAuthorization(keys.privateKey, ticket.claims);
    const originalHead = fixture.env.MEDIA.head.bind(fixture.env.MEDIA);
    let failFirstHead = true;
    fixture.env.MEDIA.head = async (key) => {
      if (failFirstHead) {
        failFirstHead = false;
        throw new Error("simulated first HEAD failure");
      }
      return await originalHead(key);
    };
    const failed = await gateway.fetch(
      deleteRequest(ticket.header, authorization.header),
      fixture.env,
    );
    expect(failed.status).toBe(500);
    expect(await getWorkState(
      fixture.env,
      ORGANIZATION_ID,
      null,
      `DELETE:${WORK_ITEM_ID}`,
    )).toMatchObject({ phase: "DELETE_IN_PROGRESS" });
    await raiseMinimumGeneration(fixture.env, {
      organizationId: ORGANIZATION_ID,
      principalKind: "MAINTENANCE",
      accountId: null,
      cellId: null,
      maintenancePrincipalId: MAINTENANCE_PRINCIPAL_ID,
      dimension: "LEASE",
    }, 6);

    const recovered = await gateway.fetch(
      deleteRequest(ticket.header, authorization.header),
      fixture.env,
    );

    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({ objectStatus: "DELETED" });
    expect(fixture.r2.deletes).toEqual([OBJECT_KEY]);
  });

  it("denies stale AUTHORIZED work and lets a current recovery claim take it over", async () => {
    const keys = await ticketKeys();
    const fixture = await gatewayEnv(keys);
    const bytes = png();
    await fixture.r2.bucket.put(OBJECT_KEY, bytes);
    const original = await maintenanceTicket(keys.privateKey, bytes);
    const originalAuthorization = await deleteAuthorization(keys.privateKey, original.claims);
    const hashes = await deleteWorkflowHashes(original.claims, originalAuthorization.claims);
    await beginWorkflow(
      fixture.env,
      ORGANIZATION_ID,
      null,
      `DELETE:${WORK_ITEM_ID}`,
      hashes.claimHash,
      "DELETE",
      [
        { jti: original.claims.jti, expiresAtEpochSeconds: original.claims.exp },
        {
          jti: String(originalAuthorization.claims.authorizationJti),
          expiresAtEpochSeconds: Math.floor(
            Date.parse(String(originalAuthorization.claims.exp)) / 1_000,
          ),
        },
      ],
      original.claims,
      false,
      hashes.replayHash,
    );
    await raiseMinimumGeneration(fixture.env, {
      organizationId: ORGANIZATION_ID,
      principalKind: "MAINTENANCE",
      accountId: null,
      cellId: null,
      maintenancePrincipalId: MAINTENANCE_PRINCIPAL_ID,
      dimension: "LEASE",
    }, 6);

    const stale = await gateway.fetch(
      deleteRequest(original.header, originalAuthorization.header),
      fixture.env,
    );
    expect(stale.status).toBe(403);
    expect(fixture.r2.objects.has(OBJECT_KEY)).toBe(true);

    const recovery = await recoveryMaintenanceTicket(keys.privateKey, bytes, original.claims, {
      leaseGeneration: 6,
      jti: "dddd7000-0000-4000-8000-000000000018",
      recoveryKind: "RETENTION_DELETE_AUTHORIZED",
      replacesTicketJti: original.claims.jti,
      replacesDeleteAuthorizationJti: originalAuthorization.claims.authorizationJti,
    });
    const recoveryAuthorization = await recoveryDeleteAuthorization(keys.privateKey, recovery.claims);
    const response = await gateway.fetch(
      deleteRequest(recovery.header, recoveryAuthorization.header),
      fixture.env,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      maintenancePrincipalId: original.claims.maintenancePrincipalId,
      claimGeneration: original.claims.claimGeneration,
      objectStatus: "DELETED",
    });
    expect(fixture.r2.deletes).toEqual([OBJECT_KEY]);
  });

  it("finishes exact DELETE_IN_PROGRESS evidence after its maintenance floor rises", async () => {
    const keys = await ticketKeys();
    const fixture = await gatewayEnv(keys);
    const bytes = png();
    await fixture.r2.bucket.put(OBJECT_KEY, bytes);
    const ticket = await maintenanceTicket(keys.privateKey, bytes);
    const authorization = await deleteAuthorization(keys.privateKey, ticket.claims);
    const hashes = await deleteWorkflowHashes(ticket.claims, authorization.claims);
    await beginWorkflow(
      fixture.env,
      ORGANIZATION_ID,
      null,
      `DELETE:${WORK_ITEM_ID}`,
      hashes.claimHash,
      "DELETE",
      [
        { jti: ticket.claims.jti, expiresAtEpochSeconds: ticket.claims.exp },
        {
          jti: String(authorization.claims.authorizationJti),
          expiresAtEpochSeconds: Math.floor(
            Date.parse(String(authorization.claims.exp)) / 1_000,
          ),
        },
      ],
      ticket.claims,
      false,
      hashes.replayHash,
    );
    await markWorkInProgress(
      fixture.env,
      ORGANIZATION_ID,
      null,
      `DELETE:${WORK_ITEM_ID}`,
      hashes.claimHash,
      { objectExisted: true, versionOrEtag: "version-1" },
    );
    await raiseMinimumGeneration(fixture.env, {
      organizationId: ORGANIZATION_ID,
      principalKind: "MAINTENANCE",
      accountId: null,
      cellId: null,
      maintenancePrincipalId: MAINTENANCE_PRINCIPAL_ID,
      dimension: "LEASE",
    }, 6);

    const response = await gateway.fetch(
      deleteRequest(ticket.header, authorization.header),
      fixture.env,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ objectStatus: "DELETED" });
    expect(fixture.r2.deletes).toEqual([OBJECT_KEY]);
  });

  it("does not DELETE after its expired object lease is taken over", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T00:00:00.000Z"));
    const keys = await ticketKeys();
    const fixture = await gatewayEnv(keys);
    const bytes = png();
    await fixture.r2.bucket.put(OBJECT_KEY, bytes);
    const ticket = await maintenanceTicket(keys.privateKey, bytes);
    const authorization = await deleteAuthorization(keys.privateKey, ticket.claims);
    const originalHead = fixture.env.MEDIA.head.bind(fixture.env.MEDIA);
    const blocker = "delete-lease-takeover";
    let headCalls = 0;
    fixture.env.MEDIA.head = async (key) => {
      headCalls += 1;
      if (headCalls === 2) {
        vi.setSystemTime(new Date(Date.now() + 120_001));
        await acquireObjectMutationOrWait(fixture.env, key, "DELETE", blocker);
      }
      return await originalHead(key);
    };

    try {
      const response = await gateway.fetch(
        deleteRequest(ticket.header, authorization.header),
        fixture.env,
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: { code: "WORK_IN_PROGRESS" } });
      expect(fixture.r2.objects.has(OBJECT_KEY)).toBe(true);
      expect(fixture.r2.deletes).toEqual([]);
    } finally {
      await releaseObjectMutation(fixture.env, OBJECT_KEY, blocker);
    }
  });

  it("rechecks receipt signer revocation immediately before R2 DELETE", async () => {
    const keys = await ticketKeys();
    const fixture = await gatewayEnv(keys);
    const bytes = png();
    await fixture.r2.bucket.put(OBJECT_KEY, bytes);
    const ticket = await maintenanceTicket(keys.privateKey, bytes);
    const authorization = await deleteAuthorization(keys.privateKey, ticket.claims);
    const originalHead = fixture.env.MEDIA.head.bind(fixture.env.MEDIA);
    fixture.env.MEDIA.head = async (key) => {
      fixture.env.OPENCLAW_RECEIPT_KEY_EMERGENCY_REVOKED = "true";
      return await originalHead(key);
    };

    const response = await gateway.fetch(
      deleteRequest(ticket.header, authorization.header),
      fixture.env,
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: { code: "RECEIPT_SIGNING_KEY_UNAVAILABLE" },
    });
    expect(fixture.r2.objects.has(OBJECT_KEY)).toBe(true);
    expect(fixture.r2.deletes).toEqual([]);
  });

  it("maps stored workflow retention expiry to the exact 410 response", async () => {
    vi.useFakeTimers();
    const startedAt = new Date("2026-08-01T00:00:00.000Z");
    vi.setSystemTime(startedAt);
    const keys = await ticketKeys();
    const fixture = await gatewayEnv(keys);
    const bytes = png();
    await fixture.r2.bucket.put(OBJECT_KEY, bytes);
    const ticket = await maintenanceTicket(keys.privateKey, bytes);
    const authorization = await deleteAuthorization(keys.privateKey, ticket.claims);
    const makeRequest = () => deleteRequest(ticket.header, authorization.header);
    expect((await gateway.fetch(makeRequest(), fixture.env)).status).toBe(200);

    vi.setSystemTime(new Date(startedAt.getTime() + (7 * 24 * 60 * 60 + 61) * 1_000));
    const expired = await gateway.fetch(makeRequest(), fixture.env);

    expect(expired.status).toBe(410);
    expect(await expired.json()).toEqual({ error: { code: "TICKET_EXPIRED_NO_WORK" } });
    expect(fixture.r2.deletes).toEqual([OBJECT_KEY]);
  });

  it("lets a current SQL-shaped recovery replace only an expired delete workflow", async () => {
    vi.useFakeTimers();
    const startedAt = new Date("2026-08-01T00:00:00.000Z");
    vi.setSystemTime(startedAt);
    const keys = await ticketKeys();
    const fixture = await gatewayEnv(keys);
    const bytes = png();
    await fixture.r2.bucket.put(OBJECT_KEY, bytes);
    const original = await maintenanceTicket(keys.privateKey, bytes);
    const originalAuthorization = await deleteAuthorization(keys.privateKey, original.claims);
    expect((await gateway.fetch(
      deleteRequest(original.header, originalAuthorization.header),
      fixture.env,
    )).status).toBe(200);

    vi.setSystemTime(new Date(startedAt.getTime() + (7 * 24 * 60 * 60 + 61) * 1_000));
    const expired = await gateway.fetch(
      deleteRequest(original.header, originalAuthorization.header),
      fixture.env,
    );
    expect(expired.status).toBe(410);
    expect(await expired.json()).toEqual({ error: { code: "TICKET_EXPIRED_NO_WORK" } });

    const recovery = await recoveryMaintenanceTicket(keys.privateKey, bytes, original.claims, {
      jti: "dddd7000-0000-4000-8000-000000000014",
      recoveryKind: "RETENTION_DELETE_AUTHORIZED",
      replacesTicketJti: original.claims.jti,
      replacesDeleteAuthorizationJti: originalAuthorization.claims.authorizationJti,
    });
    const recoveryAuthorization = await recoveryDeleteAuthorization(keys.privateKey, recovery.claims);
    const response = await gateway.fetch(
      deleteRequest(recovery.header, recoveryAuthorization.header),
      fixture.env,
    );
    const receipt = await response.json<Record<string, unknown>>();

    expect(response.status).toBe(200);
    expect(receipt).toMatchObject({
      maintenancePrincipalId: original.claims.maintenancePrincipalId,
      claimGeneration: original.claims.claimGeneration,
      deleteTicketJti: recovery.claims.jti,
      deleteAuthorizationJti: recoveryAuthorization.claims.authorizationJti,
      objectStatus: "NOT_FOUND",
    });
    expect(fixture.r2.deletes).toEqual([OBJECT_KEY]);
  });

  it("keeps a final-delete tombstone from allowing an admitted upload to recreate the key", async () => {
    const keys = await ticketKeys();
    const fixture = await gatewayEnv(keys);
    const bytes = png();
    const parkedUpload = await runtimeTicket(keys.privateKey, bytes);
    const ticket = await maintenanceTicket(keys.privateKey, bytes);
    const authorization = await deleteAuthorization(keys.privateKey, ticket.claims);

    const deleted = await gateway.fetch(
      deleteRequest(ticket.header, authorization.header),
      fixture.env,
    );
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toMatchObject({ objectStatus: "NOT_FOUND" });

    const recreated = await gateway.fetch(new Request(
      "https://openclaw-media.chillhome.io.vn/v1/object",
      {
        method: "PUT",
        headers: {
          "x-openclaw-media-ticket": parkedUpload.header,
          "content-length": String(bytes.byteLength),
          "content-type": "image/png",
        },
        body: bytes,
      },
    ), fixture.env);

    expect(recreated.status).toBe(409);
    expect(await recreated.json()).toEqual({ error: { code: "OBJECT_FINAL_DELETED" } });
    expect(fixture.r2.objects.has(OBJECT_KEY)).toBe(false);
  });

  it("rejects a signed five-second proof whose timestamps are not canonical UTC milliseconds", async () => {
    const keys = await ticketKeys();
    const fixture = await gatewayEnv(keys);
    const bytes = png();
    const ticket = await maintenanceTicket(keys.privateKey, bytes);
    const now = new Date();
    const authorization = await deleteAuthorization(keys.privateKey, ticket.claims, {
      iat: now.toISOString().replace("Z", "+00:00"),
      exp: new Date(now.getTime() + 5_000).toISOString().replace("Z", "+00:00"),
    });

    const response = await gateway.fetch(
      deleteRequest(ticket.header, authorization.header),
      fixture.env,
    );

    expect(response.status).toBe(403);
  });
});

describe("POST /v1/object/verify", () => {
  it("returns an explicit 410 when an authenticated expired verify has no workflow", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T00:00:00.000Z"));
    const keys = await ticketKeys();
    const fixture = await gatewayEnv(keys);
    const anchor = await signedAuditDocument(fixture.auditKeys.privateKey);
    const anchorKey = `v1/org/${ORGANIZATION_ID}/audit/2026-08-01/${AUDIT_ROOT_ID}.json`;
    const ticket = await maintenanceTicket(keys.privateKey, anchor.bytes, {
      operation: "ANCHOR_VERIFY",
      objectKey: anchorKey,
      contentType: "application/json",
      contentLength: anchor.bytes.byteLength,
      sha256: await sha256Hex(anchor.bytes),
      auditRootId: AUDIT_ROOT_ID,
      rootHash: "a".repeat(64),
      signatureHash: anchor.signatureHash,
      auditSigningKeyGeneration: 7,
      auditSigningPublicKeyHash: fixture.auditSigningPublicKeyHash,
    });
    vi.setSystemTime(new Date("2026-08-01T00:02:00.000Z"));

    const response = await gateway.fetch(new Request(
      "https://openclaw-media.chillhome.io.vn/v1/object/verify",
      { method: "POST", headers: { "x-openclaw-media-ticket": ticket.header } },
    ), fixture.env);

    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({ error: { code: "TICKET_EXPIRED_NO_WORK" } });
  });

  it("admits a SQL-shaped verify recovery with current floors and signs frozen lineage", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T00:00:00.000Z"));
    const keys = await ticketKeys();
    const fixture = await gatewayEnv(keys);
    const anchor = await signedAuditDocument(fixture.auditKeys.privateKey);
    const anchorKey = `v1/org/${ORGANIZATION_ID}/audit/2026-08-01/${AUDIT_ROOT_ID}.json`;
    await fixture.r2.bucket.put(anchorKey, anchor.bytes);
    const original = await maintenanceTicket(keys.privateKey, anchor.bytes, {
      operation: "ANCHOR_VERIFY",
      objectKey: anchorKey,
      contentType: "application/json",
      contentLength: anchor.bytes.byteLength,
      sha256: await sha256Hex(anchor.bytes),
      auditRootId: AUDIT_ROOT_ID,
      rootHash: "a".repeat(64),
      signatureHash: anchor.signatureHash,
      auditSigningKeyGeneration: 7,
      auditSigningPublicKeyHash: fixture.auditSigningPublicKeyHash,
    });
    vi.setSystemTime(new Date("2026-08-01T00:02:00.000Z"));
    expect((await gateway.fetch(new Request(
      "https://openclaw-media.chillhome.io.vn/v1/object/verify",
      { method: "POST", headers: { "x-openclaw-media-ticket": original.header } },
    ), fixture.env)).status).toBe(410);
    const current = {
      maintenancePrincipalId: "dddd2000-0000-4000-8000-000000000011",
      credentialGeneration: 13,
      leaseGeneration: 14,
      fencingToken: 15,
    };
    for (const [dimension, generation] of [
      ["CREDENTIAL", current.credentialGeneration],
      ["LEASE", current.leaseGeneration],
      ["CELL", current.fencingToken],
    ] as const) {
      await raiseMinimumGeneration(fixture.env, {
        organizationId: ORGANIZATION_ID,
        principalKind: "MAINTENANCE",
        accountId: null,
        cellId: null,
        maintenancePrincipalId: current.maintenancePrincipalId,
        dimension,
      }, generation);
    }
    const recovery = await recoveryMaintenanceTicket(keys.privateKey, anchor.bytes, original.claims, {
      ...current,
      operation: "ANCHOR_VERIFY",
      jti: "dddd7000-0000-4000-8000-000000000011",
      recoveryKind: "AUDIT_VERIFY_AUTHORIZED",
      replacesVerifyTicketJti: original.claims.jti,
      objectKey: anchorKey,
      contentType: "application/json",
      contentLength: anchor.bytes.byteLength,
      sha256: await sha256Hex(anchor.bytes),
      auditRootId: AUDIT_ROOT_ID,
      rootHash: "a".repeat(64),
      signatureHash: anchor.signatureHash,
      auditSigningKeyGeneration: 7,
      auditSigningPublicKeyHash: fixture.auditSigningPublicKeyHash,
    });

    const response = await gateway.fetch(new Request(
      "https://openclaw-media.chillhome.io.vn/v1/object/verify",
      { method: "POST", headers: { "x-openclaw-media-ticket": recovery.header } },
    ), fixture.env);
    const receipt = await response.json<Record<string, unknown>>();

    expect(response.status).toBe(200);
    expect(receipt).toMatchObject({
      maintenancePrincipalId: original.claims.maintenancePrincipalId,
      claimGeneration: original.claims.claimGeneration,
      credentialGeneration: original.claims.credentialGeneration,
      leaseGeneration: original.claims.leaseGeneration,
      fencingToken: original.claims.fencingToken,
      verifyTicketJti: recovery.claims.jti,
    });
  });

  it("lets a current SQL-shaped recovery replace an expired verify workflow", async () => {
    vi.useFakeTimers();
    const startedAt = new Date("2026-08-01T00:00:00.000Z");
    vi.setSystemTime(startedAt);
    const keys = await ticketKeys();
    const fixture = await gatewayEnv(keys);
    const anchor = await signedAuditDocument(fixture.auditKeys.privateKey);
    const anchorKey = `v1/org/${ORGANIZATION_ID}/audit/2026-08-01/${AUDIT_ROOT_ID}.json`;
    await fixture.r2.bucket.put(anchorKey, anchor.bytes);
    const original = await maintenanceTicket(keys.privateKey, anchor.bytes, {
      operation: "ANCHOR_VERIFY",
      objectKey: anchorKey,
      contentType: "application/json",
      contentLength: anchor.bytes.byteLength,
      sha256: await sha256Hex(anchor.bytes),
      auditRootId: AUDIT_ROOT_ID,
      rootHash: "a".repeat(64),
      signatureHash: anchor.signatureHash,
      auditSigningKeyGeneration: 7,
      auditSigningPublicKeyHash: fixture.auditSigningPublicKeyHash,
    });
    const request = (header: string) => new Request(
      "https://openclaw-media.chillhome.io.vn/v1/object/verify",
      { method: "POST", headers: { "x-openclaw-media-ticket": header } },
    );
    expect((await gateway.fetch(request(original.header), fixture.env)).status).toBe(200);

    vi.setSystemTime(new Date(startedAt.getTime() + (7 * 24 * 60 * 60 + 61) * 1_000));
    const expired = await gateway.fetch(request(original.header), fixture.env);
    expect(expired.status).toBe(410);
    expect(await expired.json()).toEqual({ error: { code: "TICKET_EXPIRED_NO_WORK" } });

    const recovery = await recoveryMaintenanceTicket(keys.privateKey, anchor.bytes, original.claims, {
      operation: "ANCHOR_VERIFY",
      jti: "dddd7000-0000-4000-8000-000000000015",
      recoveryKind: "AUDIT_VERIFY_AUTHORIZED",
      replacesVerifyTicketJti: original.claims.jti,
      objectKey: anchorKey,
      contentType: "application/json",
      contentLength: anchor.bytes.byteLength,
      sha256: await sha256Hex(anchor.bytes),
      auditRootId: AUDIT_ROOT_ID,
      rootHash: "a".repeat(64),
      signatureHash: anchor.signatureHash,
      auditSigningKeyGeneration: 7,
      auditSigningPublicKeyHash: fixture.auditSigningPublicKeyHash,
    });
    const response = await gateway.fetch(request(recovery.header), fixture.env);
    const receipt = await response.json<Record<string, unknown>>();

    expect(response.status).toBe(200);
    expect(receipt).toMatchObject({
      maintenancePrincipalId: original.claims.maintenancePrincipalId,
      claimGeneration: original.claims.claimGeneration,
      verifyTicketJti: recovery.claims.jti,
    });
  });

  it("verifies audit recovery with the exact retained historical audit key after rotation", async () => {
    const keys = await ticketKeys();
    const fixture = await gatewayEnv(keys);
    const anchor = await signedAuditDocument(fixture.auditKeys.privateKey);
    const anchorKey = `v1/org/${ORGANIZATION_ID}/audit/2026-08-01/${AUDIT_ROOT_ID}.json`;
    await fixture.r2.bucket.put(anchorKey, anchor.bytes);
    const original = await maintenanceTicket(keys.privateKey, anchor.bytes, {
      operation: "ANCHOR_VERIFY",
      objectKey: anchorKey,
      contentType: "application/json",
      contentLength: anchor.bytes.byteLength,
      sha256: await sha256Hex(anchor.bytes),
      auditRootId: AUDIT_ROOT_ID,
      rootHash: "a".repeat(64),
      signatureHash: anchor.signatureHash,
      auditSigningKeyGeneration: 7,
      auditSigningPublicKeyHash: fixture.auditSigningPublicKeyHash,
    });
    await rotateAuditVerifier(fixture.env);
    const recovery = await recoveryMaintenanceTicket(keys.privateKey, anchor.bytes, original.claims, {
      operation: "ANCHOR_VERIFY",
      jti: "dddd7000-0000-4000-8000-000000000016",
      recoveryKind: "AUDIT_VERIFY_AUTHORIZED",
      replacesVerifyTicketJti: original.claims.jti,
      objectKey: anchorKey,
      contentType: "application/json",
      contentLength: anchor.bytes.byteLength,
      sha256: await sha256Hex(anchor.bytes),
      auditRootId: AUDIT_ROOT_ID,
      rootHash: "a".repeat(64),
      signatureHash: anchor.signatureHash,
      auditSigningKeyGeneration: 7,
      auditSigningPublicKeyHash: fixture.auditSigningPublicKeyHash,
    });

    const response = await gateway.fetch(new Request(
      "https://openclaw-media.chillhome.io.vn/v1/object/verify",
      { method: "POST", headers: { "x-openclaw-media-ticket": recovery.header } },
    ), fixture.env);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      receiptKind: "AUDIT_ANCHOR_VERIFY",
      auditSigningKeyGeneration: 7,
    });
  });

  it("rejects an emergency-revoked historical audit key during recovery", async () => {
    const keys = await ticketKeys();
    const fixture = await gatewayEnv(keys);
    const anchor = await signedAuditDocument(fixture.auditKeys.privateKey);
    const anchorKey = `v1/org/${ORGANIZATION_ID}/audit/2026-08-01/${AUDIT_ROOT_ID}.json`;
    await fixture.r2.bucket.put(anchorKey, anchor.bytes);
    const original = await maintenanceTicket(keys.privateKey, anchor.bytes, {
      operation: "ANCHOR_VERIFY",
      objectKey: anchorKey,
      contentType: "application/json",
      contentLength: anchor.bytes.byteLength,
      sha256: await sha256Hex(anchor.bytes),
      auditRootId: AUDIT_ROOT_ID,
      rootHash: "a".repeat(64),
      signatureHash: anchor.signatureHash,
      auditSigningKeyGeneration: 7,
      auditSigningPublicKeyHash: fixture.auditSigningPublicKeyHash,
    });
    await rotateAuditVerifier(fixture.env, true);
    const recovery = await recoveryMaintenanceTicket(keys.privateKey, anchor.bytes, original.claims, {
      operation: "ANCHOR_VERIFY",
      jti: "dddd7000-0000-4000-8000-000000000017",
      recoveryKind: "AUDIT_VERIFY_AUTHORIZED",
      replacesVerifyTicketJti: original.claims.jti,
      objectKey: anchorKey,
      contentType: "application/json",
      contentLength: anchor.bytes.byteLength,
      sha256: await sha256Hex(anchor.bytes),
      auditRootId: AUDIT_ROOT_ID,
      rootHash: "a".repeat(64),
      signatureHash: anchor.signatureHash,
      auditSigningKeyGeneration: 7,
      auditSigningPublicKeyHash: fixture.auditSigningPublicKeyHash,
    });

    const response = await gateway.fetch(new Request(
      "https://openclaw-media.chillhome.io.vn/v1/object/verify",
      { method: "POST", headers: { "x-openclaw-media-ticket": recovery.header } },
    ), fixture.env);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code: "AUDIT_ANCHOR_INVALID" } });
  });

  it("maps an atomic audit generation rejection to 403 before reading R2", async () => {
    const keys = await ticketKeys();
    const fixture = await gatewayEnv(keys);
    const anchor = await signedAuditDocument(fixture.auditKeys.privateKey);
    const anchorKey = `v1/org/${ORGANIZATION_ID}/audit/2026-08-01/${AUDIT_ROOT_ID}.json`;
    const ticket = await maintenanceTicket(keys.privateKey, anchor.bytes, {
      operation: "ANCHOR_VERIFY",
      objectKey: anchorKey,
      contentType: "application/json",
      contentLength: anchor.bytes.byteLength,
      sha256: await sha256Hex(anchor.bytes),
      auditRootId: AUDIT_ROOT_ID,
      rootHash: "a".repeat(64),
      signatureHash: anchor.signatureHash,
      auditSigningKeyGeneration: 7,
      auditSigningPublicKeyHash: fixture.auditSigningPublicKeyHash,
    });
    await raiseMinimumGeneration(fixture.env, {
      organizationId: ORGANIZATION_ID,
      principalKind: "MAINTENANCE",
      accountId: null,
      cellId: null,
      maintenancePrincipalId: MAINTENANCE_PRINCIPAL_ID,
      dimension: "LEASE",
    }, 6);
    const get = vi.spyOn(fixture.env.MEDIA, "get");

    const response = await gateway.fetch(new Request(
      "https://openclaw-media.chillhome.io.vn/v1/object/verify",
      { method: "POST", headers: { "x-openclaw-media-ticket": ticket.header } },
    ), fixture.env);

    expect(response.status).toBe(403);
    expect(get).not.toHaveBeenCalled();
  });

  it("rechecks current admission after audit reads before persisting in-progress work", async () => {
    const keys = await ticketKeys();
    const fixture = await gatewayEnv(keys);
    const anchor = await signedAuditDocument(fixture.auditKeys.privateKey);
    const anchorKey = `v1/org/${ORGANIZATION_ID}/audit/2026-08-01/${AUDIT_ROOT_ID}.json`;
    await fixture.r2.bucket.put(anchorKey, anchor.bytes);
    const ticket = await maintenanceTicket(keys.privateKey, anchor.bytes, {
      operation: "ANCHOR_VERIFY",
      objectKey: anchorKey,
      contentType: "application/json",
      contentLength: anchor.bytes.byteLength,
      sha256: await sha256Hex(anchor.bytes),
      auditRootId: AUDIT_ROOT_ID,
      rootHash: "a".repeat(64),
      signatureHash: anchor.signatureHash,
      auditSigningKeyGeneration: 7,
      auditSigningPublicKeyHash: fixture.auditSigningPublicKeyHash,
    });
    const originalGet = fixture.env.MEDIA.get.bind(fixture.env.MEDIA);
    fixture.env.MEDIA.get = async (key) => {
      const object = await originalGet(key);
      await raiseMinimumGeneration(fixture.env, {
        organizationId: ORGANIZATION_ID,
        principalKind: "MAINTENANCE",
        accountId: null,
        cellId: null,
        maintenancePrincipalId: MAINTENANCE_PRINCIPAL_ID,
        dimension: "LEASE",
      }, 7);
      return object;
    };

    const response = await gateway.fetch(new Request(
      "https://openclaw-media.chillhome.io.vn/v1/object/verify",
      { method: "POST", headers: { "x-openclaw-media-ticket": ticket.header } },
    ), fixture.env);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: { code: "TICKET_GENERATION_REVOKED" },
    });
    expect(await getWorkState(
      fixture.env,
      ORGANIZATION_ID,
      null,
      `VERIFY:${WORK_ITEM_ID}`,
    )).toBeNull();
  });

  it("finishes exact VERIFY progress after its maintenance floor rises", async () => {
    const keys = await ticketKeys();
    const fixture = await gatewayEnv(keys);
    const anchor = await signedAuditDocument(fixture.auditKeys.privateKey);
    const anchorKey = `v1/org/${ORGANIZATION_ID}/audit/2026-08-01/${AUDIT_ROOT_ID}.json`;
    await fixture.r2.bucket.put(anchorKey, anchor.bytes);
    const ticket = await maintenanceTicket(keys.privateKey, anchor.bytes, {
      operation: "ANCHOR_VERIFY",
      objectKey: anchorKey,
      contentType: "application/json",
      contentLength: anchor.bytes.byteLength,
      sha256: await sha256Hex(anchor.bytes),
      auditRootId: AUDIT_ROOT_ID,
      rootHash: "a".repeat(64),
      signatureHash: anchor.signatureHash,
      auditSigningKeyGeneration: 7,
      auditSigningPublicKeyHash: fixture.auditSigningPublicKeyHash,
    });
    const hashes = await verifyWorkflowHashes(ticket.claims);
    await beginWorkflow(
      fixture.env,
      ORGANIZATION_ID,
      null,
      `VERIFY:${WORK_ITEM_ID}`,
      hashes.claimHash,
      "VERIFY",
      [{ jti: ticket.claims.jti, expiresAtEpochSeconds: ticket.claims.exp }],
      ticket.claims,
      false,
      hashes.replayHash,
    );
    await markWorkInProgress(
      fixture.env,
      ORGANIZATION_ID,
      null,
      `VERIFY:${WORK_ITEM_ID}`,
      hashes.claimHash,
      { versionOrEtag: "version-1" },
    );
    await raiseMinimumGeneration(fixture.env, {
      organizationId: ORGANIZATION_ID,
      principalKind: "MAINTENANCE",
      accountId: null,
      cellId: null,
      maintenancePrincipalId: MAINTENANCE_PRINCIPAL_ID,
      dimension: "LEASE",
    }, 6);

    const response = await gateway.fetch(new Request(
      "https://openclaw-media.chillhome.io.vn/v1/object/verify",
      { method: "POST", headers: { "x-openclaw-media-ticket": ticket.header } },
    ), fixture.env);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ receiptKind: "AUDIT_ANCHOR_VERIFY" });
  });

  it("finishes exact VERIFY progress with its retained audit key after rotation", async () => {
    const keys = await ticketKeys();
    const fixture = await gatewayEnv(keys);
    const anchor = await signedAuditDocument(fixture.auditKeys.privateKey);
    const anchorKey = `v1/org/${ORGANIZATION_ID}/audit/2026-08-01/${AUDIT_ROOT_ID}.json`;
    await fixture.r2.bucket.put(anchorKey, anchor.bytes);
    const ticket = await maintenanceTicket(keys.privateKey, anchor.bytes, {
      operation: "ANCHOR_VERIFY",
      objectKey: anchorKey,
      contentType: "application/json",
      contentLength: anchor.bytes.byteLength,
      sha256: await sha256Hex(anchor.bytes),
      auditRootId: AUDIT_ROOT_ID,
      rootHash: "a".repeat(64),
      signatureHash: anchor.signatureHash,
      auditSigningKeyGeneration: 7,
      auditSigningPublicKeyHash: fixture.auditSigningPublicKeyHash,
    });
    const hashes = await verifyWorkflowHashes(ticket.claims);
    await beginWorkflow(
      fixture.env,
      ORGANIZATION_ID,
      null,
      `VERIFY:${WORK_ITEM_ID}`,
      hashes.claimHash,
      "VERIFY",
      [{ jti: ticket.claims.jti, expiresAtEpochSeconds: ticket.claims.exp }],
      ticket.claims,
      false,
      hashes.replayHash,
    );
    await markWorkInProgress(
      fixture.env,
      ORGANIZATION_ID,
      null,
      `VERIFY:${WORK_ITEM_ID}`,
      hashes.claimHash,
      { versionOrEtag: "version-1" },
    );
    await rotateAuditVerifier(fixture.env);

    const response = await gateway.fetch(new Request(
      "https://openclaw-media.chillhome.io.vn/v1/object/verify",
      { method: "POST", headers: { "x-openclaw-media-ticket": ticket.header } },
    ), fixture.env);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      receiptKind: "AUDIT_ANCHOR_VERIFY",
      auditSigningKeyGeneration: 7,
    });
  });

  it("rechecks receipt signer revocation after audit reads and before signing", async () => {
    const keys = await ticketKeys();
    const fixture = await gatewayEnv(keys);
    const anchor = await signedAuditDocument(fixture.auditKeys.privateKey);
    const anchorKey = `v1/org/${ORGANIZATION_ID}/audit/2026-08-01/${AUDIT_ROOT_ID}.json`;
    await fixture.r2.bucket.put(anchorKey, anchor.bytes);
    const ticket = await maintenanceTicket(keys.privateKey, anchor.bytes, {
      operation: "ANCHOR_VERIFY",
      objectKey: anchorKey,
      contentType: "application/json",
      contentLength: anchor.bytes.byteLength,
      sha256: await sha256Hex(anchor.bytes),
      auditRootId: AUDIT_ROOT_ID,
      rootHash: "a".repeat(64),
      signatureHash: anchor.signatureHash,
      auditSigningKeyGeneration: 7,
      auditSigningPublicKeyHash: fixture.auditSigningPublicKeyHash,
    });
    const originalGet = fixture.env.MEDIA.get.bind(fixture.env.MEDIA);
    fixture.env.MEDIA.get = async (key) => {
      const object = await originalGet(key);
      fixture.env.OPENCLAW_RECEIPT_KEY_EMERGENCY_REVOKED = "true";
      return object;
    };

    const response = await gateway.fetch(new Request(
      "https://openclaw-media.chillhome.io.vn/v1/object/verify",
      { method: "POST", headers: { "x-openclaw-media-ticket": ticket.header } },
    ), fixture.env);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: { code: "RECEIPT_SIGNING_KEY_UNAVAILABLE" },
    });
    expect(await getWorkState(
      fixture.env,
      ORGANIZATION_ID,
      null,
      `VERIFY:${WORK_ITEM_ID}`,
    )).toBeNull();
  });

  it("verifies an immutable audit anchor and persists a signed replayable receipt", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T00:00:00.000Z"));
    const keys = await ticketKeys();
    const fixture = await gatewayEnv(keys);
    const anchorKey = `v1/org/${ORGANIZATION_ID}/audit/2026-08-01/${AUDIT_ROOT_ID}.json`;
    const anchor = await signedAuditDocument(fixture.auditKeys.privateKey);
    await fixture.r2.bucket.put(anchorKey, anchor.bytes);
    const ticket = await maintenanceTicket(keys.privateKey, anchor.bytes, {
      operation: "ANCHOR_VERIFY",
      objectKey: anchorKey,
      contentType: "application/json",
      contentLength: anchor.bytes.byteLength,
      sha256: await sha256Hex(anchor.bytes),
      auditRootId: AUDIT_ROOT_ID,
      rootHash: "a".repeat(64),
      signatureHash: anchor.signatureHash,
      auditSigningKeyGeneration: 7,
      auditSigningPublicKeyHash: fixture.auditSigningPublicKeyHash,
    });
    const makeRequest = () => new Request(
      "https://openclaw-media.chillhome.io.vn/v1/object/verify",
      { method: "POST", headers: { "x-openclaw-media-ticket": ticket.header } },
    );

    const first = await gateway.fetch(makeRequest(), fixture.env);
    const firstBody = await first.text();
    const receipt = JSON.parse(firstBody) as Record<string, unknown>;
    expect(first.status).toBe(200);
    expect(receipt).toMatchObject({
      version: 1,
      receiptKind: "AUDIT_ANCHOR_VERIFY",
      organizationId: ORGANIZATION_ID,
      workItemId: WORK_ITEM_ID,
      auditRootId: AUDIT_ROOT_ID,
      rootHash: "a".repeat(64),
      anchorKey,
      signatureHash: anchor.signatureHash,
      auditSigningKeyGeneration: 7,
      verifyTicketJti: ticket.claims.jti,
      objectVersionOrEtag: "version-1",
      gatewaySigningKeyGeneration: 1,
    });
    await expectReceiptSignature(
      receipt,
      fixture.signingKeys.publicKey,
      "ihome-openclaw-audit-receipt-v1",
    );

    const reclaimed = await maintenanceTicket(keys.privateKey, anchor.bytes, {
      operation: "ANCHOR_VERIFY",
      jti: "dddd7000-0000-4000-8000-000000000099",
      claimGeneration: 4,
      objectKey: anchorKey,
      contentType: "application/json",
      contentLength: anchor.bytes.byteLength,
      sha256: await sha256Hex(anchor.bytes),
      auditRootId: AUDIT_ROOT_ID,
      rootHash: "a".repeat(64),
      signatureHash: anchor.signatureHash,
      auditSigningKeyGeneration: 7,
      auditSigningPublicKeyHash: fixture.auditSigningPublicKeyHash,
    });
    const reclaimedResponse = await gateway.fetch(new Request(
      "https://openclaw-media.chillhome.io.vn/v1/object/verify",
      { method: "POST", headers: { "x-openclaw-media-ticket": reclaimed.header } },
    ), fixture.env);
    expect(reclaimedResponse.status).toBe(409);
    expect(await reclaimedResponse.json()).toEqual({
      error: { code: "WORK_CLAIM_CONFLICT" },
    });

    vi.setSystemTime(new Date("2026-08-01T00:02:00.000Z"));
    const retry = await gateway.fetch(makeRequest(), fixture.env);
    expect(retry.status).toBe(200);
    expect(await retry.text()).toBe(firstBody);
  });

  it("replays a stored verify receipt while its object lease is held and signer is retired", async () => {
    const keys = await ticketKeys();
    const fixture = await gatewayEnv(keys);
    const anchorKey = `v1/org/${ORGANIZATION_ID}/audit/2026-08-01/${AUDIT_ROOT_ID}.json`;
    const anchor = await signedAuditDocument(fixture.auditKeys.privateKey);
    await fixture.r2.bucket.put(anchorKey, anchor.bytes);
    const ticket = await maintenanceTicket(keys.privateKey, anchor.bytes, {
      operation: "ANCHOR_VERIFY",
      objectKey: anchorKey,
      contentType: "application/json",
      contentLength: anchor.bytes.byteLength,
      sha256: await sha256Hex(anchor.bytes),
      auditRootId: AUDIT_ROOT_ID,
      rootHash: "a".repeat(64),
      signatureHash: anchor.signatureHash,
      auditSigningKeyGeneration: 7,
      auditSigningPublicKeyHash: fixture.auditSigningPublicKeyHash,
    });
    const makeRequest = () => new Request(
      "https://openclaw-media.chillhome.io.vn/v1/object/verify",
      { method: "POST", headers: { "x-openclaw-media-ticket": ticket.header } },
    );
    const first = await gateway.fetch(makeRequest(), fixture.env);
    const firstBody = await first.text();
    expect(first.status).toBe(200);

    await retireReceiptSigner(fixture.env);
    const blocker = "verify-replay-blocker";
    await acquireObjectMutationOrWait(fixture.env, anchorKey, "DELETE", blocker);
    try {
      const replay = await gateway.fetch(makeRequest(), fixture.env);
      expect(replay.status).toBe(200);
      expect(await replay.text()).toBe(firstBody);
    } finally {
      await releaseObjectMutation(fixture.env, anchorKey, blocker);
    }
  });

  it("replays VERIFY receipt when the first state read races and the signer is revoked", async () => {
    const keys = await ticketKeys();
    const fixture = await gatewayEnv(keys);
    const anchorKey = `v1/org/${ORGANIZATION_ID}/audit/2026-08-01/${AUDIT_ROOT_ID}.json`;
    const anchor = await signedAuditDocument(fixture.auditKeys.privateKey);
    await fixture.r2.bucket.put(anchorKey, anchor.bytes);
    const ticket = await maintenanceTicket(keys.privateKey, anchor.bytes, {
      operation: "ANCHOR_VERIFY",
      objectKey: anchorKey,
      contentType: "application/json",
      contentLength: anchor.bytes.byteLength,
      sha256: await sha256Hex(anchor.bytes),
      auditRootId: AUDIT_ROOT_ID,
      rootHash: "a".repeat(64),
      signatureHash: anchor.signatureHash,
      auditSigningKeyGeneration: 7,
      auditSigningPublicKeyHash: fixture.auditSigningPublicKeyHash,
    });
    const makeRequest = () => new Request(
      "https://openclaw-media.chillhome.io.vn/v1/object/verify",
      { method: "POST", headers: { "x-openclaw-media-ticket": ticket.header } },
    );
    const first = await gateway.fetch(makeRequest(), fixture.env);
    const firstBody = await first.text();
    expect(first.status).toBe(200);
    hideNextWorkStateRead(fixture.env);
    fixture.env.OPENCLAW_RECEIPT_KEY_EMERGENCY_REVOKED = "true";

    const replay = await gateway.fetch(makeRequest(), fixture.env);

    expect(replay.status).toBe(200);
    expect(await replay.text()).toBe(firstBody);
  });

  it("rejects an audit ticket whose immutable key names a different root", async () => {
    const keys = await ticketKeys();
    const fixture = await gatewayEnv(keys);
    const differentRootId = "dddd4000-0000-4000-8000-000000000011";
    const anchorKey = `v1/org/${ORGANIZATION_ID}/audit/2026-08-01/${AUDIT_ROOT_ID}.json`;
    const anchor = await signedAuditDocument(fixture.auditKeys.privateKey);
    await fixture.r2.bucket.put(anchorKey, anchor.bytes);
    const ticket = await maintenanceTicket(keys.privateKey, anchor.bytes, {
      operation: "ANCHOR_VERIFY",
      objectKey: anchorKey,
      contentType: "application/json",
      contentLength: anchor.bytes.byteLength,
      sha256: await sha256Hex(anchor.bytes),
      auditRootId: differentRootId,
      rootHash: "a".repeat(64),
      signatureHash: anchor.signatureHash,
      auditSigningKeyGeneration: 7,
      auditSigningPublicKeyHash: fixture.auditSigningPublicKeyHash,
    });

    const response = await gateway.fetch(new Request(
      "https://openclaw-media.chillhome.io.vn/v1/object/verify",
      { method: "POST", headers: { "x-openclaw-media-ticket": ticket.header } },
    ), fixture.env);

    expect(response.status).toBe(403);
  });

  it("rejects a document signed by a key outside the pinned audit generation", async () => {
    const keys = await ticketKeys();
    const trustedAuditKeys = await crypto.subtle.generateKey(
      "Ed25519",
      true,
      ["sign", "verify"],
    ) as CryptoKeyPair;
    const attackerAuditKeys = await crypto.subtle.generateKey(
      "Ed25519",
      true,
      ["sign", "verify"],
    ) as CryptoKeyPair;
    const fixture = await gatewayEnv(keys);
    fixture.env.OPENCLAW_AUDIT_PUBLIC_KEY_B64 = Buffer.from(
      await crypto.subtle.exportKey("spki", trustedAuditKeys.publicKey) as ArrayBuffer,
    ).toString("base64");
    fixture.env.OPENCLAW_AUDIT_KEY_GENERATION = "7";
    const anchorKey = `v1/org/${ORGANIZATION_ID}/audit/2026-08-01/${AUDIT_ROOT_ID}.json`;
    const forged = await signedAuditDocument(attackerAuditKeys.privateKey);
    await fixture.r2.bucket.put(anchorKey, forged.bytes);
    const ticket = await maintenanceTicket(keys.privateKey, forged.bytes, {
      operation: "ANCHOR_VERIFY",
      objectKey: anchorKey,
      contentType: "application/json",
      contentLength: forged.bytes.byteLength,
      sha256: await sha256Hex(forged.bytes),
      auditRootId: AUDIT_ROOT_ID,
      rootHash: "a".repeat(64),
      signatureHash: forged.signatureHash,
      auditSigningKeyGeneration: 7,
      auditSigningPublicKeyHash: fixture.auditSigningPublicKeyHash,
    });

    const response = await gateway.fetch(new Request(
      "https://openclaw-media.chillhome.io.vn/v1/object/verify",
      { method: "POST", headers: { "x-openclaw-media-ticket": ticket.header } },
    ), fixture.env);

    expect(response.status).toBe(409);
  });

  it("rejects an R2 size mismatch without buffering the audit object", async () => {
    const keys = await ticketKeys();
    const fixture = await gatewayEnv(keys);
    const anchorKey = `v1/org/${ORGANIZATION_ID}/audit/2026-08-01/${AUDIT_ROOT_ID}.json`;
    const anchor = await signedAuditDocument(fixture.auditKeys.privateKey);
    const ticket = await maintenanceTicket(keys.privateKey, anchor.bytes, {
      operation: "ANCHOR_VERIFY",
      objectKey: anchorKey,
      contentType: "application/json",
      contentLength: anchor.bytes.byteLength,
      sha256: await sha256Hex(anchor.bytes),
      auditRootId: AUDIT_ROOT_ID,
      rootHash: "a".repeat(64),
      signatureHash: anchor.signatureHash,
      auditSigningKeyGeneration: 7,
      auditSigningPublicKeyHash: fixture.auditSigningPublicKeyHash,
    });
    const readBytes = vi.fn(async () => {
      throw new Error("object body must not be read");
    });
    fixture.env.MEDIA.get = vi.fn(async () => ({
      key: anchorKey,
      version: "version-oversized",
      size: anchor.bytes.byteLength + 1,
      etag: "etag-oversized",
      httpEtag: '"etag-oversized"',
      checksums: { toJSON: () => ({}) },
      uploaded: new Date(),
      storageClass: "Standard",
      writeHttpMetadata: () => undefined,
      body: new ReadableStream(),
      bodyUsed: false,
      bytes: readBytes,
    } as unknown as R2ObjectBody));

    const response = await gateway.fetch(new Request(
      "https://openclaw-media.chillhome.io.vn/v1/object/verify",
      { method: "POST", headers: { "x-openclaw-media-ticket": ticket.header } },
    ), fixture.env);

    expect(response.status).toBe(409);
    expect(readBytes).not.toHaveBeenCalled();
  });

  it("does not sign an audit receipt with an out-of-contract R2 version", async () => {
    const keys = await ticketKeys();
    const fixture = await gatewayEnv(keys);
    const anchorKey = `v1/org/${ORGANIZATION_ID}/audit/2026-08-01/${AUDIT_ROOT_ID}.json`;
    const anchor = await signedAuditDocument(fixture.auditKeys.privateKey);
    await fixture.r2.bucket.put(anchorKey, anchor.bytes);
    const originalGet = fixture.env.MEDIA.get.bind(fixture.env.MEDIA);
    fixture.env.MEDIA.get = async (key) => {
      const object = await originalGet(key);
      return object ? { ...object, version: "v".repeat(513) } as R2ObjectBody : null;
    };
    const ticket = await maintenanceTicket(keys.privateKey, anchor.bytes, {
      operation: "ANCHOR_VERIFY",
      objectKey: anchorKey,
      contentType: "application/json",
      contentLength: anchor.bytes.byteLength,
      sha256: await sha256Hex(anchor.bytes),
      auditRootId: AUDIT_ROOT_ID,
      rootHash: "a".repeat(64),
      signatureHash: anchor.signatureHash,
      auditSigningKeyGeneration: 7,
      auditSigningPublicKeyHash: fixture.auditSigningPublicKeyHash,
    });

    const response = await gateway.fetch(new Request(
      "https://openclaw-media.chillhome.io.vn/v1/object/verify",
      { method: "POST", headers: { "x-openclaw-media-ticket": ticket.header } },
    ), fixture.env);

    expect(response.status).toBe(500);
  });
});
