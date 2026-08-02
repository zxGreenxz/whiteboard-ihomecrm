const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

/**
 * The watchdog Worker and the host guard authenticate with a dedicated Ed25519
 * envelope, never a shared bearer: a bearer replays forever and proves nothing about which
 * operation, body, organization, or key generation the caller intended.
 * The signature covers `DOMAIN \0 canonicalJson(envelope)` so an envelope
 * signed for this Edge can never be replayed against another audience.
 */
export const WATCHDOG_ENVELOPE_DOMAIN = "ihome-openclaw-watchdog-envelope-v1";
export const WATCHDOG_ENVELOPE_AUDIENCE = "openclaw-watchdog-edge";
export const WATCHDOG_ENVELOPE_PATH = "/functions/v1/openclaw-watchdog";
export const WATCHDOG_ENVELOPE_MAX_SKEW_SECONDS = 60;
export const WATCHDOG_ENVELOPE_HEADER = "x-openclaw-watchdog-envelope";
export const WATCHDOG_SIGNATURE_HEADER = "x-openclaw-watchdog-signature";
/** base64url of a 64-byte Ed25519 signature is exactly 86 characters. */
export const WATCHDOG_SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/u;
const WATCHDOG_ENVELOPE_MAX_HEADER_BYTES = 1_024;

export const WATCHDOG_ENVELOPE_OPERATIONS = Object.freeze([
  "health.probe",
  "health.record",
  "host.guard",
] as const);

export type WatchdogEnvelopeOperation = (typeof WATCHDOG_ENVELOPE_OPERATIONS)[number];

const ENVELOPE_OPERATION_BY_REQUEST = Object.freeze({
  PROBE: "health.probe",
  RECORD: "health.record",
  HOST_GUARD: "host.guard",
} as const);

export interface WatchdogEnvelope {
  version: 1;
  audience: typeof WATCHDOG_ENVELOPE_AUDIENCE;
  operation: WatchdogEnvelopeOperation;
  method: "POST";
  path: string;
  organizationId: string;
  keyGeneration: number;
  timestamp: number;
  nonce: string;
  bodySha256: string;
}

export interface WatchdogEnvelopeKey {
  generation: number;
  /** A key generation may only ever speak for one organization. */
  organizationId: string;
  publicKeySpkiBase64: string;
  /** The cell host signs `host.guard` only; it must not forge health records. */
  allowedOperations: WatchdogEnvelopeOperation[];
  activatesAt: string;
  retiresAt: string | null;
  revokedAt: string | null;
}

export const WATCHDOG_CONTROLS = Object.freeze([
  "DISABLE_AUTOMATIC_VIDEO_FILE_CACHE",
  "PAUSE_NONCRITICAL_PROACTIVE_GROUP_MEDIA",
  "PAUSE_ALL_OUTBOUND_MEDIA",
] as const);

export type WatchdogControl = (typeof WATCHDOG_CONTROLS)[number];

export interface WatchdogHealthEvent {
  accountId: string | null;
  cellId: string | null;
  severity: "INFO" | "WARN" | "ERROR" | "CRITICAL";
  healthKind: string;
  status: "OPEN" | "RECOVERED";
  fingerprint: string;
  observedAt: string;
  contentFreeMetrics: Record<string, number | string | boolean>;
}

export interface WatchdogProbeRequest {
  version: 1;
  operation: "PROBE";
  organizationId: string;
  probeId: string;
  observedAt: string;
}

export interface WatchdogRecordRequest {
  version: 1;
  operation: "RECORD";
  organizationId: string;
  operationId: string;
  observedAt: string;
  events: WatchdogHealthEvent[];
  controls: WatchdogControl[];
  notification: null | {
    fingerprints: string[];
    repeatWindow: number;
    requiredWithinSeconds: 180;
  };
}

export interface HostGuardRequest {
  version: 1;
  operation: "HOST_GUARD";
  organizationId: string;
  operationId: string;
  observedAt: string;
  cellId: string;
  state: "TRIPPED" | "STILL_TRIPPED" | "CLEAR_PENDING";
  fingerprint: string;
  controls: ["PAUSE_OUTBOUND_AI_MEDIA"];
  contentFreeMetrics: Record<string, number | string | boolean>;
}

export type WatchdogRequest = WatchdogProbeRequest | WatchdogRecordRequest | HostGuardRequest;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function timestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function bounded(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && !/[\r\n\u0000-\u001f]/u.test(value);
}

function contentFreeMetrics(value: unknown): value is Record<string, number | string | boolean> {
  if (!object(value) || Object.keys(value).length > 40) return false;
  return Object.entries(value).every(([key, metric]) =>
    /^[a-z][A-Za-z0-9]{0,63}$/u.test(key) &&
    ((typeof metric === "number" && Number.isFinite(metric)) ||
      typeof metric === "boolean" || bounded(metric, 128))
  );
}

function healthEvent(value: unknown): value is WatchdogHealthEvent {
  if (!object(value) || !exact(value, [
    "accountId", "cellId", "severity", "healthKind", "status", "fingerprint",
    "observedAt", "contentFreeMetrics",
  ])) return false;
  return (value.accountId === null || (typeof value.accountId === "string" && UUID_PATTERN.test(value.accountId))) &&
    (value.cellId === null || (typeof value.cellId === "string" && UUID_PATTERN.test(value.cellId))) &&
    ["INFO", "WARN", "ERROR", "CRITICAL"].includes(String(value.severity)) &&
    ["OPEN", "RECOVERED"].includes(String(value.status)) && bounded(value.healthKind, 128) &&
    bounded(value.fingerprint, 128) && timestamp(value.observedAt) && contentFreeMetrics(value.contentFreeMetrics);
}

function parseProbe(value: Record<string, unknown>): WatchdogProbeRequest | null {
  if (!exact(value, ["version", "operation", "organizationId", "probeId", "observedAt"]) ||
    value.version !== 1 || value.operation !== "PROBE" ||
    typeof value.organizationId !== "string" || !UUID_PATTERN.test(value.organizationId) ||
    typeof value.probeId !== "string" || !UUID_PATTERN.test(value.probeId) || !timestamp(value.observedAt)) return null;
  return value as unknown as WatchdogProbeRequest;
}

function parseRecord(value: Record<string, unknown>): WatchdogRecordRequest | null {
  if (!exact(value, [
    "version", "operation", "organizationId", "operationId", "observedAt", "events", "controls", "notification",
  ]) || value.version !== 1 || value.operation !== "RECORD" ||
    typeof value.organizationId !== "string" || !UUID_PATTERN.test(value.organizationId) ||
    typeof value.operationId !== "string" || !UUID_PATTERN.test(value.operationId) || !timestamp(value.observedAt) ||
    !Array.isArray(value.events) || value.events.length > 100 || !value.events.every(healthEvent) ||
    !Array.isArray(value.controls) || value.controls.length > WATCHDOG_CONTROLS.length ||
    new Set(value.controls).size !== value.controls.length ||
    !value.controls.every((item) => (WATCHDOG_CONTROLS as readonly unknown[]).includes(item))) return null;
  if (value.events.length === 0 && value.controls.length === 0 && value.notification === null) return null;
  if (value.notification !== null) {
    if (!object(value.notification) || !exact(value.notification, ["fingerprints", "repeatWindow", "requiredWithinSeconds"]) ||
      !Array.isArray(value.notification.fingerprints) || value.notification.fingerprints.length < 1 ||
      value.notification.fingerprints.length > 100 ||
      new Set(value.notification.fingerprints).size !== value.notification.fingerprints.length ||
      !value.notification.fingerprints.every((item) => bounded(item, 128)) ||
      !Number.isSafeInteger(value.notification.repeatWindow) || Number(value.notification.repeatWindow) < 0 ||
      value.notification.requiredWithinSeconds !== 180) return null;
  }
  return value as unknown as WatchdogRecordRequest;
}

function parseHostGuard(value: Record<string, unknown>): HostGuardRequest | null {
  if (!exact(value, [
    "version", "operation", "organizationId", "operationId", "observedAt", "cellId", "state",
    "fingerprint", "controls", "contentFreeMetrics",
  ]) || value.version !== 1 || value.operation !== "HOST_GUARD" ||
    typeof value.organizationId !== "string" || !UUID_PATTERN.test(value.organizationId) ||
    typeof value.operationId !== "string" || !UUID_PATTERN.test(value.operationId) ||
    typeof value.cellId !== "string" || !UUID_PATTERN.test(value.cellId) || !timestamp(value.observedAt) ||
    !["TRIPPED", "STILL_TRIPPED", "CLEAR_PENDING"].includes(String(value.state)) ||
    !bounded(value.fingerprint, 128) || !Array.isArray(value.controls) || value.controls.length !== 1 ||
    value.controls[0] !== "PAUSE_OUTBOUND_AI_MEDIA" || !contentFreeMetrics(value.contentFreeMetrics)) return null;
  return value as unknown as HostGuardRequest;
}

export function watchdogEnvelopeOperationFor(
  operation: WatchdogRequest["operation"],
): WatchdogEnvelopeOperation {
  return ENVELOPE_OPERATION_BY_REQUEST[operation];
}

/**
 * The envelope is parsed from its own header, never from the body: a body-borne
 * envelope would be self-certifying once an attacker controls the body.
 */
export function parseWatchdogEnvelopeHeader(value: string | null): WatchdogEnvelope | null {
  if (typeof value !== "string" || value.length === 0 ||
    value.length > WATCHDOG_ENVELOPE_MAX_HEADER_BYTES || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    return null;
  }
  let decoded: string;
  try {
    const padded = value.replace(/-/gu, "+").replace(/_/gu, "/")
      .padEnd(Math.ceil(value.length / 4) * 4, "=");
    decoded = new TextDecoder("utf-8", { fatal: true })
      .decode(Uint8Array.from(atob(padded), (character) => character.charCodeAt(0)));
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return null;
  }
  return parseWatchdogEnvelope(parsed);
}

export function parseWatchdogEnvelope(value: unknown): WatchdogEnvelope | null {
  if (!object(value) || !exact(value, [
    "version", "audience", "operation", "method", "path", "organizationId",
    "keyGeneration", "timestamp", "nonce", "bodySha256",
  ])) return null;
  if (
    value.version !== 1 ||
    value.audience !== WATCHDOG_ENVELOPE_AUDIENCE ||
    !(WATCHDOG_ENVELOPE_OPERATIONS as readonly unknown[]).includes(value.operation) ||
    value.method !== "POST" ||
    typeof value.path !== "string" || value.path.length > 256 || /[?#]/u.test(value.path) ||
    typeof value.organizationId !== "string" || !UUID_PATTERN.test(value.organizationId) ||
    !Number.isSafeInteger(value.keyGeneration) || Number(value.keyGeneration) < 1 ||
    !Number.isSafeInteger(value.timestamp) || Number(value.timestamp) < 0 ||
    typeof value.nonce !== "string" || !UUID_PATTERN.test(value.nonce) ||
    typeof value.bodySha256 !== "string" || !SHA256_PATTERN.test(value.bodySha256)
  ) return null;
  return value as unknown as WatchdogEnvelope;
}

function parseEnvelopeKey(generation: string, value: unknown): WatchdogEnvelopeKey | null {
  if (!object(value) || !exact(value, [
    "generation", "organizationId", "publicKeySpkiBase64", "allowedOperations",
    "activatesAt", "retiresAt", "revokedAt",
  ])) return null;
  if (
    !Number.isSafeInteger(value.generation) || Number(value.generation) < 1 ||
    String(value.generation) !== generation ||
    typeof value.organizationId !== "string" || !UUID_PATTERN.test(value.organizationId) ||
    typeof value.publicKeySpkiBase64 !== "string" ||
    value.publicKeySpkiBase64.length < 32 || value.publicKeySpkiBase64.length > 512 ||
    !BASE64_PATTERN.test(value.publicKeySpkiBase64) ||
    !Array.isArray(value.allowedOperations) || value.allowedOperations.length < 1 ||
    value.allowedOperations.length > WATCHDOG_ENVELOPE_OPERATIONS.length ||
    new Set(value.allowedOperations).size !== value.allowedOperations.length ||
    !value.allowedOperations.every((item) =>
      (WATCHDOG_ENVELOPE_OPERATIONS as readonly unknown[]).includes(item)) ||
    !timestamp(value.activatesAt) ||
    !(value.retiresAt === null || timestamp(value.retiresAt)) ||
    !(value.revokedAt === null || timestamp(value.revokedAt))
  ) return null;
  return value as unknown as WatchdogEnvelopeKey;
}

/** Registry shape mirrors the Gateway receipt registry so rotation reads the same. */
export function parseWatchdogKeyRegistry(
  value: unknown,
): Readonly<Record<string, WatchdogEnvelopeKey>> | null {
  if (!object(value)) return null;
  const entries = Object.entries(value);
  if (entries.length < 1 || entries.length > 8) return null;
  const registry: Record<string, WatchdogEnvelopeKey> = {};
  for (const [generation, entry] of entries) {
    if (!/^[1-9][0-9]{0,15}$/u.test(generation)) return null;
    const key = parseEnvelopeKey(generation, entry);
    if (!key) return null;
    registry[generation] = key;
  }
  return Object.freeze(registry);
}

export const watchdogRequestSchema = {
  safeParse(value: unknown): { success: true; data: WatchdogRequest } | { success: false; error: string } {
    if (!object(value)) return { success: false, error: "request must be an object" };
    const parsed = value.operation === "PROBE"
      ? parseProbe(value)
      : value.operation === "RECORD"
      ? parseRecord(value)
      : value.operation === "HOST_GUARD"
      ? parseHostGuard(value)
      : null;
    return parsed ? { success: true, data: parsed } : { success: false, error: "invalid watchdog request" };
  },
};
