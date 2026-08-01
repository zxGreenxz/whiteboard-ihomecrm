import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  buildSignedAuditAnchor,
  runAuditAnchorWork,
  type AuditAnchorReceiptV1,
} from "../src/audit-anchor-runner.js";
import { canonicalJson, sha256Hex } from "../src/runtime-client.js";
import type { MaintenanceWorkClaimV1 } from "../src/retention-runner.js";
import { MaintenanceRetryableWorkError } from "../src/work-error.js";
import { validateRuntimeRequestBody } from "../../../supabase/functions/openclaw-runtime/contracts.js";

const ORGANIZATION_ID = "dddd0000-0000-4000-8000-000000000001";
const MAINTENANCE_ID = "dddd3000-0000-4000-8000-000000000001";
const WORK_ITEM_ID = "dddd8000-0000-4000-8000-000000000001";
const AUDIT_ROOT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const UPLOAD_TICKET_JTI = "dddd7000-0000-4000-8000-000000000001";
const VERIFY_TICKET_JTI = "dddd7000-0000-4000-8000-000000000002";
const REFRESHED_VERIFY_TICKET_JTI = "dddd7000-0000-4000-8000-000000000004";
const RECEIPT_ID = "dddd7000-0000-4000-8000-000000000003";
const CLAIM_TOKEN = "claim-token-0123456789abcdef0123456789abcdef";
const PREVIOUS_ROOT_HASH = "b".repeat(64);
const MERKLE_ROOT_HASH = "c".repeat(64);
const ROOT_HASH = "bd86b1c7091150101c2e0735b7c9d8878551c757de2d29d5987a967ff8aa2af1";
const AUDIT_PRIVATE_KEY_PKCS8_B64 =
  "MC4CAQAwBQYDK2VwBCIEIMWmteGsPnyGcc+RwwKnlCvQU2k9yW+9CzLQ8E5rvkEZ";
const AUDIT_PUBLIC_KEY_SPKI_B64 =
  "MCowBQYDK2VwAyEA9GdFBbFtql79UOiCJ56ZifmYFIsiAWE+rNkEzzjakP0=";
const AUDIT_SIGNING_PUBLIC_KEY_HASH =
  "946ee40d3b57665e5def691c4e0f616876b3bcabdcbf07feaef80bbff01a9ded";
const ANCHOR_KEY = `v1/org/${ORGANIZATION_ID}/audit/2026-08-01/${AUDIT_ROOT_ID}.json`;
const NOW_SECONDS = Date.parse("2026-08-01T00:00:00.000Z") / 1_000;

function claim(): MaintenanceWorkClaimV1 {
  return {
    version: 1,
    workItemId: WORK_ITEM_ID,
    organizationId: ORGANIZATION_ID,
    maintenancePrincipalId: MAINTENANCE_ID,
    credentialGeneration: 2,
    leaseGeneration: 3,
    sourceKey: `audit:${AUDIT_ROOT_ID}:6`,
    claimToken: CLAIM_TOKEN,
    claimGeneration: 4,
    fencingToken: 5,
    leaseExpiresAt: "2099-08-01T00:01:00.000Z",
    payload: {
      kind: "AUDIT_ANCHOR",
      auditRootId: AUDIT_ROOT_ID,
      rootDate: "2026-08-01",
      firstSequence: 11,
      lastSequence: 14,
      eventCount: 4,
      previousRootHash: PREVIOUS_ROOT_HASH,
      merkleRootHash: MERKLE_ROOT_HASH,
      rootHash: ROOT_HASH,
      auditSigningKeyGeneration: 6,
      auditSigningPublicKeyHash: AUDIT_SIGNING_PUBLIC_KEY_HASH,
      anchorKey: ANCHOR_KEY,
    },
  };
}

async function ed25519Keys(): Promise<{
  pair: CryptoKeyPair;
  privateKeyPkcs8B64: string;
  publicKeySpkiB64: string;
}> {
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    Buffer.from(AUDIT_PRIVATE_KEY_PKCS8_B64, "base64"),
    "Ed25519",
    true,
    ["sign"],
  );
  const publicKey = await crypto.subtle.importKey(
    "spki",
    Buffer.from(AUDIT_PUBLIC_KEY_SPKI_B64, "base64"),
    "Ed25519",
    true,
    ["verify"],
  );
  const pair = { privateKey, publicKey } as CryptoKeyPair;
  return {
    pair,
    privateKeyPkcs8B64: AUDIT_PRIVATE_KEY_PKCS8_B64,
    publicKeySpkiB64: AUDIT_PUBLIC_KEY_SPKI_B64,
  };
}

function ticket(
  operation: "ANCHOR" | "ANCHOR_VERIFY",
  jti: string,
  documentSha256: string,
  documentByteLength: number,
  signatureHash: string,
  auditSigningPublicKeyHash: string,
) {
  return {
    version: 1,
    aud: "openclaw-media-gateway",
    operation,
    subject: "MAINTENANCE",
    jti,
    organizationId: ORGANIZATION_ID,
    accountId: null,
    objectKey: ANCHOR_KEY,
    sha256: documentSha256,
    contentType: "application/json",
    contentLength: documentByteLength,
    sessionGeneration: 0,
    gatewayKeyGeneration: 7,
    receiptSigningKeyGeneration: 9,
    iat: NOW_SECONDS,
    exp: NOW_SECONDS + 60,
    maintenancePrincipalId: MAINTENANCE_ID,
    workItemId: WORK_ITEM_ID,
    claimGeneration: 4,
    credentialGeneration: 2,
    leaseGeneration: 3,
    fencingToken: 5,
    auditRootId: AUDIT_ROOT_ID,
    rootHash: ROOT_HASH,
    signatureHash,
    auditSigningKeyGeneration: 6,
    auditSigningPublicKeyHash,
    signature: operation === "ANCHOR" ? "A".repeat(86) : "B".repeat(86),
  } as const;
}

function recoveryVerifyTicket(
  value: ReturnType<typeof ticket>,
  replacesVerifyTicketJti: string,
) {
  const { claimGeneration: _claimGeneration, ...ticketClaims } = value;
  return {
    ...ticketClaims,
    maintenancePrincipalId: MAINTENANCE_ID,
    credentialGeneration: 12,
    leaseGeneration: 13,
    fencingToken: 15,
    recoveryKind: "AUDIT_VERIFY_AUTHORIZED",
    recoveryGeneration: 2,
    replacesVerifyTicketJti,
    frozenClaim: {
      maintenancePrincipalId: MAINTENANCE_ID,
      credentialGeneration: 2,
      leaseGeneration: 3,
      fencingToken: 5,
      claimGeneration: 4,
    },
  } as const;
}

function ticketResult(
  value: ReturnType<typeof ticket> | ReturnType<typeof recoveryVerifyTicket>,
) {
  const { signature: _signature, ...claims } = value;
  return {
    version: 1,
    ticketId: value.jti,
    ticketHash: sha256Hex(`ihome-openclaw-media-ticket-v1\0${canonicalJson(claims)}`),
    expiresAt: new Date(value.exp * 1_000).toISOString().replace("Z", "+00:00"),
    state: "ISSUED",
    ticket: value,
  } as const;
}

function auditRecovery(
  verifyTicket: ReturnType<typeof ticket>,
  gatewayReceipt: AuditAnchorReceiptV1 | null,
) {
  const result = ticketResult(verifyTicket);
  return {
    version: 1,
    recoveryKind: "AUDIT_VERIFY_AUTHORIZED",
    workItemId: WORK_ITEM_ID,
    organizationId: ORGANIZATION_ID,
    maintenancePrincipalId: MAINTENANCE_ID,
    credentialGeneration: 12,
    leaseGeneration: 13,
    fencingToken: 15,
    sourceKey: `audit:${AUDIT_ROOT_ID}:6`,
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
    payload: claim().payload,
    verifyTicketId: verifyTicket.jti,
    verifyTicketHash: result.ticketHash,
    verifyTicket,
    gatewayReceipt,
  } as const;
}

async function signedGatewayReceipt(
  privateKey: CryptoKey,
  signatureHash: string,
  overrides: Partial<Omit<AuditAnchorReceiptV1, "signature">> = {},
): Promise<AuditAnchorReceiptV1> {
  const claims = {
    version: 1,
    receiptKind: "AUDIT_ANCHOR_VERIFY",
    receiptId: RECEIPT_ID,
    organizationId: ORGANIZATION_ID,
    maintenancePrincipalId: MAINTENANCE_ID,
    workItemId: WORK_ITEM_ID,
    claimGeneration: 4,
    credentialGeneration: 2,
    leaseGeneration: 3,
    fencingToken: 5,
    auditRootId: AUDIT_ROOT_ID,
    rootHash: ROOT_HASH,
    anchorKey: ANCHOR_KEY,
    signatureHash,
    auditSigningKeyGeneration: 6,
    verifyTicketJti: VERIFY_TICKET_JTI,
    objectVersionOrEtag: "anchor-version-1",
    verifiedAt: "2026-08-01T07:00:01+07:00",
    gatewaySigningKeyGeneration: 9,
    ...overrides,
  } as const;
  const signature = Buffer.from(await crypto.subtle.sign(
    "Ed25519",
    privateKey,
    new TextEncoder().encode(`ihome-openclaw-audit-receipt-v1\0${canonicalJson(claims)}`),
  )).toString("base64url");
  return { ...claims, signature } as AuditAnchorReceiptV1;
}

describe("audit root signing", () => {
  it("signs the canonical trusted root projection with domain separation", async () => {
    const keys = await ed25519Keys();
    expect(sha256Hex(
      "ihome-openclaw-audit-lineage-root-v1\0" + canonicalJson({
        version: 1,
        organizationId: ORGANIZATION_ID,
        rootDate: "2026-08-01",
        firstSequence: 11,
        lastSequence: 14,
        eventCount: 4,
        previousRootHash: PREVIOUS_ROOT_HASH,
        merkleRootHash: MERKLE_ROOT_HASH,
      }),
    )).toBe(ROOT_HASH);
    const anchor = await buildSignedAuditAnchor({
      claim: claim(),
      auditPrivateKeyPkcs8B64: keys.privateKeyPkcs8B64,
      auditPrivateKeyGeneration: 6,
    });

    expect(anchor.root).toEqual({
      version: 1,
      organizationId: ORGANIZATION_ID,
      rootDate: "2026-08-01",
      firstSequence: 11,
      lastSequence: 14,
      eventCount: 4,
      previousRootHash: PREVIOUS_ROOT_HASH,
      merkleRootHash: MERKLE_ROOT_HASH,
      rootHash: ROOT_HASH,
      auditSigningKeyGeneration: 6,
    });
    expect(anchor.document).toMatchObject({
      version: 1,
      signingDomain: "ihome-openclaw-audit-root-v1\0",
      root: anchor.root,
      canonicalRootJson: canonicalJson(anchor.root),
    });
    expect(anchor.document).not.toHaveProperty("auditRootId");
    expect(anchor.document).not.toHaveProperty("organizationId");
    expect(anchor.document).not.toHaveProperty("rootHash");
    expect(anchor.document.signatureHash).toBe(
      createHash("sha256").update(Buffer.from(anchor.document.signature, "base64url")).digest("hex"),
    );
    expect(anchor.auditSigningPublicKeyHash).toBe(
      createHash("sha256").update(Buffer.from(keys.publicKeySpkiB64, "base64")).digest("hex"),
    );
    expect(new TextDecoder().decode(anchor.bytes)).toBe(canonicalJson(anchor.document));
    await expect(crypto.subtle.verify(
      "Ed25519",
      keys.pair.publicKey,
      Buffer.from(anchor.document.signature, "base64url"),
      new TextEncoder().encode(
        `ihome-openclaw-audit-root-v1\0${canonicalJson(anchor.root)}`,
      ),
    )).resolves.toBe(true);
  });

  it("rejects a non-canonical audit private-key encoding", async () => {
    const keys = await ed25519Keys();
    await expect(buildSignedAuditAnchor({
      claim: claim(),
      auditPrivateKeyPkcs8B64: `${keys.privateKeyPkcs8B64}\n`,
      auditPrivateKeyGeneration: 6,
    })).rejects.toThrow(/audit signing key is invalid/i);
  });

  it("rejects a private key whose derived SPKI hash differs from the trusted claim", async () => {
    const keys = await ed25519Keys();
    const base = claim();
    const mismatchedClaim = {
      ...base,
      payload: {
        ...base.payload,
        auditSigningPublicKeyHash: "d".repeat(64),
      },
    };

    const error = await buildSignedAuditAnchor({
      claim: mismatchedClaim,
      auditPrivateKeyPkcs8B64: keys.privateKeyPkcs8B64,
      auditPrivateKeyGeneration: 6,
    }).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(MaintenanceRetryableWorkError);
    expect(String(error)).toContain("audit signing public key hash mismatch");
  });

  it("treats an audit signing generation mismatch as rollout-skew retry", async () => {
    const keys = await ed25519Keys();

    const error = await buildSignedAuditAnchor({
      claim: claim(),
      auditPrivateKeyPkcs8B64: keys.privateKeyPkcs8B64,
      auditPrivateKeyGeneration: 7,
    }).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(MaintenanceRetryableWorkError);
    expect(String(error)).toContain("audit signing key generation mismatch");
  });

  it("rejects a root hash that does not match the frozen lineage metadata", async () => {
    const keys = await ed25519Keys();
    const base = claim();

    await expect(buildSignedAuditAnchor({
      claim: {
        ...base,
        payload: { ...base.payload, rootHash: "f".repeat(64) },
      },
      auditPrivateKeyPkcs8B64: keys.privateKeyPkcs8B64,
      auditPrivateKeyGeneration: 6,
    })).rejects.toThrow("audit lineage root hash mismatch");
  });

  it("rejects an unsafe sequence integer before signing", async () => {
    const keys = await ed25519Keys();
    const base = claim();

    await expect(buildSignedAuditAnchor({
      claim: {
        ...base,
        payload: {
          ...base.payload,
          firstSequence: Number.MAX_SAFE_INTEGER + 1,
          lastSequence: Number.MAX_SAFE_INTEGER + 1,
          eventCount: 1,
        },
      },
      auditPrivateKeyPkcs8B64: keys.privateKeyPkcs8B64,
      auditPrivateKeyGeneration: 6,
    })).rejects.toThrow(/firstSequence/);
  });

  it("rejects a non-contiguous sequence count before signing", async () => {
    const keys = await ed25519Keys();
    const base = claim();

    await expect(buildSignedAuditAnchor({
      claim: {
        ...base,
        payload: { ...base.payload, eventCount: 3 },
      },
      auditPrivateKeyPkcs8B64: keys.privateKeyPkcs8B64,
      auditPrivateKeyGeneration: 6,
    })).rejects.toThrow("audit root sequence range is invalid");
  });
});

describe("audit anchor orchestration", () => {
  it("runs sign → no-overwrite upload → one-use verify → exact completion", async () => {
    const auditKeys = await ed25519Keys();
    const gatewayKeys = await ed25519Keys();
    const built = await buildSignedAuditAnchor({
      claim: claim(),
      auditPrivateKeyPkcs8B64: auditKeys.privateKeyPkcs8B64,
      auditPrivateKeyGeneration: 6,
    });
    const documentSha256 = createHash("sha256").update(built.bytes).digest("hex");
    const uploadTicket = ticket(
      "ANCHOR",
      UPLOAD_TICKET_JTI,
      documentSha256,
      built.bytes.byteLength,
      built.document.signatureHash,
      built.auditSigningPublicKeyHash,
    );
    const verifyTicket = ticket(
      "ANCHOR_VERIFY",
      VERIFY_TICKET_JTI,
      documentSha256,
      built.bytes.byteLength,
      built.document.signatureHash,
      built.auditSigningPublicKeyHash,
    );
    const receipt = await signedGatewayReceipt(
      gatewayKeys.pair.privateKey,
      built.document.signatureHash,
    );
    const order: string[] = [];
    const runtime = {
      post: vi.fn(async (path: string, body: unknown) => {
        order.push(path);
        if (path.endsWith("upload-ticket")) {
          expect(body).toEqual({
            version: 1,
            operation: "ANCHOR",
            workItemId: WORK_ITEM_ID,
            claimGeneration: 4,
            claimToken: CLAIM_TOKEN,
            auditRootId: AUDIT_ROOT_ID,
            rootHash: ROOT_HASH,
            anchorKey: ANCHOR_KEY,
            signatureHash: built.document.signatureHash,
            auditSigningKeyGeneration: 6,
            auditSigningPublicKeyHash: built.auditSigningPublicKeyHash,
            documentSha256,
            documentByteLength: built.bytes.byteLength,
          });
          return ticketResult(uploadTicket);
        }
        if (path.endsWith("verify-ticket")) {
          expect(body).toEqual({
            version: 1,
            operation: "ANCHOR_VERIFY",
            workItemId: WORK_ITEM_ID,
            claimGeneration: 4,
            claimToken: CLAIM_TOKEN,
            auditRootId: AUDIT_ROOT_ID,
            rootHash: ROOT_HASH,
            anchorKey: ANCHOR_KEY,
            signatureHash: built.document.signatureHash,
            auditSigningKeyGeneration: 6,
            auditSigningPublicKeyHash: built.auditSigningPublicKeyHash,
            documentSha256,
            documentByteLength: built.bytes.byteLength,
          });
          return ticketResult(verifyTicket);
        }
        expect(body).toEqual({
          version: 1,
          workItemId: WORK_ITEM_ID,
          claimGeneration: 4,
          claimToken: CLAIM_TOKEN,
          verifyTicketJti: VERIFY_TICKET_JTI,
          gatewayReceipt: receipt,
        });
        return {
          version: 1,
          auditRootId: AUDIT_ROOT_ID,
          gatewayReceiptHash: "d".repeat(64),
          idempotentReplay: false,
        };
      }),
    };
    const gateway = {
      putObject: vi.fn(async (request: {
        ticketHeader: string;
        contentType: string;
        bytes: Uint8Array;
      }) => {
        order.push("gateway:PUT");
        expect(JSON.parse(Buffer.from(request.ticketHeader, "base64url").toString("utf8")))
          .toEqual(uploadTicket);
        expect(request.contentType).toBe("application/json");
        expect(request.bytes).toEqual(built.bytes);
        return { version: 1, status: "STORED", versionOrEtag: "anchor-version-1" };
      }),
      verifyObject: vi.fn(async (request: { ticketHeader: string }) => {
        order.push("gateway:VERIFY");
        expect(JSON.parse(Buffer.from(request.ticketHeader, "base64url").toString("utf8")))
          .toEqual(verifyTicket);
        return receipt;
      }),
    };

    await expect(runAuditAnchorWork({
      claim: claim(),
      runtime,
      gateway,
      auditPrivateKeyPkcs8B64: auditKeys.privateKeyPkcs8B64,
      auditPrivateKeyGeneration: 6,
      now: () => new Date(NOW_SECONDS * 1_000),
    })).resolves.toMatchObject({ auditRootId: AUDIT_ROOT_ID, idempotentReplay: false });

    expect(order).toEqual([
      "/v1/maintenance/media/upload-ticket",
      "gateway:PUT",
      "/v1/maintenance/media/verify-ticket",
      "gateway:VERIFY",
      "/v1/maintenance/work/complete",
    ]);
  });

  it("rejects a cross-claim receipt before acknowledging the root", async () => {
    const auditKeys = await ed25519Keys();
    const gatewayKeys = await ed25519Keys();
    const built = await buildSignedAuditAnchor({
      claim: claim(),
      auditPrivateKeyPkcs8B64: auditKeys.privateKeyPkcs8B64,
      auditPrivateKeyGeneration: 6,
    });
    const hash = createHash("sha256").update(built.bytes).digest("hex");
    const uploadTicket = ticket("ANCHOR", UPLOAD_TICKET_JTI, hash, built.bytes.byteLength, built.document.signatureHash, built.auditSigningPublicKeyHash);
    const verifyTicket = ticket("ANCHOR_VERIFY", VERIFY_TICKET_JTI, hash, built.bytes.byteLength, built.document.signatureHash, built.auditSigningPublicKeyHash);
    const forged = await signedGatewayReceipt(
      gatewayKeys.pair.privateKey,
      built.document.signatureHash,
      { workItemId: "dddd8000-0000-4000-8000-000000000099" },
    );
    const runtime = {
      post: vi.fn(async (path: string) => {
        if (path.endsWith("upload-ticket")) return ticketResult(uploadTicket);
        if (path.endsWith("verify-ticket")) return ticketResult(verifyTicket);
        throw new Error("completion must not run");
      }),
    };

    await expect(runAuditAnchorWork({
      claim: claim(),
      runtime,
      gateway: {
        putObject: vi.fn().mockResolvedValue({ version: 1, status: "STORED" }),
        verifyObject: vi.fn().mockResolvedValue(forged),
      },
      auditPrivateKeyPkcs8B64: auditKeys.privateKeyPkcs8B64,
      auditPrivateKeyGeneration: 6,
      now: () => new Date(NOW_SECONDS * 1_000),
    })).rejects.toThrow("audit receipt claim mismatch");

    expect(runtime.post.mock.calls.map(([path]) => path)).not.toContain(
      "/v1/maintenance/work/complete",
    );
  });

  it("rejects an audit ticket whose domain hash does not match its signed claims", async () => {
    const auditKeys = await ed25519Keys();
    const built = await buildSignedAuditAnchor({
      claim: claim(),
      auditPrivateKeyPkcs8B64: auditKeys.privateKeyPkcs8B64,
      auditPrivateKeyGeneration: 6,
    });
    const documentSha256 = createHash("sha256").update(built.bytes).digest("hex");
    const uploadTicket = ticket(
      "ANCHOR",
      UPLOAD_TICKET_JTI,
      documentSha256,
      built.bytes.byteLength,
      built.document.signatureHash,
      built.auditSigningPublicKeyHash,
    );
    const runtime = {
      post: vi.fn().mockResolvedValue({
        ...ticketResult(uploadTicket),
        ticketHash: "d".repeat(64),
      }),
    };
    const gateway = {
      putObject: vi.fn().mockRejectedValue(Object.assign(
        new Error("gateway must not run"),
        { status: 400 },
      )),
      verifyObject: vi.fn(),
    };

    await expect(runAuditAnchorWork({
      claim: claim(),
      runtime,
      gateway,
      auditPrivateKeyPkcs8B64: auditKeys.privateKeyPkcs8B64,
      auditPrivateKeyGeneration: 6,
      now: () => new Date(NOW_SECONDS * 1_000),
    })).rejects.toThrow("audit ticket hash mismatch");

    expect(gateway.putObject).not.toHaveBeenCalled();
  });

  it("rejects a receipt whose signing generation differs from its verify ticket", async () => {
    const auditKeys = await ed25519Keys();
    const gatewayKeys = await ed25519Keys();
    const built = await buildSignedAuditAnchor({
      claim: claim(),
      auditPrivateKeyPkcs8B64: auditKeys.privateKeyPkcs8B64,
      auditPrivateKeyGeneration: 6,
    });
    const hash = createHash("sha256").update(built.bytes).digest("hex");
    const mismatchedTicket = {
      ...ticket(
        "ANCHOR",
        UPLOAD_TICKET_JTI,
        hash,
        built.bytes.byteLength,
        built.document.signatureHash,
        built.auditSigningPublicKeyHash,
      ),
      receiptSigningKeyGeneration: 8,
    };
    const verifyTicket = {
      ...ticket(
        "ANCHOR_VERIFY",
        VERIFY_TICKET_JTI,
        hash,
        built.bytes.byteLength,
        built.document.signatureHash,
        built.auditSigningPublicKeyHash,
      ),
      receiptSigningKeyGeneration: 8,
    };
    const runtime = { post: vi.fn(async (path: string) => {
      if (path.endsWith("upload-ticket")) return ticketResult(mismatchedTicket);
      if (path.endsWith("verify-ticket")) return ticketResult(verifyTicket);
      throw new Error("completion must not run");
    }) };
    const gateway = {
      putObject: vi.fn().mockResolvedValue({ version: 1, status: "STORED" }),
      verifyObject: vi.fn().mockResolvedValue(await signedGatewayReceipt(
        gatewayKeys.pair.privateKey,
        built.document.signatureHash,
      )),
    };

    await expect(runAuditAnchorWork({
      claim: claim(),
      runtime,
      gateway,
      auditPrivateKeyPkcs8B64: auditKeys.privateKeyPkcs8B64,
      auditPrivateKeyGeneration: 6,
      now: () => new Date(NOW_SECONDS * 1_000),
    })).rejects.toThrow("audit receipt claim mismatch");

    expect(gateway.verifyObject).toHaveBeenCalledOnce();
  });

  it("verifies the immutable anchor after a restart sees object-already-exists", async () => {
    const auditKeys = await ed25519Keys();
    const gatewayKeys = await ed25519Keys();
    const built = await buildSignedAuditAnchor({
      claim: claim(),
      auditPrivateKeyPkcs8B64: auditKeys.privateKeyPkcs8B64,
      auditPrivateKeyGeneration: 6,
    });
    const hash = createHash("sha256").update(built.bytes).digest("hex");
    const uploadTicket = ticket(
      "ANCHOR",
      UPLOAD_TICKET_JTI,
      hash,
      built.bytes.byteLength,
      built.document.signatureHash,
      built.auditSigningPublicKeyHash,
    );
    const verifyTicket = ticket(
      "ANCHOR_VERIFY",
      VERIFY_TICKET_JTI,
      hash,
      built.bytes.byteLength,
      built.document.signatureHash,
      built.auditSigningPublicKeyHash,
    );
    const receipt = await signedGatewayReceipt(
      gatewayKeys.pair.privateKey,
      built.document.signatureHash,
    );
    const runtime = {
      post: vi.fn(async (path: string) => {
        if (path.endsWith("upload-ticket")) return ticketResult(uploadTicket);
        if (path.endsWith("verify-ticket")) return ticketResult(verifyTicket);
        return {
          version: 1,
          auditRootId: AUDIT_ROOT_ID,
          gatewayReceiptHash: "d".repeat(64),
          idempotentReplay: true,
        };
      }),
    };
    const gateway = {
      putObject: vi.fn().mockRejectedValue(Object.assign(
        new Error("immutable object already exists"),
        { status: 409 },
      )),
      verifyObject: vi.fn().mockResolvedValue(receipt),
    };

    await expect(runAuditAnchorWork({
      claim: claim(),
      runtime,
      gateway,
      auditPrivateKeyPkcs8B64: auditKeys.privateKeyPkcs8B64,
      auditPrivateKeyGeneration: 6,
      now: () => new Date(NOW_SECONDS * 1_000),
    })).resolves.toMatchObject({ idempotentReplay: true });

    expect(gateway.putObject).toHaveBeenCalledOnce();
    expect(gateway.verifyObject).toHaveBeenCalledOnce();
  });

  it("retries when an ambiguous upload was lost before write and verification returns 404", async () => {
    const auditKeys = await ed25519Keys();
    const built = await buildSignedAuditAnchor({
      claim: claim(),
      auditPrivateKeyPkcs8B64: auditKeys.privateKeyPkcs8B64,
      auditPrivateKeyGeneration: 6,
    });
    const hash = createHash("sha256").update(built.bytes).digest("hex");
    const uploadTicket = ticket(
      "ANCHOR",
      UPLOAD_TICKET_JTI,
      hash,
      built.bytes.byteLength,
      built.document.signatureHash,
      built.auditSigningPublicKeyHash,
    );
    const verifyTicket = ticket(
      "ANCHOR_VERIFY",
      VERIFY_TICKET_JTI,
      hash,
      built.bytes.byteLength,
      built.document.signatureHash,
      built.auditSigningPublicKeyHash,
    );
    const runtime = { post: vi.fn(async (path: string) => {
      if (path.endsWith("upload-ticket")) return ticketResult(uploadTicket);
      if (path.endsWith("verify-ticket")) return ticketResult(verifyTicket);
      throw new Error("completion must not run");
    }) };
    const gateway = {
      putObject: vi.fn().mockRejectedValue(new Error("upload connection closed")),
      verifyObject: vi.fn().mockRejectedValue(Object.assign(
        new Error("anchor object not found"),
        { status: 404 },
      )),
    };

    const error = await runAuditAnchorWork({
      claim: claim(),
      runtime,
      gateway,
      auditPrivateKeyPkcs8B64: auditKeys.privateKeyPkcs8B64,
      auditPrivateKeyGeneration: 6,
      now: () => new Date(NOW_SECONDS * 1_000),
    }).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(MaintenanceRetryableWorkError);
    expect(String(error)).toContain("missing after ambiguous upload");
    expect(gateway.putObject).toHaveBeenCalledOnce();
    expect(gateway.verifyObject).toHaveBeenCalledOnce();
  });

  it.each([409, 412])(
    "keeps verify 404 terminal after definitive PUT status %s",
    async (putStatus) => {
      const auditKeys = await ed25519Keys();
      const built = await buildSignedAuditAnchor({
        claim: claim(),
        auditPrivateKeyPkcs8B64: auditKeys.privateKeyPkcs8B64,
        auditPrivateKeyGeneration: 6,
      });
      const hash = createHash("sha256").update(built.bytes).digest("hex");
      const uploadTicket = ticket(
        "ANCHOR",
        UPLOAD_TICKET_JTI,
        hash,
        built.bytes.byteLength,
        built.document.signatureHash,
        built.auditSigningPublicKeyHash,
      );
      const verifyTicket = ticket(
        "ANCHOR_VERIFY",
        VERIFY_TICKET_JTI,
        hash,
        built.bytes.byteLength,
        built.document.signatureHash,
        built.auditSigningPublicKeyHash,
      );
      const runtime = { post: vi.fn(async (path: string) => {
        if (path.endsWith("upload-ticket")) return ticketResult(uploadTicket);
        if (path.endsWith("verify-ticket")) return ticketResult(verifyTicket);
        throw new Error("completion must not run");
      }) };
      const gateway = {
        putObject: vi.fn().mockRejectedValue(Object.assign(
          new Error("definitive immutable-object response"),
          { status: putStatus },
        )),
        verifyObject: vi.fn().mockRejectedValue(Object.assign(
          new Error("anchor object not found"),
          { status: 404 },
        )),
      };

      const error = await runAuditAnchorWork({
        claim: claim(),
        runtime,
        gateway,
        auditPrivateKeyPkcs8B64: auditKeys.privateKeyPkcs8B64,
        auditPrivateKeyGeneration: 6,
        now: () => new Date(NOW_SECONDS * 1_000),
      }).catch((value: unknown) => value);

      expect(error).not.toBeInstanceOf(MaintenanceRetryableWorkError);
      expect(error).toMatchObject({ status: 404 });
      expect(gateway.putObject).toHaveBeenCalledOnce();
      expect(gateway.verifyObject).toHaveBeenCalledOnce();
    },
  );

  it("rejects an already-expired fresh upload ticket before Gateway I/O", async () => {
    const auditKeys = await ed25519Keys();
    const built = await buildSignedAuditAnchor({
      claim: claim(),
      auditPrivateKeyPkcs8B64: auditKeys.privateKeyPkcs8B64,
      auditPrivateKeyGeneration: 6,
    });
    const hash = createHash("sha256").update(built.bytes).digest("hex");
    const expiredUploadTicket = {
      ...ticket(
        "ANCHOR",
        UPLOAD_TICKET_JTI,
        hash,
        built.bytes.byteLength,
        built.document.signatureHash,
        built.auditSigningPublicKeyHash,
      ),
      iat: NOW_SECONDS - 61,
      exp: NOW_SECONDS - 1,
    };
    const runtime = { post: vi.fn(async (path: string) => {
      if (path.endsWith("upload-ticket")) return ticketResult(expiredUploadTicket);
      throw new Error("verify ticket must not be requested");
    }) };
    const gateway = { putObject: vi.fn(), verifyObject: vi.fn() };

    await expect(runAuditAnchorWork({
      claim: claim(),
      runtime,
      gateway,
      auditPrivateKeyPkcs8B64: auditKeys.privateKeyPkcs8B64,
      auditPrivateKeyGeneration: 6,
      now: () => new Date(NOW_SECONDS * 1_000),
    })).rejects.toThrow(/ticket lifetime/i);

    expect(gateway.putObject).not.toHaveBeenCalled();
    expect(gateway.verifyObject).not.toHaveBeenCalled();
  });

  it("rejects an already-expired fresh verify ticket before Gateway verification", async () => {
    const auditKeys = await ed25519Keys();
    const built = await buildSignedAuditAnchor({
      claim: claim(),
      auditPrivateKeyPkcs8B64: auditKeys.privateKeyPkcs8B64,
      auditPrivateKeyGeneration: 6,
    });
    const hash = createHash("sha256").update(built.bytes).digest("hex");
    const uploadTicket = ticket(
      "ANCHOR",
      UPLOAD_TICKET_JTI,
      hash,
      built.bytes.byteLength,
      built.document.signatureHash,
      built.auditSigningPublicKeyHash,
    );
    const expiredVerifyTicket = {
      ...ticket(
        "ANCHOR_VERIFY",
        VERIFY_TICKET_JTI,
        hash,
        built.bytes.byteLength,
        built.document.signatureHash,
        built.auditSigningPublicKeyHash,
      ),
      iat: NOW_SECONDS - 61,
      exp: NOW_SECONDS - 1,
    };
    const runtime = { post: vi.fn(async (path: string) => {
      if (path.endsWith("upload-ticket")) return ticketResult(uploadTicket);
      if (path.endsWith("verify-ticket")) return ticketResult(expiredVerifyTicket);
      throw new Error("completion must not run");
    }) };
    const gateway = {
      putObject: vi.fn().mockResolvedValue({ version: 1, status: "STORED" }),
      verifyObject: vi.fn(),
    };

    await expect(runAuditAnchorWork({
      claim: claim(),
      runtime,
      gateway,
      auditPrivateKeyPkcs8B64: auditKeys.privateKeyPkcs8B64,
      auditPrivateKeyGeneration: 6,
      now: () => new Date(NOW_SECONDS * 1_000),
    })).rejects.toThrow(/ticket lifetime/i);

    expect(gateway.putObject).toHaveBeenCalledOnce();
    expect(gateway.verifyObject).not.toHaveBeenCalled();
  });

  it("retries the identical verify and completion after both responses are lost", async () => {
    const auditKeys = await ed25519Keys();
    const gatewayKeys = await ed25519Keys();
    const built = await buildSignedAuditAnchor({
      claim: claim(),
      auditPrivateKeyPkcs8B64: auditKeys.privateKeyPkcs8B64,
      auditPrivateKeyGeneration: 6,
    });
    const hash = createHash("sha256").update(built.bytes).digest("hex");
    const uploadTicket = ticket("ANCHOR", UPLOAD_TICKET_JTI, hash, built.bytes.byteLength, built.document.signatureHash, built.auditSigningPublicKeyHash);
    const verifyTicket = ticket("ANCHOR_VERIFY", VERIFY_TICKET_JTI, hash, built.bytes.byteLength, built.document.signatureHash, built.auditSigningPublicKeyHash);
    const receipt = await signedGatewayReceipt(
      gatewayKeys.pair.privateKey,
      built.document.signatureHash,
    );
    const verifyRequests: string[] = [];
    const completionBodies: string[] = [];
    let verifyLost = true;
    let completionLost = true;
    const runtime = {
      post: vi.fn(async (path: string, body: unknown) => {
        if (path.endsWith("upload-ticket")) return ticketResult(uploadTicket);
        if (path.endsWith("verify-ticket")) return ticketResult(verifyTicket);
        completionBodies.push(canonicalJson(body));
        if (completionLost) {
          completionLost = false;
          throw new Error("DB acknowledgement response lost");
        }
        return {
          version: 1,
          auditRootId: AUDIT_ROOT_ID,
          gatewayReceiptHash: "d".repeat(64),
          idempotentReplay: true,
        };
      }),
    };
    const gateway = {
      putObject: vi.fn().mockRejectedValue(
        new Error("response lost after immutable upload"),
      ),
      verifyObject: vi.fn(async (request: unknown) => {
        verifyRequests.push(canonicalJson(request));
        if (verifyLost) {
          verifyLost = false;
          throw new Error("durable receipt response lost");
        }
        return receipt;
      }),
    };

    await expect(runAuditAnchorWork({
      claim: claim(),
      runtime,
      gateway,
      auditPrivateKeyPkcs8B64: auditKeys.privateKeyPkcs8B64,
      auditPrivateKeyGeneration: 6,
      retryAttempts: 2,
      now: () => new Date(NOW_SECONDS * 1_000),
    })).resolves.toMatchObject({ idempotentReplay: true });

    expect(gateway.putObject).toHaveBeenCalledOnce();
    expect(verifyRequests).toHaveLength(2);
    expect(new Set(verifyRequests).size).toBe(1);
    expect(completionBodies).toHaveLength(2);
    expect(new Set(completionBodies).size).toBe(1);
  });

  it("resumes frozen verify lineage after restart without signing or uploading again", async () => {
    const auditKeys = await ed25519Keys();
    const gatewayKeys = await ed25519Keys();
    const built = await buildSignedAuditAnchor({
      claim: claim(),
      auditPrivateKeyPkcs8B64: auditKeys.privateKeyPkcs8B64,
      auditPrivateKeyGeneration: 6,
    });
    const hash = createHash("sha256").update(built.bytes).digest("hex");
    const verifyTicket = ticket(
      "ANCHOR_VERIFY",
      VERIFY_TICKET_JTI,
      hash,
      built.bytes.byteLength,
      built.document.signatureHash,
      built.auditSigningPublicKeyHash,
    );
    const receipt = await signedGatewayReceipt(
      gatewayKeys.pair.privateKey,
      built.document.signatureHash,
    );
    const recovery = auditRecovery(verifyTicket, null);
    const runtime = { post: vi.fn().mockResolvedValue({
      version: 1,
      auditRootId: AUDIT_ROOT_ID,
      gatewayReceiptHash: "d".repeat(64),
      idempotentReplay: false,
    }) };
    const gateway = {
      putObject: vi.fn(),
      verifyObject: vi.fn().mockResolvedValue(receipt),
    };

    await expect(runAuditAnchorWork({
      claim: recovery,
      runtime,
      gateway,
      auditPrivateKeyPkcs8B64: "not-used-during-recovery",
      auditPrivateKeyGeneration: 999,
      now: () => new Date("2026-08-01T00:00:00.000Z"),
    })).resolves.toMatchObject({ auditRootId: AUDIT_ROOT_ID, idempotentReplay: false });

    expect(gateway.putObject).not.toHaveBeenCalled();
    expect(gateway.verifyObject).toHaveBeenCalledOnce();
    expect(runtime.post).toHaveBeenCalledWith("/v1/maintenance/work/complete", {
      version: 1,
      recoveryKind: "AUDIT_VERIFY_AUTHORIZED",
      workItemId: WORK_ITEM_ID,
      recoveryGeneration: 2,
      claimToken: recovery.claimToken,
      verifyTicketJti: VERIFY_TICKET_JTI,
      gatewayReceipt: receipt,
    }, expect.any(Object));
  });

  it("rejects audit recovery before I/O when its lease cannot cover a refresh path", async () => {
    const auditKeys = await ed25519Keys();
    const built = await buildSignedAuditAnchor({
      claim: claim(),
      auditPrivateKeyPkcs8B64: auditKeys.privateKeyPkcs8B64,
      auditPrivateKeyGeneration: 6,
    });
    const hash = createHash("sha256").update(built.bytes).digest("hex");
    const recovery = {
      ...auditRecovery(ticket(
        "ANCHOR_VERIFY",
        VERIFY_TICKET_JTI,
        hash,
        built.bytes.byteLength,
        built.document.signatureHash,
        built.auditSigningPublicKeyHash,
      ), null),
      recoveryLeaseExpiresAt: new Date(NOW_SECONDS * 1_000 + 20_000).toISOString(),
    };
    const runtime = { post: vi.fn() };
    const gateway = { putObject: vi.fn(), verifyObject: vi.fn() };

    await expect(runAuditAnchorWork({
      claim: recovery,
      runtime,
      gateway,
      auditPrivateKeyPkcs8B64: "not-used-during-recovery",
      auditPrivateKeyGeneration: 999,
      now: () => new Date(NOW_SECONDS * 1_000),
      retryAttempts: 2,
      runtimeAttemptTimeoutMs: 4_000,
      gatewayAttemptTimeoutMs: 2_000,
      leaseSafetyMs: 1_000,
    })).rejects.toThrow(/lease budget/i);

    expect(runtime.post).not.toHaveBeenCalled();
    expect(gateway.verifyObject).not.toHaveBeenCalled();
  });

  it("submits a DB-authoritative stored audit receipt without calling Gateway again", async () => {
    const auditKeys = await ed25519Keys();
    const gatewayKeys = await ed25519Keys();
    const built = await buildSignedAuditAnchor({
      claim: claim(),
      auditPrivateKeyPkcs8B64: auditKeys.privateKeyPkcs8B64,
      auditPrivateKeyGeneration: 6,
    });
    const hash = createHash("sha256").update(built.bytes).digest("hex");
    const verifyTicket = ticket(
      "ANCHOR_VERIFY",
      VERIFY_TICKET_JTI,
      hash,
      built.bytes.byteLength,
      built.document.signatureHash,
      built.auditSigningPublicKeyHash,
    );
    const receipt = await signedGatewayReceipt(
      gatewayKeys.pair.privateKey,
      built.document.signatureHash,
    );
    const recovery = auditRecovery(verifyTicket, receipt);
    const runtime = { post: vi.fn().mockResolvedValue({
      version: 1,
      auditRootId: AUDIT_ROOT_ID,
      gatewayReceiptHash: "d".repeat(64),
      idempotentReplay: true,
    }) };
    const gateway = { putObject: vi.fn(), verifyObject: vi.fn() };

    await expect(runAuditAnchorWork({
      claim: recovery,
      runtime,
      gateway,
      auditPrivateKeyPkcs8B64: "not-used-during-recovery",
      auditPrivateKeyGeneration: 999,
      now: () => new Date("2026-08-01T00:00:00.000Z"),
    })).resolves.toMatchObject({ idempotentReplay: true });

    expect(gateway.putObject).not.toHaveBeenCalled();
    expect(gateway.verifyObject).not.toHaveBeenCalled();
    expect(runtime.post).toHaveBeenCalledOnce();
  });

  it("retries an expired frozen verify ticket unchanged after an ambiguous lost response", async () => {
    const auditKeys = await ed25519Keys();
    const gatewayKeys = await ed25519Keys();
    const built = await buildSignedAuditAnchor({
      claim: claim(),
      auditPrivateKeyPkcs8B64: auditKeys.privateKeyPkcs8B64,
      auditPrivateKeyGeneration: 6,
    });
    const hash = createHash("sha256").update(built.bytes).digest("hex");
    const expiredTicket = {
      ...ticket(
        "ANCHOR_VERIFY",
        VERIFY_TICKET_JTI,
        hash,
        built.bytes.byteLength,
        built.document.signatureHash,
        built.auditSigningPublicKeyHash,
      ),
      iat: NOW_SECONDS - 120,
      exp: NOW_SECONDS - 60,
    };
    const receipt = await signedGatewayReceipt(
      gatewayKeys.pair.privateKey,
      built.document.signatureHash,
    );
    const recovery = auditRecovery(expiredTicket, null);
    const requestHeaders: string[] = [];
    const gateway = {
      putObject: vi.fn(),
      verifyObject: vi.fn(async (request: { ticketHeader: string }) => {
        requestHeaders.push(request.ticketHeader);
        if (requestHeaders.length === 1) throw new Error("response lost after stored receipt");
        return receipt;
      }),
    };
    const runtime = { post: vi.fn().mockResolvedValue({
      version: 1,
      auditRootId: AUDIT_ROOT_ID,
      gatewayReceiptHash: "d".repeat(64),
      idempotentReplay: true,
    }) };

    await expect(runAuditAnchorWork({
      claim: recovery,
      runtime,
      gateway,
      auditPrivateKeyPkcs8B64: "not-used-during-recovery",
      auditPrivateKeyGeneration: 999,
      now: () => new Date(NOW_SECONDS * 1_000),
      retryAttempts: 2,
    })).resolves.toMatchObject({ idempotentReplay: true });

    expect(requestHeaders).toHaveLength(2);
    expect(new Set(requestHeaders).size).toBe(1);
    expect(runtime.post.mock.calls.map(([path]) => path)).not.toContain(
      "/v1/maintenance/media/verify-ticket",
    );
  });

  it("refreshes frozen verify lineage only after an exact expired-no-work denial", async () => {
    const auditKeys = await ed25519Keys();
    const gatewayKeys = await ed25519Keys();
    const built = await buildSignedAuditAnchor({
      claim: claim(),
      auditPrivateKeyPkcs8B64: auditKeys.privateKeyPkcs8B64,
      auditPrivateKeyGeneration: 6,
    });
    const hash = createHash("sha256").update(built.bytes).digest("hex");
    const expiredTicket = {
      ...ticket(
        "ANCHOR_VERIFY",
        VERIFY_TICKET_JTI,
        hash,
        built.bytes.byteLength,
        built.document.signatureHash,
        built.auditSigningPublicKeyHash,
      ),
      iat: NOW_SECONDS - 120,
      exp: NOW_SECONDS - 60,
    };
    const refreshedTicket = recoveryVerifyTicket(
      ticket(
        "ANCHOR_VERIFY",
        REFRESHED_VERIFY_TICKET_JTI,
        hash,
        built.bytes.byteLength,
        built.document.signatureHash,
        built.auditSigningPublicKeyHash,
      ),
      VERIFY_TICKET_JTI,
    );
    const receipt = await signedGatewayReceipt(
      gatewayKeys.pair.privateKey,
      built.document.signatureHash,
      { verifyTicketJti: REFRESHED_VERIFY_TICKET_JTI },
    );
    const recovery = auditRecovery(expiredTicket, null);
    const runtime = { post: vi.fn(async (path: string, body: unknown) => {
      if (path.endsWith("verify-ticket")) {
        expect(validateRuntimeRequestBody(path, body)).toBe(true);
        expect(body).not.toHaveProperty("gatewayDenialCode");
        expect(body).toEqual({
          version: 1,
          operation: "ANCHOR_VERIFY",
          recoveryKind: "AUDIT_VERIFY_AUTHORIZED",
          workItemId: WORK_ITEM_ID,
          recoveryGeneration: 2,
          claimToken: recovery.claimToken,
          expiredVerifyTicketJti: VERIFY_TICKET_JTI,
          gatewayDenial: {
            status: 410,
            code: "TICKET_EXPIRED_NO_WORK",
          },
          auditRootId: AUDIT_ROOT_ID,
          rootHash: ROOT_HASH,
          anchorKey: ANCHOR_KEY,
          signatureHash: built.document.signatureHash,
          auditSigningKeyGeneration: 6,
          auditSigningPublicKeyHash: built.auditSigningPublicKeyHash,
          documentSha256: hash,
          documentByteLength: built.bytes.byteLength,
        });
        return {
          ...ticketResult(refreshedTicket),
          state: "RECOVERY_REFRESHED",
          replacesVerifyTicketJti: VERIFY_TICKET_JTI,
        };
      }
      return {
        version: 1,
        auditRootId: AUDIT_ROOT_ID,
        gatewayReceiptHash: "d".repeat(64),
        idempotentReplay: false,
      };
    }) };
    const gateway = {
      putObject: vi.fn(),
      verifyObject: vi.fn()
        .mockRejectedValueOnce(Object.assign(new Error("expired with no work"), {
          status: 410,
          code: "TICKET_EXPIRED_NO_WORK",
        }))
        .mockResolvedValueOnce(receipt),
    };

    await expect(runAuditAnchorWork({
      claim: recovery,
      runtime,
      gateway,
      auditPrivateKeyPkcs8B64: "not-used-during-recovery",
      auditPrivateKeyGeneration: 999,
      now: () => new Date(NOW_SECONDS * 1_000),
      retryAttempts: 2,
    })).resolves.toMatchObject({ idempotentReplay: false });

    expect(gateway.verifyObject).toHaveBeenCalledTimes(2);
    expect(runtime.post.mock.calls.map(([path]) => path)).toEqual([
      "/v1/maintenance/media/verify-ticket",
      "/v1/maintenance/work/complete",
    ]);
  });

  it("reclaims an already-refreshed authoritative verify ticket after the refresh response is lost", async () => {
    const auditKeys = await ed25519Keys();
    const gatewayKeys = await ed25519Keys();
    const built = await buildSignedAuditAnchor({
      claim: claim(),
      auditPrivateKeyPkcs8B64: auditKeys.privateKeyPkcs8B64,
      auditPrivateKeyGeneration: 6,
    });
    const hash = createHash("sha256").update(built.bytes).digest("hex");
    const refreshedTicket = recoveryVerifyTicket(
      ticket(
        "ANCHOR_VERIFY",
        REFRESHED_VERIFY_TICKET_JTI,
        hash,
        built.bytes.byteLength,
        built.document.signatureHash,
        built.auditSigningPublicKeyHash,
      ),
      VERIFY_TICKET_JTI,
    );
    const recovery = {
      ...auditRecovery(refreshedTicket, null),
      credentialGeneration: 22,
      leaseGeneration: 23,
      fencingToken: 25,
      recoveryGeneration: 3,
    };
    const receipt = await signedGatewayReceipt(
      gatewayKeys.pair.privateKey,
      built.document.signatureHash,
      { verifyTicketJti: REFRESHED_VERIFY_TICKET_JTI },
    );
    const runtime = { post: vi.fn().mockResolvedValue({
      version: 1,
      auditRootId: AUDIT_ROOT_ID,
      gatewayReceiptHash: "d".repeat(64),
      idempotentReplay: false,
    }) };
    const gateway = {
      putObject: vi.fn(),
      verifyObject: vi.fn(async (request: { ticketHeader: string }) => {
        expect(JSON.parse(Buffer.from(request.ticketHeader, "base64url").toString("utf8")))
          .toEqual(refreshedTicket);
        return receipt;
      }),
    };

    await expect(runAuditAnchorWork({
      claim: recovery,
      runtime,
      gateway,
      auditPrivateKeyPkcs8B64: "not-used-during-recovery",
      auditPrivateKeyGeneration: 999,
      now: () => new Date(NOW_SECONDS * 1_000),
    })).resolves.toMatchObject({ idempotentReplay: false });

    expect(gateway.verifyObject).toHaveBeenCalledOnce();
    expect(runtime.post.mock.calls.map(([path]) => path)).toEqual([
      "/v1/maintenance/work/complete",
    ]);
  });

  it("rejects a frozen verify ticket whose audit SPKI drifts from the recovery payload", async () => {
    const auditKeys = await ed25519Keys();
    const built = await buildSignedAuditAnchor({
      claim: claim(),
      auditPrivateKeyPkcs8B64: auditKeys.privateKeyPkcs8B64,
      auditPrivateKeyGeneration: 6,
    });
    const hash = createHash("sha256").update(built.bytes).digest("hex");
    const recovery = auditRecovery(ticket(
      "ANCHOR_VERIFY",
      VERIFY_TICKET_JTI,
      hash,
      built.bytes.byteLength,
      built.document.signatureHash,
      "e".repeat(64),
    ), null);
    const runtime = { post: vi.fn() };
    const gateway = { putObject: vi.fn(), verifyObject: vi.fn() };

    await expect(runAuditAnchorWork({
      claim: recovery,
      runtime,
      gateway,
      auditPrivateKeyPkcs8B64: "not-used-during-recovery",
      auditPrivateKeyGeneration: 999,
      now: () => new Date(NOW_SECONDS * 1_000),
    })).rejects.toThrow(/ticket claim mismatch/i);

    expect(runtime.post).not.toHaveBeenCalled();
    expect(gateway.verifyObject).not.toHaveBeenCalled();
  });

  it.each([
    ["document hash", { sha256: "e".repeat(64) }],
    ["document length", { contentLength: 1 }],
    ["signature hash", { signatureHash: "e".repeat(64) }],
    ["audit SPKI", { auditSigningPublicKeyHash: "e".repeat(64) }],
  ])("rejects refreshed verify-ticket %s drift from frozen lineage", async (_name, drift) => {
    const auditKeys = await ed25519Keys();
    const built = await buildSignedAuditAnchor({
      claim: claim(),
      auditPrivateKeyPkcs8B64: auditKeys.privateKeyPkcs8B64,
      auditPrivateKeyGeneration: 6,
    });
    const hash = createHash("sha256").update(built.bytes).digest("hex");
    const expiredTicket = {
      ...ticket(
        "ANCHOR_VERIFY",
        VERIFY_TICKET_JTI,
        hash,
        built.bytes.byteLength,
        built.document.signatureHash,
        built.auditSigningPublicKeyHash,
      ),
      iat: NOW_SECONDS - 120,
      exp: NOW_SECONDS - 60,
    };
    const refreshedTicket = {
      ...recoveryVerifyTicket(
        ticket(
          "ANCHOR_VERIFY",
          REFRESHED_VERIFY_TICKET_JTI,
          hash,
          built.bytes.byteLength,
          built.document.signatureHash,
          built.auditSigningPublicKeyHash,
        ),
        VERIFY_TICKET_JTI,
      ),
      ...drift,
    } as ReturnType<typeof recoveryVerifyTicket>;
    const recovery = auditRecovery(expiredTicket, null);
    const runtime = { post: vi.fn().mockResolvedValue({
      ...ticketResult(refreshedTicket),
      state: "RECOVERY_REFRESHED",
      replacesVerifyTicketJti: VERIFY_TICKET_JTI,
    }) };
    const gateway = {
      putObject: vi.fn(),
      verifyObject: vi.fn().mockRejectedValue(Object.assign(new Error("expired with no work"), {
        status: 410,
        code: "TICKET_EXPIRED_NO_WORK",
      })),
    };

    await expect(runAuditAnchorWork({
      claim: recovery,
      runtime,
      gateway,
      auditPrivateKeyPkcs8B64: "not-used-during-recovery",
      auditPrivateKeyGeneration: 999,
      now: () => new Date(NOW_SECONDS * 1_000),
    })).rejects.toThrow(/ticket claim mismatch/i);

    expect(gateway.verifyObject).toHaveBeenCalledOnce();
  });

  it("rejects a refreshed verify ticket that reuses the expired JTI", async () => {
    const auditKeys = await ed25519Keys();
    const built = await buildSignedAuditAnchor({
      claim: claim(),
      auditPrivateKeyPkcs8B64: auditKeys.privateKeyPkcs8B64,
      auditPrivateKeyGeneration: 6,
    });
    const hash = createHash("sha256").update(built.bytes).digest("hex");
    const expiredTicket = {
      ...ticket(
        "ANCHOR_VERIFY",
        VERIFY_TICKET_JTI,
        hash,
        built.bytes.byteLength,
        built.document.signatureHash,
        built.auditSigningPublicKeyHash,
      ),
      iat: NOW_SECONDS - 120,
      exp: NOW_SECONDS - 60,
    };
    const reusedTicket = recoveryVerifyTicket(
      ticket(
        "ANCHOR_VERIFY",
        VERIFY_TICKET_JTI,
        hash,
        built.bytes.byteLength,
        built.document.signatureHash,
        built.auditSigningPublicKeyHash,
      ),
      VERIFY_TICKET_JTI,
    );
    const recovery = auditRecovery(expiredTicket, null);
    const runtime = { post: vi.fn().mockResolvedValue({
      ...ticketResult(reusedTicket),
      state: "RECOVERY_REFRESHED",
      replacesVerifyTicketJti: VERIFY_TICKET_JTI,
    }) };
    const gateway = {
      putObject: vi.fn(),
      verifyObject: vi.fn().mockRejectedValue(Object.assign(new Error("expired with no work"), {
        status: 410,
        code: "TICKET_EXPIRED_NO_WORK",
      })),
    };

    await expect(runAuditAnchorWork({
      claim: recovery,
      runtime,
      gateway,
      auditPrivateKeyPkcs8B64: "not-used-during-recovery",
      auditPrivateKeyGeneration: 999,
      now: () => new Date(NOW_SECONDS * 1_000),
    })).rejects.toThrow(/must rotate/i);

    expect(gateway.verifyObject).toHaveBeenCalledOnce();
  });

  it("rejects an already-expired refreshed verify ticket before retrying Gateway", async () => {
    const auditKeys = await ed25519Keys();
    const built = await buildSignedAuditAnchor({
      claim: claim(),
      auditPrivateKeyPkcs8B64: auditKeys.privateKeyPkcs8B64,
      auditPrivateKeyGeneration: 6,
    });
    const hash = createHash("sha256").update(built.bytes).digest("hex");
    const frozenExpiredTicket = {
      ...ticket(
        "ANCHOR_VERIFY",
        VERIFY_TICKET_JTI,
        hash,
        built.bytes.byteLength,
        built.document.signatureHash,
        built.auditSigningPublicKeyHash,
      ),
      iat: NOW_SECONDS - 120,
      exp: NOW_SECONDS - 60,
    };
    const refreshedExpiredTicket = {
      ...recoveryVerifyTicket(
        ticket(
          "ANCHOR_VERIFY",
          REFRESHED_VERIFY_TICKET_JTI,
          hash,
          built.bytes.byteLength,
          built.document.signatureHash,
          built.auditSigningPublicKeyHash,
        ),
        VERIFY_TICKET_JTI,
      ),
      iat: NOW_SECONDS - 61,
      exp: NOW_SECONDS - 1,
    };
    const recovery = auditRecovery(frozenExpiredTicket, null);
    const runtime = { post: vi.fn().mockResolvedValue({
      ...ticketResult(refreshedExpiredTicket),
      state: "RECOVERY_REFRESHED",
      replacesVerifyTicketJti: VERIFY_TICKET_JTI,
    }) };
    const gateway = {
      putObject: vi.fn(),
      verifyObject: vi.fn().mockRejectedValue(Object.assign(new Error("expired with no work"), {
        status: 410,
        code: "TICKET_EXPIRED_NO_WORK",
      })),
    };

    await expect(runAuditAnchorWork({
      claim: recovery,
      runtime,
      gateway,
      auditPrivateKeyPkcs8B64: "not-used-during-recovery",
      auditPrivateKeyGeneration: 999,
      now: () => new Date(NOW_SECONDS * 1_000),
    })).rejects.toThrow(/ticket lifetime/i);

    expect(gateway.verifyObject).toHaveBeenCalledOnce();
  });
});
