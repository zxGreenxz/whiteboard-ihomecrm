-- Runtime regression for canonical finding `worker-heartbeat-global-view`.
--
-- The pre-hardening design exposed public.network_worker_heartbeats to every
-- authenticated browser session and published it on supabase_realtime, so any
-- signed-in member of any tenant could read fleet-wide worker liveness, worker
-- identity and queue metadata. 20260729133000 revokes that table, drops it from
-- the publication, and replaces it with public.network_worker_building_status:
-- an RLS-scoped, building-keyed projection carrying no worker identity.
--
-- This fixture proves the boundary by EXECUTING it. It provisions a real worker
-- through the shipped admin RPC, drives the shipped
-- public.network_center_worker_heartbeat_v2 so the projection is written by
-- production code rather than seeded by hand, and then reads it back as three
-- different authenticated principals through PostgreSQL's own RLS machinery.
--
-- Owns its transaction: BEGIN ... ROLLBACK. Nothing survives the run.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE TEMP TABLE _nchb_results (
  case_id text PRIMARY KEY,
  passed boolean NOT NULL,
  detail jsonb NOT NULL
) ON COMMIT DROP;

CREATE TEMP TABLE _nchb_fixture ON COMMIT DROP AS
SELECT
  'dddd0000-0000-4000-8000-000000000001'::uuid AS home_org_id,
  'dddd0000-0000-4000-8000-00000000000b'::uuid AS other_org_id,
  'dddd1000-0000-4000-8000-000000000101'::uuid AS granted_building_id,
  'dddd1000-0000-4000-8000-000000000102'::uuid AS ungranted_building_id,
  'dddd1000-0000-4000-8000-000000000103'::uuid AS other_org_building_id,
  'dddd2000-0000-4000-8000-000000000101'::uuid AS granted_device_id,
  'dddd2000-0000-4000-8000-000000000102'::uuid AS ungranted_device_id,
  'dddd2000-0000-4000-8000-000000000103'::uuid AS other_org_device_id,
  'dddd4000-0000-4000-8000-000000000101'::uuid AS scoped_member_id,
  'dddd4000-0000-4000-8000-000000000102'::uuid AS unprivileged_member_id,
  'dddd4000-0000-4000-8000-000000000103'::uuid AS other_org_member_id,
  repeat('7', 64)::text AS credential_digest;

DO $preflight$
BEGIN
  IF to_regclass('public.network_worker_building_status') IS NULL
     OR to_regclass('public.network_worker_heartbeats') IS NULL
     OR to_regprocedure(
       'public.network_center_worker_heartbeat_v2('
       || 'text,text,text[],text,integer,jsonb,timestamptz)'
     ) IS NULL
     OR to_regprocedure(
       'public.network_center_admin_provision_worker_v1('
       || 'text,text,text,text,timestamptz,jsonb)'
     ) IS NULL THEN
    RAISE EXCEPTION 'Heartbeat scope proof requires the hardened worker plane';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.permission_definitions
    WHERE key IN ('network_center.view', 'network_center.execute')
      AND is_active
  ) THEN
    RAISE EXCEPTION 'Heartbeat scope proof requires the network_center catalog';
  END IF;
END
$preflight$;

-- ---------------------------------------------------------------------------
-- Two tenants, three buildings, three human principals.
-- ---------------------------------------------------------------------------
INSERT INTO auth.users (id, aud, role, email)
SELECT identity.id, 'authenticated', 'authenticated', identity.email
FROM _nchb_fixture fixture
CROSS JOIN LATERAL (VALUES
  (fixture.scoped_member_id, 'nchb-scoped@example.invalid'),
  (fixture.unprivileged_member_id, 'nchb-unprivileged@example.invalid'),
  (fixture.other_org_member_id, 'nchb-other-tenant@example.invalid')
) AS identity(id, email)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.organizations (id, slug, name, status, is_demo, created_by)
SELECT
  fixture.other_org_id, 'nchb-other-tenant', 'Heartbeat scope other tenant',
  'ACTIVE', true, fixture.scoped_member_id
FROM _nchb_fixture fixture
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.buildings (
  id, user_id, organization_id, name, code, province, district, ward,
  total_floors, total_rooms, is_virtual
)
SELECT
  building.id, fixture.scoped_member_id, building.organization_id,
  building.name, building.code, 'DEMO', 'DEMO', 'DEMO', 1, 0, false
FROM _nchb_fixture fixture
CROSS JOIN LATERAL (VALUES
  (fixture.granted_building_id, fixture.home_org_id,
    'Heartbeat scope granted', 'NCHB-1'),
  (fixture.ungranted_building_id, fixture.home_org_id,
    'Heartbeat scope ungranted', 'NCHB-2'),
  (fixture.other_org_building_id, fixture.other_org_id,
    'Heartbeat scope other tenant', 'NCHB-3')
) AS building(id, organization_id, name, code)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.network_devices (
  id, organization_id, building_id, device_kind, external_key, display_name,
  vendor, lifecycle_status, write_capability, is_active, credential_ref
)
SELECT
  device.id, device.organization_id, device.building_id, 'MIKROTIK',
  device.external_key, device.display_name, 'MikroTik', 'ONLINE',
  true, true, device.credential_ref
FROM _nchb_fixture fixture
CROSS JOIN LATERAL (VALUES
  (fixture.granted_device_id, fixture.home_org_id, fixture.granted_building_id,
    'nchb:router:1', 'Heartbeat scope router 1', 'router/nchb/1'),
  (fixture.ungranted_device_id, fixture.home_org_id,
    fixture.ungranted_building_id, 'nchb:router:2',
    'Heartbeat scope router 2', 'router/nchb/2'),
  (fixture.other_org_device_id, fixture.other_org_id,
    fixture.other_org_building_id, 'nchb:router:3',
    'Heartbeat scope router 3', 'router/nchb/3')
) AS device(
  id, organization_id, building_id, external_key, display_name, credential_ref
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.organization_memberships (
  id, organization_id, user_id, member_type, status, activated_at
)
SELECT
  membership.id, membership.organization_id, membership.user_id, 'STAFF',
  'ACTIVE', clock_timestamp()
FROM _nchb_fixture fixture
CROSS JOIN LATERAL (VALUES
  ('dddd5000-0000-4000-8000-000000000101'::uuid, fixture.home_org_id,
    fixture.scoped_member_id),
  ('dddd5000-0000-4000-8000-000000000102'::uuid, fixture.home_org_id,
    fixture.unprivileged_member_id),
  ('dddd5000-0000-4000-8000-000000000103'::uuid, fixture.other_org_id,
    fixture.other_org_member_id)
) AS membership(id, organization_id, user_id)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.authorization_scopes (
  id, organization_id, scope_type, building_id
)
SELECT
  'dddd6000-0000-4000-8000-000000000101'::uuid, fixture.home_org_id,
  'BUILDING', fixture.granted_building_id
FROM _nchb_fixture fixture
ON CONFLICT (id) DO NOTHING;

-- The scoped member may view exactly one building; the other-tenant member is
-- granted org-wide inside its own organization; the third member is a
-- legitimate signed-in user with no Network Center grant at all.
INSERT INTO public.member_permission_overrides (
  id, organization_id, membership_id, permission_key, effect, scope_mode, reason
)
SELECT
  'dddd7000-0000-4000-8000-000000000101'::uuid, fixture.home_org_id,
  'dddd5000-0000-4000-8000-000000000101'::uuid, 'network_center.view',
  'ALLOW', 'SCOPED', 'heartbeat scope proof: single building'
FROM _nchb_fixture fixture
UNION ALL
SELECT
  'dddd7000-0000-4000-8000-000000000103'::uuid, fixture.other_org_id,
  'dddd5000-0000-4000-8000-000000000103'::uuid, 'network_center.view',
  'ALLOW', 'ORGANIZATION', 'heartbeat scope proof: other tenant org-wide'
FROM _nchb_fixture fixture
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.member_override_scopes (organization_id, override_id, scope_id)
SELECT
  fixture.home_org_id,
  'dddd7000-0000-4000-8000-000000000101'::uuid,
  'dddd6000-0000-4000-8000-000000000101'::uuid
FROM _nchb_fixture fixture
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Production code writes the projection: provision a credential, then let the
-- shipped heartbeat RPC derive identity from the digest and upsert.
-- ---------------------------------------------------------------------------
SELECT public.network_center_admin_provision_worker_v1(
  'nchb-scope-worker',
  'Heartbeat scope proof worker',
  fixture.credential_digest,
  'sha256:' || substr(fixture.credential_digest, 1, 24),
  clock_timestamp() + INTERVAL '1 day',
  jsonb_build_array(
    jsonb_build_object(
      'organizationId', fixture.home_org_id,
      'buildingId', fixture.granted_building_id,
      'deviceId', fixture.granted_device_id,
      'canPoll', true, 'canInventory', true, 'canExecute', false
    ),
    jsonb_build_object(
      'organizationId', fixture.home_org_id,
      'buildingId', fixture.ungranted_building_id,
      'deviceId', fixture.ungranted_device_id,
      'canPoll', true, 'canInventory', true, 'canExecute', false
    ),
    jsonb_build_object(
      'organizationId', fixture.other_org_id,
      'buildingId', fixture.other_org_building_id,
      'deviceId', fixture.other_org_device_id,
      'canPoll', true, 'canInventory', true, 'canExecute', false
    )
  )
)
FROM _nchb_fixture fixture;

SELECT public.network_center_worker_heartbeat_v2(
  fixture.credential_digest,
  -- The release readback migration requires the worker version to be a raw
  -- 40-hex Git revision; trimming or case-folding is rejected on purpose.
  repeat('ab', 20),
  ARRAY['HEARTBEAT', 'POLL']::text[],
  'ONLINE',
  0,
  -- Poll evidence is all-or-nothing: the release readback migration rejects a
  -- partial or JSON-null triple, so supply the complete, consistent set.
  jsonb_build_object(
    'connections', 3, 'successfulPolls', 3, 'failedPolls', 0
  ),
  clock_timestamp() - INTERVAL '5 minutes'
)
FROM _nchb_fixture fixture;

-- ---------------------------------------------------------------------------
-- Read the projection back as each principal, through real RLS.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION pg_temp.nchb_visible_buildings(p_actor uuid)
RETURNS uuid[]
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_buildings uuid[];
BEGIN
  PERFORM set_config('request.jwt.claim.sub', p_actor::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT coalesce(array_agg(status.building_id ORDER BY status.building_id),
    ARRAY[]::uuid[])
  INTO v_buildings
  FROM public.network_worker_building_status status;
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claim.sub', '', true);
  RETURN v_buildings;
EXCEPTION WHEN OTHERS THEN
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claim.sub', '', true);
  RAISE;
END;
$fn$;

CREATE OR REPLACE FUNCTION pg_temp.nchb_direct_heartbeat_sqlstate(p_actor uuid)
RETURNS text
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_count bigint;
  v_sqlstate text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', p_actor::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    EXECUTE 'SELECT count(*) FROM public.network_worker_heartbeats'
      INTO v_count;
    v_sqlstate := 'NO_ERROR';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE;
  END;
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claim.sub', '', true);
  RETURN v_sqlstate;
EXCEPTION WHEN OTHERS THEN
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claim.sub', '', true);
  RAISE;
END;
$fn$;

DO $heartbeat_scope$
DECLARE
  v_fixture _nchb_fixture%ROWTYPE;
  v_scoped uuid[];
  v_unprivileged uuid[];
  v_other uuid[];
  v_direct_sqlstate text;
  v_heartbeats_published boolean;
  v_status_published boolean;
  v_heartbeats_select boolean;
  v_status_select boolean;
  v_projection_columns text[];
  v_written_rows bigint;
  v_scoped_row record;
BEGIN
  SELECT * INTO v_fixture FROM _nchb_fixture;

  SELECT count(*) INTO v_written_rows
  FROM public.network_worker_building_status status
  WHERE status.building_id IN (
    v_fixture.granted_building_id, v_fixture.ungranted_building_id,
    v_fixture.other_org_building_id
  );

  v_scoped := pg_temp.nchb_visible_buildings(v_fixture.scoped_member_id);
  v_unprivileged := pg_temp.nchb_visible_buildings(
    v_fixture.unprivileged_member_id
  );
  v_other := pg_temp.nchb_visible_buildings(v_fixture.other_org_member_id);
  v_direct_sqlstate := pg_temp.nchb_direct_heartbeat_sqlstate(
    v_fixture.scoped_member_id
  );

  v_heartbeats_select := has_table_privilege(
    'authenticated', 'public.network_worker_heartbeats', 'SELECT'
  );
  v_status_select := has_table_privilege(
    'authenticated', 'public.network_worker_building_status', 'SELECT'
  );
  v_heartbeats_published := EXISTS (
    SELECT 1 FROM pg_catalog.pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'network_worker_heartbeats'
  );
  v_status_published := EXISTS (
    SELECT 1 FROM pg_catalog.pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'network_worker_building_status'
  );
  SELECT array_agg(attribute.attname ORDER BY attribute.attname)
  INTO v_projection_columns
  FROM pg_catalog.pg_attribute attribute
  WHERE attribute.attrelid = 'public.network_worker_building_status'::regclass
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  SELECT status.status, status.queue_age_seconds
  INTO v_scoped_row
  FROM public.network_worker_building_status status
  WHERE status.organization_id = v_fixture.home_org_id
    AND status.building_id = v_fixture.granted_building_id;

  -- Exploit case: the fleet-global read path must be gone in every form.
  INSERT INTO _nchb_results(case_id, passed, detail) VALUES (
    'heartbeat-scope-runtime',
    v_written_rows = 3
      AND NOT v_heartbeats_select
      AND NOT v_heartbeats_published
      AND v_direct_sqlstate = '42501'
      AND v_scoped = ARRAY[v_fixture.granted_building_id]
      AND v_unprivileged = ARRAY[]::uuid[]
      AND NOT (v_fixture.other_org_building_id = ANY(v_scoped))
      AND NOT (v_fixture.ungranted_building_id = ANY(v_scoped))
      AND NOT (v_fixture.granted_building_id = ANY(v_other))
      AND NOT (v_projection_columns && ARRAY[
        'worker_id', 'worker_key', 'credential_digest', 'credential_ref',
        'worker_version', 'safe_metadata'
      ]::text[]),
    jsonb_build_object(
      'rows_written_by_heartbeat_rpc', v_written_rows,
      'authenticated_can_select_heartbeats', v_heartbeats_select,
      'heartbeats_still_published', v_heartbeats_published,
      'direct_heartbeat_select_sqlstate', v_direct_sqlstate,
      'scoped_member_visible_buildings', to_jsonb(v_scoped),
      'unprivileged_member_visible_buildings', to_jsonb(v_unprivileged),
      'other_tenant_visible_buildings', to_jsonb(v_other),
      'projection_columns', to_jsonb(v_projection_columns)
    )
  );

  -- Legitimate control: the replacement projection must actually work for the
  -- member entitled to it, with the values production wrote.
  INSERT INTO _nchb_results(case_id, passed, detail) VALUES (
    'heartbeat-scope-control',
    v_status_select
      AND v_status_published
      AND v_scoped = ARRAY[v_fixture.granted_building_id]
      AND v_other = ARRAY[v_fixture.other_org_building_id]
      AND v_scoped_row.status = 'ONLINE'
      AND v_scoped_row.queue_age_seconds = 0,
    jsonb_build_object(
      'authenticated_can_select_projection', v_status_select,
      'projection_published_on_realtime', v_status_published,
      'scoped_member_visible_buildings', to_jsonb(v_scoped),
      'other_tenant_visible_buildings', to_jsonb(v_other),
      'observed_status', v_scoped_row.status,
      'observed_queue_age_seconds', v_scoped_row.queue_age_seconds
    )
  );
END
$heartbeat_scope$;

CREATE TEMP TABLE _nchb_required_cases (
  sequence integer PRIMARY KEY,
  case_id text NOT NULL UNIQUE
) ON COMMIT DROP;
INSERT INTO _nchb_required_cases(sequence, case_id) VALUES
  (1, 'heartbeat-scope-runtime'),
  (2, 'heartbeat-scope-control');

WITH evaluated AS (
  SELECT
    required.sequence,
    required.case_id,
    coalesce(result.passed, false) AS passed,
    CASE WHEN result.case_id IS NULL
      THEN jsonb_build_object('missing_result', true)
      ELSE result.detail
    END AS detail
  FROM _nchb_required_cases required
  LEFT JOIN _nchb_results result USING (case_id)
)
SELECT jsonb_build_object(
  'passed', bool_and(evaluated.passed),
  'assertion_count', count(*),
  'failed_count', count(*) FILTER (WHERE NOT evaluated.passed),
  'assertions', jsonb_agg(jsonb_build_object(
    'case_id', evaluated.case_id,
    'passed', evaluated.passed,
    'detail', evaluated.detail
  ) ORDER BY evaluated.sequence)
) AS verdict
FROM evaluated;
ROLLBACK;
