-- =============================================================================
-- Network Center additive forward-fix: repair the compatibility projection in
-- public.network_center_admin_status_v1.
--
-- 20260729134000_network_center_admin_control_plane.sql projected
-- `state.enabled` and `state.cutover_finalized_at` from
-- app_private.network_worker_compatibility_state. That table has neither
-- column; its six columns are singleton, worker_id, activated_at, expires_at,
-- finalized_at and assignment_snapshot. plpgsql resolves column references when
-- a statement first EXECUTES, not when the function is created, so the broken
-- migration applied cleanly and every catalog-shaped post-apply audit passed
-- while the function raised 42703 ("column state.enabled does not exist") on
-- its first real call.
--
-- The blast radius is the whole admin CLI, not just `status`: every mutating
-- command in scripts/network-center-admin.mjs (provision-worker, rotate-worker,
-- revoke-worker, assign, unassign, provision-connection, set-rollout,
-- finalize-worker-cutover) performs its readback through this function AFTER
-- the mutating RPC has committed. A failed readback therefore produced exactly
-- the commit-then-disconnect shape this project hardened against: a worker and
-- its credential durably created, and the operator handed an error.
--
-- `enabled` is restored to the definition every compatibility gate already
-- enforces -- app_private.network_center_compatibility_worker_v1 and
-- app_private.network_center_compatibility_can_access_device_v1 both admit the
-- legacy principal only while `finalized_at IS NULL AND expires_at > now` --
-- and `cutoverFinalizedAt` is restored to the column the finalize path writes,
-- public.network_center_admin_finalize_worker_compatibility_v1 setting
-- `finalized_at = now, expires_at = LEAST(expires_at, now)`. Reading the same
-- predicate keeps the status payload and the admission decision from drifting.
--
-- Nothing else changes: the signature, STABLE volatility, ownership,
-- SECURITY DEFINER status, the pinned `search_path=pg_catalog` and the
-- service-role-only grant are all re-declared exactly as they already are.
-- =============================================================================

BEGIN;

SELECT pg_advisory_xact_lock(20260729140000::bigint);

-- Fail closed if the compatibility window ever stops being expressed by the two
-- columns this projection now reads, instead of silently shipping another
-- late-bound reference.
DO $preflight$
BEGIN
  IF to_regclass('app_private.network_worker_compatibility_state') IS NULL THEN
    RAISE EXCEPTION 'app_private.network_worker_compatibility_state is missing'
      USING ERRCODE = '42P01';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_attribute
    WHERE attrelid = 'app_private.network_worker_compatibility_state'::regclass
      AND attname = 'finalized_at'
      AND attnum > 0
      AND NOT attisdropped
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_attribute
    WHERE attrelid = 'app_private.network_worker_compatibility_state'::regclass
      AND attname = 'expires_at'
      AND attnum > 0
      AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION
      'Worker compatibility window columns finalized_at/expires_at are missing'
      USING ERRCODE = '42703';
  END IF;
END;
$preflight$;

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

  -- Forward fix. `enabled` is the live compatibility window, expressed with the
  -- same predicate the compatibility admission helpers use, and
  -- `cutoverFinalizedAt` is the one-way finalize stamp.
  SELECT coalesce(jsonb_agg(to_jsonb(row_data)), '[]'::jsonb)
  INTO v_compatibility
  FROM (
    SELECT worker.worker_key AS "workerKey",
      (
        state.finalized_at IS NULL
        AND state.expires_at > clock_timestamp()
      ) AS enabled,
      state.finalized_at AS "cutoverFinalizedAt"
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

-- Re-declared verbatim from 20260729134000. CREATE OR REPLACE preserves the
-- existing owner and ACL, so this widens nothing; it only keeps the migration
-- self-sufficient on a cluster where the function is created here first.
REVOKE ALL ON FUNCTION public.network_center_admin_status_v1(uuid, integer)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.network_center_admin_status_v1(uuid, integer)
  TO service_role;

COMMENT ON FUNCTION public.network_center_admin_status_v1(uuid, integer)
IS 'Service-role-only bounded redacted Network Center control-plane status.';

-- The defect survived apply because nothing ever ran the function. Run it. A
-- successful call forces plan-time resolution of every projection in the body,
-- so a late-bound column reference anywhere in it fails this migration instead
-- of the next operator readback. Both branches of the p_building_id predicate
-- live in the same statements, so one unfiltered call plus one filtered call
-- exercise the whole body without writing anything (the function is STABLE).
DO $runtime_proof$
DECLARE
  v_status jsonb;
  v_secdef boolean;
  v_volatile "char";
  v_config text[];
BEGIN
  v_status := public.network_center_admin_status_v1(NULL, 1);
  PERFORM public.network_center_admin_status_v1(
    '00000000-0000-4000-8000-000000000000'::uuid, 1
  );
  IF v_status IS NULL
     OR jsonb_typeof(v_status -> 'compatibility') <> 'array'
     OR jsonb_typeof(v_status -> 'settings') <> 'array'
     OR jsonb_typeof(v_status -> 'connections') <> 'array'
     OR jsonb_typeof(v_status -> 'workers') <> 'array'
     OR jsonb_typeof(v_status -> 'credentialWindows') <> 'array'
     OR jsonb_typeof(v_status -> 'assignments') <> 'array' THEN
    RAISE EXCEPTION 'Network Center admin status payload shape regressed'
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_status -> 'compatibility') entry
    WHERE jsonb_typeof(entry -> 'enabled') <> 'boolean'
      OR NOT (entry ? 'workerKey')
      OR NOT (entry ? 'cutoverFinalizedAt')
  ) THEN
    RAISE EXCEPTION 'Network Center compatibility projection lost a key'
      USING ERRCODE = '22023';
  END IF;

  SELECT p.prosecdef, p.provolatile, p.proconfig
  INTO v_secdef, v_volatile, v_config
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'network_center_admin_status_v1'
    AND p.oid::regprocedure::text
      = 'network_center_admin_status_v1(uuid,integer)';
  IF NOT FOUND
     OR v_secdef IS NOT TRUE
     OR v_volatile <> 's'
     OR v_config IS DISTINCT FROM ARRAY['search_path=pg_catalog']::text[] THEN
    RAISE EXCEPTION 'Network Center admin status definer profile regressed'
      USING ERRCODE = '42501';
  END IF;

  IF NOT has_function_privilege(
       'service_role',
       'public.network_center_admin_status_v1(uuid,integer)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated',
       'public.network_center_admin_status_v1(uuid,integer)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'anon',
       'public.network_center_admin_status_v1(uuid,integer)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'public',
       'public.network_center_admin_status_v1(uuid,integer)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'Network Center admin status grant surface changed'
      USING ERRCODE = '42501';
  END IF;
END;
$runtime_proof$;

COMMIT;

NOTIFY pgrst, 'reload schema';
