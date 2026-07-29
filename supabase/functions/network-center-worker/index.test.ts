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
      body: { limit: 5, leaseSeconds: 90 },
      rpc: "network_center_worker_claim_v2",
      args: { p_limit: 5, p_lease_seconds: 90 },
    },
    {
      path: "/renew",
      body: {
        commandId: COMMAND_ID,
        leaseToken: LEASE_TOKEN,
        leaseSeconds: 90,
      },
      rpc: "network_center_worker_renew_v2",
      args: {
        p_command_id: COMMAND_ID,
        p_lease_token: LEASE_TOKEN,
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
        eventKind: "validated",
        payload: { check: "ok" },
      },
      rpc: "network_center_worker_command_event_v2",
      args: {
        p_command_id: COMMAND_ID,
        p_lease_token: LEASE_TOKEN,
        p_event_kind: "VALIDATED",
        p_payload: { check: "ok" },
      },
    },
    {
      path: "/complete",
      body: {
        commandId: COMMAND_ID,
        leaseToken: LEASE_TOKEN,
        outcome: "succeeded",
        result: { reachable: true },
        rollback: null,
        retryDelaySeconds: 30,
      },
      rpc: "network_center_worker_complete_v2",
      args: {
        p_command_id: COMMAND_ID,
        p_lease_token: LEASE_TOKEN,
        p_outcome: "SUCCEEDED",
        p_result: { reachable: true },
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
    const { handler, calls } = await createHarness();
    const response = await handler(post(route.path, route.body));
    assertEquals(response.status, 200, route.path);
    assertEquals(calls, [{
      name: route.rpc,
      args: { p_credential_digest: credentialDigest, ...route.args },
    }], route.path);
    assertEquals(await responseJson(response), {
      ok: true,
      data: { accepted: true },
    });
  }
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
    limit: 5,
    leaseSeconds: 90,
  }));
  const failedBody = await responseJson(failedResponse);
  assertEquals(failedResponse.status, 502);
  assertEquals(failedBody.error, "worker_backend_error");
  assertEquals(JSON.stringify(failedBody).includes("secret internal"), false);
});
