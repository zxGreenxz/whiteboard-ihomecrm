import { createHash, webcrypto } from "node:crypto";

import { describe, expect, it } from "vitest";

import { base64UrlDecode, base64UrlEncode, canonicalJson, utf8 } from "../src/canonical-json.js";
import {
  decodeTicket,
  isSafeObjectKey,
  mediaIdFromObjectKey,
  signReceipt,
  UploadRejected,
  verifyBytes,
  verifyTicket,
} from "../src/upload.js";

const ORGANIZATION = "aaaa0000-0000-4000-8000-000000000001";
const ACCOUNT = "aaaa1000-0000-4000-8000-000000000001";
const CELL = "dddd2000-0000-4000-8000-000000000001";
const MEDIA = "cccc3000-0000-4000-8000-000000000001";
const TICKET_ID = "eeee4000-0000-4000-8000-000000000001";
const RECEIPT_ID = "ffff5000-0000-4000-8000-000000000001";
const OBJECT_KEY = `org/${ORGANIZATION}/account/${ACCOUNT}/media/${MEDIA}/original`;

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

async function ticketKeyPair() {
  return await webcrypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign", "verify"],
  ) as webcrypto.CryptoKeyPair;
}

async function receiptKeyPair() {
  return await webcrypto.subtle.generateKey("Ed25519", false, ["sign", "verify"]) as webcrypto.CryptoKeyPair;
}

/** Mints a ticket exactly the way `openclaw-object-tickets` does. */
async function mintTicket(options: {
  privateKey: webcrypto.CryptoKey;
  bytes?: Uint8Array;
  overrides?: Record<string, unknown>;
}) {
  const bytes = options.bytes ?? PNG;
  const claims: Record<string, unknown> = {
    version: 1,
    aud: "openclaw-media-gateway",
    operation: "PUT",
    subject: "RUNTIME",
    jti: TICKET_ID,
    organizationId: ORGANIZATION,
    accountId: ACCOUNT,
    cellId: CELL,
    objectKey: OBJECT_KEY,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    contentType: "image/png",
    contentLength: bytes.byteLength,
    sessionGeneration: 1,
    credentialGeneration: 1,
    leaseGeneration: 1,
    fencingToken: 1,
    gatewayKeyGeneration: 1,
    receiptSigningKeyGeneration: 1,
    iat: "2026-08-08T13:00:00.000Z",
    exp: "2026-08-08T13:05:00.000Z",
    ...options.overrides,
  };
  const signature = base64UrlEncode(
    new Uint8Array(
      await webcrypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        options.privateKey,
        utf8(canonicalJson(claims)),
      ),
    ),
  );
  return { ...claims, signature };
}

const now = new Date("2026-08-08T13:01:00.000Z");

async function verify(ticket: Record<string, unknown>, publicKey: webcrypto.CryptoKey, at = now) {
  return await verifyTicket({
    ticket,
    ticketPublicKeyEs256: publicKey,
    ticketKeyGeneration: 1,
    receiptKeyGeneration: 1,
    now: at,
  });
}

async function rejection(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    if (error instanceof UploadRejected) return error;
    throw error;
  }
  throw new Error("expected the upload to be rejected");
}

describe("private media gateway upload", () => {
  it("admits bytes the control plane already committed to, and signs a receipt it can verify", async () => {
    const ticketKeys = await ticketKeyPair();
    const receiptKeys = await receiptKeyPair();
    const ticket = await verify(await mintTicket({ privateKey: ticketKeys.privateKey }), ticketKeys.publicKey);

    expect(ticket.objectKey).toBe(OBJECT_KEY);
    expect(mediaIdFromObjectKey(ticket.objectKey)).toBe(MEDIA);
    verifyBytes(ticket, PNG);

    const receipt = await signReceipt({
      ticket,
      mediaId: MEDIA,
      receiptId: RECEIPT_ID,
      objectVersionOrEtag: "v1",
      storedAt: new Date("2026-08-08T13:01:30.000Z"),
      receiptSigningKey: receiptKeys.privateKey,
    });

    expect(Object.keys(receipt).sort()).toEqual([
      "accountId", "cellId", "contentLength", "contentType", "credentialGeneration",
      "fencingToken", "gatewaySigningKeyGeneration", "leaseGeneration", "mediaId", "objectKey",
      "objectVersionOrEtag", "organizationId", "receiptId", "receiptKind", "sessionGeneration",
      "sha256", "signature", "storedAt", "uploadTicketJti", "version",
    ]);
    expect(receipt.receiptKind).toBe("MEDIA_UPLOAD");
    expect(receipt.uploadTicketJti).toBe(TICKET_ID);
    expect(receipt.gatewaySigningKeyGeneration).toBe(1);
    expect(receipt.signature).toMatch(/^[A-Za-z0-9_-]{86}$/);

    // Verified the way the control plane verifies it: Ed25519 over the domain,
    // a NUL, and the canonical receipt with the signature removed.
    const unsigned = { ...receipt };
    delete unsigned.signature;
    const valid = await webcrypto.subtle.verify(
      "Ed25519",
      receiptKeys.publicKey,
      base64UrlDecode(receipt.signature as string),
      utf8(`ihome-openclaw-media-upload-receipt-v1\0${canonicalJson(unsigned)}`),
    );
    expect(valid).toBe(true);
  });

  it("refuses bytes that are not the bytes the ticket named", async () => {
    const keys = await ticketKeyPair();
    const ticket = await verify(await mintTicket({ privateKey: keys.privateKey }), keys.publicKey);

    const tampered = new Uint8Array(PNG);
    tampered[9] = 0x01;
    expect((await rejection(async () => verifyBytes(ticket, tampered))).code)
      .toBe("CONTENT_CHECKSUM_MISMATCH");

    expect((await rejection(async () => verifyBytes(ticket, PNG.slice(0, 8)))).code)
      .toBe("CONTENT_LENGTH_MISMATCH");
  });

  it("does not take the uploader's word for the content type", async () => {
    const keys = await ticketKeyPair();
    // A ticket honestly issued for a PNG, offered bytes that are not a PNG.
    const notPng = new Uint8Array(16).fill(0x41);
    const ticket = await verify(
      await mintTicket({
        privateKey: keys.privateKey,
        bytes: notPng,
        overrides: {
          sha256: createHash("sha256").update(notPng).digest("hex"),
          contentLength: notPng.byteLength,
        },
      }),
      keys.publicKey,
    );
    expect((await rejection(async () => verifyBytes(ticket, notPng))).code)
      .toBe("CONTENT_TYPE_MISMATCH");
  });

  it("rejects a ticket that was not signed by the ticket key", async () => {
    const honest = await ticketKeyPair();
    const forger = await ticketKeyPair();
    const ticket = await mintTicket({ privateKey: forger.privateKey });
    expect((await rejection(async () => verify(ticket, honest.publicKey))).code).toBe("TICKET_INVALID");
  });

  it("rejects a ticket whose claims were edited after signing", async () => {
    const keys = await ticketKeyPair();
    const ticket = await mintTicket({ privateKey: keys.privateKey });
    const edited = { ...ticket, objectKey: `org/${ORGANIZATION}/account/${ACCOUNT}/media/${MEDIA}/stolen` };
    expect((await rejection(async () => verify(edited, keys.publicKey))).code).toBe("TICKET_INVALID");
  });

  it("tells the bridge an expired ticket is expired, so the media is re-ticketed rather than lost", async () => {
    const keys = await ticketKeyPair();
    const ticket = await mintTicket({ privateKey: keys.privateKey });
    const error = await rejection(async () =>
      verify(ticket, keys.publicKey, new Date("2026-08-08T13:06:00.000Z"))
    );
    expect(error.status).toBe(410);
    expect(error.code).toBe("TICKET_EXPIRED_NO_WORK");
  });

  it("refuses before storing when the receipt generation asked for is one it cannot sign", async () => {
    const keys = await ticketKeyPair();
    const ticket = await mintTicket({
      privateKey: keys.privateKey,
      overrides: { receiptSigningKeyGeneration: 2 },
    });
    expect((await rejection(async () => verify(ticket, keys.publicKey))).code).toBe("RECEIPT_KEY_UNKNOWN");
  });

  it("refuses object keys that could leave the tenant prefix", () => {
    expect(isSafeObjectKey(OBJECT_KEY)).toBe(true);
    for (const key of ["../escape", "org//media", "/leading", "trailing/", "org/../root", "a b", ""]) {
      expect(isSafeObjectKey(key)).toBe(false);
    }
  });

  it("decodes only a well-formed ticket header", async () => {
    const keys = await ticketKeyPair();
    const ticket = await mintTicket({ privateKey: keys.privateKey });
    const header = Buffer.from(canonicalJson(ticket), "utf8").toString("base64url");
    expect(decodeTicket(header)).toEqual(ticket);
    expect((await rejection(async () => decodeTicket("bm90LWpzb24"))).code).toBe("TICKET_INVALID");
  });

  it("canonicalises the way the control plane does", () => {
    expect(canonicalJson({ b: 1, a: [true, null, "x"], "": 0 })).toBe(
      `{"":0,"a":[true,null,"x"],"b":1}`,
    );
  });
});
