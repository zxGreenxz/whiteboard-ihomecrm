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

export type TicketOperation = "PUT" | "GET" | "DELETE" | "ANCHOR" | "ANCHOR_VERIFY";
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

function ok(): TicketVerdict {
  return { ok: true };
}

function fail(failure: TicketFailure): TicketVerdict {
  return { ok: false, failure };
}

export function validateTicketShape(value: unknown): value is MediaTicketClaims {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const claims = value as Record<string, unknown>;
  return (
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
    typeof claims.contentType === "string" &&
    Number.isSafeInteger(claims.contentLength) &&
    Number.isSafeInteger(claims.sessionGeneration) &&
    Number.isSafeInteger(claims.gatewayKeyGeneration) &&
    Number.isSafeInteger(claims.iat) &&
    Number.isSafeInteger(claims.exp)
  );
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
  deleteAuthorizationPresent,
}: {
  claims: unknown;
  nowEpochSeconds: number;
  expectedOperation: TicketOperation;
  expectedObjectKey: string;
  browserProof?: BrowserProof | null;
  minimumGeneration: number;
  deleteAuthorizationPresent?: boolean;
}): TicketVerdict {
  if (!validateTicketShape(claims)) return fail("TICKET_MALFORMED");
  if (claims.aud !== MEDIA_TICKET_AUDIENCE) return fail("TICKET_AUDIENCE");
  if (claims.operation !== expectedOperation) return fail("TICKET_OPERATION");
  if (claims.exp <= claims.iat || claims.exp - claims.iat > MAX_TICKET_TTL_SECONDS) {
    return fail("TICKET_TTL");
  }
  if (nowEpochSeconds < claims.iat - 5 || nowEpochSeconds >= claims.exp) {
    return fail("TICKET_EXPIRED");
  }
  if (claims.objectKey !== expectedObjectKey) return fail("TICKET_KEY_MISMATCH");
  if (claims.sessionGeneration < minimumGeneration) return fail("TICKET_GENERATION_REVOKED");

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