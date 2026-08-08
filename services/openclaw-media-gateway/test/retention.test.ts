import { webcrypto } from "node:crypto";

import { describe, expect, it } from "vitest";

import { base64UrlEncode, canonicalJson, utf8 } from "../src/canonical-json.js";
import {
  signDeleteReceipt,
  verifyDeleteAuthorization,
  verifyDeleteTicket,
} from "../src/retention.js";
import { UploadRejected } from "../src/upload.js";

const ORGANIZATION = "aaaa0000-0000-4000-8000-000000000001";
const ACCOUNT = "aaaa1000-0000-4000-8000-000000000001";
const PRINCIPAL = "bbbb1000-0000-4000-8000-000000000001";
const WORK_ITEM = "bbbb2000-0000-4000-8000-000000000001";
const MEDIA = "cccc3000-0000-4000-8000-000000000001";
const TICKET_ID = "eeee4000-0000-4000-8000-000000000001";
const AUTHORIZATION_ID = "eeee5000-0000-4000-8000-000000000001";
const OBJECT_KEY = `org/${ORGANIZATION}/account/${ACCOUNT}/media/${MEDIA}/original`;

const now = new Date("2026-08-08T13:00:00.000Z");

async function keys() {
  return await webcrypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign", "verify"],
  ) as webcrypto.CryptoKeyPair;
}

async function sign(claims: Record<string, unknown>, privateKey: webcrypto.CryptoKey) {
  const signature = base64UrlEncode(new Uint8Array(await webcrypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    utf8(canonicalJson(claims)),
  )));
  return { ...claims, signature };
}

async function deleteTicket(privateKey: webcrypto.CryptoKey, overrides: Record<string, unknown> = {}) {
  return await sign({
    version: 1,
    aud: "openclaw-media-gateway",
    operation: "DELETE",
    subject: "MAINTENANCE",
    jti: TICKET_ID,
    organizationId: ORGANIZATION,
    accountId: ACCOUNT,
    objectKey: OBJECT_KEY,
    sha256: "a".repeat(64),
    contentType: "image/png",
    contentLength: 12,
    sessionGeneration: 1,
    gatewayKeyGeneration: 2,
    receiptSigningKeyGeneration: 1,
    iat: "2026-08-08T12:59:00.000Z",
    exp: "2026-08-08T13:05:00.000Z",
    maintenancePrincipalId: PRINCIPAL,
    workItemId: WORK_ITEM,
    claimGeneration: 3,
    credentialGeneration: 1,
    leaseGeneration: 1,
    fencingToken: 1,
    deletePhase: "FINAL_DELETE",
    holdVersion: 0,
    quarantineVersion: 0,
    finalDeleteNotBefore: "2026-08-08T12:00:00.000Z",
    ...overrides,
  }, privateKey);
}

async function authorization(privateKey: webcrypto.CryptoKey, overrides: Record<string, unknown> = {}) {
  return await sign({
    version: 1,
    authorizationKind: "RETENTION_FINAL_DELETE",
    organizationId: ORGANIZATION,
    maintenancePrincipalId: PRINCIPAL,
    workItemId: WORK_ITEM,
    claimGeneration: 3,
    credentialGeneration: 1,
    leaseGeneration: 1,
    fencingToken: 1,
    objectKey: OBJECT_KEY,
    deletePhase: "FINAL_DELETE",
    holdVersion: 0,
    quarantineVersion: 0,
    deleteTicketJti: TICKET_ID,
    authorizationJti: AUTHORIZATION_ID,
    iat: "2026-08-08T12:59:30.000Z",
    exp: "2026-08-08T13:04:00.000Z",
    gatewaySigningKeyGeneration: 1,
    ...overrides,
  }, privateKey);
}

const verifyTicket = (ticket: Record<string, unknown>, publicKey: webcrypto.CryptoKey, at = now) =>
  verifyDeleteTicket({
    ticket,
    ticketPublicKeyEs256: publicKey,
    ticketKeyGeneration: 2,
    receiptKeyGeneration: 1,
    now: at,
  });

async function rejection(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    if (error instanceof UploadRejected) return error;
    throw error;
  }
  throw new Error("expected the delete to be rejected");
}

describe("retention delete", () => {
  it("accepts a ticket and an authorization that name each other", async () => {
    const pair = await keys();
    const ticket = await verifyTicket(await deleteTicket(pair.privateKey), pair.publicKey);
    const jti = await verifyDeleteAuthorization({
      authorization: await authorization(pair.privateKey),
      ticket,
      ticketPublicKeyEs256: pair.publicKey,
      now,
    });
    expect(jti).toBe(AUTHORIZATION_ID);
    expect(ticket.objectKey).toBe(OBJECT_KEY);
  });

  it("will not delete on a ticket alone when the authorization belongs to another ticket", async () => {
    const pair = await keys();
    const ticket = await verifyTicket(await deleteTicket(pair.privateKey), pair.publicKey);
    const error = await rejection(async () =>
      await verifyDeleteAuthorization({
        authorization: await authorization(pair.privateKey, {
          deleteTicketJti: "eeee9999-0000-4000-8000-000000000001",
        }),
        ticket,
        ticketPublicKeyEs256: pair.publicKey,
        now,
      })
    );
    expect(error.code).toBe("AUTHORIZATION_MISMATCH");
  });

  it("refuses an authorization that names a different object than the ticket", async () => {
    const pair = await keys();
    const ticket = await verifyTicket(await deleteTicket(pair.privateKey), pair.publicKey);
    const error = await rejection(async () =>
      await verifyDeleteAuthorization({
        authorization: await authorization(pair.privateKey, {
          objectKey: `org/${ORGANIZATION}/account/${ACCOUNT}/media/${MEDIA}/other`,
        }),
        ticket,
        ticketPublicKeyEs256: pair.publicKey,
        now,
      })
    );
    expect(error.code).toBe("AUTHORIZATION_MISMATCH");
  });

  it("refuses to delete before the retention grace period has elapsed", async () => {
    const pair = await keys();
    const error = await rejection(async () =>
      await verifyTicket(
        await deleteTicket(pair.privateKey, { finalDeleteNotBefore: "2026-08-08T14:00:00.000Z" }),
        pair.publicKey,
      )
    );
    expect(error.code).toBe("RETENTION_GRACE_NOT_ELAPSED");
  });

  it("refuses a delete ticket signed by another key", async () => {
    const honest = await keys();
    const forger = await keys();
    const error = await rejection(async () =>
      await verifyTicket(await deleteTicket(forger.privateKey), honest.publicKey)
    );
    expect(error.code).toBe("TICKET_INVALID");
  });

  it("refuses an upload ticket presented as a delete ticket", async () => {
    const pair = await keys();
    const error = await rejection(async () =>
      await verifyTicket(await deleteTicket(pair.privateKey, { operation: "PUT" }), pair.publicKey)
    );
    expect(error.code).toBe("TICKET_INVALID");
  });

  it("signs a receipt the control plane can verify, and reports a missing object as complete", async () => {
    const pair = await keys();
    const receiptKeys = await webcrypto.subtle.generateKey("Ed25519", false, ["sign", "verify"]) as webcrypto.CryptoKeyPair;
    const ticket = await verifyTicket(await deleteTicket(pair.privateKey), pair.publicKey);
    const receipt = await signDeleteReceipt({
      ticket,
      authorizationJti: AUTHORIZATION_ID,
      objectStatus: "NOT_FOUND",
      objectVersionOrEtag: null,
      completedAt: now,
      receiptSigningKey: receiptKeys.privateKey,
      receiptId: "ffff5000-0000-4000-8000-000000000001",
    });

    expect(receipt.receiptKind).toBe("RETENTION_FINAL_DELETE");
    expect(receipt.objectStatus).toBe("NOT_FOUND");
    expect(receipt.r2VersionOrEtag).toBeNull();
    expect(receipt.deleteTicketJti).toBe(TICKET_ID);
    expect(receipt.deleteAuthorizationJti).toBe(AUTHORIZATION_ID);

    const unsigned = { ...receipt };
    delete unsigned.signature;
    expect(await webcrypto.subtle.verify(
      "Ed25519",
      receiptKeys.publicKey,
      Buffer.from(receipt.signature as string, "base64url"),
      utf8(`ihome-openclaw-retention-receipt-v1\0${canonicalJson(unsigned)}`),
    )).toBe(true);
  });
});
