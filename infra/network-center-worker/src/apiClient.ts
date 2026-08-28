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
  intentType: z.string().min(3).max(64),
  managedTarget: z.record(z.string(), z.unknown()),
  preObservation: z.record(z.string(), z.unknown()).nullable(),
  expectedPostcondition: z.record(z.string(), z.unknown()),
  observationDeadline: z.iso.datetime({ offset: true }),
  transitionVersion: z.number().int().positive(),
  fencingGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

const observationReceiptSchema = z.object({
  accepted: z.literal(true),
  transitionVersion: z.number().int().positive(),
}).passthrough();

const inventoryMappingSchema = z.object({
  routerDeviceId: z.uuid(),
  interfaces: z.array(z.object({
    managedResourceId: z.uuid().nullable(),
    interfaceKey: z.string().min(1).max(160),
    id: z.uuid(),
    currentName: z.string().min(1).max(160),
    immutableKey: z.string().min(1).max(160).nullable(),
    enrolledRole: z.enum(["WAN", "LAN", "ACCESS", "UPLINK", "MANAGEMENT", "UNKNOWN"]),
    protected: z.boolean(),
    enrollmentState: z.enum(["DISCOVERED", "ENROLLED", "REVOKED"]),
  }).strict()).max(256),
  aruba: z.array(z.object({ externalKey: z.string(), id: z.uuid() })).max(256),
  // `optional` co chu y: mot co so du lieu chua chay migration H196A tra ve
  // phan hoi khong co khoa nay, va worker moi phai chay duoc tren do. Bat buoc
  // o day se bien mot thu tu phat hanh sai thanh su co ngung giam sat.
  h196a: z.array(z.object({ stableKey: z.string(), id: z.uuid() })).max(256).optional(),
  inventoryStatus: z.enum(["OK", "DEGRADED"]).optional(),
  quarantinedCount: z.number().int().nonnegative().max(1_000_000).optional(),
}).passthrough();

const responseEnvelope = <T extends z.ZodType>(schema: T) => z.object({
  ok: z.literal(true),
  data: schema,
});

export class ApiClientError extends Error {
  readonly retryable: boolean;
  readonly status: number | null;
  readonly code: string;
  /**
   * What the SERVER called the failure: the SQLSTATE for an RPC error
   * (`23514`), or the Edge's own reason string for a rejected request.
   *
   * It exists because the F6 diagnosis needed three logs from three systems to
   * learn one fact the server had already stated. Null when the response
   * carried nothing usable.
   */
  readonly serverReason: string | null;

  constructor(options: {
    code: string;
    retryable: boolean;
    status?: number | null;
    message?: string;
    serverReason?: string | null;
  }) {
    super(options.message ?? "Network Center worker API request failed");
    this.name = "ApiClientError";
    this.code = options.code;
    this.retryable = options.retryable;
    this.status = options.status ?? null;
    this.serverReason = options.serverReason ?? null;
  }
}

interface ApiClientOptions {
  baseUrl: URL;
  secret: string;
  timeoutMs: number;
  fetch?: typeof fetch;
}

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/** Hard cap on an error body. Anything larger is discarded unread. */
const MAX_ERROR_REASON_BYTES = 4_096;
/** Hard cap on what is kept from it, so a log line can never be flooded. */
const MAX_ERROR_REASON_LENGTH = 200;

/**
 * The server's own name for a failure, read from a STRICTLY BOUNDED error body.
 *
 * The Edge answers `{error, code}` for an RPC failure (`code` is the SQLSTATE)
 * and `{error, reason}` for a rejected request, and both were previously thrown
 * away by cancelling the body - which is why an F6 poll logged nothing but
 * `ApiClientError` and the actual cause had to be recovered by correlating
 * three separate systems' logs at matching timestamps.
 *
 * Bounded twice and fails closed to null: a declared-oversize body is never
 * read, a body that turns out oversize is discarded, and any parse failure
 * yields null rather than propagating. Only the two known keys are read, so no
 * unexpected server field can reach a log through here.
 */
async function readErrorReason(response: Response): Promise<string | null> {
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (!Number.isFinite(declaredLength) || declaredLength > MAX_ERROR_REASON_BYTES) {
    try {
      await response.body?.cancel();
    } catch {
      // The response is already unusable; intentionally ignore cancellation errors.
    }
    return null;
  }
  try {
    const raw = await response.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_ERROR_REASON_BYTES) return null;
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const body = parsed as Record<string, unknown>;
    const reason = typeof body.code === "string"
      ? body.code
      : typeof body.reason === "string"
        ? body.reason
        : null;
    return reason === null ? null : reason.slice(0, MAX_ERROR_REASON_LENGTH);
  } catch {
    return null;
  }
}

export class NetworkCenterApiClient implements NetworkCenterWorkerApi {
  readonly #baseUrl: string;
  readonly #secret: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: ApiClientOptions) {
    this.#baseUrl = options.baseUrl.href.replace(/\/+$/, "");
    this.#secret = options.secret;
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
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch {
        throw new ApiClientError({ code: "NETWORK_ERROR", retryable: true });
      }

      if (!response.ok) {
        const serverReason = await readErrorReason(response);
        throw new ApiClientError({
          code: `HTTP_${response.status}`,
          retryable: isRetryableStatus(response.status),
          status: response.status,
          serverReason,
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

  async claimCommands(limit = 3, leaseSeconds = 90): Promise<CommandClaim[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 3) {
      throw new RangeError("Command claim limit must be between 1 and 3");
    }
    const data = await this.#post("claim", { limit, leaseSeconds }, z.object({
      items: z.array(commandClaimSchema).max(limit),
    }));
    return data.items as CommandClaim[];
  }

  async renewLease(input: {
    commandId: string;
    leaseToken: string;
    fencingGeneration: number;
    leaseSeconds: number;
  }): Promise<unknown> {
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
    fencingGeneration: number;
    eventKind: string;
    payload: Record<string, unknown>;
  }): Promise<unknown> {
    return this.#post("stage", input, z.unknown());
  }

  async observe(input: {
    commandId: string;
    leaseToken: string;
    fencingGeneration: number;
    transitionVersion: number;
    observationId: string;
    observationKind: "PRE_ACTION" | "POST_ACTION" | "RECONCILIATION";
    observedAt: string;
    evidence: Record<string, unknown>;
  }): Promise<{ accepted: true; transitionVersion: number }> {
    return this.#post("observe", input, observationReceiptSchema);
  }

  async complete(input: {
    commandId: string;
    leaseToken: string;
    fencingGeneration: number;
    transitionVersion: number;
    outcome: "EVALUATE_POSTCONDITION" | "RETRYABLE_FAILURE" | "FAILED" | "UNCERTAIN" | "CANCELLED_BY_KILL_SWITCH";
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
