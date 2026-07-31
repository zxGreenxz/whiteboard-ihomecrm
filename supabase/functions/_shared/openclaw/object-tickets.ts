import {
  base64UrlEncode,
  canonicalJson,
  signEs256,
  utf8,
  verifyEs256,
} from "./crypto.ts";
import { OpenClawHttpError } from "./errors.ts";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/;
const MAX_TTL_SECONDS = 60;

export interface ObjectTicketClaims {
  version: 1;
  aud: "openclaw-media-gateway";
  operation: "PUT" | "GET" | "DELETE" | "ANCHOR" | "ANCHOR_VERIFY";
  jti: string;
  organizationId: string;
  accountId: string;
  cellId: string;
  fencingToken: number;
  sessionGeneration: number;
  objectKey: string;
  sha256: string;
  contentType: string;
  contentLength: number;
  gatewayKeyGeneration: number;
  iat: number;
  exp: number;
}

export type SignedObjectTicket = ObjectTicketClaims & { signature: string };

const CLAIM_KEYS = [
  "version",
  "aud",
  "operation",
  "jti",
  "organizationId",
  "accountId",
  "cellId",
  "fencingToken",
  "sessionGeneration",
  "objectKey",
  "sha256",
  "contentType",
  "contentLength",
  "gatewayKeyGeneration",
  "iat",
  "exp",
] as const;

function ticketError(code: string, message: string): OpenClawHttpError {
  return new OpenClawHttpError(403, code, message);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const target = [...expected].sort();
  return keys.length === target.length && keys.every((key, index) => key === target[index]);
}

function assertClaims(value: unknown): asserts value is ObjectTicketClaims {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw ticketError("TICKET_STRICT_INVALID", "Ticket claims are not strict.");
  }
  const claims = value as Record<string, unknown>;
  if (!exactKeys(claims, CLAIM_KEYS)) {
    throw ticketError("TICKET_STRICT_INVALID", "Ticket claims are not strict.");
  }
  if (
    claims.version !== 1 ||
    claims.aud !== "openclaw-media-gateway" ||
    typeof claims.operation !== "string" ||
    !["PUT", "GET", "DELETE", "ANCHOR", "ANCHOR_VERIFY"].includes(claims.operation) ||
    typeof claims.jti !== "string" || !UUID_PATTERN.test(claims.jti) ||
    typeof claims.organizationId !== "string" || !UUID_PATTERN.test(claims.organizationId) ||
    typeof claims.accountId !== "string" || !UUID_PATTERN.test(claims.accountId) ||
    typeof claims.cellId !== "string" || !UUID_PATTERN.test(claims.cellId) ||
    !Number.isSafeInteger(claims.fencingToken) || Number(claims.fencingToken) < 1 ||
    !Number.isSafeInteger(claims.sessionGeneration) || Number(claims.sessionGeneration) < 0 ||
    typeof claims.objectKey !== "string" || claims.objectKey.length > 1024 ||
    claims.objectKey.includes("..") || claims.objectKey.includes("//") ||
    !claims.objectKey.startsWith(`v1/org/${claims.organizationId}/account/${claims.accountId}/`) ||
    typeof claims.sha256 !== "string" || !SHA256_PATTERN.test(claims.sha256) ||
    typeof claims.contentType !== "string" || claims.contentType.length < 3 || claims.contentType.length > 255 ||
    !Number.isSafeInteger(claims.contentLength) || Number(claims.contentLength) < 1 || Number(claims.contentLength) > 52_428_800 ||
    !Number.isSafeInteger(claims.gatewayKeyGeneration) || Number(claims.gatewayKeyGeneration) < 1 ||
    !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp)
  ) {
    throw ticketError("TICKET_CLAIMS_INVALID", "Ticket claims are invalid.");
  }
}

export async function signObjectTicket(
  claims: ObjectTicketClaims,
  privateKey: CryptoKey,
): Promise<SignedObjectTicket> {
  assertClaims(claims);
  const signature = await signEs256(privateKey, utf8(canonicalJson(claims)));
  if (signature.byteLength !== 64) {
    throw new Error("ES256 signature must be a 64-byte IEEE P1363 value.");
  }
  return { ...claims, signature: base64UrlEncode(signature) };
}

export async function verifyObjectTicket({
  ticket,
  publicKey,
  nowEpochSeconds,
  expected,
  consumeJti,
}: {
  ticket: SignedObjectTicket;
  publicKey: CryptoKey;
  nowEpochSeconds: number;
  expected: {
    audience: "openclaw-media-gateway";
    operation: ObjectTicketClaims["operation"];
    organizationId: string;
    objectKey: string;
  };
  consumeJti: (claims: ObjectTicketClaims) => Promise<void>;
}): Promise<ObjectTicketClaims> {
  if (!Number.isSafeInteger(nowEpochSeconds)) {
    throw ticketError("TICKET_TIME_INVALID", "Ticket verification clock is invalid.");
  }
  if (!ticket || typeof ticket !== "object" || Array.isArray(ticket)) {
    throw ticketError("TICKET_STRICT_INVALID", "Ticket is not strict.");
  }
  if (!exactKeys(ticket as unknown as Record<string, unknown>, [...CLAIM_KEYS, "signature"])) {
    throw ticketError("TICKET_STRICT_INVALID", "Ticket is not strict.");
  }
  const { signature, ...claims } = ticket;
  assertClaims(claims);
  if (typeof signature !== "string" || !SIGNATURE_PATTERN.test(signature)) {
    throw ticketError("TICKET_SIGNATURE_INVALID", "Ticket signature is invalid.");
  }
  const signatureBytes = Uint8Array.from(
    atob(signature.replace(/-/g, "+").replace(/_/g, "/").padEnd(88, "=")),
    (character) => character.charCodeAt(0),
  );
  if (!await verifyEs256(publicKey, utf8(canonicalJson(claims)), signatureBytes)) {
    throw ticketError("TICKET_SIGNATURE_INVALID", "Ticket signature is invalid.");
  }
  if (claims.exp <= claims.iat || claims.exp - claims.iat > MAX_TTL_SECONDS) {
    throw ticketError("TICKET_TTL_INVALID", "Ticket TTL is invalid.");
  }
  if (nowEpochSeconds < claims.iat - 60 || nowEpochSeconds >= claims.exp) {
    throw ticketError("TICKET_EXPIRED", "Ticket is expired.");
  }
  if (
    claims.aud !== expected.audience ||
    claims.operation !== expected.operation ||
    claims.organizationId !== expected.organizationId ||
    claims.objectKey !== expected.objectKey
  ) {
    throw ticketError("TICKET_BINDING_INVALID", "Ticket binding is invalid.");
  }
  await consumeJti(claims);
  return claims;
}
