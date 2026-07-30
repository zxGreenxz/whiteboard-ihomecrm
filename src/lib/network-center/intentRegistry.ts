import type { NetworkActionType } from "./contracts";

export interface IntentStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface NetworkActionIntentTarget {
  actorId: string;
  organizationId: string;
  buildingId: string;
  deviceId: string;
  actionType: NetworkActionType;
  interfaceId?: string | null;
  parameters: Record<string, string | number | boolean>;
  reason: string;
  confirmation?: string | null;
}

export type NetworkIntentStatus =
  | "PENDING"
  | "SUBMITTING"
  | "SUBMISSION_UNKNOWN"
  | "QUEUED"
  | "LEASED"
  | "RUNNING"
  | "RETRY_WAIT"
  | "RECONCILING"
  | "UNCERTAIN"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED_BY_KILL_SWITCH";

export interface NetworkActionIntent {
  id: string;
  semanticKey: string;
  target: NetworkActionIntentTarget;
  commandId: string | null;
  status: NetworkIntentStatus;
  updatedAt: string;
}

export interface IntentRegistry {
  begin(target: NetworkActionIntentTarget): NetworkActionIntent;
  lookup(target: NetworkActionIntentTarget): NetworkActionIntent | null;
  attachCommand(intentId: string, commandId: string, status?: string): NetworkActionIntent | null;
  observe(intentId: string, status: string): NetworkActionIntent | null;
  observeCommand(commandId: string, status: string): NetworkActionIntent | null;
  closeDialog(target: NetworkActionIntentTarget): void;
  reset(target: NetworkActionIntentTarget): boolean;
  prune(scope: { actorId: string; organizationIds: string[] }): number;
  list(scope?: Partial<Pick<
    NetworkActionIntentTarget,
    "actorId" | "organizationId" | "buildingId"
  >>): NetworkActionIntent[];
  subscribe(listener: () => void): () => void;
}

interface RegistryOptions {
  storage?: IntentStorage;
  now?: () => Date;
  storageKey?: string;
}

const DEFAULT_STORAGE_KEY = "ihomecrm:network-center:intents:v1";
const TERMINAL_STATUSES = new Set<NetworkIntentStatus>([
  "SUCCEEDED",
  "FAILED",
  "CANCELLED_BY_KILL_SWITCH",
]);

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  return value;
}

function normalizeTarget(target: NetworkActionIntentTarget): NetworkActionIntentTarget {
  return {
    actorId: normalize(target.actorId),
    organizationId: normalize(target.organizationId),
    buildingId: normalize(target.buildingId),
    deviceId: normalize(target.deviceId),
    actionType: target.actionType,
    interfaceId: target.interfaceId ? normalize(target.interfaceId) : null,
    parameters: canonicalValue(target.parameters) as Record<string, string | number | boolean>,
    reason: target.reason.trim(),
    confirmation: target.confirmation?.trim() || null,
  };
}

function semanticKey(target: NetworkActionIntentTarget): string {
  return JSON.stringify(canonicalValue(normalizeTarget(target)));
}

function browserStorage(): IntentStorage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function parseRecords(raw: string | null): NetworkActionIntent[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is NetworkActionIntent => {
      if (!entry || typeof entry !== "object") return false;
      const record = entry as Partial<NetworkActionIntent>;
      return typeof record.id === "string"
        && typeof record.semanticKey === "string"
        && typeof record.updatedAt === "string"
        && typeof record.status === "string"
        && (record.commandId === null || typeof record.commandId === "string")
        && Boolean(record.target && typeof record.target === "object");
    });
  } catch {
    return [];
  }
}

function normalizeStatus(status: string): NetworkIntentStatus {
  const normalized = status.trim().toUpperCase();
  if (normalized === "SUCCESS" || normalized === "ROLLED_BACK") return "SUCCEEDED";
  return [
    "PENDING",
    "SUBMITTING",
    "SUBMISSION_UNKNOWN",
    "QUEUED",
    "LEASED",
    "RUNNING",
    "RETRY_WAIT",
    "RECONCILING",
    "UNCERTAIN",
    "SUCCEEDED",
    "FAILED",
    "CANCELLED_BY_KILL_SWITCH",
  ].includes(normalized as NetworkIntentStatus)
    ? normalized as NetworkIntentStatus
    : "PENDING";
}

export function createIntentRegistry(
  uuid: () => string = () => crypto.randomUUID(),
  options: RegistryOptions = {},
): IntentRegistry {
  const storage = options.storage ?? browserStorage();
  const storageKey = options.storageKey ?? DEFAULT_STORAGE_KEY;
  const now = options.now ?? (() => new Date());
  const listeners = new Set<() => void>();
  let volatileRecords: NetworkActionIntent[] = [];

  const read = () => storage
    ? parseRecords(storage.getItem(storageKey))
    : volatileRecords.map((record) => ({ ...record }));
  const write = (records: NetworkActionIntent[]) => {
    if (storage) {
      if (records.length === 0) storage.removeItem(storageKey);
      else storage.setItem(storageKey, JSON.stringify(records));
    } else {
      volatileRecords = records;
    }
    listeners.forEach((listener) => listener());
  };

  const findById = (intentId: string) => read().find((record) => record.id === intentId) ?? null;

  const registry: IntentRegistry = {
    begin(target) {
      const normalizedTarget = normalizeTarget(target);
      const key = semanticKey(normalizedTarget);
      const records = read();
      const existing = records.find((record) => record.semanticKey === key);
      if (existing) return existing;
      const created: NetworkActionIntent = {
        id: uuid(),
        semanticKey: key,
        target: normalizedTarget,
        commandId: null,
        status: "PENDING",
        updatedAt: now().toISOString(),
      };
      write([...records, created]);
      return created;
    },
    lookup(target) {
      const key = semanticKey(target);
      return read().find((record) => record.semanticKey === key) ?? null;
    },
    attachCommand(intentId, commandId, status = "QUEUED") {
      const records = read();
      const index = records.findIndex((record) => record.id === intentId);
      if (index < 0) return null;
      const normalizedStatus = normalizeStatus(status);
      if (TERMINAL_STATUSES.has(normalizedStatus)) {
        write(records.filter((record) => record.id !== intentId));
        return null;
      }
      const normalizedCommandId = normalize(commandId);
      if (records[index].commandId === normalizedCommandId
        && records[index].status === normalizedStatus) {
        return records[index];
      }
      const updated = {
        ...records[index],
        commandId: normalizedCommandId,
        status: normalizedStatus,
        updatedAt: now().toISOString(),
      };
      records[index] = updated;
      write(records);
      return updated;
    },
    observe(intentId, status) {
      const current = findById(intentId);
      if (!current) return null;
      const normalizedStatus = normalizeStatus(status);
      const records = read();
      if (TERMINAL_STATUSES.has(normalizedStatus)) {
        write(records.filter((record) => record.id !== intentId));
        return null;
      }
      if (current.status === normalizedStatus) return current;
      const updated = {
        ...current,
        status: normalizedStatus,
        updatedAt: now().toISOString(),
      };
      write(records.map((record) => record.id === intentId ? updated : record));
      return updated;
    },
    observeCommand(commandId, status) {
      const normalizedCommandId = normalize(commandId);
      const current = read().find((record) => record.commandId === normalizedCommandId);
      return current ? registry.observe(current.id, status) : null;
    },
    closeDialog() {
      // Dialog lifecycle never owns the durable idempotency token.
    },
    reset(target) {
      const key = semanticKey(target);
      const records = read();
      const current = records.find((record) => record.semanticKey === key);
      if (!current || current.commandId !== null || current.status !== "PENDING") {
        return false;
      }
      write(records.filter((record) => record.semanticKey !== key));
      return true;
    },
    prune(scope) {
      const actorId = normalize(scope.actorId);
      const organizationIds = new Set(scope.organizationIds.map(normalize).filter(Boolean));
      if (!actorId || organizationIds.size === 0) return 0;
      const records = read();
      const retained = records.filter((record) => (
        record.target.actorId === actorId
        && organizationIds.has(record.target.organizationId)
      ));
      const removed = records.length - retained.length;
      if (removed > 0) write(retained);
      return removed;
    },
    list(scope = {}) {
      const actorId = scope.actorId ? normalize(scope.actorId) : null;
      const organizationId = scope.organizationId ? normalize(scope.organizationId) : null;
      const buildingId = scope.buildingId ? normalize(scope.buildingId) : null;
      return read().filter((record) => (
        (!actorId || record.target.actorId === actorId)
        && (!organizationId || record.target.organizationId === organizationId)
        && (!buildingId || record.target.buildingId === buildingId)
      ));
    },
    subscribe(listener) {
      listeners.add(listener);
      const onStorage = (event: StorageEvent) => {
        if (event.key === storageKey) listener();
      };
      if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
      return () => {
        listeners.delete(listener);
        if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
      };
    },
  };

  return registry;
}
