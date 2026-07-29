-- Network Center bounded queue admission and resource lifecycle.
-- Additive hardening after the four base Network Center migrations.

BEGIN;

SELECT pg_advisory_xact_lock(20260729131000::bigint);

ALTER TABLE public.network_commands
  ADD COLUMN IF NOT EXISTS semantic_fingerprint character(64);

UPDATE public.network_commands command
SET semantic_fingerprint = encode(
  extensions.digest(
    convert_to(concat_ws(
      E'\x1f',
      command.organization_id::text,
      command.building_id::text,
      command.device_id::text,
      coalesce(command.interface_id::text, ''),
      command.action_type,
      command.sanitized_parameters::text
    ), 'UTF8'),
    'sha256'
  ),
  'hex'
)
WHERE command.semantic_fingerprint IS NULL;

ALTER TABLE public.network_commands
  ALTER COLUMN semantic_fingerprint SET NOT NULL;

DO $constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.network_commands'::regclass
      AND conname = 'network_commands_semantic_fingerprint_check'
  ) THEN
    ALTER TABLE public.network_commands
      ADD CONSTRAINT network_commands_semantic_fingerprint_check
      CHECK (semantic_fingerprint ~ '^[a-f0-9]{64}$');
  END IF;
END;
$constraints$;

CREATE INDEX IF NOT EXISTS network_commands_org_budget_idx
  ON public.network_commands (organization_id, status, created_at DESC, id);

CREATE INDEX IF NOT EXISTS network_commands_actor_budget_idx
  ON public.network_commands (requested_by, status, created_at DESC, id);

CREATE INDEX IF NOT EXISTS network_commands_device_budget_idx
  ON public.network_commands (device_id, status, created_at DESC, id);

CREATE INDEX IF NOT EXISTS network_commands_org_rate_idx
  ON public.network_commands (organization_id, created_at DESC, id);

CREATE INDEX IF NOT EXISTS network_commands_actor_rate_idx
  ON public.network_commands (requested_by, created_at DESC, id);

CREATE INDEX IF NOT EXISTS network_commands_device_rate_idx
  ON public.network_commands (device_id, created_at DESC, id);

CREATE INDEX IF NOT EXISTS network_commands_semantic_recent_idx
  ON public.network_commands (semantic_fingerprint, created_at DESC, id);

CREATE INDEX IF NOT EXISTS network_commands_terminal_retention_idx
  ON public.network_commands (organization_id, finished_at, id)
  WHERE status IN (
    'SUCCEEDED', 'FAILED', 'CANCELLED_BY_KILL_SWITCH'
  );

CREATE INDEX IF NOT EXISTS network_client_sessions_retention_idx
  ON public.network_client_sessions (organization_id, last_seen_at, id);

CREATE INDEX IF NOT EXISTS network_metric_hourly_retention_idx
  ON public.network_metric_hourly (
    organization_id, bucket_hour, building_id,
    series_kind, series_id, metric_name
  );

CREATE INDEX IF NOT EXISTS network_sla_daily_retention_idx
  ON public.network_sla_daily (organization_id, sla_day, building_id);

CREATE INDEX IF NOT EXISTS network_device_leases_command_idx
  ON public.network_device_leases (command_id);

CREATE INDEX IF NOT EXISTS network_config_snapshots_command_idx
  ON public.network_config_snapshots (
    organization_id, building_id, command_id
  );

CREATE INDEX IF NOT EXISTS network_audit_events_command_idx
  ON public.network_audit_events (
    organization_id, building_id, command_id
  );

CREATE UNIQUE INDEX IF NOT EXISTS network_audit_events_retention_summary_uidx
  ON public.network_audit_events (organization_id, building_id, target_id)
  WHERE actor_type = 'SYSTEM'
    AND action = 'command.retention_summary'
    AND target_type = 'command'
    AND target_id IS NOT NULL
    AND outcome = 'OBSERVED'
    AND reason =
      'Sanitized terminal command summary retained before lifecycle deletion.'
    AND validation ? 'attemptCount'
    AND validation ? 'reconciliationState'
    AND result ? 'terminalStatus';

CREATE TABLE IF NOT EXISTS app_private.network_center_command_retention_contexts (
  backend_pid integer NOT NULL,
  transaction_id bigint NOT NULL,
  PRIMARY KEY (backend_pid, transaction_id)
);

CREATE OR REPLACE FUNCTION app_private.network_center_guard_command_immutable_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
BEGIN
  IF ROW(
    NEW.organization_id, NEW.building_id, NEW.device_id, NEW.interface_id,
    NEW.action_type, NEW.reason, NEW.sanitized_parameters, NEW.target_display,
    NEW.requested_by, NEW.request_hash, NEW.idempotency_key,
    NEW.semantic_fingerprint, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.organization_id, OLD.building_id, OLD.device_id, OLD.interface_id,
    OLD.action_type, OLD.reason, OLD.sanitized_parameters, OLD.target_display,
    OLD.requested_by, OLD.request_hash, OLD.idempotency_key,
    OLD.semantic_fingerprint, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'Immutable Network Center command fields cannot change'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE OR REPLACE FUNCTION app_private.network_center_enqueue_command_v1(
  p_organization_id uuid,
  p_building_id uuid,
  p_device_id uuid,
  p_interface_id uuid,
  p_action_type text,
  p_reason text,
  p_parameters jsonb,
  p_target_display jsonb,
  p_requested_by uuid,
  p_request_hash text,
  p_idempotency_key text,
  p_available_at timestamptz DEFAULT now()
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public', 'extensions'
AS $fn$
DECLARE
  v_now timestamptz;
  v_existing public.network_commands%ROWTYPE;
  v_command_id uuid;
  v_count bigint;
  v_semantic_material text;
  v_semantic_fingerprint character(64);
  v_cooldown interval;
  v_nonterminal text[] := ARRAY[
    'QUEUED', 'LEASED', 'RUNNING', 'RETRY_WAIT', 'UNCERTAIN', 'RECONCILING'
  ]::text[];
BEGIN
  IF p_organization_id IS NULL OR p_building_id IS NULL OR p_device_id IS NULL
     OR p_requested_by IS NULL OR p_available_at IS NULL THEN
    RAISE EXCEPTION 'Missing command identity' USING ERRCODE = '22023';
  END IF;
  p_action_type := upper(btrim(coalesce(p_action_type, '')));
  p_reason := btrim(coalesce(p_reason, ''));
  p_idempotency_key := btrim(coalesce(p_idempotency_key, ''));
  p_request_hash := lower(btrim(coalesce(p_request_hash, '')));
  p_parameters := coalesce(p_parameters, '{}'::jsonb);

  IF p_action_type NOT IN (
       'FLUSH_DNS_CACHE', 'RENEW_DHCP_LEASE', 'CYCLE_ACCESS_PORT',
       'REBOOT_ROUTER', 'CAPTURE_SNAPSHOT'
     )
     OR char_length(p_reason) NOT BETWEEN 8 AND 1000
     OR p_request_hash !~ '^[a-f0-9]{64}$'
     OR p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$'
     OR jsonb_typeof(p_parameters) <> 'object'
     OR p_target_display IS NULL
     OR jsonb_typeof(p_target_display) <> 'object' THEN
    RAISE EXCEPTION 'Invalid command request' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.network_devices device
    WHERE device.organization_id = p_organization_id
      AND device.building_id = p_building_id
      AND device.id = p_device_id
      AND device.device_kind = 'MIKROTIK'
      AND device.is_active
      AND device.write_capability
  ) THEN
    RAISE EXCEPTION 'Command target is not an active writable MikroTik'
      USING ERRCODE = '22023';
  END IF;

  IF p_action_type <> 'CAPTURE_SNAPSHOT' AND EXISTS (
    SELECT 1
    FROM public.network_site_settings settings
    WHERE settings.organization_id = p_organization_id
      AND settings.building_id = p_building_id
      AND settings.changes_paused
  ) THEN
    RAISE EXCEPTION 'Network changes are paused for this building'
      USING ERRCODE = '55000';
  END IF;

  IF p_action_type = 'CYCLE_ACCESS_PORT' THEN
    IF p_interface_id IS NULL OR NOT EXISTS (
      SELECT 1
      FROM public.network_interfaces interface
      WHERE interface.organization_id = p_organization_id
        AND interface.building_id = p_building_id
        AND interface.device_id = p_device_id
        AND interface.id = p_interface_id
        AND interface.interface_role = 'ACCESS'
        AND NOT interface.is_protected
        AND interface.is_enabled
    ) THEN
      RAISE EXCEPTION 'Access-port target is invalid or protected'
        USING ERRCODE = '22023';
    END IF;
  ELSIF p_interface_id IS NOT NULL THEN
    RAISE EXCEPTION 'This action does not accept an interface target'
      USING ERRCODE = '22023';
  END IF;

  v_semantic_material := concat_ws(
    E'\x1f',
    p_organization_id::text,
    p_building_id::text,
    p_device_id::text,
    coalesce(p_interface_id::text, ''),
    p_action_type,
    p_parameters::text
  );
  v_semantic_fingerprint := encode(
    extensions.digest(convert_to(v_semantic_material, 'UTF8'), 'sha256'),
    'hex'
  );
  v_cooldown := CASE p_action_type
    WHEN 'REBOOT_ROUTER' THEN INTERVAL '10 minutes'
    WHEN 'CYCLE_ACCESS_PORT' THEN INTERVAL '2 minutes'
    WHEN 'FLUSH_DNS_CACHE' THEN INTERVAL '30 seconds'
    WHEN 'RENEW_DHCP_LEASE' THEN INTERVAL '30 seconds'
    WHEN 'CAPTURE_SNAPSHOT' THEN INTERVAL '60 seconds'
  END;

  -- Deterministic lock order serializes organization, actor and device budgets.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('network-center:org:' || p_organization_id::text, 0)
  );
  PERFORM pg_advisory_xact_lock(
    hashtextextended('network-center:actor:' || p_requested_by::text, 0)
  );
  PERFORM pg_advisory_xact_lock(
    hashtextextended('network-center:device:' || p_device_id::text, 0)
  );

  -- Cooldown/rate timestamps start only after all admission waits finish.
  v_now := clock_timestamp();

  SELECT command.*
  INTO v_existing
  FROM public.network_commands command
  WHERE command.organization_id = p_organization_id
    AND command.requested_by = p_requested_by
    AND command.idempotency_key = p_idempotency_key
  FOR UPDATE;

  IF FOUND THEN
    IF v_existing.request_hash IS DISTINCT FROM p_request_hash THEN
      RAISE EXCEPTION 'Idempotency key reused with different command input'
        USING ERRCODE = '23505';
    END IF;
    RETURN v_existing.id;
  END IF;

  SELECT command.*
  INTO v_existing
  FROM public.network_commands command
  WHERE command.semantic_fingerprint = v_semantic_fingerprint
    AND command.created_at >= v_now - v_cooldown
  ORDER BY command.created_at DESC, command.id DESC
  LIMIT 1
  FOR UPDATE;

  IF FOUND THEN
    RAISE EXCEPTION 'Equivalent command intent already exists'
      USING ERRCODE = 'P0001',
        DETAIL = jsonb_build_object(
          'code', CASE
            WHEN v_existing.requested_by = p_requested_by
              THEN 'NETWORK_CENTER_COOLDOWN'
            ELSE 'NETWORK_CENTER_DUPLICATE_INTENT'
          END,
          'commandId', v_existing.id,
          'actionType', p_action_type,
          'cooldownSeconds', extract(epoch FROM v_cooldown)::integer
        )::text;
  END IF;

  IF p_action_type IN ('CYCLE_ACCESS_PORT', 'REBOOT_ROUTER') THEN
    SELECT count(*) INTO v_count
    FROM public.network_commands command
    WHERE command.device_id = p_device_id
      AND command.status = ANY(v_nonterminal)
      AND command.action_type IN ('CYCLE_ACCESS_PORT', 'REBOOT_ROUTER');
    IF v_count >= 1 THEN
      RAISE EXCEPTION 'A disruptive command is already active for this device'
        USING ERRCODE = 'P0001',
          DETAIL = jsonb_build_object(
            'code', 'NETWORK_CENTER_DEVICE_BUSY',
            'budget', 'disruptive',
            'limit', 1
          )::text;
    END IF;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.network_commands command
  WHERE command.device_id = p_device_id
    AND command.status = ANY(v_nonterminal);
  IF v_count >= 2 THEN
    RAISE EXCEPTION 'Device command queue is full'
      USING ERRCODE = 'P0001',
        DETAIL = jsonb_build_object(
          'code', 'NETWORK_CENTER_DEVICE_BUSY',
          'budget', 'device',
          'limit', 2
        )::text;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.network_commands command
  WHERE command.requested_by = p_requested_by
    AND command.status = ANY(v_nonterminal);
  IF v_count >= 8 THEN
    RAISE EXCEPTION 'Actor command queue is full'
      USING ERRCODE = 'P0001',
        DETAIL = jsonb_build_object(
          'code', 'NETWORK_CENTER_ACTOR_QUEUE_LIMIT',
          'budget', 'actor',
          'limit', 8
        )::text;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.network_commands command
  WHERE command.organization_id = p_organization_id
    AND command.status = ANY(v_nonterminal);
  IF v_count >= 30 THEN
    RAISE EXCEPTION 'Organization command queue is full'
      USING ERRCODE = 'P0001',
        DETAIL = jsonb_build_object(
          'code', 'NETWORK_CENTER_ORG_QUEUE_LIMIT',
          'budget', 'organization',
          'limit', 30
        )::text;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.network_commands command
  WHERE command.device_id = p_device_id
    AND command.created_at >= v_now - INTERVAL '1 hour';
  IF v_count >= 12 THEN
    RAISE EXCEPTION 'Device hourly command rate exceeded'
      USING ERRCODE = 'P0001',
        DETAIL = jsonb_build_object(
          'code', 'NETWORK_CENTER_RATE_LIMIT',
          'budget', 'device_hour',
          'limit', 12
        )::text;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.network_commands command
  WHERE command.requested_by = p_requested_by
    AND command.created_at >= v_now - INTERVAL '1 hour';
  IF v_count >= 30 THEN
    RAISE EXCEPTION 'Actor hourly command rate exceeded'
      USING ERRCODE = 'P0001',
        DETAIL = jsonb_build_object(
          'code', 'NETWORK_CENTER_RATE_LIMIT',
          'budget', 'actor_hour',
          'limit', 30
        )::text;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.network_commands command
  WHERE command.organization_id = p_organization_id
    AND command.created_at >= v_now - INTERVAL '1 hour';
  IF v_count >= 120 THEN
    RAISE EXCEPTION 'Organization hourly command rate exceeded'
      USING ERRCODE = 'P0001',
        DETAIL = jsonb_build_object(
          'code', 'NETWORK_CENTER_RATE_LIMIT',
          'budget', 'organization_hour',
          'limit', 120
        )::text;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.network_commands command
    WHERE command.device_id = p_device_id
      AND command.action_type = p_action_type
      AND (
        p_action_type <> 'CYCLE_ACCESS_PORT'
        OR command.interface_id = p_interface_id
      )
      AND command.created_at >= v_now - v_cooldown
  ) THEN
    RAISE EXCEPTION 'Command action is cooling down for this device'
      USING ERRCODE = 'P0001',
        DETAIL = jsonb_build_object(
          'code', 'NETWORK_CENTER_COOLDOWN',
          'actionType', p_action_type,
          'cooldownSeconds', extract(epoch FROM v_cooldown)::integer
        )::text;
  END IF;

  INSERT INTO public.network_commands (
    organization_id, building_id, device_id, interface_id, action_type, reason,
    sanitized_parameters, target_display, requested_by, request_hash,
    idempotency_key, semantic_fingerprint, available_at, created_at, updated_at
  ) VALUES (
    p_organization_id, p_building_id, p_device_id, p_interface_id, p_action_type,
    p_reason, p_parameters, p_target_display, p_requested_by, p_request_hash,
    p_idempotency_key, v_semantic_fingerprint, p_available_at, v_now, v_now
  )
  RETURNING id INTO v_command_id;

  RETURN v_command_id;
END;
$fn$;

-- Exact request replay is resolved after current authorization and immutable
-- input normalization, but before mutable router/site/interface eligibility.
-- A lost response therefore cannot turn one committed intent into a new token.
CREATE OR REPLACE FUNCTION public.network_center_request_snapshot_v1(
  p_device_id uuid,
  p_label text,
  p_request_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_device public.network_devices%ROWTYPE;
  v_scope record;
  v_label text := btrim(coalesce(p_label, ''));
  v_hash text;
  v_replay jsonb;
  v_command_id uuid;
  v_target jsonb;
  v_result jsonb;
BEGIN
  IF p_device_id IS NULL OR p_request_id IS NULL
     OR char_length(v_label) NOT BETWEEN 3 AND 160 THEN
    RAISE EXCEPTION 'Invalid snapshot request' USING ERRCODE = '22023';
  END IF;

  SELECT device.* INTO v_device
  FROM public.network_devices device
  WHERE device.id = p_device_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active MikroTik not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_scope
  FROM app_private.network_center_require_execute_v1(v_device.building_id);

  v_hash := encode(extensions.digest(jsonb_build_object(
    'action', 'request_snapshot', 'deviceId', p_device_id, 'label', v_label
  )::text, 'sha256'), 'hex');
  v_replay := app_private.network_center_request_replay_v1(
    v_scope.organization_id, v_scope.actor_id, p_request_id, v_hash,
    'capture_configuration'
  );
  IF v_replay IS NOT NULL THEN
    RETURN v_replay;
  END IF;

  SELECT device.* INTO v_device
  FROM public.network_devices device
  WHERE device.id = p_device_id
    AND device.organization_id = v_scope.organization_id
    AND device.device_kind = 'MIKROTIK'
    AND device.is_active
    AND device.write_capability
    AND device.lifecycle_status IN ('ONLINE', 'OFFLINE')
    AND EXISTS (
      SELECT 1
      FROM public.network_device_connections connection
      WHERE connection.organization_id = device.organization_id
        AND connection.building_id = device.building_id
        AND connection.device_id = device.id
        AND connection.is_enabled
    )
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active MikroTik not found' USING ERRCODE = 'P0002';
  END IF;

  v_target := jsonb_build_object(
    'buildingId', v_device.building_id,
    'buildingName', v_scope.building_name,
    'deviceId', v_device.id,
    'routerIdentity', v_device.display_name
  );
  v_command_id := app_private.network_center_enqueue_command_v1(
    v_scope.organization_id, v_device.building_id, v_device.id, NULL,
    'CAPTURE_SNAPSHOT', 'Capture configuration: ' || v_label,
    jsonb_build_object('label', v_label), v_target, v_scope.actor_id,
    v_hash, p_request_id::text, clock_timestamp()
  );
  INSERT INTO public.network_command_events (
    organization_id, building_id, command_id, event_seq, event_kind,
    occurred_at, actor_id, payload
  ) VALUES (
    v_scope.organization_id, v_device.building_id, v_command_id, 1, 'QUEUED',
    clock_timestamp(), v_scope.actor_id, jsonb_build_object('label', v_label)
  ) ON CONFLICT (command_id, event_seq) DO NOTHING;
  v_result := jsonb_build_object(
    'commandId', v_command_id,
    'status', 'QUEUED',
    'label', v_label
  );
  PERFORM app_private.network_center_append_user_audit_v1(
    v_scope.organization_id, v_device.building_id, v_scope.actor_id,
    'capture_configuration', 'device', v_device.id, v_target,
    'Capture configuration: ' || v_label,
    jsonb_build_object('permission', 'network_center.execute'), v_result,
    'ACCEPTED', v_command_id, p_request_id, v_hash
  );
  RETURN v_result;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.network_center_execute_action_v1(
  p_device_id uuid,
  p_action_type text,
  p_reason text,
  p_parameters jsonb,
  p_confirmation text,
  p_request_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_device public.network_devices%ROWTYPE;
  v_scope record;
  v_action text := upper(btrim(coalesce(p_action_type, '')));
  v_reason text := btrim(coalesce(p_reason, ''));
  v_parameters jsonb := coalesce(p_parameters, '{}'::jsonb);
  v_sanitized jsonb := '{}'::jsonb;
  v_interface public.network_interfaces%ROWTYPE;
  v_interface_id uuid;
  v_duration integer;
  v_identity text;
  v_hash text;
  v_replay jsonb;
  v_target jsonb;
  v_command_id uuid;
  v_result jsonb;
BEGIN
  IF p_device_id IS NULL OR p_request_id IS NULL
     OR v_action NOT IN (
       'FLUSH_DNS_CACHE', 'RENEW_DHCP_LEASE',
       'CYCLE_ACCESS_PORT', 'REBOOT_ROUTER'
     )
     OR char_length(v_reason) NOT BETWEEN 8 AND 1000
     OR jsonb_typeof(v_parameters) <> 'object'
     OR octet_length(v_parameters::text) > 16384 THEN
    RAISE EXCEPTION 'Invalid Network Center action request'
      USING ERRCODE = '22023';
  END IF;

  IF v_action = 'CYCLE_ACCESS_PORT' THEN
    IF coalesce(v_parameters->>'interfaceId', '') !~
         '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
       OR coalesce(v_parameters->>'durationSeconds', '') !~ '^[0-9]+$' THEN
      RAISE EXCEPTION 'Invalid access-port parameters' USING ERRCODE = '22023';
    END IF;
    v_interface_id := (v_parameters->>'interfaceId')::uuid;
    v_duration := (v_parameters->>'durationSeconds')::integer;
    IF v_duration NOT BETWEEN 5 AND 30 THEN
      RAISE EXCEPTION 'Access-port cycle must be between 5 and 30 seconds'
        USING ERRCODE = '22023';
    END IF;
    v_sanitized := jsonb_build_object('durationSeconds', v_duration);
  ELSIF v_parameters <> '{}'::jsonb THEN
    RAISE EXCEPTION 'This action does not accept parameters'
      USING ERRCODE = '22023';
  END IF;

  v_hash := encode(extensions.digest(jsonb_build_object(
    'action', v_action,
    'deviceId', p_device_id,
    'interfaceId', v_interface_id,
    'reason', v_reason,
    'parameters', v_sanitized
  )::text, 'sha256'), 'hex');

  SELECT device.* INTO v_device
  FROM public.network_devices device
  WHERE device.id = p_device_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Writable MikroTik not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_scope
  FROM app_private.network_center_require_execute_v1(v_device.building_id);

  v_replay := app_private.network_center_request_replay_v1(
    v_scope.organization_id, v_scope.actor_id, p_request_id, v_hash,
    lower(v_action)
  );
  IF v_replay IS NOT NULL THEN
    RETURN v_replay;
  END IF;

  SELECT device.* INTO v_device
  FROM public.network_devices device
  WHERE device.id = p_device_id
    AND device.organization_id = v_scope.organization_id
    AND device.device_kind = 'MIKROTIK'
    AND device.is_active
    AND device.write_capability
    AND device.lifecycle_status IN ('ONLINE', 'OFFLINE')
    AND EXISTS (
      SELECT 1
      FROM public.network_device_connections connection
      WHERE connection.organization_id = device.organization_id
        AND connection.building_id = device.building_id
        AND connection.device_id = device.id
        AND connection.is_enabled
    )
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Writable MikroTik not found' USING ERRCODE = 'P0002';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.network_site_settings settings
    WHERE settings.organization_id = v_scope.organization_id
      AND settings.building_id = v_device.building_id
      AND NOT settings.changes_paused
  ) THEN
    RAISE EXCEPTION 'Network changes are paused for this building'
      USING ERRCODE = '55000';
  END IF;

  SELECT coalesce(current_state.identity_name, v_device.display_name)
  INTO v_identity
  FROM public.network_device_current current_state
  WHERE current_state.device_id = v_device.id;
  v_identity := coalesce(v_identity, v_device.display_name);

  IF v_action IN ('CYCLE_ACCESS_PORT', 'REBOOT_ROUTER')
     AND p_confirmation IS DISTINCT FROM v_identity THEN
    RAISE EXCEPTION 'Router confirmation does not match the current identity'
      USING ERRCODE = '22023';
  END IF;

  IF v_action = 'CYCLE_ACCESS_PORT' THEN
    SELECT interface.* INTO v_interface
    FROM public.network_interfaces interface
    WHERE interface.organization_id = v_scope.organization_id
      AND interface.building_id = v_device.building_id
      AND interface.device_id = v_device.id
      AND interface.id = v_interface_id
      AND interface.interface_role = 'ACCESS'
      AND NOT interface.is_protected
      AND interface.is_enabled
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Access port is invalid or protected'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  v_target := jsonb_build_object(
    'buildingId', v_device.building_id,
    'buildingName', v_scope.building_name,
    'deviceId', v_device.id,
    'routerIdentity', v_identity,
    'interfaceId', v_interface_id,
    'interfaceName', v_interface.display_name
  );
  v_command_id := app_private.network_center_enqueue_command_v1(
    v_scope.organization_id, v_device.building_id, v_device.id, v_interface_id,
    v_action, v_reason, v_sanitized, v_target, v_scope.actor_id,
    v_hash, p_request_id::text, clock_timestamp()
  );
  INSERT INTO public.network_command_events (
    organization_id, building_id, command_id, event_seq, event_kind,
    occurred_at, actor_id, payload
  ) VALUES (
    v_scope.organization_id, v_device.building_id, v_command_id, 1, 'QUEUED',
    clock_timestamp(), v_scope.actor_id,
    jsonb_build_object('actionType', v_action)
  ) ON CONFLICT (command_id, event_seq) DO NOTHING;
  v_result := jsonb_build_object(
    'commandId', v_command_id,
    'status', 'QUEUED',
    'actionType', v_action,
    'reason', v_reason,
    'parameters', v_sanitized,
    'target', v_target
  );
  PERFORM app_private.network_center_append_user_audit_v1(
    v_scope.organization_id, v_device.building_id, v_scope.actor_id,
    lower(v_action), 'device', v_device.id, v_target, v_reason,
    jsonb_build_object(
      'permission', 'network_center.execute',
      'confirmationValidated', true
    ),
    v_result, 'ACCEPTED', v_command_id, p_request_id, v_hash
  );
  INSERT INTO public.network_outbox_events (
    organization_id, building_id, event_type, aggregate_type, aggregate_id,
    payload, occurred_at
  ) VALUES (
    v_scope.organization_id, v_device.building_id, 'network.command.queued',
    'command', v_command_id, jsonb_build_object('actionType', v_action),
    clock_timestamp()
  );
  RETURN v_result;
END;
$fn$;

CREATE OR REPLACE FUNCTION app_private.network_center_compact_client_history_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_entry jsonb;
  v_result jsonb := '[]'::jsonb;
  v_count integer := 0;
BEGIN
  IF NEW.address_history IS NULL
     OR jsonb_typeof(NEW.address_history) <> 'array' THEN
    RAISE EXCEPTION 'Client address history must be an array'
      USING ERRCODE = '22023';
  END IF;

  FOR v_entry IN
    SELECT item.value
    FROM jsonb_array_elements(NEW.address_history)
      WITH ORDINALITY AS item(value, ordinal)
    ORDER BY item.ordinal DESC
  LOOP
    EXIT WHEN v_count >= 16;
    IF NOT v_result @> jsonb_build_array(v_entry) THEN
      v_result := jsonb_build_array(v_entry) || v_result;
      v_count := v_count + 1;
    END IF;
  END LOOP;

  NEW.address_history := v_result;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS network_client_sessions_compact_history
  ON public.network_client_sessions;
CREATE TRIGGER network_client_sessions_compact_history
  BEFORE INSERT OR UPDATE OF address_history ON public.network_client_sessions
  FOR EACH ROW EXECUTE FUNCTION app_private.network_center_compact_client_history_v1();

DO $history_backfill$
DECLARE
  v_organization record;
  v_ids uuid[];
  v_after uuid;
BEGIN
  -- Wait for current writers once, then prevent a skipped row from being left
  -- permanently untrimmed while each physical UPDATE remains batch bounded.
  LOCK TABLE public.network_client_sessions IN SHARE ROW EXCLUSIVE MODE;

  FOR v_organization IN
    SELECT DISTINCT session.organization_id
    FROM public.network_client_sessions session
    ORDER BY session.organization_id
  LOOP
    v_after := NULL;
    LOOP
      SELECT array_agg(candidate.id ORDER BY candidate.id)
      INTO v_ids
      FROM (
        SELECT session.id
        FROM public.network_client_sessions session
        WHERE session.organization_id = v_organization.organization_id
          AND (v_after IS NULL OR session.id > v_after)
        ORDER BY session.id
        FOR UPDATE SKIP LOCKED
        LIMIT 1000
      ) candidate;

      EXIT WHEN coalesce(cardinality(v_ids), 0) = 0;

      UPDATE public.network_client_sessions session
      SET address_history = session.address_history
      WHERE session.id = ANY(v_ids);

      v_after := v_ids[cardinality(v_ids)];
    END LOOP;
  END LOOP;
END;
$history_backfill$;

CREATE OR REPLACE FUNCTION app_private.network_center_guard_command_events_v2()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_setting(
       'app_private.network_center_command_retention', true
     ) = 'on'
     AND EXISTS (
       SELECT 1
       FROM app_private.network_center_command_retention_contexts context
       WHERE context.backend_pid = pg_backend_pid()
         AND context.transaction_id = txid_current()
     ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Network Center command events are append-only'
    USING ERRCODE = '55000';
END;
$fn$;

CREATE OR REPLACE FUNCTION app_private.network_center_guard_command_evidence_v2()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
BEGIN
  IF TG_OP = 'UPDATE'
     AND current_setting(
       'app_private.network_center_command_retention', true
     ) = 'on'
     AND EXISTS (
       SELECT 1
       FROM app_private.network_center_command_retention_contexts context
       WHERE context.backend_pid = pg_backend_pid()
         AND context.transaction_id = txid_current()
     )
     AND OLD.command_id IS NOT NULL
     AND NEW.command_id IS NULL
     AND (to_jsonb(NEW) - 'command_id') IS NOT DISTINCT FROM
         (to_jsonb(OLD) - 'command_id') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Network Center evidence is append-only'
    USING ERRCODE = '55000';
END;
$fn$;

DROP TRIGGER IF EXISTS network_command_events_append_only
  ON public.network_command_events;
CREATE TRIGGER network_command_events_append_only
  BEFORE UPDATE OR DELETE ON public.network_command_events
  FOR EACH ROW EXECUTE FUNCTION app_private.network_center_guard_command_events_v2();

DROP TRIGGER IF EXISTS network_config_snapshots_append_only
  ON public.network_config_snapshots;
CREATE TRIGGER network_config_snapshots_append_only
  BEFORE UPDATE OR DELETE ON public.network_config_snapshots
  FOR EACH ROW EXECUTE FUNCTION app_private.network_center_guard_command_evidence_v2();

DROP TRIGGER IF EXISTS network_audit_events_append_only
  ON public.network_audit_events;
CREATE TRIGGER network_audit_events_append_only
  BEFORE UPDATE OR DELETE ON public.network_audit_events
  FOR EACH ROW EXECUTE FUNCTION app_private.network_center_guard_command_evidence_v2();

ALTER TABLE public.network_config_snapshots
  DROP CONSTRAINT IF EXISTS network_config_snapshots_command_fk;
ALTER TABLE public.network_config_snapshots
  ADD CONSTRAINT network_config_snapshots_command_fk
  FOREIGN KEY (organization_id, building_id, command_id)
  REFERENCES public.network_commands(organization_id, building_id, id)
  ON DELETE SET NULL (command_id);

ALTER TABLE public.network_audit_events
  DROP CONSTRAINT IF EXISTS network_audit_events_command_fk;
ALTER TABLE public.network_audit_events
  ADD CONSTRAINT network_audit_events_command_fk
  FOREIGN KEY (organization_id, building_id, command_id)
  REFERENCES public.network_commands(organization_id, building_id, id)
  ON DELETE SET NULL (command_id);

CREATE OR REPLACE FUNCTION app_private.network_center_retention_v1(
  p_now timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
SET timezone TO 'UTC'
AS $fn$
DECLARE
  v_cutoff_day date;
  v_partition record;
  v_partition_day date;
  v_organization record;
  v_command_ids uuid[];
  v_dropped integer := 0;
  v_hourly_deleted bigint := 0;
  v_daily_deleted bigint := 0;
  v_sessions_deleted bigint := 0;
  v_commands_deleted bigint := 0;
  v_count bigint;
BEGIN
  IF p_now IS NULL THEN
    RAISE EXCEPTION 'Retention timestamp is required' USING ERRCODE = '22023';
  END IF;

  v_cutoff_day := ((p_now - INTERVAL '14 days') AT TIME ZONE 'UTC')::date;

  FOR v_partition IN
    SELECT child.relname AS partition_name
    FROM pg_catalog.pg_inherits i
    JOIN pg_catalog.pg_class parent ON parent.oid = i.inhparent
    JOIN pg_catalog.pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
    JOIN pg_catalog.pg_class child ON child.oid = i.inhrelid
    JOIN pg_catalog.pg_namespace child_ns ON child_ns.oid = child.relnamespace
    WHERE parent_ns.nspname = 'public'
      AND child_ns.nspname = 'public'
      AND parent.relname IN (
        'network_device_samples', 'network_interface_samples'
      )
      AND child.relname ~ '^network_(device|interface)_samples_[0-9]{8}$'
  LOOP
    v_partition_day := to_date(
      right(v_partition.partition_name, 8), 'YYYYMMDD'
    );
    IF v_partition_day < v_cutoff_day THEN
      EXECUTE format(
        'DROP TABLE IF EXISTS public.%I', v_partition.partition_name
      );
      v_dropped := v_dropped + 1;
    END IF;
  END LOOP;

  FOR v_organization IN
    SELECT DISTINCT metric.organization_id
    FROM public.network_metric_hourly metric
    WHERE metric.bucket_hour <
      date_trunc('hour', p_now - INTERVAL '13 months')
    ORDER BY metric.organization_id
  LOOP
    WITH victims AS MATERIALIZED (
      SELECT
        metric.organization_id, metric.building_id, metric.series_kind,
        metric.series_id, metric.metric_name, metric.bucket_hour
      FROM public.network_metric_hourly metric
      WHERE metric.organization_id = v_organization.organization_id
        AND metric.bucket_hour <
          date_trunc('hour', p_now - INTERVAL '13 months')
      ORDER BY
        metric.bucket_hour, metric.building_id, metric.series_kind,
        metric.series_id, metric.metric_name
      FOR UPDATE SKIP LOCKED
      LIMIT 5000
    )
    DELETE FROM public.network_metric_hourly metric
    USING victims
    WHERE metric.organization_id = victims.organization_id
      AND metric.building_id = victims.building_id
      AND metric.series_kind = victims.series_kind
      AND metric.series_id = victims.series_id
      AND metric.metric_name = victims.metric_name
      AND metric.bucket_hour = victims.bucket_hour;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    v_hourly_deleted := v_hourly_deleted + v_count;
  END LOOP;

  FOR v_organization IN
    SELECT DISTINCT daily.organization_id
    FROM public.network_sla_daily daily
    WHERE daily.sla_day <
      ((p_now - INTERVAL '36 months') AT TIME ZONE 'UTC')::date
    ORDER BY daily.organization_id
  LOOP
    WITH victims AS MATERIALIZED (
      SELECT daily.organization_id, daily.building_id, daily.sla_day
      FROM public.network_sla_daily daily
      WHERE daily.organization_id = v_organization.organization_id
        AND daily.sla_day <
          ((p_now - INTERVAL '36 months') AT TIME ZONE 'UTC')::date
      ORDER BY daily.sla_day, daily.building_id
      FOR UPDATE SKIP LOCKED
      LIMIT 1000
    )
    DELETE FROM public.network_sla_daily daily
    USING victims
    WHERE daily.organization_id = victims.organization_id
      AND daily.building_id = victims.building_id
      AND daily.sla_day = victims.sla_day;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    v_daily_deleted := v_daily_deleted + v_count;
  END LOOP;

  FOR v_organization IN
    SELECT DISTINCT session.organization_id
    FROM public.network_client_sessions session
    WHERE session.last_seen_at < p_now - INTERVAL '90 days'
    ORDER BY session.organization_id
  LOOP
    WITH victims AS MATERIALIZED (
      SELECT session.id
      FROM public.network_client_sessions session
      WHERE session.organization_id = v_organization.organization_id
        AND session.last_seen_at < p_now - INTERVAL '90 days'
      ORDER BY session.last_seen_at, session.id
      FOR UPDATE SKIP LOCKED
      LIMIT 1000
    )
    DELETE FROM public.network_client_sessions session
    USING victims
    WHERE session.id = victims.id;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    v_sessions_deleted := v_sessions_deleted + v_count;
  END LOOP;

  FOR v_organization IN
    SELECT DISTINCT command.organization_id
    FROM public.network_commands command
    WHERE command.status IN (
        'SUCCEEDED', 'FAILED', 'CANCELLED_BY_KILL_SWITCH'
      )
      AND command.finished_at < p_now - INTERVAL '180 days'
    ORDER BY command.organization_id
  LOOP
    SELECT array_agg(candidate.id ORDER BY candidate.finished_at, candidate.id)
    INTO v_command_ids
    FROM (
      SELECT command.id, command.finished_at
      FROM public.network_commands command
      WHERE command.organization_id = v_organization.organization_id
        AND command.status IN (
          'SUCCEEDED', 'FAILED', 'CANCELLED_BY_KILL_SWITCH'
        )
        AND command.finished_at < p_now - INTERVAL '180 days'
      ORDER BY command.finished_at, command.id
      FOR UPDATE SKIP LOCKED
      LIMIT 100
    ) candidate;

    IF coalesce(cardinality(v_command_ids), 0) = 0 THEN
      CONTINUE;
    END IF;

    INSERT INTO public.network_audit_events (
      organization_id, building_id, actor_type, action, target_type,
      target_id, target_display, reason, validation, result, outcome,
      occurred_at
    )
    SELECT
      command.organization_id,
      command.building_id,
      'SYSTEM',
      'command.retention_summary',
      'command',
      command.id,
      jsonb_build_object(
        'deviceId', command.device_id,
        'actionType', command.action_type
      ),
      'Sanitized terminal command summary retained before lifecycle deletion.',
      jsonb_build_object(
        'attemptCount', command.attempt_count,
        'reconciliationState', command.reconciliation_state
      ),
      jsonb_build_object(
        'terminalStatus', command.status,
        'startedAt', command.started_at,
        'finishedAt', command.finished_at
      ),
      'OBSERVED',
      p_now
    FROM public.network_commands command
    WHERE command.id = ANY(v_command_ids)
      AND NOT EXISTS (
        SELECT 1
        FROM public.network_audit_events audit
        WHERE audit.organization_id = command.organization_id
          AND audit.building_id = command.building_id
          AND audit.actor_type = 'SYSTEM'
          AND audit.action = 'command.retention_summary'
          AND audit.target_type = 'command'
          AND audit.target_id = command.id
          AND audit.outcome = 'OBSERVED'
          AND audit.reason =
            'Sanitized terminal command summary retained before lifecycle deletion.'
          AND audit.validation->>'attemptCount' = command.attempt_count::text
          AND audit.validation->>'reconciliationState' =
            command.reconciliation_state
          AND audit.result->>'terminalStatus' = command.status
      );

    IF EXISTS (
      SELECT 1
      FROM public.network_commands command
      WHERE command.id = ANY(v_command_ids)
        AND NOT EXISTS (
          SELECT 1
          FROM public.network_audit_events audit
          WHERE audit.organization_id = command.organization_id
            AND audit.building_id = command.building_id
            AND audit.actor_type = 'SYSTEM'
            AND audit.action = 'command.retention_summary'
            AND audit.target_type = 'command'
            AND audit.target_id = command.id
            AND audit.outcome = 'OBSERVED'
            AND audit.reason =
              'Sanitized terminal command summary retained before lifecycle deletion.'
            AND audit.validation->>'attemptCount' = command.attempt_count::text
            AND audit.validation->>'reconciliationState' =
              command.reconciliation_state
            AND audit.result->>'terminalStatus' = command.status
        )
    ) THEN
      RAISE EXCEPTION 'Canonical command retention summary is missing'
        USING ERRCODE = '55000';
    END IF;

    INSERT INTO app_private.network_center_command_retention_contexts (
      backend_pid, transaction_id
    ) VALUES (
      pg_backend_pid(), txid_current()
    )
    ON CONFLICT (backend_pid, transaction_id) DO NOTHING;

    PERFORM set_config(
      'app_private.network_center_command_retention', 'on', true
    );

    DELETE FROM public.network_device_leases lease
    WHERE lease.command_id = ANY(v_command_ids);

    DELETE FROM public.network_command_events event
    WHERE event.command_id = ANY(v_command_ids);

    DELETE FROM public.network_command_attempts attempt
    WHERE attempt.command_id = ANY(v_command_ids);

    DELETE FROM public.network_commands command
    WHERE command.id = ANY(v_command_ids)
      AND command.status IN (
        'SUCCEEDED', 'FAILED', 'CANCELLED_BY_KILL_SWITCH'
      );
    GET DIAGNOSTICS v_count = ROW_COUNT;
    v_commands_deleted := v_commands_deleted + v_count;

    DELETE FROM app_private.network_center_command_retention_contexts context
    WHERE context.backend_pid = pg_backend_pid()
      AND context.transaction_id = txid_current();

    PERFORM set_config(
      'app_private.network_center_command_retention', 'off', true
    );
  END LOOP;

  PERFORM app_private.network_center_ensure_raw_partitions_v1(
    (p_now AT TIME ZONE 'UTC')::date - 1,
    (p_now AT TIME ZONE 'UTC')::date + 31
  );

  RETURN jsonb_build_object(
    'raw_partitions_dropped', v_dropped,
    'hourly_rows_deleted', v_hourly_deleted,
    'daily_rows_deleted', v_daily_deleted,
    'client_sessions_deleted', v_sessions_deleted,
    'terminal_commands_deleted', v_commands_deleted,
    'raw_retention_days', 14,
    'hourly_retention_months', 13,
    'daily_retention_months', 36,
    'client_session_retention_days', 90,
    'terminal_command_retention_days', 180
  );
END;
$fn$;

REVOKE ALL ON FUNCTION app_private.network_center_guard_command_immutable_v1()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE app_private.network_center_command_retention_contexts
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.network_center_enqueue_command_v1(
  uuid, uuid, uuid, uuid, text, text, jsonb, jsonb, uuid, text, text,
  timestamp with time zone
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.network_center_compact_client_history_v1()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.network_center_guard_command_events_v2()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.network_center_guard_command_evidence_v2()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.network_center_retention_v1(
  timestamp with time zone
) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON COLUMN public.network_commands.semantic_fingerprint IS
  'SHA-256 of canonical tenant, target, action and sanitized parameters; excludes reason and browser idempotency key.';
COMMENT ON TABLE app_private.network_center_command_retention_contexts IS
  'Transaction-bound retention capability keyed by backend PID and transaction ID; API roles have no access.';
COMMENT ON FUNCTION app_private.network_center_retention_v1(
  timestamp with time zone
) IS
  'Bounded repeat-safe retention for telemetry, client history and summarized terminal command data.';

COMMIT;

NOTIFY pgrst, 'reload schema';
