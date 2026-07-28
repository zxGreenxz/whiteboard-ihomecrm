import { z } from "zod";

import type {
  CommandClaim,
  InventoryMapping,
  JsonObject,
  NetworkCenterWorkerApi,
  NetworkConnection,
} from "./domain.js";

const connectionSchema = z.object({
  connectionId: z.uuid(),
  organizationId: z.uuid(),
  buildingId: z.uuid(),
  deviceId: z.uuid(),
  deviceKind: z.enum(["MIKROTIK", "ARUBA"]),
  externalKey: z.string().min(1).max(255),
  displayName: z.string().min(1).max(255),
  transport: z.enum(["ROUTEROS_SSH", "ROUTEROS_API", "SNMP", "HTTPS", "DISPLAY_ONLY"]),
  managementIp: z.string().min(2).max(64),
  managementPort: z.number().int().min(1).max(65_535),
  credentialRef: z.string().min(3).max(255).nullable(),
  hostKeyFingerprint: z.string().min(20).max(200).nullable(),
  pollIntervalSeconds: z.number().int().min(30).max(3_600),
  connectTimeoutMs: z.number().int().min(1_000).max(30_000),
  monitoringEnabled: z.boolean(),
  changesPaused: z.boolean(),
});

const commandClaimSchema = z.object({
  commandId: z.uuid(),
  organizationId: z.uuid(),
  buildingId: z.uuid(),
  deviceId: z.uuid(),
  interfaceId: z.uuid().nullable(),
  actionType: z.string().min(3).max(64),
  reason: z.string().min(1).max(1_000),
  parameters: z.record(z.string(), z.unknown()),
  attemptNo: z.number().int().positive(),
  leaseToken: z.uuid(),
  leaseExpiresAt: z.iso.datetime({ offset: true }),
  reconciliation: z.boolean(),
});

const inventoryMappingSchema = z.object({
  routerDeviceId: z.uuid(),
  interfaces: z.array(z.object({ interfaceKey: z.string(), id: z.uuid() })).max(256),
  aruba: z.array(z.object({ externalKey: z.string(), id: z.uuid() })).max(256),
}).passthrough();

const responseEnvelope = <T extends z.ZodType>(schema: T) => z.object({
  ok: z.literal(true),
  data: schema,
});

export class ApiClientError extends Error {
  readonly retryable: boolean;
  readonly status: number | null;
  readonly code: string;

  constructor(options: {
    code: string;
    retryable: boolean;
    status?: number | null;
    message?: string;
  }) {
    super(options.message ?? "Network Center worker API request failed");
    this.name = "ApiClientError";
    this.code = options.code;
    this.retryable = options.retryable;
    this.status = options.status ?? null;
  }
}

interface ApiClientOptions {
  baseUrl: URL;
  secret: string;
  workerId: string;
  timeoutMs: number;
  fetch?: typeof fetch;
}

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export class NetworkCenterApiClient implements NetworkCenterWorkerApi {
  readonly #baseUrl: string;
  readonly #secret: string;
  readonly #workerId: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: ApiClientOptions) {
    this.#baseUrl = options.baseUrl.href.replace(/\/+$/, "");
    this.#secret = options.secret;
    this.#workerId = options.workerId;
    this.#timeoutMs = options.timeoutMs;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async #post<T>(route: string, body: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.#fetch(`${this.#baseUrl}/${route}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-network-worker-secret": this.#secret,
          },
          body: JSON.stringify({ workerId: this.#workerId, ...body }),
          signal: controller.signal,
        });
      } catch {
        throw new ApiClientError({ code: "NETWORK_ERROR", retryable: true });
      }

      if (!response.ok) {
        try {
          await response.body?.cancel();
        } catch {
          // The response is already unusable; intentionally ignore cancellation errors.
        }
        throw new ApiClientError({
          code: `HTTP_${response.status}`,
          retryable: isRetryableStatus(response.status),
          status: response.status,
        });
      }

      const declaredLength = Number(response.headers.get("content-length") ?? "0");
      if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
        throw new ApiClientError({ code: "RESPONSE_TOO_LARGE", retryable: false, status: response.status });
      }
      let raw: string;
      try {
        raw = await response.text();
      } catch {
        throw new ApiClientError({ code: "NETWORK_ERROR", retryable: true, status: response.status });
      }
      if (Buffer.byteLength(raw, "utf8") > MAX_RESPONSE_BYTES) {
        throw new ApiClientError({ code: "RESPONSE_TOO_LARGE", retryable: false, status: response.status });
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new ApiClientError({ code: "INVALID_RESPONSE", retryable: false, status: response.status });
      }
      const result = responseEnvelope(schema).safeParse(parsed);
      if (!result.success) {
        throw new ApiClientError({ code: "INVALID_RESPONSE", retryable: false, status: response.status });
      }
      return result.data.data;
    } finally {
      clearTimeout(timer);
    }
  }

  async listConnections(limit = 100): Promise<NetworkConnection[]> {
    const data = await this.#post("connections", { limit }, z.object({
      items: z.array(connectionSchema).max(500),
    }));
    return data.items as NetworkConnection[];
  }

  async heartbeat(input: {
    status: string;
    workerVersion: string;
    capabilities: string[];
    queueAgeSeconds: number;
    safeMetadata: JsonObject;
    startedAt: string;
  }): Promise<unknown> {
    return this.#post("heartbeat", input, z.unknown());
  }

  async claimCommands(limit = 5, leaseSeconds = 90): Promise<CommandClaim[]> {
    const data = await this.#post("claim", { limit, leaseSeconds }, z.object({
      items: z.array(commandClaimSchema).max(20),
    }));
    return data.items as CommandClaim[];
  }

  async renewLease(input: { commandId: string; leaseToken: string; leaseSeconds: number }): Promise<unknown> {
    return this.#post("renew", input, z.unknown());
  }

  async ingest(payload: Record<string, unknown>): Promise<unknown> {
    return this.#post("ingest", { payload }, z.unknown());
  }

  async inventory(payload: Record<string, unknown>): Promise<InventoryMapping> {
    return this.#post("inventory", { payload }, inventoryMappingSchema) as Promise<InventoryMapping>;
  }

  async stage(input: {
    commandId: string;
    leaseToken: string;
    eventKind: string;
    payload: Record<string, unknown>;
  }): Promise<unknown> {
    return this.#post("stage", input, z.unknown());
  }

  async complete(input: {
    commandId: string;
    leaseToken: string;
    outcome: "SUCCEEDED" | "RETRYABLE_FAILURE" | "FAILED" | "UNCERTAIN" | "CANCELLED_BY_KILL_SWITCH";
    result: Record<string, unknown>;
    rollback?: Record<string, unknown> | null;
    retryDelaySeconds?: number;
  }): Promise<unknown> {
    return this.#post("complete", input, z.unknown());
  }

  async upsertIncident(payload: Record<string, unknown>): Promise<unknown> {
    return this.#post("incidents", { payload }, z.unknown());
  }

  async snapshot(payload: Record<string, unknown>): Promise<unknown> {
    return this.#post("snapshots", { payload }, z.unknown());
  }

  async maintenance(now: string): Promise<unknown> {
    return this.#post("maintenance", { now }, z.unknown());
  }
}
