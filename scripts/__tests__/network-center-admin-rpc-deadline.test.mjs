import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import * as admin from "../network-center-admin.mjs";

// 2026-08 incident. `set-rollout` was called with a stale `--expected-version`.
// The server spelled that deterministic CAS refusal as SQLSTATE 40001 (a
// serialization failure), upstream infrastructure retried it, and because
// `createRpcTransport` passed no `signal` the operator's terminal sat silent
// through two ~2 minute undici timeouts before a 504 finally landed. The same
// refusal via the Management API answers instantly. The server half is fixed in
// a migration; this file guards the client half: every admin request is bounded,
// nothing is retried, and an abandoned request stays UNKNOWN.
const CONFIG = { projectRef: "test-project", serviceRoleKey: "test-service-role-key" };
const BUILDING_ID = "11111111-1111-4111-8111-111111111111";
const INTERFACE_ID = "44444444-4444-4444-8444-444444444444";
const ORGANIZATION_ID = "dddd0000-0000-4000-8000-000000000001";
const DEVICE_ID = "22222222-2222-4222-8222-222222222222";
const MANAGED_RESOURCE_ID = "55555555-5555-4555-8555-555555555555";
const WORKER_KEY = "worker-demo-01";
const EXPIRES_AT = "2026-08-30T00:00:00.000Z";
const REASON = "cycle ether4 for tenant fault isolation";

const assignments = [{
  organizationId: ORGANIZATION_ID,
  buildingId: BUILDING_ID,
  deviceId: DEVICE_ID,
  enabled: true,
  canPoll: true,
  canInventory: true,
  canExecute: false,
}];

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => name.toLowerCase() === "content-type" ? "application/json" : null },
    text: async () => JSON.stringify(body),
  };
}

function rpcName(url) {
  return decodeURIComponent(new URL(url).pathname.split("/").at(-1));
}

/**
 * An upstream that never answers but does honour cancellation — exactly the
 * shape of the incident. Without a `signal` this promise settles never, so a
 * transport that forgets the deadline hangs instead of failing.
 */
function createHangingFetch() {
  const calls = [];
  const fetchImpl = (url, options) => new Promise((resolve, reject) => {
    calls.push({ url, options });
    const signal = options?.signal;
    if (!signal) return;
    if (signal.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true });
  });
  return { calls, fetchImpl };
}

/**
 * Awaits an admin call but refuses to wait forever. A transport that forgot the
 * deadline leaves this pending, and the test then reports THAT — instead of
 * stalling the whole file the way the incident stalled the operator's terminal.
 */
function settleWithin(promise, ms) {
  let guard;
  return Promise.race([
    promise.then((value) => ({ value }), (error) => ({ error })),
    new Promise((resolve) => { guard = setTimeout(() => resolve({ stalled: ms }), ms); }),
  ]).finally(() => clearTimeout(guard));
}

/** The same upstream, answering well inside any deadline. */
function createRespondingFetch(payloadFor) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return jsonResponse(200, payloadFor(rpcName(url), JSON.parse(options.body)));
  };
  return { calls, fetchImpl };
}

async function withSecretTarget(run) {
  const directory = await mkdtemp(join(tmpdir(), "network-center-admin-deadline-"));
  const outputPath = join(directory, "worker.secret");
  try {
    return await run({ outputPath });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("a hung admin RPC is abandoned at the deadline instead of holding the terminal", { timeout: 5_000 }, async () => {
  const { calls, fetchImpl } = createHangingFetch();
  const rpc = admin.createRpcTransport(CONFIG, fetchImpl, { timeoutMs: 40 });

  const startedAt = Date.now();
  const outcome = await settleWithin(rpc("network_center_admin_set_rollout_v1", {
    p_building_id: BUILDING_ID,
    p_expected_version: 1,
  }), 2_000);
  const elapsed = Date.now() - startedAt;

  assert.equal(
    outcome.stalled,
    undefined,
    "the request was never cancelled: the deadline did not reach fetch",
  );
  const error = outcome.error;
  assert.ok(error instanceof Error, "a hung request must reject");
  assert.equal(error.outcome, "UNKNOWN");
  assert.match(String(error.message), /network_center_admin_set_rollout_v1/);
  assert.match(String(error.message), /40 ms/);
  assert.match(String(error.message), /UNKNOWN/);
  assert.ok(elapsed < 2_000, `the deadline must fire promptly, waited ${elapsed} ms`);
  // The signal has to reach the actual request, not just exist on our side.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.signal?.aborted, true);
  // Nothing is ever re-sent: a CAS refusal is a decision, not a transient.
  assert.equal(calls.length, 1);
});

// Non-vacuity: the identical transport and the identical fake upstream, only
// answering in time. If this failed, test 1 above would prove nothing.
test("the same transport returns the payload when the upstream answers in time", { timeout: 5_000 }, async () => {
  const { calls, fetchImpl } = createRespondingFetch(() => ({ version: 2 }));
  const rpc = admin.createRpcTransport(CONFIG, fetchImpl, { timeoutMs: 40 });

  const payload = await rpc("network_center_admin_set_rollout_v1", {
    p_building_id: BUILDING_ID,
    p_expected_version: 1,
  });

  assert.deepEqual(payload, { version: 2 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.signal?.aborted, false);
});

test("a timed-out credential mutation is UNKNOWN and never REJECTED", { timeout: 5_000 }, async () => {
  for (const name of [
    "network_center_admin_provision_worker_v1",
    "network_center_admin_rotate_worker_credential_v1",
  ]) {
    const { fetchImpl } = createHangingFetch();
    const rpc = admin.createRpcTransport(CONFIG, fetchImpl, { timeoutMs: 25 });
    const outcome = await settleWithin(rpc(name, { p_worker_key: WORKER_KEY }), 2_000);
    assert.equal(outcome.stalled, undefined, `${name} was never cancelled`);
    const error = outcome.error;

    // The mutation may already have committed on the server when we gave up.
    // "REJECTED" would authorise deleting a secret that is live in production.
    assert.equal(error?.outcome, "UNKNOWN", `${name} must stay UNKNOWN`);
    assert.notEqual(error?.outcome, "REJECTED");
    assert.match(String(error?.message), new RegExp(name));
  }
});

test("a timed-out provision keeps the generated secret on disk", { timeout: 5_000 }, async () => {
  await withSecretTarget(async ({ outputPath }) => {
    const { fetchImpl } = createHangingFetch();
    const rpc = admin.createRpcTransport(CONFIG, fetchImpl, { timeoutMs: 25 });

    const outcome = await settleWithin(admin.provisionWorker({
      workerKey: WORKER_KEY,
      displayName: "Demo worker",
      outputPath,
      expiresAt: EXPIRES_AT,
      assignments,
      rpc,
    }), 2_000);

    // Timeout -> UNKNOWN -> reconciliation is attempted, itself times out, and
    // the operator is told to preserve the secret rather than losing it.
    assert.equal(outcome.stalled, undefined, "provision-worker was never cancelled");
    const error = outcome.error;
    assert.equal(error?.code, "CREDENTIAL_OUTCOME_UNKNOWN");
    assert.equal(existsSync(outputPath), true, "an unknown outcome must never delete the secret");
  });
});

test("a transport failure that is not a timeout keeps its own message and stays redacted", { timeout: 5_000 }, async () => {
  const rpc = admin.createRpcTransport(CONFIG, async () => {
    throw new Error(`socket hang up while presenting ${CONFIG.serviceRoleKey}`);
  }, { timeoutMs: 5_000 });

  const error = await rpc("network_center_admin_status_v1", { p_limit: 1 }).catch((cause) => cause);

  assert.equal(error?.outcome, "UNKNOWN");
  assert.match(String(error?.message), /socket hang up/);
  assert.doesNotMatch(String(error?.message), /timed out/);
  assert.equal(String(error?.message).includes(CONFIG.serviceRoleKey), false);
  assert.match(String(error?.message), /\[REDACTED\]/);
});

test("the deadline timer is armed from the environment and cleared on success", { timeout: 5_000 }, async () => {
  const envDeadline = 4_321;
  const armed = [];
  const live = new Set();
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  // Only our own deadline is tracked, so timers the test runner arms for its
  // own bookkeeping cannot make this assertion flaky.
  globalThis.setTimeout = (handler, delay, ...rest) => {
    const handle = realSetTimeout(handler, delay, ...rest);
    if (delay === envDeadline) {
      armed.push(delay);
      live.add(handle);
    }
    return handle;
  };
  globalThis.clearTimeout = (handle) => {
    live.delete(handle);
    return realClearTimeout(handle);
  };
  try {
    const { fetchImpl } = createRespondingFetch(() => ({ workers: [], assignments: [] }));
    const rpc = admin.createRpcTransport(CONFIG, fetchImpl, {
      environment: { NETWORK_CENTER_ADMIN_RPC_TIMEOUT_MS: String(envDeadline) },
    });
    await rpc("network_center_admin_status_v1", { p_limit: 1 });
    await rpc("network_center_admin_status_v1", { p_limit: 1 });
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }

  // Non-vacuity: the env var really did arm the deadline, once per request...
  assert.deepEqual(armed, [envDeadline, envDeadline]);
  // ...and every one of them was cleared, so the CLI can exit immediately.
  assert.equal(live.size, 0, "a surviving deadline timer would keep the process alive");
});

test("the default deadline is 30 s and a usable override is honoured", () => {
  assert.equal(admin.resolveAdminRpcTimeoutMs({ environment: {} }), 30_000);
  assert.equal(admin.resolveAdminRpcTimeoutMs({ environment: { NETWORK_CENTER_ADMIN_RPC_TIMEOUT_MS: "" } }), 30_000);
  for (const value of ["1000", "45000", "600000"]) {
    assert.equal(
      admin.resolveAdminRpcTimeoutMs({ environment: { NETWORK_CENTER_ADMIN_RPC_TIMEOUT_MS: value } }),
      Number(value),
    );
  }
});

test("an unusable NETWORK_CENTER_ADMIN_RPC_TIMEOUT_MS is refused, never silently defaulted", () => {
  for (const value of ["0", "abc", "600001", "-1", "1.5", "999", "30s", "1e4", "  "]) {
    if (value.trim() === "") continue;
    const environment = { NETWORK_CENTER_ADMIN_RPC_TIMEOUT_MS: value };
    assert.throws(
      () => admin.resolveAdminRpcTimeoutMs({ environment }),
      /NETWORK_CENTER_ADMIN_RPC_TIMEOUT_MS must be an integer/,
      `${value} must be refused`,
    );
    // The refusal happens while the transport is being built, before any
    // request could be sent under a deadline the operator does not have.
    let called = 0;
    assert.throws(
      () => admin.createRpcTransport(CONFIG, () => { called += 1; }, { environment }),
      /NETWORK_CENTER_ADMIN_RPC_TIMEOUT_MS must be an integer/,
    );
    assert.equal(called, 0);
  }
});

test("enroll-access-port refuses a bad request before any RPC is sent", async () => {
  const rejected = [
    { label: "no arguments at all", args: {} },
    { label: "interface id is not a uuid", args: { interfaceId: "ether4", confirmImmutableKey: "ether4", reason: REASON } },
    // ether1 is the WAN uplink on every device in this fleet. Enrolling it
    // would make the router's own uplink cyclable.
    { label: "ether1 is the WAN uplink", args: { interfaceId: INTERFACE_ID, confirmImmutableKey: "ether1", reason: REASON } },
    { label: "ether0 does not exist", args: { interfaceId: INTERFACE_ID, confirmImmutableKey: "ether0", reason: REASON } },
    { label: "bridge is not a physical access port", args: { interfaceId: INTERFACE_ID, confirmImmutableKey: "bridge", reason: REASON } },
    // A typed confirmation is only a confirmation if it must be typed exactly.
    { label: "casing must match", args: { interfaceId: INTERFACE_ID, confirmImmutableKey: "Ether4", reason: REASON } },
    { label: "trailing space is a typo", args: { interfaceId: INTERFACE_ID, confirmImmutableKey: "ether4 ", reason: REASON } },
    { label: "ether100 is out of range", args: { interfaceId: INTERFACE_ID, confirmImmutableKey: "ether100", reason: REASON } },
    { label: "reason shorter than 8 characters", args: { interfaceId: INTERFACE_ID, confirmImmutableKey: "ether4", reason: "cycle" } },
    { label: "reason that is only padding", args: { interfaceId: INTERFACE_ID, confirmImmutableKey: "ether4", reason: "       fix       " } },
    { label: "reason longer than 500 characters", args: { interfaceId: INTERFACE_ID, confirmImmutableKey: "ether4", reason: "a".repeat(501) } },
  ];

  for (const { label, args } of rejected) {
    const calls = [];
    const rpc = async (name, rpcArgs) => { calls.push({ name, rpcArgs }); return {}; };
    await assert.rejects(admin.enrollAccessPort({ ...args, rpc }), Error, label);
    assert.equal(calls.length, 0, `${label} must be refused locally, not on the server`);
  }
});

test("enroll-access-port accepts every real access port key", async () => {
  for (const immutableKey of ["ether2", "ether5", "ether9", "ether10", "ether99"]) {
    const calls = [];
    const rpc = async (name, args) => {
      calls.push({ name, args });
      if (name === "network_center_admin_enroll_access_port_v1") {
        return { interfaceId: INTERFACE_ID, immutableKey: args.p_confirm_immutable_key, changed: true };
      }
      return { workers: [], assignments: [] };
    };
    await admin.enrollAccessPort({
      interfaceId: INTERFACE_ID,
      confirmImmutableKey: immutableKey,
      reason: REASON,
      rpc,
    });
    assert.equal(calls[0].args.p_confirm_immutable_key, immutableKey);
  }
});

test("enroll-access-port maps its flags to the exact RPC argument names", async () => {
  const calls = [];
  const rpc = async (name, args) => {
    calls.push({ name, args });
    if (name === "network_center_admin_enroll_access_port_v1") {
      return {
        organizationId: ORGANIZATION_ID,
        buildingId: BUILDING_ID,
        deviceId: DEVICE_ID,
        interfaceId: args.p_interface_id,
        managedResourceId: MANAGED_RESOURCE_ID,
        immutableKey: args.p_confirm_immutable_key,
        enrollmentState: "ENROLLED",
        resourceProtected: false,
        interfaceProtected: false,
        changed: true,
      };
    }
    if (name === "network_center_admin_status_v1") return { workers: [], assignments: [] };
    throw new Error(`unexpected RPC ${name}`);
  };

  const result = await admin.enrollAccessPort({
    interfaceId: INTERFACE_ID,
    confirmImmutableKey: "ether4",
    reason: `   ${REASON}   `,
    rpc,
  });

  assert.equal(calls[0].name, "network_center_admin_enroll_access_port_v1");
  assert.deepEqual(
    Object.keys(calls[0].args).sort(),
    ["p_confirm_immutable_key", "p_interface_id", "p_reason", "p_request_id"],
  );
  assert.equal(calls[0].args.p_interface_id, INTERFACE_ID);
  assert.equal(calls[0].args.p_confirm_immutable_key, "ether4");
  assert.equal(calls[0].args.p_reason, REASON);
  assert.match(
    calls[0].args.p_request_id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  assert.equal(result.operation.enrollmentState, "ENROLLED");
  assert.equal(result.operation.changed, true);
});

test("list-access-ports sends an explicit null when no building is given", async () => {
  const calls = [];
  const rpc = async (name, args) => {
    calls.push({ name, args });
    return { ports: [] };
  };

  const unscoped = await admin.listAccessPorts({ rpc });
  assert.equal(calls[0].name, "network_center_admin_list_access_ports_v1");
  assert.deepEqual(calls[0].args, { p_building_id: null });
  assert.deepEqual(unscoped, { ports: [] });

  await admin.listAccessPorts({ buildingId: BUILDING_ID, rpc });
  assert.deepEqual(calls[1].args, { p_building_id: BUILDING_ID });
});

test("list-access-ports refuses a malformed building id and a malformed payload", async () => {
  const calls = [];
  const rpc = async (name, args) => { calls.push({ name, args }); return { ports: [] }; };
  await assert.rejects(admin.listAccessPorts({ buildingId: "all", rpc }), /Invalid building id/);
  assert.equal(calls.length, 0);

  await assert.rejects(
    admin.listAccessPorts({ rpc: async () => ({ rows: [] }) }),
    /invalid payload/i,
  );
});

test("both access-port commands are reachable from the CLI surface", () => {
  assert.equal(admin.ADMIN_COMMANDS.has("list-access-ports"), true);
  assert.equal(admin.ADMIN_COMMANDS.has("enroll-access-port"), true);
  assert.deepEqual(
    admin.parseAdminCommand("enroll-access-port", [
      "--interface-id", INTERFACE_ID,
      "--confirm-immutable-key", "ether4",
      "--reason", REASON,
    ]),
    { interfaceId: INTERFACE_ID, confirmImmutableKey: "ether4", reason: REASON },
  );
  assert.deepEqual(
    admin.parseAdminCommand("list-access-ports", ["--building-id", BUILDING_ID]),
    { buildingId: BUILDING_ID },
  );
  assert.deepEqual(admin.parseAdminCommand("list-access-ports", []), {});
  assert.throws(
    () => admin.parseAdminCommand("enroll-access-port", ["--force", "yes"]),
    /unknown.*flag|unsupported/i,
  );
});
