\set ON_ERROR_STOP on

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

DO $auth_fixture$
BEGIN
  IF to_regnamespace('auth') IS NULL THEN
    EXECUTE 'CREATE SCHEMA auth';
  END IF;
  IF to_regprocedure('auth.uid()') IS NULL THEN
    EXECUTE $sql$
      CREATE FUNCTION auth.uid()
      RETURNS uuid
      LANGUAGE sql
      STABLE
      AS 'SELECT nullif(current_setting(''request.jwt.claim.sub'', true), '''')::uuid'
    $sql$;
  END IF;
END
$auth_fixture$;

SELECT set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000001',
  true
);

CREATE OR REPLACE FUNCTION pg_temp.t11_assert(
  p_condition boolean,
  p_message text
)
RETURNS void
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF coalesce(p_condition, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'TASK11_RUNTIME_ASSERTION: %', p_message;
  END IF;
END;
$fn$;

INSERT INTO public.organizations (id, slug, name, is_demo)
VALUES (
  '20000000-0000-4000-8000-000000000001',
  'task11-runtime',
  'Task 11 Runtime',
  true
);

INSERT INTO public.buildings (
  id, user_id, organization_id, name, province, district, ward,
  total_floors, total_rooms
) VALUES (
  '30000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000001',
  'Task 11 Building',
  'Runtime', 'Runtime', 'Runtime', 1, 1
);

INSERT INTO public.network_devices (
  id, organization_id, building_id, device_kind, external_key,
  display_name, vendor, lifecycle_status, write_capability,
  credential_ref
) VALUES (
  '40000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000001',
  'MIKROTIK', 'slot:primary', 'Task 11 Router', 'MikroTik',
  'ONLINE', true, 'runtime/task11'
);

INSERT INTO public.network_site_settings (
  organization_id, building_id, changes_paused
) VALUES (
  '20000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000001',
  false
);

SELECT public.network_center_worker_inventory_v1(
  'task11-runtime',
  jsonb_build_object(
    'routerDeviceId', '40000000-0000-4000-8000-000000000001'::uuid,
    'discoveryRunId', '41000000-0000-4000-8000-000000000001'::uuid,
    'observedAt', clock_timestamp(),
    'batchIndex', 0,
    'batchCount', 1,
    'interfaces', jsonb_build_array(jsonb_build_object(
      'interfaceKey', 'ether4',
      'displayName', 'room-401',
      'interfaceKind', 'ETHERNET',
      'interfaceRole', 'ACCESS',
      'isProtected', false,
      'isEnabled', true,
      'sortOrder', 4,
      'metadata', jsonb_build_object(
        'immutableKey', 'ether4',
        'currentName', 'room-401'
      )
    )),
    'aruba', '[]'::jsonb,
    'quarantine', '[]'::jsonb
  )
);

SELECT app_private.network_center_enroll_access_interface_v1(
  managed_resource_id
)
FROM public.network_interfaces
WHERE device_id = '40000000-0000-4000-8000-000000000001'
  AND interface_key = 'ether4';

CREATE TEMP TABLE _t11_commands (
  action_type text PRIMARY KEY,
  command_id uuid NOT NULL
) ON COMMIT DROP;

CREATE OR REPLACE FUNCTION pg_temp.t11_enqueue(
  p_action text,
  p_interface_id uuid,
  p_parameters jsonb,
  p_request_id uuid,
  p_priority smallint DEFAULT 50
)
RETURNS uuid
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_command_id uuid;
BEGIN
  v_command_id := app_private.network_center_enqueue_command_v1(
    '20000000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000001',
    p_interface_id,
    p_action,
    'Task 11 runtime proof',
    p_parameters,
    jsonb_build_object('routerIdentity', 'Task 11 Router'),
    '10000000-0000-4000-8000-000000000001',
    encode(
      extensions.digest(convert_to(p_request_id::text, 'UTF8'), 'sha256'),
      'hex'
    ),
    p_request_id::text,
    clock_timestamp()
  );
  UPDATE public.network_commands
  SET priority = p_priority
  WHERE id = v_command_id;
  INSERT INTO _t11_commands (action_type, command_id)
  VALUES (p_action, v_command_id)
  ON CONFLICT (action_type) DO UPDATE SET command_id = EXCLUDED.command_id;
  RETURN v_command_id;
END;
$fn$;

CREATE OR REPLACE FUNCTION pg_temp.t11_lease(
  p_command_id uuid,
  p_lease_token uuid
)
RETURNS jsonb
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_command public.network_commands%ROWTYPE;
  v_attempt_id uuid;
BEGIN
  SELECT * INTO v_command
  FROM public.network_commands
  WHERE id = p_command_id
  FOR UPDATE;
  INSERT INTO public.network_device_leases (
    device_id, organization_id, building_id, command_id, lease_token,
    lease_owner, acquired_at, heartbeat_at, expires_at, generation
  ) VALUES (
    v_command.device_id, v_command.organization_id, v_command.building_id,
    v_command.id, p_lease_token, 'task11-runtime', v_now, v_now,
    v_now + INTERVAL '90 seconds', 1
  );
  UPDATE public.network_commands command
  SET status = 'LEASED', lease_token = p_lease_token,
      lease_owner = 'task11-runtime',
      lease_expires_at = v_now + INTERVAL '90 seconds',
      attempt_count = command.attempt_count + 1,
      started_at = coalesce(command.started_at, v_now),
      updated_at = v_now
  WHERE command.id = p_command_id
  RETURNING command.* INTO v_command;
  INSERT INTO public.network_command_attempts (
    organization_id, building_id, command_id, device_id, attempt_no,
    worker_id, lease_token, outcome, started_at
  ) VALUES (
    v_command.organization_id, v_command.building_id, v_command.id,
    v_command.device_id, v_command.attempt_count, 'task11-runtime',
    p_lease_token, 'STARTED', v_now
  ) RETURNING id INTO v_attempt_id;
  INSERT INTO public.network_command_events (
    organization_id, building_id, command_id, attempt_id, event_seq,
    event_kind, occurred_at, worker_id, payload
  ) VALUES (
    v_command.organization_id, v_command.building_id, v_command.id,
    v_attempt_id, 1, 'LEASED', v_now, 'task11-runtime',
    jsonb_build_object('attemptNo', v_command.attempt_count)
  );
  RETURN jsonb_build_object(
    'commandId', v_command.id,
    'leaseToken', p_lease_token,
    'fencingGeneration', 1,
    'transitionVersion', v_command.transition_version
  );
END;
$fn$;

SELECT pg_temp.t11_enqueue(
  'FLUSH_DNS_CACHE', NULL, '{}'::jsonb,
  '50000000-0000-4000-8000-000000000001', 100::smallint
);

CREATE TEMP TABLE _t11_claim ON COMMIT DROP AS
SELECT pg_temp.t11_lease(
  (SELECT command_id FROM _t11_commands
   WHERE action_type = 'FLUSH_DNS_CACHE'),
  '61000000-0000-4000-8000-000000000001'
) AS item;

DO $durable_observations$
DECLARE
  v_claim jsonb;
  v_command_id uuid;
  v_lease_token uuid;
  v_generation bigint;
  v_version bigint;
  v_pre_id uuid := '60000000-0000-4000-8000-000000000001';
  v_post_id uuid := '60000000-0000-4000-8000-000000000002';
  v_result jsonb;
  v_count bigint;
BEGIN
  SELECT item INTO v_claim FROM _t11_claim;
  v_command_id := (v_claim->>'commandId')::uuid;
  v_lease_token := (v_claim->>'leaseToken')::uuid;
  v_generation := (v_claim->>'fencingGeneration')::bigint;
  v_version := (v_claim->>'transitionVersion')::bigint;

  PERFORM pg_temp.t11_assert(
    v_command_id = (
      SELECT command_id FROM _t11_commands
      WHERE action_type = 'FLUSH_DNS_CACHE'
    ),
    'priority-100 fixture command must be claimed exactly'
  );

  v_result := app_private.network_center_record_command_observation_v1(
    'task11-runtime', v_command_id, v_lease_token, v_generation,
    v_version, v_pre_id, 'PRE_ACTION', clock_timestamp(),
    jsonb_build_object('reachable', true)
  );
  PERFORM pg_temp.t11_assert(
    (v_result->>'transitionVersion')::bigint = v_version + 1,
    'durable PRE must advance the compare-and-swap version'
  );
  PERFORM pg_temp.t11_assert(
    EXISTS (
      SELECT 1 FROM public.network_command_observations observation
      WHERE observation.id = v_pre_id
        AND observation.observation_kind = 'PRE_ACTION'
        AND observation.evidence_hash ~ '^[a-f0-9]{64}$'
    ) AND (
      SELECT pre_observation IS NOT NULL
      FROM public.network_commands command
      WHERE command.id = v_command_id
    ),
    'PRE evidence must be durable before any POST evidence'
  );

  v_result := app_private.network_center_record_command_observation_v1(
    'task11-runtime', v_command_id, v_lease_token, v_generation,
    v_version, v_pre_id, 'PRE_ACTION',
    (SELECT observed_at FROM public.network_command_observations WHERE id = v_pre_id),
    jsonb_build_object('reachable', true)
  );
  PERFORM pg_temp.t11_assert(
    (v_result->>'duplicate')::boolean,
    'same observation id and evidence must be idempotent'
  );

  BEGIN
    PERFORM app_private.network_center_record_command_observation_v1(
      'task11-runtime', v_command_id, v_lease_token, v_generation,
      v_version, v_pre_id, 'PRE_ACTION',
      (SELECT observed_at FROM public.network_command_observations WHERE id = v_pre_id),
      jsonb_build_object('reachable', false)
    );
    RAISE EXCEPTION 'conflicting duplicate observation was accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  SELECT count(*) INTO v_count
  FROM public.network_command_observations
  WHERE command_id = v_command_id;
  BEGIN
    PERFORM app_private.network_center_record_command_observation_v1(
      'task11-runtime', v_command_id, gen_random_uuid(), v_generation,
      v_version + 1, gen_random_uuid(), 'POST_ACTION', clock_timestamp(),
      jsonb_build_object('dns', jsonb_build_object('commandAck', true))
    );
    RAISE EXCEPTION 'stale lease token was accepted';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;
  END;
  BEGIN
    PERFORM app_private.network_center_record_command_observation_v1(
      'task11-runtime', v_command_id, v_lease_token, v_generation + 1,
      v_version + 1, gen_random_uuid(), 'POST_ACTION', clock_timestamp(),
      jsonb_build_object('dns', jsonb_build_object('commandAck', true))
    );
    RAISE EXCEPTION 'stale fencing generation was accepted';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;
  END;
  PERFORM pg_temp.t11_assert(
    (SELECT count(*) FROM public.network_command_observations
      WHERE command_id = v_command_id) = v_count,
    'stale generation must have no observation side effect'
  );

  BEGIN
    PERFORM app_private.network_center_record_command_observation_v1(
      'task11-runtime', v_command_id, v_lease_token, v_generation,
      v_version, gen_random_uuid(), 'POST_ACTION', clock_timestamp(),
      jsonb_build_object('dns', jsonb_build_object('commandAck', true))
    );
    RAISE EXCEPTION 'stale transition version was accepted';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;
  END;

  v_result := app_private.network_center_record_command_observation_v1(
    'task11-runtime', v_command_id, v_lease_token, v_generation,
    v_version + 1, v_post_id, 'POST_ACTION', clock_timestamp(),
    jsonb_build_object('reachable', true, 'dns', jsonb_build_object(
      'commandAck', true
    ))
  );
  PERFORM pg_temp.t11_assert(
    (v_result->>'transitionVersion')::bigint = v_version + 2,
    'one same-version POST writer must win'
  );
  BEGIN
    PERFORM app_private.network_center_record_command_observation_v1(
      'task11-runtime', v_command_id, v_lease_token, v_generation,
      v_version + 1, gen_random_uuid(), 'POST_ACTION', clock_timestamp(),
      jsonb_build_object('dns', jsonb_build_object('commandAck', true))
    );
    RAISE EXCEPTION 'second same-version POST writer was accepted';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;
  END;

  v_result := app_private.network_center_transition_command_v1(
    'task11-runtime', v_command_id, v_lease_token, v_generation,
    v_version + 2, 'EVALUATE_POSTCONDITION',
    jsonb_build_object('actionType', 'FLUSH_DNS_CACHE'), NULL, 30
  );
  PERFORM pg_temp.t11_assert(
    v_result->>'status' = 'SUCCEEDED'
      AND (SELECT status FROM public.network_commands WHERE id = v_command_id)
        = 'SUCCEEDED',
    'database-owned DNS postcondition must be the only success authority'
  );

  BEGIN
    UPDATE public.network_command_observations
    SET evidence = '{}'::jsonb
    WHERE id = v_pre_id;
    RAISE EXCEPTION 'observation update was accepted';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;
  END;
  BEGIN
    DELETE FROM public.network_command_observations WHERE id = v_pre_id;
    RAISE EXCEPTION 'observation delete was accepted';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;
  END;
END
$durable_observations$;

SELECT pg_temp.t11_enqueue(
  'RENEW_DHCP_LEASE', NULL, '{}'::jsonb,
  '50000000-0000-4000-8000-000000000002', 100::smallint
);

CREATE TEMP TABLE _t11_expired_claim ON COMMIT DROP AS
SELECT pg_temp.t11_lease(
  (SELECT command_id FROM _t11_commands
   WHERE action_type = 'RENEW_DHCP_LEASE'),
  '61000000-0000-4000-8000-000000000002'
) AS item;

DO $expired_lease$
DECLARE
  v_claim jsonb;
  v_count bigint;
BEGIN
  SELECT item INTO v_claim FROM _t11_expired_claim;
  UPDATE public.network_device_leases
  SET acquired_at = clock_timestamp() - INTERVAL '120 seconds',
      heartbeat_at = clock_timestamp() - INTERVAL '120 seconds',
      expires_at = clock_timestamp() - INTERVAL '1 second'
  WHERE command_id = (v_claim->>'commandId')::uuid;
  SELECT count(*) INTO v_count FROM public.network_command_observations;
  BEGIN
    PERFORM app_private.network_center_record_command_observation_v1(
      'task11-runtime',
      (v_claim->>'commandId')::uuid,
      (v_claim->>'leaseToken')::uuid,
      (v_claim->>'fencingGeneration')::bigint,
      (v_claim->>'transitionVersion')::bigint,
      gen_random_uuid(), 'PRE_ACTION', clock_timestamp(),
      jsonb_build_object('reachable', true)
    );
    RAISE EXCEPTION 'expired lease was accepted';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;
  END;
  PERFORM pg_temp.t11_assert(
    (SELECT count(*) FROM public.network_command_observations) = v_count,
    'expired lease rejection must have no side effect'
  );
END
$expired_lease$;

DELETE FROM public.network_device_leases
WHERE command_id = (
  SELECT (item->>'commandId')::uuid FROM _t11_expired_claim
);
UPDATE public.network_command_attempts
SET outcome = 'PERMANENT_FAILURE', retryable = false,
    error_code = 'RUNTIME_FIXTURE_CLOSED', finished_at = clock_timestamp()
WHERE command_id = (
  SELECT (item->>'commandId')::uuid FROM _t11_expired_claim
);
UPDATE public.network_commands
SET status = 'FAILED', lease_token = NULL, lease_owner = NULL,
    lease_expires_at = NULL, result = jsonb_build_object(
      'code', 'RUNTIME_FIXTURE_CLOSED'
    ), reconciliation_state = 'FAILED', finished_at = clock_timestamp(),
    updated_at = clock_timestamp()
WHERE id = (
  SELECT (item->>'commandId')::uuid FROM _t11_expired_claim
);

SELECT pg_temp.t11_enqueue(
  'CYCLE_ACCESS_PORT',
  (SELECT id FROM public.network_interfaces
   WHERE device_id = '40000000-0000-4000-8000-000000000001'
     AND interface_key = 'ether4'),
  jsonb_build_object('durationSeconds', 5),
  '50000000-0000-4000-8000-000000000003'
);
UPDATE public.network_commands
SET status = 'FAILED', started_at = created_at,
    finished_at = clock_timestamp(), result = jsonb_build_object(
      'code', 'RUNTIME_EVALUATOR_FIXTURE'
    ), reconciliation_state = 'FAILED', updated_at = clock_timestamp()
WHERE id = (
  SELECT command_id FROM _t11_commands
  WHERE action_type = 'CYCLE_ACCESS_PORT'
);
SELECT pg_temp.t11_enqueue(
  'REBOOT_ROUTER', NULL, '{}'::jsonb,
  '50000000-0000-4000-8000-000000000004'
);
SELECT pg_temp.t11_enqueue(
  'CAPTURE_SNAPSHOT', NULL, '{}'::jsonb,
  '50000000-0000-4000-8000-000000000005'
);

SELECT public.network_center_worker_snapshot_v1(
  'task11-runtime',
  jsonb_build_object(
    'snapshotId', '70000000-0000-4000-8000-000000000001'::uuid,
    'deviceId', '40000000-0000-4000-8000-000000000001'::uuid,
    'commandId', (SELECT command_id FROM _t11_commands
      WHERE action_type = 'CAPTURE_SNAPSHOT'),
    'source', 'PRE_ACTION',
    'normalizedContent', jsonb_build_object('format', 'routeros-export-v1'),
    'redactedLines', jsonb_build_array('/system identity print'),
    'contentHash', repeat('a', 64),
    'encryptedArtifactHash', repeat('b', 64)
  )
);

DO $typed_postconditions$
DECLARE
  v_command public.network_commands%ROWTYPE;
  v_decision jsonb;
BEGIN
  SELECT * INTO v_command FROM public.network_commands
  WHERE id = (SELECT command_id FROM _t11_commands
    WHERE action_type = 'FLUSH_DNS_CACHE');
  v_decision := app_private.network_center_evaluate_postcondition_v1(
    v_command,
    jsonb_build_object('observedAt', clock_timestamp(), 'reachable', true),
    jsonb_build_object('observedAt', clock_timestamp(), 'reachable', true)
  );
  PERFORM pg_temp.t11_assert(
    v_decision->>'outcome' = 'UNCERTAIN',
    'generic reachability must never prove action success'
  );

  SELECT * INTO v_command FROM public.network_commands
  WHERE id = (SELECT command_id FROM _t11_commands
    WHERE action_type = 'RENEW_DHCP_LEASE');
  v_decision := app_private.network_center_evaluate_postcondition_v1(
    v_command,
    jsonb_build_object('observedAt', clock_timestamp(), 'dhcp', jsonb_build_object(
      'leaseKey', 'wan-dhcp', 'status', 'bound', 'expiresInSeconds', 120
    )),
    jsonb_build_object('observedAt', clock_timestamp(), 'dhcp', jsonb_build_object(
      'leaseKey', 'wan-dhcp', 'status', 'bound', 'expiresInSeconds', 3600
    ))
  );
  PERFORM pg_temp.t11_assert(
    v_decision->>'outcome' = 'SUCCEEDED',
    'DHCP renew requires bound state and newer expiry'
  );
  v_decision := app_private.network_center_evaluate_postcondition_v1(
    v_command, jsonb_build_object('observedAt', clock_timestamp()),
    jsonb_build_object(
      'observedAt', clock_timestamp(),
      'dhcp', jsonb_build_object('notApplicable', true)
    )
  );
  PERFORM pg_temp.t11_assert(
    v_decision->>'outcome' = 'FAILED'
      AND v_decision->>'code' = 'DHCP_RENEW_NOT_APPLICABLE',
    'DHCP not-applicable must use the exact typed terminal code'
  );

  SELECT * INTO v_command FROM public.network_commands
  WHERE id = (SELECT command_id FROM _t11_commands
    WHERE action_type = 'CYCLE_ACCESS_PORT');
  v_decision := app_private.network_center_evaluate_postcondition_v1(
    v_command, jsonb_build_object('observedAt', clock_timestamp()),
    jsonb_build_object(
      'observedAt', clock_timestamp(),
      'accessInterface', jsonb_build_object(
      'managedResourceId', v_command.managed_target->>'managedResourceId',
      'immutableKey', v_command.managed_target->>'immutableKey',
      'disabledObserved', true,
      'enabledObserved', true,
      'enabled', true
    ))
  );
  PERFORM pg_temp.t11_assert(
    v_decision->>'outcome' = 'SUCCEEDED',
    'access cycle requires immutable identity and ordered disable/enable evidence'
  );

  SELECT * INTO v_command FROM public.network_commands
  WHERE id = (SELECT command_id FROM _t11_commands
    WHERE action_type = 'REBOOT_ROUTER');
  v_decision := app_private.network_center_evaluate_postcondition_v1(
    v_command,
    jsonb_build_object('observedAt', clock_timestamp(), 'boot', jsonb_build_object(
      'bootId', 'boot-1', 'uptimeSeconds', 86400
    )),
    jsonb_build_object('observedAt', clock_timestamp(), 'boot', jsonb_build_object(
      'bootId', 'boot-2', 'uptimeSeconds', 15
    ))
  );
  PERFORM pg_temp.t11_assert(
    v_decision->>'outcome' = 'SUCCEEDED',
    'reboot requires a new boot identity and lower uptime'
  );

  SELECT * INTO v_command FROM public.network_commands
  WHERE id = (SELECT command_id FROM _t11_commands
    WHERE action_type = 'CAPTURE_SNAPSHOT');
  v_decision := app_private.network_center_evaluate_postcondition_v1(
    v_command, jsonb_build_object('observedAt', clock_timestamp()),
    jsonb_build_object(
      'observedAt', clock_timestamp(),
      'snapshot', jsonb_build_object(
      'redactedContentHash', repeat('a', 64),
      'encryptedArtifactHash', repeat('b', 64)
    ))
  );
  PERFORM pg_temp.t11_assert(
    v_decision->>'outcome' = 'SUCCEEDED'
      AND EXISTS (
        SELECT 1 FROM public.network_config_snapshots snapshot
        WHERE snapshot.command_id = v_command.id
          AND snapshot.content_hash = repeat('a', 64)
          AND snapshot.encrypted_artifact_hash = repeat('b', 64)
      ),
    'snapshot success requires both hashes on the authoritative row'
  );
END
$typed_postconditions$;

DO $retention_order$
DECLARE
  v_command_id uuid := (
    SELECT command_id FROM _t11_commands
    WHERE action_type = 'FLUSH_DNS_CACHE'
  );
  v_report jsonb;
BEGIN
  v_report := app_private.network_center_retention_v1(
    clock_timestamp() + INTERVAL '181 days'
  );
  PERFORM pg_temp.t11_assert(
    (v_report->>'command_observations_deleted')::bigint >= 2,
    'retention must delete observations before attempts and commands'
  );
  PERFORM pg_temp.t11_assert(
    NOT EXISTS (
      SELECT 1 FROM public.network_command_observations
      WHERE command_id = v_command_id
    ) AND NOT EXISTS (
      SELECT 1 FROM public.network_command_attempts
      WHERE command_id = v_command_id
    ) AND NOT EXISTS (
      SELECT 1 FROM public.network_commands
      WHERE id = v_command_id
    ),
    'terminal command retention must close every dependent row in order'
  );
END
$retention_order$;

SELECT jsonb_build_object(
  'status', 'PASS',
  'proofs', jsonb_build_array(
    'durable_pre_before_post',
    'stable_observation_idempotency',
    'stale_token_rejected',
    'stale_generation_rejected',
    'stale_version_single_winner',
    'expired_lease_rejected',
    'generic_reachability_uncertain',
    'dns_ack_success',
    'dhcp_newer_expiry',
    'dhcp_not_applicable_typed',
    'immutable_access_cycle',
    'new_boot_identity',
    'persisted_snapshot_hashes',
    'append_only_observations',
    'retention_order'
  )
) AS task11_runtime_proof;

ROLLBACK;
