-- =============================================================================
-- Network Center hardening 5/5: service-role-only administrative control plane.
--
-- This migration is intentionally additive. Runtime administration never receives
-- direct table DML and no plaintext worker/router credential enters PostgreSQL.
-- =============================================================================

BEGIN;

SELECT pg_advisory_xact_lock(20260729134000::bigint);

CREATE UNIQUE INDEX network_device_connections_one_enabled_per_device_idx
  ON public.network_device_connections (device_id)
  WHERE is_enabled;

REVOKE ALL ON TABLE public.network_device_connections
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.network_site_settings
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.network_center_admin_provision_connection_v1(
  p_device_id uuid,
  p_transport text,
  p_management_ip inet,
  p_management_port integer,
  p_credential_ref text,
  p_host_key_fingerprint text,
  p_poll_interval_seconds integer DEFAULT 60,
  p_connect_timeout_ms integer DEFAULT 8000,
  p_request_id uuid DEFAULT gen_random_uuid()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $fn$
DECLARE
  v_identity record;
  v_building record;
  v_settings record;
  v_device record;
  v_connection_id uuid;
BEGIN
  IF p_device_id IS NULL
     OR upper(btrim(coalesce(p_transport, ''))) <> 'ROUTEROS_SSH'
     OR p_management_ip IS NULL
     OR p_management_port NOT BETWEEN 1 AND 65535
     OR p_credential_ref IS NULL
     OR p_credential_ref !~ '^router/[A-Za-z0-9][A-Za-z0-9._/-]{1,127}$'
     OR p_host_key_fingerprint IS NULL
     OR p_host_key_fingerprint !~ '^SHA256:[A-Za-z0-9+/]{20,}={0,2}$'
     OR p_poll_interval_seconds NOT BETWEEN 30 AND 3600
     OR p_connect_timeout_ms NOT BETWEEN 1000 AND 30000
     OR p_request_id IS NULL THEN
    RAISE EXCEPTION 'Invalid Network Center connection provision request'
      USING ERRCODE = '22023';
  END IF;

  -- Resolve identity without trusting caller-supplied tenant/building fields, then
  -- take locks in the global order: building -> settings -> device -> connections.
  SELECT device.organization_id, device.building_id
  INTO v_identity
  FROM public.network_devices device
  WHERE device.id = p_device_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Network device not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT building.organization_id, building.id, building.name
  INTO v_building
  FROM public.buildings building
  WHERE building.organization_id = v_identity.organization_id
    AND building.id = v_identity.building_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Network building not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT settings.id, settings.version, settings.rollout_state
  INTO v_settings
  FROM public.network_site_settings settings
  WHERE settings.organization_id = v_building.organization_id
    AND settings.building_id = v_building.id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Network settings not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_settings.rollout_state = 'EXECUTE' THEN
    RAISE EXCEPTION 'Disable Network Center execution before changing connection metadata'
      USING ERRCODE = '55000';
  END IF;

  SELECT device.id, device.organization_id, device.building_id, device.device_kind
  INTO v_device
  FROM public.network_devices device
  WHERE device.id = p_device_id
    AND device.organization_id = v_building.organization_id
    AND device.building_id = v_building.id
  FOR UPDATE;
  IF NOT FOUND OR v_device.device_kind <> 'MIKROTIK' THEN
    RAISE EXCEPTION 'Connection target must be the scoped MikroTik device'
      USING ERRCODE = '22023';
  END IF;

  PERFORM connection.id
  FROM public.network_device_connections connection
  WHERE connection.organization_id = v_building.organization_id
    AND connection.building_id = v_building.id
    AND connection.device_id = v_device.id
  ORDER BY connection.id
  FOR UPDATE;

  UPDATE public.network_device_connections connection
  SET is_enabled = false,
      updated_at = clock_timestamp()
  WHERE connection.organization_id = v_building.organization_id
    AND connection.building_id = v_building.id
    AND connection.device_id = v_device.id
    AND connection.is_enabled;

  INSERT INTO public.network_device_connections (
    organization_id,
    building_id,
    device_id,
    transport,
    management_ip,
    management_port,
    credential_ref,
    host_key_fingerprint,
    poll_interval_seconds,
    connect_timeout_ms,
    is_enabled
  ) VALUES (
    v_building.organization_id,
    v_building.id,
    v_device.id,
    'ROUTEROS_SSH',
    p_management_ip,
    p_management_port,
    p_credential_ref,
    p_host_key_fingerprint,
    p_poll_interval_seconds,
    p_connect_timeout_ms,
    true
  )
  ON CONFLICT (device_id, transport, management_ip, management_port)
  DO UPDATE SET
    credential_ref = EXCLUDED.credential_ref,
    host_key_fingerprint = EXCLUDED.host_key_fingerprint,
    poll_interval_seconds = EXCLUDED.poll_interval_seconds,
    connect_timeout_ms = EXCLUDED.connect_timeout_ms,
    is_enabled = true,
    updated_at = clock_timestamp()
  RETURNING id INTO v_connection_id;

  INSERT INTO public.network_audit_events (
    organization_id,
    building_id,
    actor_type,
    action,
    target_type,
    target_id,
    target_display,
    reason,
    validation,
    result,
    outcome,
    request_id,
    occurred_at
  ) VALUES (
    v_building.organization_id,
    v_building.id,
    'SYSTEM',
    'admin.provision_connection',
    'connection',
    v_connection_id,
    jsonb_build_object(
      'buildingName', v_building.name,
      'deviceId', v_device.id,
      'transport', 'ROUTEROS_SSH'
    ),
    'Provision pinned Network Center connection metadata',
    jsonb_build_object(
      'settingsVersion', v_settings.version,
      'managementIp', host(p_management_ip),
      'managementPort', p_management_port
    ),
    jsonb_build_object(
      'credentialRef', p_credential_ref,
      'hostKeyFingerprint', p_host_key_fingerprint,
      'enabled', true
    ),
    'SUCCEEDED',
    p_request_id,
    clock_timestamp()
  );

  RETURN jsonb_build_object(
    'connectionId', v_connection_id,
    'organizationId', v_building.organization_id,
    'buildingId', v_building.id,
    'deviceId', v_device.id,
    'transport', 'ROUTEROS_SSH',
    'managementIp', host(p_management_ip),
    'managementPort', p_management_port,
    'credentialRef', p_credential_ref,
    'hostKeyFingerprint', p_host_key_fingerprint,
    'enabled', true
  );
END;
$fn$;

CREATE OR REPLACE FUNCTION public.network_center_admin_set_rollout_v1(
  p_building_id uuid,
  p_rollout_state text,
  p_expected_version bigint,
  p_reason text,
  p_request_id uuid DEFAULT gen_random_uuid()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $fn$
DECLARE
  v_building record;
  v_settings record;
  v_target text := upper(btrim(coalesce(p_rollout_state, '')));
  v_new_version bigint;
BEGIN
  IF p_building_id IS NULL
     OR v_target NOT IN ('OFF', 'READ_ONLY', 'EXECUTE')
     OR p_expected_version IS NULL
     OR p_expected_version < 1
     OR p_reason IS NULL
     OR char_length(btrim(p_reason)) NOT BETWEEN 3 AND 500
     OR p_request_id IS NULL THEN
    RAISE EXCEPTION 'Invalid Network Center rollout request' USING ERRCODE = '22023';
  END IF;

  SELECT building.organization_id, building.id, building.name
  INTO v_building
  FROM public.buildings building
  WHERE building.id = p_building_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Network building not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT settings.id, settings.rollout_state, settings.version
  INTO v_settings
  FROM public.network_site_settings settings
  WHERE settings.organization_id = v_building.organization_id
    AND settings.building_id = v_building.id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Network settings not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_settings.version <> p_expected_version THEN
    RAISE EXCEPTION 'Network rollout changed; reload status before updating'
      USING ERRCODE = '40001';
  END IF;

  -- Upward transitions must pass OFF -> READ_ONLY -> EXECUTE. Downward transitions
  -- are always fail-safe. Executions that already recorded EXECUTION_STARTED may
  -- complete; the worker admission gates reject every new execution after commit.
  IF v_settings.rollout_state = 'OFF' AND v_target = 'EXECUTE' THEN
    RAISE EXCEPTION 'Network rollout must pass through READ_ONLY before EXECUTE'
      USING ERRCODE = '22023';
  END IF;
  IF v_settings.rollout_state = 'OFF' AND v_target NOT IN ('OFF', 'READ_ONLY') THEN
    RAISE EXCEPTION 'Invalid Network rollout transition' USING ERRCODE = '22023';
  END IF;
  IF v_settings.rollout_state = 'READ_ONLY'
     AND v_target NOT IN ('OFF', 'READ_ONLY', 'EXECUTE') THEN
    RAISE EXCEPTION 'Invalid Network rollout transition' USING ERRCODE = '22023';
  END IF;

  IF v_settings.rollout_state = v_target THEN
    RETURN jsonb_build_object(
      'organizationId', v_building.organization_id,
      'buildingId', v_building.id,
      'rolloutState', v_target,
      'previousRolloutState', v_settings.rollout_state,
      'version', v_settings.version,
      'changed', false
    );
  END IF;

  UPDATE public.network_site_settings settings
  SET rollout_state = v_target,
      version = settings.version + 1,
      updated_at = clock_timestamp()
  WHERE settings.id = v_settings.id
  RETURNING settings.version INTO v_new_version;

  INSERT INTO public.network_audit_events (
    organization_id,
    building_id,
    actor_type,
    action,
    target_type,
    target_id,
    target_display,
    reason,
    validation,
    result,
    outcome,
    request_id,
    occurred_at
  ) VALUES (
    v_building.organization_id,
    v_building.id,
    'SYSTEM',
    'admin.set_rollout',
    'building',
    v_building.id,
    jsonb_build_object('buildingName', v_building.name),
    btrim(p_reason),
    jsonb_build_object(
      'expectedVersion', p_expected_version,
      'previousRolloutState', v_settings.rollout_state
    ),
    jsonb_build_object(
      'rolloutState', v_target,
      'version', v_new_version
    ),
    'SUCCEEDED',
    p_request_id,
    clock_timestamp()
  );

  RETURN jsonb_build_object(
    'organizationId', v_building.organization_id,
    'buildingId', v_building.id,
    'rolloutState', v_target,
    'previousRolloutState', v_settings.rollout_state,
    'version', v_new_version,
    'changed', true
  );
END;
$fn$;

CREATE OR REPLACE FUNCTION public.network_center_admin_status_v1(
  p_building_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 100
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $fn$
DECLARE
  v_settings jsonb;
  v_connections jsonb;
  v_workers jsonb;
  v_credentials jsonb;
  v_assignments jsonb;
  v_compatibility jsonb;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'Network Center status limit must be between 1 and 200'
      USING ERRCODE = '22023';
  END IF;

  SELECT coalesce(jsonb_agg(to_jsonb(row_data)), '[]'::jsonb)
  INTO v_settings
  FROM (
    SELECT settings.organization_id AS "organizationId",
      settings.building_id AS "buildingId",
      settings.rollout_state AS "rolloutState",
      settings.changes_paused AS "changesPaused",
      settings.monitoring_enabled AS "monitoringEnabled",
      settings.version,
      settings.updated_at AS "updatedAt"
    FROM public.network_site_settings settings
    WHERE p_building_id IS NULL OR settings.building_id = p_building_id
    ORDER BY settings.organization_id, settings.building_id
    LIMIT p_limit
  ) row_data;

  SELECT coalesce(jsonb_agg(to_jsonb(row_data)), '[]'::jsonb)
  INTO v_connections
  FROM (
    SELECT connection.organization_id AS "organizationId",
      connection.building_id AS "buildingId",
      connection.device_id AS "deviceId",
      connection.id AS "connectionId",
      connection.transport,
      host(connection.management_ip) AS "managementIp",
      connection.management_port AS "managementPort",
      connection.credential_ref AS "credentialRef",
      connection.host_key_fingerprint AS "hostKeyFingerprint",
      connection.is_enabled AS enabled,
      connection.updated_at AS "updatedAt"
    FROM public.network_device_connections connection
    WHERE p_building_id IS NULL OR connection.building_id = p_building_id
    ORDER BY connection.organization_id, connection.building_id, connection.id
    LIMIT p_limit
  ) row_data;

  SELECT coalesce(jsonb_agg(to_jsonb(row_data)), '[]'::jsonb)
  INTO v_workers
  FROM (
    SELECT worker.id AS "workerId", worker.worker_key AS "workerKey",
      worker.display_name AS "displayName", worker.status,
      worker.capabilities, worker.version, worker.updated_at AS "updatedAt"
    FROM public.network_workers worker
    WHERE p_building_id IS NULL OR EXISTS (
      SELECT 1
      FROM public.network_worker_assignments assignment
      WHERE assignment.worker_id = worker.id
        AND assignment.building_id = p_building_id
        AND assignment.active_until IS NULL
    )
    ORDER BY worker.worker_key
    LIMIT p_limit
  ) row_data;

  SELECT coalesce(jsonb_agg(to_jsonb(row_data)), '[]'::jsonb)
  INTO v_credentials
  FROM (
    SELECT worker.worker_key AS "workerKey",
      credential.fingerprint,
      credential.not_before AS "notBefore",
      credential.expires_at AS "expiresAt",
      credential.revoked_at AS "revokedAt",
      credential.last_used_at AS "lastUsedAt"
    FROM public.network_worker_credentials credential
    JOIN public.network_workers worker ON worker.id = credential.worker_id
    WHERE p_building_id IS NULL OR EXISTS (
      SELECT 1
      FROM public.network_worker_assignments assignment
      WHERE assignment.worker_id = worker.id
        AND assignment.building_id = p_building_id
        AND assignment.active_until IS NULL
    )
    ORDER BY worker.worker_key, credential.not_before DESC, credential.id
    LIMIT p_limit
  ) row_data;

  SELECT coalesce(jsonb_agg(to_jsonb(row_data)), '[]'::jsonb)
  INTO v_assignments
  FROM (
    SELECT worker.worker_key AS "workerKey",
      assignment.organization_id AS "organizationId",
      assignment.building_id AS "buildingId",
      assignment.device_id AS "deviceId",
      assignment.can_poll AS "canPoll",
      assignment.can_inventory AS "canInventory",
      assignment.can_execute AS "canExecute",
      assignment.active_from AS "activeFrom",
      assignment.active_until AS "activeUntil",
      assignment.assignment_version AS "assignmentVersion"
    FROM public.network_worker_assignments assignment
    JOIN public.network_workers worker ON worker.id = assignment.worker_id
    WHERE p_building_id IS NULL OR assignment.building_id = p_building_id
    ORDER BY worker.worker_key, assignment.organization_id,
      assignment.building_id, assignment.device_id
    LIMIT p_limit
  ) row_data;

  SELECT coalesce(jsonb_agg(to_jsonb(row_data)), '[]'::jsonb)
  INTO v_compatibility
  FROM (
    SELECT worker.worker_key AS "workerKey",
      state.enabled, state.cutover_finalized_at AS "cutoverFinalizedAt"
    FROM app_private.network_worker_compatibility_state state
    JOIN public.network_workers worker ON worker.id = state.worker_id
    ORDER BY worker.worker_key
    LIMIT p_limit
  ) row_data;

  RETURN jsonb_build_object(
    'settings', v_settings,
    'connections', v_connections,
    'workers', v_workers,
    'credentialWindows', v_credentials,
    'assignments', v_assignments,
    'compatibility', v_compatibility
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.network_center_admin_provision_connection_v1(
  uuid, text, inet, integer, text, text, integer, integer, uuid
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.network_center_admin_set_rollout_v1(
  uuid, text, bigint, text, uuid
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.network_center_admin_status_v1(uuid, integer)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.network_center_admin_provision_connection_v1(
  uuid, text, inet, integer, text, text, integer, integer, uuid
) TO service_role;
GRANT EXECUTE ON FUNCTION public.network_center_admin_set_rollout_v1(
  uuid, text, bigint, text, uuid
) TO service_role;
GRANT EXECUTE ON FUNCTION public.network_center_admin_status_v1(uuid, integer)
  TO service_role;

COMMENT ON FUNCTION public.network_center_admin_provision_connection_v1(
  uuid, text, inet, integer, text, text, integer, integer, uuid
) IS 'Service-role-only pinned RouterOS SSH connection provisioning; accepts opaque credential references, never credential material.';
COMMENT ON FUNCTION public.network_center_admin_set_rollout_v1(
  uuid, text, bigint, text, uuid
) IS 'Service-role-only CAS rollout transition with durable SYSTEM audit.';
COMMENT ON FUNCTION public.network_center_admin_status_v1(uuid, integer)
IS 'Service-role-only bounded redacted Network Center control-plane status.';

COMMIT;

NOTIFY pgrst, 'reload schema';
