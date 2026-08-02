export const WATCHDOG_INTERVAL_SECONDS = 60;
export const WATCHDOG_TIMEOUT_MS = 10_000;
export const HEARTBEAT_STALE_MS = 90_000;
export const FAILURE_THRESHOLD = 3;
export const DEFAULT_REPEAT_WINDOW_SECONDS = 15 * 60;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ALLOWED_EDGE_PATH = /\/functions\/v1\/openclaw-watchdog\/?$/u;

export interface WatchdogEnv {
  WATCHDOG_STATE: DurableObjectNamespace;
  OPENCLAW_WATCHDOG_EDGE_URL: string;
  OPENCLAW_WATCHDOG_BEARER_TOKEN: string;
  OPENCLAW_WATCHDOG_ORGANIZATION_ID: string;
  OPENCLAW_WATCHDOG_REPEAT_WINDOW_SECONDS?: string;
}

export interface CapacityMetrics {
  queueLagP95Seconds: number;
  unknownCount10m: number;
  unknownRate10m: number;
  attempts10m: number;
  adapterErrorRate5m: number;
  reconnectCount10m: number;
  cpuPercentOfCap: number;
  ramPercentOfCap: number;
  rootDiskUsedPercent: number;
  spoolUsedPercent: number;
  spoolOldestAgeSeconds: number;
  spoolBytes: number;
  mediaBacklog: number;
  r2FailureCount5m: number;
  supabaseEgressPercent: number;
  r2StoragePercent: number;
  r2RequestPercent: number;
  vpsOutboundPercent: number;
  transferQuotaPercent: number;
}

export interface ProbeSnapshot {
  version: 1;
  organizationId: string;
  observedAt: string;
  probeOk: boolean;
  heartbeatAt: string | null;
  metrics: CapacityMetrics;
}

export type CapacityControl =
  | "DISABLE_AUTOMATIC_VIDEO_FILE_CACHE"
  | "PAUSE_NONCRITICAL_PROACTIVE_GROUP_MEDIA"
  | "PAUSE_ALL_OUTBOUND_MEDIA";

export interface WatchdogEvent {
  accountId: string | null;
  cellId: string | null;
  severity: "INFO" | "WARN" | "ERROR" | "CRITICAL";
  healthKind: string;
  status: "OPEN" | "RECOVERED";
  fingerprint: string;
  observedAt: string;
  contentFreeMetrics: Record<string, number | string | boolean>;
}

export interface EvaluatedHealth {
  events: WatchdogEvent[];
  controls: CapacityControl[];
}

interface PersistedState {
  consecutiveProbeFailures: number;
  openEvents: Record<string, WatchdogEvent>;
  notificationWindows: Record<string, number>;
}

const EMPTY_STATE: PersistedState = {
  consecutiveProbeFailures: 0,
  openEvents: {},
  notificationWindows: {},
};

function finitePercent(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 100;
}

function finiteNonnegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function parseProbeSnapshot(value: unknown, organizationId: string): ProbeSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid probe response");
  const record = value as Record<string, unknown>;
  if (!exactKeys(record, ["version", "organizationId", "observedAt", "probeOk", "heartbeatAt", "metrics"])) {
    throw new Error("invalid probe response");
  }
  if (
    record.version !== 1 || record.organizationId !== organizationId ||
    typeof record.observedAt !== "string" || !Number.isFinite(Date.parse(record.observedAt)) ||
    typeof record.probeOk !== "boolean" ||
    !(record.heartbeatAt === null ||
      (typeof record.heartbeatAt === "string" && Number.isFinite(Date.parse(record.heartbeatAt)))) ||
    !record.metrics || typeof record.metrics !== "object" || Array.isArray(record.metrics)
  ) throw new Error("invalid probe response");

  const metrics = record.metrics as Record<string, unknown>;
  const keys = [
    "queueLagP95Seconds", "unknownCount10m", "unknownRate10m", "attempts10m",
    "adapterErrorRate5m", "reconnectCount10m", "cpuPercentOfCap", "ramPercentOfCap",
    "rootDiskUsedPercent", "spoolUsedPercent", "spoolOldestAgeSeconds", "spoolBytes",
    "mediaBacklog", "r2FailureCount5m", "supabaseEgressPercent", "r2StoragePercent",
    "r2RequestPercent", "vpsOutboundPercent", "transferQuotaPercent",
  ] as const;
  if (!exactKeys(metrics, keys) || !keys.every((key) => typeof metrics[key] === "number")) {
    throw new Error("invalid probe metrics");
  }
  const percentages = [
    "unknownRate10m", "adapterErrorRate5m", "cpuPercentOfCap", "ramPercentOfCap",
    "rootDiskUsedPercent", "spoolUsedPercent", "supabaseEgressPercent", "r2StoragePercent",
    "r2RequestPercent", "vpsOutboundPercent", "transferQuotaPercent",
  ] as const;
  if (!percentages.every((key) => finitePercent(Number(metrics[key]))) ||
    !keys.every((key) => finiteNonnegative(Number(metrics[key])))) {
    throw new Error("invalid probe metrics");
  }
  return record as unknown as ProbeSnapshot;
}

function event(
  observedAt: string,
  healthKind: string,
  severity: WatchdogEvent["severity"],
  fingerprint: string,
  metrics: WatchdogEvent["contentFreeMetrics"],
): WatchdogEvent {
  return {
    accountId: null,
    cellId: null,
    severity,
    healthKind,
    status: "OPEN",
    fingerprint,
    observedAt,
    contentFreeMetrics: metrics,
  };
}

function quotaLevel(percent: number): 0 | 60 | 80 | 90 | 100 {
  if (percent >= 100) return 100;
  if (percent >= 90) return 90;
  if (percent >= 80) return 80;
  if (percent >= 60) return 60;
  return 0;
}

export function evaluateSnapshot(snapshot: ProbeSnapshot, nowMs: number): EvaluatedHealth {
  const events: WatchdogEvent[] = [];
  const { metrics, observedAt } = snapshot;
  const heartbeatAgeMs = snapshot.heartbeatAt === null
    ? Number.POSITIVE_INFINITY
    : Math.max(0, nowMs - Date.parse(snapshot.heartbeatAt));
  if (!snapshot.probeOk || heartbeatAgeMs > HEARTBEAT_STALE_MS) {
    events.push(event(observedAt, "WATCHDOG_HEARTBEAT_STALE", "CRITICAL", "heartbeat:stale", {
      heartbeatAgeSeconds: Number.isFinite(heartbeatAgeMs) ? Math.floor(heartbeatAgeMs / 1_000) : -1,
      thresholdSeconds: HEARTBEAT_STALE_MS / 1_000,
    }));
  }
  if (metrics.queueLagP95Seconds > 30) {
    events.push(event(observedAt, "QUEUE_LAG_HIGH", "ERROR", "queue-lag:p95", {
      valueSeconds: metrics.queueLagP95Seconds, thresholdSeconds: 30,
    }));
  }
  if (metrics.unknownCount10m > 3 || (metrics.attempts10m >= 20 && metrics.unknownRate10m > 2)) {
    events.push(event(observedAt, "UNKNOWN_RATE_HIGH", "CRITICAL", "unknown:10m", {
      count: metrics.unknownCount10m, ratePercent: metrics.unknownRate10m,
      attempts: metrics.attempts10m,
    }));
  }
  if (metrics.adapterErrorRate5m > 1) {
    events.push(event(observedAt, "ADAPTER_ERROR_RATE_HIGH", "ERROR", "adapter-errors:5m", {
      ratePercent: metrics.adapterErrorRate5m, thresholdPercent: 1,
    }));
  }
  if (metrics.reconnectCount10m >= 3) {
    events.push(event(observedAt, "RECONNECT_BURST", "WARN", "reconnects:10m", {
      count: metrics.reconnectCount10m, threshold: 3,
    }));
  }
  for (const [kind, fingerprint, value] of [
    ["CPU_PRESSURE", "cpu:cap", metrics.cpuPercentOfCap],
    ["RAM_PRESSURE", "ram:cap", metrics.ramPercentOfCap],
  ] as const) {
    if (value >= 70) events.push(event(observedAt, kind, value >= 90 ? "CRITICAL" : "WARN", fingerprint, {
      valuePercent: value, thresholdPercent: 70,
    }));
  }
  if (metrics.rootDiskUsedPercent >= 80) {
    events.push(event(observedAt, "ROOT_DISK_PRESSURE", metrics.rootDiskUsedPercent >= 90 ? "CRITICAL" : "ERROR", "disk:root", {
      usedPercent: metrics.rootDiskUsedPercent, thresholdPercent: 80,
    }));
  }
  if (metrics.spoolUsedPercent >= 80 || metrics.spoolOldestAgeSeconds >= 24 * 60 * 60) {
    events.push(event(observedAt, "SPOOL_PRESSURE", metrics.spoolUsedPercent >= 95 ? "CRITICAL" : "ERROR", "spool:pressure", {
      usedPercent: metrics.spoolUsedPercent,
      oldestAgeSeconds: metrics.spoolOldestAgeSeconds,
      bytes: metrics.spoolBytes,
    }));
  }
  if (metrics.mediaBacklog > 0) {
    events.push(event(observedAt, "MEDIA_BACKLOG", "WARN", "media:backlog", { count: metrics.mediaBacklog }));
  }
  if (metrics.r2FailureCount5m > 0) {
    events.push(event(observedAt, "R2_FAILURE", "ERROR", "r2:failures:5m", { count: metrics.r2FailureCount5m }));
  }

  const quotaMetrics = [
    ["SUPABASE_EGRESS", metrics.supabaseEgressPercent],
    ["R2_STORAGE", metrics.r2StoragePercent],
    ["R2_REQUESTS", metrics.r2RequestPercent],
    ["VPS_OUTBOUND", metrics.vpsOutboundPercent],
    ["TRANSFER", metrics.transferQuotaPercent],
  ] as const;
  for (const [name, percent] of quotaMetrics) {
    const level = quotaLevel(percent);
    if (level === 0) continue;
    events.push(event(observedAt, `${name}_QUOTA_${level}`, level >= 100 ? "CRITICAL" : level >= 90 ? "ERROR" : "WARN", `quota:${name.toLowerCase()}:${level}`, {
      usedPercent: percent, thresholdPercent: level,
    }));
  }

  const mediaQuota = Math.max(
    metrics.supabaseEgressPercent,
    metrics.r2StoragePercent,
    metrics.r2RequestPercent,
    metrics.vpsOutboundPercent,
    metrics.transferQuotaPercent,
  );
  const controls: CapacityControl[] = [];
  if (mediaQuota >= 80) controls.push("DISABLE_AUTOMATIC_VIDEO_FILE_CACHE");
  if (mediaQuota >= 90) controls.push("PAUSE_NONCRITICAL_PROACTIVE_GROUP_MEDIA");
  if (mediaQuota >= 100) controls.push("PAUSE_ALL_OUTBOUND_MEDIA");
  return { events, controls };
}

function edgeUrl(env: WatchdogEnv): string {
  const value = new URL(env.OPENCLAW_WATCHDOG_EDGE_URL);
  if (value.protocol !== "https:" || value.username || value.password || value.search || value.hash ||
    !ALLOWED_EDGE_PATH.test(value.pathname) || /gateway/iu.test(value.hostname + value.pathname) ||
    ["18789", "3000", "8080"].includes(value.port)) {
    throw new Error("watchdog Edge URL must be the dedicated openclaw-watchdog endpoint");
  }
  return value.toString();
}

function environment(env: WatchdogEnv): { edgeUrl: string; organizationId: string; repeatWindowSeconds: number } {
  if (!UUID_PATTERN.test(env.OPENCLAW_WATCHDOG_ORGANIZATION_ID)) throw new Error("watchdog organization is invalid");
  if (env.OPENCLAW_WATCHDOG_BEARER_TOKEN.length < 32 || env.OPENCLAW_WATCHDOG_BEARER_TOKEN.length > 512) {
    throw new Error("watchdog bearer token is invalid");
  }
  const repeatWindowSeconds = Number(env.OPENCLAW_WATCHDOG_REPEAT_WINDOW_SECONDS ?? DEFAULT_REPEAT_WINDOW_SECONDS);
  if (!Number.isSafeInteger(repeatWindowSeconds) || repeatWindowSeconds < 180 || repeatWindowSeconds > 86_400) {
    throw new Error("watchdog repeat window is invalid");
  }
  return { edgeUrl: edgeUrl(env), organizationId: env.OPENCLAW_WATCHDOG_ORGANIZATION_ID, repeatWindowSeconds };
}

async function postEdge(
  env: WatchdogEnv,
  body: Record<string, unknown>,
  fetcher: typeof fetch,
): Promise<unknown> {
  const config = environment(env);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WATCHDOG_TIMEOUT_MS);
  try {
    const response = await fetcher(config.edgeUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.OPENCLAW_WATCHDOG_BEARER_TOKEN}`,
        "content-type": "application/json",
        "x-openclaw-watchdog-version": "1",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`watchdog Edge failed with ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function operationId(): string {
  return crypto.randomUUID();
}

// Operation ID cho RECORD phải TẤT ĐỊNH theo nội dung tác động, không phải UUID mới
// mỗi tick. Trước đây mỗi lần thử lại sau khi mất phản hồi sinh ID mới, trong khi Edge
// ghi DB -> áp control -> gửi notify tuần tự; hỏng ở khâu sau khiến tick kế lặp lại
// những khâu đã thành công dưới ID khác, nhân bản incident/control/push/email trong
// cùng một repeat window. Dẫn xuất SHA-256 rồi định dạng theo khuôn UUID v5 cho khớp
// UUID_PATTERN mà Edge kiểm ([1-5]).
const RECORD_OPERATION_DOMAIN = "ihome-openclaw-watchdog-record-v1";
export async function deriveRecordOperationId(input: {
  organizationId: string;
  events: readonly WatchdogEvent[];
  controls: readonly string[];
  notificationFingerprints: readonly string[];
  repeatWindow: number;
}): Promise<string> {
  const material = [
    RECORD_OPERATION_DOMAIN,
    input.organizationId,
    String(input.repeatWindow),
    [...input.events].map((item) => `${item.healthKind}|${item.status}|${item.fingerprint}`).sort().join(","),
    [...input.controls].sort().join(","),
    [...input.notificationFingerprints].sort().join(","),
  ].join(" ");
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material)),
  );
  const hex = [...digest.subarray(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const version = `5${hex.slice(13, 16)}`;
  const variant = `${"89ab"[parseInt(hex[16]!, 16) % 4]}${hex.slice(17, 20)}`;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${version}-${variant}-${hex.slice(20, 32)}`;
}

export class WatchdogState implements DurableObject {
  readonly #state: DurableObjectState;
  readonly #env: WatchdogEnv;

  constructor(state: DurableObjectState, env: WatchdogEnv) {
    this.#state = state;
    this.#env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/tick") return new Response("not found", { status: 404 });
    try {
      const result = await this.tick(Date.now(), fetch);
      return Response.json(result, { headers: { "cache-control": "no-store" } });
    } catch {
      return Response.json({ version: 1, status: "failed" }, { status: 503, headers: { "cache-control": "no-store" } });
    }
  }

  async tick(nowMs: number, fetcher: typeof fetch): Promise<Record<string, unknown>> {
    const config = environment(this.#env);
    const state = await this.#state.storage.get<PersistedState>("state") ?? structuredClone(EMPTY_STATE);
    const now = new Date(nowMs).toISOString();
    let evaluated: EvaluatedHealth;
    try {
      const snapshot = parseProbeSnapshot(await postEdge(this.#env, {
        version: 1,
        operation: "PROBE",
        organizationId: config.organizationId,
        probeId: operationId(),
        observedAt: now,
      }, fetcher), config.organizationId);
      state.consecutiveProbeFailures = snapshot.probeOk ? 0 : state.consecutiveProbeFailures + 1;
      evaluated = evaluateSnapshot(snapshot, nowMs);
      if (!snapshot.probeOk && state.consecutiveProbeFailures < FAILURE_THRESHOLD) {
        evaluated = { events: evaluated.events.filter((item) => item.healthKind !== "WATCHDOG_HEARTBEAT_STALE"), controls: evaluated.controls };
      }
    } catch {
      state.consecutiveProbeFailures += 1;
      evaluated = state.consecutiveProbeFailures >= FAILURE_THRESHOLD
        ? {
            events: [event(now, "WATCHDOG_EDGE_PROBE_FAILED", "CRITICAL", "watchdog:probe-failed", {
              consecutiveFailures: state.consecutiveProbeFailures,
              threshold: FAILURE_THRESHOLD,
            })],
            controls: [],
          }
        : { events: [], controls: [] };
    }

    const current = new Map(evaluated.events.map((item) => [item.fingerprint, item]));
    const transitions: WatchdogEvent[] = [];
    for (const [fingerprint, item] of current) {
      if (!(fingerprint in state.openEvents)) transitions.push(item);
      state.openEvents[fingerprint] = item;
    }
    for (const [fingerprint, previous] of Object.entries(state.openEvents)) {
      if (current.has(fingerprint)) continue;
      transitions.push({ ...previous, status: "RECOVERED", severity: "INFO", observedAt: now });
      delete state.openEvents[fingerprint];
      delete state.notificationWindows[fingerprint];
    }

    const repeatWindow = Math.floor(nowMs / (config.repeatWindowSeconds * 1_000));
    const notificationFingerprints = evaluated.events
      .filter((item) => item.severity !== "INFO" && state.notificationWindows[item.fingerprint] !== repeatWindow)
      .map((item) => item.fingerprint);
    for (const fingerprint of notificationFingerprints) state.notificationWindows[fingerprint] = repeatWindow;

    if (transitions.length > 0 || evaluated.controls.length > 0 || notificationFingerprints.length > 0) {
      await postEdge(this.#env, {
        version: 1,
        operation: "RECORD",
        organizationId: config.organizationId,
        operationId: await deriveRecordOperationId({
          organizationId: config.organizationId,
          events: transitions,
          controls: evaluated.controls,
          notificationFingerprints,
          repeatWindow,
        }),
        observedAt: now,
        events: transitions,
        controls: evaluated.controls,
        notification: notificationFingerprints.length === 0
          ? null
          : { fingerprints: notificationFingerprints, repeatWindow, requiredWithinSeconds: 180 },
      }, fetcher);
    }
    await this.#state.storage.put("state", state);
    return {
      version: 1,
      status: "ok",
      consecutiveProbeFailures: state.consecutiveProbeFailures,
      transitions: transitions.length,
      notifications: notificationFingerprints.length,
    };
  }
}

export default {
  async fetch(): Promise<Response> {
    return new Response("not found", { status: 404, headers: { "cache-control": "no-store" } });
  },
  async scheduled(_controller: ScheduledController, env: WatchdogEnv, ctx: ExecutionContext): Promise<void> {
    environment(env);
    const stub = env.WATCHDOG_STATE.get(env.WATCHDOG_STATE.idFromName(env.OPENCLAW_WATCHDOG_ORGANIZATION_ID));
    ctx.waitUntil(stub.fetch("https://watchdog.internal/tick", { method: "POST" }).then((response) => {
      if (!response.ok) throw new Error("watchdog tick failed");
    }));
  },
};
