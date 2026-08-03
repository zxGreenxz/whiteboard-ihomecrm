import { ApiClientError } from "./apiClient.js";
import type {
  ActionObservation,
} from "./reconciliation.js";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export interface WorkerLogger {
  info(message: string, context?: unknown): void;
  warn(message: string, context?: unknown): void;
  error(message: string, context?: unknown): void;
}

export interface RouterCredential {
  username: string;
  privateKey: string;
  privateKeyPassphrase?: string;
  backupPassword: string;
}

export interface NetworkConnection {
  connectionId: string;
  organizationId: string;
  buildingId: string;
  deviceId: string;
  deviceKind: "MIKROTIK" | "ARUBA";
  externalKey: string;
  displayName: string;
  transport: "ROUTEROS_SSH" | "ROUTEROS_API" | "SNMP" | "HTTPS" | "DISPLAY_ONLY";
  managementIp: string;
  managementPort: number;
  credentialRef: string | null;
  hostKeyFingerprint: string | null;
  pollIntervalSeconds: number;
  connectTimeoutMs: number;
  monitoringEnabled: boolean;
  changesPaused: boolean;
}

// ---------------------------------------------------------------------------
// Value domains the control plane's CHECK constraints accept.
//
// WHY THESE ARE CONSTANTS AND NOT COMMENTS. The worker shipped
// `connectionType: "DHCP"` and `sessionType: "LEASE"` to production. Neither
// value appears in any CHECK constraint in the schema: `DHCP` is a legal
// SESSION type that was written into the CONNECTION field, and `LEASE` is not a
// telemetry value at all - it is a `network_client_links.source`. Postgres
// rejected the row with SQLSTATE 23514 and, because the ingest RPC is ONE
// transaction, took the whole telemetry batch - interfaces included - down with
// it, on every poll, forever.
//
// Nothing caught it because `RouterClientObservation` was
// `{ externalKey: string; [key: string]: JsonValue }`: an index signature makes
// the worker's most schema-coupled payload the least type-checked object in the
// package, so both literals were just `string`.
//
// These arrays are a RESTATEMENT of the database, so they are pinned to it
// rather than trusted: scripts/test-network-center-ingest-domains-disposable.mjs
// builds a real PostgreSQL 17 cluster from the real migrations, reads the
// domains out of pg_get_constraintdef, and fails if any array here differs from
// the catalog by a single member. Edit one without editing the schema and that
// proof goes red.
// ---------------------------------------------------------------------------

/** `network_client_current.connection_type`, `network_client_sessions.connection_type`. */
export const CLIENT_CONNECTION_TYPES = ["UNKNOWN", "ETHERNET", "WIFI", "VPN"] as const;
/** `network_client_current.session_type`. */
export const CLIENT_SESSION_TYPES = ["UNKNOWN", "DHCP", "HOTSPOT", "STATIC", "ARP"] as const;
/** `network_device_current.health_status`. */
export const DEVICE_HEALTH_STATUSES = [
  "UNKNOWN",
  "HEALTHY",
  "DEGRADED",
  "CRITICAL",
  "OFFLINE",
] as const;
/** `network_interface_current.link_state`. */
export const INTERFACE_LINK_STATES = ["UNKNOWN", "UP", "DOWN"] as const;
/** `network_interfaces.interface_role`. */
export const INTERFACE_ROLES = [
  "WAN",
  "LAN",
  "ACCESS",
  "UPLINK",
  "MANAGEMENT",
  "UNKNOWN",
] as const;
/** `network_interfaces.interface_kind`. */
export const INTERFACE_KINDS = [
  "ETHERNET",
  "WIRELESS",
  "WIREGUARD",
  "BRIDGE",
  "VLAN",
  "LOOPBACK",
  "OTHER",
] as const;

export type ClientConnectionType = (typeof CLIENT_CONNECTION_TYPES)[number];
export type ClientSessionType = (typeof CLIENT_SESSION_TYPES)[number];
export type DeviceHealthStatus = (typeof DEVICE_HEALTH_STATUSES)[number];
export type InterfaceLinkState = (typeof INTERFACE_LINK_STATES)[number];
export type InterfaceRole = (typeof INTERFACE_ROLES)[number];
export type InterfaceKind = (typeof INTERFACE_KINDS)[number];

export interface RouterInterfaceObservation {
  externalKey: string;
  displayName: string;
  immutableKey?: string | null;
  role: InterfaceRole;
  protected: boolean;
  enabled: boolean;
  sample?: JsonObject;
}

export interface ArubaObservation {
  stableIdentity: string;
  identitySource: "SERIAL" | "HARDWARE_MAC";
  externalKey: string;
  aliases: string[];
  displayName: string;
  displayOnly: true;
  reachable: boolean;
  model?: string | null;
  managementIp?: string | null;
  metadata?: JsonObject;
}

export interface ArubaQuarantineObservation {
  code: "ARUBA_STABLE_IDENTITY_INVALID";
  fingerprint: string;
}

/**
 * One observed client, shaped exactly like the `clients[]` recordset
 * `network_center_worker_ingest_v2` destructures.
 *
 * DELIBERATELY CLOSED. There is no index signature: every field the ingest RPC
 * reads is declared, and the two that land in a CHECK-constrained column carry
 * their real union type, so a value the database would reject cannot compile.
 * The RPC ignores unknown keys anyway, so an open shape bought nothing and cost
 * the entire type-check of this payload.
 */
export interface RouterClientObservation {
  externalKey: string;
  deviceId: string;
  /** `network_client_current.session_key`: 8-200 characters after trimming. */
  sessionKey: string;
  /** `network_client_current.client_fingerprint`: 8-200 characters. */
  clientFingerprint: string;
  observedMac: string | null;
  observedIp: string | null;
  hostname: string | null;
  connectionType: ClientConnectionType;
  sessionType: ClientSessionType;
  firstSeenAt: string;
  lastSeenAt: string;
  /** Must be strictly after `lastSeenAt` - the table's own time CHECK. */
  expiresAt: string;
  randomizedMac: boolean;
  interfaceId?: string | null;
}

export interface RouterObservation {
  observedAt: string;
  device: JsonObject;
  interfaces: RouterInterfaceObservation[];
  clients: RouterClientObservation[];
  aruba: ArubaObservation[];
  arubaQuarantine?: ArubaQuarantineObservation[];
}

export interface InventoryMapping {
  routerDeviceId: string;
  interfaces: ManagedInterfaceMapping[];
  aruba: Array<{ externalKey: string; id: string }>;
  inventoryStatus?: "OK" | "DEGRADED";
  quarantinedCount?: number;
}

export interface ManagedInterfaceTarget {
  managedResourceId: string;
  interfaceId: string;
  interfaceKey: string;
  currentName: string;
  immutableKey: string | null;
  enrolledRole: string;
  protected: boolean;
  enrollmentState: "DISCOVERED" | "ENROLLED" | "REVOKED";
}

export interface ManagedInterfaceMapping {
  managedResourceId: string | null;
  id: string;
  interfaceKey: string;
  currentName: string;
  immutableKey: string | null;
  enrolledRole: string;
  protected: boolean;
  enrollmentState: "DISCOVERED" | "ENROLLED" | "REVOKED";
}

export type CommandAction =
  | "FLUSH_DNS_CACHE"
  | "RENEW_DHCP_LEASE"
  | "CYCLE_ACCESS_PORT"
  | "REBOOT_ROUTER"
  | "CAPTURE_SNAPSHOT";

export interface CommandClaim {
  commandId: string;
  organizationId: string;
  buildingId: string;
  deviceId: string;
  interfaceId: string | null;
  actionType: string;
  reason: string;
  parameters: Record<string, unknown>;
  attemptNo: number;
  leaseToken: string;
  leaseExpiresAt: string;
  reconciliation: boolean;
  intentType: string;
  managedTarget: JsonObject;
  preObservation: ActionObservation | null;
  expectedPostcondition: JsonObject;
  observationDeadline: string;
  transitionVersion: number;
  fencingGeneration: number;
}

export type CommandOutcome =
  | "EVALUATE_POSTCONDITION"
  | "RETRYABLE_FAILURE"
  | "FAILED"
  | "UNCERTAIN"
  | "CANCELLED_BY_KILL_SWITCH";

export interface NetworkCenterWorkerApi {
  listConnections(limit?: number): Promise<NetworkConnection[]>;
  heartbeat(input: {
    status: string;
    workerVersion: string;
    capabilities: string[];
    queueAgeSeconds: number;
    safeMetadata: JsonObject;
    startedAt: string;
  }): Promise<unknown>;
  claimCommands(limit?: number, leaseSeconds?: number): Promise<CommandClaim[]>;
  renewLease(input: {
    commandId: string;
    leaseToken: string;
    fencingGeneration: number;
    leaseSeconds: number;
  }): Promise<unknown>;
  ingest(payload: Record<string, unknown>): Promise<unknown>;
  inventory(payload: Record<string, unknown>): Promise<InventoryMapping>;
  stage(input: {
    commandId: string;
    leaseToken: string;
    fencingGeneration: number;
    eventKind: string;
    payload: Record<string, unknown>;
  }): Promise<unknown>;
  observe(input: {
    commandId: string;
    leaseToken: string;
    fencingGeneration: number;
    transitionVersion: number;
    observationId: string;
    observationKind: "PRE_ACTION" | "POST_ACTION" | "RECONCILIATION";
    observedAt: string;
    evidence: Record<string, unknown>;
  }): Promise<{ accepted: true; transitionVersion: number }>;
  complete(input: {
    commandId: string;
    leaseToken: string;
    fencingGeneration: number;
    transitionVersion: number;
    outcome: CommandOutcome;
    result: Record<string, unknown>;
    rollback?: Record<string, unknown> | null;
    retryDelaySeconds?: number;
  }): Promise<unknown>;
  upsertIncident(payload: Record<string, unknown>): Promise<unknown>;
  snapshot(payload: Record<string, unknown>): Promise<unknown>;
  maintenance(now: string): Promise<unknown>;
}

export interface WorkerClock {
  now(): Date;
  setInterval(callback: () => void | Promise<void>, milliseconds: number): unknown;
  clearInterval(handle: unknown): void;
  sleep(milliseconds: number, signal?: AbortSignal): Promise<void>;
}

export const systemClock: WorkerClock = {
  now: () => new Date(),
  setInterval: (callback, milliseconds) => setInterval(() => void callback(), milliseconds),
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
  sleep: (milliseconds, signal) => new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, milliseconds);
    function done() {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    function onAbort() {
      clearTimeout(timer);
      done();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  }),
};

export function chunkAll<T>(items: readonly T[], maximum: number): T[][] {
  if (!Number.isSafeInteger(maximum) || maximum < 1) {
    throw new RangeError("Chunk size must be a positive safe integer");
  }
  const chunks: T[][] = [];
  for (let offset = 0; offset < items.length; offset += maximum) {
    chunks.push(items.slice(offset, offset + maximum));
  }
  return chunks;
}

const SECRET_KEY = /(authorization|cookie|credential|passphrase|password|private.?key|secret|token)/i;
const INLINE_SECRET = /\b(password|passphrase|secret|token|authorization)=([^\s,;]+)/gi;

function redactString(value: string): string {
  return value
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]")
    .replace(INLINE_SECRET, "$1=[REDACTED]");
}

export function redactForLog(value: unknown): unknown {
  const seen = new WeakSet<object>();
  function visit(current: unknown, key?: string): unknown {
    if (key && SECRET_KEY.test(key)) return "[REDACTED]";
    if (typeof current === "string") return redactString(current);
    if (current === null || typeof current !== "object") return current;
    if (seen.has(current)) return "[CIRCULAR]";
    seen.add(current);
    if (Array.isArray(current)) return current.map((item) => visit(item));
    return Object.fromEntries(
      Object.entries(current as Record<string, unknown>).map(([entryKey, entryValue]) => [
        entryKey,
        visit(entryValue, entryKey),
      ]),
    );
  }
  return visit(value);
}

export class InterfaceRegistry {
  readonly #byRouter = new Map<string, Map<string, ManagedInterfaceMapping>>();

  update(routerDeviceId: string, mappings: ManagedInterfaceMapping[]): void {
    const replacement = new Map<string, ManagedInterfaceMapping>();
    for (const mapping of mappings) replacement.set(mapping.id, { ...mapping });
    this.#byRouter.set(routerDeviceId, replacement);
  }

  resolve(routerDeviceId: string, interfaceId: string): ManagedInterfaceTarget | null {
    const mapping = this.#byRouter.get(routerDeviceId)?.get(interfaceId);
    if (
      !mapping?.immutableKey
      || !mapping.managedResourceId
      || mapping.enrollmentState !== "ENROLLED"
      || mapping.enrolledRole !== "ACCESS"
      || mapping.protected
    ) return null;
    return {
      managedResourceId: mapping.managedResourceId,
      interfaceId: mapping.id,
      interfaceKey: mapping.interfaceKey,
      currentName: mapping.currentName,
      immutableKey: mapping.immutableKey,
      enrolledRole: "ACCESS",
      protected: false,
      enrollmentState: "ENROLLED",
    };
  }

  clear(routerDeviceId: string): void {
    this.#byRouter.delete(routerDeviceId);
  }
}

export class RouterOperationError extends Error {
  readonly retryable: boolean;
  readonly mayHaveExecuted: boolean;
  readonly code: string;

  constructor(
    code: string,
    options: { retryable: boolean; mayHaveExecuted: boolean; message?: string },
  ) {
    super(options.message ?? "Router operation failed");
    this.name = "RouterOperationError";
    this.code = code;
    this.retryable = options.retryable;
    this.mayHaveExecuted = options.mayHaveExecuted;
  }
}

export interface ClassifiedWorkerError {
  outcome: CommandOutcome;
  result: { code: string; message: string };
  retryDelaySeconds: number;
}

/**
 * Turns a worker-side failure into the outcome the command plane should record.
 *
 * `mayHaveExecuted` is what separates a clean retry from an UNCERTAIN command, and
 * it is never inferred from the error's class:
 * - a `RouterOperationError` carries its own `mayHaveExecuted`, decided at the
 *   exact statement that failed;
 * - an `ApiClientError` is a control-plane failure with no view of the router, so
 *   the caller supplies `actionStarted` — true only once the router action has
 *   been attempted. A control-plane blip *before* the action is a clean retry; the
 *   same blip *after* a disruptive action must stay UNCERTAIN and be reconciled.
 * Anything else still fails closed as a permanent failure.
 */
/**
 * `actionExecuted` is the caller's own knowledge that the router action was
 * already dispatched and returned. It has to be able to OVERRIDE an error's
 * `mayHaveExecuted: false`, because that flag is two different statements
 * wearing one boolean: the connector saying "this provably did not run" (a
 * refusal on a completed channel) and the connector saying nothing at all (the
 * hard-coded default on a connect timeout, which cannot know what happened
 * before it). Consulting only the flag classified a post-action connect failure
 * as RETRYABLE_FAILURE; the command was re-queued, and because
 * `pre_observation` is frozen on first write the retry skipped straight back to
 * the action - so a REBOOT_ROUTER whose router HAD come back was rebooted again,
 * once per attempt, on real hardware.
 *
 * The property, which matters more than the reboot: a disruptive action that may
 * have executed is never silently replayed. Only `disruptive` actions are
 * escalated, because the rest (FLUSH_DNS_CACHE, RENEW_DHCP_LEASE) are idempotent
 * by construction and a replay of those costs nothing - while UNCERTAIN blocks
 * every later command for the device until it is reconciled.
 */
export function classifyWorkerError(
  error: unknown,
  disruptive: boolean,
  actionExecuted = false,
): ClassifiedWorkerError {
  if (error instanceof RouterOperationError) {
    const outcome: CommandOutcome = disruptive && (error.mayHaveExecuted || actionExecuted)
      ? "UNCERTAIN"
      : error.retryable ? "RETRYABLE_FAILURE" : "FAILED";
    return {
      outcome,
      result: { code: error.code, message: error.message.slice(0, 500) },
      retryDelaySeconds: 30,
    };
  }
  if (error instanceof ApiClientError) {
    const outcome: CommandOutcome = disruptive && actionExecuted
      ? "UNCERTAIN"
      : error.retryable ? "RETRYABLE_FAILURE" : "FAILED";
    return {
      outcome,
      result: { code: error.code, message: error.message.slice(0, 500) },
      retryDelaySeconds: 30,
    };
  }
  return {
    outcome: "FAILED",
    result: { code: "UNEXPECTED_WORKER_ERROR", message: "Worker operation failed" },
    retryDelaySeconds: 30,
  };
}

export function createConsoleLogger(): WorkerLogger {
  const write = (level: string, message: string, context?: unknown) => {
    const entry = {
      level,
      at: new Date().toISOString(),
      message: redactString(message).slice(0, 2_000),
      ...(context === undefined ? {} : { context: redactForLog(context) }),
    };
    process.stdout.write(`${JSON.stringify(entry)}\n`);
  };
  return {
    info: (message, context) => write("info", message, context),
    warn: (message, context) => write("warn", message, context),
    error: (message, context) => write("error", message, context),
  };
}
