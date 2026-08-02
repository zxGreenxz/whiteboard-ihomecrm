#!/usr/bin/env node
// Regenerate scripts/network-center-rollout-manifest.json from the repository.
//
// WHY THIS EXISTS
// The manifest is the immutable contract Task 16 Step 2 uses to apply Network
// Center migrations to the LIVE production database. Until now it was
// hand-maintained, and it rotted exactly the way hand-maintained contracts do:
// it pinned ten migrations and a reviewed SHA from many commits back while
// fourteen migrations existed on disk. Applying it would have applied an
// INCOMPLETE set to a customer-serving database.
//
// WHY THE ASSERTIONS ARE MEASURED, NOT WRITTEN BY HAND
// Every entry carries postApply.required: the catalog objects that must exist
// once that migration has run. Those assertions are worthless if they name
// objects the migration did not introduce. That is not hypothetical here - a
// hand-written entry probed `table:public.network_site_settings` to prove
// migration 20260729131000 had run, but that table is created by migration
// 20260729010000; the probe was a FALSE POSITIVE and would have reported a
// never-applied migration as applied. What 131000 actually adds is the
// `rollout_state` COLUMN.
//
// So this generator does not parse SQL and does not trust a curated list. It
// boots a disposable local PostgreSQL cluster, applies the platform bootstrap
// and then the REAL migration files one at a time, and snapshots the catalog
// between every pair. Each migration's assertions are the measured DIFFERENCE
// its own file produced. An object that already existed cannot appear in a
// later migration's set, because it is not in that migration's diff.
//
// The apply script depends on three properties this generator guarantees:
//   1. CUMULATIVE - entry N lists everything entries 1..N introduced, because
//      apply uses entry N-1's list as the in-lock precondition for stage N.
//   2. EXACTLY-ASSIGNED - a descriptor appears first at the migration that
//      creates it. Everything not yet required is asserted ABSENT, so listing
//      an object one stage late makes the rollout fail on a healthy database.
//   3. MONOTONIC - once true, true through the last stage. A descriptor that
//      later stops holding (a table dropped from the realtime publication, for
//      example) is dropped from the manifest and reported, never silently kept.
//
// SAFETY: the disposable cluster listens on 127.0.0.1 only, on an ephemeral
// port, in a TEMP directory whose name is pattern-checked before any recursive
// removal, and its teardown is verified by evidence (port refuses connections,
// data directory gone). Those primitives are imported from
// network-center-disposable-db.mjs rather than re-implemented, because this
// project has already leaked a disposable Postgres to the public internet once.
//
// USAGE
//   node scripts/generate-network-center-rollout-manifest.mjs
//   node scripts/generate-network-center-rollout-manifest.mjs --reviewed-git-sha <40-hex>
//   node scripts/generate-network-center-rollout-manifest.mjs --check
//   node scripts/generate-network-center-rollout-manifest.mjs --stamp <40-hex|HEAD>
//   node scripts/generate-network-center-rollout-manifest.mjs --verify-tamper
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  MANIFEST_PATH,
  REPO_ROOT,
  discoverNetworkCenterMigrations,
  isEntrypoint,
  redactSecrets,
} from "./network-center-rollout-common.mjs";
import {
  FLEET_SEED_AFTER_MIGRATION,
  PLATFORM_BOOTSTRAP_RELATIVE_PATH,
  assertLocalClusterPath,
  assertLoopbackPortClosed,
  assertSupportedLocalPostgresVersion,
  buildLocalClusterSeedSql,
  candidateLocalPostgresBins,
} from "./network-center-disposable-db.mjs";
import { collectDeploymentFiles, computeSourceDigest } from "./deploy-edge-fn.mjs";
import { catalogDescriptorSql } from "./apply-network-center-rollout.mjs";

const CLUSTER_PREFIX = "network-center-pg-";
const TAMPER_PREFIX = "network-center-manifest-tamper-";
const PSQL_TIMEOUT_MS = 240_000;
const PG_CTL_TIMEOUT_MS = 60_000;
const VERSION_PROBE_TIMEOUT_MS = 10_000;
const MEASURED_SCHEMAS = "'public','app_private'";

export const MANIFEST_SCHEMA_VERSION = 1;
export const ROLLOUT_LOCK_NAME = "ihomecrm:network-center-rollout:v1";
export const PROJECT_REF = "tryymsxyyckgbrmmvozx";
export const REVIEWED_SHA_PLACEHOLDER = `${"0".repeat(39)}0`;

// Foundation objects that must already exist before the first stage, and the
// object whose ABSENCE proves the rollout has not started.
export const PREFLIGHT_REQUIRED = ["table:public.organizations", "table:public.buildings"];
export const PREFLIGHT_ABSENT = ["table:public.network_devices"];

// ---------------------------------------------------------------------------
// Disposable PostgreSQL driver
// ---------------------------------------------------------------------------

function resolveLocalBinary(name, environment = process.env) {
  const executable = process.platform === "win32" ? `${name}.exe` : name;
  const candidates = [
    ...candidateLocalPostgresBins(environment).map((directory) => join(directory, executable)),
    executable,
  ];
  for (const candidate of candidates) {
    if (candidate.includes("/") || candidate.includes("\\")) {
      if (!existsSync(candidate)) continue;
    }
    const probe = spawnSync(candidate, ["--version"], {
      encoding: "utf8",
      timeout: VERSION_PROBE_TIMEOUT_MS,
      windowsHide: true,
    });
    if (probe.status !== 0) continue;
    assertSupportedLocalPostgresVersion(name, probe.stdout || probe.stderr);
    return candidate;
  }
  throw new Error(`${name} is unavailable; set POSTGRES_BIN to a PostgreSQL 16+ bin directory`);
}

function runNative(file, args, { input, stdio, timeoutMs } = {}) {
  const options = {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutMs ?? PSQL_TIMEOUT_MS,
  };
  if (input !== undefined) options.input = input;
  if (stdio !== undefined) options.stdio = stdio;
  const result = spawnSync(file, args, options);
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "native command failed")
      .trim()
      .slice(-4_000);
    throw new Error(`${basename(file)} failed (${result.status ?? result.error?.code}): ${detail}`, {
      cause: result.error,
    });
  }
  return result.stdout ?? "";
}

async function availableLoopbackPort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((error) => (error ? reject(error) : resolvePort(port)));
    });
  });
}

// One row per catalog object, in the exact descriptor vocabulary that
// apply-network-center-rollout.mjs::catalogDescriptorSql can verify. Anything
// this query cannot express is not asserted, rather than asserted loosely.
//
// Partitions and partition-local indexes are excluded on purpose: the telemetry
// migrations pre-create partitions relative to now(), so their names depend on
// the DAY the generator runs. Pinning them would make the manifest expire.
//
// Functions are rendered through ::regprocedure, whose output is by definition
// accepted back by to_regprocedure() - which is what the descriptor SQL calls.
// pg_get_function_identity_arguments() looks equivalent and is NOT: it emits
// argument NAMES ("p_worker_id text"), and to_regprocedure raises a syntax
// error on those instead of returning NULL, which would turn every absence
// check into an aborted rollout stage. search_path is emptied so regprocedure
// always schema-qualifies; a bare name would resolve against the caller's
// search_path rather than the schema the migration actually wrote to.
export const CATALOG_SNAPSHOT_SQL = `SET search_path = pg_catalog;
SELECT descriptor FROM (
  SELECT 'table:' || n.nspname || '.' || c.relname AS descriptor
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname IN (${MEASURED_SCHEMAS})
     AND c.relkind IN ('r', 'p') AND NOT c.relispartition
  UNION ALL
  SELECT 'view:' || n.nspname || '.' || c.relname
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname IN (${MEASURED_SCHEMAS}) AND c.relkind = 'v'
  UNION ALL
  SELECT 'column:' || n.nspname || '.' || c.relname || ':' || a.attname
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname IN (${MEASURED_SCHEMAS})
     AND c.relkind IN ('r', 'p') AND NOT c.relispartition
     AND a.attnum > 0 AND NOT a.attisdropped
  UNION ALL
  SELECT 'function:' || p.oid::regprocedure::text
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname IN (${MEASURED_SCHEMAS}) AND p.prokind IN ('f', 'p')
  UNION ALL
  SELECT 'index:' || n.nspname || ':' || c.relname
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname IN (${MEASURED_SCHEMAS}) AND c.relkind = 'i' AND NOT c.relispartition
  UNION ALL
  SELECT 'rls:' || n.nspname || '.' || c.relname
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname IN (${MEASURED_SCHEMAS})
     AND c.relkind IN ('r', 'p') AND NOT c.relispartition AND c.relrowsecurity
  UNION ALL
  SELECT 'realtime:' || t.schemaname || ':' || t.tablename
    FROM pg_publication_tables t
   WHERE t.pubname = 'supabase_realtime' AND t.schemaname IN (${MEASURED_SCHEMAS})
  UNION ALL
  SELECT 'function_service_only:' || p.oid::regprocedure::text
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname IN (${MEASURED_SCHEMAS})
     AND p.prosecdef
     AND pg_get_userbyid(p.proowner) = 'postgres'
     AND EXISTS (
       SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
       JOIN pg_roles grantee ON grantee.oid = acl.grantee
       WHERE grantee.rolname = 'service_role' AND acl.privilege_type = 'EXECUTE'
     )
     AND NOT EXISTS (
       SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
       LEFT JOIN pg_roles grantee ON grantee.oid = acl.grantee
       WHERE acl.privilege_type = 'EXECUTE'
         AND (acl.grantee = 0 OR grantee.rolname NOT IN ('postgres', 'service_role'))
     )
) catalog ORDER BY 1;`;

// Data-state descriptor: it cannot be measured by the structural query above
// because its predicate reads the table itself, which does not parse before the
// table exists. Probed separately, only once the table is there.
export const ROLLOUT_OFF_DESCRIPTOR = "rows_rollout_off:public.network_site_settings";
const ROLLOUT_OFF_PROBE_SQL = `SELECT '${ROLLOUT_OFF_DESCRIPTOR}' AS descriptor
WHERE EXISTS (
        SELECT 1 FROM pg_attribute attribute
        WHERE attribute.attrelid = to_regclass('public.network_site_settings')
          AND attribute.attname = 'rollout_state'
          AND attribute.attnum > 0 AND NOT attribute.attisdropped
      )
  AND NOT EXISTS (
        SELECT 1 FROM public.network_site_settings settings
        WHERE to_jsonb(settings)->>'rollout_state' IS DISTINCT FROM 'OFF'
      );`;

// The rollout does not read the snapshot query above - it reads
// catalogDescriptorSql(). Two queries that agree by inspection are two queries
// that can silently disagree, so the generator runs the REAL descriptor SQL
// over every descriptor it measured and requires the two to return the same
// set. A descriptor string the rollout cannot parse fails here, on a disposable
// database, instead of aborting a stage against production.
export function buildDescriptorProbeSql(descriptors) {
  if (!descriptors.length) return "SELECT NULL::text AS name WHERE false;";
  const rows = descriptors
    .map((descriptor) => `('${descriptor.replaceAll("'", "''")}', ${catalogDescriptorSql(descriptor)})`)
    .join(",\n  ");
  return `SELECT name FROM (VALUES\n  ${rows}\n) probe(name, present) WHERE present ORDER BY 1;`;
}

function parseDescriptorLines(output) {
  return new Set(
    String(output)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  );
}

/**
 * Boot a disposable cluster, apply bootstrap + every Network Center migration
 * in apply order, and return the catalog snapshot taken after each one.
 */
export async function measureCatalogStages({
  repoRoot = REPO_ROOT,
  migrationPaths,
  tempRoot = tmpdir(),
  environment = process.env,
  log = () => {},
} = {}) {
  const binaries = Object.fromEntries(
    ["initdb", "pg_ctl", "psql"].map((name) => [name, resolveLocalBinary(name, environment)]),
  );
  const bootstrap = await readFile(join(repoRoot, PLATFORM_BOOTSTRAP_RELATIVE_PATH), "utf8");
  const migrations = await Promise.all(
    migrationPaths.map(async (path) => ({
      path,
      name: basename(path),
      body: await readFile(join(repoRoot, path), "utf8"),
    })),
  );
  if (!migrations.some((entry) => entry.name === FLEET_SEED_AFTER_MIGRATION)) {
    throw new Error(
      `Fleet seed anchor ${FLEET_SEED_AFTER_MIGRATION} is missing; the measured seed order is no longer valid`,
    );
  }

  const port = await availableLoopbackPort();
  await mkdir(resolve(tempRoot), { recursive: true });
  const cluster = assertLocalClusterPath(
    await mkdtemp(join(resolve(tempRoot), CLUSTER_PREFIX)),
    tempRoot,
  );
  const connectionArgs = [
    "-X",
    "-v",
    "ON_ERROR_STOP=1",
    "-h",
    "127.0.0.1",
    "-p",
    String(port),
    "-U",
    "postgres",
    "-d",
    "postgres",
  ];
  const psql = (input) => runNative(binaries.psql, connectionArgs, { input });
  const snapshot = () => {
    const structural = parseDescriptorLines(
      runNative(binaries.psql, ["-q", "-t", "-A", ...connectionArgs], {
        input: CATALOG_SNAPSHOT_SQL,
      }),
    );
    if (structural.has("table:public.network_site_settings")) {
      for (const descriptor of parseDescriptorLines(
        runNative(binaries.psql, ["-q", "-t", "-A", ...connectionArgs], {
          input: ROLLOUT_OFF_PROBE_SQL,
        }),
      )) {
        structural.add(descriptor);
      }
    }
    return structural;
  };

  let startAttempted = false;
  let primaryError;
  try {
    runNative(binaries.initdb, [
      "-D",
      cluster,
      "--auth=trust",
      "--username=postgres",
      "--encoding=UTF8",
      "--no-locale",
    ]);
    startAttempted = true;
    runNative(
      binaries.pg_ctl,
      [
        "-D",
        cluster,
        "-l",
        join(cluster, "postgres.log"),
        "-o",
        `-p ${port} -h 127.0.0.1`,
        "-w",
        "start",
      ],
      { stdio: ["ignore", "ignore", "ignore"], timeoutMs: PG_CTL_TIMEOUT_MS },
    );
    log("cluster: bootstrap");
    psql(bootstrap);
    const baseline = snapshot();
    const stages = [];
    for (const migration of migrations) {
      log(`cluster: ${migration.name}`);
      try {
        psql(migration.body);
      } catch (error) {
        throw new Error(
          `Network Center migration ${migration.name} failed on the disposable cluster: ${error.message}`,
          { cause: error },
        );
      }
      // The tenancy/fleet seed lands where the hardening wave expects it: after
      // the four base migrations, because 20260729133000 snapshots whatever
      // MikroTik devices exist when it runs.
      if (migration.name === FLEET_SEED_AFTER_MIGRATION) {
        psql(buildLocalClusterSeedSql({ includeFleetFixtures: true }));
      }
      stages.push({ path: migration.path, name: migration.name, present: snapshot() });
    }

    // Cross-check at the final state, over every descriptor the run ever saw:
    // the rollout's own descriptor SQL must agree with the snapshot query about
    // which of them hold and which do not. Descriptors that vanished part-way
    // (a table dropped from the realtime publication) are in this universe on
    // purpose - they exercise the ABSENCE half of the agreement.
    const universe = [...new Set(stages.flatMap((stage) => [...stage.present]))].sort();
    const probed = parseDescriptorLines(
      runNative(binaries.psql, ["-q", "-t", "-A", ...connectionArgs], {
        input: buildDescriptorProbeSql(universe),
      }),
    );
    const finalStage = stages[stages.length - 1].present;
    const disagreements = universe.filter(
      (descriptor) => probed.has(descriptor) !== finalStage.has(descriptor),
    );
    if (disagreements.length) {
      throw new Error(
        `Descriptor SQL disagrees with the measured catalog for ${disagreements.length} descriptor(s): ` +
          `${disagreements.slice(0, 5).join(", ")}`,
      );
    }
    log(`cluster: descriptor SQL agreed with the catalog on all ${universe.length} descriptors`);
    return { baseline, stages };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    let cleanupError = null;
    if (startAttempted) {
      try {
        assertLocalClusterPath(cluster, tempRoot);
        runNative(binaries.pg_ctl, ["-D", cluster, "-m", "fast", "-w", "stop"], {
          stdio: ["ignore", "ignore", "ignore"],
          timeoutMs: PG_CTL_TIMEOUT_MS,
        });
      } catch (error) {
        cleanupError = error;
      }
    }
    try {
      await rm(assertLocalClusterPath(cluster, tempRoot), { recursive: true, force: true });
    } catch (error) {
      cleanupError ??= error;
    }
    // "We called stop" is exactly the claim that let a disposable Postgres
    // survive three days on a public address. Teardown is proven, not asserted.
    if (!cleanupError) {
      try {
        await assertLoopbackPortClosed(port);
        if (existsSync(cluster)) {
          throw new Error(`Disposable PostgreSQL teardown unverified: ${cluster} still exists`);
        }
      } catch (error) {
        cleanupError = error;
      }
    }
    if (cleanupError) {
      const message = `Disposable PostgreSQL cleanup failed: ${cleanupError.message}`;
      if (primaryError) {
        throw new AggregateError([primaryError, cleanupError], `${primaryError.message}; ${message}`);
      }
      throw new Error(message, { cause: cleanupError });
    }
  }
}

// ---------------------------------------------------------------------------
// Descriptor assignment
// ---------------------------------------------------------------------------

function descriptorTable(descriptor) {
  const match = /^column:([^:]+):/.exec(descriptor);
  return match ? `table:${match[1]}` : null;
}

/**
 * Turn per-stage catalog snapshots into per-stage assertion sets.
 *
 * Every exclusion is returned in `dropped` with a reason. Nothing is silently
 * discarded: a cap or a filter that does not say what it removed is how a
 * contract quietly stops covering the thing it exists to cover.
 */
export function deriveAssignments({ baseline, stages }) {
  const dropped = [];
  const lastIndex = stages.length - 1;
  const firstSeen = new Map();
  for (let index = 0; index < stages.length; index += 1) {
    for (const descriptor of stages[index].present) {
      if (!firstSeen.has(descriptor)) firstSeen.set(descriptor, index);
    }
  }

  const assigned = new Map();
  for (const [descriptor, index] of [...firstSeen].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (baseline.has(descriptor)) {
      // Created by the platform, not by this rollout. Asserting it would make
      // the manifest claim credit for objects production already has.
      continue;
    }
    let monotonic = true;
    for (let probe = index; probe <= lastIndex; probe += 1) {
      if (!stages[probe].present.has(descriptor)) {
        monotonic = false;
        dropped.push({
          descriptor,
          reason: `not monotonic: introduced by ${stages[index].name}, absent again after ${stages[probe].name}`,
        });
        break;
      }
    }
    if (!monotonic) continue;
    // A column that arrives WITH its table is already covered by the table
    // descriptor. A column added to a table that existed at an EARLIER stage is
    // kept, and it is the whole point of measuring: 20260729131000 introduces
    // no new table at all, only network_site_settings.rollout_state on a table
    // migration 20260729010000 created. Probing the table name there was a
    // false positive that reported an unapplied migration as applied.
    const owningTable = descriptorTable(descriptor);
    if (owningTable && firstSeen.get(owningTable) === index) {
      dropped.push({
        descriptor,
        reason: `covered by ${owningTable}, which arrives in the same stage (${stages[index].name})`,
      });
      continue;
    }
    if (!assigned.has(index)) assigned.set(index, []);
    assigned.get(index).push(descriptor);
  }

  const cumulative = [];
  const running = [];
  for (let index = 0; index < stages.length; index += 1) {
    running.push(...(assigned.get(index) ?? []));
    cumulative.push([...running].sort((left, right) => left.localeCompare(right)));
  }
  return {
    introduced: stages.map((_, index) => assigned.get(index) ?? []),
    cumulative,
    dropped,
  };
}

// ---------------------------------------------------------------------------
// Manifest assembly
// ---------------------------------------------------------------------------

function git(args, repoRoot = REPO_ROOT) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function serializeManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

// core.autocrlf=true is set in this repository and .gitattributes pins eol=lf
// for *.sh, *.service, *.ps1 and the deploy *.conf files only - not *.sql. A
// pinned file saved with CRLF is therefore stored as LF in the object database,
// its worktree digest can never equal its reviewed-revision digest, and the
// rollout blocks forever on what looks like tampering. Pinning that digest
// anyway would ship a manifest that is guaranteed to fail validation, so this
// refuses instead of recording it quietly.
// With --allow-crlf the digest pinned is the LF-normalized one - byte-identical
// to what git already stores and to what the file must become - so the manifest
// is correct the moment the line endings are fixed, and no second regeneration
// is needed. It is never the CRLF digest: pinning that would guarantee a
// mismatch against the reviewed revision forever.
function pinnedBytes(path, contents, { allowCrlf, onNormalized }) {
  if (!contents.includes(0x0d)) return contents;
  if (!allowCrlf) {
    throw new Error(
      `${path} contains CRLF line endings; git stores it as LF (core.autocrlf, and .gitattributes ` +
        "does not pin eol for *.sql), so its worktree digest can never match its reviewed-revision " +
        "digest and the rollout is blocked. Normalize the file to LF and commit it, then regenerate. " +
        "Pass --allow-crlf to pin the LF-normalized digest anyway.",
    );
  }
  onNormalized(path);
  return Buffer.from(contents.toString("utf8").replaceAll("\r\n", "\n"), "utf8");
}

export async function buildManifest({
  repoRoot = REPO_ROOT,
  reviewedGitSha,
  migrationPaths,
  cumulative,
  previous,
  allowCrlf = false,
  onNormalized = () => {},
} = {}) {
  const pin = (path, contents) => pinnedBytes(path, contents, { allowCrlf, onNormalized });
  const migrations = [];
  for (let index = 0; index < migrationPaths.length; index += 1) {
    const path = migrationPaths[index];
    const contents = pin(path, await readFile(join(repoRoot, path)));
    migrations.push({
      ordinal: index + 1,
      path,
      sha256: createHash("sha256").update(contents).digest("hex"),
      postApply: { required: cumulative[index] },
    });
  }
  const edgeSlug = previous?.edgeFunction?.slug ?? "network-center-worker";
  const edgePath = previous?.edgeFunction?.path ?? `supabase/functions/${edgeSlug}`;
  const edgeFiles = (
    await collectDeploymentFiles({
      repoRoot,
      slug: edgeSlug,
      expectedFiles: previous?.edgeFunction?.files?.map((file) => file.path),
    })
  ).map((file) => {
    const contents = pin(`${edgePath}/${file.path}`, file.contents);
    return { ...file, contents, sha256: createHash("sha256").update(contents).digest("hex") };
  });
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    projectRef: previous?.projectRef ?? PROJECT_REF,
    reviewedGitSha,
    lockName: ROLLOUT_LOCK_NAME,
    preflight: { required: [...PREFLIGHT_REQUIRED], absent: [...PREFLIGHT_ABSENT] },
    migrations,
    postApply: { required: [...cumulative[cumulative.length - 1]] },
    edgeFunction: {
      slug: edgeSlug,
      path: `supabase/functions/${edgeSlug}`,
      entrypoint: previous?.edgeFunction?.entrypoint ?? "index.ts",
      verifyJwt: previous?.edgeFunction?.verifyJwt ?? false,
      files: edgeFiles.map((file) => ({ path: file.path, sha256: file.sha256 })),
      sha256: computeSourceDigest(edgeFiles),
    },
  };
}

export async function generateManifest({
  repoRoot = REPO_ROOT,
  reviewedGitSha,
  tempRoot = tmpdir(),
  allowCrlf = false,
  onNormalized = () => {},
  log = () => {},
} = {}) {
  const migrationPaths = await discoverNetworkCenterMigrations(repoRoot);
  const previous = existsSync(MANIFEST_PATH)
    ? JSON.parse(await readFile(MANIFEST_PATH, "utf8"))
    : undefined;
  const measured = await measureCatalogStages({ repoRoot, migrationPaths, tempRoot, log });
  const derived = deriveAssignments(measured);
  const manifest = await buildManifest({
    repoRoot,
    reviewedGitSha,
    migrationPaths,
    cumulative: derived.cumulative,
    previous,
    allowCrlf,
    onNormalized,
  });
  return { manifest, derived, measured, migrationPaths };
}

// ---------------------------------------------------------------------------
// Tamper proof: the manifest is only worth what the validator refuses
// ---------------------------------------------------------------------------

async function buildTamperSandbox({ repoRoot, manifest, tempRoot = tmpdir() }) {
  const sandbox = await mkdtemp(join(resolve(tempRoot), TAMPER_PREFIX));
  const edgeSlug = manifest.edgeFunction.slug;
  const baseline = clone(manifest);
  const normalized = [];
  await mkdir(join(sandbox, "supabase", "migrations"), { recursive: true });
  await mkdir(join(sandbox, "supabase", "functions", edgeSlug), { recursive: true });
  await copyFile(
    join(repoRoot, "supabase", "config.toml"),
    join(sandbox, "supabase", "config.toml"),
  );
  // Copy verbatim. A pinned file that carries CRLF cannot be validated at all -
  // that is a defect in the repository, reported separately - so the harness
  // normalizes it and REPINS its digest here rather than letting one broken
  // file mask every rejection the matrix exists to demonstrate.
  const place = async (sourcePath, targetPath, repin) => {
    const contents = await readFile(sourcePath);
    if (contents.includes(0x0d)) {
      const lf = Buffer.from(contents.toString("utf8").replaceAll("\r\n", "\n"), "utf8");
      await writeFile(targetPath, lf);
      normalized.push(repin(createHash("sha256").update(lf).digest("hex")));
      return;
    }
    await writeFile(targetPath, contents);
  };
  for (const path of await discoverNetworkCenterMigrations(repoRoot)) {
    await place(join(repoRoot, path), join(sandbox, path), (digest) => {
      const entry = baseline.migrations.find((migration) => migration.path === path);
      if (entry) entry.sha256 = digest;
      return path;
    });
  }
  for (const file of manifest.edgeFunction.files) {
    await place(
      join(repoRoot, manifest.edgeFunction.path, file.path),
      join(sandbox, "supabase", "functions", edgeSlug, file.path),
      (digest) => {
        const entry = baseline.edgeFunction.files.find((item) => item.path === file.path);
        if (entry) entry.sha256 = digest;
        return `${manifest.edgeFunction.path}/${file.path}`;
      },
    );
  }
  if (normalized.some((path) => path.startsWith(manifest.edgeFunction.path))) {
    baseline.edgeFunction.sha256 = computeSourceDigest(baseline.edgeFunction.files);
  }
  git(["init", "-q", "-b", "main"], sandbox);
  // The sandbox must store bytes verbatim. This repository runs with
  // core.autocrlf=true and pins eol=lf for only four file globs, none of them
  // *.sql, so an inherited config would rewrite line endings on `git add` and
  // every reviewed-revision digest in the harness would mismatch for a reason
  // that has nothing to do with the tampering under test.
  git(["config", "core.autocrlf", "false"], sandbox);
  await writeFile(join(sandbox, ".gitattributes"), "* -text\n", "utf8");
  git(["add", "-A"], sandbox);
  git(
    [
      "-c",
      "user.email=rollout@example.invalid",
      "-c",
      "user.name=Rollout Tamper Harness",
      "commit",
      "-q",
      "-m",
      "manifest tamper harness baseline",
    ],
    sandbox,
  );
  return { sandbox, baseline, normalized, headSha: git(["rev-parse", "HEAD"], sandbox) };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function tamperCases() {
  return [
    {
      name: "baseline (untampered)",
      expect: null,
      mutate: (manifest) => manifest,
    },
    {
      name: "migration sha256 flipped",
      expect: /digest mismatch/i,
      mutate: (manifest) => {
        manifest.migrations[3].sha256 = `${"0".repeat(63)}f`;
        return manifest;
      },
    },
    {
      name: "one migration dropped from the set",
      expect: /does not cover every Network Center migration|missing/i,
      mutate: (manifest) => {
        manifest.migrations.splice(9, 1);
        for (let index = 0; index < manifest.migrations.length; index += 1) {
          manifest.migrations[index].ordinal = index + 1;
        }
        return manifest;
      },
    },
    {
      name: "two migrations reordered",
      expect: /apply order|ascending/i,
      mutate: (manifest) => {
        const [left, right] = [manifest.migrations[5], manifest.migrations[6]];
        manifest.migrations[5] = { ...right, ordinal: 6 };
        manifest.migrations[6] = { ...left, ordinal: 7 };
        return manifest;
      },
    },
    {
      name: "ordinals renumbered out of step with apply order",
      expect: /ordinal/i,
      mutate: (manifest) => {
        manifest.migrations[2].ordinal = 99;
        return manifest;
      },
    },
    {
      name: "postApply assertion removed from a later stage",
      expect: /cumulative|superset/i,
      mutate: (manifest) => {
        const last = manifest.migrations[manifest.migrations.length - 1];
        last.postApply.required = last.postApply.required.filter(
          (descriptor) => descriptor !== "table:public.network_devices",
        );
        return manifest;
      },
    },
    {
      name: "unverifiable descriptor smuggled in",
      expect: /descriptor/i,
      mutate: (manifest) => {
        manifest.migrations[0].postApply.required.push("trigger:public.network_devices");
        return manifest;
      },
    },
    {
      name: "project ref repointed",
      expect: /project/i,
      mutate: (manifest) => {
        manifest.projectRef = "wrongprojectref00000";
        return manifest;
      },
    },
    {
      name: "reviewed revision is not an ancestor of the release",
      expect: /ancestor/i,
      mutate: (manifest) => {
        manifest.reviewedGitSha = "f".repeat(40);
        return manifest;
      },
    },
    {
      name: "edge function source digest flipped",
      expect: /digest mismatch/i,
      mutate: (manifest) => {
        manifest.edgeFunction.sha256 = `${"0".repeat(63)}a`;
        return manifest;
      },
    },
    {
      // Not a manifest mutation: the release tree itself. An uncommitted change
      // means the bytes about to reach production are not the bytes anybody
      // reviewed, whatever the digests say.
      name: "release worktree is dirty",
      expect: /dirty/i,
      mutate: (manifest) => manifest,
      dirty: true,
    },
  ];
}

export async function verifyTamperRejection({
  repoRoot = REPO_ROOT,
  manifest,
  tempRoot = tmpdir(),
  write = (line) => process.stdout.write(line),
} = {}) {
  const { validateRolloutCli } = await import("./validate-network-center-rollout.mjs");
  const prepared = await buildTamperSandbox({ repoRoot, manifest, tempRoot });
  const results = [];
  for (const path of prepared.normalized) {
    write(
      `NOTE ${path} carries CRLF in the worktree; the sandbox pins its LF-normalized digest so the ` +
        "matrix is not masked by a defect it is not testing.\n",
    );
  }
  try {
    for (const testCase of tamperCases()) {
      const candidate = testCase.mutate(clone({ ...prepared.baseline, reviewedGitSha: prepared.headSha }));
      const strayPath = join(prepared.sandbox, "uncommitted-change.sql");
      if (testCase.dirty) await writeFile(strayPath, "-- not reviewed\n", "utf8");
      let outcome;
      try {
        const validated = await validateRolloutCli({ repoRoot: prepared.sandbox, manifest: candidate });
        outcome = { accepted: true, message: `accepted ${validated.migrationCount} migrations` };
      } catch (error) {
        outcome = { accepted: false, message: error?.message ?? String(error) };
      } finally {
        if (testCase.dirty) await rm(strayPath, { force: true });
      }
      const shouldReject = testCase.expect !== null;
      const passed = shouldReject
        ? !outcome.accepted && testCase.expect.test(outcome.message)
        : outcome.accepted;
      results.push({ name: testCase.name, passed, ...outcome });
      write(
        `${passed ? "OK  " : "FAIL"} ${testCase.name}\n     -> ${outcome.accepted ? "ACCEPTED: " : "REJECTED: "}${outcome.message}\n`,
      );
    }
  } finally {
    const normalized = resolve(prepared.sandbox);
    if (
      dirname(normalized) !== resolve(tempRoot) ||
      !basename(normalized).startsWith(TAMPER_PREFIX)
    ) {
      throw new Error(`Refusing to remove a tamper sandbox outside TEMP: ${normalized}`);
    }
    await rm(normalized, { recursive: true, force: true });
  }
  return results;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = { mode: "generate" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") options.mode = "check";
    else if (arg === "--verify-tamper") options.mode = "verify-tamper";
    else if (arg === "--stamp") {
      options.mode = "stamp";
      options.stamp = argv[++index];
    } else if (arg === "--reviewed-git-sha") options.reviewedGitSha = argv[++index];
    else if (arg === "--inventory-out") options.inventoryOut = argv[++index];
    else if (arg === "--out") options.out = argv[++index];
    else if (arg === "--allow-crlf") options.allowCrlf = true;
    else if (arg === "--quiet") options.quiet = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function resolveReviewedSha(value, repoRoot = REPO_ROOT) {
  if (value === undefined) return REVIEWED_SHA_PLACEHOLDER;
  if (value === "HEAD") return git(["rev-parse", "HEAD"], repoRoot);
  if (!/^[a-f0-9]{40}$/.test(value ?? "")) {
    throw new Error("--reviewed-git-sha requires a full 40-character revision, or HEAD");
  }
  return value;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const log = options.quiet ? () => {} : (line) => process.stderr.write(`${line}\n`);

  if (options.mode === "stamp") {
    const sha = resolveReviewedSha(options.stamp === undefined ? "HEAD" : options.stamp);
    const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
    manifest.reviewedGitSha = sha;
    await writeFile(MANIFEST_PATH, serializeManifest(manifest), "utf8");
    process.stdout.write(`Stamped reviewedGitSha=${sha}\n`);
    return;
  }

  if (options.mode === "verify-tamper") {
    const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
    const results = await verifyTamperRejection({ manifest });
    const failed = results.filter((result) => !result.passed);
    process.stdout.write(
      `Tamper matrix: ${results.length - failed.length}/${results.length} behaved as required\n`,
    );
    if (failed.length) {
      process.exitCode = 1;
      process.stdout.write(`Unmet expectations: ${failed.map((item) => item.name).join(", ")}\n`);
    }
    return;
  }

  const reviewedGitSha = resolveReviewedSha(options.reviewedGitSha);
  const { manifest, derived, migrationPaths } = await generateManifest({
    reviewedGitSha,
    allowCrlf: options.allowCrlf === true,
    onNormalized: (path) =>
      log(
        `NOTE ${path} carries CRLF in the worktree. Pinned the LF-normalized digest, which is what ` +
          "git already stores. The rollout stays blocked until the file itself is normalized and committed.",
      ),
    log,
  });
  const serialized = serializeManifest(manifest);

  if (options.inventoryOut) {
    await writeFile(
      options.inventoryOut,
      `${JSON.stringify(
        {
          migrations: migrationPaths,
          introduced: derived.introduced,
          dropped: derived.dropped,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }

  for (const entry of derived.dropped) {
    log(`dropped ${entry.descriptor} (${entry.reason})`);
  }
  log(
    `descriptors: ${derived.cumulative[derived.cumulative.length - 1].length} asserted, ` +
      `${derived.dropped.length} dropped with a stated reason`,
  );

  const target = options.out ?? MANIFEST_PATH;
  if (options.mode === "check") {
    const current = existsSync(target) ? await readFile(target, "utf8") : "";
    const normalize = (value) => {
      const parsed = value ? JSON.parse(value) : {};
      return serializeManifest({ ...parsed, reviewedGitSha });
    };
    if (normalize(current) !== serialized) {
      process.exitCode = 1;
      process.stdout.write(
        "Manifest drift: scripts/network-center-rollout-manifest.json no longer matches the repository. " +
          "Regenerate it.\n",
      );
      return;
    }
    process.stdout.write(
      `Manifest matches the repository: ${manifest.migrations.length} migrations, ` +
        `${manifest.postApply.required.length} post-apply assertions\n`,
    );
    return;
  }

  await writeFile(target, serialized, "utf8");
  process.stdout.write(
    `Wrote ${target}: ${manifest.migrations.length} migrations, ` +
      `${manifest.postApply.required.length} post-apply assertions, reviewedGitSha=${manifest.reviewedGitSha}\n`,
  );
}

if (isEntrypoint(import.meta.url)) {
  main().catch((error) => {
    console.error(redactSecrets(error?.stack ?? error?.message ?? error));
    process.exitCode = 1;
  });
}
