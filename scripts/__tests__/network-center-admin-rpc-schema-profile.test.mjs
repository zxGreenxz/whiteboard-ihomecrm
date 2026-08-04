import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import * as admin from "../network-center-admin.mjs";

// This project's PostgREST exposes `db_schema = "api, public, graphql_public"`.
// The FIRST entry is the default profile, so a POST RPC that omits
// `Content-Profile` is resolved against `api`, never `public`, and PostgREST
// answers 404/PGRST202. Every Network Center admin function lives in `public`.
// The stub below mimics exactly that resolution rule so the guard below is a
// behavioural test, not a string match on our own source.
const EXPOSED_SCHEMAS = ["api", "public", "graphql_public"];
const DEFAULT_PROFILE = EXPOSED_SCHEMAS[0];

const WORKER_KEY = "worker-demo-01";
const WORKER_ID = "33333333-3333-4333-8333-333333333333";
const ORGANIZATION_ID = "dddd0000-0000-4000-8000-000000000001";
const BUILDING_ID = "11111111-1111-4111-8111-111111111111";
const DEVICE_ID = "22222222-2222-4222-8222-222222222222";
const FINGERPRINT = "sha256:0123456789abcdef01234567";
const WORKER_VERSION = "a".repeat(40);
const NOT_BEFORE = "2026-08-02T00:00:00.000Z";
const EXPIRES_AT = "2026-08-30T00:00:00.000Z";

const assignments = [{
  organizationId: ORGANIZATION_ID,
  buildingId: BUILDING_ID,
  deviceId: DEVICE_ID,
  enabled: true,
  canPoll: true,
  canInventory: true,
  canExecute: false,
}];

// Every admin RPC the CLI is able to reach, and the authoritative payload each
// one returns. A new admin RPC that is not listed here makes the sweep below
// fail loudly rather than silently escaping the profile guard.
const ADMIN_RPC_PAYLOADS = new Map([
  ["network_center_admin_provision_worker_v1", (args) => ({
    workerId: WORKER_ID,
    workerKey: args.p_worker_key,
    status: "ACTIVE",
    credentialFingerprint: args.p_fingerprint,
    assignmentCount: args.p_assignments.length,
  })],
  ["network_center_admin_rotate_worker_credential_v1", (args) => ({
    workerId: WORKER_ID,
    workerKey: args.p_worker_key,
    credentialFingerprint: args.p_fingerprint,
    notBefore: args.p_not_before,
    expiresAt: args.p_expires_at,
  })],
  ["network_center_admin_revoke_worker_credential_v1", () => ({ revoked: true })],
  ["network_center_admin_set_worker_assignments_v1", () => ({ assignmentCount: 1 })],
  ["network_center_admin_provision_connection_v1", () => ({ connectionId: DEVICE_ID })],
  ["network_center_admin_set_rollout_v1", () => ({ version: 2 })],
  ["network_center_admin_finalize_worker_compatibility_v1", () => ({ finalized: true })],
  ["network_center_admin_status_v1", () => ({ workers: [], assignments: [] })],
  ["network_center_admin_release_status_v1", () => ({ releaseHeartbeats: [] })],
  ["network_center_admin_worker_credential_status_v1", (args) => ({
    found: true,
    workerKey: args.p_worker_key,
    credentialFingerprint: args.p_fingerprint,
    notBefore: NOT_BEFORE,
    expiresAt: EXPIRES_AT,
    revokedAt: null,
  })],
  ["network_center_admin_worker_release_status_v1", () => null],
]);

function rpcName(url) {
  return decodeURIComponent(new URL(url).pathname.split("/").at(-1));
}

// PostgREST matches header names case-insensitively; so must the stub, or the
// guard would pass for a header spelled in a casing PostgREST accepts.
function resolveProfile(headers) {
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() === "content-profile") return value;
  }
  return DEFAULT_PROFILE;
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => name.toLowerCase() === "content-type" ? "application/json" : null },
    text: async () => body === undefined ? "" : JSON.stringify(body),
  };
}

/**
 * A PostgREST stand-in configured exactly like production: the admin functions
 * exist ONLY in `public`, and requests are routed by profile.
 */
function createPostgrestStub() {
  const requests = [];
  const fetchImpl = async (url, options) => {
    const name = rpcName(url);
    const profile = resolveProfile(options.headers);
    const args = JSON.parse(options.body);
    requests.push({ name, profile });
    if (!EXPOSED_SCHEMAS.includes(profile)) {
      return jsonResponse(406, {
        code: "PGRST106",
        details: null,
        hint: null,
        message: `The schema must be one of the following: ${EXPOSED_SCHEMAS.join(", ")}`,
      });
    }
    if (profile !== "public") {
      return jsonResponse(404, {
        code: "PGRST202",
        details: `Searched for the function ${profile}.${name} ` +
          "but no matches were found in the schema cache.",
        hint: null,
        message: `Could not find the function ${profile}.${name} in the schema cache`,
      });
    }
    const payload = ADMIN_RPC_PAYLOADS.get(name);
    assert.ok(payload, `unlisted admin RPC ${name}`);
    return jsonResponse(200, payload(args));
  };
  return { requests, fetchImpl };
}

async function withSecretTarget(run) {
  const directory = await mkdtemp(join(tmpdir(), "network-center-admin-profile-"));
  const outputPath = join(directory, "worker.secret");
  try {
    return await run({ outputPath });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Drives every admin command that reaches PostgREST through one transport. */
async function exerciseEveryAdminCommand(rpc) {
  await withSecretTarget(({ outputPath }) => admin.provisionWorker({
    workerKey: WORKER_KEY,
    displayName: "Demo worker",
    outputPath,
    expiresAt: EXPIRES_AT,
    assignments,
    rpc,
  }));
  await withSecretTarget(({ outputPath }) => admin.rotateWorker({
    workerKey: WORKER_KEY,
    outputPath,
    notBefore: NOT_BEFORE,
    expiresAt: EXPIRES_AT,
    rpc,
  }));
  await admin.revokeWorker({ workerKey: WORKER_KEY, fingerprint: FINGERPRINT, rpc });
  await admin.setAssignments({ workerKey: WORKER_KEY, assignments, rpc });
  await admin.unassignWorker({ workerKey: WORKER_KEY, confirmWorkerKey: WORKER_KEY, rpc });
  await admin.provisionConnection({
    deviceId: DEVICE_ID,
    transport: "ROUTEROS_SSH",
    managementIp: "192.168.88.1",
    managementPort: 22,
    credentialRef: "router/demo-01",
    hostKeyFingerprint: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    rpc,
  });
  await admin.setRollout({
    buildingId: BUILDING_ID,
    rolloutState: "READ_ONLY",
    expectedVersion: 1,
    reason: "regression guard",
    rpc,
  });
  await admin.finalizeWorkerCutover({ rpc });
  await admin.getStatus({ rpc });
  await admin.getWorkerReleaseStatus({ workerKey: WORKER_KEY, workerVersion: WORKER_VERSION, rpc });
}

/**
 * The credential-status RPC is only reached when a mutation's outcome is
 * unknown, so the sweep has to force that path or it would never observe the
 * one RPC that decides whether a minted secret is live.
 */
async function exerciseCredentialReconciliation(fetchImpl) {
  const rpc = admin.createRpcTransport(
    { projectRef: "test-project", serviceRoleKey: "test-service-role-key" },
    async (url, options) => {
      const response = await fetchImpl(url, options);
      if (rpcName(url) === "network_center_admin_provision_worker_v1") {
        return jsonResponse(503, {
          code: "22023",
          details: null,
          hint: null,
          message: "upstream gateway unavailable",
        });
      }
      return response;
    },
  );
  await withSecretTarget(({ outputPath }) => admin.provisionWorker({
    workerKey: WORKER_KEY,
    displayName: "Demo worker",
    outputPath,
    expiresAt: EXPIRES_AT,
    assignments,
    rpc,
  }));
}

test("the admin RPC schema is declared once and is the schema the functions live in", () => {
  assert.equal(admin.ADMIN_RPC_SCHEMA, "public");
  assert.equal(
    admin.adminRpcHeaders("service-role-key")["Content-Profile"],
    admin.ADMIN_RPC_SCHEMA,
  );
});

test("every admin RPC is posted with the public Content-Profile", async () => {
  const { requests, fetchImpl } = createPostgrestStub();
  const rpc = admin.createRpcTransport(
    { projectRef: "test-project", serviceRoleKey: "test-service-role-key" },
    fetchImpl,
  );

  await exerciseEveryAdminCommand(rpc);
  await exerciseCredentialReconciliation(fetchImpl);

  assert.ok(requests.length >= ADMIN_RPC_PAYLOADS.size);
  for (const { name, profile } of requests) {
    assert.equal(profile, "public", `${name} resolved against ${profile}, not public`);
  }
  // The sweep must actually reach every admin RPC, otherwise a call site could
  // regress behind a name this test never exercises.
  const observed = new Set(requests.map((request) => request.name));
  for (const name of ADMIN_RPC_PAYLOADS.keys()) {
    assert.ok(observed.has(name), `admin RPC ${name} was never exercised`);
  }
});

test("dropping the profile reproduces the production PGRST202 against schema api", async () => {
  const { fetchImpl } = createPostgrestStub();
  // Same transport, profile stripped in flight — the exact defect being guarded.
  const rpc = admin.createRpcTransport(
    { projectRef: "test-project", serviceRoleKey: "test-service-role-key" },
    (url, options) => {
      const headers = { ...options.headers };
      for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === "content-profile") delete headers[key];
      }
      return fetchImpl(url, { ...options, headers });
    },
  );

  const error = await admin.getStatus({ rpc }).catch((cause) => cause);
  assert.match(String(error?.message), /\(404\)/);
  assert.match(String(error?.message), /PGRST202/);
  assert.match(String(error?.message), /api\.network_center_admin_status_v1/);
});

test("a mis-resolved schema never leaves a provisioned secret behind", async () => {
  const { fetchImpl } = createPostgrestStub();
  const rpc = admin.createRpcTransport(
    { projectRef: "test-project", serviceRoleKey: "test-service-role-key" },
    (url, options) => {
      const headers = { ...options.headers };
      for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === "content-profile") delete headers[key];
      }
      return fetchImpl(url, { ...options, headers });
    },
  );

  await withSecretTarget(async ({ outputPath }) => {
    const error = await admin.provisionWorker({
      workerKey: WORKER_KEY,
      displayName: "Demo worker",
      outputPath,
      expiresAt: EXPIRES_AT,
      assignments,
      rpc,
    }).catch((cause) => cause);

    assert.equal(error?.outcome, "REJECTED");
    assert.match(String(error?.message), /PGRST202/);
    assert.equal(existsSync(outputPath), false);
  });
});

test("the service-role credential is never used as the schema profile", () => {
  const headers = admin.adminRpcHeaders("test-service-role-key");
  assert.equal(headers["Content-Profile"], "public");
  assert.equal(headers.apikey, "test-service-role-key");
  assert.equal(headers.Authorization, "Bearer test-service-role-key");
  assert.equal(headers["Content-Type"], "application/json");
  assert.deepEqual(
    Object.keys(headers).sort(),
    ["Authorization", "Content-Profile", "Content-Type", "apikey"],
  );
});
