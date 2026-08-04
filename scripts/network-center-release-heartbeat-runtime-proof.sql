BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE OR REPLACE FUNCTION pg_temp.ncrr_assert(
  p_condition boolean,
  p_message text
)
RETURNS void
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF coalesce(p_condition, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'NETWORK_CENTER_RELEASE_READBACK_ASSERTION: %', p_message;
  END IF;
END;
$fn$;

CREATE TEMP TABLE _ncrr_fixture (
  worker_key text PRIMARY KEY,
  secret_digest text NOT NULL,
  organization_id uuid NOT NULL,
  building_id uuid NOT NULL,
  device_id uuid NOT NULL,
  alternate_device_id uuid NOT NULL,
  replacement_device_id uuid NOT NULL
) ON COMMIT DROP;

DO $fixture$
DECLARE
  v_worker_key text := 'release-proof-' || substr(
    replace(gen_random_uuid()::text, '-', ''), 1, 16
  );
  v_secret_digest text := encode(
    extensions.digest(
      convert_to(gen_random_uuid()::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );
  v_organization_id uuid := 'dddd0000-0000-4000-8000-000000000001';
  v_building_id uuid := gen_random_uuid();
  v_device_id uuid := gen_random_uuid();
  v_alternate_device_id uuid := gen_random_uuid();
  v_replacement_device_id uuid := gen_random_uuid();
  v_user_id uuid;
BEGIN
  SELECT building.user_id
  INTO v_user_id
  FROM public.buildings building
  WHERE building.organization_id = v_organization_id
    AND building.deleted_at IS NULL
  ORDER BY building.id
  LIMIT 1;

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'A DEMO building owner is required for rollback-only release proof';
  END IF;

  INSERT INTO public.buildings (
    id,
    user_id,
    name,
    province,
    district,
    ward,
    organization_id
  ) VALUES (
    v_building_id,
    v_user_id,
    'Release heartbeat rollback proof ' || substr(v_building_id::text, 1, 8),
    'DEMO',
    'DEMO',
    'DEMO',
    v_organization_id
  );

  INSERT INTO public.network_devices (
    id,
    organization_id,
    building_id,
    device_kind,
    external_key,
    display_name,
    vendor,
    lifecycle_status,
    write_capability,
    is_active
  ) VALUES
    (
      v_device_id,
      v_organization_id,
      v_building_id,
      'MIKROTIK',
      'release-proof-' || replace(v_device_id::text, '-', ''),
      'Release heartbeat rollback proof',
      'MikroTik',
      'ONLINE',
      false,
      true
    ),
    (
      v_alternate_device_id,
      v_organization_id,
      v_building_id,
      'MIKROTIK',
      'release-proof-' || replace(v_alternate_device_id::text, '-', ''),
      'Release heartbeat alternate device',
      'MikroTik',
      'OFFLINE',
      false,
      false
    ),
    (
      v_replacement_device_id,
      v_organization_id,
      v_building_id,
      'MIKROTIK',
      'release-proof-' || replace(v_replacement_device_id::text, '-', ''),
      'Release heartbeat replacement device',
      'MikroTik',
      'OFFLINE',
      false,
      false
    );

  INSERT INTO pg_temp._ncrr_fixture (
    worker_key,
    secret_digest,
    organization_id,
    building_id,
    device_id,
    alternate_device_id,
    replacement_device_id
  ) VALUES (
    v_worker_key,
    v_secret_digest,
    v_organization_id,
    v_building_id,
    v_device_id,
    v_alternate_device_id,
    v_replacement_device_id
  );

  PERFORM public.network_center_admin_provision_worker_v1(
    v_worker_key,
    'Release heartbeat rollback proof',
    v_secret_digest,
    'sha256:' || substr(v_secret_digest, 1, 24),
    clock_timestamp() + INTERVAL '1 day',
    jsonb_build_array(jsonb_build_object(
      'organizationId', v_organization_id,
      'buildingId', v_building_id,
      'deviceId', v_device_id,
      'canPoll', true,
      'canInventory', true,
      'canExecute', false
    ))
  );

  INSERT INTO public.network_worker_assignments (
    worker_id,
    organization_id,
    building_id,
    device_id,
    device_kind,
    can_poll,
    can_inventory,
    can_execute,
    active_from,
    active_until,
    assignment_version,
    created_by,
    updated_by
  )
  SELECT worker.id,
    v_organization_id,
    v_building_id,
    v_alternate_device_id,
    'MIKROTIK',
    false,
    true,
    false,
    clock_timestamp() - INTERVAL '1 hour',
    clock_timestamp() + INTERVAL '1 day',
    7,
    'release-readback-proof',
    'release-readback-proof'
  FROM public.network_workers worker
  WHERE worker.worker_key = v_worker_key;
END;
$fixture$;

GRANT SELECT ON pg_temp._ncrr_fixture TO service_role;

SET LOCAL ROLE service_role;

SELECT public.network_center_worker_heartbeat_v2(
  (SELECT secret_digest FROM pg_temp._ncrr_fixture),
  repeat('1', 40),
  ARRAY['routeros-ssh', 'polling'],
  'ONLINE',
  0,
  jsonb_build_object(
    'source', 'release-proof-old',
    'connections', 1,
    'successfulPolls', 1,
    'failedPolls', 0
  ),
  clock_timestamp() - INTERVAL '1 minute'
);

SELECT public.network_center_worker_heartbeat_v2(
  (SELECT secret_digest FROM pg_temp._ncrr_fixture),
  repeat('2', 40),
  ARRAY['routeros-ssh', 'polling'],
  'PAUSED',
  0,
  jsonb_build_object(
    'source', 'release-proof-candidate',
    'connections', 1,
    'successfulPolls', 1,
    'failedPolls', 0
  ),
  clock_timestamp() - INTERVAL '1 minute'
);

SELECT public.network_center_admin_release_status_v1(200);

DO $direct_table_denial$
DECLARE
  v_denied boolean := false;
BEGIN
  BEGIN
    EXECUTE 'SELECT count(*) FROM app_private.network_worker_release_heartbeats';
  EXCEPTION WHEN insufficient_privilege THEN
    v_denied := true;
  END;
  IF NOT v_denied THEN
    RAISE EXCEPTION 'service_role unexpectedly read the private release table';
  END IF;
END;
$direct_table_denial$;

RESET ROLE;

CREATE TEMP TABLE _ncrr_pre_invalid_state ON COMMIT DROP AS
SELECT (
    SELECT count(*)
    FROM app_private.network_worker_release_heartbeats heartbeat
    JOIN public.network_workers worker ON worker.id = heartbeat.worker_id
    JOIN pg_temp._ncrr_fixture fixture
      ON fixture.worker_key = worker.worker_key
  ) AS release_row_count,
  (
    SELECT max(heartbeat.updated_at)
    FROM app_private.network_worker_release_heartbeats heartbeat
    JOIN public.network_workers worker ON worker.id = heartbeat.worker_id
    JOIN pg_temp._ncrr_fixture fixture
      ON fixture.worker_key = worker.worker_key
  ) AS release_updated_at,
  (
    SELECT jsonb_agg(to_jsonb(building_status) ORDER BY building_status.building_id)
    FROM public.network_worker_building_status building_status
    JOIN pg_temp._ncrr_fixture fixture
      ON fixture.organization_id = building_status.organization_id
      AND fixture.building_id = building_status.building_id
  ) AS building_status_rows;

SET LOCAL ROLE service_role;

DO $invalid_release_versions$
DECLARE
  v_version text;
  v_rejected boolean;
BEGIN
  FOREACH v_version IN ARRAY ARRAY[
    upper(repeat('a', 40)),
    repeat('a', 39),
    repeat('a', 41),
    repeat('g', 40),
    ' ' || repeat('a', 40),
    repeat('a', 40) || E'\n'
  ] LOOP
    v_rejected := false;
    BEGIN
      PERFORM public.network_center_worker_heartbeat_v2(
        (SELECT secret_digest FROM pg_temp._ncrr_fixture),
        v_version,
        ARRAY['routeros-ssh', 'polling'],
        'STOPPING',
        0,
        jsonb_build_object('source', 'invalid-release-proof'),
        clock_timestamp() - INTERVAL '1 minute'
      );
    EXCEPTION WHEN invalid_parameter_value THEN
      v_rejected := true;
    END;
    IF NOT v_rejected THEN
      RAISE EXCEPTION 'invalid worker heartbeat version was accepted: %',
        quote_literal(v_version);
    END IF;

    v_rejected := false;
    BEGIN
      PERFORM public.network_center_admin_worker_release_status_v1(
        (SELECT worker_key FROM pg_temp._ncrr_fixture),
        v_version
      );
    EXCEPTION WHEN invalid_parameter_value THEN
      v_rejected := true;
    END;
    IF NOT v_rejected THEN
      RAISE EXCEPTION 'invalid release readback version was accepted: %',
        quote_literal(v_version);
    END IF;
  END LOOP;
END;
$invalid_release_versions$;

RESET ROLE;

DO $invalid_core_release_versions$
DECLARE
  v_version text;
  v_rejected boolean;
BEGIN
  FOREACH v_version IN ARRAY ARRAY[
    upper(repeat('a', 40)),
    repeat('a', 39),
    repeat('a', 41),
    repeat('g', 40),
    ' ' || repeat('a', 40),
    repeat('a', 40) || E'\n'
  ] LOOP
    v_rejected := false;
    BEGIN
      PERFORM app_private.network_center_worker_heartbeat_core_v2(
        (SELECT secret_digest FROM pg_temp._ncrr_fixture),
        v_version,
        ARRAY['routeros-ssh', 'polling'],
        'STOPPING',
        0,
        jsonb_build_object('source', 'invalid-core-release-proof'),
        clock_timestamp() - INTERVAL '1 minute'
      );
    EXCEPTION WHEN invalid_parameter_value THEN
      v_rejected := true;
    END;
    IF NOT v_rejected THEN
      RAISE EXCEPTION 'invalid private core heartbeat version was accepted: %',
        quote_literal(v_version);
    END IF;
  END LOOP;
END;
$invalid_core_release_versions$;

DO $invalid_versions_are_non_mutating$
DECLARE
  v_release_row_count bigint;
  v_release_updated_at timestamptz;
  v_building_status_rows jsonb;
BEGIN
  SELECT count(*), max(heartbeat.updated_at)
  INTO v_release_row_count, v_release_updated_at
  FROM app_private.network_worker_release_heartbeats heartbeat
  JOIN public.network_workers worker ON worker.id = heartbeat.worker_id
  JOIN pg_temp._ncrr_fixture fixture
    ON fixture.worker_key = worker.worker_key;

  SELECT jsonb_agg(to_jsonb(building_status) ORDER BY building_status.building_id)
  INTO v_building_status_rows
  FROM public.network_worker_building_status building_status
  JOIN pg_temp._ncrr_fixture fixture
    ON fixture.organization_id = building_status.organization_id
    AND fixture.building_id = building_status.building_id;

  PERFORM pg_temp.ncrr_assert(
    EXISTS (
      SELECT 1
      FROM pg_temp._ncrr_pre_invalid_state baseline
      WHERE baseline.release_row_count = v_release_row_count
        AND baseline.release_updated_at = v_release_updated_at
        AND baseline.building_status_rows = v_building_status_rows
    ),
    'invalid release versions must fail with 22023 before any heartbeat mutation'
  );
END;
$invalid_versions_are_non_mutating$;

DO $version_isolation$
DECLARE
  v_worker_id uuid;
  v_worker_key text;
  v_release_status jsonb;
  v_fixture_release_heartbeats jsonb;
  v_keyed_release_status jsonb;
  v_missing_release_status jsonb;
  v_active_assigned_building_count integer;
  v_active_assignment_count integer;
  v_active_assignment_hash text;
  v_previous_assignment_hash text;
  v_mutated_release_status jsonb;
BEGIN
  SELECT worker.id, worker.worker_key
  INTO v_worker_id, v_worker_key
  FROM public.network_workers worker
  JOIN pg_temp._ncrr_fixture fixture
    ON fixture.worker_key = worker.worker_key;

  PERFORM pg_temp.ncrr_assert(
    (
      SELECT count(*) = 2
      FROM app_private.network_worker_release_heartbeats heartbeat
      WHERE heartbeat.worker_id = v_worker_id
    ),
    'two releases sharing one worker must retain independent rows'
  );
  PERFORM pg_temp.ncrr_assert(
    EXISTS (
      SELECT 1
      FROM app_private.network_worker_release_heartbeats heartbeat
      WHERE heartbeat.worker_id = v_worker_id
        AND heartbeat.worker_version = repeat('1', 40)
        AND heartbeat.status = 'ONLINE'
    ) AND EXISTS (
      SELECT 1
      FROM app_private.network_worker_release_heartbeats heartbeat
      WHERE heartbeat.worker_id = v_worker_id
        AND heartbeat.worker_version = repeat('2', 40)
        AND heartbeat.status = 'PAUSED'
    ),
    'old and candidate release states must not overwrite each other'
  );

  v_release_status := public.network_center_admin_release_status_v1(200);
  SELECT coalesce(jsonb_agg(item ORDER BY item->>'workerVersion'), '[]'::jsonb)
  INTO v_fixture_release_heartbeats
  FROM jsonb_array_elements(v_release_status->'releaseHeartbeats') item
  WHERE item->>'workerKey' = v_worker_key;
  v_keyed_release_status := public.network_center_admin_worker_release_status_v1(
    v_worker_key,
    repeat('2', 40)
  );
  v_missing_release_status := public.network_center_admin_worker_release_status_v1(
    v_worker_key,
    repeat('f', 40)
  );
  PERFORM pg_temp.ncrr_assert(
    jsonb_typeof(v_release_status->'releaseHeartbeats') = 'array'
      AND jsonb_array_length(v_release_status->'releaseHeartbeats') BETWEEN 2 AND 200
      AND jsonb_array_length(v_fixture_release_heartbeats) = 2,
    'release status must return a bounded array'
  );
  PERFORM pg_temp.ncrr_assert(
    NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(
        v_fixture_release_heartbeats
      ) item
      WHERE item->>'workerKey' <> v_worker_key
        OR NOT (item ?& ARRAY[
          'workerKey', 'displayName', 'workerVersion', 'status',
          'heartbeatAt', 'startedAt', 'assignedBuildingCount',
          'connectionCount', 'successfulPollCount', 'failedPollCount',
          'pollObservedAt'
        ])
        OR item ?| ARRAY[
          'credentialDigest', 'secretDigest', 'credentialFingerprint',
          'safeMetadata'
        ]
    ),
    'release status shape must be exact and secret-free'
  );

  WITH effective_assignments AS MATERIALIZED (
    SELECT assignment.organization_id,
      assignment.building_id,
      concat_ws(
        '|',
        'network-worker-assignment-v1',
        assignment.id::text,
        assignment.worker_id::text,
        assignment.organization_id::text,
        assignment.building_id::text,
        assignment.device_id::text,
        assignment.device_kind,
        assignment.assignment_version::text,
        CASE WHEN assignment.can_poll THEN '1' ELSE '0' END,
        CASE WHEN assignment.can_inventory THEN '1' ELSE '0' END,
        CASE WHEN assignment.can_execute THEN '1' ELSE '0' END,
        to_char(
          assignment.active_from AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        ),
        coalesce(to_char(
          assignment.active_until AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        ), '-')
      ) AS canonical_row
    FROM public.network_worker_assignments assignment
    JOIN public.network_workers worker ON worker.id = assignment.worker_id
    WHERE worker.id = v_worker_id
      AND worker.status IN ('ACTIVE', 'DRAINING')
      AND 'HEARTBEAT' = ANY(worker.capabilities)
      AND assignment.active_from <= clock_timestamp()
      AND (
        assignment.active_until IS NULL
        OR assignment.active_until > clock_timestamp()
      )
      AND (
        assignment.can_poll OR assignment.can_inventory
        OR assignment.can_execute
      )
  )
  SELECT count(DISTINCT (organization_id, building_id))::integer,
    count(*)::integer,
    encode(
      extensions.digest(
        convert_to(coalesce(string_agg(
          canonical_row,
          E'\n' ORDER BY canonical_row COLLATE "C"
        ), ''), 'UTF8'),
        'sha256'
      ),
      'hex'
    )
  INTO v_active_assigned_building_count,
    v_active_assignment_count,
    v_active_assignment_hash
  FROM effective_assignments;

  PERFORM pg_temp.ncrr_assert(
    v_keyed_release_status IS NOT NULL
      AND jsonb_typeof(v_keyed_release_status) = 'object'
      AND (v_keyed_release_status->>'schemaVersion')::integer = 1
      AND v_keyed_release_status->>'workerKey' = v_worker_key
      AND v_keyed_release_status->>'workerVersion' = repeat('2', 40)
      AND (v_keyed_release_status->>'assignedBuildingCount')::integer
        = v_active_assigned_building_count
      AND (v_keyed_release_status->>'activeAssignedBuildingCount')::integer
        = v_active_assigned_building_count
      AND (v_keyed_release_status->>'activeAssignmentCount')::integer
        = v_active_assignment_count
      AND v_keyed_release_status->>'activeAssignmentHash'
        = v_active_assignment_hash
      AND NOT (v_keyed_release_status ?| ARRAY[
        'credentialDigest', 'secretDigest', 'credentialFingerprint',
        'safeMetadata'
      ])
      AND (
        SELECT array_agg(key_name ORDER BY key_name)
        FROM jsonb_object_keys(v_keyed_release_status) key_name
      ) = ARRAY[
        'activeAssignedBuildingCount', 'activeAssignmentCount',
        'activeAssignmentHash',
        'assignedBuildingCount', 'connectionCount', 'displayName',
        'failedPollCount', 'heartbeatAt', 'pollObservedAt', 'schemaVersion',
        'startedAt', 'status', 'successfulPollCount', 'workerKey',
        'workerVersion'
      ],
    'exact keyed readback must return one secret-free row with canonical assignment evidence'
  );
  PERFORM pg_temp.ncrr_assert(
    (v_keyed_release_status->>'assignedBuildingCount')::integer = 1
      AND v_active_assigned_building_count = 1
      AND v_active_assignment_count = 2,
    'two active assignment rows for one building must keep both building counts at one'
  );

  v_previous_assignment_hash := v_active_assignment_hash;

  -- A same-building device swap must change only the full-row digest evidence.
  UPDATE public.network_worker_assignments assignment
  SET device_id = fixture.replacement_device_id
  FROM pg_temp._ncrr_fixture fixture
  WHERE assignment.worker_id = v_worker_id
    AND assignment.device_id = fixture.alternate_device_id;
  v_mutated_release_status := public.network_center_admin_worker_release_status_v1(
    v_worker_key,
    repeat('2', 40)
  );
  PERFORM pg_temp.ncrr_assert(
    (v_mutated_release_status->>'assignedBuildingCount')::integer = 1
      AND (v_mutated_release_status->>'activeAssignedBuildingCount')::integer = 1
      AND (v_mutated_release_status->>'activeAssignmentCount')::integer = 2
      AND v_mutated_release_status->>'activeAssignmentHash'
        <> v_previous_assignment_hash,
    'same-building device swap must change the assignment digest'
  );
  v_previous_assignment_hash := v_mutated_release_status->>'activeAssignmentHash';

  -- A capability change must be visible even when scope cardinality is stable.
  UPDATE public.network_worker_assignments assignment
  SET can_poll = false,
      can_execute = true
  FROM pg_temp._ncrr_fixture fixture
  WHERE assignment.worker_id = v_worker_id
    AND assignment.device_id = fixture.device_id;
  v_mutated_release_status := public.network_center_admin_worker_release_status_v1(
    v_worker_key,
    repeat('2', 40)
  );
  PERFORM pg_temp.ncrr_assert(
    (v_mutated_release_status->>'assignedBuildingCount')::integer = 1
      AND (v_mutated_release_status->>'activeAssignedBuildingCount')::integer = 1
      AND (v_mutated_release_status->>'activeAssignmentCount')::integer = 2
      AND v_mutated_release_status->>'activeAssignmentHash'
        <> v_previous_assignment_hash,
    'capability change must change the assignment digest'
  );
  v_previous_assignment_hash := v_mutated_release_status->>'activeAssignmentHash';

  -- An assignment ID/version/window change must be digest-visible while active.
  UPDATE public.network_worker_assignments assignment
  SET id = gen_random_uuid(),
      assignment_version = assignment.assignment_version + 1,
      active_from = clock_timestamp() - INTERVAL '2 hours',
      active_until = clock_timestamp() + INTERVAL '2 days'
  FROM pg_temp._ncrr_fixture fixture
  WHERE assignment.worker_id = v_worker_id
    AND assignment.device_id = fixture.replacement_device_id;
  v_mutated_release_status := public.network_center_admin_worker_release_status_v1(
    v_worker_key,
    repeat('2', 40)
  );
  PERFORM pg_temp.ncrr_assert(
    (v_mutated_release_status->>'assignedBuildingCount')::integer = 1
      AND (v_mutated_release_status->>'activeAssignedBuildingCount')::integer = 1
      AND (v_mutated_release_status->>'activeAssignmentCount')::integer = 2
      AND v_mutated_release_status->>'activeAssignmentHash'
        <> v_previous_assignment_hash,
    'assignment ID/version/window change must change the assignment digest'
  );
  PERFORM pg_temp.ncrr_assert(
    v_missing_release_status IS NULL,
    'exact keyed readback must return SQL NULL when the release row is absent'
  );
  PERFORM pg_temp.ncrr_assert(
    has_function_privilege(
      'service_role',
      'public.network_center_admin_release_status_v1(integer)',
      'EXECUTE'
    )
      AND NOT has_function_privilege(
        'anon',
        'public.network_center_admin_release_status_v1(integer)',
        'EXECUTE'
      )
      AND NOT has_function_privilege(
        'authenticated',
        'public.network_center_admin_release_status_v1(integer)',
        'EXECUTE'
      ),
    'release status RPC must be service-role-only'
  );
  PERFORM pg_temp.ncrr_assert(
    has_function_privilege(
      'service_role',
      'public.network_center_admin_worker_release_status_v1(text,text)',
      'EXECUTE'
    )
      AND NOT has_function_privilege(
        'anon',
        'public.network_center_admin_worker_release_status_v1(text,text)',
        'EXECUTE'
      )
      AND NOT has_function_privilege(
        'authenticated',
        'public.network_center_admin_worker_release_status_v1(text,text)',
        'EXECUTE'
      ),
    'exact release readback RPC must be service-role-only'
  );
  PERFORM pg_temp.ncrr_assert(
    has_function_privilege(
      'service_role',
      'public.network_center_worker_heartbeat_v2(text,text,text[],text,integer,jsonb,timestamp with time zone)',
      'EXECUTE'
    )
      AND NOT has_function_privilege(
        'anon',
        'public.network_center_worker_heartbeat_v2(text,text,text[],text,integer,jsonb,timestamp with time zone)',
        'EXECUTE'
      )
      AND NOT has_function_privilege(
        'authenticated',
        'public.network_center_worker_heartbeat_v2(text,text,text[],text,integer,jsonb,timestamp with time zone)',
        'EXECUTE'
      )
      AND NOT has_function_privilege(
        'service_role',
        'app_private.network_center_worker_heartbeat_core_v2(text,text,text[],text,integer,jsonb,timestamp with time zone)',
        'EXECUTE'
      )
      AND NOT has_function_privilege(
        'anon',
        'app_private.network_center_worker_heartbeat_core_v2(text,text,text[],text,integer,jsonb,timestamp with time zone)',
        'EXECUTE'
      )
      AND NOT has_function_privilege(
        'authenticated',
        'app_private.network_center_worker_heartbeat_core_v2(text,text,text[],text,integer,jsonb,timestamp with time zone)',
        'EXECUTE'
      )
      AND NOT has_function_privilege(
        'service_role',
        'app_private.network_center_worker_heartbeat_impl_v2(text,text,text[],text,integer,jsonb,timestamp with time zone)',
        'EXECUTE'
      )
      AND NOT has_function_privilege(
        'anon',
        'app_private.network_center_worker_heartbeat_impl_v2(text,text,text[],text,integer,jsonb,timestamp with time zone)',
        'EXECUTE'
      )
      AND NOT has_function_privilege(
        'authenticated',
        'app_private.network_center_worker_heartbeat_impl_v2(text,text,text[],text,integer,jsonb,timestamp with time zone)',
        'EXECUTE'
      ),
    'heartbeat wrapper and private core EXECUTE ACLs must remain closed'
  );
  PERFORM pg_temp.ncrr_assert(
    NOT EXISTS (
      SELECT 1
      FROM pg_proc procedure_row
      JOIN pg_namespace namespace_row
        ON namespace_row.oid = procedure_row.pronamespace
      CROSS JOIN LATERAL aclexplode(coalesce(
        procedure_row.proacl,
        acldefault('f', procedure_row.proowner)
      )) acl_row
      WHERE (
          (
            namespace_row.nspname = 'public'
            AND procedure_row.proname IN (
              'network_center_worker_heartbeat_v2',
              'network_center_admin_release_status_v1',
              'network_center_admin_worker_release_status_v1'
            )
          ) OR (
            namespace_row.nspname = 'app_private'
            AND procedure_row.proname IN (
              'network_center_worker_heartbeat_core_v2',
              'network_center_worker_heartbeat_impl_v2'
            )
          )
        )
        AND acl_row.grantee = 0
        AND acl_row.privilege_type = 'EXECUTE'
    ),
    'release wrapper, readback and core functions must have no PUBLIC EXECUTE grant'
  );
  PERFORM pg_temp.ncrr_assert(
    NOT has_table_privilege(
      'service_role',
      'app_private.network_worker_release_heartbeats',
      'SELECT'
    )
      AND NOT EXISTS (
        SELECT 1
        FROM information_schema.columns column_row
        WHERE column_row.table_schema = 'app_private'
          AND column_row.table_name = 'network_worker_release_heartbeats'
          AND column_row.column_name IN (
            'credential_digest', 'safe_metadata', 'credential_fingerprint'
          )
      ),
    'private storage must deny direct service-role reads and contain no secret columns'
  );
END;
$version_isolation$;

SET LOCAL ROLE service_role;

SELECT public.network_center_worker_heartbeat_v2(
  (SELECT secret_digest FROM pg_temp._ncrr_fixture),
  repeat('1', 40),
  ARRAY['routeros-ssh', 'polling'],
  'DEGRADED',
  0,
  jsonb_build_object(
    'source', 'release-proof-old-replay',
    'connections', 1,
    'successfulPolls', 1,
    'failedPolls', 0
  ),
  clock_timestamp() - INTERVAL '1 minute'
);

RESET ROLE;

DO $old_replay_isolation$
DECLARE
  v_worker_id uuid;
BEGIN
  SELECT worker.id INTO v_worker_id
  FROM public.network_workers worker
  JOIN pg_temp._ncrr_fixture fixture
    ON fixture.worker_key = worker.worker_key;
  PERFORM pg_temp.ncrr_assert(
    EXISTS (
      SELECT 1
      FROM app_private.network_worker_release_heartbeats heartbeat
      WHERE heartbeat.worker_id = v_worker_id
        AND heartbeat.worker_version = repeat('1', 40)
        AND heartbeat.status = 'DEGRADED'
    ) AND EXISTS (
      SELECT 1
      FROM app_private.network_worker_release_heartbeats heartbeat
      WHERE heartbeat.worker_id = v_worker_id
        AND heartbeat.worker_version = repeat('2', 40)
        AND heartbeat.status = 'PAUSED'
    ),
    'an old release replay must not overwrite the candidate release row'
  );

  -- poll_observed_at must age with the row: the all-or-nothing poll metrics
  -- CHECK requires it to stay inside [started_at, heartbeat_at].
  UPDATE app_private.network_worker_release_heartbeats heartbeat
  SET started_at = statement_timestamp() - INTERVAL '32 days',
      heartbeat_at = statement_timestamp() - INTERVAL '31 days',
      poll_observed_at = statement_timestamp() - INTERVAL '31 days',
      updated_at = statement_timestamp() - INTERVAL '31 days'
  WHERE heartbeat.worker_id = v_worker_id
    AND heartbeat.worker_version = repeat('1', 40);
END;
$old_replay_isolation$;

SET LOCAL ROLE service_role;

SELECT public.network_center_worker_heartbeat_v2(
  (SELECT secret_digest FROM pg_temp._ncrr_fixture),
  repeat('2', 40),
  ARRAY['routeros-ssh', 'polling'],
  'PAUSED',
  0,
  jsonb_build_object(
    'source', 'release-proof-retention',
    'connections', 1,
    'successfulPolls', 1,
    'failedPolls', 0
  ),
  clock_timestamp() - INTERVAL '1 minute'
);

RESET ROLE;

-- Release '1' is 31 days stale but is still the immediately preceding release,
-- i.e. exactly what rollback-vultr.ps1 reads back as the rollback target. An
-- age-only purge would have deleted it here and silently disarmed rollback.
SELECT pg_temp.ncrr_assert(
  (
    SELECT count(*) = 2
      AND bool_or(heartbeat.worker_version = repeat('1', 40))
      AND bool_or(heartbeat.worker_version = repeat('2', 40))
    FROM app_private.network_worker_release_heartbeats heartbeat
    JOIN public.network_workers worker ON worker.id = heartbeat.worker_id
    JOIN pg_temp._ncrr_fixture fixture
      ON fixture.worker_key = worker.worker_key
  ),
  'retention must not expire a release that is still a reachable rollback target'
);

-- Displace the stale release beyond the reachable rollback depth with five
-- newer-but-also-expired releases, so age-based cleanup still has something to
-- collect and unbounded growth stays impossible.
DO $displace_reachable_window$
DECLARE
  v_worker_id uuid;
BEGIN
  SELECT worker.id INTO v_worker_id
  FROM public.network_workers worker
  JOIN pg_temp._ncrr_fixture fixture
    ON fixture.worker_key = worker.worker_key;

  INSERT INTO app_private.network_worker_release_heartbeats (
    worker_id, worker_version, status, heartbeat_at, started_at,
    assigned_building_count, updated_at
  )
  SELECT v_worker_id,
    repeat(filler.version_digit, 40),
    'PAUSED',
    clock_timestamp() - INTERVAL '30 days 1 hour'
      - (filler.ordinal * INTERVAL '1 minute'),
    clock_timestamp() - INTERVAL '31 days',
    1,
    clock_timestamp() - INTERVAL '30 days 1 hour'
  FROM (VALUES ('3', 0), ('4', 1), ('5', 2), ('6', 3), ('7', 4))
    AS filler(version_digit, ordinal);
END;
$displace_reachable_window$;

SET LOCAL ROLE service_role;

SELECT public.network_center_worker_heartbeat_v2(
  (SELECT secret_digest FROM pg_temp._ncrr_fixture),
  repeat('2', 40),
  ARRAY['routeros-ssh', 'polling'],
  'PAUSED',
  0,
  jsonb_build_object(
    'source', 'release-proof-retention-displaced',
    'connections', 1,
    'successfulPolls', 1,
    'failedPolls', 0
  ),
  clock_timestamp() - INTERVAL '1 minute'
);

RESET ROLE;

-- Rank 1 is the live release '2'; ranks 2-5 are the four newest fillers and
-- stay reachable; the fifth filler and release '1' are displaced past the
-- reachable depth and are older than 30 days, so both are collected.
SELECT pg_temp.ncrr_assert(
  (
    SELECT count(*) = 5
      AND bool_and(heartbeat.worker_version <> repeat('1', 40))
      AND bool_and(heartbeat.worker_version <> repeat('7', 40))
      AND bool_or(heartbeat.worker_version = repeat('2', 40))
      AND bool_or(heartbeat.worker_version = repeat('3', 40))
      AND bool_or(heartbeat.worker_version = repeat('6', 40))
    FROM app_private.network_worker_release_heartbeats heartbeat
    JOIN public.network_workers worker ON worker.id = heartbeat.worker_id
    JOIN pg_temp._ncrr_fixture fixture
      ON fixture.worker_key = worker.worker_key
  ),
  'successful heartbeat must prune release proof older than 30 days once it is no longer a reachable rollback target'
);

-- A heartbeat carrying JSON null poll counts must fail closed exactly like one
-- carrying no poll keys, and must not refresh the freshness stamp the canary
-- gate trusts. `?|`/`?&` only test key existence, so nulls slip past unless the
-- values themselves are rejected.
CREATE TEMP TABLE _ncrr_poll_freshness (
  worker_version text PRIMARY KEY,
  poll_observed_at timestamptz NOT NULL
) ON COMMIT DROP;

INSERT INTO _ncrr_poll_freshness (worker_version, poll_observed_at)
SELECT heartbeat.worker_version, heartbeat.poll_observed_at
FROM app_private.network_worker_release_heartbeats heartbeat
JOIN public.network_workers worker ON worker.id = heartbeat.worker_id
JOIN pg_temp._ncrr_fixture fixture ON fixture.worker_key = worker.worker_key
WHERE heartbeat.worker_version = repeat('2', 40)
  AND heartbeat.poll_observed_at IS NOT NULL;

SELECT pg_temp.ncrr_assert(
  (SELECT count(*) = 1 FROM pg_temp._ncrr_poll_freshness),
  'null-poll-evidence proof requires a baseline of genuine poll freshness'
);

SET LOCAL ROLE service_role;

DO $null_poll_evidence$
DECLARE
  v_rejected boolean := false;
BEGIN
  BEGIN
    PERFORM public.network_center_worker_heartbeat_v2(
      (SELECT secret_digest FROM pg_temp._ncrr_fixture),
      repeat('2', 40),
      ARRAY['routeros-ssh', 'polling'],
      'PAUSED',
      0,
      jsonb_build_object(
        'source', 'release-proof-null-poll-evidence',
        'connections', NULL,
        'successfulPolls', NULL,
        'failedPolls', NULL
      ),
      clock_timestamp() - INTERVAL '1 minute'
    );
  EXCEPTION WHEN invalid_parameter_value THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'NETWORK_CENTER_RELEASE_READBACK_ASSERTION: %',
      'JSON null poll counts must be rejected exactly like missing poll keys';
  END IF;
END;
$null_poll_evidence$;

RESET ROLE;

SELECT pg_temp.ncrr_assert(
  (
    SELECT count(*) = 1
    FROM app_private.network_worker_release_heartbeats heartbeat
    JOIN public.network_workers worker ON worker.id = heartbeat.worker_id
    JOIN pg_temp._ncrr_fixture fixture ON fixture.worker_key = worker.worker_key
    JOIN pg_temp._ncrr_poll_freshness baseline
      ON baseline.worker_version = heartbeat.worker_version
    WHERE heartbeat.poll_observed_at = baseline.poll_observed_at
      AND heartbeat.connection_count = 1
      AND heartbeat.successful_poll_count = 1
      AND heartbeat.failed_poll_count = 0
  ),
  'a rejected null-poll heartbeat must not refresh poll freshness or poll counts'
);

SELECT jsonb_build_object(
  'status', 'PASS',
  'proofs', jsonb_build_array(
    'service_role_heartbeat',
    'strict_raw_release_sha_and_no_mutation',
    'version_keyed_blue_green_rows',
    'old_release_replay_isolated',
    'exact_secret_free_status_shape',
    'exact_keyed_nullable_release_readback',
    'canonical_active_assignment_count_and_hash',
    'service_role_only_status_rpc',
    'wrapper_core_catalog_acl_denial',
    'direct_table_read_denied',
    'reachable_rollback_target_never_expired',
    'bounded_30_day_cleanup',
    'null_poll_evidence_fails_closed'
  )
) AS network_center_release_heartbeat_runtime_proof;

ROLLBACK;
