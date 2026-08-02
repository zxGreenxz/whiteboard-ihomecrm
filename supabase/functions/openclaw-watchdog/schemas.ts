const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

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
