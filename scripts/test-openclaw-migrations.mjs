import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";

import { redactSensitiveText } from "./test-openclaw-sql.mjs";
import {
  buildGeneratedTypesFile,
  buildMinimalChildEnvironment,
  buildSupabaseCliInvocation,
  captureCliOutput,
  extractSupabaseAccessToken,
} from "./gen-supabase-types.mjs";

export const SUPABASE_CLI_VERSION = "2.109.1";
export const EXPECTED_PROJECT_REF = "tryymsxyyckgbrmmvozx";
export const DEMO_ORG_ID = "dddd0000-0000-4000-8000-000000000001";
export const PROD_ORG_ID = "aaaa0000-0000-4000-8000-000000000001";
export const FORWARD_CORRECTIVE_INSTRUCTION =
  "Stop rollout; preserve applied evidence. Do not down-migrate or rewrite migration history. Ship only a separately reviewed forward corrective migration.";
export const MIGRATION_MANIFEST_DOMAIN =
  "ihome-openclaw-migration-manifest-v1";
export const OPENCLAW_MIGRATIONS = Object.freeze([
  "20260727010000_openclaw_catalog_foundation.sql",
  "20260727015000_openclaw_security_principals.sql",
  "20260727020000_openclaw_inbox_schema.sql",
  "20260727025000_openclaw_inbound_automation.sql",
  "20260727030000_openclaw_policy_automation_knowledge.sql",
  "20260727040000_openclaw_delivery_audit_ops.sql",
  "20260727050000_openclaw_access_policies.sql",
  "20260727060000_openclaw_rpc_surface.sql",
  "20260727070000_openclaw_crm_event_sources.sql",
  "20260727080000_openclaw_realtime_allowlist.sql",
  "20260727090000_openclaw_maintenance_jobs.sql",
  "20260727095000_openclaw_activation_guards.sql",
]);
export const SQL_AUTHORIZATION_PROOFS = Object.freeze([
  "membership.inactive-revoked",
  "permissions.mixed",
  "tenant.wrong-account",
  "tenant.composite-fk",
  "qr.unique",
  "outbox-work.claim-cas",
  "marker.mint-consume-ttl",
  "completion-requeue.serialization",
  "inbound.atomic-commit",
  "work-outbox.atomic-rollback",
  "policy.stale-rejected",
  "audit.immutability-receipt",
  "retention.hold-version-receipt",
  "rollout.stage-cas",
  "realtime.safe-publication",
  "operation.scope-separation",
  "claims.non-null-lineage",
  "maintenance.channel-paused",
  "tenant.cross-org-stale-credential",
]);
export const BROWSER_DML_PRIVILEGE_MATRIX = Object.freeze([
  Object.freeze({ role: "anon", privilege: "INSERT" }),
  Object.freeze({ role: "anon", privilege: "UPDATE" }),
  Object.freeze({ role: "anon", privilege: "DELETE" }),
  Object.freeze({ role: "authenticated", privilege: "INSERT" }),
  Object.freeze({ role: "authenticated", privilege: "UPDATE" }),
  Object.freeze({ role: "authenticated", privilege: "DELETE" }),
]);

const repositoryRoot = resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

export const OPENCLAW_DISPOSABLE_FIXTURE_SQL = `
  create schema if not exists extensions;
  create extension if not exists pgcrypto with schema extensions;
  create schema if not exists app_private;
  create schema if not exists auth;
  do $roles$
  begin
    if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
    if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
    if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin; end if;
  end
  $roles$;
  create or replace function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
  $$;
  create table auth.users (id uuid primary key default gen_random_uuid());
  create or replace function public.my_org_ids() returns uuid[] language sql stable as $$
    select '{}'::uuid[]
  $$;
  create table public.organizations (
    id uuid primary key default gen_random_uuid(),
    name text not null default ''
  );
  create table public.leads (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid references public.organizations(id),
    assigned_staff_id uuid,
    customer_name text,
    phone text,
    building_id uuid,
    room_id uuid,
    status text not null default 'NEW',
    source text,
    created_at timestamptz not null default statement_timestamp(),
    updated_at timestamptz not null default statement_timestamp(),
    deleted_at timestamptz
  );
  create table public.rooms (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid references public.organizations(id),
    building_id uuid,
    name text,
    code text,
    status text not null default 'RESERVED',
    updated_at timestamptz not null default statement_timestamp(),
    deleted_at timestamptz
  );
  create table public.lead_activities (
    id uuid primary key default gen_random_uuid(),
    lead_id uuid not null references public.leads(id),
    organization_id uuid references public.organizations(id),
    activity_type text not null,
    scheduled_at timestamp without time zone,
    completed_at timestamp without time zone
  );
  alter table public.leads enable row level security;
  alter table public.rooms enable row level security;
  alter table public.lead_activities enable row level security;
  create table public.pglite_room_reconcile_modes (
    room_id uuid primary key references public.rooms(id),
    final_status text not null
  );
  create or replace function public.recompute_room_reservation(p_room_id uuid)
    returns void language plpgsql security definer set search_path='' as $function$
    declare v_final_status text;
    begin
      select mode.final_status into v_final_status
      from public.pglite_room_reconcile_modes mode where mode.room_id=p_room_id;
      if found then
        update public.rooms set status=v_final_status,updated_at=statement_timestamp()
        where id=p_room_id;
      end if;
    end;
    $function$;
  create table public.permission_definitions (
    key text primary key,
    resource text not null,
    action text not null,
    sensitivity text not null,
    permission_domain text not null,
    scope_kinds text[] not null default '{}',
    is_active boolean not null default true,
    requires_cashbook_possession boolean not null default false,
    accepted_possession_kinds text[] not null default '{}',
    required_dimensions text[] not null default '{}'
  );
  create table public.organization_roles (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id),
    is_system boolean not null default false,
    status text not null default 'ACTIVE',
    name text not null default '',
    unique (organization_id,id)
  );
  create table public.role_permissions (
    organization_id uuid not null,
    role_id uuid not null,
    permission_key text not null,
    effect text not null,
    primary key (organization_id,role_id,permission_key)
  );
  create table public.organization_memberships (
    id uuid not null default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id),
    user_id uuid,
    member_type text not null default 'USER',
    status text not null default 'ACTIVE',
    primary key (organization_id,id)
  );
  create table public.role_bindings (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null,
    membership_id uuid not null,
    role_id uuid not null,
    valid_from timestamptz not null default statement_timestamp(),
    valid_to timestamptz,
    unique (organization_id,id),
    foreign key (organization_id,membership_id)
      references public.organization_memberships(organization_id,id),
    foreign key (organization_id,role_id)
      references public.organization_roles(organization_id,id)
  );
  create table public.authorization_scopes (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id),
    scope_type text not null check (scope_type in ('ORGANIZATION','BUILDING')),
    building_id uuid,
    unique (organization_id,id),
    check (
      (scope_type='ORGANIZATION' and building_id is null)
      or (scope_type='BUILDING' and building_id is not null)
    )
  );
  create table public.role_binding_scopes (
    organization_id uuid not null,
    role_binding_id uuid not null,
    scope_id uuid not null,
    primary key (role_binding_id,scope_id),
    foreign key (organization_id,role_binding_id)
      references public.role_bindings(organization_id,id),
    foreign key (organization_id,scope_id)
      references public.authorization_scopes(organization_id,id)
  );
  create or replace function app_private.lock_org_for_decision_v1(uuid)
    returns void language sql security definer set search_path='' as $$ select $$;
  create or replace function app_private.require_perm_v1(uuid,text,text)
    returns void language plpgsql security definer set search_path='' as $$
      begin
        if not coalesce((select decision.allowed
          from app_private.authorize_tenant_action_v3(
            auth.uid(),$1,$2,null,null
          ) decision),false) then
          raise exception 'permission denied' using errcode='42501';
        end if;
      end
    $$;
  create or replace function app_private.authorize_tenant_action_v3(
    p_user uuid,p_org uuid,p_permission text,p_building uuid,p_cashbook uuid
  ) returns table(allowed boolean)
    language sql stable security definer set search_path='' as $$
      select exists (
        select 1
        from public.organization_memberships membership
        join public.role_bindings binding
          on binding.organization_id=membership.organization_id
         and binding.membership_id=membership.id
         and binding.valid_from<=statement_timestamp()
         and (binding.valid_to is null or binding.valid_to>statement_timestamp())
        join public.organization_roles role
          on role.organization_id=binding.organization_id
         and role.id=binding.role_id and role.status='ACTIVE'
        join public.role_permissions permission
          on permission.organization_id=role.organization_id
         and permission.role_id=role.id
         and permission.permission_key=p_permission
         and permission.effect='ALLOW'
        join public.permission_definitions definition
          on definition.key=permission.permission_key and definition.is_active
        join public.role_binding_scopes binding_scope
          on binding_scope.organization_id=binding.organization_id
         and binding_scope.role_binding_id=binding.id
        join public.authorization_scopes scope
          on scope.organization_id=binding_scope.organization_id
         and scope.id=binding_scope.scope_id
        where membership.user_id=p_user and membership.organization_id=p_org
          and membership.status='ACTIVE'
          and (scope.scope_type='ORGANIZATION'
            or (scope.scope_type='BUILDING' and scope.building_id=p_building))
          and not exists (
            select 1 from public.role_bindings deny_binding
            join public.organization_roles deny_role
              on deny_role.organization_id=deny_binding.organization_id
             and deny_role.id=deny_binding.role_id and deny_role.status='ACTIVE'
            join public.role_permissions deny_permission
              on deny_permission.organization_id=deny_role.organization_id
             and deny_permission.role_id=deny_role.id
             and deny_permission.permission_key=p_permission
             and deny_permission.effect='DENY'
            where deny_binding.organization_id=membership.organization_id
              and deny_binding.membership_id=membership.id
              and deny_binding.valid_from<=statement_timestamp()
              and (deny_binding.valid_to is null
                or deny_binding.valid_to>statement_timestamp())
          )
      )
    $$;
  create or replace function app_private.authorized_scope_v3(p_permission text,p_org uuid)
    returns table(org_wide boolean,building_ids uuid[],cashbook_ids uuid[])
    language sql stable security definer set search_path='' as $$
      select coalesce((select decision.allowed
          from app_private.authorize_tenant_action_v3(
            auth.uid(),p_org,p_permission,null,null
          ) decision),false),
        '{}'::uuid[], '{}'::uuid[]
    $$;
  create publication supabase_realtime;
`;

function capture(command, args, cwd = repositoryRoot, environment = process.env) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
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
    child.once("close", (code) =>
      resolvePromise({
        code: code ?? 1,
        stdoutBuffer: Buffer.concat(stdout),
        stderrBuffer: Buffer.concat(stderr),
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      }),
    );
  });
}

export function computeOpenClawMigrationManifest(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("OpenClaw migration manifest cannot be empty.");
  }
  const normalizedEntries = entries.map(({ file, bytes }, index) => {
    if (!/^\d{14}_[a-z0-9_]+\.sql$/.test(file ?? "")) {
      throw new Error(`Invalid migration file at manifest position ${index + 1}.`);
    }
    const rawBytes = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? "");
    const version = file.slice(0, 14);
    const name = file.slice(15, -4);
    return {
      order: index + 1,
      file,
      version,
      name,
      sha256: createHash("sha256").update(rawBytes).digest("hex"),
      bytes: rawBytes,
    };
  });
  const manifestLines = normalizedEntries
    .map((entry) => `${entry.file}:${entry.sha256}\n`)
    .join("");
  const aggregateSha256 = createHash("sha256")
    .update(MIGRATION_MANIFEST_DOMAIN)
    .update(Buffer.from([0]))
    .update(manifestLines)
    .digest("hex");
  return { entries: normalizedEntries, aggregateSha256 };
}

export async function loadReviewedMigrationManifest(
  reviewedSha,
  { runGit = capture } = {},
) {
  const commit = await runGit("git", ["cat-file", "-e", `${reviewedSha}^{commit}`]);
  if (commit.code !== 0) {
    throw new Error("Reviewed SHA is not an available Git commit.");
  }
  const tree = await runGit("git", [
    "ls-tree",
    "-r",
    "--name-only",
    reviewedSha,
    "--",
    "supabase/migrations",
  ]);
  if (tree.code !== 0) throw new Error("Could not inspect the reviewed migration tree.");
  const reviewedOpenClawFiles = tree.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((path) => path.split("/").at(-1))
    .filter((file) => /^20260727\d{6}_openclaw_[a-z0-9_]+\.sql$/.test(file));
  if (JSON.stringify(reviewedOpenClawFiles) !== JSON.stringify(OPENCLAW_MIGRATIONS)) {
    throw new Error("Reviewed tree does not contain the exact ordered twelve-file manifest.");
  }
  const entries = [];
  for (const file of OPENCLAW_MIGRATIONS) {
    const blob = await runGit("git", [
      "cat-file",
      "blob",
      `${reviewedSha}:supabase/migrations/${file}`,
    ]);
    if (blob.code !== 0) throw new Error(`Reviewed migration blob is missing: ${file}`);
    entries.push({ file, bytes: blob.stdoutBuffer ?? Buffer.from(blob.stdout, "utf8") });
  }
  return computeOpenClawMigrationManifest(entries);
}

export function parseMigrationHarnessArgs(args) {
  if (args[0] === "--local" && args.length === 1) return { mode: "local" };
  if (args[0] === "--local-file" && args.length === 2) {
    const file = basename(args[1]);
    if (!OPENCLAW_MIGRATIONS.includes(file)) {
      throw new Error("Local migration file is outside the reviewed twelve-file manifest.");
    }
    return { mode: "local-file", file };
  }
  if (args[0] === "--schema-drift") {
    for (const flag of ["--project-ref", "--reviewed-sha"]) {
      if (args.filter((value) => value === flag).length !== 1) {
        throw new Error(`Schema drift requires ${flag} exactly once.`);
      }
    }
    const allowedFlags = new Set([
      "--schema-drift",
      "--project-ref",
      "--reviewed-sha",
    ]);
    const unknownFlag = args.find(
      (value) => value.startsWith("--") && !allowedFlags.has(value),
    );
    if (unknownFlag) {
      throw new Error(`Unknown schema drift argument: ${unknownFlag}`);
    }
    if (args.length !== 5) {
      throw new Error("Schema drift accepts only project-ref and reviewed-sha.");
    }
    const projectIndex = args.indexOf("--project-ref");
    const shaIndex = args.indexOf("--reviewed-sha");
    const projectRef = args[projectIndex + 1];
    const reviewedSha = args[shaIndex + 1];
    if (projectRef !== EXPECTED_PROJECT_REF) {
      throw new Error("Schema drift project ref mismatch.");
    }
    if (!/^[0-9a-f]{40}$/.test(reviewedSha ?? "")) {
      throw new Error("Schema drift requires an exact reviewed Git SHA.");
    }
    return { mode: "schema-drift", projectRef, reviewedSha };
  }
  throw new Error(
    "Use --local, --local-file FILE, or --schema-drift --project-ref REF --reviewed-sha SHA.",
  );
}

export async function assertPinnedSupabaseCli() {
  const command = process.platform === "win32" ? process.execPath : "npx";
  const args =
    process.platform === "win32"
      ? [
          process.env.npm_execpath ??
            join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
          "exec",
          "--yes",
          "--package",
          `supabase@${SUPABASE_CLI_VERSION}`,
          "--",
          "supabase",
          "--version",
        ]
      : ["--yes", `supabase@${SUPABASE_CLI_VERSION}`, "--version"];
  const result = await capture(command, args);
  if (result.code !== 0 || result.stdout.trim() !== SUPABASE_CLI_VERSION) {
    throw new Error(`Pinned Supabase CLI ${SUPABASE_CLI_VERSION} is unavailable.`);
  }
}

export async function createDisposableOpenClawDatabase({
  throughFile = OPENCLAW_MIGRATIONS.at(-1),
  verifyCli = false,
  readMigration = (migration) =>
    readFile(join(repositoryRoot, "supabase", "migrations", migration)),
} = {}) {
  if (verifyCli) await assertPinnedSupabaseCli();
  const lastIndex = OPENCLAW_MIGRATIONS.indexOf(throughFile);
  if (lastIndex < 0) throw new Error("Migration is outside the reviewed manifest.");
  const database = new PGlite({ extensions: { pgcrypto } });
  try {
    await database.exec(OPENCLAW_DISPOSABLE_FIXTURE_SQL);
    for (const migration of OPENCLAW_MIGRATIONS.slice(0, lastIndex + 1)) {
      const bytes = await readMigration(migration);
      await database.exec(Buffer.isBuffer(bytes) ? bytes.toString("utf8") : bytes);
    }
    return database;
  } catch (error) {
    await database.close().catch(() => {});
    throw error;
  }
}

export async function assertMigrationSmoke(database, expectedCount = 12) {
  const tableCount = await database.query(`
    select count(*)::integer as count
    from pg_catalog.pg_tables
    where schemaname='public' and tablename like 'openclaw\\_%' escape '\\'
  `);
  if (tableCount.rows[0].count < 50) {
    throw new Error("OpenClaw migration smoke found an incomplete schema.");
  }
  const unsafeDefaults = await database.query(`
    select count(*)::integer as count
    from information_schema.columns
    where table_schema='public' and table_name='openclaw_control_states'
      and column_name in (
        'feature_enabled','limited_auto_reply_enabled','proactive_enabled',
        'sales_groups_enabled','first_contact_enabled'
      )
      and column_default is distinct from 'false'
  `);
  if (unsafeDefaults.rows[0].count !== 0) {
    throw new Error("OpenClaw activation defaults are not fail-closed.");
  }
  const publicationCount = await database.query(`
    select count(*)::integer as count
    from pg_catalog.pg_publication_tables
    where pubname='supabase_realtime' and schemaname='public'
      and tablename like 'openclaw\\_%' escape '\\'
  `);
  if (publicationCount.rows[0].count !== 7) {
    throw new Error("OpenClaw Realtime publication is not the exact seven-table allowlist.");
  }
  return { expectedCount, tableCount: tableCount.rows[0].count };
}

let sqlHarnessSavepoint = 0;

async function withSqlHarnessSavepoint(database, operation, { rollback = true } = {}) {
  sqlHarnessSavepoint += 1;
  const name = `openclaw_harness_${sqlHarnessSavepoint}`;
  await database.exec(`savepoint ${name}`);
  try {
    const result = await operation();
    if (rollback) await database.exec(`rollback to savepoint ${name}`);
    await database.exec(`release savepoint ${name}`);
    return result;
  } catch (error) {
    await database.exec(`rollback to savepoint ${name}`).catch(() => {});
    await database.exec(`release savepoint ${name}`).catch(() => {});
    throw error;
  }
}

async function expectSqlHarnessRejection(database, label, operation, pattern) {
  let rejection;
  await withSqlHarnessSavepoint(database, async () => {
    try {
      await operation();
    } catch (error) {
      rejection = error;
    }
  });
  if (!rejection) throw new Error(`${label} unexpectedly succeeded.`);
  if (pattern && !pattern.test(String(rejection?.message ?? rejection))) {
    throw new Error(`${label} failed for the wrong reason: ${rejection.message}`);
  }
}

function assertProof(condition, message) {
  if (!condition) throw new Error(message);
}

export async function assertNoOpenClawBrowserDml(database) {
  const matrixRows = BROWSER_DML_PRIVILEGE_MATRIX
    .map(({ role, privilege }) => `('${role}','${privilege}')`)
    .join(",");
  const browserDml = await database.query(`
    select
      table_row.tablename as "tableName",
      matrix.role_name as "roleName",
      matrix.privilege_type as privilege
    from pg_catalog.pg_tables table_row
    cross join (values ${matrixRows}) matrix(role_name,privilege_type)
    where table_row.schemaname='public'
      and table_row.tablename like 'openclaw\\_%' escape '\\'
      and pg_catalog.has_table_privilege(
        matrix.role_name,
        pg_catalog.format('%I.%I',table_row.schemaname,table_row.tablename),
        matrix.privilege_type
      )
    order by table_row.tablename,matrix.role_name,matrix.privilege_type
  `);
  if (browserDml.rows.length !== 0) {
    const leak = browserDml.rows[0];
    throw new Error(
      `Browser role ${leak.roleName} unexpectedly has ${leak.privilege} ` +
      `on public.${leak.tableName}.`,
    );
  }
}

export async function runDisposableSqlAuthorizationMatrix() {
  const database = await createDisposableOpenClawDatabase();
  const proofs = [];
  const prove = (name) => {
    if (SQL_AUTHORIZATION_PROOFS[proofs.length] !== name) {
      throw new Error(`SQL proof order mismatch at ${name}.`);
    }
    proofs.push(name);
    if (process.env.OPENCLAW_SQL_HARNESS_DEBUG === "1") {
      process.stderr.write(`SQL proof ${proofs.length}/${SQL_AUTHORIZATION_PROOFS.length}: ${name}\n`);
    }
  };
  try {
    await database.exec("begin");
    await database.exec(`
      insert into public.organizations(id,name) values
        ('${DEMO_ORG_ID}','DEMO'),
        ('${PROD_ORG_ID}','PROD');
      insert into auth.users(id) values
        ('91000000-0000-4000-8000-000000000001'),
        ('91000000-0000-4000-8000-000000000002'),
        ('91000000-0000-4000-8000-000000000003'),
        ('91000000-0000-4000-8000-000000000004');
      insert into public.organization_memberships(
        id,organization_id,user_id,member_type,status
      ) values
        ('92000000-0000-4000-8000-000000000001','${DEMO_ORG_ID}',
          '91000000-0000-4000-8000-000000000001','USER','ACTIVE'),
        ('92000000-0000-4000-8000-000000000002','${DEMO_ORG_ID}',
          '91000000-0000-4000-8000-000000000002','USER','INACTIVE'),
        ('92000000-0000-4000-8000-000000000003','${DEMO_ORG_ID}',
          '91000000-0000-4000-8000-000000000003','USER','REVOKED'),
        ('92000000-0000-4000-8000-000000000004','${DEMO_ORG_ID}',
          '91000000-0000-4000-8000-000000000004','USER','ACTIVE');
      insert into public.organization_roles(
        id,organization_id,is_system,status,name
      ) values
        ('93000000-0000-4000-8000-000000000001','${DEMO_ORG_ID}',false,'ACTIVE','Harness view'),
        ('93000000-0000-4000-8000-000000000002','${DEMO_ORG_ID}',false,'ACTIVE','Harness send'),
        ('93000000-0000-4000-8000-000000000003','${DEMO_ORG_ID}',false,'ACTIVE','Harness deny send');
      insert into public.role_permissions(
        organization_id,role_id,permission_key,effect
      ) values
        ('${DEMO_ORG_ID}','93000000-0000-4000-8000-000000000001','openclaw_zalo.view','ALLOW'),
        ('${DEMO_ORG_ID}','93000000-0000-4000-8000-000000000002','openclaw_zalo.send','ALLOW'),
        ('${DEMO_ORG_ID}','93000000-0000-4000-8000-000000000003','openclaw_zalo.send','DENY');
      insert into public.authorization_scopes(id,organization_id,scope_type)
      values ('94000000-0000-4000-8000-000000000001','${DEMO_ORG_ID}','ORGANIZATION');
      insert into public.role_bindings(
        id,organization_id,membership_id,role_id
      ) values
        ('95000000-0000-4000-8000-000000000001','${DEMO_ORG_ID}',
          '92000000-0000-4000-8000-000000000001','93000000-0000-4000-8000-000000000001'),
        ('95000000-0000-4000-8000-000000000002','${DEMO_ORG_ID}',
          '92000000-0000-4000-8000-000000000002','93000000-0000-4000-8000-000000000001'),
        ('95000000-0000-4000-8000-000000000003','${DEMO_ORG_ID}',
          '92000000-0000-4000-8000-000000000003','93000000-0000-4000-8000-000000000001'),
        ('95000000-0000-4000-8000-000000000004','${DEMO_ORG_ID}',
          '92000000-0000-4000-8000-000000000004','93000000-0000-4000-8000-000000000002'),
        ('95000000-0000-4000-8000-000000000005','${DEMO_ORG_ID}',
          '92000000-0000-4000-8000-000000000004','93000000-0000-4000-8000-000000000003');
      insert into public.role_binding_scopes(
        organization_id,role_binding_id,scope_id
      ) select '${DEMO_ORG_ID}',binding.id,'94000000-0000-4000-8000-000000000001'
        from public.role_bindings binding
        where binding.organization_id='${DEMO_ORG_ID}';
    `);
    const membershipDecisions = await database.query(`
      select
        (select allowed from app_private.authorize_tenant_action_v3(
          '91000000-0000-4000-8000-000000000001','${DEMO_ORG_ID}',
          'openclaw_zalo.view',null,null)) active_view,
        (select allowed from app_private.authorize_tenant_action_v3(
          '91000000-0000-4000-8000-000000000002','${DEMO_ORG_ID}',
          'openclaw_zalo.view',null,null)) inactive_view,
        (select allowed from app_private.authorize_tenant_action_v3(
          '91000000-0000-4000-8000-000000000003','${DEMO_ORG_ID}',
          'openclaw_zalo.view',null,null)) revoked_view
    `);
    assertProof(
      membershipDecisions.rows[0].active_view === true &&
        membershipDecisions.rows[0].inactive_view === false &&
        membershipDecisions.rows[0].revoked_view === false,
      "Inactive or revoked membership authorization was not fail-closed.",
    );
    prove("membership.inactive-revoked");

    const permissionDecisions = await database.query(`
      select
        (select allowed from app_private.authorize_tenant_action_v3(
          '91000000-0000-4000-8000-000000000001','${DEMO_ORG_ID}',
          'openclaw_zalo.view',null,null)) can_view,
        (select allowed from app_private.authorize_tenant_action_v3(
          '91000000-0000-4000-8000-000000000001','${DEMO_ORG_ID}',
          'openclaw_zalo.send',null,null)) cannot_send,
        (select allowed from app_private.authorize_tenant_action_v3(
          '91000000-0000-4000-8000-000000000004','${DEMO_ORG_ID}',
          'openclaw_zalo.send',null,null)) deny_wins
    `);
    assertProof(
      permissionDecisions.rows[0].can_view === true &&
        permissionDecisions.rows[0].cannot_send === false &&
        permissionDecisions.rows[0].deny_wins === false,
      "Mixed permission or deny-wins behavior is incorrect.",
    );
    prove("permissions.mixed");

    await prepareDisposableConcurrencyFixtures(database);
    await database.exec(`
      set session_replication_role='replica';
      insert into public.openclaw_accounts(id,organization_id,account_profile,is_active)
      values ('96000000-0000-4000-8000-000000000001','${PROD_ORG_ID}','prod-cross-check',true);
      set session_replication_role='origin';
    `);
    await expectSqlHarnessRejection(
      database,
      "Cross-account target",
      () => database.exec(`
        insert into public.openclaw_targets(
          id,organization_id,account_id,kind,provider_id,directory_refreshed_at
        ) values (
          '96000000-0000-4000-8000-000000000002','${DEMO_ORG_ID}',
          '96000000-0000-4000-8000-000000000001','PEER','cross-account',statement_timestamp()
        )
      `),
      /foreign key|constraint/i,
    );
    prove("tenant.wrong-account");

    await expectSqlHarnessRejection(
      database,
      "Cross-tenant runtime cell",
      () => database.exec(`
        insert into public.openclaw_runtime_cells(
          id,organization_id,account_id,cell_generation,state,is_current,
          reviewed_commit_sha,image_digest,config_digest
        ) values (
          '96000000-0000-4000-8000-000000000003','${PROD_ORG_ID}',
          '11111111-1111-4111-8111-111111111111',2,'READY',false,
          repeat('a',40),'sha256:'||repeat('b',64),repeat('c',64)
        )
      `),
      /foreign key|constraint/i,
    );
    prove("tenant.composite-fk");

    await database.exec(`
      set session_replication_role='replica';
      insert into public.openclaw_qr_challenges(
        id,organization_id,account_id,cell_id,ciphertext,cipher_iv,auth_tag,
        actor_id,auth_session_hash,browser_nonce_hash,issued_at,expires_at,
        material_version,material_published_at
      ) values (
        '97000000-0000-4000-8000-000000000001','${DEMO_ORG_ID}',
        '11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222',
        decode('01','hex'),decode(repeat('01',12),'hex'),decode(repeat('02',16),'hex'),
        '99999999-9999-4999-8999-999999999999',repeat('a',64),repeat('b',64),
        statement_timestamp(),statement_timestamp()+interval '120 seconds',
        1,statement_timestamp()
      );
      set session_replication_role='origin';
    `);
    await expectSqlHarnessRejection(
      database,
      "Second active QR challenge",
      () => database.exec(`
        set session_replication_role='replica';
        insert into public.openclaw_qr_challenges(
          id,organization_id,account_id,cell_id,ciphertext,cipher_iv,auth_tag,
          actor_id,auth_session_hash,browser_nonce_hash,issued_at,expires_at,
          material_version,material_published_at
        ) values (
          '97000000-0000-4000-8000-000000000002','${DEMO_ORG_ID}',
          '11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222',
          decode('01','hex'),decode(repeat('01',12),'hex'),decode(repeat('02',16),'hex'),
          '99999999-9999-4999-8999-999999999999',repeat('c',64),repeat('d',64),
          statement_timestamp(),statement_timestamp()+interval '120 seconds',
          1,statement_timestamp()
        )
      `),
      /unique|duplicate/i,
    );
    prove("qr.unique");

    await runDisposableConcurrencyScenario(database, "PRE_HANDOFF_REQUEUE");
    await runDisposableConcurrencyScenario(database, "OUTBOX_SINGLE_CLAIM");
    const claimedOutbox = await database.query(`
      select id,payload_hash,claim_generation,fencing_token,session_generation,
        control_version,takeover_version,lease_expires_at
      from public.openclaw_outbox
      where id='bbbbbbbb-bbbb-4bbb-8bbb-000000000001'
    `);
    assertProof(
      claimedOutbox.rows[0]?.claim_generation === 1 &&
        claimedOutbox.rows[0]?.fencing_token === 1 &&
        claimedOutbox.rows[0]?.lease_expires_at,
      "Outbox claim did not persist its CAS lineage.",
    );
    prove("outbox-work.claim-cas");

    await database.exec(`
      set session_replication_role='replica';
      insert into public.openclaw_control_states(
        organization_id,control_key,feature_enabled,global_stop,control_version
      ) values ('${DEMO_ORG_ID}','GLOBAL_STOP',true,false,1)
      on conflict (organization_id,control_key) do update
        set feature_enabled=true,global_stop=false,
            control_version=public.openclaw_control_states.control_version+1;
      insert into public.openclaw_consents(
        organization_id,account_id,target_id,consent_scope,consent_status,
        consent_source,evidence_hash,granted_at
      ) values (
        '${DEMO_ORG_ID}','11111111-1111-4111-8111-111111111111',
        '55555555-5555-4555-8555-555555555555','REPLY','ACTIVE',
        'sql-matrix',repeat('a',64),statement_timestamp()
      );
      set session_replication_role='origin';
    `);
    const stalePolicy = await database.query(
      `select app_private.openclaw_preflight_outbox_v1(
        $1::jsonb,'{}'::jsonb,$2::jsonb
      ) result`,
      [
        JSON.stringify(channelPrincipal()),
        JSON.stringify({
          version: 1,
          outboxId: "bbbbbbbb-bbbb-4bbb-8bbb-000000000001",
          claimGeneration: 1,
          claimToken: "claim-a",
        }),
      ],
    );
    assertProof(
      stalePolicy.rows[0].result.decision === "POLICY_STALE" &&
        stalePolicy.rows[0].result.authorizationMarker === null,
      "Missing or non-published policy was not rejected before marker minting.",
    );

    const marker = claimedOutbox.rows[0];
    await database.exec(`
      set session_replication_role='replica';
      insert into public.openclaw_outbound_authorizations(
        id,organization_id,account_id,outbox_id,claim_generation,payload_hash,
        fencing_token,session_generation,control_version,takeover_version,
        marker_nonce_hash,issued_at,expires_at,lease_expires_at
      ) values (
        '98000000-0000-4000-8000-000000000001','${DEMO_ORG_ID}',
        '11111111-1111-4111-8111-111111111111','${"bbbbbbbb-bbbb-4bbb-8bbb-000000000001"}',
        ${marker.claim_generation},'${marker.payload_hash}',${marker.fencing_token},
        ${marker.session_generation},${marker.control_version},${marker.takeover_version},
        repeat('8',64),statement_timestamp(),statement_timestamp()+interval '5 seconds',
        '${new Date(marker.lease_expires_at).toISOString()}'::timestamptz
      );
      set session_replication_role='origin';
    `);
    await expectSqlHarnessRejection(
      database,
      "Duplicate outbound marker nonce",
      () => database.exec(`
        set session_replication_role='replica';
        insert into public.openclaw_outbound_authorizations(
          id,organization_id,account_id,outbox_id,claim_generation,payload_hash,
          fencing_token,session_generation,control_version,takeover_version,
          marker_nonce_hash,issued_at,expires_at,lease_expires_at
        ) values (
          '98000000-0000-4000-8000-000000000002','${DEMO_ORG_ID}',
          '11111111-1111-4111-8111-111111111111','bbbbbbbb-bbbb-4bbb-8bbb-000000000001',
          ${marker.claim_generation},'${marker.payload_hash}',${marker.fencing_token},
          ${marker.session_generation},${marker.control_version},${marker.takeover_version},
          repeat('8',64),statement_timestamp(),statement_timestamp()+interval '5 seconds',
          '${new Date(marker.lease_expires_at).toISOString()}'::timestamptz
        )
      `),
      /unique|duplicate/i,
    );
    await expectSqlHarnessRejection(
      database,
      "Outbound marker TTL above 15 seconds",
      () => database.exec(`
        set session_replication_role='replica';
        insert into public.openclaw_outbound_authorizations(
          id,organization_id,account_id,outbox_id,claim_generation,payload_hash,
          fencing_token,session_generation,control_version,takeover_version,
          marker_nonce_hash,issued_at,expires_at,lease_expires_at
        ) values (
          '98000000-0000-4000-8000-000000000003','${DEMO_ORG_ID}',
          '11111111-1111-4111-8111-111111111111','bbbbbbbb-bbbb-4bbb-8bbb-000000000001',
          ${marker.claim_generation},'${marker.payload_hash}',${marker.fencing_token},
          ${marker.session_generation},${marker.control_version},${marker.takeover_version},
          repeat('9',64),statement_timestamp(),statement_timestamp()+interval '16 seconds',
          statement_timestamp()+interval '30 seconds'
        )
      `),
      /check|constraint/i,
    );
    await database.exec(`set session_replication_role='replica'`);
    const firstConsume = await database.query(`
      update public.openclaw_outbound_authorizations
      set consumed_at=statement_timestamp(),authorized_handoff_at=statement_timestamp()
      where id='98000000-0000-4000-8000-000000000001' and consumed_at is null
      returning id
    `);
    const replayConsume = await database.query(`
      update public.openclaw_outbound_authorizations
      set consumed_at=statement_timestamp(),authorized_handoff_at=statement_timestamp()
      where id='98000000-0000-4000-8000-000000000001' and consumed_at is null
      returning id
    `);
    await database.exec(`set session_replication_role='origin'`);
    assertProof(
      firstConsume.rows.length === 1 && replayConsume.rows.length === 0,
      "Outbound marker consumption was not one-time.",
    );
    prove("marker.mint-consume-ttl");
    prove("completion-requeue.serialization");

    const atomicEvents = [
      {
        version: 1,
        eventKind: "MESSAGE",
        providerEventId: "atomic-event-good",
        providerMessageId: "atomic-message-good",
        providerConversationId: "atomic-conversation",
        providerSenderId: "atomic-sender",
        providerTarget: { kind: "PEER", providerId: "atomic-peer" },
        providerEventType: "CALLBACK",
        sourceTimestamp: "2026-07-31T00:00:00.000Z",
        callbackReceivedAt: "2026-07-31T00:00:01.000Z",
        rawEnvelope: { bounded: true },
        rawEnvelopeSha256: "a".repeat(64),
        normalized: { text: "atomic" },
        normalizedSha256: "b".repeat(64),
      },
      {
        version: 1,
        eventKind: "MESSAGE",
        providerEventId: "atomic-event-invalid",
        providerMessageId: "atomic-message-invalid",
        providerConversationId: "atomic-conversation",
        providerSenderId: "atomic-sender",
        providerTarget: { kind: "PEER", providerId: "atomic-peer" },
        providerEventType: "CALLBACK",
        sourceTimestamp: "not-a-timestamp",
        callbackReceivedAt: "2026-07-31T00:00:01.000Z",
        rawEnvelope: { bounded: true },
        rawEnvelopeSha256: "c".repeat(64),
        normalized: { text: "must roll back" },
        normalizedSha256: "d".repeat(64),
      },
    ];
    await expectSqlHarnessRejection(
      database,
      "Atomic inbound batch with a late invalid event",
      () => database.query(
        `select app_private.openclaw_ingest_inbound_batch_v1(
          $1::jsonb,'{}'::jsonb,$2::jsonb
        )`,
        [
          JSON.stringify(channelPrincipal()),
          JSON.stringify({
            version: 1,
            requestId: "99000000-0000-4000-8000-000000000001",
            events: atomicEvents,
          }),
        ],
      ),
      /timestamp|date\/time|invalid input/i,
    );
    const partialInbound = await database.query(`
      select
        (select count(*)::integer from public.openclaw_inbound_events
          where provider_event_id like 'atomic-event-%') inbound_count,
        (select count(*)::integer from public.openclaw_messages message
          join public.openclaw_inbound_events inbound
            on inbound.organization_id=message.organization_id
           and inbound.account_id=message.account_id
           and inbound.id=message.source_inbound_event_id
          where inbound.provider_event_id like 'atomic-event-%') message_count,
        (select count(*)::integer from public.openclaw_inbound_automation_decisions decision
          join public.openclaw_inbound_events inbound
            on inbound.organization_id=decision.organization_id
           and inbound.account_id=decision.account_id
           and inbound.id=decision.inbound_event_id
          where inbound.provider_event_id like 'atomic-event-%') decision_count
    `);
    assertProof(
      Object.values(partialInbound.rows[0]).every((count) => count === 0),
      "Inbound batch failure left a partial message, decision, or work lineage.",
    );
    prove("inbound.atomic-commit");

    await runDisposableConcurrencyScenario(database, "DUPLICATE_SCHEDULE_MATERIALIZER");
    const workClaim = await database.query(
      `select app_private.openclaw_claim_work_item_v1(
        $1::jsonb,'{}'::jsonb,$2::jsonb
      ) result`,
      [
        JSON.stringify(channelPrincipal()),
        JSON.stringify({
          version: 1,
          claimToken: "sql-matrix-work-claim",
          limit: 1,
          leaseSeconds: 30,
        }),
      ],
    );
    const claimedWork = workClaim.rows[0].result.items[0];
    assertProof(claimedWork?.workItemId, "Schedule work could not be claimed for rollback proof.");
    await expectSqlHarnessRejection(
      database,
      "Work-to-outbox payload hash mismatch",
      () => database.query(
        `select app_private.openclaw_create_outbox_from_work_v1(
          $1::jsonb,'{}'::jsonb,$2::jsonb
        )`,
        [
          JSON.stringify(channelPrincipal()),
          JSON.stringify({
            version: 1,
            workItemId: claimedWork.workItemId,
            claimGeneration: claimedWork.claimGeneration,
            claimToken: "sql-matrix-work-claim",
            canonicalPayload: {
              version: 1,
              organizationId: DEMO_ORG_ID,
              accountId: "11111111-1111-4111-8111-111111111111",
              target: { kind: "PEER", providerId: "peer-concurrency" },
              channel: "zalouser",
              accountProfile: "concurrency",
              idempotencyKey: "sql-matrix-work-outbox",
              parts: [{ version: 1, partIndex: 0, kind: "TEXT", text: "matrix" }],
              replyToProviderMessageId: null,
              policyVersionId: "66666666-6666-4666-8666-666666666666",
              automationVersionId: null,
              templateVersionId: null,
              frozenInputs: {
                campaignVersionId: null,
                scheduleVersion: null,
                subscriptionVersion: null,
                subscriptionId: null,
                occurrenceId: null,
                sourceTable: null,
                sourceId: null,
                sourceVersion: null,
                knowledgeVersionIds: [],
                sourceSnapshotHash: null,
                targetVersion: 1,
                targetDirectoryRefreshedAt: "2026-07-31T00:00:00.000Z",
                fieldMappingHash: null,
              },
            },
            payloadHash: "0".repeat(64),
            sourceSnapshotHash: claimedWork.sourceHash,
          }),
        ],
      ),
      /payload|hash|mismatch/i,
    );
    const workRollback = await database.query(
      `select work.state,
        (select count(*)::integer from public.openclaw_outbox outbox
          where outbox.organization_id=work.organization_id
            and outbox.account_id=work.account_id
            and outbox.idempotency_key='sql-matrix-work-outbox') outbox_count
       from public.openclaw_send_work_items work where work.id=$1`,
      [claimedWork.workItemId],
    );
    assertProof(
      workRollback.rows[0]?.state === "LEASED" &&
        workRollback.rows[0]?.outbox_count === 0,
      "Failed work-to-outbox conversion changed work state or inserted an outbox row.",
    );
    prove("work-outbox.atomic-rollback");

    prove("policy.stale-rejected");

    await database.query(
      `select app_private.append_openclaw_audit_v1(
        $1,'SQL_MATRIX',null,'HARNESS',$2,$2,$3::jsonb,
        convert_to($4,'UTF8')
      )`,
      [
        DEMO_ORG_ID,
        "99000000-0000-4000-8000-000000000002",
        JSON.stringify({ kind: "matrix" }),
        JSON.stringify({ kind: "matrix" }),
      ],
    );
    await expectSqlHarnessRejection(
      database,
      "Audit event mutation",
      () => database.exec(`
        update public.openclaw_audit_events set event_hash=repeat('f',64)
        where organization_id='${DEMO_ORG_ID}' and event_type='SQL_MATRIX'
      `),
      /append|immutable|audit/i,
    );
    const receiptDatabase = await createDisposableOpenClawDatabase();
    try {
      await prepareDisposableConcurrencyFixtures(receiptDatabase);
      for (const scenario of [
        "FORGED_AUDIT_RECEIPT",
        "LOST_AUDIT_ACKNOWLEDGEMENT",
      ]) {
        await runDisposableConcurrencyScenario(receiptDatabase, scenario);
      }
      prove("audit.immutability-receipt");

      for (const scenario of [
        "RETENTION_QUARANTINE_HOLD_RACE",
        "RETENTION_FINAL_DELETE_HOLD_RACE",
        "FORGED_DELETE_RECEIPT",
        "AUTHENTICATED_NOT_FOUND_RECEIPT",
        "LOST_GATEWAY_RESPONSE_REPLAY",
        "LOST_DB_FINALIZATION",
      ]) {
        await runDisposableConcurrencyScenario(receiptDatabase, scenario);
      }
    } finally {
      await receiptDatabase.close().catch(() => {});
    }
    prove("retention.hold-version-receipt");

    const rollout = await database.query(
      `select app_private.openclaw_begin_rollout_v1(
        $1::jsonb,'{}'::jsonb,$2::jsonb
      ) result`,
      [
        JSON.stringify(maintenancePrincipal()),
        JSON.stringify({
          version: 1,
          reviewedCommitSha: "a".repeat(40),
          migrationManifestSha256: "b".repeat(64),
          upstreamSri: "sha512-harness",
          upstreamGitHead: "c".repeat(40),
          patchSeriesSha256: "d".repeat(64),
          builtTgzSha256: "e".repeat(64),
          artifactDigests: { harness: "f".repeat(64) },
          projectRef: EXPECTED_PROJECT_REF,
        }),
      ],
    );
    const rolloutRunId = rollout.rows[0].result.rolloutRunId;
    await database.exec(`set session_replication_role='replica'`);
    const advanced = await database.query(
      `select app_private.openclaw_advance_rollout_stage_v1(
        $1::jsonb,'{}'::jsonb,$2::jsonb
      ) result`,
      [
        JSON.stringify(maintenancePrincipal()),
        JSON.stringify({
          version: 1,
          rolloutRunId,
          expectedStageVersion: 1,
          nextStage: "INFRASTRUCTURE",
        }),
      ],
    );
    assertProof(
      advanced.rows[0].result.stage === "INFRASTRUCTURE" &&
        advanced.rows[0].result.stageVersion === 2,
      "Rollout stage did not advance with the expected CAS version.",
    );
    await expectSqlHarnessRejection(
      database,
      "Stale rollout stage version",
      () => database.query(
        `select app_private.openclaw_advance_rollout_stage_v1(
          $1::jsonb,'{}'::jsonb,$2::jsonb
        )`,
        [
          JSON.stringify(maintenancePrincipal()),
          JSON.stringify({
            version: 1,
            rolloutRunId,
            expectedStageVersion: 1,
            nextStage: "WAITING_OWNER_QR",
          }),
        ],
      ),
      /CAS|version/i,
    );
    await database.exec(`set session_replication_role='origin'`);
    prove("rollout.stage-cas");

    const publication = await database.query(`
      select count(*)::integer count,
        bool_and(attnames is not null and cardinality(attnames)>0) columns_are_explicit
      from pg_catalog.pg_publication_tables
      where pubname='supabase_realtime' and schemaname='public'
        and tablename like 'openclaw\\_%' escape '\\'
    `);
    assertProof(
      publication.rows[0].count === 7 && publication.rows[0].columns_are_explicit === true,
      "Realtime publication is not the exact column-scoped seven-table allowlist.",
    );
    prove("realtime.safe-publication");

    await runDisposableConcurrencyScenario(database, "CRM_FANOUT_IDEMPOTENCY");
    const operationScopes = await database.query(`
      select
        (select allowed_scopes from public.openclaw_runtime_credentials
          where organization_id='${DEMO_ORG_ID}'
            and account_id='11111111-1111-4111-8111-111111111111'
            and cell_id='22222222-2222-4222-8222-222222222222'
            and credential_generation=1) channel_scopes,
        (select allowed_scopes from public.openclaw_maintenance_credentials
          where organization_id='${DEMO_ORG_ID}'
            and maintenance_principal_id='44444444-4444-4444-8444-444444444444'
            and credential_generation=1) maintenance_scopes,
        (select count(*)::integer from public.openclaw_send_work_items
          where work_kind in ('SCHEDULE_OCCURRENCE','CRM_EVENT')
            and account_id is not null and cell_id is not null) send_work_count
    `);
    const scopeRow = operationScopes.rows[0];
    assertProof(
      scopeRow.send_work_count >= 2 &&
        scopeRow.channel_scopes.includes("outbox.claim") &&
        !scopeRow.channel_scopes.includes("maintenance.claim") &&
        scopeRow.maintenance_scopes.includes("maintenance.claim") &&
        !scopeRow.maintenance_scopes.includes("outbox.claim"),
      "Schedule/CRM channel scopes overlap organization maintenance scopes.",
    );
    prove("operation.scope-separation");

    const lineage = await database.query(`
      select count(*)::integer count
      from public.openclaw_send_work_items work
      where work.work_kind in ('SCHEDULE_OCCURRENCE','CRM_EVENT')
        and (work.organization_id is null or work.account_id is null or work.cell_id is null
          or work.credential_generation is null or work.runtime_lease_generation is null
          or work.fencing_token is null or work.target_id is null)
    `);
    assertProof(
      lineage.rows[0].count === 0,
      "A send-work claim is missing account, cell, credential, lease, fence, or target lineage.",
    );
    prove("claims.non-null-lineage");

    const pausedAudit = await prepareAuditAnchorFixture(database, 31);
    await database.exec(`
      set session_replication_role='replica';
      update public.openclaw_accounts set is_active=false,paused_at=statement_timestamp()
      where organization_id='${DEMO_ORG_ID}'
        and id='11111111-1111-4111-8111-111111111111';
      set session_replication_role='origin';
    `);
    const pausedAcknowledgement = await acknowledgeAuditAnchor(
      database,
      pausedAudit,
      pausedAudit.receipt,
    );
    assertProof(
      pausedAcknowledgement.rows[0].result.auditRootId === pausedAudit.auditRootId,
      "Organization maintenance stopped when the channel account was paused.",
    );
    await database.exec(`
      set session_replication_role='replica';
      update public.openclaw_accounts set is_active=true,paused_at=null
      where organization_id='${DEMO_ORG_ID}'
        and id='11111111-1111-4111-8111-111111111111';
      set session_replication_role='origin';
    `);
    prove("maintenance.channel-paused");

    await expectSqlHarnessRejection(
      database,
      "Cross-organization runtime principal",
      () => database.query(
        `select app_private.openclaw_claim_outbox_v1(
          $1::jsonb,'{}'::jsonb,$2::jsonb
        )`,
        [
          JSON.stringify({
            ...channelPrincipal(),
            organizationId: PROD_ORG_ID,
            accountId: "96000000-0000-4000-8000-000000000001",
          }),
          JSON.stringify({ version: 1, claimToken: "cross-org", limit: 1 }),
        ],
      ),
      /stale|binding|credential|lease/i,
    );
    await expectSqlHarnessRejection(
      database,
      "Stale runtime credential",
      () => database.query(
        `select app_private.openclaw_claim_work_item_v1(
          $1::jsonb,'{}'::jsonb,$2::jsonb
        )`,
        [
          JSON.stringify({ ...channelPrincipal(), credentialGeneration: 99 }),
          JSON.stringify({
            version: 1,
            claimToken: "stale-credential",
            limit: 1,
            leaseSeconds: 30,
          }),
        ],
      ),
      /stale|credential|lease/i,
    );
    prove("tenant.cross-org-stale-credential");

    await assertNoOpenClawBrowserDml(database);
    const definerPath = await database.query(`
      select count(*)::integer as count
      from pg_catalog.pg_proc proc
      join pg_catalog.pg_namespace namespace on namespace.oid=proc.pronamespace
      where namespace.nspname in ('public','app_private')
        and proc.proname like 'openclaw\\_%' escape '\\'
        and proc.prosecdef
        and not exists (
          select 1
          from pg_catalog.unnest(coalesce(proc.proconfig,'{}'::text[])) setting
          where setting like 'search_path=%'
        )
    `);
    if (definerPath.rows[0].count !== 0) {
      throw new Error("A SECURITY DEFINER function has an unsafe search_path.");
    }
    return {
      summary: "PASS OpenClaw SQL local rollback-only authorization matrix",
      proofs,
    };
  } finally {
    await database.exec("rollback").catch(() => {});
    await database.close();
  }
}

export async function prepareDisposableConcurrencyFixtures(database) {
  await database.exec(`
    set session_replication_role='replica';
    insert into public.organizations(id,name)
    values ('${DEMO_ORG_ID}','Concurrency DEMO')
    on conflict (id) do nothing;
    insert into auth.users(id)
    values ('99999999-9999-4999-8999-999999999999')
    on conflict (id) do nothing;
    insert into public.organization_memberships(
      id,organization_id,user_id,member_type,status
    ) values (
      '99990000-0000-4000-8000-000000000001','${DEMO_ORG_ID}',
      '99999999-9999-4999-8999-999999999999','USER','ACTIVE'
    ) on conflict (organization_id,id) do nothing;
    insert into public.organization_roles(id,organization_id,is_system,status,name)
    values (
      '99991000-0000-4000-8000-000000000001','${DEMO_ORG_ID}',
      false,'ACTIVE','Concurrency harness owner'
    ) on conflict (organization_id,id) do nothing;
    insert into public.role_permissions(
      organization_id,role_id,permission_key,effect
    ) select '${DEMO_ORG_ID}','99991000-0000-4000-8000-000000000001',
      definition.key,'ALLOW'
      from public.permission_definitions definition
      where definition.key like 'openclaw_zalo.%'
    on conflict (organization_id,role_id,permission_key) do update set effect='ALLOW';
    insert into public.authorization_scopes(id,organization_id,scope_type)
    values ('99992000-0000-4000-8000-000000000001','${DEMO_ORG_ID}','ORGANIZATION')
    on conflict (id) do nothing;
    insert into public.role_bindings(
      id,organization_id,membership_id,role_id
    ) values (
      '99993000-0000-4000-8000-000000000001','${DEMO_ORG_ID}',
      '99990000-0000-4000-8000-000000000001','99991000-0000-4000-8000-000000000001'
    ) on conflict (id) do nothing;
    insert into public.role_binding_scopes(
      organization_id,role_binding_id,scope_id
    ) values (
      '${DEMO_ORG_ID}','99993000-0000-4000-8000-000000000001',
      '99992000-0000-4000-8000-000000000001'
    ) on conflict (role_binding_id,scope_id) do nothing;
    insert into public.openclaw_accounts(
      id,organization_id,account_profile,is_active
    ) values (
      '11111111-1111-4111-8111-111111111111',
      '${DEMO_ORG_ID}','concurrency',true
    ) on conflict (organization_id,id) do nothing;
    insert into public.openclaw_runtime_cells(
      id,organization_id,account_id,cell_generation,state,is_current,
      reviewed_commit_sha,image_digest,config_digest
    ) values (
      '22222222-2222-4222-8222-222222222222',
      '${DEMO_ORG_ID}','11111111-1111-4111-8111-111111111111',
      1,'READY',true,repeat('a',40),'sha256:'||repeat('b',64),repeat('c',64)
    ) on conflict (organization_id,id) do nothing;
    insert into public.openclaw_runtime_credentials(
      organization_id,account_id,cell_id,credential_generation,
      credential_hash,allowed_scopes
    ) values (
      '${DEMO_ORG_ID}','11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',1,repeat('d',64),
      array['outbox.claim','outbox.preflight','outbox.authorize-send',
        'outbox.requeue','outbox.complete']
    ) on conflict (organization_id,account_id,cell_id,credential_generation) do nothing;
    insert into public.openclaw_runtime_leases(
      id,organization_id,account_id,cell_id,lease_generation,fencing_token,
      status,acquired_at,expires_at
    ) values (
      '33333333-3333-4333-8333-333333333333',
      '${DEMO_ORG_ID}','11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',1,1,'ACTIVE',
      statement_timestamp(),statement_timestamp()+interval '10 minutes'
    ) on conflict (organization_id,id) do nothing;
    insert into public.openclaw_maintenance_principals(
      id,organization_id,principal_generation,is_current
    ) values (
      '44444444-4444-4444-8444-444444444444','${DEMO_ORG_ID}',1,true
    ) on conflict (organization_id,id) do nothing;
    insert into public.openclaw_maintenance_credentials(
      organization_id,maintenance_principal_id,credential_generation,
      credential_hash,allowed_scopes
    ) values (
      '${DEMO_ORG_ID}','44444444-4444-4444-8444-444444444444',1,
      repeat('4',64),array['maintenance.claim','maintenance.complete']
    ) on conflict (
      organization_id,maintenance_principal_id,credential_generation
    ) do nothing;
    insert into public.openclaw_maintenance_leases(
      organization_id,maintenance_principal_id,lease_generation,fencing_token,
      status,expires_at
    ) values (
      '${DEMO_ORG_ID}','44444444-4444-4444-8444-444444444444',1,1,
      'ACTIVE',statement_timestamp()+interval '1 hour'
    ) on conflict (
      organization_id,maintenance_principal_id,lease_generation,fencing_token
    ) do nothing;
    insert into public.openclaw_contacts(
      id,organization_id,account_id,provider_id,directory_refreshed_at
    ) values (
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '${DEMO_ORG_ID}','11111111-1111-4111-8111-111111111111',
      'peer-concurrency',statement_timestamp()
    ) on conflict (organization_id,id) do nothing;
    insert into public.openclaw_targets(
      id,organization_id,account_id,kind,provider_id,contact_id,
      directory_refreshed_at
    ) values (
      '55555555-5555-4555-8555-555555555555',
      '${DEMO_ORG_ID}','11111111-1111-4111-8111-111111111111',
      'PEER','peer-concurrency','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      statement_timestamp()
    ) on conflict (organization_id,id) do nothing;
    insert into public.openclaw_conversations(
      id,organization_id,account_id,target_id,provider_conversation_id
    ) values (
      '55555555-5555-4555-8555-555555555556','${DEMO_ORG_ID}',
      '11111111-1111-4111-8111-111111111111',
      '55555555-5555-4555-8555-555555555555','concurrency-retention'
    ) on conflict (organization_id,id) do nothing;
    set session_replication_role='origin';
  `);
}

const concurrencyOutboxIds = Object.freeze({
  OUTBOX_SINGLE_CLAIM: "bbbbbbbb-bbbb-4bbb-8bbb-000000000001",
  EXPIRED_LEASE_RECLAIM: "bbbbbbbb-bbbb-4bbb-8bbb-000000000002",
  STALE_FENCE_REJECTED: "bbbbbbbb-bbbb-4bbb-8bbb-000000000003",
  PRE_HANDOFF_REQUEUE: "bbbbbbbb-bbbb-4bbb-8bbb-000000000004",
  UNKNOWN_SINGLE_WINNER: "bbbbbbbb-bbbb-4bbb-8bbb-000000000005",
});

async function insertConcurrencyOutbox(database, scenario, state = "QUEUED") {
  const outboxId = concurrencyOutboxIds[scenario];
  if (!outboxId) throw new Error(`No behavioral fixture for ${scenario}.`);
  const payload = JSON.stringify({
    version: 1,
    organizationId: DEMO_ORG_ID,
    accountId: "11111111-1111-4111-8111-111111111111",
    target: { kind: "PEER", providerId: "peer-concurrency" },
    channel: "zalouser",
    accountProfile: "concurrency",
    idempotencyKey: `concurrency:${scenario}`,
    parts: [{ version: 1, partIndex: 0, kind: "TEXT", text: scenario }],
    replyToProviderMessageId: null,
    policyVersionId: "66666666-6666-4666-8666-666666666666",
    automationVersionId: null,
    templateVersionId: null,
    frozenInputs: {
      campaignVersionId: null,
      scheduleVersion: null,
      subscriptionVersion: null,
      subscriptionId: null,
      occurrenceId: null,
      sourceTable: null,
      sourceId: null,
      sourceVersion: null,
      knowledgeVersionIds: [],
      sourceSnapshotHash: null,
      targetVersion: 1,
      targetDirectoryRefreshedAt: "2026-07-31T00:00:00.000Z",
      fieldMappingHash: null,
    },
  });
  const leased = state === "LEASED";
  await database.exec(`
    set session_replication_role='replica';
    delete from public.openclaw_outbox
    where idempotency_key like 'concurrency:%';
    set session_replication_role='origin';
  `);
  await database.query(
    `
      insert into public.openclaw_outbox(
        id,organization_id,account_id,target_id,source_kind,actor_id,
        client_operation_id,idempotency_key,canonical_payload,
        canonical_payload_bytes,payload_hash,state,claim_token_hash,
        claim_generation,claimed_cell_id,credential_generation,
        runtime_lease_generation,lease_expires_at,fencing_token,
        session_generation,attempt_count,terminal_at
      ) values (
        $1,'${DEMO_ORG_ID}','11111111-1111-4111-8111-111111111111',
        '55555555-5555-4555-8555-555555555555','MANUAL',
        '99999999-9999-4999-8999-999999999999',$2,$3,$4::jsonb,
        app_private.openclaw_jcs_bytes_v1($4::jsonb),
        encode(extensions.digest(
          convert_to('ihome-openclaw-send-v1','UTF8')||decode('00','hex')
            ||app_private.openclaw_jcs_bytes_v1($4::jsonb),
          'sha256'
        ),'hex'),
        $5,
        case when $5='LEASED' then repeat('e',64) else null end,
        case when $5='LEASED' then 1 else 0 end,
        case when $5='LEASED' then '22222222-2222-4222-8222-222222222222'::uuid else null end,
        case when $5='LEASED' then 1 else null end,
        case when $5='LEASED' then 1 else null end,
        case when $5='LEASED' then statement_timestamp()-interval '1 second' else null end,
        case when $5='LEASED' then 1 else 0 end,
        1,
        case when $5='LEASED' then 1 else 0 end,
        case when $5 in ('SENT','FAILED','UNKNOWN','DEAD_LETTER')
          then statement_timestamp() else null end
      )
      on conflict (organization_id,id) do nothing
    `,
    [
      outboxId,
      `99999999-9999-4999-8999-${outboxId.slice(-12)}`,
      `concurrency:${scenario}`,
      payload,
      state,
    ],
  );
  return outboxId;
}

function channelPrincipal(fencingToken = 1) {
  return {
    version: 1,
    principalKind: "CHANNEL",
    organizationId: DEMO_ORG_ID,
    accountId: "11111111-1111-4111-8111-111111111111",
    cellId: "22222222-2222-4222-8222-222222222222",
    credentialGeneration: 1,
    leaseGeneration: 1,
    fencingToken,
    sessionGeneration: 1,
  };
}

function maintenancePrincipal(fencingToken = 1) {
  return {
    version: 1,
    principalKind: "MAINTENANCE",
    organizationId: DEMO_ORG_ID,
    maintenancePrincipalId: "44444444-4444-4444-8444-444444444444",
    credentialGeneration: 1,
    leaseGeneration: 1,
    fencingToken,
  };
}

async function prepareAutomationFixtures(database) {
  await database.exec(`
    set session_replication_role='replica';
    insert into public.openclaw_policies(
      id,organization_id,account_id,name,lifecycle_state,current_version
    ) values (
      '66666666-6666-4666-8666-666666666661','${DEMO_ORG_ID}',
      '11111111-1111-4111-8111-111111111111','Concurrency policy','PUBLISHED',1
    ) on conflict (organization_id,id) do nothing;
    insert into public.openclaw_policy_versions(
      id,organization_id,account_id,policy_id,version,lifecycle_state,timezone,
      rate_limits,disclosure_version,policy_payload,payload_hash,published_at
    ) values (
      '66666666-6666-4666-8666-666666666662','${DEMO_ORG_ID}',
      '11111111-1111-4111-8111-111111111111',
      '66666666-6666-4666-8666-666666666661',1,'PUBLISHED','Asia/Bangkok',
      '{"perPeer":1}'::jsonb,1,'{"version":1}'::jsonb,repeat('6',64),
      statement_timestamp()
    ) on conflict (organization_id,id) do nothing;
    insert into public.openclaw_automations(
      id,organization_id,account_id,name,automation_kind,lifecycle_state,current_version
    ) values (
      '66666666-6666-4666-8666-666666666663','${DEMO_ORG_ID}',
      '11111111-1111-4111-8111-111111111111','Concurrency automation',
      'CRM_EVENT','PUBLISHED',1
    ) on conflict (organization_id,id) do nothing;
    insert into public.openclaw_automation_versions(
      id,organization_id,account_id,automation_id,version,lifecycle_state,mode,
      template_body,missing_value_policy,escaping_mode,maximum_rendered_codepoints,
      policy_version_id,configuration,dry_run_hash,published_at
    ) values (
      '66666666-6666-4666-8666-666666666664','${DEMO_ORG_ID}',
      '11111111-1111-4111-8111-111111111111',
      '66666666-6666-4666-8666-666666666663',1,'PUBLISHED','PROACTIVE',
      'Concurrency body','REJECT','CONTROL_SAFE',2000,
      '66666666-6666-4666-8666-666666666662','{}'::jsonb,repeat('7',64),
      statement_timestamp()
    ) on conflict (organization_id,id) do nothing;
    insert into public.openclaw_control_states(
      organization_id,control_key,global_stop,feature_enabled,proactive_enabled
    ) values ('${DEMO_ORG_ID}','GLOBAL_STOP',false,true,true)
    on conflict (organization_id,control_key) do update set
      global_stop=false,feature_enabled=true,proactive_enabled=true;
    set session_replication_role='origin';
  `);
}

async function prepareScheduleFixture(database) {
  await prepareAutomationFixtures(database);
  await database.exec(`
    set session_replication_role='replica';
    with timing as (
      select
        timezone('Asia/Bangkok',statement_timestamp()-interval '1 minute')::timestamp local_at,
        statement_timestamp()-interval '1 minute' run_at
    ), schedule_values as (
      select timing.*,
        'V1;FREQ=ONCE;DTSTART='||to_char(timing.local_at,'YYYY-MM-DD"T"HH24:MI') recurrence
      from timing
    )
    insert into public.openclaw_schedules(
      id,organization_id,account_id,automation_version_id,target_id,
      schedule_version,status,timezone,local_recurrence_rule,next_run_at,
      next_nominal_local,next_resolved_local,next_utc_offset_seconds,next_resolution
    )
    select
      '77777777-7777-4777-8777-777777777771','${DEMO_ORG_ID}',
      '11111111-1111-4111-8111-111111111111',
      '66666666-6666-4666-8666-666666666664',
      '55555555-5555-4555-8555-555555555555',1,'ACTIVE','Asia/Bangkok',
      recurrence,run_at,local_at,local_at,25200,'EXACT'
    from schedule_values
    on conflict (organization_id,id) do nothing;
    with schedule_data as (
      select schedule.*,
        jsonb_build_object(
          'version',1,'scheduleId',schedule.id,'scheduleVersion',schedule.schedule_version,
          'automationVersionId',schedule.automation_version_id,'targetId',schedule.target_id,
          'status',schedule.status,'timezone',schedule.timezone,
          'localRecurrenceRule',schedule.local_recurrence_rule,
          'missedOccurrencePolicy',schedule.missed_occurrence_policy,
          'occurrenceGraceSeconds',schedule.occurrence_grace_seconds,
          'dstFoldPolicy',schedule.dst_fold_policy
        ) snapshot
      from public.openclaw_schedules schedule
      where schedule.organization_id='${DEMO_ORG_ID}'
        and schedule.id='77777777-7777-4777-8777-777777777771'
    ), canonical as (
      select schedule_data.*,app_private.openclaw_jcs_bytes_v1(snapshot) snapshot_bytes
      from schedule_data
    )
    insert into public.openclaw_schedule_snapshots(
      organization_id,account_id,schedule_id,schedule_version,automation_version_id,
      target_id,status,timezone,local_recurrence_rule,missed_occurrence_policy,
      occurrence_grace_seconds,dst_fold_policy,snapshot,snapshot_bytes,snapshot_hash
    )
    select
      organization_id,account_id,id,schedule_version,automation_version_id,target_id,
      status,timezone,local_recurrence_rule,missed_occurrence_policy,
      occurrence_grace_seconds,dst_fold_policy,snapshot,snapshot_bytes,
      encode(extensions.digest(
        convert_to('ihome-openclaw-schedule-snapshot-v1','UTF8')
          ||decode('00','hex')||snapshot_bytes,'sha256'
      ),'hex')
    from canonical
    on conflict (organization_id,account_id,schedule_id,schedule_version) do nothing;
    set session_replication_role='origin';
  `);
}

async function prepareCrmFixture(database) {
  await prepareAutomationFixtures(database);
  await database.exec(`
    set session_replication_role='replica';
    insert into public.openclaw_crm_event_subscriptions(
      id,organization_id,account_id,automation_version_id,destination_target_id,
      event_type,subscription_version,field_mapping,field_mapping_hash,is_active
    ) values (
      '88888888-8888-4888-8888-888888888881','${DEMO_ORG_ID}',
      '11111111-1111-4111-8111-111111111111',
      '66666666-6666-4666-8666-666666666664',
      '55555555-5555-4555-8555-555555555555',
      'lead_created_or_assigned',1,'{}'::jsonb,repeat('8',64),true
    ) on conflict (organization_id,id) do nothing;
    with subscription as (
      select item.*,
        jsonb_build_object(
          'version',1,'subscriptionId',item.id,
          'subscriptionVersion',item.subscription_version,
          'automationVersionId',item.automation_version_id,
          'destinationTargetId',item.destination_target_id,
          'eventType',item.event_type,'fieldMapping',item.field_mapping,
          'fieldMappingHash',item.field_mapping_hash,'isActive',item.is_active
        ) snapshot
      from public.openclaw_crm_event_subscriptions item
      where item.organization_id='${DEMO_ORG_ID}'
        and item.id='88888888-8888-4888-8888-888888888881'
    ), canonical as (
      select subscription.*,app_private.openclaw_jcs_bytes_v1(snapshot) snapshot_bytes
      from subscription
    )
    insert into public.openclaw_crm_event_subscription_snapshots(
      organization_id,account_id,subscription_id,subscription_version,
      automation_version_id,destination_target_id,event_type,field_mapping,
      field_mapping_hash,is_active,snapshot,snapshot_bytes,snapshot_hash
    )
    select organization_id,account_id,id,subscription_version,automation_version_id,
      destination_target_id,event_type,field_mapping,field_mapping_hash,is_active,
      snapshot,snapshot_bytes,
      encode(extensions.digest(
        convert_to('ihome-openclaw-crm-subscription-snapshot-v1','UTF8')
          ||decode('00','hex')||snapshot_bytes,'sha256'
      ),'hex')
    from canonical
    on conflict (organization_id,account_id,subscription_id,subscription_version) do nothing;
    with occurrence as (
      select jsonb_build_object(
        'version',1,'leadId','88888888-8888-4888-8888-888888888883',
        'customerName','Concurrency customer'
      ) snapshot
    ), canonical as (
      select snapshot,app_private.openclaw_jcs_bytes_v1(snapshot) snapshot_bytes
      from occurrence
    )
    insert into public.openclaw_crm_event_occurrences(
      id,organization_id,event_type,event_subtype,source_table,source_id,
      source_version,source_snapshot,snapshot_bytes,snapshot_hash,occurred_at
    )
    select
      '88888888-8888-4888-8888-888888888882','${DEMO_ORG_ID}',
      'lead_created_or_assigned','CREATED','leads',
      '88888888-8888-4888-8888-888888888883',1,snapshot,snapshot_bytes,
      encode(extensions.digest(
        convert_to('ihome-openclaw-crm-snapshot-v1','UTF8')
          ||decode('00','hex')||snapshot_bytes,'sha256'
      ),'hex'),statement_timestamp()
    from canonical
    on conflict (organization_id,id) do nothing;
    set session_replication_role='origin';
  `);
}

async function prepareRetentionQuarantineRace(database) {
  await database.exec(`
    set session_replication_role='replica';
    insert into public.openclaw_retention_policies(
      organization_id,policy_version,subject_kind,retain_for_seconds,
      is_active,activated_at
    ) values (
      '${DEMO_ORG_ID}',1,'MESSAGE',15552000,true,statement_timestamp()
    ) on conflict (organization_id,subject_kind,policy_version) do nothing;
    insert into public.openclaw_messages(
      id,organization_id,account_id,conversation_id,direction,text_content,
      payload_hash,received_at,created_at
    ) values (
      '99999999-9999-4999-8999-000000000001','${DEMO_ORG_ID}',
      '11111111-1111-4111-8111-111111111111',
      '55555555-5555-4555-8555-555555555556','INBOUND',
      'held quarantine message',repeat('1',64),
      statement_timestamp()-interval '181 days',
      statement_timestamp()-interval '181 days'
    ) on conflict (organization_id,id) do nothing;
    set session_replication_role='origin';
  `);
  const materialized = await database.query(
    `select app_private.materialize_openclaw_retention_quarantine_v1(10) value`,
  );
  if (Number(materialized.rows[0].value) !== 1) {
    throw new Error("Retention quarantine fixture did not materialize one work item.");
  }
  await database.query(
    `select app_private.openclaw_claim_work_item_v1(
      $1::jsonb,'{}'::jsonb,$2::jsonb
    )`,
    [
      JSON.stringify(maintenancePrincipal()),
      JSON.stringify({
        version: 1,
        claimToken: "retention-quarantine-hold",
        limit: 1,
        leaseSeconds: 30,
      }),
    ],
  );
  const work = await database.query(`
    select id::text id,claim_generation
    from public.openclaw_maintenance_work_items
    where source_id='99999999-9999-4999-8999-000000000001'
      and work_phase='QUARANTINE' and state='LEASED'
  `);
  if (!work.rows[0]) {
    throw new Error("Retention quarantine work was not leased.");
  }
  await database.exec(`
    insert into public.openclaw_retention_holds(
      organization_id,target_kind,target_id,reason,created_by
    ) values (
      '${DEMO_ORG_ID}','MESSAGE',
      '99999999-9999-4999-8999-000000000001',
      'concurrency quarantine hold',
      '99999999-9999-4999-8999-999999999999'
    );
  `);
  return work.rows[0];
}

async function prepareRetentionQuarantineSuccess(database) {
  const subjectId = "99999999-9999-4999-8999-000000000020";
  const messageId = "99999999-9999-4999-8999-000000000019";
  const objectKey = `v1/org/${DEMO_ORG_ID}/retention/r2-independent`;
  const claimToken = "retention-quarantine-r2-independent";
  await database.exec(`
    set session_replication_role='replica';
    insert into public.openclaw_retention_policies(
      organization_id,policy_version,subject_kind,retain_for_seconds,
      is_active,activated_at
    ) values (
      '${DEMO_ORG_ID}',1,'MEDIA',7776000,true,statement_timestamp()
    ) on conflict (organization_id,subject_kind,policy_version) do nothing;
    insert into public.openclaw_messages(
      id,organization_id,account_id,conversation_id,direction,text_content,
      payload_hash,received_at,created_at
    ) values (
      '${messageId}','${DEMO_ORG_ID}',
      '11111111-1111-4111-8111-111111111111',
      '55555555-5555-4555-8555-555555555556','INBOUND',
      'r2 independent quarantine',repeat('6',64),
      statement_timestamp()-interval '91 days',
      statement_timestamp()-interval '91 days'
    ) on conflict (organization_id,id) do nothing;
    insert into public.openclaw_message_media(
      id,organization_id,account_id,conversation_id,message_id,media_index,
      media_kind,byte_state,object_key,created_at,updated_at
    ) values (
      '${subjectId}','${DEMO_ORG_ID}',
      '11111111-1111-4111-8111-111111111111',
      '55555555-5555-4555-8555-555555555556','${messageId}',0,
      'IMAGE','AVAILABLE','${objectKey}',
      statement_timestamp()-interval '91 days',
      statement_timestamp()-interval '91 days'
    ) on conflict (organization_id,id) do nothing;
    set session_replication_role='origin';
  `);
  await database.query(
    `select app_private.materialize_openclaw_retention_quarantine_v1(10)`,
  );
  await database.query(
    `select app_private.openclaw_claim_work_item_v1(
      $1::jsonb,'{}'::jsonb,$2::jsonb
    )`,
    [
      JSON.stringify(maintenancePrincipal()),
      JSON.stringify({
        version: 1,
        claimToken,
        limit: 10,
        leaseSeconds: 30,
      }),
    ],
  );
  const work = await database.query(`
    select id::text id,claim_generation
    from public.openclaw_maintenance_work_items
    where source_id='${subjectId}' and work_phase='QUARANTINE' and state='LEASED'
  `);
  if (!work.rows[0]) {
    throw new Error("R2-independent quarantine work was not leased.");
  }
  return { ...work.rows[0], subjectId, claimToken, objectKey };
}

async function prepareFinalDeleteHoldRace(database) {
  const claimToken = "retention-final-hold";
  await database.exec(`
    set session_replication_role='replica';
    insert into public.openclaw_messages(
      id,organization_id,account_id,conversation_id,direction,text_content,
      payload_hash
    ) values (
      '99999999-9999-4999-8999-000000000010','${DEMO_ORG_ID}',
      '11111111-1111-4111-8111-111111111111',
      '55555555-5555-4555-8555-555555555556','INBOUND',
      '[REDACTED_BY_RETENTION]',repeat('2',64)
    ) on conflict (organization_id,id) do nothing;
    insert into public.openclaw_message_media(
      id,organization_id,account_id,conversation_id,message_id,media_index,
      media_kind,byte_state,object_key,retention_delete_not_before
    ) values (
      '99999999-9999-4999-8999-000000000011','${DEMO_ORG_ID}',
      '11111111-1111-4111-8111-111111111111',
      '55555555-5555-4555-8555-555555555556',
      '99999999-9999-4999-8999-000000000010',0,'IMAGE',
      'QUARANTINED',null,statement_timestamp()-interval '1 day'
    ) on conflict (organization_id,id) do nothing;
    insert into public.openclaw_maintenance_work_items(
      id,organization_id,maintenance_principal_id,work_kind,work_phase,
      source_id,source_version,source_key,source_hash,payload,payload_hash,
      state,claim_generation,maintenance_lease_generation,fencing_token,
      lease_expires_at,attempt_count,credential_generation,terminal_at
    ) values (
      '99999999-9999-4999-8999-000000000012','${DEMO_ORG_ID}',
      '44444444-4444-4444-8444-444444444444','RETENTION_DELETE','QUARANTINE',
      '99999999-9999-4999-8999-000000000011','1:0',
      'retention:quarantine:hold-race',repeat('3',64),'{"version":1}'::jsonb,
      repeat('3',64),'COMPLETE',1,1,1,null,1,1,statement_timestamp()
    ) on conflict (organization_id,id) do nothing;
    insert into public.openclaw_retention_tombstones(
      id,organization_id,maintenance_principal_id,work_item_id,subject_kind,
      subject_id,retention_version,hold_version,quarantine_version,object_key,
      redaction_evidence_hash,quarantined_at,final_delete_not_before
    ) values (
      '99999999-9999-4999-8999-000000000013','${DEMO_ORG_ID}',
      '44444444-4444-4444-8444-444444444444',
      '99999999-9999-4999-8999-000000000012','MEDIA',
      '99999999-9999-4999-8999-000000000011',1,0,1,
      'v1/org/${DEMO_ORG_ID}/retention/hold-race',
      repeat('4',64),statement_timestamp()-interval '8 days',
      statement_timestamp()-interval '1 day'
    ) on conflict (organization_id,id) do nothing;
    insert into public.openclaw_maintenance_work_items(
      id,organization_id,maintenance_principal_id,work_kind,work_phase,
      source_id,source_version,source_key,source_hash,payload,payload_hash,
      state,claim_token_hash,claim_generation,maintenance_lease_generation,
      fencing_token,lease_expires_at,attempt_count,credential_generation
    ) values (
      '99999999-9999-4999-8999-000000000014','${DEMO_ORG_ID}',
      '44444444-4444-4444-8444-444444444444','RETENTION_DELETE','FINAL_DELETE',
      '99999999-9999-4999-8999-000000000013','1',
      'retention:final:hold-race',repeat('5',64),
      jsonb_build_object(
        'version',1,'subjectKind','MEDIA',
        'subjectId','99999999-9999-4999-8999-000000000011',
        'tombstoneId','99999999-9999-4999-8999-000000000013',
        'quarantineVersion',1,
        'finalDeleteNotBefore',statement_timestamp()-interval '1 day',
        'scopeVersion',0
      ),repeat('5',64),'LEASED',
      encode(extensions.digest(
        convert_to('ihome-openclaw-work-claim-v1','UTF8')||decode('00','hex')
          ||convert_to('${claimToken}','UTF8'),'sha256'
      ),'hex'),
      1,1,1,statement_timestamp()+interval '30 seconds',1,1
    ) on conflict (organization_id,id) do nothing;
    set session_replication_role='origin';
    insert into public.openclaw_retention_holds(
      organization_id,target_kind,target_id,reason,created_by
    ) values (
      '${DEMO_ORG_ID}','MEDIA',
      '99999999-9999-4999-8999-000000000011',
      'concurrency final delete hold',
      '99999999-9999-4999-8999-999999999999'
    );
  `);
  return {
    claimToken,
    workItemId: "99999999-9999-4999-8999-000000000014",
    mediaId: "99999999-9999-4999-8999-000000000011",
  };
}

async function prepareRetentionDeleteTicket(database, code) {
  const suffix = String(code).padStart(12, "0");
  const messageId = `99990000-0000-4000-8000-${suffix}`;
  const mediaId = `99991000-0000-4000-8000-${suffix}`;
  const quarantineWorkId = `99992000-0000-4000-8000-${suffix}`;
  const tombstoneId = `99993000-0000-4000-8000-${suffix}`;
  const workItemId = `99994000-0000-4000-8000-${suffix}`;
  const ticketId = `99995000-0000-4000-8000-${suffix}`;
  const ticketJti = `99996000-0000-4000-8000-${suffix}`;
  const authorizationJti = `99997000-0000-4000-8000-${suffix}`;
  const objectKey = `v1/org/${DEMO_ORG_ID}/retention/${code}`;
  await database.exec(
    `
      set session_replication_role='replica';
      insert into public.openclaw_messages(
        id,organization_id,account_id,conversation_id,direction,text_content,
        payload_hash
      ) values (
        '${messageId}','${DEMO_ORG_ID}','11111111-1111-4111-8111-111111111111',
        '55555555-5555-4555-8555-555555555556','INBOUND',
        '[REDACTED_BY_RETENTION]',repeat('6',64)
      ) on conflict (organization_id,id) do nothing;
      insert into public.openclaw_message_media(
        id,organization_id,account_id,conversation_id,message_id,media_index,
        media_kind,byte_state,object_key,retention_delete_not_before
      ) values (
        '${mediaId}','${DEMO_ORG_ID}','11111111-1111-4111-8111-111111111111',
        '55555555-5555-4555-8555-555555555556','${messageId}',0,'IMAGE',
        'QUARANTINED',null,statement_timestamp()-interval '1 day'
      ) on conflict (organization_id,id) do nothing;
      insert into public.openclaw_maintenance_work_items(
        id,organization_id,maintenance_principal_id,work_kind,work_phase,
        source_id,source_version,source_key,source_hash,payload,payload_hash,
        state,claim_generation,maintenance_lease_generation,fencing_token,
        attempt_count,credential_generation,terminal_at
      ) values (
        '${quarantineWorkId}','${DEMO_ORG_ID}','44444444-4444-4444-8444-444444444444',
        'RETENTION_DELETE','QUARANTINE','${mediaId}','1:0',
        'retention:quarantine:ticket:${code}',
        repeat('7',64),'{"version":1}'::jsonb,repeat('7',64),
        'COMPLETE',1,1,1,1,1,statement_timestamp()
      ) on conflict (organization_id,id) do nothing;
      insert into public.openclaw_retention_tombstones(
        id,organization_id,maintenance_principal_id,work_item_id,subject_kind,
        subject_id,retention_version,hold_version,quarantine_version,object_key,
        redaction_evidence_hash,quarantined_at,final_delete_not_before
      ) values (
        '${tombstoneId}','${DEMO_ORG_ID}','44444444-4444-4444-8444-444444444444',
        '${quarantineWorkId}','MEDIA','${mediaId}',1,0,1,'${objectKey}',repeat('8',64),
        statement_timestamp()-interval '8 days',
        statement_timestamp()-interval '1 day'
      ) on conflict (organization_id,id) do nothing;
      insert into public.openclaw_maintenance_work_items(
        id,organization_id,maintenance_principal_id,work_kind,work_phase,
        source_id,source_version,source_key,source_hash,payload,payload_hash,
        state,claim_generation,maintenance_lease_generation,fencing_token,
        attempt_count,credential_generation
      ) values (
        '${workItemId}','${DEMO_ORG_ID}','44444444-4444-4444-8444-444444444444',
        'RETENTION_DELETE','FINAL_DELETE','${tombstoneId}','1',
        'retention:final:ticket:${code}',
        repeat('9',64),
        jsonb_build_object(
          'version',1,'subjectKind','MEDIA','subjectId','${mediaId}',
          'tombstoneId','${tombstoneId}',
          'quarantineVersion',1,
          'finalDeleteNotBefore',statement_timestamp()-interval '1 day',
          'scopeVersion',0
        ),repeat('9',64),'DELETE_AUTHORIZED',1,1,1,1,1
      ) on conflict (organization_id,id) do nothing;
      with timing as (
        select statement_timestamp() authorized_at,
          statement_timestamp()+interval '4 seconds' expires_at
      ), claims as (
        select timing.*,
          jsonb_build_object(
            'version',1,'organizationId','${DEMO_ORG_ID}',
            'maintenancePrincipalId','44444444-4444-4444-8444-444444444444',
            'workItemId','${workItemId}','claimGeneration',1,'credentialGeneration',1,
            'leaseGeneration',1,'fencingToken',1,'deletePhase','FINAL_DELETE',
            'ticketJti','${ticketJti}',
            'deleteAuthorizationJti','${authorizationJti}',
            'objectKey','${objectKey}',
            'holdVersion',0,'quarantineVersion',1,'domainHash',repeat('a',64),
            'signingKeyGeneration',1,'expiresAt',timing.expires_at
          ) expected
        from timing
      ), payload as (
        select claims.*,
          expected||jsonb_build_object(
            'tombstoneId','${tombstoneId}','subjectId','${mediaId}',
            'authorizedAt',authorized_at
          ) ticket_payload
        from claims
      ), canonical as (
        select payload.*,
          app_private.openclaw_jcs_bytes_v1(ticket_payload) ticket_bytes
        from payload
      )
      insert into public.openclaw_retention_delete_tickets(
        id,organization_id,maintenance_principal_id,work_item_id,tombstone_id,
        subject_id,object_key,ticket_jti,delete_authorization_jti,
        claim_generation,credential_generation,maintenance_lease_generation,
        fencing_token,hold_version,quarantine_version,signing_key_generation,
        domain_hash,ticket_payload,ticket_bytes,ticket_hash,
        expected_receipt_claims,authorized_at,expires_at
      )
      select
        '${ticketId}','${DEMO_ORG_ID}','44444444-4444-4444-8444-444444444444',
        '${workItemId}','${tombstoneId}','${mediaId}','${objectKey}',
        '${ticketJti}','${authorizationJti}',1,1,1,1,0,1,1,repeat('a',64),
        ticket_payload,ticket_bytes,
        encode(extensions.digest(
          convert_to('ihome-openclaw-retention-delete-ticket-v1','UTF8')
            ||decode('00','hex')||ticket_bytes,'sha256'
        ),'hex'),expected,authorized_at,expires_at
      from canonical
      on conflict (organization_id,id) do nothing;
      set session_replication_role='origin';
    `,
  );
  const ticket = await database.query(
    `select id::text id,expected_receipt_claims
     from public.openclaw_retention_delete_tickets where id=$1`,
    [ticketId],
  );
  return {
    ticketId,
    workItemId,
    mediaId,
    expectedReceiptClaims: ticket.rows[0].expected_receipt_claims,
  };
}

function retentionReceipt(ticket, outcome, overrides = {}) {
  return {
    ...ticket.expectedReceiptClaims,
    preverified: true,
    outcome,
    signatureHash: "b".repeat(64),
    ...overrides,
  };
}

async function finalizeRetentionTicket(database, ticket, receipt) {
  return database.query(
    `select app_private.openclaw_finalize_retention_delete_v1(
      $1::jsonb,'{}'::jsonb,$2::jsonb
    ) result`,
    [
      JSON.stringify(maintenancePrincipal()),
      JSON.stringify({
        version: 1,
        ticketId: ticket.ticketId,
        gatewayReceipt: receipt,
      }),
    ],
  );
}

async function prepareAuditAnchorFixture(database, code) {
  const suffix = String(code).padStart(12, "0");
  const auditRootId = `aaaa0000-0000-4000-8000-${suffix}`;
  const workItemId = `aaaa1000-0000-4000-8000-${suffix}`;
  const verifyTicketJti = `aaaa2000-0000-4000-8000-${suffix}`;
  const claimToken = `audit-anchor-${code}`;
  const rootHash = code === 21 ? "c".repeat(64) : "d".repeat(64);
  const rootDate = code === 21 ? "2026-06-21" : "2026-06-22";
  const objectKey =
    `v1/org/${DEMO_ORG_ID}/audit/${rootDate}/${auditRootId}.json`;
  await database.exec(`
    set session_replication_role='replica';
    insert into public.openclaw_audit_roots(
      id,organization_id,root_date,first_sequence,last_sequence,root_hash,
      event_count,signing_key_generation,r2_anchor_key
    ) values (
      '${auditRootId}','${DEMO_ORG_ID}','${rootDate}',1,1,'${rootHash}',
      1,1,'${objectKey}'
    ) on conflict (organization_id,id) do nothing;
    insert into public.openclaw_maintenance_work_items(
      id,organization_id,maintenance_principal_id,work_kind,work_phase,
      source_id,source_version,source_key,source_hash,payload,payload_hash,
      state,claim_token_hash,claim_generation,maintenance_lease_generation,
      fencing_token,lease_expires_at,attempt_count,credential_generation
    ) values (
      '${workItemId}','${DEMO_ORG_ID}',
      '44444444-4444-4444-8444-444444444444','AUDIT_ANCHOR','ANCHOR',
      '${auditRootId}','1','audit:fixture:${code}',repeat('e',64),
      jsonb_build_object(
        'version',1,'auditRootId','${auditRootId}','rootDate','${rootDate}',
        'rootHash','${rootHash}','firstSequence',1,'lastSequence',1,
        'eventCount',1,'signingKeyGeneration',1,'r2AnchorKey','${objectKey}'
      ),repeat('e',64),'LEASED',
      encode(extensions.digest(
        convert_to('ihome-openclaw-work-claim-v1','UTF8')||decode('00','hex')
          ||convert_to('${claimToken}','UTF8'),'sha256'
      ),'hex'),1,1,1,statement_timestamp()+interval '30 seconds',1,1
    ) on conflict (organization_id,id) do nothing;
    set session_replication_role='origin';
  `);
  const receipt = {
    version: 1,
    preverified: true,
    outcome: "VERIFIED",
    organizationId: DEMO_ORG_ID,
    maintenancePrincipalId: "44444444-4444-4444-8444-444444444444",
    workItemId,
    claimGeneration: 1,
    credentialGeneration: 1,
    leaseGeneration: 1,
    fencingToken: 1,
    auditRootId,
    rootHash,
    objectKey,
    verifyTicketJti,
    signingKeyGeneration: 1,
    signatureHash: "f".repeat(64),
  };
  return {
    auditRootId,
    workItemId,
    verifyTicketJti,
    claimToken,
    receipt,
  };
}

async function acknowledgeAuditAnchor(database, fixture, receipt) {
  return database.query(
    `select app_private.openclaw_ack_audit_anchor_v1(
      $1::jsonb,'{}'::jsonb,$2::jsonb
    ) result`,
    [
      JSON.stringify(maintenancePrincipal()),
      JSON.stringify({
        version: 1,
        workItemId: fixture.workItemId,
        claimGeneration: 1,
        claimToken: fixture.claimToken,
        verifyTicketJti: fixture.verifyTicketJti,
        gatewayReceipt: receipt,
      }),
    ],
  );
}

async function runConcurrent(database, operations, { settled = false } = {}) {
  if (typeof database.runConcurrent === "function") {
    return database.runConcurrent(operations, { settled });
  }
  const pending = operations.map((operation) => operation(database));
  return settled ? Promise.allSettled(pending) : Promise.all(pending);
}

export async function runDisposableConcurrencyScenario(database, scenario) {
  if (scenario === "OUTBOX_SINGLE_CLAIM") {
    const outboxId = await insertConcurrencyOutbox(database, scenario);
    const claims = await runConcurrent(database, [
      (session) => session.query(
        `select app_private.openclaw_claim_outbox_v1($1::jsonb,'{}'::jsonb,$2::jsonb) result`,
        [
          JSON.stringify(channelPrincipal()),
          JSON.stringify({ version: 1, claimToken: "claim-a", limit: 1, leaseSeconds: 30 }),
        ],
      ),
      (session) => session.query(
        `select app_private.openclaw_claim_outbox_v1($1::jsonb,'{}'::jsonb,$2::jsonb) result`,
        [
          JSON.stringify(channelPrincipal()),
          JSON.stringify({ version: 1, claimToken: "claim-b", limit: 1, leaseSeconds: 30 }),
        ],
      ),
    ]);
    const itemCounts = claims.map((claim) => claim.rows[0].result.items.length).sort();
    if (JSON.stringify(itemCounts) !== JSON.stringify([0, 1])) {
      throw new Error("Concurrent outbox claims did not produce exactly one winner.");
    }
    const row = await database.query(
      `select state,claim_generation from public.openclaw_outbox where id=$1`,
      [outboxId],
    );
    if (row.rows[0].state !== "LEASED" || Number(row.rows[0].claim_generation) !== 1) {
      throw new Error("Outbox winner did not persist the exact claim generation.");
    }
    return;
  }
  if (scenario === "WORK_SINGLE_CLAIM") {
    const workId = "bbbbbbbb-bbbb-4bbb-8bbb-000000000101";
    await database.exec(`
      set session_replication_role='replica';
      insert into public.openclaw_send_work_items(
        id,organization_id,account_id,cell_id,work_kind,source_id,source_version,
        source_key,source_hash,payload,payload_hash,state,claim_generation,
        fencing_token,session_generation,target_id,credential_generation,
        runtime_lease_generation,schedule_id,schedule_version,schedule_occurrence_id
      ) values (
        '${workId}','${DEMO_ORG_ID}','11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222','SCHEDULE_OCCURRENCE',
        'bbbbbbbb-bbbb-4bbb-8bbb-000000000102','1',
        'concurrency:work:single-claim',repeat('a',64),
        jsonb_build_object('kind','SCHEDULE_OCCURRENCE','targetId',
          '55555555-5555-4555-8555-555555555555'),repeat('b',64),
        'QUEUED',0,1,1,'55555555-5555-4555-8555-555555555555',1,1,
        'bbbbbbbb-bbbb-4bbb-8bbb-000000000103',1,
        'bbbbbbbb-bbbb-4bbb-8bbb-000000000102'
      ) on conflict (organization_id,id) do nothing;
      set session_replication_role='origin';
    `);
    const claims = await runConcurrent(database, [
      (session) => session.query(
        `select app_private.openclaw_claim_work_item_v1(
          $1::jsonb,'{}'::jsonb,$2::jsonb
        ) result`,
        [
          JSON.stringify(channelPrincipal()),
          JSON.stringify({
            version: 1,
            claimToken: "work-claim-a",
            limit: 1,
            leaseSeconds: 30,
          }),
        ],
      ),
      (session) => session.query(
        `select app_private.openclaw_claim_work_item_v1(
          $1::jsonb,'{}'::jsonb,$2::jsonb
        ) result`,
        [
          JSON.stringify(channelPrincipal()),
          JSON.stringify({
            version: 1,
            claimToken: "work-claim-b",
            limit: 1,
            leaseSeconds: 30,
          }),
        ],
      ),
    ]);
    const itemCounts = claims.map((claim) => claim.rows[0].result.items.length).sort();
    const row = await database.query(
      `select state,claim_generation,credential_generation,
        runtime_lease_generation,fencing_token
       from public.openclaw_send_work_items where id=$1`,
      [workId],
    );
    if (
      JSON.stringify(itemCounts) !== JSON.stringify([0, 1]) ||
      row.rows[0].state !== "LEASED" ||
      Number(row.rows[0].claim_generation) !== 1 ||
      Number(row.rows[0].credential_generation) !== 1 ||
      Number(row.rows[0].runtime_lease_generation) !== 1 ||
      Number(row.rows[0].fencing_token) !== 1
    ) {
      throw new Error("Concurrent send-work claims did not preserve one exact winner.");
    }
    return;
  }
  if (scenario === "EXPIRED_LEASE_RECLAIM") {
    const outboxId = await insertConcurrencyOutbox(database, scenario, "LEASED");
    await database.query(
      `select app_private.sweep_openclaw_delivery_claims_v1($1,$2,null)`,
      [DEMO_ORG_ID, "11111111-1111-4111-8111-111111111111"],
    );
    const row = await database.query(
      `select state,claim_generation,claim_token_hash
       from public.openclaw_outbox where id=$1`,
      [outboxId],
    );
    if (row.rows[0].state !== "QUEUED" ||
        Number(row.rows[0].claim_generation) !== 2 ||
        row.rows[0].claim_token_hash !== null) {
      throw new Error("Expired pre-handoff lease was not safely requeued.");
    }
    return;
  }
  if (scenario === "STALE_FENCE_REJECTED") {
    const outboxId = await insertConcurrencyOutbox(database, scenario);
    let rejected = false;
    try {
      await database.query(
        `select app_private.openclaw_claim_outbox_v1($1::jsonb,'{}'::jsonb,$2::jsonb)`,
        [
          JSON.stringify(channelPrincipal(999)),
          JSON.stringify({ version: 1, claimToken: "stale-fence", limit: 1 }),
        ],
      );
    } catch (error) {
      rejected = /stale/i.test(String(error?.message ?? error));
    }
    const row = await database.query(
      `select state,claim_generation from public.openclaw_outbox where id=$1`,
      [outboxId],
    );
    if (!rejected || row.rows[0].state !== "QUEUED" || Number(row.rows[0].claim_generation) !== 0) {
      throw new Error("A stale fence changed the outbox.");
    }
    return;
  }
  if (scenario === "PRE_HANDOFF_REQUEUE") {
    const outboxId = await insertConcurrencyOutbox(database, scenario);
    await database.query(
      `select app_private.openclaw_claim_outbox_v1($1::jsonb,'{}'::jsonb,$2::jsonb)`,
      [
        JSON.stringify(channelPrincipal()),
        JSON.stringify({
          version: 1,
          claimToken: "pre-handoff-requeue",
          limit: 1,
          leaseSeconds: 30,
        }),
      ],
    );
    const result = await database.query(
      `select app_private.openclaw_requeue_pre_handoff_v1(
        $1::jsonb,'{}'::jsonb,$2::jsonb
      ) result`,
      [
        JSON.stringify(channelPrincipal()),
        JSON.stringify({
          version: 1,
          outboxId,
          claimGeneration: 1,
          claimToken: "pre-handoff-requeue",
          retryAfterSeconds: 1,
        }),
      ],
    );
    const row = await database.query(
      `select state,claim_generation,claim_token_hash
       from public.openclaw_outbox where id=$1`,
      [outboxId],
    );
    if (
      result.rows[0].result.state !== "QUEUED" ||
      row.rows[0].state !== "QUEUED" ||
      Number(row.rows[0].claim_generation) !== 2 ||
      row.rows[0].claim_token_hash !== null
    ) {
      throw new Error("Pre-handoff requeue did not atomically revoke the claim.");
    }
    return;
  }
  if (scenario === "UNKNOWN_SINGLE_WINNER") {
    const outboxId = await insertConcurrencyOutbox(database, scenario, "UNKNOWN");
    await database.query(
      `select set_config(
        'request.jwt.claim.sub','99999999-9999-4999-8999-999999999999',false
      )`,
    );
    const authority = await database.query(
      `
        with authority as (
          select jsonb_build_object(
            'version',1,'outboxId',outbox.id,'organizationId',outbox.organization_id,
            'accountId',outbox.account_id,'state',outbox.state,
            'resolutionVersion',outbox.resolution_version,
            'payloadHash',outbox.payload_hash,'claimGeneration',outbox.claim_generation,
            'fencingToken',outbox.fencing_token,
            'sessionGeneration',outbox.session_generation,
            'controlVersion',outbox.control_version,
            'takeoverVersion',outbox.takeover_version,'attempts','[]'::jsonb
          ) value
          from public.openclaw_outbox outbox where outbox.id=$1
        )
        select encode(extensions.digest(
          convert_to('ihome-openclaw-unknown-authority-v1','UTF8')
            ||decode('00','hex')||app_private.openclaw_jcs_bytes_v1(value),
          'sha256'
        ),'hex') value from authority
      `,
      [outboxId],
    );
    const request = {
      version: 1,
      organizationId: DEMO_ORG_ID,
      outboxId,
      expectedResolutionVersion: 0,
      expectedEvidenceDomain: "ihome-openclaw-unknown-authority-v1\\0",
      expectedEvidenceHash: authority.rows[0].value,
      outcome: "CONFIRMED_FAILED",
      reasonCode: "OPERATOR_CONFIRMED_FAILED",
      operatorEvidenceHash: "9".repeat(64),
      newIntent: null,
    };
    const calls = await runConcurrent(database, [
      (session) => session.query(
        `select public.openclaw_resolve_unknown_v1($1::jsonb,$2::uuid) result`,
        [JSON.stringify(request), "99999999-9999-4999-8999-000000000001"],
      ),
      (session) => session.query(
        `select public.openclaw_resolve_unknown_v1($1::jsonb,$2::uuid) result`,
        [JSON.stringify(request), "99999999-9999-4999-8999-000000000002"],
      ),
    ], { settled: true });
    const winners = calls.filter((call) => call.status === "fulfilled");
    const losers = calls.filter(
      (call) =>
        call.status === "rejected" &&
        /CAS|winner|resolved|version/i.test(
          String(call.reason?.message ?? call.reason),
        ),
    );
    const state = await database.query(
      `select state,resolution_version,
        (select count(*)::integer from public.openclaw_unknown_resolutions
         where outbox_id=$1) resolution_count
       from public.openclaw_outbox where id=$1`,
      [outboxId],
    );
    if (
      winners.length !== 1 ||
      losers.length !== 1 ||
      state.rows[0].state !== "UNKNOWN" ||
      Number(state.rows[0].resolution_version) !== 1 ||
      state.rows[0].resolution_count !== 1
    ) {
      throw new Error(
        `UNKNOWN resolution did not preserve one immutable CAS winner: ${JSON.stringify({
          calls: calls.map((call) =>
            call.status === "fulfilled"
              ? "fulfilled"
              : String(call.reason?.message ?? call.reason),
          ),
          state: state.rows[0],
        })}`,
      );
    }
    return;
  }
  if (scenario === "DUPLICATE_SCHEDULE_MATERIALIZER") {
    await prepareScheduleFixture(database);
    const results = await runConcurrent(database, [
      (session) => session.query(
        `select app_private.materialize_openclaw_schedule_work_v1(10) value`,
      ),
      (session) => session.query(
        `select app_private.materialize_openclaw_schedule_work_v1(10) value`,
      ),
    ]);
    const counts = results.map((result) => Number(result.rows[0].value)).sort();
    const proof = await database.query(`
      select
        (select count(*)::integer from public.openclaw_schedule_occurrences
         where schedule_id='77777777-7777-4777-8777-777777777771') occurrence_count,
        (select count(*)::integer from public.openclaw_send_work_items
         where schedule_id='77777777-7777-4777-8777-777777777771') work_count
    `);
    if (
      JSON.stringify(counts) !== JSON.stringify([0, 1]) ||
      proof.rows[0].occurrence_count !== 1 ||
      proof.rows[0].work_count !== 1
    ) {
      throw new Error(
        "Duplicate schedule materializers did not converge to one work item.",
      );
    }
    return;
  }
  if (scenario === "CRM_FANOUT_IDEMPOTENCY") {
    await prepareCrmFixture(database);
    const results = await runConcurrent(database, [
      (session) => session.query(
        `select app_private.materialize_openclaw_crm_work_v1(10) value`,
      ),
      (session) => session.query(
        `select app_private.materialize_openclaw_crm_work_v1(10) value`,
      ),
    ]);
    const counts = results.map((result) => Number(result.rows[0].value)).sort();
    const proof = await database.query(`
      select count(*)::integer as count
      from public.openclaw_send_work_items
      where subscription_id='88888888-8888-4888-8888-888888888881'
        and crm_occurrence_id='88888888-8888-4888-8888-888888888882'
    `);
    if (
      JSON.stringify(counts) !== JSON.stringify([0, 1]) ||
      proof.rows[0].count !== 1
    ) {
      throw new Error("CRM fan-out did not materialize exactly once.");
    }
    return;
  }
  if (scenario === "RETENTION_QUARANTINE_HOLD_RACE") {
    const work = await prepareRetentionQuarantineRace(database);
    let rejected = false;
    try {
      await database.query(
        `select app_private.openclaw_complete_retention_quarantine_v1(
          $1::jsonb,'{}'::jsonb,$2::jsonb
        )`,
        [
          JSON.stringify(maintenancePrincipal()),
          JSON.stringify({
            version: 1,
            workItemId: work.id,
            claimGeneration: work.claim_generation,
            claimToken: "retention-quarantine-hold",
          }),
        ],
      );
    } catch (error) {
      rejected = error?.code === "40001" || /hold/i.test(String(error?.message ?? error));
    }
    const proof = await database.query(`
      select message.text_content,
        (select count(*)::integer from public.openclaw_retention_tombstones
         where subject_id=message.id) tombstone_count
      from public.openclaw_messages message
      where message.id='99999999-9999-4999-8999-000000000001'
    `);
    if (
      !rejected ||
      proof.rows[0].text_content !== "held quarantine message" ||
      proof.rows[0].tombstone_count !== 0
    ) {
      throw new Error("A legal hold did not win before quarantine CAS.");
    }
    return;
  }
  if (scenario === "RETENTION_FINAL_DELETE_HOLD_RACE") {
    const fixture = await prepareFinalDeleteHoldRace(database);
    let rejected = false;
    try {
      await database.query(
        `select app_private.openclaw_authorize_retention_delete_v1(
          $1::jsonb,'{}'::jsonb,$2::jsonb
        )`,
        [
          JSON.stringify(maintenancePrincipal()),
          JSON.stringify({
            version: 1,
            workItemId: fixture.workItemId,
            claimGeneration: 1,
            claimToken: fixture.claimToken,
          }),
        ],
      );
    } catch (error) {
      rejected = error?.code === "42501" || /hold/i.test(String(error?.message ?? error));
    }
    const proof = await database.query(
      `select media.byte_state,
        (select count(*)::integer from public.openclaw_retention_delete_tickets
         where work_item_id=$1) ticket_count
       from public.openclaw_message_media media where media.id=$2`,
      [fixture.workItemId, fixture.mediaId],
    );
    if (
      !rejected ||
      proof.rows[0].byte_state !== "QUARANTINED" ||
      proof.rows[0].ticket_count !== 0
    ) {
      throw new Error("A legal hold did not block final delete authorization.");
    }
    return;
  }
  if (scenario === "RETENTION_QUARANTINE_R2_INDEPENDENT") {
    const work = await prepareRetentionQuarantineSuccess(database);
    const result = await database.query(
      `select app_private.openclaw_complete_retention_quarantine_v1(
        $1::jsonb,'{}'::jsonb,$2::jsonb
      ) result`,
      [
        JSON.stringify(maintenancePrincipal()),
        JSON.stringify({
          version: 1,
          workItemId: work.id,
          claimGeneration: work.claim_generation,
          claimToken: work.claimToken,
        }),
      ],
    );
    const proof = await database.query(
      `select media.byte_state,media.object_key,
        tombstone.object_key tombstone_object_key,
        tombstone.id::text tombstone_id,
        extract(epoch from (
          tombstone.final_delete_not_before-tombstone.quarantined_at
        ))::integer grace_seconds,
        (select state from public.openclaw_maintenance_work_items work
          where work.id=$2) work_state,
        (select count(*)::integer from public.openclaw_retention_delete_tickets ticket
          where ticket.tombstone_id=tombstone.id) ticket_count
       from public.openclaw_message_media media
       join public.openclaw_retention_tombstones tombstone
         on tombstone.organization_id=media.organization_id
        and tombstone.subject_kind='MEDIA'
        and tombstone.subject_id=media.id
       where media.id=$1`,
      [work.subjectId, work.id],
    );
    if (
      proof.rows[0].work_state !== "COMPLETE" ||
      result.rows[0].result.subjectKind !== "MEDIA" ||
      proof.rows[0].byte_state !== "QUARANTINED" ||
      proof.rows[0].object_key !== null ||
      proof.rows[0].tombstone_object_key !== work.objectKey ||
      Number(proof.rows[0].grace_seconds) !== 604800 ||
      Number(proof.rows[0].ticket_count) !== 0
    ) {
      const diagnostic = JSON.stringify({
        workState: proof.rows[0]?.work_state ?? null,
        resultSubjectKind: result.rows[0]?.result?.subjectKind ?? null,
        byteState: proof.rows[0]?.byte_state ?? null,
        mediaObjectKeyCleared: proof.rows[0]?.object_key === null,
        tombstoneObjectKeyBound:
          proof.rows[0]?.tombstone_object_key === work.objectKey,
        graceSeconds: Number(proof.rows[0]?.grace_seconds),
        ticketCount: Number(proof.rows[0]?.ticket_count),
      });
      throw new Error(
        `Quarantine was not DB-only or did not bind the exact seven-day grace: ${diagnostic}`,
      );
    }
    return;
  }
  if (scenario === "RETENTION_FINAL_DELETE_GRACE_BARRIER") {
    const materialized = await database.query(
      `select app_private.materialize_openclaw_retention_final_delete_v1(100) value`,
    );
    const proof = await database.query(`
      select
        (select count(*)::integer from public.openclaw_retention_tombstones
          where subject_id='99999999-9999-4999-8999-000000000020'
            and final_delete_not_before>statement_timestamp()) future_tombstone_count,
        (select count(*)::integer from public.openclaw_maintenance_work_items work
          join public.openclaw_retention_tombstones tombstone
            on tombstone.organization_id=work.organization_id
           and tombstone.id=work.source_id
          where tombstone.subject_id='99999999-9999-4999-8999-000000000020'
            and work.work_phase='FINAL_DELETE') final_work_count,
        (select count(*)::integer from public.openclaw_retention_delete_tickets ticket
          join public.openclaw_retention_tombstones tombstone
            on tombstone.organization_id=ticket.organization_id
           and tombstone.id=ticket.tombstone_id
          where tombstone.subject_id='99999999-9999-4999-8999-000000000020') ticket_count
    `);
    if (
      Number(materialized.rows[0].value) !== 0 ||
      proof.rows[0].future_tombstone_count !== 1 ||
      proof.rows[0].final_work_count !== 0 ||
      proof.rows[0].ticket_count !== 0
    ) {
      throw new Error("Final delete became claimable before the seven-day grace.");
    }
    return;
  }
  if (scenario === "RETENTION_DUPLICATE_PHASE_MATERIALIZER") {
    const subjectId = "99999999-9999-4999-8999-000000000021";
    await database.exec(`
      set session_replication_role='replica';
      insert into public.openclaw_messages(
        id,organization_id,account_id,conversation_id,direction,text_content,
        payload_hash,received_at,created_at
      ) values (
        '${subjectId}','${DEMO_ORG_ID}',
        '11111111-1111-4111-8111-111111111111',
        '55555555-5555-4555-8555-555555555556','INBOUND',
        'duplicate phase fixture',repeat('7',64),
        statement_timestamp()-interval '181 days',
        statement_timestamp()-interval '181 days'
      ) on conflict (organization_id,id) do nothing;
      set session_replication_role='origin';
    `);
    const materialized = await runConcurrent(database, [
      (session) => session.query(
        `select app_private.materialize_openclaw_retention_quarantine_v1(10) value`,
      ),
      (session) => session.query(
        `select app_private.materialize_openclaw_retention_quarantine_v1(10) value`,
      ),
    ]);
    const counts = materialized.map((row) => Number(row.rows[0].value)).sort();
    const proof = await database.query(
      `select count(*)::integer count
       from public.openclaw_maintenance_work_items
       where source_id=$1 and work_phase='QUARANTINE'`,
      [subjectId],
    );
    if (
      JSON.stringify(counts) !== JSON.stringify([0, 1]) ||
      proof.rows[0].count !== 1
    ) {
      throw new Error("Concurrent retention materializers created duplicate phase work.");
    }
    return;
  }
  if (scenario === "FORGED_DELETE_RECEIPT") {
    const ticket = await prepareRetentionDeleteTicket(database, 11);
    const forged = retentionReceipt(ticket, "DELETED", {
      objectKey: `${ticket.expectedReceiptClaims.objectKey}-forged`,
    });
    let rejected = false;
    try {
      await finalizeRetentionTicket(database, ticket, forged);
    } catch (error) {
      rejected = error?.code === "42501" || /receipt/i.test(String(error?.message ?? error));
    }
    const proof = await database.query(
      `select state,receipt is null receipt_absent
       from public.openclaw_retention_delete_tickets where id=$1`,
      [ticket.ticketId],
    );
    if (
      !rejected ||
      proof.rows[0].state !== "DELETE_AUTHORIZED" ||
      proof.rows[0].receipt_absent !== true
    ) {
      throw new Error("A forged delete receipt changed canonical state.");
    }
    return;
  }
  if (scenario === "AUTHENTICATED_NOT_FOUND_RECEIPT") {
    const ticket = await prepareRetentionDeleteTicket(database, 12);
    const receipt = retentionReceipt(ticket, "NOT_FOUND");
    const finalized = await finalizeRetentionTicket(database, ticket, receipt);
    const proof = await database.query(
      `select ticket.state,ticket.gateway_outcome,work.state work_state
       from public.openclaw_retention_delete_tickets ticket
       join public.openclaw_maintenance_work_items work
         on work.organization_id=ticket.organization_id
        and work.id=ticket.work_item_id
       where ticket.id=$1`,
      [ticket.ticketId],
    );
    if (
      finalized.rows[0].result.gatewayOutcome !== "NOT_FOUND" ||
      proof.rows[0].state !== "FINALIZED" ||
      proof.rows[0].gateway_outcome !== "NOT_FOUND" ||
      proof.rows[0].work_state !== "COMPLETE"
    ) {
      throw new Error("Authenticated NOT_FOUND did not finalize exactly once.");
    }
    return;
  }
  if (scenario === "LOST_GATEWAY_RESPONSE_REPLAY") {
    const ticket = await prepareRetentionDeleteTicket(database, 13);
    const receipt = retentionReceipt(ticket, "DELETED");
    const first = await finalizeRetentionTicket(database, ticket, receipt);
    const replay = await finalizeRetentionTicket(database, ticket, receipt);
    const proof = await database.query(
      `select
        (select count(*)::integer from public.openclaw_maintenance_work_attempts
         where work_item_id=$1) attempt_count,
        (select byte_state from public.openclaw_message_media where id=$2) byte_state`,
      [ticket.workItemId, ticket.mediaId],
    );
    if (
      first.rows[0].result.idempotentReplay !== false ||
      replay.rows[0].result.idempotentReplay !== true ||
      proof.rows[0].attempt_count !== 1 ||
      proof.rows[0].byte_state !== "DELETED"
    ) {
      throw new Error("A lost gateway response did not replay one persisted receipt.");
    }
    return;
  }
  if (scenario === "LOST_DB_FINALIZATION") {
    const ticket = await prepareRetentionDeleteTicket(database, 14);
    const receipt = retentionReceipt(ticket, "DELETED");
    await database.exec("begin");
    try {
      await finalizeRetentionTicket(database, ticket, receipt);
    } finally {
      await database.exec("rollback");
    }
    const beforeReplay = await database.query(
      `select state from public.openclaw_retention_delete_tickets where id=$1`,
      [ticket.ticketId],
    );
    const replay = await finalizeRetentionTicket(database, ticket, receipt);
    const proof = await database.query(
      `select ticket.state,
        (select count(*)::integer from public.openclaw_maintenance_work_attempts
         where work_item_id=$1) attempt_count
       from public.openclaw_retention_delete_tickets ticket where ticket.id=$2`,
      [ticket.workItemId, ticket.ticketId],
    );
    if (
      beforeReplay.rows[0].state !== "DELETE_AUTHORIZED" ||
      replay.rows[0].result.idempotentReplay !== false ||
      proof.rows[0].state !== "FINALIZED" ||
      proof.rows[0].attempt_count !== 1
    ) {
      throw new Error("A rolled-back DB finalization was not safely replayable.");
    }
    return;
  }
  if (scenario === "FORGED_AUDIT_RECEIPT") {
    const fixture = await prepareAuditAnchorFixture(database, 21);
    const forged = {
      ...fixture.receipt,
      rootHash: "0".repeat(64),
    };
    let rejected = false;
    try {
      await acknowledgeAuditAnchor(database, fixture, forged);
    } catch (error) {
      rejected = error?.code === "42501" || /receipt/i.test(String(error?.message ?? error));
    }
    const proof = await database.query(
      `select root.anchored_at,work.state
       from public.openclaw_audit_roots root
       join public.openclaw_maintenance_work_items work
         on work.organization_id=root.organization_id and work.source_id=root.id
       where root.id=$1`,
      [fixture.auditRootId],
    );
    if (
      !rejected ||
      proof.rows[0].anchored_at !== null ||
      proof.rows[0].state !== "LEASED"
    ) {
      throw new Error("A forged audit receipt changed the immutable audit root.");
    }
    return;
  }
  if (scenario === "LOST_AUDIT_ACKNOWLEDGEMENT") {
    const fixture = await prepareAuditAnchorFixture(database, 22);
    const first = await acknowledgeAuditAnchor(
      database,
      fixture,
      fixture.receipt,
    );
    const replay = await acknowledgeAuditAnchor(
      database,
      fixture,
      fixture.receipt,
    );
    const proof = await database.query(
      `select root.anchored_at is not null anchored,work.state,
        (select count(*)::integer from public.openclaw_maintenance_work_attempts
         where work_item_id=$1) attempt_count
       from public.openclaw_audit_roots root
       join public.openclaw_maintenance_work_items work
         on work.organization_id=root.organization_id and work.source_id=root.id
       where root.id=$2`,
      [fixture.workItemId, fixture.auditRootId],
    );
    if (
      first.rows[0].result.idempotentReplay !== false ||
      replay.rows[0].result.idempotentReplay !== true ||
      proof.rows[0].anchored !== true ||
      proof.rows[0].state !== "COMPLETE" ||
      proof.rows[0].attempt_count !== 1
    ) {
      throw new Error("A lost audit acknowledgement was not idempotently replayed.");
    }
    return;
  }

  const requiredFunctions = {
  };
  const functionName = requiredFunctions[scenario];
  if (!functionName) throw new Error(`Unknown concurrency scenario ${scenario}.`);
  const result = await database.query(
    `select count(*)::integer as count from pg_catalog.pg_proc where proname=$1`,
    [functionName],
  );
  if (result.rows[0].count === 0) {
    throw new Error(`Concurrency prerequisite function ${functionName} is missing.`);
  }
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function canonicalComparisonJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalComparisonJson).join(",")}]`;
  }
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalComparisonJson(child)}`)
    .join(",")}}`;
}

const FUNCTION_SNAPSHOT_SELECT = `
  select
    format('%I.%I(%s)',n.nspname,p.proname,
      pg_get_function_identity_arguments(p.oid)) as "signature",
    pg_get_userbyid(p.proowner) as "owner",
    p.prosecdef as "securityDefiner",
    coalesce(array_to_string(p.proconfig,E'\\n'),'') as "configuration",
    case when acl.grantee=0 then 'PUBLIC'
      else pg_get_userbyid(acl.grantee) end as "grantee",
    acl.privilege_type as "privilegeType",
    acl.is_grantable as "isGrantable"
  from pg_proc p
  join pg_namespace n on n.oid=p.pronamespace
  left join lateral aclexplode(
    coalesce(p.proacl,acldefault('f',p.proowner))
  ) acl on true
  where n.nspname in ('public','app_private')
    and (
      position('openclaw' in p.proname)>0
      or (n.nspname='public' and p.proname='trg_room_status_reconcile')
    )
  order by "signature","grantee","privilegeType","isGrantable"
`;

export function buildSchemaDriftQuery(manifest) {
  const values = manifest.entries
    .map((entry) =>
      `(${entry.order},${sqlLiteral(entry.version)},${sqlLiteral(entry.file)},${sqlLiteral(entry.name)})`,
    )
    .join(",\n      ");
  return `with expected("order",version,"fileName","migrationName") as (
    values ${values}
  ), migration_rows as (
    select expected."order",expected.version,expected."fileName",
      expected."migrationName",migration.name as "recordedName",
      cardinality(migration.statements) as "statementCount",
      case when cardinality(migration.statements)=1 then
        encode(extensions.digest(convert_to(migration.statements[1],'UTF8'),'sha256'),'hex')
      end as "recordedSha256"
    from expected
    left join supabase_migrations.schema_migrations migration
      on migration.version=expected.version
    order by expected."order"
  ), unsafe_views as (
    select relation.relname as "viewName"
    from pg_class relation
    join pg_namespace namespace on namespace.oid=relation.relnamespace
    where namespace.nspname='public' and relation.relkind='v'
      and not coalesce((
        select option_value::boolean
        from pg_options_to_table(relation.reloptions)
        where option_name='security_invoker'
      ),false)
    order by relation.relname
  ), function_rows as (
    ${FUNCTION_SNAPSHOT_SELECT}
  ), activation_columns as (
    select column_name as "columnName",column_default as "columnDefault",
      is_nullable as "isNullable"
    from information_schema.columns
    where table_schema='public' and table_name='openclaw_control_states'
      and column_name in (
        'feature_enabled','limited_auto_reply_enabled','proactive_enabled',
        'sales_groups_enabled','first_contact_enabled'
      )
    order by column_name
  )
  select jsonb_build_object(
    'migrations',coalesce((select jsonb_agg(to_jsonb(row) order by row."order")
      from migration_rows row),'[]'::jsonb),
    'unsafeViews',coalesce((select jsonb_agg(row."viewName" order by row."viewName")
      from unsafe_views row),'[]'::jsonb),
    'functions',coalesce((select jsonb_agg(to_jsonb(row)
      order by row."signature",row."grantee",row."privilegeType",row."isGrantable")
      from function_rows row),'[]'::jsonb),
    'activationColumns',coalesce((select jsonb_agg(to_jsonb(row) order by row."columnName")
      from activation_columns row),'[]'::jsonb),
    'enabledRowCount',(select count(*)::integer
      from public.openclaw_control_states state
      where state.feature_enabled or state.limited_auto_reply_enabled
        or state.proactive_enabled or state.sales_groups_enabled
        or state.first_contact_enabled)
  ) as snapshot`;
}

async function readOptionalFile(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

async function loadSchemaDriftAccessToken(environment = process.env) {
  const localConfig = await readOptionalFile(join(repositoryRoot, "CLAUDE.local.md"));
  return extractSupabaseAccessToken({ environment, localConfig });
}

export async function requestRemoteSchemaSnapshot({
  projectRef,
  manifest,
  environment = process.env,
  fetchImpl = fetch,
}) {
  if (projectRef !== EXPECTED_PROJECT_REF) {
    throw new Error("Schema snapshot project ref mismatch.");
  }
  const accessToken = await loadSchemaDriftAccessToken(environment);
  let response;
  try {
    response = await fetchImpl(
      `https://api.supabase.com/v1/projects/${projectRef}/database/query`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query: buildSchemaDriftQuery(manifest) }),
      },
    );
  } catch (error) {
    throw new Error(
      `Read-only schema snapshot request failed: ${redactSensitiveText(
        String(error?.message ?? error).replaceAll(accessToken, "[REDACTED_TOKEN]"),
      )}`,
    );
  }
  const body = await response.text();
  if (!response.ok) {
    throw new Error(
      `Read-only schema snapshot failed (${response.status}): ${redactSensitiveText(
        body.replaceAll(accessToken, "[REDACTED_TOKEN]"),
      ).slice(0, 2_000)}`,
    );
  }
  let rows;
  try {
    rows = JSON.parse(body);
  } catch {
    throw new Error("Read-only schema snapshot returned invalid JSON.");
  }
  const snapshot = rows?.[0]?.snapshot;
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new Error("Read-only schema snapshot returned no snapshot object.");
  }
  return snapshot;
}

export async function buildExpectedFunctionSnapshot(manifest) {
  const reviewedBytes = new Map(
    manifest.entries.map((entry) => [entry.file, entry.bytes]),
  );
  const database = await createDisposableOpenClawDatabase({
    readMigration: async (file) => {
      const bytes = reviewedBytes.get(file);
      if (!bytes) throw new Error(`Reviewed migration is missing: ${file}`);
      return bytes;
    },
  });
  try {
    const result = await database.query(FUNCTION_SNAPSHOT_SELECT);
    return result.rows;
  } finally {
    await database.close();
  }
}

async function readReviewedTypes(reviewedSha) {
  const result = await capture("git", [
    "cat-file",
    "blob",
    `${reviewedSha}:src/integrations/supabase/types.ts`,
  ]);
  if (result.code !== 0) throw new Error("Reviewed generated types blob is missing.");
  return result.stdoutBuffer.toString("utf8");
}

async function generateRemoteTypes({
  projectRef,
  environment = process.env,
  runCli = captureCliOutput,
}) {
  const accessToken = await loadSchemaDriftAccessToken(environment);
  const invocation = buildSupabaseCliInvocation(projectRef, process.platform, {
    npmExecPath: environment.npm_execpath,
    source: "project",
  });
  const childEnvironment = buildMinimalChildEnvironment(environment, {
    SUPABASE_ACCESS_TOKEN: accessToken,
  });
  try {
    const result = await runCli({
      ...invocation,
      cwd: repositoryRoot,
      env: childEnvironment,
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `Remote type generation exited with code ${result.exitCode}: ${String(
          result.stderr ?? "",
        ).replaceAll(accessToken, "[REDACTED_TOKEN]")}`,
      );
    }
    return buildGeneratedTypesFile(result.stdout);
  } finally {
    delete childEnvironment.SUPABASE_PAT;
    delete childEnvironment.SUPABASE_ACCESS_TOKEN;
  }
}

function schemaDriftFailure(reason) {
  return new Error(`${reason}\n${FORWARD_CORRECTIVE_INSTRUCTION}`);
}

function validateSchemaDriftSnapshot({ snapshot, manifest, expectedFunctions }) {
  if (!Array.isArray(snapshot.migrations) ||
      snapshot.migrations.length !== manifest.entries.length) {
    throw schemaDriftFailure("Remote migration identity cardinality mismatch.");
  }
  for (let index = 0; index < manifest.entries.length; index += 1) {
    const expected = manifest.entries[index];
    const actual = snapshot.migrations[index];
    if (
      Number(actual?.order) !== expected.order ||
      actual?.version !== expected.version ||
      actual?.fileName !== expected.file ||
      actual?.migrationName !== expected.name ||
      actual?.recordedName !== expected.name ||
      Number(actual?.statementCount) !== 1 ||
      actual?.recordedSha256 !== expected.sha256
    ) {
      throw schemaDriftFailure(`Remote migration identity mismatch at ${expected.file}.`);
    }
  }
  const recordedLines = snapshot.migrations
    .map((entry) => `${entry.fileName}:${entry.recordedSha256}\n`)
    .join("");
  const recordedAggregate = createHash("sha256")
    .update(MIGRATION_MANIFEST_DOMAIN)
    .update(Buffer.from([0]))
    .update(recordedLines)
    .digest("hex");
  if (recordedAggregate !== manifest.aggregateSha256) {
    throw schemaDriftFailure("Remote aggregate migration manifest mismatch.");
  }
  if (!Array.isArray(snapshot.unsafeViews) || snapshot.unsafeViews.length !== 0) {
    throw schemaDriftFailure("A public view is missing security_invoker=true.");
  }
  if (canonicalComparisonJson(snapshot.functions) !==
      canonicalComparisonJson(expectedFunctions)) {
    throw schemaDriftFailure("Function owner, search_path, or grant snapshot drifted.");
  }
  const expectedActivationColumns = [
    "feature_enabled",
    "first_contact_enabled",
    "limited_auto_reply_enabled",
    "proactive_enabled",
    "sales_groups_enabled",
  ];
  if (!Array.isArray(snapshot.activationColumns) ||
      snapshot.activationColumns.length !== expectedActivationColumns.length) {
    throw schemaDriftFailure("Activation-default column cardinality mismatch.");
  }
  for (let index = 0; index < expectedActivationColumns.length; index += 1) {
    const column = snapshot.activationColumns[index];
    if (
      column?.columnName !== expectedActivationColumns[index] ||
      column?.isNullable !== "NO" ||
      !/^\(?false\)?(?:::boolean)?$/i.test(String(column?.columnDefault ?? ""))
    ) {
      throw schemaDriftFailure(`Activation default drifted for ${expectedActivationColumns[index]}.`);
    }
  }
  if (Number(snapshot.enabledRowCount) !== 0) {
    throw schemaDriftFailure("An OpenClaw activation flag is already enabled.");
  }
}

export async function runSchemaDrift(
  { projectRef, reviewedSha },
  dependencies = {},
) {
  if (projectRef !== EXPECTED_PROJECT_REF || !/^[0-9a-f]{40}$/.test(reviewedSha ?? "")) {
    throw schemaDriftFailure("Schema drift identity is invalid.");
  }
  const loadManifest =
    dependencies.loadReviewedMigrationManifest ?? loadReviewedMigrationManifest;
  const buildFunctions =
    dependencies.buildExpectedFunctionSnapshot ?? buildExpectedFunctionSnapshot;
  const requestSnapshot =
    dependencies.requestRemoteSnapshot ?? requestRemoteSchemaSnapshot;
  const generateTypes = dependencies.generateRemoteTypes ?? generateRemoteTypes;
  const loadTypes = dependencies.readReviewedTypes ?? readReviewedTypes;
  try {
    const manifest = await loadManifest(reviewedSha);
    if (
      manifest.entries.length !== OPENCLAW_MIGRATIONS.length ||
      manifest.entries.some((entry, index) => entry.file !== OPENCLAW_MIGRATIONS[index])
    ) {
      throw schemaDriftFailure("Reviewed migration manifest is not the exact twelve-file chain.");
    }
    const expectedFunctions = await buildFunctions(manifest);
    const snapshotBefore = await requestSnapshot({
      projectRef,
      reviewedSha,
      manifest,
    });
    const [remoteTypes, reviewedTypes] = await Promise.all([
      generateTypes({ projectRef, reviewedSha }),
      loadTypes(reviewedSha),
    ]);
    const snapshotAfter = await requestSnapshot({
      projectRef,
      reviewedSha,
      manifest,
    });
    if (canonicalComparisonJson(snapshotBefore) !== canonicalComparisonJson(snapshotAfter)) {
      throw schemaDriftFailure("Remote schema changed while drift verification was running.");
    }
    validateSchemaDriftSnapshot({
      snapshot: snapshotAfter,
      manifest,
      expectedFunctions,
    });
    if (remoteTypes !== reviewedTypes) {
      throw schemaDriftFailure("Generated Supabase type shape differs from the reviewed blob.");
    }
    return {
      summary: `PASS read-only schema drift for reviewed SHA ${reviewedSha}`,
      migrationManifestSha256: manifest.aggregateSha256,
    };
  } catch (error) {
    const message = redactSensitiveText(error?.message ?? error);
    if (message.includes(FORWARD_CORRECTIVE_INSTRUCTION)) throw new Error(message);
    throw schemaDriftFailure(message);
  }
}

export async function runMigrationHarness(args = process.argv.slice(2)) {
  const options = parseMigrationHarnessArgs(args);
  if (options.mode === "schema-drift") return runSchemaDrift(options);
  const database = await createDisposableOpenClawDatabase({
    throughFile:
      options.mode === "local-file" ? options.file : OPENCLAW_MIGRATIONS.at(-1),
    verifyCli: true,
  });
  try {
    if (options.mode === "local") {
      await assertMigrationSmoke(database);
    }
    return {
      summary:
        options.mode === "local"
          ? "PASS OpenClaw 12-file disposable local migration chain"
          : `PASS ${options.file}`,
    };
  } finally {
    await database.close();
  }
}

async function main() {
  const result = await runMigrationHarness();
  process.stdout.write(`${result.summary}\n`);
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
