import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";

import { buildMinimalChildEnvironment } from "./gen-supabase-types.mjs";

import {
  DEMO_ORG_ID,
  PROD_ORG_ID,
  assertLiveDemoTarget,
  assertSafeHarnessOutput,
  redactSensitiveText,
} from "./test-openclaw-sql.mjs";

export { DEMO_ORG_ID, PROD_ORG_ID };

const { Pool } = pg;
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const ADVISORY_LOCK_NAMESPACE = Object.freeze([0x4f43, 0x4c57]);
const ADVISORY_LOCK_WAIT_TIMEOUT_MS = 5_000;

export const CONCURRENCY_SCENARIOS = Object.freeze([
  "OUTBOX_SINGLE_CLAIM",
  "WORK_SINGLE_CLAIM",
  "EXPIRED_LEASE_RECLAIM",
  "STALE_FENCE_REJECTED",
  "PRE_HANDOFF_REQUEUE",
  "UNKNOWN_SINGLE_WINNER",
  "DUPLICATE_SCHEDULE_MATERIALIZER",
  "CRM_FANOUT_IDEMPOTENCY",
  "RETENTION_QUARANTINE_HOLD_RACE",
  "RETENTION_FINAL_DELETE_HOLD_RACE",
  "RETENTION_QUARANTINE_R2_INDEPENDENT",
  "RETENTION_FINAL_DELETE_GRACE_BARRIER",
  "RETENTION_DUPLICATE_PHASE_MATERIALIZER",
  "FORGED_DELETE_RECEIPT",
  "AUTHENTICATED_NOT_FOUND_RECEIPT",
  "LOST_GATEWAY_RESPONSE_REPLAY",
  "LOST_DB_FINALIZATION",
  "FORGED_AUDIT_RECEIPT",
  "LOST_AUDIT_ACKNOWLEDGEMENT",
]);

export const BEHAVIOR_PROVEN_SCENARIOS = Object.freeze([
  "OUTBOX_SINGLE_CLAIM",
  "WORK_SINGLE_CLAIM",
  "EXPIRED_LEASE_RECLAIM",
  "STALE_FENCE_REJECTED",
  "PRE_HANDOFF_REQUEUE",
  "UNKNOWN_SINGLE_WINNER",
  "DUPLICATE_SCHEDULE_MATERIALIZER",
  "CRM_FANOUT_IDEMPOTENCY",
  "RETENTION_QUARANTINE_HOLD_RACE",
  "RETENTION_FINAL_DELETE_HOLD_RACE",
  "RETENTION_QUARANTINE_R2_INDEPENDENT",
  "RETENTION_FINAL_DELETE_GRACE_BARRIER",
  "RETENTION_DUPLICATE_PHASE_MATERIALIZER",
  "FORGED_DELETE_RECEIPT",
  "AUTHENTICATED_NOT_FOUND_RECEIPT",
  "LOST_GATEWAY_RESPONSE_REPLAY",
  "LOST_DB_FINALIZATION",
  "FORGED_AUDIT_RECEIPT",
  "LOST_AUDIT_ACKNOWLEDGEMENT",
]);

export function buildNativePostgresPoolConfig({ port, maxConnections }) {
  return {
    connectionString:
      `postgresql://postgres@127.0.0.1:${port}/postgres?sslmode=disable`,
    options:
      "-c request.jwt.claim.sub=99999999-9999-4999-8999-999999999999",
    max: maxConnections,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 5_000,
  };
}

export function parseConcurrencyHarnessArgs(args) {
  const modes = [
    args.includes("--local") && "local",
    args.includes("--live-demo") && "live-demo",
  ].filter(Boolean);
  if (modes.length === 0) {
    throw new Error("An explicit --local or --live-demo mode is required.");
  }
  if (modes.length !== 1) {
    throw new Error("Exactly one concurrency harness mode may be selected.");
  }
  const workerIndex = args.indexOf("--workers");
  const workers = workerIndex === -1 ? 8 : Number(args[workerIndex + 1]);
  if (!Number.isInteger(workers) || workers < 1 || workers > 30) {
    throw new Error("Concurrency workers must be between 1 and 30.");
  }
  const consumed = new Set([
    "--local",
    "--live-demo",
    ...(workerIndex === -1 ? [] : ["--workers", args[workerIndex + 1]]),
  ]);
  const unknown = args.filter((value) => !consumed.has(value));
  if (unknown.length > 0) {
    throw new Error(`Unknown concurrency harness argument: ${unknown[0]}`);
  }
  return { mode: modes[0], workers };
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function waitForAdvisoryLockWaiters(coordinator, contenderPids) {
  const deadline = Date.now() + ADVISORY_LOCK_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const waiters = await coordinator.query(
      `select pid
       from pg_stat_activity
       where pid = any($1::integer[])
         and wait_event_type = 'Lock'
         and wait_event = 'advisory'`,
      [contenderPids],
    );
    const waitingPids = new Set(waiters.rows.map((row) => Number(row.pid)));
    if (contenderPids.every((pid) => waitingPids.has(pid))) return;
    await delay(10);
  }
  throw new Error(
    `Timed out waiting for ${contenderPids.length} advisory-lock contenders.`,
  );
}

async function runWithAdvisoryLockBarrier(
  pool,
  operations,
  transport,
  { settled = false } = {},
) {
  if (!Array.isArray(operations) || operations.length < 2) {
    throw new Error("Concurrent database execution requires at least two operations.");
  }
  if (operations.some((operation) => typeof operation !== "function")) {
    throw new Error("Concurrent database operations must be functions.");
  }
  if (operations.length + 1 > pool.options.max) {
    throw new Error(
      `Concurrent database execution needs ${operations.length + 1} dedicated connections, ` +
        `but the pool is capped at ${pool.options.max}.`,
    );
  }

  const coordinator = await pool.connect();
  const contenders = [];
  const contenderTransactions = [];
  let coordinatorTransaction = false;
  let lockRequests = [];
  let result;
  let executionError;

  try {
    for (let index = 0; index < operations.length; index += 1) {
      contenders.push(await pool.connect());
      contenderTransactions.push(false);
    }

    await coordinator.query("begin");
    coordinatorTransaction = true;
    await coordinator.query(
      "select pg_advisory_xact_lock($1::integer,$2::integer)",
      ADVISORY_LOCK_NAMESPACE,
    );
    const coordinatorPid = Number(
      (await coordinator.query("select pg_backend_pid() pid")).rows[0].pid,
    );

    const contenderPids = [];
    for (let index = 0; index < contenders.length; index += 1) {
      await contenders[index].query("begin");
      contenderTransactions[index] = true;
      contenderPids.push(
        Number(
          (await contenders[index].query("select pg_backend_pid() pid")).rows[0]
            .pid,
        ),
      );
    }
    const backendPids = [coordinatorPid, ...contenderPids];
    if (new Set(backendPids).size !== backendPids.length) {
      throw new Error("Advisory-lock barrier did not use distinct PostgreSQL backends.");
    }

    lockRequests = contenders.map((client) =>
      client.query(
        "select pg_advisory_xact_lock_shared($1::integer,$2::integer)",
        ADVISORY_LOCK_NAMESPACE,
      ),
    );
    await waitForAdvisoryLockWaiters(coordinator, contenderPids);
    transport.distinctBackendPids = true;
    transport.barrierPasses += 1;

    await coordinator.query("commit");
    coordinatorTransaction = false;
    await Promise.all(lockRequests);

    const operationResults = await Promise.allSettled(
      operations.map(async (operation, index) => {
        try {
          const value = await operation(contenders[index]);
          await contenders[index].query("commit");
          contenderTransactions[index] = false;
          return value;
        } catch (error) {
          try {
            await contenders[index].query("rollback");
            contenderTransactions[index] = false;
          } catch (rollbackError) {
            throw new AggregateError(
              [error, rollbackError],
              "Concurrent operation failed and its transaction could not roll back.",
            );
          }
          throw error;
        }
      }),
    );
    if (settled) {
      result = operationResults;
    } else {
      const failure = operationResults.find((operation) => operation.status === "rejected");
      if (failure) throw failure.reason;
      result = operationResults.map((operation) => operation.value);
    }
  } catch (error) {
    executionError = error;
  }

  const cleanupErrors = [];
  if (coordinatorTransaction) {
    try {
      await coordinator.query("rollback");
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (lockRequests.length > 0) {
    const lockResults = await Promise.allSettled(lockRequests);
    cleanupErrors.push(
      ...lockResults
        .filter((lockResult) => lockResult.status === "rejected")
        .map((lockResult) => lockResult.reason),
    );
  }
  for (let index = 0; index < contenders.length; index += 1) {
    if (contenderTransactions[index]) {
      try {
        await contenders[index].query("rollback");
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    contenders[index].release();
  }
  coordinator.release();

  if (executionError && cleanupErrors.length > 0) {
    throw new AggregateError(
      [executionError, ...cleanupErrors],
      "Concurrent database execution and cleanup both failed.",
    );
  }
  if (executionError) throw executionError;
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "Concurrent database cleanup failed.");
  }
  return result;
}

function capture(command, args, environment = process.env) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      env: buildMinimalChildEnvironment(environment),
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", rejectPromise);
    child.once("close", (code) => resolvePromise({
      code: code ?? 1,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
  });
}

function runQuiet(command, args, environment = process.env) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      env: buildMinimalChildEnvironment(environment),
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    });
    child.once("error", rejectPromise);
    child.once("close", (code) => resolvePromise(code ?? 1));
  });
}

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function findPostgresBin(environment = process.env) {
  const executable = process.platform === "win32" ? "initdb.exe" : "initdb";
  const explicit = environment.OPENCLAW_POSTGRES_BIN;
  const candidates = [
    explicit,
    ...(process.platform === "win32"
      ? [17, 16, 15, 14].map(
          (version) => `C:\\Program Files\\PostgreSQL\\${version}\\bin`,
        )
      : ["/usr/lib/postgresql/17/bin", "/usr/lib/postgresql/16/bin", "/usr/local/bin", "/usr/bin"]),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (await fileExists(join(candidate, executable))) return candidate;
  }
  const lookup = await capture(
    process.platform === "win32" ? "where.exe" : "which",
    [executable],
    environment,
  ).catch(() => ({ code: 1, stdout: "" }));
  const located = lookup.code === 0 ? lookup.stdout.split(/\r?\n/)[0].trim() : "";
  if (located && await fileExists(located)) return dirname(located);
  throw new Error(
    "Native PostgreSQL initdb/pg_ctl is required for independent concurrency sessions.",
  );
}

async function reserveTcpPort() {
  const server = createServer();
  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolvePromise) => server.close(resolvePromise));
  if (!port) throw new Error("Could not reserve a native PostgreSQL port.");
  return port;
}

async function startDisposableNativePostgres(environment = process.env) {
  const bin = await findPostgresBin(environment);
  const root = await mkdtemp(join(tmpdir(), "openclaw-pg-"));
  const data = join(root, "data");
  const log = join(root, "postgres.log");
  const port = await reserveTcpPort();
  const initdb = join(bin, process.platform === "win32" ? "initdb.exe" : "initdb");
  const pgCtl = join(bin, process.platform === "win32" ? "pg_ctl.exe" : "pg_ctl");
  const childEnvironment = buildMinimalChildEnvironment(environment, { PGTZ: "UTC" });
  let started = false;
  try {
    const initialized = await capture(
      initdb,
      [
        "-D", data,
        "--auth=trust",
        "--username=postgres",
        "--encoding=UTF8",
        "--no-locale",
        "--no-sync",
      ],
      childEnvironment,
    );
    if (initialized.code !== 0) {
      throw new Error(`initdb failed: ${initialized.stderr.slice(0, 1_000)}`);
    }
    const launched = await runQuiet(
      pgCtl,
      [
        "-D", data,
        "-l", log,
        "-o", `-F -p ${port} -h 127.0.0.1`,
        "-w", "start",
      ],
      childEnvironment,
    );
    if (launched !== 0) {
      const details = await readFile(log, "utf8").catch(() => "");
      throw new Error(`pg_ctl start failed: ${details.slice(-1_000)}`);
    }
    started = true;
    return {
      port,
      async stop() {
        if (started) {
          await runQuiet(pgCtl, ["-D", data, "-m", "fast", "-w", "stop"], childEnvironment)
            .catch(() => {});
          started = false;
        }
        const resolvedRoot = resolve(root);
        const resolvedTemp = resolve(tmpdir());
        if (
          !resolvedRoot.startsWith(`${resolvedTemp}${process.platform === "win32" ? "\\" : "/"}`) ||
          !resolvedRoot.split(/[\\/]/).at(-1).startsWith("openclaw-pg-")
        ) {
          throw new Error("Refusing to remove an unexpected PostgreSQL temp path.");
        }
        await rm(resolvedRoot, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (started) {
      await runQuiet(pgCtl, ["-D", data, "-m", "immediate", "-w", "stop"], childEnvironment)
        .catch(() => {});
    }
    const resolvedRoot = resolve(root);
    if (resolvedRoot.split(/[\\/]/).at(-1).startsWith("openclaw-pg-")) {
      await rm(resolvedRoot, { recursive: true, force: true }).catch(() => {});
    }
    throw error;
  }
}

async function createDefaultLocalRuntime(shared, workers) {
  const {
    OPENCLAW_DISPOSABLE_FIXTURE_SQL,
    OPENCLAW_MIGRATIONS,
    prepareDisposableConcurrencyFixtures,
  } = await import("./test-openclaw-migrations.mjs");
  const postgres = await startDisposableNativePostgres();
  const maxConnections = Math.max(3, workers);
  let pool;
  try {
    pool = new Pool(buildNativePostgresPoolConfig({
      port: postgres.port,
      maxConnections,
    }));
    const setup = await pool.connect();
    try {
      await setup.query(OPENCLAW_DISPOSABLE_FIXTURE_SQL);
      for (const migration of OPENCLAW_MIGRATIONS) {
        const sql = await readFile(
          join(repositoryRoot, "supabase", "migrations", migration),
          "utf8",
        );
        await setup.query(sql);
      }
    } finally {
      setup.release();
    }
    const transport = {
      kind: "native-postgres",
      maxConnections,
      independentSessions: true,
      contentionBarrier: "advisory-lock",
      distinctBackendPids: false,
      barrierPasses: 0,
    };
    const sql = {
      query: (text, values) => pool.query(text, values),
      exec: (text) => pool.query(text),
      runConcurrent: (operations, options) =>
        runWithAdvisoryLockBarrier(pool, operations, transport, options),
    };
    await prepareDisposableConcurrencyFixtures(sql);
    const [left, right] = await Promise.all([pool.connect(), pool.connect()]);
    try {
      await left.query("select set_config('openclaw.session_probe','left',false)");
      await right.query("select set_config('openclaw.session_probe','right',false)");
      const [leftValue, rightValue] = await Promise.all([
        left.query("select current_setting('openclaw.session_probe') value"),
        right.query("select current_setting('openclaw.session_probe') value"),
      ]);
      if (
        leftValue.rows[0].value !== "left" ||
        rightValue.rows[0].value !== "right"
      ) {
        throw new Error("Native PostgreSQL sessions are not independently scoped.");
      }
    } finally {
      left.release();
      right.release();
    }
    Object.assign(shared, {
      postgres,
      pool,
      sql,
      transport,
    });
    return shared;
  } catch (error) {
    if (pool) await pool.end().catch(() => {});
    await postgres.stop().catch(() => {});
    throw error;
  }
}

async function defaultExecuteScenario({ mode, workers, scenario, shared }) {
  if (mode === "live-demo") {
    throw new Error(
      "Live DEMO concurrency transport is disabled until Task 29 supplies reviewed credentials.",
    );
  }
  if (!shared.runtimePromise) {
    shared.runtimePromise = createDefaultLocalRuntime(shared, workers);
  }
  await shared.runtimePromise;
  const { runDisposableConcurrencyScenario } = await import(
    "./test-openclaw-migrations.mjs"
  );
  try {
    return await runDisposableConcurrencyScenario(shared.sql, scenario);
  } catch (error) {
    throw new Error(`${scenario}: ${String(error?.message ?? error)}`);
  }
}

export async function defaultCleanup({ shared = {} } = {}) {
  const failures = [];
  for (const cleanup of [
    shared.pool && (() => shared.pool.end()),
    shared.postgres && (() => shared.postgres.stop()),
  ].filter(Boolean)) {
    try {
      await cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `OpenClaw cleanup failed: ${failures
        .map((error) => String(error?.message ?? error))
        .join("; ")}`,
    );
  }
}

export async function runConcurrencyHarness({
  args = process.argv.slice(2),
  environment = process.env,
  organizationId,
  executeScenario = defaultExecuteScenario,
  cleanup = defaultCleanup,
} = {}) {
  const { mode, workers } = parseConcurrencyHarnessArgs(args);
  const fixtureOrganizationId =
    organizationId ??
    (mode === "local" ? DEMO_ORG_ID : environment.OPENCLAW_DEMO_ORG_ID);
  if (fixtureOrganizationId === PROD_ORG_ID) {
    throw new Error("PROD organization fixtures are forbidden.");
  }
  if (fixtureOrganizationId !== DEMO_ORG_ID) {
    throw new Error("Only the canonical DEMO organization is allowed.");
  }
  if (mode === "live-demo") {
    assertLiveDemoTarget({
      projectRef: environment.OPENCLAW_PROJECT_REF,
      organizationId: fixtureOrganizationId,
      authorized: environment.OPENCLAW_AUTHORIZED_LIVE_DEMO === "1",
    });
  }

  const shared = {};
  const completed = [];
  try {
    for (const scenario of CONCURRENCY_SCENARIOS) {
      if (environment.OPENCLAW_CONCURRENCY_DEBUG === "1") {
        process.stderr.write(`Concurrency start: ${scenario}\n`);
      }
      await executeScenario({
        mode,
        organizationId: fixtureOrganizationId,
        workers,
        scenario,
        shared,
      });
      completed.push(scenario);
      if (environment.OPENCLAW_CONCURRENCY_DEBUG === "1") {
        process.stderr.write(`Concurrency pass: ${scenario}\n`);
      }
    }
  } finally {
    await cleanup({
      mode,
      organizationId: fixtureOrganizationId,
      shared,
    });
  }
  const summary = assertSafeHarnessOutput(
    `PASS OpenClaw concurrency ${mode}: ${completed.length}/${CONCURRENCY_SCENARIOS.length}`,
  );
  return { mode, workers, completed, summary, transport: shared.transport };
}

async function main() {
  const result = await runConcurrencyHarness();
  process.stdout.write(`${result.summary}\n`);
}

const entryPoint = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : "";
if (entryPoint === import.meta.url) {
  main().catch((error) => {
    const message = redactSensitiveText(error?.message ?? error);
    console.error(message);
    process.exitCode = 1;
  });
}
