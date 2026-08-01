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
  "set-rollout",
  "finalize-worker-cutover",
  "status",
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
  ["set-rollout", new Set(["buildingId", "state", "expectedVersion", "reason"])],
  ["finalize-worker-cutover", new Set()],
  ["status", new Set(["buildingId", "limit"])],
]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WORKER_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const WORKER_FINGERPRINT_PATTERN = /^sha256:[a-f0-9]{12,64}$/;
const HOST_KEY_PATTERN = /^SHA256:[A-Za-z0-9+/]{20,}={0,2}$/;
const OPAQUE_CREDENTIAL_REF_PATTERN = /^router\/[A-Za-z0-9][A-Za-z0-9._/-]{1,127}$/;

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
    if (!committed) await rm(outputPath, { force: true }).catch(() => {});
    throw error;
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
    if (!committed) await rm(outputPath, { force: true }).catch(() => {});
    throw error;
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
  return rpc("network_center_admin_status_v1", {
    p_building_id: buildingId,
    p_limit: limit,
  });
}

function extractServiceRoleKey({ environment = process.env, localConfig = "" } = {}) {
  const fromEnvironment = environment.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (fromEnvironment) return fromEnvironment;
  const match = String(localConfig).match(
    /(?:SUPABASE_SERVICE_ROLE_KEY|service[ _-]?role(?:[ _-]?key)?)\s*[:=]\s*[`"']?([A-Za-z0-9_.-]{40,})/i,
  );
  return match?.[1] ?? null;
}

async function loadRpcConfig({
  repoRoot = REPO_ROOT,
  environment = process.env,
  fetchImpl = fetch,
} = {}) {
  const [configToml, localConfig] = await Promise.all([
    readFile(join(repoRoot, "supabase", "config.toml"), "utf8"),
    loadLocalRuntimeConfig(repoRoot),
  ]);
  const projectRef = parseProjectRef(configToml);
  let serviceRoleKey = extractServiceRoleKey({ environment, localConfig });
  if (!serviceRoleKey) {
    const pat = extractManagementPat({ environment, localConfig });
    const response = await fetchImpl(
      `https://api.supabase.com/v1/projects/${projectRef}/api-keys`,
      { headers: { Authorization: `Bearer ${pat}` } },
    );
    const text = await response.text();
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

function createRpcTransport(config, fetchImpl = fetch) {
  return async (name, args) => {
    const response = await fetchImpl(
      `https://${config.projectRef}.supabase.co/rest/v1/rpc/${encodeURIComponent(name)}`,
      {
        method: "POST",
        headers: {
          apikey: config.serviceRoleKey,
          Authorization: `Bearer ${config.serviceRoleKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(args),
      },
    );
    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        redactSecrets(`Admin RPC ${name} failed (${response.status}): ${text.slice(0, 2_000)}`, [
          config.serviceRoleKey,
        ]),
      );
    }
    return text ? JSON.parse(text) : null;
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
