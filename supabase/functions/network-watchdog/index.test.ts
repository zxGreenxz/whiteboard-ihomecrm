function assert(
  condition: unknown,
  message = "Assertion failed",
): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals<T>(actual: T, expected: T, message = "Values differ"): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${message}\nactual: ${actualJson}\nexpected: ${expectedJson}`);
  }
}

type RpcResult = {
  data: unknown;
  error: null | { code?: string; message?: string };
};

type RpcCall = { name: string; args: Record<string, unknown> };

type WatchdogModule = {
  createWatchdogHandler: (dependencies?: {
    getEnv?: (name: string) => string | undefined;
    rpc?: (name: string, args: Record<string, unknown>) => Promise<RpcResult>;
  }) => (request: Request) => Promise<Response>;
};

const CRON_SECRET = "network-watchdog-test-cron-secret-at-least-32-bytes";
const SERVICE_ROLE_KEY = "service-role-test-key-value-not-a-real-key";

const watchdogModule = import("./index.ts").catch(() => null);

async function loadWatchdogModule(): Promise<WatchdogModule> {
  const loaded = await watchdogModule;
  assert(loaded !== null, "network-watchdog/index.ts must exist");
  assertEquals(
    typeof loaded.createWatchdogHandler,
    "function",
    "index.ts must export createWatchdogHandler",
  );
  return loaded as WatchdogModule;
}

const HEALTHY = {
  schemaVersion: 1,
  job: "LIVENESS",
  at: "2026-08-02T00:00:00.000Z",
  skipped: false,
  skipReason: null,
  thresholdSeconds: 300,
  assessedAt: new Date().toISOString(),
  monitoredWorkers: 1,
  monitoredBuildings: 15,
  staleWorkers: 0,
  staleBuildings: 0,
  incidentsOpened: 0,
  incidentsRefreshed: 0,
  incidentsResolved: 0,
  staleWorkerDetail: [],
};

function stale(overrides: Record<string, unknown> = {}) {
  return {
    ...HEALTHY,
    staleWorkers: 1,
    staleBuildings: 2,
    incidentsOpened: 2,
    staleWorkerDetail: [
      { workerKey: "vultr-network-worker-01", lastHeartbeatAt: null, buildingCount: 2 },
    ],
    ...overrides,
  };
}

async function createHarness(options?: {
  rpcResult?: RpcResult;
  env?: Record<string, string | undefined>;
  onEnv?: (name: string) => void;
}) {
  const calls: RpcCall[] = [];
  const loaded = await loadWatchdogModule();
  const environment: Record<string, string | undefined> = {
    NETWORK_WATCHDOG_CRON_SECRET: CRON_SECRET,
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
    ...options?.env,
  };
  const handler = loaded.createWatchdogHandler({
    getEnv: (name) => {
      options?.onEnv?.(name);
      if (name === "NETWORK_WORKER_SECRET") {
        throw new Error("the watchdog must never read a worker credential");
      }
      return environment[name];
    },
    rpc: (name, args) => {
      calls.push({ name, args });
      return Promise.resolve(
        options?.rpcResult ?? { data: HEALTHY, error: null },
      );
    },
  });
  return { calls, handler };
}

function post(
  path: string,
  options?: { secret?: string | null; method?: string },
): Request {
  const headers = new Headers();
  if (options?.secret !== null) {
    headers.set("x-network-watchdog-secret", options?.secret ?? CRON_SECRET);
  }
  return new Request(`http://localhost/network-watchdog${path}`, {
    method: options?.method ?? "POST",
    headers,
  });
}

async function body(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

Deno.test("a missing cron secret fails closed and never reaches the database", async () => {
  const { handler, calls } = await createHarness({
    env: { NETWORK_WATCHDOG_CRON_SECRET: undefined },
  });
  const response = await handler(post("/liveness"));
  assertEquals(response.status, 500, "an unconfigured watchdog must not be open");
  assertEquals((await body(response)).error, "watchdog_config_error");
  assertEquals(calls.length, 0, "no RPC may run without a configured secret");
});

Deno.test("a too-short cron secret is a configuration error, not an accepted secret", async () => {
  const { handler, calls } = await createHarness({
    env: { NETWORK_WATCHDOG_CRON_SECRET: "short" },
  });
  const response = await handler(post("/liveness", { secret: "short" }));
  assertEquals(response.status, 500);
  assertEquals(calls.length, 0);
});

Deno.test("a wrong or missing secret is rejected before any RPC", async () => {
  const { handler, calls } = await createHarness();
  const missing = await handler(post("/liveness", { secret: null }));
  const wrong = await handler(
    post("/liveness", { secret: "network-watchdog-test-cron-secret-at-least-32-byteX" }),
  );
  // A prefix of the real secret must not be accepted either.
  const prefix = await handler(
    post("/liveness", { secret: CRON_SECRET.slice(0, CRON_SECRET.length - 1) }),
  );
  assertEquals(missing.status, 401);
  assertEquals(wrong.status, 401);
  assertEquals(prefix.status, 401);
  assertEquals(calls.length, 0, "authentication must precede every RPC");
});

Deno.test("missing Supabase configuration fails closed", async () => {
  const { handler, calls } = await createHarness({
    env: { SUPABASE_SERVICE_ROLE_KEY: undefined },
  });
  const response = await handler(post("/liveness"));
  assertEquals(response.status, 500);
  assertEquals((await body(response)).error, "watchdog_config_error");
  assertEquals(calls.length, 0);
});

Deno.test("non-POST methods are refused with an allow header", async () => {
  const { handler, calls } = await createHarness();
  const response = await handler(post("/liveness", { method: "GET" }));
  assertEquals(response.status, 405);
  assertEquals(response.headers.get("allow"), "POST");
  assertEquals(calls.length, 0);
});

Deno.test("only the two declared routes exist", async () => {
  const { handler, calls } = await createHarness();
  assertEquals((await handler(post("/"))).status, 404);
  assertEquals((await handler(post("/unknown"))).status, 404);
  assertEquals(calls.length, 0);
});

Deno.test("route lookup cannot resolve an Object.prototype member", async () => {
  // Deno disables the legacy __proto__ accessor, so the exploitable keys on this
  // runtime are the ordinary prototype members. A plain object literal route table
  // answers all of these truthy; a Map cannot.
  const { handler, calls } = await createHarness();
  const statuses: Record<string, number> = {};
  for (
    const key of [
      "__proto__",
      "constructor",
      "toString",
      "valueOf",
      "hasOwnProperty",
      "isPrototypeOf",
      "propertyIsEnumerable",
      "toLocaleString",
    ]
  ) {
    statuses[key] = (await handler(post(`/${key}`))).status;
  }
  for (const [key, status] of Object.entries(statuses)) {
    assertEquals(status, 404, `route ${key} must not resolve`);
  }
  assertEquals(calls.length, 0);
});

Deno.test("a healthy fleet answers 200 and calls the liveness RPC", async () => {
  const { handler, calls } = await createHarness();
  const response = await handler(post("/liveness"));
  const payload = await body(response);
  assertEquals(response.status, 200);
  assertEquals(payload.healthy, true);
  assertEquals(payload.reason, null);
  assertEquals(calls.length, 1);
  assertEquals(calls[0]?.name, "network_center_watchdog_liveness_v1");
  assertEquals(calls[0]?.args, { p_stale_after_seconds: 300 });
  assertEquals(response.headers.get("cache-control"), "no-store");
});

Deno.test("the staleness threshold is configurable and bounded", async () => {
  const configured = await createHarness({
    env: { NETWORK_WATCHDOG_STALE_AFTER_SECONDS: "120" },
  });
  await configured.handler(post("/liveness"));
  assertEquals(configured.calls[0]?.args, { p_stale_after_seconds: 120 });

  const overridden = await createHarness();
  await overridden.handler(post("/liveness?staleAfterSeconds=600"));
  assertEquals(overridden.calls[0]?.args, { p_stale_after_seconds: 600 });

  const rejected = await createHarness();
  const tooSmall = await rejected.handler(post("/liveness?staleAfterSeconds=5"));
  const notANumber = await rejected.handler(post("/liveness?staleAfterSeconds=abc"));
  assertEquals(tooSmall.status, 400);
  assertEquals(notANumber.status, 400);
  assertEquals(rejected.calls.length, 0);

  const badEnvironment = await createHarness({
    env: { NETWORK_WATCHDOG_STALE_AFTER_SECONDS: "0" },
  });
  const response = await badEnvironment.handler(post("/liveness"));
  assertEquals(response.status, 500, "an unusable configured threshold must fail closed");
  assertEquals(badEnvironment.calls.length, 0);
});

Deno.test("a stale worker answers 503 so an uptime monitor can page", async () => {
  const { handler } = await createHarness({
    rpcResult: { data: stale(), error: null },
  });
  const response = await handler(post("/liveness"));
  const payload = await body(response);
  assertEquals(response.status, 503);
  assertEquals(payload.healthy, false);
  assertEquals(payload.reason, "WORKER_HEARTBEAT_STALE");
  assertEquals((payload.report as Record<string, unknown>).staleBuildings, 2);
});

Deno.test("an RPC failure is an alert, never silence", async () => {
  const { handler } = await createHarness({
    rpcResult: { data: null, error: { code: "42501", message: "denied" } },
  });
  const response = await handler(post("/liveness"));
  const payload = await body(response);
  assertEquals(response.status, 503);
  assertEquals(payload.healthy, false);
  assertEquals(payload.reason, "LIVENESS_INDETERMINATE");
});

Deno.test("an unusable liveness payload is indeterminate, not healthy", async () => {
  for (
    const data of [
      null,
      "ok",
      [],
      {},
      { staleBuildings: 0 },
      { ...HEALTHY, staleBuildings: "0" },
      { ...HEALTHY, monitoredWorkers: null },
      { ...HEALTHY, staleBuildings: -1 },
    ]
  ) {
    const { handler } = await createHarness({ rpcResult: { data, error: null } });
    const response = await handler(post("/liveness"));
    const payload = await body(response);
    assertEquals(
      response.status,
      503,
      `payload ${JSON.stringify(data)} must not read as healthy`,
    );
    assertEquals(payload.reason, "LIVENESS_INDETERMINATE");
  }
});

Deno.test("a contended run reporting stale buildings still answers 503", async () => {
  const { handler } = await createHarness({
    rpcResult: {
      data: stale({ skipped: true, skipReason: "CONCURRENT_RUN" }),
      error: null,
    },
  });
  const response = await handler(post("/liveness"));
  assertEquals(response.status, 503);
  assertEquals((await body(response)).reason, "WORKER_HEARTBEAT_STALE");
});

Deno.test("a contended run whose last assessment is fresh and clean answers 200", async () => {
  const { handler } = await createHarness({
    rpcResult: {
      data: { ...HEALTHY, skipped: true, skipReason: "CONCURRENT_RUN" },
      error: null,
    },
  });
  const response = await handler(post("/liveness"));
  assertEquals(response.status, 200);
  assertEquals((await body(response)).healthy, true);
});

Deno.test("a stale or absent assessment timestamp is indeterminate", async () => {
  const old = new Date(Date.now() - 3_600_000).toISOString();
  for (const assessedAt of [null, undefined, "not-a-date", old]) {
    const { handler } = await createHarness({
      rpcResult: {
        data: { ...HEALTHY, skipped: true, skipReason: "CONCURRENT_RUN", assessedAt },
        error: null,
      },
    });
    const response = await handler(post("/liveness"));
    assertEquals(
      response.status,
      503,
      `assessedAt ${String(assessedAt)} must not read as healthy`,
    );
    assertEquals((await body(response)).reason, "ASSESSMENT_STALE");
  }
});

Deno.test("an under-provisioned fleet is reported when a minimum is configured", async () => {
  const unset = await createHarness({
    rpcResult: {
      data: { ...HEALTHY, monitoredWorkers: 0, monitoredBuildings: 0 },
      error: null,
    },
  });
  const beforeRollout = await unset.handler(post("/liveness"));
  assertEquals(beforeRollout.status, 200, "an empty registry is normal before rollout");

  const configured = await createHarness({
    env: { NETWORK_WATCHDOG_MIN_WORKERS: "1" },
    rpcResult: {
      data: { ...HEALTHY, monitoredWorkers: 0, monitoredBuildings: 0 },
      error: null,
    },
  });
  const afterRollout = await configured.handler(post("/liveness"));
  assertEquals(afterRollout.status, 503);
  assertEquals((await body(afterRollout)).reason, "FLEET_UNDER_PROVISIONED");
});

Deno.test("maintenance runs its own RPC and reports failure loudly", async () => {
  const ok = await createHarness({
    rpcResult: {
      data: { schemaVersion: 1, job: "MAINTENANCE", skipped: false },
      error: null,
    },
  });
  const success = await ok.handler(post("/maintenance"));
  assertEquals(success.status, 200);
  assertEquals(ok.calls[0]?.name, "network_center_watchdog_maintenance_v1");
  assertEquals(ok.calls[0]?.args, {});

  const broken = await createHarness({
    rpcResult: { data: null, error: { code: "XX000", message: "boom" } },
  });
  const failure = await broken.handler(post("/maintenance"));
  assertEquals(failure.status, 503);
  assertEquals((await body(failure)).reason, "MAINTENANCE_FAILED");
});

Deno.test("a thrown RPC transport error is an alert, not a crash", async () => {
  const loaded = await loadWatchdogModule();
  const handler = loaded.createWatchdogHandler({
    getEnv: (name) =>
      ({
        NETWORK_WATCHDOG_CRON_SECRET: CRON_SECRET,
        SUPABASE_URL: "https://example.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
      })[name],
    rpc: () => Promise.reject(new Error("network down")),
  });
  const response = await handler(post("/liveness"));
  assertEquals(response.status, 503);
  assertEquals((await body(response)).reason, "LIVENESS_INDETERMINATE");
});

Deno.test("no response ever echoes a configured secret", async () => {
  const cases: Response[] = [];
  const healthy = await createHarness();
  cases.push(await healthy.handler(post("/liveness")));
  cases.push(await healthy.handler(post("/liveness", { secret: "wrong-secret-value" })));
  const failing = await createHarness({
    rpcResult: { data: null, error: { code: "42501", message: SERVICE_ROLE_KEY } },
  });
  cases.push(await failing.handler(post("/liveness")));
  const misconfigured = await createHarness({
    env: { SUPABASE_SERVICE_ROLE_KEY: undefined },
  });
  cases.push(await misconfigured.handler(post("/liveness")));

  for (const response of cases) {
    const text = JSON.stringify(await response.json());
    assert(!text.includes(CRON_SECRET), "the cron secret leaked into a response");
    assert(!text.includes(SERVICE_ROLE_KEY), "the service role key leaked into a response");
    assertEquals(response.headers.get("cache-control"), "no-store");
  }
});

Deno.test("the watchdog never reads a worker credential from the environment", async () => {
  const read: string[] = [];
  const { handler } = await createHarness({ onEnv: (name) => read.push(name) });
  await handler(post("/liveness"));
  await handler(post("/maintenance"));
  assert(read.length > 0, "the handler read no environment at all");
  for (const name of read) {
    assert(
      !/WORKER_SECRET|CREDENTIAL/i.test(name),
      `the watchdog read ${name}`,
    );
  }
});
