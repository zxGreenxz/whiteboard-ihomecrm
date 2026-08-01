/**
 * Ticket verification inside the Worker.
 *
 * A ticket alone is never sufficient for a browser request: the caller must also
 * present the same live Supabase JWT that the ticket was minted for. The Worker
 * recomputes both hashes and checks the generation floor before touching R2.
 */

export const MEDIA_TICKET_AUDIENCE = "openclaw-media-gateway";
export const REVOCATION_AUDIENCE = "openclaw-media-revocation";
export const REVOCATION_OPERATION = "generation.revoke";
export const MAX_TICKET_TTL_SECONDS = 60;
export const REVOCATION_SKEW_SECONDS = 60;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_CONTENT_LENGTH = 52_428_800;

const COMMON_TICKET_KEYS = [
  "version", "aud", "operation", "subject", "jti", "organizationId", "accountId",
  "objectKey", "sha256", "contentType", "contentLength", "sessionGeneration",
  "gatewayKeyGeneration", "iat", "exp",
] as const;
const BROWSER_TICKET_KEYS = [
  ...COMMON_TICKET_KEYS,
  "browserUserId", "browserSessionIdSha256", "browserAccessTokenSha256",
] as const;
const RUNTIME_TICKET_KEYS = [
  ...COMMON_TICKET_KEYS,
  "cellId", "credentialGeneration", "leaseGeneration", "fencingToken",
  "receiptSigningKeyGeneration",
] as const;
const MAINTENANCE_TICKET_KEYS = [
  ...COMMON_TICKET_KEYS,
  "maintenancePrincipalId", "workItemId", "claimGeneration", "credentialGeneration",
  "leaseGeneration", "fencingToken", "receiptSigningKeyGeneration",
] as const;
const DELETE_TICKET_KEYS = [
  ...MAINTENANCE_TICKET_KEYS,
  "deletePhase", "quarantineVersion", "finalDeleteNotBefore", "holdVersion",
] as const;
const AUDIT_TICKET_KEYS = [
  ...MAINTENANCE_TICKET_KEYS,
  "auditRootId", "rootHash", "signatureHash", "auditSigningKeyGeneration",
  "auditSigningPublicKeyHash",
] as const;
const MAINTENANCE_RECOVERY_TICKET_KEYS = [
  ...COMMON_TICKET_KEYS,
  "maintenancePrincipalId", "workItemId", "credentialGeneration", "leaseGeneration",
  "fencingToken", "receiptSigningKeyGeneration", "recoveryKind", "recoveryGeneration",
  "frozenClaim",
] as const;
const DELETE_RECOVERY_TICKET_KEYS = [
  ...MAINTENANCE_RECOVERY_TICKET_KEYS,
  "replacesTicketJti", "replacesDeleteAuthorizationJti", "deletePhase", "quarantineVersion",
  "finalDeleteNotBefore", "holdVersion",
] as const;
const AUDIT_VERIFY_RECOVERY_TICKET_KEYS = [
  ...MAINTENANCE_RECOVERY_TICKET_KEYS,
  "replacesVerifyTicketJti", "auditRootId", "rootHash", "signatureHash",
  "auditSigningKeyGeneration", "auditSigningPublicKeyHash",
] as const;

export interface FrozenMaintenanceClaim {
  maintenancePrincipalId: string;
  credentialGeneration: number;
  leaseGeneration: number;
  fencingToken: number;
  claimGeneration: number;
}

export type TicketOperation = "PUT" | "GET" | "DELETE" | "ANCHOR" | "ANCHOR_VERIFY";
export type TicketOperationExpectation = TicketOperation | readonly TicketOperation[];
export type TicketSubject = "BROWSER" | "RUNTIME" | "MAINTENANCE";

export interface MediaTicketClaims {
  version: 1;
  aud: typeof MEDIA_TICKET_AUDIENCE;
  operation: TicketOperation;
  subject: TicketSubject;
  jti: string;
  organizationId: string;
  accountId: string | null;
  objectKey: string;
  sha256: string;
  contentType: string;
  contentLength: number;
  sessionGeneration: number;
  gatewayKeyGeneration: number;
  receiptSigningKeyGeneration?: number;
  iat: number;
  exp: number;
  /** Browser tickets only: SHA-256 of the JWT session id and of the token. */
  browserUserId?: string;
  browserSessionIdSha256?: string;
  browserAccessTokenSha256?: string;
  /** Retention tickets only. */
  deletePhase?: "QUARANTINE" | "FINAL_DELETE";
  quarantineVersion?: number;
  finalDeleteNotBefore?: number;
  /** Runtime principal binding. */
  cellId?: string;
  credentialGeneration?: number;
  leaseGeneration?: number;
  fencingToken?: number;
  /** Maintenance work binding used for receipts and replay recovery. */
  maintenancePrincipalId?: string;
  workItemId?: string;
  claimGeneration?: number;
  holdVersion?: number;
  /** Audit-anchor verification binding. */
  auditRootId?: string;
  rootHash?: string;
  signatureHash?: string;
  auditSigningKeyGeneration?: number;
  auditSigningPublicKeyHash?: string;
  /** Recovery refresh uses current admission fields and freezes receipt lineage here. */
  recoveryKind?: "RETENTION_DELETE_AUTHORIZED" | "AUDIT_VERIFY_AUTHORIZED";
  recoveryGeneration?: number;
  replacesTicketJti?: string;
  replacesDeleteAuthorizationJti?: string;
  replacesVerifyTicketJti?: string;
  frozenClaim?: FrozenMaintenanceClaim;
}

export type TicketFailure =
  | "TICKET_MALFORMED"
  | "TICKET_AUDIENCE"
  | "TICKET_OPERATION"
  | "TICKET_TTL"
  | "TICKET_EXPIRED"
  | "TICKET_KEY_MISMATCH"
  | "TICKET_TENANT_MISMATCH"
  | "TICKET_REPLAY"
  | "TICKET_GENERATION_REVOKED"
  | "BROWSER_PROOF_MISSING"
  | "BROWSER_PROOF_MISMATCH"
  | "DELETE_PHASE_INVALID"
  | "DELETE_AUTHORIZATION_REQUIRED";

export interface TicketVerdict {
  ok: boolean;
  failure?: TicketFailure;
}

export interface TicketGenerationFloors {
  sessionGeneration: number;
  credentialGeneration: number;
  leaseGeneration: number;
  fencingToken: number;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const target = [...expected].sort();
  return actual.length === target.length && actual.every((key, index) => key === target[index]);
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}

function frozenMaintenanceClaim(value: unknown): value is FrozenMaintenanceClaim {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const claim = value as Record<string, unknown>;
  return exactKeys(claim, [
    "maintenancePrincipalId", "credentialGeneration", "leaseGeneration", "fencingToken",
    "claimGeneration",
  ]) && typeof claim.maintenancePrincipalId === "string" &&
    UUID_PATTERN.test(claim.maintenancePrincipalId) &&
    positiveInteger(claim.credentialGeneration) && positiveInteger(claim.leaseGeneration) &&
    positiveInteger(claim.fencingToken) && positiveInteger(claim.claimGeneration);
}

function ok(): TicketVerdict {
  return { ok: true };
}

function fail(failure: TicketFailure): TicketVerdict {
  return { ok: false, failure };
}

export function validateTicketShape(value: unknown): value is MediaTicketClaims {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const claims = value as Record<string, unknown>;
  const commonValid =
    claims.version === 1 &&
    claims.aud === MEDIA_TICKET_AUDIENCE &&
    typeof claims.operation === "string" &&
    ["PUT", "GET", "DELETE", "ANCHOR", "ANCHOR_VERIFY"].includes(claims.operation) &&
    typeof claims.subject === "string" &&
    ["BROWSER", "RUNTIME", "MAINTENANCE"].includes(claims.subject) &&
    typeof claims.jti === "string" && UUID_PATTERN.test(claims.jti) &&
    typeof claims.organizationId === "string" && UUID_PATTERN.test(claims.organizationId) &&
    (claims.accountId === null ||
      (typeof claims.accountId === "string" && UUID_PATTERN.test(claims.accountId))) &&
    typeof claims.objectKey === "string" &&
    typeof claims.sha256 === "string" && SHA256_PATTERN.test(claims.sha256) &&
    typeof claims.contentType === "string" && claims.contentType.length >= 3 &&
    claims.contentType.length <= 255 &&
    positiveInteger(claims.contentLength) && Number(claims.contentLength) <= MAX_CONTENT_LENGTH &&
    Number.isSafeInteger(claims.sessionGeneration) && Number(claims.sessionGeneration) >= 0 &&
    positiveInteger(claims.gatewayKeyGeneration) &&
    Number.isSafeInteger(claims.iat) &&
    Number.isSafeInteger(claims.exp);
  if (!commonValid) return false;

  if (claims.subject === "BROWSER") {
    return exactKeys(claims, BROWSER_TICKET_KEYS) && claims.operation === "GET" &&
      claims.accountId !== null &&
      typeof claims.browserUserId === "string" && UUID_PATTERN.test(claims.browserUserId) &&
      typeof claims.browserSessionIdSha256 === "string" &&
      SHA256_PATTERN.test(claims.browserSessionIdSha256) &&
      typeof claims.browserAccessTokenSha256 === "string" &&
      SHA256_PATTERN.test(claims.browserAccessTokenSha256);
  }
  if (claims.subject === "RUNTIME") {
    return exactKeys(claims, RUNTIME_TICKET_KEYS) &&
      (claims.operation === "PUT" || claims.operation === "GET") && claims.accountId !== null &&
      positiveInteger(claims.sessionGeneration) &&
      typeof claims.cellId === "string" && UUID_PATTERN.test(claims.cellId) &&
      positiveInteger(claims.credentialGeneration) && positiveInteger(claims.leaseGeneration) &&
      positiveInteger(claims.fencingToken) && positiveInteger(claims.receiptSigningKeyGeneration);
  }
  if (claims.subject !== "MAINTENANCE" || claims.accountId !== null ||
    claims.sessionGeneration !== 0) return false;
  const maintenanceAdmissionValid =
    typeof claims.maintenancePrincipalId === "string" && UUID_PATTERN.test(claims.maintenancePrincipalId) &&
    typeof claims.workItemId === "string" && UUID_PATTERN.test(claims.workItemId) &&
    positiveInteger(claims.credentialGeneration) &&
    positiveInteger(claims.leaseGeneration) && positiveInteger(claims.fencingToken) &&
    positiveInteger(claims.receiptSigningKeyGeneration);
  if (!maintenanceAdmissionValid) return false;
  const recovery = claims.recoveryKind !== undefined;
  if (recovery) {
    if (
      !positiveInteger(claims.recoveryGeneration) ||
      !frozenMaintenanceClaim(claims.frozenClaim)
    ) return false;
    if (claims.operation === "DELETE") {
      return claims.recoveryKind === "RETENTION_DELETE_AUTHORIZED" &&
        exactKeys(claims, DELETE_RECOVERY_TICKET_KEYS) &&
        typeof claims.replacesTicketJti === "string" && UUID_PATTERN.test(claims.replacesTicketJti) &&
        typeof claims.replacesDeleteAuthorizationJti === "string" &&
        UUID_PATTERN.test(claims.replacesDeleteAuthorizationJti) &&
        claims.deletePhase === "FINAL_DELETE" && positiveInteger(claims.quarantineVersion) &&
        Number.isSafeInteger(claims.finalDeleteNotBefore) &&
        Number.isSafeInteger(claims.holdVersion) && Number(claims.holdVersion) >= 0;
    }
    if (claims.operation === "ANCHOR_VERIFY") {
      return claims.recoveryKind === "AUDIT_VERIFY_AUTHORIZED" &&
        exactKeys(claims, AUDIT_VERIFY_RECOVERY_TICKET_KEYS) &&
        typeof claims.replacesVerifyTicketJti === "string" &&
        UUID_PATTERN.test(claims.replacesVerifyTicketJti) &&
        claims.contentType === "application/json" &&
        typeof claims.auditRootId === "string" && UUID_PATTERN.test(claims.auditRootId) &&
        typeof claims.rootHash === "string" && SHA256_PATTERN.test(claims.rootHash) &&
        typeof claims.signatureHash === "string" && SHA256_PATTERN.test(claims.signatureHash) &&
        positiveInteger(claims.auditSigningKeyGeneration) &&
        typeof claims.auditSigningPublicKeyHash === "string" &&
        SHA256_PATTERN.test(claims.auditSigningPublicKeyHash);
    }
    return false;
  }
  if (!positiveInteger(claims.claimGeneration)) return false;
  if (claims.operation === "DELETE") {
    return exactKeys(claims, DELETE_TICKET_KEYS) && claims.deletePhase === "FINAL_DELETE" &&
      positiveInteger(claims.quarantineVersion) &&
      Number.isSafeInteger(claims.finalDeleteNotBefore) &&
      Number.isSafeInteger(claims.holdVersion) && Number(claims.holdVersion) >= 0;
  }
  if (claims.operation === "ANCHOR" || claims.operation === "ANCHOR_VERIFY") {
    return exactKeys(claims, AUDIT_TICKET_KEYS) && claims.contentType === "application/json" &&
      typeof claims.auditRootId === "string" && UUID_PATTERN.test(claims.auditRootId) &&
      typeof claims.rootHash === "string" && SHA256_PATTERN.test(claims.rootHash) &&
      typeof claims.signatureHash === "string" && SHA256_PATTERN.test(claims.signatureHash) &&
      positiveInteger(claims.auditSigningKeyGeneration) &&
      typeof claims.auditSigningPublicKeyHash === "string" &&
      SHA256_PATTERN.test(claims.auditSigningPublicKeyHash);
  }
  return false;
}

export interface BrowserProof {
  userId: string;
  sessionIdSha256: string;
  accessTokenSha256: string;
}

/**
 * Pure verification of everything the Worker can decide without I/O. Signature
 * checking, `jti` consumption, and the generation floor are handled by the
 * caller, which owns the key material and the durable object.
 */
export function evaluateTicket({
  claims,
  nowEpochSeconds,
  expectedOperation,
  expectedObjectKey,
  browserProof,
  minimumGeneration,
  generationFloors,
  deleteAuthorizationPresent,
  ignoreTemporalValidity = false,
}: {
  claims: unknown;
  nowEpochSeconds: number;
  expectedOperation: TicketOperationExpectation;
  expectedObjectKey: string;
  browserProof?: BrowserProof | null;
  minimumGeneration?: number;
  generationFloors?: TicketGenerationFloors;
  deleteAuthorizationPresent?: boolean;
  ignoreTemporalValidity?: boolean;
}): TicketVerdict {
  if (!validateTicketShape(claims)) return fail("TICKET_MALFORMED");
  if (claims.aud !== MEDIA_TICKET_AUDIENCE) return fail("TICKET_AUDIENCE");
  const allowedOperations = Array.isArray(expectedOperation)
    ? expectedOperation as readonly TicketOperation[]
    : [expectedOperation as TicketOperation];
  if (!allowedOperations.includes(claims.operation)) return fail("TICKET_OPERATION");
  if (claims.exp <= claims.iat || claims.exp - claims.iat > MAX_TICKET_TTL_SECONDS) {
    return fail("TICKET_TTL");
  }
  if (!ignoreTemporalValidity &&
    (nowEpochSeconds < claims.iat - 5 || nowEpochSeconds >= claims.exp)) {
    return fail("TICKET_EXPIRED");
  }
  if (claims.objectKey !== expectedObjectKey) return fail("TICKET_KEY_MISMATCH");
  const floors = generationFloors ?? {
    sessionGeneration: minimumGeneration ?? 0,
    credentialGeneration: 0,
    leaseGeneration: 0,
    fencingToken: 0,
  };
  if (claims.sessionGeneration < floors.sessionGeneration) {
    return fail("TICKET_GENERATION_REVOKED");
  }
  if (
    (claims.subject === "RUNTIME" || claims.subject === "MAINTENANCE") &&
    (
      Number(claims.credentialGeneration) < floors.credentialGeneration ||
      Number(claims.leaseGeneration) < floors.leaseGeneration ||
      Number(claims.fencingToken) < floors.fencingToken
    )
  ) return fail("TICKET_GENERATION_REVOKED");

  if (claims.subject === "BROWSER") {
    // A stolen ticket alone is unusable: the live token must match too.
    if (!browserProof) return fail("BROWSER_PROOF_MISSING");
    if (
      claims.browserUserId !== browserProof.userId ||
      claims.browserSessionIdSha256 !== browserProof.sessionIdSha256 ||
      claims.browserAccessTokenSha256 !== browserProof.accessTokenSha256
    ) {
      return fail("BROWSER_PROOF_MISMATCH");
    }
  }

  if (expectedOperation === "DELETE") {
    if (claims.deletePhase !== "FINAL_DELETE") return fail("DELETE_PHASE_INVALID");
    if (
      typeof claims.quarantineVersion !== "number" ||
      claims.quarantineVersion < 1 ||
      typeof claims.finalDeleteNotBefore !== "number" ||
      nowEpochSeconds < claims.finalDeleteNotBefore
    ) {
      return fail("DELETE_PHASE_INVALID");
    }
    // A delete ticket alone is never enough; the five-second authorization proof
    // must accompany it.
    if (!deleteAuthorizationPresent) return fail("DELETE_AUTHORIZATION_REQUIRED");
  }

  return ok();
}

export interface RevocationEnvelope {
  version: 1;
  aud: typeof REVOCATION_AUDIENCE;
  operation: typeof REVOCATION_OPERATION;
  nonce: string;
  issuedAt: number;
  bodySha256: string;
  organizationId: string;
  accountId: string | null;
  sessionGeneration: number;
}

export function validateRevocationEnvelope(
  value: unknown,
  nowEpochSeconds: number,
): { ok: boolean; failure?: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, failure: "ENVELOPE_MALFORMED" };
  }
  const envelope = value as Record<string, unknown>;
  if (envelope.version !== 1) return { ok: false, failure: "ENVELOPE_MALFORMED" };
  if (envelope.aud !== REVOCATION_AUDIENCE) return { ok: false, failure: "ENVELOPE_AUDIENCE" };
  if (envelope.operation !== REVOCATION_OPERATION) {
    return { ok: false, failure: "ENVELOPE_OPERATION" };
  }
  if (typeof envelope.nonce !== "string" || !UUID_PATTERN.test(envelope.nonce)) {
    return { ok: false, failure: "ENVELOPE_NONCE" };
  }
  if (
    typeof envelope.bodySha256 !== "string" || !SHA256_PATTERN.test(envelope.bodySha256)
  ) {
    return { ok: false, failure: "ENVELOPE_BODY_HASH" };
  }
  if (
    typeof envelope.organizationId !== "string" ||
    !UUID_PATTERN.test(envelope.organizationId)
  ) {
    return { ok: false, failure: "ENVELOPE_TENANT" };
  }
  if (
    envelope.accountId !== null &&
    (typeof envelope.accountId !== "string" || !UUID_PATTERN.test(envelope.accountId))
  ) {
    return { ok: false, failure: "ENVELOPE_TENANT" };
  }
  if (
    !Number.isSafeInteger(envelope.sessionGeneration) ||
    Number(envelope.sessionGeneration) < 0
  ) {
    return { ok: false, failure: "ENVELOPE_GENERATION" };
  }
  if (!Number.isSafeInteger(envelope.issuedAt)) {
    return { ok: false, failure: "ENVELOPE_CLOCK" };
  }
  if (Math.abs(nowEpochSeconds - Number(envelope.issuedAt)) > REVOCATION_SKEW_SECONDS) {
    return { ok: false, failure: "ENVELOPE_CLOCK" };
  }
  return { ok: true };
}
