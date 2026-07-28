import { createClient } from "@supabase/supabase-js";

type JsonObject = Record<string, unknown>;

type RpcError = {
  code?: string;
  message?: string;
};

type RpcResult = {
  data: unknown;
  error: RpcError | null;
};

type RpcCall = (
  name: string,
  args: Record<string, unknown>,
) => Promise<RpcResult>;

type ServiceRpcClient = {
  rpc: (name: string, args: Record<string, unknown>) => Promise<{
    data: unknown;
    error: null | { code?: string; message?: string };
  }>;
};

export type WorkerHandlerDependencies = {
  getEnv?: (name: string) => string | undefined;
  rpc?: RpcCall;
};

type RouteDefinition = {
  maxBodyBytes: number;
  rpcName: string;
  toRpcArgs: (body: JsonObject) => Record<string, unknown>;
};

const SECRET_HEADER = "x-network-worker-secret";
const WORKER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const encoder = new TextEncoder();

const COMMAND_EVENT_KINDS = new Set([
  "VALIDATED",
  "BACKUP_STARTED",
  "BACKUP_COMPLETED",
  "EXECUTION_STARTED",
  "EXECUTION_COMPLETED",
  "POST_CHECK_STARTED",
  "POST_CHECK_COMPLETED",
  "RECONCILIATION_STARTED",
  "RECONCILIATION_COMPLETED",
]);

const COMMAND_OUTCOMES = new Set([
  "SUCCEEDED",
  "RETRYABLE_FAILURE",
  "FAILED",
  "UNCERTAIN",
  "CANCELLED_BY_KILL_SWITCH",
]);

class RequestValidationError extends Error {}

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function jsonBytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).byteLength;
}

function asObject(value: unknown, field = "body"): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RequestValidationError(`${field} must be an object`);
  }
  return value as JsonObject;
}

function asString(
  value: unknown,
  field: string,
  minimum = 1,
  maximum = 2_000,
): string {
  if (typeof value !== "string") {
    throw new RequestValidationError(`${field} must be a string`);
  }
  const normalized = value.trim();
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new RequestValidationError(`${field} has invalid length`);
  }
  return normalized;
}

function asInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (
    !Number.isInteger(value) || (value as number) < minimum ||
    (value as number) > maximum
  ) {
    throw new RequestValidationError(`${field} is out of range`);
  }
  return value as number;
}

function asUuid(value: unknown, field: string): string {
  const uuid = asString(value, field, 36, 36);
  if (!UUID_PATTERN.test(uuid)) {
    throw new RequestValidationError(`${field} must be a UUID`);
  }
  return uuid.toLowerCase();
}

function asTimestamp(value: unknown, field: string): string {
  const timestamp = asString(value, field, 10, 64);
  if (!Number.isFinite(Date.parse(timestamp))) {
    throw new RequestValidationError(`${field} must be a timestamp`);
  }
  return timestamp;
}

function asWorkerId(value: unknown): string {
  const workerId = asString(value, "workerId", 3, 128);
  if (!WORKER_ID_PATTERN.test(workerId)) {
    throw new RequestValidationError("workerId is invalid");
  }
  return workerId;
}

function asArray(value: unknown, field: string, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new RequestValidationError(`${field} must be a bounded array`);
  }
  return value;
}

function asBoundedObject(
  value: unknown,
  field: string,
  maximumBytes: number,
): JsonObject {
  const object = asObject(value, field);
  if (jsonBytes(object) > maximumBytes) {
    throw new RequestValidationError(`${field} is too large`);
  }
  return object;
}

function asOptionalBoundedObject(
  value: unknown,
  field: string,
  maximumBytes: number,
): JsonObject | null {
  if (value === null || value === undefined) return null;
  return asBoundedObject(value, field, maximumBytes);
}

function asUpperEnum(
  value: unknown,
  field: string,
  allowed: ReadonlySet<string>,
): string {
  const normalized = asString(value, field, 1, 100).toUpperCase();
  if (!allowed.has(normalized)) {
    throw new RequestValidationError(`${field} is not allowed`);
  }
  return normalized;
}

function heartbeatArgs(body: JsonObject): Record<string, unknown> {
  const capabilities = asArray(body.capabilities, "capabilities", 32).map((
    capability,
  ) => asString(capability, "capability", 1, 100));
  const status = asUpperEnum(
    body.status,
    "status",
    new Set(["ONLINE", "DEGRADED", "PAUSED", "STOPPING"]),
  );
  const metadata = asBoundedObject(
    body.safeMetadata ?? {},
    "safeMetadata",
    16_384,
  );
  return {
    p_worker_id: asWorkerId(body.workerId),
    p_worker_version: asString(body.workerVersion, "workerVersion", 1, 100),
    p_capabilities: capabilities,
    p_status: status,
    p_queue_age_seconds: asInteger(
      body.queueAgeSeconds,
      "queueAgeSeconds",
      0,
      31_536_000,
    ),
    p_safe_metadata: metadata,
    p_started_at: asTimestamp(body.startedAt, "startedAt"),
  };
}

function connectionsArgs(body: JsonObject): Record<string, unknown> {
  return {
    p_worker_id: asWorkerId(body.workerId),
    p_limit: asInteger(body.limit ?? 100, "limit", 1, 500),
  };
}

function claimArgs(body: JsonObject): Record<string, unknown> {
  return {
    p_worker_id: asWorkerId(body.workerId),
    p_limit: asInteger(body.limit ?? 5, "limit", 1, 20),
    p_lease_seconds: asInteger(
      body.leaseSeconds ?? 90,
      "leaseSeconds",
      15,
      300,
    ),
  };
}

function renewArgs(body: JsonObject): Record<string, unknown> {
  return {
    p_worker_id: asWorkerId(body.workerId),
    p_command_id: asUuid(body.commandId, "commandId"),
    p_lease_token: asUuid(body.leaseToken, "leaseToken"),
    p_lease_seconds: asInteger(
      body.leaseSeconds ?? 90,
      "leaseSeconds",
      15,
      300,
    ),
  };
}

function ingestArgs(body: JsonObject): Record<string, unknown> {
  const payload = asBoundedObject(body.payload, "payload", 524_288);
  asTimestamp(payload.observedAt, "payload.observedAt");
  asArray(payload.devices ?? [], "payload.devices", 256);
  asArray(payload.interfaces ?? [], "payload.interfaces", 256);
  asArray(payload.clients ?? [], "payload.clients", 256);
  return { p_worker_id: asWorkerId(body.workerId), p_payload: payload };
}

function inventoryArgs(body: JsonObject): Record<string, unknown> {
  const payload = asBoundedObject(body.payload, "payload", 524_288);
  asUuid(payload.routerDeviceId, "payload.routerDeviceId");
  asArray(payload.interfaces ?? [], "payload.interfaces", 256);
  asArray(payload.aruba ?? [], "payload.aruba", 256);
  return { p_worker_id: asWorkerId(body.workerId), p_payload: payload };
}

function stageArgs(body: JsonObject): Record<string, unknown> {
  return {
    p_worker_id: asWorkerId(body.workerId),
    p_command_id: asUuid(body.commandId, "commandId"),
    p_lease_token: asUuid(body.leaseToken, "leaseToken"),
    p_event_kind: asUpperEnum(body.eventKind, "eventKind", COMMAND_EVENT_KINDS),
    p_payload: asBoundedObject(body.payload ?? {}, "payload", 65_536),
  };
}

function completeArgs(body: JsonObject): Record<string, unknown> {
  return {
    p_worker_id: asWorkerId(body.workerId),
    p_command_id: asUuid(body.commandId, "commandId"),
    p_lease_token: asUuid(body.leaseToken, "leaseToken"),
    p_outcome: asUpperEnum(body.outcome, "outcome", COMMAND_OUTCOMES),
    p_result: asBoundedObject(body.result ?? {}, "result", 65_536),
    p_rollback: asOptionalBoundedObject(body.rollback, "rollback", 65_536),
    p_retry_delay_seconds: asInteger(
      body.retryDelaySeconds ?? 30,
      "retryDelaySeconds",
      5,
      3_600,
    ),
  };
}

function incidentArgs(body: JsonObject): Record<string, unknown> {
  const payload = asBoundedObject(body.payload, "payload", 65_536);
  asUuid(payload.deviceId, "payload.deviceId");
  const eventKey = asString(payload.eventKey, "payload.eventKey", 8, 200);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/.test(eventKey)) {
    throw new RequestValidationError("payload.eventKey is invalid");
  }
  asString(payload.fingerprint, "payload.fingerprint", 8, 200);
  const incidentType = asString(
    payload.incidentType,
    "payload.incidentType",
    3,
    64,
  ).toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(incidentType)) {
    throw new RequestValidationError("payload.incidentType is invalid");
  }
  asUpperEnum(
    payload.severity,
    "payload.severity",
    new Set(["INFO", "WARNING", "CRITICAL"]),
  );
  asString(payload.title, "payload.title", 3, 200);
  asString(payload.summary, "payload.summary", 3, 2_000);
  asTimestamp(payload.observedAt, "payload.observedAt");
  asBoundedObject(
    payload.observedValues ?? {},
    "payload.observedValues",
    16_384,
  );
  if (payload.resolved !== undefined && typeof payload.resolved !== "boolean") {
    throw new RequestValidationError("payload.resolved must be boolean");
  }
  return { p_worker_id: asWorkerId(body.workerId), p_payload: payload };
}

function snapshotArgs(body: JsonObject): Record<string, unknown> {
  const payload = asBoundedObject(body.payload, "payload", 2_097_152);
  asUuid(payload.snapshotId, "payload.snapshotId");
  asUuid(payload.deviceId, "payload.deviceId");
  if (
    payload.commandId !== undefined && payload.commandId !== null &&
    payload.commandId !== ""
  ) {
    asUuid(payload.commandId, "payload.commandId");
  }
  asUpperEnum(
    payload.source,
    "payload.source",
    new Set(["MANUAL", "SCHEDULED", "PRE_ACTION", "POST_ACTION"]),
  );
  asBoundedObject(
    payload.normalizedContent,
    "payload.normalizedContent",
    1_048_576,
  );
  const lines = asArray(payload.redactedLines, "payload.redactedLines", 50_000);
  if (jsonBytes(lines) > 1_048_576) {
    throw new RequestValidationError("payload.redactedLines is too large");
  }
  const hash = asString(payload.contentHash, "payload.contentHash", 64, 64);
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    throw new RequestValidationError("payload.contentHash is invalid");
  }
  return { p_worker_id: asWorkerId(body.workerId), p_payload: payload };
}

function maintenanceArgs(body: JsonObject): Record<string, unknown> {
  return {
    p_worker_id: asWorkerId(body.workerId),
    p_now: asTimestamp(body.now, "now"),
  };
}

const ROUTES: Readonly<Record<string, RouteDefinition>> = Object.freeze({
  heartbeat: {
    maxBodyBytes: 32_768,
    rpcName: "network_center_worker_heartbeat_v1",
    toRpcArgs: heartbeatArgs,
  },
  connections: {
    maxBodyBytes: 8_192,
    rpcName: "network_center_worker_list_connections_v1",
    toRpcArgs: connectionsArgs,
  },
  claim: {
    maxBodyBytes: 8_192,
    rpcName: "network_center_worker_claim_v1",
    toRpcArgs: claimArgs,
  },
  renew: {
    maxBodyBytes: 8_192,
    rpcName: "network_center_worker_renew_v1",
    toRpcArgs: renewArgs,
  },
  ingest: {
    maxBodyBytes: 600_000,
    rpcName: "network_center_worker_ingest_v1",
    toRpcArgs: ingestArgs,
  },
  inventory: {
    maxBodyBytes: 600_000,
    rpcName: "network_center_worker_inventory_v1",
    toRpcArgs: inventoryArgs,
  },
  stage: {
    maxBodyBytes: 100_000,
    rpcName: "network_center_worker_command_event_v1",
    toRpcArgs: stageArgs,
  },
  complete: {
    maxBodyBytes: 150_000,
    rpcName: "network_center_worker_complete_v1",
    toRpcArgs: completeArgs,
  },
  incidents: {
    maxBodyBytes: 100_000,
    rpcName: "network_center_worker_upsert_incident_v1",
    toRpcArgs: incidentArgs,
  },
  snapshots: {
    maxBodyBytes: 2_200_000,
    rpcName: "network_center_worker_snapshot_v1",
    toRpcArgs: snapshotArgs,
  },
  maintenance: {
    maxBodyBytes: 8_192,
    rpcName: "network_center_worker_maintenance_v1",
    toRpcArgs: maintenanceArgs,
  },
});

function routeFromUrl(url: string): string {
  const parts = new URL(url).pathname.split("/").filter(Boolean);
  const marker = parts.lastIndexOf("network-center-worker");
  return (marker >= 0 ? parts.slice(marker + 1) : parts).join("/");
}

async function readJsonBody(
  request: Request,
  maximumBytes: number,
): Promise<JsonObject> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]
    .trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new TypeError("unsupported_content_type");
  }
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new RangeError("body_too_large");
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > maximumBytes) {
    throw new RangeError("body_too_large");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new SyntaxError("invalid_json");
  }
  return asObject(parsed);
}

export async function constantTimeSecretEquals(
  provided: string,
  expected: string,
): Promise<boolean> {
  const [providedDigest, expectedDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const left = new Uint8Array(providedDigest);
  const right = new Uint8Array(expectedDigest);
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

function createServiceRpc(
  getEnv: (name: string) => string | undefined,
): RpcCall {
  let client: ServiceRpcClient | undefined;
  return async (name, args) => {
    const supabaseUrl = getEnv("SUPABASE_URL")?.trim();
    const serviceRoleKey = getEnv("SUPABASE_SERVICE_ROLE_KEY")?.trim();
    if (!supabaseUrl || !serviceRoleKey) {
      return { data: null, error: { code: "WORKER_CONFIG_MISSING" } };
    }
    client ??= createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    }) as unknown as ServiceRpcClient;
    const { data, error } = await client.rpc(name, args);
    return {
      data,
      error: error ? { code: error.code, message: error.message } : null,
    };
  };
}

function rpcErrorStatus(code: string | undefined): number {
  if (code === "22023") return 400;
  if (code === "42501") return 403;
  if (code === "P0002") return 404;
  if (code === "23505" || code === "55000") return 409;
  return 502;
}

export function createWorkerHandler(
  dependencies: WorkerHandlerDependencies = {},
): (request: Request) => Promise<Response> {
  const getEnv = dependencies.getEnv ?? ((name) => Deno.env.get(name));
  const rpc = dependencies.rpc ?? createServiceRpc(getEnv);

  return async (request: Request): Promise<Response> => {
    const expectedSecret = getEnv("NETWORK_WORKER_SECRET")?.trim() ?? "";
    if (expectedSecret.length < 32 || expectedSecret.length > 512) {
      return jsonResponse(503, { error: "worker_auth_unavailable" });
    }

    const providedSecret = request.headers.get(SECRET_HEADER) ?? "";
    const authenticated = await constantTimeSecretEquals(
      providedSecret,
      expectedSecret,
    );
    if (!authenticated) {
      return jsonResponse(401, { error: "unauthorized" });
    }

    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "method_not_allowed" }), {
        status: 405,
        headers: {
          allow: "POST",
          "cache-control": "no-store",
          "content-type": "application/json; charset=utf-8",
        },
      });
    }

    const route = ROUTES[routeFromUrl(request.url)];
    if (!route) {
      return jsonResponse(404, { error: "route_not_found" });
    }

    let body: JsonObject;
    try {
      body = await readJsonBody(request, route.maxBodyBytes);
    } catch (error) {
      if (error instanceof RangeError) {
        return jsonResponse(413, { error: "body_too_large" });
      }
      if (error instanceof TypeError) {
        return jsonResponse(415, { error: "unsupported_content_type" });
      }
      return jsonResponse(400, { error: "invalid_json" });
    }

    let args: Record<string, unknown>;
    try {
      args = route.toRpcArgs(body);
    } catch (error) {
      if (error instanceof RequestValidationError) {
        return jsonResponse(400, { error: "invalid_request" });
      }
      return jsonResponse(400, { error: "invalid_request" });
    }

    let result: RpcResult;
    try {
      result = await rpc(route.rpcName, args);
    } catch {
      return jsonResponse(502, { error: "worker_backend_error" });
    }
    if (result.error) {
      return jsonResponse(rpcErrorStatus(result.error.code), {
        error: "worker_backend_error",
        code: result.error.code ?? "UNKNOWN",
      });
    }
    return jsonResponse(200, { ok: true, data: result.data });
  };
}

if (import.meta.main) {
  Deno.serve(createWorkerHandler());
}
