import { OPENCLAW_DEFAULT_JSON_LIMIT_BYTES } from "../_shared/openclaw/constants.ts";
import { base64UrlDecode, canonicalJson, sha256Hex, utf8 } from "../_shared/openclaw/crypto.ts";
import { OpenClawHttpError } from "../_shared/openclaw/errors.ts";
import { errorResponse, jsonResponse, readStrictJson } from "../_shared/openclaw/http.ts";
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
  expiresAtEpochSeconds: number;
}

export interface WatchdogDependencies {
  /** Generation -> Ed25519 verification key. Rotation adds a generation; it never edits one. */
  envelopeKeys: Readonly<Record<string, WatchdogEnvelopeKey>>;
  /** Returns false when the nonce was already spent, which rejects the replay. */
  consumeEnvelopeNonce: (input: ConsumeEnvelopeNonceInput) => Promise<boolean>;
  now?: () => Date;
  probe: (organizationId: string, signal: AbortSignal) => Promise<WatchdogSnapshot>;
  recordHealth: (input: {
    organizationId: string;
    operationId: string;
    observedAt: string;
    events: WatchdogHealthEvent[];
  }) => Promise<{ recorded: number }>;
  applyCapacityControls: (input: {
    organizationId: string;
    operationId: string;
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

function activeKey(
  keys: Readonly<Record<string, WatchdogEnvelopeKey>>,
  envelope: WatchdogEnvelope,
  observedAt: string,
): WatchdogEnvelopeKey {
  const key = keys[String(envelope.keyGeneration)];
  if (
    !key ||
    key.generation !== envelope.keyGeneration ||
    key.organizationId !== envelope.organizationId ||
    !key.allowedOperations.includes(envelope.operation) ||
    observedAt < key.activatesAt ||
    (key.retiresAt !== null && observedAt >= key.retiresAt) ||
    (key.revokedAt !== null && observedAt >= key.revokedAt)
  ) {
    throw envelopeDenied();
  }
  return key;
}

/**
 * Verification order is deliberate: cheap structural binding, then the key
 * generation, then the clock, then the body digest, then Ed25519, and only then
 * the one-time nonce. Nothing here touches the database, so an unauthenticated
 * caller can never reach a facade.
 */
export async function verifyWatchdogEnvelope(
  request: Request,
  rawBody: Uint8Array,
  body: WatchdogRequest,
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
    url.pathname.replace(/\/$/u, "") !== WATCHDOG_ENVELOPE_PATH ||
    envelope.operation !== watchdogEnvelopeOperationFor(body.operation) ||
    envelope.organizationId !== body.organizationId
  ) {
    throw envelopeDenied();
  }

  const now = dependencies.now?.() ?? new Date();
  const nowEpochSeconds = Math.floor(now.getTime() / 1_000);
  const key = activeKey(dependencies.envelopeKeys, envelope, now.toISOString());
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
    expiresAtEpochSeconds: envelope.timestamp + WATCHDOG_ENVELOPE_MAX_SKEW_SECONDS,
  });
  if (!consumed) throw envelopeDenied();
  return envelope;
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
    const parsed = await readStrictJson(request, {
      method: "POST",
      maxBytes: OPENCLAW_DEFAULT_JSON_LIMIT_BYTES,
      schema: watchdogRequestSchema,
      requestIdFactory: dependencies.requestIdFactory,
    });
    requestId = parsed.requestId;
    await verifyWatchdogEnvelope(request, parsed.rawBody, parsed.data, dependencies);
    if (parsed.data.operation === "PROBE") {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8_000);
      try {
        const snapshot = await dependencies.probe(parsed.data.organizationId, controller.signal);
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
