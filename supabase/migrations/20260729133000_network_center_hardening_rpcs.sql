-- Network Center: bind every worker call to an authenticated principal and an
-- explicit, currently-active device assignment. The migration is additive;
-- legacy v1 entry points remain only for one bounded compatibility snapshot.

BEGIN;

SELECT pg_advisory_xact_lock(20260729133000::bigint);

-- Browser-visible worker state is deliberately building scoped. It contains no
-- worker identity, credential material, metadata, or cross-building join key.
CREATE TABLE public.network_worker_building_status (
  organization_id uuid NOT NULL,
  building_id uuid NOT NULL,
  status text NOT NULL
    CHECK (status IN ('ONLINE', 'DEGRADED', 'PAUSED', 'STOPPING')),
  heartbeat_at timestamptz NOT NULL,
  queue_age_seconds integer NOT NULL DEFAULT 0
    CHECK (queue_age_seconds BETWEEN 0 AND 31536000),
  started_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT network_worker_building_status_building_fk
    FOREIGN KEY (organization_id, building_id)
    REFERENCES public.buildings(organization_id, id) ON DELETE CASCADE,
  CONSTRAINT network_worker_building_status_time_check
    CHECK (started_at <= heartbeat_at),
  PRIMARY KEY (organization_id, building_id)
);

CREATE INDEX network_worker_building_status_tenant_building_idx
  ON public.network_worker_building_status (
    organization_id, building_id, heartbeat_at DESC
  );

ALTER TABLE public.network_worker_building_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.network_worker_building_status FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS network_worker_building_status_view
  ON public.network_worker_building_status;
CREATE POLICY network_worker_building_status_view
  ON public.network_worker_building_status
  FOR SELECT TO authenticated
  USING ((SELECT public.can_do_on_building(
    'network_center', 'view', building_id
  )));

REVOKE ALL ON TABLE public.network_worker_building_status
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.network_worker_building_status TO authenticated;

DROP POLICY IF EXISTS network_worker_heartbeats_view
  ON public.network_worker_heartbeats;
REVOKE ALL ON TABLE public.network_worker_heartbeats
  FROM PUBLIC, anon, authenticated, service_role;
ALTER PUBLICATION supabase_realtime
  DROP TABLE public.network_worker_heartbeats;
ALTER PUBLICATION supabase_realtime
  ADD TABLE public.network_worker_building_status;

-- This helper is intentionally locking rather than STABLE: assignment closure,
-- worker disablement and capability changes serialize with the side effect that
-- follows the check. A committed revoke therefore wins before a later writer.
CREATE OR REPLACE FUNCTION app_private.network_center_worker_can_access_device_v2(
  p_worker_id uuid,
  p_organization_id uuid,
  p_building_id uuid,
  p_device_id uuid,
  p_required_capability text,
  p_now timestamptz DEFAULT clock_timestamp()
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $fn$
BEGIN
  IF p_worker_id IS NULL OR p_organization_id IS NULL
     OR p_building_id IS NULL OR p_device_id IS NULL
     OR p_required_capability NOT IN (
       'HEARTBEAT', 'POLL', 'TELEMETRY', 'INVENTORY',
       'EXECUTE', 'INCIDENT', 'SNAPSHOT', 'MAINTENANCE'
     ) OR p_now IS NULL THEN
    RETURN false;
  END IF;

  PERFORM 1
  FROM public.network_workers worker
  JOIN public.network_worker_assignments assignment
    ON assignment.worker_id = worker.id
  WHERE worker.id = p_worker_id
    AND worker.status IN ('ACTIVE', 'DRAINING')
    AND p_required_capability = ANY(worker.capabilities)
    AND assignment.worker_id = p_worker_id
    AND assignment.organization_id = p_organization_id
    AND assignment.building_id = p_building_id
    AND assignment.device_id = p_device_id
    AND assignment.active_from <= p_now
    AND (assignment.active_until IS NULL OR assignment.active_until > p_now)
    AND CASE
      WHEN p_required_capability = 'HEARTBEAT' THEN
        assignment.can_poll OR assignment.can_inventory OR assignment.can_execute
      WHEN p_required_capability IN (
        'POLL', 'TELEMETRY', 'INCIDENT', 'MAINTENANCE'
      ) THEN assignment.can_poll
      WHEN p_required_capability = 'INVENTORY' THEN assignment.can_inventory
      WHEN p_required_capability IN ('EXECUTE', 'SNAPSHOT') THEN assignment.can_execute
      ELSE false
    END
  FOR UPDATE OF worker, assignment;
  RETURN FOUND;
END;
$fn$;

CREATE OR REPLACE FUNCTION app_private.network_center_worker_can_access_building_v2(
  p_worker_id uuid,
  p_organization_id uuid,
  p_building_id uuid,
  p_required_capability text,
  p_now timestamptz DEFAULT clock_timestamp()
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $fn$
BEGIN
  IF p_worker_id IS NULL OR p_organization_id IS NULL
     OR p_building_id IS NULL
     OR p_required_capability NOT IN (
       'HEARTBEAT', 'POLL', 'TELEMETRY', 'INVENTORY',
       'EXECUTE', 'INCIDENT', 'SNAPSHOT', 'MAINTENANCE'
     ) OR p_now IS NULL THEN
    RETURN false;
  END IF;

  PERFORM 1
  FROM public.network_workers worker
  JOIN public.network_worker_assignments assignment
    ON assignment.worker_id = worker.id
  WHERE worker.id = p_worker_id
    AND worker.status IN ('ACTIVE', 'DRAINING')
    AND p_required_capability = ANY(worker.capabilities)
    AND assignment.worker_id = p_worker_id
    AND assignment.organization_id = p_organization_id
    AND assignment.building_id = p_building_id
    AND assignment.active_from <= p_now
    AND (assignment.active_until IS NULL OR assignment.active_until > p_now)
    AND CASE
      WHEN p_required_capability = 'HEARTBEAT' THEN
        assignment.can_poll OR assignment.can_inventory OR assignment.can_execute
      WHEN p_required_capability IN (
        'POLL', 'TELEMETRY', 'INCIDENT', 'MAINTENANCE'
      ) THEN assignment.can_poll
      WHEN p_required_capability = 'INVENTORY' THEN assignment.can_inventory
      WHEN p_required_capability IN ('EXECUTE', 'SNAPSHOT') THEN assignment.can_execute
      ELSE false
    END
  FOR UPDATE OF worker, assignment;
  RETURN FOUND;
END;
$fn$;

-- Preserve only the mature payload writers. They are moved out of public so
-- neither service_role nor PostgREST can invoke them without a scoped facade.
ALTER FUNCTION public.network_center_worker_renew_v1(
  text, uuid, uuid, integer
) RENAME TO network_center_worker_renew_legacy_impl_v1;
ALTER FUNCTION public.network_center_worker_renew_legacy_impl_v1(
  text, uuid, uuid, integer
) SET SCHEMA app_private;

ALTER FUNCTION public.network_center_worker_ingest_v1(text, jsonb)
  RENAME TO network_center_worker_ingest_legacy_impl_v1;
ALTER FUNCTION public.network_center_worker_ingest_legacy_impl_v1(text, jsonb)
  SET SCHEMA app_private;

ALTER FUNCTION public.network_center_worker_inventory_v1(text, jsonb)
  RENAME TO network_center_worker_inventory_legacy_impl_v1;
ALTER FUNCTION public.network_center_worker_inventory_legacy_impl_v1(text, jsonb)
  SET SCHEMA app_private;

ALTER FUNCTION public.network_center_worker_command_event_v1(
  text, uuid, uuid, text, jsonb
) RENAME TO network_center_worker_command_event_legacy_impl_v1;
ALTER FUNCTION public.network_center_worker_command_event_legacy_impl_v1(
  text, uuid, uuid, text, jsonb
) SET SCHEMA app_private;

ALTER FUNCTION public.network_center_worker_upsert_incident_v1(text, jsonb)
  RENAME TO network_center_worker_upsert_incident_legacy_impl_v1;
ALTER FUNCTION public.network_center_worker_upsert_incident_legacy_impl_v1(
  text, jsonb
) SET SCHEMA app_private;

ALTER FUNCTION public.network_center_worker_snapshot_v1(text, jsonb)
  RENAME TO network_center_worker_snapshot_legacy_impl_v1;
ALTER FUNCTION public.network_center_worker_snapshot_legacy_impl_v1(text, jsonb)
  SET SCHEMA app_private;

REVOKE ALL ON FUNCTION app_private.network_center_worker_renew_legacy_impl_v1(
  text, uuid, uuid, integer
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.network_center_worker_ingest_legacy_impl_v1(
  text, jsonb
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.network_center_worker_inventory_legacy_impl_v1(
  text, jsonb
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.network_center_worker_command_event_legacy_impl_v1(
  text, uuid, uuid, text, jsonb
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.network_center_worker_upsert_incident_legacy_impl_v1(
  text, jsonb
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.network_center_worker_snapshot_legacy_impl_v1(
  text, jsonb
) FROM PUBLIC, anon, authenticated, service_role;

-- The compatibility principal is a one-time snapshot, not a wildcard. It has
-- no credential and no command capability, and it cannot outlive seven days.
CREATE TABLE app_private.network_worker_compatibility_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  worker_id uuid NOT NULL
    REFERENCES public.network_workers(id) ON DELETE RESTRICT,
  activated_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  finalized_at timestamptz,
  assignment_snapshot jsonb NOT NULL
    CHECK (jsonb_typeof(assignment_snapshot) = 'array'),
  CONSTRAINT network_worker_compatibility_max_window
    CHECK (expires_at <= activated_at + INTERVAL '7 days'),
  CONSTRAINT network_worker_compatibility_finalize_time
    CHECK (finalized_at IS NULL OR finalized_at >= activated_at)
);

ALTER TABLE app_private.network_worker_compatibility_state
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.network_worker_compatibility_state
  FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE app_private.network_worker_compatibility_state
  FROM PUBLIC, anon, authenticated, service_role;

DO $compatibility_seed$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_expires_at timestamptz := v_now + INTERVAL '7 days';
  v_worker_id uuid;
  v_snapshot jsonb;
BEGIN
  INSERT INTO public.network_workers (
    worker_key, display_name, status, capabilities
  ) VALUES (
    'legacy-v1-compat',
    'Legacy v1 compatibility (expires automatically)',
    'ACTIVE',
    ARRAY['POLL', 'INVENTORY']::text[]
  ) RETURNING id INTO v_worker_id;

  INSERT INTO public.network_worker_assignments (
    worker_id, organization_id, building_id, device_id, device_kind,
    can_poll, can_inventory, can_execute, active_from, active_until,
    created_by, updated_by
  )
  SELECT
    v_worker_id, device.organization_id, device.building_id, device.id,
    'MIKROTIK', true, true, false, v_now, v_expires_at,
    'legacy-v1-compatibility-snapshot',
    'legacy-v1-compatibility-snapshot'
  FROM public.network_devices device
  WHERE device.device_kind = 'MIKROTIK'
    AND device.is_active
    AND NOT EXISTS (
      SELECT 1
      FROM public.network_worker_assignments current_assignment
      WHERE current_assignment.organization_id = device.organization_id
        AND current_assignment.building_id = device.building_id
        AND current_assignment.device_id = device.id
        AND current_assignment.can_poll
        AND current_assignment.active_from <= v_now
        AND (
          current_assignment.active_until IS NULL
          OR current_assignment.active_until > v_now
        )
    );

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'assignmentId', assignment.id,
    'organizationId', assignment.organization_id,
    'buildingId', assignment.building_id,
    'deviceId', assignment.device_id,
    'canPoll', assignment.can_poll,
    'canInventory', assignment.can_inventory,
    'canExecute', false
  ) ORDER BY assignment.organization_id, assignment.building_id,
    assignment.device_id), '[]'::jsonb)
  INTO v_snapshot
  FROM public.network_worker_assignments assignment
  WHERE assignment.worker_id = v_worker_id
    AND assignment.created_by = 'legacy-v1-compatibility-snapshot';

  INSERT INTO app_private.network_worker_compatibility_state (
    singleton, worker_id, activated_at, expires_at,
    finalized_at, assignment_snapshot
  ) VALUES (
    true, v_worker_id, v_now, v_expires_at, NULL, v_snapshot
  );
END;
$compatibility_seed$;

CREATE OR REPLACE FUNCTION app_private.network_center_guard_compatibility_state_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $fn$
BEGIN
  IF OLD.finalized_at IS NOT NULL AND NEW.finalized_at IS DISTINCT FROM OLD.finalized_at THEN
    RAISE EXCEPTION 'Worker compatibility finalization is permanent'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.expires_at > OLD.expires_at
     OR NEW.assignment_snapshot IS DISTINCT FROM OLD.assignment_snapshot
     OR NEW.worker_id IS DISTINCT FROM OLD.worker_id
     OR NEW.activated_at IS DISTINCT FROM OLD.activated_at THEN
    RAISE EXCEPTION 'Worker compatibility snapshot cannot be expanded'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER network_worker_compatibility_one_way
  BEFORE UPDATE ON app_private.network_worker_compatibility_state
  FOR EACH ROW EXECUTE FUNCTION
    app_private.network_center_guard_compatibility_state_v1();

CREATE OR REPLACE FUNCTION app_private.network_center_compatibility_worker_v1()
RETURNS TABLE (worker_id uuid, worker_key text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $fn$
BEGIN
  SELECT worker.id, worker.worker_key
  INTO worker_id, worker_key
  FROM app_private.network_worker_compatibility_state state
  JOIN public.network_workers worker ON worker.id = state.worker_id
  WHERE state.singleton
    AND state.finalized_at IS NULL
    AND state.expires_at > clock_timestamp()
    AND worker.status = 'ACTIVE'
    AND worker.capabilities @> ARRAY['POLL', 'INVENTORY']::text[]
  FOR UPDATE OF state, worker;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Legacy worker compatibility is disabled or expired'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEXT;
END;
$fn$;

CREATE OR REPLACE FUNCTION app_private.network_center_compatibility_can_access_device_v1(
  p_worker_id uuid,
  p_organization_id uuid,
  p_building_id uuid,
  p_device_id uuid,
  p_required_capability text,
  p_now timestamptz DEFAULT clock_timestamp()
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $fn$
BEGIN
  PERFORM 1
  FROM app_private.network_worker_compatibility_state state
  JOIN public.network_worker_assignments assignment
    ON assignment.worker_id = state.worker_id
  WHERE state.singleton
    AND state.worker_id = p_worker_id
    AND state.finalized_at IS NULL
    AND state.expires_at > p_now
    AND assignment.organization_id = p_organization_id
    AND assignment.building_id = p_building_id
    AND assignment.device_id = p_device_id
    AND assignment.active_from <= p_now
    AND assignment.active_until > p_now
    AND CASE p_required_capability
      WHEN 'can_poll' THEN assignment.can_poll
      WHEN 'can_inventory' THEN assignment.can_inventory
      WHEN 'can_execute' THEN assignment.can_execute
      ELSE false
    END
    AND state.assignment_snapshot @> jsonb_build_array(jsonb_build_object(
      'assignmentId', assignment.id,
      'organizationId', assignment.organization_id,
      'buildingId', assignment.building_id,
      'deviceId', assignment.device_id
    ))
  FOR UPDATE OF state, assignment;
  RETURN FOUND;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.network_center_worker_heartbeat_v2(
  p_credential_digest text,
  p_worker_version text,
  p_capabilities text[],
  p_status text,
  p_queue_age_seconds integer,
  p_safe_metadata jsonb,
  p_started_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $fn$
DECLARE
  v_worker_id uuid;
  v_worker_key text;
  v_worker_status text;
  v_registry_capabilities text[];
  v_now timestamptz := clock_timestamp();
  v_status text := upper(btrim(coalesce(p_status, '')));
  v_building_count integer;
BEGIN
  SELECT authenticated.worker_id, authenticated.worker_key,
    authenticated.worker_status, authenticated.capabilities
  INTO v_worker_id, v_worker_key, v_worker_status, v_registry_capabilities
  FROM app_private.network_center_authenticate_worker_v2(
    p_credential_digest
  ) authenticated;

  IF char_length(btrim(coalesce(p_worker_version, ''))) NOT BETWEEN 1 AND 100
     OR cardinality(coalesce(p_capabilities, ARRAY[]::text[])) > 32
     OR v_status NOT IN ('ONLINE', 'DEGRADED', 'PAUSED', 'STOPPING')
     OR p_queue_age_seconds NOT BETWEEN 0 AND 31536000
     OR p_safe_metadata IS NULL OR jsonb_typeof(p_safe_metadata) <> 'object'
     OR octet_length(p_safe_metadata::text) > 16384
     OR p_started_at IS NULL OR p_started_at > v_now THEN
    RAISE EXCEPTION 'Invalid worker heartbeat' USING ERRCODE = '22023';
  END IF;
  PERFORM app_private.network_center_assert_safe_json_v1(
    p_safe_metadata, 'worker heartbeat metadata'
  );

  WITH authorized_buildings AS MATERIALIZED (
    SELECT DISTINCT assignment.organization_id, assignment.building_id
    FROM public.network_workers worker
    JOIN public.network_worker_assignments assignment
      ON assignment.worker_id = worker.id
    WHERE worker.id = v_worker_id
      AND worker.status IN ('ACTIVE', 'DRAINING')
      AND 'HEARTBEAT' = ANY(worker.capabilities)
      AND assignment.active_from <= v_now
      AND (
        assignment.active_until IS NULL
        OR assignment.active_until > v_now
      )
      AND (
        assignment.can_poll OR assignment.can_inventory
        OR assignment.can_execute
      )
      AND app_private.network_center_worker_can_access_building_v2(
        v_worker_id, assignment.organization_id,
        assignment.building_id,
        'HEARTBEAT',
        v_now
      )
  ), upserted AS (
    INSERT INTO public.network_worker_building_status (
      organization_id, building_id, status, heartbeat_at,
      queue_age_seconds, started_at, updated_at
    )
    SELECT organization_id, building_id, v_status, v_now,
      p_queue_age_seconds, p_started_at, v_now
    FROM authorized_buildings
    ON CONFLICT (organization_id, building_id) DO UPDATE SET
      status = EXCLUDED.status,
      heartbeat_at = EXCLUDED.heartbeat_at,
      queue_age_seconds = EXCLUDED.queue_age_seconds,
      started_at = LEAST(
        public.network_worker_building_status.started_at,
        EXCLUDED.started_at
      ),
      updated_at = EXCLUDED.updated_at
    RETURNING building_id
  )
  SELECT count(*) INTO v_building_count FROM upserted;

  IF v_building_count = 0 THEN
    RAISE EXCEPTION 'Worker has no active assigned building'
      USING ERRCODE = '42501';
  END IF;
  RETURN jsonb_build_object(
    'status', v_status, 'heartbeatAt', v_now,
    'assignedBuildingCount', v_building_count
  );
END;
$fn$;

CREATE OR REPLACE FUNCTION public.network_center_worker_list_connections_v2(
  p_credential_digest text,
  p_limit integer DEFAULT 100
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $fn$
DECLARE
  v_worker_id uuid;
  v_worker_key text;
  v_worker_status text;
  v_capabilities text[];
  v_now timestamptz := clock_timestamp();
  v_result jsonb;
BEGIN
  SELECT authenticated.worker_id, authenticated.worker_key,
    authenticated.worker_status, authenticated.capabilities
  INTO v_worker_id, v_worker_key, v_worker_status, v_capabilities
  FROM app_private.network_center_authenticate_worker_v2(
    p_credential_digest
  ) authenticated;
  IF p_limit NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'Invalid worker connection request'
      USING ERRCODE = '22023';
  END IF;

  SELECT jsonb_build_object(
    'items', coalesce(jsonb_agg(row.item ORDER BY
      row.organization_id, row.building_id, row.device_id
    ), '[]'::jsonb)
  ) INTO v_result
  FROM (
    SELECT DISTINCT ON (connection.id)
      connection.organization_id, connection.building_id,
      connection.device_id, connection.id,
      jsonb_build_object(
        'connectionId', connection.id,
        'organizationId', connection.organization_id,
        'buildingId', connection.building_id,
        'deviceId', connection.device_id,
        'deviceKind', device.device_kind,
        'externalKey', device.external_key,
        'displayName', device.display_name,
        'transport', connection.transport,
        'managementIp', connection.management_ip::text,
        'managementPort', connection.management_port,
        'credentialRef', connection.credential_ref,
        'hostKeyFingerprint', connection.host_key_fingerprint,
        'pollIntervalSeconds', coalesce(
          settings.poll_interval_seconds, connection.poll_interval_seconds
        ),
        'connectTimeoutMs', connection.connect_timeout_ms,
        'monitoringEnabled', coalesce(settings.monitoring_enabled, true),
        'changesPaused', coalesce(settings.changes_paused, false)
      ) AS item
    FROM public.network_device_connections connection
    JOIN public.network_devices device
      ON device.organization_id = connection.organization_id
     AND device.building_id = connection.building_id
     AND device.id = connection.device_id
    JOIN public.network_worker_assignments assignment
      ON assignment.worker_id = v_worker_id
     AND assignment.organization_id = connection.organization_id
     AND assignment.building_id = connection.building_id
     AND assignment.device_id = connection.device_id
     AND assignment.can_poll
     AND assignment.active_from <= v_now
     AND (
       assignment.active_until IS NULL
       OR assignment.active_until > v_now
     )
    JOIN public.network_workers worker
      ON worker.id = assignment.worker_id
     AND worker.status IN ('ACTIVE', 'DRAINING')
     AND 'POLL' = ANY(worker.capabilities)
    LEFT JOIN public.network_site_settings settings
      ON settings.organization_id = connection.organization_id
     AND settings.building_id = connection.building_id
    WHERE connection.is_enabled AND device.is_active
    ORDER BY connection.id, assignment.active_from DESC
    LIMIT p_limit
  ) row;
  RETURN coalesce(v_result, jsonb_build_object('items', '[]'::jsonb));
END;
$fn$;

CREATE OR REPLACE FUNCTION app_private.network_center_reclaim_expired_commands_v2(
  p_worker_id uuid,
  p_now timestamptz DEFAULT clock_timestamp()
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $fn$
DECLARE
  v_command public.network_commands%ROWTYPE;
  v_attempt_id uuid;
  v_next_status text;
  v_event_kind text;
  v_reclaimed integer := 0;
BEGIN
  IF p_worker_id IS NULL OR p_now IS NULL THEN
    RAISE EXCEPTION 'Scoped reclaim identity and timestamp are required'
      USING ERRCODE = '22023';
  END IF;

  FOR v_command IN
    SELECT command.*
    FROM public.network_commands command
    JOIN public.network_worker_assignments assignment
      ON assignment.worker_id = p_worker_id
     AND assignment.organization_id = command.organization_id
     AND assignment.building_id = command.building_id
     AND assignment.device_id = command.device_id
     AND assignment.can_execute
     AND assignment.active_from <= p_now
     AND (assignment.active_until IS NULL OR assignment.active_until > p_now)
    JOIN public.network_workers worker
      ON worker.id = assignment.worker_id
     AND worker.status IN ('ACTIVE', 'DRAINING')
     AND 'EXECUTE' = ANY(worker.capabilities)
    WHERE command.status IN ('LEASED', 'RUNNING', 'RECONCILING')
      AND command.lease_expires_at <= p_now
    ORDER BY command.lease_expires_at, command.id
    FOR UPDATE OF command, assignment, worker SKIP LOCKED
  LOOP
    v_next_status := CASE
      WHEN v_command.status = 'LEASED'
       AND v_command.attempt_count < v_command.max_attempts THEN 'RETRY_WAIT'
      WHEN v_command.status = 'LEASED' THEN 'FAILED'
      ELSE 'UNCERTAIN'
    END;
    v_event_kind := CASE
      WHEN v_next_status = 'RETRY_WAIT' THEN 'RETRY_SCHEDULED'
      WHEN v_next_status = 'FAILED' THEN 'FAILED'
      ELSE 'UNCERTAIN'
    END;

    UPDATE public.network_command_attempts attempt
    SET outcome = CASE WHEN v_next_status = 'UNCERTAIN'
          THEN 'UNCERTAIN' ELSE 'ABANDONED' END,
        retryable = (v_next_status = 'RETRY_WAIT'),
        error_code = 'LEASE_EXPIRED',
        error_message = CASE WHEN v_next_status = 'UNCERTAIN'
          THEN 'Worker lease expired after execution may have started; reconciliation is required.'
          ELSE 'Worker lease expired before completion.' END,
        result = jsonb_build_object('leaseExpiredAt', v_command.lease_expires_at),
        finished_at = p_now
    WHERE attempt.command_id = v_command.id
      AND attempt.lease_token = v_command.lease_token
      AND attempt.finished_at IS NULL
    RETURNING attempt.id INTO v_attempt_id;

    INSERT INTO public.network_command_events (
      organization_id, building_id, command_id, attempt_id, event_seq,
      event_kind, occurred_at, worker_id, payload
    ) VALUES (
      v_command.organization_id, v_command.building_id, v_command.id,
      v_attempt_id, coalesce((
        SELECT max(existing_event.event_seq) + 1
        FROM public.network_command_events existing_event
        WHERE existing_event.command_id = v_command.id
      ), 1), v_event_kind, p_now, v_command.lease_owner,
      jsonb_build_object(
        'previousStatus', v_command.status,
        'leaseExpiredAt', v_command.lease_expires_at,
        'nextStatus', v_next_status
      )
    );

    DELETE FROM public.network_device_leases device_lease
    WHERE device_lease.device_id = v_command.device_id
      AND device_lease.command_id = v_command.id
      AND device_lease.lease_token = v_command.lease_token
      AND device_lease.expires_at <= p_now;

    UPDATE public.network_commands command
    SET status = v_next_status,
        available_at = CASE WHEN v_next_status = 'RETRY_WAIT'
          THEN p_now + INTERVAL '5 seconds' ELSE command.available_at END,
        lease_token = NULL,
        lease_owner = NULL,
        lease_expires_at = NULL,
        reconciliation_state = CASE WHEN v_next_status = 'UNCERTAIN'
          THEN 'REQUIRED' ELSE command.reconciliation_state END,
        result = CASE WHEN v_next_status = 'FAILED'
          THEN jsonb_build_object(
            'code', 'LEASE_EXPIRED', 'retryExhausted', true
          ) ELSE command.result END,
        finished_at = CASE WHEN v_next_status = 'FAILED' THEN p_now ELSE NULL END,
        updated_at = p_now
    WHERE command.id = v_command.id;

    v_reclaimed := v_reclaimed + 1;
  END LOOP;
  RETURN v_reclaimed;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.network_center_worker_claim_v2(
  p_credential_digest text,
  p_limit integer DEFAULT 5,
  p_lease_seconds integer DEFAULT 90
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $fn$
DECLARE
  v_worker_id uuid;
  v_worker_key text;
  v_worker_status text;
  v_capabilities text[];
  v_now timestamptz := clock_timestamp();
  v_candidate public.network_commands%ROWTYPE;
  v_command public.network_commands%ROWTYPE;
  v_lease public.network_device_leases%ROWTYPE;
  v_attempt_id uuid;
  v_event_seq bigint;
  v_items jsonb := '[]'::jsonb;
  v_claimed integer := 0;
BEGIN
  SELECT authenticated.worker_id, authenticated.worker_key,
    authenticated.worker_status, authenticated.capabilities
  INTO v_worker_id, v_worker_key, v_worker_status, v_capabilities
  FROM app_private.network_center_authenticate_worker_v2(
    p_credential_digest
  ) authenticated;
  IF p_limit NOT BETWEEN 1 AND 20
     OR p_lease_seconds NOT BETWEEN 15 AND 300 THEN
    RAISE EXCEPTION 'Invalid command claim request' USING ERRCODE = '22023';
  END IF;
  PERFORM app_private.network_center_reclaim_expired_commands_v2(
    v_worker_id, v_now
  );

  -- Assignment and managed-resource admission happen in the candidate query,
  -- before any lease mutation. Revocation/protection committed before this lock
  -- makes the command ineligible rather than globally claiming then rejecting.
  FOR v_candidate IN
    SELECT command.*
    FROM public.network_commands command
    JOIN public.network_worker_assignments assignment
      ON assignment.worker_id = v_worker_id
     AND assignment.organization_id = command.organization_id
     AND assignment.building_id = command.building_id
     AND assignment.device_id = command.device_id
     AND assignment.can_execute
     AND assignment.active_from <= v_now
     AND (
       assignment.active_until IS NULL
       OR assignment.active_until > v_now
     )
    JOIN public.network_workers worker
      ON worker.id = assignment.worker_id
     AND worker.status = 'ACTIVE'
     AND 'EXECUTE' = ANY(worker.capabilities)
    WHERE command.status IN ('QUEUED', 'RETRY_WAIT')
      AND command.available_at <= v_now
      AND command.attempt_count < command.max_attempts
      AND (
        command.action_type = 'CAPTURE_SNAPSHOT'
        OR EXISTS (
          SELECT 1 FROM public.network_site_settings settings
          WHERE settings.organization_id = command.organization_id
            AND settings.building_id = command.building_id
            AND NOT settings.changes_paused
        )
      )
      AND (
        command.action_type <> 'CYCLE_ACCESS_PORT'
        OR EXISTS (
          SELECT 1
          FROM public.network_interfaces interface
          JOIN public.network_managed_resources resource
            ON resource.organization_id = interface.organization_id
           AND resource.building_id = interface.building_id
           AND resource.device_id = interface.device_id
           AND resource.id = interface.managed_resource_id
          WHERE interface.organization_id = command.organization_id
            AND interface.building_id = command.building_id
            AND interface.device_id = command.device_id
            AND interface.id = command.interface_id
            AND interface.interface_role = 'ACCESS'
            AND NOT interface.is_protected
            AND resource.resource_kind = 'INTERFACE'
            AND resource.enrolled_role = 'ACCESS'
            AND resource.enrollment_state = 'ENROLLED'
            AND resource.protected = false
            AND resource.last_verified_at IS NOT NULL
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.network_device_leases active_lease
        WHERE active_lease.device_id = command.device_id
          AND active_lease.expires_at > v_now
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.network_commands unresolved
        WHERE unresolved.device_id = command.device_id
          AND unresolved.status = 'UNCERTAIN'
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.network_commands earlier
        WHERE earlier.device_id = command.device_id
          AND earlier.status IN ('QUEUED', 'RETRY_WAIT')
          AND earlier.available_at <= v_now
          AND earlier.attempt_count < earlier.max_attempts
          AND (
            earlier.priority > command.priority
            OR (
              earlier.priority = command.priority
              AND ROW(earlier.available_at, earlier.created_at, earlier.id)
                < ROW(command.available_at, command.created_at, command.id)
            )
          )
      )
    ORDER BY command.priority DESC, command.available_at,
      command.created_at, command.id
    FOR UPDATE OF command, assignment, worker SKIP LOCKED
    LIMIT p_limit
  LOOP
    IF v_candidate.action_type = 'CYCLE_ACCESS_PORT' THEN
      PERFORM 1
      FROM public.network_interfaces interface
      JOIN public.network_managed_resources resource
        ON resource.organization_id = interface.organization_id
       AND resource.building_id = interface.building_id
       AND resource.device_id = interface.device_id
       AND resource.id = interface.managed_resource_id
      WHERE interface.organization_id = v_candidate.organization_id
        AND interface.building_id = v_candidate.building_id
        AND interface.device_id = v_candidate.device_id
        AND interface.id = v_candidate.interface_id
        AND interface.interface_role = 'ACCESS'
        AND NOT interface.is_protected
        AND resource.resource_kind = 'INTERFACE'
        AND resource.enrolled_role = 'ACCESS'
        AND resource.enrollment_state = 'ENROLLED'
        AND resource.protected = false
        AND resource.last_verified_at IS NOT NULL
      FOR UPDATE OF interface, resource;
      IF NOT FOUND THEN CONTINUE; END IF;
    END IF;

    INSERT INTO public.network_device_leases (
      device_id, organization_id, building_id, command_id, lease_token,
      lease_owner, acquired_at, heartbeat_at, expires_at, generation
    ) VALUES (
      v_candidate.device_id, v_candidate.organization_id,
      v_candidate.building_id, v_candidate.id, gen_random_uuid(),
      v_worker_key, v_now, v_now,
      v_now + make_interval(secs => p_lease_seconds), 1
    )
    ON CONFLICT (device_id) DO UPDATE SET
      organization_id = EXCLUDED.organization_id,
      building_id = EXCLUDED.building_id,
      command_id = EXCLUDED.command_id,
      lease_token = EXCLUDED.lease_token,
      lease_owner = EXCLUDED.lease_owner,
      acquired_at = EXCLUDED.acquired_at,
      heartbeat_at = EXCLUDED.heartbeat_at,
      expires_at = EXCLUDED.expires_at,
      generation = public.network_device_leases.generation + 1
    WHERE public.network_device_leases.expires_at <= v_now
    RETURNING * INTO v_lease;
    IF NOT FOUND THEN CONTINUE; END IF;

    UPDATE public.network_commands command
    SET status = 'LEASED', lease_token = v_lease.lease_token,
        lease_owner = v_worker_key, lease_expires_at = v_lease.expires_at,
        attempt_count = command.attempt_count + 1,
        started_at = coalesce(command.started_at, v_now), updated_at = v_now
    WHERE command.id = v_candidate.id
    RETURNING * INTO v_command;

    INSERT INTO public.network_command_attempts (
      organization_id, building_id, command_id, device_id, attempt_no,
      worker_id, lease_token, outcome, started_at
    ) VALUES (
      v_command.organization_id, v_command.building_id, v_command.id,
      v_command.device_id, v_command.attempt_count, v_worker_key,
      v_command.lease_token, 'STARTED', v_now
    ) RETURNING id INTO v_attempt_id;

    SELECT coalesce(max(event.event_seq) + 1, 1)
    INTO v_event_seq
    FROM public.network_command_events event
    WHERE event.command_id = v_command.id;
    INSERT INTO public.network_command_events (
      organization_id, building_id, command_id, attempt_id, event_seq,
      event_kind, occurred_at, worker_id, payload
    ) VALUES (
      v_command.organization_id, v_command.building_id, v_command.id,
      v_attempt_id, v_event_seq, 'LEASED', v_now, v_worker_key,
      jsonb_build_object(
        'attemptNo', v_command.attempt_count,
        'leaseExpiresAt', v_command.lease_expires_at
      )
    );

    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'commandId', v_command.id,
      'organizationId', v_command.organization_id,
      'buildingId', v_command.building_id,
      'deviceId', v_command.device_id,
      'interfaceId', v_command.interface_id,
      'actionType', v_command.action_type,
      'reason', v_command.reason,
      'parameters', v_command.sanitized_parameters,
      'attemptNo', v_command.attempt_count,
      'leaseToken', v_command.lease_token,
      'leaseExpiresAt', v_command.lease_expires_at,
      'reconciliation', false,
      'intentType', v_command.intent_type,
      'managedTarget', v_command.managed_target,
      'preObservation', v_command.pre_observation,
      'expectedPostcondition', v_command.expected_postcondition,
      'observationDeadline', v_command.observation_deadline,
      'transitionVersion', v_command.transition_version,
      'fencingGeneration', v_lease.generation
    ));
    v_claimed := v_claimed + 1;
  END LOOP;

  IF v_claimed < p_limit THEN
    FOR v_candidate IN
      SELECT command.*
      FROM public.network_commands command
      JOIN public.network_worker_assignments assignment
        ON assignment.worker_id = v_worker_id
       AND assignment.organization_id = command.organization_id
       AND assignment.building_id = command.building_id
       AND assignment.device_id = command.device_id
       AND assignment.can_execute
       AND assignment.active_from <= v_now
       AND (
         assignment.active_until IS NULL
         OR assignment.active_until > v_now
       )
      JOIN public.network_workers worker
        ON worker.id = assignment.worker_id
       AND worker.status = 'ACTIVE'
       AND 'EXECUTE' = ANY(worker.capabilities)
      WHERE command.status = 'UNCERTAIN'
        AND command.reconciliation_state = 'REQUIRED'
        AND (
          command.action_type <> 'CYCLE_ACCESS_PORT'
          OR EXISTS (
            SELECT 1
            FROM public.network_interfaces interface
            JOIN public.network_managed_resources resource
              ON resource.id = interface.managed_resource_id
             AND resource.organization_id = interface.organization_id
             AND resource.building_id = interface.building_id
             AND resource.device_id = interface.device_id
            WHERE interface.id = command.interface_id
              AND interface.device_id = command.device_id
              AND interface.interface_role = 'ACCESS'
              AND NOT interface.is_protected
              AND resource.enrollment_state = 'ENROLLED'
              AND resource.protected = false
          )
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.network_device_leases active_lease
          WHERE active_lease.device_id = command.device_id
            AND active_lease.expires_at > v_now
        )
      ORDER BY command.updated_at, command.id
      FOR UPDATE OF command, assignment, worker SKIP LOCKED
      LIMIT (p_limit - v_claimed)
    LOOP
      IF v_candidate.action_type = 'CYCLE_ACCESS_PORT' THEN
        PERFORM 1
        FROM public.network_interfaces interface
        JOIN public.network_managed_resources resource
          ON resource.organization_id = interface.organization_id
         AND resource.building_id = interface.building_id
         AND resource.device_id = interface.device_id
         AND resource.id = interface.managed_resource_id
        WHERE interface.organization_id = v_candidate.organization_id
          AND interface.building_id = v_candidate.building_id
          AND interface.device_id = v_candidate.device_id
          AND interface.id = v_candidate.interface_id
          AND interface.interface_role = 'ACCESS'
          AND NOT interface.is_protected
          AND resource.resource_kind = 'INTERFACE'
          AND resource.enrolled_role = 'ACCESS'
          AND resource.enrollment_state = 'ENROLLED'
          AND resource.protected = false
          AND resource.last_verified_at IS NOT NULL
        FOR UPDATE OF interface, resource;
        IF NOT FOUND THEN CONTINUE; END IF;
      END IF;

      INSERT INTO public.network_device_leases (
        device_id, organization_id, building_id, command_id, lease_token,
        lease_owner, acquired_at, heartbeat_at, expires_at, generation
      ) VALUES (
        v_candidate.device_id, v_candidate.organization_id,
        v_candidate.building_id, v_candidate.id, gen_random_uuid(),
        v_worker_key, v_now, v_now,
        v_now + make_interval(secs => p_lease_seconds), 1
      )
      ON CONFLICT (device_id) DO UPDATE SET
        organization_id = EXCLUDED.organization_id,
        building_id = EXCLUDED.building_id,
        command_id = EXCLUDED.command_id,
        lease_token = EXCLUDED.lease_token,
        lease_owner = EXCLUDED.lease_owner,
        acquired_at = EXCLUDED.acquired_at,
        heartbeat_at = EXCLUDED.heartbeat_at,
        expires_at = EXCLUDED.expires_at,
        generation = public.network_device_leases.generation + 1
      WHERE public.network_device_leases.expires_at <= v_now
      RETURNING * INTO v_lease;
      IF NOT FOUND THEN CONTINUE; END IF;

      UPDATE public.network_commands command
      SET status = 'RECONCILING', reconciliation_state = 'IN_PROGRESS',
          lease_token = v_lease.lease_token, lease_owner = v_worker_key,
          lease_expires_at = v_lease.expires_at, updated_at = v_now
      WHERE command.id = v_candidate.id
      RETURNING * INTO v_command;

      SELECT attempt.id INTO v_attempt_id
      FROM public.network_command_attempts attempt
      WHERE attempt.command_id = v_command.id
      ORDER BY attempt.attempt_no DESC LIMIT 1;
      SELECT coalesce(max(event.event_seq) + 1, 1)
      INTO v_event_seq FROM public.network_command_events event
      WHERE event.command_id = v_command.id;
      INSERT INTO public.network_command_events (
        organization_id, building_id, command_id, attempt_id, event_seq,
        event_kind, occurred_at, worker_id, payload
      ) VALUES (
        v_command.organization_id, v_command.building_id, v_command.id,
        v_attempt_id, v_event_seq, 'RECONCILIATION_STARTED', v_now,
        v_worker_key, jsonb_build_object(
          'leaseExpiresAt', v_command.lease_expires_at
        )
      );

      v_items := v_items || jsonb_build_array(jsonb_build_object(
        'commandId', v_command.id,
        'organizationId', v_command.organization_id,
        'buildingId', v_command.building_id,
        'deviceId', v_command.device_id,
        'interfaceId', v_command.interface_id,
        'actionType', v_command.action_type,
        'reason', v_command.reason,
        'parameters', v_command.sanitized_parameters,
        'attemptNo', v_command.attempt_count,
        'leaseToken', v_command.lease_token,
        'leaseExpiresAt', v_command.lease_expires_at,
        'reconciliation', true,
        'intentType', v_command.intent_type,
        'managedTarget', v_command.managed_target,
        'preObservation', v_command.pre_observation,
        'expectedPostcondition', v_command.expected_postcondition,
        'observationDeadline', v_command.observation_deadline,
        'transitionVersion', v_command.transition_version,
        'fencingGeneration', v_lease.generation
      ));
      v_claimed := v_claimed + 1;
    END LOOP;
  END IF;

  RETURN jsonb_build_object('items', v_items);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.network_center_worker_renew_v2(
  p_credential_digest text,
  p_command_id uuid,
  p_lease_token uuid,
  p_fencing_generation bigint,
  p_lease_seconds integer DEFAULT 90
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $fn$
DECLARE
  v_worker_id uuid;
  v_worker_key text;
  v_worker_status text;
  v_capabilities text[];
  v_command public.network_commands%ROWTYPE;
BEGIN
  SELECT authenticated.worker_id, authenticated.worker_key,
    authenticated.worker_status, authenticated.capabilities
  INTO v_worker_id, v_worker_key, v_worker_status, v_capabilities
  FROM app_private.network_center_authenticate_worker_v2(
    p_credential_digest
  ) authenticated;
  IF p_command_id IS NULL OR p_lease_token IS NULL
     OR p_fencing_generation < 1
     OR p_lease_seconds NOT BETWEEN 15 AND 300 THEN
    RAISE EXCEPTION 'Invalid lease renewal request' USING ERRCODE = '22023';
  END IF;

  SELECT command.* INTO v_command
  FROM public.network_commands command
  JOIN public.network_device_leases lease
    ON lease.organization_id = command.organization_id
   AND lease.building_id = command.building_id
   AND lease.device_id = command.device_id
   AND lease.command_id = command.id
  WHERE command.id = p_command_id
    AND command.lease_token = p_lease_token
    AND command.lease_owner = v_worker_key
    AND command.status IN ('LEASED', 'RUNNING', 'RECONCILING')
    AND lease.lease_token = p_lease_token
    AND lease.lease_owner = v_worker_key
    AND lease.generation = p_fencing_generation
    AND lease.expires_at > clock_timestamp()
  FOR UPDATE OF command, lease;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active fenced command lease not found'
      USING ERRCODE = '55000';
  END IF;
  IF NOT app_private.network_center_worker_can_access_device_v2(
    v_worker_id, v_command.organization_id, v_command.building_id,
    v_command.device_id, 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'Worker is not assigned to target device'
      USING ERRCODE = '42501';
  END IF;
  RETURN app_private.network_center_worker_renew_legacy_impl_v1(
    v_worker_key, p_command_id, p_lease_token, p_lease_seconds
  );
END;
$fn$;

CREATE OR REPLACE FUNCTION public.network_center_worker_ingest_v2(
  p_credential_digest text,
  p_payload jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $fn$
DECLARE
  v_worker_id uuid;
  v_worker_key text;
  v_worker_status text;
  v_capabilities text[];
  v_target_count integer;
BEGIN
  SELECT authenticated.worker_id, authenticated.worker_key,
    authenticated.worker_status, authenticated.capabilities
  INTO v_worker_id, v_worker_key, v_worker_status, v_capabilities
  FROM app_private.network_center_authenticate_worker_v2(
    p_credential_digest
  ) authenticated;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object'
     OR jsonb_typeof(coalesce(p_payload->'devices', '[]'::jsonb)) <> 'array'
     OR jsonb_typeof(coalesce(p_payload->'interfaces', '[]'::jsonb)) <> 'array'
     OR jsonb_typeof(coalesce(p_payload->'clients', '[]'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'Invalid telemetry payload' USING ERRCODE = '22023';
  END IF;

  v_target_count := jsonb_array_length(coalesce(p_payload->'devices', '[]'::jsonb))
    + jsonb_array_length(coalesce(p_payload->'interfaces', '[]'::jsonb))
    + jsonb_array_length(coalesce(p_payload->'clients', '[]'::jsonb));
  IF v_target_count = 0 THEN
    RAISE EXCEPTION 'Telemetry payload requires an assigned target'
      USING ERRCODE = '42501';
  END IF;

  -- All arrays are checked before the legacy all-or-nothing writer is entered.
  -- A single unknown or unassigned target aborts the transaction, so a mixed
  -- authorized/unauthorized batch cannot partially persist.
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(coalesce(p_payload->'devices', '[]'::jsonb)) item
    LEFT JOIN public.network_devices device
      ON device.id = nullif(item->>'deviceId', '')::uuid
    LEFT JOIN public.network_devices assigned_router
      ON assigned_router.id = CASE
        WHEN device.device_kind = 'MIKROTIK' THEN device.id
        ELSE device.parent_device_id
      END
     AND assigned_router.organization_id = device.organization_id
     AND assigned_router.building_id = device.building_id
     AND assigned_router.device_kind = 'MIKROTIK'
    WHERE assigned_router.id IS NULL
       OR NOT app_private.network_center_worker_can_access_device_v2(
         v_worker_id, assigned_router.organization_id,
         assigned_router.building_id, assigned_router.id, 'TELEMETRY'
       )
  ) OR EXISTS (
    SELECT 1
    FROM jsonb_array_elements(coalesce(p_payload->'interfaces', '[]'::jsonb)) item
    LEFT JOIN public.network_interfaces interface
      ON interface.id = nullif(item->>'interfaceId', '')::uuid
    LEFT JOIN public.network_devices device ON device.id = interface.device_id
    LEFT JOIN public.network_devices assigned_router
      ON assigned_router.id = CASE
        WHEN device.device_kind = 'MIKROTIK' THEN device.id
        ELSE device.parent_device_id
      END
     AND assigned_router.organization_id = interface.organization_id
     AND assigned_router.building_id = interface.building_id
     AND assigned_router.device_kind = 'MIKROTIK'
    WHERE assigned_router.id IS NULL
       OR NOT app_private.network_center_worker_can_access_device_v2(
         v_worker_id, assigned_router.organization_id,
         assigned_router.building_id, assigned_router.id, 'TELEMETRY'
       )
  ) OR EXISTS (
    SELECT 1
    FROM jsonb_array_elements(coalesce(p_payload->'clients', '[]'::jsonb)) item
    LEFT JOIN public.network_devices device
      ON device.id = nullif(item->>'deviceId', '')::uuid
    LEFT JOIN public.network_devices assigned_router
      ON assigned_router.id = CASE
        WHEN device.device_kind = 'MIKROTIK' THEN device.id
        ELSE device.parent_device_id
      END
     AND assigned_router.organization_id = device.organization_id
     AND assigned_router.building_id = device.building_id
     AND assigned_router.device_kind = 'MIKROTIK'
    LEFT JOIN public.network_interfaces interface
      ON nullif(item->>'interfaceId', '') IS NOT NULL
     AND interface.id = nullif(item->>'interfaceId', '')::uuid
     AND interface.organization_id = device.organization_id
     AND interface.building_id = device.building_id
     AND interface.device_id = device.id
    WHERE assigned_router.id IS NULL
       OR (
         nullif(item->>'interfaceId', '') IS NOT NULL
         AND interface.id IS NULL
       )
       OR NOT app_private.network_center_worker_can_access_device_v2(
         v_worker_id, assigned_router.organization_id,
         assigned_router.building_id, assigned_router.id, 'TELEMETRY'
       )
  ) THEN
    RAISE EXCEPTION 'Unauthorized telemetry target in mixed payload'
      USING ERRCODE = '42501';
  END IF;

  RETURN app_private.network_center_worker_ingest_legacy_impl_v1(
    v_worker_key, p_payload
  );
END;
$fn$;

CREATE OR REPLACE FUNCTION public.network_center_worker_inventory_v2(
  p_credential_digest text,
  p_payload jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $fn$
DECLARE
  v_worker_id uuid;
  v_worker_key text;
  v_worker_status text;
  v_capabilities text[];
  v_router public.network_devices%ROWTYPE;
  v_result jsonb;
  v_mapping jsonb;
BEGIN
  SELECT authenticated.worker_id, authenticated.worker_key,
    authenticated.worker_status, authenticated.capabilities
  INTO v_worker_id, v_worker_key, v_worker_status, v_capabilities
  FROM app_private.network_center_authenticate_worker_v2(
    p_credential_digest
  ) authenticated;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'Invalid inventory payload' USING ERRCODE = '22023';
  END IF;
  SELECT router.* INTO v_router
  FROM public.network_devices router
  WHERE router.id = nullif(p_payload->>'routerDeviceId', '')::uuid
    AND router.device_kind = 'MIKROTIK'
    AND router.is_active
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Inventory router not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT app_private.network_center_worker_can_access_device_v2(
    v_worker_id, v_router.organization_id, v_router.building_id,
    v_router.id, 'INVENTORY'
  ) THEN
    RAISE EXCEPTION 'Worker is not assigned to inventory target'
      USING ERRCODE = '42501';
  END IF;

  v_result := app_private.network_center_worker_inventory_legacy_impl_v1(
    v_worker_key, p_payload
  );
  v_mapping := app_private.network_center_managed_interface_mapping_v1(
    v_router.id
  );
  -- Keep Task 9's Aruba/quarantine fields byte-for-byte and replace only the
  -- interface authorization mapping with Task 10's private authoritative data.
  v_result := jsonb_set(v_result, '{interfaces}', v_mapping, true);
  v_result := jsonb_set(
    v_result, '{interfaceCount}', to_jsonb(jsonb_array_length(v_mapping)), true
  );
  RETURN v_result;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.network_center_worker_command_event_v2(
  p_credential_digest text,
  p_command_id uuid,
  p_lease_token uuid,
  p_fencing_generation bigint,
  p_event_kind text,
  p_payload jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $fn$
DECLARE
  v_worker_id uuid;
  v_worker_key text;
  v_worker_status text;
  v_capabilities text[];
  v_command public.network_commands%ROWTYPE;
BEGIN
  SELECT authenticated.worker_id, authenticated.worker_key,
    authenticated.worker_status, authenticated.capabilities
  INTO v_worker_id, v_worker_key, v_worker_status, v_capabilities
  FROM app_private.network_center_authenticate_worker_v2(
    p_credential_digest
  ) authenticated;
  SELECT command.* INTO v_command
  FROM public.network_commands command
  JOIN public.network_device_leases lease
    ON lease.command_id = command.id
   AND lease.organization_id = command.organization_id
   AND lease.building_id = command.building_id
   AND lease.device_id = command.device_id
  WHERE command.id = p_command_id
    AND command.lease_token = p_lease_token
    AND command.lease_owner = v_worker_key
    AND command.status IN ('LEASED', 'RUNNING', 'RECONCILING')
    AND lease.lease_token = p_lease_token
    AND lease.lease_owner = v_worker_key
    AND lease.generation = p_fencing_generation
    AND lease.expires_at > clock_timestamp()
  FOR UPDATE OF command, lease;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active fenced command lease not found'
      USING ERRCODE = '55000';
  END IF;
  IF NOT app_private.network_center_worker_can_access_device_v2(
    v_worker_id, v_command.organization_id, v_command.building_id,
    v_command.device_id, 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'Worker is not assigned to command target'
      USING ERRCODE = '42501';
  END IF;
  RETURN app_private.network_center_worker_command_event_legacy_impl_v1(
    v_worker_key, p_command_id, p_lease_token, p_event_kind, p_payload
  );
END;
$fn$;

CREATE OR REPLACE FUNCTION public.network_center_worker_observe_v2(
  p_credential_digest text,
  p_command_id uuid,
  p_lease_token uuid,
  p_fencing_generation bigint,
  p_transition_version bigint,
  p_observation_id uuid,
  p_observation_kind text,
  p_observed_at timestamptz,
  p_evidence jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $fn$
DECLARE
  v_worker_id uuid;
  v_worker_key text;
  v_worker_status text;
  v_capabilities text[];
  v_command public.network_commands%ROWTYPE;
BEGIN
  SELECT authenticated.worker_id, authenticated.worker_key,
    authenticated.worker_status, authenticated.capabilities
  INTO v_worker_id, v_worker_key, v_worker_status, v_capabilities
  FROM app_private.network_center_authenticate_worker_v2(
    p_credential_digest
  ) authenticated;
  SELECT command.* INTO v_command
  FROM public.network_commands command
  JOIN public.network_device_leases lease
    ON lease.command_id = command.id
   AND lease.device_id = command.device_id
  WHERE command.id = p_command_id
    AND command.lease_token = p_lease_token
    AND command.lease_owner = v_worker_key
    AND lease.lease_token = p_lease_token
    AND lease.lease_owner = v_worker_key
    AND lease.generation = p_fencing_generation
    AND lease.expires_at > clock_timestamp()
  FOR UPDATE OF command, lease;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active fenced observation lease not found'
      USING ERRCODE = '55000';
  END IF;
  IF NOT app_private.network_center_worker_can_access_device_v2(
    v_worker_id, v_command.organization_id, v_command.building_id,
    v_command.device_id, 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'Worker is not assigned to observation target'
      USING ERRCODE = '42501';
  END IF;
  RETURN app_private.network_center_record_command_observation_v1(
    v_worker_key, p_command_id, p_lease_token, p_fencing_generation,
    p_transition_version, p_observation_id, p_observation_kind,
    p_observed_at, p_evidence
  );
END;
$fn$;

CREATE OR REPLACE FUNCTION public.network_center_worker_complete_v2(
  p_credential_digest text,
  p_command_id uuid,
  p_lease_token uuid,
  p_fencing_generation bigint,
  p_transition_version bigint,
  p_outcome text,
  p_result jsonb,
  p_rollback jsonb DEFAULT NULL,
  p_retry_delay_seconds integer DEFAULT 30
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $fn$
DECLARE
  v_worker_id uuid;
  v_worker_key text;
  v_worker_status text;
  v_capabilities text[];
  v_command public.network_commands%ROWTYPE;
  v_outcome text := upper(btrim(coalesce(p_outcome, '')));
BEGIN
  SELECT authenticated.worker_id, authenticated.worker_key,
    authenticated.worker_status, authenticated.capabilities
  INTO v_worker_id, v_worker_key, v_worker_status, v_capabilities
  FROM app_private.network_center_authenticate_worker_v2(
    p_credential_digest
  ) authenticated;
  IF v_outcome NOT IN (
    'EVALUATE_POSTCONDITION', 'RETRYABLE_FAILURE', 'FAILED',
    'UNCERTAIN', 'CANCELLED_BY_KILL_SWITCH'
  ) THEN
    RAISE EXCEPTION 'Worker cannot author an authoritative success outcome'
      USING ERRCODE = '22023';
  END IF;
  SELECT command.* INTO v_command
  FROM public.network_commands command
  JOIN public.network_device_leases lease
    ON lease.command_id = command.id
   AND lease.device_id = command.device_id
  WHERE command.id = p_command_id
    AND command.lease_token = p_lease_token
    AND command.lease_owner = v_worker_key
    AND lease.lease_token = p_lease_token
    AND lease.lease_owner = v_worker_key
    AND lease.generation = p_fencing_generation
    AND lease.expires_at > clock_timestamp()
  FOR UPDATE OF command, lease;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active fenced completion lease not found'
      USING ERRCODE = '55000';
  END IF;
  IF NOT app_private.network_center_worker_can_access_device_v2(
    v_worker_id, v_command.organization_id, v_command.building_id,
    v_command.device_id, 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'Worker is not assigned to completion target'
      USING ERRCODE = '42501';
  END IF;
  RETURN app_private.network_center_transition_command_v1(
    v_worker_key, p_command_id, p_lease_token, p_fencing_generation,
    p_transition_version, v_outcome, p_result, p_rollback,
    p_retry_delay_seconds
  );
END;
$fn$;

CREATE OR REPLACE FUNCTION public.network_center_worker_upsert_incident_v2(
  p_credential_digest text,
  p_payload jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $fn$
DECLARE
  v_worker_id uuid;
  v_worker_key text;
  v_worker_status text;
  v_capabilities text[];
  v_device public.network_devices%ROWTYPE;
  v_assigned_router public.network_devices%ROWTYPE;
BEGIN
  SELECT authenticated.worker_id, authenticated.worker_key,
    authenticated.worker_status, authenticated.capabilities
  INTO v_worker_id, v_worker_key, v_worker_status, v_capabilities
  FROM app_private.network_center_authenticate_worker_v2(
    p_credential_digest
  ) authenticated;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'Invalid incident payload' USING ERRCODE = '22023';
  END IF;
  SELECT device.* INTO v_device
  FROM public.network_devices device
  WHERE device.id = nullif(p_payload->>'deviceId', '')::uuid
    AND device.is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Incident device not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT router.* INTO v_assigned_router
  FROM public.network_devices router
  WHERE router.id = CASE
      WHEN v_device.device_kind = 'MIKROTIK' THEN v_device.id
      ELSE v_device.parent_device_id
    END
    AND router.organization_id = v_device.organization_id
    AND router.building_id = v_device.building_id
    AND router.device_kind = 'MIKROTIK'
    AND router.is_active;
  IF NOT FOUND OR NOT app_private.network_center_worker_can_access_device_v2(
    v_worker_id, v_assigned_router.organization_id,
    v_assigned_router.building_id, v_assigned_router.id, 'INCIDENT'
  ) THEN
    RAISE EXCEPTION 'Worker is not assigned to incident target'
      USING ERRCODE = '42501';
  END IF;
  RETURN app_private.network_center_worker_upsert_incident_legacy_impl_v1(
    v_worker_key, p_payload
  );
END;
$fn$;

CREATE OR REPLACE FUNCTION public.network_center_worker_snapshot_v2(
  p_credential_digest text,
  p_payload jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $fn$
DECLARE
  v_worker_id uuid;
  v_worker_key text;
  v_worker_status text;
  v_capabilities text[];
  v_device public.network_devices%ROWTYPE;
  v_command public.network_commands%ROWTYPE;
  v_command_id uuid;
BEGIN
  SELECT authenticated.worker_id, authenticated.worker_key,
    authenticated.worker_status, authenticated.capabilities
  INTO v_worker_id, v_worker_key, v_worker_status, v_capabilities
  FROM app_private.network_center_authenticate_worker_v2(
    p_credential_digest
  ) authenticated;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'Invalid snapshot payload' USING ERRCODE = '22023';
  END IF;
  SELECT device.* INTO v_device
  FROM public.network_devices device
  WHERE device.id = nullif(p_payload->>'deviceId', '')::uuid
    AND device.device_kind = 'MIKROTIK'
    AND device.is_active
  FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Snapshot device not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT app_private.network_center_worker_can_access_device_v2(
    v_worker_id, v_device.organization_id, v_device.building_id,
    v_device.id, 'SNAPSHOT'
  ) THEN
    RAISE EXCEPTION 'Worker is not assigned to snapshot target'
      USING ERRCODE = '42501';
  END IF;

  v_command_id := nullif(p_payload->>'commandId', '')::uuid;
  IF v_command_id IS NOT NULL THEN
    SELECT command.* INTO v_command
    FROM public.network_commands command
    WHERE command.id = v_command_id
      AND command.organization_id = v_device.organization_id
      AND command.building_id = v_device.building_id
      AND command.device_id = v_device.id
    FOR KEY SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Snapshot command not found' USING ERRCODE = 'P0002';
    END IF;
  END IF;
  RETURN app_private.network_center_worker_snapshot_legacy_impl_v1(
    v_worker_key, p_payload
  );
END;
$fn$;

CREATE OR REPLACE FUNCTION public.network_center_worker_maintenance_v2(
  p_credential_digest text,
  p_now timestamptz DEFAULT clock_timestamp()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $fn$
DECLARE
  v_worker_id uuid;
  v_worker_key text;
  v_worker_status text;
  v_capabilities text[];
  v_expired_clients bigint := 0;
  v_windows_updated bigint := 0;
  v_building_count integer := 0;
BEGIN
  SELECT authenticated.worker_id, authenticated.worker_key,
    authenticated.worker_status, authenticated.capabilities
  INTO v_worker_id, v_worker_key, v_worker_status, v_capabilities
  FROM app_private.network_center_authenticate_worker_v2(
    p_credential_digest
  ) authenticated;
  IF p_now IS NULL
     OR abs(extract(epoch FROM (clock_timestamp() - p_now))) > 3600 THEN
    RAISE EXCEPTION 'Invalid worker maintenance request'
      USING ERRCODE = '22023';
  END IF;

  SELECT count(*) INTO v_building_count
  FROM (
    SELECT DISTINCT assignment.organization_id, assignment.building_id
    FROM public.network_worker_assignments assignment
    WHERE assignment.worker_id = v_worker_id
      AND assignment.can_poll
      AND assignment.active_from <= p_now
      AND (
        assignment.active_until IS NULL
        OR assignment.active_until > p_now
      )
      AND app_private.network_center_worker_can_access_building_v2(
        v_worker_id, assignment.organization_id,
        assignment.building_id, 'MAINTENANCE', p_now
      )
  ) assigned_building;
  IF v_building_count = 0 THEN
    RAISE EXCEPTION 'Worker has no maintenance assignment'
      USING ERRCODE = '42501';
  END IF;

  DELETE FROM public.network_client_current client
  WHERE client.expires_at <= p_now
    AND EXISTS (
      SELECT 1
      FROM public.network_worker_assignments assignment
      JOIN public.network_devices client_device
        ON client_device.organization_id = client.organization_id
       AND client_device.building_id = client.building_id
       AND client_device.id = client.device_id
      WHERE assignment.worker_id = v_worker_id
        AND assignment.organization_id = client.organization_id
        AND assignment.building_id = client.building_id
        AND assignment.device_id = CASE
          WHEN client_device.device_kind = 'MIKROTIK' THEN client_device.id
          ELSE client_device.parent_device_id
        END
        AND assignment.can_poll
        AND assignment.active_from <= p_now
        AND (
          assignment.active_until IS NULL
          OR assignment.active_until > p_now
        )
    );
  GET DIAGNOSTICS v_expired_clients = ROW_COUNT;

  UPDATE public.network_maintenance_windows maintenance
  SET status = CASE
    WHEN maintenance.ends_at <= p_now THEN 'COMPLETED' ELSE 'ACTIVE'
  END
  WHERE maintenance.status IN ('SCHEDULED', 'ACTIVE')
    AND (
      maintenance.starts_at <= p_now OR maintenance.ends_at <= p_now
    )
    AND EXISTS (
      SELECT 1
      FROM public.network_worker_assignments assignment
      WHERE assignment.worker_id = v_worker_id
        AND assignment.organization_id = maintenance.organization_id
        AND assignment.building_id = maintenance.building_id
        AND assignment.can_poll
        AND assignment.active_from <= p_now
        AND (
          assignment.active_until IS NULL
          OR assignment.active_until > p_now
        )
    );
  GET DIAGNOSTICS v_windows_updated = ROW_COUNT;

  -- Fleet-global partition, retention, rollup and command reclamation remain a
  -- separate trusted scheduler responsibility; worker auth never invokes them.
  RETURN jsonb_build_object(
    'at', p_now,
    'assignedBuildings', v_building_count,
    'expiredClients', v_expired_clients,
    'maintenanceWindowsUpdated', v_windows_updated,
    'reclaimedCommands', 0
  );
END;
$fn$;

-- ---------------------------------------------------------------------------
-- Bounded legacy compatibility wrappers. Caller-supplied p_worker_id is never
-- authority. Every wrapper resolves the same private snapshot principal.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.network_center_worker_heartbeat_v1(
  p_worker_id text,
  p_worker_version text,
  p_capabilities text[],
  p_status text,
  p_queue_age_seconds integer,
  p_safe_metadata jsonb,
  p_started_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $fn$
DECLARE
  v_compat_worker_id uuid;
  v_compat_worker_key text;
  v_now timestamptz := clock_timestamp();
  v_status text := upper(btrim(coalesce(p_status, '')));
  v_count integer;
BEGIN
  SELECT compatibility.worker_id, compatibility.worker_key
  INTO v_compat_worker_id, v_compat_worker_key
  FROM app_private.network_center_compatibility_worker_v1() compatibility;
  IF char_length(btrim(coalesce(p_worker_version, ''))) NOT BETWEEN 1 AND 100
     OR cardinality(coalesce(p_capabilities, ARRAY[]::text[])) > 32
     OR v_status NOT IN ('ONLINE', 'DEGRADED', 'PAUSED', 'STOPPING')
     OR p_queue_age_seconds NOT BETWEEN 0 AND 31536000
     OR p_safe_metadata IS NULL OR jsonb_typeof(p_safe_metadata) <> 'object'
     OR p_started_at IS NULL OR p_started_at > v_now THEN
    RAISE EXCEPTION 'Invalid worker heartbeat' USING ERRCODE = '22023';
  END IF;
  PERFORM app_private.network_center_assert_safe_json_v1(
    p_safe_metadata, 'worker heartbeat metadata'
  );

  WITH snapshot_assignments AS MATERIALIZED (
    SELECT assignment.organization_id, assignment.building_id
    FROM app_private.network_worker_compatibility_state state
    JOIN public.network_worker_assignments assignment
      ON assignment.worker_id = state.worker_id
    WHERE state.singleton AND state.worker_id = v_compat_worker_id
      AND state.finalized_at IS NULL AND state.expires_at > v_now
      AND assignment.can_poll
      AND assignment.active_from <= v_now
      AND assignment.active_until > v_now
      AND state.assignment_snapshot @> jsonb_build_array(jsonb_build_object(
        'assignmentId', assignment.id,
        'organizationId', assignment.organization_id,
        'buildingId', assignment.building_id,
        'deviceId', assignment.device_id
      ))
  ), upserted AS (
    INSERT INTO public.network_worker_building_status (
      organization_id, building_id, status, heartbeat_at,
      queue_age_seconds, started_at, updated_at
    )
    SELECT DISTINCT organization_id, building_id, v_status, v_now,
      p_queue_age_seconds, p_started_at, v_now
    FROM snapshot_assignments
    ON CONFLICT (organization_id, building_id) DO UPDATE SET
      status = EXCLUDED.status, heartbeat_at = EXCLUDED.heartbeat_at,
      queue_age_seconds = EXCLUDED.queue_age_seconds,
      started_at = LEAST(
        public.network_worker_building_status.started_at,
        EXCLUDED.started_at
      ), updated_at = EXCLUDED.updated_at
    RETURNING building_id
  ) SELECT count(*) INTO v_count FROM upserted;
  IF v_count = 0 THEN
    RAISE EXCEPTION 'Legacy compatibility has no active snapshot assignment'
      USING ERRCODE = '42501';
  END IF;
  RETURN jsonb_build_object(
    'status', v_status, 'heartbeatAt', v_now,
    'assignedBuildingCount', v_count
  );
END;
$fn$;

CREATE OR REPLACE FUNCTION public.network_center_worker_list_connections_v1(
  p_worker_id text,
  p_limit integer DEFAULT 100
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $fn$
DECLARE
  v_compat_worker_id uuid;
  v_compat_worker_key text;
  v_now timestamptz := clock_timestamp();
  v_result jsonb;
BEGIN
  SELECT compatibility.worker_id, compatibility.worker_key
  INTO v_compat_worker_id, v_compat_worker_key
  FROM app_private.network_center_compatibility_worker_v1() compatibility;
  IF p_limit NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'Invalid worker connection request'
      USING ERRCODE = '22023';
  END IF;
  SELECT jsonb_build_object('items', coalesce(jsonb_agg(item ORDER BY
    organization_id, building_id, device_id
  ), '[]'::jsonb)) INTO v_result
  FROM (
    SELECT connection.organization_id, connection.building_id,
      connection.device_id, jsonb_build_object(
        'connectionId', connection.id,
        'organizationId', connection.organization_id,
        'buildingId', connection.building_id,
        'deviceId', connection.device_id,
        'deviceKind', device.device_kind,
        'externalKey', device.external_key,
        'displayName', device.display_name,
        'transport', connection.transport,
        'managementIp', connection.management_ip::text,
        'managementPort', connection.management_port,
        'credentialRef', connection.credential_ref,
        'hostKeyFingerprint', connection.host_key_fingerprint,
        'pollIntervalSeconds', coalesce(
          settings.poll_interval_seconds, connection.poll_interval_seconds
        ),
        'connectTimeoutMs', connection.connect_timeout_ms,
        'monitoringEnabled', coalesce(settings.monitoring_enabled, true),
        'changesPaused', coalesce(settings.changes_paused, false)
      ) AS item
    FROM public.network_device_connections connection
    JOIN public.network_devices device ON device.id = connection.device_id
    JOIN public.network_worker_assignments assignment
      ON assignment.worker_id = v_compat_worker_id
     AND assignment.organization_id = connection.organization_id
     AND assignment.building_id = connection.building_id
     AND assignment.device_id = connection.device_id
     AND assignment.can_poll
     AND assignment.active_from <= v_now
     AND assignment.active_until > v_now
    JOIN app_private.network_worker_compatibility_state state
      ON state.worker_id = assignment.worker_id
     AND state.singleton AND state.finalized_at IS NULL
     AND state.expires_at > v_now
     AND state.assignment_snapshot @> jsonb_build_array(jsonb_build_object(
       'assignmentId', assignment.id,
       'organizationId', assignment.organization_id,
       'buildingId', assignment.building_id,
       'deviceId', assignment.device_id
     ))
    LEFT JOIN public.network_site_settings settings
      ON settings.organization_id = connection.organization_id
     AND settings.building_id = connection.building_id
    WHERE connection.is_enabled AND device.is_active
    ORDER BY connection.organization_id, connection.building_id,
      connection.device_id
    LIMIT p_limit
  ) scoped_connections;
  RETURN coalesce(v_result, jsonb_build_object('items', '[]'::jsonb));
END;
$fn$;

CREATE OR REPLACE FUNCTION public.network_center_worker_claim_v1(
  p_worker_id text,
  p_limit integer DEFAULT 5,
  p_lease_seconds integer DEFAULT 90
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $fn$
DECLARE
  v_compat_worker_id uuid;
  v_compat_worker_key text;
BEGIN
  SELECT compatibility.worker_id, compatibility.worker_key
  INTO v_compat_worker_id, v_compat_worker_key
  FROM app_private.network_center_compatibility_worker_v1() compatibility;
  IF p_limit NOT BETWEEN 1 AND 20
     OR p_lease_seconds NOT BETWEEN 15 AND 300 THEN
    RAISE EXCEPTION 'Invalid command claim request' USING ERRCODE = '22023';
  END IF;
  RETURN jsonb_build_object('items', '[]'::jsonb);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.network_center_worker_renew_v1(
  p_worker_id text,
  p_command_id uuid,
  p_lease_token uuid,
  p_lease_seconds integer DEFAULT 90
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $fn$
DECLARE v_compat_worker_id uuid; v_compat_worker_key text;
BEGIN
  SELECT compatibility.worker_id, compatibility.worker_key
  INTO v_compat_worker_id, v_compat_worker_key
  FROM app_private.network_center_compatibility_worker_v1() compatibility;
  RAISE EXCEPTION 'Legacy compatibility cannot renew command leases'
    USING ERRCODE = '42501';
END;
$fn$;

CREATE OR REPLACE FUNCTION public.network_center_worker_ingest_v1(
  p_worker_id text,
  p_payload jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $fn$
DECLARE
  v_compat_worker_id uuid;
  v_compat_worker_key text;
  v_target_count integer;
BEGIN
  SELECT compatibility.worker_id, compatibility.worker_key
  INTO v_compat_worker_id, v_compat_worker_key
  FROM app_private.network_center_compatibility_worker_v1() compatibility;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object'
     OR jsonb_typeof(coalesce(p_payload->'devices', '[]'::jsonb)) <> 'array'
     OR jsonb_typeof(coalesce(p_payload->'interfaces', '[]'::jsonb)) <> 'array'
     OR jsonb_typeof(coalesce(p_payload->'clients', '[]'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'Invalid telemetry payload' USING ERRCODE = '22023';
  END IF;
  v_target_count := jsonb_array_length(coalesce(p_payload->'devices', '[]'::jsonb))
    + jsonb_array_length(coalesce(p_payload->'interfaces', '[]'::jsonb))
    + jsonb_array_length(coalesce(p_payload->'clients', '[]'::jsonb));
  IF v_target_count = 0 OR EXISTS (
    SELECT 1
    FROM jsonb_array_elements(coalesce(p_payload->'devices', '[]'::jsonb)) item
    LEFT JOIN public.network_devices device
      ON device.id = nullif(item->>'deviceId', '')::uuid
    LEFT JOIN public.network_devices router
      ON router.id = CASE WHEN device.device_kind = 'MIKROTIK'
        THEN device.id ELSE device.parent_device_id END
    WHERE router.id IS NULL OR NOT
      app_private.network_center_compatibility_can_access_device_v1(
        v_compat_worker_id, router.organization_id, router.building_id,
        router.id, 'can_poll'
      )
  ) OR EXISTS (
    SELECT 1
    FROM jsonb_array_elements(coalesce(p_payload->'interfaces', '[]'::jsonb)) item
    LEFT JOIN public.network_interfaces interface
      ON interface.id = nullif(item->>'interfaceId', '')::uuid
    LEFT JOIN public.network_devices device ON device.id = interface.device_id
    LEFT JOIN public.network_devices router
      ON router.id = CASE WHEN device.device_kind = 'MIKROTIK'
        THEN device.id ELSE device.parent_device_id END
    WHERE router.id IS NULL OR NOT
      app_private.network_center_compatibility_can_access_device_v1(
        v_compat_worker_id, router.organization_id, router.building_id,
        router.id, 'can_poll'
      )
  ) OR EXISTS (
    SELECT 1
    FROM jsonb_array_elements(coalesce(p_payload->'clients', '[]'::jsonb)) item
    LEFT JOIN public.network_devices device
      ON device.id = nullif(item->>'deviceId', '')::uuid
    LEFT JOIN public.network_devices router
      ON router.id = CASE WHEN device.device_kind = 'MIKROTIK'
        THEN device.id ELSE device.parent_device_id END
    WHERE router.id IS NULL OR NOT
      app_private.network_center_compatibility_can_access_device_v1(
        v_compat_worker_id, router.organization_id, router.building_id,
        router.id, 'can_poll'
      )
  ) THEN
    RAISE EXCEPTION 'Legacy telemetry target is outside compatibility snapshot'
      USING ERRCODE = '42501';
  END IF;
  RETURN app_private.network_center_worker_ingest_legacy_impl_v1(
    v_compat_worker_key, p_payload
  );
END;
$fn$;

CREATE OR REPLACE FUNCTION public.network_center_worker_inventory_v1(
  p_worker_id text,
  p_payload jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $fn$
DECLARE
  v_compat_worker_id uuid;
  v_compat_worker_key text;
  v_router public.network_devices%ROWTYPE;
  v_result jsonb;
  v_mapping jsonb;
BEGIN
  SELECT compatibility.worker_id, compatibility.worker_key
  INTO v_compat_worker_id, v_compat_worker_key
  FROM app_private.network_center_compatibility_worker_v1() compatibility;
  SELECT router.* INTO v_router FROM public.network_devices router
  WHERE router.id = nullif(p_payload->>'routerDeviceId', '')::uuid
    AND router.device_kind = 'MIKROTIK' AND router.is_active
  FOR UPDATE;
  IF NOT FOUND OR NOT
    app_private.network_center_compatibility_can_access_device_v1(
      v_compat_worker_id, v_router.organization_id, v_router.building_id,
      v_router.id, 'can_inventory'
    ) THEN
    RAISE EXCEPTION 'Legacy inventory target is outside compatibility snapshot'
      USING ERRCODE = '42501';
  END IF;
  v_result := app_private.network_center_worker_inventory_legacy_impl_v1(
    v_compat_worker_key, p_payload
  );
  v_mapping := app_private.network_center_managed_interface_mapping_v1(v_router.id);
  v_result := jsonb_set(v_result, '{interfaces}', v_mapping, true);
  v_result := jsonb_set(
    v_result, '{interfaceCount}', to_jsonb(jsonb_array_length(v_mapping)), true
  );
  RETURN v_result;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.network_center_worker_command_event_v1(
  p_worker_id text,
  p_command_id uuid,
  p_lease_token uuid,
  p_event_kind text,
  p_payload jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $fn$
DECLARE v_compat_worker_id uuid; v_compat_worker_key text;
BEGIN
  SELECT compatibility.worker_id, compatibility.worker_key
  INTO v_compat_worker_id, v_compat_worker_key
  FROM app_private.network_center_compatibility_worker_v1() compatibility;
  RAISE EXCEPTION 'Legacy compatibility cannot write command events'
    USING ERRCODE = '42501';
END;
$fn$;

CREATE OR REPLACE FUNCTION public.network_center_worker_complete_v1(
  p_worker_id text,
  p_command_id uuid,
  p_lease_token uuid,
  p_outcome text,
  p_result jsonb,
  p_rollback jsonb DEFAULT NULL,
  p_retry_delay_seconds integer DEFAULT 30
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $fn$
DECLARE v_compat_worker_id uuid; v_compat_worker_key text;
BEGIN
  SELECT compatibility.worker_id, compatibility.worker_key
  INTO v_compat_worker_id, v_compat_worker_key
  FROM app_private.network_center_compatibility_worker_v1() compatibility;
  RAISE EXCEPTION 'Legacy compatibility cannot complete commands'
    USING ERRCODE = '42501';
END;
$fn$;

CREATE OR REPLACE FUNCTION public.network_center_worker_upsert_incident_v1(
  p_worker_id text,
  p_payload jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $fn$
DECLARE
  v_compat_worker_id uuid;
  v_compat_worker_key text;
  v_device public.network_devices%ROWTYPE;
  v_router public.network_devices%ROWTYPE;
BEGIN
  SELECT compatibility.worker_id, compatibility.worker_key
  INTO v_compat_worker_id, v_compat_worker_key
  FROM app_private.network_center_compatibility_worker_v1() compatibility;
  SELECT device.* INTO v_device FROM public.network_devices device
  WHERE device.id = nullif(p_payload->>'deviceId', '')::uuid
    AND device.is_active;
  SELECT router.* INTO v_router FROM public.network_devices router
  WHERE router.id = CASE WHEN v_device.device_kind = 'MIKROTIK'
    THEN v_device.id ELSE v_device.parent_device_id END
    AND router.organization_id = v_device.organization_id
    AND router.building_id = v_device.building_id
    AND router.device_kind = 'MIKROTIK';
  IF NOT FOUND OR NOT
    app_private.network_center_compatibility_can_access_device_v1(
      v_compat_worker_id, v_router.organization_id, v_router.building_id,
      v_router.id, 'can_poll'
    ) THEN
    RAISE EXCEPTION 'Legacy incident target is outside compatibility snapshot'
      USING ERRCODE = '42501';
  END IF;
  RETURN app_private.network_center_worker_upsert_incident_legacy_impl_v1(
    v_compat_worker_key, p_payload
  );
END;
$fn$;

CREATE OR REPLACE FUNCTION public.network_center_worker_snapshot_v1(
  p_worker_id text,
  p_payload jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $fn$
DECLARE v_compat_worker_id uuid; v_compat_worker_key text;
BEGIN
  SELECT compatibility.worker_id, compatibility.worker_key
  INTO v_compat_worker_id, v_compat_worker_key
  FROM app_private.network_center_compatibility_worker_v1() compatibility;
  RAISE EXCEPTION 'Legacy compatibility cannot persist command snapshots'
    USING ERRCODE = '42501';
END;
$fn$;

CREATE OR REPLACE FUNCTION public.network_center_worker_maintenance_v1(
  p_worker_id text,
  p_now timestamptz DEFAULT clock_timestamp()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $fn$
DECLARE
  v_compat_worker_id uuid;
  v_compat_worker_key text;
  v_expired_clients bigint := 0;
  v_windows_updated bigint := 0;
BEGIN
  SELECT compatibility.worker_id, compatibility.worker_key
  INTO v_compat_worker_id, v_compat_worker_key
  FROM app_private.network_center_compatibility_worker_v1() compatibility;
  IF p_now IS NULL
     OR abs(extract(epoch FROM (clock_timestamp() - p_now))) > 3600 THEN
    RAISE EXCEPTION 'Invalid worker maintenance request'
      USING ERRCODE = '22023';
  END IF;
  DELETE FROM public.network_client_current client
  WHERE client.expires_at <= p_now
    AND EXISTS (
      SELECT 1
      FROM public.network_worker_assignments assignment
      JOIN app_private.network_worker_compatibility_state state
        ON state.worker_id = assignment.worker_id
       AND state.singleton AND state.finalized_at IS NULL
       AND state.expires_at > p_now
      JOIN public.network_devices device ON device.id = client.device_id
      WHERE assignment.worker_id = v_compat_worker_id
        AND assignment.organization_id = client.organization_id
        AND assignment.building_id = client.building_id
        AND assignment.device_id = CASE WHEN device.device_kind = 'MIKROTIK'
          THEN device.id ELSE device.parent_device_id END
        AND assignment.can_poll
        AND assignment.active_from <= p_now
        AND assignment.active_until > p_now
        AND state.assignment_snapshot @> jsonb_build_array(jsonb_build_object(
          'assignmentId', assignment.id,
          'organizationId', assignment.organization_id,
          'buildingId', assignment.building_id,
          'deviceId', assignment.device_id
        ))
    );
  GET DIAGNOSTICS v_expired_clients = ROW_COUNT;
  UPDATE public.network_maintenance_windows maintenance
  SET status = CASE WHEN maintenance.ends_at <= p_now
    THEN 'COMPLETED' ELSE 'ACTIVE' END
  WHERE maintenance.status IN ('SCHEDULED', 'ACTIVE')
    AND (maintenance.starts_at <= p_now OR maintenance.ends_at <= p_now)
    AND EXISTS (
      SELECT 1
      FROM public.network_worker_assignments assignment
      JOIN app_private.network_worker_compatibility_state state
        ON state.worker_id = assignment.worker_id
       AND state.singleton AND state.finalized_at IS NULL
       AND state.expires_at > p_now
      WHERE assignment.worker_id = v_compat_worker_id
        AND assignment.organization_id = maintenance.organization_id
        AND assignment.building_id = maintenance.building_id
        AND assignment.can_poll
        AND assignment.active_from <= p_now
        AND assignment.active_until > p_now
        AND state.assignment_snapshot @> jsonb_build_array(jsonb_build_object(
          'assignmentId', assignment.id,
          'organizationId', assignment.organization_id,
          'buildingId', assignment.building_id,
          'deviceId', assignment.device_id
        ))
    );
  GET DIAGNOSTICS v_windows_updated = ROW_COUNT;
  RETURN jsonb_build_object(
    'at', p_now, 'expiredClients', v_expired_clients,
    'maintenanceWindowsUpdated', v_windows_updated,
    'reclaimedCommands', 0
  );
END;
$fn$;

CREATE OR REPLACE FUNCTION public.network_center_admin_finalize_worker_compatibility_v1()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $fn$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_worker_id uuid;
  v_already_finalized boolean := false;
BEGIN
  SELECT state.worker_id, state.finalized_at IS NOT NULL
  INTO v_worker_id, v_already_finalized
  FROM app_private.network_worker_compatibility_state state
  WHERE state.singleton
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Worker compatibility state not found'
      USING ERRCODE = 'P0002';
  END IF;

  IF NOT v_already_finalized THEN
    UPDATE app_private.network_worker_compatibility_state
    SET finalized_at = v_now, expires_at = LEAST(expires_at, v_now)
    WHERE singleton;
    UPDATE public.network_workers worker
    SET status = 'DISABLED', version = worker.version + 1,
        updated_at = v_now
    WHERE worker.id = v_worker_id;
    UPDATE public.network_worker_assignments assignment
    SET active_until = greatest(
          v_now, assignment.active_from + INTERVAL '1 microsecond'
        ),
        assignment_version = assignment.assignment_version + 1,
        updated_by = 'worker-compatibility-finalizer',
        updated_at = v_now
    WHERE assignment.worker_id = v_worker_id
      AND (assignment.active_until IS NULL OR assignment.active_until > v_now);
  END IF;

  EXECUTE 'REVOKE EXECUTE ON FUNCTION public.network_center_worker_heartbeat_v1(text,text,text[],text,integer,jsonb,timestamp with time zone) FROM service_role';
  EXECUTE 'REVOKE EXECUTE ON FUNCTION public.network_center_worker_list_connections_v1(text,integer) FROM service_role';
  EXECUTE 'REVOKE EXECUTE ON FUNCTION public.network_center_worker_claim_v1(text,integer,integer) FROM service_role';
  EXECUTE 'REVOKE EXECUTE ON FUNCTION public.network_center_worker_renew_v1(text,uuid,uuid,integer) FROM service_role';
  EXECUTE 'REVOKE EXECUTE ON FUNCTION public.network_center_worker_ingest_v1(text,jsonb) FROM service_role';
  EXECUTE 'REVOKE EXECUTE ON FUNCTION public.network_center_worker_inventory_v1(text,jsonb) FROM service_role';
  EXECUTE 'REVOKE EXECUTE ON FUNCTION public.network_center_worker_command_event_v1(text,uuid,uuid,text,jsonb) FROM service_role';
  EXECUTE 'REVOKE EXECUTE ON FUNCTION public.network_center_worker_complete_v1(text,uuid,uuid,text,jsonb,jsonb,integer) FROM service_role';
  EXECUTE 'REVOKE EXECUTE ON FUNCTION public.network_center_worker_upsert_incident_v1(text,jsonb) FROM service_role';
  EXECUTE 'REVOKE EXECUTE ON FUNCTION public.network_center_worker_snapshot_v1(text,jsonb) FROM service_role';
  EXECUTE 'REVOKE EXECUTE ON FUNCTION public.network_center_worker_maintenance_v1(text,timestamp with time zone) FROM service_role';

  RETURN jsonb_build_object(
    'finalized', true,
    'alreadyFinalized', v_already_finalized,
    'finalizedAt', coalesce((
      SELECT state.finalized_at
      FROM app_private.network_worker_compatibility_state state
      WHERE state.singleton
    ), v_now)
  );
END;
$fn$;

-- Private implementation and authorization helpers never cross PostgREST.
REVOKE ALL ON FUNCTION app_private.network_center_worker_can_access_device_v2(
  uuid, uuid, uuid, uuid, text, timestamp with time zone
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.network_center_worker_can_access_building_v2(
  uuid, uuid, uuid, text, timestamp with time zone
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.network_center_reclaim_expired_commands_v2(
  uuid, timestamp with time zone
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.network_center_guard_compatibility_state_v1()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.network_center_compatibility_worker_v1()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.network_center_compatibility_can_access_device_v1(
  uuid, uuid, uuid, uuid, text, timestamp with time zone
) FROM PUBLIC, anon, authenticated, service_role;

-- v2 is the only durable Edge contract.
REVOKE ALL ON FUNCTION public.network_center_worker_heartbeat_v2(
  text, text, text[], text, integer, jsonb, timestamp with time zone
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.network_center_worker_heartbeat_v2(
  text, text, text[], text, integer, jsonb, timestamp with time zone
) TO service_role;

REVOKE ALL ON FUNCTION public.network_center_worker_list_connections_v2(
  text, integer
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.network_center_worker_list_connections_v2(
  text, integer
) TO service_role;

REVOKE ALL ON FUNCTION public.network_center_worker_claim_v2(
  text, integer, integer
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.network_center_worker_claim_v2(
  text, integer, integer
) TO service_role;

REVOKE ALL ON FUNCTION public.network_center_worker_renew_v2(
  text, uuid, uuid, bigint, integer
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.network_center_worker_renew_v2(
  text, uuid, uuid, bigint, integer
) TO service_role;

REVOKE ALL ON FUNCTION public.network_center_worker_ingest_v2(text, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.network_center_worker_ingest_v2(text, jsonb)
  TO service_role;

REVOKE ALL ON FUNCTION public.network_center_worker_inventory_v2(text, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.network_center_worker_inventory_v2(text, jsonb)
  TO service_role;

REVOKE ALL ON FUNCTION public.network_center_worker_command_event_v2(
  text, uuid, uuid, bigint, text, jsonb
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.network_center_worker_command_event_v2(
  text, uuid, uuid, bigint, text, jsonb
) TO service_role;

REVOKE ALL ON FUNCTION public.network_center_worker_observe_v2(
  text, uuid, uuid, bigint, bigint, uuid, text,
  timestamp with time zone, jsonb
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.network_center_worker_observe_v2(
  text, uuid, uuid, bigint, bigint, uuid, text,
  timestamp with time zone, jsonb
) TO service_role;

REVOKE ALL ON FUNCTION public.network_center_worker_complete_v2(
  text, uuid, uuid, bigint, bigint, text, jsonb, jsonb, integer
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.network_center_worker_complete_v2(
  text, uuid, uuid, bigint, bigint, text, jsonb, jsonb, integer
) TO service_role;

REVOKE ALL ON FUNCTION public.network_center_worker_upsert_incident_v2(
  text, jsonb
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.network_center_worker_upsert_incident_v2(
  text, jsonb
) TO service_role;

REVOKE ALL ON FUNCTION public.network_center_worker_snapshot_v2(text, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.network_center_worker_snapshot_v2(text, jsonb)
  TO service_role;

REVOKE ALL ON FUNCTION public.network_center_worker_maintenance_v2(
  text, timestamp with time zone
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.network_center_worker_maintenance_v2(
  text, timestamp with time zone
) TO service_role;

-- Exact v1 signatures remain callable by service_role only until finalization.
REVOKE ALL ON FUNCTION public.network_center_worker_heartbeat_v1(
  text, text, text[], text, integer, jsonb, timestamp with time zone
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.network_center_worker_heartbeat_v1(
  text, text, text[], text, integer, jsonb, timestamp with time zone
) TO service_role;

REVOKE ALL ON FUNCTION public.network_center_worker_list_connections_v1(
  text, integer
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.network_center_worker_list_connections_v1(
  text, integer
) TO service_role;

REVOKE ALL ON FUNCTION public.network_center_worker_claim_v1(
  text, integer, integer
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.network_center_worker_claim_v1(
  text, integer, integer
) TO service_role;

REVOKE ALL ON FUNCTION public.network_center_worker_renew_v1(
  text, uuid, uuid, integer
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.network_center_worker_renew_v1(
  text, uuid, uuid, integer
) TO service_role;

REVOKE ALL ON FUNCTION public.network_center_worker_ingest_v1(text, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.network_center_worker_ingest_v1(text, jsonb)
  TO service_role;

REVOKE ALL ON FUNCTION public.network_center_worker_inventory_v1(text, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.network_center_worker_inventory_v1(text, jsonb)
  TO service_role;

REVOKE ALL ON FUNCTION public.network_center_worker_command_event_v1(
  text, uuid, uuid, text, jsonb
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.network_center_worker_command_event_v1(
  text, uuid, uuid, text, jsonb
) TO service_role;

REVOKE ALL ON FUNCTION public.network_center_worker_complete_v1(
  text, uuid, uuid, text, jsonb, jsonb, integer
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.network_center_worker_complete_v1(
  text, uuid, uuid, text, jsonb, jsonb, integer
) TO service_role;

REVOKE ALL ON FUNCTION public.network_center_worker_upsert_incident_v1(
  text, jsonb
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.network_center_worker_upsert_incident_v1(
  text, jsonb
) TO service_role;

REVOKE ALL ON FUNCTION public.network_center_worker_snapshot_v1(text, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.network_center_worker_snapshot_v1(text, jsonb)
  TO service_role;

REVOKE ALL ON FUNCTION public.network_center_worker_maintenance_v1(
  text, timestamp with time zone
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.network_center_worker_maintenance_v1(
  text, timestamp with time zone
) TO service_role;

REVOKE ALL ON FUNCTION
  public.network_center_admin_finalize_worker_compatibility_v1()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION
  public.network_center_admin_finalize_worker_compatibility_v1()
  TO service_role;

COMMENT ON TABLE public.network_worker_building_status IS
  'Tenant/building-scoped worker liveness; contains no fleet-correlatable worker identity or credentials.';
COMMENT ON TABLE app_private.network_worker_compatibility_state IS
  'One-time explicit legacy assignment snapshot, capped at seven days and permanently finalizable.';

NOTIFY pgrst, 'reload schema';

COMMIT;
