#!/usr/bin/env node
// OpenClaw Zalo - recovery adapter.
//
// restore-drill.sh delegates every state-changing recovery step to this binary.
// Until now it existed only in a runbook sentence, which meant the drill proved
// nothing: a missing adapter would have been an exec failure, and a stubbed one
// would have produced a PASS evidence file describing work nobody did.
//
// Two rules hold everywhere in this file:
//   1. FAIL CLOSED. A step that cannot reach the infrastructure it is supposed to
//      exercise exits non-zero. It never degrades to a no-op, and it never prints
//      a success line it did not earn.
//   2. NO SECRETS OUT. Object ids, credentials, tokens, and session material never
//      reach stdout, stderr, or the evidence JSON. Only counts, durations, and
//      opaque digests do.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const DEMO_ORGANIZATION = "dddd0000-0000-4000-8000-000000000001";

/**
 * Every subcommand declares its exact flags. An unknown subcommand, an unknown
 * flag, a missing required flag, or a repeated flag is a usage error (exit 64),
 * never a silently ignored argument.
 */
const COMMANDS = {
  "supabase-restore-test": {
    required: ["backup-observed-at", "restore-started-at", "restore-completed-at"],
  },
  "supabase-verify-canonical": {
    required: ["maximum-rpo-seconds", "maximum-rto-seconds"],
  },
  "r2-delete-simulate": { required: ["object-id", "grace-seconds"] },
  "r2-restore-within-grace": { required: ["object-id", "grace-seconds"] },
  "r2-verify-restored": { required: ["object-id"] },
  "session-reencrypt-atomic": { required: ["operation"], flags: ["require-fsync-rename"] },
  "session-require-fresh-qr-login": { required: [], flags: ["invalidate-old-session"] },
  "prove-no-plaintext-session-snapshot": { required: ["runtime-root"] },
};

/** Present on every call: restore-drill.sh appends them to each invocation. */
const GLOBAL_REQUIRED = ["organization", "cell"];

class UsageError extends Error {}
class FailClosed extends Error {}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  if (!command || !Object.hasOwn(COMMANDS, command)) {
    throw new UsageError(`unknown recovery subcommand: ${command ?? "(none)"}`);
  }
  const spec = COMMANDS[command];
  const values = new Map();
  const booleans = new Set();
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) throw new UsageError(`unexpected positional argument`);
    const name = token.slice(2);
    if (values.has(name) || booleans.has(name)) throw new UsageError(`repeated flag --${name}`);
    if ((spec.flags ?? []).includes(name)) {
      booleans.add(name);
      continue;
    }
    const allowed = [...spec.required, ...GLOBAL_REQUIRED];
    if (!allowed.includes(name)) throw new UsageError(`unknown flag --${name}`);
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new UsageError(`flag --${name} requires a value`);
    }
    values.set(name, value);
    index += 1;
  }
  for (const name of [...spec.required, ...GLOBAL_REQUIRED]) {
    if (!values.has(name)) throw new UsageError(`missing required flag --${name}`);
  }
  return { command, values, booleans };
}

function requireUuid(values, name) {
  const value = values.get(name);
  if (!UUID.test(value)) throw new UsageError(`--${name} must be a v4 UUID`);
  return value;
}

function requireTimestamp(values, name) {
  const value = values.get(name);
  if (!RFC3339.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new UsageError(`--${name} must be an RFC3339 timestamp`);
  }
  return Date.parse(value);
}

function requireInteger(values, name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = values.get(name);
  if (!/^\d+$/.test(raw)) throw new UsageError(`--${name} must be a non-negative integer`);
  const value = Number(raw);
  if (value < min || value > max) throw new UsageError(`--${name} is out of range`);
  return value;
}

/** Digest of a value we must correlate across steps but must never print. */
function opaque(value) {
  return createHash("sha256")
    .update("ihome-openclaw-recovery-opaque-v1")
    .update(String.fromCharCode(0))
    .update(value)
    .digest("hex")
    .slice(0, 16);
}

function environment(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new FailClosed(
      `${name} is required for this step; refusing to report a recovery result that was never exercised`,
    );
  }
  return value.trim();
}

/**
 * A restore is a database operation, not a PostgREST call: pg_restore needs a
 * connection string, and asking the canonical database how fresh it is needs a
 * query. Inventing RPC facades for these would have put a fake restore behind a
 * real-looking name. Credentials arrive through PGPASSFILE-style env only and are
 * never placed on a command line, where /proc/<pid>/cmdline would expose them.
 */
/**
 * Splits a postgres URI into the discrete libpq variables.
 *
 * Passing the whole URI as `PGDATABASE` does NOT work: libpq only URI-expands
 * `dbname` when it arrives through `PQconnectdbParams(expand_dbname=true)`, while
 * environment defaults are taken literally. The first version therefore asked for
 * a database literally named "postgresql://…" on the local default host, and every
 * step that used it failed with a misleading "query failed".
 *
 * Discrete variables also keep the password out of argv, unlike putting the URI on
 * the command line where /proc/<pid>/cmdline exposes it.
 */
export function connectionEnvironment(uri) {
  let parsed;
  try {
    parsed = new URL(uri);
  } catch {
    throw new FailClosed("connection URI is malformed");
  }
  if (!/^postgres(ql)?:$/u.test(parsed.protocol)) {
    throw new FailClosed("connection URI must use the postgres scheme");
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//u, ""));
  if (!database) throw new FailClosed("connection URI carries no database name");
  const variables = { PGDATABASE: database };
  if (parsed.hostname) variables.PGHOST = parsed.hostname;
  if (parsed.port) variables.PGPORT = parsed.port;
  if (parsed.username) variables.PGUSER = decodeURIComponent(parsed.username);
  if (parsed.password) variables.PGPASSWORD = decodeURIComponent(parsed.password);
  const sslmode = parsed.searchParams.get("sslmode");
  if (sslmode) variables.PGSSLMODE = sslmode;
  return variables;
}

function psqlScalar(connectionEnv, sql) {
  const connection = environment(connectionEnv);
  let output;
  try {
    output = execFileSync(
      "psql",
      ["--no-psqlrc", "--tuples-only", "--no-align", "--quiet", "--command", sql],
      {
        encoding: "utf8",
        timeout: 120_000,
        env: { ...process.env, ...connectionEnvironment(connection) },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch (error) {
    throw new FailClosed(`canonical query failed with status ${error.status ?? "unknown"}`);
  }
  return output.trim();
}

async function supabaseRpc(operation, body) {
  const url = environment("OPENCLAW_RECOVERY_SUPABASE_URL");
  const key = environment("OPENCLAW_RECOVERY_SUPABASE_SERVICE_KEY");
  const endpoint = new URL(url);
  if (endpoint.protocol !== "https:") throw new FailClosed("recovery Supabase URL must be https");
  const response = await fetch(`${endpoint.origin}/rest/v1/rpc/${operation}`, {
    method: "POST",
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    // The status is safe to print; the body may echo request material, so it is not.
    throw new FailClosed(`${operation} failed with status ${response.status}`);
  }
  return await response.json();
}

async function r2Object(method, objectId, extra = {}) {
  const endpoint = new URL(environment("OPENCLAW_RECOVERY_R2_ENDPOINT"));
  const token = environment("OPENCLAW_RECOVERY_R2_TOKEN");
  if (endpoint.protocol !== "https:") throw new FailClosed("recovery R2 endpoint must be https");
  const response = await fetch(`${endpoint.origin}${endpoint.pathname.replace(/\/$/u, "")}/${objectId}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(method === "GET" || method === "HEAD" ? {} : { body: JSON.stringify(extra) }),
  });
  return response;
}

const PLAINTEXT_SESSION_NAMES = [
  "credentials.json",
  "cookies.json",
  "session.json",
  "localStorage.json",
];
const PLAINTEXT_SESSION_SUFFIXES = [".cookie", ".session-plaintext", ".session.json"];

/**
 * Walks the runtime root without following symlinks or crossing into another
 * device, mirroring the `find -xdev` guard restore-drill.sh applies afterwards.
 */
function findPlaintextSessionArtifacts(root) {
  const rootDevice = statSync(root).dev;
  const found = [];
  const stack = [root];
  let scanned = 0;
  while (stack.length > 0) {
    const directory = stack.pop();
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        let info;
        try {
          info = statSync(path);
        } catch {
          continue;
        }
        if (info.dev !== rootDevice) continue;
        stack.push(path);
        continue;
      }
      if (!entry.isFile()) continue;
      scanned += 1;
      const name = entry.name.toLowerCase();
      if (
        PLAINTEXT_SESSION_NAMES.includes(name) ||
        PLAINTEXT_SESSION_SUFFIXES.some((suffix) => name.endsWith(suffix))
      ) {
        // The PATH is the finding; its CONTENT is never read or reported.
        found.push(opaque(path));
      }
    }
  }
  return { scanned, found };
}

function emit(record) {
  process.stdout.write(`${JSON.stringify({ version: 1, ...record })}\n`);
}

async function run({ command, values, booleans }) {
  const organization = requireUuid(values, "organization");
  const cell = requireUuid(values, "cell");
  if (organization !== DEMO_ORGANIZATION) {
    throw new FailClosed("recovery drills may only mutate the DEMO organization");
  }
  const scope = { organizationId: organization, cellId: cell, step: command };

  switch (command) {
    case "supabase-restore-test": {
      const backupAt = requireTimestamp(values, "backup-observed-at");
      const startedAt = requireTimestamp(values, "restore-started-at");
      const completedAt = requireTimestamp(values, "restore-completed-at");
      if (completedAt < startedAt) throw new UsageError("restore interval is inverted");
      const backupFile = environment("OPENCLAW_RECOVERY_BACKUP_FILE");
      if (!backupFile.startsWith("/")) {
        throw new FailClosed("OPENCLAW_RECOVERY_BACKUP_FILE must be an absolute path");
      }
      let backupInfo;
      try {
        backupInfo = statSync(backupFile);
      } catch {
        throw new FailClosed("backup artifact is not readable");
      }
      if (!backupInfo.isFile() || backupInfo.size === 0) {
        throw new FailClosed("backup artifact is empty or not a regular file");
      }

      const startedWall = Date.now();
      // A REAL restore into a disposable target. restore-drill.sh brackets this call
      // with its own clock to measure the true RTO, so nothing here may shortcut.
      const restoreTarget = environment("OPENCLAW_RECOVERY_RESTORE_URL");
      const restoreVariables = connectionEnvironment(restoreTarget);
      try {
        execFileSync(
          "pg_restore",
          [
            // WITHOUT --dbname, pg_restore writes the SQL script to stdout and exits
            // 0 - it restores nothing. The first version omitted it and still
            // reported `restored: true`. The database NAME is safe in argv; the
            // password travels in the environment.
            "--dbname", restoreVariables.PGDATABASE,
            "--no-owner", "--no-privileges", "--clean", "--if-exists", "--exit-on-error",
          ],
          {
            encoding: "utf8",
            // Four hours is the RTO gate; a restore that outruns it must fail here
            // rather than let the drill report a passing time.
            timeout: 4 * 60 * 60 * 1000,
            env: { ...process.env, ...restoreVariables },
            input: readFileSync(backupFile),
            stdio: ["pipe", "pipe", "pipe"],
          },
        );
      } catch (error) {
        throw new FailClosed(`restore failed with status ${error.status ?? "unknown"}`);
      }

      // Prove the restore produced the schema this product needs, not just that
      // pg_restore exited zero.
      const restoredTables = Number(psqlScalar(
        "OPENCLAW_RECOVERY_RESTORE_URL",
        "select count(*) from pg_tables where schemaname='public' and tablename like 'openclaw_%'",
      ));
      if (!Number.isFinite(restoredTables) || restoredTables < 1) {
        throw new FailClosed("restored target contains no OpenClaw tables");
      }
      emit({
        ...scope,
        restored: true,
        restoredTables,
        declaredWindowSeconds: Math.floor((completedAt - startedAt) / 1000),
        elapsedSeconds: Math.floor((Date.now() - startedWall) / 1000),
      });
      return;
    }

    case "supabase-verify-canonical": {
      const maximumRpo = requireInteger(values, "maximum-rpo-seconds", { min: 1, max: 86_400 });
      const maximumRto = requireInteger(values, "maximum-rto-seconds", { min: 1, max: 86_400 });
      // Freshness is MEASURED against the canonical store, never taken from a
      // caller-declared timestamp: that substitution is the exact defect the
      // restore drill was rewritten to remove.
      const observedRpo = Number(psqlScalar(
        "OPENCLAW_RECOVERY_CANONICAL_URL",
        "select coalesce(ceil(extract(epoch from (now() - max(observed_at)))), -1)" +
          " from public.openclaw_health_events",
      ));
      if (!Number.isFinite(observedRpo) || observedRpo < 0) {
        throw new FailClosed("canonical store reported no measurable freshness");
      }
      if (observedRpo > maximumRpo) {
        throw new FailClosed(`canonical RPO ${observedRpo}s exceeds the ${maximumRpo}s gate`);
      }
      // The restored copy must actually contain the canonical row count, otherwise
      // "restored" meant an empty schema.
      const canonicalRows = Number(psqlScalar(
        "OPENCLAW_RECOVERY_CANONICAL_URL",
        "select count(*) from public.openclaw_outbox",
      ));
      const restoredRows = Number(psqlScalar(
        "OPENCLAW_RECOVERY_RESTORE_URL",
        "select count(*) from public.openclaw_outbox",
      ));
      if (!Number.isFinite(canonicalRows) || !Number.isFinite(restoredRows)) {
        throw new FailClosed("row comparison between canonical and restored failed");
      }
      // The restore snapshot predates "now", so it may hold fewer rows - never more.
      if (restoredRows > canonicalRows) {
        throw new FailClosed("restored copy holds more rows than the canonical store");
      }
      if (maximumRto < 1) throw new UsageError("--maximum-rto-seconds must be positive");
      emit({
        ...scope,
        canonicalIntact: true,
        observedRpoSeconds: observedRpo,
        canonicalRows,
        restoredRows,
      });
      return;
    }

    case "r2-delete-simulate": {
      const objectId = requireUuid(values, "object-id");
      const grace = requireInteger(values, "grace-seconds", { min: 1, max: 2_592_000 });
      const response = await r2Object("DELETE", objectId, { graceSeconds: grace, simulate: true });
      if (!response.ok) throw new FailClosed(`R2 delete simulation failed with status ${response.status}`);
      const body = await response.json().catch(() => null);
      if (body?.tombstoned !== true) throw new FailClosed("R2 delete did not create a tombstone");
      emit({ ...scope, tombstoned: true, graceSeconds: grace, objectDigest: opaque(objectId) });
      return;
    }

    case "r2-restore-within-grace": {
      const objectId = requireUuid(values, "object-id");
      const grace = requireInteger(values, "grace-seconds", { min: 1, max: 2_592_000 });
      const response = await r2Object("POST", objectId, { graceSeconds: grace, action: "restore" });
      if (!response.ok) throw new FailClosed(`R2 restore failed with status ${response.status}`);
      const body = await response.json().catch(() => null);
      if (body?.restored !== true) throw new FailClosed("R2 restore did not complete");
      const remaining = Number(body?.graceRemainingSeconds);
      if (!Number.isFinite(remaining) || remaining <= 0) {
        throw new FailClosed("R2 restore happened outside the tombstone grace window");
      }
      emit({ ...scope, restored: true, graceRemainingSeconds: remaining });
      return;
    }

    case "r2-verify-restored": {
      const objectId = requireUuid(values, "object-id");
      const response = await r2Object("HEAD", objectId);
      if (!response.ok) throw new FailClosed(`R2 object is not readable: status ${response.status}`);
      const length = Number(response.headers.get("content-length"));
      if (!Number.isFinite(length) || length <= 0) {
        throw new FailClosed("restored R2 object is empty");
      }
      emit({ ...scope, verified: true, objectDigest: opaque(objectId) });
      return;
    }

    case "session-reencrypt-atomic": {
      if (values.get("operation") !== "rotate") throw new UsageError("--operation must be rotate");
      if (!booleans.has("require-fsync-rename")) {
        throw new UsageError("--require-fsync-rename is mandatory for session re-encryption");
      }
      // Delegates to the committed session-crypto daemon rather than reimplementing
      // authenticated decrypt/re-encrypt here: one implementation, one review.
      const binary = environment("OPENCLAW_RECOVERY_SESSION_CRYPTO_BIN");
      let output;
      try {
        output = execFileSync(binary, ["rotate", "--require-fsync-rename"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 300_000,
        });
      } catch (error) {
        throw new FailClosed(`session re-encryption failed with status ${error.status ?? "unknown"}`);
      }
      let result;
      try {
        result = JSON.parse(output.trim().split("\n").at(-1) ?? "");
      } catch {
        throw new FailClosed("session re-encryption produced no machine-readable result");
      }
      if (result?.rotated !== true || result?.fsyncRenameApplied !== true) {
        throw new FailClosed("session re-encryption did not confirm an atomic rotation");
      }
      emit({ ...scope, rotated: true, fsyncRenameApplied: true });
      return;
    }

    case "session-require-fresh-qr-login": {
      if (!booleans.has("invalidate-old-session")) {
        throw new UsageError("--invalidate-old-session is mandatory");
      }
      const result = await supabaseRpc("openclaw_service_require_fresh_qr_login_v1", {
        p_request: { version: 1, organizationId: organization, cellId: cell },
      });
      if (result?.sessionInvalidated !== true) {
        throw new FailClosed("old session was not invalidated");
      }
      // Never restore a cookie or session snapshot: re-login is the only path.
      emit({ ...scope, sessionInvalidated: true, freshQrLoginRequired: true });
      return;
    }

    case "prove-no-plaintext-session-snapshot": {
      const root = values.get("runtime-root");
      if (!root.startsWith("/")) throw new UsageError("--runtime-root must be absolute");
      let info;
      try {
        info = statSync(root);
      } catch {
        throw new FailClosed("runtime root is not readable");
      }
      if (!info.isDirectory()) throw new FailClosed("runtime root is not a directory");
      const { scanned, found } = findPlaintextSessionArtifacts(root);
      if (found.length > 0) {
        // Digests only: naming the file would put session material in evidence.
        throw new FailClosed(
          `plaintext session artifacts found: ${found.length} (digests ${found.join(",")})`,
        );
      }
      emit({ ...scope, filesScanned: scanned, plaintextSessionSnapshotFound: false });
      return;
    }

    default:
      throw new UsageError(`unhandled subcommand ${command}`);
  }
}

async function main() {
  let parsed;
  try {
    parsed = parseArguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(64);
  }
  try {
    await run(parsed);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(64);
    }
    process.stderr.write(`${error instanceof Error ? error.message : "recovery step failed"}\n`);
    process.exit(1);
  }
}

// Exported for the contract tests; `main` only runs as a program.
export { COMMANDS, findPlaintextSessionArtifacts, parseArguments };

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("openclaw-recovery-adapter.mjs")) {
  await main();
}
