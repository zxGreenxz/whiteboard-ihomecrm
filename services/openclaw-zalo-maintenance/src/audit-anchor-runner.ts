import { createPrivateKey, createPublicKey } from "node:crypto";

import { canonicalJson, sha256Hex } from "./runtime-client.js";
import { assertAuditLineageRoot } from "./audit-lineage.js";
import { timestamp } from "./timestamp.js";
import { MaintenanceRetryableWorkError } from "./work-error.js";
import type {
  AuditVerifyAuthorizedRecoveryV1,
  MaintenanceRuntimePort,
  MaintenanceWorkClaimV1,
} from "./retention-runner.js";

export interface AuditRootProjectionV1 {
  version: 1;
  organizationId: string;
  rootDate: string;
  firstSequence: number;
  lastSequence: number;
  eventCount: number;
  previousRootHash: string | null;
  merkleRootHash: string;
  rootHash: string;
  auditSigningKeyGeneration: number;
}

export interface SignedAuditAnchorDocumentV1 {
  version: 1;
  signingDomain: "ihome-openclaw-audit-root-v1\0";
  root: AuditRootProjectionV1;
  canonicalRootJson: string;
  signature: string;
  signatureHash: string;
}

export interface BuiltAuditAnchor {
  root: AuditRootProjectionV1;
  document: SignedAuditAnchorDocumentV1;
  bytes: Uint8Array;
  auditSigningPublicKeyHash: string;
}

export interface AuditAnchorReceiptV1 {
  version: 1;
  receiptKind: "AUDIT_ANCHOR_VERIFY";
  receiptId: string;
  organizationId: string;
  maintenancePrincipalId: string;
  workItemId: string;
  claimGeneration: number;
  credentialGeneration: number;
  leaseGeneration: number;
  fencingToken: number;
  auditRootId: string;
  rootHash: string;
  anchorKey: string;
  signatureHash: string;
  auditSigningKeyGeneration: number;
  verifyTicketJti: string;
  objectVersionOrEtag: string;
  verifiedAt: string;
  gatewaySigningKeyGeneration: number;
  signature: string;
}

export interface AuditGatewayPort {
  putObject(request: Readonly<{
    ticketHeader: string;
    contentType: "application/json";
    bytes: Uint8Array;
  }>, options?: Readonly<{ signal?: AbortSignal }>): Promise<unknown>;
  verifyObject(
    request: Readonly<{ ticketHeader: string }>,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<unknown>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/u;
const JTI = /^[A-Za-z0-9_-]{16,128}$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const ED25519_PKCS8_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06,
  0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

function auditPrivateKeyBytes(value: string): Uint8Array {
  if (
    value.length === 0 || value !== value.trim() || value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)
  ) throw new TypeError("audit signing key is invalid");
  const decoded = Buffer.from(value, "base64");
  try {
    if (
      decoded.toString("base64") !== value ||
      decoded.byteLength !== ED25519_PKCS8_PREFIX.byteLength + 32 ||
      ED25519_PKCS8_PREFIX.some((byte, index) => decoded[index] !== byte)
    ) throw new TypeError("audit signing key is invalid");
    return Uint8Array.from(decoded);
  } finally {
    decoded.fill(0);
  }
}

async function loadAuditSigningPrivateKey(value: string): Promise<{
  privateKey: Awaited<ReturnType<typeof crypto.subtle.importKey>>;
  auditSigningPublicKeyHash: string;
}> {
  let privateKeyBytes: Uint8Array | null = null;
  try {
    privateKeyBytes = auditPrivateKeyBytes(value);
    const privateKeyObject = createPrivateKey({
      key: Buffer.from(privateKeyBytes),
      format: "der",
      type: "pkcs8",
    });
    const publicKeyDer = createPublicKey(privateKeyObject).export({
      format: "der",
      type: "spki",
    });
    const privateKey = await crypto.subtle.importKey(
      "pkcs8",
      privateKeyBytes,
      "Ed25519",
      false,
      ["sign"],
    );
    return {
      privateKey,
      auditSigningPublicKeyHash: sha256Hex(publicKeyDer),
    };
  } catch {
    throw new TypeError("audit signing key is invalid");
  } finally {
    privateKeyBytes?.fill(0);
  }
}

export async function validateAuditSigningPrivateKey(value: string): Promise<string> {
  return (await loadAuditSigningPrivateKey(value)).auditSigningPublicKeyHash;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exact(value: unknown, keys: readonly string[], name: string): Record<string, unknown> {
  const result = record(value, name);
  const actual = Object.keys(result).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${name} has non-canonical fields`);
  }
  return result;
}

function string(value: unknown, pattern: RegExp | null, name: string): string {
  if (
    typeof value !== "string" || value.length === 0 || value !== value.trim() ||
    (pattern !== null && !pattern.test(value))
  ) throw new TypeError(`${name} is invalid`);
  return value;
}

function integer(value: unknown, minimum: number, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new TypeError(`${name} must be an integer >= ${minimum}`);
  }
  return Number(value);
}

function auditPayload(claim: MaintenanceWorkClaimV1 | AuditVerifyAuthorizedRecoveryV1) {
  if (claim.payload.kind !== "AUDIT_ANCHOR") {
    throw new TypeError("audit runner received another work kind");
  }
  return claim.payload;
}

export async function buildSignedAuditAnchor({
  claim,
  auditPrivateKeyPkcs8B64,
  auditPrivateKeyGeneration,
}: {
  claim: MaintenanceWorkClaimV1;
  auditPrivateKeyPkcs8B64: string;
  auditPrivateKeyGeneration: number;
}): Promise<BuiltAuditAnchor> {
  const payload = auditPayload(claim);
  if (payload.auditSigningKeyGeneration !== auditPrivateKeyGeneration) {
    throw new MaintenanceRetryableWorkError("audit signing key generation mismatch");
  }
  string(payload.auditRootId, UUID, "auditRootId");
  string(payload.rootDate, DATE, "rootDate");
  integer(payload.firstSequence, 1, "firstSequence");
  integer(payload.lastSequence, 1, "lastSequence");
  integer(payload.eventCount, 1, "eventCount");
  if (
    payload.lastSequence < payload.firstSequence ||
    payload.eventCount !== payload.lastSequence - payload.firstSequence + 1
  ) throw new TypeError("audit root sequence range is invalid");
  if (payload.previousRootHash !== null) {
    string(payload.previousRootHash, SHA256, "previousRootHash");
  }
  string(payload.merkleRootHash, SHA256, "merkleRootHash");
  string(payload.rootHash, SHA256, "rootHash");
  string(payload.auditSigningPublicKeyHash, SHA256, "auditSigningPublicKeyHash");
  assertAuditLineageRoot({
    organizationId: claim.organizationId,
    rootDate: payload.rootDate,
    firstSequence: payload.firstSequence,
    lastSequence: payload.lastSequence,
    eventCount: payload.eventCount,
    previousRootHash: payload.previousRootHash,
    merkleRootHash: payload.merkleRootHash,
    rootHash: payload.rootHash,
  });
  const root: AuditRootProjectionV1 = {
    version: 1,
    organizationId: claim.organizationId,
    rootDate: payload.rootDate,
    firstSequence: payload.firstSequence,
    lastSequence: payload.lastSequence,
    eventCount: payload.eventCount,
    previousRootHash: payload.previousRootHash,
    merkleRootHash: payload.merkleRootHash,
    rootHash: payload.rootHash,
    auditSigningKeyGeneration: payload.auditSigningKeyGeneration,
  };
  const { privateKey, auditSigningPublicKeyHash } = await loadAuditSigningPrivateKey(
    auditPrivateKeyPkcs8B64,
  );
  if (auditSigningPublicKeyHash !== payload.auditSigningPublicKeyHash) {
    throw new MaintenanceRetryableWorkError("audit signing public key hash mismatch");
  }
  const canonicalRootJson = canonicalJson(root);
  const signatureBytes = new Uint8Array(await crypto.subtle.sign(
    "Ed25519",
    privateKey,
    new TextEncoder().encode(`ihome-openclaw-audit-root-v1\0${canonicalRootJson}`),
  ));
  const signature = Buffer.from(signatureBytes).toString("base64url");
  const signatureHash = sha256Hex(signatureBytes);
  const document: SignedAuditAnchorDocumentV1 = {
    version: 1,
    signingDomain: "ihome-openclaw-audit-root-v1\0",
    root,
    canonicalRootJson,
    signature,
    signatureHash,
  };
  return {
    root,
    document,
    bytes: new TextEncoder().encode(canonicalJson(document)),
    auditSigningPublicKeyHash,
  };
}

function encodeSignedHeader(value: unknown): string {
  return Buffer.from(canonicalJson(value), "utf8").toString("base64url");
}

interface AuditTicketResult {
  ticketId: string;
  ticketHash: string;
  receiptSigningKeyGeneration: number;
  ticket: Record<string, unknown>;
}

interface AuditRecoveryArtifactContext {
  maintenancePrincipalId: string;
  credentialGeneration: number;
  leaseGeneration: number;
  fencingToken: number;
  recoveryGeneration: number;
  replacesVerifyTicketJti: string;
  frozenClaim: AuditVerifyAuthorizedRecoveryV1["frozenClaim"];
}

function parseAuditTicketResult({
  value,
  claim,
  operation,
  documentSha256,
  documentByteLength,
  signatureHash,
  auditSigningPublicKeyHash,
  now,
  allowExpired = false,
  recovery,
}: {
  value: unknown;
  claim: MaintenanceWorkClaimV1;
  operation: "ANCHOR" | "ANCHOR_VERIFY";
  documentSha256: string;
  documentByteLength: number;
  signatureHash: string;
  auditSigningPublicKeyHash: string;
  now: Date;
  allowExpired?: boolean;
  recovery?: AuditRecoveryArtifactContext;
}): AuditTicketResult {
  const result = exact(
    value,
    ["version", "ticketId", "ticketHash", "expiresAt", "state", "ticket"],
    "audit ticket result",
  );
  if (result.version !== 1 || result.state !== "ISSUED") {
    throw new TypeError("audit ticket result state is invalid");
  }
  const ticketId = string(result.ticketId, JTI, "ticketId");
  const ticketHash = string(result.ticketHash, SHA256, "ticketHash");
  const resultExpiresAt = timestamp(result.expiresAt, "ticket.expiresAt");
  const normalTicketKeys = [
    "version", "aud", "operation", "subject", "jti", "organizationId", "accountId",
    "objectKey", "sha256", "contentType", "contentLength", "sessionGeneration",
    "gatewayKeyGeneration", "receiptSigningKeyGeneration", "iat", "exp",
    "maintenancePrincipalId", "workItemId",
    "claimGeneration", "credentialGeneration", "leaseGeneration", "fencingToken",
    "auditRootId", "rootHash", "signatureHash", "auditSigningKeyGeneration",
    "auditSigningPublicKeyHash", "signature",
  ] as const;
  const recoveryTicketKeys = [
    "version", "aud", "operation", "subject", "jti", "organizationId", "accountId",
    "objectKey", "sha256", "contentType", "contentLength", "sessionGeneration",
    "gatewayKeyGeneration", "receiptSigningKeyGeneration", "iat", "exp",
    "maintenancePrincipalId", "workItemId", "credentialGeneration", "leaseGeneration",
    "fencingToken", "recoveryKind", "recoveryGeneration", "replacesVerifyTicketJti",
    "frozenClaim", "auditRootId", "rootHash", "signatureHash",
    "auditSigningKeyGeneration", "auditSigningPublicKeyHash", "signature",
  ] as const;
  const ticket = exact(
    result.ticket,
    recovery === undefined ? normalTicketKeys : recoveryTicketKeys,
    "audit ticket",
  );
  const payload = auditPayload(claim);
  let admissionMatches: boolean;
  if (recovery === undefined) {
    admissionMatches = ticket.maintenancePrincipalId === claim.maintenancePrincipalId &&
      ticket.claimGeneration === claim.claimGeneration &&
      ticket.credentialGeneration === claim.credentialGeneration &&
      ticket.leaseGeneration === claim.leaseGeneration &&
      ticket.fencingToken === claim.fencingToken;
  } else {
    const frozenClaim = exact(ticket.frozenClaim, [
      "maintenancePrincipalId", "credentialGeneration", "leaseGeneration", "fencingToken",
      "claimGeneration",
    ], "audit recovery ticket frozen claim");
    admissionMatches = ticket.maintenancePrincipalId === recovery.maintenancePrincipalId &&
      ticket.credentialGeneration === recovery.credentialGeneration &&
      ticket.leaseGeneration === recovery.leaseGeneration &&
      ticket.fencingToken === recovery.fencingToken &&
      ticket.recoveryKind === "AUDIT_VERIFY_AUTHORIZED" &&
      ticket.recoveryGeneration === recovery.recoveryGeneration &&
      ticket.replacesVerifyTicketJti === recovery.replacesVerifyTicketJti &&
      frozenClaim.maintenancePrincipalId === recovery.frozenClaim.maintenancePrincipalId &&
      frozenClaim.credentialGeneration === recovery.frozenClaim.credentialGeneration &&
      frozenClaim.leaseGeneration === recovery.frozenClaim.leaseGeneration &&
      frozenClaim.fencingToken === recovery.frozenClaim.fencingToken &&
      frozenClaim.claimGeneration === recovery.frozenClaim.claimGeneration;
  }
  if (
    ticket.version !== 1 || ticket.aud !== "openclaw-media-gateway" ||
    ticket.operation !== operation || ticket.subject !== "MAINTENANCE" || ticket.jti !== ticketId ||
    ticket.organizationId !== claim.organizationId || ticket.accountId !== null ||
    ticket.objectKey !== payload.anchorKey || ticket.sha256 !== documentSha256 ||
    ticket.contentType !== "application/json" || ticket.contentLength !== documentByteLength ||
    ticket.workItemId !== claim.workItemId || !admissionMatches ||
    ticket.auditRootId !== payload.auditRootId || ticket.rootHash !== payload.rootHash ||
    ticket.signatureHash !== signatureHash ||
    ticket.auditSigningKeyGeneration !== payload.auditSigningKeyGeneration ||
    ticket.auditSigningPublicKeyHash !== payload.auditSigningPublicKeyHash ||
    ticket.auditSigningPublicKeyHash !== auditSigningPublicKeyHash
  ) throw new TypeError("audit ticket claim mismatch");
  string(ticket.signature, SIGNATURE, "ticket.signature");
  integer(ticket.contentLength, 1, "ticket.contentLength");
  integer(ticket.sessionGeneration, 0, "ticket.sessionGeneration");
  integer(ticket.gatewayKeyGeneration, 1, "ticket.gatewayKeyGeneration");
  const receiptSigningKeyGeneration = integer(
    ticket.receiptSigningKeyGeneration,
    1,
    "ticket.receiptSigningKeyGeneration",
  );
  const issuedAt = integer(ticket.iat, 1, "ticket.iat");
  const expiresAt = integer(ticket.exp, 1, "ticket.exp");
  const { signature: _signature, ...unsignedTicket } = ticket;
  const expectedTicketHash = sha256Hex(
    `ihome-openclaw-media-ticket-v1\0${canonicalJson(unsignedTicket)}`,
  );
  if (ticketHash !== expectedTicketHash) throw new TypeError("audit ticket hash mismatch");
  if (Date.parse(resultExpiresAt) !== expiresAt * 1_000) {
    throw new TypeError("audit ticket expiry mismatch");
  }
  if (expiresAt <= issuedAt || expiresAt - issuedAt > 60) {
    throw new TypeError("audit ticket lifetime is invalid");
  }
  if (
    !allowExpired &&
    (now.getTime() < issuedAt * 1_000 - 5_000 || now.getTime() >= expiresAt * 1_000)
  ) throw new MaintenanceRetryableWorkError("audit ticket lifetime is not active");
  return { ticketId, ticketHash, receiptSigningKeyGeneration, ticket };
}

function parseAuditRecoveryTicketResult({
  value,
  replacesVerifyTicketJti,
  claim,
  oldTicket,
  now,
  recovery,
}: {
  value: unknown;
  replacesVerifyTicketJti: string;
  claim: MaintenanceWorkClaimV1;
  oldTicket: AuditTicketResult;
  now: Date;
  recovery: AuditVerifyAuthorizedRecoveryV1;
}): AuditTicketResult {
  const result = exact(value, [
    "version", "ticketId", "ticketHash", "expiresAt", "state",
    "replacesVerifyTicketJti", "ticket",
  ], "audit recovery ticket result");
  if (
    result.version !== 1 || result.state !== "RECOVERY_REFRESHED" ||
    result.replacesVerifyTicketJti !== replacesVerifyTicketJti
  ) throw new TypeError("audit recovery ticket result state is invalid");
  if (result.ticketId === replacesVerifyTicketJti) {
    throw new TypeError("audit recovery ticket must rotate its JTI");
  }
  return parseAuditTicketResult({
    value: {
      version: 1,
      ticketId: result.ticketId,
      ticketHash: result.ticketHash,
      expiresAt: result.expiresAt,
      state: "ISSUED",
      ticket: result.ticket,
    },
    claim,
    operation: "ANCHOR_VERIFY",
    documentSha256: string(oldTicket.ticket.sha256, SHA256, "oldTicket.sha256"),
    documentByteLength: integer(
      oldTicket.ticket.contentLength,
      1,
      "oldTicket.contentLength",
    ),
    signatureHash: string(
      oldTicket.ticket.signatureHash,
      SHA256,
      "oldTicket.signatureHash",
    ),
    auditSigningPublicKeyHash: string(
      auditPayload(claim).auditSigningPublicKeyHash,
      SHA256,
      "payload.auditSigningPublicKeyHash",
    ),
    now,
    recovery: {
      maintenancePrincipalId: recovery.maintenancePrincipalId,
      credentialGeneration: recovery.credentialGeneration,
      leaseGeneration: recovery.leaseGeneration,
      fencingToken: recovery.fencingToken,
      recoveryGeneration: recovery.recoveryGeneration,
      replacesVerifyTicketJti,
      frozenClaim: recovery.frozenClaim,
    },
  });
}

function storedAuditRecoveryContext(
  claim: AuditVerifyAuthorizedRecoveryV1,
): AuditRecoveryArtifactContext | undefined {
  if (claim.verifyTicket.recoveryKind === undefined) return undefined;
  const ticket = record(claim.verifyTicket, "stored audit recovery ticket");
  if (ticket.recoveryKind !== "AUDIT_VERIFY_AUTHORIZED") {
    throw new TypeError("stored audit recovery kind is invalid");
  }
  const frozen = exact(ticket.frozenClaim, [
    "maintenancePrincipalId", "credentialGeneration", "leaseGeneration", "fencingToken",
    "claimGeneration",
  ], "stored audit recovery frozen claim");
  const frozenClaim = {
    maintenancePrincipalId: string(
      frozen.maintenancePrincipalId,
      UUID,
      "stored audit frozen maintenancePrincipalId",
    ),
    credentialGeneration: integer(
      frozen.credentialGeneration,
      1,
      "stored audit frozen credentialGeneration",
    ),
    leaseGeneration: integer(
      frozen.leaseGeneration,
      1,
      "stored audit frozen leaseGeneration",
    ),
    fencingToken: integer(frozen.fencingToken, 1, "stored audit frozen fencingToken"),
    claimGeneration: integer(frozen.claimGeneration, 1, "stored audit frozen claimGeneration"),
  };
  if (
    frozenClaim.maintenancePrincipalId !== claim.frozenClaim.maintenancePrincipalId ||
    frozenClaim.credentialGeneration !== claim.frozenClaim.credentialGeneration ||
    frozenClaim.leaseGeneration !== claim.frozenClaim.leaseGeneration ||
    frozenClaim.fencingToken !== claim.frozenClaim.fencingToken ||
    frozenClaim.claimGeneration !== claim.frozenClaim.claimGeneration
  ) throw new TypeError("stored audit recovery frozen lineage mismatch");
  return {
    maintenancePrincipalId: string(
      ticket.maintenancePrincipalId,
      UUID,
      "stored audit maintenancePrincipalId",
    ),
    credentialGeneration: integer(
      ticket.credentialGeneration,
      1,
      "stored audit credentialGeneration",
    ),
    leaseGeneration: integer(ticket.leaseGeneration, 1, "stored audit leaseGeneration"),
    fencingToken: integer(ticket.fencingToken, 1, "stored audit fencingToken"),
    recoveryGeneration: integer(
      ticket.recoveryGeneration,
      1,
      "stored audit recoveryGeneration",
    ),
    replacesVerifyTicketJti: string(
      ticket.replacesVerifyTicketJti,
      JTI,
      "stored audit replacesVerifyTicketJti",
    ),
    frozenClaim,
  };
}

async function parseAuditReceipt({
  value,
  claim,
  verifyTicket,
  signatureHash,
}: {
  value: unknown;
  claim: MaintenanceWorkClaimV1;
  verifyTicket: AuditTicketResult;
  signatureHash: string;
}): Promise<AuditAnchorReceiptV1> {
  const receipt = exact(value, [
    "version", "receiptKind", "receiptId", "organizationId", "maintenancePrincipalId",
    "workItemId", "claimGeneration", "credentialGeneration", "leaseGeneration", "fencingToken",
    "auditRootId", "rootHash", "anchorKey", "signatureHash", "auditSigningKeyGeneration",
    "verifyTicketJti", "objectVersionOrEtag", "verifiedAt", "gatewaySigningKeyGeneration",
    "signature",
  ], "audit receipt");
  const payload = auditPayload(claim);
  if (
    receipt.version !== 1 || receipt.receiptKind !== "AUDIT_ANCHOR_VERIFY" ||
    receipt.organizationId !== claim.organizationId ||
    receipt.maintenancePrincipalId !== claim.maintenancePrincipalId ||
    receipt.workItemId !== claim.workItemId || receipt.claimGeneration !== claim.claimGeneration ||
    receipt.credentialGeneration !== claim.credentialGeneration ||
    receipt.leaseGeneration !== claim.leaseGeneration || receipt.fencingToken !== claim.fencingToken ||
    receipt.auditRootId !== payload.auditRootId || receipt.rootHash !== payload.rootHash ||
    receipt.anchorKey !== payload.anchorKey || receipt.signatureHash !== signatureHash ||
    receipt.auditSigningKeyGeneration !== payload.auditSigningKeyGeneration ||
    receipt.verifyTicketJti !== verifyTicket.ticketId ||
    receipt.gatewaySigningKeyGeneration !== verifyTicket.receiptSigningKeyGeneration
  ) throw new TypeError("audit receipt claim mismatch");
  string(receipt.receiptId, UUID, "receiptId");
  string(receipt.verifyTicketJti, JTI, "verifyTicketJti");
  string(receipt.objectVersionOrEtag, null, "objectVersionOrEtag");
  string(receipt.signature, SIGNATURE, "receipt.signature");
  timestamp(receipt.verifiedAt, "verifiedAt");
  return receipt as unknown as AuditAnchorReceiptV1;
}

function retryable(error: unknown): boolean {
  if (!error || typeof error !== "object") return true;
  const status = (error as { status?: unknown }).status;
  return status === undefined || status === null || (typeof status === "number" && status >= 500);
}

function expiredWithoutGatewayWork(error: unknown): boolean {
  return !!error && typeof error === "object" &&
    (error as { status?: unknown }).status === 410 &&
    (error as { code?: unknown }).code === "TICKET_EXPIRED_NO_WORK";
}

function safeToVerifyAfterAnchorUploadFailure(error: unknown): boolean {
  if (retryable(error)) return true;
  if (!error || typeof error !== "object") return false;
  const status = (error as { status?: unknown }).status;
  // A previous attempt/process may have committed the immutable object before
  // losing its response. Verification is authoritative and checks the exact
  // bytes and signed audit document, so an existing-object response is safe to
  // resolve through ANCHOR_VERIFY; every other client error remains terminal.
  return status === 409 || status === 412;
}

async function retryExact<T>(operation: () => Promise<T>, attempts: number): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!retryable(error) || attempt + 1 >= attempts) throw error;
    }
  }
  throw lastError;
}

function parseAcknowledgement(value: unknown, auditRootId: string): Record<string, unknown> {
  const result = exact(
    value,
    ["version", "auditRootId", "gatewayReceiptHash", "idempotentReplay"],
    "audit acknowledgement",
  );
  if (
    result.version !== 1 || result.auditRootId !== auditRootId ||
    typeof result.idempotentReplay !== "boolean"
  ) throw new TypeError("audit acknowledgement is invalid");
  string(result.gatewayReceiptHash, SHA256, "gatewayReceiptHash");
  return result;
}

export async function runAuditAnchorWork({
  claim,
  runtime,
  gateway,
  auditPrivateKeyPkcs8B64,
  auditPrivateKeyGeneration,
  retryAttempts = 2,
  now = () => new Date(),
  runtimeAttemptTimeoutMs = 4_000,
  gatewayAttemptTimeoutMs = 2_000,
  leaseSafetyMs = 1_000,
}: {
  claim: MaintenanceWorkClaimV1 | AuditVerifyAuthorizedRecoveryV1;
  runtime: MaintenanceRuntimePort;
  gateway: AuditGatewayPort;
  auditPrivateKeyPkcs8B64: string;
  auditPrivateKeyGeneration: number;
  retryAttempts?: number;
  now?: () => Date;
  runtimeAttemptTimeoutMs?: number;
  gatewayAttemptTimeoutMs?: number;
  leaseSafetyMs?: number;
}): Promise<Record<string, unknown>> {
  if (!Number.isSafeInteger(retryAttempts) || retryAttempts < 1 || retryAttempts > 3) {
    throw new TypeError("retryAttempts must be between 1 and 3");
  }
  for (const [value, minimum, maximum, name] of [
    [runtimeAttemptTimeoutMs, 100, 10_000, "runtime attempt timeout"],
    [gatewayAttemptTimeoutMs, 100, 4_000, "gateway attempt timeout"],
    [leaseSafetyMs, 100, 5_000, "lease safety margin"],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new TypeError(`${name} is invalid`);
    }
  }
  if ("recoveryKind" in claim) {
    const requiredMs = runtimeAttemptTimeoutMs * retryAttempts *
        (claim.gatewayReceipt === null ? 2 : 1) +
      (claim.gatewayReceipt === null ? gatewayAttemptTimeoutMs * retryAttempts * 2 : 0) +
      leaseSafetyMs;
    if (Date.parse(claim.recoveryLeaseExpiresAt) - now().getTime() < requiredMs) {
      throw new MaintenanceRetryableWorkError("maintenance claim has insufficient lease budget");
    }
    const frozenClaim: MaintenanceWorkClaimV1 = {
      version: 1,
      workItemId: claim.workItemId,
      organizationId: claim.organizationId,
      maintenancePrincipalId: claim.frozenClaim.maintenancePrincipalId,
      credentialGeneration: claim.frozenClaim.credentialGeneration,
      leaseGeneration: claim.frozenClaim.leaseGeneration,
      sourceKey: claim.sourceKey,
      claimToken: claim.claimToken,
      claimGeneration: claim.frozenClaim.claimGeneration,
      fencingToken: claim.frozenClaim.fencingToken,
      leaseExpiresAt: claim.recoveryLeaseExpiresAt,
      payload: claim.payload,
    };
    const ticketExp = integer(claim.verifyTicket.exp, 1, "verifyTicket.exp");
    let verifyTicket = parseAuditTicketResult({
      value: {
        version: 1,
        ticketId: claim.verifyTicketId,
        ticketHash: claim.verifyTicketHash,
        expiresAt: new Date(ticketExp * 1_000).toISOString(),
        state: "ISSUED",
        ticket: claim.verifyTicket,
      },
      claim: frozenClaim,
      operation: "ANCHOR_VERIFY",
      documentSha256: string(claim.verifyTicket.sha256, SHA256, "verifyTicket.sha256"),
      documentByteLength: integer(
        claim.verifyTicket.contentLength,
        1,
        "verifyTicket.contentLength",
      ),
      signatureHash: string(
        claim.verifyTicket.signatureHash,
        SHA256,
        "verifyTicket.signatureHash",
      ),
      auditSigningPublicKeyHash: string(
        claim.payload.auditSigningPublicKeyHash,
        SHA256,
        "payload.auditSigningPublicKeyHash",
      ),
      now: now(),
      allowExpired: true,
      recovery: storedAuditRecoveryContext(claim),
    });
    let receiptValue: unknown = claim.gatewayReceipt;
    if (receiptValue === null) {
      try {
        receiptValue = await retryExact(
          () => gateway.verifyObject(Object.freeze({
            ticketHeader: encodeSignedHeader(verifyTicket.ticket),
          }), { signal: AbortSignal.timeout(gatewayAttemptTimeoutMs) }),
          retryAttempts,
        );
      } catch (error) {
        if (!expiredWithoutGatewayWork(error)) throw error;
        const payload = auditPayload(frozenClaim);
        const oldVerifyTicket = verifyTicket;
        const refreshBody = Object.freeze({
          version: 1,
          operation: "ANCHOR_VERIFY" as const,
          recoveryKind: "AUDIT_VERIFY_AUTHORIZED" as const,
          workItemId: claim.workItemId,
          recoveryGeneration: claim.recoveryGeneration,
          claimToken: claim.claimToken,
          expiredVerifyTicketJti: oldVerifyTicket.ticketId,
          gatewayDenial: Object.freeze({
            status: 410 as const,
            code: "TICKET_EXPIRED_NO_WORK" as const,
          }),
          auditRootId: payload.auditRootId,
          rootHash: payload.rootHash,
          anchorKey: payload.anchorKey,
          signatureHash: string(
            oldVerifyTicket.ticket.signatureHash,
            SHA256,
            "verifyTicket.signatureHash",
          ),
          auditSigningKeyGeneration: payload.auditSigningKeyGeneration,
          auditSigningPublicKeyHash: payload.auditSigningPublicKeyHash,
          documentSha256: string(
            oldVerifyTicket.ticket.sha256,
            SHA256,
            "verifyTicket.sha256",
          ),
          documentByteLength: integer(
            oldVerifyTicket.ticket.contentLength,
            1,
            "verifyTicket.contentLength",
          ),
        });
        verifyTicket = parseAuditRecoveryTicketResult({
          value: await retryExact(
            () => runtime.post("/v1/maintenance/media/verify-ticket", refreshBody, {
              signal: AbortSignal.timeout(runtimeAttemptTimeoutMs),
            }),
            retryAttempts,
          ),
          replacesVerifyTicketJti: oldVerifyTicket.ticketId,
          claim: frozenClaim,
          oldTicket: oldVerifyTicket,
          now: now(),
          recovery: claim,
        });
        receiptValue = await retryExact(
          () => gateway.verifyObject(Object.freeze({
            ticketHeader: encodeSignedHeader(verifyTicket.ticket),
          }), { signal: AbortSignal.timeout(gatewayAttemptTimeoutMs) }),
          retryAttempts,
        );
      }
    }
    const receipt = await parseAuditReceipt({
      value: receiptValue,
      claim: frozenClaim,
      verifyTicket,
      signatureHash: string(
        claim.verifyTicket.signatureHash,
        SHA256,
        "verifyTicket.signatureHash",
      ),
    });
    const completionBody = Object.freeze({
      version: 1,
      recoveryKind: "AUDIT_VERIFY_AUTHORIZED" as const,
      workItemId: claim.workItemId,
      recoveryGeneration: claim.recoveryGeneration,
      claimToken: claim.claimToken,
      verifyTicketJti: verifyTicket.ticketId,
      gatewayReceipt: receipt,
    });
    const result = await retryExact(
      () => runtime.post("/v1/maintenance/work/complete", completionBody, {
        signal: AbortSignal.timeout(runtimeAttemptTimeoutMs),
      }),
      retryAttempts,
    );
    return parseAcknowledgement(result, claim.payload.auditRootId);
  }
  const payload = auditPayload(claim);
  const anchor = await buildSignedAuditAnchor({
    claim,
    auditPrivateKeyPkcs8B64,
    auditPrivateKeyGeneration,
  });
  const documentSha256 = sha256Hex(anchor.bytes);
  const ticketBody = (operation: "ANCHOR" | "ANCHOR_VERIFY") => Object.freeze({
    version: 1,
    operation,
    workItemId: claim.workItemId,
    claimGeneration: claim.claimGeneration,
    claimToken: claim.claimToken,
    auditRootId: payload.auditRootId,
    rootHash: payload.rootHash,
    anchorKey: payload.anchorKey,
    signatureHash: anchor.document.signatureHash,
    auditSigningKeyGeneration: payload.auditSigningKeyGeneration,
    auditSigningPublicKeyHash: anchor.auditSigningPublicKeyHash,
    documentSha256,
    documentByteLength: anchor.bytes.byteLength,
  });
  const requireLeaseBudget = (requiredMs: number) => {
    if (Date.parse(claim.leaseExpiresAt) - now().getTime() < requiredMs) {
      throw new MaintenanceRetryableWorkError("maintenance claim has insufficient lease budget");
    }
  };
  requireLeaseBudget(
    runtimeAttemptTimeoutMs * retryAttempts * 3 +
      gatewayAttemptTimeoutMs * (retryAttempts + 1) + leaseSafetyMs,
  );
  const uploadTicket = parseAuditTicketResult({
    value: await retryExact(
      () => runtime.post("/v1/maintenance/media/upload-ticket", ticketBody("ANCHOR"), {
        signal: AbortSignal.timeout(runtimeAttemptTimeoutMs),
      }),
      retryAttempts,
    ),
    claim,
    operation: "ANCHOR",
    documentSha256,
    documentByteLength: anchor.bytes.byteLength,
    signatureHash: anchor.document.signatureHash,
    auditSigningPublicKeyHash: anchor.auditSigningPublicKeyHash,
    now: now(),
  });

  // A transport error is ambiguous: the immutable object may already exist. Do
  // not blindly repeat a no-overwrite PUT; the verify step safely establishes it.
  let uploadFailureWasAmbiguous = false;
  try {
    await gateway.putObject(Object.freeze({
      ticketHeader: encodeSignedHeader(uploadTicket.ticket),
      contentType: "application/json",
      bytes: anchor.bytes,
    }), { signal: AbortSignal.timeout(gatewayAttemptTimeoutMs) });
  } catch (error) {
    if (!safeToVerifyAfterAnchorUploadFailure(error)) throw error;
    uploadFailureWasAmbiguous = retryable(error);
  }

  const verifyTicket = parseAuditTicketResult({
    value: await retryExact(
      () => runtime.post("/v1/maintenance/media/verify-ticket", ticketBody("ANCHOR_VERIFY"), {
        signal: AbortSignal.timeout(runtimeAttemptTimeoutMs),
      }),
      retryAttempts,
    ),
    claim,
    operation: "ANCHOR_VERIFY",
    documentSha256,
    documentByteLength: anchor.bytes.byteLength,
    signatureHash: anchor.document.signatureHash,
    auditSigningPublicKeyHash: anchor.auditSigningPublicKeyHash,
    now: now(),
  });
  if (verifyTicket.ticketId === uploadTicket.ticketId) {
    throw new TypeError("audit upload and verify tickets must be distinct");
  }
  let receiptValue: unknown;
  try {
    receiptValue = await retryExact(
      () => gateway.verifyObject(Object.freeze({
        ticketHeader: encodeSignedHeader(verifyTicket.ticket),
      }), { signal: AbortSignal.timeout(gatewayAttemptTimeoutMs) }),
      retryAttempts,
    );
  } catch (error) {
    const status = error && typeof error === "object"
      ? (error as { status?: unknown }).status
      : null;
    if (uploadFailureWasAmbiguous && status === 404) {
      throw new MaintenanceRetryableWorkError(
        "audit anchor is missing after ambiguous upload",
      );
    }
    throw error;
  }
  const receipt = await parseAuditReceipt({
    value: receiptValue,
    claim,
    verifyTicket,
    signatureHash: anchor.document.signatureHash,
  });
  const completionBody = Object.freeze({
    version: 1,
    workItemId: claim.workItemId,
    claimGeneration: claim.claimGeneration,
    claimToken: claim.claimToken,
    verifyTicketJti: verifyTicket.ticketId,
    gatewayReceipt: receipt,
  });
  const result = await retryExact(
    () => runtime.post("/v1/maintenance/work/complete", completionBody, {
      signal: AbortSignal.timeout(runtimeAttemptTimeoutMs),
    }),
    retryAttempts,
  );
  return parseAcknowledgement(result, payload.auditRootId);
}
