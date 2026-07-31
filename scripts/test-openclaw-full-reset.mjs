import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildMinimalChildEnvironment } from "./gen-supabase-types.mjs";
import { redactSensitiveText } from "./test-openclaw-sql.mjs";

export const FULL_RESET_MANIFEST_DOMAIN = "ihome-openclaw-full-reset-plan-v1";
export const FULL_RESET_EXPECTED_FILE_COUNT = 498;
export const FULL_RESET_EXPECTED_DUPLICATE_VERSION_GROUPS = 18;
export const SUPABASE_CLI_VERSION = "2.109.1";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const MIGRATION_FILE_PATTERN = /^\d+_[a-z0-9_-]+\.sql$/;
const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export function buildFullResetPlan(inputs) {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new Error("The complete migration input set cannot be empty.");
  }
  const seen = new Set();
  const normalized = inputs.map(({ file, bytes }) => {
    if (
      typeof file !== "string" ||
      basename(file) !== file ||
      !MIGRATION_FILE_PATTERN.test(file)
    ) {
      throw new Error(`Unsafe migration filename: ${String(file)}`);
    }
    if (seen.has(file)) throw new Error(`Duplicate migration file: ${file}`);
    seen.add(file);
    const rawBytes = Buffer.isBuffer(bytes) ? Buffer.from(bytes) : Buffer.from(bytes ?? "");
    return {
      sourceFile: file,
      sourceVersion: file.slice(0, file.indexOf("_")),
      bytes: rawBytes,
    };
  }).sort((left, right) => compareUtf8(left.sourceFile, right.sourceFile));

  const versionCounts = new Map();
  for (const entry of normalized) {
    versionCounts.set(
      entry.sourceVersion,
      (versionCounts.get(entry.sourceVersion) ?? 0) + 1,
    );
  }
  const duplicateOriginalVersionGroups = [...versionCounts.values()]
    .filter((count) => count > 1).length;

  const sourceVersions = new Set(versionCounts.keys());
  const usedTargetVersions = new Set();
  const duplicateRanks = new Map();
  const entries = normalized.map((entry, index) => {
    const groupCount = versionCounts.get(entry.sourceVersion);
    let targetVersion = entry.sourceVersion;
    if (groupCount > 1) {
      const rank = (duplicateRanks.get(entry.sourceVersion) ?? 0) + 1;
      duplicateRanks.set(entry.sourceVersion, rank);
      const width = String(groupCount).length;
      targetVersion = `${entry.sourceVersion}${String(rank).padStart(width, "0")}`;
      if (sourceVersions.has(targetVersion) || usedTargetVersions.has(targetVersion)) {
        throw new Error(
          `Cannot allocate a fidelity-preserving version for ${entry.sourceFile}.`,
        );
      }
    }
    usedTargetVersions.add(targetVersion);
    const migrationName = entry.sourceFile.slice(entry.sourceVersion.length + 1);
    return {
      order: index + 1,
      sourceFile: entry.sourceFile,
      sourceVersion: entry.sourceVersion,
      targetVersion,
      targetFile: groupCount > 1
        ? `${targetVersion}_${migrationName}`
        : entry.sourceFile,
      rawSha256: createHash("sha256").update(entry.bytes).digest("hex"),
      bytes: entry.bytes,
    };
  });
  const targetOrder = entries
    .map((entry) => entry.targetFile)
    .toSorted(compareUtf8);
  if (targetOrder.some((file, index) => file !== entries[index].targetFile)) {
    throw new Error("Fidelity-preserving migration versions changed canonical order.");
  }

  const aggregate = createHash("sha256")
    .update(FULL_RESET_MANIFEST_DOMAIN)
    .update(Buffer.from([0]));
  for (const entry of entries) {
    aggregate.update(entry.sourceFile).update(Buffer.from([0]));
    aggregate.update(entry.sourceVersion).update(Buffer.from([0]));
    aggregate.update(entry.targetFile).update(Buffer.from([0]));
    aggregate.update(entry.rawSha256).update(Buffer.from([0]));
  }
  return {
    entries,
    duplicateOriginalVersionGroups,
    aggregateSha256: aggregate.digest("hex"),
  };
}

export async function loadRepositoryMigrationInputs({
  repoRoot = repositoryRoot,
} = {}) {
  const migrationRoot = join(repoRoot, "supabase", "migrations");
  const directoryEntries = await readdir(migrationRoot, { withFileTypes: true });
  const files = directoryEntries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort(compareUtf8);
  return Promise.all(files.map(async (file) => ({
    file,
    bytes: await readFile(join(migrationRoot, file)),
  })));
}

function assertSafeTemporaryRoot(root) {
  const resolvedRoot = resolve(root);
  const resolvedTemporaryRoot = resolve(tmpdir());
  const relationship = relative(resolvedTemporaryRoot, resolvedRoot);
  if (
    !relationship ||
    relationship === ".." ||
    relationship.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    !basename(resolvedRoot).startsWith("openclaw-full-reset-")
  ) {
    throw new Error("Refusing to clean an unsafe full-reset temporary path.");
  }
  return resolvedRoot;
}

function manifestJson(plan) {
  return `${JSON.stringify({
    schema: 1,
    domain: FULL_RESET_MANIFEST_DOMAIN,
    fileCount: plan.entries.length,
    duplicateOriginalVersionGroups: plan.duplicateOriginalVersionGroups,
    aggregateSha256: plan.aggregateSha256,
    entries: plan.entries.map((entry) => ({
      order: entry.order,
      sourceFile: entry.sourceFile,
      sourceVersion: entry.sourceVersion,
      targetVersion: entry.targetVersion,
      targetFile: entry.targetFile,
      rawSha256: entry.rawSha256,
    })),
  }, null, 2)}\n`;
}

export async function prepareDisposableFullResetProject({
  inputs,
  configToml,
  repoRoot = repositoryRoot,
} = {}) {
  const migrationInputs = inputs ?? await loadRepositoryMigrationInputs({ repoRoot });
  const sourceConfig = configToml ?? await readFile(
    join(repoRoot, "supabase", "config.toml"),
    "utf8",
  );
  const projectRows = sourceConfig.match(/^project_id\s*=\s*"[^"]*"\s*$/gm) ?? [];
  if (projectRows.length !== 1) {
    throw new Error("Supabase config must contain exactly one project_id binding.");
  }
  const plan = buildFullResetPlan(migrationInputs);
  const root = await mkdtemp(join(tmpdir(), "openclaw-full-reset-"));
  const safeRoot = assertSafeTemporaryRoot(root);
  const projectSuffix = basename(safeRoot)
    .slice("openclaw-full-reset-".length)
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase();
  if (!projectSuffix) {
    await rm(safeRoot, { recursive: true, force: true });
    throw new Error("Disposable Supabase project identity is empty.");
  }
  const preparedConfig = sourceConfig.replace(
    /^project_id\s*=\s*"[^"]*"\s*$/m,
    `project_id = "openclaw_task12_${projectSuffix}"`,
  );
  let prepared = false;
  try {
    const supabaseRoot = join(safeRoot, "supabase");
    const migrationRoot = join(supabaseRoot, "migrations");
    await mkdir(migrationRoot, { recursive: true });
    await writeFile(join(supabaseRoot, "config.toml"), preparedConfig, {
      encoding: "utf8",
      flag: "wx",
    });
    await Promise.all(plan.entries.map((entry) =>
      writeFile(join(migrationRoot, entry.targetFile), entry.bytes, { flag: "wx" })
    ));
    await writeFile(
      join(safeRoot, "openclaw-full-reset-manifest.json"),
      manifestJson(plan),
      { encoding: "utf8", flag: "wx" },
    );
    prepared = true;
  } finally {
    if (!prepared) await rm(safeRoot, { recursive: true, force: true });
  }
  let cleaned = false;
  return {
    root: safeRoot,
    plan,
    cleanup: async () => {
      if (cleaned) return;
      assertSafeTemporaryRoot(safeRoot);
      await rm(safeRoot, { recursive: true, force: true, maxRetries: 3 });
      cleaned = true;
    },
  };
}

export function parseFullResetArgs(args) {
  if (args.length === 1 && args[0] === "--plan-only") return { mode: "plan-only" };
  if (args.length === 1 && args[0] === "--local") return { mode: "local" };
  throw new Error("An explicit --plan-only or --local full-reset mode is required.");
}

function appendBounded(chunks, state, chunk) {
  if (state.bytes >= MAX_CAPTURE_BYTES) return;
  const remaining = MAX_CAPTURE_BYTES - state.bytes;
  const bounded = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
  chunks.push(bounded);
  state.bytes += bounded.length;
}

function buildPinnedInvocation(args, environment = process.env) {
  if (process.platform === "win32") {
    const npmCliPath = environment.npm_execpath ?? join(
      dirname(process.execPath),
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js",
    );
    return {
      command: process.execPath,
      args: [
        npmCliPath,
        "exec",
        "--yes",
        "--package",
        `supabase@${SUPABASE_CLI_VERSION}`,
        "--",
        "supabase",
        ...args,
      ],
    };
  }
  return {
    command: "npx",
    args: ["--yes", `supabase@${SUPABASE_CLI_VERSION}`, ...args],
  };
}

export function runPinnedSupabaseCli(
  args,
  { cwd = repositoryRoot, environment = process.env } = {},
) {
  const invocation = buildPinnedInvocation(args, environment);
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd,
      env: buildMinimalChildEnvironment(environment),
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    const stdoutState = { bytes: 0 };
    const stderrState = { bytes: 0 };
    child.stdout.on("data", (chunk) => appendBounded(stdout, stdoutState, chunk));
    child.stderr.on("data", (chunk) => appendBounded(stderr, stderrState, chunk));
    child.once("error", rejectPromise);
    child.once("close", (code) => resolvePromise({
      code: code ?? 1,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
  });
}

function assertFrozenPlan(plan) {
  if (plan.entries.length !== FULL_RESET_EXPECTED_FILE_COUNT) {
    throw new Error(
      `Full-reset migration cardinality drifted: ${plan.entries.length}.`,
    );
  }
  if (
    plan.duplicateOriginalVersionGroups !==
    FULL_RESET_EXPECTED_DUPLICATE_VERSION_GROUPS
  ) {
    throw new Error(
      "Full-reset duplicate-version group cardinality drifted.",
    );
  }
}

function cliFailure(label, result) {
  const details = redactSensitiveText(
    `${result.stderr ?? ""}\n${result.stdout ?? ""}`,
  ).trim().slice(0, 4_000);
  return new Error(`${label} failed.${details ? ` ${details}` : ""}`);
}

export function parseSupabaseStatus(stdout) {
  let status;
  try {
    status = JSON.parse(stdout);
  } catch {
    throw new Error("Supabase status did not return JSON.");
  }
  if (typeof status?.DB_URL !== "string" || !status.DB_URL) {
    throw new Error("Supabase status did not return DB_URL.");
  }
  let databaseUrl;
  try {
    databaseUrl = new URL(status.DB_URL);
  } catch {
    throw new Error("Supabase status returned an invalid DB_URL.");
  }
  if (
    databaseUrl.protocol !== "postgresql:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(databaseUrl.hostname)
  ) {
    throw new Error("Full-reset assertions require a loopback PostgreSQL DB_URL.");
  }
  if (databaseUrl.username !== "postgres" || databaseUrl.pathname !== "/postgres") {
    throw new Error("Full-reset assertions require the disposable postgres database.");
  }
  return status.DB_URL;
}

async function connectToLocalPostgres(databaseUrl) {
  const { Client } = await import("pg");
  const client = new Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 15_000,
    query_timeout: 20_000,
    application_name: "openclaw-task12-full-reset",
  });
  await client.connect();
  return client;
}

function expectedFinanceSnapshotTail(plan) {
  const snapshotIndex = plan.entries.findIndex(
    (entry) =>
      entry.sourceFile === "20260723010000_finance_v2_semantics_snapshot.sql",
  );
  if (snapshotIndex < 0) {
    throw new Error("Finance V2 semantics snapshot migration is missing.");
  }
  return plan.entries
    .slice(Math.max(0, snapshotIndex - 5), snapshotIndex)
    .map((entry) => entry.targetVersion)
    .toSorted(compareUtf8)
    .reverse()
    .join(",");
}

const FULL_RESET_SMOKE_SQL = `
with activation_columns(column_name) as (
  values
    ('feature_enabled'),
    ('limited_auto_reply_enabled'),
    ('proactive_enabled'),
    ('sales_groups_enabled'),
    ('first_contact_enabled')
), activation_state as (
  select expected.column_name, column_row.column_default, column_row.is_nullable
  from activation_columns expected
  left join information_schema.columns column_row
    on column_row.table_schema = 'public'
   and column_row.table_name = 'openclaw_control_states'
   and column_row.column_name = expected.column_name
), browser_dml as (
  select count(*)::integer as count
  from pg_catalog.pg_tables table_row
  cross join (values ('anon'), ('authenticated')) browser_role(role_name)
  cross join (values ('INSERT'), ('UPDATE'), ('DELETE')) operation(privilege_type)
  where table_row.schemaname = 'public'
    and table_row.tablename like 'openclaw\\_%' escape '\\'
    and pg_catalog.has_table_privilege(
      browser_role.role_name,
      pg_catalog.format('%I.%I', table_row.schemaname, table_row.tablename),
      operation.privilege_type
    )
), unsafe_views as (
  select count(*)::integer as count
  from pg_catalog.pg_class class_row
  join pg_catalog.pg_namespace namespace_row
    on namespace_row.oid = class_row.relnamespace
  where namespace_row.nspname = 'public'
    and class_row.relkind = 'v'
    and not coalesce((
      select option_value::boolean
      from pg_catalog.pg_options_to_table(class_row.reloptions)
      where option_name = 'security_invoker'
    ), false)
), public_execute as (
  select count(*)::integer as count
  from pg_catalog.pg_proc procedure_row
  join pg_catalog.pg_namespace namespace_row
    on namespace_row.oid = procedure_row.pronamespace
  cross join lateral pg_catalog.aclexplode(
    coalesce(
      procedure_row.proacl,
      pg_catalog.acldefault('f', procedure_row.proowner)
    )
  ) acl_row
  where namespace_row.nspname in ('public', 'app_private')
    and (
      position('openclaw' in procedure_row.proname) > 0
      or (
        namespace_row.nspname = 'public'
        and procedure_row.proname = 'trg_room_status_reconcile'
      )
    )
    and acl_row.grantee = 0
    and acl_row.privilege_type = 'EXECUTE'
)
select
  (select count(*)::integer
   from pg_catalog.pg_tables
   where schemaname = 'public'
     and tablename like 'openclaw\\_%' escape '\\') as openclaw_table_count,
  (select count from browser_dml) as browser_dml_leak_count,
  (select count from unsafe_views) as unsafe_public_view_count,
  (select count from public_execute) as public_execute_leak_count,
  (select count(*)::integer
   from activation_state
   where column_default is null
      or is_nullable <> 'NO'
      or column_default not in ('false', 'false::boolean')) as bad_activation_default_count,
  (select count(*)::integer
   from public.openclaw_control_states
   where feature_enabled
      or limited_auto_reply_enabled
      or proactive_enabled
      or sales_groups_enabled
      or first_contact_enabled) as enabled_control_row_count,
  (select schema_migrations_tail
   from app_private.finance_v2_semantics_snapshot
   order by captured_at, id
   limit 1) as finance_snapshot_tail
`;

export async function runFullResetSmokeAssertions({
  databaseUrl,
  plan,
  connect = connectToLocalPostgres,
}) {
  const verifiedDatabaseUrl = parseSupabaseStatus(JSON.stringify({
    DB_URL: databaseUrl,
  }));
  const client = await connect(verifiedDatabaseUrl);
  let primaryError;
  try {
    const migrationRows = await client.query(
      "select version from supabase_migrations.schema_migrations order by version",
    );
    const actualVersions = migrationRows.rows.map((row) => String(row.version));
    const expectedVersions = plan.entries
      .map((entry) => entry.targetVersion)
      .toSorted(compareUtf8);
    if (
      actualVersions.length !== expectedVersions.length ||
      actualVersions.some((version, index) => version !== expectedVersions[index])
    ) {
      throw new Error("Full-reset migration identity does not match the 498-file plan.");
    }

    const smoke = await client.query(FULL_RESET_SMOKE_SQL);
    const row = smoke.rows[0];
    if (!row || Number(row.openclaw_table_count) < 1) {
      throw new Error("Full-reset OpenClaw catalog smoke failed.");
    }
    const zeroChecks = [
      ["browser DML", row.browser_dml_leak_count],
      ["unsafe public view", row.unsafe_public_view_count],
      ["PUBLIC EXECUTE", row.public_execute_leak_count],
      ["activation default", row.bad_activation_default_count],
      ["enabled control row", row.enabled_control_row_count],
    ];
    for (const [label, value] of zeroChecks) {
      if (Number(value) !== 0) {
        throw new Error(`Full-reset ${label} smoke failed: ${String(value)}.`);
      }
    }
    const expectedTail = expectedFinanceSnapshotTail(plan);
    if (row.finance_snapshot_tail !== expectedTail) {
      throw new Error("Full-reset migration-history snapshot fidelity failed.");
    }
  } catch (error) {
    primaryError = error;
  }

  let cleanupError;
  try {
    await client.end();
  } catch (error) {
    cleanupError = error;
  }
  if (primaryError || cleanupError) {
    const errors = [primaryError, cleanupError].filter(Boolean);
    throw new AggregateError(
      errors,
      errors.map((error) => String(error?.message ?? error)).join("; "),
    );
  }
}

export async function runFullResetHarness({
  args = process.argv.slice(2),
  environment = process.env,
  dependencies = {},
} = {}) {
  const options = parseFullResetArgs(args);
  const loadInputs = dependencies.loadInputs ?? loadRepositoryMigrationInputs;
  if (options.mode === "plan-only") {
    const plan = buildFullResetPlan(await loadInputs());
    assertFrozenPlan(plan);
    return {
      mode: options.mode,
      summary: `PASS OpenClaw full-reset plan: ${plan.entries.length}-file chain`,
      migrationManifestSha256: plan.aggregateSha256,
    };
  }

  const prepareProject =
    dependencies.prepareProject ?? prepareDisposableFullResetProject;
  const runCli = dependencies.runCli ?? ((cliArgs, cliOptions) =>
    runPinnedSupabaseCli(cliArgs, cliOptions));
  const assertReset = dependencies.assertReset ?? runFullResetSmokeAssertions;
  const prepared = await prepareProject();
  let primaryError;
  let result;
  let shouldStop = false;
  try {
    assertFrozenPlan(prepared.plan);
    const version = await runCli(["--version"], {
      cwd: prepared.root,
      environment,
    });
    if (
      version.code !== 0 ||
      version.stdout.trim() !== SUPABASE_CLI_VERSION
    ) {
      throw cliFailure("Pinned Supabase CLI verification", version);
    }
    shouldStop = true;
    const started = await runCli(
      ["db", "start", "--workdir", prepared.root],
      { cwd: prepared.root, environment },
    );
    if (started.code !== 0) throw cliFailure("Disposable Supabase start", started);
    const reset = await runCli([
      "db",
      "reset",
      "--local",
      "--no-seed",
      "--workdir",
      prepared.root,
    ], { cwd: prepared.root, environment });
    if (reset.code !== 0) throw cliFailure("Complete migration reset", reset);
    const status = await runCli([
      "status",
      "-o",
      "json",
      "--workdir",
      prepared.root,
    ], { cwd: prepared.root, environment });
    if (status.code !== 0) throw cliFailure("Disposable Supabase status", status);
    await assertReset({
      databaseUrl: parseSupabaseStatus(status.stdout),
      plan: prepared.plan,
    });
    result = {
      mode: options.mode,
      summary: `PASS OpenClaw complete ${prepared.plan.entries.length}-file Supabase reset`,
      migrationManifestSha256: prepared.plan.aggregateSha256,
    };
  } catch (error) {
    primaryError = error;
  }

  const cleanupErrors = [];
  if (shouldStop) {
    try {
      const stopped = await runCli(
        ["stop", "--no-backup", "--workdir", prepared.root],
        { cwd: prepared.root, environment },
      );
      if (stopped.code !== 0) {
        cleanupErrors.push(cliFailure("Supabase stop", stopped));
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  try {
    await prepared.cleanup();
  } catch (error) {
    cleanupErrors.push(error);
  }

  if (primaryError || cleanupErrors.length > 0) {
    const errors = [primaryError, ...cleanupErrors].filter(Boolean);
    throw new AggregateError(
      errors,
      errors.map((error) => String(error?.message ?? error)).join("; "),
    );
  }
  return result;
}

async function main() {
  const result = await runFullResetHarness();
  process.stdout.write(`${result.summary}\n`);
  if (result.migrationManifestSha256) {
    process.stdout.write(
      `Migration manifest SHA-256: ${result.migrationManifestSha256}\n`,
    );
  }
}

const entryPoint = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : "";
if (entryPoint === import.meta.url) {
  main().catch((error) => {
    console.error(redactSensitiveText(error?.message ?? error));
    process.exitCode = 1;
  });
}
