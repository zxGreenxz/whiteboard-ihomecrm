\set ON_ERROR_STOP on

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

CREATE TEMP TABLE _t9_routers ON COMMIT DROP AS
SELECT
  row_number() OVER (ORDER BY count(aruba.id), router.id)::integer AS ordinal,
  router.id,
  router.organization_id,
  router.building_id
FROM public.network_devices router
LEFT JOIN public.network_devices aruba
  ON aruba.parent_device_id = router.id
 AND aruba.device_kind = 'ARUBA'
WHERE router.device_kind = 'MIKROTIK'
  AND router.is_active
GROUP BY router.id, router.organization_id, router.building_id
ORDER BY count(aruba.id), router.id
LIMIT 8;

DO $preflight$
BEGIN
  IF (SELECT count(*) FROM _t9_routers) < 8 THEN
    RAISE EXCEPTION 'Task 9 runtime proof requires eight active MikroTik fixtures';
  END IF;
  IF to_regprocedure(
    'public.network_center_worker_inventory_v2(text,jsonb)'
  ) IS NULL OR to_regprocedure(
    'public.network_center_list_aruba_v1(uuid,integer,uuid,integer)'
  ) IS NULL OR to_regprocedure(
    'app_private.network_center_aruba_retention_v1(timestamptz)'
  ) IS NULL THEN
    RAISE EXCEPTION 'Task 9 migration functions are unavailable';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION pg_temp.t9_assert(
  p_condition boolean,
  p_message text
)
RETURNS void
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF coalesce(p_condition, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'TASK9_RUNTIME_ASSERTION: %', p_message;
  END IF;
END;
$fn$;

CREATE OR REPLACE FUNCTION pg_temp.t9_item(
  p_serial text,
  p_sort_order integer DEFAULT 0,
  p_aliases jsonb DEFAULT '[]'::jsonb
)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT jsonb_build_object(
    'stableIdentity', p_serial,
    'identitySource', 'SERIAL',
    'externalKey', 'serial:' || p_serial,
    'displayName', 'Aruba ' || p_serial,
    'displayOnly', true,
    'sortOrder', p_sort_order,
    'lifecycleStatus', 'ONLINE',
    'aliases', p_aliases,
    'metadata', jsonb_build_object('discovery', 'task9-runtime')
  );
$fn$;

CREATE OR REPLACE FUNCTION pg_temp.t9_payload(
  p_router_id uuid,
  p_run_id uuid,
  p_observed_at timestamptz,
  p_batch_index integer,
  p_batch_count integer,
  p_aruba jsonb,
  p_quarantine jsonb DEFAULT '[]'::jsonb
)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT jsonb_build_object(
    'routerDeviceId', p_router_id,
    'discoveryRunId', p_run_id,
    'observedAt', p_observed_at,
    'batchIndex', p_batch_index,
    'batchCount', p_batch_count,
    'interfaces', '[]'::jsonb,
    'aruba', coalesce(p_aruba, '[]'::jsonb),
    'quarantine', coalesce(p_quarantine, '[]'::jsonb)
  );
$fn$;

DO $parent_guard$
DECLARE
  v_parent _t9_routers%ROWTYPE;
  v_other _t9_routers%ROWTYPE;
BEGIN
  SELECT * INTO v_parent FROM _t9_routers WHERE ordinal = 1;
  SELECT * INTO v_other FROM _t9_routers WHERE ordinal = 2;
  BEGIN
    INSERT INTO public.network_devices (
      organization_id, building_id, device_kind, external_key,
      display_name, vendor, parent_device_id, sort_order,
      lifecycle_status, write_capability, is_active, inventory_metadata,
      aruba_stable_key, aruba_identity_source, aruba_discovery_state,
      aruba_discovery_first_seen_at, aruba_discovery_last_seen_at
    ) VALUES (
      v_parent.organization_id, v_other.building_id, 'ARUBA',
      'serial:T9-PARENT-GUARD', 'Task 9 invalid parent', 'Aruba',
      v_parent.id, 0, 'ONLINE', false, true, '{}'::jsonb,
      'serial:T9-PARENT-GUARD', 'SERIAL', 'DISCOVERED',
      clock_timestamp(), clock_timestamp()
    );
    RAISE EXCEPTION 'parent guard accepted a cross-building Aruba parent';
  EXCEPTION
    WHEN foreign_key_violation THEN NULL;
  END;
END
$parent_guard$;

DO $run_budget_and_replay$
DECLARE
  v_router _t9_routers%ROWTYPE;
  v_run_id uuid := gen_random_uuid();
  v_second_run_id uuid := gen_random_uuid();
  v_observed_at timestamptz := clock_timestamp();
  v_payload jsonb;
  v_response jsonb;
  v_replay jsonb;
BEGIN
  SELECT * INTO v_router FROM _t9_routers WHERE ordinal = 1;
  SELECT pg_temp.t9_payload(
    v_router.id,
    v_run_id,
    v_observed_at,
    0,
    1,
    jsonb_agg(pg_temp.t9_item(
      'T9RUN' || lpad(series::text, 3, '0'), series
    ) ORDER BY series)
  ) INTO v_payload
  FROM generate_series(1, 65) series;

  SELECT public.network_center_worker_inventory_v2(
    (SELECT fixture.credential_digest FROM _ncmr_fixture fixture), v_payload
  ) INTO v_response;
  PERFORM pg_temp.t9_assert(
    (v_response->>'arubaCount')::integer = 64,
    'a discovery run must persist at most 64 new stable identities'
  );
  PERFORM pg_temp.t9_assert(
    (v_response->>'quarantinedCount')::integer = 1,
    'the 65th identity must be quarantined'
  );
  PERFORM pg_temp.t9_assert(
    (SELECT count(*) FROM public.network_devices device
      WHERE device.parent_device_id = v_router.id
        AND device.aruba_stable_key LIKE 'serial:T9RUN%') = 64,
    'exactly 64 Task 9 devices must exist after the bounded run'
  );

  SELECT public.network_center_worker_inventory_v2(
    (SELECT fixture.credential_digest FROM _ncmr_fixture fixture), v_payload
  ) INTO v_replay;
  PERFORM pg_temp.t9_assert(
    v_replay = v_response,
    'an exact discovery batch replay must return the durable response'
  );
  PERFORM pg_temp.t9_assert(
    (SELECT count(*) FROM app_private.network_aruba_quarantine quarantine
      WHERE quarantine.discovery_run_id = v_run_id) = 1,
    'an exact replay must not duplicate quarantine rows'
  );
  BEGIN
    PERFORM public.network_center_worker_inventory_v2(
    (SELECT fixture.credential_digest FROM _ncmr_fixture fixture),
      jsonb_set(v_payload, '{aruba,0,displayName}', '"changed"'::jsonb)
    );
    RAISE EXCEPTION 'changed discovery replay was accepted';
  EXCEPTION
    WHEN unique_violation THEN NULL;
  END;

  SELECT pg_temp.t9_payload(
    v_router.id,
    v_second_run_id,
    clock_timestamp(),
    0,
    1,
    jsonb_build_array(pg_temp.t9_item('T9RUN001', 999)) ||
      (SELECT jsonb_agg(pg_temp.t9_item(
        'T9REF' || lpad(series::text, 3, '0'), 1000 + series
      ) ORDER BY series) FROM generate_series(1, 64) series)
  ) INTO v_payload;
  SELECT public.network_center_worker_inventory_v2(
    (SELECT fixture.credential_digest FROM _ncmr_fixture fixture), v_payload
  ) INTO v_response;
  PERFORM pg_temp.t9_assert(
    (v_response->>'arubaCount')::integer = 65
      AND (v_response->>'quarantinedCount')::integer = 0,
    'refreshing an existing identity must not consume the 64-new run budget'
  );
  PERFORM pg_temp.t9_assert(
    (SELECT new_identity_count
      FROM app_private.network_aruba_discovery_runs
      WHERE discovery_run_id = v_second_run_id) = 64,
    'only new stable identities may increment discovery-run admission'
  );
  PERFORM pg_temp.t9_assert(
    (SELECT sort_order FROM public.network_devices device
      WHERE device.parent_device_id = v_router.id
        AND device.aruba_stable_key = 'serial:T9RUN001') = 1,
    'refreshes must preserve durable sort order for keyset cursors'
  );
END
$run_budget_and_replay$;

DO $router_scoped_identity$
DECLARE
  v_router _t9_routers%ROWTYPE;
  v_response jsonb;
BEGIN
  SELECT * INTO v_router FROM _t9_routers WHERE ordinal = 2;
  SELECT public.network_center_worker_inventory_v2(
    (SELECT fixture.credential_digest FROM _ncmr_fixture fixture),
    pg_temp.t9_payload(
      v_router.id, gen_random_uuid(), clock_timestamp(), 0, 1,
      jsonb_build_array(pg_temp.t9_item('T9RUN001', 1))
    )
  ) INTO v_response;
  PERFORM pg_temp.t9_assert(
    (v_response->>'arubaCount')::integer = 1,
    'the same serial must be accepted under a different router'
  );
  PERFORM pg_temp.t9_assert(
    (SELECT count(*) FROM public.network_devices device
      WHERE device.device_kind = 'ARUBA'
        AND device.aruba_stable_key = 'serial:T9RUN001'
        AND device.parent_device_id IN (
          SELECT id FROM _t9_routers WHERE ordinal IN (1, 2)
        )) = 2,
    'stable identity uniqueness must be router-scoped'
  );
END
$router_scoped_identity$;

DO $enrollment_budget$
DECLARE
  v_router _t9_routers%ROWTYPE;
  v_response jsonb;
BEGIN
  SELECT * INTO v_router FROM _t9_routers WHERE ordinal = 3;
  INSERT INTO app_private.network_aruba_router_state (
    organization_id, building_id, router_device_id,
    enrollment_started_at, last_discovery_at
  ) VALUES (
    v_router.organization_id, v_router.building_id, v_router.id,
    clock_timestamp() - INTERVAL '1 minute', clock_timestamp()
  ) ON CONFLICT (router_device_id) DO UPDATE SET
    organization_id = EXCLUDED.organization_id,
    building_id = EXCLUDED.building_id,
    enrollment_started_at = EXCLUDED.enrollment_started_at,
    last_discovery_at = EXCLUDED.last_discovery_at;

  INSERT INTO public.network_devices (
    organization_id, building_id, device_kind, external_key,
    display_name, vendor, parent_device_id, sort_order,
    lifecycle_status, write_capability, is_active, inventory_metadata,
    aruba_stable_key, aruba_identity_source, aruba_discovery_state,
    aruba_discovery_first_seen_at, aruba_discovery_last_seen_at
  )
  SELECT
    v_router.organization_id, v_router.building_id, 'ARUBA',
    'serial:T9CAP' || lpad(series::text, 3, '0'),
    'Task 9 cap ' || series, 'Aruba', v_router.id, series,
    'ONLINE', false, true, '{}'::jsonb,
    'serial:T9CAP' || lpad(series::text, 3, '0'),
    'SERIAL', 'DISCOVERED', clock_timestamp(), clock_timestamp()
  FROM generate_series(1, 511) series;

  SELECT public.network_center_worker_inventory_v2(
    (SELECT fixture.credential_digest FROM _ncmr_fixture fixture),
    pg_temp.t9_payload(
      v_router.id, gen_random_uuid(), clock_timestamp(), 0, 1,
      jsonb_build_array(
        pg_temp.t9_item('T9CAP512', 512),
        pg_temp.t9_item('T9CAP513', 513)
      )
    )
  ) INTO v_response;
  PERFORM pg_temp.t9_assert(
    (v_response->>'arubaCount')::integer = 1
      AND (v_response->>'quarantinedCount')::integer = 1,
    'the first-day enrollment window must stop at 512 identities'
  );
  PERFORM pg_temp.t9_assert(
    (SELECT count(*) FROM public.network_devices device
      WHERE device.parent_device_id = v_router.id
        AND device.device_kind = 'ARUBA') = 512,
    'the router must retain exactly 512 enrolled identities'
  );
END
$enrollment_budget$;

DO $mature_daily_budget$
DECLARE
  v_limited _t9_routers%ROWTYPE;
  v_eligible _t9_routers%ROWTYPE;
  v_response jsonb;
  v_previous_run uuid := gen_random_uuid();
BEGIN
  SELECT * INTO v_limited FROM _t9_routers WHERE ordinal = 4;
  INSERT INTO app_private.network_aruba_router_state (
    organization_id, building_id, router_device_id,
    enrollment_started_at, last_discovery_at
  ) VALUES (
    v_limited.organization_id, v_limited.building_id, v_limited.id,
    clock_timestamp() - INTERVAL '48 hours', clock_timestamp()
  ) ON CONFLICT (router_device_id) DO UPDATE SET
    organization_id = EXCLUDED.organization_id,
    building_id = EXCLUDED.building_id,
    enrollment_started_at = EXCLUDED.enrollment_started_at,
    last_discovery_at = EXCLUDED.last_discovery_at;
  INSERT INTO public.network_devices (
    organization_id, building_id, device_kind, external_key,
    display_name, vendor, parent_device_id, sort_order,
    lifecycle_status, write_capability, is_active, inventory_metadata,
    aruba_stable_key, aruba_identity_source, aruba_discovery_state,
    aruba_discovery_first_seen_at, aruba_discovery_last_seen_at
  )
  SELECT
    v_limited.organization_id, v_limited.building_id, 'ARUBA',
    'serial:T9DAY' || lpad(series::text, 3, '0'),
    'Task 9 daily ' || series, 'Aruba', v_limited.id, series,
    'ONLINE', false, true, '{}'::jsonb,
    'serial:T9DAY' || lpad(series::text, 3, '0'),
    'SERIAL', 'DISCOVERED',
    clock_timestamp() - INTERVAL '1 hour', clock_timestamp()
  FROM generate_series(1, 128) series;
  INSERT INTO app_private.network_aruba_discovery_candidates (
    organization_id, building_id, router_device_id, stable_key,
    identity_source, external_key, display_name, sort_order, aliases,
    inventory_metadata, first_seen_at, last_seen_at,
    sighting_count, last_discovery_run_id
  ) VALUES (
    v_limited.organization_id, v_limited.building_id, v_limited.id,
    'serial:T9MATURE-LIMIT', 'SERIAL', 'serial:T9MATURE-LIMIT',
    'Task 9 mature limited', 1000, '[]'::jsonb, '{}'::jsonb,
    clock_timestamp() - INTERVAL '11 minutes',
    clock_timestamp() - INTERVAL '1 minute', 3, v_previous_run
  );
  SELECT public.network_center_worker_inventory_v2(
    (SELECT fixture.credential_digest FROM _ncmr_fixture fixture),
    pg_temp.t9_payload(
      v_limited.id, gen_random_uuid(), clock_timestamp(), 0, 1,
      jsonb_build_array(pg_temp.t9_item('T9MATURE-LIMIT', 1000))
    )
  ) INTO v_response;
  PERFORM pg_temp.t9_assert(
    (v_response->>'arubaCount')::integer = 0
      AND (v_response->>'quarantinedCount')::integer = 1,
    'a mature router must stop at 128 new identities per 24 hours'
  );

  SELECT * INTO v_eligible FROM _t9_routers WHERE ordinal = 5;
  INSERT INTO app_private.network_aruba_router_state (
    organization_id, building_id, router_device_id,
    enrollment_started_at, last_discovery_at
  ) VALUES (
    v_eligible.organization_id, v_eligible.building_id, v_eligible.id,
    clock_timestamp() - INTERVAL '48 hours', clock_timestamp()
  ) ON CONFLICT (router_device_id) DO UPDATE SET
    organization_id = EXCLUDED.organization_id,
    building_id = EXCLUDED.building_id,
    enrollment_started_at = EXCLUDED.enrollment_started_at,
    last_discovery_at = EXCLUDED.last_discovery_at;
  INSERT INTO app_private.network_aruba_discovery_candidates (
    organization_id, building_id, router_device_id, stable_key,
    identity_source, external_key, display_name, sort_order, aliases,
    inventory_metadata, first_seen_at, last_seen_at,
    sighting_count, last_discovery_run_id
  ) VALUES (
    v_eligible.organization_id, v_eligible.building_id, v_eligible.id,
    'serial:T9MATURE-OK', 'SERIAL', 'serial:T9MATURE-OK',
    'Task 9 mature eligible', 1, '[]'::jsonb, '{}'::jsonb,
    clock_timestamp() - INTERVAL '11 minutes',
    clock_timestamp() - INTERVAL '1 minute', 2, gen_random_uuid()
  );
  SELECT public.network_center_worker_inventory_v2(
    (SELECT fixture.credential_digest FROM _ncmr_fixture fixture),
    pg_temp.t9_payload(
      v_eligible.id, gen_random_uuid(), clock_timestamp(), 0, 1,
      jsonb_build_array(pg_temp.t9_item('T9MATURE-OK', 1))
    )
  ) INTO v_response;
  PERFORM pg_temp.t9_assert(
    (v_response->>'arubaCount')::integer = 1
      AND (v_response->>'quarantinedCount')::integer = 0,
    'three sightings across ten minutes must admit a mature identity below cap'
  );
END
$mature_daily_budget$;

DO $quarantine_bound$
DECLARE
  v_router _t9_routers%ROWTYPE;
  v_run_id uuid := gen_random_uuid();
BEGIN
  SELECT * INTO v_router FROM _t9_routers WHERE ordinal = 8;
  INSERT INTO app_private.network_aruba_router_state (
    organization_id, building_id, router_device_id,
    enrollment_started_at, last_discovery_at
  ) VALUES (
    v_router.organization_id, v_router.building_id, v_router.id,
    clock_timestamp(), clock_timestamp()
  ) ON CONFLICT (router_device_id) DO UPDATE SET
    organization_id = EXCLUDED.organization_id,
    building_id = EXCLUDED.building_id,
    enrollment_started_at = EXCLUDED.enrollment_started_at,
    last_discovery_at = EXCLUDED.last_discovery_at;
  INSERT INTO app_private.network_aruba_discovery_runs (
    discovery_run_id, organization_id, building_id, router_device_id,
    observed_at, batch_count
  ) VALUES (
    v_run_id, v_router.organization_id, v_router.building_id,
    v_router.id, clock_timestamp(), 1
  );
  INSERT INTO app_private.network_aruba_quarantine (
    organization_id, building_id, router_device_id,
    discovery_run_id, batch_index, reason_code, fingerprint, observed_at
  )
  SELECT
    v_router.organization_id, v_router.building_id, v_router.id,
    v_run_id, 0, 'ARUBA_ITEM_INVALID',
    encode(extensions.digest(convert_to(series::text, 'UTF8'), 'sha256'), 'hex'),
    clock_timestamp() + series * INTERVAL '1 microsecond'
  FROM generate_series(1, 1005) series;
  PERFORM public.network_center_worker_inventory_v2(
    (SELECT fixture.credential_digest FROM _ncmr_fixture fixture),
    pg_temp.t9_payload(
      v_router.id, gen_random_uuid(), clock_timestamp(), 0, 1, '[]'::jsonb
    )
  );
  PERFORM pg_temp.t9_assert(
    (SELECT count(*) FROM app_private.network_aruba_quarantine quarantine
      WHERE quarantine.router_device_id = v_router.id) = 1000,
    'quarantine must retain at most 1000 rows per router'
  );
END
$quarantine_bound$;

CREATE OR REPLACE FUNCTION app_private.network_center_require_view_v1(
  p_building_id uuid
)
RETURNS TABLE (organization_id uuid, building_name text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fixture$
  SELECT building.organization_id, building.name
  FROM public.buildings building
  WHERE building.id = p_building_id
    AND building.deleted_at IS NULL
    AND building.is_virtual = false;
$fixture$;

DO $pagination$
DECLARE
  v_router _t9_routers%ROWTYPE;
  v_page jsonb;
  v_cursor jsonb;
  v_seen uuid[] := ARRAY[]::uuid[];
  v_page_count integer := 0;
  v_existing_count integer;
  v_original_sort integer;
BEGIN
  SELECT * INTO v_router FROM _t9_routers WHERE ordinal = 6;
  SELECT count(*) INTO v_existing_count
  FROM public.network_devices device
  WHERE device.building_id = v_router.building_id
    AND device.device_kind = 'ARUBA'
    AND device.is_active;
  INSERT INTO public.network_devices (
    organization_id, building_id, device_kind, external_key,
    display_name, vendor, parent_device_id, sort_order,
    lifecycle_status, write_capability, is_active, inventory_metadata,
    aruba_stable_key, aruba_identity_source, aruba_discovery_state,
    aruba_discovery_first_seen_at, aruba_discovery_last_seen_at
  )
  SELECT
    v_router.organization_id, v_router.building_id, 'ARUBA',
    'serial:T9PAGE' || lpad(series::text, 3, '0'),
    'Task 9 page ' || series, 'Aruba', v_router.id, series - 1,
    'ONLINE', false, true, '{}'::jsonb,
    'serial:T9PAGE' || lpad(series::text, 3, '0'),
    'SERIAL', 'DISCOVERED', clock_timestamp(), clock_timestamp()
  FROM generate_series(1, 253) series;

  LOOP
    SELECT public.network_center_list_aruba_v1(
      v_router.building_id,
      CASE WHEN v_cursor IS NULL THEN NULL
        ELSE (v_cursor->>'sortOrder')::integer END,
      CASE WHEN v_cursor IS NULL THEN NULL
        ELSE (v_cursor->>'id')::uuid END,
      100
    ) INTO v_page;
    v_page_count := v_page_count + 1;
    IF EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_page->'items') item
      WHERE (item->>'id')::uuid = ANY(v_seen)
    ) THEN
      RAISE EXCEPTION 'TASK9_RUNTIME_ASSERTION: keyset page repeated a row';
    END IF;
    SELECT v_seen || coalesce(array_agg((item->>'id')::uuid), ARRAY[]::uuid[])
    INTO v_seen
    FROM jsonb_array_elements(v_page->'items') item;
    v_cursor := v_page->'nextCursor';
    EXIT WHEN v_cursor IS NULL OR jsonb_typeof(v_cursor) = 'null';
  END LOOP;
  PERFORM pg_temp.t9_assert(
    v_page_count = ceil((v_existing_count + 253)::numeric / 100)::integer
      AND cardinality(v_seen) = v_existing_count + 253
      AND (
        SELECT count(*)
        FROM public.network_devices device
        WHERE device.id = ANY(v_seen)
          AND device.parent_device_id = v_router.id
          AND device.aruba_stable_key LIKE 'serial:T9PAGE%'
      ) = 253,
    '253 Aruba rows must require exactly three bounded keyset pages'
  );
  BEGIN
    PERFORM public.network_center_list_aruba_v1(
      v_router.building_id, NULL, NULL, NULL
    );
    RAISE EXCEPTION 'NULL page limit was accepted';
  EXCEPTION
    WHEN invalid_parameter_value THEN NULL;
  END;

  SELECT sort_order INTO v_original_sort
  FROM public.network_devices device
  WHERE device.parent_device_id = v_router.id
    AND device.aruba_stable_key = 'serial:T9PAGE001';
  PERFORM public.network_center_worker_inventory_v2(
    (SELECT fixture.credential_digest FROM _ncmr_fixture fixture),
    pg_temp.t9_payload(
      v_router.id, gen_random_uuid(), clock_timestamp(), 0, 1,
      jsonb_build_array(pg_temp.t9_item('T9PAGE001', 999999))
    )
  );
  PERFORM pg_temp.t9_assert(
    (SELECT sort_order FROM public.network_devices device
      WHERE device.parent_device_id = v_router.id
        AND device.aruba_stable_key = 'serial:T9PAGE001') = v_original_sort,
    'neighbor order changes must not mutate the durable keyset position'
  );
END
$pagination$;

DO $retention$
DECLARE
  v_router _t9_routers%ROWTYPE;
  v_discovered_id uuid;
  v_pinned_id uuid;
  v_now timestamptz := clock_timestamp();
  v_result jsonb;
BEGIN
  SELECT * INTO v_router FROM _t9_routers WHERE ordinal = 7;
  INSERT INTO public.network_devices (
    organization_id, building_id, device_kind, external_key,
    display_name, vendor, parent_device_id, sort_order,
    lifecycle_status, write_capability, is_active, inventory_metadata,
    aruba_stable_key, aruba_identity_source, aruba_discovery_state,
    aruba_discovery_first_seen_at, aruba_discovery_last_seen_at
  ) VALUES
  (
    v_router.organization_id, v_router.building_id, 'ARUBA',
    'serial:T9RET-DISCOVERED', 'Task 9 old discovery', 'Aruba',
    v_router.id, 1, 'ONLINE', false, true, '{}'::jsonb,
    'serial:T9RET-DISCOVERED', 'SERIAL', 'DISCOVERED',
    v_now - INTERVAL '40 days', v_now - INTERVAL '31 days'
  ),
  (
    v_router.organization_id, v_router.building_id, 'ARUBA',
    'serial:T9RET-PINNED', 'Task 9 pinned', 'Aruba',
    v_router.id, 2, 'ONLINE', false, true, '{}'::jsonb,
    'serial:T9RET-PINNED', 'SERIAL', 'PINNED',
    v_now - INTERVAL '40 days', v_now - INTERVAL '31 days'
  );

  SELECT id INTO v_discovered_id
  FROM public.network_devices
  WHERE parent_device_id = v_router.id
    AND aruba_stable_key = 'serial:T9RET-DISCOVERED';
  SELECT id INTO v_pinned_id
  FROM public.network_devices
  WHERE parent_device_id = v_router.id
    AND aruba_stable_key = 'serial:T9RET-PINNED';
  INSERT INTO app_private.network_aruba_aliases (
    organization_id, building_id, router_device_id, stable_key,
    alias, first_seen_at, last_seen_at, tombstoned_at
  ) VALUES (
    v_router.organization_id, v_router.building_id, v_router.id,
    'serial:T9RET-ORPHAN', 'old-alias',
    v_now - INTERVAL '40 days', v_now - INTERVAL '31 days', NULL
  );

  SELECT app_private.network_center_aruba_retention_v1(v_now)
  INTO v_result;
  PERFORM pg_temp.t9_assert(
    NOT EXISTS (SELECT 1 FROM public.network_devices WHERE id = v_discovered_id),
    'discovery-only Aruba older than 30 days must be purged'
  );
  PERFORM pg_temp.t9_assert(
    EXISTS (SELECT 1 FROM public.network_devices WHERE id = v_pinned_id),
    'operator-pinned Aruba must survive discovery retention'
  );
  PERFORM pg_temp.t9_assert(
    (SELECT tombstoned_at IS NOT NULL
      FROM app_private.network_aruba_aliases
      WHERE router_device_id = v_router.id
        AND stable_key = 'serial:T9RET-ORPHAN'
        AND alias = 'old-alias'),
    'orphan aliases older than 30 days must be tombstoned'
  );
  PERFORM pg_temp.t9_assert(
    (v_result->>'aruba_discovery_retention_days')::integer = 30
      AND (v_result->>'aruba_alias_retention_days')::integer = 90
      AND (v_result->>'aruba_quarantine_per_router')::integer = 1000,
    'retention readback must expose the fixed Task 9 lifecycle bounds'
  );
END
$retention$;

SELECT jsonb_build_object(
  'status', 'PASS',
  'proofs', jsonb_build_array(
    'parent_guard',
    '64_new_per_run',
    'exact_replay',
    'router_scoped_identity',
    '512_enrollment',
    '128_per_day',
    'three_sightings_ten_minutes',
    'quarantine_1000',
    'keyset_253_rows',
    'durable_sort_order',
    'discovery_retention',
    'pinned_retention',
    'alias_tombstone'
  )
) AS task9_runtime_proof;

ROLLBACK;
