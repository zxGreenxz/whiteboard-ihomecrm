-- =============================================================================
-- Network Center additive forward-fix: a written row that stores nothing, and a
-- stored 0 that was never observed.
--
-- TWO DEFECTS, ONE WRITER. Both live in the `sampled` / client CTEs of
-- app_private.network_center_worker_ingest_legacy_impl_v1, and both were found
-- by reading production after the first sixteen clean poll cycles.
--
-- (1) network_interface_samples.sample was the LITERAL '{}'::jsonb.
--     Measured in production 2026-08-03: 128 sample rows written across 16
--     cycles, every one carrying observed_at and link_up and NOTHING else --
--     `rx_bps`, `tx_bps`, `utilization_pct` and all three delta columns NULL
--     because the worker emits none of them, and `sample` an empty object
--     because this function threw the counters away. The worker DOES send
--     rxBytes/txBytes/errorCount -- they are how network_interface_current
--     holds real, strictly increasing values -- and the interface recordset
--     already destructures them one CTE above. They simply had nowhere to land:
--     network_interface_samples has no counter column, and the jsonb payload
--     that exists for exactly that purpose was hard-coded empty.
--     CONSEQUENCE: the *current* view is correct and the *history* is empty, so
--     the only thing that can show a trend records that a cycle happened and
--     nothing about throughput. An empty {} also LOOKS like a written row,
--     which is why 128 of them survived a review that was looking for missing
--     rows.
--     The device branch six lines above already does this correctly
--     (jsonb_strip_nulls(jsonb_build_object(...))). This makes the interface
--     branch match it.
--
-- (2) network_client_current.rx_bytes/tx_bytes were NOT NULL DEFAULT 0 and the
--     writer coalesced the absent value to 0. So every client row asserted
--     zero traffic AS FACT.
--     MEASURED, not assumed: the worker's only client source is
--     /ip/dhcp-server/lease. On the demo hEX (RouterOS 7.20.8, read-only probe
--     2026-08-03) a lease record's complete key set is
--       .id, active-address, active-client-id, active-mac-address,
--       active-server, address, address-lists, age, blocked, class-id,
--       client-id, dhcp-option, disabled, dynamic, expires-after, host-name,
--       last-seen, mac-address, radius, server, status
--     -- twenty-one keys, not one of them a byte or packet counter. Every other
--     menu on this hardware that could carry a per-client counter is empty or
--     absent: /queue/simple 0, /queue/tree 0, /ip/kid-control/device 0,
--     /ip/hotspot/host 0, /ip/hotspot/active 0, /ppp/active 0,
--     /interface/wifi/registration-table 0, /interface/wireless -> syntax error
--     (package absent), /ip/accounting -> syntax error (removed in RouterOS 7).
--     The single exception is /ip/firewall/connection, which does carry
--     orig-bytes/repl-bytes -- and is NOT a per-client counter: entries are
--     ephemeral (timeouts of seconds; time-wait rows vanish), most flows are
--     fasttrack=true so conntrack stops accounting them after the handshake,
--     and 46 rows existed for ONE client. Summing it yields a quantity that
--     rises and collapses, while rx_bytes is consumed as a monotonic cumulative
--     counter (network_client_sessions keeps GREATEST(old, new)). Emitting it
--     would be a fabricated reading wearing a real number's clothes, which is
--     the same mistake as the nominalSpeedBps link-flap counter this branch
--     already paid for. So the columns become nullable and the writer stops
--     inventing a value.
--     CONSEQUENCE OF THE OLD SHAPE: "not observed" was not representable, and a
--     stored 0 manufactures a negative delta the moment a real reading arrives.
--     This is the same choice already made for network_interface_current.
--     error_count and network_interfaces.nominal_speed_bps, and the last place
--     on this branch where it had not been made.
--
-- WHY THIS IS SAFE TO MAKE NULLABLE. Swept from the LIVE catalog, not from the
-- repository: rx_bytes/tx_bytes on these two tables are referenced by exactly
-- ONE function body in public+app_private (this one, the writer) and by ZERO
-- views. No reader has a NOT NULL assumption to break. The generated type file
-- src/integrations/supabase/types.ts still declares them non-nullable and will
-- drift until regenerated; no TypeScript in the repository reads either column,
-- so nothing breaks in the meantime.
--
-- BACKFILL. network_client_current/network_client_sessions rows whose rx_bytes
-- AND tx_bytes are both exactly 0 are nulled: the writer never had a value to
-- store, so a (0,0) pair can only be the coalesce. A row with either value
-- non-zero could only have come from a real reading and is left alone.
-- network_interface_samples is NOT backfilled and cannot be -- the table is
-- append-only (network_interface_samples_append_only rejects UPDATE and DELETE)
-- -- and should not be: those 128 rows genuinely recorded nothing, and
-- inventing counters for them would be the defect this migration removes.
--
-- Nothing else about the function changes. Signature, RETURNS type, LANGUAGE,
-- volatility, SECURITY DEFINER, the pinned search_path and the exact (empty)
-- grant surface are re-declared as production is measured to have them and
-- asserted back out of the catalog below. The body is the reviewed body from
-- 20260729145000 with three expressions replaced and no other edit.
-- =============================================================================

BEGIN;

SELECT pg_advisory_xact_lock(20260729147000::bigint);

-- Fail closed rather than replace something other than what was reviewed. Each
-- defect token below must still be LIVE: if a previous migration already fixed
-- one of them, this file is stale and must not overwrite the newer body.
DO $preflight$
DECLARE
  v_signature constant text :=
    'app_private.network_center_worker_ingest_legacy_impl_v1(text,jsonb)';
  v_secdef boolean;
  v_volatile "char";
  v_config text[];
  v_src text;
  v_token text;
  v_column record;
BEGIN
  IF to_regprocedure(v_signature) IS NULL THEN
    RAISE EXCEPTION '% is missing', v_signature USING ERRCODE = '42883';
  END IF;

  -- Identify by OID. pg_get_function_identity_arguments() renders parameter
  -- NAMES as well, so comparing it against a type list matches nothing and
  -- every assertion below it becomes vacuous.
  SELECT proc.prosecdef, proc.provolatile, proc.proconfig, proc.prosrc
  INTO v_secdef, v_volatile, v_config, v_src
  FROM pg_proc proc
  WHERE proc.oid = to_regprocedure(v_signature);

  IF v_secdef IS NOT TRUE THEN
    RAISE EXCEPTION '% lost SECURITY DEFINER before the fix', v_signature
      USING ERRCODE = '42501';
  END IF;
  IF v_volatile <> 'v' THEN
    RAISE EXCEPTION '% volatility is %, not the pinned v', v_signature, v_volatile
      USING ERRCODE = '42501';
  END IF;
  IF v_config IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, app_private']::text[] THEN
    RAISE EXCEPTION '% proconfig is %, not the pinned search_path',
      v_signature, coalesce(v_config::text, '<null>')
      USING ERRCODE = '42501';
  END IF;

  FOREACH v_token IN ARRAY ARRAY[
    '"errorDelta", "discardDelta", "queueDropDelta", ''{}''::jsonb',
    '"roomHint", "signalDbm", coalesce("rxBytes", 0), coalesce("txBytes", 0)',
    'coalesce("rxBytes", 0), coalesce("txBytes", 0)'
  ]
  LOOP
    IF position(v_token in v_src) = 0 THEN
      RAISE EXCEPTION
        'The reviewed pre-image of % no longer contains %; this migration is stale',
        v_signature, v_token
        USING ERRCODE = '22023';
    END IF;
  END LOOP;

  -- The columns must still be in the shape this migration was written against.
  FOR v_column IN
    SELECT *
    FROM (VALUES
      ('public.network_client_current', 'rx_bytes'),
      ('public.network_client_current', 'tx_bytes'),
      ('public.network_client_sessions', 'rx_bytes'),
      ('public.network_client_sessions', 'tx_bytes')
    ) AS pin(relation, column_name)
  LOOP
    IF to_regclass(v_column.relation) IS NULL THEN
      RAISE EXCEPTION 'Relation % is missing', v_column.relation
        USING ERRCODE = '42P01';
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM pg_attribute attribute
      WHERE attribute.attrelid = to_regclass(v_column.relation)
        AND attribute.attname = v_column.column_name
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
        AND attribute.attnotnull
    ) THEN
      RAISE EXCEPTION
        '%.% is already nullable; this migration is stale',
        v_column.relation, v_column.column_name
        USING ERRCODE = '22023';
    END IF;
  END LOOP;

  IF to_regclass('public.network_interface_samples') IS NULL THEN
    RAISE EXCEPTION 'Relation public.network_interface_samples is missing'
      USING ERRCODE = '42P01';
  END IF;
END;
$preflight$;

-- ---------------------------------------------------------------------------
-- 1. Make "not observed" representable.
--
-- The CHECK is restated rather than left alone. `rx_bytes >= 0` already ADMITS
-- NULL (NULL >= 0 is NULL, and a CHECK passes on anything that is not FALSE),
-- so this changes no behaviour -- but a reader should not have to re-derive
-- three-valued logic to answer "is NULL allowed here?". DROP and ADD are in one
-- ALTER statement so the table is never momentarily unconstrained.
-- ---------------------------------------------------------------------------
ALTER TABLE public.network_client_current
  ALTER COLUMN rx_bytes DROP NOT NULL,
  ALTER COLUMN rx_bytes DROP DEFAULT,
  ALTER COLUMN tx_bytes DROP NOT NULL,
  ALTER COLUMN tx_bytes DROP DEFAULT,
  DROP CONSTRAINT network_client_current_traffic_check,
  ADD CONSTRAINT network_client_current_traffic_check
    CHECK (
      (rx_bytes IS NULL OR rx_bytes >= 0)
      AND (tx_bytes IS NULL OR tx_bytes >= 0)
    );

ALTER TABLE public.network_client_sessions
  ALTER COLUMN rx_bytes DROP NOT NULL,
  ALTER COLUMN rx_bytes DROP DEFAULT,
  ALTER COLUMN tx_bytes DROP NOT NULL,
  ALTER COLUMN tx_bytes DROP DEFAULT,
  DROP CONSTRAINT network_client_sessions_traffic_check,
  ADD CONSTRAINT network_client_sessions_traffic_check
    CHECK (
      (rx_bytes IS NULL OR rx_bytes >= 0)
      AND (tx_bytes IS NULL OR tx_bytes >= 0)
    );

-- ---------------------------------------------------------------------------
-- 2. Retire the zeros that were never observed.
--
-- Only the (0, 0) pair, which is the coalesce's own signature. Either value
-- non-zero could only have come from a real reading and is preserved.
-- ---------------------------------------------------------------------------
UPDATE public.network_client_current
SET rx_bytes = NULL, tx_bytes = NULL
WHERE rx_bytes = 0 AND tx_bytes = 0;

UPDATE public.network_client_sessions
SET rx_bytes = NULL, tx_bytes = NULL
WHERE rx_bytes = 0 AND tx_bytes = 0;

-- ---------------------------------------------------------------------------
-- 3. The writer.
--
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
      "errorDelta", "discardDelta", "queueDropDelta",
      -- The counters, which have no column of their own on this table and
      -- were previously DISCARDED here: the literal '{}'::jsonb wrote 128
      -- rows carrying observed_at, link_up and nothing else, so the raw
      -- counters existed only in the _current upsert and the time series
      -- recorded THAT a cycle happened and nothing about throughput.
      -- jsonb_strip_nulls, exactly as the device branch above: a counter
      -- the router did not report is ABSENT, never a fabricated 0. The
      -- object is never empty, because linkState is always present, so a
      -- future '{}' is a defect and not a quiet cycle.
      jsonb_strip_nulls(jsonb_build_object(
        'linkState', coalesce("linkState", 'UNKNOWN'),
        'rxBytes', "rxBytes", 'txBytes', "txBytes",
        'errorCount', "errorCount", 'discardCount', "discardCount",
        'queueDropCount', "queueDropCount"
      ))
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
      -- NOT coalesce(..., 0). The worker emits no client byte counters at
      -- all (a DHCP lease record carries none -- measured on the demo hEX,
      -- RouterOS 7.20.8: /ip/dhcp-server/lease/get returns 21 keys and not
      -- one of them is a byte or packet count), so every 0 this wrote was
      -- the coalesce and not an observation. NULL is now representable and
      -- means exactly "not observed".
      "roomHint", "signalDbm", "rxBytes", "txBytes",
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
      "rxBytes", "txBytes"
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
REVOKE ALL ON FUNCTION app_private.network_center_worker_ingest_legacy_impl_v1(
  text,jsonb
)
  FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Post-condition. Everything this migration claims is read back out of the
-- catalog. A CREATE OR REPLACE that silently dropped SET search_path would
-- otherwise leave a SECURITY DEFINER function resolving names through the
-- caller's search_path.
-- ---------------------------------------------------------------------------
DO $runtime_proof$
DECLARE
  v_signature constant text :=
    'app_private.network_center_worker_ingest_legacy_impl_v1(text,jsonb)';
  v_secdef boolean;
  v_volatile "char";
  v_config text[];
  v_src text;
  v_token text;
  v_role text;
  v_column record;
  v_definition text;
BEGIN
  SELECT proc.prosecdef, proc.provolatile, proc.proconfig, proc.prosrc
  INTO v_secdef, v_volatile, v_config, v_src
  FROM pg_proc proc
  WHERE proc.oid = to_regprocedure(v_signature);

  IF NOT FOUND
     OR v_secdef IS NOT TRUE
     OR v_volatile <> 'v'
     OR v_config IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, app_private']::text[] THEN
    RAISE EXCEPTION 'Definer profile of % regressed (secdef=%, volatile=%, config=%)',
      v_signature, v_secdef, v_volatile, coalesce(v_config::text, '<null>')
      USING ERRCODE = '42501';
  END IF;

  FOREACH v_token IN ARRAY ARRAY[
    '"errorDelta", "discardDelta", "queueDropDelta", ''{}''::jsonb',
    'coalesce("rxBytes", 0)',
    'coalesce("txBytes", 0)'
  ]
  LOOP
    IF position(v_token in v_src) <> 0 THEN
      RAISE EXCEPTION 'The discarded-counter expression % is still live in %',
        v_token, v_signature
        USING ERRCODE = '22023';
    END IF;
  END LOOP;

  FOREACH v_token IN ARRAY ARRAY[
    '''rxBytes'', "rxBytes", ''txBytes'', "txBytes"',
    '''errorCount'', "errorCount", ''discardCount'', "discardCount"',
    '"roomHint", "signalDbm", "rxBytes", "txBytes"'
  ]
  LOOP
    IF position(v_token in v_src) = 0 THEN
      RAISE EXCEPTION 'The repaired expression % is not in the live body of %',
        v_token, v_signature
        USING ERRCODE = '22023';
    END IF;
  END LOOP;

  FOREACH v_role IN ARRAY ARRAY['public', 'anon', 'authenticated', 'service_role']
  LOOP
    IF has_function_privilege(v_role, v_signature, 'EXECUTE') THEN
      RAISE EXCEPTION 'Grant surface of % changed for role %', v_signature, v_role
        USING ERRCODE = '42501';
    END IF;
  END LOOP;

  -- The columns, read back rather than assumed.
  FOR v_column IN
    SELECT *
    FROM (VALUES
      ('public.network_client_current', 'rx_bytes'),
      ('public.network_client_current', 'tx_bytes'),
      ('public.network_client_sessions', 'rx_bytes'),
      ('public.network_client_sessions', 'tx_bytes')
    ) AS pin(relation, column_name)
  LOOP
    IF EXISTS (
      SELECT 1
      FROM pg_attribute attribute
      WHERE attribute.attrelid = to_regclass(v_column.relation)
        AND attribute.attname = v_column.column_name
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
        AND (attribute.attnotnull OR attribute.atthasdef)
    ) THEN
      RAISE EXCEPTION
        '%.% is still NOT NULL or still carries a default, so an unobserved counter is not representable',
        v_column.relation, v_column.column_name
        USING ERRCODE = '22023';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.network_client_current entry
      WHERE v_column.relation = 'public.network_client_current'
        AND entry.rx_bytes = 0 AND entry.tx_bytes = 0
    ) OR EXISTS (
      SELECT 1 FROM public.network_client_sessions entry
      WHERE v_column.relation = 'public.network_client_sessions'
        AND entry.rx_bytes = 0 AND entry.tx_bytes = 0
    ) THEN
      RAISE EXCEPTION 'A fabricated (0, 0) counter pair survived the backfill in %',
        v_column.relation
        USING ERRCODE = '22023';
    END IF;
  END LOOP;

  -- And the restated CHECKs really do name NULL, so a future reader does not
  -- have to re-derive three-valued logic to know an unobserved counter is legal.
  FOR v_column IN
    SELECT *
    FROM (VALUES
      ('public.network_client_current', 'network_client_current_traffic_check'),
      ('public.network_client_sessions', 'network_client_sessions_traffic_check')
    ) AS pin(relation, constraint_name)
  LOOP
    SELECT pg_get_constraintdef(constraint_row.oid) INTO v_definition
    FROM pg_constraint constraint_row
    WHERE constraint_row.conrelid = to_regclass(v_column.relation)
      AND constraint_row.conname = v_column.constraint_name;
    IF v_definition IS NULL
       OR position('rx_bytes IS NULL' in v_definition) = 0
       OR position('tx_bytes IS NULL' in v_definition) = 0 THEN
      RAISE EXCEPTION '% does not admit an unobserved counter: %',
        v_column.constraint_name, coalesce(v_definition, '<missing>')
        USING ERRCODE = '22023';
    END IF;
  END LOOP;
END;
$runtime_proof$;

-- Fleet sweep, derived from the LIVE CATALOG rather than a hand-written list:
-- no network_* function body anywhere in public/app_private may coalesce a byte
-- counter to zero, and none may write the empty-object literal into a sample
-- payload column. A future function that reintroduces either shape is refused
-- here rather than discovered by reading production a third time.
--
-- COMMENTS ARE STRIPPED FIRST, and that is not cosmetic: pg_proc.prosrc keeps
-- them, so the first draft of this sweep flagged THIS migration because the
-- comment above the repaired expression quotes the defect it removed. A sweep
-- that cannot tell code from prose either blocks every fix that documents
-- itself or gets softened until it matches nothing. Stripping can in
-- principle hide a defect written after a comment marker on the same line; that
-- is accepted, because the shapes being hunted are whole expressions on their
-- own lines and a trailing-comment false NEGATIVE is cheaper than a
-- prose-matching false positive that teaches people to stop explaining fixes.
DO $counter_honesty_sweep$
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
    AND function_row.proname LIKE 'network\_%'
    AND function_row.prosrc IS NOT NULL
    AND regexp_replace(function_row.prosrc, '--[^\n]*', '', 'g')
          ~ 'coalesce\("(rx|tx)Bytes", 0\)';
  IF v_offender IS NOT NULL THEN
    RAISE EXCEPTION
      'A byte counter is still coalesced to a fabricated zero in: %', v_offender
      USING ERRCODE = '22023';
  END IF;

  SELECT string_agg(
    schema_row.nspname || '.' || function_row.proname, ', '
    ORDER BY schema_row.nspname || '.' || function_row.proname
  )
  INTO v_offender
  FROM pg_proc function_row
  JOIN pg_namespace schema_row ON schema_row.oid = function_row.pronamespace
  WHERE schema_row.nspname IN ('public', 'app_private')
    AND function_row.proname LIKE 'network\_%'
    AND function_row.prosrc IS NOT NULL
    AND regexp_replace(function_row.prosrc, '--[^\n]*', '', 'g')
          ~ 'INSERT INTO public\.network_(device|interface)_samples'
    AND regexp_replace(function_row.prosrc, '--[^\n]*', '', 'g')
          ~ '''\{\}''::jsonb';
  IF v_offender IS NOT NULL THEN
    RAISE EXCEPTION
      'A telemetry sample payload is still written as an empty object in: %', v_offender
      USING ERRCODE = '22023';
  END IF;
END;
$counter_honesty_sweep$;

COMMIT;

NOTIFY pgrst, 'reload schema';
