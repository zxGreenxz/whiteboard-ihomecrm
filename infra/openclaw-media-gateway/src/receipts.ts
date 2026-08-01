import type { MediaGatewayEnv } from "./env";
import { GatewayError } from "./gateway-error";
import { jsonTextResponse } from "./responses";
import type { StoredReceipt } from "./ticket-state";
import type { FrozenMaintenanceClaim, MediaTicketClaims } from "./ticket";
import { ticketVerificationKey } from "./ticket-verifier";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/u;

export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Non-finite JSON number.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object") throw new TypeError("Unsupported canonical JSON value.");
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  ).join(",")}}`;
}

function base64UrlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("invalid base64url");
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

function base64Decode(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new Error("invalid base64");
  }
  const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  if (btoa(String.fromCharCode(...bytes)) !== value) throw new Error("non-canonical base64");
  return bytes;
}

function base64UrlEncode(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value)).replaceAll("+", "-").replaceAll("/", "_")
    .replaceAll("=", "");
}

export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function receiptClaimHash(value: unknown): Promise<string> {
  return await sha256Hex(canonicalJson(value));
}

export function requireReceiptSigningGeneration(
  env: MediaGatewayEnv,
  ticket: MediaTicketClaims,
): number {
  const configured = Number(env.OPENCLAW_RECEIPT_KEY_GENERATION);
  if (
    !positiveInteger(ticket.receiptSigningKeyGeneration) || !positiveInteger(configured) ||
    !configuredReceiptSigners(env).some((entry) =>
      entry.generation === ticket.receiptSigningKeyGeneration
    )
  ) throw new GatewayError("RECEIPT_SIGNING_KEY_UNAVAILABLE", 403);
  return ticket.receiptSigningKeyGeneration;
}

interface ReceiptSignerConfiguration {
  generation: number;
  privateKeyB64: string;
  publicKeySha256: string;
  notBeforeEpochSeconds: number;
  notAfterEpochSeconds: number;
  emergencyRevoked: boolean;
}

export interface ReceiptSigner {
  generation: number;
  privateKey: CryptoKey;
  publicKeySha256: string;
}

function canonicalEpoch(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || String(parsed) !== value) {
    throw new Error("receipt key epoch invalid");
  }
  return parsed;
}

function recoveryReceiptSigners(env: MediaGatewayEnv): ReceiptSignerConfiguration[] {
  const parsed = JSON.parse(env.OPENCLAW_RECEIPT_RECOVERY_KEYRING_JSON) as unknown;
  if (!Array.isArray(parsed) || parsed.length > 2) throw new Error("receipt keyring invalid");
  return parsed.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("receipt keyring invalid");
    }
    const entry = value as Record<string, unknown>;
    const keys = Object.keys(entry).sort().join(",");
    if (keys !== [
      "emergencyRevoked", "generation", "notAfterEpochSeconds", "notBeforeEpochSeconds",
      "privateKeyB64", "publicKeySha256",
    ].sort().join(",")) throw new Error("receipt keyring invalid");
    if (!positiveInteger(entry.generation) || typeof entry.privateKeyB64 !== "string" ||
      typeof entry.publicKeySha256 !== "string" || typeof entry.emergencyRevoked !== "boolean") {
      throw new Error("receipt keyring invalid");
    }
    return {
      generation: entry.generation,
      privateKeyB64: entry.privateKeyB64,
      publicKeySha256: entry.publicKeySha256,
      notBeforeEpochSeconds: canonicalEpoch(String(entry.notBeforeEpochSeconds)),
      notAfterEpochSeconds: canonicalEpoch(String(entry.notAfterEpochSeconds)),
      emergencyRevoked: entry.emergencyRevoked,
    };
  });
}

function configuredReceiptSigners(env: MediaGatewayEnv): ReceiptSignerConfiguration[] {
  const active: ReceiptSignerConfiguration = {
    generation: Number(env.OPENCLAW_RECEIPT_KEY_GENERATION),
    privateKeyB64: env.OPENCLAW_RECEIPT_PRIVATE_KEY_B64,
    publicKeySha256: env.OPENCLAW_RECEIPT_PUBLIC_KEY_SHA256,
    notBeforeEpochSeconds: canonicalEpoch(env.OPENCLAW_RECEIPT_KEY_NOT_BEFORE_EPOCH_SECONDS),
    notAfterEpochSeconds: canonicalEpoch(env.OPENCLAW_RECEIPT_KEY_NOT_AFTER_EPOCH_SECONDS),
    emergencyRevoked: env.OPENCLAW_RECEIPT_KEY_EMERGENCY_REVOKED === "true",
  };
  if (
    !positiveInteger(active.generation) ||
    !["true", "false"].includes(env.OPENCLAW_RECEIPT_KEY_EMERGENCY_REVOKED)
  ) throw new Error("receipt key configuration invalid");
  const all = [active, ...recoveryReceiptSigners(env)];
  if (new Set(all.map((entry) => entry.generation)).size !== all.length) {
    throw new Error("duplicate receipt key generation");
  }
  if (all.some((entry) =>
    !/^[0-9a-f]{64}$/u.test(entry.publicKeySha256) ||
    entry.notBeforeEpochSeconds >= entry.notAfterEpochSeconds
  )) throw new Error("receipt key lifecycle invalid");
  return all;
}

async function importReceiptSigner(
  configuration: ReceiptSignerConfiguration,
): Promise<ReceiptSigner> {
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    base64Decode(configuration.privateKeyB64).slice().buffer,
    "Ed25519",
    true,
    ["sign"],
  );
  const privateJwk = await crypto.subtle.exportKey("jwk", privateKey) as JsonWebKey;
  if (privateJwk.kty !== "OKP" || privateJwk.crv !== "Ed25519" || typeof privateJwk.x !== "string") {
    throw new Error("receipt private key invalid");
  }
  const publicKey = await crypto.subtle.importKey(
    "jwk",
    { kty: "OKP", crv: "Ed25519", x: privateJwk.x, ext: true, key_ops: ["verify"] },
    "Ed25519",
    true,
    ["verify"],
  );
  const publicKeyHash = await sha256Hex(new Uint8Array(
    await crypto.subtle.exportKey("spki", publicKey) as ArrayBuffer,
  ));
  if (publicKeyHash !== configuration.publicKeySha256) {
    throw new Error("receipt public key identity mismatch");
  }
  return {
    generation: configuration.generation,
    privateKey,
    publicKeySha256: configuration.publicKeySha256,
  };
}

async function receiptSignerForGeneration(
  env: MediaGatewayEnv,
  generation: number,
  nowEpochSeconds = Math.floor(Date.now() / 1_000),
): Promise<ReceiptSigner> {
  const configuration = configuredReceiptSigners(env).find((entry) => entry.generation === generation);
  if (
    !configuration || configuration.emergencyRevoked ||
    nowEpochSeconds < configuration.notBeforeEpochSeconds ||
    nowEpochSeconds >= configuration.notAfterEpochSeconds ||
    !/^[0-9a-f]{64}$/u.test(configuration.publicKeySha256)
  ) throw new GatewayError("RECEIPT_SIGNING_KEY_UNAVAILABLE", 403);
  try {
    return await importReceiptSigner(configuration);
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    throw new GatewayError("RECEIPT_SIGNING_KEY_UNAVAILABLE", 403);
  }
}

export async function prepareReceiptSigner(
  env: MediaGatewayEnv,
  ticket: MediaTicketClaims,
): Promise<ReceiptSigner> {
  const generation = requireReceiptSigningGeneration(env, ticket);
  return await receiptSignerForGeneration(env, generation);
}

export async function assertReceiptSignerCurrent(
  env: MediaGatewayEnv,
  preparedSigner: ReceiptSigner,
): Promise<void> {
  const current = await receiptSignerForGeneration(env, preparedSigner.generation);
  if (current.publicKeySha256 !== preparedSigner.publicKeySha256) {
    throw new GatewayError("RECEIPT_SIGNING_KEY_UNAVAILABLE", 403);
  }
}

export async function activeReceiptSignerConfigurationIsValid(env: MediaGatewayEnv): Promise<boolean> {
  try {
    const configured = configuredReceiptSigners(env);
    await Promise.all(configured.map(importReceiptSigner));
    const active = configured[0] as ReceiptSignerConfiguration;
    const nowEpochSeconds = Math.floor(Date.now() / 1_000);
    return !active.emergencyRevoked && nowEpochSeconds >= active.notBeforeEpochSeconds &&
      nowEpochSeconds < active.notAfterEpochSeconds;
  } catch {
    return false;
  }
}

export async function receiptHash(domain: string, fullReceipt: unknown): Promise<string> {
  if (
    domain !== "ihome-openclaw-retention-receipt-v1" &&
    domain !== "ihome-openclaw-audit-receipt-v1" &&
    domain !== "ihome-openclaw-media-upload-receipt-v1"
  ) throw new TypeError("Unknown receipt domain.");
  return await sha256Hex(`${domain}\0${canonicalJson(fullReceipt)}`);
}

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value as Record<string, unknown>).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}

export interface DeleteAuthorizationClaims {
  version: 1;
  authorizationKind: "RETENTION_FINAL_DELETE";
  organizationId: string;
  maintenancePrincipalId: string;
  workItemId: string;
  claimGeneration?: number;
  credentialGeneration: number;
  leaseGeneration: number;
  fencingToken: number;
  objectKey: string;
  deletePhase: "FINAL_DELETE";
  holdVersion: number;
  quarantineVersion: number;
  deleteTicketJti: string;
  authorizationJti: string;
  iat: string;
  exp: string;
  gatewaySigningKeyGeneration: number;
  recoveryKind?: "RETENTION_DELETE_AUTHORIZED";
  recoveryGeneration?: number;
  replacesTicketJti?: string;
  replacesDeleteAuthorizationJti?: string;
  frozenClaim?: FrozenMaintenanceClaim;
}

const DELETE_AUTHORIZATION_KEYS = [
  "version", "authorizationKind", "organizationId", "maintenancePrincipalId", "workItemId",
  "claimGeneration", "credentialGeneration", "leaseGeneration", "fencingToken", "objectKey",
  "deletePhase", "holdVersion", "quarantineVersion", "deleteTicketJti", "authorizationJti",
  "iat", "exp", "gatewaySigningKeyGeneration", "signature",
] as const;
const DELETE_RECOVERY_AUTHORIZATION_KEYS = [
  "version", "authorizationKind", "organizationId", "maintenancePrincipalId", "workItemId",
  "credentialGeneration", "leaseGeneration", "fencingToken", "recoveryKind",
  "recoveryGeneration", "replacesTicketJti", "replacesDeleteAuthorizationJti", "frozenClaim",
  "objectKey", "deletePhase", "holdVersion", "quarantineVersion", "deleteTicketJti",
  "authorizationJti", "iat", "exp", "gatewaySigningKeyGeneration", "signature",
] as const;

function exactFrozenMaintenanceClaim(value: unknown): value is FrozenMaintenanceClaim {
  return exact(value, [
    "maintenancePrincipalId", "credentialGeneration", "leaseGeneration", "fencingToken",
    "claimGeneration",
  ]) && typeof value.maintenancePrincipalId === "string" &&
    UUID.test(value.maintenancePrincipalId) && positiveInteger(value.credentialGeneration) &&
    positiveInteger(value.leaseGeneration) && positiveInteger(value.fencingToken) &&
    positiveInteger(value.claimGeneration);
}

function assertMaintenanceTicket(ticket: MediaTicketClaims): asserts ticket is MediaTicketClaims & {
  maintenancePrincipalId: string;
  workItemId: string;
  credentialGeneration: number;
  leaseGeneration: number;
  fencingToken: number;
} {
  if (
    ticket.subject !== "MAINTENANCE" ||
    typeof ticket.maintenancePrincipalId !== "string" || !UUID.test(ticket.maintenancePrincipalId) ||
    typeof ticket.workItemId !== "string" || !UUID.test(ticket.workItemId) ||
    !positiveInteger(ticket.credentialGeneration) ||
    !positiveInteger(ticket.leaseGeneration) || !positiveInteger(ticket.fencingToken)
  ) throw new GatewayError("MAINTENANCE_TICKET_INVALID", 403);
  if (ticket.recoveryKind === undefined) {
    if (!positiveInteger(ticket.claimGeneration)) {
      throw new GatewayError("MAINTENANCE_TICKET_INVALID", 403);
    }
  } else if (!positiveInteger(ticket.recoveryGeneration) ||
    !exactFrozenMaintenanceClaim(ticket.frozenClaim)) {
    throw new GatewayError("MAINTENANCE_TICKET_INVALID", 403);
  }
}

export function requireMaintenanceTicket(ticket: MediaTicketClaims): asserts ticket is MediaTicketClaims & {
  maintenancePrincipalId: string;
  workItemId: string;
  credentialGeneration: number;
  leaseGeneration: number;
  fencingToken: number;
} {
  assertMaintenanceTicket(ticket);
}

export function maintenanceReceiptLineage(ticket: MediaTicketClaims): FrozenMaintenanceClaim {
  assertMaintenanceTicket(ticket);
  if (ticket.recoveryKind !== undefined) return ticket.frozenClaim as FrozenMaintenanceClaim;
  return {
    maintenancePrincipalId: ticket.maintenancePrincipalId,
    credentialGeneration: ticket.credentialGeneration,
    leaseGeneration: ticket.leaseGeneration,
    fencingToken: ticket.fencingToken,
    claimGeneration: ticket.claimGeneration as number,
  };
}

export async function verifyDeleteAuthorization(
  request: Request,
  env: MediaGatewayEnv,
  ticket: MediaTicketClaims,
  now = new Date(),
  allowExpiredForReplay = false,
): Promise<DeleteAuthorizationClaims> {
  assertMaintenanceTicket(ticket);
  const header = request.headers.get("x-openclaw-delete-authorization");
  if (!header || header.length > 16_384) {
    throw new GatewayError("DELETE_AUTHORIZATION_REQUIRED", 403);
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      base64UrlDecode(header),
    ));
  } catch {
    throw new GatewayError("DELETE_AUTHORIZATION_INVALID", 403);
  }
  const recoveryTicket = ticket.recoveryKind === "RETENTION_DELETE_AUTHORIZED";
  if (!exact(decoded, recoveryTicket
    ? DELETE_RECOVERY_AUTHORIZATION_KEYS
    : DELETE_AUTHORIZATION_KEYS)) {
    throw new GatewayError("DELETE_AUTHORIZATION_INVALID", 403);
  }
  const { signature, ...claims } = decoded;
  const issuedAt = typeof claims.iat === "string" ? Date.parse(claims.iat) : Number.NaN;
  const expiresAt = typeof claims.exp === "string" ? Date.parse(claims.exp) : Number.NaN;
  if (
    claims.version !== 1 || claims.authorizationKind !== "RETENTION_FINAL_DELETE" ||
    typeof signature !== "string" || !SIGNATURE.test(signature) ||
    typeof claims.organizationId !== "string" || !UUID.test(claims.organizationId) ||
    typeof claims.maintenancePrincipalId !== "string" || !UUID.test(claims.maintenancePrincipalId) ||
    typeof claims.workItemId !== "string" || !UUID.test(claims.workItemId) ||
    !positiveInteger(claims.credentialGeneration) ||
    !positiveInteger(claims.leaseGeneration) || !positiveInteger(claims.fencingToken) ||
    typeof claims.objectKey !== "string" || claims.deletePhase !== "FINAL_DELETE" ||
    !Number.isSafeInteger(claims.holdVersion) || Number(claims.holdVersion) < 0 ||
    !positiveInteger(claims.quarantineVersion) ||
    typeof claims.deleteTicketJti !== "string" || !UUID.test(claims.deleteTicketJti) ||
    typeof claims.authorizationJti !== "string" || !UUID.test(claims.authorizationJti) ||
    !positiveInteger(claims.gatewaySigningKeyGeneration) ||
    !Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt ||
    new Date(issuedAt).toISOString() !== claims.iat ||
    new Date(expiresAt).toISOString() !== claims.exp ||
    expiresAt - issuedAt > 5_000 || (!allowExpiredForReplay &&
      (now.getTime() < issuedAt - 5_000 || now.getTime() >= expiresAt))
  ) throw new GatewayError("DELETE_AUTHORIZATION_INVALID", 403);
  if (recoveryTicket) {
    if (
      claims.recoveryKind !== "RETENTION_DELETE_AUTHORIZED" ||
      !positiveInteger(claims.recoveryGeneration) ||
      typeof claims.replacesTicketJti !== "string" || !UUID.test(claims.replacesTicketJti) ||
      typeof claims.replacesDeleteAuthorizationJti !== "string" ||
      !UUID.test(claims.replacesDeleteAuthorizationJti) ||
      !exactFrozenMaintenanceClaim(claims.frozenClaim)
    ) throw new GatewayError("DELETE_AUTHORIZATION_INVALID", 403);
  } else if (!positiveInteger(claims.claimGeneration)) {
    throw new GatewayError("DELETE_AUTHORIZATION_INVALID", 403);
  }
  if (
    claims.organizationId !== ticket.organizationId ||
    claims.maintenancePrincipalId !== ticket.maintenancePrincipalId ||
    claims.workItemId !== ticket.workItemId ||
    claims.credentialGeneration !== ticket.credentialGeneration ||
    claims.leaseGeneration !== ticket.leaseGeneration || claims.fencingToken !== ticket.fencingToken ||
    claims.objectKey !== ticket.objectKey || claims.holdVersion !== ticket.holdVersion ||
    claims.quarantineVersion !== ticket.quarantineVersion || claims.deleteTicketJti !== ticket.jti ||
    claims.gatewaySigningKeyGeneration !== ticket.gatewayKeyGeneration
  ) throw new GatewayError("DELETE_AUTHORIZATION_MISMATCH", 403);
  if (recoveryTicket) {
    if (
      claims.recoveryGeneration !== ticket.recoveryGeneration ||
      claims.replacesTicketJti !== ticket.replacesTicketJti ||
      claims.replacesDeleteAuthorizationJti !== ticket.replacesDeleteAuthorizationJti ||
      canonicalJson(claims.frozenClaim) !== canonicalJson(ticket.frozenClaim)
    ) throw new GatewayError("DELETE_AUTHORIZATION_MISMATCH", 403);
  } else if (claims.claimGeneration !== ticket.claimGeneration) {
    throw new GatewayError("DELETE_AUTHORIZATION_MISMATCH", 403);
  }

  try {
    const key = await ticketVerificationKey(
      env,
      claims.gatewaySigningKeyGeneration,
      allowExpiredForReplay,
    );
    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      base64UrlDecode(signature),
      new TextEncoder().encode(
        `ihome-openclaw-retention-authorization-v1\0${canonicalJson(claims)}`,
      ),
    );
    if (!valid) throw new Error("invalid signature");
  } catch {
    throw new GatewayError("DELETE_AUTHORIZATION_INVALID", 403);
  }
  return claims as unknown as DeleteAuthorizationClaims;
}

export async function signReceipt(
  env: MediaGatewayEnv,
  domain: "ihome-openclaw-retention-receipt-v1" | "ihome-openclaw-audit-receipt-v1" |
    "ihome-openclaw-media-upload-receipt-v1",
  claims: Record<string, unknown>,
  preparedSigner?: ReceiptSigner,
): Promise<StoredReceipt> {
  const canonical = canonicalJson(claims);
  const generation = Number(claims.gatewaySigningKeyGeneration);
  const signer = preparedSigner ?? await receiptSignerForGeneration(env, generation);
  if (signer.generation !== generation) {
    throw new GatewayError("RECEIPT_SIGNING_KEY_UNAVAILABLE", 403);
  }
  await assertReceiptSignerCurrent(env, signer);
  const signature = base64UrlEncode(new Uint8Array(await crypto.subtle.sign(
    "Ed25519",
    signer.privateKey,
    new TextEncoder().encode(`${domain}\0${canonical}`),
  )));
  await assertReceiptSignerCurrent(env, signer);
  const fullReceipt = { ...claims, signature };
  const canonicalFullReceipt = canonicalJson(fullReceipt);
  return {
    canonicalJson: canonicalFullReceipt,
    signature,
    sha256: await receiptHash(domain, fullReceipt),
  };
}

export function storedReceiptResponse(receipt: StoredReceipt, status = 200): Response {
  return jsonTextResponse(receipt.canonicalJson, status);
}
