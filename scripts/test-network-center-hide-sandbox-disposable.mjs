#!/usr/bin/env node
// Disposable PostgreSQL proof for
// supabase/migrations/20260729142000_network_center_hide_sandbox_policies.sql.
//
// WHAT IS UNDER TEST
// The org SANDBOX (`cccc0000-…0001`, the TEST clone of the real company's
// books) must never surface on the real company owner's screen. That boundary
// is enforced by a RESTRICTIVE `<table>_hide_sandbox_admin` policy on every
// public relation that has `organization_id` and RLS. Five Network Center
// tables were created after the one-shot sweeps that installed those policies
// and were therefore never covered. This proof runs the REAL migration file, on
// a real PostgreSQL 17 cluster, against the REAL table definitions, and asserts
// both halves of the contract CLAUDE.md states:
//
//   * a row of org TEST must NOT be visible to a real-org (super admin) reader;
//   * a row with `organization_id IS NULL` must STILL be visible — the
//     `NULL = ANY(...)` trap that 20260801040000 had to repair after it silently
//     erased the real company's own rows.
//
// Every assertion runs inside ONE transaction that ends in ROLLBACK, on a
// cluster created in TEMP, bound to 127.0.0.1 on an ephemeral port, torn down
// with verified evidence by the shared harness. No production credential, no
// Docker, no remote host, nothing written anywhere that survives the run.
//
// The invariant count is COUNTED BY THE SQL ITSELF (one row per named
// assertion, primary-keyed so a copy-pasted name cannot inflate it).
//
// NON-VACUITY IS CHECKED ON EVERY RUN, not just by hand: after the verdict is
// emitted the script drops the two policies under test and re-probes, and the
// runner REFUSES a PASS unless the sandbox rows reappear. A migration that
// silently created nothing therefore fails here instead of shipping.
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { runDisposableLocalClusterMatrix } from "./network-center-disposable-db.mjs";

export const HIDE_SANDBOX_MIGRATION_PATH = fileURLToPath(
  new URL(
    "../supabase/migrations/20260729142000_network_center_hide_sandbox_policies.sql",
    import.meta.url,
  ),
);

/** Raise together with the SQL whenever an invariant is added. */
export const HIDE_SANDBOX_PROOF_INVARIANTS = 36;

const REAL_ORG_ID = "aaaa0000-0000-4000-8000-000000000001";
const SANDBOX_ORG_ID = "cccc0000-0000-4000-8000-000000000001";
const REAL_BUILDING_ID = "aaaa1000-0000-4000-8000-000000000001";
const SANDBOX_BUILDING_ID = "cccc1000-0000-4000-8000-000000000001";
// Seeded into auth.users by the shared disposable seed. The first is the real
// company's owner and is made a super admin here, which is exactly the
// principal the sandbox policies exist to constrain; the second is an ordinary
// tenant used as the "legitimate access is unchanged" control.
const SUPER_ADMIN_ID = "90450d5f-29b6-4897-bdef-cdb5fb53f339";
const ORDINARY_USER_ID = "de6f33f3-349f-4bec-bd3d-106192f6715e";

/** The five tables the migration exists for. */
export const HIDE_SANDBOX_TARGET_TABLES = Object.freeze([
  "network_command_observations",
  "network_managed_resources",
  "network_org_mutation_gates",
  "network_worker_assignments",
  "network_worker_building_status",
]);

/**
 * The only one of the five that role `authenticated` can reach today: it has
 * `GRANT SELECT … TO authenticated` and a PERMISSIVE policy that short-circuits
 * on is_super_admin(). The other four are revoked and policy-less, so they are
 * defence in depth rather than a live leak — asserted below rather than assumed.
 */
export const HIDE_SANDBOX_REACHABLE_TABLE = "network_worker_building_status";

export function buildHideSandboxSql({ localProof } = {}) {
  const nonce = String(localProof?.proofNonce ?? "");
  if (!/^[a-f0-9]{32}$/.test(nonce)) {
    throw new Error(
      "Hide-sandbox proof requires the disposable cluster proof nonce",
    );
  }
  return String.raw`
SET TIME ZONE 'UTC';
BEGIN;

-- Bind the run to the cluster it was built for. Without this the proof could be
-- pointed at any database and would still report PASS.
DO $bind$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM app_private.network_center_disposable_proof
    WHERE proof_nonce = '${nonce}'
  ) THEN
    RAISE EXCEPTION 'Hide-sandbox proof is not running on its own disposable cluster';
  END IF;
END;
$bind$;

CREATE TEMP TABLE ncs_results (
  name text PRIMARY KEY,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
) ON COMMIT DROP;

CREATE FUNCTION pg_temp.ncs_assert(
  p_name text, p_condition boolean, p_detail text DEFAULT ''
) RETURNS void LANGUAGE plpgsql AS $assert$
BEGIN
  IF p_condition IS NOT TRUE THEN
    RAISE EXCEPTION 'HIDE-SANDBOX PROOF FAILED [%]: %', p_name, p_detail;
  END IF;
  INSERT INTO pg_temp.ncs_results (name) VALUES (p_name);
END;
$assert$;

-- Probe sink. A REGULAR table, not a temp one: role authenticated has USAGE on
-- public but not on this session's pg_temp schema, and every measurement below
-- is taken while acting as authenticated. The whole transaction rolls back.
CREATE TABLE public.ncs_probe (
  name text PRIMARY KEY,
  visible_count integer NOT NULL,
  visible_orgs text
);
GRANT INSERT, SELECT ON public.ncs_probe TO authenticated, service_role;

-- ===========================================================================
-- Part 0 — principals. The real company's owner is a super admin; that is the
-- only reason sandbox rows are visible to them at all, so every probe below
-- depends on this row existing first.
-- ===========================================================================
INSERT INTO public.organizations (id, slug, name, status, is_demo, created_by)
VALUES ('${SANDBOX_ORG_ID}', 'ihome-test', 'iHome CRM (Test)', 'ACTIVE', false, '${SUPER_ADMIN_ID}')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.super_admins (user_id, note)
VALUES ('${SUPER_ADMIN_ID}', 'disposable hide-sandbox proof')
ON CONFLICT (user_id) DO NOTHING;

-- ===========================================================================
-- Part 1 — catalog invariants: the migration actually installed the reviewed
-- policy on all five tables, and left the gap nowhere else.
-- ===========================================================================
DO $catalog$
DECLARE
  v_tbl text;
  v_uncovered text;
BEGIN
  FOREACH v_tbl IN ARRAY ARRAY[
    'network_command_observations',
    'network_managed_resources',
    'network_org_mutation_gates',
    'network_worker_assignments',
    'network_worker_building_status'
  ] LOOP
    PERFORM pg_temp.ncs_assert(
      v_tbl || '-carries-the-reviewed-hide-sandbox-policy',
      EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = v_tbl
          AND policyname = v_tbl || '_hide_sandbox_admin'
          AND permissive = 'RESTRICTIVE'
          AND cmd = 'SELECT'
          AND roles = ARRAY['authenticated']::name[]
      ),
      'no RESTRICTIVE/SELECT/authenticated hide_sandbox policy on ' || v_tbl
    );

    -- The COALESCE guard is the whole point of 20260801040000: without it a row
    -- whose organization_id IS NULL evaluates to NULL, RLS reads NULL as "not
    -- permitted", and the real company's own rows disappear.
    PERFORM pg_temp.ncs_assert(
      v_tbl || '-predicate-wraps-the-coalesce-guard',
      EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public'
          AND policyname = v_tbl || '_hide_sandbox_admin'
          AND qual LIKE '%COALESCE%'
          AND qual LIKE '%sandbox_org_ids()%'
          AND qual LIKE '%is_super_admin%'
      ),
      'hide_sandbox predicate on ' || v_tbl || ' is not the guarded shape'
    );

    -- organization_id NOT NULL on all five means the NULL trap cannot fire on
    -- these tables specifically. Asserted rather than assumed, because a later
    -- migration relaxing it would silently move them into the trap's range.
    PERFORM pg_temp.ncs_assert(
      v_tbl || '-declares-organization-id-not-null',
      (SELECT attnotnull FROM pg_attribute
       WHERE attrelid = ('public.' || v_tbl)::regclass AND attname = 'organization_id'),
      'organization_id became nullable on ' || v_tbl
    );
  END LOOP;

  -- Re-run the production sweep inside the proof: no non-partition relation
  -- with organization_id and RLS may be left without the policy.
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname)
  INTO v_uncovered
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r', 'p')
    AND NOT c.relispartition
    AND c.relrowsecurity
    AND c.relname <> 'ncs_probe'
    AND EXISTS (
      SELECT 1 FROM pg_attribute a
      WHERE a.attrelid = c.oid AND a.attname = 'organization_id'
        AND a.attnum > 0 AND NOT a.attisdropped
    )
    AND NOT EXISTS (
      SELECT 1 FROM pg_policy p
      WHERE p.polrelid = c.oid AND p.polname = c.relname || '_hide_sandbox_admin'
    );
  PERFORM pg_temp.ncs_assert(
    'no-relation-with-org-and-rls-is-left-uncovered',
    v_uncovered IS NULL,
    'still uncovered: ' || coalesce(v_uncovered, '')
  );

  PERFORM pg_temp.ncs_assert(
    'every-hide-sandbox-policy-shares-one-reviewed-shape',
    NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public'
        AND policyname LIKE '%\_hide\_sandbox\_admin'
        AND (permissive <> 'RESTRICTIVE'
          OR cmd <> 'SELECT'
          OR roles <> ARRAY['authenticated']::name[]
          OR qual NOT LIKE '%COALESCE%')
    ),
    'a hide_sandbox policy deviates from the reviewed shape'
  );
END;
$catalog$;

-- ===========================================================================
-- Part 2 — the daily raw-telemetry partitions. A naive sweep flags all of them
-- as "missing the policy". Measure what actually happens instead of assuming
-- the policy is inherited, because if it were NOT safe, every partition created
-- daily by ensure_raw_partitions_v1 would need one of its own.
-- ===========================================================================
DO $partitions$
DECLARE
  v_day date := (clock_timestamp() AT TIME ZONE 'UTC')::date;
  v_partition text;
  v_direct integer;
  v_via_parent integer;
  v_offenders text;
BEGIN
  PERFORM app_private.network_center_ensure_raw_partitions_v1(v_day, v_day);
  v_partition := 'network_device_samples_' || to_char(v_day, 'YYYYMMDD');

  PERFORM pg_temp.ncs_assert(
    'discovery-rule-never-targets-a-partition',
    NOT EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_policy p ON p.polrelid = c.oid
      WHERE n.nspname = 'public' AND c.relispartition
        AND p.polname LIKE '%\_hide\_sandbox\_admin'
    ),
    'the migration put a hide_sandbox policy on a partition'
  );

  -- Every partition is born deny-all AND unprivileged: two independent locks,
  -- installed by ensure_raw_partitions_v1 itself.
  SELECT string_agg(
    c.relname || '(rls=' || c.relrowsecurity
      || ',auth=' || has_table_privilege('authenticated', c.oid, 'SELECT')
      || ',anon=' || has_table_privilege('anon', c.oid, 'SELECT')
      || ',svc=' || has_table_privilege('service_role', c.oid, 'SELECT')
      || ',acl=' || coalesce(c.relacl::text, 'null') || ')',
    ', ' ORDER BY c.relname
  )
  INTO v_offenders
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relispartition
    AND c.relkind = 'r'
    AND c.relname LIKE 'network\_%\_samples\_%'
    AND (NOT c.relrowsecurity
      OR has_table_privilege('authenticated', c.oid, 'SELECT')
      OR has_table_privilege('anon', c.oid, 'SELECT')
      OR has_table_privilege('service_role', c.oid, 'SELECT'));
  PERFORM pg_temp.ncs_assert(
    'every-raw-partition-is-born-deny-all-and-unprivileged',
    v_offenders IS NULL,
    'raw sample partitions readable or with RLS off: ' || coalesce(v_offenders, '')
  );

  -- Now the measurement itself. Open the parent AND one partition to
  -- authenticated, seed one real-org and one sandbox row, and read both ways.
  SET LOCAL session_replication_role = 'replica';
  INSERT INTO public.network_device_samples (
    organization_id, building_id, device_id, observed_at, reachable, sample
  ) VALUES
    ('${REAL_ORG_ID}', '${REAL_BUILDING_ID}', gen_random_uuid(),
     v_day + interval '10 hours', true, '{}'::jsonb),
    ('${SANDBOX_ORG_ID}', '${SANDBOX_BUILDING_ID}', gen_random_uuid(),
     v_day + interval '11 hours', true, '{}'::jsonb);
  SET LOCAL session_replication_role = 'origin';

  EXECUTE 'GRANT SELECT ON public.network_device_samples TO authenticated';
  EXECUTE format('GRANT SELECT ON public.%I TO authenticated', v_partition);
  EXECUTE 'CREATE POLICY ncs_samples_read ON public.network_device_samples '
       || 'FOR SELECT TO authenticated USING (true)';

  PERFORM set_config('request.jwt.claim.sub', '${SUPER_ADMIN_ID}', true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_via_parent FROM public.network_device_samples;
  EXECUTE format('SELECT count(*) FROM public.%I', v_partition) INTO v_direct;
  RESET ROLE;

  -- Through the parent the RESTRICTIVE policy DOES gate rows stored in the
  -- partition: the sandbox row is hidden, the real-org row is not.
  PERFORM pg_temp.ncs_assert(
    'parent-policy-gates-partition-rows-read-through-the-parent',
    v_via_parent = 1,
    'rows visible through the parent: ' || v_via_parent
  );

  -- Naming the partition directly, the parent policy does NOT apply — the
  -- partition's own RLS (enabled, zero policies) is what refuses the read. So
  -- "policies live on the parent" is only half true, and the partitions are
  -- safe because ensure_raw_partitions_v1 makes them deny-all, not because they
  -- inherit anything.
  PERFORM pg_temp.ncs_assert(
    'directly-named-partition-is-refused-by-its-own-rls-not-by-inheritance',
    v_direct = 0,
    'rows visible naming the partition directly: ' || v_direct
  );
END;
$partitions$;

-- ===========================================================================
-- Part 3 — fixtures for the row-level proof.
-- Referential integrity is irrelevant to a row-VISIBILITY proof, so the seed
-- runs with triggers and foreign keys suspended; CHECK constraints and NOT NULL
-- still apply, and enforcement is restored before any probe is taken.
-- ===========================================================================
DO $seed$
BEGIN
  SET LOCAL session_replication_role = 'replica';

  INSERT INTO public.buildings (
    id, user_id, organization_id, name, code, province, district, ward,
    total_floors, total_rooms, is_virtual
  ) VALUES (
    '${SANDBOX_BUILDING_ID}', '${SUPER_ADMIN_ID}', '${SANDBOX_ORG_ID}',
    'TEST-CLONE-BUILDING', 'TEST-CLONE', 'Local', 'Local', 'Local', 1, 1, false
  ) ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.network_worker_building_status (
    organization_id, building_id, status, heartbeat_at, started_at
  ) VALUES
    ('${REAL_ORG_ID}', '${REAL_BUILDING_ID}', 'ONLINE', clock_timestamp(), clock_timestamp()),
    ('${SANDBOX_ORG_ID}', '${SANDBOX_BUILDING_ID}', 'ONLINE', clock_timestamp(), clock_timestamp());

  INSERT INTO public.network_worker_assignments (
    worker_id, organization_id, building_id, device_id, active_from
  ) VALUES
    (gen_random_uuid(), '${REAL_ORG_ID}', '${REAL_BUILDING_ID}', gen_random_uuid(), clock_timestamp()),
    (gen_random_uuid(), '${SANDBOX_ORG_ID}', '${SANDBOX_BUILDING_ID}', gen_random_uuid(), clock_timestamp());

  INSERT INTO public.network_managed_resources (
    organization_id, building_id, device_id, resource_kind, stable_key,
    display_name, ownership_marker
  ) VALUES
    ('${REAL_ORG_ID}', '${REAL_BUILDING_ID}', gen_random_uuid(), 'ROUTER', 'router-real', 'Real Router', 'ihomecrm-network-center:v1:realrouter'),
    ('${SANDBOX_ORG_ID}', '${SANDBOX_BUILDING_ID}', gen_random_uuid(), 'ROUTER', 'router-test', 'Test Router', 'ihomecrm-network-center:v1:testrouter');

  INSERT INTO public.network_command_observations (
    id, organization_id, building_id, command_id, attempt_id, device_id,
    attempt_no, lease_token, fencing_generation, transition_version_before,
    observation_kind, evidence, evidence_hash, observed_at, worker_id
  ) VALUES
    (gen_random_uuid(), '${REAL_ORG_ID}', '${REAL_BUILDING_ID}', gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
     1, gen_random_uuid(), 1, 1, 'POST_ACTION', '{}'::jsonb, repeat('a', 64), clock_timestamp(), 'worker-real'),
    (gen_random_uuid(), '${SANDBOX_ORG_ID}', '${SANDBOX_BUILDING_ID}', gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
     1, gen_random_uuid(), 1, 1, 'POST_ACTION', '{}'::jsonb, repeat('b', 64), clock_timestamp(), 'worker-test');

  -- The fleet kill switch, engaged for the SANDBOX org. If hiding sandbox rows
  -- broke the gate, this row would stop being readable by the guard.
  INSERT INTO public.network_org_mutation_gates (
    organization_id, mutations_paused, paused_reason, paused_at, paused_by
  ) VALUES
    ('${REAL_ORG_ID}', false, NULL, NULL, NULL),
    ('${SANDBOX_ORG_ID}', true, 'disposable proof kill switch', clock_timestamp(), '${SUPER_ADMIN_ID}');

  SET LOCAL session_replication_role = 'origin';
END;
$seed$;

-- ===========================================================================
-- Part 4 — today's reachability, measured rather than asserted from memory.
-- ===========================================================================
DO $reachability$
DECLARE
  v_tbl text;
BEGIN
  PERFORM pg_temp.ncs_assert(
    'worker-building-status-is-the-one-table-authenticated-can-reach',
    has_table_privilege('authenticated', 'public.${HIDE_SANDBOX_REACHABLE_TABLE}', 'SELECT'),
    'the reachable table lost its GRANT; the leak surface moved'
  );

  FOREACH v_tbl IN ARRAY ARRAY[
    'network_command_observations',
    'network_managed_resources',
    'network_org_mutation_gates',
    'network_worker_assignments'
  ] LOOP
    PERFORM pg_temp.ncs_assert(
      v_tbl || '-is-unreachable-by-authenticated-today',
      NOT has_table_privilege('authenticated', ('public.' || v_tbl)::regclass, 'SELECT')
      AND NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = v_tbl AND permissive = 'PERMISSIVE'
      ),
      v_tbl || ' became reachable by authenticated'
    );
  END LOOP;
END;
$reachability$;

-- Open the four defence-in-depth tables exactly the way a future migration
-- would: a GRANT plus a permissive read policy. Everything the RESTRICTIVE
-- policy has to survive is then in place. service_role is opened too, so the
-- next part can show the new policy does not touch it.
DO $open$
DECLARE
  v_tbl text;
BEGIN
  FOREACH v_tbl IN ARRAY ARRAY[
    'network_command_observations',
    'network_managed_resources',
    'network_org_mutation_gates',
    'network_worker_assignments'
  ] LOOP
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated, service_role', v_tbl);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated, service_role USING (true)',
      v_tbl || '_ncs_probe_read', v_tbl
    );
  END LOOP;
END;
$open$;

-- ===========================================================================
-- Part 5 — the NULL organization_id control. None of the five can hold a NULL
-- organization_id, so the trap CLAUDE.md warns about is reproduced on a table
-- that can, using the EXACT predicate text the migration installed (read back
-- from the catalog, never re-typed) beside the pre-20260801040000 predicate it
-- replaced.
-- ===========================================================================
DO $nullorg$
DECLARE
  v_qual text;
BEGIN
  SELECT qual INTO v_qual FROM pg_policies
  WHERE schemaname = 'public'
    AND policyname = '${HIDE_SANDBOX_REACHABLE_TABLE}_hide_sandbox_admin';
  IF v_qual IS NULL THEN
    RAISE EXCEPTION 'Cannot read back the installed hide_sandbox predicate';
  END IF;

  CREATE TABLE public.ncs_null_org_probe (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid,
    label text NOT NULL
  );
  CREATE TABLE public.ncs_null_org_legacy (LIKE public.ncs_null_org_probe INCLUDING ALL);

  INSERT INTO public.ncs_null_org_probe (organization_id, label) VALUES
    ('${REAL_ORG_ID}', 'real'), ('${SANDBOX_ORG_ID}', 'sandbox'), (NULL, 'null-org');
  INSERT INTO public.ncs_null_org_legacy (organization_id, label)
  SELECT organization_id, label FROM public.ncs_null_org_probe;

  ALTER TABLE public.ncs_null_org_probe ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.ncs_null_org_legacy ENABLE ROW LEVEL SECURITY;
  GRANT SELECT ON public.ncs_null_org_probe, public.ncs_null_org_legacy TO authenticated;
  CREATE POLICY ncs_null_org_probe_read ON public.ncs_null_org_probe
    FOR SELECT TO authenticated USING (true);
  CREATE POLICY ncs_null_org_legacy_read ON public.ncs_null_org_legacy
    FOR SELECT TO authenticated USING (true);

  EXECUTE format(
    'CREATE POLICY ncs_null_org_probe_hide_sandbox_admin ON public.ncs_null_org_probe '
    'AS RESTRICTIVE FOR SELECT TO authenticated USING (%s)', v_qual
  );
  -- The predicate exactly as 20260801020000 first wrote it, before the COALESCE
  -- repair. Kept here so the trap is demonstrated rather than described.
  EXECUTE
    'CREATE POLICY ncs_null_org_legacy_hide_sandbox_admin ON public.ncs_null_org_legacy '
    'AS RESTRICTIVE FOR SELECT TO authenticated '
    'USING (NOT ((SELECT public.is_super_admin()) '
    '            AND organization_id = ANY (public.sandbox_org_ids())))';
END;
$nullorg$;

-- ===========================================================================
-- Part 6 — the measurements, taken while acting as role authenticated.
--
-- For the five target tables visible_count counts SANDBOX rows that leaked
-- through (it must be zero) and visible_orgs lists the distinct org prefixes
-- still visible (it must still contain the real company's). Counting leaked
-- rows rather than total rows keeps the verdict immune to the DEMO fixtures the
-- shared disposable seed and the compatibility snapshot write into these tables.
-- ===========================================================================
SELECT set_config('request.jwt.claim.sub', '${SUPER_ADMIN_ID}', true);
SET LOCAL ROLE authenticated;
INSERT INTO public.ncs_probe (name, visible_count, visible_orgs)
SELECT 'network_worker_building_status@super-admin',
       count(*) FILTER (WHERE organization_id = '${SANDBOX_ORG_ID}')::integer,
       coalesce(string_agg(DISTINCT left(organization_id::text, 4), ',' ORDER BY left(organization_id::text, 4)), '')
FROM public.network_worker_building_status;
INSERT INTO public.ncs_probe (name, visible_count, visible_orgs)
SELECT 'network_worker_assignments@super-admin',
       count(*) FILTER (WHERE organization_id = '${SANDBOX_ORG_ID}')::integer,
       coalesce(string_agg(DISTINCT left(organization_id::text, 4), ',' ORDER BY left(organization_id::text, 4)), '')
FROM public.network_worker_assignments;
INSERT INTO public.ncs_probe (name, visible_count, visible_orgs)
SELECT 'network_managed_resources@super-admin',
       count(*) FILTER (WHERE organization_id = '${SANDBOX_ORG_ID}')::integer,
       coalesce(string_agg(DISTINCT left(organization_id::text, 4), ',' ORDER BY left(organization_id::text, 4)), '')
FROM public.network_managed_resources;
INSERT INTO public.ncs_probe (name, visible_count, visible_orgs)
SELECT 'network_command_observations@super-admin',
       count(*) FILTER (WHERE organization_id = '${SANDBOX_ORG_ID}')::integer,
       coalesce(string_agg(DISTINCT left(organization_id::text, 4), ',' ORDER BY left(organization_id::text, 4)), '')
FROM public.network_command_observations;
INSERT INTO public.ncs_probe (name, visible_count, visible_orgs)
SELECT 'network_org_mutation_gates@super-admin',
       count(*) FILTER (WHERE organization_id = '${SANDBOX_ORG_ID}')::integer,
       coalesce(string_agg(DISTINCT left(organization_id::text, 4), ',' ORDER BY left(organization_id::text, 4)), '')
FROM public.network_org_mutation_gates;
INSERT INTO public.ncs_probe (name, visible_count, visible_orgs)
SELECT 'ncs_null_org_probe@super-admin', count(*),
       coalesce(string_agg(label, ',' ORDER BY label), '')
FROM public.ncs_null_org_probe;
INSERT INTO public.ncs_probe (name, visible_count, visible_orgs)
SELECT 'ncs_null_org_legacy@super-admin', count(*),
       coalesce(string_agg(label, ',' ORDER BY label), '')
FROM public.ncs_null_org_legacy;
RESET ROLE;

-- The same reads for an ordinary tenant who is NOT a super admin: the policy
-- must be a tautology for them, so nothing they legitimately see moves.
SELECT set_config('request.jwt.claim.sub', '${ORDINARY_USER_ID}', true);
SET LOCAL ROLE authenticated;
INSERT INTO public.ncs_probe (name, visible_count, visible_orgs)
SELECT 'ncs_null_org_probe@ordinary-tenant', count(*),
       coalesce(string_agg(label, ',' ORDER BY label), '')
FROM public.ncs_null_org_probe;
RESET ROLE;

-- And for service_role, which the policy does not name at all.
SET LOCAL ROLE service_role;
INSERT INTO public.ncs_probe (name, visible_count, visible_orgs)
SELECT 'network_org_mutation_gates@service-role',
       count(*) FILTER (WHERE organization_id = '${SANDBOX_ORG_ID}')::integer,
       coalesce(string_agg(DISTINCT left(organization_id::text, 4), ',' ORDER BY left(organization_id::text, 4)), '')
FROM public.network_org_mutation_gates;
RESET ROLE;

-- The fleet kill switch, exercised through its real SECURITY DEFINER guard
-- while acting as the super admin who can no longer read the gate row directly.
SELECT set_config('request.jwt.claim.sub', '${SUPER_ADMIN_ID}', true);
GRANT EXECUTE ON FUNCTION app_private.network_center_org_mutations_paused_v1(uuid)
  TO authenticated;
GRANT USAGE ON SCHEMA app_private TO authenticated;
SET LOCAL ROLE authenticated;
INSERT INTO public.ncs_probe (name, visible_count, visible_orgs)
SELECT 'kill-switch@super-admin', 1,
       app_private.network_center_org_mutations_paused_v1('${SANDBOX_ORG_ID}')::text;
RESET ROLE;

-- ===========================================================================
-- Part 7 — verdicts on the measurements.
-- ===========================================================================
DO $verdicts$
DECLARE
  v_tbl text;
  v_row public.ncs_probe%ROWTYPE;
BEGIN
  FOREACH v_tbl IN ARRAY ARRAY[
    'network_command_observations',
    'network_managed_resources',
    'network_org_mutation_gates',
    'network_worker_assignments',
    'network_worker_building_status'
  ] LOOP
    SELECT * INTO v_row FROM public.ncs_probe WHERE name = v_tbl || '@super-admin';
    PERFORM pg_temp.ncs_assert(
      v_tbl || '-hides-the-sandbox-row-from-the-real-company-owner',
      v_row.visible_count = 0 AND v_row.visible_orgs LIKE '%aaaa%',
      v_tbl || ' leaked ' || coalesce(v_row.visible_count::text, 'no probe')
        || ' sandbox row(s); orgs still visible: ' || coalesce(v_row.visible_orgs, '?')
    );
  END LOOP;

  SELECT * INTO v_row FROM public.ncs_probe WHERE name = 'ncs_null_org_probe@super-admin';
  PERFORM pg_temp.ncs_assert(
    'guarded-predicate-keeps-the-null-org-row-visible',
    v_row.visible_count = 2 AND v_row.visible_orgs = 'null-org,real',
    'super admin saw: ' || coalesce(v_row.visible_orgs, '?')
  );

  SELECT * INTO v_row FROM public.ncs_probe WHERE name = 'ncs_null_org_legacy@super-admin';
  PERFORM pg_temp.ncs_assert(
    'pre-coalesce-predicate-would-have-erased-the-null-org-row',
    v_row.visible_count = 1 AND v_row.visible_orgs = 'real',
    'the pre-fix predicate no longer reproduces the trap: '
      || coalesce(v_row.visible_orgs, '?')
  );

  SELECT * INTO v_row FROM public.ncs_probe WHERE name = 'ncs_null_org_probe@ordinary-tenant';
  PERFORM pg_temp.ncs_assert(
    'ordinary-tenant-reads-are-unchanged-by-the-new-policy',
    v_row.visible_count = 3,
    'an ordinary tenant lost rows: ' || coalesce(v_row.visible_orgs, '?')
  );

  -- The policy names role authenticated only, so service_role must still see
  -- the sandbox gate row that the super admin no longer can.
  SELECT * INTO v_row FROM public.ncs_probe WHERE name = 'network_org_mutation_gates@service-role';
  PERFORM pg_temp.ncs_assert(
    'service-role-reads-are-not-named-by-the-new-policy',
    v_row.visible_count = 1 AND v_row.visible_orgs LIKE '%cccc%',
    'service_role lost the sandbox gate row: ' || coalesce(v_row.visible_orgs, '?')
  );

  SELECT * INTO v_row FROM public.ncs_probe WHERE name = 'kill-switch@super-admin';
  PERFORM pg_temp.ncs_assert(
    'org-mutation-gate-kill-switch-still-sees-the-sandbox-pause',
    v_row.visible_orgs = 'true',
    'the kill switch stopped reporting the sandbox org as paused: '
      || coalesce(v_row.visible_orgs, '?')
  );
END;
$verdicts$;

SELECT jsonb_build_object(
  'status', 'PASS',
  'invariants', (SELECT count(*)::integer FROM pg_temp.ncs_results),
  'proofNonce', (
    SELECT proof_nonce FROM app_private.network_center_disposable_proof
    WHERE proof_nonce = '${nonce}'
  ),
  'names', (SELECT jsonb_agg(name ORDER BY name) FROM pg_temp.ncs_results)
) AS disposable_hide_sandbox_proof;

-- ===========================================================================
-- Part 8 — machine-checked non-vacuity. Drop the two policies under test and
-- take the same two measurements again. If the migration had created nothing,
-- these numbers would be identical to the ones above and the runner rejects the
-- PASS. The whole transaction rolls back immediately afterwards.
-- ===========================================================================
DROP POLICY network_worker_building_status_hide_sandbox_admin
  ON public.network_worker_building_status;
DROP POLICY ncs_null_org_probe_hide_sandbox_admin ON public.ncs_null_org_probe;
DROP POLICY ncs_null_org_legacy_hide_sandbox_admin ON public.ncs_null_org_legacy;

SELECT set_config('request.jwt.claim.sub', '${SUPER_ADMIN_ID}', true);
SET LOCAL ROLE authenticated;
SELECT jsonb_build_object(
  'counterProof', jsonb_build_object(
    'workerBuildingStatusSandboxRows',
      (SELECT count(*)::integer FROM public.network_worker_building_status
       WHERE organization_id = '${SANDBOX_ORG_ID}'),
    'nullOrgProbeLabels',
      (SELECT coalesce(string_agg(label, ',' ORDER BY label), '') FROM public.ncs_null_org_probe),
    'nullOrgLegacyLabels',
      (SELECT coalesce(string_agg(label, ',' ORDER BY label), '') FROM public.ncs_null_org_legacy)
  )
) AS disposable_hide_sandbox_counter_proof;
RESET ROLE;

ROLLBACK;
`;
}

function parseJsonLines(output) {
  return String(output)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"))
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((entry) => entry !== null && typeof entry === "object");
}

export function parseHideSandboxVerdict(output, { expectedLocalProof } = {}) {
  const objects = parseJsonLines(output);
  const verdict = objects.filter((entry) => Object.hasOwn(entry, "invariants")).at(-1) ?? null;
  if (
    verdict?.status !== "PASS"
    || verdict?.invariants !== HIDE_SANDBOX_PROOF_INVARIANTS
    || verdict?.proofNonce !== expectedLocalProof?.proofNonce
  ) {
    throw new Error(
      "Disposable hide-sandbox proof did not return the expected PASS verdict: "
        + JSON.stringify(verdict),
    );
  }
  if (
    !Array.isArray(verdict.names)
    || new Set(verdict.names).size !== HIDE_SANDBOX_PROOF_INVARIANTS
  ) {
    throw new Error(
      "Disposable hide-sandbox proof returned a malformed assertion ledger: "
        + JSON.stringify(verdict?.names),
    );
  }

  // Non-vacuity: with the policies dropped the sandbox row MUST come back and
  // the pre-COALESCE predicate MUST stop erasing the null-org row. Identical
  // numbers would mean the assertions above passed for some other reason.
  const counter = objects.filter((entry) => Object.hasOwn(entry, "counterProof")).at(-1)
    ?.counterProof ?? null;
  if (
    counter?.workerBuildingStatusSandboxRows !== 1
    || counter?.nullOrgProbeLabels !== "null-org,real,sandbox"
    || counter?.nullOrgLegacyLabels !== "null-org,real,sandbox"
  ) {
    throw new Error(
      "Disposable hide-sandbox proof is VACUOUS: dropping the policies changed nothing. "
        + JSON.stringify(counter),
    );
  }
  return { ...verdict, counterProof: counter };
}

/**
 * Build a disposable PostgreSQL 17 cluster from the declared platform bootstrap
 * plus every real Network Center migration — including the one under test — and
 * run the tenancy matrix against it.
 */
export async function runDisposableHideSandboxProof({ environment = process.env } = {}) {
  return runDisposableLocalClusterMatrix({
    buildSql: buildHideSandboxSql,
    parseVerdict: parseHideSandboxVerdict,
    environment,
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--dry-run")) {
    throw new Error(
      "Usage: node scripts/test-network-center-hide-sandbox-disposable.mjs [--dry-run]",
    );
  }
  if (args[0] === "--dry-run") {
    buildHideSandboxSql({ localProof: { proofNonce: "0".repeat(32) } });
    process.stdout.write(
      "Disposable hide-sandbox proof dry-run passed; no PostgreSQL process was started.\n",
    );
    return;
  }
  const verdict = await runDisposableHideSandboxProof();
  process.stdout.write(
    `Disposable PostgreSQL sandbox-hide policy proof PASS: `
      + `${verdict.invariants}/${HIDE_SANDBOX_PROOF_INVARIANTS} invariants.\n`,
  );
  process.stdout.write(
    `Non-vacuity counter-proof (policies dropped): `
      + `network_worker_building_status sandbox rows ${verdict.counterProof.workerBuildingStatusSandboxRows}, `
      + `guarded probe [${verdict.counterProof.nullOrgProbeLabels}], `
      + `pre-COALESCE probe [${verdict.counterProof.nullOrgLegacyLabels}].\n`,
  );
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error?.message ?? error);
    process.exitCode = 1;
  });
}
