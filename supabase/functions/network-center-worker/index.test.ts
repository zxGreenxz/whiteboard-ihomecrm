function assert(
  condition: unknown,
  message = "Assertion failed",
): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals<T>(
  actual: T,
  expected: T,
  message = "Values differ",
): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(
      `${message}\nactual: ${actualJson}\nexpected: ${expectedJson}`,
    );
  }
}

type RpcResult = {
  data: unknown;
  error: null | { code?: string; message?: string };
};

type WorkerModule = {
  createWorkerHandler: (dependencies?: {
    getEnv?: (name: string) => string | undefined;
    rpc?: (name: string, args: Record<string, unknown>) => Promise<RpcResult>;
  }) => (request: Request) => Promise<Response>;
  readJsonBody?: (
    request: Request,
    maximumBytes: number,
  ) => Promise<Record<string, unknown>>;
};

type RpcCall = {
  name: string;
  args: Record<string, unknown>;
};

const SECRET = "network-worker-test-secret-at-least-32-bytes";
const WORKER_ID = "vultr-network-worker-01";
const COMMAND_ID = "11111111-1111-4111-8111-111111111111";
const LEASE_TOKEN = "22222222-2222-4222-8222-222222222222";
const DEVICE_ID = "33333333-3333-4333-8333-333333333333";
const SNAPSHOT_ID = "44444444-4444-4444-8444-444444444444";

const workerModule = import("./index.ts").catch(() => null);

async function loadWorkerModule(): Promise<WorkerModule> {
  const loaded = await workerModule;
  assert(loaded !== null, "network-center-worker/index.ts must exist");
  assertEquals(
    typeof loaded.createWorkerHandler,
    "function",
    "index.ts must export createWorkerHandler",
  );
  return loaded as WorkerModule;
}

async function createHarness(options?: { rpcResult?: RpcResult }) {
  const calls: RpcCall[] = [];
  const loaded = await loadWorkerModule();
  const handler = loaded.createWorkerHandler({
    getEnv: (name) => {
      if (name === "NETWORK_WORKER_SECRET") {
        throw new Error("fleet-global worker secret must not be read");
      }
      if (name === "SUPABASE_URL") return "https://example.supabase.co";
      if (name === "SUPABASE_SERVICE_ROLE_KEY") return "service-role-test-key";
      return undefined;
    },
    rpc: (name, args) => {
      calls.push({ name, args });
      return Promise.resolve(
        options?.rpcResult ?? { data: { accepted: true }, error: null },
      );
    },
  });
  return { calls, handler };
}

function post(
  path: string,
  body: unknown,
  options?: { secret?: string | null; raw?: string; headers?: HeadersInit },
): Request {
  const headers = new Headers(options?.headers);
  headers.set("content-type", "application/json");
  if (options?.secret !== null) {
    headers.set("x-network-worker-secret", options?.secret ?? SECRET);
  }
  return new Request(`http://localhost/network-center-worker${path}`, {
    method: "POST",
    headers,
    body: options?.raw ?? JSON.stringify(body),
  });
}

async function responseJson(
  response: Response,
): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

Deno.test("worker auth rejects missing or malformed credentials before RPC", async () => {
  const { handler, calls } = await createHarness();
  const missing = await handler(post("/heartbeat", {}, { secret: null }));
  const malformed = await handler(
    post("/heartbeat", {}, { secret: "too-short" }),
  );
  assertEquals(missing.status, 401);
  assertEquals(malformed.status, 401);
  assertEquals(calls.length, 0);
});

Deno.test("spoofed workerId is rejected before any RPC", async () => {
  const { handler, calls } = await createHarness();
  const response = await handler(post("/connections", {
    workerId: "victim-worker",
    limit: 100,
  }));
  assertEquals(response.status, 400);
  assertEquals(calls.length, 0);
});

Deno.test("credential digest reaches v2 RPC and Edge never supplies worker identity", async () => {
  const { handler, calls } = await createHarness();
  const response = await handler(post("/connections", { limit: 100 }));
  assertEquals(response.status, 200);
  assertEquals(calls.length, 1);
  assertEquals(calls[0]?.name, "network_center_worker_list_connections_v2");
  assert(
    typeof calls[0]?.args.p_credential_digest === "string" &&
      /^[a-f0-9]{64}$/.test(calls[0]?.args.p_credential_digest as string),
    "credential digest must be a lowercase SHA-256 hex value",
  );
  assertEquals("p_worker_id" in (calls[0]?.args ?? {}), false);
  assertEquals("workerId" in (calls[0]?.args ?? {}), false);
});

Deno.test("database authentication failures are returned as one unauthorized response", async () => {
  const { handler, calls } = await createHarness({
    rpcResult: { data: null, error: { code: "28000", message: "credential detail" } },
  });
  const response = await handler(post("/connections", { limit: 100 }));
  assertEquals(response.status, 401);
  assertEquals(await responseJson(response), { error: "unauthorized" });
  assertEquals(calls.length, 1);
});

Deno.test("unknown routes and non-POST methods are denied without invoking RPC", async () => {
  const { handler, calls } = await createHarness();
  const unknown = await handler(post("/raw-cli", { workerId: WORKER_ID }));
  const get = await handler(
    new Request("http://localhost/network-center-worker/claim", {
      method: "GET",
      headers: { "x-network-worker-secret": SECRET },
    }),
  );

  assertEquals(unknown.status, 404);
  assertEquals(get.status, 405);
  assertEquals(calls.length, 0);
});

Deno.test("claim defaults to the process-wide RouterOS concurrency limit", async () => {
  const { handler, calls } = await createHarness({
    rpcResult: { data: { items: [] }, error: null },
  });

  const response = await handler(post("/claim", {}));

  assertEquals(response.status, 200);
  assertEquals(calls.length, 1);
  assertEquals(calls[0]?.name, "network_center_worker_claim_v2");
  assertEquals(calls[0]?.args.p_limit, 3);
});

Deno.test("claim rejects limits above the process-wide RouterOS concurrency limit", async () => {
  for (const limit of [4, 20]) {
    const { handler, calls } = await createHarness();

    const response = await handler(post("/claim", { limit }));

    assertEquals(response.status, 400);
    assertEquals(calls.length, 0);
  }
});

Deno.test("claim accepts each limit within the process-wide RouterOS concurrency limit", async () => {
  for (const limit of [1, 2, 3]) {
    const { handler, calls } = await createHarness({
      rpcResult: { data: { items: [] }, error: null },
    });

    const response = await handler(post("/claim", { limit }));

    assertEquals(response.status, 200);
    assertEquals(calls.length, 1);
    assertEquals(calls[0]?.args.p_limit, limit);
  }
});

Deno.test("claim rejects an explicit null limit instead of applying the default", async () => {
  const { handler, calls } = await createHarness({
    rpcResult: { data: { items: [] }, error: null },
  });

  const response = await handler(post("/claim", { limit: null }));

  assertEquals(response.status, 400);
  assertEquals(calls.length, 0);
});

Deno.test("claim fails closed when the RPC response is not an items envelope", async () => {
  for (const data of [
    null,
    [],
    { rows: [] },
    { items: null },
    { items: {} },
    Object.assign(new Date(0), { items: [] }),
    "malformed",
  ]) {
    const { handler } = await createHarness({
      rpcResult: { data, error: null },
    });

    const response = await handler(post("/claim", { limit: 3 }));

    assertEquals(response.status, 502);
    assertEquals(await responseJson(response), {
      error: "worker_backend_error",
    });
  }
});

Deno.test("claim fails closed when the RPC returns more rows than requested", async () => {
  const cases = [
    { limit: 1, rows: [{ id: "secret-row-1" }, { id: "secret-row-2" }] },
    {
      limit: 3,
      rows: [
        { id: "secret-row-1" },
        { id: "secret-row-2" },
        { id: "secret-row-3" },
        { id: "secret-row-4" },
      ],
    },
  ];

  for (const { limit, rows } of cases) {
    const { handler } = await createHarness({
      rpcResult: { data: { items: rows }, error: null },
    });

    const response = await handler(post("/claim", { limit }));
    const body = await responseJson(response);

    assertEquals(response.status, 502);
    assertEquals(body, { error: "worker_backend_error" });
    assertEquals(JSON.stringify(body).includes("secret-row"), false);
  }
});

Deno.test("claim preserves the production items envelope within the requested limit", async () => {
  const rows = [{ id: "row-1" }, { id: "row-2" }];
  const { handler } = await createHarness({
    rpcResult: { data: { items: rows }, error: null },
  });

  const response = await handler(post("/claim", { limit: 2 }));

  assertEquals(response.status, 200);
  assertEquals(await responseJson(response), {
    ok: true,
    data: { items: rows },
  });
});

Deno.test("malformed JSON, wrong content type, and oversized bodies are rejected", async () => {
  const { handler, calls } = await createHarness();
  const malformed = await handler(post("/claim", {}, { raw: "{" }));
  const wrongContentType = await handler(
    new Request(
      "http://localhost/network-center-worker/claim",
      {
        method: "POST",
        headers: {
          "content-type": "text/plain",
          "x-network-worker-secret": SECRET,
        },
        body: JSON.stringify({ workerId: WORKER_ID }),
      },
    ),
  );
  const oversized = await handler(post("/claim", {
    workerId: WORKER_ID,
    padding: "x".repeat(20_000),
  }));

  assertEquals(malformed.status, 400);
  assertEquals(wrongContentType.status, 415);
  assertEquals(oversized.status, 413);
  assertEquals(calls.length, 0);
});

Deno.test("valid routes forward only their allowlisted RPC and normalized arguments", async () => {
  const now = new Date().toISOString();
  const credentialDigest = await sha256Hex(SECRET);
  const routes: Array<{
    path: string;
    body: Record<string, unknown>;
    rpc: string;
    args: Record<string, unknown>;
  }> = [
    {
      path: "/heartbeat",
      body: {
        workerVersion: "1.0.0",
        capabilities: ["poll", "execute"],
        status: "online",
        queueAgeSeconds: 0,
        safeMetadata: { region: "sgp" },
        startedAt: now,
      },
      rpc: "network_center_worker_heartbeat_v2",
      args: {
        p_worker_version: "1.0.0",
        p_capabilities: ["poll", "execute"],
        p_status: "ONLINE",
        p_queue_age_seconds: 0,
        p_safe_metadata: { region: "sgp" },
        p_started_at: now,
      },
    },
    {
      path: "/connections",
      body: { limit: 100 },
      rpc: "network_center_worker_list_connections_v2",
      args: { p_limit: 100 },
    },
    {
      path: "/claim",
      body: { limit: 3, leaseSeconds: 90 },
      rpc: "network_center_worker_claim_v2",
      args: { p_limit: 3, p_lease_seconds: 90 },
    },
    {
      path: "/renew",
      body: {
        commandId: COMMAND_ID,
        leaseToken: LEASE_TOKEN,
        fencingGeneration: 11,
        leaseSeconds: 90,
      },
      rpc: "network_center_worker_renew_v2",
      args: {
        p_command_id: COMMAND_ID,
        p_lease_token: LEASE_TOKEN,
        p_fencing_generation: 11,
        p_lease_seconds: 90,
      },
    },
    {
      path: "/ingest",
      body: {
        payload: { observedAt: now, devices: [], interfaces: [], clients: [] },
      },
      rpc: "network_center_worker_ingest_v2",
      args: {
        p_payload: {
          observedAt: now,
          devices: [],
          interfaces: [],
          clients: [],
        },
      },
    },
    {
      path: "/inventory",
      body: {
        payload: {
          routerDeviceId: DEVICE_ID,
          discoveryRunId: SNAPSHOT_ID,
          observedAt: now,
          batchIndex: 0,
          batchCount: 1,
          interfaces: [],
          aruba: [],
          quarantine: [],
        },
      },
      rpc: "network_center_worker_inventory_v2",
      args: {
        p_payload: {
          routerDeviceId: DEVICE_ID,
          discoveryRunId: SNAPSHOT_ID,
          observedAt: now,
          batchIndex: 0,
          batchCount: 1,
          interfaces: [],
          aruba: [],
          quarantine: [],
        },
      },
    },
    {
      path: "/stage",
      body: {
        commandId: COMMAND_ID,
        leaseToken: LEASE_TOKEN,
        fencingGeneration: 11,
        eventKind: "validated",
        payload: { check: "ok" },
      },
      rpc: "network_center_worker_command_event_v2",
      args: {
        p_command_id: COMMAND_ID,
        p_lease_token: LEASE_TOKEN,
        p_fencing_generation: 11,
        p_event_kind: "VALIDATED",
        p_payload: { check: "ok" },
      },
    },
    {
      path: "/observe",
      body: {
        commandId: COMMAND_ID,
        leaseToken: LEASE_TOKEN,
        fencingGeneration: 11,
        transitionVersion: 7,
        observationId: SNAPSHOT_ID,
        observationKind: "post_action",
        observedAt: now,
        evidence: { dns: { commandAck: true } },
      },
      rpc: "network_center_worker_observe_v2",
      args: {
        p_command_id: COMMAND_ID,
        p_lease_token: LEASE_TOKEN,
        p_fencing_generation: 11,
        p_transition_version: 7,
        p_observation_id: SNAPSHOT_ID,
        p_observation_kind: "POST_ACTION",
        p_observed_at: now,
        p_evidence: { dns: { commandAck: true } },
      },
    },
    {
      path: "/complete",
      body: {
        commandId: COMMAND_ID,
        leaseToken: LEASE_TOKEN,
        fencingGeneration: 11,
        transitionVersion: 7,
        outcome: "evaluate_postcondition",
        result: { actionType: "FLUSH_DNS_CACHE" },
        rollback: null,
        retryDelaySeconds: 30,
      },
      rpc: "network_center_worker_complete_v2",
      args: {
        p_command_id: COMMAND_ID,
        p_lease_token: LEASE_TOKEN,
        p_fencing_generation: 11,
        p_transition_version: 7,
        p_outcome: "EVALUATE_POSTCONDITION",
        p_result: { actionType: "FLUSH_DNS_CACHE" },
        p_rollback: null,
        p_retry_delay_seconds: 30,
      },
    },
    {
      path: "/incidents",
      body: {
        payload: {
          eventKey: "router-down-0001",
          fingerprint: "router-down-building-1",
          incidentType: "ROUTER_OFFLINE",
          severity: "critical",
          title: "Router offline",
          summary: "Router did not answer health checks",
          observedAt: now,
          observedValues: {},
          resolved: false,
          deviceId: DEVICE_ID,
        },
      },
      rpc: "network_center_worker_upsert_incident_v2",
      args: {
        p_payload: {
          eventKey: "router-down-0001",
          fingerprint: "router-down-building-1",
          incidentType: "ROUTER_OFFLINE",
          severity: "critical",
          title: "Router offline",
          summary: "Router did not answer health checks",
          observedAt: now,
          observedValues: {},
          resolved: false,
          deviceId: DEVICE_ID,
        },
      },
    },
    {
      path: "/snapshots",
      body: {
        payload: {
          snapshotId: SNAPSHOT_ID,
          deviceId: DEVICE_ID,
          source: "manual",
          normalizedContent: { identity: "demo" },
          redactedLines: ["/system identity set name=demo"],
          contentHash: "a".repeat(64),
          encryptedArtifactHash: "b".repeat(64),
        },
      },
      rpc: "network_center_worker_snapshot_v2",
      args: {
        p_payload: {
          snapshotId: SNAPSHOT_ID,
          deviceId: DEVICE_ID,
          source: "manual",
          normalizedContent: { identity: "demo" },
          redactedLines: ["/system identity set name=demo"],
          contentHash: "a".repeat(64),
          encryptedArtifactHash: "b".repeat(64),
        },
      },
    },
    {
      path: "/maintenance",
      body: { now },
      rpc: "network_center_worker_maintenance_v2",
      args: { p_now: now },
    },
  ];

  for (const route of routes) {
    const rpcData = route.path === "/claim"
      ? { items: [] }
      : { accepted: true };
    const { handler, calls } = await createHarness({
      rpcResult: { data: rpcData, error: null },
    });
    const response = await handler(post(route.path, route.body));
    assertEquals(response.status, 200, route.path);
    assertEquals(calls, [{
      name: route.rpc,
      args: { p_credential_digest: credentialDigest, ...route.args },
    }], route.path);
    assertEquals(await responseJson(response), {
      ok: true,
      data: rpcData,
    });
  }
});

Deno.test("complete rejects worker-authored SUCCEEDED before RPC", async () => {
  const { handler, calls } = await createHarness();
  const response = await handler(post("/complete", {
    commandId: COMMAND_ID,
    leaseToken: LEASE_TOKEN,
    fencingGeneration: 11,
    transitionVersion: 1,
    outcome: "SUCCEEDED",
    result: {},
    rollback: null,
    retryDelaySeconds: 30,
  }));

  assertEquals(response.status, 400);
  assertEquals(calls.length, 0);

  const advisory = await handler(post("/complete", {
    commandId: COMMAND_ID,
    leaseToken: LEASE_TOKEN,
    fencingGeneration: 11,
    transitionVersion: 1,
    outcome: "EVALUATE_POSTCONDITION",
    result: { reconciliationDecision: { outcome: "SUCCEEDED" } },
    rollback: null,
    retryDelaySeconds: 30,
  }));
  assertEquals(advisory.status, 400);
  assertEquals(calls.length, 0);
});

Deno.test("inventory accepts unlimited Aruba through repeated bounded batches", async () => {
  const { handler, calls } = await createHarness();
  const observedAt = "2026-07-29T00:00:00.000Z";
  const aruba = Array.from({ length: 256 }, (_, index) => ({
    externalKey: `aruba-${index + 1}`,
    displayName: `Aruba ${index + 1}`,
  }));
  const body = {
    payload: {
      routerDeviceId: DEVICE_ID,
      discoveryRunId: SNAPSHOT_ID,
      observedAt,
      batchIndex: 0,
      batchCount: 2,
      interfaces: [],
      aruba,
      quarantine: [],
    },
  };

  const first = await handler(post("/inventory", body));
  const second = await handler(post("/inventory", body));
  assertEquals(first.status, 200);
  assertEquals(second.status, 200);
  assertEquals(calls.length, 2);

  const tooMany = await handler(post("/inventory", {
    ...body,
    payload: {
      ...body.payload,
      aruba: [...aruba, { externalKey: "aruba-257" }],
    },
  }));
  assertEquals(tooMany.status, 400);
  assertEquals(calls.length, 2);
});

Deno.test("inventory requires coherent discovery-run metadata before RPC", async () => {
  const { handler, calls } = await createHarness();
  const base = {
    routerDeviceId: DEVICE_ID,
    discoveryRunId: SNAPSHOT_ID,
    observedAt: "2026-07-29T00:00:00.000Z",
    batchIndex: 0,
    batchCount: 1,
    interfaces: [],
    aruba: [],
    quarantine: [],
  };

  for (const payload of [
    { ...base, discoveryRunId: undefined },
    { ...base, observedAt: "not-a-date" },
    { ...base, batchIndex: 1, batchCount: 1 },
    { ...base, quarantine: Array.from({ length: 257 }, () => ({
      code: "ARUBA_STABLE_IDENTITY_INVALID",
      fingerprint: "a".repeat(64),
    })) },
  ]) {
    const response = await handler(post("/inventory", { payload }));
    assertEquals(response.status, 400);
  }
  assertEquals(calls.length, 0);
});

Deno.test("invalid stage kinds, UUIDs, timestamps, and RPC failures are sanitized", async () => {
  const { handler, calls } = await createHarness();
  const invalidStage = await handler(post("/stage", {
    commandId: COMMAND_ID,
    leaseToken: LEASE_TOKEN,
    eventKind: "run_arbitrary_cli",
    payload: {},
  }));
  const invalidUuid = await handler(post("/renew", {
    commandId: "not-a-uuid",
    leaseToken: LEASE_TOKEN,
    leaseSeconds: 90,
  }));
  const invalidTimestamp = await handler(post("/heartbeat", {
    workerVersion: "1.0.0",
    capabilities: [],
    status: "online",
    queueAgeSeconds: 0,
    safeMetadata: {},
    startedAt: "not-a-date",
  }));
  assertEquals(invalidStage.status, 400);
  assertEquals(invalidUuid.status, 400);
  assertEquals(invalidTimestamp.status, 400);
  assertEquals(calls.length, 0);

  const failed = await createHarness({
    rpcResult: {
      data: null,
      error: { code: "XX000", message: "secret internal database detail" },
    },
  });
  const failedResponse = await failed.handler(post("/claim", {
    limit: 3,
    leaseSeconds: 90,
  }));
  const failedBody = await responseJson(failedResponse);
  assertEquals(failedResponse.status, 502);
  assertEquals(failedBody.error, "worker_backend_error");
  assertEquals(JSON.stringify(failedBody).includes("secret internal"), false);
});

// ROUTES must be immune to prototype-chain lookups: `ROUTES[key]` on a plain
// frozen object literal still resolves inherited Object.prototype members
// as truthy values, which bypasses the `if (!route) return 404` guard
// entirely. NOTE: on this Deno/V8 build, `["__proto__"]` bracket access
// itself happens to evaluate to `undefined` (unlike Node, where the legacy
// accessor returns the real prototype) -- so `/__proto__` alone would 404
// even on unpatched code and prove nothing. `constructor`, `toString`,
// `valueOf`, and `hasOwnProperty` are ordinary inherited data/function
// properties (not the special __proto__ accessor) and are confirmed truthy
// via `ROUTES[key]` on every engine, including this one. We assert the
// full set together (not via sequential asserts that abort at the first
// mismatch) specifically so an accidentally-already-404 case like
// `__proto__` can never mask a real failure on the others.
Deno.test("prototype-chain route names are rejected as unknown routes, not resolved via Object.prototype", async () => {
  const { handler, calls } = await createHarness();
  const maliciousPaths = [
    "/__proto__",
    "/constructor",
    "/hasOwnProperty",
    "/toString",
    "/valueOf",
  ];
  const statuses: Record<string, number> = {};
  const bodies: Record<string, Record<string, unknown>> = {};
  for (const path of maliciousPaths) {
    const response = await handler(post(path, {}));
    statuses[path] = response.status;
    bodies[path] = await responseJson(response);
  }
  assertEquals(
    statuses,
    Object.fromEntries(maliciousPaths.map((path) => [path, 404])),
    "every prototype-chain route name must be treated as unknown",
  );
  assertEquals(
    bodies,
    Object.fromEntries(
      maliciousPaths.map((path) => [path, { error: "route_not_found" }]),
    ),
  );
  assertEquals(calls.length, 0);
});

// Route resolution must happen strictly before any body I/O. We prove this
// by sending bodies that would trip a *different* error path (415 for wrong
// content-type, 400 for invalid JSON) if the request ever reached
// readJsonBody. A 404 proves the malicious route name was rejected before
// the body was touched at all. Uses "constructor" (confirmed truthy via
// ROUTES[...] on this runtime) rather than "__proto__", which does not
// reproduce the bug on this Deno/V8 build -- see note above.
Deno.test("prototype-chain route dispatch happens before any body parsing", async () => {
  const { handler, calls } = await createHarness();

  const wrongContentType = await handler(
    new Request("http://localhost/network-center-worker/constructor", {
      method: "POST",
      headers: {
        "content-type": "text/plain",
        "x-network-worker-secret": SECRET,
      },
      body: "not json at all",
    }),
  );
  const invalidJson = await handler(
    post("/toString", {}, { raw: "{not valid json" }),
  );

  assertEquals(
    wrongContentType.status,
    404,
    "route lookup must precede content-type validation",
  );
  assertEquals(
    invalidJson.status,
    404,
    "route lookup must precede JSON parsing",
  );
  assertEquals(calls.length, 0);
});

// The per-route maxBodyBytes cap only exists to bound memory before
// authentication/parsing. If a prototype-chain key resolves to a route-like
// value, `route.maxBodyBytes` is undefined, and `size > undefined` is always
// false in JS -- so a multi-megabyte body sails through uncapped. Sending a
// body larger than the largest legitimate cap (2_200_000 bytes, /snapshots)
// to "constructor" (confirmed truthy via ROUTES[...] on this runtime, unlike
// "__proto__") and still getting 404 proves both that the route was
// rejected and that no size-based short-circuit silently accepted it as
// "unlimited".
Deno.test("prototype-chain route rejects dispatch regardless of body size, proving no cap silently became unlimited", async () => {
  const { handler, calls } = await createHarness();
  const oversizedBody = JSON.stringify({ padding: "x".repeat(3_000_000) });

  const response = await handler(
    post("/constructor", {}, { raw: oversizedBody }),
  );

  assertEquals(response.status, 404);
  assertEquals(calls.length, 0);
});

// Defense in depth: even in isolation, readJsonBody must fail closed when
// handed a byte cap that isn't a valid positive integer, instead of letting
// `declaredLength > maximumBytes` and `bytes.byteLength > maximumBytes`
// silently evaluate to false (which is what happens for undefined, NaN, and
// other non-numeric values in JS). This is what stops the routing bug class
// from silently recurring even if a future route is misconfigured.
Deno.test("readJsonBody rejects a missing or invalid byte cap instead of treating it as unlimited", async () => {
  const loaded = await loadWorkerModule();
  const readBody = loaded.readJsonBody;
  assert(
    typeof readBody === "function",
    "index.ts must export readJsonBody so its byte-cap contract is testable",
  );

  const invalidCaps: unknown[] = [
    undefined,
    null,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    -1,
    0,
    1.5,
    "8192",
  ];
  for (const cap of invalidCaps) {
    const request = new Request(
      "http://localhost/network-center-worker/heartbeat",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ok: true }),
      },
    );
    let threw = false;
    try {
      await readBody(request, cap as number);
    } catch {
      threw = true;
    }
    assert(
      threw,
      `readJsonBody must reject a byte cap of ${JSON.stringify(cap)} instead of treating it as unlimited`,
    );
  }
});
