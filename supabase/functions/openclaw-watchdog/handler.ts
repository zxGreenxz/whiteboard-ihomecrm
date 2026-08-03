import { OPENCLAW_DEFAULT_JSON_LIMIT_BYTES } from "../_shared/openclaw/constants.ts";
import { base64UrlDecode, canonicalJson, sha256Hex, utf8 } from "../_shared/openclaw/crypto.ts";
import { OpenClawHttpError } from "../_shared/openclaw/errors.ts";
import { errorResponse, jsonResponse, readBoundedBody } from "../_shared/openclaw/http.ts";
import { redactLogValue } from "../_shared/openclaw/redaction.ts";
import {
  WATCHDOG_ENVELOPE_AUDIENCE,
  WATCHDOG_ENVELOPE_DOMAIN,
  WATCHDOG_ENVELOPE_HEADER,
  WATCHDOG_ENVELOPE_MAX_SKEW_SECONDS,
  WATCHDOG_ENVELOPE_PATH,
  WATCHDOG_SIGNATURE_HEADER,
  WATCHDOG_SIGNATURE_PATTERN,
  parseWatchdogEnvelopeHeader,
  watchdogEnvelopeOperationFor,
  watchdogRequestSchema,
  type HostGuardRequest,
  type WatchdogControl,
  type WatchdogEnvelope,
  type WatchdogEnvelopeKey,
  type WatchdogHealthEvent,
  type WatchdogRecordRequest,
  type WatchdogRequest,
} from "./schemas.ts";

export const WATCHDOG_HEALTH_RPC = "openclaw_service_record_watchdog_health_v1";
export const WATCHDOG_SNAPSHOT_RPC = "openclaw_service_watchdog_snapshot_v1";
export const WATCHDOG_APPLY_CONTROLS_RPC = "openclaw_service_apply_capacity_controls_v1";
export const WATCHDOG_NONCE_RPC = "openclaw_service_consume_watchdog_envelope_nonce_v1";

export interface WatchdogSnapshot {
  version: 1;
  organizationId: string;
  observedAt: string;
  probeOk: boolean;
  heartbeatAt: string | null;
  metrics: Record<string, number>;
}

export interface ConsumeEnvelopeNonceInput {
  nonce: string;
  organizationId: string;
  operation: WatchdogEnvelope["operation"];
  keyGeneration: number;
  bodySha256: string;
  signedAtEpochSeconds: number;
}

export interface WatchdogDependencies {
  /** Generation -> Ed25519 verification key. Rotation adds a generation; it never edits one. */
  envelopeKeys: Readonly<Record<string, WatchdogEnvelopeKey>>;
  /** Returns false when the nonce was already spent, which rejects the replay. */
  consumeEnvelopeNonce: (input: ConsumeEnvelopeNonceInput) => Promise<boolean>;
  now?: () => Date;
  probe: (
    organizationId: string,
    probeId: string,
    observedAt: string,
    signal: AbortSignal,
  ) => Promise<WatchdogSnapshot>;
  recordHealth: (input: {
    organizationId: string;
    operationId: string;
    observedAt: string;
    events: WatchdogHealthEvent[];
  }) => Promise<{ recorded: number }>;
  applyCapacityControls: (input: {
    organizationId: string;
    operationId: string;
    observedAt: string;
    controls: WatchdogControl[] | ["PAUSE_OUTBOUND_AI_MEDIA"];
    reasonFingerprint: string;
  }) => Promise<void>;
  notifyOwnerAdmins: (input: {
    organizationId: string;
    operationId: string;
    fingerprints: string[];
    repeatWindow: number;
  }) => Promise<{ push: number; email: number }>;
  logger?: { error: (message: string, context: unknown) => void };
  requestIdFactory?: () => string;
}

/** Every envelope failure collapses into one code so the endpoint is not an oracle. */
function envelopeDenied(): OpenClawHttpError {
  return new OpenClawHttpError(
    403,
    "WATCHDOG_ENVELOPE_INVALID",
    "Watchdog envelope verification failed.",
  );
}

function ownedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function base64Decode(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

/**
 * Lifetime windows are compared as instants, not as strings. A lexicographic ISO
 * compare accepts `Date#toISOString` extended years ("+010000-01-01T…"), which sort
 * BEFORE "2026…" and would make a not-yet-active generation look active.
 */
function instant(value: string): number {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw envelopeDenied();
  return milliseconds;
}

function activeKey(
  keys: Readonly<Record<string, WatchdogEnvelopeKey>>,
  envelope: WatchdogEnvelope,
  observedAtMilliseconds: number,
): WatchdogEnvelopeKey {
  const key = keys[String(envelope.keyGeneration)];
  if (
    !key ||
    key.generation !== envelope.keyGeneration ||
    key.organizationId !== envelope.organizationId ||
    !key.allowedOperations.includes(envelope.operation) ||
    observedAtMilliseconds < instant(key.activatesAt) ||
    (key.retiresAt !== null && observedAtMilliseconds >= instant(key.retiresAt)) ||
    (key.revokedAt !== null && observedAtMilliseconds >= instant(key.revokedAt))
  ) {
    throw envelopeDenied();
  }
  return key;
}

/**
 * Binds the verified envelope to the parsed body. Split from signature
 * verification so authentication runs BEFORE the body is parsed: otherwise an
 * unauthenticated caller learns 400/413/415 schema outcomes and spends parse work.
 */
export function assertWatchdogEnvelopeBodyBinding(
  envelope: WatchdogEnvelope,
  body: WatchdogRequest,
): void {
  if (
    envelope.operation !== watchdogEnvelopeOperationFor(body.operation) ||
    envelope.organizationId !== body.organizationId
  ) {
    throw envelopeDenied();
  }
}

/**
 * Verification order is deliberate: cheap structural binding, then the key
 * generation, then the clock, then the body digest, then Ed25519, and only then
 * the one-time nonce. The nonce store is the only database touch, and it happens
 * after the signature is proven, so an unauthenticated caller reaches no facade.
 */
export async function verifyWatchdogEnvelope(
  request: Request,
  rawBody: Uint8Array,
  dependencies: WatchdogDependencies,
): Promise<WatchdogEnvelope> {
  const signature = request.headers.get(WATCHDOG_SIGNATURE_HEADER);
  const rawEnvelope = request.headers.get(WATCHDOG_ENVELOPE_HEADER);
  // Absent credential is 401; a presented-but-wrong credential is always 403, so
  // "no envelope" and "envelope for another audience" never look the same.
  if (rawEnvelope === null || signature === null) {
    throw new OpenClawHttpError(
      401,
      "WATCHDOG_AUTH_REQUIRED",
      "Watchdog envelope authentication is required.",
    );
  }
  const envelope = parseWatchdogEnvelopeHeader(rawEnvelope);
  if (envelope === null || !WATCHDOG_SIGNATURE_PATTERN.test(signature)) throw envelopeDenied();

  const url = new URL(request.url);
  if (
    envelope.audience !== WATCHDOG_ENVELOPE_AUDIENCE ||
    envelope.method !== request.method ||
    envelope.path !== WATCHDOG_ENVELOPE_PATH ||
    url.pathname.replace(/\/$/u, "") !== WATCHDOG_ENVELOPE_PATH
  ) {
    throw envelopeDenied();
  }

  const now = dependencies.now?.() ?? new Date();
  const nowEpochSeconds = Math.floor(now.getTime() / 1_000);
  const key = activeKey(dependencies.envelopeKeys, envelope, now.getTime());
  if (Math.abs(nowEpochSeconds - envelope.timestamp) > WATCHDOG_ENVELOPE_MAX_SKEW_SECONDS) {
    throw envelopeDenied();
  }
  if (envelope.bodySha256 !== await sha256Hex(rawBody)) throw envelopeDenied();

  let verified = false;
  try {
    const publicKey = await crypto.subtle.importKey(
      "spki",
      ownedArrayBuffer(base64Decode(key.publicKeySpkiBase64)),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    verified = await crypto.subtle.verify(
      "Ed25519",
      publicKey,
      ownedArrayBuffer(base64UrlDecode(signature)),
      ownedArrayBuffer(utf8(`${WATCHDOG_ENVELOPE_DOMAIN}\0${canonicalJson(envelope)}`)),
    );
  } catch {
    throw envelopeDenied();
  }
  if (!verified) throw envelopeDenied();

  const consumed = await dependencies.consumeEnvelopeNonce({
    nonce: envelope.nonce,
    organizationId: envelope.organizationId,
    operation: envelope.operation,
    keyGeneration: envelope.keyGeneration,
    bodySha256: envelope.bodySha256,
    signedAtEpochSeconds: envelope.timestamp,
  });
  if (!consumed) throw envelopeDenied();
  return envelope;
}

const REQUEST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/** Parses an ALREADY AUTHENTICATED body; the digest was bound by the envelope. */
function parseVerifiedBody(
  rawBody: Uint8Array,
  request: Request,
  dependencies: WatchdogDependencies,
): { data: WatchdogRequest; requestId: string } {
  if (request.headers.get("content-type")?.trim().toLowerCase() !== "application/json") {
    throw new OpenClawHttpError(415, "CONTENT_TYPE_REQUIRED", "Content-Type must be application/json.");
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawBody));
  } catch {
    throw new OpenClawHttpError(400, "INVALID_JSON", "Request body is not valid JSON.");
  }
  const result = watchdogRequestSchema.safeParse(value);
  if (!result.success) {
    throw new OpenClawHttpError(400, "INVALID_REQUEST", "Request schema is invalid.");
  }
  const supplied = request.headers.get("x-request-id")?.toLowerCase();
  return {
    data: result.data,
    requestId: supplied && REQUEST_ID_PATTERN.test(supplied)
      ? supplied
      : (dependencies.requestIdFactory ?? (() => crypto.randomUUID()))(),
  };
}

function hostGuardEvent(request: HostGuardRequest): WatchdogHealthEvent {
  return {
    accountId: null,
    cellId: request.cellId,
    severity: request.state === "CLEAR_PENDING" ? "INFO" : "CRITICAL",
    healthKind: "HOST_GUARD",
    status: request.state === "CLEAR_PENDING" ? "RECOVERED" : "OPEN",
    fingerprint: request.fingerprint,
    observedAt: request.observedAt,
    contentFreeMetrics: { ...request.contentFreeMetrics, guardState: request.state },
  };
}

async function record(
  request: WatchdogRecordRequest,
  dependencies: WatchdogDependencies,
): Promise<{ recorded: number; notified: { push: number; email: number } }> {
  const stored = request.events.length === 0
    ? { recorded: 0 }
    : await dependencies.recordHealth({
        organizationId: request.organizationId,
        operationId: request.operationId,
        observedAt: request.observedAt,
        events: request.events,
      });
  if (request.controls.length > 0) {
    await dependencies.applyCapacityControls({
      organizationId: request.organizationId,
      operationId: request.operationId,
      observedAt: request.observedAt,
      controls: request.controls,
      reasonFingerprint: request.events[0]?.fingerprint ?? "watchdog:capacity-control",
    });
  }
  const notified = request.notification === null
    ? { push: 0, email: 0 }
    : await dependencies.notifyOwnerAdmins({
        organizationId: request.organizationId,
        operationId: request.operationId,
        fingerprints: request.notification.fingerprints,
        repeatWindow: request.notification.repeatWindow,
      });
  return { recorded: stored.recorded, notified };
}

export async function handleWatchdogRequest(
  request: Request,
  dependencies: WatchdogDependencies,
): Promise<Response> {
  let requestId = dependencies.requestIdFactory?.() ?? crypto.randomUUID();
  try {
    if (request.headers.get("origin") !== null) {
      throw new OpenClawHttpError(403, "ORIGIN_FORBIDDEN", "Browser requests are forbidden.");
    }
    // A Supabase browser JWT (or any bearer) is never an accepted credential here;
    // accepting one would resurrect exactly the replayable shared secret this
    // endpoint replaced.
    if (request.headers.get("authorization") !== null) {
      throw new OpenClawHttpError(
        401,
        "WATCHDOG_AUTH_REQUIRED",
        "Watchdog envelope authentication is required.",
      );
    }
    // Authentication runs BEFORE the body is parsed. Parsing first would let an
    // unauthenticated caller read distinguishable 405/413/415/400 outcomes and
    // spend full body-read work on this endpoint.
    if (request.method !== "POST") {
      throw new OpenClawHttpError(405, "METHOD_NOT_ALLOWED", "Method is not allowed.");
    }
    const rawBody = await readBoundedBody(request, OPENCLAW_DEFAULT_JSON_LIMIT_BYTES);
    const envelope = await verifyWatchdogEnvelope(request, rawBody, dependencies);

    const parsed = parseVerifiedBody(rawBody, request, dependencies);
    requestId = parsed.requestId;
    assertWatchdogEnvelopeBodyBinding(envelope, parsed.data);
    if (parsed.data.operation === "PROBE") {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8_000);
      try {
        const snapshot = await dependencies.probe(
          parsed.data.organizationId,
          parsed.data.probeId,
          parsed.data.observedAt,
          controller.signal,
        );
        if (snapshot.organizationId !== parsed.data.organizationId) {
          throw new OpenClawHttpError(502, "PROBE_SCOPE_MISMATCH", "Health probe scope mismatch.");
        }
        return jsonResponse(snapshot, 200, requestId);
      } finally {
        clearTimeout(timeout);
      }
    }
    if (parsed.data.operation === "HOST_GUARD") {
      const guardEvent = hostGuardEvent(parsed.data);
      const stored = await dependencies.recordHealth({
        organizationId: parsed.data.organizationId,
        operationId: parsed.data.operationId,
        observedAt: parsed.data.observedAt,
        events: [guardEvent],
      });
      await dependencies.applyCapacityControls({
        organizationId: parsed.data.organizationId,
        operationId: parsed.data.operationId,
        observedAt: parsed.data.observedAt,
        controls: parsed.data.controls,
        reasonFingerprint: parsed.data.fingerprint,
      });
      return jsonResponse({ version: 1, requestId, recorded: stored.recorded, manualResumeRequired: true }, 200, requestId);
    }
    const result = await record(parsed.data, dependencies);
    return jsonResponse({ version: 1, requestId, ...result }, 200, requestId);
  } catch (error) {
    dependencies.logger?.error("openclaw-watchdog failed", redactLogValue({
      requestId,
      code: error instanceof OpenClawHttpError ? error.code : "WATCHDOG_DEPENDENCY_FAILED",
    }));
    return errorResponse(
      error instanceof OpenClawHttpError
        ? error
        : new OpenClawHttpError(503, "WATCHDOG_DEPENDENCY_FAILED", "Watchdog dependency failed."),
      requestId,
    );
  }
}
