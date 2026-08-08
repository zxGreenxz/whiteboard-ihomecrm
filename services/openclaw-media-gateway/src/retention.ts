// Retention delete. The gateway never decides that an object has aged out: the
// control plane does, and it says so twice - once as a delete ticket and once as
// a separate authorization that names the ticket it belongs to. Both are ES256
// signed, both have to agree about the object, and only then are the bytes gone.
//
// Two signatures rather than one is the point. A ticket alone would let a
// replayed or mis-scoped request destroy data; the authorization is issued after
// the grace period is checked and is bound to that exact ticket's jti, so
// neither half is useful on its own.

import { randomUUID, webcrypto } from "node:crypto";

import { base64UrlDecode, base64UrlEncode, canonicalJson, utf8 } from "./canonical-json.js";
import { isSafeObjectKey, UploadRejected } from "./upload.js";

const RECEIPT_DOMAIN = "ihome-openclaw-retention-receipt-v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/;

const TICKET_FIELDS = [
  "version", "aud", "operation", "subject", "jti", "organizationId", "accountId",
  "objectKey", "sha256", "contentType", "contentLength", "sessionGeneration",
  "gatewayKeyGeneration", "receiptSigningKeyGeneration", "iat", "exp",
  "maintenancePrincipalId", "workItemId",
  "claimGeneration", "credentialGeneration", "leaseGeneration", "fencingToken",
  "deletePhase", "holdVersion", "quarantineVersion", "finalDeleteNotBefore", "signature",
] as const;

const RECOVERY_TICKET_FIELDS = [
  "version", "aud", "operation", "subject", "jti", "organizationId", "accountId",
  "objectKey", "sha256", "contentType", "contentLength", "sessionGeneration",
  "gatewayKeyGeneration", "receiptSigningKeyGeneration", "iat", "exp",
  "maintenancePrincipalId", "workItemId", "credentialGeneration", "leaseGeneration",
  "fencingToken", "recoveryKind", "recoveryGeneration", "replacesTicketJti",
  "replacesDeleteAuthorizationJti", "frozenClaim", "deletePhase", "holdVersion",
  "quarantineVersion", "finalDeleteNotBefore", "signature",
] as const;

const AUTHORIZATION_FIELDS = [
  "version", "authorizationKind", "organizationId", "maintenancePrincipalId", "workItemId",
  "claimGeneration", "credentialGeneration", "leaseGeneration", "fencingToken", "objectKey",
  "deletePhase", "holdVersion", "quarantineVersion", "deleteTicketJti", "authorizationJti",
  "iat", "exp", "gatewaySigningKeyGeneration", "signature",
] as const;

const RECOVERY_AUTHORIZATION_FIELDS = [
  "version", "authorizationKind", "organizationId", "maintenancePrincipalId", "workItemId",
  "credentialGeneration", "leaseGeneration", "fencingToken", "recoveryKind",
  "recoveryGeneration", "replacesTicketJti", "replacesDeleteAuthorizationJti", "frozenClaim",
  "objectKey", "deletePhase", "holdVersion", "quarantineVersion", "deleteTicketJti",
  "authorizationJti", "iat", "exp", "gatewaySigningKeyGeneration", "signature",
] as const;

export interface DeleteTicket {
  jti: string;
  organizationId: string;
  maintenancePrincipalId: string;
  workItemId: string;
  claimGeneration: number | null;
  credentialGeneration: number;
  leaseGeneration: number;
  fencingToken: number;
  objectKey: string;
  holdVersion: number;
  quarantineVersion: number;
  receiptSigningKeyGeneration: number;
}

function reject(code: string, message: string, status = 403): never {
  throw new UploadRejected(status, code, message);
}

function fieldsMatch(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...fields].sort().join(",");
}

function integer(value: unknown, minimum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum;
}

function isoTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(new Date(value).valueOf()) &&
    new Date(value).toISOString() === value;
}

async function verifySignature(
  claims: Record<string, unknown>,
  publicKey: webcrypto.CryptoKey,
): Promise<boolean> {
  const unsigned = { ...claims };
  delete unsigned.signature;
  return await webcrypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    base64UrlDecode(claims.signature as string),
    utf8(canonicalJson(unsigned)),
  );
}

export async function verifyDeleteTicket(options: {
  ticket: Record<string, unknown>;
  ticketPublicKeyEs256: webcrypto.CryptoKey;
  ticketKeyGeneration: number;
  receiptKeyGeneration: number;
  now: Date;
}): Promise<DeleteTicket> {
  const ticket = options.ticket;
  const recovery = fieldsMatch(ticket, RECOVERY_TICKET_FIELDS);
  if (!recovery && !fieldsMatch(ticket, TICKET_FIELDS)) {
    reject("TICKET_INVALID", "delete ticket fields are not exactly the ticket contract");
  }
  if (
    ticket.version !== 1 || ticket.aud !== "openclaw-media-gateway" ||
    ticket.operation !== "DELETE" || ticket.subject !== "MAINTENANCE" ||
    ticket.deletePhase !== "FINAL_DELETE" ||
    typeof ticket.jti !== "string" || !UUID.test(ticket.jti) ||
    typeof ticket.organizationId !== "string" || !UUID.test(ticket.organizationId) ||
    typeof ticket.maintenancePrincipalId !== "string" || !UUID.test(ticket.maintenancePrincipalId) ||
    typeof ticket.workItemId !== "string" || !UUID.test(ticket.workItemId) ||
    typeof ticket.objectKey !== "string" || !isSafeObjectKey(ticket.objectKey) ||
    !integer(ticket.credentialGeneration, 1) || !integer(ticket.leaseGeneration, 1) ||
    !integer(ticket.fencingToken, 1) || !integer(ticket.holdVersion, 0) ||
    !integer(ticket.quarantineVersion, 0) ||
    !integer(ticket.gatewayKeyGeneration, 1) || !integer(ticket.receiptSigningKeyGeneration, 1) ||
    !isoTimestamp(ticket.iat) || !isoTimestamp(ticket.exp) ||
    !isoTimestamp(ticket.finalDeleteNotBefore) ||
    (!recovery && !integer(ticket.claimGeneration, 1)) ||
    typeof ticket.signature !== "string" || !SIGNATURE.test(ticket.signature)
  ) {
    reject("TICKET_INVALID", "delete ticket claims are invalid");
  }
  if (ticket.gatewayKeyGeneration !== options.ticketKeyGeneration) {
    reject("TICKET_KEY_UNKNOWN", "delete ticket was signed by an unknown ticket key generation");
  }
  if (ticket.receiptSigningKeyGeneration !== options.receiptKeyGeneration) {
    reject("RECEIPT_KEY_UNKNOWN", "delete ticket asks for a receipt key this gateway does not hold");
  }
  if (options.now >= new Date(ticket.exp as string)) {
    reject("TICKET_EXPIRED", "delete ticket has expired", 410);
  }
  // The grace period is the whole point of retention: deleting before it elapses
  // destroys data the control plane still considers live.
  if (options.now < new Date(ticket.finalDeleteNotBefore as string)) {
    reject("RETENTION_GRACE_NOT_ELAPSED", "the retention grace period has not elapsed");
  }
  if (!await verifySignature(ticket, options.ticketPublicKeyEs256)) {
    reject("TICKET_INVALID", "delete ticket signature does not verify");
  }
  return {
    jti: ticket.jti as string,
    organizationId: ticket.organizationId as string,
    maintenancePrincipalId: ticket.maintenancePrincipalId as string,
    workItemId: ticket.workItemId as string,
    claimGeneration: recovery ? null : ticket.claimGeneration as number,
    credentialGeneration: ticket.credentialGeneration as number,
    leaseGeneration: ticket.leaseGeneration as number,
    fencingToken: ticket.fencingToken as number,
    objectKey: ticket.objectKey as string,
    holdVersion: ticket.holdVersion as number,
    quarantineVersion: ticket.quarantineVersion as number,
    receiptSigningKeyGeneration: ticket.receiptSigningKeyGeneration as number,
  };
}

export async function verifyDeleteAuthorization(options: {
  authorization: Record<string, unknown>;
  ticket: DeleteTicket;
  ticketPublicKeyEs256: webcrypto.CryptoKey;
  now: Date;
}): Promise<string> {
  const proof = options.authorization;
  const recovery = fieldsMatch(proof, RECOVERY_AUTHORIZATION_FIELDS);
  if (!recovery && !fieldsMatch(proof, AUTHORIZATION_FIELDS)) {
    reject("AUTHORIZATION_INVALID", "delete authorization fields are not exactly the contract");
  }
  if (
    proof.version !== 1 || proof.authorizationKind !== "RETENTION_FINAL_DELETE" ||
    proof.deletePhase !== "FINAL_DELETE" ||
    typeof proof.authorizationJti !== "string" || !UUID.test(proof.authorizationJti) ||
    !isoTimestamp(proof.iat) || !isoTimestamp(proof.exp) ||
    typeof proof.signature !== "string" || !SIGNATURE.test(proof.signature)
  ) {
    reject("AUTHORIZATION_INVALID", "delete authorization claims are invalid");
  }
  // Each half is worthless alone: the authorization has to name this ticket and
  // agree about the object, the tenant and the versions being deleted.
  if (
    proof.deleteTicketJti !== options.ticket.jti ||
    proof.organizationId !== options.ticket.organizationId ||
    proof.maintenancePrincipalId !== options.ticket.maintenancePrincipalId ||
    proof.workItemId !== options.ticket.workItemId ||
    proof.objectKey !== options.ticket.objectKey ||
    proof.holdVersion !== options.ticket.holdVersion ||
    proof.quarantineVersion !== options.ticket.quarantineVersion ||
    proof.credentialGeneration !== options.ticket.credentialGeneration ||
    proof.leaseGeneration !== options.ticket.leaseGeneration ||
    proof.fencingToken !== options.ticket.fencingToken ||
    proof.gatewaySigningKeyGeneration !== options.ticket.receiptSigningKeyGeneration ||
    (!recovery && proof.claimGeneration !== options.ticket.claimGeneration)
  ) {
    reject("AUTHORIZATION_MISMATCH", "delete authorization is not bound to this delete ticket");
  }
  if (options.now >= new Date(proof.exp as string)) {
    reject("AUTHORIZATION_EXPIRED", "delete authorization has expired", 410);
  }
  if (!await verifySignature(proof, options.ticketPublicKeyEs256)) {
    reject("AUTHORIZATION_INVALID", "delete authorization signature does not verify");
  }
  return proof.authorizationJti;
}

export async function signDeleteReceipt(options: {
  ticket: DeleteTicket;
  authorizationJti: string;
  objectStatus: "DELETED" | "NOT_FOUND";
  objectVersionOrEtag: string | null;
  completedAt: Date;
  receiptSigningKey: webcrypto.CryptoKey;
  receiptId?: string;
}): Promise<Record<string, unknown>> {
  const receipt: Record<string, unknown> = {
    version: 1,
    receiptKind: "RETENTION_FINAL_DELETE",
    receiptId: options.receiptId ?? randomUUID(),
    organizationId: options.ticket.organizationId,
    maintenancePrincipalId: options.ticket.maintenancePrincipalId,
    workItemId: options.ticket.workItemId,
    claimGeneration: options.ticket.claimGeneration,
    credentialGeneration: options.ticket.credentialGeneration,
    leaseGeneration: options.ticket.leaseGeneration,
    fencingToken: options.ticket.fencingToken,
    objectKey: options.ticket.objectKey,
    deletePhase: "FINAL_DELETE",
    holdVersion: options.ticket.holdVersion,
    quarantineVersion: options.ticket.quarantineVersion,
    deleteTicketJti: options.ticket.jti,
    deleteAuthorizationJti: options.authorizationJti,
    // The proof identifies this delete act itself; the runner records it so a
    // repeated delete is recognisable rather than looking like a second one.
    proofJti: randomUUID(),
    objectStatus: options.objectStatus,
    r2VersionOrEtag: options.objectVersionOrEtag,
    completedAt: options.completedAt.toISOString(),
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
