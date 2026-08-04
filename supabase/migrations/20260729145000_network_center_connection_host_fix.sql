-- =============================================================================
-- Network Center additive forward-fix: an `inet` rendered through `::text` is
-- not a dialable address.
--
-- PostgreSQL's cast to text is backed by network_show(), which ALWAYS appends
-- the netmask. Measured on the production PostgreSQL 17.6:
--
--     '10.77.0.250'::inet::text     ->  '10.77.0.250/32'    (the defect)
--     host('10.77.0.250'::inet)     ->  '10.77.0.250'
--     to_jsonb('10.77.0.250'::inet) ->  '"10.77.0.250"'     (inet_out omits /32)
--
-- The third line is why nothing caught this: every human-facing readback of a
-- connection row goes through inet_out (row_to_json on the table) or through
-- host() (network_center_admin_status_v1), so operators always saw a clean
-- "10.77.0.250" while the worker alone was handed "10.77.0.250/32".
--
-- MEASURED CONSEQUENCE, from inside the running canary container on
-- 2026-08-02, same ApiClient, same image, only the string differing:
--     managementIp "10.77.0.250/32" -> POLL_FAIL in   20 ms
--     managementIp "10.77.0.250"    -> POLL_OK   in 1044 ms / 931 ms (x4)
-- ssh2 hands the value straight to the resolver, so a value carrying "/" fails
-- before a socket is opened. The router's own log shows "publickey accepted"
-- for every manual probe and NOT ONE entry at any of the nine canary poll
-- timestamps: the failure leaves no trace on the device at all.
--
-- BLAST RADIUS. network_center_worker_list_connections_v2 is the only route by
-- which a worker learns a router address, and CommandCoordinator resolves the
-- router for a claimed command through the same call, so this blocked polling,
-- inventory, telemetry AND all four disruptive actions for every ROUTEROS_SSH
-- device in the fleet -- not merely telemetry.
--
-- WHY host() AND NOT abbrev()/text(). host() extracts the address and drops the
-- mask for every family and every mask length: host('10.77.0.250'::inet) and
-- host('10.77.0.250/24'::inet) are both '10.77.0.250', and
-- host('2001:db8::1/128'::inet) is '2001:db8::1'. abbrev() and text() both keep
-- a non-maximal mask, and network_device_connections.management_ip carries NO
-- masklen constraint, so a /24 can legitimately be stored today. host() is also
-- already this schema's convention: 20260729134000:185/204/391 and
-- 20260729140000:119 use it, which is exactly why the admin control plane was
-- the one reader that always worked.
--
-- SCOPE. The corpus was swept for every column declared inet, cidr, macaddr or
-- macaddr8 and for every use of those columns. FIVE live function bodies
-- rendered an inet through ::text; all five are repaired here. Two further
-- ::text sites in 20260729040000 (:667, :1647) are DEAD -- both functions were
-- superseded by a later CREATE OR REPLACE at the same signature -- and are
-- deliberately not touched. macaddr::text (20260729040000:750) is benign:
-- macaddr_out and the text cast render identically.
--
-- Nothing else about any of the five functions changes. Signature, RETURNS
-- type, LANGUAGE, volatility, SECURITY DEFINER, the pinned search_path and the
-- exact grant surface are re-declared as production already has them (measured
-- from pg_proc.prosecdef / provolatile / proconfig / proacl, which genuinely
-- differ per function on this database) and asserted back out of the catalog
-- below. Each body was extracted verbatim from its owning migration by line
-- range and passed through a single mechanical substitution; the
-- pre-substitution sha256(prosrc) of all five matches production byte for byte,
-- and the substitution is length-preserving (host(X) and X::text are the same
-- width), so the repaired bodies are the reviewed bodies with one token moved.
--
-- DATA NOTE. network_client_sessions.address_history rows written before this
-- fix would hold "10.0.0.5/32" strings. Production holds ZERO telemetry rows,
-- so no backfill is required and none is performed.
-- =============================================================================

BEGIN;

SELECT pg_advisory_xact_lock(20260729145000::bigint);

-- Fail closed rather than replace something other than what was reviewed:
-- refuse to run unless every function is present with exactly the definer
-- profile production is measured to have.
DO $preflight$
DECLARE
  v_pin record;
  v_secdef boolean;
  v_volatile "char";
  v_config text[];
  v_missing text;
BEGIN
  FOR v_pin IN
    SELECT *
    FROM (VALUES
      ('public.network_center_worker_list_connections_v2(text,integer)', 'v'::"char", ARRAY['search_path=pg_catalog']::text[], 'connection.management_ip::text', 'host(connection.management_ip)',
       ARRAY['service_role']::text[]),
      ('public.network_center_worker_list_connections_v1(text,integer)', 'v'::"char", ARRAY['search_path=pg_catalog']::text[], 'connection.management_ip::text', 'host(connection.management_ip)',
       ARRAY['service_role']::text[]),
      ('public.network_center_list_aruba_v1(uuid,integer,uuid,integer)', 's'::"char", ARRAY['search_path=pg_catalog, public, app_private']::text[], 'connection.management_ip::text', 'host(connection.management_ip)',
       ARRAY['service_role', 'authenticated']::text[]),
      ('public.network_center_list_clients_v1(uuid,timestamp with time zone,uuid,integer)', 's'::"char", ARRAY['search_path=pg_catalog, public, app_private']::text[], 'item.observed_ip::text', 'host(item.observed_ip)',
       ARRAY['service_role', 'authenticated']::text[]),
      ('app_private.network_center_worker_ingest_legacy_impl_v1(text,jsonb)', 'v'::"char", ARRAY['search_path=pg_catalog, public, app_private']::text[], 'jsonb_build_array("observedIp"::text)', 'jsonb_build_array(host("observedIp"))',
       ARRAY[]::text[])
    ) AS pin(signature, volatility, config, defect_token, fix_token, grantees)
  LOOP
    IF to_regprocedure(v_pin.signature) IS NULL THEN
      RAISE EXCEPTION '% is missing', v_pin.signature USING ERRCODE = '42883';
    END IF;

    -- Identify by OID. pg_get_function_identity_arguments() renders parameter
    -- NAMES as well, so comparing it against a type list matches nothing and
    -- every assertion below it becomes vacuous.
    SELECT proc.prosecdef, proc.provolatile, proc.proconfig
    INTO v_secdef, v_volatile, v_config
    FROM pg_proc proc
    WHERE proc.oid = to_regprocedure(v_pin.signature);

    IF v_secdef IS NOT TRUE THEN
      RAISE EXCEPTION '% lost SECURITY DEFINER before the fix', v_pin.signature
        USING ERRCODE = '42501';
    END IF;
    IF v_volatile <> v_pin.volatility THEN
      RAISE EXCEPTION '% volatility is %, not the pinned %',
        v_pin.signature, v_volatile, v_pin.volatility
        USING ERRCODE = '42501';
    END IF;
    IF v_config IS DISTINCT FROM v_pin.config THEN
      RAISE EXCEPTION '% proconfig is %, not the pinned %',
        v_pin.signature, coalesce(v_config::text, '<null>'), v_pin.config::text
        USING ERRCODE = '42501';
    END IF;
  END LOOP;

  FOR v_missing IN
    SELECT relation
    FROM unnest(ARRAY[
      'public.network_device_connections',
      'public.network_devices',
      'public.network_site_settings',
      'public.network_worker_assignments',
      'public.network_workers',
      'public.network_client_current',
      'public.network_client_sessions',
      'public.network_device_current'
    ]) AS relation
    WHERE to_regclass(relation) IS NULL
  LOOP
    RAISE EXCEPTION 'Relation % named by the repaired readers is missing', v_missing
      USING ERRCODE = '42P01';
  END LOOP;
END;
$preflight$;

-- ---------------------------------------------------------------------------
-- public.network_center_worker_list_connections_v2(text,integer)
-- ---------------------------------------------------------------------------
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
        'managementIp', host(connection.management_ip),
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

-- ---------------------------------------------------------------------------
-- public.network_center_worker_list_connections_v1(text,integer)
-- ---------------------------------------------------------------------------
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
        'managementIp', host(connection.management_ip),
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

-- ---------------------------------------------------------------------------
-- public.network_center_list_aruba_v1(uuid,integer,uuid,integer)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.network_center_list_aruba_v1(
  p_building_id uuid,
  p_after_sort_order integer DEFAULT NULL,
  p_after_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 100
)
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
  IF p_limit IS NULL
     OR p_limit NOT BETWEEN 1 AND 250
     OR ((p_after_sort_order IS NULL) <> (p_after_id IS NULL)) THEN
    RAISE EXCEPTION 'Invalid Aruba cursor' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_scope
  FROM app_private.network_center_require_view_v1(p_building_id);

  WITH page AS (
    SELECT
      device.id, device.sort_order, device.display_name, device.model,
      device.external_key, device.lifecycle_status,
      current_state.reachable, current_state.health_status,
      current_state.last_seen_at,
      coalesce(
        (
          SELECT host(connection.management_ip)
          FROM public.network_device_connections connection
          WHERE connection.device_id = device.id AND connection.is_enabled
          ORDER BY connection.id
          LIMIT 1
        ),
        nullif(device.inventory_metadata->>'managementAddress', '')
      ) AS management_address
    FROM public.network_devices device
    LEFT JOIN public.network_device_current current_state
      ON current_state.device_id = device.id
    WHERE device.organization_id = v_scope.organization_id
      AND device.building_id = p_building_id
      AND device.device_kind = 'ARUBA'
      AND device.is_active
      AND (
        p_after_id IS NULL
        OR ROW(device.sort_order, device.id) >
           ROW(p_after_sort_order, p_after_id)
      )
    ORDER BY device.sort_order, device.id
    LIMIT p_limit + 1
  ), items AS (
    SELECT * FROM page ORDER BY sort_order, id LIMIT p_limit
  )
  SELECT jsonb_build_object(
    'items', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id', item.id,
        'name', item.display_name,
        'model', item.model,
        'externalKey', item.external_key,
        'lifecycleStatus', item.lifecycle_status,
        'reachable', coalesce(item.reachable, false),
        'healthStatus', item.health_status,
        'lastSeenAt', item.last_seen_at,
        'address', item.management_address
      ) ORDER BY item.sort_order, item.id)
      FROM items item
    ), '[]'::jsonb),
    'nextCursor', CASE WHEN (SELECT count(*) FROM page) > p_limit THEN (
      SELECT jsonb_build_object('sortOrder', item.sort_order, 'id', item.id)
      FROM items item
      ORDER BY item.sort_order DESC, item.id DESC
      LIMIT 1
    ) ELSE NULL END
  ) INTO v_result;
  RETURN v_result;
END;
$fn$;

-- ---------------------------------------------------------------------------
-- public.network_center_list_clients_v1(uuid,timestamp with time zone,uuid,integer)
-- ---------------------------------------------------------------------------
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
      'id', item.id, 'hostname', item.hostname, 'address', host(item.observed_ip),
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

-- ---------------------------------------------------------------------------
-- app_private.network_center_worker_ingest_legacy_impl_v1(text,jsonb)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_private.network_center_worker_ingest_legacy_impl_v1(
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
      CASE WHEN "observedIp" IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(host("observedIp")) END,
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

-- The grant surface is re-declared rather than inherited. CREATE OR REPLACE
-- preserves an existing ACL, so this is belt and braces -- but a body-only
-- forward fix is exactly the shape that drifts silently, and the assertions
-- below would rather fail the migration than ship a widened definer.
REVOKE ALL ON FUNCTION public.network_center_worker_list_connections_v2(
  text,integer
)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.network_center_worker_list_connections_v2(
  text,integer
)
  TO service_role;

REVOKE ALL ON FUNCTION public.network_center_worker_list_connections_v1(
  text,integer
)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.network_center_worker_list_connections_v1(
  text,integer
)
  TO service_role;

REVOKE ALL ON FUNCTION public.network_center_list_aruba_v1(
  uuid,integer,uuid,integer
)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.network_center_list_aruba_v1(
  uuid,integer,uuid,integer
)
  TO service_role, authenticated;

REVOKE ALL ON FUNCTION public.network_center_list_clients_v1(
  uuid,timestamp with time zone,uuid,integer
)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.network_center_list_clients_v1(
  uuid,timestamp with time zone,uuid,integer
)
  TO service_role, authenticated;

REVOKE ALL ON FUNCTION app_private.network_center_worker_ingest_legacy_impl_v1(
  text,jsonb
)
  FROM PUBLIC, anon, authenticated, service_role;

-- Post-condition. Everything this migration claims to have preserved is read
-- back out of the catalog, and the repaired token is asserted live in each
-- body. A CREATE OR REPLACE that silently dropped SET search_path would
-- otherwise leave a SECURITY DEFINER function resolving names through the
-- caller's search_path.
DO $runtime_proof$
DECLARE
  v_pin record;
  v_secdef boolean;
  v_volatile "char";
  v_config text[];
  v_src text;
  v_role text;
BEGIN
  FOR v_pin IN
    SELECT *
    FROM (VALUES
      ('public.network_center_worker_list_connections_v2(text,integer)', 'v'::"char", ARRAY['search_path=pg_catalog']::text[], 'connection.management_ip::text', 'host(connection.management_ip)',
       ARRAY['service_role']::text[]),
      ('public.network_center_worker_list_connections_v1(text,integer)', 'v'::"char", ARRAY['search_path=pg_catalog']::text[], 'connection.management_ip::text', 'host(connection.management_ip)',
       ARRAY['service_role']::text[]),
      ('public.network_center_list_aruba_v1(uuid,integer,uuid,integer)', 's'::"char", ARRAY['search_path=pg_catalog, public, app_private']::text[], 'connection.management_ip::text', 'host(connection.management_ip)',
       ARRAY['service_role', 'authenticated']::text[]),
      ('public.network_center_list_clients_v1(uuid,timestamp with time zone,uuid,integer)', 's'::"char", ARRAY['search_path=pg_catalog, public, app_private']::text[], 'item.observed_ip::text', 'host(item.observed_ip)',
       ARRAY['service_role', 'authenticated']::text[]),
      ('app_private.network_center_worker_ingest_legacy_impl_v1(text,jsonb)', 'v'::"char", ARRAY['search_path=pg_catalog, public, app_private']::text[], 'jsonb_build_array("observedIp"::text)', 'jsonb_build_array(host("observedIp"))',
       ARRAY[]::text[])
    ) AS pin(signature, volatility, config, defect_token, fix_token, grantees)
  LOOP
    SELECT proc.prosecdef, proc.provolatile, proc.proconfig, proc.prosrc
    INTO v_secdef, v_volatile, v_config, v_src
    FROM pg_proc proc
    WHERE proc.oid = to_regprocedure(v_pin.signature);

    IF NOT FOUND
       OR v_secdef IS NOT TRUE
       OR v_volatile <> v_pin.volatility
       OR v_config IS DISTINCT FROM v_pin.config THEN
      RAISE EXCEPTION 'Definer profile of % regressed (secdef=%, volatile=%, config=%)',
        v_pin.signature, v_secdef, v_volatile, coalesce(v_config::text, '<null>')
        USING ERRCODE = '42501';
    END IF;

    IF position(v_pin.defect_token in v_src) <> 0 THEN
      RAISE EXCEPTION 'The inet cast % is still live in %',
        v_pin.defect_token, v_pin.signature
        USING ERRCODE = '22023';
    END IF;
    IF position(v_pin.fix_token in v_src) = 0 THEN
      RAISE EXCEPTION 'The repaired expression % is not in the live body of %',
        v_pin.fix_token, v_pin.signature
        USING ERRCODE = '22023';
    END IF;

    FOREACH v_role IN ARRAY ARRAY['public', 'anon', 'authenticated', 'service_role']
    LOOP
      IF has_function_privilege(v_role, v_pin.signature, 'EXECUTE')
         <> (v_role = ANY(v_pin.grantees)) THEN
        RAISE EXCEPTION 'Grant surface of % changed for role %',
          v_pin.signature, v_role
          USING ERRCODE = '42501';
      END IF;
    END LOOP;
  END LOOP;
END;
$runtime_proof$;

-- Fleet sweep, derived from the LIVE CATALOG rather than a hand-written list:
-- take every column in public/app_private whose declared type is inet or cidr
-- and refuse the migration if any live network_* function body still casts one
-- of them to text. An inet column added later is covered automatically, which a
-- literal token list would not be. macaddr is excluded deliberately --
-- macaddr_out and macaddr::text render identically, so that cast is correct.
DO $inet_cast_sweep$
DECLARE
  v_offender text;
BEGIN
  SELECT string_agg(DISTINCT offender.label, ', ' ORDER BY offender.label)
  INTO v_offender
  FROM (
    SELECT schema_row.nspname || '.' || function_row.proname
      || ' (' || address_column.attname || ')' AS label
    FROM pg_attribute address_column
    JOIN pg_class table_row ON table_row.oid = address_column.attrelid
    JOIN pg_namespace table_schema ON table_schema.oid = table_row.relnamespace
    CROSS JOIN LATERAL (
      SELECT proc.proname, proc.pronamespace
      FROM pg_proc proc
      WHERE proc.prosrc IS NOT NULL
        AND proc.proname LIKE 'network\\_%'
        AND proc.prosrc ~ ('(^|[^A-Za-z_0-9$"])' || address_column.attname || '::text')
    ) function_row
    JOIN pg_namespace schema_row ON schema_row.oid = function_row.pronamespace
    WHERE address_column.attnum > 0
      AND NOT address_column.attisdropped
      AND address_column.atttypid IN ('inet'::regtype, 'cidr'::regtype)
      AND table_schema.nspname IN ('public', 'app_private')
      AND table_row.relkind IN ('r', 'p', 'v', 'm')
      AND schema_row.nspname IN ('public', 'app_private')
  ) offender;
  IF v_offender IS NOT NULL THEN
    RAISE EXCEPTION
      'An inet/cidr column is still rendered through ::text in: %', v_offender
      USING ERRCODE = '22023';
  END IF;
END;
$inet_cast_sweep$;

-- The record-set field names below are declared inet inside a
-- jsonb_to_recordset() column definition list, so they are NOT catalog columns
-- and the sweep above cannot see them. They are checked literally. A wider
-- textual scan belongs in the repository scanner, where a false positive costs
-- an investigation instead of blocking a production rollout.
DO $recordset_cast_sweep$
DECLARE
  v_offender text;
BEGIN
  SELECT string_agg(
    schema_row.nspname || '.' || function_row.proname, ', '
    ORDER BY schema_row.nspname || '.' || function_row.proname
  )
  INTO v_offender
  FROM pg_proc function_row
  JOIN pg_namespace schema_row ON schema_row.oid = function_row.pronamespace
  WHERE schema_row.nspname IN ('public', 'app_private')
    AND function_row.proname LIKE 'network\\_%'
    AND function_row.prosrc IS NOT NULL
    AND function_row.prosrc ~ '"(observedIp|managementIp|managementAddress)"::text';
  IF v_offender IS NOT NULL THEN
    RAISE EXCEPTION
      'An inet record-set field is still rendered through ::text in: %', v_offender
      USING ERRCODE = '22023';
  END IF;
END;
$recordset_cast_sweep$;

COMMIT;

NOTIFY pgrst, 'reload schema';
