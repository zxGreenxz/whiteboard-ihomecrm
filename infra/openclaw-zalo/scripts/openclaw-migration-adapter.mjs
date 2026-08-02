#!/usr/bin/env node
// OpenClaw Zalo - VPS migration adapter.
//
// migrate-cell.sh delegates all seventeen migration steps to this binary, in a
// fixed order that IS the safety contract. Until now the binary existed only in a
// runbook sentence, so the ordering guarantee protected nothing.
//
// Rules, same as the recovery adapter:
//   1. FAIL CLOSED. A step that cannot reach its infrastructure exits non-zero so
//      migrate-cell.sh keeps GLOBAL_STOP active instead of resuming on a lie.
//   2. NEVER TOUCH THE CO-TENANTS. Snapshot and comparison are strictly read-only
//      and refuse to name, inspect, or mutate the external 9Router / cli-proxy-api
//      containers beyond the read the plan explicitly allows.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Exact flag contract per step; anything else is a usage error. */
const COMMANDS = {
  "global-stop": { required: ["scope", "reason"] },
  "drain-outbox": { flags: ["stop-new-claims", "return-leased-to-queue"] },
  "freeze-outbox": { required: ["states"] },
  "move-expired-dispatching-to-unknown": { flags: ["never-retry-unknown"] },
  "snapshot-old-cotenants": { required: ["compare-fields"], flags: ["read-only"] },
  "provision-new-rootless-cell": { required: ["runtime-env"], flags: ["no-public-gateway"] },
  "rotate-workload-credentials": { flags: ["new-cell-only", "revoke-on-fence"] },
  "acquire-higher-fencing-lease": { flags: ["strictly-greater-than-old"] },
  "revoke-old-credential-and-lease": { flags: ["fence-old-cell"] },
  "require-fresh-qr-login": { required: ["copy-session"] },
  "sync-history": { required: ["hours", "automation", "dedupe"] },
  "reconcile-gaps-and-unknown": { flags: ["operator-required-for-unknown"] },
  "controlled-smoke": { required: ["one-send-ceiling"], flags: ["cleanup-required"] },
  "compare-cotenants": { flags: ["fail-on-change"] },
  "verify-external-canonical-stores": { required: ["supabase-copy", "r2-copy"] },
  "resume-organization": { required: ["permission", "reason"] },
};

const GLOBAL_REQUIRED = ["organization", "old-cell", "new-cell"];

/** Containers this adapter must never stop, restart, exec into, or reconfigure. */
const FORBIDDEN_CONTAINER_PATTERNS = [/9router/iu, /cli-?proxy/iu];

class UsageError extends Error {}
class FailClosed extends Error {}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  if (!command || !Object.hasOwn(COMMANDS, command)) {
    throw new UsageError(`unknown migration subcommand: ${command ?? "(none)"}`);
  }
  const spec = COMMANDS[command];
  const required = spec.required ?? [];
  const flags = spec.flags ?? [];
  const values = new Map();
  const booleans = new Set();
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) throw new UsageError("unexpected positional argument");
    const name = token.slice(2);
    if (values.has(name) || booleans.has(name)) throw new UsageError(`repeated flag --${name}`);
    if (flags.includes(name)) {
      booleans.add(name);
      continue;
    }
    if (![...required, ...GLOBAL_REQUIRED].includes(name)) {
      throw new UsageError(`unknown flag --${name}`);
    }
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new UsageError(`flag --${name} requires a value`);
    }
    values.set(name, value);
    index += 1;
  }
  for (const name of [...required, ...GLOBAL_REQUIRED]) {
    if (!values.has(name)) throw new UsageError(`missing required flag --${name}`);
  }
  // Every declared boolean is mandatory: migrate-cell.sh always passes them, so a
  // missing one means the caller is not the reviewed script.
  for (const name of flags) {
    if (!booleans.has(name)) throw new UsageError(`missing required flag --${name}`);
  }
  return { command, values, booleans };
}

function requireUuid(values, name) {
  const value = values.get(name);
  if (!UUID.test(value)) throw new UsageError(`--${name} must be a v4 UUID`);
  return value;
}

function environment(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new FailClosed(
      `${name} is required for this step; refusing to report migration progress that never happened`,
    );
  }
  return value.trim();
}

/**
 * Read-only query against the canonical store. Three migration steps verify facts
 * that live in Postgres and nowhere else; inventing RPC facades for them would have
 * dressed a guess up as a check. The URI carries the password so it travels through
 * the environment, never argv, where /proc/<pid>/cmdline exposes it.
 */
function canonicalScalar(sql) {
  const connection = environment("OPENCLAW_MIGRATION_CANONICAL_URL");
  if (!/^postgres(ql)?:\/\//u.test(connection)) {
    throw new FailClosed("OPENCLAW_MIGRATION_CANONICAL_URL must be a postgres connection URI");
  }
  let output;
  try {
    output = execFileSync(
      "psql",
      ["--no-psqlrc", "--tuples-only", "--no-align", "--quiet", "--command", sql],
      {
        encoding: "utf8",
        timeout: 120_000,
        env: { ...process.env, PGDATABASE: connection },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch (error) {
    throw new FailClosed(`canonical query failed with status ${error.status ?? "unknown"}`);
  }
  return output.trim();
}

async function supabaseRpc(operation, request) {
  const endpoint = new URL(environment("OPENCLAW_MIGRATION_SUPABASE_URL"));
  const key = environment("OPENCLAW_MIGRATION_SUPABASE_SERVICE_KEY");
  if (endpoint.protocol !== "https:") throw new FailClosed("migration Supabase URL must be https");
  const response = await fetch(`${endpoint.origin}/rest/v1/rpc/${operation}`, {
    method: "POST",
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ p_request: { version: 1, ...request } }),
  });
  if (!response.ok) throw new FailClosed(`${operation} failed with status ${response.status}`);
  return await response.json();
}

/**
 * Read-only co-tenant inventory over the rootless socket. `docker inspect` is the
 * only verb used, and the socket must be the runner's own: a rootful socket would
 * put the external 9Router host inside this adapter's reach.
 */
function inspectCoTenants(fields) {
  const dockerHost = environment("DOCKER_HOST");
  if (!/^unix:\/\/\/run\/user\/\d+\/docker\.sock$/u.test(dockerHost)) {
    throw new FailClosed("co-tenant inspection requires the rootless DOCKER_HOST socket");
  }
  let listing;
  try {
    listing = execFileSync("docker", ["ps", "--all", "--format", "{{.Names}}"], {
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, DOCKER_HOST: dockerHost },
    });
  } catch {
    throw new FailClosed("co-tenant listing failed");
  }
  const names = listing.split("\n").map((name) => name.trim()).filter(Boolean);
  const snapshot = {};
  for (const name of names) {
    let raw;
    try {
      raw = execFileSync(
        "docker",
        ["inspect", "--format", "{{json .}}", name],
        { encoding: "utf8", timeout: 60_000, env: { ...process.env, DOCKER_HOST: dockerHost } },
      );
    } catch {
      throw new FailClosed(`co-tenant inspection failed for one container`);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new FailClosed("co-tenant inspection produced unparseable output");
    }
    const projection = {};
    for (const field of fields) {
      switch (field) {
        case "id": projection.id = parsed.Id ?? null; break;
        case "image": projection.image = parsed.Image ?? null; break;
        case "network":
          projection.network = Object.keys(parsed.NetworkSettings?.Networks ?? {}).sort();
          break;
        case "mounts":
          projection.mounts = (parsed.Mounts ?? [])
            .map((mount) => `${mount.Type}:${mount.Source}:${mount.Destination}`)
            .sort();
          break;
        case "restart-count": projection.restartCount = parsed.RestartCount ?? null; break;
        case "ports":
          projection.ports = Object.keys(parsed.NetworkSettings?.Ports ?? {}).sort();
          break;
        default:
          throw new UsageError(`unsupported compare field ${field}`);
      }
    }
    snapshot[name] = projection;
  }
  return snapshot;
}

/**
 * Recursive canonical serialisation with sorted keys at EVERY depth.
 *
 * `JSON.stringify(value, Object.keys(value).sort())` looks like "stringify with
 * sorted keys" and is not: the array form is a key ALLOW-LIST applied at every
 * nesting level. With top-level container names as the allow-list, no nested field
 * survives, so `{cell:{image,ports}}` and a version with a different image and
 * different ports both serialised to `{"cell":{}}` - `compare-cotenants
 * --fail-on-change` could only ever notice a container being added or removed.
 */
function canonicalize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  return `{${Object.keys(value).sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
    .join(",")}}`;
}

function snapshotDigest(snapshot) {
  return createHash("sha256")
    .update("ihome-openclaw-cotenant-snapshot-v1")
    .update(String.fromCharCode(0))
    .update(canonicalize(snapshot))
    .digest("hex");
}

function emit(record) {
  process.stdout.write(`${JSON.stringify({ version: 1, ...record })}\n`);
}

async function run({ command, values, booleans }) {
  const organization = requireUuid(values, "organization");
  const oldCell = requireUuid(values, "old-cell");
  const newCell = requireUuid(values, "new-cell");
  if (oldCell === newCell) throw new UsageError("old and new cell must differ");
  const scope = { organizationId: organization, oldCellId: oldCell, newCellId: newCell, step: command };
  const identity = { organizationId: organization, oldCellId: oldCell, newCellId: newCell };

  switch (command) {
    case "global-stop": {
      if (values.get("scope") !== "organization") throw new UsageError("--scope must be organization");
      const result = await supabaseRpc("openclaw_service_begin_global_stop_v1", {
        ...identity,
        reason: values.get("reason"),
      });
      if (result?.globalStopActive !== true) throw new FailClosed("GLOBAL_STOP did not take effect");
      emit({ ...scope, globalStopActive: true });
      return;
    }

    case "drain-outbox":
    case "freeze-outbox":
    case "move-expired-dispatching-to-unknown":
    case "reconcile-gaps-and-unknown": {
      const operations = {
        "drain-outbox": "openclaw_service_drain_outbox_v1",
        "freeze-outbox": "openclaw_service_freeze_outbox_v1",
        "move-expired-dispatching-to-unknown": "openclaw_service_expire_dispatching_to_unknown_v1",
        "reconcile-gaps-and-unknown": "openclaw_service_reconcile_migration_gaps_v1",
      };
      const request = { ...identity };
      if (command === "freeze-outbox") {
        const states = values.get("states").split(",").map((state) => state.trim());
        if (states.length === 0 || !states.every((state) => ["QUEUED", "LEASED"].includes(state))) {
          throw new UsageError("--states must be a subset of QUEUED,LEASED");
        }
        request.states = states;
      }
      const result = await supabaseRpc(operations[command], request);
      if (result?.applied !== true) throw new FailClosed(`${command} did not confirm completion`);
      emit({ ...scope, applied: true, affected: Number(result.affected ?? 0) });
      return;
    }

    case "snapshot-old-cotenants": {
      const fields = values.get("compare-fields").split(",").map((field) => field.trim());
      if (fields.length === 0) throw new UsageError("--compare-fields must not be empty");
      const snapshot = inspectCoTenants(fields);
      const digest = snapshotDigest(snapshot);
      // Digest only. Container names and mount paths stay out of evidence.
      emit({ ...scope, containers: Object.keys(snapshot).length, snapshotDigest: digest });
      process.stderr.write(`cotenant-snapshot ${digest}\n`);
      return;
    }

    case "compare-cotenants": {
      const expected = environment("OPENCLAW_MIGRATION_COTENANT_DIGEST");
      const fields = ["id", "image", "network", "mounts", "restart-count", "ports"];
      const digest = snapshotDigest(inspectCoTenants(fields));
      if (digest !== expected) {
        throw new FailClosed("co-tenant snapshot changed across the migration");
      }
      emit({ ...scope, unchanged: true, snapshotDigest: digest });
      return;
    }

    case "provision-new-rootless-cell": {
      const runtimeEnv = values.get("runtime-env");
      if (!runtimeEnv.startsWith("/")) throw new UsageError("--runtime-env must be absolute");
      let info;
      try {
        info = statSync(runtimeEnv);
      } catch {
        throw new FailClosed("new runtime environment file is not readable");
      }
      if (!info.isFile()) throw new FailClosed("new runtime environment must be a regular file");
      const dockerHost = environment("DOCKER_HOST");
      if (!/^unix:\/\/\/run\/user\/\d+\/docker\.sock$/u.test(dockerHost)) {
        throw new FailClosed("provisioning requires the rootless DOCKER_HOST socket");
      }
      const compose = environment("OPENCLAW_MIGRATION_COMPOSE_FILE");
      // `docker compose up` is the one verb here that CREATES containers, so it is
      // the one path that could touch a co-tenant. Reading the file first turns the
      // forbidden-name list into an enforced guard instead of a comment: a compose
      // file that names 9Router or cli-proxy-api never reaches Docker.
      let composeSource;
      try {
        composeSource = readFileSync(compose, "utf8");
      } catch {
        throw new FailClosed("compose file is not readable");
      }
      for (const pattern of FORBIDDEN_CONTAINER_PATTERNS) {
        if (pattern.test(composeSource)) {
          throw new FailClosed(
            "compose file references an external co-tenant; provisioning refuses to touch it",
          );
        }
      }
      try {
        execFileSync(
          "docker",
          [
            "compose", "--project-name", `openclaw-zalo-${newCell}`,
            "--env-file", runtimeEnv, "-f", compose, "up", "--detach", "--no-build",
          ],
          {
            encoding: "utf8",
            timeout: 900_000,
            env: { ...process.env, DOCKER_HOST: dockerHost },
          },
        );
      } catch (error) {
        throw new FailClosed(`new cell did not start: status ${error.status ?? "unknown"}`);
      }
      emit({ ...scope, provisioned: true, publicGateway: false });
      return;
    }

    case "rotate-workload-credentials":
    case "acquire-higher-fencing-lease":
    case "revoke-old-credential-and-lease": {
      const operations = {
        "rotate-workload-credentials": "openclaw_service_rotate_migration_credentials_v1",
        "acquire-higher-fencing-lease": "openclaw_service_acquire_migration_lease_v1",
        "revoke-old-credential-and-lease": "openclaw_service_revoke_migration_lease_v1",
      };
      const result = await supabaseRpc(operations[command], identity);
      if (command === "acquire-higher-fencing-lease") {
        const newToken = Number(result?.newFencingToken);
        const oldToken = Number(result?.oldFencingToken);
        if (!Number.isSafeInteger(newToken) || !Number.isSafeInteger(oldToken) || newToken <= oldToken) {
          throw new FailClosed("new fencing token is not strictly greater than the old one");
        }
        emit({ ...scope, fencingTokenAdvanced: true });
        return;
      }
      if (result?.applied !== true) throw new FailClosed(`${command} did not confirm completion`);
      emit({ ...scope, applied: true });
      return;
    }

    case "require-fresh-qr-login": {
      if (values.get("copy-session") !== "never") {
        throw new UsageError("--copy-session must be never; a copied session is never migrated");
      }
      const result = await supabaseRpc("openclaw_service_require_fresh_qr_login_v1", identity);
      if (result?.sessionInvalidated !== true) {
        throw new FailClosed("old session was not invalidated");
      }
      emit({ ...scope, sessionInvalidated: true, sessionCopied: false });
      return;
    }

    case "sync-history": {
      const hours = Number(values.get("hours"));
      if (!Number.isSafeInteger(hours) || hours < 1 || hours > 168) {
        throw new UsageError("--hours must be between 1 and 168");
      }
      if (values.get("automation") !== "disabled") {
        throw new UsageError("--automation must be disabled while syncing history");
      }
      if (values.get("dedupe") !== "true") throw new UsageError("--dedupe must be true");
      // The CELL re-fetches history from the provider; no adapter can do that. What
      // this step can do is refuse to move on until the new cell has actually landed
      // that history in the canonical store, which is the property the runbook needs.
      const ingested = Number(canonicalScalar(
        `select count(*) from public.openclaw_messages` +
          ` where organization_id = '${organization}'` +
          ` and created_at >= now() - interval '${hours} hours'`,
      ));
      if (!Number.isFinite(ingested)) {
        throw new FailClosed("history verification returned no count");
      }
      if (ingested < 1) {
        throw new FailClosed(
          `no history landed in the last ${hours} hours; the new cell has not synced`,
        );
      }
      emit({ ...scope, applied: true, hours, ingested, automationDisabled: true });
      return;
    }

    case "controlled-smoke": {
      const ceiling = Number(values.get("one-send-ceiling"));
      if (ceiling !== 1) throw new UsageError("--one-send-ceiling must be exactly 1");
      // A controlled smoke is an OPERATOR action driven through the dedicated smoke
      // surface (openclaw_service_begin_smoke_run_v1 and friends), which requires a
      // full machine envelope this operator tool does not hold. So this step GATES on
      // the evidence rather than pretending to perform the send: migrate-cell.sh will
      // not resume the organization unless a smoke run really completed and cleaned up.
      const smokeStatus = canonicalScalar(
        `select coalesce(max(status), 'NONE') from public.openclaw_smoke_runs` +
          ` where organization_id = '${organization}'` +
          ` and finished_at >= now() - interval '2 hours'`,
      );
      if (smokeStatus !== "CLEANED") {
        throw new FailClosed(
          `controlled smoke evidence is '${smokeStatus}', expected CLEANED within the last 2 hours`,
        );
      }
      emit({ ...scope, smokePassed: true, fixturesCleaned: true, oneSendCeiling: ceiling });
      return;
    }

    case "verify-external-canonical-stores": {
      // Supabase and R2 are canonical and shared; copying them during a VPS move
      // would fork the source of truth.
      if (values.get("supabase-copy") !== "false" || values.get("r2-copy") !== "false") {
        throw new UsageError("Supabase and R2 are never copied during a cell migration");
      }
      // "Not copied" is provable: the cluster the new cell talks to must be the SAME
      // cluster, and Postgres publishes a system identifier that survives a restart
      // but never a restore into a fresh cluster. A forked copy fails here.
      const expected = environment("OPENCLAW_MIGRATION_CANONICAL_SYSTEM_ID");
      const observed = canonicalScalar("select system_identifier from pg_control_system()");
      if (!/^\d+$/u.test(observed)) {
        throw new FailClosed("canonical cluster reported no system identifier");
      }
      if (observed !== expected) {
        throw new FailClosed(
          "canonical cluster identity changed; Supabase appears to have been copied or forked",
        );
      }
      emit({ ...scope, canonicalIntact: true, supabaseCopied: false, r2Copied: false });
      return;
    }

    case "resume-organization": {
      if (values.get("permission") !== "openclaw_zalo.manage_operations") {
        throw new UsageError("resume requires the openclaw_zalo.manage_operations permission");
      }
      const result = await supabaseRpc("openclaw_service_resume_after_migration_v1", {
        ...identity,
        reason: values.get("reason"),
      });
      if (result?.resumed !== true) throw new FailClosed("organization did not resume");
      emit({ ...scope, resumed: true, globalStopActive: false });
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
    process.stderr.write(`${error instanceof Error ? error.message : "migration step failed"}\n`);
    process.exit(1);
  }
}

export { COMMANDS, FORBIDDEN_CONTAINER_PATTERNS, parseArguments, snapshotDigest };

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("openclaw-migration-adapter.mjs")) {
  await main();
}
