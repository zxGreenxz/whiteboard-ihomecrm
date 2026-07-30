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

export interface RouterInterfaceObservation {
  externalKey: string;
  displayName: string;
  immutableKey?: string | null;
  role: string;
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

export interface RouterClientObservation {
  externalKey: string;
  [key: string]: JsonValue;
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

export function classifyWorkerError(error: unknown, disruptive: boolean): ClassifiedWorkerError {
  if (error instanceof RouterOperationError) {
    const outcome: CommandOutcome = disruptive && error.mayHaveExecuted
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
