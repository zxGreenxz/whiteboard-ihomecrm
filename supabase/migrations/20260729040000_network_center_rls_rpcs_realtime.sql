-- =============================================================================
-- Network Center 4/4: tenant-safe RLS, browser RPCs, worker-only RPCs and the
-- small Realtime invalidation surface. No router secret is browser-readable.
-- =============================================================================

BEGIN;

-- Complete the persisted settings/client contract used by the existing UI.
ALTER TABLE public.network_site_settings
  ADD COLUMN IF NOT EXISTS backup_time_local time NOT NULL DEFAULT TIME '03:00',
  ADD COLUMN IF NOT EXISTS alert_sensitivity text NOT NULL DEFAULT 'STANDARD',
  ADD COLUMN IF NOT EXISTS dependency_grouping boolean NOT NULL DEFAULT true;

ALTER TABLE public.network_client_current
  ADD COLUMN IF NOT EXISTS session_type text NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN IF NOT EXISTS rx_bps numeric(20,2),
  ADD COLUMN IF NOT EXISTS tx_bps numeric(20,2),
  ADD COLUMN IF NOT EXISTS randomized_mac boolean NOT NULL DEFAULT false;

ALTER TABLE public.network_audit_events
  ADD COLUMN IF NOT EXISTS request_hash text;

ALTER TABLE public.network_devices
  DROP CONSTRAINT IF EXISTS network_devices_aruba_display_only;

ALTER TABLE public.network_devices
  ADD CONSTRAINT network_devices_aruba_display_only
  CHECK (
    (device_kind = 'ARUBA' AND write_capability = false AND credential_ref IS NULL)
    OR device_kind <> 'ARUBA'
  );

DO $constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.network_site_settings'::regclass
      AND conname = 'network_site_settings_alert_sensitivity_check'
  ) THEN
    ALTER TABLE public.network_site_settings
      ADD CONSTRAINT network_site_settings_alert_sensitivity_check
      CHECK (alert_sensitivity IN ('STANDARD', 'STRICT'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.network_client_current'::regclass
      AND conname = 'network_client_current_session_type_check'
  ) THEN
    ALTER TABLE public.network_client_current
      ADD CONSTRAINT network_client_current_session_type_check
      CHECK (session_type IN ('UNKNOWN', 'DHCP', 'HOTSPOT', 'STATIC', 'ARP'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.network_client_current'::regclass
      AND conname = 'network_client_current_rate_check'
  ) THEN
    ALTER TABLE public.network_client_current
      ADD CONSTRAINT network_client_current_rate_check
      CHECK ((rx_bps IS NULL OR rx_bps >= 0) AND (tx_bps IS NULL OR tx_bps >= 0));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.network_audit_events'::regclass
      AND conname = 'network_audit_events_request_hash_check'
  ) THEN
    ALTER TABLE public.network_audit_events
      ADD CONSTRAINT network_audit_events_request_hash_check
      CHECK (request_hash IS NULL OR request_hash ~ '^[a-f0-9]{64}$');
  END IF;
END;
$constraints$;

CREATE UNIQUE INDEX IF NOT EXISTS network_audit_events_user_request_uidx
  ON public.network_audit_events (organization_id, actor_id, request_id)
  WHERE actor_type = 'USER' AND actor_id IS NOT NULL AND request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS network_devices_aruba_cursor_idx
  ON public.network_devices (organization_id, building_id, sort_order, id)
  WHERE device_kind = 'ARUBA' AND is_active;

-- New catalog keys are not automatically materialized into roles that predate
-- them. Give active organization owners the two locked Network Center
-- permissions at organization scope; staff still receive nothing implicitly.
INSERT INTO public.authorization_scopes (organization_id, scope_type)
SELECT organization.id, 'ORGANIZATION'
FROM public.organizations organization
WHERE NOT EXISTS (
  SELECT 1
  FROM public.authorization_scopes scope
  WHERE scope.organization_id = organization.id
    AND scope.scope_type = 'ORGANIZATION'
)
ON CONFLICT DO NOTHING;

INSERT INTO public.member_permission_overrides (
  organization_id,
  membership_id,
  permission_key,
  effect,
  reason,
  created_by,
  scope_mode
)
SELECT
  membership.organization_id,
  membership.id,
  permission.permission_key,
  'ALLOW',
  'Network Center owner baseline access',
  membership.user_id,
  'ORGANIZATION'
FROM public.organization_memberships membership
CROSS JOIN (
  VALUES ('network_center.view'::text), ('network_center.execute'::text)
) permission(permission_key)
WHERE membership.member_type = 'OWNER'
  AND membership.status = 'ACTIVE'
  AND coalesce(membership.valid_from, '-infinity'::timestamptz) <= statement_timestamp()
  AND (membership.valid_to IS NULL OR membership.valid_to > statement_timestamp())
  AND NOT EXISTS (
    SELECT 1
    FROM public.member_permission_overrides existing
    WHERE existing.organization_id = membership.organization_id
      AND existing.membership_id = membership.id
      AND existing.permission_key = permission.permission_key
      AND existing.effect = 'ALLOW'
      AND existing.scope_mode = 'ORGANIZATION'
      AND existing.revoked_at IS NULL
  );

INSERT INTO public.member_override_scopes (
  organization_id,
  override_id,
  scope_id
)
SELECT
  override.organization_id,
  override.id,
  scope.id
FROM public.member_permission_overrides override
JOIN public.organization_memberships membership
  ON membership.organization_id = override.organization_id
 AND membership.id = override.membership_id
 AND membership.member_type = 'OWNER'
 AND membership.status = 'ACTIVE'
JOIN public.authorization_scopes scope
  ON scope.organization_id = override.organization_id
 AND scope.scope_type = 'ORGANIZATION'
WHERE override.permission_key IN ('network_center.view', 'network_center.execute')
  AND override.effect = 'ALLOW'
  AND override.scope_mode = 'ORGANIZATION'
  AND override.revoked_at IS NULL
ON CONFLICT DO NOTHING;

-- Defence in depth for every worker-provided JSON value that can later become
-- browser-readable. Redacted sensitive keys are allowed; raw credentials,
-- tokens, private-key material, and credential-bearing export lines are not.
CREATE OR REPLACE FUNCTION app_private.network_center_assert_safe_json_v1(
  p_value jsonb,
  p_context text DEFAULT 'Network Center payload',
  p_depth integer DEFAULT 0
)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_key text;
  v_child jsonb;
  v_text text;
  v_sensitive_key boolean;
  v_redacted boolean;
BEGIN
  IF p_value IS NULL THEN
    RETURN;
  END IF;
  IF p_depth > 32 THEN
    RAISE EXCEPTION 'Unsafe or over-nested %', left(coalesce(p_context, 'Network Center payload'), 80)
      USING ERRCODE = '22023';
  END IF;

  CASE jsonb_typeof(p_value)
    WHEN 'object' THEN
      FOR v_key, v_child IN SELECT entry.key, entry.value FROM jsonb_each(p_value) entry
      LOOP
        v_sensitive_key := lower(v_key) ~
          '(^|[^a-z0-9])(password|passwd|secret|private.?key|preshared.?key|authorization|cookie|credential(ref)?|access.?token|refresh.?token|service.?role|lease.?token|artifact.?key)($|[^a-z0-9])';
        v_redacted := jsonb_typeof(v_child) = 'string'
          AND (v_child #>> '{}') ~* '^(\[?redacted\]?|<redacted>|\*{3,})$';
        IF v_sensitive_key AND NOT v_redacted THEN
          RAISE EXCEPTION 'Sensitive key is not redacted in %',
            left(coalesce(p_context, 'Network Center payload'), 80)
            USING ERRCODE = '22023';
        END IF;
        PERFORM app_private.network_center_assert_safe_json_v1(
          v_child, p_context, p_depth + 1
        );
      END LOOP;
    WHEN 'array' THEN
      FOR v_child IN SELECT element.value FROM jsonb_array_elements(p_value) element
      LOOP
        PERFORM app_private.network_center_assert_safe_json_v1(
          v_child, p_context, p_depth + 1
        );
      END LOOP;
    WHEN 'string' THEN
      v_text := p_value #>> '{}';
      IF v_text ~* '-----BEGIN[[:space:]][A-Z0-9 _-]*PRIVATE KEY-----'
         OR v_text ~* '(^|[^A-Za-z0-9_-])Bearer[[:space:]]+[A-Za-z0-9._~+/=-]{16,}'
         OR v_text ~ '(^|[^A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}'
         OR (
           v_text ~* '(password|passwd|secret|private[-_ ]?key|preshared[-_ ]?key|token)[[:space:]]*[:=]'
           AND v_text !~* '(password|passwd|secret|private[-_ ]?key|preshared[-_ ]?key|token)[[:space:]]*[:=][[:space:]]*"?((\[?redacted\]?)|(<redacted>)|(\*{3,}))"?'
         ) THEN
        RAISE EXCEPTION 'Sensitive value is not redacted in %',
          left(coalesce(p_context, 'Network Center payload'), 80)
          USING ERRCODE = '22023';
      END IF;
    ELSE
      NULL;
  END CASE;
END;
$fn$;


-- Keep every Network Center relation fail-closed. Only the five safe Realtime
-- tables below receive direct SELECT; all other browser reads go through RPCs.
ALTER TABLE public.network_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.network_interfaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.network_device_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.network_site_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.network_desired_state_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.network_device_current ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.network_interface_current ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.network_client_current ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.network_client_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.network_client_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.network_device_samples ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.network_interface_samples ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.network_metric_hourly ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.network_sla_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.network_incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.network_incident_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.network_maintenance_windows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.network_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.network_command_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.network_command_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.network_device_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.network_config_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.network_audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.network_outbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.network_outbox_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.network_worker_heartbeats ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS network_device_current_view ON public.network_device_current;
CREATE POLICY network_device_current_view
  ON public.network_device_current FOR SELECT TO authenticated
  USING ((SELECT public.can_do_on_building('network_center', 'view', building_id)));

DROP POLICY IF EXISTS network_interface_current_view ON public.network_interface_current;
CREATE POLICY network_interface_current_view
  ON public.network_interface_current FOR SELECT TO authenticated
  USING ((SELECT public.can_do_on_building('network_center', 'view', building_id)));

DROP POLICY IF EXISTS network_incidents_view ON public.network_incidents;
CREATE POLICY network_incidents_view
  ON public.network_incidents FOR SELECT TO authenticated
  USING ((SELECT public.can_do_on_building('network_center', 'view', building_id)));

DROP POLICY IF EXISTS network_commands_view ON public.network_commands;

DROP POLICY IF EXISTS network_command_events_view ON public.network_command_events;
CREATE POLICY network_command_events_view
  ON public.network_command_events FOR SELECT TO authenticated
  USING ((SELECT public.can_do_on_building('network_center', 'view', building_id)));

DROP POLICY IF EXISTS network_worker_heartbeats_view ON public.network_worker_heartbeats;
CREATE POLICY network_worker_heartbeats_view
  ON public.network_worker_heartbeats FOR SELECT TO authenticated
  USING ((SELECT app_private.has_any_scope_v3('network_center.view')));

REVOKE ALL ON TABLE public.network_device_current FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.network_interface_current FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.network_incidents FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.network_commands FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.network_command_events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.network_worker_heartbeats FROM PUBLIC, anon, authenticated;

GRANT SELECT ON TABLE public.network_device_current TO authenticated;
GRANT SELECT ON TABLE public.network_interface_current TO authenticated;
GRANT SELECT ON TABLE public.network_incidents TO authenticated;
GRANT SELECT ON TABLE public.network_command_events TO authenticated;
GRANT SELECT ON TABLE public.network_worker_heartbeats TO authenticated;

CREATE OR REPLACE FUNCTION app_private.network_center_require_view_v1(p_building_id uuid)
RETURNS TABLE (organization_id uuid, building_name text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
BEGIN
  IF (SELECT auth.uid()) IS NULL OR p_building_id IS NULL THEN
    RAISE EXCEPTION 'Network Center view permission is required' USING ERRCODE = '42501';
  END IF;

  SELECT building.organization_id, building.name
  INTO organization_id, building_name
  FROM public.buildings building
  WHERE building.id = p_building_id
    AND building.deleted_at IS NULL
    AND building.is_virtual = false;

  IF organization_id IS NULL
     OR NOT public.can_do_on_building('network_center', 'view', p_building_id) THEN
    RAISE EXCEPTION 'Network Center view permission is required' USING ERRCODE = '42501';
  END IF;

  RETURN NEXT;
END;
$fn$;

CREATE OR REPLACE FUNCTION app_private.network_center_require_execute_v1(p_building_id uuid)
RETURNS TABLE (organization_id uuid, building_name text, actor_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
BEGIN
  actor_id := (SELECT auth.uid());
  IF actor_id IS NULL OR p_building_id IS NULL THEN
    RAISE EXCEPTION 'Network Center execute permission is required' USING ERRCODE = '42501';
  END IF;

  SELECT building.organization_id, building.name
  INTO organization_id, building_name
  FROM public.buildings building
  WHERE building.id = p_building_id
    AND building.deleted_at IS NULL
    AND building.is_virtual = false
  FOR UPDATE;

  IF organization_id IS NULL
     OR NOT public.can_do_on_building('network_center', 'execute', p_building_id) THEN
    RAISE EXCEPTION 'Network Center execute permission is required' USING ERRCODE = '42501';
  END IF;

  RETURN NEXT;
END;
$fn$;

CREATE OR REPLACE FUNCTION app_private.network_center_request_replay_v1(
  p_organization_id uuid,
  p_actor_id uuid,
  p_request_id uuid,
  p_request_hash text,
  p_action text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_existing public.network_audit_events%ROWTYPE;
BEGIN
  SELECT audit.* INTO v_existing
  FROM public.network_audit_events audit
  WHERE audit.organization_id = p_organization_id
    AND audit.actor_type = 'USER'
    AND audit.actor_id = p_actor_id
    AND audit.request_id = p_request_id
  LIMIT 1;

  IF NOT FOUND THEN RETURN NULL; END IF;
  IF v_existing.action IS DISTINCT FROM p_action
     OR v_existing.request_hash IS DISTINCT FROM p_request_hash THEN
    RAISE EXCEPTION 'Idempotency key reused with different Network Center input'
      USING ERRCODE = '23505';
  END IF;
  RETURN v_existing.result;
END;
$fn$;

CREATE OR REPLACE FUNCTION app_private.network_center_append_user_audit_v1(
  p_organization_id uuid,
  p_building_id uuid,
  p_actor_id uuid,
  p_action text,
  p_target_type text,
  p_target_id uuid,
  p_target_display jsonb,
  p_reason text,
  p_validation jsonb,
  p_result jsonb,
  p_outcome text,
  p_command_id uuid,
  p_request_id uuid,
  p_request_hash text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE v_id uuid;
BEGIN
  INSERT INTO public.network_audit_events (
    organization_id, building_id, actor_type, actor_id, action, target_type,
    target_id, target_display, reason, validation, result, outcome, command_id,
    request_id, request_hash
  ) VALUES (
    p_organization_id, p_building_id, 'USER', p_actor_id, p_action,
    p_target_type, p_target_id, p_target_display, p_reason,
    coalesce(p_validation, '{}'::jsonb), coalesce(p_result, '{}'::jsonb),
    p_outcome, p_command_id, p_request_id, p_request_hash
  ) RETURNING id INTO v_id;
  RETURN v_id;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.network_center_list_fleet_v1()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
  WITH allowed AS (
    SELECT building.id, building.organization_id, building.name,
           coalesce(building.total_rooms, 0) AS total_rooms
    FROM public.buildings building
    WHERE building.deleted_at IS NULL
      AND building.is_virtual = false
      AND public.can_do_on_building('network_center', 'view', building.id)
  ), rows AS (
    SELECT allowed.*,
      router.id AS router_id,
      router.display_name AS router_name,
      router.model AS router_model,
      router.desired_firmware,
      router.lifecycle_status,
      current_state.reachable,
      current_state.health_status,
      current_state.last_seen_at,
      current_state.routeros_version,
      current_state.cpu_pct,
      current_state.memory_used_bytes,
      current_state.memory_total_bytes,
      current_state.pppoe_state,
      current_state.connection_count,
      (SELECT count(*) FROM public.network_devices aruba
        WHERE aruba.organization_id = allowed.organization_id
          AND aruba.building_id = allowed.id
          AND aruba.device_kind = 'ARUBA' AND aruba.is_active) AS aruba_count,
      (SELECT count(*) FROM public.network_incidents incident
        WHERE incident.organization_id = allowed.organization_id
          AND incident.building_id = allowed.id
          AND incident.status <> 'RESOLVED') AS open_incidents,
      (SELECT count(*) FROM public.network_client_current client
        WHERE client.organization_id = allowed.organization_id
          AND client.building_id = allowed.id
          AND client.expires_at > statement_timestamp()) AS active_clients,
      (SELECT max(snapshot.created_at) FROM public.network_config_snapshots snapshot
        WHERE snapshot.organization_id = allowed.organization_id
          AND snapshot.building_id = allowed.id) AS last_backup_at,
      (SELECT sla.uptime_pct FROM public.network_sla_daily sla
        WHERE sla.organization_id = allowed.organization_id
          AND sla.building_id = allowed.id
        ORDER BY sla.sla_day DESC LIMIT 1) AS uptime_pct,
      (SELECT sla.mttr_seconds FROM public.network_sla_daily sla
        WHERE sla.organization_id = allowed.organization_id
          AND sla.building_id = allowed.id
        ORDER BY sla.sla_day DESC LIMIT 1) AS mttr_seconds,
      EXISTS (SELECT 1 FROM public.network_maintenance_windows maintenance
        WHERE maintenance.organization_id = allowed.organization_id
          AND maintenance.building_id = allowed.id
          AND maintenance.status IN ('SCHEDULED', 'ACTIVE')
          AND maintenance.starts_at <= statement_timestamp()
          AND maintenance.ends_at > statement_timestamp()) AS maintenance_active
    FROM allowed
    LEFT JOIN public.network_devices router
      ON router.organization_id = allowed.organization_id
     AND router.building_id = allowed.id
     AND router.device_kind = 'MIKROTIK' AND router.is_active
    LEFT JOIN public.network_device_current current_state ON current_state.device_id = router.id
  )
  SELECT jsonb_build_object(
    'items', coalesce(jsonb_agg(jsonb_build_object(
      'buildingId', rows.id,
      'buildingName', rows.name,
      'roomsCount', rows.total_rooms,
      'routerId', rows.router_id,
      'routerIdentity', rows.router_name,
      'routerModel', rows.router_model,
      'targetFirmware', rows.desired_firmware,
      'lifecycleStatus', rows.lifecycle_status,
      'reachable', coalesce(rows.reachable, false),
      'healthStatus', coalesce(rows.health_status, 'UNKNOWN'),
      'lastSeenAt', rows.last_seen_at,
      'routerosVersion', rows.routeros_version,
      'cpuPercent', rows.cpu_pct,
      'memoryUsedBytes', rows.memory_used_bytes,
      'memoryTotalBytes', rows.memory_total_bytes,
      'pppoeState', rows.pppoe_state,
      'connectionCount', rows.connection_count,
      'arubaCount', rows.aruba_count,
      'openIncidents', rows.open_incidents,
      'activeClients', rows.active_clients,
      'lastBackupAt', rows.last_backup_at,
      'uptimePercent', rows.uptime_pct,
      'mttrSeconds', rows.mttr_seconds,
      'maintenanceActive', rows.maintenance_active
    ) ORDER BY rows.name, rows.id), '[]'::jsonb)
  ) FROM rows;
$fn$;

CREATE OR REPLACE FUNCTION public.network_center_get_building_v1(p_building_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_scope record;
  v_result jsonb;
BEGIN
  SELECT * INTO v_scope FROM app_private.network_center_require_view_v1(p_building_id);

  SELECT jsonb_build_object(
    'buildingId', p_building_id,
    'buildingName', v_scope.building_name,
    'roomsCount', coalesce(building.total_rooms, 0),
    'router', CASE WHEN router.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id', router.id,
      'identity', coalesce(current_state.identity_name, router.display_name),
      'externalKey', router.external_key,
      'model', router.model,
      'firmware', current_state.routeros_version,
      'targetFirmware', router.desired_firmware,
      'lifecycleStatus', router.lifecycle_status,
      'reachable', coalesce(current_state.reachable, false),
      'healthStatus', coalesce(current_state.health_status, 'UNKNOWN'),
      'lastSeenAt', current_state.last_seen_at,
      'cpuPercent', current_state.cpu_pct,
      'memoryUsedBytes', current_state.memory_used_bytes,
      'memoryTotalBytes', current_state.memory_total_bytes,
      'diskUsedBytes', current_state.disk_used_bytes,
      'diskTotalBytes', current_state.disk_total_bytes,
      'temperatureC', current_state.temperature_c,
      'voltageV', current_state.voltage_v,
      'pppoeState', current_state.pppoe_state,
      'connectionCount', current_state.connection_count
    ) END,
    'interfaces', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id', interface.id, 'name', interface.display_name,
        'key', interface.interface_key, 'role', interface.interface_role,
        'protected', interface.is_protected, 'enabled', interface.is_enabled,
        'linkState', interface_state.link_state, 'rxBps', interface_state.rx_bps,
        'txBps', interface_state.tx_bps,
        'utilizationPercent', interface_state.utilization_pct,
        'errors', interface_state.error_count, 'discards', interface_state.discard_count,
        'queueDrops', interface_state.queue_drop_count
      ) ORDER BY interface.sort_order, interface.id)
      FROM public.network_interfaces interface
      LEFT JOIN public.network_interface_current interface_state ON interface_state.interface_id = interface.id
      WHERE interface.organization_id = v_scope.organization_id
        AND interface.building_id = p_building_id
        AND interface.device_id = router.id
    ), '[]'::jsonb),
    'incidents', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id', incident.id, 'title', incident.title, 'detail', incident.summary,
        'severity', incident.severity, 'status', incident.status,
        'openedAt', incident.opened_at, 'acknowledgedAt', incident.acknowledged_at
      ) ORDER BY incident.opened_at DESC, incident.id DESC)
      FROM public.network_incidents incident
      WHERE incident.organization_id = v_scope.organization_id
        AND incident.building_id = p_building_id
        AND incident.status <> 'RESOLVED'
    ), '[]'::jsonb),
    'maintenance', (
      SELECT jsonb_build_object(
        'id', maintenance.id, 'reason', maintenance.reason,
        'startsAt', maintenance.starts_at, 'endsAt', maintenance.ends_at,
        'status', maintenance.status
      )
      FROM public.network_maintenance_windows maintenance
      WHERE maintenance.organization_id = v_scope.organization_id
        AND maintenance.building_id = p_building_id
        AND maintenance.status IN ('SCHEDULED', 'ACTIVE')
      ORDER BY maintenance.starts_at LIMIT 1
    ),
    'revisions', coalesce((
      SELECT jsonb_agg(revision.row ORDER BY revision.created_at DESC, revision.id DESC)
      FROM (
        SELECT snapshot.id, snapshot.created_at,
          jsonb_build_object(
            'id', snapshot.id, 'capturedAt', snapshot.created_at,
            'label', initcap(replace(snapshot.source, '_', ' ')),
            'hash', snapshot.content_hash, 'source', snapshot.source,
            'schemaVersion', snapshot.schema_version
          ) AS row
        FROM public.network_config_snapshots snapshot
        WHERE snapshot.organization_id = v_scope.organization_id
          AND snapshot.building_id = p_building_id
        ORDER BY snapshot.created_at DESC, snapshot.id DESC
        LIMIT 50
      ) revision
    ), '[]'::jsonb),
    'settings', jsonb_build_object(
      'pollingSeconds', settings.poll_interval_seconds,
      'backupHour', to_char(settings.backup_time_local, 'HH24:MI'),
      'alertSensitivity', lower(settings.alert_sensitivity),
      'dependencyGrouping', settings.dependency_grouping,
      'changesPaused', settings.changes_paused,
      'version', settings.version
    )
  ) INTO v_result
  FROM public.buildings building
  LEFT JOIN public.network_devices router
    ON router.organization_id = building.organization_id
   AND router.building_id = building.id
   AND router.device_kind = 'MIKROTIK' AND router.is_active
  LEFT JOIN public.network_device_current current_state ON current_state.device_id = router.id
  LEFT JOIN public.network_site_settings settings
    ON settings.organization_id = building.organization_id AND settings.building_id = building.id
  WHERE building.id = p_building_id;

  RETURN v_result;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.network_center_list_aruba_v1(
  p_building_id uuid,
  p_after_sort_order integer DEFAULT NULL,
  p_after_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 50
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE v_scope record; v_result jsonb;
BEGIN
  IF p_limit NOT BETWEEN 1 AND 100
     OR ((p_after_sort_order IS NULL) <> (p_after_id IS NULL)) THEN
    RAISE EXCEPTION 'Invalid Aruba cursor' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_scope FROM app_private.network_center_require_view_v1(p_building_id);

  WITH page AS (
    SELECT device.id, device.sort_order, device.display_name, device.model,
           device.external_key, device.lifecycle_status,
           current_state.reachable, current_state.health_status, current_state.last_seen_at,
           coalesce(
             (SELECT connection.management_ip::text
                FROM public.network_device_connections connection
               WHERE connection.device_id = device.id AND connection.is_enabled
               ORDER BY connection.id LIMIT 1),
             nullif(device.inventory_metadata->>'managementAddress', '')
           ) AS management_address
    FROM public.network_devices device
    LEFT JOIN public.network_device_current current_state ON current_state.device_id = device.id
    WHERE device.organization_id = v_scope.organization_id
      AND device.building_id = p_building_id
      AND device.device_kind = 'ARUBA'
      AND device.is_active
      AND (p_after_id IS NULL OR ROW(device.sort_order, device.id) > ROW(p_after_sort_order, p_after_id))
    ORDER BY device.sort_order, device.id
    LIMIT p_limit + 1
  ), items AS (
    SELECT * FROM page ORDER BY sort_order, id LIMIT p_limit
  )
  SELECT jsonb_build_object(
    'items', coalesce((SELECT jsonb_agg(jsonb_build_object(
      'id', item.id, 'name', item.display_name, 'model', item.model,
      'externalKey', item.external_key, 'lifecycleStatus', item.lifecycle_status,
      'reachable', coalesce(item.reachable, false), 'healthStatus', item.health_status,
      'lastSeenAt', item.last_seen_at, 'address', item.management_address
    ) ORDER BY item.sort_order, item.id) FROM items item), '[]'::jsonb),
    'nextCursor', CASE WHEN (SELECT count(*) FROM page) > p_limit THEN (
      SELECT jsonb_build_object('sortOrder', item.sort_order, 'id', item.id)
      FROM items item ORDER BY item.sort_order DESC, item.id DESC LIMIT 1
    ) ELSE NULL END
  ) INTO v_result;
  RETURN v_result;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.network_center_list_clients_v1(
  p_building_id uuid,
  p_before_seen_at timestamptz DEFAULT NULL,
  p_before_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 50
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE v_scope record; v_result jsonb;
BEGIN
  IF p_limit NOT BETWEEN 1 AND 100
     OR ((p_before_seen_at IS NULL) <> (p_before_id IS NULL)) THEN
    RAISE EXCEPTION 'Invalid client cursor' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_scope FROM app_private.network_center_require_view_v1(p_building_id);

  WITH page AS (
    SELECT client.*, link.room_id, link.contract_id, link.customer_id,
           room.name AS room_name, customer.full_name AS customer_name
    FROM public.network_client_current client
    LEFT JOIN LATERAL (
      SELECT candidate.room_id, candidate.contract_id, candidate.customer_id
      FROM public.network_client_links candidate
      WHERE candidate.organization_id = client.organization_id
        AND candidate.building_id = client.building_id
        AND candidate.client_fingerprint = client.client_fingerprint
        AND candidate.valid_from <= client.observed_at
        AND (candidate.valid_to IS NULL OR candidate.valid_to > client.observed_at)
      ORDER BY candidate.confidence DESC, candidate.valid_from DESC, candidate.id DESC
      LIMIT 1
    ) link ON true
    LEFT JOIN public.rooms room ON room.id = link.room_id
    LEFT JOIN public.customers customer ON customer.id = link.customer_id
    WHERE client.organization_id = v_scope.organization_id
      AND client.building_id = p_building_id
       AND client.expires_at > statement_timestamp()
      AND (p_before_id IS NULL OR ROW(client.last_seen_at, client.id) < ROW(p_before_seen_at, p_before_id))
    ORDER BY client.last_seen_at DESC, client.id DESC
    LIMIT p_limit + 1
  ), items AS (
    SELECT * FROM page ORDER BY last_seen_at DESC, id DESC LIMIT p_limit
  )
  SELECT jsonb_build_object(
    'items', coalesce((SELECT jsonb_agg(jsonb_build_object(
      'id', item.id, 'hostname', item.hostname, 'address', item.observed_ip::text,
      'macAddress', item.observed_mac::text, 'sessionType', item.session_type,
      'connectionType', item.connection_type, 'roomHint', coalesce(item.room_name, item.room_hint),
      'customerName', item.customer_name, 'roomId', item.room_id,
      'contractId', item.contract_id, 'customerId', item.customer_id,
      'rxBps', item.rx_bps, 'txBps', item.tx_bps,
      'randomizedMac', item.randomized_mac, 'sessionIdentity', item.session_key,
      'lastSeenAt', item.last_seen_at, 'expiresAt', item.expires_at
    ) ORDER BY item.last_seen_at DESC, item.id DESC) FROM items item), '[]'::jsonb),
    'nextCursor', CASE WHEN (SELECT count(*) FROM page) > p_limit THEN (
      SELECT jsonb_build_object('seenAt', item.last_seen_at, 'id', item.id)
      FROM items item ORDER BY item.last_seen_at, item.id LIMIT 1
    ) ELSE NULL END
  ) INTO v_result;
  RETURN v_result;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.network_center_list_commands_v1(
  p_building_id uuid,
  p_before_created_at timestamptz DEFAULT NULL,
  p_before_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 50
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE v_scope record; v_result jsonb;
BEGIN
  IF p_limit NOT BETWEEN 1 AND 100
     OR ((p_before_created_at IS NULL) <> (p_before_id IS NULL)) THEN
    RAISE EXCEPTION 'Invalid command cursor' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_scope FROM app_private.network_center_require_view_v1(p_building_id);
  WITH page AS (
    SELECT command.* FROM public.network_commands command
    WHERE command.organization_id = v_scope.organization_id
      AND command.building_id = p_building_id
      AND (p_before_id IS NULL OR ROW(command.created_at, command.id) < ROW(p_before_created_at, p_before_id))
    ORDER BY command.created_at DESC, command.id DESC LIMIT p_limit + 1
  ), items AS (
    SELECT * FROM page ORDER BY created_at DESC, id DESC LIMIT p_limit
  )
  SELECT jsonb_build_object(
    'items', coalesce((SELECT jsonb_agg(jsonb_build_object(
      'id', item.id, 'actionType', item.action_type, 'reason', item.reason,
      'parameters', item.sanitized_parameters, 'target', item.target_display,
      'requestedBy', item.requested_by, 'status', item.status,
      'attemptCount', item.attempt_count, 'result', item.result,
      'rollback', item.rollback, 'reconciliationState', item.reconciliation_state,
      'createdAt', item.created_at, 'startedAt', item.started_at, 'finishedAt', item.finished_at
    ) ORDER BY item.created_at DESC, item.id DESC) FROM items item), '[]'::jsonb),
    'nextCursor', CASE WHEN (SELECT count(*) FROM page) > p_limit THEN (
      SELECT jsonb_build_object('createdAt', item.created_at, 'id', item.id)
      FROM items item ORDER BY item.created_at, item.id LIMIT 1
    ) ELSE NULL END
  ) INTO v_result;
  RETURN v_result;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.network_center_list_audit_v1(
  p_building_id uuid,
  p_before_occurred_at timestamptz DEFAULT NULL,
  p_before_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 50
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE v_scope record; v_result jsonb;
BEGIN
  IF p_limit NOT BETWEEN 1 AND 100
     OR ((p_before_occurred_at IS NULL) <> (p_before_id IS NULL)) THEN
    RAISE EXCEPTION 'Invalid audit cursor' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_scope FROM app_private.network_center_require_view_v1(p_building_id);
  WITH page AS (
    SELECT audit.* FROM public.network_audit_events audit
    WHERE audit.organization_id = v_scope.organization_id
      AND audit.building_id = p_building_id
      AND (p_before_id IS NULL OR ROW(audit.occurred_at, audit.id) < ROW(p_before_occurred_at, p_before_id))
    ORDER BY audit.occurred_at DESC, audit.id DESC LIMIT p_limit + 1
  ), items AS (
    SELECT * FROM page ORDER BY occurred_at DESC, id DESC LIMIT p_limit
  )
  SELECT jsonb_build_object(
    'items', coalesce((SELECT jsonb_agg(jsonb_build_object(
      'id', item.id, 'at', item.occurred_at, 'actorType', item.actor_type,
      'actorId', item.actor_id, 'workerId', item.worker_id,
      'action', item.action, 'targetType', item.target_type,
      'targetId', item.target_id, 'target', item.target_display,
      'reason', item.reason, 'validation', item.validation,
      'result', item.result, 'outcome', item.outcome, 'commandId', item.command_id
    ) ORDER BY item.occurred_at DESC, item.id DESC) FROM items item), '[]'::jsonb),
    'nextCursor', CASE WHEN (SELECT count(*) FROM page) > p_limit THEN (
      SELECT jsonb_build_object('occurredAt', item.occurred_at, 'id', item.id)
      FROM items item ORDER BY item.occurred_at, item.id LIMIT 1
    ) ELSE NULL END
  ) INTO v_result;
  RETURN v_result;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.network_center_compare_snapshots_v1(
  p_building_id uuid,
  p_from_snapshot_id uuid,
  p_to_snapshot_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE v_scope record; v_from jsonb; v_to jsonb; v_result jsonb;
BEGIN
  SELECT * INTO v_scope FROM app_private.network_center_require_view_v1(p_building_id);
  SELECT snapshot.redacted_lines INTO v_from
  FROM public.network_config_snapshots snapshot
  WHERE snapshot.organization_id = v_scope.organization_id
    AND snapshot.building_id = p_building_id AND snapshot.id = p_from_snapshot_id;
  SELECT snapshot.redacted_lines INTO v_to
  FROM public.network_config_snapshots snapshot
  WHERE snapshot.organization_id = v_scope.organization_id
    AND snapshot.building_id = p_building_id AND snapshot.id = p_to_snapshot_id;
  IF v_from IS NULL OR v_to IS NULL THEN
    RAISE EXCEPTION 'Snapshot not found' USING ERRCODE = 'P0002';
  END IF;

  WITH old_lines AS (
    SELECT ordinality AS line_no, value AS line
    FROM jsonb_array_elements_text(v_from) WITH ORDINALITY
  ), new_lines AS (
    SELECT ordinality AS line_no, value AS line
    FROM jsonb_array_elements_text(v_to) WITH ORDINALITY
  ), diff AS (
    SELECT old_lines.line_no, 0 AS position,
      CASE WHEN old_lines.line IS NOT DISTINCT FROM new_lines.line THEN 'context' ELSE 'removed' END AS kind,
      old_lines.line AS text
    FROM old_lines FULL JOIN new_lines USING (line_no)
    WHERE old_lines.line IS NOT NULL
    UNION ALL
    SELECT new_lines.line_no, 1 AS position, 'added', new_lines.line
    FROM new_lines LEFT JOIN old_lines USING (line_no)
    WHERE new_lines.line IS DISTINCT FROM old_lines.line
  )
  SELECT jsonb_build_object(
    'fromRevisionId', p_from_snapshot_id,
    'toRevisionId', p_to_snapshot_id,
    'changeCount', count(*) FILTER (WHERE kind <> 'context'),
    'lines', coalesce(jsonb_agg(jsonb_build_object('kind', kind, 'text', text)
      ORDER BY line_no, position), '[]'::jsonb)
  ) INTO v_result FROM diff;
  RETURN v_result;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.network_center_ack_incident_v1(
  p_incident_id uuid,
  p_request_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_building_id uuid;
  v_scope record;
  v_incident public.network_incidents%ROWTYPE;
  v_hash text;
  v_replay jsonb;
  v_result jsonb;
BEGIN
  IF p_incident_id IS NULL OR p_request_id IS NULL THEN
    RAISE EXCEPTION 'Incident and request identifiers are required' USING ERRCODE = '22023';
  END IF;
  SELECT incident.building_id INTO v_building_id
  FROM public.network_incidents incident WHERE incident.id = p_incident_id;
  IF v_building_id IS NULL THEN RAISE EXCEPTION 'Incident not found' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO v_scope FROM app_private.network_center_require_execute_v1(v_building_id);
  v_hash := encode(extensions.digest(jsonb_build_object(
    'action', 'ack_incident', 'incidentId', p_incident_id
  )::text, 'sha256'), 'hex');
  v_replay := app_private.network_center_request_replay_v1(
    v_scope.organization_id, v_scope.actor_id, p_request_id, v_hash, 'acknowledge_incident'
  );
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;

  SELECT incident.* INTO v_incident
  FROM public.network_incidents incident
  WHERE incident.organization_id = v_scope.organization_id
    AND incident.building_id = v_building_id AND incident.id = p_incident_id
  FOR UPDATE;
  IF NOT FOUND OR v_incident.status = 'RESOLVED' THEN
    RAISE EXCEPTION 'Active incident not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_incident.acknowledged_at IS NULL THEN
    UPDATE public.network_incidents
    SET status = 'ACKNOWLEDGED', acknowledged_at = clock_timestamp(),
        acknowledged_by = v_scope.actor_id, version = version + 1
    WHERE id = p_incident_id;
    INSERT INTO public.network_incident_events (
      organization_id, building_id, incident_id, event_seq, event_kind,
      severity, occurred_at, actor_id, details
    ) VALUES (
      v_scope.organization_id, v_building_id, p_incident_id,
      coalesce((SELECT max(event.event_seq) + 1 FROM public.network_incident_events event
        WHERE event.incident_id = p_incident_id), 1),
      'ACKNOWLEDGED', v_incident.severity, clock_timestamp(), v_scope.actor_id,
      jsonb_build_object('previousStatus', v_incident.status)
    );
  END IF;

  SELECT jsonb_build_object(
    'incidentId', incident.id, 'status', incident.status,
    'acknowledgedAt', incident.acknowledged_at, 'acknowledgedBy', incident.acknowledged_by
  ) INTO v_result FROM public.network_incidents incident WHERE incident.id = p_incident_id;
  PERFORM app_private.network_center_append_user_audit_v1(
    v_scope.organization_id, v_building_id, v_scope.actor_id,
    'acknowledge_incident', 'incident', p_incident_id,
    jsonb_build_object('buildingName', v_scope.building_name, 'incidentTitle', v_incident.title),
    'Acknowledge network incident', jsonb_build_object('permission', 'network_center.execute'),
    v_result, 'SUCCEEDED', NULL, p_request_id, v_hash
  );
  INSERT INTO public.network_outbox_events (
    organization_id, building_id, event_type, aggregate_type, aggregate_id, payload, occurred_at
  ) VALUES (
    v_scope.organization_id, v_building_id, 'network.incident.acknowledged',
    'incident', p_incident_id, jsonb_build_object('incidentId', p_incident_id), clock_timestamp()
  );
  RETURN v_result;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.network_center_create_maintenance_v1(
  p_building_id uuid,
  p_duration_minutes integer,
  p_reason text,
  p_request_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_scope record;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_hash text;
  v_existing public.network_maintenance_windows%ROWTYPE;
  v_window public.network_maintenance_windows%ROWTYPE;
  v_result jsonb;
BEGIN
  IF p_request_id IS NULL OR p_duration_minutes NOT BETWEEN 5 AND 480
     OR char_length(v_reason) NOT BETWEEN 8 AND 1000 THEN
    RAISE EXCEPTION 'Invalid maintenance request' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_scope FROM app_private.network_center_require_execute_v1(p_building_id);
  v_hash := encode(extensions.digest(jsonb_build_object(
    'action', 'create_maintenance', 'buildingId', p_building_id,
    'durationMinutes', p_duration_minutes, 'reason', v_reason
  )::text, 'sha256'), 'hex');

  SELECT maintenance.* INTO v_existing
  FROM public.network_maintenance_windows maintenance
  WHERE maintenance.organization_id = v_scope.organization_id
    AND maintenance.created_by = v_scope.actor_id
    AND maintenance.idempotency_key = p_request_id::text
  FOR UPDATE;
  IF FOUND THEN
    IF v_existing.request_hash IS DISTINCT FROM v_hash THEN
      RAISE EXCEPTION 'Idempotency key reused with different maintenance input' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'id', v_existing.id, 'reason', v_existing.reason,
      'startsAt', v_existing.starts_at, 'endsAt', v_existing.ends_at,
      'status', v_existing.status
    );
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.network_maintenance_windows maintenance
    WHERE maintenance.organization_id = v_scope.organization_id
      AND maintenance.building_id = p_building_id
      AND maintenance.status IN ('SCHEDULED', 'ACTIVE')
      AND maintenance.ends_at > clock_timestamp()
  ) THEN
    RAISE EXCEPTION 'A maintenance window is already active for this building'
      USING ERRCODE = '55000';
  END IF;

  INSERT INTO public.network_maintenance_windows (
    organization_id, building_id, status, starts_at, ends_at, reason,
    created_by, request_hash, idempotency_key
  ) VALUES (
    v_scope.organization_id, p_building_id, 'ACTIVE', clock_timestamp(),
    clock_timestamp() + make_interval(mins => p_duration_minutes), v_reason,
    v_scope.actor_id, v_hash, p_request_id::text
  ) RETURNING * INTO v_window;
  v_result := jsonb_build_object(
    'id', v_window.id, 'reason', v_window.reason,
    'startsAt', v_window.starts_at, 'endsAt', v_window.ends_at,
    'status', v_window.status
  );
  PERFORM app_private.network_center_append_user_audit_v1(
    v_scope.organization_id, p_building_id, v_scope.actor_id,
    'create_maintenance', 'maintenance', v_window.id,
    jsonb_build_object('buildingName', v_scope.building_name), v_reason,
    jsonb_build_object('durationMinutes', p_duration_minutes), v_result,
    'SUCCEEDED', NULL, p_request_id, v_hash
  );
  INSERT INTO public.network_outbox_events (
    organization_id, building_id, event_type, aggregate_type, aggregate_id, payload, occurred_at
  ) VALUES (
    v_scope.organization_id, p_building_id, 'network.maintenance.started',
    'maintenance', v_window.id, jsonb_build_object('endsAt', v_window.ends_at), clock_timestamp()
  );
  RETURN v_result;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.network_center_cancel_maintenance_v1(
  p_building_id uuid,
  p_maintenance_id uuid,
  p_request_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_scope record;
  v_window public.network_maintenance_windows%ROWTYPE;
  v_hash text;
  v_replay jsonb;
  v_result jsonb;
BEGIN
  IF p_maintenance_id IS NULL OR p_request_id IS NULL THEN
    RAISE EXCEPTION 'Maintenance and request identifiers are required' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_scope FROM app_private.network_center_require_execute_v1(p_building_id);
  v_hash := encode(extensions.digest(jsonb_build_object(
    'action', 'cancel_maintenance', 'buildingId', p_building_id,
    'maintenanceId', p_maintenance_id
  )::text, 'sha256'), 'hex');
  v_replay := app_private.network_center_request_replay_v1(
    v_scope.organization_id, v_scope.actor_id, p_request_id, v_hash, 'cancel_maintenance'
  );
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;

  SELECT maintenance.* INTO v_window
  FROM public.network_maintenance_windows maintenance
  WHERE maintenance.organization_id = v_scope.organization_id
    AND maintenance.building_id = p_building_id AND maintenance.id = p_maintenance_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Maintenance window not found' USING ERRCODE = 'P0002'; END IF;
  IF v_window.status NOT IN ('CANCELLED', 'COMPLETED') THEN
    UPDATE public.network_maintenance_windows
    SET status = 'CANCELLED', cancelled_at = clock_timestamp(),
        cancelled_by = v_scope.actor_id,
        cancellation_reason = 'Cancelled from Network Center', version = version + 1
    WHERE id = p_maintenance_id;
  END IF;
  SELECT jsonb_build_object(
    'id', maintenance.id, 'status', maintenance.status,
    'cancelledAt', maintenance.cancelled_at
  ) INTO v_result FROM public.network_maintenance_windows maintenance
  WHERE maintenance.id = p_maintenance_id;
  PERFORM app_private.network_center_append_user_audit_v1(
    v_scope.organization_id, p_building_id, v_scope.actor_id,
    'cancel_maintenance', 'maintenance', p_maintenance_id,
    jsonb_build_object('buildingName', v_scope.building_name),
    'Cancel maintenance window', '{}'::jsonb, v_result,
    'SUCCEEDED', NULL, p_request_id, v_hash
  );
  RETURN v_result;
END;
$fn$;

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
  IF p_device_id IS NULL OR p_request_id IS NULL OR char_length(v_label) NOT BETWEEN 3 AND 160 THEN
    RAISE EXCEPTION 'Invalid snapshot request' USING ERRCODE = '22023';
  END IF;
  SELECT device.* INTO v_device
  FROM public.network_devices device
  WHERE device.id = p_device_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Active MikroTik not found' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO v_scope FROM app_private.network_center_require_execute_v1(v_device.building_id);
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
  IF NOT FOUND THEN RAISE EXCEPTION 'Active MikroTik not found' USING ERRCODE = 'P0002'; END IF;
  v_hash := encode(extensions.digest(jsonb_build_object(
    'action', 'request_snapshot', 'deviceId', p_device_id, 'label', v_label
  )::text, 'sha256'), 'hex');
  v_replay := app_private.network_center_request_replay_v1(
    v_scope.organization_id, v_scope.actor_id, p_request_id, v_hash, 'capture_configuration'
  );
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  v_target := jsonb_build_object(
    'buildingId', v_device.building_id, 'buildingName', v_scope.building_name,
    'deviceId', v_device.id, 'routerIdentity', v_device.display_name
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
  v_result := jsonb_build_object('commandId', v_command_id, 'status', 'QUEUED', 'label', v_label);
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
     OR v_action NOT IN ('FLUSH_DNS_CACHE', 'RENEW_DHCP_LEASE', 'CYCLE_ACCESS_PORT', 'REBOOT_ROUTER')
     OR char_length(v_reason) NOT BETWEEN 8 AND 1000
     OR jsonb_typeof(v_parameters) <> 'object'
     OR octet_length(v_parameters::text) > 16384 THEN
    RAISE EXCEPTION 'Invalid Network Center action request' USING ERRCODE = '22023';
  END IF;
  SELECT device.* INTO v_device
  FROM public.network_devices device
  WHERE device.id = p_device_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Writable MikroTik not found' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO v_scope FROM app_private.network_center_require_execute_v1(v_device.building_id);
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
  IF NOT FOUND THEN RAISE EXCEPTION 'Writable MikroTik not found' USING ERRCODE = 'P0002'; END IF;
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
  SELECT coalesce(current_state.identity_name, v_device.display_name) INTO v_identity
  FROM public.network_device_current current_state WHERE current_state.device_id = v_device.id;
  v_identity := coalesce(v_identity, v_device.display_name);

  IF v_action IN ('CYCLE_ACCESS_PORT', 'REBOOT_ROUTER')
     AND p_confirmation IS DISTINCT FROM v_identity THEN
    RAISE EXCEPTION 'Router confirmation does not match the current identity'
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
      RAISE EXCEPTION 'Access-port cycle must be between 5 and 30 seconds' USING ERRCODE = '22023';
    END IF;
    SELECT interface.* INTO v_interface
    FROM public.network_interfaces interface
    WHERE interface.organization_id = v_scope.organization_id
      AND interface.building_id = v_device.building_id
      AND interface.device_id = v_device.id AND interface.id = v_interface_id
      AND interface.interface_role = 'ACCESS' AND NOT interface.is_protected
      AND interface.is_enabled
    FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Access port is invalid or protected' USING ERRCODE = '22023'; END IF;
    v_sanitized := jsonb_build_object('durationSeconds', v_duration);
  ELSIF v_parameters <> '{}'::jsonb THEN
    RAISE EXCEPTION 'This action does not accept parameters' USING ERRCODE = '22023';
  END IF;

  v_hash := encode(extensions.digest(jsonb_build_object(
    'action', v_action, 'deviceId', p_device_id, 'interfaceId', v_interface_id,
    'reason', v_reason, 'parameters', v_sanitized
  )::text, 'sha256'), 'hex');
  v_replay := app_private.network_center_request_replay_v1(
    v_scope.organization_id, v_scope.actor_id, p_request_id, v_hash, lower(v_action)
  );
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  v_target := jsonb_build_object(
    'buildingId', v_device.building_id, 'buildingName', v_scope.building_name,
    'deviceId', v_device.id, 'routerIdentity', v_identity,
    'interfaceId', v_interface_id, 'interfaceName', v_interface.display_name
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
    clock_timestamp(), v_scope.actor_id, jsonb_build_object('actionType', v_action)
  ) ON CONFLICT (command_id, event_seq) DO NOTHING;
  v_result := jsonb_build_object(
    'commandId', v_command_id, 'status', 'QUEUED', 'actionType', v_action,
    'reason', v_reason, 'parameters', v_sanitized, 'target', v_target
  );
  PERFORM app_private.network_center_append_user_audit_v1(
    v_scope.organization_id, v_device.building_id, v_scope.actor_id,
    lower(v_action), 'device', v_device.id, v_target, v_reason,
    jsonb_build_object('permission', 'network_center.execute', 'confirmationValidated', true),
    v_result, 'ACCEPTED', v_command_id, p_request_id, v_hash
  );
  INSERT INTO public.network_outbox_events (
    organization_id, building_id, event_type, aggregate_type, aggregate_id, payload, occurred_at
  ) VALUES (
    v_scope.organization_id, v_device.building_id, 'network.command.queued',
    'command', v_command_id, jsonb_build_object('actionType', v_action), clock_timestamp()
  );
  RETURN v_result;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.network_center_update_settings_v1(
  p_building_id uuid,
  p_settings jsonb,
  p_expected_version bigint,
  p_request_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_scope record;
  v_current public.network_site_settings%ROWTYPE;
  v_hash text;
  v_replay jsonb;
  v_result jsonb;
  v_poll integer;
  v_backup text;
  v_alert text;
BEGIN
  IF p_request_id IS NULL OR p_expected_version IS NULL OR p_expected_version < 1
     OR p_settings IS NULL OR jsonb_typeof(p_settings) <> 'object'
     OR octet_length(p_settings::text) > 16384
     OR EXISTS (
       SELECT 1 FROM jsonb_object_keys(p_settings) key
       WHERE key NOT IN ('pollingSeconds', 'backupHour', 'alertSensitivity', 'dependencyGrouping', 'changesPaused')
     ) THEN
    RAISE EXCEPTION 'Invalid Network Center settings request' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_scope FROM app_private.network_center_require_execute_v1(p_building_id);
  SELECT settings.* INTO v_current
  FROM public.network_site_settings settings
  WHERE settings.organization_id = v_scope.organization_id AND settings.building_id = p_building_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Network settings not found' USING ERRCODE = 'P0002'; END IF;

  IF p_settings ? 'pollingSeconds' THEN
    IF (p_settings->>'pollingSeconds') !~ '^[0-9]+$' THEN
      RAISE EXCEPTION 'Polling seconds must be an integer' USING ERRCODE = '22023';
    END IF;
    v_poll := (p_settings->>'pollingSeconds')::integer;
    IF v_poll NOT BETWEEN 30 AND 300 THEN
      RAISE EXCEPTION 'Polling seconds must be between 30 and 300' USING ERRCODE = '22023';
    END IF;
  END IF;
  IF p_settings ? 'backupHour' THEN
    v_backup := p_settings->>'backupHour';
    IF v_backup !~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$' THEN
      RAISE EXCEPTION 'Backup hour must use HH:MM' USING ERRCODE = '22023';
    END IF;
  END IF;
  IF p_settings ? 'alertSensitivity' THEN
    v_alert := upper(p_settings->>'alertSensitivity');
    IF v_alert NOT IN ('STANDARD', 'STRICT') THEN
      RAISE EXCEPTION 'Invalid alert sensitivity' USING ERRCODE = '22023';
    END IF;
  END IF;
  IF (p_settings ? 'dependencyGrouping' AND jsonb_typeof(p_settings->'dependencyGrouping') <> 'boolean')
     OR (p_settings ? 'changesPaused' AND jsonb_typeof(p_settings->'changesPaused') <> 'boolean') THEN
    RAISE EXCEPTION 'Invalid boolean Network Center setting' USING ERRCODE = '22023';
  END IF;

  v_hash := encode(extensions.digest(jsonb_build_object(
    'action', 'update_settings', 'buildingId', p_building_id,
    'expectedVersion', p_expected_version, 'settings', p_settings
  )::text, 'sha256'), 'hex');
  v_replay := app_private.network_center_request_replay_v1(
    v_scope.organization_id, v_scope.actor_id, p_request_id, v_hash, 'update_settings'
  );
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  IF v_current.version <> p_expected_version THEN
    RAISE EXCEPTION 'Network settings changed; reload before saving' USING ERRCODE = '40001';
  END IF;

  UPDATE public.network_site_settings settings
  SET poll_interval_seconds = coalesce(v_poll, settings.poll_interval_seconds),
      backup_time_local = coalesce(v_backup::time, settings.backup_time_local),
      alert_sensitivity = coalesce(v_alert, settings.alert_sensitivity),
      dependency_grouping = CASE WHEN p_settings ? 'dependencyGrouping'
        THEN (p_settings->>'dependencyGrouping')::boolean ELSE settings.dependency_grouping END,
      changes_paused = CASE WHEN p_settings ? 'changesPaused'
        THEN (p_settings->>'changesPaused')::boolean ELSE settings.changes_paused END,
      version = settings.version + 1
  WHERE settings.id = v_current.id
  RETURNING jsonb_build_object(
    'pollingSeconds', settings.poll_interval_seconds,
    'backupHour', to_char(settings.backup_time_local, 'HH24:MI'),
    'alertSensitivity', lower(settings.alert_sensitivity),
    'dependencyGrouping', settings.dependency_grouping,
    'changesPaused', settings.changes_paused,
    'version', settings.version
  ) INTO v_result;
  PERFORM app_private.network_center_append_user_audit_v1(
    v_scope.organization_id, p_building_id, v_scope.actor_id,
    'update_settings', 'building', p_building_id,
    jsonb_build_object('buildingName', v_scope.building_name),
    'Update Network Center settings', jsonb_build_object('expectedVersion', p_expected_version),
    v_result, 'SUCCEEDED', NULL, p_request_id, v_hash
  );
  RETURN v_result;
END;
$fn$;

CREATE OR REPLACE FUNCTION app_private.network_center_claim_reconciliation_v1(
  p_worker_id text,
  p_limit integer DEFAULT 5,
  p_lease_seconds integer DEFAULT 90
)
RETURNS TABLE (
  command_id uuid,
  organization_id uuid,
  building_id uuid,
  device_id uuid,
  interface_id uuid,
  action_type text,
  reason text,
  sanitized_parameters jsonb,
  attempt_no integer,
  lease_token uuid,
  lease_expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE v_now timestamptz := clock_timestamp();
BEGIN
  IF p_worker_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$'
     OR p_limit NOT BETWEEN 1 AND 20 OR p_lease_seconds NOT BETWEEN 15 AND 300 THEN
    RAISE EXCEPTION 'Invalid reconciliation claim request' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  WITH candidates AS MATERIALIZED (
    SELECT command.*, gen_random_uuid() AS new_token
    FROM public.network_commands command
    WHERE command.status = 'UNCERTAIN'
      AND command.reconciliation_state = 'REQUIRED'
      AND NOT EXISTS (
        SELECT 1 FROM public.network_device_leases lease
        WHERE lease.device_id = command.device_id AND lease.expires_at > v_now
      )
    ORDER BY command.updated_at, command.id
    FOR UPDATE SKIP LOCKED LIMIT p_limit
  ), leases AS (
    INSERT INTO public.network_device_leases (
      device_id, organization_id, building_id, command_id, lease_token,
      lease_owner, acquired_at, heartbeat_at, expires_at, generation
    )
    SELECT candidate.device_id, candidate.organization_id, candidate.building_id,
      candidate.id, candidate.new_token, p_worker_id, v_now, v_now,
      v_now + make_interval(secs => p_lease_seconds), 1
    FROM candidates candidate
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
    RETURNING public.network_device_leases.*
  ), claimed AS (
    UPDATE public.network_commands command
    SET status = 'RECONCILING', reconciliation_state = 'IN_PROGRESS',
        lease_token = lease.lease_token, lease_owner = p_worker_id,
        lease_expires_at = lease.expires_at, updated_at = v_now
    FROM leases lease WHERE command.id = lease.command_id
    RETURNING command.*
  ), events AS (
    INSERT INTO public.network_command_events (
      organization_id, building_id, command_id, attempt_id, event_seq,
      event_kind, occurred_at, worker_id, payload
    )
    SELECT claimed.organization_id, claimed.building_id, claimed.id,
      (SELECT attempt.id FROM public.network_command_attempts attempt
       WHERE attempt.command_id = claimed.id ORDER BY attempt.attempt_no DESC LIMIT 1),
      coalesce((SELECT max(event.event_seq) + 1 FROM public.network_command_events event
        WHERE event.command_id = claimed.id), 1),
      'RECONCILIATION_STARTED', v_now, p_worker_id,
      jsonb_build_object('leaseExpiresAt', claimed.lease_expires_at)
    FROM claimed RETURNING command_id
  )
  SELECT claimed.id, claimed.organization_id, claimed.building_id,
    claimed.device_id, claimed.interface_id, claimed.action_type, claimed.reason,
    claimed.sanitized_parameters, claimed.attempt_count,
    claimed.lease_token, claimed.lease_expires_at
  FROM claimed JOIN events ON events.command_id = claimed.id;
END;
$fn$;

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
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE v_now timestamptz := clock_timestamp(); v_row public.network_worker_heartbeats%ROWTYPE;
BEGIN
  p_worker_id := btrim(coalesce(p_worker_id, ''));
  p_worker_version := btrim(coalesce(p_worker_version, ''));
  p_status := upper(btrim(coalesce(p_status, '')));
  p_safe_metadata := coalesce(p_safe_metadata, '{}'::jsonb);
  IF p_worker_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$'
     OR char_length(p_worker_version) NOT BETWEEN 1 AND 100
     OR p_status NOT IN ('ONLINE', 'DEGRADED', 'PAUSED', 'STOPPING')
     OR p_queue_age_seconds NOT BETWEEN 0 AND 31536000
     OR cardinality(coalesce(p_capabilities, ARRAY[]::text[])) > 32
     OR jsonb_typeof(p_safe_metadata) <> 'object'
     OR octet_length(p_safe_metadata::text) > 16384
     OR p_started_at IS NULL OR p_started_at > v_now THEN
    RAISE EXCEPTION 'Invalid worker heartbeat' USING ERRCODE = '22023';
  END IF;
  PERFORM app_private.network_center_assert_safe_json_v1(
    p_safe_metadata, 'worker heartbeat metadata'
  );
  INSERT INTO public.network_worker_heartbeats (
    worker_id, worker_version, capabilities, status, heartbeat_at,
    queue_age_seconds, safe_metadata, started_at
  ) VALUES (
    p_worker_id, p_worker_version, coalesce(p_capabilities, ARRAY[]::text[]),
    p_status, v_now, p_queue_age_seconds, p_safe_metadata, p_started_at
  ) ON CONFLICT (worker_id) DO UPDATE SET
    worker_version = EXCLUDED.worker_version,
    capabilities = EXCLUDED.capabilities,
    status = EXCLUDED.status,
    heartbeat_at = EXCLUDED.heartbeat_at,
    queue_age_seconds = EXCLUDED.queue_age_seconds,
    safe_metadata = EXCLUDED.safe_metadata,
    started_at = LEAST(public.network_worker_heartbeats.started_at, EXCLUDED.started_at)
  RETURNING * INTO v_row;
  RETURN jsonb_build_object(
    'workerId', v_row.worker_id, 'status', v_row.status,
    'heartbeatAt', v_row.heartbeat_at, 'queueAgeSeconds', v_row.queue_age_seconds
  );
END;
$fn$;

CREATE OR REPLACE FUNCTION public.network_center_worker_list_connections_v1(
  p_worker_id text,
  p_limit integer DEFAULT 100
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE v_result jsonb;
BEGIN
  IF p_worker_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$'
     OR p_limit NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'Invalid worker connection request' USING ERRCODE = '22023';
  END IF;
  SELECT jsonb_build_object('items', coalesce(jsonb_agg(row.item ORDER BY row.building_id, row.device_id), '[]'::jsonb))
  INTO v_result FROM (
    SELECT connection.building_id, connection.device_id,
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
        'pollIntervalSeconds', coalesce(settings.poll_interval_seconds, connection.poll_interval_seconds),
        'connectTimeoutMs', connection.connect_timeout_ms,
        'monitoringEnabled', coalesce(settings.monitoring_enabled, true),
        'changesPaused', coalesce(settings.changes_paused, false)
      ) AS item
    FROM public.network_device_connections connection
    JOIN public.network_devices device
      ON device.organization_id = connection.organization_id
     AND device.building_id = connection.building_id AND device.id = connection.device_id
    LEFT JOIN public.network_site_settings settings
      ON settings.organization_id = connection.organization_id
     AND settings.building_id = connection.building_id
    WHERE connection.is_enabled AND device.is_active
    ORDER BY connection.building_id, connection.device_id, connection.id
    LIMIT p_limit
  ) row;
  RETURN v_result;
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
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE v_regular jsonb; v_reconcile jsonb;
BEGIN
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'commandId', claim.command_id, 'organizationId', claim.organization_id,
    'buildingId', claim.building_id, 'deviceId', claim.device_id,
    'interfaceId', claim.interface_id, 'actionType', claim.action_type,
    'reason', claim.reason, 'parameters', claim.sanitized_parameters,
    'attemptNo', claim.attempt_no, 'leaseToken', claim.lease_token,
    'leaseExpiresAt', claim.lease_expires_at, 'reconciliation', false
  )), '[]'::jsonb) INTO v_regular
  FROM app_private.network_center_claim_commands_v1(p_worker_id, p_limit, p_lease_seconds) claim;

  IF jsonb_array_length(v_regular) < p_limit THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'commandId', claim.command_id, 'organizationId', claim.organization_id,
      'buildingId', claim.building_id, 'deviceId', claim.device_id,
      'interfaceId', claim.interface_id, 'actionType', claim.action_type,
      'reason', claim.reason, 'parameters', claim.sanitized_parameters,
      'attemptNo', claim.attempt_no, 'leaseToken', claim.lease_token,
      'leaseExpiresAt', claim.lease_expires_at, 'reconciliation', true
    )), '[]'::jsonb) INTO v_reconcile
    FROM app_private.network_center_claim_reconciliation_v1(
      p_worker_id, p_limit - jsonb_array_length(v_regular), p_lease_seconds
    ) claim;
  ELSE
    v_reconcile := '[]'::jsonb;
  END IF;
  RETURN jsonb_build_object('items', v_regular || coalesce(v_reconcile, '[]'::jsonb));
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
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE v_now timestamptz := clock_timestamp(); v_expiry timestamptz;
BEGIN
  IF p_worker_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$'
     OR p_command_id IS NULL OR p_lease_token IS NULL
     OR p_lease_seconds NOT BETWEEN 15 AND 300 THEN
    RAISE EXCEPTION 'Invalid lease renewal request' USING ERRCODE = '22023';
  END IF;
  v_expiry := v_now + make_interval(secs => p_lease_seconds);
  UPDATE public.network_device_leases lease
  SET heartbeat_at = v_now, expires_at = v_expiry
  WHERE lease.command_id = p_command_id AND lease.lease_token = p_lease_token
    AND lease.lease_owner = p_worker_id AND lease.expires_at > v_now;
  IF NOT FOUND THEN RAISE EXCEPTION 'Active device lease not found' USING ERRCODE = '55000'; END IF;
  UPDATE public.network_commands command
  SET lease_expires_at = v_expiry, updated_at = v_now
  WHERE command.id = p_command_id AND command.lease_token = p_lease_token
    AND command.lease_owner = p_worker_id
    AND command.status IN ('LEASED', 'RUNNING', 'RECONCILING');
  IF NOT FOUND THEN RAISE EXCEPTION 'Active command lease not found' USING ERRCODE = '55000'; END IF;
  RETURN jsonb_build_object('commandId', p_command_id, 'leaseExpiresAt', v_expiry);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.network_center_worker_ingest_v1(
  p_worker_id text,
  p_payload jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_observed_at timestamptz;
  v_devices integer := 0;
  v_interfaces integer := 0;
  v_clients integer := 0;
BEGIN
  IF p_worker_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$'
     OR p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object'
     OR octet_length(p_payload::text) > 524288
     OR jsonb_typeof(coalesce(p_payload->'devices', '[]'::jsonb)) <> 'array'
     OR jsonb_typeof(coalesce(p_payload->'interfaces', '[]'::jsonb)) <> 'array'
     OR jsonb_typeof(coalesce(p_payload->'clients', '[]'::jsonb)) <> 'array'
     OR jsonb_array_length(coalesce(p_payload->'devices', '[]'::jsonb)) > 256
     OR jsonb_array_length(coalesce(p_payload->'interfaces', '[]'::jsonb)) > 256
     OR jsonb_array_length(coalesce(p_payload->'clients', '[]'::jsonb)) > 256 THEN
    RAISE EXCEPTION 'Invalid or oversized telemetry payload' USING ERRCODE = '22023';
  END IF;
  v_observed_at := nullif(p_payload->>'observedAt', '')::timestamptz;
  IF v_observed_at IS NULL
     OR abs(extract(epoch FROM (v_now - v_observed_at))) > 600 THEN
    RAISE EXCEPTION 'Telemetry timestamp is outside the accepted window' USING ERRCODE = '22023';
  END IF;
  PERFORM app_private.network_center_ensure_raw_partitions_v1(
    v_observed_at::date - 1, v_observed_at::date + 2
  );

  WITH input AS (
    SELECT * FROM jsonb_to_recordset(coalesce(p_payload->'devices', '[]'::jsonb)) AS row(
      "deviceId" uuid, "lastSeenAt" timestamptz, reachable boolean,
      "healthStatus" text, identity text, "routerosVersion" text,
      "uptimeSeconds" bigint, "cpuPct" numeric, "memoryUsedBytes" bigint,
      "memoryTotalBytes" bigint, "diskUsedBytes" bigint, "diskTotalBytes" bigint,
      "temperatureC" numeric, "voltageV" numeric, "pppoeState" text,
      "connectionCount" integer, "latencyMs" numeric, "packetLossPct" numeric,
      "lastErrorCode" text
    )
  ), valid AS (
    SELECT input.*, device.organization_id, device.building_id
    FROM input JOIN public.network_devices device ON device.id = input."deviceId"
    WHERE device.is_active
  ), upserted AS (
    INSERT INTO public.network_device_current (
      device_id, organization_id, building_id, observed_at, last_seen_at,
      reachable, health_status, identity_name, routeros_version, uptime_seconds,
      cpu_pct, memory_used_bytes, memory_total_bytes, disk_used_bytes,
      disk_total_bytes, temperature_c, voltage_v, pppoe_state, connection_count,
      latency_ms, packet_loss_pct, last_error_code, update_seq
    )
    SELECT "deviceId", organization_id, building_id, v_observed_at,
      coalesce("lastSeenAt", CASE WHEN reachable THEN v_observed_at ELSE NULL END),
      coalesce(reachable, false), coalesce("healthStatus", 'UNKNOWN'), identity,
      "routerosVersion", "uptimeSeconds", "cpuPct", "memoryUsedBytes",
      "memoryTotalBytes", "diskUsedBytes", "diskTotalBytes", "temperatureC",
      "voltageV", coalesce("pppoeState", 'UNKNOWN'), "connectionCount",
      "latencyMs", "packetLossPct", "lastErrorCode", 1
    FROM valid
    ON CONFLICT (device_id) DO UPDATE SET
      organization_id = EXCLUDED.organization_id,
      building_id = EXCLUDED.building_id,
      observed_at = EXCLUDED.observed_at,
      last_seen_at = GREATEST(
        public.network_device_current.last_seen_at,
        EXCLUDED.last_seen_at
      ),
      reachable = EXCLUDED.reachable,
      health_status = EXCLUDED.health_status,
      identity_name = EXCLUDED.identity_name,
      routeros_version = EXCLUDED.routeros_version,
      uptime_seconds = EXCLUDED.uptime_seconds,
      cpu_pct = EXCLUDED.cpu_pct,
      memory_used_bytes = EXCLUDED.memory_used_bytes,
      memory_total_bytes = EXCLUDED.memory_total_bytes,
      disk_used_bytes = EXCLUDED.disk_used_bytes,
      disk_total_bytes = EXCLUDED.disk_total_bytes,
      temperature_c = EXCLUDED.temperature_c,
      voltage_v = EXCLUDED.voltage_v,
      pppoe_state = EXCLUDED.pppoe_state,
      connection_count = EXCLUDED.connection_count,
      latency_ms = EXCLUDED.latency_ms,
      packet_loss_pct = EXCLUDED.packet_loss_pct,
      last_error_code = EXCLUDED.last_error_code,
      update_seq = public.network_device_current.update_seq + 1
    WHERE EXCLUDED.observed_at >= public.network_device_current.observed_at
    RETURNING device_id
  ), sampled AS (
    INSERT INTO public.network_device_samples (
      organization_id, building_id, device_id, observed_at, reachable,
      latency_ms, packet_loss_pct, cpu_pct, memory_used_pct, temperature_c,
      voltage_v, connection_count, sample
    )
    SELECT organization_id, building_id, "deviceId", v_observed_at,
      coalesce(reachable, false), "latencyMs", "packetLossPct", "cpuPct",
      CASE WHEN "memoryTotalBytes" > 0
        THEN round(("memoryUsedBytes"::numeric / "memoryTotalBytes") * 100, 2) END,
      "temperatureC", "voltageV", "connectionCount",
      jsonb_strip_nulls(jsonb_build_object(
        'routerosVersion', "routerosVersion", 'uptimeSeconds', "uptimeSeconds",
        'diskUsedBytes', "diskUsedBytes", 'diskTotalBytes', "diskTotalBytes",
        'pppoeState', "pppoeState"
      ))
    FROM valid ON CONFLICT (device_id, observed_at) DO NOTHING
    RETURNING device_id
  )
  SELECT count(*) INTO v_devices FROM upserted;

  WITH input AS (
    SELECT * FROM jsonb_to_recordset(coalesce(p_payload->'interfaces', '[]'::jsonb)) AS row(
      "interfaceId" uuid, "linkState" text, "rxBps" numeric, "txBps" numeric,
      "utilizationPct" numeric, "rxBytes" bigint, "txBytes" bigint,
      "errorCount" bigint, "discardCount" bigint, "queueDropCount" bigint,
      "errorDelta" bigint, "discardDelta" bigint, "queueDropDelta" bigint
    )
  ), valid AS (
    SELECT input.*, interface.organization_id, interface.building_id, interface.device_id
    FROM input JOIN public.network_interfaces interface ON interface.id = input."interfaceId"
  ), upserted AS (
    INSERT INTO public.network_interface_current (
      interface_id, organization_id, building_id, device_id, observed_at,
      link_state, rx_bps, tx_bps, utilization_pct, rx_bytes, tx_bytes,
      error_count, discard_count, queue_drop_count, update_seq
    )
    SELECT "interfaceId", organization_id, building_id, device_id, v_observed_at,
      coalesce("linkState", 'UNKNOWN'), "rxBps", "txBps", "utilizationPct",
      "rxBytes", "txBytes", "errorCount", "discardCount", "queueDropCount", 1
    FROM valid
    ON CONFLICT (interface_id) DO UPDATE SET
      organization_id = EXCLUDED.organization_id,
      building_id = EXCLUDED.building_id,
      device_id = EXCLUDED.device_id,
      observed_at = EXCLUDED.observed_at,
      link_state = EXCLUDED.link_state,
      rx_bps = EXCLUDED.rx_bps,
      tx_bps = EXCLUDED.tx_bps,
      utilization_pct = EXCLUDED.utilization_pct,
      rx_bytes = EXCLUDED.rx_bytes,
      tx_bytes = EXCLUDED.tx_bytes,
      error_count = EXCLUDED.error_count,
      discard_count = EXCLUDED.discard_count,
      queue_drop_count = EXCLUDED.queue_drop_count,
      update_seq = public.network_interface_current.update_seq + 1
    WHERE EXCLUDED.observed_at >= public.network_interface_current.observed_at
    RETURNING interface_id
  ), sampled AS (
    INSERT INTO public.network_interface_samples (
      organization_id, building_id, device_id, interface_id, observed_at,
      link_up, rx_bps, tx_bps, utilization_pct, error_delta, discard_delta,
      queue_drop_delta, sample
    )
    SELECT organization_id, building_id, device_id, "interfaceId", v_observed_at,
      coalesce("linkState", 'UNKNOWN') = 'UP', "rxBps", "txBps", "utilizationPct",
      "errorDelta", "discardDelta", "queueDropDelta", '{}'::jsonb
    FROM valid ON CONFLICT (interface_id, observed_at) DO NOTHING
    RETURNING interface_id
  )
  SELECT count(*) INTO v_interfaces FROM upserted;

  WITH input AS (
    SELECT * FROM jsonb_to_recordset(coalesce(p_payload->'clients', '[]'::jsonb)) AS row(
      "deviceId" uuid, "interfaceId" uuid, "sessionKey" text,
      "clientFingerprint" text, "observedMac" macaddr, "observedIp" inet,
      hostname text, "connectionType" text, "sessionType" text, "roomHint" text,
      "signalDbm" integer, "rxBytes" bigint, "txBytes" bigint,
      "rxBps" numeric, "txBps" numeric, "firstSeenAt" timestamptz,
      "lastSeenAt" timestamptz, "expiresAt" timestamptz, "randomizedMac" boolean
    )
  ), valid AS (
    SELECT input.*, device.organization_id, device.building_id
    FROM input JOIN public.network_devices device ON device.id = input."deviceId"
    LEFT JOIN public.network_interfaces interface
      ON interface.id = input."interfaceId" AND interface.device_id = device.id
    WHERE input."interfaceId" IS NULL OR interface.id IS NOT NULL
  ), upserted AS (
    INSERT INTO public.network_client_current (
      organization_id, building_id, device_id, interface_id, session_key,
      client_fingerprint, observed_mac, observed_ip, hostname, connection_type,
      session_type, room_hint, signal_dbm, rx_bytes, tx_bytes, rx_bps, tx_bps,
      first_seen_at, last_seen_at, observed_at, expires_at, randomized_mac, update_seq
    )
    SELECT organization_id, building_id, "deviceId", "interfaceId", "sessionKey",
      "clientFingerprint", "observedMac", "observedIp", hostname,
      coalesce("connectionType", 'UNKNOWN'), coalesce("sessionType", 'UNKNOWN'),
      "roomHint", "signalDbm", coalesce("rxBytes", 0), coalesce("txBytes", 0),
      "rxBps", "txBps", coalesce("firstSeenAt", v_observed_at),
      coalesce("lastSeenAt", v_observed_at), v_observed_at,
      coalesce("expiresAt", v_observed_at + INTERVAL '3 minutes'),
      coalesce("randomizedMac", false), 1
    FROM valid
    ON CONFLICT (organization_id, building_id, session_key) DO UPDATE SET
      device_id = EXCLUDED.device_id,
      interface_id = EXCLUDED.interface_id,
      client_fingerprint = EXCLUDED.client_fingerprint,
      observed_mac = EXCLUDED.observed_mac,
      observed_ip = EXCLUDED.observed_ip,
      hostname = EXCLUDED.hostname,
      connection_type = EXCLUDED.connection_type,
      session_type = EXCLUDED.session_type,
      room_hint = EXCLUDED.room_hint,
      signal_dbm = EXCLUDED.signal_dbm,
      rx_bytes = EXCLUDED.rx_bytes,
      tx_bytes = EXCLUDED.tx_bytes,
      rx_bps = EXCLUDED.rx_bps,
      tx_bps = EXCLUDED.tx_bps,
      first_seen_at = LEAST(public.network_client_current.first_seen_at, EXCLUDED.first_seen_at),
      last_seen_at = EXCLUDED.last_seen_at,
      observed_at = EXCLUDED.observed_at,
      expires_at = EXCLUDED.expires_at,
      randomized_mac = EXCLUDED.randomized_mac,
      update_seq = public.network_client_current.update_seq + 1
    WHERE EXCLUDED.observed_at >= public.network_client_current.observed_at
    RETURNING id
  ), sessions AS (
    INSERT INTO public.network_client_sessions (
      organization_id, building_id, device_id, interface_id, session_key,
      client_fingerprint, observed_mac, address_history, hostname, connection_type,
      first_seen_at, last_seen_at, rx_bytes, tx_bytes
    )
    SELECT organization_id, building_id, "deviceId", "interfaceId", "sessionKey",
      "clientFingerprint", "observedMac",
      CASE WHEN "observedIp" IS NULL THEN '[]'::jsonb ELSE jsonb_build_array("observedIp"::text) END,
      hostname, coalesce("connectionType", 'UNKNOWN'),
      coalesce("firstSeenAt", v_observed_at), coalesce("lastSeenAt", v_observed_at),
      coalesce("rxBytes", 0), coalesce("txBytes", 0)
    FROM valid
    ON CONFLICT (organization_id, building_id, session_key) DO UPDATE SET
      interface_id = EXCLUDED.interface_id,
      observed_mac = EXCLUDED.observed_mac,
      address_history = CASE
        WHEN EXCLUDED.address_history = '[]'::jsonb
          OR public.network_client_sessions.address_history @> EXCLUDED.address_history
          THEN public.network_client_sessions.address_history
        ELSE public.network_client_sessions.address_history || EXCLUDED.address_history
      END,
      hostname = EXCLUDED.hostname,
      connection_type = EXCLUDED.connection_type,
      last_seen_at = GREATEST(public.network_client_sessions.last_seen_at, EXCLUDED.last_seen_at),
      rx_bytes = GREATEST(public.network_client_sessions.rx_bytes, EXCLUDED.rx_bytes),
      tx_bytes = GREATEST(public.network_client_sessions.tx_bytes, EXCLUDED.tx_bytes)
    RETURNING id
  )
  SELECT count(*) INTO v_clients FROM upserted;

  DELETE FROM public.network_client_current client WHERE client.expires_at <= v_now;
  RETURN jsonb_build_object(
    'observedAt', v_observed_at, 'devices', v_devices,
    'interfaces', v_interfaces, 'clients', v_clients
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
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_router public.network_devices%ROWTYPE;
  v_interfaces jsonb := '[]'::jsonb;
  v_aruba jsonb := '[]'::jsonb;
BEGIN
  IF p_worker_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$'
     OR p_payload IS NULL
     OR jsonb_typeof(p_payload) <> 'object'
     OR octet_length(p_payload::text) > 524288
     OR coalesce(p_payload->>'routerDeviceId', '') !~
       '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
     OR jsonb_typeof(coalesce(p_payload->'interfaces', '[]'::jsonb)) <> 'array'
     OR jsonb_typeof(coalesce(p_payload->'aruba', '[]'::jsonb)) <> 'array'
     OR jsonb_array_length(coalesce(p_payload->'interfaces', '[]'::jsonb)) > 256
     OR jsonb_array_length(coalesce(p_payload->'aruba', '[]'::jsonb)) > 256 THEN
    RAISE EXCEPTION 'Invalid or oversized inventory payload' USING ERRCODE = '22023';
  END IF;

  PERFORM app_private.network_center_assert_safe_json_v1(
    p_payload, 'inventory discovery payload'
  );

  IF EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(coalesce(p_payload->'interfaces', '[]'::jsonb)) AS item(
      "interfaceKey" text
    )
    GROUP BY btrim(item."interfaceKey")
    HAVING count(*) > 1
  ) OR EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(coalesce(p_payload->'aruba', '[]'::jsonb)) AS item(
      "externalKey" text
    )
    GROUP BY btrim(item."externalKey")
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Inventory keys must be unique within a batch' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(coalesce(p_payload->'interfaces', '[]'::jsonb)) AS item(
      "interfaceKey" text,
      "displayName" text,
      "interfaceKind" text,
      "interfaceRole" text,
      "macAddress" text,
      "ifIndex" integer,
      "nominalSpeedBps" bigint,
      "sortOrder" integer,
      metadata jsonb
    )
    WHERE char_length(btrim(coalesce(item."interfaceKey", ''))) NOT BETWEEN 1 AND 160
       OR char_length(btrim(coalesce(item."displayName", item."interfaceKey", ''))) NOT BETWEEN 1 AND 160
       OR upper(btrim(coalesce(item."interfaceKind", 'OTHER'))) NOT IN (
         'ETHERNET', 'WIRELESS', 'WIREGUARD', 'BRIDGE', 'VLAN', 'LOOPBACK', 'OTHER'
       )
       OR upper(btrim(coalesce(item."interfaceRole", 'UNKNOWN'))) NOT IN (
         'WAN', 'LAN', 'ACCESS', 'UPLINK', 'MANAGEMENT', 'UNKNOWN'
       )
       OR (
         nullif(btrim(coalesce(item."macAddress", '')), '') IS NOT NULL
         AND btrim(item."macAddress") !~* '^([0-9a-f]{2}:){5}[0-9a-f]{2}$'
       )
       OR (item."ifIndex" IS NOT NULL AND item."ifIndex" < 0)
       OR (item."nominalSpeedBps" IS NOT NULL AND item."nominalSpeedBps" <= 0)
       OR coalesce(item."sortOrder", 0) < 0
       OR jsonb_typeof(coalesce(item.metadata, '{}'::jsonb)) <> 'object'
       OR octet_length(coalesce(item.metadata, '{}'::jsonb)::text) > 16384
  ) THEN
    RAISE EXCEPTION 'Malformed interface inventory item' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(coalesce(p_payload->'aruba', '[]'::jsonb)) AS item(
      "externalKey" text,
      "displayName" text,
      model text,
      "serialNumber" text,
      "uplinkInterfaceKey" text,
      "managementAddress" text,
      "sortOrder" integer,
      "lifecycleStatus" text,
      metadata jsonb
    )
    WHERE char_length(btrim(coalesce(item."externalKey", ''))) NOT BETWEEN 1 AND 160
       OR char_length(btrim(coalesce(item."displayName", item."externalKey", ''))) NOT BETWEEN 1 AND 160
       OR (item.model IS NOT NULL AND char_length(btrim(item.model)) NOT BETWEEN 1 AND 160)
       OR (item."serialNumber" IS NOT NULL AND char_length(btrim(item."serialNumber")) NOT BETWEEN 1 AND 160)
       OR (
         item."uplinkInterfaceKey" IS NOT NULL
         AND char_length(btrim(item."uplinkInterfaceKey")) NOT BETWEEN 1 AND 160
       )
       OR coalesce(item."sortOrder", 0) < 0
       OR upper(btrim(coalesce(item."lifecycleStatus", 'ONLINE'))) NOT IN (
         'ONLINE', 'OFFLINE', 'DISABLED'
       )
       OR jsonb_typeof(coalesce(item.metadata, '{}'::jsonb)) <> 'object'
       OR octet_length(coalesce(item.metadata, '{}'::jsonb)::text) > 16384
  ) THEN
    RAISE EXCEPTION 'Malformed Aruba inventory item' USING ERRCODE = '22023';
  END IF;

  BEGIN
    PERFORM btrim(item."managementAddress")::inet
    FROM jsonb_to_recordset(coalesce(p_payload->'aruba', '[]'::jsonb)) AS item(
      "managementAddress" text
    )
    WHERE nullif(btrim(coalesce(item."managementAddress", '')), '') IS NOT NULL;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'Malformed Aruba management address' USING ERRCODE = '22023';
  END;

  SELECT router.* INTO v_router
  FROM public.network_devices router
  WHERE router.id = (p_payload->>'routerDeviceId')::uuid
    AND router.device_kind = 'MIKROTIK'
    AND router.is_active
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Inventory router not found' USING ERRCODE = 'P0002';
  END IF;

  WITH input AS (
    SELECT
      btrim(item."interfaceKey") AS interface_key,
      btrim(coalesce(item."displayName", item."interfaceKey")) AS display_name,
      upper(btrim(coalesce(item."interfaceKind", 'OTHER'))) AS interface_kind,
      upper(btrim(coalesce(item."interfaceRole", 'UNKNOWN'))) AS interface_role,
      nullif(btrim(coalesce(item."macAddress", '')), '')::macaddr AS mac_address,
      item."ifIndex" AS if_index,
      item."nominalSpeedBps" AS nominal_speed_bps,
      coalesce(item."isProtected", false) AS requested_protection,
      coalesce(item."sortOrder", 0) AS sort_order,
      coalesce(item."isEnabled", true) AS is_enabled,
      coalesce(item.metadata, '{}'::jsonb) AS display_metadata
    FROM jsonb_to_recordset(coalesce(p_payload->'interfaces', '[]'::jsonb)) AS item(
      "interfaceKey" text,
      "displayName" text,
      "interfaceKind" text,
      "interfaceRole" text,
      "macAddress" text,
      "ifIndex" integer,
      "nominalSpeedBps" bigint,
      "isProtected" boolean,
      "sortOrder" integer,
      "isEnabled" boolean,
      metadata jsonb
    )
  ), upserted AS (
    INSERT INTO public.network_interfaces (
      organization_id, building_id, device_id, interface_key, display_name,
      interface_kind, interface_role, mac_address, if_index, nominal_speed_bps,
      is_protected, sort_order, is_enabled, is_managed, display_metadata
    )
    SELECT
      v_router.organization_id, v_router.building_id, v_router.id,
      input.interface_key, input.display_name, input.interface_kind,
      input.interface_role, input.mac_address, input.if_index,
      input.nominal_speed_bps,
      input.requested_protection
        OR input.interface_role IN ('WAN', 'UPLINK', 'MANAGEMENT'),
      input.sort_order, input.is_enabled, true, input.display_metadata
    FROM input
    ON CONFLICT (device_id, interface_key) DO UPDATE SET
      display_name = EXCLUDED.display_name,
      interface_kind = EXCLUDED.interface_kind,
      interface_role = EXCLUDED.interface_role,
      mac_address = EXCLUDED.mac_address,
      if_index = EXCLUDED.if_index,
      nominal_speed_bps = EXCLUDED.nominal_speed_bps,
      is_protected = public.network_interfaces.is_protected OR EXCLUDED.is_protected,
      sort_order = EXCLUDED.sort_order,
      is_enabled = EXCLUDED.is_enabled,
      is_managed = true,
      display_metadata = EXCLUDED.display_metadata,
      updated_at = clock_timestamp()
    RETURNING id, interface_key
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'interfaceKey', upserted.interface_key,
    'id', upserted.id
  ) ORDER BY upserted.interface_key), '[]'::jsonb)
  INTO v_interfaces
  FROM upserted;

  WITH input AS (
    SELECT
      btrim(item."externalKey") AS external_key,
      btrim(coalesce(item."displayName", item."externalKey")) AS display_name,
      nullif(btrim(coalesce(item.model, '')), '') AS model,
      nullif(btrim(coalesce(item."serialNumber", '')), '') AS serial_number,
      nullif(btrim(coalesce(item."uplinkInterfaceKey", '')), '') AS uplink_interface_key,
      nullif(btrim(coalesce(item."managementAddress", '')), '') AS management_address,
      coalesce(item."sortOrder", 0) AS sort_order,
      upper(btrim(coalesce(item."lifecycleStatus", 'ONLINE'))) AS lifecycle_status,
      coalesce(item.metadata, '{}'::jsonb) AS inventory_metadata
    FROM jsonb_to_recordset(coalesce(p_payload->'aruba', '[]'::jsonb)) AS item(
      "externalKey" text,
      "displayName" text,
      model text,
      "serialNumber" text,
      "uplinkInterfaceKey" text,
      "managementAddress" text,
      "sortOrder" integer,
      "lifecycleStatus" text,
      metadata jsonb
    )
  ), upserted AS (
    INSERT INTO public.network_devices (
      organization_id, building_id, device_kind, external_key, display_name,
      vendor, model, serial_number, parent_device_id, uplink_interface_key,
      sort_order, lifecycle_status, write_capability, is_active,
      credential_ref, inventory_metadata
    )
    SELECT
      v_router.organization_id, v_router.building_id, 'ARUBA', input.external_key,
      input.display_name, 'Aruba', input.model, input.serial_number, v_router.id,
      input.uplink_interface_key, input.sort_order, input.lifecycle_status,
      false, true, NULL,
      (input.inventory_metadata - 'managementAddress')
        || CASE WHEN input.management_address IS NULL THEN '{}'::jsonb
          ELSE jsonb_build_object(
            'managementAddress', host(input.management_address::inet)
          ) END
    FROM input
    ON CONFLICT (organization_id, building_id, device_kind, external_key) DO UPDATE SET
      display_name = EXCLUDED.display_name,
      vendor = 'Aruba',
      model = EXCLUDED.model,
      serial_number = EXCLUDED.serial_number,
      parent_device_id = EXCLUDED.parent_device_id,
      uplink_interface_key = EXCLUDED.uplink_interface_key,
      sort_order = EXCLUDED.sort_order,
      lifecycle_status = EXCLUDED.lifecycle_status,
      write_capability = false,
      is_active = true,
      credential_ref = NULL,
      inventory_metadata = CASE
        WHEN EXCLUDED.inventory_metadata ? 'managementAddress'
          THEN EXCLUDED.inventory_metadata
        WHEN public.network_devices.inventory_metadata ? 'managementAddress'
          THEN EXCLUDED.inventory_metadata || jsonb_build_object(
            'managementAddress', public.network_devices.inventory_metadata->'managementAddress'
          )
        ELSE EXCLUDED.inventory_metadata
      END,
      updated_at = clock_timestamp()
    RETURNING id, external_key
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'externalKey', upserted.external_key,
    'id', upserted.id
  ) ORDER BY upserted.external_key), '[]'::jsonb)
  INTO v_aruba
  FROM upserted;

  RETURN jsonb_build_object(
    'routerDeviceId', v_router.id,
    'interfaces', v_interfaces,
    'aruba', v_aruba,
    'interfaceCount', jsonb_array_length(v_interfaces),
    'arubaCount', jsonb_array_length(v_aruba)
  );
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
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_command public.network_commands%ROWTYPE;
  v_attempt_id uuid;
  v_kind text := upper(btrim(coalesce(p_event_kind, '')));
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
  v_seq bigint;
BEGIN
  IF p_worker_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$'
     OR p_command_id IS NULL OR p_lease_token IS NULL
     OR v_kind NOT IN (
       'VALIDATED', 'BACKUP_STARTED', 'BACKUP_COMPLETED',
       'EXECUTION_STARTED', 'EXECUTION_COMPLETED', 'POST_CHECK_STARTED',
       'POST_CHECK_COMPLETED', 'RECONCILIATION_STARTED', 'RECONCILIATION_COMPLETED'
     )
     OR jsonb_typeof(v_payload) <> 'object'
     OR octet_length(v_payload::text) > 65536 THEN
    RAISE EXCEPTION 'Invalid command stage event' USING ERRCODE = '22023';
  END IF;
  PERFORM app_private.network_center_assert_safe_json_v1(
    v_payload, 'command event payload'
  );
  SELECT command.* INTO v_command FROM public.network_commands command
  WHERE command.id = p_command_id AND command.lease_token = p_lease_token
    AND command.lease_owner = p_worker_id
    AND command.status IN ('LEASED', 'RUNNING', 'RECONCILING')
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Active command lease not found' USING ERRCODE = '55000'; END IF;
  SELECT attempt.id INTO v_attempt_id FROM public.network_command_attempts attempt
  WHERE attempt.command_id = p_command_id
  ORDER BY attempt.attempt_no DESC LIMIT 1;
  SELECT coalesce(max(event.event_seq) + 1, 1) INTO v_seq
  FROM public.network_command_events event WHERE event.command_id = p_command_id;
  INSERT INTO public.network_command_events (
    organization_id, building_id, command_id, attempt_id, event_seq,
    event_kind, occurred_at, worker_id, payload
  ) VALUES (
    v_command.organization_id, v_command.building_id, p_command_id,
    v_attempt_id, v_seq, v_kind, clock_timestamp(), p_worker_id, v_payload
  );
  IF v_kind = 'EXECUTION_STARTED' AND v_command.status = 'LEASED' THEN
    UPDATE public.network_commands SET status = 'RUNNING' WHERE id = p_command_id;
  ELSIF v_kind = 'RECONCILIATION_STARTED' AND v_command.status <> 'RECONCILING' THEN
    UPDATE public.network_commands
    SET status = 'RECONCILING', reconciliation_state = 'IN_PROGRESS'
    WHERE id = p_command_id;
  END IF;
  RETURN jsonb_build_object('commandId', p_command_id, 'eventSeq', v_seq, 'eventKind', v_kind);
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
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_command public.network_commands%ROWTYPE;
  v_outcome text := upper(btrim(coalesce(p_outcome, '')));
  v_result jsonb := coalesce(p_result, '{}'::jsonb);
  v_rollback jsonb := p_rollback;
  v_attempt_id uuid;
  v_status text;
  v_event text;
  v_attempt_outcome text;
  v_reconciliation text;
  v_seq bigint;
  v_response jsonb;
BEGIN
  IF p_worker_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$'
     OR p_command_id IS NULL OR p_lease_token IS NULL
     OR v_outcome NOT IN ('SUCCEEDED', 'RETRYABLE_FAILURE', 'FAILED', 'UNCERTAIN', 'CANCELLED_BY_KILL_SWITCH')
     OR jsonb_typeof(v_result) <> 'object' OR octet_length(v_result::text) > 65536
     OR (v_rollback IS NOT NULL AND (jsonb_typeof(v_rollback) <> 'object' OR octet_length(v_rollback::text) > 65536))
     OR p_retry_delay_seconds NOT BETWEEN 5 AND 3600 THEN
    RAISE EXCEPTION 'Invalid command completion' USING ERRCODE = '22023';
  END IF;
  PERFORM app_private.network_center_assert_safe_json_v1(
    v_result, 'command result'
  );
  PERFORM app_private.network_center_assert_safe_json_v1(
    v_rollback, 'command rollback'
  );
  SELECT command.* INTO v_command FROM public.network_commands command
  WHERE command.id = p_command_id AND command.lease_token = p_lease_token
    AND command.lease_owner = p_worker_id
    AND command.status IN ('LEASED', 'RUNNING', 'RECONCILING')
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Active command lease not found' USING ERRCODE = '55000'; END IF;

  v_status := CASE
    WHEN v_command.status = 'RECONCILING'
     AND v_outcome = 'RETRYABLE_FAILURE' THEN 'UNCERTAIN'
    ELSE CASE v_outcome
    WHEN 'SUCCEEDED' THEN 'SUCCEEDED'
    WHEN 'RETRYABLE_FAILURE' THEN CASE
      WHEN v_command.attempt_count < v_command.max_attempts THEN 'RETRY_WAIT' ELSE 'FAILED' END
    WHEN 'FAILED' THEN 'FAILED'
    WHEN 'UNCERTAIN' THEN 'UNCERTAIN'
    ELSE 'CANCELLED_BY_KILL_SWITCH'
    END
  END;
  v_event := CASE
    WHEN v_status = 'RETRY_WAIT' THEN 'RETRY_SCHEDULED'
    WHEN v_status = 'CANCELLED_BY_KILL_SWITCH' THEN 'CANCELLED_BY_KILL_SWITCH'
    WHEN v_status = 'UNCERTAIN' THEN 'UNCERTAIN'
    WHEN v_status = 'SUCCEEDED' THEN 'SUCCEEDED'
    ELSE 'FAILED'
  END;
  v_attempt_outcome := CASE
    WHEN v_status = 'SUCCEEDED' THEN 'SUCCEEDED'
    WHEN v_status = 'RETRY_WAIT' THEN 'RETRYABLE_FAILURE'
    WHEN v_status = 'UNCERTAIN' THEN 'UNCERTAIN'
    WHEN v_status = 'CANCELLED_BY_KILL_SWITCH' THEN 'ABANDONED'
    ELSE 'PERMANENT_FAILURE'
  END;
  v_reconciliation := CASE
    WHEN v_status = 'UNCERTAIN' THEN 'REQUIRED'
    WHEN v_command.status = 'RECONCILING' AND v_status = 'SUCCEEDED' THEN 'CONFIRMED'
    WHEN v_command.status = 'RECONCILING' AND v_status = 'FAILED' THEN 'FAILED'
    ELSE v_command.reconciliation_state
  END;

  SELECT attempt.id INTO v_attempt_id FROM public.network_command_attempts attempt
  WHERE attempt.command_id = p_command_id AND attempt.lease_token = p_lease_token
  ORDER BY attempt.attempt_no DESC LIMIT 1;
  IF v_attempt_id IS NOT NULL THEN
    UPDATE public.network_command_attempts
    SET outcome = v_attempt_outcome,
        retryable = (v_status = 'RETRY_WAIT'),
        result = v_result,
        error_code = CASE WHEN v_status IN ('SUCCEEDED', 'RETRY_WAIT') THEN NULL ELSE v_result->>'code' END,
        error_message = CASE WHEN v_status = 'SUCCEEDED' THEN NULL ELSE left(v_result->>'message', 2000) END,
        finished_at = v_now
    WHERE id = v_attempt_id;
  END IF;
  SELECT coalesce(max(event.event_seq) + 1, 1) INTO v_seq
  FROM public.network_command_events event WHERE event.command_id = p_command_id;
  INSERT INTO public.network_command_events (
    organization_id, building_id, command_id, attempt_id, event_seq,
    event_kind, occurred_at, worker_id, payload
  ) VALUES (
    v_command.organization_id, v_command.building_id, p_command_id,
    v_attempt_id, v_seq, v_event, v_now, p_worker_id,
    jsonb_build_object('outcome', v_outcome, 'result', v_result)
  );

  DELETE FROM public.network_device_leases lease
  WHERE lease.command_id = p_command_id AND lease.lease_token = p_lease_token
    AND lease.lease_owner = p_worker_id;
  UPDATE public.network_commands command
  SET status = v_status,
      available_at = CASE WHEN v_status = 'RETRY_WAIT'
        THEN v_now + make_interval(secs => p_retry_delay_seconds) ELSE command.available_at END,
      lease_token = NULL, lease_owner = NULL, lease_expires_at = NULL,
      result = v_result, rollback = v_rollback,
      reconciliation_state = v_reconciliation,
      finished_at = CASE WHEN v_status IN ('SUCCEEDED', 'FAILED', 'CANCELLED_BY_KILL_SWITCH')
        THEN v_now ELSE NULL END,
      updated_at = v_now
  WHERE command.id = p_command_id;
  v_response := jsonb_build_object(
    'commandId', p_command_id, 'status', v_status,
    'result', v_result, 'rollback', v_rollback,
    'reconciliationState', v_reconciliation
  );
  INSERT INTO public.network_audit_events (
    organization_id, building_id, actor_type, worker_id, action, target_type,
    target_id, target_display, reason, validation, result, outcome, command_id
  ) VALUES (
    v_command.organization_id, v_command.building_id, 'WORKER', p_worker_id,
    lower(v_command.action_type), 'device', v_command.device_id,
    v_command.target_display, v_command.reason,
    jsonb_build_object('attemptCount', v_command.attempt_count), v_response,
    CASE v_status WHEN 'SUCCEEDED' THEN 'SUCCEEDED' WHEN 'UNCERTAIN' THEN 'UNCERTAIN' ELSE 'FAILED' END,
    p_command_id
  );
  INSERT INTO public.network_outbox_events (
    organization_id, building_id, event_type, aggregate_type, aggregate_id, payload, occurred_at
  ) VALUES (
    v_command.organization_id, v_command.building_id, 'network.command.completed',
    'command', p_command_id, jsonb_build_object('status', v_status), v_now
  );
  RETURN v_response;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.network_center_worker_upsert_incident_v1(
  p_worker_id text,
  p_payload jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_device public.network_devices%ROWTYPE;
  v_incident public.network_incidents%ROWTYPE;
  v_interface_id uuid;
  v_event_key text;
  v_fingerprint text;
  v_type text;
  v_severity text;
  v_title text;
  v_summary text;
  v_observed_at timestamptz;
  v_values jsonb;
  v_resolved boolean;
  v_event_kind text;
  v_seq bigint;
BEGIN
  IF p_worker_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$'
     OR p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object'
     OR octet_length(p_payload::text) > 65536 THEN
    RAISE EXCEPTION 'Invalid incident payload' USING ERRCODE = '22023';
  END IF;
  v_event_key := btrim(coalesce(p_payload->>'eventKey', ''));
  v_fingerprint := btrim(coalesce(p_payload->>'fingerprint', ''));
  v_type := upper(btrim(coalesce(p_payload->>'incidentType', '')));
  v_severity := upper(btrim(coalesce(p_payload->>'severity', '')));
  v_title := btrim(coalesce(p_payload->>'title', ''));
  v_summary := btrim(coalesce(p_payload->>'summary', ''));
  v_observed_at := nullif(p_payload->>'observedAt', '')::timestamptz;
  v_values := coalesce(p_payload->'observedValues', '{}'::jsonb);
  v_resolved := coalesce((p_payload->>'resolved')::boolean, false);
  IF v_event_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$'
     OR char_length(v_fingerprint) NOT BETWEEN 8 AND 200
     OR v_type !~ '^[A-Z][A-Z0-9_]{2,63}$'
     OR v_severity NOT IN ('INFO', 'WARNING', 'CRITICAL')
     OR char_length(v_title) NOT BETWEEN 3 AND 200
     OR char_length(v_summary) NOT BETWEEN 3 AND 2000
     OR v_observed_at IS NULL
     OR abs(extract(epoch FROM (clock_timestamp() - v_observed_at))) > 600
     OR jsonb_typeof(v_values) <> 'object' OR octet_length(v_values::text) > 16384 THEN
    RAISE EXCEPTION 'Malformed incident payload' USING ERRCODE = '22023';
  END IF;
  PERFORM app_private.network_center_assert_safe_json_v1(
    p_payload, 'incident payload'
  );
  SELECT device.* INTO v_device FROM public.network_devices device
  WHERE device.id = (p_payload->>'deviceId')::uuid AND device.is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'Incident device not found' USING ERRCODE = 'P0002'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.network_incident_events event
    WHERE event.organization_id = v_device.organization_id
      AND event.external_event_key = v_event_key
  ) THEN
    SELECT incident.* INTO v_incident
    FROM public.network_incidents incident
    JOIN public.network_incident_events event
      ON event.organization_id = incident.organization_id
     AND event.building_id = incident.building_id
     AND event.incident_id = incident.id
    WHERE event.organization_id = v_device.organization_id
      AND event.external_event_key = v_event_key
    LIMIT 1;
    RETURN jsonb_build_object('incidentId', v_incident.id, 'status', v_incident.status);
  END IF;
  IF nullif(p_payload->>'interfaceId', '') IS NOT NULL THEN
    v_interface_id := (p_payload->>'interfaceId')::uuid;
    IF NOT EXISTS (
      SELECT 1 FROM public.network_interfaces interface
      WHERE interface.id = v_interface_id AND interface.device_id = v_device.id
        AND interface.organization_id = v_device.organization_id
        AND interface.building_id = v_device.building_id
    ) THEN RAISE EXCEPTION 'Incident interface not found' USING ERRCODE = 'P0002'; END IF;
  END IF;

  SELECT incident.* INTO v_incident FROM public.network_incidents incident
  WHERE incident.organization_id = v_device.organization_id
    AND incident.building_id = v_device.building_id
    AND incident.fingerprint = v_fingerprint AND incident.status <> 'RESOLVED'
  FOR UPDATE;
  IF v_resolved THEN
    IF NOT FOUND THEN
      RETURN jsonb_build_object('incidentId', NULL, 'status', 'RESOLVED', 'alreadyClosed', true);
    END IF;
    UPDATE public.network_incidents
    SET status = 'RESOLVED', last_observed_at = greatest(last_observed_at, v_observed_at),
        recovered_at = coalesce(recovered_at, v_observed_at), resolved_at = v_observed_at,
        version = version + 1
    WHERE id = v_incident.id RETURNING * INTO v_incident;
    v_event_kind := 'RESOLVED';
  ELSIF NOT FOUND THEN
    INSERT INTO public.network_incidents (
      organization_id, building_id, device_id, interface_id, fingerprint,
      incident_type, severity, status, title, summary, availability_impact,
      opened_at, last_observed_at, observed_values
    ) VALUES (
      v_device.organization_id, v_device.building_id, v_device.id, v_interface_id,
      v_fingerprint, v_type, v_severity, 'OPEN', v_title, v_summary,
      coalesce((p_payload->>'availabilityImpact')::boolean, false),
      v_observed_at, v_observed_at, v_values
    ) RETURNING * INTO v_incident;
    v_event_kind := 'OPENED';
  ELSE
    UPDATE public.network_incidents
    SET severity = v_severity, title = v_title, summary = v_summary,
        last_observed_at = greatest(last_observed_at, v_observed_at),
        occurrence_count = occurrence_count + 1, observed_values = v_values,
        version = version + 1
    WHERE id = v_incident.id RETURNING * INTO v_incident;
    v_event_kind := 'OBSERVED';
  END IF;
  SELECT coalesce(max(event.event_seq) + 1, 1) INTO v_seq
  FROM public.network_incident_events event WHERE event.incident_id = v_incident.id;
  INSERT INTO public.network_incident_events (
    organization_id, building_id, incident_id, event_seq, event_kind, severity,
    occurred_at, worker_id, details, external_event_key
  ) VALUES (
    v_device.organization_id, v_device.building_id, v_incident.id, v_seq,
    v_event_kind, v_severity, v_observed_at, p_worker_id, v_values, v_event_key
  );
  IF v_event_kind IN ('OPENED', 'RESOLVED') THEN
    INSERT INTO public.network_outbox_events (
      organization_id, building_id, event_type, aggregate_type, aggregate_id, payload, occurred_at
    ) VALUES (
      v_device.organization_id, v_device.building_id,
      CASE WHEN v_event_kind = 'OPENED' THEN 'network.incident.opened' ELSE 'network.incident.resolved' END,
      'incident', v_incident.id,
      jsonb_build_object('severity', v_severity, 'title', v_title), v_observed_at
    );
  END IF;
  RETURN jsonb_build_object(
    'incidentId', v_incident.id, 'status', v_incident.status,
    'eventKind', v_event_kind, 'eventSeq', v_seq
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
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_device public.network_devices%ROWTYPE;
  v_command public.network_commands%ROWTYPE;
  v_snapshot public.network_config_snapshots%ROWTYPE;
  v_snapshot_id uuid;
  v_command_id uuid;
  v_source text;
  v_normalized jsonb;
  v_lines jsonb;
  v_hash text;
  v_artifact_key text;
BEGIN
  IF p_worker_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$'
     OR p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object'
     OR octet_length(p_payload::text) > 2097152 THEN
    RAISE EXCEPTION 'Invalid snapshot payload' USING ERRCODE = '22023';
  END IF;
  v_snapshot_id := (p_payload->>'snapshotId')::uuid;
  v_command_id := nullif(p_payload->>'commandId', '')::uuid;
  v_source := upper(btrim(coalesce(p_payload->>'source', '')));
  v_normalized := p_payload->'normalizedContent';
  v_lines := p_payload->'redactedLines';
  v_hash := lower(btrim(coalesce(p_payload->>'contentHash', '')));
  v_artifact_key := nullif(btrim(coalesce(p_payload->>'artifactKey', '')), '');
  IF v_source NOT IN ('MANUAL', 'SCHEDULED', 'PRE_ACTION', 'POST_ACTION')
     OR jsonb_typeof(v_normalized) <> 'object' OR octet_length(v_normalized::text) > 1048576
     OR jsonb_typeof(v_lines) <> 'array' OR octet_length(v_lines::text) > 1048576
     OR v_hash !~ '^[a-f0-9]{64}$'
     OR (v_artifact_key IS NOT NULL AND (
       char_length(v_artifact_key) NOT BETWEEN 8 AND 500
       OR v_artifact_key !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]+$'
     )) THEN
    RAISE EXCEPTION 'Malformed or unbounded redacted snapshot' USING ERRCODE = '22023';
  END IF;
  PERFORM app_private.network_center_assert_safe_json_v1(
    v_normalized, 'normalized configuration snapshot'
  );
  PERFORM app_private.network_center_assert_safe_json_v1(
    v_lines, 'redacted configuration lines'
  );
  SELECT device.* INTO v_device FROM public.network_devices device
  WHERE device.id = (p_payload->>'deviceId')::uuid
    AND device.device_kind = 'MIKROTIK' AND device.is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'Snapshot device not found' USING ERRCODE = 'P0002'; END IF;
  IF v_command_id IS NOT NULL THEN
    SELECT command.* INTO v_command FROM public.network_commands command
    WHERE command.id = v_command_id AND command.device_id = v_device.id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Snapshot command not found' USING ERRCODE = 'P0002'; END IF;
  END IF;
  INSERT INTO public.network_config_snapshots (
    id, organization_id, building_id, device_id, command_id, source,
    schema_version, normalized_content, redacted_lines, content_hash,
    artifact_key, created_by, worker_id
  ) VALUES (
    v_snapshot_id, v_device.organization_id, v_device.building_id, v_device.id,
    v_command_id, v_source, coalesce((p_payload->>'schemaVersion')::integer, 1),
    v_normalized, v_lines, v_hash, v_artifact_key, v_command.requested_by, p_worker_id
  ) ON CONFLICT (id) DO NOTHING;
  SELECT snapshot.* INTO v_snapshot FROM public.network_config_snapshots snapshot
  WHERE snapshot.id = v_snapshot_id AND snapshot.device_id = v_device.id;
  IF NOT FOUND OR v_snapshot.content_hash IS DISTINCT FROM v_hash THEN
    RAISE EXCEPTION 'Snapshot idempotency conflict' USING ERRCODE = '23505';
  END IF;
  RETURN jsonb_build_object(
    'snapshotId', v_snapshot.id, 'contentHash', v_snapshot.content_hash,
    'createdAt', v_snapshot.created_at, 'source', v_snapshot.source
  );
END;
$fn$;

CREATE OR REPLACE FUNCTION public.network_center_worker_maintenance_v1(
  p_worker_id text,
  p_now timestamptz DEFAULT clock_timestamp()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE v_expired_clients bigint; v_reclaimed integer;
BEGIN
  IF p_worker_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$'
     OR p_now IS NULL OR abs(extract(epoch FROM (clock_timestamp() - p_now))) > 3600 THEN
    RAISE EXCEPTION 'Invalid worker maintenance request' USING ERRCODE = '22023';
  END IF;
  PERFORM app_private.network_center_ensure_raw_partitions_v1(p_now::date - 1, p_now::date + 7);
  PERFORM app_private.network_center_rollup_hourly_v1(date_trunc('hour', p_now) - INTERVAL '1 hour');
  PERFORM app_private.network_center_rollup_sla_daily_v1((p_now - INTERVAL '1 day')::date);
  PERFORM app_private.network_center_retention_v1(p_now);
  v_reclaimed := app_private.network_center_reclaim_expired_commands_v1(p_now);
  DELETE FROM public.network_client_current client WHERE client.expires_at <= p_now;
  GET DIAGNOSTICS v_expired_clients = ROW_COUNT;
  UPDATE public.network_maintenance_windows maintenance
  SET status = CASE WHEN maintenance.ends_at <= p_now THEN 'COMPLETED' ELSE 'ACTIVE' END
  WHERE maintenance.status IN ('SCHEDULED', 'ACTIVE')
    AND (maintenance.starts_at <= p_now OR maintenance.ends_at <= p_now);
  RETURN jsonb_build_object(
    'at', p_now, 'expiredClients', v_expired_clients, 'reclaimedCommands', v_reclaimed
  );
END;
$fn$;

-- ---------------------------------------------------------------------------
-- Function ACLs: browser roles receive only the public view/execute facades.
-- Worker functions are callable only through the service-role Edge boundary.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION app_private.network_center_assert_safe_json_v1(jsonb, text, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app_private.network_center_require_view_v1(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app_private.network_center_require_execute_v1(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app_private.network_center_request_replay_v1(uuid, uuid, uuid, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app_private.network_center_append_user_audit_v1(
  uuid, uuid, uuid, text, text, uuid, jsonb, text, jsonb, jsonb, text, uuid, uuid, text
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app_private.network_center_claim_reconciliation_v1(text, integer, integer)
  FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.network_center_list_fleet_v1()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.network_center_get_building_v1(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.network_center_list_aruba_v1(uuid, integer, uuid, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.network_center_list_clients_v1(uuid, timestamptz, uuid, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.network_center_list_commands_v1(uuid, timestamptz, uuid, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.network_center_list_audit_v1(uuid, timestamptz, uuid, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.network_center_compare_snapshots_v1(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.network_center_ack_incident_v1(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.network_center_create_maintenance_v1(uuid, integer, text, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.network_center_cancel_maintenance_v1(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.network_center_request_snapshot_v1(uuid, text, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.network_center_execute_action_v1(uuid, text, text, jsonb, text, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.network_center_update_settings_v1(uuid, jsonb, bigint, uuid)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.network_center_list_fleet_v1()
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.network_center_get_building_v1(uuid)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.network_center_list_aruba_v1(uuid, integer, uuid, integer)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.network_center_list_clients_v1(uuid, timestamptz, uuid, integer)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.network_center_list_commands_v1(uuid, timestamptz, uuid, integer)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.network_center_list_audit_v1(uuid, timestamptz, uuid, integer)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.network_center_compare_snapshots_v1(uuid, uuid, uuid)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.network_center_ack_incident_v1(uuid, uuid)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.network_center_create_maintenance_v1(uuid, integer, text, uuid)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.network_center_cancel_maintenance_v1(uuid, uuid, uuid)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.network_center_request_snapshot_v1(uuid, text, uuid)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.network_center_execute_action_v1(uuid, text, text, jsonb, text, uuid)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.network_center_update_settings_v1(uuid, jsonb, bigint, uuid)
  TO authenticated;

REVOKE ALL ON FUNCTION public.network_center_worker_heartbeat_v1(
  text, text, text[], text, integer, jsonb, timestamptz
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.network_center_worker_list_connections_v1(text, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.network_center_worker_claim_v1(text, integer, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.network_center_worker_renew_v1(text, uuid, uuid, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.network_center_worker_ingest_v1(text, jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.network_center_worker_inventory_v1(text, jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.network_center_worker_command_event_v1(text, uuid, uuid, text, jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.network_center_worker_complete_v1(
  text, uuid, uuid, text, jsonb, jsonb, integer
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.network_center_worker_upsert_incident_v1(text, jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.network_center_worker_snapshot_v1(text, jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.network_center_worker_maintenance_v1(text, timestamptz)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.network_center_worker_heartbeat_v1(
  text, text, text[], text, integer, jsonb, timestamptz
) TO service_role;
GRANT EXECUTE ON FUNCTION public.network_center_worker_list_connections_v1(text, integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.network_center_worker_claim_v1(text, integer, integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.network_center_worker_renew_v1(text, uuid, uuid, integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.network_center_worker_ingest_v1(text, jsonb)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.network_center_worker_inventory_v1(text, jsonb)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.network_center_worker_command_event_v1(text, uuid, uuid, text, jsonb)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.network_center_worker_complete_v1(
  text, uuid, uuid, text, jsonb, jsonb, integer
) TO service_role;
GRANT EXECUTE ON FUNCTION public.network_center_worker_upsert_incident_v1(text, jsonb)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.network_center_worker_snapshot_v1(text, jsonb)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.network_center_worker_maintenance_v1(text, timestamptz)
  TO service_role;

-- Realtime is only an invalidation surface. Command rows are intentionally
-- excluded because they carry worker lease credentials; command events are the
-- safe invalidation signal. Do not add client presence because DELETE payload
-- authorization is not filtered by RLS in Postgres Changes.
SELECT pg_advisory_xact_lock(20260729040000::bigint);

DO $realtime$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'network_device_current'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.network_device_current;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'network_interface_current'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.network_interface_current;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'network_incidents'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.network_incidents;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'network_commands'
  ) THEN
    ALTER PUBLICATION supabase_realtime DROP TABLE public.network_commands;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'network_command_events'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.network_command_events;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'network_worker_heartbeats'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.network_worker_heartbeats;
  END IF;
END;
$realtime$;

COMMIT;

NOTIFY pgrst, 'reload schema';
