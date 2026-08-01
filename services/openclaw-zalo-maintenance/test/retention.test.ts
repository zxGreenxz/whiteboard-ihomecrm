import { describe, expect, it, vi } from "vitest";

import { canonicalJson, sha256Hex } from "../src/runtime-client.js";
import {
  runRetentionWork,
  type MaintenanceWorkClaimV1,
  type RetentionDeleteReceiptV1,
  type RetentionSubjectKind,
} from "../src/retention-runner.js";

const NOW = new Date("2026-08-01T00:00:00.000Z");
const ORGANIZATION_ID = "dddd0000-0000-4000-8000-000000000001";
const MAINTENANCE_ID = "dddd3000-0000-4000-8000-000000000001";
const WORK_ITEM_ID = "dddd8000-0000-4000-8000-000000000001";
const SUBJECT_ID = "dddd6000-0000-4000-8000-000000000001";
const TOMBSTONE_ID = "dddd6000-0000-4000-8000-000000000002";
const TICKET_ID = "dddd7000-0000-4000-8000-000000000001";
const TICKET_JTI = "dddd7000-0000-4000-8000-000000000002";
const AUTHORIZATION_ID = "dddd7000-0000-4000-8000-000000000003";
const RECEIPT_ID = "dddd7000-0000-4000-8000-000000000004";
const REFRESHED_TICKET_JTI = "dddd7000-0000-4000-8000-000000000005";
const REFRESHED_AUTHORIZATION_ID = "dddd7000-0000-4000-8000-000000000006";
const CLAIM_TOKEN = "claim-token-0123456789abcdef0123456789abcdef";
const OBJECT_KEY =
  `v1/org/${ORGANIZATION_ID}/account/dddd1000-0000-4000-8000-000000000001` +
  "/conversation/dddd4000-0000-4000-8000-000000000001" +
  "/message/dddd5000-0000-4000-8000-000000000001" +
  `/media/${SUBJECT_ID}/original`;

function claim(
  phase: "QUARANTINE" | "FINAL_DELETE",
  subjectKind: RetentionSubjectKind = "MEDIA",
): MaintenanceWorkClaimV1 {
  return {
    version: 1,
    workItemId: WORK_ITEM_ID,
    organizationId: ORGANIZATION_ID,
    maintenancePrincipalId: MAINTENANCE_ID,
    credentialGeneration: 2,
    leaseGeneration: 3,
    sourceKey: `RETENTION:MEDIA:${SUBJECT_ID}:${phase}`,
    claimToken: CLAIM_TOKEN,
    claimGeneration: 4,
    fencingToken: 5,
    leaseExpiresAt: "2026-08-01T00:01:00.000Z",
    payload: phase === "QUARANTINE"
      ? {
          kind: "RETENTION_DELETE",
          deletePhase: "QUARANTINE",
          subjectKind,
          subjectId: SUBJECT_ID,
          retentionVersion: 1,
          holdVersion: 0,
        }
      : {
          kind: "RETENTION_DELETE",
          deletePhase: "FINAL_DELETE",
          subjectKind: "MEDIA",
          subjectId: SUBJECT_ID,
          objectKey: OBJECT_KEY,
          retentionVersion: 1,
          holdVersion: 0,
          quarantineVersion: 1,
          finalDeleteNotBefore: "2026-07-31T23:59:59.000Z",
        },
  };
}

function ticket() {
  return {
    version: 1,
    aud: "openclaw-media-gateway",
    operation: "DELETE",
    subject: "MAINTENANCE",
    jti: TICKET_JTI,
    organizationId: ORGANIZATION_ID,
    accountId: null,
    objectKey: OBJECT_KEY,
    sha256: "a".repeat(64),
    contentType: "image/png",
    contentLength: 33,
    sessionGeneration: 0,
    gatewayKeyGeneration: 7,
    receiptSigningKeyGeneration: 9,
    iat: Math.floor(NOW.getTime() / 1_000),
    exp: Math.floor(NOW.getTime() / 1_000) + 60,
    maintenancePrincipalId: MAINTENANCE_ID,
    workItemId: WORK_ITEM_ID,
    claimGeneration: 4,
    credentialGeneration: 2,
    leaseGeneration: 3,
    fencingToken: 5,
    deletePhase: "FINAL_DELETE",
    holdVersion: 0,
    quarantineVersion: 1,
    finalDeleteNotBefore: Math.floor(NOW.getTime() / 1_000) - 1,
    signature: "A".repeat(86),
  } as const;
}

function ticketHash(): string {
  const { signature: _signature, ...claims } = ticket();
  return sha256Hex(
    `ihome-openclaw-retention-delete-ticket-v1\0${canonicalJson(claims)}`,
  );
}

function authorization() {
  return {
    version: 1,
    authorizationKind: "RETENTION_FINAL_DELETE",
    organizationId: ORGANIZATION_ID,
    maintenancePrincipalId: MAINTENANCE_ID,
    workItemId: WORK_ITEM_ID,
    claimGeneration: 4,
    credentialGeneration: 2,
    leaseGeneration: 3,
    fencingToken: 5,
    objectKey: OBJECT_KEY,
    deletePhase: "FINAL_DELETE",
    holdVersion: 0,
    quarantineVersion: 1,
    deleteTicketJti: TICKET_JTI,
    authorizationJti: AUTHORIZATION_ID,
    iat: "2026-08-01T07:00:00+07:00",
    exp: "2026-08-01T07:00:05+07:00",
    gatewaySigningKeyGeneration: 7,
    signature: "B".repeat(86),
  } as const;
}

function recoveryDeleteTicket(value: ReturnType<typeof ticket>) {
  const { claimGeneration: _claimGeneration, ...ticketClaims } = value;
  return {
    ...ticketClaims,
    maintenancePrincipalId: MAINTENANCE_ID,
    credentialGeneration: 12,
    leaseGeneration: 13,
    fencingToken: 15,
    recoveryKind: "RETENTION_DELETE_AUTHORIZED",
    recoveryGeneration: 2,
    replacesTicketJti: TICKET_JTI,
    replacesDeleteAuthorizationJti: AUTHORIZATION_ID,
    frozenClaim: {
      maintenancePrincipalId: MAINTENANCE_ID,
      credentialGeneration: 2,
      leaseGeneration: 3,
      fencingToken: 5,
      claimGeneration: 4,
    },
  } as const;
}

function recoveryDeleteAuthorization(value: ReturnType<typeof authorization>) {
  const { claimGeneration: _claimGeneration, ...authorizationClaims } = value;
  return {
    ...authorizationClaims,
    maintenancePrincipalId: MAINTENANCE_ID,
    credentialGeneration: 12,
    leaseGeneration: 13,
    fencingToken: 15,
    recoveryKind: "RETENTION_DELETE_AUTHORIZED",
    recoveryGeneration: 2,
    replacesTicketJti: TICKET_JTI,
    replacesDeleteAuthorizationJti: AUTHORIZATION_ID,
    frozenClaim: {
      maintenancePrincipalId: MAINTENANCE_ID,
      credentialGeneration: 2,
      leaseGeneration: 3,
      fencingToken: 5,
      claimGeneration: 4,
    },
  } as const;
}

async function receiptKeys(): Promise<CryptoKeyPair> {
  return await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair;
}

async function signedReceipt(
  privateKey: CryptoKey,
  overrides: Partial<Omit<RetentionDeleteReceiptV1, "signature">> = {},
): Promise<RetentionDeleteReceiptV1> {
  const claims = {
    version: 1,
    receiptKind: "RETENTION_FINAL_DELETE",
    receiptId: RECEIPT_ID,
    organizationId: ORGANIZATION_ID,
    maintenancePrincipalId: MAINTENANCE_ID,
    workItemId: WORK_ITEM_ID,
    claimGeneration: 4,
    credentialGeneration: 2,
    leaseGeneration: 3,
    fencingToken: 5,
    objectKey: OBJECT_KEY,
    deletePhase: "FINAL_DELETE",
    holdVersion: 0,
    quarantineVersion: 1,
    deleteTicketJti: TICKET_JTI,
    deleteAuthorizationJti: AUTHORIZATION_ID,
    proofJti: AUTHORIZATION_ID,
    objectStatus: "DELETED",
    r2VersionOrEtag: "version-or-etag-1",
    completedAt: "2026-08-01T07:00:01+07:00",
    gatewaySigningKeyGeneration: 9,
    ...overrides,
  } as const;
  const signature = Buffer.from(await crypto.subtle.sign(
    "Ed25519",
    privateKey,
    new TextEncoder().encode(
      `ihome-openclaw-retention-receipt-v1\0${canonicalJson(claims)}`,
    ),
  )).toString("base64url");
  return { ...claims, signature } as RetentionDeleteReceiptV1;
}

async function publicKeyB64(pair: CryptoKeyPair): Promise<string> {
  return Buffer.from(await crypto.subtle.exportKey("spki", pair.publicKey)).toString("base64");
}

function ticketResult() {
  return {
    version: 1,
    ticketId: TICKET_ID,
    ticketHash: ticketHash(),
    expiresAt: "2026-08-01T07:01:00+07:00",
    state: "TICKET_ISSUED",
    ticket: ticket(),
  } as const;
}

function authorizationResult(authorizationTicketHash = ticketHash()) {
  return {
    version: 1,
    ticketId: TICKET_ID,
    ticketHash: authorizationTicketHash,
    deleteAuthorizationJti: AUTHORIZATION_ID,
    expiresAt: "2026-08-01T00:00:05+00:00",
    state: "DELETE_AUTHORIZED",
    authorization: authorization(),
  } as const;
}

function authorizationHash(): string {
  return sha256Hex(
    `ihome-openclaw-retention-authorization-v1\0${canonicalJson(authorization())}`,
  );
}

function authorizedRecovery(gatewayReceipt: RetentionDeleteReceiptV1 | null) {
  return {
    version: 1,
    recoveryKind: "RETENTION_DELETE_AUTHORIZED",
    workItemId: WORK_ITEM_ID,
    organizationId: ORGANIZATION_ID,
    maintenancePrincipalId: MAINTENANCE_ID,
    credentialGeneration: 12,
    leaseGeneration: 13,
    fencingToken: 15,
    sourceKey: `RETENTION:MEDIA:${SUBJECT_ID}:FINAL_DELETE`,
    claimToken: "recovery-token-0123456789abcdef0123456789abcdef",
    recoveryGeneration: 2,
    recoveryLeaseExpiresAt: "2026-08-01T00:01:00.000Z",
    frozenClaim: {
      maintenancePrincipalId: MAINTENANCE_ID,
      credentialGeneration: 2,
      leaseGeneration: 3,
      fencingToken: 5,
      claimGeneration: 4,
    },
    payload: claim("FINAL_DELETE").payload,
    ticketId: TICKET_ID,
    ticketHash: ticketHash(),
    ticket: ticket(),
    authorizationHash: authorizationHash(),
    authorization: authorization(),
    authorizationExpiresAt: authorization().exp,
    gatewayReceipt,
  } as const;
}

describe("retention orchestration", () => {
  it("fails before network I/O when the claim cannot cover the bounded final-delete budget", async () => {
    const expiringClaim = claim("FINAL_DELETE");
    expiringClaim.leaseExpiresAt = new Date(NOW.getTime() + 28_000).toISOString();
    const runtime = { post: vi.fn().mockRejectedValue(new Error("network must not run")) };
    const gateway = { deleteObject: vi.fn() };

    await expect(runRetentionWork({
      claim: expiringClaim,
      runtime,
      gateway,
      now: () => NOW,
      retryAttempts: 2,
      runtimeAttemptTimeoutMs: 4_000,
      gatewayAttemptTimeoutMs: 2_000,
      leaseSafetyMs: 1_000,
    })).rejects.toThrow(/lease budget/i);

    expect(runtime.post).not.toHaveBeenCalled();
    expect(gateway.deleteObject).not.toHaveBeenCalled();
  });

  it("completes QUARANTINE through the DB-only route and never touches the gateway", async () => {
    const runtime = { post: vi.fn().mockResolvedValue({
      version: 1,
      workItemId: WORK_ITEM_ID,
      tombstoneId: TOMBSTONE_ID,
      subjectKind: "MEDIA",
      subjectId: SUBJECT_ID,
      quarantinedAt: NOW.toISOString(),
      state: "COMPLETE",
    }) };
    const gateway = { deleteObject: vi.fn() };

    await expect(runRetentionWork({
      claim: claim("QUARANTINE"),
      runtime,
      gateway,
      now: () => NOW,
    })).resolves.toMatchObject({ state: "COMPLETE" });

    expect(runtime.post).toHaveBeenCalledOnce();
    expect(runtime.post.mock.calls[0]?.slice(0, 2)).toEqual(["/v1/maintenance/work/complete", {
      version: 1,
      workItemId: WORK_ITEM_ID,
      claimGeneration: 4,
      claimToken: CLAIM_TOKEN,
      subjectKind: "MEDIA",
      subjectId: SUBJECT_ID,
    }]);
    expect(gateway.deleteObject).not.toHaveBeenCalled();
  });

  it.each([
    "KNOWLEDGE", "HEALTH", "QR", "AUDIT", "POLICY", "CONTROL", "DELIVERY",
    "UNKNOWN", "SECURITY", "CONSENT", "RISK",
  ] as const)("completes canonical %s QUARANTINE through the DB-only route", async (subjectKind) => {
    const runtime = { post: vi.fn().mockResolvedValue({
      version: 1,
      workItemId: WORK_ITEM_ID,
      tombstoneId: TOMBSTONE_ID,
      subjectKind,
      subjectId: SUBJECT_ID,
      quarantinedAt: NOW.toISOString(),
      state: "COMPLETE",
    }) };
    const gateway = { deleteObject: vi.fn() };

    await expect(runRetentionWork({
      claim: claim("QUARANTINE", subjectKind),
      runtime,
      gateway,
      now: () => NOW,
    })).resolves.toMatchObject({ state: "COMPLETE", subjectKind });

    expect(runtime.post).toHaveBeenCalledOnce();
    expect(gateway.deleteObject).not.toHaveBeenCalled();
  });

  it("runs FINAL_DELETE in one exact ticket → authorization → gateway → completion path", async () => {
    const keys = await receiptKeys();
    const gatewayReceipt = await signedReceipt(keys.privateKey);
    const order: string[] = [];
    const runtime = {
      post: vi.fn(async (path: string, body: unknown) => {
        order.push(path);
        if (path.endsWith("delete-ticket")) return ticketResult();
        if (path.endsWith("authorize-delete")) {
          expect(body).toEqual({
            version: 1,
            workItemId: WORK_ITEM_ID,
            claimGeneration: 4,
            claimToken: CLAIM_TOKEN,
          });
          return authorizationResult();
        }
        expect(path).toBe("/v1/maintenance/work/complete");
        expect(body).toEqual({ version: 1, ticketId: TICKET_ID, gatewayReceipt });
        return {
          version: 1,
          ticketId: TICKET_ID,
          gatewayOutcome: "DELETED",
          receiptHash: "d".repeat(64),
          finalized: true,
          idempotentReplay: false,
        };
      }),
    };
    const gateway = {
      deleteObject: vi.fn(async (request: {
        ticketHeader: string;
        deleteAuthorizationHeader: string;
      }) => {
        order.push("gateway:DELETE");
        expect(JSON.parse(Buffer.from(request.ticketHeader, "base64url").toString("utf8")))
          .toEqual(ticket());
        expect(ticket().gatewayKeyGeneration).toBe(7);
        expect(ticket().receiptSigningKeyGeneration).toBe(9);
        expect(JSON.parse(
          Buffer.from(request.deleteAuthorizationHeader, "base64url").toString("utf8"),
        )).toEqual(authorization());
        return gatewayReceipt;
      }),
    };

    await expect(runRetentionWork({
      claim: claim("FINAL_DELETE"),
      runtime,
      gateway,
      now: () => NOW,
    })).resolves.toMatchObject({ finalized: true, gatewayOutcome: "DELETED" });

    expect(order).toEqual([
      "/v1/maintenance/retention/delete-ticket",
      "/v1/maintenance/retention/authorize-delete",
      "gateway:DELETE",
      "/v1/maintenance/work/complete",
    ]);
  });

  it("rejects a cross-claim gateway receipt before DB completion", async () => {
    const keys = await receiptKeys();
    const forged = await signedReceipt(keys.privateKey, {
      workItemId: "dddd8000-0000-4000-8000-000000000099",
    });
    const runtime = {
      post: vi.fn(async (path: string) => {
        if (path.endsWith("delete-ticket")) return ticketResult();
        if (path.endsWith("authorize-delete")) {
          return authorizationResult();
        }
        throw new Error("completion must not run");
      }),
    };

    await expect(runRetentionWork({
      claim: claim("FINAL_DELETE"),
      runtime,
      gateway: { deleteObject: vi.fn().mockResolvedValue(forged) },
      now: () => NOW,
    })).rejects.toThrow("retention receipt claim mismatch");

    expect(runtime.post.mock.calls.map((entry) => entry[0])).not.toContain(
      "/v1/maintenance/work/complete",
    );
  });

  it("rejects an authorization bound to a different delete-ticket hash", async () => {
    const runtime = {
      post: vi.fn(async (path: string) => {
        if (path.endsWith("delete-ticket")) return ticketResult();
        if (path.endsWith("authorize-delete")) return authorizationResult("d".repeat(64));
        throw new Error("completion must not run");
      }),
    };
    const gateway = { deleteObject: vi.fn() };

    await expect(runRetentionWork({
      claim: claim("FINAL_DELETE"),
      runtime,
      gateway,
      now: () => NOW,
    })).rejects.toThrow("delete authorization ticket hash mismatch");

    expect(gateway.deleteObject).not.toHaveBeenCalled();
  });

  it("rejects a receipt whose signing generation differs from its delete ticket", async () => {
    const keys = await receiptKeys();
    const mismatchedTicket = { ...ticket(), receiptSigningKeyGeneration: 8 };
    const { signature: _signature, ...claims } = mismatchedTicket;
    const mismatchedTicketHash = sha256Hex(
      `ihome-openclaw-retention-delete-ticket-v1\0${canonicalJson(claims)}`,
    );
    const runtime = {
      post: vi.fn(async (path: string) => {
        if (path.endsWith("delete-ticket")) return {
          ...ticketResult(),
          ticketHash: mismatchedTicketHash,
          ticket: mismatchedTicket,
        };
        if (path.endsWith("authorize-delete")) return authorizationResult(mismatchedTicketHash);
        throw new Error("completion must not run");
      }),
    };
    const gateway = { deleteObject: vi.fn().mockResolvedValue(
      await signedReceipt(keys.privateKey),
    ) };

    await expect(runRetentionWork({
      claim: claim("FINAL_DELETE"),
      runtime,
      gateway,
      now: () => NOW,
    })).rejects.toThrow("retention receipt claim mismatch");

    expect(gateway.deleteObject).toHaveBeenCalledOnce();
  });

  it("rejects a delete-ticket envelope whose expiry disagrees with its signed claims", async () => {
    const runtime = {
      post: vi.fn(async (path: string) => {
        if (path.endsWith("delete-ticket")) {
          return { ...ticketResult(), expiresAt: "2026-08-01T00:00:59.000Z" };
        }
        if (path.endsWith("authorize-delete")) return authorizationResult();
        throw new Error("completion must not run");
      }),
    };
    const gateway = { deleteObject: vi.fn() };

    await expect(runRetentionWork({
      claim: claim("FINAL_DELETE"),
      runtime,
      gateway,
      now: () => NOW,
    })).rejects.toThrow("delete ticket expiry mismatch");

    expect(gateway.deleteObject).not.toHaveBeenCalled();
  });

  it("replays byte-identical gateway and completion requests after lost responses", async () => {
    const keys = await receiptKeys();
    const gatewayReceipt = await signedReceipt(keys.privateKey);
    const gatewayRequests: string[] = [];
    const completionBodies: string[] = [];
    let gatewayLost = true;
    let completionLost = true;
    const runtime = {
      post: vi.fn(async (path: string, body: unknown) => {
        if (path.endsWith("delete-ticket")) return ticketResult();
        if (path.endsWith("authorize-delete")) {
          return authorizationResult();
        }
        completionBodies.push(canonicalJson(body));
        if (completionLost) {
          completionLost = false;
          throw new Error("response lost after DB commit");
        }
        return {
          version: 1,
          ticketId: TICKET_ID,
          gatewayOutcome: "DELETED",
          receiptHash: "d".repeat(64),
          finalized: true,
          idempotentReplay: true,
        };
      }),
    };
    let physicalDeleteCount = 0;
    const gateway = {
      deleteObject: vi.fn(async (request: unknown) => {
        gatewayRequests.push(canonicalJson(request));
        if (gatewayLost) {
          gatewayLost = false;
          physicalDeleteCount += 1;
          throw new Error("response lost after durable receipt commit");
        }
        return gatewayReceipt;
      }),
    };

    await expect(runRetentionWork({
      claim: claim("FINAL_DELETE"),
      runtime,
      gateway,
      now: () => NOW,
      retryAttempts: 2,
    })).resolves.toMatchObject({ finalized: true, idempotentReplay: true });

    expect(physicalDeleteCount).toBe(1);
    expect(gatewayRequests).toHaveLength(2);
    expect(new Set(gatewayRequests).size).toBe(1);
    expect(completionBodies).toHaveLength(2);
    expect(new Set(completionBodies).size).toBe(1);
    expect(runtime.post.mock.calls.filter(([path]) => String(path).endsWith("delete-ticket")))
      .toHaveLength(1);
    expect(runtime.post.mock.calls.filter(([path]) => String(path).endsWith("authorize-delete")))
      .toHaveLength(1);
  });

  it("resumes an authorized delete after restart without the cleared original claim token", async () => {
    const keys = await receiptKeys();
    const gatewayReceipt = await signedReceipt(keys.privateKey);
    const recovery = authorizedRecovery(null);
    const runtime = { post: vi.fn().mockResolvedValue({
      version: 1,
      ticketId: TICKET_ID,
      gatewayOutcome: "DELETED",
      receiptHash: "d".repeat(64),
      finalized: true,
      idempotentReplay: false,
    }) };
    const gateway = { deleteObject: vi.fn().mockResolvedValue(gatewayReceipt) };

    await expect(runRetentionWork({
      claim: recovery,
      runtime,
      gateway,
      now: () => NOW,
    })).resolves.toMatchObject({ finalized: true, gatewayOutcome: "DELETED" });

    expect(gateway.deleteObject).toHaveBeenCalledOnce();
    expect(runtime.post).toHaveBeenCalledOnce();
    expect(runtime.post).toHaveBeenCalledWith("/v1/maintenance/work/complete", {
      version: 1,
      recoveryKind: "RETENTION_DELETE_AUTHORIZED",
      workItemId: WORK_ITEM_ID,
      recoveryGeneration: 2,
      claimToken: recovery.claimToken,
      ticketId: TICKET_ID,
      gatewayReceipt,
    }, expect.any(Object));
  });

  it("rejects delete recovery before I/O when its lease cannot cover a refresh path", async () => {
    const recovery = {
      ...authorizedRecovery(null),
      recoveryLeaseExpiresAt: new Date(NOW.getTime() + 20_000).toISOString(),
    };
    const runtime = { post: vi.fn() };
    const gateway = { deleteObject: vi.fn() };

    await expect(runRetentionWork({
      claim: recovery,
      runtime,
      gateway,
      now: () => NOW,
      retryAttempts: 2,
      runtimeAttemptTimeoutMs: 4_000,
      gatewayAttemptTimeoutMs: 2_000,
      leaseSafetyMs: 1_000,
    })).rejects.toThrow(/lease budget/i);

    expect(runtime.post).not.toHaveBeenCalled();
    expect(gateway.deleteObject).not.toHaveBeenCalled();
  });

  it("submits a DB-authoritative stored delete receipt without calling Gateway again", async () => {
    const keys = await receiptKeys();
    const gatewayReceipt = await signedReceipt(keys.privateKey);
    const recovery = authorizedRecovery(gatewayReceipt);
    const runtime = { post: vi.fn().mockResolvedValue({
      version: 1,
      ticketId: TICKET_ID,
      gatewayOutcome: "DELETED",
      receiptHash: "d".repeat(64),
      finalized: true,
      idempotentReplay: true,
    }) };
    const gateway = { deleteObject: vi.fn() };

    await expect(runRetentionWork({
      claim: recovery,
      runtime,
      gateway,
      now: () => NOW,
    })).resolves.toMatchObject({ finalized: true, idempotentReplay: true });

    expect(gateway.deleteObject).not.toHaveBeenCalled();
    expect(runtime.post).toHaveBeenCalledOnce();
  });

  it("retries expired frozen delete artifacts unchanged after an ambiguous lost response", async () => {
    const keys = await receiptKeys();
    const oldTicket = {
      ...ticket(),
      iat: Math.floor(NOW.getTime() / 1_000) - 120,
      exp: Math.floor(NOW.getTime() / 1_000) - 60,
    };
    const { signature: _ticketSignature, ...oldTicketClaims } = oldTicket;
    const oldAuthorization = {
      ...authorization(),
      iat: new Date(NOW.getTime() - 65_000).toISOString(),
      exp: new Date(NOW.getTime() - 60_000).toISOString(),
    };
    const recovery = {
      ...authorizedRecovery(null),
      ticketHash: sha256Hex(
        `ihome-openclaw-retention-delete-ticket-v1\0${canonicalJson(oldTicketClaims)}`,
      ),
      ticket: oldTicket,
      authorizationHash: sha256Hex(
        `ihome-openclaw-retention-authorization-v1\0${canonicalJson(oldAuthorization)}`,
      ),
      authorization: oldAuthorization,
      authorizationExpiresAt: oldAuthorization.exp,
    };
    const gatewayReceipt = await signedReceipt(keys.privateKey);
    const gatewayRequests: string[] = [];
    const gateway = { deleteObject: vi.fn(async (request: unknown) => {
      gatewayRequests.push(canonicalJson(request));
      if (gatewayRequests.length === 1) throw new Error("response lost after stored receipt");
      return gatewayReceipt;
    }) };
    const runtime = { post: vi.fn().mockResolvedValue({
      version: 1,
      ticketId: TICKET_ID,
      gatewayOutcome: "DELETED",
      receiptHash: "d".repeat(64),
      finalized: true,
      idempotentReplay: true,
    }) };

    await expect(runRetentionWork({
      claim: recovery,
      runtime,
      gateway,
      now: () => NOW,
      retryAttempts: 2,
    })).resolves.toMatchObject({ finalized: true, idempotentReplay: true });

    expect(gatewayRequests).toHaveLength(2);
    expect(new Set(gatewayRequests).size).toBe(1);
    expect(runtime.post.mock.calls.map(([path]) => path)).not.toContain(
      "/v1/maintenance/retention/authorize-delete",
    );
  });

  it("refreshes both delete artifacts only after an exact expired-no-work denial", async () => {
    const keys = await receiptKeys();
    const oldTicket = {
      ...ticket(),
      iat: Math.floor(NOW.getTime() / 1_000) - 120,
      exp: Math.floor(NOW.getTime() / 1_000) - 60,
    };
    const { signature: _oldTicketSignature, ...oldTicketClaims } = oldTicket;
    const oldTicketHash = sha256Hex(
      `ihome-openclaw-retention-delete-ticket-v1\0${canonicalJson(oldTicketClaims)}`,
    );
    const oldAuthorization = {
      ...authorization(),
      iat: new Date(NOW.getTime() - 65_000).toISOString(),
      exp: new Date(NOW.getTime() - 60_000).toISOString(),
    };
    const refreshedTicket = recoveryDeleteTicket({
      ...ticket(),
      jti: REFRESHED_TICKET_JTI,
    });
    const { signature: _newTicketSignature, ...refreshedTicketClaims } = refreshedTicket;
    const refreshedTicketHash = sha256Hex(
      `ihome-openclaw-retention-delete-ticket-v1\0${canonicalJson(refreshedTicketClaims)}`,
    );
    const refreshedAuthorization = recoveryDeleteAuthorization({
      ...authorization(),
      deleteTicketJti: REFRESHED_TICKET_JTI,
      authorizationJti: REFRESHED_AUTHORIZATION_ID,
    });
    const recovery = {
      ...authorizedRecovery(null),
      ticketHash: oldTicketHash,
      ticket: oldTicket,
      authorizationHash: sha256Hex(
        `ihome-openclaw-retention-authorization-v1\0${canonicalJson(oldAuthorization)}`,
      ),
      authorization: oldAuthorization,
      authorizationExpiresAt: oldAuthorization.exp,
    };
    const gatewayReceipt = await signedReceipt(keys.privateKey, {
      deleteTicketJti: REFRESHED_TICKET_JTI,
      deleteAuthorizationJti: REFRESHED_AUTHORIZATION_ID,
      proofJti: REFRESHED_AUTHORIZATION_ID,
    });
    const runtime = { post: vi.fn(async (path: string, body: unknown) => {
      if (path.endsWith("authorize-delete")) {
        expect(body).toEqual({
          version: 1,
          recoveryKind: "RETENTION_DELETE_AUTHORIZED",
          workItemId: WORK_ITEM_ID,
          recoveryGeneration: 2,
          claimToken: recovery.claimToken,
          ticketId: TICKET_ID,
          expiredTicketJti: TICKET_JTI,
          expiredDeleteAuthorizationJti: AUTHORIZATION_ID,
          gatewayDenial: { status: 410, code: "TICKET_EXPIRED_NO_WORK" },
        });
        return {
          version: 1,
          ticketId: TICKET_ID,
          ticketHash: refreshedTicketHash,
          deleteAuthorizationJti: REFRESHED_AUTHORIZATION_ID,
          expiresAt: refreshedAuthorization.exp,
          state: "RECOVERY_REFRESHED",
          replacesTicketJti: TICKET_JTI,
          replacesDeleteAuthorizationJti: AUTHORIZATION_ID,
          ticket: refreshedTicket,
          authorization: refreshedAuthorization,
        };
      }
      return {
        version: 1,
        ticketId: TICKET_ID,
        gatewayOutcome: "DELETED",
        receiptHash: "d".repeat(64),
        finalized: true,
        idempotentReplay: false,
      };
    }) };
    const gateway = { deleteObject: vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("expired with no work"), {
        status: 410,
        code: "TICKET_EXPIRED_NO_WORK",
      }))
      .mockResolvedValueOnce(gatewayReceipt) };

    await expect(runRetentionWork({
      claim: recovery,
      runtime,
      gateway,
      now: () => NOW,
      retryAttempts: 2,
    })).resolves.toMatchObject({ finalized: true, idempotentReplay: false });

    expect(gateway.deleteObject).toHaveBeenCalledTimes(2);
    expect(runtime.post.mock.calls.map(([path]) => path)).toEqual([
      "/v1/maintenance/retention/authorize-delete",
      "/v1/maintenance/work/complete",
    ]);
  });

  it("reclaims already-refreshed authoritative delete artifacts after the refresh response is lost", async () => {
    const keys = await receiptKeys();
    const refreshedTicket = recoveryDeleteTicket({
      ...ticket(),
      jti: REFRESHED_TICKET_JTI,
    });
    const { signature: _ticketSignature, ...refreshedTicketClaims } = refreshedTicket;
    const refreshedAuthorization = recoveryDeleteAuthorization({
      ...authorization(),
      deleteTicketJti: REFRESHED_TICKET_JTI,
      authorizationJti: REFRESHED_AUTHORIZATION_ID,
    });
    const recovery = {
      ...authorizedRecovery(null),
      credentialGeneration: 22,
      leaseGeneration: 23,
      fencingToken: 25,
      recoveryGeneration: 3,
      ticketHash: sha256Hex(
        `ihome-openclaw-retention-delete-ticket-v1\0${canonicalJson(refreshedTicketClaims)}`,
      ),
      ticket: refreshedTicket,
      authorizationHash: sha256Hex(
        `ihome-openclaw-retention-authorization-v1\0${canonicalJson(refreshedAuthorization)}`,
      ),
      authorization: refreshedAuthorization,
      authorizationExpiresAt: refreshedAuthorization.exp,
    };
    const receipt = await signedReceipt(keys.privateKey, {
      deleteTicketJti: REFRESHED_TICKET_JTI,
      deleteAuthorizationJti: REFRESHED_AUTHORIZATION_ID,
      proofJti: REFRESHED_AUTHORIZATION_ID,
    });
    const runtime = { post: vi.fn().mockResolvedValue({
      version: 1,
      ticketId: TICKET_ID,
      gatewayOutcome: "DELETED",
      receiptHash: "d".repeat(64),
      finalized: true,
      idempotentReplay: false,
    }) };
    const gateway = { deleteObject: vi.fn(async (request: {
      ticketHeader: string;
      deleteAuthorizationHeader: string;
    }) => {
      expect(JSON.parse(Buffer.from(request.ticketHeader, "base64url").toString("utf8")))
        .toEqual(refreshedTicket);
      expect(JSON.parse(
        Buffer.from(request.deleteAuthorizationHeader, "base64url").toString("utf8"),
      )).toEqual(refreshedAuthorization);
      return receipt;
    }) };

    await expect(runRetentionWork({
      claim: recovery,
      runtime,
      gateway,
      now: () => NOW,
    })).resolves.toMatchObject({ finalized: true, idempotentReplay: false });

    expect(gateway.deleteObject).toHaveBeenCalledOnce();
    expect(runtime.post.mock.calls.map(([path]) => path)).toEqual([
      "/v1/maintenance/work/complete",
    ]);
  });
});
