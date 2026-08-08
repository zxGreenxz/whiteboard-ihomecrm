// The private media gateway: it admits exactly one operation, `PUT /v1/object`,
// and only for bytes an upload ticket already committed the control plane to.
//
// The ticket is minted by `openclaw-object-tickets` and signed ES256 over the
// canonical claims. It names the object key, the exact byte length, the exact
// SHA-256 and the content type before the bytes are ever offered here, so this
// service never has to trust the uploader about what it is storing - and cannot
// be talked into storing something else under a key it was given.
//
// The receipt is signed Ed25519 and travels back through the bridge to the
// control plane, which verifies it against the public key registry. That
// registry is a control-plane secret; if it does not carry this service's
// generation, every upload is rejected there no matter what happens here.

import { createHash, webcrypto } from "node:crypto";

import { base64UrlDecode, base64UrlEncode, canonicalJson, utf8 } from "./canonical-json.js";

const RECEIPT_DOMAIN = "ihome-openclaw-media-upload-receipt-v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/;

const TICKET_FIELDS = [
  "version", "aud", "operation", "subject", "jti", "organizationId", "accountId", "objectKey",
  "sha256", "contentType", "contentLength", "sessionGeneration", "gatewayKeyGeneration", "iat", "exp",
  "cellId", "credentialGeneration", "leaseGeneration", "fencingToken", "receiptSigningKeyGeneration",
  "signature",
] as const;

// Content types are taken from the ticket, never from the request, and each one
// has to prove itself in the first bytes. `share.file` uploads arrive as
// application/octet-stream, which by definition has no signature to check.
const MAGIC_BYTES: Readonly<Record<string, readonly (readonly number[])[]>> = {
  "image/jpeg": [[0xff, 0xd8, 0xff]],
  "image/png": [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  "image/gif": [[0x47, 0x49, 0x46, 0x38]],
  "image/webp": [[0x52, 0x49, 0x46, 0x46]],
  "video/mp4": [[0x66, 0x74, 0x79, 0x70]],
  "audio/mpeg": [[0x49, 0x44, 0x33], [0xff, 0xfb], [0xff, 0xf3], [0xff, 0xf2]],
  "audio/aac": [[0xff, 0xf1], [0xff, 0xf9]],
  "audio/ogg": [[0x4f, 0x67, 0x67, 0x53]],
  "application/octet-stream": [],
};

export class UploadRejected extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "UploadRejected";
    this.status = status;
    this.code = code;
  }
}

export interface UploadTicket {
  jti: string;
  organizationId: string;
  accountId: string;
  cellId: string;
  objectKey: string;
  sha256: string;
  contentType: string;
  contentLength: number;
  sessionGeneration: number;
  credentialGeneration: number;
  leaseGeneration: number;
  fencingToken: number;
  receiptSigningKeyGeneration: number;
  expiresAt: Date;
}

function reject(code: string, message: string, status = 403): never {
  throw new UploadRejected(status, code, message);
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    reject("TICKET_INVALID", "upload ticket is not an object");
  }
  return value as Record<string, unknown>;
}

function integer(value: unknown, minimum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum;
}

function isoTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(new Date(value).valueOf()) &&
    new Date(value).toISOString() === value;
}

export function decodeTicket(header: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(base64UrlDecode(header)).toString("utf8"));
  } catch {
    reject("TICKET_INVALID", "upload ticket is not decodable");
  }
  return record(parsed);
}

/**
 * Verifies the ticket signature and every claim the object depends on. Nothing
 * about the incoming request is consulted here on purpose: a ticket that does
 * not stand on its own must not be rescued by matching request headers.
 */
export async function verifyTicket(options: {
  ticket: Record<string, unknown>;
  ticketPublicKeyEs256: webcrypto.CryptoKey;
  ticketKeyGeneration: number;
  receiptKeyGeneration: number;
  now: Date;
}): Promise<UploadTicket> {
  const ticket = options.ticket;
  if (Object.keys(ticket).sort().join(",") !== [...TICKET_FIELDS].sort().join(",")) {
    reject("TICKET_INVALID", "upload ticket fields are not exactly the ticket contract");
  }
  if (
    ticket.version !== 1 || ticket.aud !== "openclaw-media-gateway" ||
    ticket.operation !== "PUT" || ticket.subject !== "RUNTIME" ||
    typeof ticket.jti !== "string" || !UUID.test(ticket.jti) ||
    typeof ticket.organizationId !== "string" || !UUID.test(ticket.organizationId) ||
    typeof ticket.accountId !== "string" || !UUID.test(ticket.accountId) ||
    typeof ticket.cellId !== "string" || !UUID.test(ticket.cellId) ||
    typeof ticket.objectKey !== "string" || !isSafeObjectKey(ticket.objectKey) ||
    typeof ticket.sha256 !== "string" || !SHA256_HEX.test(ticket.sha256) ||
    typeof ticket.contentType !== "string" ||
    !Object.hasOwn(MAGIC_BYTES, ticket.contentType) ||
    !integer(ticket.contentLength, 1) ||
    !integer(ticket.sessionGeneration, 0) ||
    !integer(ticket.credentialGeneration, 1) ||
    !integer(ticket.leaseGeneration, 1) ||
    !integer(ticket.fencingToken, 1) ||
    !integer(ticket.gatewayKeyGeneration, 1) ||
    !integer(ticket.receiptSigningKeyGeneration, 1) ||
    !isoTimestamp(ticket.iat) || !isoTimestamp(ticket.exp) ||
    typeof ticket.signature !== "string" || !SIGNATURE.test(ticket.signature)
  ) {
    reject("TICKET_INVALID", "upload ticket claims are invalid");
  }

  if (ticket.gatewayKeyGeneration !== options.ticketKeyGeneration) {
    reject("TICKET_KEY_UNKNOWN", "upload ticket was signed by an unknown ticket key generation");
  }
  if (ticket.receiptSigningKeyGeneration !== options.receiptKeyGeneration) {
    // Signing with a generation the control plane did not ask for produces a
    // receipt it will refuse; failing here says so while the bytes can still be
    // retried, instead of after they are stored.
    reject("RECEIPT_KEY_UNKNOWN", "upload ticket asks for a receipt key this gateway does not hold");
  }

  const issuedAt = new Date(ticket.iat as string);
  const expiresAt = new Date(ticket.exp as string);
  if (expiresAt <= issuedAt) reject("TICKET_INVALID", "upload ticket expiry precedes issuance");
  if (options.now >= expiresAt) {
    // The bridge understands exactly this shape and re-requests a ticket rather
    // than losing the media.
    throw new UploadRejected(410, "TICKET_EXPIRED_NO_WORK", "upload ticket has expired");
  }

  const unsigned = { ...ticket };
  delete unsigned.signature;
  const valid = await webcrypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    options.ticketPublicKeyEs256,
    base64UrlDecode(ticket.signature as string),
    utf8(canonicalJson(unsigned)),
  );
  if (!valid) reject("TICKET_INVALID", "upload ticket signature does not verify");

  return {
    jti: ticket.jti as string,
    organizationId: ticket.organizationId as string,
    accountId: ticket.accountId as string,
    cellId: ticket.cellId as string,
    objectKey: ticket.objectKey as string,
    sha256: ticket.sha256 as string,
    contentType: ticket.contentType as string,
    contentLength: ticket.contentLength as number,
    sessionGeneration: ticket.sessionGeneration as number,
    credentialGeneration: ticket.credentialGeneration as number,
    leaseGeneration: ticket.leaseGeneration as number,
    fencingToken: ticket.fencingToken as number,
    receiptSigningKeyGeneration: ticket.receiptSigningKeyGeneration as number,
    expiresAt,
  };
}

/**
 * Object keys are used as storage paths. Anything that could climb out of the
 * tenant prefix is refused rather than normalised, and the key must carry the
 * organization it belongs to so a stored object is attributable on its own.
 */
export function isSafeObjectKey(key: string): boolean {
  if (key.length === 0 || key.length > 512) return false;
  if (!/^[A-Za-z0-9._\-/]+$/.test(key)) return false;
  if (key.startsWith("/") || key.endsWith("/") || key.includes("//")) return false;
  return !key.split("/").some((segment) => segment === "." || segment === "..");
}

export function verifyBytes(ticket: UploadTicket, bytes: Uint8Array): void {
  if (bytes.byteLength !== ticket.contentLength) {
    reject("CONTENT_LENGTH_MISMATCH", "uploaded byte count does not match the ticket", 400);
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== ticket.sha256) {
    reject("CONTENT_CHECKSUM_MISMATCH", "uploaded bytes do not match the ticket checksum", 400);
  }
  const signatures = MAGIC_BYTES[ticket.contentType] ?? [];
  if (signatures.length === 0) return;
  // mp4 carries `ftyp` at offset 4; every other signature we accept starts the file.
  const offset = ticket.contentType === "video/mp4" ? 4 : 0;
  const matches = signatures.some((signature) =>
    signature.every((byte, index) => bytes[offset + index] === byte)
  );
  if (!matches) {
    reject("CONTENT_TYPE_MISMATCH", "uploaded bytes are not the content type the ticket declared", 400);
  }
}

export async function signReceipt(options: {
  ticket: UploadTicket;
  mediaId: string;
  receiptId: string;
  objectVersionOrEtag: string;
  storedAt: Date;
  receiptSigningKey: webcrypto.CryptoKey;
}): Promise<Record<string, unknown>> {
  const receipt: Record<string, unknown> = {
    version: 1,
    receiptKind: "MEDIA_UPLOAD",
    receiptId: options.receiptId,
    organizationId: options.ticket.organizationId,
    accountId: options.ticket.accountId,
    cellId: options.ticket.cellId,
    mediaId: options.mediaId,
    objectKey: options.ticket.objectKey,
    sha256: options.ticket.sha256,
    contentType: options.ticket.contentType,
    contentLength: options.ticket.contentLength,
    uploadTicketJti: options.ticket.jti,
    credentialGeneration: options.ticket.credentialGeneration,
    leaseGeneration: options.ticket.leaseGeneration,
    fencingToken: options.ticket.fencingToken,
    sessionGeneration: options.ticket.sessionGeneration,
    objectVersionOrEtag: options.objectVersionOrEtag,
    storedAt: options.storedAt.toISOString(),
    gatewaySigningKeyGeneration: options.ticket.receiptSigningKeyGeneration,
  };
  const signature = new Uint8Array(
    await webcrypto.subtle.sign(
      "Ed25519",
      options.receiptSigningKey,
      utf8(`${RECEIPT_DOMAIN}\0${canonicalJson(receipt)}`),
    ),
  );
  return { ...receipt, signature: base64UrlEncode(signature) };
}

/**
 * `.../media/<mediaId>/...` is the shape the bridge asserts on the ticket, so the
 * media id is read back out of the key rather than taken from the request.
 */
export function mediaIdFromObjectKey(objectKey: string): string {
  const segments = objectKey.split("/");
  const index = segments.lastIndexOf("media");
  const mediaId = index >= 0 ? segments[index + 1] : undefined;
  if (mediaId === undefined || !UUID.test(mediaId)) {
    reject("TICKET_INVALID", "upload ticket object key does not name a media id");
  }
  return mediaId;
}
