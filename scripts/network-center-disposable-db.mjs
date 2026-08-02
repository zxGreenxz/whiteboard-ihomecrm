import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const DISPOSABLE_MARKER_PATTERN =
  /^network-center-disposable:v1:([a-z0-9-]{8,64})$/i;
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost"]);
const MAX_SENTINEL_LIFETIME_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_SENTINEL_LIFETIME_MS = 2 * 60 * 60 * 1_000;
const JANITOR_MIN_AGE_MS = 30 * 60 * 1_000;
const WORKSPACE_PREFIX = "network-center-supabase-";
const DEFAULT_REPO_ROOT = resolve(
  fileURLToPath(new URL("../", import.meta.url)),
);
const DR_SNAPSHOT_BOUNDARY = "20260720000000";
const PRODUCTION_PROJECT_REFS = new Set(["tryymsxyyckgbrmmvozx"]);
const DR_SNAPSHOT_FILES = Object.freeze([
  "scripts/authz-prepared/prod-snapshot/PS04_rbac_org_meter_threshold.sql",
  "scripts/authz-prepared/prod-snapshot/PS01_engine_approval_v2.sql",
  "scripts/authz-prepared/prod-snapshot/PS02_payment_invoice_writers.sql",
  "scripts/authz-prepared/prod-snapshot/PS03_storage_shield.sql",
  "scripts/authz-prepared/prod-snapshot/PS05_misc_remaining.sql",
]);

const PROD_OWNER_ID = "90450d5f-29b6-4897-bdef-cdb5fb53f339";
const DEMO_OWNER_ID = "de6f33f3-349f-4bec-bd3d-106192f6715e";
const DEMO_VIEW_ID = "dddd2000-0000-4000-8000-000000000001";
const DEMO_EXECUTE_ID = "dddd2000-0000-4000-8000-000000000002";
const DEMO_ORG_ID = "dddd0000-0000-4000-8000-000000000001";
const PROD_ORG_ID = "aaaa0000-0000-4000-8000-000000000001";

export const DISPOSABLE_SENTINEL_FILE = ".network-center-disposable.json";
export const SUPABASE_CLI_PACKAGE = "supabase@2.109.1";
export const GLOBAL_DEADLINE_MS = 12 * 60 * 1_000;

const COMMAND_TIMEOUT_CAPS = Object.freeze({
  docker: 15_000,
  start: 4 * 60_000,
  reset: 10 * 60_000,
  query: 10 * 60_000,
  stop: 2 * 60_000,
});

export function assertDisposableTenantTestTarget(
  { projectRef, marker, host, createdAt, expiresAt },
  { productionRefs = new Set(), now = new Date() } = {},
) {
  const normalizedProjectRef = String(projectRef ?? "").trim();
  if (!normalizedProjectRef || productionRefs.has(normalizedProjectRef)) {
    throw new Error("Cross-tenant test refuses production project reference");
  }

  const markerMatch = String(marker ?? "").match(DISPOSABLE_MARKER_PATTERN);
  if (!markerMatch) {
    throw new Error(
      "Cross-tenant test requires an immutable disposable marker",
    );
  }
  if (
    !normalizedProjectRef
      .toLowerCase()
      .endsWith(`-${markerMatch[1].toLowerCase()}`)
  ) {
    throw new Error("Disposable marker does not own the project reference");
  }

  const normalizedHost = String(host ?? "")
    .trim()
    .toLowerCase();
  if (!LOCAL_HOSTS.has(normalizedHost)) {
    throw new Error(
      "Cross-tenant test target must be the per-run local Supabase stack",
    );
  }

  const expiry = new Date(String(expiresAt ?? ""));
  if (Number.isNaN(expiry.getTime())) {
    throw new Error("Disposable database sentinel expiry is invalid");
  }
  const creation = createdAt === undefined ? null : new Date(String(createdAt));
  if (creation && Number.isNaN(creation.getTime())) {
    throw new Error("Disposable database sentinel creation time is invalid");
  }
  if (
    creation &&
    expiry.getTime() - creation.getTime() > MAX_SENTINEL_LIFETIME_MS
  ) {
    throw new Error("Disposable database sentinel cannot exceed 24 hours");
  }
  const remainingLifetime = expiry.getTime() - now.getTime();
  if (remainingLifetime <= 0) {
    throw new Error("Disposable database sentinel has expired");
  }
  if (!creation && remainingLifetime > MAX_SENTINEL_LIFETIME_MS) {
    throw new Error("Disposable database sentinel cannot exceed 24 hours");
  }

  return {
    projectRef: normalizedProjectRef,
    host: normalizedHost,
    runId: markerMatch[1],
    expiresAt: expiry.toISOString(),
  };
}

function validatePort(value, label) {
  if (!Number.isInteger(value) || value < 1_024 || value > 65_535) {
    throw new Error(`${label} must be an unprivileged TCP port`);
  }
}

async function availableLoopbackPort(excluded = new Set()) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const port = await new Promise((resolvePort, reject) => {
      const server = createServer();
      server.unref();
      server.once("error", reject);
      server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
        const address = server.address();
        const selected =
          typeof address === "object" && address ? address.port : null;
        server.close((error) =>
          error ? reject(error) : resolvePort(selected),
        );
      });
    });
    if (Number.isInteger(port) && !excluded.has(port)) return port;
  }
  throw new Error(
    "Unable to allocate unique loopback ports for local Supabase",
  );
}

async function defaultDatabasePorts() {
  const port = await availableLoopbackPort();
  const shadowPort = await availableLoopbackPort(new Set([port]));
  return { port, shadowPort };
}

function defaultRunId() {
  return randomUUID().replaceAll("-", "").slice(0, 16);
}

function defaultProofNonce() {
  return randomBytes(16).toString("hex");
}

function localOnlyEnv(env = process.env) {
  const safe = { ...env };
  for (const key of Object.keys(safe)) {
    if (key.toUpperCase().startsWith("SUPABASE_")) delete safe[key];
  }
  delete safe.SB_ACCESS_TOKEN;
  return safe;
}

export function resolveNpxInvocation({
  platform = process.platform,
  execPath = process.execPath,
  npxCliPath,
} = {}) {
  if (platform === "win32") {
    return {
      command: execPath,
      argsPrefix: [
        npxCliPath ??
          join(dirname(execPath), "node_modules", "npm", "bin", "npx-cli.js"),
      ],
    };
  }
  return { command: "npx", argsPrefix: [] };
}

export async function runCommand({ command, args, cwd, env, timeoutMs }) {
  return new Promise((resolveCommand, reject) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timeout);
      if (timedOut) {
        reject(new Error(`Command timed out after ${timeoutMs}ms: ${command}`));
        return;
      }
      if (exitCode !== 0) {
        const detail =
          stderr.trim() || stdout.trim() || `signal ${signal ?? "unknown"}`;
        reject(
          new Error(`Command failed (${exitCode}): ${command}: ${detail}`),
        );
        return;
      }
      resolveCommand({ stdout, stderr, exitCode });
    });
  });
}

async function runChecked(runner, command) {
  const result = await runner(command);
  if (result?.exitCode !== undefined && result.exitCode !== 0) {
    throw new Error(
      `Command failed (${result.exitCode}): ${command.command}: ${result.stderr || result.stdout || "no output"}`,
    );
  }
  return {
    stdout: String(result?.stdout ?? ""),
    stderr: String(result?.stderr ?? ""),
    exitCode: result?.exitCode ?? 0,
  };
}

function remainingTimeout(deadline, cap) {
  const remaining = Math.floor(deadline.endsAt - deadline.now());
  if (remaining <= 0) {
    throw new Error(
      "Network Center disposable run exceeded its 12-minute global deadline",
    );
  }
  return Math.max(1, Math.min(cap, remaining));
}

function supabaseCommand(invocation, workspace, env, args) {
  return {
    command: invocation.command,
    args: [
      ...invocation.argsPrefix,
      "--yes",
      SUPABASE_CLI_PACKAGE,
      "--workdir",
      workspace,
      ...args,
    ],
    cwd: workspace,
    env,
  };
}

async function runWithinDeadline(runner, deadline, cap, command) {
  return runChecked(runner, {
    ...command,
    timeoutMs: remainingTimeout(deadline, cap),
  });
}

function migrationVersion(index) {
  const date = new Date(Date.UTC(2000, 0, 1) + index * 1_000);
  return date.toISOString().replace(/[-:T]/g, "").slice(0, 14);
}

function sanitizeSnapshotSql(sql) {
  return sql
    .replace(/^\\set\s+ON_ERROR_STOP\s+on\s*$/gim, "")
    .replace(/^\uFEFF/, "")
    .trimStart();
}

function buildBootstrapAuthSql() {
  return `-- Local-only principals required by historical organization migrations.
INSERT INTO auth.users (id, aud, role, email, created_at, updated_at)
VALUES
  ('${PROD_OWNER_ID}', 'authenticated', 'authenticated', 'local.prod.owner@example.invalid', now(), now()),
  ('${DEMO_OWNER_ID}', 'authenticated', 'authenticated', 'demo.chunha@username.ihomecrm.local', now(), now()),
  ('${DEMO_VIEW_ID}', 'authenticated', 'authenticated', 'demo.ketoan@username.ihomecrm.local', now(), now()),
  ('${DEMO_EXECUTE_ID}', 'authenticated', 'authenticated', 'demo.quanly@username.ihomecrm.local', now(), now())
ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, updated_at = now();
`;
}

function buildLocalCatalogPrerequisitesSql() {
  return `-- Local compatibility types required by the documented DR replay order.
CREATE SCHEMA IF NOT EXISTS app_private;

CREATE TABLE IF NOT EXISTS app_private.canonical_write_operations (
  organization_id uuid NOT NULL,
  operation text NOT NULL,
  subject_scope text NOT NULL,
  actor_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  payload_hash text NOT NULL,
  subject_id uuid,
  response_payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE IF NOT EXISTS app_private.income_expense_audit_chain_heads (
  organization_id uuid NOT NULL,
  last_sequence_no bigint DEFAULT 0 NOT NULL,
  last_event_hash text DEFAULT repeat('0', 64) NOT NULL,
  updated_at timestamptz DEFAULT clock_timestamp() NOT NULL
);

CREATE TABLE IF NOT EXISTS app_private.tenant_emergency_denies (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  organization_id uuid NOT NULL,
  permission_key text,
  active_from timestamptz DEFAULT clock_timestamp() NOT NULL,
  expires_at timestamptz,
  reason text NOT NULL,
  created_by uuid,
  created_at timestamptz DEFAULT clock_timestamp() NOT NULL
);
`;
}

function buildLocalCatalogGrantFinalizerSql() {
  return `-- Reproduce the reviewed PostgreSQL 17 dual-grant catalog exactly.
GRANT ie_canonical_writer TO postgres
  WITH ADMIN TRUE, INHERIT FALSE, SET FALSE
  GRANTED BY supabase_admin;
`;
}

async function loadReplayEntries(repoRoot) {
  const migrationRoot = join(repoRoot, "supabase", "migrations");
  const sourceNames = (await readdir(migrationRoot, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort();
  const sourceEntries = await Promise.all(
    sourceNames.map(async (name) => ({
      kind: "repo",
      source: name,
      body: await readFile(join(migrationRoot, name), "utf8"),
    })),
  );
  const snapshotEntries = await Promise.all(
    DR_SNAPSHOT_FILES.map(async (file) => ({
      kind: "dr",
      source: basename(file),
      body: sanitizeSnapshotSql(await readFile(join(repoRoot, file), "utf8")),
    })),
  );

  const before = sourceEntries.filter(
    (entry) => entry.source < DR_SNAPSHOT_BOUNDARY,
  );
  const after = sourceEntries.filter(
    (entry) => entry.source >= DR_SNAPSHOT_BOUNDARY,
  );
  const ordered = [
    {
      kind: "bootstrap",
      source: "local_auth_principals.sql",
      body: buildBootstrapAuthSql(),
    },
    ...before,
    {
      kind: "prerequisite",
      source: "local_catalog_prerequisites.sql",
      body: buildLocalCatalogPrerequisitesSql(),
    },
    ...snapshotEntries,
    {
      kind: "finalizer",
      source: "local_catalog_grants.sql",
      body: buildLocalCatalogGrantFinalizerSql(),
    },
    ...after,
  ];
  const entries = ordered.map((entry, index) => {
    const source = entry.source.replace(/[^a-zA-Z0-9_.-]/g, "_");
    return {
      ...entry,
      target: `${migrationVersion(index)}_${entry.kind}_${source}`,
    };
  });
  const hash = createHash("sha256");
  for (const entry of entries) {
    hash.update(entry.kind).update("\0").update(entry.source).update("\0");
    hash.update(entry.body).update("\0");
  }
  return {
    entries,
    manifestSha256: hash.digest("hex"),
    networkCenterMigrationCount: sourceEntries.filter((entry) =>
      entry.source.includes("network_center"),
    ).length,
  };
}

function buildLocalConfig(projectRef, { port, shadowPort }) {
  return `project_id = "${projectRef}"

[db]
port = ${port}
shadow_port = ${shadowPort}
major_version = 17

[db.seed]
enabled = true
sql_paths = ["./seed.sql"]
`;
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function buildSeedSql({
  proofNonce,
  manifestSha256,
  migrationCount,
  networkCenterMigrationCount,
}) {
  return `-- Local-only deterministic fixtures for the rollback authorization matrix.
BEGIN;

INSERT INTO auth.users (id, aud, role, email, created_at, updated_at)
VALUES
  ('${PROD_OWNER_ID}', 'authenticated', 'authenticated', 'local.prod.owner@example.invalid', now(), now()),
  ('${DEMO_OWNER_ID}', 'authenticated', 'authenticated', 'demo.chunha@username.ihomecrm.local', now(), now()),
  ('${DEMO_VIEW_ID}', 'authenticated', 'authenticated', 'demo.ketoan@username.ihomecrm.local', now(), now()),
  ('${DEMO_EXECUTE_ID}', 'authenticated', 'authenticated', 'demo.quanly@username.ihomecrm.local', now(), now())
ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, updated_at = now();

INSERT INTO public.organizations (id, slug, name, status, is_demo, created_by)
VALUES
  ('${DEMO_ORG_ID}', 'ihome-demo', 'iHome CRM (Demo)', 'ACTIVE', true, '${DEMO_OWNER_ID}'),
  ('${PROD_ORG_ID}', 'ihome-prod', 'iHome CRM', 'ACTIVE', false, '${PROD_OWNER_ID}')
ON CONFLICT (id) DO UPDATE SET status = 'ACTIVE', updated_at = now();

INSERT INTO public.profiles (id, full_name, email, organization_id)
VALUES
  ('${PROD_OWNER_ID}', 'Local Production Owner', 'local.prod.owner@example.invalid', '${PROD_ORG_ID}'),
  ('${DEMO_OWNER_ID}', 'DEMO Chu Nha', 'demo.chunha@username.ihomecrm.local', '${DEMO_ORG_ID}'),
  ('${DEMO_VIEW_ID}', 'DEMO Ke Toan', 'demo.ketoan@username.ihomecrm.local', '${DEMO_ORG_ID}'),
  ('${DEMO_EXECUTE_ID}', 'DEMO Quan Ly', 'demo.quanly@username.ihomecrm.local', '${DEMO_ORG_ID}')
ON CONFLICT (id) DO UPDATE SET organization_id = EXCLUDED.organization_id, email = EXCLUDED.email;

INSERT INTO public.organization_memberships (
  organization_id, user_id, member_type, status, valid_from, activated_at
) VALUES
  ('${PROD_ORG_ID}', '${PROD_OWNER_ID}', 'OWNER', 'ACTIVE', now(), now()),
  ('${DEMO_ORG_ID}', '${DEMO_OWNER_ID}', 'OWNER', 'ACTIVE', now(), now()),
  ('${DEMO_ORG_ID}', '${DEMO_VIEW_ID}', 'STAFF', 'ACTIVE', now(), now()),
  ('${DEMO_ORG_ID}', '${DEMO_EXECUTE_ID}', 'STAFF', 'ACTIVE', now(), now())
ON CONFLICT (organization_id, user_id) WHERE status IN ('INVITED','ACTIVE')
DO UPDATE SET
  member_type = EXCLUDED.member_type,
  status = 'ACTIVE',
  valid_from = EXCLUDED.valid_from,
  valid_to = NULL,
  activated_at = EXCLUDED.activated_at,
  revoked_at = NULL,
  version = public.organization_memberships.version + 1;

INSERT INTO public.buildings (
  id, user_id, organization_id, name, code, province, district, ward,
  total_floors, total_rooms, is_virtual
) VALUES
  ('dddd1000-0000-4000-8000-000000000001', '${DEMO_OWNER_ID}', '${DEMO_ORG_ID}', 'DEMO-NC-BUILDING-A', 'DEMO-NC-A', 'Local', 'Local', 'Local', 1, 1, false),
  ('dddd1000-0000-4000-8000-000000000002', '${DEMO_OWNER_ID}', '${DEMO_ORG_ID}', 'DEMO-NC-BUILDING-B', 'DEMO-NC-B', 'Local', 'Local', 'Local', 1, 1, false),
  ('aaaa1000-0000-4000-8000-000000000001', '${PROD_OWNER_ID}', '${PROD_ORG_ID}', 'PROD-NC-READ-ONLY', 'PROD-NC-RO', 'Local', 'Local', 'Local', 1, 1, false)
ON CONFLICT (id) DO UPDATE SET organization_id = EXCLUDED.organization_id, deleted_at = NULL, is_virtual = false;

INSERT INTO public.authorization_scopes (organization_id, scope_type)
VALUES
  ('${DEMO_ORG_ID}', 'ORGANIZATION'),
  ('${PROD_ORG_ID}', 'ORGANIZATION')
ON CONFLICT DO NOTHING;
INSERT INTO public.authorization_scopes (organization_id, scope_type, building_id)
VALUES
  ('${DEMO_ORG_ID}', 'BUILDING', 'dddd1000-0000-4000-8000-000000000001'),
  ('${DEMO_ORG_ID}', 'BUILDING', 'dddd1000-0000-4000-8000-000000000002'),
  ('${PROD_ORG_ID}', 'BUILDING', 'aaaa1000-0000-4000-8000-000000000001')
ON CONFLICT DO NOTHING;

INSERT INTO public.network_devices (
  organization_id, building_id, device_kind, external_key, display_name,
  vendor, lifecycle_status, write_capability, is_active
) VALUES
  ('${DEMO_ORG_ID}', 'dddd1000-0000-4000-8000-000000000001', 'MIKROTIK', 'slot:primary', 'DEMO Router A', 'MikroTik', 'UNPROVISIONED', true, true),
  ('${DEMO_ORG_ID}', 'dddd1000-0000-4000-8000-000000000002', 'MIKROTIK', 'slot:primary', 'DEMO Router B', 'MikroTik', 'UNPROVISIONED', true, true)
ON CONFLICT DO NOTHING;

INSERT INTO public.network_site_settings (organization_id, building_id)
VALUES
  ('${DEMO_ORG_ID}', 'dddd1000-0000-4000-8000-000000000001'),
  ('${DEMO_ORG_ID}', 'dddd1000-0000-4000-8000-000000000002')
ON CONFLICT DO NOTHING;

DO $proof_preflight$
DECLARE
  actual_migrations integer;
  actual_network_center integer;
BEGIN
  SELECT count(*) INTO actual_migrations
  FROM supabase_migrations.schema_migrations;
  SELECT count(*) INTO actual_network_center
  FROM supabase_migrations.schema_migrations
  WHERE name LIKE '%network_center%';
  IF actual_migrations <> ${migrationCount}
     OR actual_network_center <> ${networkCenterMigrationCount} THEN
    RAISE EXCEPTION 'Disposable migration replay incomplete: total %/% network-center %/%',
      actual_migrations, ${migrationCount}, actual_network_center, ${networkCenterMigrationCount};
  END IF;
END
$proof_preflight$;

CREATE TABLE IF NOT EXISTS app_private.network_center_disposable_proof (
  proof_nonce text PRIMARY KEY,
  migration_manifest_sha256 text NOT NULL,
  migration_count integer NOT NULL,
  network_center_migration_count integer NOT NULL,
  seeded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON app_private.network_center_disposable_proof FROM PUBLIC, anon, authenticated, service_role;
INSERT INTO app_private.network_center_disposable_proof (
  proof_nonce, migration_manifest_sha256, migration_count, network_center_migration_count
) VALUES (
  ${sqlLiteral(proofNonce)}, ${sqlLiteral(manifestSha256)},
  ${migrationCount}, ${networkCenterMigrationCount}
);

COMMIT;
`;
}

async function prepareDisposableWorkspace({
  repoRoot,
  tempRoot,
  now,
  runId,
  proofNonce,
  lifetimeMs,
  databasePorts,
}) {
  if (
    !Number.isInteger(lifetimeMs) ||
    lifetimeMs <= 0 ||
    lifetimeMs > MAX_SENTINEL_LIFETIME_MS
  ) {
    throw new Error(
      "Disposable database sentinel lifetime must be within 24 hours",
    );
  }
  const selectedRunId = String(runId()).trim().toLowerCase();
  if (!/^[a-z0-9-]{8,64}$/.test(selectedRunId)) {
    throw new Error("Disposable Supabase run ID is invalid");
  }
  const selectedProofNonce = String(proofNonce()).trim().toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(selectedProofNonce)) {
    throw new Error("Disposable Supabase proof nonce is invalid");
  }
  const projectRef = `network-center-${selectedRunId}`;
  const ports = await databasePorts();
  validatePort(ports.port, "Local database port");
  validatePort(ports.shadowPort, "Local shadow database port");
  if (ports.port === ports.shadowPort) {
    throw new Error("Local database and shadow database ports must differ");
  }
  const replay = await loadReplayEntries(repoRoot);

  await mkdir(tempRoot, { recursive: true });
  const workspace = await mkdtemp(join(resolve(tempRoot), WORKSPACE_PREFIX));
  const createdAt = new Date(now());
  if (Number.isNaN(createdAt.getTime()))
    throw new Error("Disposable clock is invalid");
  const sentinel = Object.freeze({
    marker: `network-center-disposable:v1:${selectedRunId}`,
    projectRef,
    host: "127.0.0.1",
    workspaceName: basename(workspace),
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + lifetimeMs).toISOString(),
    proofNonce: selectedProofNonce,
    migrationManifestSha256: replay.manifestSha256,
    migrationCount: replay.entries.length,
    networkCenterMigrationCount: replay.networkCenterMigrationCount,
  });
  await writeFile(
    join(workspace, DISPOSABLE_SENTINEL_FILE),
    `${JSON.stringify(sentinel, null, 2)}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );

  try {
    assertDisposableTenantTestTarget(sentinel, {
      productionRefs: PRODUCTION_PROJECT_REFS,
      now: createdAt,
    });
    const localSupabase = join(workspace, "supabase");
    const localMigrations = join(localSupabase, "migrations");
    await mkdir(localMigrations, { recursive: true });
    for (const entry of replay.entries) {
      await writeFile(join(localMigrations, entry.target), entry.body, {
        encoding: "utf8",
        flag: "wx",
      });
    }
    await writeFile(
      join(localSupabase, "config.toml"),
      buildLocalConfig(projectRef, ports),
      {
        encoding: "utf8",
        flag: "wx",
      },
    );
    await writeFile(
      join(localSupabase, "seed.sql"),
      buildSeedSql({
        proofNonce: selectedProofNonce,
        manifestSha256: replay.manifestSha256,
        migrationCount: replay.entries.length,
        networkCenterMigrationCount: replay.networkCenterMigrationCount,
      }),
      { encoding: "utf8", flag: "wx" },
    );
    return { workspace, sentinel, projectRef };
  } catch (error) {
    try {
      await cleanupOwnedDisposableWorkspace({ workspace, tempRoot, sentinel });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `${error instanceof Error ? error.message : String(error)}; disposable workspace cleanup also failed`,
      );
    }
    throw error;
  }
}

async function readOwnedSentinel(workspace, tempRoot) {
  const normalizedWorkspace = resolve(workspace);
  const normalizedTempRoot = resolve(tempRoot);
  if (
    dirname(normalizedWorkspace) !== normalizedTempRoot ||
    !basename(normalizedWorkspace).startsWith(WORKSPACE_PREFIX)
  ) {
    throw new Error(
      "Disposable cleanup target must be an owned direct child of the temp root",
    );
  }
  const [rootRealPath, parentRealPath, workspaceStat] = await Promise.all([
    realpath(normalizedTempRoot),
    realpath(dirname(normalizedWorkspace)),
    lstat(normalizedWorkspace),
  ]);
  if (
    rootRealPath !== parentRealPath ||
    !workspaceStat.isDirectory() ||
    workspaceStat.isSymbolicLink()
  ) {
    throw new Error(
      "Disposable cleanup target must be a direct non-symlink directory",
    );
  }
  const markerPath = join(normalizedWorkspace, DISPOSABLE_SENTINEL_FILE);
  const markerStat = await lstat(markerPath);
  if (!markerStat.isFile() || markerStat.isSymbolicLink()) {
    throw new Error(
      "Disposable cleanup requires the immutable ownership marker file",
    );
  }
  const sentinel = JSON.parse(await readFile(markerPath, "utf8"));
  if (sentinel.workspaceName !== basename(normalizedWorkspace)) {
    throw new Error(
      "Disposable ownership marker does not belong to this workspace",
    );
  }
  const markerMatch = String(sentinel.marker ?? "").match(
    DISPOSABLE_MARKER_PATTERN,
  );
  if (
    !markerMatch ||
    sentinel.projectRef !== `network-center-${markerMatch[1]}` ||
    sentinel.host !== "127.0.0.1"
  ) {
    throw new Error("Disposable ownership marker identity is invalid");
  }
  const createdAt = new Date(sentinel.createdAt);
  const expiresAt = new Date(sentinel.expiresAt);
  if (
    Number.isNaN(createdAt.getTime()) ||
    Number.isNaN(expiresAt.getTime()) ||
    expiresAt.getTime() <= createdAt.getTime() ||
    expiresAt.getTime() - createdAt.getTime() > MAX_SENTINEL_LIFETIME_MS
  ) {
    throw new Error("Disposable ownership marker lifetime is invalid");
  }
  return { sentinel, normalizedWorkspace };
}

export async function cleanupOwnedDisposableWorkspace({
  workspace,
  tempRoot,
  sentinel,
}) {
  const owned = await readOwnedSentinel(workspace, tempRoot);
  if (!isDeepStrictEqual(owned.sentinel, sentinel)) {
    throw new Error(
      "Disposable cleanup ownership marker changed; refusing recursive removal",
    );
  }
  await rm(owned.normalizedWorkspace, { recursive: true, force: false });
}

function quoteManualArgument(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function manualCleanupCommand(workspace, projectRef) {
  return `npx --yes ${SUPABASE_CLI_PACKAGE} --workdir ${quoteManualArgument(workspace)} stop --project-id ${projectRef} --no-backup`;
}

function stopFailureError(error, workspace, projectRef) {
  const reason = error instanceof Error ? error.message : String(error);
  return new Error(
    `${reason}. Ownership evidence retained. Manual cleanup: ${manualCleanupCommand(workspace, projectRef)}`,
    { cause: error },
  );
}

async function stopExactProject({
  runner,
  deadline,
  invocation,
  workspace,
  projectRef,
  env,
}) {
  try {
    await runWithinDeadline(
      runner,
      deadline,
      COMMAND_TIMEOUT_CAPS.stop,
      supabaseCommand(invocation, workspace, env, [
        "stop",
        "--project-id",
        projectRef,
        "--no-backup",
      ]),
    );
  } catch (error) {
    throw stopFailureError(error, workspace, projectRef);
  }
}

async function janitorOwnedDisposableWorkspaces({
  tempRoot,
  now,
  runner,
  deadline,
  invocation,
  env,
}) {
  await mkdir(tempRoot, { recursive: true });
  const entries = await readdir(tempRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(WORKSPACE_PREFIX))
      continue;
    const workspace = join(tempRoot, entry.name);
    let owned;
    try {
      owned = await readOwnedSentinel(workspace, tempRoot);
    } catch {
      continue;
    }
    const age = now().getTime() - new Date(owned.sentinel.createdAt).getTime();
    if (age < JANITOR_MIN_AGE_MS) continue;
    await stopExactProject({
      runner,
      deadline,
      invocation,
      workspace,
      projectRef: owned.sentinel.projectRef,
      env,
    });
    await cleanupOwnedDisposableWorkspace({
      workspace,
      tempRoot,
      sentinel: owned.sentinel,
    });
  }
}

export async function runDisposableSupabaseMatrix({
  buildSql,
  parseVerdict,
  runner = runCommand,
  repoRoot = DEFAULT_REPO_ROOT,
  tempRoot = tmpdir(),
  now = () => new Date(),
  monotonicNow = () => performance.now(),
  runId = defaultRunId,
  proofNonce = defaultProofNonce,
  databasePorts = defaultDatabasePorts,
  lifetimeMs = DEFAULT_SENTINEL_LIFETIME_MS,
  env = process.env,
  npxInvocation = resolveNpxInvocation(),
} = {}) {
  if (typeof buildSql !== "function" || typeof parseVerdict !== "function") {
    throw new Error(
      "Disposable Supabase matrix requires SQL builder and verdict parser",
    );
  }
  const safeEnv = localOnlyEnv(env);
  const deadline = {
    now: monotonicNow,
    endsAt: monotonicNow() + GLOBAL_DEADLINE_MS,
  };
  try {
    await runWithinDeadline(runner, deadline, COMMAND_TIMEOUT_CAPS.docker, {
      command: "docker",
      args: ["version", "--format", "{{.Server.Version}}"],
      cwd: repoRoot,
      env: safeEnv,
    });
  } catch (error) {
    throw new Error(
      "Docker is required for --local-disposable; no production config or network access was attempted.",
      { cause: error },
    );
  }

  await janitorOwnedDisposableWorkspaces({
    tempRoot: resolve(tempRoot),
    now,
    runner,
    deadline,
    invocation: npxInvocation,
    env: safeEnv,
  });
  const prepared = await prepareDisposableWorkspace({
    repoRoot: resolve(repoRoot),
    tempRoot: resolve(tempRoot),
    now,
    runId,
    proofNonce,
    lifetimeMs,
    databasePorts,
  });
  const localProof = Object.freeze({
    proofNonce: prepared.sentinel.proofNonce,
    migrationManifestSha256: prepared.sentinel.migrationManifestSha256,
    migrationCount: prepared.sentinel.migrationCount,
    networkCenterMigrationCount: prepared.sentinel.networkCenterMigrationCount,
  });
  const sqlPath = join(prepared.workspace, "network-center-cross-tenant.sql");
  let primaryError;
  let cleanupError;
  let verdict;

  try {
    await writeFile(sqlPath, buildSql({ localProof }), {
      encoding: "utf8",
      flag: "wx",
    });
    await runWithinDeadline(
      runner,
      deadline,
      COMMAND_TIMEOUT_CAPS.start,
      supabaseCommand(npxInvocation, prepared.workspace, safeEnv, [
        "db",
        "start",
      ]),
    );
    await runWithinDeadline(
      runner,
      deadline,
      COMMAND_TIMEOUT_CAPS.reset,
      supabaseCommand(npxInvocation, prepared.workspace, safeEnv, [
        "db",
        "reset",
        "--local",
      ]),
    );
    const queryResult = await runWithinDeadline(
      runner,
      deadline,
      COMMAND_TIMEOUT_CAPS.query,
      supabaseCommand(npxInvocation, prepared.workspace, safeEnv, [
        "--output",
        "json",
        "db",
        "query",
        "--local",
        "--file",
        sqlPath,
      ]),
    );
    verdict = parseVerdict(queryResult.stdout, {
      expectedLocalProof: localProof,
    });
  } catch (error) {
    primaryError = error;
  } finally {
    try {
      await stopExactProject({
        runner,
        deadline,
        invocation: npxInvocation,
        workspace: prepared.workspace,
        projectRef: prepared.projectRef,
        env: safeEnv,
      });
      await cleanupOwnedDisposableWorkspace({
        workspace: prepared.workspace,
        tempRoot,
        sentinel: prepared.sentinel,
      });
    } catch (error) {
      cleanupError = error;
    }
  }

  if (primaryError || cleanupError) {
    if (!cleanupError) throw primaryError;
    const primaryMessage =
      primaryError instanceof Error ? `${primaryError.message}; ` : "";
    throw new AggregateError(
      primaryError ? [primaryError, cleanupError] : [cleanupError],
      `${primaryMessage}${cleanupError.message}`,
    );
  }
  return verdict;
}
