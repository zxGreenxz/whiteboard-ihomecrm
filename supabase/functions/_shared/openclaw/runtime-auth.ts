import {
  base64UrlDecode,
  base64UrlEncode,
  canonicalJson,
  sha256Hex,
  signHmacSha256,
  utf8,
  verifyHmacSha256,
} from "./crypto.ts";
import {
  OPENCLAW_CLOCK_DRIFT_BREAKER_SECONDS,
  OPENCLAW_CLOCK_DRIFT_BREAKER_WINDOW_SECONDS,
  OPENCLAW_REQUEST_CLOCK_SKEW_SECONDS,
  OPENCLAW_RUNTIME_TOKEN_TTL_SECONDS,
} from "./constants.ts";
import { OpenClawHttpError } from "./errors.ts";
import type {
  RuntimePrincipal,
  RuntimeRequirement,
  RuntimeVerification,
} from "./types.ts";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

const ROUTES = new Map<string, RuntimeRequirement>([
  ["POST /v1/heartbeat", { operation: "heartbeat", principalKind: "CHANNEL" }],
  ["POST /v1/qr/publish", { operation: "qr.publish", principalKind: "CHANNEL" }],
  ["POST /v1/qr/result", { operation: "qr.result", principalKind: "CHANNEL" }],
  ["POST /v1/inbound/batch", { operation: "inbound.commit", principalKind: "CHANNEL" }],
  ["POST /v1/outbox/claim", { operation: "outbox.claim", principalKind: "CHANNEL" }],
  ["POST /v1/outbox/preflight", { operation: "outbox.preflight", principalKind: "CHANNEL" }],
  ["POST /v1/outbox/authorize-send", { operation: "outbox.authorize-send", principalKind: "CHANNEL" }],
  ["POST /v1/outbox/requeue", { operation: "outbox.requeue", principalKind: "CHANNEL" }],
  ["POST /v1/outbox/complete", { operation: "outbox.complete", principalKind: "CHANNEL" }],
  ["POST /v1/work/claim", { operation: "work.claim", principalKind: "CHANNEL" }],
  ["POST /v1/work/complete", { operation: "work.complete", principalKind: "CHANNEL" }],
  ["POST /v1/work/create-outbox", { operation: "work.complete", principalKind: "CHANNEL" }],
  ["POST /v1/media/upload-ticket", { operation: "media.issue", principalKind: "CHANNEL" }],
  ["POST /v1/maintenance/work/claim", { operation: "maintenance.claim", principalKind: "MAINTENANCE" }],
  ["POST /v1/maintenance/work/complete", { operation: "maintenance.complete", principalKind: "MAINTENANCE" }],
  ["POST /v1/maintenance/media/upload-ticket", { operation: "maintenance.complete", principalKind: "MAINTENANCE" }],
  ["POST /v1/maintenance/media/verify-ticket", { operation: "maintenance.complete", principalKind: "MAINTENANCE" }],
  ["POST /v1/maintenance/retention/delete-ticket", { operation: "maintenance.complete", principalKind: "MAINTENANCE" }],
  ["POST /v1/maintenance/retention/authorize-delete", { operation: "maintenance.complete", principalKind: "MAINTENANCE" }],
]);

const CHANNEL_WORK_KINDS = new Set([
  "INBOUND_AUTOMATION",
  "SCHEDULE_OCCURRENCE",
  "CRM_EVENT",
]);
const MAINTENANCE_WORK_KINDS = new Set(["RETENTION_DELETE", "AUDIT_ANCHOR"]);

export class RuntimeClockDriftCircuit {
  #violationStartedAtDatabaseEpochSeconds: number | null = null;

  observe({
    localEpochSeconds,
    databaseEpochSeconds,
  }: {
    localEpochSeconds: number;
    databaseEpochSeconds: number;
  }): { open: boolean; driftSeconds: number } {
    if (!Number.isFinite(localEpochSeconds) || !Number.isFinite(databaseEpochSeconds)) {
      throw new Error("Clock observation is invalid.");
    }
    const driftSeconds = Math.abs(databaseEpochSeconds - localEpochSeconds);
    if (driftSeconds <= OPENCLAW_CLOCK_DRIFT_BREAKER_SECONDS) {
      this.#violationStartedAtDatabaseEpochSeconds = null;
      return { open: false, driftSeconds };
    }
    if (
      this.#violationStartedAtDatabaseEpochSeconds === null ||
      databaseEpochSeconds < this.#violationStartedAtDatabaseEpochSeconds
    ) {
      this.#violationStartedAtDatabaseEpochSeconds = databaseEpochSeconds;
    }
    return {
      open: databaseEpochSeconds - this.#violationStartedAtDatabaseEpochSeconds >=
        OPENCLAW_CLOCK_DRIFT_BREAKER_WINDOW_SECONDS,
      driftSeconds,
    };
  }
}

interface RuntimeTokenPayload {
  version: 1;
  audience: "openclaw-runtime-channel" | "openclaw-runtime-maintenance";
  operation: string;
  method: string;
  path: string;
  iat: number;
  exp: number;
  timestamp: number;
  nonce: string;
  bodySha256: string;
  principal: RuntimePrincipal;
}

interface IssueRuntimeTokenInput {
  principal: RuntimePrincipal;
  method: string;
  path: string;
  body: Uint8Array;
  routeBody?: unknown;
  timestamp: number;
  nonce: string;
  signingKey: Uint8Array;
  nowEpochSeconds: number;
  ttlSeconds?: number;
}

type RuntimeEnvelopeInput = Pick<
  IssueRuntimeTokenInput,
  "method" | "path" | "routeBody" | "timestamp" | "nonce" | "nowEpochSeconds" | "ttlSeconds"
>;

function authError(code: string, message: string, status = 403): OpenClawHttpError {
  return new OpenClawHttpError(status, code, message);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function positiveInteger(value: unknown, allowZero = false): value is number {
  return Number.isSafeInteger(value) && (allowZero ? Number(value) >= 0 : Number(value) > 0);
}

function assertPrincipal(value: unknown): asserts value is RuntimePrincipal {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw authError("PRINCIPAL_INVALID", "Runtime principal is invalid.");
  }
  const principal = value as Record<string, unknown>;
  if (
    principal.version !== 1 ||
    typeof principal.organizationId !== "string" ||
    !UUID_PATTERN.test(principal.organizationId) ||
    !positiveInteger(principal.credentialGeneration) ||
    !positiveInteger(principal.leaseGeneration) ||
    !positiveInteger(principal.fencingToken)
  ) {
    throw authError("PRINCIPAL_INVALID", "Runtime principal is invalid.");
  }
  if (principal.principalKind === "CHANNEL") {
    if (
      !exactKeys(principal, [
        "version",
        "principalKind",
        "organizationId",
        "accountId",
        "cellId",
        "credentialGeneration",
        "leaseGeneration",
        "fencingToken",
        "sessionGeneration",
      ]) ||
      typeof principal.accountId !== "string" ||
      !UUID_PATTERN.test(principal.accountId) ||
      typeof principal.cellId !== "string" ||
      !UUID_PATTERN.test(principal.cellId) ||
      !positiveInteger(principal.sessionGeneration, true)
    ) {
      throw authError("PRINCIPAL_INVALID", "Channel principal is invalid.");
    }
    return;
  }
  if (principal.principalKind === "MAINTENANCE") {
    if (
      !exactKeys(principal, [
        "version",
        "principalKind",
        "organizationId",
        "maintenancePrincipalId",
        "credentialGeneration",
        "leaseGeneration",
        "fencingToken",
      ]) ||
      typeof principal.maintenancePrincipalId !== "string" ||
      !UUID_PATTERN.test(principal.maintenancePrincipalId)
    ) {
      throw authError("PRINCIPAL_INVALID", "Maintenance principal is invalid.");
    }
    return;
  }
  throw authError("PRINCIPAL_INVALID", "Runtime principal kind is invalid.");
}

function requestedKinds(body: unknown): string[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) return [];
  const value = (body as Record<string, unknown>).requestedKinds;
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? value
    : [];
}

export function deriveRuntimeRequirement({
  method,
  path,
  body,
}: {
  method: string;
  path: string;
  body: unknown;
}): RuntimeRequirement {
  if (path.includes("?") || path.includes("#")) {
    throw authError("ROUTE_NOT_FOUND", "Runtime route is not allowed.", 404);
  }
  const requirement = ROUTES.get(`${method} ${path}`);
  if (!requirement) {
    throw authError("ROUTE_NOT_FOUND", "Runtime route is not allowed.", 404);
  }
  if (path === "/v1/work/claim") {
    const kinds = requestedKinds(body);
    if (kinds.length === 0 || kinds.some((kind) => !CHANNEL_WORK_KINDS.has(kind))) {
      throw authError("WORK_KIND_DENIED", "Channel work kind is not allowed.");
    }
  }
  if (path === "/v1/maintenance/work/claim") {
    const kinds = requestedKinds(body);
    if (kinds.length === 0 || kinds.some((kind) => !MAINTENANCE_WORK_KINDS.has(kind))) {
      throw authError("WORK_KIND_DENIED", "Maintenance work kind is not allowed.");
    }
  }
  return { ...requirement };
}

function validateRuntimeEnvelope(input: RuntimeEnvelopeInput): RuntimeRequirement {
  const requirement = deriveRuntimeRequirement({
    method: input.method,
    path: input.path,
    body: input.routeBody ?? {},
  });
  if (!Number.isSafeInteger(input.nowEpochSeconds) ||
      !Number.isSafeInteger(input.timestamp) ||
      Math.abs(input.nowEpochSeconds - input.timestamp) > OPENCLAW_REQUEST_CLOCK_SKEW_SECONDS) {
    throw authError("CLOCK_SKEW", "Runtime request clock skew is too large.");
  }
  if (typeof input.nonce !== "string" || !UUID_PATTERN.test(input.nonce)) {
    throw authError("NONCE_INVALID", "Runtime nonce is invalid.");
  }
  const ttl = input.ttlSeconds ?? OPENCLAW_RUNTIME_TOKEN_TTL_SECONDS;
  if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > OPENCLAW_RUNTIME_TOKEN_TTL_SECONDS) {
    throw authError("TOKEN_TTL_INVALID", "Runtime token TTL is invalid.");
  }
  return requirement;
}

function validateIssueInput(input: IssueRuntimeTokenInput): RuntimeRequirement {
  assertPrincipal(input.principal);
  const requirement = validateRuntimeEnvelope(input);
  if (input.principal.principalKind !== requirement.principalKind) {
    throw authError("PRINCIPAL_ROUTE_MISMATCH", "Principal does not match the route.");
  }
  return requirement;
}

function assertPrincipalSelector(
  value: unknown,
  principalKind: RuntimeRequirement["principalKind"],
): asserts value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw authError("CREDENTIAL_SELECTOR_INVALID", "Credential selector is invalid.");
  }
  const selector = value as Record<string, unknown>;
  const keys = principalKind === "CHANNEL"
    ? ["organizationId", "accountId", "cellId"]
    : ["organizationId", "maintenancePrincipalId"];
  if (
    !exactKeys(selector, keys) ||
    keys.some((key) => typeof selector[key] !== "string" || !UUID_PATTERN.test(selector[key]))
  ) {
    throw authError("CREDENTIAL_SELECTOR_INVALID", "Credential selector is invalid.");
  }
}

export async function issueRuntimeToken(input: IssueRuntimeTokenInput): Promise<string> {
  const requirement = validateIssueInput(input);
  const ttl = input.ttlSeconds ?? OPENCLAW_RUNTIME_TOKEN_TTL_SECONDS;
  const payload: RuntimeTokenPayload = {
    version: 1,
    audience: input.principal.principalKind === "CHANNEL"
      ? "openclaw-runtime-channel"
      : "openclaw-runtime-maintenance",
    operation: requirement.operation,
    method: input.method,
    path: input.path,
    iat: input.nowEpochSeconds,
    exp: input.nowEpochSeconds + ttl,
    timestamp: input.timestamp,
    nonce: input.nonce,
    bodySha256: await sha256Hex(input.body),
    principal: input.principal,
  };
  const header = { alg: "HS256", typ: "JWT", kid: "openclaw-runtime-v1" };
  const encodedHeader = base64UrlEncode(utf8(canonicalJson(header)));
  const encodedPayload = base64UrlEncode(utf8(canonicalJson(payload)));
  const signingInput = utf8(`${encodedHeader}.${encodedPayload}`);
  const signature = await signHmacSha256(input.signingKey, signingInput);
  return `${encodedHeader}.${encodedPayload}.${base64UrlEncode(signature)}`;
}

function parseTokenPayload(token: string): {
  encodedHeader: string;
  encodedPayload: string;
  signature: Uint8Array;
  payload: RuntimeTokenPayload;
} {
  const parts = token.split(".");
  if (parts.length !== 3) throw authError("TOKEN_INVALID", "Runtime token is invalid.");
  let header: unknown;
  let payload: unknown;
  let signature: Uint8Array;
  try {
    header = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[0])));
    payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[1])));
    signature = base64UrlDecode(parts[2]);
  } catch {
    throw authError("TOKEN_INVALID", "Runtime token is invalid.");
  }
  if (
    !header ||
    typeof header !== "object" ||
    Array.isArray(header) ||
    !exactKeys(header as Record<string, unknown>, ["alg", "typ", "kid"]) ||
    (header as Record<string, unknown>).alg !== "HS256" ||
    (header as Record<string, unknown>).typ !== "JWT" ||
    (header as Record<string, unknown>).kid !== "openclaw-runtime-v1"
  ) {
    throw authError("TOKEN_INVALID", "Runtime token header is invalid.");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw authError("TOKEN_INVALID", "Runtime token payload is invalid.");
  }
  const record = payload as Record<string, unknown>;
  if (!exactKeys(record, [
    "version",
    "audience",
    "operation",
    "method",
    "path",
    "iat",
    "exp",
    "timestamp",
    "nonce",
    "bodySha256",
    "principal",
  ])) {
    throw authError("TOKEN_INVALID", "Runtime token payload is not strict.");
  }
  assertPrincipal(record.principal);
  return {
    encodedHeader: parts[0],
    encodedPayload: parts[1],
    signature,
    payload: record as unknown as RuntimeTokenPayload,
  };
}

export async function verifyRuntimeRequest({
  token,
  method,
  path,
  body,
  routeBody = {},
  timestamp,
  nonce,
  signingKey,
  nowEpochSeconds,
  origin = null,
  revalidatePrincipal,
  consumeNonce,
}: {
  token: string;
  method: string;
  path: string;
  body: Uint8Array;
  routeBody?: unknown;
  timestamp: number;
  nonce: string;
  signingKey: Uint8Array;
  nowEpochSeconds: number;
  origin?: string | null;
  revalidatePrincipal: (principal: RuntimePrincipal, operation: string) => Promise<RuntimePrincipal>;
  consumeNonce: (context: RuntimeVerification) => Promise<void>;
}): Promise<RuntimeVerification> {
  if (origin !== null) {
    throw authError("BROWSER_ORIGIN_FORBIDDEN", "Runtime endpoints reject browser origins.");
  }
  if (!Number.isSafeInteger(nowEpochSeconds) || !Number.isSafeInteger(timestamp)) {
    throw authError("CLOCK_INVALID", "Runtime request clock is invalid.");
  }
  const parsed = parseTokenPayload(token);
  const validSignature = await verifyHmacSha256(
    signingKey,
    utf8(`${parsed.encodedHeader}.${parsed.encodedPayload}`),
    parsed.signature,
  );
  if (!validSignature) throw authError("TOKEN_SIGNATURE_INVALID", "Runtime token signature is invalid.");

  const payload = parsed.payload;
  const requirement = deriveRuntimeRequirement({ method, path, body: routeBody });
  const expectedAudience = requirement.principalKind === "CHANNEL"
    ? "openclaw-runtime-channel"
    : "openclaw-runtime-maintenance";
  if (
    payload.version !== 1 ||
    payload.audience !== expectedAudience ||
    payload.operation !== requirement.operation ||
    payload.method !== method ||
    payload.path !== path ||
    payload.timestamp !== timestamp ||
    payload.nonce !== nonce ||
    payload.principal.principalKind !== requirement.principalKind
  ) {
    throw authError("TOKEN_BINDING_INVALID", "Runtime token binding is invalid.");
  }
  if (
    !Number.isSafeInteger(payload.iat) ||
    !Number.isSafeInteger(payload.exp) ||
    payload.exp <= payload.iat ||
    payload.exp - payload.iat > OPENCLAW_RUNTIME_TOKEN_TTL_SECONDS ||
    nowEpochSeconds < payload.iat - OPENCLAW_REQUEST_CLOCK_SKEW_SECONDS ||
    nowEpochSeconds >= payload.exp ||
    Math.abs(nowEpochSeconds - timestamp) > OPENCLAW_REQUEST_CLOCK_SKEW_SECONDS
  ) {
    throw authError("TOKEN_EXPIRED", "Runtime token is expired or outside the clock window.");
  }
  const bodySha256 = await sha256Hex(body);
  if (!SHA256_PATTERN.test(payload.bodySha256) || payload.bodySha256 !== bodySha256) {
    throw authError("BODY_HASH_INVALID", "Runtime request body hash is invalid.");
  }
  const currentPrincipal = await revalidatePrincipal(payload.principal, requirement.operation);
  assertPrincipal(currentPrincipal);
  if (canonicalJson(currentPrincipal) !== canonicalJson(payload.principal)) {
    throw authError("PRINCIPAL_STALE", "Runtime principal generation is stale.");
  }
  const verification: RuntimeVerification = {
    operation: requirement.operation,
    principal: currentPrincipal,
    nonce,
    bodySha256,
  };
  await consumeNonce(verification);
  return verification;
}

export async function exchangeRuntimeCredential({
  credential,
  method,
  path,
  body,
  routeBody = {},
  timestamp,
  nonce,
  principalSelector,
  signingKey,
  nowEpochSeconds,
  origin = null,
  authenticateCredential,
}: {
  credential: string;
  method: string;
  path: string;
  body: Uint8Array;
  routeBody?: unknown;
  timestamp: number;
  nonce: string;
  principalSelector: Record<string, string>;
  signingKey: Uint8Array;
  nowEpochSeconds: number;
  origin?: string | null;
  authenticateCredential: (
    credential: string,
    selector: Record<string, string>,
    operation: string,
  ) => Promise<RuntimePrincipal>;
}): Promise<string> {
  if (origin !== null) {
    throw authError("BROWSER_ORIGIN_FORBIDDEN", "Runtime endpoints reject browser origins.");
  }
  if (typeof credential !== "string" || credential.length < 24 || credential.length > 512) {
    throw authError("CREDENTIAL_INVALID", "Runtime credential is invalid.");
  }
  const requirement = validateRuntimeEnvelope({
    method,
    path,
    routeBody,
    timestamp,
    nonce,
    nowEpochSeconds,
  });
  assertPrincipalSelector(principalSelector, requirement.principalKind);
  const principal = await authenticateCredential(
    credential,
    principalSelector,
    requirement.operation,
  );
  assertPrincipal(principal);
  if (principal.organizationId !== principalSelector.organizationId) {
    throw authError("CREDENTIAL_SELECTOR_MISMATCH", "Credential selector does not match.");
  }
  if (
    principal.principalKind === "CHANNEL" &&
    (principal.accountId !== principalSelector.accountId ||
      principal.cellId !== principalSelector.cellId)
  ) {
    throw authError("CREDENTIAL_SELECTOR_MISMATCH", "Credential selector does not match.");
  }
  if (
    principal.principalKind === "MAINTENANCE" &&
    principal.maintenancePrincipalId !== principalSelector.maintenancePrincipalId
  ) {
    throw authError("CREDENTIAL_SELECTOR_MISMATCH", "Credential selector does not match.");
  }
  return issueRuntimeToken({
    principal,
    method,
    path,
    body,
    routeBody,
    timestamp,
    nonce,
    signingKey,
    nowEpochSeconds,
  });
}
