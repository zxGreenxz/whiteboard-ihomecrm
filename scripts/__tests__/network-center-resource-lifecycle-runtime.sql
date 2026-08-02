-- Transaction ownership belongs to verify-network-center-managed-resources.mjs.
-- Every persistent fixture is in the canonical DEMO organization and is
-- discarded by the outer transaction's final ROLLBACK.

CREATE TEMP TABLE _ncmr_fixture ON COMMIT DROP AS
SELECT
  'dddd0000-0000-4000-8000-000000000001'::uuid AS organization_id,
  'dddd4000-0000-4000-8000-000000000001'::uuid AS actor_id,
  repeat('9', 64)::text AS credential_digest,
  clock_timestamp() AS proof_now;

DO $fixture_preflight$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.organizations organization
    WHERE organization.id = 'dddd0000-0000-4000-8000-000000000001'::uuid
      AND organization.is_demo
      AND organization.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'Managed-resource verifier requires canonical DEMO';
  END IF;
  IF to_regprocedure('public.network_center_worker_inventory_v2(text,jsonb)')
       IS NULL
     OR to_regprocedure(
       'public.network_center_admin_provision_worker_v1(text,text,text,text,timestamptz,jsonb)'
     ) IS NULL THEN
    RAISE EXCEPTION 'Authoritative worker inventory v2 is unavailable';
  END IF;
END
$fixture_preflight$;

CREATE OR REPLACE FUNCTION pg_temp.ncmr_building_id(p_index integer)
RETURNS uuid
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT (
    'dddd1000-0000-4000-8000-' || lpad(p_index::text, 12, '0')
  )::uuid;
$fn$;

CREATE OR REPLACE FUNCTION pg_temp.ncmr_router_id(p_index integer)
RETURNS uuid
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT (
    'dddd2000-0000-4000-8000-' || lpad(p_index::text, 12, '0')
  )::uuid;
$fn$;

CREATE OR REPLACE FUNCTION pg_temp.ncmr_actor_id(p_index integer)
RETURNS uuid
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT (
    'dddd4000-0000-4000-8000-' || lpad(p_index::text, 12, '0')
  )::uuid;
$fn$;

INSERT INTO auth.users (id, aud, role, email, created_at, updated_at)
SELECT
  pg_temp.ncmr_actor_id(series),
  'authenticated',
  'authenticated',
  'ncmr-actor-' || series || '@example.invalid',
  clock_timestamp(),
  clock_timestamp()
FROM generate_series(1, 8) series
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.buildings (
  id, user_id, organization_id, name, code, province, district, ward,
  total_floors, total_rooms, is_virtual
)
SELECT
  pg_temp.ncmr_building_id(series),
  fixture.actor_id,
  fixture.organization_id,
  'Network Center verifier ' || series,
  'NCMR-' || series,
  'DEMO', 'DEMO', 'DEMO', 1, 0, false
FROM _ncmr_fixture fixture
CROSS JOIN generate_series(1, 32) series
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.network_devices (
  id, organization_id, building_id, device_kind, external_key,
  display_name, vendor, lifecycle_status, write_capability, is_active,
  credential_ref, inventory_metadata
)
SELECT
  pg_temp.ncmr_router_id(series),
  fixture.organization_id,
  pg_temp.ncmr_building_id(series),
  'MIKROTIK',
  'verifier:router:' || series,
  'Network Center verifier router ' || series,
  'MikroTik', 'ONLINE', true, true,
  'router/ncmr/' || series,
  jsonb_build_object('fixture', 'managed-resource-verifier')
FROM _ncmr_fixture fixture
CROSS JOIN generate_series(1, 32) series
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.network_site_settings (organization_id, building_id)
SELECT fixture.organization_id, pg_temp.ncmr_building_id(series)
FROM _ncmr_fixture fixture
CROSS JOIN generate_series(1, 32) series
ON CONFLICT (organization_id, building_id) DO NOTHING;

-- The server provisions the worker credential and authoritative assignments;
-- v2 derives worker identity exclusively from this digest on every call.
SELECT public.network_center_admin_provision_worker_v1(
  'ncmr-authoritative-worker',
  'Managed-resource verifier worker',
  fixture.credential_digest,
  'sha256:' || substr(fixture.credential_digest, 1, 24),
  clock_timestamp() + INTERVAL '1 day',
  (
    SELECT jsonb_agg(jsonb_build_object(
      'organizationId', fixture.organization_id,
      'buildingId', pg_temp.ncmr_building_id(series),
      'deviceId', pg_temp.ncmr_router_id(series),
      'canPoll', true,
      'canInventory', true,
      'canExecute', true
    ) ORDER BY series)
    FROM generate_series(1, 32) series
  )
)
FROM _ncmr_fixture fixture;

CREATE TEMP TABLE _ncmr_results (
  case_id text PRIMARY KEY,
  passed boolean NOT NULL,
  detail jsonb NOT NULL
) ON COMMIT DROP;

CREATE TEMP TABLE _ncmr_queue_checks (
  check_id text PRIMARY KEY,
  passed boolean NOT NULL,
  detail jsonb NOT NULL
) ON COMMIT DROP;

CREATE OR REPLACE FUNCTION pg_temp.ncmr_expect_enqueue_rejection(
  p_check_id text,
  p_expected_sqlstate text,
  p_expected_code text,
  p_expected_budget text,
  p_building_id uuid,
  p_device_id uuid,
  p_actor_id uuid,
  p_action_type text,
  p_parameters jsonb,
  p_idempotency_key text,
  p_request_hash text
)
RETURNS void
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_fixture _ncmr_fixture%ROWTYPE;
  v_before_rows bigint;
  v_after_rows bigint;
  v_before_events bigint;
  v_after_events bigint;
  v_sqlstate text;
  v_detail_text text;
  v_detail jsonb := '{}'::jsonb;
BEGIN
  SELECT * INTO v_fixture FROM _ncmr_fixture;
  SELECT count(*) INTO v_before_rows
  FROM public.network_commands command
  WHERE command.idempotency_key LIKE 'ncmr-q-%';
  SELECT count(*) INTO v_before_events
  FROM public.network_command_events event
  JOIN public.network_commands command ON command.id = event.command_id
  WHERE command.idempotency_key LIKE 'ncmr-q-%';

  BEGIN
    PERFORM app_private.network_center_enqueue_command_v1(
      v_fixture.organization_id, p_building_id, p_device_id, NULL,
      p_action_type, 'Verifier rejected admission request', p_parameters,
      jsonb_build_object('deviceId', p_device_id), p_actor_id,
      p_request_hash, p_idempotency_key, v_fixture.proof_now
    );
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS
      v_sqlstate = RETURNED_SQLSTATE,
      v_detail_text = PG_EXCEPTION_DETAIL;
    IF nullif(v_detail_text, '') IS NOT NULL THEN
      BEGIN
        v_detail := v_detail_text::jsonb;
      EXCEPTION WHEN OTHERS THEN
        v_detail := jsonb_build_object('raw', v_detail_text);
      END;
    END IF;
  END;

  SELECT count(*) INTO v_after_rows
  FROM public.network_commands command
  WHERE command.idempotency_key LIKE 'ncmr-q-%';
  SELECT count(*) INTO v_after_events
  FROM public.network_command_events event
  JOIN public.network_commands command ON command.id = event.command_id
  WHERE command.idempotency_key LIKE 'ncmr-q-%';

  INSERT INTO _ncmr_queue_checks(check_id, passed, detail) VALUES (
    p_check_id,
    v_sqlstate = p_expected_sqlstate
      AND (p_expected_code IS NULL OR v_detail->>'code' = p_expected_code)
      AND (p_expected_budget IS NULL OR v_detail->>'budget' = p_expected_budget)
      AND v_after_rows = v_before_rows
      AND v_after_events = v_before_events,
    jsonb_build_object(
      'sqlstate', v_sqlstate,
      'code', v_detail->>'code',
      'budget', v_detail->>'budget',
      'no_orphan_rows', v_after_rows = v_before_rows,
      'no_orphan_events', v_after_events = v_before_events
    )
  );
END;
$fn$;

-- Legitimate admission and exact replay are the positive control.
DO $queue_control$
DECLARE
  v_fixture _ncmr_fixture%ROWTYPE;
  v_command_id uuid;
  v_replay_id uuid;
BEGIN
  SELECT * INTO v_fixture FROM _ncmr_fixture;
  v_command_id := app_private.network_center_enqueue_command_v1(
    v_fixture.organization_id, pg_temp.ncmr_building_id(1),
    pg_temp.ncmr_router_id(1), NULL, 'CAPTURE_SNAPSHOT',
    'Verifier legitimate queue control', '{}'::jsonb,
    jsonb_build_object('deviceId', pg_temp.ncmr_router_id(1)),
    v_fixture.actor_id, repeat('a', 64), 'ncmr-q-control-0001',
    v_fixture.proof_now
  );
  v_replay_id := app_private.network_center_enqueue_command_v1(
    v_fixture.organization_id, pg_temp.ncmr_building_id(1),
    pg_temp.ncmr_router_id(1), NULL, 'CAPTURE_SNAPSHOT',
    'Verifier legitimate queue control', '{}'::jsonb,
    jsonb_build_object('deviceId', pg_temp.ncmr_router_id(1)),
    v_fixture.actor_id, repeat('a', 64), 'ncmr-q-control-0001',
    v_fixture.proof_now
  );
  INSERT INTO _ncmr_results(case_id, passed, detail) VALUES (
    'queue-admission-control',
    v_command_id IS NOT NULL
      AND v_replay_id = v_command_id
      AND (SELECT count(*) FROM public.network_commands command
        WHERE command.idempotency_key = 'ncmr-q-control-0001') = 1
      AND NOT EXISTS (
        SELECT 1 FROM public.network_command_events event
        WHERE event.command_id = v_command_id
      ),
    jsonb_build_object('command_id', v_command_id, 'replay_id', v_replay_id)
  );
END
$queue_control$;
DELETE FROM public.network_commands WHERE idempotency_key = 'ncmr-q-control-0001';

-- Idempotency hash mismatch must raise 23505 without orphan rows/events.
SELECT app_private.network_center_enqueue_command_v1(
  organization_id, pg_temp.ncmr_building_id(1), pg_temp.ncmr_router_id(1),
  NULL, 'CAPTURE_SNAPSHOT', 'Verifier idempotency hash seed', '{}'::jsonb,
  jsonb_build_object('deviceId', pg_temp.ncmr_router_id(1)), actor_id,
  repeat('b', 64), 'ncmr-q-idempotency-0001', proof_now
) FROM _ncmr_fixture;
SELECT pg_temp.ncmr_expect_enqueue_rejection(
  'idempotency_hash_mismatch', '23505', NULL, NULL,
  pg_temp.ncmr_building_id(1), pg_temp.ncmr_router_id(1),
  pg_temp.ncmr_actor_id(1), 'CAPTURE_SNAPSHOT', '{}'::jsonb,
  'ncmr-q-idempotency-0001', repeat('c', 64)
);
DELETE FROM public.network_commands
WHERE idempotency_key LIKE 'ncmr-q-idempotency-%';

-- Same-actor semantic replay inside cooldown is rejected.
SELECT app_private.network_center_enqueue_command_v1(
  organization_id, pg_temp.ncmr_building_id(1), pg_temp.ncmr_router_id(1),
  NULL, 'FLUSH_DNS_CACHE', 'Verifier semantic cooldown seed',
  jsonb_build_object('variant', 1), '{}'::jsonb, actor_id,
  repeat('d', 64), 'ncmr-q-semantic-cooldown-1', proof_now
) FROM _ncmr_fixture;
SELECT pg_temp.ncmr_expect_enqueue_rejection(
  'semantic_cooldown', 'P0001', 'NETWORK_CENTER_COOLDOWN', NULL,
  pg_temp.ncmr_building_id(1), pg_temp.ncmr_router_id(1),
  pg_temp.ncmr_actor_id(1), 'FLUSH_DNS_CACHE',
  jsonb_build_object('variant', 1), 'ncmr-q-semantic-cooldown-2', repeat('e', 64)
);
DELETE FROM public.network_commands
WHERE idempotency_key LIKE 'ncmr-q-semantic-cooldown-%';

-- A different actor cannot submit an equivalent semantic intent.
SELECT app_private.network_center_enqueue_command_v1(
  organization_id, pg_temp.ncmr_building_id(1), pg_temp.ncmr_router_id(1),
  NULL, 'RENEW_DHCP_LEASE', 'Verifier duplicate semantic seed',
  jsonb_build_object('variant', 1), '{}'::jsonb, actor_id,
  repeat('f', 64), 'ncmr-q-semantic-duplicate-1', proof_now
) FROM _ncmr_fixture;
SELECT pg_temp.ncmr_expect_enqueue_rejection(
  'semantic_duplicate', 'P0001', 'NETWORK_CENTER_DUPLICATE_INTENT', NULL,
  pg_temp.ncmr_building_id(1), pg_temp.ncmr_router_id(1),
  pg_temp.ncmr_actor_id(2), 'RENEW_DHCP_LEASE',
  jsonb_build_object('variant', 1), 'ncmr-q-semantic-duplicate-2', repeat('1', 64)
);
DELETE FROM public.network_commands
WHERE idempotency_key LIKE 'ncmr-q-semantic-duplicate-%';

-- Different semantic parameters still hit the action cooldown guard.
SELECT app_private.network_center_enqueue_command_v1(
  organization_id, pg_temp.ncmr_building_id(1), pg_temp.ncmr_router_id(1),
  NULL, 'FLUSH_DNS_CACHE', 'Verifier action cooldown seed',
  jsonb_build_object('variant', 1), '{}'::jsonb, actor_id,
  repeat('2', 64), 'ncmr-q-action-cooldown-1', proof_now
) FROM _ncmr_fixture;
SELECT pg_temp.ncmr_expect_enqueue_rejection(
  'action_cooldown', 'P0001', 'NETWORK_CENTER_COOLDOWN', NULL,
  pg_temp.ncmr_building_id(1), pg_temp.ncmr_router_id(1),
  pg_temp.ncmr_actor_id(1), 'FLUSH_DNS_CACHE',
  jsonb_build_object('variant', 2), 'ncmr-q-action-cooldown-2', repeat('3', 64)
);
DELETE FROM public.network_commands
WHERE idempotency_key LIKE 'ncmr-q-action-cooldown-%';

-- Seed exact guard boundaries directly, then exercise the authoritative
-- enqueue function once beyond each boundary.
INSERT INTO public.network_commands (
  organization_id, building_id, device_id, action_type, reason,
  sanitized_parameters, target_display, requested_by, request_hash,
  idempotency_key, semantic_fingerprint, status, available_at,
  created_at, updated_at
)
SELECT organization_id, pg_temp.ncmr_building_id(1), pg_temp.ncmr_router_id(1),
  'REBOOT_ROUTER', 'Verifier disruptive budget seed',
  jsonb_build_object('seed', 1), '{}'::jsonb, actor_id, repeat('4', 64),
  'ncmr-q-disruptive-seed', repeat('4', 64), 'QUEUED', proof_now,
  proof_now, proof_now
FROM _ncmr_fixture;
SELECT pg_temp.ncmr_expect_enqueue_rejection(
  'disruptive_budget', 'P0001', 'NETWORK_CENTER_DEVICE_BUSY', 'disruptive',
  pg_temp.ncmr_building_id(1), pg_temp.ncmr_router_id(1),
  pg_temp.ncmr_actor_id(1), 'REBOOT_ROUTER', jsonb_build_object('seed', 2),
  'ncmr-q-disruptive-reject', repeat('5', 64)
);
DELETE FROM public.network_commands WHERE idempotency_key LIKE 'ncmr-q-disruptive-%';

INSERT INTO public.network_commands (
  organization_id, building_id, device_id, action_type, reason,
  sanitized_parameters, target_display, requested_by, request_hash,
  idempotency_key, semantic_fingerprint, status, available_at,
  created_at, updated_at
)
SELECT fixture.organization_id, pg_temp.ncmr_building_id(1),
  pg_temp.ncmr_router_id(1),
  CASE series WHEN 1 THEN 'FLUSH_DNS_CACHE' ELSE 'RENEW_DHCP_LEASE' END,
  'Verifier device budget seed', jsonb_build_object('seed', series),
  '{}'::jsonb, pg_temp.ncmr_actor_id(series), repeat('6', 64),
  'ncmr-q-device-' || series,
  encode(extensions.digest(convert_to('device-' || series, 'UTF8'), 'sha256'), 'hex'),
  'QUEUED', fixture.proof_now, fixture.proof_now, fixture.proof_now
FROM _ncmr_fixture fixture CROSS JOIN generate_series(1, 2) series;
SELECT pg_temp.ncmr_expect_enqueue_rejection(
  'device_budget', 'P0001', 'NETWORK_CENTER_DEVICE_BUSY', 'device',
  pg_temp.ncmr_building_id(1), pg_temp.ncmr_router_id(1),
  pg_temp.ncmr_actor_id(3), 'CAPTURE_SNAPSHOT', '{}'::jsonb,
  'ncmr-q-device-reject', repeat('7', 64)
);
DELETE FROM public.network_commands WHERE idempotency_key LIKE 'ncmr-q-device-%';

INSERT INTO public.network_commands (
  organization_id, building_id, device_id, action_type, reason,
  sanitized_parameters, target_display, requested_by, request_hash,
  idempotency_key, semantic_fingerprint, status, available_at,
  created_at, updated_at
)
SELECT fixture.organization_id, pg_temp.ncmr_building_id(series),
  pg_temp.ncmr_router_id(series), 'FLUSH_DNS_CACHE',
  'Verifier actor budget seed', jsonb_build_object('seed', series),
  '{}'::jsonb, fixture.actor_id, repeat('8', 64),
  'ncmr-q-actor-' || series,
  encode(extensions.digest(convert_to('actor-' || series, 'UTF8'), 'sha256'), 'hex'),
  'QUEUED', fixture.proof_now, fixture.proof_now, fixture.proof_now
FROM _ncmr_fixture fixture CROSS JOIN generate_series(1, 8) series;
SELECT pg_temp.ncmr_expect_enqueue_rejection(
  'actor_budget', 'P0001', 'NETWORK_CENTER_ACTOR_QUEUE_LIMIT', 'actor',
  pg_temp.ncmr_building_id(9), pg_temp.ncmr_router_id(9),
  pg_temp.ncmr_actor_id(1), 'CAPTURE_SNAPSHOT', '{}'::jsonb,
  'ncmr-q-actor-reject', repeat('a', 64)
);
DELETE FROM public.network_commands WHERE idempotency_key LIKE 'ncmr-q-actor-%';

INSERT INTO public.network_commands (
  organization_id, building_id, device_id, action_type, reason,
  sanitized_parameters, target_display, requested_by, request_hash,
  idempotency_key, semantic_fingerprint, status, available_at,
  created_at, updated_at
)
SELECT fixture.organization_id, pg_temp.ncmr_building_id(series),
  pg_temp.ncmr_router_id(series), 'FLUSH_DNS_CACHE',
  'Verifier organization budget seed', jsonb_build_object('seed', series),
  '{}'::jsonb, pg_temp.ncmr_actor_id(((series - 1) % 8) + 1), repeat('b', 64),
  'ncmr-q-organization-' || series,
  encode(extensions.digest(convert_to('organization-' || series, 'UTF8'), 'sha256'), 'hex'),
  'QUEUED', fixture.proof_now, fixture.proof_now, fixture.proof_now
FROM _ncmr_fixture fixture CROSS JOIN generate_series(1, 30) series;
SELECT pg_temp.ncmr_expect_enqueue_rejection(
  'organization_budget', 'P0001', 'NETWORK_CENTER_ORG_QUEUE_LIMIT', 'organization',
  pg_temp.ncmr_building_id(31), pg_temp.ncmr_router_id(31),
  pg_temp.ncmr_actor_id(1), 'CAPTURE_SNAPSHOT', '{}'::jsonb,
  'ncmr-q-organization-reject', repeat('c', 64)
);
DELETE FROM public.network_commands
WHERE idempotency_key LIKE 'ncmr-q-organization-%';

INSERT INTO public.network_commands (
  organization_id, building_id, device_id, action_type, reason,
  sanitized_parameters, target_display, requested_by, request_hash,
  idempotency_key, semantic_fingerprint, status, available_at,
  reconciliation_state, started_at, finished_at, created_at, updated_at
)
SELECT fixture.organization_id, pg_temp.ncmr_building_id(1),
  pg_temp.ncmr_router_id(1),
  CASE WHEN series % 2 = 0 THEN 'FLUSH_DNS_CACHE' ELSE 'RENEW_DHCP_LEASE' END,
  'Verifier device hourly seed', jsonb_build_object('seed', series),
  '{}'::jsonb, pg_temp.ncmr_actor_id(((series - 1) % 8) + 1), repeat('d', 64),
  'ncmr-q-device-hour-' || series,
  encode(extensions.digest(convert_to('device-hour-' || series, 'UTF8'), 'sha256'), 'hex'),
  'FAILED', fixture.proof_now, 'FAILED',
  fixture.proof_now - INTERVAL '30 minutes',
  fixture.proof_now - INTERVAL '30 minutes',
  fixture.proof_now - INTERVAL '30 minutes',
  fixture.proof_now - INTERVAL '30 minutes'
FROM _ncmr_fixture fixture CROSS JOIN generate_series(1, 12) series;
SELECT pg_temp.ncmr_expect_enqueue_rejection(
  'device_hour', 'P0001', 'NETWORK_CENTER_RATE_LIMIT', 'device_hour',
  pg_temp.ncmr_building_id(1), pg_temp.ncmr_router_id(1),
  pg_temp.ncmr_actor_id(1), 'CAPTURE_SNAPSHOT', '{}'::jsonb,
  'ncmr-q-device-hour-reject', repeat('e', 64)
);
DELETE FROM public.network_commands WHERE idempotency_key LIKE 'ncmr-q-device-hour-%';

INSERT INTO public.network_commands (
  organization_id, building_id, device_id, action_type, reason,
  sanitized_parameters, target_display, requested_by, request_hash,
  idempotency_key, semantic_fingerprint, status, available_at,
  reconciliation_state, started_at, finished_at, created_at, updated_at
)
SELECT fixture.organization_id, pg_temp.ncmr_building_id(series),
  pg_temp.ncmr_router_id(series), 'FLUSH_DNS_CACHE',
  'Verifier actor hourly seed', jsonb_build_object('seed', series),
  '{}'::jsonb, fixture.actor_id, repeat('f', 64),
  'ncmr-q-actor-hour-' || series,
  encode(extensions.digest(convert_to('actor-hour-' || series, 'UTF8'), 'sha256'), 'hex'),
  'FAILED', fixture.proof_now, 'FAILED',
  fixture.proof_now - INTERVAL '20 minutes',
  fixture.proof_now - INTERVAL '20 minutes',
  fixture.proof_now - INTERVAL '20 minutes',
  fixture.proof_now - INTERVAL '20 minutes'
FROM _ncmr_fixture fixture CROSS JOIN generate_series(1, 30) series;
SELECT pg_temp.ncmr_expect_enqueue_rejection(
  'actor_hour', 'P0001', 'NETWORK_CENTER_RATE_LIMIT', 'actor_hour',
  pg_temp.ncmr_building_id(31), pg_temp.ncmr_router_id(31),
  pg_temp.ncmr_actor_id(1), 'CAPTURE_SNAPSHOT', '{}'::jsonb,
  'ncmr-q-actor-hour-reject', repeat('1', 64)
);
DELETE FROM public.network_commands WHERE idempotency_key LIKE 'ncmr-q-actor-hour-%';

INSERT INTO public.network_commands (
  organization_id, building_id, device_id, action_type, reason,
  sanitized_parameters, target_display, requested_by, request_hash,
  idempotency_key, semantic_fingerprint, status, available_at,
  reconciliation_state, started_at, finished_at, created_at, updated_at
)
SELECT fixture.organization_id,
  pg_temp.ncmr_building_id(((series - 1) % 30) + 1),
  pg_temp.ncmr_router_id(((series - 1) % 30) + 1),
  CASE WHEN series % 2 = 0 THEN 'FLUSH_DNS_CACHE' ELSE 'RENEW_DHCP_LEASE' END,
  'Verifier organization hourly seed', jsonb_build_object('seed', series),
  '{}'::jsonb, pg_temp.ncmr_actor_id(((series - 1) % 8) + 1), repeat('2', 64),
  'ncmr-q-organization-hour-' || series,
  encode(extensions.digest(convert_to('organization-hour-' || series, 'UTF8'), 'sha256'), 'hex'),
  'FAILED', fixture.proof_now, 'FAILED',
  fixture.proof_now - INTERVAL '10 minutes',
  fixture.proof_now - INTERVAL '10 minutes',
  fixture.proof_now - INTERVAL '10 minutes',
  fixture.proof_now - INTERVAL '10 minutes'
FROM _ncmr_fixture fixture CROSS JOIN generate_series(1, 120) series;
SELECT pg_temp.ncmr_expect_enqueue_rejection(
  'organization_hour', 'P0001', 'NETWORK_CENTER_RATE_LIMIT', 'organization_hour',
  pg_temp.ncmr_building_id(31), pg_temp.ncmr_router_id(31),
  pg_temp.ncmr_actor_id(8), 'CAPTURE_SNAPSHOT', '{}'::jsonb,
  'ncmr-q-organization-hour-reject', repeat('3', 64)
);
DELETE FROM public.network_commands
WHERE idempotency_key LIKE 'ncmr-q-organization-hour-%';

INSERT INTO _ncmr_results(case_id, passed, detail)
SELECT
  'queue-admission-runtime',
  count(*) = 11 AND bool_and(check_result.passed),
  jsonb_build_object(
    'checks', jsonb_object_agg(
      check_result.check_id,
      check_result.detail || jsonb_build_object('passed', check_result.passed)
      ORDER BY check_result.check_id
    ),
    'no_orphan_rows', NOT EXISTS (
      SELECT 1 FROM public.network_commands
      WHERE idempotency_key LIKE 'ncmr-q-%'
    ),
    'no_orphan_events', NOT EXISTS (
      SELECT 1 FROM public.network_command_events event
      JOIN public.network_commands command ON command.id = event.command_id
      WHERE command.idempotency_key LIKE 'ncmr-q-%'
    )
  )
FROM _ncmr_queue_checks check_result;

DO $client_retention$
DECLARE
  v_fixture _ncmr_fixture%ROWTYPE;
  v_old_id uuid := 'dddd3000-0000-4000-8000-000000000001'::uuid;
  v_recent_id uuid := 'dddd3000-0000-4000-8000-000000000002'::uuid;
  v_expected_old_history jsonb := '[
    "10.0.0.06", "10.0.0.07", "10.0.0.08", "10.0.0.09",
    "10.0.0.10", "10.0.0.11", "10.0.0.12", "10.0.0.13",
    "10.0.0.14", "10.0.0.15", "10.0.0.16", "10.0.0.03",
    "10.0.0.17", "10.0.0.18", "10.0.0.19", "10.0.0.20"
  ]'::jsonb;
  v_expected_recent_history jsonb := '[
    "10.0.1.06", "10.0.1.07", "10.0.1.08", "10.0.1.09",
    "10.0.1.10", "10.0.1.11", "10.0.1.12", "10.0.1.13",
    "10.0.1.14", "10.0.1.15", "10.0.1.16", "10.0.1.03",
    "10.0.1.17", "10.0.1.18", "10.0.1.19", "10.0.1.20"
  ]'::jsonb;
  v_old_exact boolean;
  v_recent_exact boolean;
  v_report jsonb;
BEGIN
  SELECT * INTO v_fixture FROM _ncmr_fixture;
  INSERT INTO public.network_client_sessions (
    id, organization_id, building_id, device_id, session_key,
    client_fingerprint, address_history, connection_type,
    first_seen_at, last_seen_at, ended_at
  ) VALUES
  (
    v_old_id, v_fixture.organization_id, pg_temp.ncmr_building_id(7),
    pg_temp.ncmr_router_id(7), 'ncmr-old-session', 'ncmr-old-client',
    '["10.0.0.01","10.0.0.02","10.0.0.03","10.0.0.04","10.0.0.05",
      "10.0.0.06","10.0.0.07","10.0.0.08","10.0.0.09","10.0.0.10",
      "10.0.0.11","10.0.0.12","10.0.0.13","10.0.0.14","10.0.0.15",
      "10.0.0.16","10.0.0.03","10.0.0.17","10.0.0.18","10.0.0.19",
      "10.0.0.20"]'::jsonb,
    'WIFI', v_fixture.proof_now - INTERVAL '100 days 1 hour',
    v_fixture.proof_now - INTERVAL '100 days',
    v_fixture.proof_now - INTERVAL '99 days'
  ),
  (
    v_recent_id, v_fixture.organization_id, pg_temp.ncmr_building_id(7),
    pg_temp.ncmr_router_id(7), 'ncmr-recent-session', 'ncmr-recent-client',
    '["10.0.1.01","10.0.1.02","10.0.1.03","10.0.1.04","10.0.1.05",
      "10.0.1.06","10.0.1.07","10.0.1.08","10.0.1.09","10.0.1.10",
      "10.0.1.11","10.0.1.12","10.0.1.13","10.0.1.14","10.0.1.15",
      "10.0.1.16","10.0.1.03","10.0.1.17","10.0.1.18","10.0.1.19",
      "10.0.1.20"]'::jsonb,
    'WIFI', v_fixture.proof_now - INTERVAL '2 days',
    v_fixture.proof_now - INTERVAL '1 day', NULL
  );

  SELECT session.address_history = v_expected_old_history
  INTO v_old_exact FROM public.network_client_sessions session
  WHERE session.id = v_old_id;
  SELECT session.address_history = v_expected_recent_history
  INTO v_recent_exact FROM public.network_client_sessions session
  WHERE session.id = v_recent_id;

  SELECT app_private.network_center_retention_v1(v_fixture.proof_now)
  INTO v_report;

  INSERT INTO _ncmr_results(case_id, passed, detail) VALUES (
    'client-retention-runtime',
    v_old_exact
      AND NOT EXISTS (SELECT 1 FROM public.network_client_sessions WHERE id = v_old_id)
      AND (v_report->>'client_sessions_deleted')::integer >= 1,
    jsonb_build_object(
      'old_history_exact', v_old_exact,
      'old_session_deleted', NOT EXISTS (
        SELECT 1 FROM public.network_client_sessions WHERE id = v_old_id
      ),
      'retention_report', v_report
    )
  ),
  (
    'client-retention-control',
    v_recent_exact AND EXISTS (
      SELECT 1 FROM public.network_client_sessions session
      WHERE session.id = v_recent_id
        AND session.address_history = v_expected_recent_history
        AND session.last_seen_at = v_fixture.proof_now - INTERVAL '1 day'
    ),
    jsonb_build_object(
      'recent_session_preserved', EXISTS (
        SELECT 1 FROM public.network_client_sessions WHERE id = v_recent_id
      ),
      'expected_recent_history', v_expected_recent_history,
      'recent_history_exact', v_recent_exact
    )
  );
END
$client_retention$;

CREATE TEMP TABLE _ncmr_aruba_observations (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  malformed_isolated boolean NOT NULL DEFAULT false,
  churn_stable boolean NOT NULL DEFAULT false,
  authoritative_pages integer NOT NULL DEFAULT 0,
  authoritative_total integer NOT NULL DEFAULT 0,
  stable_identity_count integer NOT NULL DEFAULT 0
) ON COMMIT DROP;
INSERT INTO _ncmr_aruba_observations DEFAULT VALUES;

DO $aruba_malformed_and_churn$
DECLARE
  v_fixture _ncmr_fixture%ROWTYPE;
  v_router_id uuid := pg_temp.ncmr_router_id(8);
  v_first_id uuid;
  v_second_id uuid;
  v_original_sort integer;
  v_response jsonb;
BEGIN
  SELECT * INTO v_fixture FROM _ncmr_fixture;
  SELECT public.network_center_worker_inventory_v2(
    v_fixture.credential_digest,
    jsonb_build_object(
      'routerDeviceId', v_router_id, 'discoveryRunId', gen_random_uuid(),
      'observedAt', clock_timestamp(), 'batchIndex', 0, 'batchCount', 1,
      'interfaces', '[]'::jsonb,
      'aruba', jsonb_build_array(
        jsonb_build_object('displayOnly', true),
        jsonb_build_object(
          'stableIdentity', 'NCMR-STABLE-001', 'identitySource', 'SERIAL',
          'externalKey', 'serial:NCMR-STABLE-001',
          'displayName', 'NCMR stable Aruba', 'displayOnly', true,
          'sortOrder', 7, 'lifecycleStatus', 'ONLINE',
          'aliases', jsonb_build_array('ncmr-stable'),
          'metadata', jsonb_build_object('fixture', 'malformed-isolation')
        )
      ),
      'quarantine', '[]'::jsonb
    )
  ) INTO v_response;
  SELECT device.id, device.sort_order INTO v_first_id, v_original_sort
  FROM public.network_devices device
  WHERE device.parent_device_id = v_router_id
    AND device.aruba_stable_key = 'serial:NCMR-STABLE-001';

  PERFORM public.network_center_worker_inventory_v2(
    v_fixture.credential_digest,
    jsonb_build_object(
      'routerDeviceId', v_router_id, 'discoveryRunId', gen_random_uuid(),
      'observedAt', clock_timestamp(), 'batchIndex', 0, 'batchCount', 1,
      'interfaces', '[]'::jsonb,
      'aruba', jsonb_build_array(jsonb_build_object(
        'stableIdentity', 'NCMR-STABLE-001', 'identitySource', 'SERIAL',
        'externalKey', 'serial:NCMR-STABLE-001',
        'displayName', 'NCMR stable Aruba renamed', 'displayOnly', true,
        'sortOrder', 999999, 'lifecycleStatus', 'ONLINE',
        'aliases', jsonb_build_array('ncmr-stable', 'ncmr-renamed'),
        'metadata', jsonb_build_object('fixture', 'identity-churn')
      )),
      'quarantine', '[]'::jsonb
    )
  );
  SELECT device.id INTO v_second_id
  FROM public.network_devices device
  WHERE device.parent_device_id = v_router_id
    AND device.aruba_stable_key = 'serial:NCMR-STABLE-001';

  UPDATE _ncmr_aruba_observations SET
    malformed_isolated =
      (v_response->>'arubaCount')::integer = 1
      AND (v_response->>'quarantinedCount')::integer = 1,
    churn_stable = v_first_id IS NOT NULL
      AND v_second_id = v_first_id
      AND (SELECT count(*) FROM public.network_devices device
        WHERE device.parent_device_id = v_router_id
          AND device.aruba_stable_key = 'serial:NCMR-STABLE-001') = 1
      AND (SELECT device.sort_order FROM public.network_devices device
        WHERE device.id = v_first_id) = v_original_sort
      AND (SELECT device.display_name FROM public.network_devices device
        WHERE device.id = v_first_id) = 'NCMR stable Aruba renamed';
END
$aruba_malformed_and_churn$;

-- Ten authoritative bounded pages across assigned routers persist 640 stable
-- identities, proving there is no organization/building-wide total Aruba cap.
DO $aruba_authoritative_pages$
DECLARE
  v_fixture _ncmr_fixture%ROWTYPE;
  v_router_index integer;
  v_items jsonb;
  v_payload jsonb;
  v_response jsonb;
  v_replay jsonb;
  v_total integer := 0;
  v_pages integer := 0;
BEGIN
  SELECT * INTO v_fixture FROM _ncmr_fixture;
  FOR v_router_index IN 17..26 LOOP
    SELECT jsonb_agg(jsonb_build_object(
      'stableIdentity', 'NCMR-LARGE-' || v_router_index || '-' || lpad(series::text, 3, '0'),
      'identitySource', 'SERIAL',
      'externalKey', 'serial:NCMR-LARGE-' || v_router_index || '-' || lpad(series::text, 3, '0'),
      'displayName', 'NCMR large Aruba ' || v_router_index || '-' || series,
      'displayOnly', true, 'sortOrder', series, 'lifecycleStatus', 'ONLINE',
      'aliases', '[]'::jsonb,
      'metadata', jsonb_build_object('fixture', 'authoritative-large-page')
    ) ORDER BY series)
    INTO v_items FROM generate_series(1, 64) series;
    v_payload := jsonb_build_object(
      'routerDeviceId', pg_temp.ncmr_router_id(v_router_index),
      'discoveryRunId', gen_random_uuid(), 'observedAt', clock_timestamp(),
      'batchIndex', 0, 'batchCount', 1, 'interfaces', '[]'::jsonb,
      'aruba', v_items, 'quarantine', '[]'::jsonb
    );
    SELECT public.network_center_worker_inventory_v2(
      v_fixture.credential_digest, v_payload
    ) INTO v_response;
    SELECT public.network_center_worker_inventory_v2(
      v_fixture.credential_digest, v_payload
    ) INTO v_replay;
    IF v_replay IS DISTINCT FROM v_response THEN
      RAISE EXCEPTION 'NCMR_ARUBA_ASSERTION: authoritative page replay changed';
    END IF;
    v_total := v_total + (v_response->>'arubaCount')::integer;
    v_pages := v_pages + 1;
  END LOOP;

  UPDATE _ncmr_aruba_observations SET
    authoritative_pages = v_pages,
    authoritative_total = v_total,
    stable_identity_count = (
      SELECT count(*)
      FROM public.network_devices device
      WHERE device.organization_id = v_fixture.organization_id
        AND device.device_kind = 'ARUBA'
        AND device.aruba_stable_key LIKE 'serial:NCMR-LARGE-%'
        AND device.parent_device_id IN (
          SELECT pg_temp.ncmr_router_id(series)
          FROM generate_series(17, 26) series
        )
    );
END
$aruba_authoritative_pages$;

CREATE TEMP TABLE _ncmr_aruba_runtime_verdict (
  verdict jsonb NOT NULL
) ON COMMIT DROP;
