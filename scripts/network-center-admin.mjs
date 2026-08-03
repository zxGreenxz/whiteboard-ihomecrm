#!/usr/bin/env node
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { link, open, readFile, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  REPO_ROOT,
  extractManagementPat,
  isEntrypoint,
  loadLocalRuntimeConfig,
  parseProjectRef,
  readOptional,
  redactSecrets,
} from "./network-center-rollout-common.mjs";

export const ADMIN_COMMANDS = new Set([
  "provision-worker",
  "rotate-worker",
  "revoke-worker",
  "assign",
  "unassign",
  "provision-connection",
  "list-access-ports",
  "enroll-access-port",
  "set-rollout",
  "finalize-worker-cutover",
  "status",
  "worker-release-status",
]);

const COMMAND_FLAGS = new Map([
  ["provision-worker", new Set(["workerKey", "displayName", "output", "expiresAt", "assignmentsFile"])],
  ["rotate-worker", new Set(["workerKey", "output", "notBefore", "expiresAt"])],
  ["revoke-worker", new Set(["workerKey", "fingerprint"])],
  ["assign", new Set(["workerKey", "assignmentsFile"])],
  ["unassign", new Set(["workerKey", "confirm"])],
  [
    "provision-connection",
    new Set([
      "deviceId", "transport", "managementIp", "managementPort", "credentialRef",
      "hostKeyFingerprint", "pollIntervalSeconds", "connectTimeoutMs",
    ]),
  ],
  ["list-access-ports", new Set(["buildingId"])],
  ["enroll-access-port", new Set(["interfaceId", "confirmImmutableKey", "reason"])],
  ["set-rollout", new Set(["buildingId", "state", "expectedVersion", "reason"])],
  ["finalize-worker-cutover", new Set()],
  ["status", new Set(["buildingId", "limit"])],
  ["worker-release-status", new Set(["workerKey", "workerVersion"])],
]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WORKER_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const WORKER_FINGERPRINT_PATTERN = /^sha256:[a-f0-9]{12,64}$/;
const WORKER_RELEASE_PATTERN = /^[a-f0-9]{40}$/;
const ASSIGNMENT_HASH_PATTERN = /^[a-f0-9]{64}$/;
const RFC3339_INSTANT_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
const RFC3339_INSTANT_MAX_LENGTH = 35;
const HOST_KEY_PATTERN = /^SHA256:[A-Za-z0-9+/]{20,}={0,2}$/;
const OPAQUE_CREDENTIAL_REF_PATTERN = /^router\/[A-Za-z0-9][A-Za-z0-9._/-]{1,127}$/;
// Enrolling an access port is what makes that port cyclable, so the operator has
// to type its immutable key exactly. `ether1` is the WAN uplink on every device
// in this fleet and is refused here, not only server-side, and the match is
// case-sensitive so `Ether4` reads as the typo it is instead of a synonym.
const ACCESS_PORT_IMMUTABLE_KEY_PATTERN = /^ether(?:[2-9]|[1-9][0-9])$/;
const ENROLL_REASON_MIN_LENGTH = 8;
const ENROLL_REASON_MAX_LENGTH = 500;

// Every Network Center admin function is created in `public`. This project's
// PostgREST is exposed as `db_schema = "api, public, graphql_public"` and the
// FIRST entry is the default profile, so an admin RPC posted without an
// explicit profile resolves against `api` and PostgREST answers
// PGRST202 ("no matches were found in the schema cache") — the function is
// never reached. For a POST RPC the schema selector is the `Content-Profile`
// request header (`Accept-Profile` only applies to GET/HEAD).
//
// This constant is the single declaration of where the admin RPCs live; the
// header is derived from it in `adminRpcHeaders`, which every admin RPC goes
// through. Do not inline a schema string at a call site.
export const ADMIN_RPC_SCHEMA = "public";

export function adminRpcHeaders(serviceRoleKey) {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
    "Content-Profile": ADMIN_RPC_SCHEMA,
  };
}

function digestSecret(secret) {
  return createHash("sha256").update(secret).digest("hex");
}

async function writeSecretAtomic(target, secret) {
  if (!target || !String(target).trim()) throw new Error("An explicit secret output path is required");
  const temporary = join(dirname(target), `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${secret}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(temporary, target);
    return target;
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error(`Secret output already exists: ${target}`);
    throw error;
  } finally {
    if (handle) await handle.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
}

function normalizeAssignments(assignments, { allowEmpty = false } = {}) {
  if (!Array.isArray(assignments) || assignments.length > 100 || (!allowEmpty && assignments.length === 0)) {
    throw new Error("Assignments must be an explicit enabled snapshot with 1 to 100 items");
  }
  return assignments.map((assignment) => {
    if (
      assignment?.enabled !== true ||
      !UUID_PATTERN.test(assignment.organizationId ?? "") ||
      !UUID_PATTERN.test(assignment.buildingId ?? "") ||
      !UUID_PATTERN.test(assignment.deviceId ?? "") ||
      typeof assignment.canPoll !== "boolean" ||
      typeof assignment.canInventory !== "boolean" ||
      typeof assignment.canExecute !== "boolean" ||
      (!assignment.canPoll && !assignment.canInventory && !assignment.canExecute)
    ) {
      throw new Error("Every assignment must be explicit, enabled, scoped, and declare all capabilities");
    }
    return {
      organizationId: assignment.organizationId,
      buildingId: assignment.buildingId,
      deviceId: assignment.deviceId,
      canPoll: assignment.canPoll,
      canInventory: assignment.canInventory,
      canExecute: assignment.canExecute,
    };
  });
}

async function readback(rpc, buildingId = null) {
  return rpc("network_center_admin_status_v1", {
    p_building_id: buildingId,
    p_limit: 200,
  });
}

function sanitizeCredentialError(error, credentialMaterial) {
  const sanitized = new Error(redactSecrets(error?.message ?? error, credentialMaterial));
  if (error?.outcome === "REJECTED") sanitized.outcome = "REJECTED";
  return sanitized;
}

function credentialOutcomeUnknown(fingerprint) {
  const error = new Error(
    `Credential operation outcome is unknown for fingerprint ${fingerprint}; preserve the generated secret`,
  );
  error.code = "CREDENTIAL_OUTCOME_UNKNOWN";
  return error;
}

const CREDENTIAL_STATUS_KEYS = [
  "credentialFingerprint",
  "expiresAt",
  "found",
  "notBefore",
  "revokedAt",
  "workerKey",
];

function hasExactKeys(payload, expectedKeys) {
  return Object.keys(payload).sort().join("\0") === expectedKeys.join("\0");
}

function isExactCredentialStatus(status, workerKey, fingerprint) {
  if (
    !status ||
    typeof status !== "object" ||
    Array.isArray(status) ||
    !hasExactKeys(status, CREDENTIAL_STATUS_KEYS) ||
    status.found !== true ||
    status.workerKey !== workerKey ||
    status.credentialFingerprint !== fingerprint ||
    typeof status.notBefore !== "string" ||
    typeof status.expiresAt !== "string" ||
    (status.revokedAt !== null && typeof status.revokedAt !== "string")
  ) {
    return false;
  }
  const notBefore = Date.parse(status.notBefore);
  const expiresAt = Date.parse(status.expiresAt);
  const revokedAt = status.revokedAt === null ? null : Date.parse(status.revokedAt);
  return Number.isFinite(notBefore) &&
    Number.isFinite(expiresAt) &&
    expiresAt > notBefore &&
    (revokedAt === null || Number.isFinite(revokedAt));
}

async function reconcileCredentialOutcome({ rpc, workerKey, fingerprint }) {
  let status;
  try {
    status = await rpc("network_center_admin_worker_credential_status_v1", {
      p_worker_key: workerKey,
      p_fingerprint: fingerprint,
    });
  } catch {
    throw credentialOutcomeUnknown(fingerprint);
  }
  if (!isExactCredentialStatus(status, workerKey, fingerprint)) {
    throw credentialOutcomeUnknown(fingerprint);
  }
  return {
    found: status.found,
    workerKey: status.workerKey,
    credentialFingerprint: status.credentialFingerprint,
    notBefore: status.notBefore,
    expiresAt: status.expiresAt,
    revokedAt: status.revokedAt,
  };
}

export async function provisionWorker({
  workerKey,
  displayName,
  outputPath,
  expiresAt,
  assignments,
  rpc,
} = {}) {
  if (!WORKER_KEY_PATTERN.test(workerKey ?? "") || !String(displayName ?? "").trim()) {
    throw new Error("Invalid worker identity");
  }
  if (!rpc) throw new Error("RPC transport is required");
  const normalizedAssignments = normalizeAssignments(assignments);
  const secret = randomBytes(48).toString("base64url");
  const digest = digestSecret(secret);
  const fingerprint = `sha256:${digest.slice(0, 24)}`;
  await writeSecretAtomic(outputPath, secret);
  let committed = false;
  try {
    const operation = await rpc("network_center_admin_provision_worker_v1", {
      p_worker_key: workerKey,
      p_display_name: String(displayName).trim(),
      p_secret_digest: digest,
      p_fingerprint: fingerprint,
      p_expires_at: expiresAt,
      p_assignments: normalizedAssignments,
    });
    committed = true;
    const status = await readback(rpc, normalizedAssignments[0].buildingId);
    return { operation, status, credentialFingerprint: fingerprint, outputPath };
  } catch (error) {
    if (committed) throw sanitizeCredentialError(error, [secret, digest]);
    if (error?.outcome === "REJECTED") {
      await rm(outputPath, { force: true }).catch(() => {});
      throw sanitizeCredentialError(error, [secret, digest]);
    }
    const credentialStatus = await reconcileCredentialOutcome({
      rpc,
      workerKey,
      fingerprint,
    });
    const status = await readback(rpc, normalizedAssignments[0].buildingId).catch(() => null);
    return {
      operation: null,
      status,
      credentialStatus,
      credentialFingerprint: fingerprint,
      outputPath,
      reconciled: true,
    };
  }
}

export async function rotateWorker({
  workerKey,
  outputPath,
  notBefore,
  expiresAt,
  rpc,
} = {}) {
  if (!WORKER_KEY_PATTERN.test(workerKey ?? "") || !rpc) throw new Error("Invalid worker rotation request");
  const secret = randomBytes(48).toString("base64url");
  const digest = digestSecret(secret);
  const fingerprint = `sha256:${digest.slice(0, 24)}`;
  await writeSecretAtomic(outputPath, secret);
  let committed = false;
  try {
    const operation = await rpc("network_center_admin_rotate_worker_credential_v1", {
      p_worker_key: workerKey,
      p_secret_digest: digest,
      p_fingerprint: fingerprint,
      p_not_before: notBefore,
      p_expires_at: expiresAt,
    });
    committed = true;
    return { operation, status: await readback(rpc), credentialFingerprint: fingerprint, outputPath };
  } catch (error) {
    if (committed) throw sanitizeCredentialError(error, [secret, digest]);
    if (error?.outcome === "REJECTED") {
      await rm(outputPath, { force: true }).catch(() => {});
      throw sanitizeCredentialError(error, [secret, digest]);
    }
    const credentialStatus = await reconcileCredentialOutcome({
      rpc,
      workerKey,
      fingerprint,
    });
    const status = await readback(rpc).catch(() => null);
    return {
      operation: null,
      status,
      credentialStatus,
      credentialFingerprint: fingerprint,
      outputPath,
      reconciled: true,
    };
  }
}

export async function revokeWorker({ workerKey, fingerprint, rpc } = {}) {
  if (!WORKER_KEY_PATTERN.test(workerKey ?? "") || !WORKER_FINGERPRINT_PATTERN.test(fingerprint ?? "")) {
    throw new Error("Invalid worker credential revocation");
  }
  const operation = await rpc("network_center_admin_revoke_worker_credential_v1", {
    p_worker_key: workerKey,
    p_fingerprint: fingerprint,
  });
  return { operation, status: await readback(rpc) };
}

export async function setAssignments({ workerKey, assignments, rpc } = {}) {
  if (!WORKER_KEY_PATTERN.test(workerKey ?? "") || !rpc) throw new Error("Invalid assignment request");
  const normalizedAssignments = normalizeAssignments(assignments);
  const operation = await rpc("network_center_admin_set_worker_assignments_v1", {
    p_worker_key: workerKey,
    p_assignments: normalizedAssignments,
  });
  return { operation, status: await readback(rpc, normalizedAssignments[0].buildingId) };
}

export async function unassignWorker({ workerKey, confirmWorkerKey, rpc } = {}) {
  if (!WORKER_KEY_PATTERN.test(workerKey ?? "") || confirmWorkerKey !== workerKey || !rpc) {
    throw new Error("Unassign requires an exact worker-key confirmation");
  }
  const operation = await rpc("network_center_admin_set_worker_assignments_v1", {
    p_worker_key: workerKey,
    p_assignments: [],
  });
  return { operation, status: await readback(rpc) };
}

export async function provisionConnection(options = {}) {
  const {
    deviceId,
    transport,
    managementIp,
    managementPort,
    credentialRef,
    hostKeyFingerprint,
    pollIntervalSeconds = 60,
    connectTimeoutMs = 8000,
    rpc,
  } = options;
  if (
    Object.hasOwn(options, "credentialSecret") ||
    !UUID_PATTERN.test(deviceId ?? "") ||
    transport !== "ROUTEROS_SSH" ||
    !OPAQUE_CREDENTIAL_REF_PATTERN.test(credentialRef ?? "") ||
    !HOST_KEY_PATTERN.test(hostKeyFingerprint ?? "")
  ) {
    throw new Error(
      "credential_ref must be opaque router/... metadata, a pinned host-key is required, and secrets are forbidden",
    );
  }
  if (!rpc) throw new Error("RPC transport is required");
  const operation = await rpc("network_center_admin_provision_connection_v1", {
    p_device_id: deviceId,
    p_transport: transport,
    p_management_ip: managementIp,
    p_management_port: managementPort,
    p_credential_ref: credentialRef,
    p_host_key_fingerprint: hostKeyFingerprint,
    p_poll_interval_seconds: pollIntervalSeconds,
    p_connect_timeout_ms: connectTimeoutMs,
    p_request_id: randomUUID(),
  });
  return { operation, status: await readback(rpc) };
}

export async function listAccessPorts({ buildingId = null, rpc } = {}) {
  if (buildingId !== null && !UUID_PATTERN.test(buildingId ?? "")) throw new Error("Invalid building id");
  if (!rpc) throw new Error("RPC transport is required");
  const payload = await rpc("network_center_admin_list_access_ports_v1", {
    p_building_id: buildingId,
  });
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || !Array.isArray(payload.ports)) {
    throw new Error("Network Center access port listing returned an invalid payload");
  }
  return payload;
}

export async function enrollAccessPort({ interfaceId, confirmImmutableKey, reason, rpc } = {}) {
  if (!UUID_PATTERN.test(interfaceId ?? "")) throw new Error("Invalid access port interface id");
  if (!ACCESS_PORT_IMMUTABLE_KEY_PATTERN.test(confirmImmutableKey ?? "")) {
    throw new Error(
      "Enrolling an access port requires its exact immutable key (ether2 to ether99); ether1 is the WAN uplink and is never enrollable",
    );
  }
  const enrollReason = String(reason ?? "").trim();
  if (enrollReason.length < ENROLL_REASON_MIN_LENGTH || enrollReason.length > ENROLL_REASON_MAX_LENGTH) {
    throw new Error(
      `Enrollment reason must be ${ENROLL_REASON_MIN_LENGTH} to ${ENROLL_REASON_MAX_LENGTH} characters`,
    );
  }
  if (!rpc) throw new Error("RPC transport is required");
  const operation = await rpc("network_center_admin_enroll_access_port_v1", {
    p_interface_id: interfaceId,
    p_confirm_immutable_key: confirmImmutableKey,
    p_reason: enrollReason,
    p_request_id: randomUUID(),
  });
  return { operation, status: await readback(rpc) };
}

export async function setRollout({ buildingId, rolloutState, expectedVersion, reason, rpc } = {}) {
  if (
    !UUID_PATTERN.test(buildingId ?? "") ||
    !["OFF", "READ_ONLY", "EXECUTE"].includes(rolloutState) ||
    !Number.isSafeInteger(expectedVersion) ||
    expectedVersion < 1 ||
    String(reason ?? "").trim().length < 3
  ) {
    throw new Error("Invalid rollout request");
  }
  const operation = await rpc("network_center_admin_set_rollout_v1", {
    p_building_id: buildingId,
    p_rollout_state: rolloutState,
    p_expected_version: expectedVersion,
    p_reason: String(reason).trim(),
    p_request_id: randomUUID(),
  });
  return { operation, status: await readback(rpc, buildingId) };
}

export async function finalizeWorkerCutover({ rpc } = {}) {
  if (!rpc) throw new Error("RPC transport is required");
  const operation = await rpc("network_center_admin_finalize_worker_compatibility_v1", {});
  return { operation, status: await readback(rpc) };
}

export async function getStatus({ buildingId = null, limit = 100, rpc } = {}) {
  if (buildingId !== null && !UUID_PATTERN.test(buildingId)) throw new Error("Invalid building id");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error("Invalid status limit");
  if (!rpc) throw new Error("RPC transport is required");
  const status = await rpc("network_center_admin_status_v1", {
    p_building_id: buildingId,
    p_limit: limit,
  });
  const releaseStatus = await rpc("network_center_admin_release_status_v1", {
    p_limit: limit,
  });
  if (!status || typeof status !== "object" || Array.isArray(status)) {
    throw new Error("Network Center admin status returned an invalid payload");
  }
  if (
    !releaseStatus ||
    typeof releaseStatus !== "object" ||
    Array.isArray(releaseStatus) ||
    !Array.isArray(releaseStatus.releaseHeartbeats)
  ) {
    throw new Error("Network Center release status returned an invalid payload");
  }
  return { ...status, releaseHeartbeats: releaseStatus.releaseHeartbeats };
}

const WORKER_RELEASE_STATUS_KEYS = [
  "activeAssignedBuildingCount",
  "activeAssignmentCount",
  "activeAssignmentHash",
  "assignedBuildingCount",
  "connectionCount",
  "displayName",
  "expectedConnectionCount",
  "failedPollCount",
  "heartbeatAt",
  "pollObservedAt",
  "schemaVersion",
  "startedAt",
  "status",
  "successfulPollCount",
  "workerKey",
  "workerVersion",
];

function isBoundedCount(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function parseExactRfc3339Instant(value) {
  if (typeof value !== "string" || value.length > RFC3339_INSTANT_MAX_LENGTH) {
    return Number.NaN;
  }
  const match = RFC3339_INSTANT_PATTERN.exec(value);
  if (!match) return Number.NaN;
  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  const calendarDay = new Date(Date.UTC(year, month - 1, day));
  if (
    calendarDay.getUTCFullYear() !== year ||
    calendarDay.getUTCMonth() !== month - 1 ||
    calendarDay.getUTCDate() !== day
  ) {
    return Number.NaN;
  }
  return Date.parse(value);
}

function isExactWorkerReleaseStatus(status, workerKey, workerVersion) {
  if (!status || typeof status !== "object" || Array.isArray(status)) return false;
  if (
    Object.keys(status).sort().join("\0") !== WORKER_RELEASE_STATUS_KEYS.join("\0") ||
    status.schemaVersion !== 1 ||
    typeof status.workerKey !== "string" ||
    typeof status.workerVersion !== "string" ||
    status.workerKey !== workerKey ||
    status.workerVersion !== workerVersion ||
    typeof status.displayName !== "string" ||
    status.displayName.length < 1 ||
    status.displayName.length > 128 ||
    !["ONLINE", "DEGRADED", "PAUSED", "STOPPING"].includes(status.status) ||
    !isBoundedCount(status.assignedBuildingCount, 1, 10_000) ||
    !isBoundedCount(status.activeAssignedBuildingCount, 0, 10_000) ||
    !isBoundedCount(status.activeAssignmentCount, 0, 10_000) ||
    status.activeAssignmentCount < status.activeAssignedBuildingCount ||
    // The deployment gate compares the reported poll evidence against this
    // number instead of against a hard-coded ">= 1", so it has to be a real
    // server-side integer. A missing or malformed value must reject the whole
    // payload rather than degrade to a count of zero, which would read as
    // "nothing to poll" and let an unproven release through.
    !isBoundedCount(status.expectedConnectionCount, 0, 10_000) ||
    typeof status.activeAssignmentHash !== "string" ||
    !ASSIGNMENT_HASH_PATTERN.test(status.activeAssignmentHash)
  ) {
    return false;
  }

  const startedAt = parseExactRfc3339Instant(status.startedAt);
  const heartbeatAt = parseExactRfc3339Instant(status.heartbeatAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(heartbeatAt) || startedAt > heartbeatAt) {
    return false;
  }

  const pollValues = [
    status.connectionCount,
    status.successfulPollCount,
    status.failedPollCount,
    status.pollObservedAt,
  ];
  if (pollValues.every((value) => value === null)) return true;
  if (
    !isBoundedCount(status.connectionCount, 0, 500) ||
    !isBoundedCount(status.successfulPollCount, 0, 500) ||
    !isBoundedCount(status.failedPollCount, 0, 500) ||
    status.successfulPollCount + status.failedPollCount !== status.connectionCount ||
    typeof status.pollObservedAt !== "string"
  ) {
    return false;
  }
  const pollObservedAt = parseExactRfc3339Instant(status.pollObservedAt);
  return Number.isFinite(pollObservedAt) &&
    pollObservedAt >= startedAt &&
    pollObservedAt <= heartbeatAt;
}

export async function getWorkerReleaseStatus({ workerKey, workerVersion, rpc } = {}) {
  if (
    typeof workerKey !== "string" ||
    !WORKER_KEY_PATTERN.test(workerKey) ||
    typeof workerVersion !== "string" ||
    !WORKER_RELEASE_PATTERN.test(workerVersion) ||
    !rpc
  ) {
    throw new Error("Invalid worker release status request");
  }
  const status = await rpc("network_center_admin_worker_release_status_v1", {
    p_worker_key: workerKey,
    p_worker_version: workerVersion,
  });
  if (status === null) return null;
  if (!isExactWorkerReleaseStatus(status, workerKey, workerVersion)) {
    throw new Error("Invalid exact worker release status payload");
  }
  return {
    schemaVersion: status.schemaVersion,
    workerKey: status.workerKey,
    displayName: status.displayName,
    workerVersion: status.workerVersion,
    status: status.status,
    heartbeatAt: status.heartbeatAt,
    startedAt: status.startedAt,
    assignedBuildingCount: status.assignedBuildingCount,
    activeAssignedBuildingCount: status.activeAssignedBuildingCount,
    activeAssignmentCount: status.activeAssignmentCount,
    activeAssignmentHash: status.activeAssignmentHash,
    expectedConnectionCount: status.expectedConnectionCount,
    connectionCount: status.connectionCount,
    successfulPollCount: status.successfulPollCount,
    failedPollCount: status.failedPollCount,
    pollObservedAt: status.pollObservedAt,
  };
}

function extractServiceRoleKey({ environment = process.env, localConfig = "" } = {}) {
  const fromEnvironment = environment.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (fromEnvironment) return fromEnvironment;
  const match = String(localConfig).match(
    /(?:SUPABASE_SERVICE_ROLE_KEY|service[ _-]?role(?:[ _-]?key)?)\s*[:=]\s*[`"']?([A-Za-z0-9_.-]{40,})/i,
  );
  return match?.[1] ?? null;
}

// A hung upstream must never hold an operator's terminal open. Node's undici
// defaults are 300 s for response headers AND 300 s for the body, and a gateway
// that retries stacks them, so a single admin call could sit silent for minutes
// with nothing printed — observed in production when a stale `--expected-version`
// made `set-rollout` wait through two ~2 minute timeouts before a 504. Every
// request this CLI makes is therefore bounded by an AbortController deadline.
// There is deliberately NO retry: an admin RPC refusal is a decision, not a
// transient, and re-sending one would be the wrong answer to a slow response.
const ADMIN_RPC_TIMEOUT_ENV = "NETWORK_CENTER_ADMIN_RPC_TIMEOUT_MS";
const DEFAULT_ADMIN_RPC_TIMEOUT_MS = 30_000;
const MIN_ADMIN_RPC_TIMEOUT_MS = 1_000;
const MAX_ADMIN_RPC_TIMEOUT_MS = 600_000;

/**
 * Resolves the per-request deadline in milliseconds. An explicit `timeoutMs` is
 * a caller-owned budget (tests use single-digit values); the operator-facing
 * environment variable is additionally floored at 1 s so a fat-fingered value
 * cannot turn every admin RPC into an instant UNKNOWN. An unusable value is
 * refused here instead of silently falling back to the default, because a
 * deadline the operator believes is in force but is not is precisely the failure
 * this bound exists to remove.
 */
export function resolveAdminRpcTimeoutMs({ environment = process.env, timeoutMs } = {}) {
  if (timeoutMs !== undefined) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_ADMIN_RPC_TIMEOUT_MS) {
      throw new Error(
        `Admin RPC timeout must be an integer from 1 to ${MAX_ADMIN_RPC_TIMEOUT_MS} milliseconds; received ${timeoutMs}`,
      );
    }
    return timeoutMs;
  }
  const declared = environment?.[ADMIN_RPC_TIMEOUT_ENV];
  if (declared === undefined || declared === null || String(declared).trim() === "") {
    return DEFAULT_ADMIN_RPC_TIMEOUT_MS;
  }
  const raw = String(declared).trim();
  const parsed = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < MIN_ADMIN_RPC_TIMEOUT_MS ||
    parsed > MAX_ADMIN_RPC_TIMEOUT_MS
  ) {
    throw new Error(
      `${ADMIN_RPC_TIMEOUT_ENV} must be an integer from ${MIN_ADMIN_RPC_TIMEOUT_MS} to ${MAX_ADMIN_RPC_TIMEOUT_MS} milliseconds; received ${raw}`,
    );
  }
  return parsed;
}

async function loadRpcConfig({
  repoRoot = REPO_ROOT,
  environment = process.env,
  fetchImpl = fetch,
  timeoutMs,
} = {}) {
  const deadlineMs = resolveAdminRpcTimeoutMs({ environment, timeoutMs });
  const [configToml, localConfig] = await Promise.all([
    readFile(join(repoRoot, "supabase", "config.toml"), "utf8"),
    loadLocalRuntimeConfig(repoRoot),
  ]);
  const projectRef = parseProjectRef(configToml);
  let serviceRoleKey = extractServiceRoleKey({ environment, localConfig });
  if (!serviceRoleKey) {
    const pat = extractManagementPat({ environment, localConfig });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deadlineMs);
    let response;
    let text;
    try {
      response = await fetchImpl(
        `https://api.supabase.com/v1/projects/${projectRef}/api-keys`,
        { headers: { Authorization: `Bearer ${pat}` }, signal: controller.signal },
      );
      text = await response.text();
    } catch (error) {
      throw new Error(redactSecrets(
        controller.signal.aborted
          ? `Could not resolve runtime service-role credential: the Supabase Management API did not answer within ${deadlineMs} ms`
          : `Could not resolve runtime service-role credential: ${error?.message ?? error}`,
        [pat],
      ));
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      throw new Error(
        redactSecrets(`Could not resolve runtime service-role credential (${response.status})`, [pat]),
      );
    }
    const keys = JSON.parse(text);
    const serviceRole = keys.find(
      (item) => item.name === "service_role" || item.type === "service_role",
    );
    serviceRoleKey = serviceRole?.api_key ?? serviceRole?.key ?? null;
  }
  if (!serviceRoleKey) throw new Error("Supabase service-role credential is unavailable");
  return { projectRef, serviceRoleKey };
}

function createRpcError(message, outcome, knownSecrets) {
  const error = new Error(redactSecrets(message, knownSecrets));
  error.outcome = outcome;
  return error;
}

const POSTGREST_ERROR_KEYS = ["code", "details", "hint", "message"];
const CREDENTIAL_RPC_REJECTION_CODES = new Map([
  [
    "network_center_admin_provision_worker_v1",
    new Set(["22023", "23503", "23505", "P0002", "PGRST202"]),
  ],
  [
    "network_center_admin_rotate_worker_credential_v1",
    new Set(["22023", "23505", "P0002", "PGRST202"]),
  ],
]);

function isBoundedNullableErrorText(value) {
  return value === null || (typeof value === "string" && value.length <= 2_000);
}

function isVerifiedPostgrestError(name, response, text) {
  const contentType = response.headers?.get?.("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/json")) return false;
  const allowedCodes = CREDENTIAL_RPC_REJECTION_CODES.get(name);
  if (!allowedCodes) return false;
  try {
    const payload = JSON.parse(text);
    return Boolean(
      payload &&
      typeof payload === "object" &&
      !Array.isArray(payload) &&
      hasExactKeys(payload, POSTGREST_ERROR_KEYS) &&
      allowedCodes.has(payload.code) &&
      typeof payload.message === "string" &&
      payload.message.length > 0 &&
      payload.message.length <= 2_000 &&
      isBoundedNullableErrorText(payload.details) &&
      isBoundedNullableErrorText(payload.hint),
    );
  } catch {
    return false;
  }
}

function classifyHttpRpcOutcome(name, response, text) {
  if (response.status >= 500 && response.status < 600) return "UNKNOWN";
  if (
    response.status >= 400 &&
    response.status < 500 &&
    isVerifiedPostgrestError(name, response, text)
  ) {
    return "REJECTED";
  }
  return "UNKNOWN";
}

const PROVISION_RESPONSE_KEYS = [
  "assignmentCount",
  "credentialFingerprint",
  "status",
  "workerId",
  "workerKey",
];
const ROTATION_RESPONSE_KEYS = [
  "credentialFingerprint",
  "expiresAt",
  "notBefore",
  "workerId",
  "workerKey",
];

function isExactCredentialMutationResponse(name, payload, args) {
  if (
    name !== "network_center_admin_provision_worker_v1" &&
    name !== "network_center_admin_rotate_worker_credential_v1"
  ) {
    return true;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  if (
    payload.workerKey !== args.p_worker_key ||
    payload.credentialFingerprint !== args.p_fingerprint ||
    !UUID_PATTERN.test(payload.workerId ?? "")
  ) {
    return false;
  }

  if (name === "network_center_admin_provision_worker_v1") {
    return hasExactKeys(payload, PROVISION_RESPONSE_KEYS) &&
      payload.status === "ACTIVE" &&
      Number.isSafeInteger(payload.assignmentCount) &&
      payload.assignmentCount === args.p_assignments?.length;
  }
  if (name === "network_center_admin_rotate_worker_credential_v1") {
    if (
      !hasExactKeys(payload, ROTATION_RESPONSE_KEYS) ||
      typeof payload.notBefore !== "string" ||
      typeof payload.expiresAt !== "string"
    ) {
      return false;
    }
    const notBefore = Date.parse(payload.notBefore);
    const expiresAt = Date.parse(payload.expiresAt);
    return Number.isFinite(notBefore) &&
      Number.isFinite(expiresAt) &&
      notBefore === Date.parse(args.p_not_before) &&
      expiresAt === Date.parse(args.p_expires_at) &&
      expiresAt > notBefore;
  }
  return false;
}

export function createRpcTransport(config, fetchImpl = fetch, options = {}) {
  const deadlineMs = resolveAdminRpcTimeoutMs(options);
  return async (name, args) => {
    // The deadline covers the body read as well as the headers: undici bounds
    // those separately and either one hanging is the same silent terminal.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deadlineMs);
    // An abandoned request is ALWAYS "UNKNOWN". A credential-mutating RPC may
    // already have committed server-side when the deadline fires, so calling a
    // timeout "REJECTED" would delete a live secret. Never reclassify this.
    const unknownOutcome = (error) => createRpcError(
      controller.signal.aborted
        ? `Admin RPC ${name} timed out after ${deadlineMs} ms; outcome is UNKNOWN (the call may or may not have committed).`
        : `Admin RPC ${name} outcome is unknown: ${error?.message ?? error}`,
      "UNKNOWN",
      [config.serviceRoleKey],
    );
    let response;
    let text;
    try {
      response = await fetchImpl(
        `https://${config.projectRef}.supabase.co/rest/v1/rpc/${encodeURIComponent(name)}`,
        {
          method: "POST",
          headers: adminRpcHeaders(config.serviceRoleKey),
          body: JSON.stringify(args),
          signal: controller.signal,
        },
      );
      text = await response.text();
    } catch (error) {
      throw unknownOutcome(error);
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      throw createRpcError(
        `Admin RPC ${name} failed (${response.status}): ${text.slice(0, 2_000)}`,
        classifyHttpRpcOutcome(name, response, text),
        [config.serviceRoleKey],
      );
    }
    if (!text) {
      throw createRpcError(
        `Admin RPC ${name} returned an empty success payload`,
        "UNKNOWN",
        [config.serviceRoleKey],
      );
    }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw createRpcError(
        `Admin RPC ${name} returned an invalid success payload`,
        "UNKNOWN",
        [config.serviceRoleKey],
      );
    }
    if (!isExactCredentialMutationResponse(name, payload, args)) {
      throw createRpcError(
        `Admin RPC ${name} returned a non-authoritative success payload`,
        "UNKNOWN",
        [config.serviceRoleKey],
      );
    }
    return payload;
  };
}

function parseFlags(argv, allowedFlags) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag.startsWith("--")) throw new Error(`Unexpected argument: ${flag}`);
    const key = flag.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (!allowedFlags.has(key)) throw new Error(`Unknown or unsupported flag: ${flag}`);
    const value = argv[++index];
    if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
    values[key] = value;
  }
  return values;
}

export function parseAdminCommand(command, argv) {
  if (!ADMIN_COMMANDS.has(command)) throw new Error(`Unsupported admin command: ${command}`);
  return parseFlags(argv, COMMAND_FLAGS.get(command));
}

async function readAssignments(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function runCommand(command, flags, rpc) {
  if (command === "provision-worker") {
    return provisionWorker({
      workerKey: flags.workerKey,
      displayName: flags.displayName,
      outputPath: flags.output,
      expiresAt: flags.expiresAt,
      assignments: await readAssignments(flags.assignmentsFile),
      rpc,
    });
  }
  if (command === "rotate-worker") {
    return rotateWorker({
      workerKey: flags.workerKey,
      outputPath: flags.output,
      notBefore: flags.notBefore,
      expiresAt: flags.expiresAt,
      rpc,
    });
  }
  if (command === "revoke-worker") {
    return revokeWorker({ workerKey: flags.workerKey, fingerprint: flags.fingerprint, rpc });
  }
  if (command === "assign") {
    return setAssignments({
      workerKey: flags.workerKey,
      assignments: await readAssignments(flags.assignmentsFile),
      rpc,
    });
  }
  if (command === "unassign") {
    return unassignWorker({ workerKey: flags.workerKey, confirmWorkerKey: flags.confirm, rpc });
  }
  if (command === "provision-connection") {
    return provisionConnection({
      deviceId: flags.deviceId,
      transport: flags.transport,
      managementIp: flags.managementIp,
      managementPort: Number(flags.managementPort),
      credentialRef: flags.credentialRef,
      hostKeyFingerprint: flags.hostKeyFingerprint,
      pollIntervalSeconds: flags.pollIntervalSeconds ? Number(flags.pollIntervalSeconds) : 60,
      connectTimeoutMs: flags.connectTimeoutMs ? Number(flags.connectTimeoutMs) : 8000,
      rpc,
    });
  }
  if (command === "list-access-ports") {
    return listAccessPorts({ buildingId: flags.buildingId ?? null, rpc });
  }
  if (command === "enroll-access-port") {
    return enrollAccessPort({
      interfaceId: flags.interfaceId,
      confirmImmutableKey: flags.confirmImmutableKey,
      reason: flags.reason,
      rpc,
    });
  }
  if (command === "set-rollout") {
    return setRollout({
      buildingId: flags.buildingId,
      rolloutState: flags.state,
      expectedVersion: Number(flags.expectedVersion),
      reason: flags.reason,
      rpc,
    });
  }
  if (command === "finalize-worker-cutover") return finalizeWorkerCutover({ rpc });
  if (command === "status") {
    return getStatus({
      buildingId: flags.buildingId ?? null,
      limit: flags.limit ? Number(flags.limit) : 100,
      rpc,
    });
  }
  if (command === "worker-release-status") {
    return getWorkerReleaseStatus({
      workerKey: flags.workerKey,
      workerVersion: flags.workerVersion,
      rpc,
    });
  }
  throw new Error(`Unsupported admin command: ${command}`);
}

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  if (!ADMIN_COMMANDS.has(command)) {
    throw new Error(`Usage: node scripts/network-center-admin.mjs <${[...ADMIN_COMMANDS].join("|")}> [flags]`);
  }
  const flags = parseAdminCommand(command, argv);
  const config = await loadRpcConfig();
  const result = await runCommand(command, flags, createRpcTransport(config));
  process.stdout.write(`${redactSecrets(JSON.stringify(result), [config.serviceRoleKey])}\n`);
}

if (isEntrypoint(import.meta.url)) {
  main().catch((error) => {
    console.error(redactSecrets(error?.message ?? error));
    process.exitCode = 1;
  });
}
