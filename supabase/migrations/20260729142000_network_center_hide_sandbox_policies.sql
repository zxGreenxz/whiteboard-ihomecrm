-- =============================================================================
-- Network Center additive forward-fix: the five hardening-wave tables that never
-- got a `<bảng>_hide_sandbox_admin` policy.
-- =============================================================================
-- BỐI CẢNH
--   20260801020000_sandbox_org_hide_from_super_admin.sql swept the catalog once
--   and gave every `public` relation that (a) is a real relation or partitioned
--   parent, (b) is not itself a partition, (c) has RLS enabled and (d) carries
--   an `organization_id` column a RESTRICTIVE SELECT policy that hides org
--   SANDBOX (`cccc0000-…0001`, the TEST clone of the real company's books) from
--   super admins. 20260801040000_fix_sandbox_hide_null_org.sql then rewrote
--   every one of those predicates to wrap `COALESCE(…, false)`, because
--   `NULL = ANY(...)` yields NULL, RLS treats NULL as "not permitted", and the
--   real company's own `organization_id IS NULL` rows were vanishing from the
--   owner's screen (measured: inspection_photos 477 → 254).
--
--   Both of those ran ONCE, as one-shot sweeps, on 2026-08-01. The Network
--   Center hardening wave (20260729130000 … 20260729141000) was applied to
--   production AFTER them, so five tables it created were never swept:
--
--     public.network_command_observations
--     public.network_managed_resources
--     public.network_org_mutation_gates
--     public.network_worker_assignments
--     public.network_worker_building_status
--
--   Measured on production 2026-08-02 (catalog read only): of the 225 non-
--   partition `public` relations that have `organization_id` and RLS enabled,
--   exactly those five lack a `%hide_sandbox%` policy. Every older one has it.
--
-- WHAT ACTUALLY LEAKS TODAY, TABLE BY TABLE
--   Only ONE of the five is reachable at all by role `authenticated`:
--
--   * network_worker_building_status — REAL, REACHABLE LEAK.
--       `GRANT SELECT … TO authenticated` (20260729133000:48) plus a PERMISSIVE
--       policy `USING (can_do_on_building('network_center','view', building_id))`.
--       public.can_do_on_building short-circuits on `public.is_super_admin()`
--       and is NOT sandbox aware — unlike public.can_access_building(), which
--       20260801050000 taught to skip sandbox buildings. So the real company's
--       owner, who is a super admin, sees org TEST worker rows on the Network
--       Center screen, and the table is a member of the `supabase_realtime`
--       publication, so those rows are also pushed live. Production carries 2
--       rows today and none of them are org TEST, so nothing has leaked YET:
--       this is a latent leak that fires the first time a worker heartbeats for
--       a building of the cloned company.
--
--   * network_command_observations, network_managed_resources,
--     network_org_mutation_gates, network_worker_assignments — DEFENCE IN DEPTH.
--       All four have `REVOKE ALL … FROM PUBLIC, anon, authenticated,
--       service_role` and ZERO policies, so RLS denies by default and the
--       privilege check refuses the read before RLS is even consulted. They are
--       not leaking. They get the policy anyway so that the day somebody adds
--       the first `GRANT SELECT … TO authenticated` — exactly how
--       network_worker_building_status became reachable — the tenant boundary is
--       already in place instead of being remembered.
--
-- WHY THIS CANNOT BREAK THE KILL SWITCH OR THE WATCHDOG
--   The policy is RESTRICTIVE, `FOR SELECT`, `TO authenticated`. Three
--   independent reasons it cannot touch any operational path:
--     1. It names only role `authenticated`. A policy with a role list is not
--        even evaluated for roles outside it.
--     2. Every operational reader is SECURITY DEFINER owned by `postgres`, and
--        `postgres` carries `rolbypassrls` on this project (verified in
--        pg_roles), which overrides FORCE ROW LEVEL SECURITY. That covers
--        app_private.network_center_org_mutations_paused_v1 (the org kill
--        switch), public.network_center_pause_organization_v1 /
--        _resume_organization_v1, app_private.network_center_watchdog_liveness_
--        scan_v1, network_center_worker_can_access_building_v2, the reclaim and
--        retention jobs, and every worker RPC.
--     3. It constrains SELECT only. Every write path — heartbeats, assignment
--        replacement, observation recording, gate pause/resume — is untouched.
--   A `FOR ALL` or unrestricted-role variant WOULD have been dangerous on
--   network_org_mutation_gates under its FORCE ROW LEVEL SECURITY. This is not
--   that; the template is reproduced exactly and deliberately.
--
-- WHY THE DAILY PARTITIONS ARE NOT IN SCOPE
--   `network_device_samples_YYYYMMDD` / `network_interface_samples_YYYYMMDD`
--   show up in a naive sweep as "no hide_sandbox policy" (76 of them today, one
--   more pair every day from app_private.network_center_ensure_raw_partitions_v1).
--   Measured on a real PostgreSQL 17 cluster: a parent's RESTRICTIVE policy DOES
--   gate partition rows read through the parent, and does NOT apply when the
--   partition is named directly — so "policies live on the parent" is only half
--   true. The partitions are nonetheless safe, and for a sturdier reason:
--   ensure_raw_partitions_v1 issues `ENABLE ROW LEVEL SECURITY` and
--   `REVOKE ALL … FROM PUBLIC, anon, authenticated, service_role` on every
--   partition it creates, so each one is born deny-all AND unprivileged. Two
--   independent locks, verified on production for all 76. The discovery query
--   below keeps `NOT c.relispartition` from the original template for exactly
--   this reason.
--
-- SAFE ON A LIVE DATABASE
--   Additive only: it creates policies that do not exist and never drops,
--   replaces or alters an existing policy or GRANT. CREATE POLICY takes a brief
--   ACCESS EXCLUSIVE lock and rewrites nothing; `lock_timeout` below makes the
--   whole transaction fail fast and roll back rather than queue behind a long
--   reader and stall writers behind it.
-- =============================================================================

BEGIN;

SELECT pg_advisory_xact_lock(20260729142000::bigint);

-- Fail fast instead of parking an ACCESS EXCLUSIVE lock request in front of
-- live traffic. The whole migration is one transaction, so a timeout leaves the
-- catalog exactly as it was.
SET LOCAL lock_timeout = '5s';

-- 1. Same sweep as 20260801020000, same skip-if-present rule, same predicate as
--    corrected by 20260801040000. Nothing here is a variant of the template.
DO $do$
DECLARE
  r record;
  v_n int := 0;
BEGIN
  FOR r IN
    SELECT c.relname AS tbl
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
      AND NOT c.relispartition
      AND c.relrowsecurity
      AND EXISTS (
        SELECT 1 FROM pg_attribute a
        WHERE a.attrelid = c.oid AND a.attname = 'organization_id' AND a.attnum > 0 AND NOT a.attisdropped
      )
    ORDER BY 1
  LOOP
    IF EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = r.tbl
        AND policyname = r.tbl || '_hide_sandbox_admin'
    ) THEN
      CONTINUE;
    END IF;

    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR SELECT TO authenticated '
      'USING (NOT ((SELECT public.is_super_admin()) '
      '            AND COALESCE(organization_id = ANY (public.sandbox_org_ids()), false)))',
      r.tbl || '_hide_sandbox_admin', r.tbl
    );
    v_n := v_n + 1;
    RAISE NOTICE 'sandbox hide policy added: public.%', r.tbl;
  END LOOP;

  RAISE NOTICE 'sandbox hide policies created: %', v_n;
END
$do$;

-- 2. Prove the five named tables really are covered, and that the predicate
--    carries the COALESCE guard rather than the pre-20260801040000 shape that
--    hid the real company's own organization_id IS NULL rows. A silent no-op is
--    the failure mode this whole file exists to prevent, so it must raise.
DO $verify$
DECLARE
  v_missing text;
  v_unguarded text;
BEGIN
  SELECT string_agg(expected.tbl, ', ' ORDER BY expected.tbl)
  INTO v_missing
  FROM unnest(ARRAY[
    'network_command_observations',
    'network_managed_resources',
    'network_org_mutation_gates',
    'network_worker_assignments',
    'network_worker_building_status'
  ]) AS expected(tbl)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = expected.tbl
      AND policyname = expected.tbl || '_hide_sandbox_admin'
  );
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Network Center sandbox hide policy missing on: %', v_missing
      USING ERRCODE = '42501';
  END IF;

  SELECT string_agg(policy_row.tablename, ', ' ORDER BY policy_row.tablename)
  INTO v_unguarded
  FROM pg_policies policy_row
  WHERE policy_row.schemaname = 'public'
    AND policy_row.policyname LIKE '%\_hide\_sandbox\_admin'
    AND (
      policy_row.permissive <> 'RESTRICTIVE'
      OR policy_row.cmd <> 'SELECT'
      OR policy_row.roles <> ARRAY['authenticated']::name[]
      OR policy_row.qual NOT LIKE '%COALESCE%'
      OR policy_row.qual NOT LIKE '%sandbox_org_ids()%'
      OR policy_row.qual NOT LIKE '%is_super_admin%'
    );
  IF v_unguarded IS NOT NULL THEN
    RAISE EXCEPTION
      'Sandbox hide policy is not the reviewed RESTRICTIVE/SELECT/authenticated + COALESCE shape on: %',
      v_unguarded
      USING ERRCODE = '42501';
  END IF;
END
$verify$;

COMMIT;

NOTIFY pgrst, 'reload schema';
