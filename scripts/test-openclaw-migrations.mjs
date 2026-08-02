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
  "operations.account-bounded-contracts",
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
export const CREDENTIAL_EXCHANGE_AUTHORIZATION_PROOFS = Object.freeze([
  "credential.channel-success",
  "credential.declared-channel-routes",
  "credential.maintenance-success",
  "credential.wrong-proof-domain-separated",
  "credential.cross-binding-denied",
  "credential.scope-revocation-denied",
  "credential.stale-principal-lease-denied",
  "credential.expired-envelope-denied",
  "credential.malformed-input-denied",
  "credential.auth-failure-does-not-consume-nonce",
  "credential.nonce-replay-denied",
  "credential.exchange-nonce-namespace-separated",
  "credential.disconnect-transition-heartbeat-only",
]);
export const BROWSER_DML_PRIVILEGE_MATRIX = Object.freeze([
  Object.freeze({ role: "anon", privilege: "INSERT" }),
  Object.freeze({ role: "anon", privilege: "UPDATE" }),
  Object.freeze({ role: "anon", privilege: "DELETE" }),
  Object.freeze({ role: "authenticated", privilege: "INSERT" }),
  Object.freeze({ role: "authenticated", privilege: "UPDATE" }),
  Object.freeze({ role: "authenticated", privilege: "DELETE" }),
]);

const DISPOSABLE_CHANNEL_ROOT_CREDENTIAL =
  "openclaw-disposable-channel-root-credential-v1";
const DISPOSABLE_MAINTENANCE_ROOT_CREDENTIAL =
  "openclaw-disposable-maintenance-root-credential-v1";
const CREDENTIAL_PROOF_DOMAINS = Object.freeze({
  CHANNEL: "ihome-openclaw-channel-credential-v1",
  MAINTENANCE: "ihome-openclaw-maintenance-credential-v1",
});

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

export async function withSqlHarnessSavepoint(database, operation, { rollback = true } = {}) {
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
  return rejection;
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

export async function assertTask21AccountBoundedContracts(database) {
  return withSqlHarnessSavepoint(database, async () => {
  const selectedAccountId = "11111111-1111-4111-8111-111111111111";
  const otherAccountId = "11111111-1111-4111-8111-111111111112";
  const selectedOutboxId = "bbbbbbbb-bbbb-4bbb-8bbb-000000000101";
  const otherOutboxId = "bbbbbbbb-bbbb-4bbb-8bbb-000000000102";
  const selectedDeadLetterId = "dddddddd-dddd-4ddd-8ddd-000000000101";
  const selectedHealthId = "eeeeeeee-eeee-4eee-8eee-000000000101";
  const resolutionId = "cccccccc-cccc-4ccc-8ccc-000000000101";

  await database.exec(`
    insert into public.openclaw_accounts(
      id,organization_id,account_profile,display_name,is_active
    ) values (
      '${otherAccountId}','${DEMO_ORG_ID}','task21-other','Task 21 other',false
    );
    insert into public.openclaw_contacts(
      id,organization_id,account_id,provider_id,directory_refreshed_at
    ) values (
      'aaaaaaaa-aaaa-4aaa-8aaa-000000000102','${DEMO_ORG_ID}',
      '${otherAccountId}','task21-other-peer',statement_timestamp()
    );
    insert into public.openclaw_targets(
      id,organization_id,account_id,kind,provider_id,contact_id,directory_refreshed_at
    ) values (
      '55555555-5555-4555-8555-555555555557','${DEMO_ORG_ID}',
      '${otherAccountId}','PEER','task21-other-peer',
      'aaaaaaaa-aaaa-4aaa-8aaa-000000000102',statement_timestamp()
    );

    with fixtures(id,account_id,target_id,client_operation_id,idempotency_key,terminal_at) as (
      values
        ('${selectedOutboxId}'::uuid,'${selectedAccountId}'::uuid,
          '55555555-5555-4555-8555-555555555555'::uuid,
          '99999999-9999-4999-8999-000000000101'::uuid,
          'task21:selected','2100-01-01T00:00:00Z'::timestamptz),
        ('${otherOutboxId}'::uuid,'${otherAccountId}'::uuid,
          '55555555-5555-4555-8555-555555555557'::uuid,
          '99999999-9999-4999-8999-000000000102'::uuid,
          'task21:other','2101-01-01T00:00:00Z'::timestamptz)
    ), payloads as (
      select fixture.*, jsonb_build_object(
        'version',1,'organizationId','${DEMO_ORG_ID}',
        'accountId',fixture.account_id,'idempotencyKey',fixture.idempotency_key
      ) payload
      from fixtures fixture
    )
    insert into public.openclaw_outbox(
      id,organization_id,account_id,target_id,source_kind,actor_id,
      client_operation_id,idempotency_key,canonical_payload,
      canonical_payload_bytes,payload_hash,state,terminal_at
    )
    select payload.id,'${DEMO_ORG_ID}',payload.account_id,payload.target_id,
      'MANUAL','99999999-9999-4999-8999-999999999999',
      payload.client_operation_id,payload.idempotency_key,payload.payload,
      app_private.openclaw_jcs_bytes_v1(payload.payload),
      encode(extensions.digest(
        convert_to('ihome-openclaw-send-v1','UTF8')||decode('00','hex')
          ||app_private.openclaw_jcs_bytes_v1(payload.payload),
        'sha256'
      ),'hex'),
      'UNKNOWN',payload.terminal_at
    from payloads payload;

    insert into public.openclaw_dead_letters(
      id,organization_id,account_id,outbox_id,reason_code,payload_hash,evidence,created_at
    )
    select
      case when outbox.id='${selectedOutboxId}' then '${selectedDeadLetterId}'::uuid
        else 'dddddddd-dddd-4ddd-8ddd-000000000102'::uuid end,
      outbox.organization_id,outbox.account_id,outbox.id,'TASK21_CAP',outbox.payload_hash,
      jsonb_build_object('version',1),
      case when outbox.id='${selectedOutboxId}'
        then '2100-01-01T00:00:00Z'::timestamptz
        else '2101-01-01T00:00:00Z'::timestamptz end
    from public.openclaw_outbox outbox
    where outbox.id in ('${selectedOutboxId}','${otherOutboxId}');

    insert into public.openclaw_health_events(
      id,organization_id,account_id,severity,health_kind,status,
      fingerprint,content_free_metrics,observed_at,created_at
    ) values
      ('${selectedHealthId}','${DEMO_ORG_ID}','${selectedAccountId}',
        'WARN','TASK21_CAP','OPEN','task21-selected','{}',
        '2100-01-01T00:00:00Z','2100-01-01T00:00:00Z'),
      ('eeeeeeee-eeee-4eee-8eee-000000000102','${DEMO_ORG_ID}','${otherAccountId}',
        'CRITICAL','TASK21_CAP','OPEN','task21-other','{}',
        '2101-01-01T00:00:00Z','2101-01-01T00:00:00Z');

    update public.openclaw_outbox
    set resolution_version=1
    where organization_id='${DEMO_ORG_ID}' and id='${selectedOutboxId}';
    insert into public.openclaw_unknown_resolutions(
      id,organization_id,account_id,outbox_id,outcome,new_outbox_id,
      authoritative_evidence_domain,authoritative_evidence_hash,
      operator_evidence_hash,reason_code,resolved_by,resolved_at,
      client_operation_id,request_hash
    ) values (
      '${resolutionId}','${DEMO_ORG_ID}','${selectedAccountId}','${selectedOutboxId}',
      'CONFIRMED_FAILED',null,'ihome-openclaw-unknown-authority-v1\\0',
      repeat('a',64),repeat('b',64),'OPERATOR_CONFIRMED_FAILED',
      '99999999-9999-4999-8999-999999999999','2100-01-02T00:00:00Z',
      '99999999-9999-4999-8999-000000000103',repeat('c',64)
    );
  `);

  await database.query(`select set_config(
    'request.jwt.claim.sub','99999999-9999-4999-8999-999999999999',false
  )`);
  const request = (extra = {}) => JSON.stringify({
    version: 1,
    organizationId: DEMO_ORG_ID,
    accountId: selectedAccountId,
    limit: 1,
    ...extra,
  });
  const [unknown, deadLetters, health, winner, wrongAccountWinner] = await Promise.all([
    database.query(
      `select public.openclaw_list_unknown_by_account_v1($1::jsonb) result`,
      [request()],
    ),
    database.query(
      `select public.openclaw_list_dead_letters_by_account_v1($1::jsonb) result`,
      [request()],
    ),
    database.query(
      `select public.openclaw_list_health_events_by_account_v1($1::jsonb) result`,
      [request()],
    ),
    database.query(
      `select public.openclaw_get_unknown_resolution_v1($1::jsonb) result`,
      [JSON.stringify({
        version: 1,
        organizationId: DEMO_ORG_ID,
        accountId: selectedAccountId,
        outboxId: selectedOutboxId,
      })],
    ),
    database.query(
      `select public.openclaw_get_unknown_resolution_v1($1::jsonb) result`,
      [JSON.stringify({
        version: 1,
        organizationId: DEMO_ORG_ID,
        accountId: otherAccountId,
        outboxId: selectedOutboxId,
      })],
    ),
  ]);

  assertProof(
    unknown.rows[0].result.items.length === 1 &&
      unknown.rows[0].result.items[0].outboxId === selectedOutboxId &&
      deadLetters.rows[0].result.items.length === 1 &&
      deadLetters.rows[0].result.items[0].deadLetterId === selectedDeadLetterId &&
      health.rows[0].result.items.length === 1 &&
      health.rows[0].result.items[0].healthEventId === selectedHealthId,
    "An org-wide cap hid the selected account's operations records.",
  );
  assertProof(
    winner.rows[0].result?.resolutionId === resolutionId &&
      winner.rows[0].result?.organizationId === DEMO_ORG_ID &&
      winner.rows[0].result?.accountId === selectedAccountId &&
      winner.rows[0].result?.outboxId === selectedOutboxId &&
      winner.rows[0].result?.resolutionVersion === 1 &&
      winner.rows[0].result?.outcome === "CONFIRMED_FAILED" &&
      winner.rows[0].result?.newOutboxId === null &&
      wrongAccountWinner.rows[0].result === null,
    "UNKNOWN winner reload was not bound to exact organization/account/outbox identity.",
  );
  const immutableUnknown = await database.query(
    `select state,resolution_version from public.openclaw_outbox
     where organization_id=$1 and account_id=$2 and id=$3`,
    [DEMO_ORG_ID, selectedAccountId, selectedOutboxId],
  );
  assertProof(
    immutableUnknown.rows[0]?.state === "UNKNOWN" &&
      Number(immutableUnknown.rows[0]?.resolution_version) === 1,
    "Winner reload changed the immutable UNKNOWN history row.",
  );

  await expectSqlHarnessRejection(
    database,
    "Task 21 missing account argument",
    () => database.query(
      `select public.openclaw_list_unknown_by_account_v1($1::jsonb)`,
      [JSON.stringify({ version: 1, organizationId: DEMO_ORG_ID, limit: 1 })],
    ),
    /required|accountId|request object/i,
  );
  await expectSqlHarnessRejection(
    database,
    "Task 21 half cursor",
    () => database.query(
      `select public.openclaw_list_unknown_by_account_v1($1::jsonb)`,
      [request({ cursorTerminalAt: "2100-01-01T00:00:00Z" })],
    ),
    /cursor requires timestamp and id/i,
  );
  await database.query(`select set_config(
    'request.jwt.claim.sub','91000000-0000-4000-8000-000000000001',false
  )`);
  await expectSqlHarnessRejection(
    database,
    "Task 21 operations permission",
    () => database.query(
      `select public.openclaw_list_unknown_by_account_v1($1::jsonb)`,
      [request()],
    ),
    /permission|not allowed|không|khong|42501/i,
  );

  const grants = await database.query(`
    select
      has_function_privilege('authenticated','public.openclaw_list_unknown_by_account_v1(jsonb)','EXECUTE') authenticated_read,
      has_function_privilege('anon','public.openclaw_list_unknown_by_account_v1(jsonb)','EXECUTE') anon_read,
      has_function_privilege('authenticated','public.openclaw_get_unknown_resolution_v1(jsonb)','EXECUTE') authenticated_winner,
      has_function_privilege('anon','public.openclaw_get_unknown_resolution_v1(jsonb)','EXECUTE') anon_winner
  `);
  assertProof(
    grants.rows[0].authenticated_read === true && grants.rows[0].anon_read === false &&
      grants.rows[0].authenticated_winner === true && grants.rows[0].anon_winner === false,
    "Task 21 browser RPC grants are not fail-closed.",
  );
  });
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
    await assertTask21AccountBoundedContracts(database);
    prove("operations.account-bounded-contracts");
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
    const outboxClaim = await runDisposableConcurrencyScenario(database, "OUTBOX_SINGLE_CLAIM");
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
      ) on conflict (organization_id,account_id,target_id,consent_scope,consent_version)
        do update set consent_status='ACTIVE',revoked_at=null;
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
          claimToken: outboxClaim.claimToken,
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
        rawEnvelopeSha256: createHash("sha256")
          .update('{"bounded":true}', "utf8").digest("hex"),
        normalized: { text: "atomic", replyToProviderMessageId: null, mediaManifest: [] },
        normalizedSha256: createHash("sha256")
          .update('{"mediaManifest":[],"replyToProviderMessageId":null,"text":"atomic"}', "utf8")
          .digest("hex"),
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
        rawEnvelopeSha256: createHash("sha256")
          .update('{"bounded":true}', "utf8").digest("hex"),
        normalized: {
          text: "must roll back",
          replyToProviderMessageId: null,
          mediaManifest: [],
        },
        normalizedSha256: createHash("sha256")
          .update(
            '{"mediaManifest":[],"replyToProviderMessageId":null,"text":"must roll back"}',
            "utf8",
          ).digest("hex"),
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
            organizationId: DEMO_ORG_ID,
            accountId: "11111111-1111-4111-8111-111111111111",
            cellId: "22222222-2222-4222-8222-222222222222",
            sessionGeneration: 1,
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
    const sqlMatrixWorkClaimToken = concurrencyClaimToken("sql-matrix-work-claim");
    const workClaim = await database.query(
      `select app_private.openclaw_claim_work_item_v1(
        $1::jsonb,'{}'::jsonb,$2::jsonb
      ) result`,
      [
        JSON.stringify(channelPrincipal()),
        JSON.stringify({
          version: 1,
          claimToken: sqlMatrixWorkClaimToken,
          limit: 1,
          leaseSeconds: 30,
          requestedKinds: ["SCHEDULE_OCCURRENCE"],
        }),
      ],
    );
    const claimedWork = workClaim.rows[0].result.items[0];
    assertProof(claimedWork?.workItemId, "Schedule work could not be claimed for rollback proof.");
    const claimedWorkSource = await database.query(
      `select source_hash from public.openclaw_send_work_items
       where organization_id=$1 and id=$2`,
      [DEMO_ORG_ID, claimedWork.workItemId],
    );
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
            principalKind: "CHANNEL",
            claim: claimedWork,
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
            sourceSnapshotHash: claimedWorkSource.rows[0].source_hash,
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
        "MAINTENANCE_FAILURE_READINESS",
      ]) {
        await runDisposableConcurrencyScenario(receiptDatabase, scenario);
      }
      const auditRecoveryDatabase = await createDisposableOpenClawDatabase();
      try {
        await prepareDisposableConcurrencyFixtures(auditRecoveryDatabase);
        await runDisposableConcurrencyScenario(auditRecoveryDatabase, "AUDIT_RECOVERY_REFRESH");
      } finally {
        await auditRecoveryDatabase.close().catch(() => {});
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
      const retentionRecoveryDatabase = await createDisposableOpenClawDatabase();
      try {
        await prepareDisposableConcurrencyFixtures(retentionRecoveryDatabase);
        await runDisposableConcurrencyScenario(
          retentionRecoveryDatabase,
          "RETENTION_RECOVERY_REFRESH",
        );
      } finally {
        await retentionRecoveryDatabase.close().catch(() => {});
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
          JSON.stringify({
            version: 1,
            claimToken: concurrencyClaimToken("cross-org"),
            limit: 1,
            leaseSeconds: 30,
          }),
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
            claimToken: concurrencyClaimToken("stale-credential"),
            limit: 1,
            leaseSeconds: 30,
            requestedKinds: ["SCHEDULE_OCCURRENCE"],
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

function disposableCredentialProof(principalKind, credential) {
  const domain = CREDENTIAL_PROOF_DOMAINS[principalKind];
  if (!domain) throw new Error("Disposable credential kind is invalid.");
  return createHash("sha256")
    .update(domain, "utf8")
    .update(Buffer.from([0]))
    .update(credential, "utf8")
    .digest("hex");
}

let credentialExchangeNonce = 0;

function nextCredentialExchangeNonce() {
  credentialExchangeNonce += 1;
  return `00000000-0000-4000-8000-${String(credentialExchangeNonce).padStart(12, "0")}`;
}

async function buildCredentialExchangeInvocation(database, {
  principalKind,
  principal,
  credentialProofSha256,
  requestedOperation,
  nonce = nextCredentialExchangeNonce(),
  runtimeMethod = "POST",
  runtimePath,
  runtimeTimestamp,
  runtimeNonce = nextCredentialExchangeNonce(),
  runtimeBodySha256 = createHash("sha256").update("{}").digest("hex"),
  localSessionGeneration = 1,
  requestMutation,
  envelopeMutation,
} = {}) {
  const operation = principalKind === "CHANNEL"
    ? "openclaw_exchange_runtime_credential_v1"
    : "openclaw_exchange_maintenance_credential_v1";
  const facade = principalKind === "CHANNEL"
    ? "public.openclaw_service_exchange_runtime_credential_v1"
    : "public.openclaw_service_exchange_maintenance_credential_v1";
  const defaultRuntimePath = principalKind === "CHANNEL"
    ? {
        heartbeat: "/v1/heartbeat",
        "qr.publish": "/v1/qr/publish",
        "qr.result": "/v1/qr/result",
        "inbound.commit": "/v1/inbound/batch",
        "outbox.claim": "/v1/outbox/claim",
        "outbox.preflight": "/v1/outbox/preflight",
        "outbox.authorize-send": "/v1/outbox/authorize-send",
        "outbox.requeue": "/v1/outbox/requeue",
        "outbox.complete": "/v1/outbox/complete",
        "work.claim": "/v1/work/claim",
        "work.context": "/v1/work/context",
        "work.complete": "/v1/work/complete",
        "media.issue": "/v1/media/upload-ticket",
      }[requestedOperation]
    : {
        "maintenance.claim": "/v1/maintenance/work/claim",
        "maintenance.complete": "/v1/maintenance/work/complete",
      }[requestedOperation];
  const times = await database.query(`
    select statement_timestamp()::text as iat,
      (statement_timestamp()+interval '4 minutes')::text as exp,
      floor(extract(epoch from statement_timestamp()))::bigint as runtime_timestamp
  `);
  const request = {
    version: 1,
    credentialProofSha256,
    requestedOperation,
    runtimeMethod,
    runtimePath: runtimePath ?? defaultRuntimePath,
    runtimeTimestamp: runtimeTimestamp ?? times.rows[0].runtime_timestamp,
    runtimeNonce,
    runtimeBodySha256,
    ...(principalKind === "CHANNEL" ? { localSessionGeneration } : {}),
    ...requestMutation,
  };
  const requestHash = await database.query(
    `select encode(extensions.digest(
      convert_to('ihome-openclaw-service-request-v1','UTF8')
        || decode('00','hex') || convert_to($1::text,'UTF8')
        || decode('00','hex') || app_private.openclaw_jcs_bytes_v1($2::jsonb),
      'sha256'),'hex') as hash`,
    [operation, JSON.stringify(request)],
  );
  const envelope = {
    version: 1,
    operation,
    nonce,
    iat: times.rows[0].iat,
    exp: times.rows[0].exp,
    requestHash: requestHash.rows[0].hash,
    ...envelopeMutation,
  };
  return { facade, principal, envelope, request };
}

async function executeCredentialExchange(database, invocation) {
  return database.query(
    `select ${invocation.facade}($1::jsonb,$2::jsonb,$3::jsonb) as result`,
    [
      JSON.stringify(invocation.principal),
      JSON.stringify(invocation.envelope),
      JSON.stringify(invocation.request),
    ],
  );
}

export async function executeAuthenticatedServiceCall(database, {
  operation,
  facade,
  nonce,
  request,
  principalOverrides = {},
}) {
  const times = await database.query(`
    select statement_timestamp()::text as iat,
      (statement_timestamp()+interval '4 minutes')::text as exp
  `);
  const requestHash = await database.query(
    `select encode(extensions.digest(
      convert_to('ihome-openclaw-service-request-v1','UTF8')
        || decode('00','hex') || convert_to($1::text,'UTF8')
        || decode('00','hex') || app_private.openclaw_jcs_bytes_v1($2::jsonb),
      'sha256'),'hex') as hash`,
    [operation, JSON.stringify(request)],
  );
  const principal = {
    version: 1,
    principalKind: "CHANNEL",
    organizationId: DEMO_ORG_ID,
    accountId: "11111111-1111-4111-8111-111111111111",
    cellId: "22222222-2222-4222-8222-222222222222",
    maintenancePrincipalId: null,
    credentialGeneration: "1",
    leaseGeneration: "1",
    fencingToken: "1",
    sessionGeneration: "1",
    localSessionGeneration: "1",
    authMode: "NORMAL",
    allowedOperations: [operation],
    ...principalOverrides,
  };
  const envelope = {
    version: 1,
    operation,
    nonce,
    iat: times.rows[0].iat,
    exp: times.rows[0].exp,
    requestHash: requestHash.rows[0].hash,
  };
  try {
    const result = await withSqlHarnessSavepoint(
      database,
      () => database.query(
        `select ${facade}($1::jsonb,$2::jsonb,$3::jsonb) as result`,
        [
          JSON.stringify(principal),
          JSON.stringify(envelope),
          JSON.stringify(request),
        ],
      ),
      { rollback: false },
    );
    return { ok: true, result: result.rows[0].result };
  } catch (error) {
    return { ok: false, error: error.message, code: error.code };
  }
}

async function queryServiceNonceNamespaces(database) {
  try {
    const result = await withSqlHarnessSavepoint(
      database,
      () => database.query(`
        select nonce_namespace, count(*)::integer as count
        from public.openclaw_service_nonces
        group by nonce_namespace
        order by nonce_namespace
      `),
      { rollback: false },
    );
    return { ok: true, rows: result.rows };
  } catch (error) {
    return { ok: false, error: error.message, rows: [] };
  }
}

async function credentialNonceCount(database) {
  const result = await database.query(`
    select count(*)::integer as count from public.openclaw_service_nonces
  `);
  return result.rows[0].count;
}

export async function runDisposableCredentialExchangeAuthorizationMatrix() {
  const database = await createDisposableOpenClawDatabase();
  const proofs = [];
  const prove = (proof) => {
    if (CREDENTIAL_EXCHANGE_AUTHORIZATION_PROOFS[proofs.length] !== proof) {
      throw new Error(`Credential exchange proof order mismatch at ${proof}.`);
    }
    proofs.push(proof);
  };
  const channelPrincipal = {
    version: 1,
    principalKind: "CHANNEL",
    organizationId: DEMO_ORG_ID,
    accountId: "11111111-1111-4111-8111-111111111111",
    cellId: "22222222-2222-4222-8222-222222222222",
  };
  const maintenancePrincipal = {
    version: 1,
    principalKind: "MAINTENANCE",
    organizationId: DEMO_ORG_ID,
    maintenancePrincipalId: "44444444-4444-4444-8444-444444444444",
  };
  const channelProof = disposableCredentialProof(
    "CHANNEL",
    DISPOSABLE_CHANNEL_ROOT_CREDENTIAL,
  );
  const maintenanceProof = disposableCredentialProof(
    "MAINTENANCE",
    DISPOSABLE_MAINTENANCE_ROOT_CREDENTIAL,
  );
  const channelSecretWithMaintenanceDomain = disposableCredentialProof(
    "MAINTENANCE",
    DISPOSABLE_CHANNEL_ROOT_CREDENTIAL,
  );
  const maintenanceSecretWithChannelDomain = disposableCredentialProof(
    "CHANNEL",
    DISPOSABLE_MAINTENANCE_ROOT_CREDENTIAL,
  );
  const reject = (label, invocation, pattern = /credential exchange denied/i) =>
    expectSqlHarnessRejection(
      database,
      label,
      () => executeCredentialExchange(database, invocation),
      pattern,
    );

  try {
    await database.exec("begin");
    await prepareDisposableConcurrencyFixtures(database);

    const channelSuccess = await buildCredentialExchangeInvocation(database, {
      principalKind: "CHANNEL",
      principal: channelPrincipal,
      credentialProofSha256: channelProof,
      requestedOperation: "outbox.claim",
    });
    const channelResult = await executeCredentialExchange(database, channelSuccess);
    const channelReceipt = channelResult.rows[0].result;
    assertProof(
      channelReceipt?.principalKind === "CHANNEL" &&
        channelReceipt?.organizationId === DEMO_ORG_ID &&
        channelReceipt?.accountId === channelPrincipal.accountId &&
        channelReceipt?.cellId === channelPrincipal.cellId &&
        channelReceipt?.credentialGeneration === "1" &&
        channelReceipt?.leaseGeneration === "1" &&
        channelReceipt?.fencingToken === "1" &&
        channelReceipt?.sessionGeneration === "1" &&
        channelReceipt?.localSessionGeneration === "1" &&
        channelReceipt?.authMode === "NORMAL" &&
        channelReceipt?.requestedOperation === "outbox.claim" &&
        channelReceipt?.runtimeMethod === "POST" &&
        channelReceipt?.runtimePath === "/v1/outbox/claim" &&
        channelReceipt?.runtimeNonce === channelSuccess.request.runtimeNonce &&
        channelReceipt?.runtimeBodySha256 === channelSuccess.request.runtimeBodySha256 &&
        channelReceipt?.exchangeNonce === channelSuccess.envelope.nonce &&
        channelReceipt?.exchangeRequestHash === channelSuccess.envelope.requestHash &&
        typeof channelReceipt?.authenticatedAt === "string" &&
        typeof channelReceipt?.leaseExpiresAt === "string" &&
        !("credentialProofSha256" in channelReceipt) &&
        !("requestHash" in channelReceipt) &&
        !("allowedScopes" in channelReceipt),
      "Authenticated channel exchange did not return its DB-derived binding.",
    );
    prove("credential.channel-success");

    for (const [requestedOperation, runtimePath] of [
      ["work.context", "/v1/work/context"],
      ["media.issue", "/v1/media/upload-complete"],
    ]) {
      const invocation = await buildCredentialExchangeInvocation(database, {
        principalKind: "CHANNEL",
        principal: channelPrincipal,
        credentialProofSha256: channelProof,
        requestedOperation,
        runtimePath,
      });
      const result = await executeCredentialExchange(database, invocation);
      assertProof(
        result.rows[0].result?.requestedOperation === requestedOperation &&
          result.rows[0].result?.runtimePath === runtimePath,
        `Declared runtime route was rejected by credential exchange: ${runtimePath}`,
      );
    }
    prove("credential.declared-channel-routes");

    const maintenanceSuccess = await buildCredentialExchangeInvocation(database, {
      principalKind: "MAINTENANCE",
      principal: maintenancePrincipal,
      credentialProofSha256: maintenanceProof,
      requestedOperation: "maintenance.claim",
    });
    const maintenanceResult = await executeCredentialExchange(database, maintenanceSuccess);
    const maintenanceReceipt = maintenanceResult.rows[0].result;
    assertProof(
      maintenanceReceipt?.principalKind === "MAINTENANCE" &&
        maintenanceReceipt?.organizationId === DEMO_ORG_ID &&
        maintenanceReceipt?.maintenancePrincipalId ===
          maintenancePrincipal.maintenancePrincipalId &&
        maintenanceReceipt?.credentialGeneration === "1" &&
        maintenanceReceipt?.leaseGeneration === "1" &&
        maintenanceReceipt?.fencingToken === "1" &&
        maintenanceReceipt?.requestedOperation === "maintenance.claim" &&
        maintenanceReceipt?.runtimePath === "/v1/maintenance/work/claim" &&
        maintenanceReceipt?.runtimeNonce === maintenanceSuccess.request.runtimeNonce &&
        maintenanceReceipt?.exchangeNonce === maintenanceSuccess.envelope.nonce &&
        maintenanceReceipt?.exchangeRequestHash === maintenanceSuccess.envelope.requestHash &&
        !("credentialProofSha256" in maintenanceReceipt) &&
        !("allowedScopes" in maintenanceReceipt),
      "Authenticated maintenance exchange did not return its DB-derived binding.",
    );
    prove("credential.maintenance-success");

    const nonceCountAfterSuccess = await credentialNonceCount(database);
    for (const [label, principalKind, principal, proof, operation] of [
      ["Wrong channel proof", "CHANNEL", channelPrincipal, "f".repeat(64), "outbox.claim"],
      ["Channel secret with maintenance domain", "CHANNEL", channelPrincipal, channelSecretWithMaintenanceDomain, "outbox.claim"],
      ["Maintenance proof on channel", "CHANNEL", channelPrincipal, maintenanceProof, "outbox.claim"],
      ["Maintenance secret with channel domain", "MAINTENANCE", maintenancePrincipal, maintenanceSecretWithChannelDomain, "maintenance.claim"],
      ["Channel proof on maintenance", "MAINTENANCE", maintenancePrincipal, channelProof, "maintenance.claim"],
    ]) {
      await reject(label, await buildCredentialExchangeInvocation(database, {
        principalKind,
        principal,
        credentialProofSha256: proof,
        requestedOperation: operation,
      }));
    }
    assertProof(
      await credentialNonceCount(database) === nonceCountAfterSuccess,
      "Wrong or cross-domain credential proof consumed a nonce.",
    );
    prove("credential.wrong-proof-domain-separated");

    for (const [label, principalKind, principal, proof, operation] of [
      ["Wrong organization", "CHANNEL", { ...channelPrincipal, organizationId: PROD_ORG_ID }, channelProof, "outbox.claim"],
      ["Wrong account", "CHANNEL", { ...channelPrincipal, accountId: "11111111-1111-4111-8111-111111111112" }, channelProof, "outbox.claim"],
      ["Wrong cell", "CHANNEL", { ...channelPrincipal, cellId: "22222222-2222-4222-8222-222222222223" }, channelProof, "outbox.claim"],
      ["Wrong maintenance principal", "MAINTENANCE", { ...maintenancePrincipal, maintenancePrincipalId: "44444444-4444-4444-8444-444444444445" }, maintenanceProof, "maintenance.claim"],
    ]) {
      await reject(label, await buildCredentialExchangeInvocation(database, {
        principalKind,
        principal,
        credentialProofSha256: proof,
        requestedOperation: operation,
      }));
    }
    prove("credential.cross-binding-denied");

    for (const mutation of [
      `update public.openclaw_runtime_credentials
       set allowed_scopes=array_remove(allowed_scopes,'credential.exchange')`,
      `update public.openclaw_runtime_credentials
       set allowed_scopes=array_remove(allowed_scopes,'outbox.claim')`,
      `update public.openclaw_runtime_credentials set revoked_at=statement_timestamp()`,
      `update public.openclaw_runtime_credentials
       set enabled_at=statement_timestamp()+interval '1 hour'`,
      `update public.openclaw_maintenance_credentials
       set allowed_scopes=array_remove(allowed_scopes,'maintenance.exchange')`,
      `update public.openclaw_maintenance_credentials set revoked_at=statement_timestamp()`,
      `update public.openclaw_maintenance_credentials
       set enabled_at=statement_timestamp()+interval '1 hour'`,
    ]) {
      await withSqlHarnessSavepoint(database, async () => {
        await database.exec(`
          set session_replication_role='replica';
          ${mutation};
          set session_replication_role='origin';
        `);
        const isMaintenance = mutation.includes("maintenance_credentials");
        await reject("Scope or revoked credential", await buildCredentialExchangeInvocation(database, {
          principalKind: isMaintenance ? "MAINTENANCE" : "CHANNEL",
          principal: isMaintenance ? maintenancePrincipal : channelPrincipal,
          credentialProofSha256: isMaintenance ? maintenanceProof : channelProof,
          requestedOperation: isMaintenance ? "maintenance.claim" : "outbox.claim",
        }));
      });
    }
    prove("credential.scope-revocation-denied");

    for (const [mutation, principalKind, principal, proof, operation] of [
      ["update public.openclaw_runtime_cells set state='STALE'", "CHANNEL", channelPrincipal, channelProof, "outbox.claim"],
      ["update public.openclaw_runtime_cells set is_current=false", "CHANNEL", channelPrincipal, channelProof, "outbox.claim"],
      ["update public.openclaw_accounts set is_active=false", "CHANNEL", channelPrincipal, channelProof, "outbox.claim"],
      ["update public.openclaw_runtime_leases set status='EXPIRED'", "CHANNEL", channelPrincipal, channelProof, "outbox.claim"],
      ["update public.openclaw_runtime_leases set acquired_at=statement_timestamp()-interval '2 hours',expires_at=statement_timestamp()-interval '1 hour'", "CHANNEL", channelPrincipal, channelProof, "outbox.claim"],
      ["update public.openclaw_maintenance_principals set is_current=false", "MAINTENANCE", maintenancePrincipal, maintenanceProof, "maintenance.claim"],
      ["update public.openclaw_maintenance_leases set status='EXPIRED'", "MAINTENANCE", maintenancePrincipal, maintenanceProof, "maintenance.claim"],
      ["update public.openclaw_maintenance_leases set acquired_at=statement_timestamp()-interval '2 hours',expires_at=statement_timestamp()-interval '1 hour'", "MAINTENANCE", maintenancePrincipal, maintenanceProof, "maintenance.claim"],
    ]) {
      await withSqlHarnessSavepoint(database, async () => {
        await database.exec(mutation);
        await reject("Stale principal or lease", await buildCredentialExchangeInvocation(database, {
          principalKind,
          principal,
          credentialProofSha256: proof,
          requestedOperation: operation,
        }));
      });
    }
    prove("credential.stale-principal-lease-denied");

    await reject("Expired exchange envelope", await buildCredentialExchangeInvocation(database, {
      principalKind: "CHANNEL",
      principal: channelPrincipal,
      credentialProofSha256: channelProof,
      requestedOperation: "outbox.claim",
      envelopeMutation: {
        iat: "2000-01-01T00:00:00.000Z",
        exp: "2000-01-01T00:04:00.000Z",
      },
    }));
    prove("credential.expired-envelope-denied");

    for (const invocation of [
      await buildCredentialExchangeInvocation(database, {
        principalKind: "CHANNEL",
        principal: { ...channelPrincipal, extra: "forbidden" },
        credentialProofSha256: channelProof,
        requestedOperation: "outbox.claim",
      }),
      await buildCredentialExchangeInvocation(database, {
        principalKind: "CHANNEL",
        principal: channelPrincipal,
        credentialProofSha256: "not-a-proof",
        requestedOperation: "outbox.claim",
      }),
      await buildCredentialExchangeInvocation(database, {
        principalKind: "CHANNEL",
        principal: channelPrincipal,
        credentialProofSha256: channelProof,
        requestedOperation: "credential.exchange",
      }),
    ]) {
      await reject(
        "Malformed exchange input",
        invocation,
        /invalid|unknown JSON key|required JSON key/i,
      );
    }
    prove("credential.malformed-input-denied");

    const nonceCountBeforeAuthFailure = await credentialNonceCount(database);
    const authenticationFailureInvocation = await buildCredentialExchangeInvocation(database, {
      principalKind: "CHANNEL",
      principal: channelPrincipal,
      credentialProofSha256: "0".repeat(64),
      requestedOperation: "outbox.claim",
    });
    const authenticationFailure = await reject(
      "Authentication before nonce",
      authenticationFailureInvocation,
    );
    assertProof(
      await credentialNonceCount(database) === nonceCountBeforeAuthFailure,
      "Credential authentication failure created a service nonce row.",
    );
    const correctRetry = await buildCredentialExchangeInvocation(database, {
      principalKind: "CHANNEL",
      principal: channelPrincipal,
      credentialProofSha256: channelProof,
      requestedOperation: "outbox.claim",
      nonce: authenticationFailureInvocation.envelope.nonce,
      runtimeMethod: authenticationFailureInvocation.request.runtimeMethod,
      runtimePath: authenticationFailureInvocation.request.runtimePath,
      runtimeTimestamp: authenticationFailureInvocation.request.runtimeTimestamp,
      runtimeNonce: authenticationFailureInvocation.request.runtimeNonce,
      runtimeBodySha256: authenticationFailureInvocation.request.runtimeBodySha256,
      localSessionGeneration: authenticationFailureInvocation.request.localSessionGeneration,
    });
    await executeCredentialExchange(database, correctRetry);
    assertProof(
      await credentialNonceCount(database) === nonceCountBeforeAuthFailure + 1,
      "A failed credential proof burned its nonce before authentication.",
    );
    prove("credential.auth-failure-does-not-consume-nonce");

    const replayInvocation = await buildCredentialExchangeInvocation(database, {
      principalKind: "CHANNEL",
      principal: channelPrincipal,
      credentialProofSha256: channelProof,
      requestedOperation: "outbox.claim",
    });
    await executeCredentialExchange(database, replayInvocation);
    const nonceCountBeforeReplay = await credentialNonceCount(database);
    const replayFailure = await reject(
      "Credential exchange replay",
      replayInvocation,
      /credential exchange denied/i,
    );
    assertProof(
      await credentialNonceCount(database) === nonceCountBeforeReplay &&
        authenticationFailure.code === "42501" &&
        replayFailure.code === "42501" &&
        authenticationFailure.message === replayFailure.message,
      "Credential replay created a nonce row or exposed a proof-validation oracle.",
    );
    prove("credential.nonce-replay-denied");

    const sharedNonce = nextCredentialExchangeNonce();
    const namespaceExchange = await buildCredentialExchangeInvocation(database, {
      principalKind: "CHANNEL",
      principal: channelPrincipal,
      credentialProofSha256: channelProof,
      requestedOperation: "outbox.claim",
      nonce: sharedNonce,
    });
    await executeCredentialExchange(database, namespaceExchange);
    const runtimeAfterExchange = await executeAuthenticatedServiceCall(database, {
      operation: "openclaw_claim_outbox_v1",
      facade: "public.openclaw_service_claim_outbox_v1",
      nonce: sharedNonce,
      request: {
        version: 1,
        claimToken: "openclaw-namespace-probe-claim-token",
        limit: 1,
        leaseSeconds: 30,
      },
    });
    assertProof(
      runtimeAfterExchange.ok,
      "A credential exchange burned the identical runtime nonce: " +
        `${runtimeAfterExchange.error ?? "unknown error"}`,
    );
    const namespaces = await queryServiceNonceNamespaces(database);
    assertProof(
      namespaces.ok &&
        namespaces.rows.length === 2 &&
        namespaces.rows.some((row) => row.nonce_namespace === "EXCHANGE") &&
        namespaces.rows.some((row) => row.nonce_namespace === "RUNTIME"),
      "Service nonces are not partitioned into EXCHANGE and RUNTIME namespaces: " +
        `${namespaces.error ?? JSON.stringify(namespaces.rows)}`,
    );
    await reject(
      "Exchange nonce replay inside its own namespace",
      namespaceExchange,
      /credential exchange denied/i,
    );
    prove("credential.exchange-nonce-namespace-separated");

    const transitionCommandId = "dddd7100-0000-4000-8000-000000000099";
    await database.exec(`
      set session_replication_role='replica';
      update public.openclaw_accounts set
        session_generation=2,connection_generation=1,connection_state='DISCONNECTING'
      where organization_id='${DEMO_ORG_ID}'
        and id='11111111-1111-4111-8111-111111111111';
      with payload as (
        select jsonb_build_object(
          'version',1,'reasonCode','ACCOUNT_DISCONNECT',
          'revocationId','dddd7100-0000-4000-8000-000000000098',
          'revokedSessionGeneration',1,'minimumSessionGeneration',2
        ) value
      )
      insert into public.openclaw_runtime_commands(
        id,organization_id,account_id,cell_id,command_key,command_kind,
        source_session_generation,target_session_generation,
        source_connection_generation,target_connection_generation,
        expected_session_generation,expected_connection_generation,expected_fencing_token,
        payload,payload_bytes,payload_hash,created_by
      ) select '${transitionCommandId}','${DEMO_ORG_ID}',
        '11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222',
        'credential-transition','DISCONNECT',1,2,0,1,2,0,1,value,
        app_private.openclaw_jcs_bytes_v1(value),
        encode(extensions.digest(app_private.openclaw_jcs_bytes_v1(value),'sha256'),'hex'),
        '99999999-9999-4999-8999-999999999999'
      from payload;
      set session_replication_role='origin';
    `);
    const transitionExchange = await buildCredentialExchangeInvocation(database, {
      principalKind: "CHANNEL",
      principal: channelPrincipal,
      credentialProofSha256: channelProof,
      requestedOperation: "heartbeat",
      localSessionGeneration: 1,
    });
    const transitionReceipt = (await executeCredentialExchange(
      database,
      transitionExchange,
    )).rows[0].result;
    assertProof(
      transitionReceipt.authMode === "COMMAND_TRANSITION" &&
        transitionReceipt.localSessionGeneration === "1" &&
        transitionReceipt.sessionGeneration === "2",
      "Exact disconnect transition did not mint heartbeat-only transition authority.",
    );
    await reject(
      "Old Bridge ordinary authority after disconnect",
      await buildCredentialExchangeInvocation(database, {
        principalKind: "CHANNEL",
        principal: channelPrincipal,
        credentialProofSha256: channelProof,
        requestedOperation: "outbox.claim",
        localSessionGeneration: 1,
      }),
    );
    prove("credential.disconnect-transition-heartbeat-only");

    return {
      summary: "PASS OpenClaw credential exchange authorization matrix",
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
    with manifest(file_name) as (values
      ('20260727010000_openclaw_catalog_foundation.sql'),
      ('20260727015000_openclaw_security_principals.sql'),
      ('20260727020000_openclaw_inbox_schema.sql'),
      ('20260727025000_openclaw_inbound_automation.sql'),
      ('20260727030000_openclaw_policy_automation_knowledge.sql'),
      ('20260727040000_openclaw_delivery_audit_ops.sql'),
      ('20260727050000_openclaw_access_policies.sql'),
      ('20260727060000_openclaw_rpc_surface.sql'),
      ('20260727070000_openclaw_crm_event_sources.sql'),
      ('20260727080000_openclaw_realtime_allowlist.sql'),
      ('20260727090000_openclaw_maintenance_jobs.sql'),
      ('20260727095000_openclaw_activation_guards.sql')
    ), artifacts as (
      select jsonb_object_agg(file_name,repeat('d',64)) || jsonb_build_object(
        'cellReviewedCommitSha',repeat('a',40),
        'cellImageDigest','sha256:'||repeat('b',64),
        'cellConfigDigest',repeat('c',64)
      ) payload from manifest
    )
    insert into public.openclaw_rollout_runs(
      id,organization_id,reviewed_commit_sha,migration_manifest_sha256,
      upstream_sri,upstream_git_head,patch_series_sha256,built_tgz_sha256,
      artifact_digests,stage,status,completed_at
    )
    select '99994000-0000-4000-8000-000000000001','${DEMO_ORG_ID}',
      repeat('a',40),app_private.openclaw_rollout_manifest_hash_v1(payload),
      'sha512-disposable',repeat('e',40),repeat('f',64),repeat('9',64),
      payload,'COMPLETE','COMPLETE',statement_timestamp()
    from artifacts
    on conflict (organization_id,id) do nothing;
    insert into public.openclaw_accounts(
      id,organization_id,account_profile,is_active
    ) values (
      '11111111-1111-4111-8111-111111111111',
      '${DEMO_ORG_ID}','concurrency',true
    ) on conflict (organization_id,id) do nothing;
    insert into public.openclaw_account_connections(
      id,organization_id,account_id,connection_generation,connection_state,
      session_risk_state,configured_mode,effective_mode,reason_code,
      disclosure_version,disclosure_acknowledged_version,evidence_hash
    ) values (
      '99995000-0000-4000-8000-000000000001','${DEMO_ORG_ID}',
      '11111111-1111-4111-8111-111111111111',1,'CONNECTED','HEALTHY',
      'DRAFT_ONLY','DRAFT_ONLY','CONCURRENCY_FIXTURE',1,1,repeat('e',64)
    ) on conflict (organization_id,id) do nothing;
    insert into public.openclaw_rollout_checkpoints(
      id,organization_id,rollout_run_id,checkpoint_name,stage,status,
      trusted_evidence_id,trusted_evidence_hash,completed_at
    ) values (
      '99996000-0000-4000-8000-000000000001','${DEMO_ORG_ID}',
      '99994000-0000-4000-8000-000000000001','WAITING_OWNER_QR',
      'WAITING_OWNER_QR','COMPLETE','99995000-0000-4000-8000-000000000001',
      repeat('f',64),statement_timestamp()
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
      '22222222-2222-4222-8222-222222222222',1,
      encode(extensions.digest(
        convert_to('ihome-openclaw-channel-credential-v1','UTF8')
          || decode('00','hex')
          || convert_to('${DISPOSABLE_CHANNEL_ROOT_CREDENTIAL}','UTF8'),
        'sha256'),'hex'),
      array['heartbeat','outbox.claim','outbox.preflight','outbox.authorize-send',
        'outbox.requeue','outbox.complete','work.context','media.issue','credential.exchange']
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
      encode(extensions.digest(
        convert_to('ihome-openclaw-maintenance-credential-v1','UTF8')
          || decode('00','hex')
          || convert_to('${DISPOSABLE_MAINTENANCE_ROOT_CREDENTIAL}','UTF8'),
        'sha256'),'hex'),
      array['maintenance.claim','maintenance.complete','maintenance.exchange']
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
  CANONICAL_OUTBOX_COMPLETION: "bbbbbbbb-bbbb-4bbb-8bbb-000000000006",
});

function concurrencyClaimToken(label) {
  return `concurrency:${label}`.padEnd(32, "x");
}

function canonicalDomainHash(domain, value) {
  return createHash("sha256")
    .update(`${domain}\0`, "utf8")
    .update(canonicalComparisonJson(value), "utf8")
    .digest("hex");
}

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
    policyVersionId: scenario === "OUTBOX_SINGLE_CLAIM"
      ? "66666666-6666-4666-8666-666666666666"
      : "66666666-6666-4666-8666-666666666662",
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
    localSessionGeneration: 1,
    authMode: "NORMAL",
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

function rotatedMaintenancePrincipal() {
  return {
    version: 1,
    principalKind: "MAINTENANCE",
    organizationId: DEMO_ORG_ID,
    maintenancePrincipalId: "44444444-4444-4444-8444-444444444445",
    credentialGeneration: 2,
    leaseGeneration: 2,
    fencingToken: 2,
  };
}

async function prepareRotatedMaintenancePrincipal(database) {
  await database.exec(`
    set session_replication_role='replica';
    update public.openclaw_maintenance_principals set is_current=false
    where organization_id='${DEMO_ORG_ID}' and is_current;
    insert into public.openclaw_maintenance_principals(
      id,organization_id,principal_generation,is_current
    ) values (
      '44444444-4444-4444-8444-444444444445','${DEMO_ORG_ID}',2,true
    ) on conflict (organization_id,id) do update set is_current=true,revoked_at=null;
    insert into public.openclaw_maintenance_credentials(
      organization_id,maintenance_principal_id,credential_generation,
      credential_hash,allowed_scopes
    ) values (
      '${DEMO_ORG_ID}','44444444-4444-4444-8444-444444444445',2,
      repeat('f',64),array['maintenance.claim','maintenance.complete']
    ) on conflict (organization_id,maintenance_principal_id,credential_generation)
      do update set revoked_at=null,revoked_reason=null;
    insert into public.openclaw_maintenance_leases(
      organization_id,maintenance_principal_id,lease_generation,fencing_token,
      status,expires_at
    ) values (
      '${DEMO_ORG_ID}','44444444-4444-4444-8444-444444444445',2,2,
      'ACTIVE',statement_timestamp()+interval '1 hour'
    ) on conflict (organization_id,maintenance_principal_id,lease_generation)
      do update set fencing_token=2,status='ACTIVE',released_at=null,
        expires_at=statement_timestamp()+interval '1 hour';
    set session_replication_role='origin';
  `);
  return rotatedMaintenancePrincipal();
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
      quiet_hours_start,quiet_hours_end,rate_limits,disclosure_version,
      policy_payload,payload_hash,published_at
    ) values (
      '66666666-6666-4666-8666-666666666662','${DEMO_ORG_ID}',
      '11111111-1111-4111-8111-111111111111',
      '66666666-6666-4666-8666-666666666661',1,'PUBLISHED','Asia/Bangkok',
      '00:00','00:00','{"perPeer":1}'::jsonb,1,'{"version":1}'::jsonb,repeat('6',64),
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
    insert into public.openclaw_campaigns(
      id,organization_id,account_id,automation_version_id,name,status
    ) values (
      '66666666-6666-4666-8666-666666666665','${DEMO_ORG_ID}',
      '11111111-1111-4111-8111-111111111111',
      '66666666-6666-4666-8666-666666666664','Concurrency campaign','ACTIVE'
    ) on conflict (organization_id,id) do nothing;
    insert into public.openclaw_campaign_runs(
      id,organization_id,account_id,campaign_id,campaign_version,
      automation_version_id,run_key,status,target_snapshot_hash
    ) values (
      '66666666-6666-4666-8666-666666666666','${DEMO_ORG_ID}',
      '11111111-1111-4111-8111-111111111111',
      '66666666-6666-4666-8666-666666666665',1,
      '66666666-6666-4666-8666-666666666664','concurrency-campaign-v1',
      'PLANNED',repeat('9',64)
    ) on conflict (organization_id,id) do nothing;
    insert into public.openclaw_control_states(
      organization_id,control_key,global_stop,feature_enabled,proactive_enabled
    ) values ('${DEMO_ORG_ID}','GLOBAL_STOP',false,true,true)
    on conflict (organization_id,control_key) do update set
      global_stop=false,feature_enabled=true,proactive_enabled=true;
    set session_replication_role='origin';
  `);
}

async function prepareCanonicalManualDispatchFixtures(database) {
  await prepareAutomationFixtures(database);
  await database.exec(`
    set session_replication_role='replica';
    insert into public.openclaw_consents(
      organization_id,account_id,target_id,consent_scope,consent_status,
      consent_source,evidence_hash,granted_at
    ) values (
      '${DEMO_ORG_ID}','11111111-1111-4111-8111-111111111111',
      '55555555-5555-4555-8555-555555555555','REPLY','ACTIVE',
      'canonical-manual-dispatch',repeat('a',64),statement_timestamp()
    ) on conflict (organization_id,account_id,target_id,consent_scope,consent_version)
      do update set consent_status='ACTIVE',revoked_at=null;
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
      id,organization_id,account_id,automation_version_id,target_id,campaign_id,
      campaign_version_id,
      schedule_version,status,timezone,local_recurrence_rule,next_run_at,
      next_nominal_local,next_resolved_local,next_utc_offset_seconds,next_resolution
    )
    select
      '77777777-7777-4777-8777-777777777771','${DEMO_ORG_ID}',
      '11111111-1111-4111-8111-111111111111',
      '66666666-6666-4666-8666-666666666664',
      '55555555-5555-4555-8555-555555555555',
      '66666666-6666-4666-8666-666666666665',
      '66666666-6666-4666-8666-666666666666',1,'ACTIVE','Asia/Bangkok',
      recurrence,run_at,local_at,local_at,25200,'EXACT'
    from schedule_values
    on conflict (organization_id,id) do nothing;
    with schedule_data as (
      select schedule.*,
        jsonb_build_object(
          'version',1,'scheduleId',schedule.id,'scheduleVersion',schedule.schedule_version,
          'automationVersionId',schedule.automation_version_id,'targetId',schedule.target_id,
          'campaignVersionId',schedule.campaign_version_id,
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
      target_id,campaign_id,campaign_version_id,status,timezone,local_recurrence_rule,
      missed_occurrence_policy,
      occurrence_grace_seconds,dst_fold_policy,snapshot,snapshot_bytes,snapshot_hash
    )
    select
      organization_id,account_id,id,schedule_version,automation_version_id,target_id,
      campaign_id,campaign_version_id,status,timezone,local_recurrence_rule,
      missed_occurrence_policy,
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
        'version',1,'eventType','lead_created_or_assigned','eventSubtype','CREATED',
        'sourceTable','leads','sourceId','88888888-8888-4888-8888-888888888883',
        'sourceVersion','1','snapshot',jsonb_build_object(
          'leadId','88888888-8888-4888-8888-888888888883',
          'assignedStaffId',null,'status','NEW'
        )
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
  const claimed = await database.query(
    `select app_private.openclaw_claim_work_item_v1(
      $1::jsonb,'{}'::jsonb,$2::jsonb
    ) result`,
    [
      JSON.stringify(maintenancePrincipal()),
      JSON.stringify({
        version: 1,
        claimToken: concurrencyClaimToken("retention-quarantine-hold"),
        limit: 1,
        leaseSeconds: 30,
        requestedKinds: ["RETENTION_DELETE"],
      }),
    ],
  );
  const work = await database.query(`
    select id::text id,claim_generation::integer claim_generation
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
  const claimed = await database.query(
    `select app_private.openclaw_claim_work_item_v1(
      $1::jsonb,'{}'::jsonb,$2::jsonb
    ) result`,
    [
      JSON.stringify(maintenancePrincipal()),
      JSON.stringify({
        version: 1,
        claimToken,
        limit: 10,
        leaseSeconds: 30,
        requestedKinds: ["RETENTION_DELETE"],
      }),
    ],
  );
  const work = await database.query(`
    select id::text id,claim_generation::integer claim_generation
    from public.openclaw_maintenance_work_items
    where source_id='${subjectId}' and work_phase='QUARANTINE' and state='LEASED'
  `);
  if (!work.rows[0]) {
    throw new Error("R2-independent quarantine work was not leased.");
  }
  const claim = claimed.rows[0].result.items.find((item) => item.workItemId === work.rows[0].id);
  if (
    !claim || canonicalComparisonJson(Object.keys(claim).sort()) !== canonicalComparisonJson([
      "claimGeneration","claimToken","credentialGeneration","fencingToken",
      "leaseExpiresAt","leaseGeneration","maintenancePrincipalId","organizationId",
      "payload","sourceKey","version","workItemId",
    ].sort()) ||
    claim.version !== 1 || claim.organizationId !== DEMO_ORG_ID ||
    claim.maintenancePrincipalId !== "44444444-4444-4444-8444-444444444444" ||
    claim.credentialGeneration !== 1 || claim.leaseGeneration !== 1 ||
    claim.claimToken !== claimToken || claim.claimGeneration !== work.rows[0].claim_generation ||
    claim.fencingToken !== 1 || claim.payload?.kind !== "RETENTION_DELETE" ||
    claim.payload?.deletePhase !== "QUARANTINE"
  ) {
    throw new Error("Maintenance claim did not match the canonical discriminated contract.");
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
      media_kind,mime,byte_length,sha256,byte_state,object_key,retention_delete_not_before
    ) values (
      '99999999-9999-4999-8999-000000000011','${DEMO_ORG_ID}',
      '11111111-1111-4111-8111-111111111111',
      '55555555-5555-4555-8555-555555555556',
      '99999999-9999-4999-8999-000000000010',0,'IMAGE','image/png',64,repeat('1',64),
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
    insert into public.openclaw_retention_gateway_configs(
      id,organization_id,signing_key_generation,ticket_key_generation,
      public_key_hash,is_active,enabled_at
    ) values (
      '99999999-9999-4999-8999-000000000018','${DEMO_ORG_ID}',1,1,
      repeat('a',64),true,statement_timestamp()
    ) on conflict (organization_id,signing_key_generation) do nothing;
    set session_replication_role='origin';
  `);
  const request = {
    version: 1,
    workItemId: "99999999-9999-4999-8999-000000000014",
    claimGeneration: 1,
    claimToken,
  };
  let forgedIssueRejected = false;
  try {
    await database.query(
      `select app_private.openclaw_issue_retention_delete_ticket_v1(
        $1::jsonb,'{}'::jsonb,$2::jsonb
      )`,
      [
        JSON.stringify(maintenancePrincipal()),
        JSON.stringify({
          ...request,
          tombstoneId: "99999999-9999-4999-8999-000000000013",
        }),
      ],
    );
  } catch (error) {
    forgedIssueRejected = error?.code === "22023";
  }
  if (!forgedIssueRejected) {
    throw new Error("Retention delete ticket accepted a caller-supplied trusted field.");
  }
  await database.query(
    `select app_private.openclaw_issue_retention_delete_ticket_v1(
      $1::jsonb,'{}'::jsonb,$2::jsonb
    )`,
    [
      JSON.stringify(maintenancePrincipal()),
      JSON.stringify(request),
    ],
  );
  let forgedAuthorizationRejected = false;
  try {
    await database.query(
      `select app_private.openclaw_authorize_retention_delete_v1(
        $1::jsonb,'{}'::jsonb,$2::jsonb
      )`,
      [JSON.stringify(maintenancePrincipal()), JSON.stringify({ ...request, preverified: true })],
    );
  } catch (error) {
    forgedAuthorizationRejected = error?.code === "22023";
  }
  if (!forgedAuthorizationRejected) {
    throw new Error("Retention authorization accepted a caller-supplied trusted field.");
  }
  await database.exec(`
    update public.openclaw_retention_gateway_configs
    set ticket_key_generation=2
    where organization_id='${DEMO_ORG_ID}' and is_active;
  `);
  let keyMismatchRejected = false;
  try {
    await database.query(
      `select app_private.openclaw_authorize_retention_delete_v1(
        $1::jsonb,'{}'::jsonb,$2::jsonb
      )`,
      [JSON.stringify(maintenancePrincipal()), JSON.stringify(request)],
    );
  } catch (error) {
    keyMismatchRejected = error?.code === "42501";
  }
  const mismatchState = await database.query(
    `select state from public.openclaw_retention_delete_tickets
     where organization_id=$1 and work_item_id=$2`,
    [DEMO_ORG_ID, request.workItemId],
  );
  if (!keyMismatchRejected || mismatchState.rows[0]?.state !== "TICKET_ISSUED") {
    throw new Error("Retention ticket-key mismatch did not fail closed before authorization.");
  }
  await database.exec(`
    update public.openclaw_retention_gateway_configs
    set ticket_key_generation=1
    where organization_id='${DEMO_ORG_ID}' and is_active;
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
    tombstoneId: "99999999-9999-4999-8999-000000000013",
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
  const objectKey = `v1/org/${DEMO_ORG_ID}/retention/${code}`;
  const claimToken = `retention-ticket-${code}`;
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
        media_kind,mime,byte_length,sha256,byte_state,object_key,retention_delete_not_before
      ) values (
        '${mediaId}','${DEMO_ORG_ID}','11111111-1111-4111-8111-111111111111',
        '55555555-5555-4555-8555-555555555556','${messageId}',0,'IMAGE',
        'image/png',64,repeat('c',64),'QUARANTINED',null,statement_timestamp()-interval '1 day'
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
        state,claim_token_hash,claim_generation,maintenance_lease_generation,fencing_token,
        lease_expires_at,attempt_count,credential_generation
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
        ),repeat('9',64),'LEASED',
        encode(extensions.digest(
          convert_to('ihome-openclaw-work-claim-v1','UTF8')||decode('00','hex')
            ||convert_to('${claimToken}','UTF8'),'sha256'
        ),'hex'),1,1,1,statement_timestamp()+interval '30 seconds',1,1
      ) on conflict (organization_id,id) do nothing;
      insert into public.openclaw_retention_gateway_configs(
        organization_id,signing_key_generation,ticket_key_generation,
        public_key_hash,is_active,enabled_at
      ) values (
        '${DEMO_ORG_ID}',1,1,repeat('a',64),true,statement_timestamp()
      ) on conflict (organization_id,signing_key_generation) do nothing;
      set session_replication_role='origin';
    `,
  );
  const request = {
    version: 1,
    workItemId,
    claimGeneration: 1,
    claimToken,
  };
  const firstIssue = await database.query(
    `select app_private.openclaw_issue_retention_delete_ticket_v1(
      $1::jsonb,'{}'::jsonb,$2::jsonb
    ) result`,
    [JSON.stringify(maintenancePrincipal()), JSON.stringify(request)],
  );
  const replayedIssue = await database.query(
    `select app_private.openclaw_issue_retention_delete_ticket_v1(
      $1::jsonb,'{}'::jsonb,$2::jsonb
    ) result`,
    [JSON.stringify(maintenancePrincipal()), JSON.stringify(request)],
  );
  if (
    JSON.stringify(firstIssue.rows[0].result) !== JSON.stringify(replayedIssue.rows[0].result) ||
    firstIssue.rows[0].result.ticketId === firstIssue.rows[0].result.ticket.jti
  ) {
    throw new Error("Retention delete ticket replay was not deterministic or used ticketId as jti.");
  }
  const firstAuthorization = await database.query(
    `select app_private.openclaw_authorize_retention_delete_v1(
      $1::jsonb,'{}'::jsonb,$2::jsonb
    ) result`,
    [JSON.stringify(maintenancePrincipal()), JSON.stringify(request)],
  );
  const replayedAuthorization = await database.query(
    `select app_private.openclaw_authorize_retention_delete_v1(
      $1::jsonb,'{}'::jsonb,$2::jsonb
    ) result`,
    [JSON.stringify(maintenancePrincipal()), JSON.stringify(request)],
  );
  if (
    JSON.stringify(firstAuthorization.rows[0].result) !==
      JSON.stringify(replayedAuthorization.rows[0].result) ||
    firstAuthorization.rows[0].result.ticketHash !== firstIssue.rows[0].result.ticketHash
  ) {
    throw new Error("Retention authorization replay did not preserve the issued ticket binding.");
  }
  const issuedTicketId = firstIssue.rows[0].result.ticketId;
  const ticket = await database.query(
    `select id::text id,expected_receipt_claims
     from public.openclaw_retention_delete_tickets where id=$1`,
    [issuedTicketId],
  );
  return {
    ticketId: issuedTicketId,
    workItemId,
    mediaId,
    expectedReceiptClaims: ticket.rows[0].expected_receipt_claims,
  };
}

function retentionReceipt(ticket, outcome, overrides = {}) {
  return {
    ...ticket.expectedReceiptClaims,
    receiptId: ticket.ticketId,
    objectStatus: outcome,
    r2VersionOrEtag: outcome === "DELETED" ? "r2-version-1" : null,
    completedAt: "2026-07-31T00:00:10.000Z",
    signature: "A".repeat(86),
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
  const claimToken = `audit-anchor-${code}`;
  const rootHash = createHash("sha256").update(`audit-root-${code}`).digest("hex");
  const rootDate = new Date(Date.UTC(2026, 5, code)).toISOString().slice(0, 10);
  const objectKey =
    `v1/org/${DEMO_ORG_ID}/audit/${rootDate}/${auditRootId}.json`;
  await database.exec(`
    set session_replication_role='replica';
    insert into public.openclaw_audit_signing_configs(
      id,organization_id,signing_key_generation,public_key_hash,is_active,enabled_at
    ) values (
      'aaaa4000-0000-4000-8000-000000000001','${DEMO_ORG_ID}',1,
      repeat('a',64),true,statement_timestamp()
    ) on conflict (organization_id,signing_key_generation) do update set
      public_key_hash=excluded.public_key_hash,is_active=true,
      enabled_at=excluded.enabled_at,retired_at=null;
    insert into public.openclaw_audit_roots(
      id,organization_id,root_date,first_sequence,last_sequence,previous_root_hash,
      merkle_root_hash,root_hash,
      event_count,signing_key_generation,r2_anchor_key
    ) values (
      '${auditRootId}','${DEMO_ORG_ID}','${rootDate}',1,1,null,'${rootHash}','${rootHash}',
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
        'eventCount',1,'previousRootHash',null,'merkleRootHash','${rootHash}',
        'auditSigningKeyGeneration',1,
        'auditSigningPublicKeyHash',repeat('a',64),'anchorKey','${objectKey}'
      ),repeat('e',64),'LEASED',
      encode(extensions.digest(
        convert_to('ihome-openclaw-work-claim-v1','UTF8')||decode('00','hex')
          ||convert_to('${claimToken}','UTF8'),'sha256'
      ),'hex'),1,1,1,statement_timestamp()+interval '30 seconds',1,1
    ) on conflict (organization_id,id) do nothing;
    insert into public.openclaw_retention_gateway_configs(
      id,organization_id,signing_key_generation,public_key_hash,is_active,enabled_at
    ) values (
      'aaaa3000-0000-4000-8000-000000000001','${DEMO_ORG_ID}',1,
      repeat('a',64),true,statement_timestamp()
    ) on conflict (organization_id,signing_key_generation) do nothing;
    set session_replication_role='origin';
  `);
  const verifyTicket = await database.query(
    `select app_private.openclaw_issue_media_ticket_v1(
      $1::jsonb,'{}'::jsonb,$2::jsonb
    ) result`,
    [
      JSON.stringify(maintenancePrincipal()),
      JSON.stringify({
        version: 1,
        operation: "ANCHOR_VERIFY",
        workItemId,
        claimGeneration: 1,
        claimToken,
        auditRootId,
        rootHash,
        anchorKey: objectKey,
        signatureHash: "f".repeat(64),
        auditSigningKeyGeneration: 1,
        auditSigningPublicKeyHash: "a".repeat(64),
        documentSha256: "b".repeat(64),
        documentByteLength: 128,
      }),
    ],
  );
  const verifyTicketJti = verifyTicket.rows[0].result.ticketId;
  const receipt = {
    version: 1,
    receiptKind: "AUDIT_ANCHOR_VERIFY",
    receiptId: verifyTicketJti,
    organizationId: DEMO_ORG_ID,
    maintenancePrincipalId: "44444444-4444-4444-8444-444444444444",
    workItemId,
    claimGeneration: 1,
    credentialGeneration: 1,
    leaseGeneration: 1,
    fencingToken: 1,
    auditRootId,
    rootHash,
    anchorKey: objectKey,
    verifyTicketJti,
    auditSigningKeyGeneration: 1,
    signatureHash: "f".repeat(64),
    objectVersionOrEtag: "audit-version-1",
    verifiedAt: "2026-07-31T00:00:10.000Z",
    gatewaySigningKeyGeneration: 1,
    signature: "A".repeat(86),
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
    const outboxClaimTokenA = concurrencyClaimToken("outbox-claim-a");
    const outboxClaimTokenB = concurrencyClaimToken("outbox-claim-b");
    const claims = await runConcurrent(database, [
      (session) => session.query(
        `select app_private.openclaw_claim_outbox_v1($1::jsonb,'{}'::jsonb,$2::jsonb) result`,
        [
          JSON.stringify(channelPrincipal()),
          JSON.stringify({ version: 1, claimToken: outboxClaimTokenA, limit: 1, leaseSeconds: 30 }),
        ],
      ),
      (session) => session.query(
        `select app_private.openclaw_claim_outbox_v1($1::jsonb,'{}'::jsonb,$2::jsonb) result`,
        [
          JSON.stringify(channelPrincipal()),
          JSON.stringify({ version: 1, claimToken: outboxClaimTokenB, limit: 1, leaseSeconds: 30 }),
        ],
      ),
    ]);
    const itemCounts = claims.map((claim) => claim.rows[0].result.items.length).sort();
    if (JSON.stringify(itemCounts) !== JSON.stringify([0, 1])) {
      throw new Error("Concurrent outbox claims did not produce exactly one winner.");
    }
    const winningIndex = claims.findIndex((claim) => claim.rows[0].result.items.length === 1);
    const winningToken = winningIndex === 0 ? outboxClaimTokenA : outboxClaimTokenB;
    const row = await database.query(
      `select state,claim_generation from public.openclaw_outbox where id=$1`,
      [outboxId],
    );
    if (row.rows[0].state !== "LEASED" || Number(row.rows[0].claim_generation) !== 1) {
      throw new Error("Outbox winner did not persist the exact claim generation.");
    }
    return { outboxId, claimToken: winningToken };
  }
  if (scenario === "WORK_SINGLE_CLAIM") {
    const workId = "bbbbbbbb-bbbb-4bbb-8bbb-000000000101";
    const workClaimTokenA = concurrencyClaimToken("work-claim-a");
    const workClaimTokenB = concurrencyClaimToken("work-claim-b");
    await database.exec(`
      set session_replication_role='replica';
      insert into public.openclaw_send_work_items(
        id,organization_id,account_id,cell_id,work_kind,source_id,source_version,
        source_key,source_hash,payload,payload_hash,state,claim_generation,
        fencing_token,session_generation,target_id,credential_generation,
        runtime_lease_generation,schedule_id,schedule_version,schedule_occurrence_id,
        campaign_version_id
      ) values (
        '${workId}','${DEMO_ORG_ID}','11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222','SCHEDULE_OCCURRENCE',
        'bbbbbbbb-bbbb-4bbb-8bbb-000000000102','1',
        'concurrency:work:single-claim',repeat('a',64),
        jsonb_build_object('kind','SCHEDULE_OCCURRENCE','targetId',
          '55555555-5555-4555-8555-555555555555'),repeat('b',64),
        'QUEUED',0,1,1,'55555555-5555-4555-8555-555555555555',1,1,
        'bbbbbbbb-bbbb-4bbb-8bbb-000000000103',1,
        'bbbbbbbb-bbbb-4bbb-8bbb-000000000102',
        'bbbbbbbb-bbbb-4bbb-8bbb-000000000104'
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
            claimToken: workClaimTokenA,
            limit: 1,
            leaseSeconds: 30,
            requestedKinds: ["SCHEDULE_OCCURRENCE"],
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
            claimToken: workClaimTokenB,
            limit: 1,
            leaseSeconds: 30,
            requestedKinds: ["SCHEDULE_OCCURRENCE"],
          }),
        ],
      ),
    ]);
    const itemCounts = claims.map((claim) => claim.rows[0].result.items.length).sort();
    const winningIndex = claims.findIndex((claim) => claim.rows[0].result.items.length === 1);
    const winningItem = winningIndex < 0 ? null : claims[winningIndex].rows[0].result.items[0];
    const winningToken = winningIndex === 0 ? workClaimTokenA : workClaimTokenB;
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
      Number(row.rows[0].fencing_token) !== 1 ||
      canonicalComparisonJson(Object.keys(winningItem ?? {}).sort()) !== canonicalComparisonJson([
        "accountId","cellId","claimGeneration","claimToken","credentialGeneration",
        "fencingToken","leaseExpiresAt","leaseGeneration","organizationId","payload",
        "sourceKey","version","workItemId",
      ].sort()) ||
      winningItem.version !== 1 || winningItem.workItemId !== workId ||
      winningItem.organizationId !== DEMO_ORG_ID ||
      winningItem.accountId !== "11111111-1111-4111-8111-111111111111" ||
      winningItem.cellId !== "22222222-2222-4222-8222-222222222222" ||
      winningItem.credentialGeneration !== 1 || winningItem.leaseGeneration !== 1 ||
      winningItem.claimToken !== winningToken || winningItem.claimGeneration !== 1 ||
      winningItem.fencingToken !== 1 ||
      winningItem.sourceKey !== "concurrency:work:single-claim" ||
      winningItem.payload?.kind !== "SCHEDULE_OCCURRENCE"
    ) {
      throw new Error("Concurrent send-work claims did not return one canonical exact winner.");
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
    await prepareCanonicalManualDispatchFixtures(database);
    const outboxId = await insertConcurrencyOutbox(database, scenario);
    const claimToken = concurrencyClaimToken("pre-handoff-requeue");
    const claimed = await database.query(
      `select app_private.openclaw_claim_outbox_v1($1::jsonb,'{}'::jsonb,$2::jsonb) result`,
      [
        JSON.stringify(channelPrincipal()),
        JSON.stringify({
          version: 1,
          claimToken,
          limit: 1,
          leaseSeconds: 30,
        }),
      ],
    );
    const claim = claimed.rows[0].result.items[0];
    const preflight = await database.query(
      `select app_private.openclaw_preflight_outbox_v1(
        $1::jsonb,'{}'::jsonb,$2::jsonb
      ) result`,
      [
        JSON.stringify(channelPrincipal()),
        JSON.stringify({
          version: 1,
          outboxId,
          claimGeneration: claim.claimGeneration,
          claimToken,
        }),
      ],
    );
    const marker = preflight.rows[0].result.authorizationMarker;
    if (preflight.rows[0].result.decision !== "ALLOWED" || !marker) {
      throw new Error(
        `Canonical pre-handoff fixture was not authorized: ${JSON.stringify(preflight.rows[0].result)}`,
      );
    }
    const evidence = {
      version: 1,
      evidenceKind: "OUTBOX_PRE_HANDOFF",
      outboxId,
      claimGeneration: claim.claimGeneration,
      payloadHash: claim.payloadHash,
      authorizationMarker: marker,
      reasonCode: "ADAPTER_NOT_READY",
      authorizedHandoffRecorded: false,
    };
    const retryNotBefore = new Date(
      new Date(preflight.rows[0].result.databaseTime).valueOf() + 5_000,
    ).toISOString();
    const result = await database.query(
      `select app_private.openclaw_requeue_pre_handoff_v1(
        $1::jsonb,'{}'::jsonb,$2::jsonb
      ) result`,
      [
        JSON.stringify(channelPrincipal()),
        JSON.stringify({
          version: 1,
          authorization: {
            version: 1,
            claimToken,
            authorizationMarker: marker,
          },
          outcome: "SAFE_RETRY",
          reasonCode: "ADAPTER_NOT_READY",
          preHandoffEvidence: evidence,
          preHandoffEvidenceHash: canonicalDomainHash(
            "ihome-openclaw-pre-handoff-evidence-v1",
            evidence,
          ),
          retryNotBefore,
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
  if (scenario === "CANONICAL_OUTBOX_COMPLETION") {
    await prepareCanonicalManualDispatchFixtures(database);
    const outboxId = await insertConcurrencyOutbox(database, scenario);
    const claimToken = concurrencyClaimToken("canonical-completion");
    const claimed = await database.query(
      `select app_private.openclaw_claim_outbox_v1(
        $1::jsonb,'{}'::jsonb,$2::jsonb
      ) result`,
      [
        JSON.stringify(channelPrincipal()),
        JSON.stringify({ version: 1, claimToken, limit: 1, leaseSeconds: 30 }),
      ],
    );
    const claim = claimed.rows[0].result.items[0];
    const preflight = await database.query(
      `select app_private.openclaw_preflight_outbox_v1(
        $1::jsonb,'{}'::jsonb,$2::jsonb
      ) result`,
      [
        JSON.stringify(channelPrincipal()),
        JSON.stringify({
          version: 1,
          outboxId,
          claimGeneration: claim.claimGeneration,
          claimToken,
        }),
      ],
    );
    const marker = preflight.rows[0].result.authorizationMarker;
    if (preflight.rows[0].result.decision !== "ALLOWED" || !marker) {
      throw new Error(
        `Canonical completion fixture was not authorized: ${JSON.stringify(preflight.rows[0].result)}`,
      );
    }
    const authorization = {
      version: 1,
      claimToken,
      authorizationMarker: marker,
    };
    await database.query(
      `select app_private.openclaw_authorize_outbox_send_v1(
        $1::jsonb,'{}'::jsonb,$2::jsonb
      ) result`,
      [JSON.stringify(channelPrincipal()), JSON.stringify(authorization)],
    );
    const deliveryEvidence = {
      version: 1,
      evidenceKind: "OUTBOX_DELIVERY",
      outboxId,
      claimGeneration: claim.claimGeneration,
      payloadHash: claim.payloadHash,
      authorizationMarker: marker,
      totalPartCount: 1,
      knownProviderMessageIds: ["provider-canonical-1"],
      possibleHandoffPrefixLength: 1,
      outcome: "SENT",
      reasonCode: "ALL_PARTS_ACKNOWLEDGED",
    };
    const deliveryEvidenceHash = canonicalDomainHash(
      "ihome-openclaw-delivery-evidence-v1",
      deliveryEvidence,
    );
    const completion = {
      version: 1,
      authorization,
      deliveryEvidence,
      deliveryEvidenceHash,
      outcome: "SENT",
      reasonCode: "ALL_PARTS_ACKNOWLEDGED",
    };
    let forgedRejected = false;
    try {
      await database.query(
        `select app_private.openclaw_complete_outbox_v1(
          $1::jsonb,'{}'::jsonb,$2::jsonb
        )`,
        [
          JSON.stringify(channelPrincipal()),
          JSON.stringify({ ...completion, deliveryEvidenceHash: "f".repeat(64) }),
        ],
      );
    } catch (error) {
      forgedRejected = /hash|contract/i.test(String(error?.message ?? error));
    }
    if (!forgedRejected) throw new Error("Forged canonical delivery evidence hash was accepted.");
    const result = await database.query(
      `select app_private.openclaw_complete_outbox_v1(
        $1::jsonb,'{}'::jsonb,$2::jsonb
      ) result`,
      [JSON.stringify(channelPrincipal()), JSON.stringify(completion)],
    );
    const persisted = await database.query(
      `select outbox.state,attempt.delivery_evidence_hash,
        attempt.known_provider_message_ids
       from public.openclaw_outbox outbox
       join public.openclaw_delivery_attempts attempt
         on attempt.organization_id=outbox.organization_id
        and attempt.account_id=outbox.account_id and attempt.outbox_id=outbox.id
       where outbox.organization_id=$1 and outbox.id=$2`,
      [DEMO_ORG_ID, outboxId],
    );
    if (
      result.rows[0].result.state !== "SENT" ||
      persisted.rows[0]?.state !== "SENT" ||
      persisted.rows[0]?.delivery_evidence_hash !== deliveryEvidenceHash ||
      persisted.rows[0]?.known_provider_message_ids?.[0] !== "provider-canonical-1"
    ) {
      throw new Error("Canonical outbox completion was not persisted exactly.");
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
    const winningResolution = winners[0]?.value?.rows?.[0]?.result;
    const reloadedWinner = await database.query(
      `select public.openclaw_get_unknown_resolution_v1($1::jsonb) result`,
      [JSON.stringify({
        version: 1,
        organizationId: DEMO_ORG_ID,
        accountId: "11111111-1111-4111-8111-111111111111",
        outboxId,
      })],
    );
    if (
      winners.length !== 1 ||
      losers.length !== 1 ||
      state.rows[0].state !== "UNKNOWN" ||
      Number(state.rows[0].resolution_version) !== 1 ||
      state.rows[0].resolution_count !== 1 ||
      reloadedWinner.rows[0].result?.resolutionId !== winningResolution?.resolutionId ||
      reloadedWinner.rows[0].result?.outboxId !== outboxId ||
      reloadedWinner.rows[0].result?.accountId !== "11111111-1111-4111-8111-111111111111"
    ) {
      throw new Error(
        `UNKNOWN resolution did not preserve one immutable CAS winner: ${JSON.stringify({
          calls: calls.map((call) =>
            call.status === "fulfilled"
              ? "fulfilled"
              : String(call.reason?.message ?? call.reason),
          ),
          state: state.rows[0],
          reloadedWinner: reloadedWinner.rows[0].result,
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
            claimToken: concurrencyClaimToken("retention-quarantine-hold"),
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
      proof.rows[0].ticket_count !== 1
    ) {
      throw new Error("A legal hold did not block final delete authorization.");
    }
    return;
  }
  if (scenario === "CANONICAL_MAINTENANCE_CLAIM") {
    await prepareRetentionQuarantineSuccess(database);
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
  if (scenario === "MAINTENANCE_FAILURE_READINESS") {
    const work = await prepareRetentionQuarantineSuccess(database);
    const evidence = {
      version: 1,
      evidenceKind: "WORK_FAILURE",
      reasonCode: "MAINTENANCE_WORK_RETRY",
      failureFingerprint: "a".repeat(64),
    };
    const request = {
      version: 1,
      workItemId: work.id,
      organizationId: DEMO_ORG_ID,
      maintenancePrincipalId: maintenancePrincipal().maintenancePrincipalId,
      credentialGeneration: 1,
      leaseGeneration: 1,
      fencingToken: 1,
      claimToken: work.claimToken,
      claimGeneration: work.claim_generation,
      outcome: "RETRY",
      evidence,
      evidenceHash: canonicalDomainHash(
        "ihome-openclaw-maintenance-work-failure-v1",
        evidence,
      ),
      retryAfterSeconds: 1,
    };
    const first = await database.query(
      `select app_private.openclaw_complete_maintenance_work_v1(
        $1::jsonb,'{}'::jsonb,$2::jsonb
      ) result`,
      [JSON.stringify(maintenancePrincipal()), JSON.stringify(request)],
    );
    const replay = await database.query(
      `select app_private.openclaw_complete_maintenance_work_v1(
        $1::jsonb,'{}'::jsonb,$2::jsonb
      ) result`,
      [JSON.stringify(maintenancePrincipal()), JSON.stringify(request)],
    );
    const blockedClaim = await database.query(
      `select app_private.openclaw_claim_work_item_v1(
        $1::jsonb,'{}'::jsonb,$2::jsonb
      ) result`,
      [JSON.stringify(maintenancePrincipal()), JSON.stringify({
        version: 1,
        claimToken: concurrencyClaimToken("maintenance-failure-backoff-blocked"),
        limit: 1,
        leaseSeconds: 30,
        requestedKinds: ["RETENTION_DELETE"],
      })],
    );
    if (
      first.rows[0].result.state !== "FAILURE_RECORDED" ||
      first.rows[0].result.outcome !== "SAFE_RETRY" ||
      canonicalComparisonJson(first.rows[0].result) !==
        canonicalComparisonJson(replay.rows[0].result) ||
      blockedClaim.rows[0].result.items.length !== 0 ||
      blockedClaim.rows[0].result.unresolvedFailures.retentionDelete !== 1 ||
      blockedClaim.rows[0].result.unresolvedFailures.auditAnchor !== 0
    ) {
      throw new Error("Maintenance failure was not durably replayed with exact readiness.");
    }
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const retryToken = concurrencyClaimToken("maintenance-failure-retry-claim");
    const retried = await database.query(
      `select app_private.openclaw_claim_work_item_v1(
        $1::jsonb,'{}'::jsonb,$2::jsonb
      ) result`,
      [JSON.stringify(maintenancePrincipal()), JSON.stringify({
        version: 1,
        claimToken: retryToken,
        limit: 1,
        leaseSeconds: 30,
        requestedKinds: ["RETENTION_DELETE"],
      })],
    );
    const retriedItem = retried.rows[0].result.items.find((item) => item.workItemId === work.id);
    if (!retriedItem || retried.rows[0].result.unresolvedFailures.retentionDelete !== 1) {
      throw new Error("Exact failed maintenance item did not become retryable after backoff.");
    }
    await database.query(
      `select app_private.openclaw_complete_retention_quarantine_v1(
        $1::jsonb,'{}'::jsonb,$2::jsonb
      ) result`,
      [JSON.stringify(maintenancePrincipal()), JSON.stringify({
        version: 1,
        workItemId: work.id,
        claimGeneration: retriedItem.claimGeneration,
        claimToken: retryToken,
      })],
    );
    const cleared = await database.query(
      `select app_private.openclaw_claim_work_item_v1(
        $1::jsonb,'{}'::jsonb,$2::jsonb
      ) result`,
      [JSON.stringify(maintenancePrincipal()), JSON.stringify({
        version: 1,
        claimToken: concurrencyClaimToken("maintenance-failure-cleared-check"),
        limit: 1,
        leaseSeconds: 30,
        requestedKinds: ["RETENTION_DELETE"],
      })],
    );
    if (cleared.rows[0].result.unresolvedFailures.retentionDelete !== 0) {
      throw new Error("Exact maintenance item success did not clear its durable failure.");
    }
    return;
  }
  if (scenario === "MAINTENANCE_RECOVERY_FAILURE") {
    const ticket = await prepareRetentionDeleteTicket(database, 18);
    await database.exec(`
      set session_replication_role='replica';
      update public.openclaw_maintenance_work_items
      set recovery_lease_expires_at=statement_timestamp()-interval '1 second',
          updated_at=statement_timestamp()
      where organization_id='${DEMO_ORG_ID}' and id='${ticket.workItemId}';
      set session_replication_role='origin';
    `);
    const firstToken = concurrencyClaimToken("maintenance-recovery-failure-first");
    const firstClaim = await database.query(
      `select app_private.openclaw_claim_work_item_v1(
        $1::jsonb,'{}'::jsonb,$2::jsonb
      ) result`,
      [JSON.stringify(maintenancePrincipal()), JSON.stringify({
        version: 1,
        claimToken: firstToken,
        limit: 1,
        leaseSeconds: 30,
        requestedKinds: ["RETENTION_DELETE"],
      })],
    );
    const recovery = firstClaim.rows[0].result.items[0];
    const evidence = {
      version: 1,
      evidenceKind: "WORK_FAILURE",
      reasonCode: "MAINTENANCE_RECOVERY_RETRY",
      failureFingerprint: "b".repeat(64),
    };
    const failureRequest = {
      version: 1,
      workItemId: ticket.workItemId,
      organizationId: DEMO_ORG_ID,
      maintenancePrincipalId: maintenancePrincipal().maintenancePrincipalId,
      credentialGeneration: 1,
      leaseGeneration: 1,
      fencingToken: 1,
      claimToken: firstToken,
      recoveryKind: "RETENTION_DELETE_AUTHORIZED",
      recoveryGeneration: recovery.recoveryGeneration,
      frozenClaim: recovery.frozenClaim,
      outcome: "RETRY",
      evidence,
      evidenceHash: canonicalDomainHash(
        "ihome-openclaw-maintenance-work-failure-v1",
        evidence,
      ),
      retryAfterSeconds: 1,
    };
    const firstFailure = await database.query(
      `select app_private.openclaw_complete_maintenance_work_v1(
        $1::jsonb,'{}'::jsonb,$2::jsonb
      ) result`,
      [JSON.stringify(maintenancePrincipal()), JSON.stringify(failureRequest)],
    );
    const replayFailure = await database.query(
      `select app_private.openclaw_complete_maintenance_work_v1(
        $1::jsonb,'{}'::jsonb,$2::jsonb
      ) result`,
      [JSON.stringify(maintenancePrincipal()), JSON.stringify(failureRequest)],
    );
    const blocked = await database.query(
      `select app_private.openclaw_claim_work_item_v1(
        $1::jsonb,'{}'::jsonb,$2::jsonb
      ) result`,
      [JSON.stringify(maintenancePrincipal()), JSON.stringify({
        version: 1,
        claimToken: concurrencyClaimToken("maintenance-recovery-failure-blocked"),
        limit: 1,
        leaseSeconds: 30,
        requestedKinds: ["RETENTION_DELETE"],
      })],
    );
    if (
      firstFailure.rows[0].result.outcome !== "SAFE_RETRY" ||
      canonicalComparisonJson(firstFailure.rows[0].result) !==
        canonicalComparisonJson(replayFailure.rows[0].result) ||
      blocked.rows[0].result.items.length !== 0 ||
      blocked.rows[0].result.unresolvedFailures.retentionDelete !== 1
    ) {
      throw new Error("Recovery failure was not durable, replayable, or backoff-bound.");
    }
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const secondToken = concurrencyClaimToken("maintenance-recovery-failure-second");
    const secondClaim = await database.query(
      `select app_private.openclaw_claim_work_item_v1(
        $1::jsonb,'{}'::jsonb,$2::jsonb
      ) result`,
      [JSON.stringify(maintenancePrincipal()), JSON.stringify({
        version: 1,
        claimToken: secondToken,
        limit: 1,
        leaseSeconds: 30,
        requestedKinds: ["RETENTION_DELETE"],
      })],
    );
    const reclaimed = secondClaim.rows[0].result.items.find((item) =>
      item.workItemId === ticket.workItemId
    );
    if (!reclaimed || reclaimed.recoveryGeneration <= recovery.recoveryGeneration) {
      throw new Error("Recovery failure did not reclaim with a fresh recovery generation.");
    }
    await database.query(
      `select app_private.openclaw_complete_maintenance_work_v1(
        $1::jsonb,'{}'::jsonb,$2::jsonb
      ) result`,
      [JSON.stringify(maintenancePrincipal()), JSON.stringify({
        version: 1,
        recoveryKind: "RETENTION_DELETE_AUTHORIZED",
        workItemId: ticket.workItemId,
        recoveryGeneration: reclaimed.recoveryGeneration,
        claimToken: secondToken,
        ticketId: ticket.ticketId,
        gatewayReceipt: retentionReceipt(ticket, "DELETED"),
      })],
    );
    const cleared = await database.query(
      `select app_private.openclaw_claim_work_item_v1(
        $1::jsonb,'{}'::jsonb,$2::jsonb
      ) result`,
      [JSON.stringify(maintenancePrincipal()), JSON.stringify({
        version: 1,
        claimToken: concurrencyClaimToken("maintenance-recovery-failure-cleared"),
        limit: 1,
        leaseSeconds: 30,
        requestedKinds: ["RETENTION_DELETE"],
      })],
    );
    if (cleared.rows[0].result.unresolvedFailures.retentionDelete !== 0) {
      throw new Error("Exact recovery item success did not clear durable readiness.");
    }
    return;
  }
  if (scenario === "HEARTBEAT_COMMAND_DELIVERY") {
    const transitionPrincipal = {
      ...channelPrincipal(),
      sessionGeneration: 2,
      localSessionGeneration: 1,
      authMode: "COMMAND_TRANSITION",
    };
    const normalPrincipal = {
      ...channelPrincipal(),
      sessionGeneration: 2,
      localSessionGeneration: 2,
      authMode: "NORMAL",
    };
    const qrCommandId = "dddd7100-0000-4000-8000-000000000001";
    const challengeId = "dddd7100-0000-4000-8000-000000000002";
    const disconnectCommandId = "dddd7100-0000-4000-8000-000000000003";
    const revocationId = "dddd7100-0000-4000-8000-000000000004";
    await database.exec(`
      set session_replication_role='replica';
      update public.openclaw_accounts set session_generation=2,connection_generation=1,
        connection_state='DISCONNECTING',effective_mode='DRAFT_ONLY'
      where organization_id='${DEMO_ORG_ID}'
        and id='11111111-1111-4111-8111-111111111111';
      insert into public.openclaw_runtime_commands(
        id,organization_id,account_id,cell_id,command_key,command_kind,
        source_session_generation,target_session_generation,
        source_connection_generation,target_connection_generation,
        expected_session_generation,expected_connection_generation,expected_fencing_token,
        payload,payload_bytes,payload_hash
      ) select '${qrCommandId}','${DEMO_ORG_ID}',
        '11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222',
        'heartbeat:qr','QR_LOGIN',2,2,0,1,2,0,1,payload.value,
        app_private.openclaw_jcs_bytes_v1(payload.value),
        encode(extensions.digest(app_private.openclaw_jcs_bytes_v1(payload.value),'sha256'),'hex')
      from (values (jsonb_build_object(
        'version',1,'challengeId','${challengeId}','browserNonceHash',repeat('a',64)
      ))) payload(value)
      on conflict (organization_id,id) do nothing;
      insert into public.openclaw_qr_challenges(
        id,organization_id,account_id,cell_id,runtime_command_id,challenge_version,
        challenge_status,active_slot,material_version,actor_id,auth_session_hash,
        browser_nonce_hash,issued_at,expires_at
      ) values (
        '${challengeId}','${DEMO_ORG_ID}','11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222','${qrCommandId}',1,
        'PENDING',true,0,'99999999-9999-4999-8999-999999999999',repeat('b',64),
        repeat('a',64),statement_timestamp(),statement_timestamp()+interval '120 seconds'
      ) on conflict (organization_id,id) do nothing;
      insert into public.openclaw_runtime_commands(
        id,organization_id,account_id,cell_id,command_key,command_kind,
        source_session_generation,target_session_generation,
        source_connection_generation,target_connection_generation,
        expected_session_generation,expected_connection_generation,expected_fencing_token,
        payload,payload_bytes,payload_hash
      ) select '${disconnectCommandId}','${DEMO_ORG_ID}',
        '11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222',
        'heartbeat:disconnect','DISCONNECT',1,2,0,1,2,0,1,payload.value,
        app_private.openclaw_jcs_bytes_v1(payload.value),
        encode(extensions.digest(app_private.openclaw_jcs_bytes_v1(payload.value),'sha256'),'hex')
      from (values (jsonb_build_object(
        'version',1,'reasonCode','ACCOUNT_DISCONNECT','revocationId','${revocationId}',
        'revokedSessionGeneration',1,'minimumSessionGeneration',2
      ))) payload(value)
      on conflict (organization_id,id) do nothing;
      insert into public.openclaw_generation_revocations(
        id,organization_id,principal_kind,account_id,cell_id,revocation_kind,
        revoked_generation,minimum_valid_generation,command_id,reason_code
      ) values (
        '${revocationId}','${DEMO_ORG_ID}','CHANNEL',
        '11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222',
        'SESSION',1,2,'${disconnectCommandId}','ACCOUNT_DISCONNECT'
      ) on conflict (organization_id,id) do nothing;
      set session_replication_role='origin';
    `);
    const firstToken = concurrencyClaimToken("heartbeat-command-first");
    const heartbeat = (
      principal,
      claimToken,
      commandStarts = [],
      commandResults = [],
      commandLeaseSeconds = 60,
    ) => database.query(
      `select app_private.openclaw_runtime_heartbeat_v1(
        $1::jsonb,'{}'::jsonb,$2::jsonb
      ) result`,
      [JSON.stringify(principal), JSON.stringify({
        version: 1,
        commandClaimToken: claimToken,
        commandLeaseSeconds,
        commandStarts,
        commandResults,
      })],
    );
    const first = await heartbeat(transitionPrincipal, firstToken);
    const replay = await heartbeat(transitionPrincipal, firstToken);
    const commands = first.rows[0].result.commands;
    if (
      commands.length !== 1 || commands[0].runtimeCommandId !== disconnectCommandId ||
      commands[0].sourceSessionGeneration !== 1 || commands[0].targetSessionGeneration !== 2 ||
      commands[0].executionState !== "LEASED" ||
      canonicalComparisonJson(first.rows[0].result.commands) !==
        canonicalComparisonJson(replay.rows[0].result.commands)
    ) throw new Error("Heartbeat command claim was not bounded, ordered, or replayable.");
    const other = await heartbeat(
      transitionPrincipal,
      concurrencyClaimToken("heartbeat-command-other"),
    );
    if (other.rows[0].result.commands.length !== 0) {
      throw new Error("A different heartbeat claim token stole an active command lease.");
    }
    const disconnect = commands[0];
    const start = {
      version: 1,
      runtimeCommandId: disconnectCommandId,
      commandKind: "DISCONNECT",
      claimGeneration: disconnect.claimGeneration,
      claimToken: firstToken,
      payloadHash: disconnect.payloadHash,
    };
    const started = await heartbeat(transitionPrincipal, firstToken, [start]);
    if (
      started.rows[0].result.commands[0].executionState !== "STARTED" ||
      !started.rows[0].result.commands[0].effectDeadlineAt
    ) throw new Error("Disconnect command was not durably STARTED before provider effect.");
    await database.exec(`
      set session_replication_role='replica';
      update public.openclaw_runtime_commands set lease_expires_at=statement_timestamp()-interval '1 second'
      where organization_id='${DEMO_ORG_ID}' and id='${disconnectCommandId}';
      set session_replication_role='origin';
    `);
    const notReclaimed = await heartbeat(
      transitionPrincipal,
      concurrencyClaimToken("heartbeat-command-started-other"),
    );
    if (notReclaimed.rows[0].result.commands.length !== 0) {
      throw new Error("A STARTED command was reclaimed by another token.");
    }
    const reconciled = await heartbeat(transitionPrincipal, firstToken);
    if (reconciled.rows[0].result.commands[0].executionState !== "STARTED") {
      throw new Error("The original token could not renew and reconcile STARTED work.");
    }
    const providerResult = {
      version: 1,
      revocationId,
      revokedSessionGeneration: 1,
      minimumSessionGeneration: 2,
      channel: "zalouser",
      accountId: "11111111-1111-4111-8111-111111111111",
      credentialsCleared: false,
      loggedOut: true,
      status: "PROVIDER_LOGGED_OUT",
    };
    const completion = {
      version: 1,
      runtimeCommandId: disconnectCommandId,
      commandKind: "DISCONNECT",
      claimGeneration: disconnect.claimGeneration,
      claimToken: firstToken,
      outcome: "PROVIDER_LOGGED_OUT",
      result: providerResult,
    };
    const completed = await heartbeat(transitionPrincipal, firstToken, [], [completion]);
    const completionReplay = await heartbeat(transitionPrincipal, firstToken, [], [completion]);
    const expectedResultHash = createHash("sha256")
      .update(canonicalComparisonJson(providerResult), "utf8").digest("hex");
    if (
      completed.rows[0].result.commands.length !== 0 ||
      completed.rows[0].result.commandResultAcks[0].resultHash !== expectedResultHash ||
      completed.rows[0].result.commandResultAcks[0].adoptSessionGeneration !== 2 ||
      canonicalComparisonJson(completed.rows[0].result.commandResultAcks) !==
        canonicalComparisonJson(completionReplay.rows[0].result.commandResultAcks)
    ) throw new Error("Provider result acknowledgement was not exact or replayable.");
    const beforeGatewayAck = await database.query(`
      select account.connection_state,
        revocation.acknowledgement_hash,revocation.acknowledged_at
      from public.openclaw_accounts account
      join public.openclaw_generation_revocations revocation
        on revocation.organization_id=account.organization_id and revocation.account_id=account.id
      where account.organization_id='${DEMO_ORG_ID}'
        and account.id='11111111-1111-4111-8111-111111111111'
        and revocation.id='${revocationId}'
    `);
    if (
      beforeGatewayAck.rows[0].connection_state !== "DISCONNECTING" ||
      beforeGatewayAck.rows[0].acknowledgement_hash !== null ||
      beforeGatewayAck.rows[0].acknowledged_at !== null
    ) throw new Error("Heartbeat forged Gateway acknowledgement or finalized disconnect early.");
    await database.query(`
      update public.openclaw_generation_revocations set
        acknowledgement_hash=repeat('f',64),acknowledged_at=statement_timestamp()
      where organization_id=$1 and id=$2
    `, [DEMO_ORG_ID, revocationId]);
    await database.query(
      `select app_private.openclaw_try_finalize_disconnect_v1($1,$2,$3) connection_state`,
      [DEMO_ORG_ID, "11111111-1111-4111-8111-111111111111", disconnectCommandId],
    );
    const finalized = await database.query(`
      select connection_state from public.openclaw_accounts
      where organization_id=$1 and id=$2
    `, [DEMO_ORG_ID, "11111111-1111-4111-8111-111111111111"]);
    if (finalized.rows[0].connection_state !== "DISCONNECTED") {
      throw new Error("Disconnect did not finalize after both independent durable evidences.");
    }
    const qrToken = concurrencyClaimToken("heartbeat-command-qr");
    const qrClaim = await heartbeat(normalPrincipal, qrToken);
    const qr = qrClaim.rows[0].result.commands[0];
    if (qr.runtimeCommandId !== qrCommandId || qr.executionState !== "LEASED") {
      throw new Error("Normal authority did not claim the QR command after session adoption.");
    }
    const qrStart = {
      version: 1,
      runtimeCommandId: qrCommandId,
      commandKind: "QR_LOGIN",
      claimGeneration: qr.claimGeneration,
      claimToken: qrToken,
      payloadHash: qr.payloadHash,
    };
    await database.exec(`
      set session_replication_role='replica';
      update public.openclaw_rollout_runs set stage='INFRASTRUCTURE'
      where organization_id='${DEMO_ORG_ID}'
        and id='99994000-0000-4000-8000-000000000001';
      set session_replication_role='origin';
    `);
    let startBlockedByRollout = false;
    try {
      await heartbeat(normalPrincipal, qrToken, [qrStart]);
    } catch (error) {
      startBlockedByRollout = /rollout stage/i.test(String(error?.message ?? error));
    }
    if (!startBlockedByRollout) {
      throw new Error("A QR command crossed into STARTED below WAITING_OWNER_QR rollout stage.");
    }
    await database.exec(`
      set session_replication_role='replica';
      update public.openclaw_rollout_runs set stage='COMPLETE'
      where organization_id='${DEMO_ORG_ID}'
        and id='99994000-0000-4000-8000-000000000001';
      set session_replication_role='origin';
    `);
    await heartbeat(normalPrincipal, qrToken, [qrStart]);
    const ciphertext = Buffer.from("qr-data-url", "utf8").toString("base64");
    const iv = Buffer.from("123456789012", "utf8").toString("base64");
    const tag = Buffer.from("1234567890123456", "utf8").toString("base64");
    const publishRequest = {
      version: 1,
      challengeId,
      runtimeCommandId: qrCommandId,
      claimGeneration: qr.claimGeneration,
      claimToken: qrToken,
      ciphertextB64: ciphertext,
      cipherIvB64: iv,
      authTagB64: tag,
    };
    const published = await database.query(
      `select app_private.openclaw_submit_qr_result_v1(
        $1::jsonb,'{}'::jsonb,$2::jsonb
      ) result`,
      [JSON.stringify(normalPrincipal), JSON.stringify(publishRequest)],
    );
    const publishReplay = await database.query(
      `select app_private.openclaw_submit_qr_result_v1(
        $1::jsonb,'{}'::jsonb,$2::jsonb
      ) result`,
      [JSON.stringify(normalPrincipal), JSON.stringify(publishRequest)],
    );
    if (
      published.rows[0].result.materialVersion !== 1 ||
      canonicalComparisonJson(published.rows[0].result) !==
        canonicalComparisonJson(publishReplay.rows[0].result)
    ) throw new Error("QR command publication was not claim-bound or replayable.");

    const insertQrCommand = async (commandId, commandKey) => {
      await database.query(`
        insert into public.openclaw_runtime_commands(
          id,organization_id,account_id,cell_id,command_key,command_kind,
          source_session_generation,target_session_generation,
          source_connection_generation,target_connection_generation,
          expected_session_generation,expected_connection_generation,expected_fencing_token,
          payload,payload_bytes,payload_hash
        ) select $1,$2,$3,$4,$5,'QR_LOGIN',2,2,1,1,2,1,1,payload.value,
          app_private.openclaw_jcs_bytes_v1(payload.value),
          encode(extensions.digest(app_private.openclaw_jcs_bytes_v1(payload.value),'sha256'),'hex')
        from (values (jsonb_build_object(
          'version',1,'challengeId',$6::uuid,'browserNonceHash',repeat('a',64)
        ))) payload(value)
      `, [
        commandId,
        DEMO_ORG_ID,
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
        commandKey,
        commandId,
      ]);
    };

    const failedCommandId = "dddd7100-0000-4000-8000-000000000005";
    await insertQrCommand(failedCommandId, "heartbeat:failed-before-start");
    const failedToken = concurrencyClaimToken("heartbeat-command-failed-before-start");
    const failedClaim = (await heartbeat(normalPrincipal, failedToken)).rows[0].result.commands[0];
    const failedResult = {
      version: 1,
      reasonCode: "PROVIDER_UNAVAILABLE",
      failureFingerprint: "1".repeat(64),
      status: "FAILED_BEFORE_START",
    };
    const failedCompletion = {
      version: 1,
      runtimeCommandId: failedCommandId,
      commandKind: "QR_LOGIN",
      claimGeneration: failedClaim.claimGeneration,
      claimToken: failedToken,
      outcome: "FAILED",
      result: failedResult,
    };
    const failed = await heartbeat(normalPrincipal, failedToken, [], [failedCompletion]);
    const failedReplay = await heartbeat(normalPrincipal, failedToken, [], [failedCompletion]);
    if (
      failed.rows[0].result.commandResultAcks[0].outcome !== "FAILED" ||
      failed.rows[0].result.commandResultAcks[0].adoptSessionGeneration !== null ||
      canonicalComparisonJson(failed.rows[0].result.commandResultAcks) !==
        canonicalComparisonJson(failedReplay.rows[0].result.commandResultAcks)
    ) throw new Error("A failed-before-start command was not sealed and replayed exactly.");

    const startedFailureId = "dddd7100-0000-4000-8000-000000000006";
    await insertQrCommand(startedFailureId, "heartbeat:started-failure");
    const startedFailureToken = concurrencyClaimToken("heartbeat-command-started-failure");
    const startedFailureClaim = (await heartbeat(normalPrincipal, startedFailureToken))
      .rows[0].result.commands[0];
    await heartbeat(normalPrincipal, startedFailureToken, [{
      version: 1,
      runtimeCommandId: startedFailureId,
      commandKind: "QR_LOGIN",
      claimGeneration: startedFailureClaim.claimGeneration,
      claimToken: startedFailureToken,
      payloadHash: startedFailureClaim.payloadHash,
    }]);
    let startedFailureRejected = false;
    try {
      await heartbeat(normalPrincipal, startedFailureToken, [], [{
        ...failedCompletion,
        runtimeCommandId: startedFailureId,
        claimGeneration: startedFailureClaim.claimGeneration,
        claimToken: startedFailureToken,
      }]);
    } catch (error) {
      startedFailureRejected = /started command cannot be failed/i.test(String(error?.message ?? error));
    }
    if (!startedFailureRejected) {
      throw new Error("A STARTED command accepted a pre-start failure result.");
    }

    const shortLeaseId = "dddd7100-0000-4000-8000-000000000007";
    await insertQrCommand(shortLeaseId, "heartbeat:short-effect-margin");
    const shortLeaseToken = concurrencyClaimToken("heartbeat-command-short-margin");
    const shortLeaseClaim = (await heartbeat(normalPrincipal, shortLeaseToken, [], [], 5))
      .rows[0].result.commands[0];
    let shortMarginRejected = false;
    try {
      await heartbeat(normalPrincipal, shortLeaseToken, [{
        version: 1,
        runtimeCommandId: shortLeaseId,
        commandKind: "QR_LOGIN",
        claimGeneration: shortLeaseClaim.claimGeneration,
        claimToken: shortLeaseToken,
        payloadHash: shortLeaseClaim.payloadHash,
      }], [], 5);
    } catch (error) {
      shortMarginRejected = /start ownership CAS failed|effect margin is insufficient/i.test(
        String(error?.message ?? error),
      );
    }
    if (!shortMarginRejected) {
      throw new Error("A runtime command started without the required effect margin.");
    }

    const gatewayFirstCommandId = "dddd7100-0000-4000-8000-000000000008";
    const gatewayFirstRevocationId = "dddd7100-0000-4000-8000-000000000009";
    await database.exec(`
      set session_replication_role='replica';
      update public.openclaw_accounts set session_generation=3,connection_generation=2,
        connection_state='DISCONNECTING',effective_mode='DRAFT_ONLY'
      where organization_id='${DEMO_ORG_ID}'
        and id='11111111-1111-4111-8111-111111111111';
      insert into public.openclaw_runtime_commands(
        id,organization_id,account_id,cell_id,command_key,command_kind,
        source_session_generation,target_session_generation,
        source_connection_generation,target_connection_generation,
        expected_session_generation,expected_connection_generation,expected_fencing_token,
        payload,payload_bytes,payload_hash,created_by
      ) select '${gatewayFirstCommandId}','${DEMO_ORG_ID}',
        '11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222',
        'heartbeat:gateway-first','DISCONNECT',2,3,1,2,3,1,1,payload.value,
        app_private.openclaw_jcs_bytes_v1(payload.value),
        encode(extensions.digest(app_private.openclaw_jcs_bytes_v1(payload.value),'sha256'),'hex'),
        '99999999-9999-4999-8999-999999999999'
      from (values (jsonb_build_object(
        'version',1,'reasonCode','ACCOUNT_DISCONNECT','revocationId','${gatewayFirstRevocationId}',
        'revokedSessionGeneration',2,'minimumSessionGeneration',3
      ))) payload(value);
      insert into public.openclaw_generation_revocations(
        id,organization_id,principal_kind,account_id,cell_id,revocation_kind,
        revoked_generation,minimum_valid_generation,command_id,reason_code
      ) values (
        '${gatewayFirstRevocationId}','${DEMO_ORG_ID}','CHANNEL',
        '11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222',
        'SESSION',2,3,'${gatewayFirstCommandId}','ACCOUNT_DISCONNECT'
      );
      set session_replication_role='origin';
    `);
    await database.query(
      `select public.openclaw_service_ack_disconnect_revocation_v1($1::uuid,$2::jsonb) result`,
      [
        "99999999-9999-4999-8999-999999999999",
        JSON.stringify({
          version: 1,
          organizationId: DEMO_ORG_ID,
          accountId: "11111111-1111-4111-8111-111111111111",
          revocationId: gatewayFirstRevocationId,
          minimumValidGeneration: 3,
          acknowledgementHash: "2".repeat(64),
        }),
      ],
    );
    const gatewayFirstPending = await database.query(`
      select connection_state from public.openclaw_accounts
      where organization_id=$1 and id=$2
    `, [DEMO_ORG_ID, "11111111-1111-4111-8111-111111111111"]);
    if (gatewayFirstPending.rows[0].connection_state !== "DISCONNECTING") {
      throw new Error("Gateway acknowledgement finalized a disconnect before provider evidence.");
    }
    const gatewayFirstPrincipal = {
      ...channelPrincipal(),
      sessionGeneration: 3,
      localSessionGeneration: 2,
      authMode: "COMMAND_TRANSITION",
    };
    const gatewayFirstToken = concurrencyClaimToken("heartbeat-command-gateway-first");
    const gatewayFirstClaim = (await heartbeat(gatewayFirstPrincipal, gatewayFirstToken))
      .rows[0].result.commands[0];
    await heartbeat(gatewayFirstPrincipal, gatewayFirstToken, [{
      version: 1,
      runtimeCommandId: gatewayFirstCommandId,
      commandKind: "DISCONNECT",
      claimGeneration: gatewayFirstClaim.claimGeneration,
      claimToken: gatewayFirstToken,
      payloadHash: gatewayFirstClaim.payloadHash,
    }]);
    await heartbeat(gatewayFirstPrincipal, gatewayFirstToken, [], [{
      version: 1,
      runtimeCommandId: gatewayFirstCommandId,
      commandKind: "DISCONNECT",
      claimGeneration: gatewayFirstClaim.claimGeneration,
      claimToken: gatewayFirstToken,
      outcome: "PROVIDER_LOGGED_OUT",
      result: {
        version: 1,
        revocationId: gatewayFirstRevocationId,
        revokedSessionGeneration: 2,
        minimumSessionGeneration: 3,
        channel: "zalouser",
        accountId: "11111111-1111-4111-8111-111111111111",
        credentialsCleared: false,
        loggedOut: true,
        status: "PROVIDER_LOGGED_OUT",
      },
    }]);
    const gatewayFirstFinalized = await database.query(`
      select connection_state from public.openclaw_accounts
      where organization_id=$1 and id=$2
    `, [DEMO_ORG_ID, "11111111-1111-4111-8111-111111111111"]);
    if (gatewayFirstFinalized.rows[0].connection_state !== "DISCONNECTED") {
      throw new Error("Gateway-first disconnect did not finalize after provider evidence.");
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
    const beforeForgery = await database.query(
      `select root.anchored_at,root.signature_hash,work.state
       from public.openclaw_audit_roots root
       join public.openclaw_maintenance_work_items work
         on work.organization_id=root.organization_id and work.source_id=root.id
       where root.id=$1`,
      [fixture.auditRootId],
    );
    const forged = {
      ...fixture.receipt,
      signatureHash: "0".repeat(64),
    };
    let rejected = false;
    try {
      await acknowledgeAuditAnchor(database, fixture, forged);
    } catch (error) {
      rejected = error?.code === "42501" || /receipt/i.test(String(error?.message ?? error));
    }
    const proof = await database.query(
      `select root.anchored_at,root.signature_hash,work.state
       from public.openclaw_audit_roots root
       join public.openclaw_maintenance_work_items work
         on work.organization_id=root.organization_id and work.source_id=root.id
       where root.id=$1`,
      [fixture.auditRootId],
    );
    if (
      !rejected ||
      JSON.stringify(proof.rows[0]) !== JSON.stringify(beforeForgery.rows[0])
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
  if (scenario === "RETENTION_AUTHORIZED_RECLAIM") {
    const ticket = await prepareRetentionDeleteTicket(database, 15);
    await database.exec(`
      set session_replication_role='replica';
      update public.openclaw_maintenance_work_items
      set recovery_lease_expires_at=statement_timestamp()-interval '1 second',
          updated_at=statement_timestamp()
      where organization_id='${DEMO_ORG_ID}' and id='${ticket.workItemId}';
      set session_replication_role='origin';
    `);
    const recoveryToken = concurrencyClaimToken("retention-authorized-recovery");
    const claimed = await database.query(
      `select app_private.openclaw_claim_work_item_v1(
        $1::jsonb,'{}'::jsonb,$2::jsonb
      ) result`,
      [
        JSON.stringify(maintenancePrincipal()),
        JSON.stringify({
          version: 1,
          claimToken: recoveryToken,
          limit: 1,
          leaseSeconds: 30,
          requestedKinds: ["RETENTION_DELETE"],
        }),
      ],
    );
    const recovery = claimed.rows[0].result.items[0];
    if (
      recovery?.recoveryKind !== "RETENTION_DELETE_AUTHORIZED" ||
      recovery.workItemId !== ticket.workItemId ||
      recovery.claimToken !== recoveryToken ||
      recovery.frozenClaim?.claimGeneration !== 1 ||
      recovery.ticketId !== ticket.ticketId ||
      recovery.gatewayReceipt !== null
    ) {
      throw new Error("DELETE_AUTHORIZED work was not reclaimed with exact frozen lineage.");
    }
    return;
  }
  if (scenario === "AUDIT_VERIFY_RECLAIM") {
    const fixture = await prepareAuditAnchorFixture(database, 23);
    const originalRequest = {
      version: 1,
      operation: "ANCHOR_VERIFY",
      workItemId: fixture.workItemId,
      claimGeneration: 1,
      claimToken: fixture.claimToken,
      auditRootId: fixture.auditRootId,
      rootHash: fixture.receipt.rootHash,
      anchorKey: fixture.receipt.anchorKey,
      signatureHash: fixture.receipt.signatureHash,
      auditSigningKeyGeneration: 1,
      auditSigningPublicKeyHash: "a".repeat(64),
      documentSha256: "b".repeat(64),
      documentByteLength: 128,
    };
    const original = await database.query(
      `select app_private.openclaw_issue_media_ticket_v1(
        $1::jsonb,'{}'::jsonb,$2::jsonb
      ) result`,
      [JSON.stringify(maintenancePrincipal()), JSON.stringify(originalRequest)],
    );
    await database.exec(`
      set session_replication_role='replica';
      update public.openclaw_maintenance_work_items
      set recovery_lease_expires_at=statement_timestamp()-interval '1 second',
          updated_at=statement_timestamp()
      where organization_id='${DEMO_ORG_ID}' and id='${fixture.workItemId}';
      set session_replication_role='origin';
    `);
    const recoveryToken = concurrencyClaimToken("audit-verify-recovery");
    const reclaimed = await database.query(
      `select app_private.openclaw_claim_work_item_v1(
        $1::jsonb,'{}'::jsonb,$2::jsonb
      ) result`,
      [
        JSON.stringify(maintenancePrincipal()),
        JSON.stringify({
          version: 1,
          claimToken: recoveryToken,
          limit: 1,
          leaseSeconds: 30,
          requestedKinds: ["AUDIT_ANCHOR"],
        }),
      ],
    );
    const result = reclaimed.rows[0].result.items[0];
    if (
      result.recoveryKind !== "AUDIT_VERIFY_AUTHORIZED" ||
      result.claimToken !== recoveryToken ||
      result.frozenClaim?.claimGeneration !== 1 ||
      result.verifyTicketId !== original.rows[0].result.ticketId ||
      result.verifyTicket?.jti !== original.rows[0].result.ticket.jti ||
      result.gatewayReceipt !== null
    ) {
      throw new Error("Audit recovery claim did not preserve original Gateway lineage.");
    }
    return;
  }
  if (scenario === "RETENTION_RECOVERY_REFRESH") {
    const ticket = await prepareRetentionDeleteTicket(database, 16);
    const before = await database.query(
      `select ticket_jti::text,delete_authorization_jti::text,expected_receipt_claims
       from public.openclaw_retention_delete_tickets
       where organization_id=$1 and id=$2`,
      [DEMO_ORG_ID, ticket.ticketId],
    );
    await new Promise((resolve) => setTimeout(resolve, 5_100));
    await database.exec(`
      set session_replication_role='replica';
      update public.openclaw_maintenance_work_items
      set recovery_lease_expires_at=statement_timestamp()-interval '1 second',
          updated_at=statement_timestamp()
      where organization_id='${DEMO_ORG_ID}' and id='${ticket.workItemId}';
      set session_replication_role='origin';
    `);
    const recoveryPrincipal = await prepareRotatedMaintenancePrincipal(database);
    const recoveryToken = concurrencyClaimToken("retention-refresh-recovery");
    const claimed = await database.query(
      `select app_private.openclaw_claim_work_item_v1(
        $1::jsonb,'{}'::jsonb,$2::jsonb
      ) result`,
      [
        JSON.stringify(recoveryPrincipal),
        JSON.stringify({
          version: 1,
          claimToken: recoveryToken,
          limit: 1,
          leaseSeconds: 30,
          requestedKinds: ["RETENTION_DELETE"],
        }),
      ],
    );
    const recovery = claimed.rows[0].result.items[0];
    const refreshRequest = {
      version: 1,
      recoveryKind: "RETENTION_DELETE_AUTHORIZED",
      workItemId: ticket.workItemId,
      recoveryGeneration: recovery.recoveryGeneration,
      claimToken: recoveryToken,
      ticketId: ticket.ticketId,
      expiredTicketJti: before.rows[0].ticket_jti,
      expiredDeleteAuthorizationJti: before.rows[0].delete_authorization_jti,
      gatewayDenial: { status: 410, code: "TICKET_EXPIRED_NO_WORK" },
    };
    const pointerBeforeRejection = await database.query(
      `select ticket_jti::text,delete_authorization_jti::text,
        (select count(*)::integer
         from public.openclaw_retention_delete_ticket_lineage lineage
         where lineage.organization_id=ticket.organization_id
           and lineage.logical_ticket_id=ticket.id) lineage_count
       from public.openclaw_retention_delete_tickets ticket
       where ticket.organization_id=$1 and ticket.id=$2`,
      [DEMO_ORG_ID, ticket.ticketId],
    );
    let wrongStatusRejected = false;
    try {
      await database.query(
        `select app_private.openclaw_authorize_retention_delete_v1(
          $1::jsonb,'{}'::jsonb,$2::jsonb
        ) result`,
        [
          JSON.stringify(recoveryPrincipal),
          JSON.stringify({
            ...refreshRequest,
            gatewayDenial: { status: 409, code: "TICKET_EXPIRED_NO_WORK" },
          }),
        ],
      );
    } catch (error) {
      wrongStatusRejected = error?.code === "22023";
    }
    let extraDenialKeyRejected = false;
    try {
      await database.query(
        `select app_private.openclaw_authorize_retention_delete_v1(
          $1::jsonb,'{}'::jsonb,$2::jsonb
        ) result`,
        [
          JSON.stringify(recoveryPrincipal),
          JSON.stringify({
            ...refreshRequest,
            gatewayDenial: {
              status: 410,
              code: "TICKET_EXPIRED_NO_WORK",
              detail: "not allowed",
            },
          }),
        ],
      );
    } catch (error) {
      extraDenialKeyRejected = error?.code === "22023";
    }
    const pointerAfterRejection = await database.query(
      `select ticket_jti::text,delete_authorization_jti::text,
        (select count(*)::integer
         from public.openclaw_retention_delete_ticket_lineage lineage
         where lineage.organization_id=ticket.organization_id
           and lineage.logical_ticket_id=ticket.id) lineage_count
       from public.openclaw_retention_delete_tickets ticket
       where ticket.organization_id=$1 and ticket.id=$2`,
      [DEMO_ORG_ID, ticket.ticketId],
    );
    if (
      !wrongStatusRejected ||
      !extraDenialKeyRejected ||
      JSON.stringify(pointerAfterRejection.rows[0]) !==
        JSON.stringify(pointerBeforeRejection.rows[0])
    ) {
      throw new Error("Invalid retention recovery evidence mutated authoritative lineage.");
    }
    const first = await database.query(
      `select app_private.openclaw_authorize_retention_delete_v1(
        $1::jsonb,'{}'::jsonb,$2::jsonb
      ) result`,
      [JSON.stringify(recoveryPrincipal), JSON.stringify(refreshRequest)],
    );
    const replay = await database.query(
      `select app_private.openclaw_authorize_retention_delete_v1(
        $1::jsonb,'{}'::jsonb,$2::jsonb
      ) result`,
      [JSON.stringify(recoveryPrincipal), JSON.stringify(refreshRequest)],
    );
    const refreshed = first.rows[0].result;
    const lineage = await database.query(
      `select count(*)::integer count,
        count(*) filter (where ticket_jti=$3::uuid)::integer old_ticket_rows,
        count(*) filter (where ticket_jti=$4::uuid)::integer new_ticket_rows
       from public.openclaw_retention_delete_ticket_lineage
       where organization_id=$1 and logical_ticket_id=$2`,
      [DEMO_ORG_ID, ticket.ticketId, refreshRequest.expiredTicketJti, refreshed.ticket.jti],
    );
    const expectedFrozenClaim = {
      maintenancePrincipalId: maintenancePrincipal().maintenancePrincipalId,
      credentialGeneration: maintenancePrincipal().credentialGeneration,
      leaseGeneration: maintenancePrincipal().leaseGeneration,
      fencingToken: maintenancePrincipal().fencingToken,
      claimGeneration: 1,
    };
    if (
      refreshed.state !== "RECOVERY_REFRESHED" ||
      refreshed.ticketId !== ticket.ticketId ||
      refreshed.replacesTicketJti !== refreshRequest.expiredTicketJti ||
      refreshed.replacesDeleteAuthorizationJti !== refreshRequest.expiredDeleteAuthorizationJti ||
      refreshed.ticket.jti === refreshRequest.expiredTicketJti ||
      refreshed.authorization.authorizationJti === refreshRequest.expiredDeleteAuthorizationJti ||
      refreshed.ticket.claimGeneration !== undefined ||
      refreshed.authorization.claimGeneration !== undefined ||
      refreshed.ticket.maintenancePrincipalId !== recoveryPrincipal.maintenancePrincipalId ||
      refreshed.ticket.credentialGeneration !== recoveryPrincipal.credentialGeneration ||
      refreshed.ticket.leaseGeneration !== recoveryPrincipal.leaseGeneration ||
      refreshed.ticket.fencingToken !== recoveryPrincipal.fencingToken ||
      refreshed.ticket.workItemId !== ticket.workItemId ||
      refreshed.authorization.maintenancePrincipalId !== recoveryPrincipal.maintenancePrincipalId ||
      refreshed.authorization.credentialGeneration !== recoveryPrincipal.credentialGeneration ||
      refreshed.authorization.leaseGeneration !== recoveryPrincipal.leaseGeneration ||
      refreshed.authorization.fencingToken !== recoveryPrincipal.fencingToken ||
      refreshed.authorization.workItemId !== ticket.workItemId ||
      refreshed.ticket.recoveryKind !== "RETENTION_DELETE_AUTHORIZED" ||
      refreshed.authorization.recoveryGeneration !== recovery.recoveryGeneration ||
      canonicalComparisonJson(refreshed.ticket.frozenClaim) !==
        canonicalComparisonJson(expectedFrozenClaim) ||
      canonicalComparisonJson(refreshed.authorization.frozenClaim) !==
        canonicalComparisonJson(expectedFrozenClaim) ||
      JSON.stringify(first.rows[0].result) !== JSON.stringify(replay.rows[0].result) ||
      lineage.rows[0].count !== 2 || lineage.rows[0].old_ticket_rows !== 1 ||
      lineage.rows[0].new_ticket_rows !== 1
    ) {
      throw new Error("Retention recovery refresh did not rotate and preserve exact lineage.");
    }
    const oldReceipt = retentionReceipt({
      ...ticket,
      expectedReceiptClaims: before.rows[0].expected_receipt_claims,
    }, "DELETED");
    const completionRequest = {
      version: 1,
      recoveryKind: "RETENTION_DELETE_AUTHORIZED",
      workItemId: ticket.workItemId,
      recoveryGeneration: recovery.recoveryGeneration,
      claimToken: recoveryToken,
      ticketId: ticket.ticketId,
      gatewayReceipt: oldReceipt,
    };
    const completed = await database.query(
      `select app_private.openclaw_finalize_retention_delete_v1(
        $1::jsonb,'{}'::jsonb,$2::jsonb
      ) result`,
      [JSON.stringify(recoveryPrincipal), JSON.stringify(completionRequest)],
    );
    const refreshAfterTerminal = await database.query(
      `select app_private.openclaw_authorize_retention_delete_v1(
        $1::jsonb,'{}'::jsonb,$2::jsonb
      ) result`,
      [JSON.stringify(recoveryPrincipal), JSON.stringify(refreshRequest)],
    );
    const completedReplay = await database.query(
      `select app_private.openclaw_finalize_retention_delete_v1(
        $1::jsonb,'{}'::jsonb,$2::jsonb
      ) result`,
      [JSON.stringify(recoveryPrincipal), JSON.stringify(completionRequest)],
    );
    if (
      completed.rows[0].result.idempotentReplay !== false ||
      completedReplay.rows[0].result.idempotentReplay !== true ||
      canonicalComparisonJson(refreshAfterTerminal.rows[0].result) !==
        canonicalComparisonJson(first.rows[0].result)
    ) {
      throw new Error("Late old retention receipt was not terminally replayable.");
    }
    return;
  }
  if (scenario === "AUDIT_RECOVERY_REFRESH") {
    const fixture = await prepareAuditAnchorFixture(database, 24);
    const oldTicket = await database.query(
      `select ticket_payload from public.openclaw_audit_gateway_tickets
       where organization_id=$1 and ticket_jti=$2`,
      [DEMO_ORG_ID, fixture.verifyTicketJti],
    );
    await database.exec(`
      set session_replication_role='replica';
      with expired as (
        select ticket.id,
          jsonb_set(jsonb_set(ticket.ticket_payload,'{iat}',to_jsonb(
            extract(epoch from date_trunc('second',statement_timestamp()-interval '2 minutes'))::bigint
          )),'{exp}',to_jsonb(
            extract(epoch from date_trunc('second',statement_timestamp()-interval '1 minute'))::bigint
          )) payload
        from public.openclaw_audit_gateway_tickets ticket
        where ticket.organization_id='${DEMO_ORG_ID}'
          and ticket.ticket_jti='${fixture.verifyTicketJti}'
      ), canonical as (
        select expired.*,app_private.openclaw_jcs_bytes_v1(expired.payload) bytes
        from expired
      )
      update public.openclaw_audit_gateway_tickets ticket
      set issued_at=date_trunc('second',statement_timestamp()-interval '2 minutes'),
          expires_at=date_trunc('second',statement_timestamp()-interval '1 minute'),
          ticket_payload=canonical.payload,ticket_bytes=canonical.bytes,
          ticket_hash=encode(extensions.digest(
            convert_to('ihome-openclaw-media-ticket-v1','UTF8')||decode('00','hex')
              ||canonical.bytes,'sha256'),'hex')
      from canonical where ticket.id=canonical.id;
      update public.openclaw_maintenance_work_items
      set recovery_lease_expires_at=statement_timestamp()-interval '1 second',
          updated_at=statement_timestamp()
      where organization_id='${DEMO_ORG_ID}' and id='${fixture.workItemId}';
      set session_replication_role='origin';
    `);
    const recoveryPrincipal = await prepareRotatedMaintenancePrincipal(database);
    const recoveryToken = concurrencyClaimToken("audit-refresh-recovery");
    const claimed = await database.query(
      `select app_private.openclaw_claim_work_item_v1(
        $1::jsonb,'{}'::jsonb,$2::jsonb
      ) result`,
      [
        JSON.stringify(recoveryPrincipal),
        JSON.stringify({
          version: 1,
          claimToken: recoveryToken,
          limit: 1,
          leaseSeconds: 30,
          requestedKinds: ["AUDIT_ANCHOR"],
        }),
      ],
    );
    const recovery = claimed.rows[0].result.items[0];
    const old = oldTicket.rows[0].ticket_payload;
    const refreshRequest = {
      version: 1,
      operation: "ANCHOR_VERIFY",
      recoveryKind: "AUDIT_VERIFY_AUTHORIZED",
      workItemId: fixture.workItemId,
      recoveryGeneration: recovery.recoveryGeneration,
      claimToken: recoveryToken,
      expiredVerifyTicketJti: fixture.verifyTicketJti,
      gatewayDenial: { status: 410, code: "TICKET_EXPIRED_NO_WORK" },
      auditRootId: fixture.auditRootId,
      rootHash: fixture.receipt.rootHash,
      anchorKey: fixture.receipt.anchorKey,
      signatureHash: fixture.receipt.signatureHash,
      auditSigningKeyGeneration: 1,
      auditSigningPublicKeyHash: "a".repeat(64),
      documentSha256: old.sha256,
      documentByteLength: old.contentLength,
    };
    const lineageBeforeRejection = await database.query(
      `select count(*)::integer count,
        count(*) filter (where is_authoritative)::integer authoritative,
        max(ticket_jti::text) filter (where is_authoritative) authoritative_ticket_jti
       from public.openclaw_audit_gateway_tickets
       where organization_id=$1 and work_item_id=$2`,
      [DEMO_ORG_ID, fixture.workItemId],
    );
    let wrongStatusRejected = false;
    try {
      await database.query(
        `select app_private.openclaw_issue_media_ticket_v1(
          $1::jsonb,'{}'::jsonb,$2::jsonb
        ) result`,
        [
          JSON.stringify(recoveryPrincipal),
          JSON.stringify({
            ...refreshRequest,
            gatewayDenial: { status: 409, code: "TICKET_EXPIRED_NO_WORK" },
          }),
        ],
      );
    } catch (error) {
      wrongStatusRejected = error?.code === "22023";
    }
    let extraDenialKeyRejected = false;
    try {
      await database.query(
        `select app_private.openclaw_issue_media_ticket_v1(
          $1::jsonb,'{}'::jsonb,$2::jsonb
        ) result`,
        [
          JSON.stringify(recoveryPrincipal),
          JSON.stringify({
            ...refreshRequest,
            gatewayDenial: {
              status: 410,
              code: "TICKET_EXPIRED_NO_WORK",
              detail: "not allowed",
            },
          }),
        ],
      );
    } catch (error) {
      extraDenialKeyRejected = error?.code === "22023";
    }
    const lineageAfterRejection = await database.query(
      `select count(*)::integer count,
        count(*) filter (where is_authoritative)::integer authoritative,
        max(ticket_jti::text) filter (where is_authoritative) authoritative_ticket_jti
       from public.openclaw_audit_gateway_tickets
       where organization_id=$1 and work_item_id=$2`,
      [DEMO_ORG_ID, fixture.workItemId],
    );
    if (
      !wrongStatusRejected ||
      !extraDenialKeyRejected ||
      JSON.stringify(lineageAfterRejection.rows[0]) !==
        JSON.stringify(lineageBeforeRejection.rows[0])
    ) {
      throw new Error("Invalid audit recovery evidence mutated authoritative lineage.");
    }
    const first = await database.query(
      `select app_private.openclaw_issue_media_ticket_v1(
        $1::jsonb,'{}'::jsonb,$2::jsonb
      ) result`,
      [JSON.stringify(recoveryPrincipal), JSON.stringify(refreshRequest)],
    );
    const replay = await database.query(
      `select app_private.openclaw_issue_media_ticket_v1(
        $1::jsonb,'{}'::jsonb,$2::jsonb
      ) result`,
      [JSON.stringify(recoveryPrincipal), JSON.stringify(refreshRequest)],
    );
    const refreshed = first.rows[0].result;
    const lineage = await database.query(
      `select count(*)::integer count,
        count(*) filter (where is_authoritative)::integer authoritative,
        count(*) filter (where ticket_jti=$3::uuid and not is_authoritative)::integer old_rows
       from public.openclaw_audit_gateway_tickets
       where organization_id=$1 and work_item_id=$2`,
      [DEMO_ORG_ID, fixture.workItemId, fixture.verifyTicketJti],
    );
    const expectedFrozenClaim = {
      maintenancePrincipalId: maintenancePrincipal().maintenancePrincipalId,
      credentialGeneration: maintenancePrincipal().credentialGeneration,
      leaseGeneration: maintenancePrincipal().leaseGeneration,
      fencingToken: maintenancePrincipal().fencingToken,
      claimGeneration: 1,
    };
    if (
      refreshed.state !== "RECOVERY_REFRESHED" ||
      refreshed.replacesVerifyTicketJti !== fixture.verifyTicketJti ||
      refreshed.ticketId === fixture.verifyTicketJti ||
      refreshed.ticket.claimGeneration !== undefined ||
      refreshed.ticket.maintenancePrincipalId !== recoveryPrincipal.maintenancePrincipalId ||
      refreshed.ticket.credentialGeneration !== recoveryPrincipal.credentialGeneration ||
      refreshed.ticket.leaseGeneration !== recoveryPrincipal.leaseGeneration ||
      refreshed.ticket.fencingToken !== recoveryPrincipal.fencingToken ||
      refreshed.ticket.workItemId !== fixture.workItemId ||
      refreshed.ticket.recoveryKind !== "AUDIT_VERIFY_AUTHORIZED" ||
      refreshed.ticket.recoveryGeneration !== recovery.recoveryGeneration ||
      canonicalComparisonJson(refreshed.ticket.frozenClaim) !==
        canonicalComparisonJson(expectedFrozenClaim) ||
      JSON.stringify(first.rows[0].result) !== JSON.stringify(replay.rows[0].result) ||
      lineage.rows[0].count !== 2 || lineage.rows[0].authoritative !== 1 ||
      lineage.rows[0].old_rows !== 1
    ) {
      throw new Error("Audit recovery refresh did not rotate and preserve exact lineage.");
    }
    const completionRequest = {
      version: 1,
      recoveryKind: "AUDIT_VERIFY_AUTHORIZED",
      workItemId: fixture.workItemId,
      recoveryGeneration: recovery.recoveryGeneration,
      claimToken: recoveryToken,
      verifyTicketJti: fixture.verifyTicketJti,
      gatewayReceipt: fixture.receipt,
    };
    let forgedSignatureRejected = false;
    try {
      await database.query(
        `select app_private.openclaw_ack_audit_anchor_v1(
          $1::jsonb,'{}'::jsonb,$2::jsonb
        ) result`,
        [JSON.stringify(recoveryPrincipal), JSON.stringify({
          ...completionRequest,
          gatewayReceipt: {
            ...fixture.receipt,
            signatureHash: "0".repeat(64),
          },
        })],
      );
    } catch (error) {
      forgedSignatureRejected = error?.code === "42501";
    }
    const stateAfterForgery = await database.query(
      `select root.anchored_at,work.state
       from public.openclaw_audit_roots root
       join public.openclaw_maintenance_work_items work
         on work.organization_id=root.organization_id and work.source_id=root.id
       where root.id=$1`,
      [fixture.auditRootId],
    );
    if (
      !forgedSignatureRejected ||
      stateAfterForgery.rows[0].anchored_at !== null ||
      stateAfterForgery.rows[0].state !== "AUDIT_VERIFY_AUTHORIZED"
    ) {
      throw new Error("A forged recovery audit signature hash changed terminal state.");
    }
    const completed = await database.query(
      `select app_private.openclaw_ack_audit_anchor_v1(
        $1::jsonb,'{}'::jsonb,$2::jsonb
      ) result`,
      [JSON.stringify(recoveryPrincipal), JSON.stringify(completionRequest)],
    );
    const refreshAfterTerminal = await database.query(
      `select app_private.openclaw_issue_media_ticket_v1(
        $1::jsonb,'{}'::jsonb,$2::jsonb
      ) result`,
      [JSON.stringify(recoveryPrincipal), JSON.stringify(refreshRequest)],
    );
    const completedReplay = await database.query(
      `select app_private.openclaw_ack_audit_anchor_v1(
        $1::jsonb,'{}'::jsonb,$2::jsonb
      ) result`,
      [JSON.stringify(recoveryPrincipal), JSON.stringify(completionRequest)],
    );
    if (
      completed.rows[0].result.idempotentReplay !== false ||
      completedReplay.rows[0].result.idempotentReplay !== true ||
      canonicalComparisonJson(refreshAfterTerminal.rows[0].result) !==
        canonicalComparisonJson(first.rows[0].result)
    ) {
      throw new Error("Late old audit receipt was not terminally replayable.");
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
