import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import { credentialDigestHex, WorkerCredentialError } from "./workerAuth.ts";

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
  bodySchema: z.ZodType<JsonObject>;
  toRpcArgs: (body: JsonObject) => Record<string, unknown>;
};

const SECRET_HEADER = "x-network-worker-secret";
const CLAIM_LIMIT = 3;
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
  "EVALUATE_POSTCONDITION",
  "RETRYABLE_FAILURE",
  "FAILED",
  "UNCERTAIN",
  "CANCELLED_BY_KILL_SWITCH",
]);

// ---------------------------------------------------------------------------
// Telemetry value domains.
//
// This function used to validate the SHAPE of an ingest payload and nothing
// about its VALUES: `asArray(payload.clients, ..., 256)` and no more. So when
// the worker sent `connectionType: "DHCP"` / `sessionType: "LEASE"` - two values
// no CHECK constraint in the schema accepts - they were forwarded intact, and
// the first thing that noticed was Postgres, mid-transaction, which rolled back
// every device, interface and client row in the batch.
//
// The sets below mirror the CHECK constraints EXACTLY: not laxer (that forwards
// a violation again) and not stricter (that would refuse data the database is
// happy to store). Comparison is exact, with no case folding, because the CHECK
// is exact - accepting "dhcp" here would mean the Edge silently repairing a
// value the database would have rejected, which is how a producer drifts into a
// shape only this function understands.
//
// They are a RESTATEMENT of the database and are pinned to it rather than
// trusted: scripts/test-network-center-ingest-domains-disposable.mjs reads the
// real domains out of pg_get_constraintdef on a real PostgreSQL 17 cluster built
// from the real migrations and fails if any set here differs by one member.
// ---------------------------------------------------------------------------

/** `network_client_current.connection_type`, `network_client_sessions.connection_type`. */
const CLIENT_CONNECTION_TYPES = new Set([
  "UNKNOWN",
  "ETHERNET",
  "WIFI",
  "VPN",
]);
/** `network_client_current.session_type`. */
const CLIENT_SESSION_TYPES = new Set([
  "UNKNOWN",
  "DHCP",
  "HOTSPOT",
  "STATIC",
  "ARP",
]);
/** `network_device_current.health_status`. */
const DEVICE_HEALTH_STATUSES = new Set([
  "UNKNOWN",
  "HEALTHY",
  "DEGRADED",
  "CRITICAL",
  "OFFLINE",
]);
/** `network_device_current.pppoe_state`. */
const DEVICE_PPPOE_STATES = new Set([
  "UNKNOWN",
  "UP",
  "DOWN",
  "NOT_APPLICABLE",
]);
/** `network_interface_current.link_state`. */
const INTERFACE_LINK_STATES = new Set(["UNKNOWN", "UP", "DOWN"]);

class RequestValidationError extends Error {}

// Thrown when a caller of readJsonBody supplies a byte cap that is not a
// valid positive integer. This must never happen for a real, allow-listed
// route (every RouteDefinition.maxBodyBytes is a literal positive number),
// so surfacing it distinctly (rather than silently treating the cap as
// unlimited) turns a future misconfiguration into a loud 500 instead of a
// silent unbounded-body-read regression.
class InvalidBodyCapError extends Error {}

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

function asArray(value: unknown, field: string, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new RequestValidationError(`${field} must be a bounded array`);
  }
  return value;
}

function strictBodySchema(keys: readonly string[]): z.ZodType<JsonObject> {
  const shape = Object.fromEntries(
    keys.map((key) => [key, z.unknown().optional()]),
  ) as Record<string, z.ZodOptional<z.ZodUnknown>>;
  return z.object(shape).strict();
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

/**
 * A telemetry field that must land inside a CHECK-constrained column.
 *
 * Absent and null are ALLOWED: the ingest RPC coalesces both to 'UNKNOWN', which
 * is a legal member of every domain here, so rejecting them would refuse rows
 * the database stores happily. Anything present must match a member exactly.
 */
function assertTelemetryDomain(
  value: unknown,
  field: string,
  allowed: ReadonlySet<string>,
): void {
  if (value === undefined || value === null) return;
  if (typeof value !== "string" || !allowed.has(value)) {
    throw new RequestValidationError(`${field} is outside its value domain`);
  }
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
    p_limit: asInteger(body.limit ?? 100, "limit", 1, 500),
  };
}

function claimArgs(body: JsonObject): Record<string, unknown> {
  const limit = Object.hasOwn(body, "limit") ? body.limit : CLAIM_LIMIT;
  return {
    p_limit: asInteger(limit, "limit", 1, CLAIM_LIMIT),
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
    p_command_id: asUuid(body.commandId, "commandId"),
    p_lease_token: asUuid(body.leaseToken, "leaseToken"),
    p_fencing_generation: asInteger(
      body.fencingGeneration,
      "fencingGeneration",
      1,
      Number.MAX_SAFE_INTEGER,
    ),
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
  const devices = asArray(payload.devices ?? [], "payload.devices", 256);
  const interfaces = asArray(
    payload.interfaces ?? [],
    "payload.interfaces",
    256,
  );
  const clients = asArray(payload.clients ?? [], "payload.clients", 256);

  // Every enumerated column this RPC writes, checked before the transaction
  // opens. `jsonb_to_recordset` also requires each element to BE an object, so
  // that is asserted here too rather than left to a 22023 from inside the CTE.
  devices.forEach((device, index) => {
    const row = asObject(device, `payload.devices[${index}]`);
    assertTelemetryDomain(
      row.healthStatus,
      `payload.devices[${index}].healthStatus`,
      DEVICE_HEALTH_STATUSES,
    );
    assertTelemetryDomain(
      row.pppoeState,
      `payload.devices[${index}].pppoeState`,
      DEVICE_PPPOE_STATES,
    );
  });
  interfaces.forEach((item, index) => {
    const row = asObject(item, `payload.interfaces[${index}]`);
    assertTelemetryDomain(
      row.linkState,
      `payload.interfaces[${index}].linkState`,
      INTERFACE_LINK_STATES,
    );
  });
  clients.forEach((client, index) => {
    const row = asObject(client, `payload.clients[${index}]`);
    assertTelemetryDomain(
      row.connectionType,
      `payload.clients[${index}].connectionType`,
      CLIENT_CONNECTION_TYPES,
    );
    assertTelemetryDomain(
      row.sessionType,
      `payload.clients[${index}].sessionType`,
      CLIENT_SESSION_TYPES,
    );
  });
  return { p_payload: payload };
}

function inventoryArgs(body: JsonObject): Record<string, unknown> {
  const payload = asBoundedObject(body.payload, "payload", 524_288);
  asUuid(payload.routerDeviceId, "payload.routerDeviceId");
  asUuid(payload.discoveryRunId, "payload.discoveryRunId");
  asTimestamp(payload.observedAt, "payload.observedAt");
  const batchIndex = asInteger(payload.batchIndex, "payload.batchIndex", 0, 4_095);
  const batchCount = asInteger(payload.batchCount, "payload.batchCount", 1, 4_096);
  if (batchIndex >= batchCount) {
    throw new RequestValidationError("payload.batchIndex must be below batchCount");
  }
  asArray(payload.interfaces ?? [], "payload.interfaces", 256);
  asArray(payload.aruba ?? [], "payload.aruba", 256);
  asArray(payload.quarantine ?? [], "payload.quarantine", 256);
  return { p_payload: payload };
}

function stageArgs(body: JsonObject): Record<string, unknown> {
  return {
    p_command_id: asUuid(body.commandId, "commandId"),
    p_lease_token: asUuid(body.leaseToken, "leaseToken"),
    p_fencing_generation: asInteger(
      body.fencingGeneration,
      "fencingGeneration",
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    p_event_kind: asUpperEnum(body.eventKind, "eventKind", COMMAND_EVENT_KINDS),
    p_payload: asBoundedObject(body.payload ?? {}, "payload", 65_536),
  };
}

function observeArgs(body: JsonObject): Record<string, unknown> {
  return {
    p_command_id: asUuid(body.commandId, "commandId"),
    p_lease_token: asUuid(body.leaseToken, "leaseToken"),
    p_fencing_generation: asInteger(
      body.fencingGeneration,
      "fencingGeneration",
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    p_transition_version: asInteger(
      body.transitionVersion,
      "transitionVersion",
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    p_observation_id: asUuid(body.observationId, "observationId"),
    p_observation_kind: asUpperEnum(
      body.observationKind,
      "observationKind",
      new Set(["PRE_ACTION", "POST_ACTION", "RECONCILIATION"]),
    ),
    p_observed_at: asTimestamp(body.observedAt, "observedAt"),
    p_evidence: asBoundedObject(body.evidence, "evidence", 65_536),
  };
}

function completeArgs(body: JsonObject): Record<string, unknown> {
  const result = asBoundedObject(body.result ?? {}, "result", 65_536);
  if (Object.hasOwn(result, "reconciliationDecision")) {
    throw new RequestValidationError(
      "result.reconciliationDecision is database-owned",
    );
  }
  return {
    p_command_id: asUuid(body.commandId, "commandId"),
    p_lease_token: asUuid(body.leaseToken, "leaseToken"),
    p_fencing_generation: asInteger(
      body.fencingGeneration,
      "fencingGeneration",
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    p_transition_version: asInteger(
      body.transitionVersion,
      "transitionVersion",
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    p_outcome: asUpperEnum(body.outcome, "outcome", COMMAND_OUTCOMES),
    p_result: result,
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
  return { p_payload: payload };
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
  const encryptedHash = asString(
    payload.encryptedArtifactHash,
    "payload.encryptedArtifactHash",
    64,
    64,
  );
  if (!/^[a-f0-9]{64}$/.test(encryptedHash)) {
    throw new RequestValidationError("payload.encryptedArtifactHash is invalid");
  }
  return { p_payload: payload };
}

function maintenanceArgs(body: JsonObject): Record<string, unknown> {
  return {
    p_now: asTimestamp(body.now, "now"),
  };
}

// A Map is used instead of a plain object so route lookup can never resolve
// an inherited Object.prototype member (constructor, toString, valueOf,
// hasOwnProperty, __proto__, ...). Map#get only ever returns a value for a
// key that was explicitly set via the constructor/`.set`, with no prototype
// chain to fall through to -- unlike `ROUTES[key]` on an object literal
// (even a frozen one), where any request path that happens to name a
// standard Object.prototype member resolves to a truthy value and silently
// bypasses the `if (!route) return 404` guard below.
const ROUTES: ReadonlyMap<string, RouteDefinition> = new Map<
  string,
  RouteDefinition
>([
  ["heartbeat", {
    maxBodyBytes: 32_768,
    rpcName: "network_center_worker_heartbeat_v2",
    bodySchema: strictBodySchema([
      "workerVersion", "capabilities", "status", "queueAgeSeconds",
      "safeMetadata", "startedAt",
    ]),
    toRpcArgs: heartbeatArgs,
  }],
  ["connections", {
    maxBodyBytes: 8_192,
    rpcName: "network_center_worker_list_connections_v2",
    bodySchema: strictBodySchema(["limit"]),
    toRpcArgs: connectionsArgs,
  }],
  ["claim", {
    maxBodyBytes: 8_192,
    rpcName: "network_center_worker_claim_v2",
    bodySchema: strictBodySchema(["limit", "leaseSeconds"]),
    toRpcArgs: claimArgs,
  }],
  ["renew", {
    maxBodyBytes: 8_192,
    rpcName: "network_center_worker_renew_v2",
    bodySchema: strictBodySchema([
      "commandId", "leaseToken", "fencingGeneration", "leaseSeconds",
    ]),
    toRpcArgs: renewArgs,
  }],
  ["ingest", {
    maxBodyBytes: 600_000,
    rpcName: "network_center_worker_ingest_v2",
    bodySchema: strictBodySchema(["payload"]),
    toRpcArgs: ingestArgs,
  }],
  ["inventory", {
    maxBodyBytes: 600_000,
    rpcName: "network_center_worker_inventory_v2",
    bodySchema: strictBodySchema(["payload"]),
    toRpcArgs: inventoryArgs,
  }],
  ["stage", {
    maxBodyBytes: 100_000,
    rpcName: "network_center_worker_command_event_v2",
    bodySchema: strictBodySchema([
      "commandId", "leaseToken", "fencingGeneration", "eventKind", "payload",
    ]),
    toRpcArgs: stageArgs,
  }],
  ["observe", {
    maxBodyBytes: 100_000,
    rpcName: "network_center_worker_observe_v2",
    bodySchema: strictBodySchema([
      "commandId", "leaseToken", "fencingGeneration", "transitionVersion",
      "observationId", "observationKind", "observedAt", "evidence",
    ]),
    toRpcArgs: observeArgs,
  }],
  ["complete", {
    maxBodyBytes: 150_000,
    rpcName: "network_center_worker_complete_v2",
    bodySchema: strictBodySchema([
      "commandId", "leaseToken", "fencingGeneration", "transitionVersion",
      "outcome", "result", "rollback", "retryDelaySeconds",
    ]),
    toRpcArgs: completeArgs,
  }],
  ["incidents", {
    maxBodyBytes: 100_000,
    rpcName: "network_center_worker_upsert_incident_v2",
    bodySchema: strictBodySchema(["payload"]),
    toRpcArgs: incidentArgs,
  }],
  ["snapshots", {
    maxBodyBytes: 2_200_000,
    rpcName: "network_center_worker_snapshot_v2",
    bodySchema: strictBodySchema(["payload"]),
    toRpcArgs: snapshotArgs,
  }],
  ["maintenance", {
    maxBodyBytes: 8_192,
    rpcName: "network_center_worker_maintenance_v2",
    bodySchema: strictBodySchema(["now"]),
    toRpcArgs: maintenanceArgs,
  }],
]);

function routeFromUrl(url: string): string {
  const parts = new URL(url).pathname.split("/").filter(Boolean);
  const marker = parts.lastIndexOf("network-center-worker");
  return (marker >= 0 ? parts.slice(marker + 1) : parts).join("/");
}

export async function readJsonBody(
  request: Request,
  maximumBytes: number,
): Promise<JsonObject> {
  // Fail closed: a byte cap that is not a finite positive integer must
  // never be treated as "no limit". Without this guard, `declaredLength >
  // maximumBytes` and `bytes.byteLength > maximumBytes` both silently
  // evaluate to false whenever maximumBytes is undefined/NaN/non-numeric
  // (any comparison against a non-number coerces to NaN, and every
  // NaN comparison is false), which would let an arbitrarily large body be
  // buffered into memory in full before any other validation runs.
  if (!Number.isInteger(maximumBytes) || maximumBytes <= 0) {
    throw new InvalidBodyCapError(
      "readJsonBody requires a positive integer byte cap",
    );
  }
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

/**
 * HTTP status for a PostgreSQL SQLSTATE.
 *
 * The unmapped default is 502, and that default is what made F6 cost a
 * three-log triangulation to identify. Postgres said `23514` and named the
 * constraint (`network_client_current_session_type_check`); this function did
 * not know the code, answered a generic 502 `worker_backend_error`, and the
 * worker logged the single word `ApiClientError`. Everything needed to diagnose
 * it existed and was discarded one layer at a time.
 *
 * So the rule follows the SQLSTATE CLASSES rather than an accumulating list of
 * the individual codes that have already bitten us:
 *
 *  - class 22 (data exception) is always "the payload itself is wrong" - 22023
 *    invalid parameter, 22P02 a string Postgres cannot cast to macaddr/inet,
 *    22003 out of range -> 400;
 *  - 23502 not-null and 23514 check violation say the same thing about a
 *    constrained column -> 400;
 *  - 23505 unique and 23503 foreign key are conflicts with rows that do or do
 *    not exist, not malformed input -> 409;
 *  - 42501 -> 403, P0002 -> 404, 55000 -> 409.
 *
 * 400 and 409 are both non-retryable for the worker's HTTP client, which is the
 * behaviour this class of failure needs: re-sending a byte-identical malformed
 * payload cannot start working, whereas a 502 is retried forever. The SQLSTATE
 * itself is returned in `code`, so the response names the failure either way.
 */
function rpcErrorStatus(code: string | undefined): number {
  if (code === undefined) return 502;
  if (code.startsWith("22")) return 400;
  if (code === "23502" || code === "23514") return 400;
  if (code === "42501") return 403;
  if (code === "P0002") return 404;
  if (code === "23503" || code === "23505" || code === "55000") return 409;
  return 502;
}

function isValidRpcData(
  route: RouteDefinition,
  args: Record<string, unknown>,
  data: unknown,
): boolean {
  if (route.rpcName !== "network_center_worker_claim_v2") return true;
  const requestedLimit = args.p_limit;
  if (!Number.isInteger(requestedLimit) || data === null ||
    typeof data !== "object" || Array.isArray(data)) {
    return false;
  }
  try {
    const prototype = Object.getPrototypeOf(data);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const items = (data as JsonObject).items;
    return Array.isArray(items) &&
      items.length <= (requestedLimit as number) &&
      items.length <= CLAIM_LIMIT;
  } catch {
    return false;
  }
}

export function createWorkerHandler(
  dependencies: WorkerHandlerDependencies = {},
): (request: Request) => Promise<Response> {
  const getEnv = dependencies.getEnv ?? ((name) => Deno.env.get(name));
  const rpc = dependencies.rpc ?? createServiceRpc(getEnv);

  return async (request: Request): Promise<Response> => {
    const providedSecret = request.headers.get(SECRET_HEADER) ?? "";
    let credentialDigest: string;
    try {
      credentialDigest = await credentialDigestHex(providedSecret);
    } catch (error) {
      if (!(error instanceof WorkerCredentialError)) {
        return jsonResponse(500, { error: "worker_auth_error" });
      }
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

    const route = ROUTES.get(routeFromUrl(request.url));
    if (!route) {
      return jsonResponse(404, { error: "route_not_found" });
    }

    let body: JsonObject;
    try {
      body = await readJsonBody(request, route.maxBodyBytes);
    } catch (error) {
      if (error instanceof InvalidBodyCapError) {
        return jsonResponse(500, { error: "worker_config_error" });
      }
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
      const parsedBody = route.bodySchema.safeParse(body);
      if (!parsedBody.success) {
        throw new RequestValidationError("body contains an unsupported field");
      }
      args = {
        p_credential_digest: credentialDigest,
        ...route.toRpcArgs(parsedBody.data),
      };
    } catch (error) {
      if (error instanceof RequestValidationError) {
        // The reason is the FIELD PATH and a fixed phrase - never the value, so
        // nothing from the payload is echoed back. The caller is already
        // authenticated at this point (the credential digest was computed
        // above), and telling an authenticated worker which of its own fields it
        // got wrong is the difference between a fixable error and the opaque
        // 400 that F6-class defects hide behind.
        return jsonResponse(400, {
          error: "invalid_request",
          reason: error.message,
        });
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
      if (result.error.code === "28000") {
        return jsonResponse(401, { error: "unauthorized" });
      }
      return jsonResponse(rpcErrorStatus(result.error.code), {
        error: "worker_backend_error",
        code: result.error.code ?? "UNKNOWN",
      });
    }
    if (!isValidRpcData(route, args, result.data)) {
      return jsonResponse(502, { error: "worker_backend_error" });
    }
    return jsonResponse(200, { ok: true, data: result.data });
  };
}

if (import.meta.main) {
  Deno.serve(createWorkerHandler());
}
