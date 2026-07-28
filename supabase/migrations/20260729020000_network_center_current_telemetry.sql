-- =============================================================================
-- Network Center 2/4: current projections, client history, partitioned raw
-- telemetry, repeat-safe rollups, and locked Hybrid A+ retention.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.network_device_current (
  device_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  building_id uuid NOT NULL,
  observed_at timestamptz NOT NULL,
  last_seen_at timestamptz,
  reachable boolean NOT NULL DEFAULT false,
  health_status text NOT NULL DEFAULT 'UNKNOWN',
  identity_name text,
  routeros_version text,
  uptime_seconds bigint,
  cpu_pct numeric(5,2),
  memory_used_bytes bigint,
  memory_total_bytes bigint,
  disk_used_bytes bigint,
  disk_total_bytes bigint,
  temperature_c numeric(7,2),
  voltage_v numeric(7,3),
  pppoe_state text NOT NULL DEFAULT 'UNKNOWN',
  connection_count integer,
  latency_ms numeric(10,3),
  packet_loss_pct numeric(5,2),
  last_error_code text,
  update_seq bigint NOT NULL DEFAULT 1,
  CONSTRAINT network_device_current_org_building_fk
    FOREIGN KEY (organization_id, building_id)
    REFERENCES public.buildings(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT network_device_current_device_fk
    FOREIGN KEY (organization_id, building_id, device_id)
    REFERENCES public.network_devices(organization_id, building_id, id) ON DELETE CASCADE,
  CONSTRAINT network_device_current_health_check
    CHECK (health_status IN ('UNKNOWN', 'HEALTHY', 'DEGRADED', 'CRITICAL', 'OFFLINE')),
  CONSTRAINT network_device_current_time_check
    CHECK (last_seen_at IS NULL OR last_seen_at <= observed_at),
  CONSTRAINT network_device_current_uptime_check
    CHECK (uptime_seconds IS NULL OR uptime_seconds >= 0),
  CONSTRAINT network_device_current_cpu_check
    CHECK (cpu_pct IS NULL OR cpu_pct BETWEEN 0 AND 100),
  CONSTRAINT network_device_current_memory_check
    CHECK (
      (memory_used_bytes IS NULL OR memory_used_bytes >= 0)
      AND (memory_total_bytes IS NULL OR memory_total_bytes >= 0)
      AND (memory_used_bytes IS NULL OR memory_total_bytes IS NULL OR memory_used_bytes <= memory_total_bytes)
    ),
  CONSTRAINT network_device_current_disk_check
    CHECK (
      (disk_used_bytes IS NULL OR disk_used_bytes >= 0)
      AND (disk_total_bytes IS NULL OR disk_total_bytes >= 0)
      AND (disk_used_bytes IS NULL OR disk_total_bytes IS NULL OR disk_used_bytes <= disk_total_bytes)
    ),
  CONSTRAINT network_device_current_temperature_check
    CHECK (temperature_c IS NULL OR temperature_c BETWEEN -80 AND 250),
  CONSTRAINT network_device_current_voltage_check
    CHECK (voltage_v IS NULL OR voltage_v BETWEEN 0 AND 1000),
  CONSTRAINT network_device_current_pppoe_check
    CHECK (pppoe_state IN ('UNKNOWN', 'UP', 'DOWN', 'NOT_APPLICABLE')),
  CONSTRAINT network_device_current_connections_check
    CHECK (connection_count IS NULL OR connection_count >= 0),
  CONSTRAINT network_device_current_latency_check
    CHECK (latency_ms IS NULL OR latency_ms BETWEEN 0 AND 600000),
  CONSTRAINT network_device_current_loss_check
    CHECK (packet_loss_pct IS NULL OR packet_loss_pct BETWEEN 0 AND 100),
  CONSTRAINT network_device_current_seq_check
    CHECK (update_seq > 0),
  UNIQUE (organization_id, building_id, device_id)
);

CREATE INDEX IF NOT EXISTS network_device_current_building_idx
  ON public.network_device_current (organization_id, building_id, health_status, observed_at DESC, device_id);

CREATE TABLE IF NOT EXISTS public.network_interface_current (
  interface_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  building_id uuid NOT NULL,
  device_id uuid NOT NULL,
  observed_at timestamptz NOT NULL,
  link_state text NOT NULL DEFAULT 'UNKNOWN',
  rx_bps numeric(20,2),
  tx_bps numeric(20,2),
  utilization_pct numeric(7,3),
  rx_bytes bigint,
  tx_bytes bigint,
  error_count bigint,
  discard_count bigint,
  queue_drop_count bigint,
  update_seq bigint NOT NULL DEFAULT 1,
  CONSTRAINT network_interface_current_org_building_fk
    FOREIGN KEY (organization_id, building_id)
    REFERENCES public.buildings(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT network_interface_current_device_fk
    FOREIGN KEY (organization_id, building_id, device_id)
    REFERENCES public.network_devices(organization_id, building_id, id) ON DELETE CASCADE,
  CONSTRAINT network_interface_current_interface_fk
    FOREIGN KEY (organization_id, building_id, device_id, interface_id)
    REFERENCES public.network_interfaces(organization_id, building_id, device_id, id) ON DELETE CASCADE,
  CONSTRAINT network_interface_current_link_check
    CHECK (link_state IN ('UNKNOWN', 'UP', 'DOWN')),
  CONSTRAINT network_interface_current_rate_check
    CHECK ((rx_bps IS NULL OR rx_bps >= 0) AND (tx_bps IS NULL OR tx_bps >= 0)),
  CONSTRAINT network_interface_current_utilization_check
    CHECK (utilization_pct IS NULL OR utilization_pct BETWEEN 0 AND 100),
  CONSTRAINT network_interface_current_counters_check
    CHECK (
      (rx_bytes IS NULL OR rx_bytes >= 0)
      AND (tx_bytes IS NULL OR tx_bytes >= 0)
      AND (error_count IS NULL OR error_count >= 0)
      AND (discard_count IS NULL OR discard_count >= 0)
      AND (queue_drop_count IS NULL OR queue_drop_count >= 0)
    ),
  CONSTRAINT network_interface_current_seq_check
    CHECK (update_seq > 0),
  UNIQUE (organization_id, building_id, device_id, interface_id)
);

CREATE INDEX IF NOT EXISTS network_interface_current_building_idx
  ON public.network_interface_current (organization_id, building_id, device_id, link_state, observed_at DESC, interface_id);

CREATE TABLE IF NOT EXISTS public.network_client_current (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  building_id uuid NOT NULL,
  device_id uuid NOT NULL,
  interface_id uuid,
  session_key text NOT NULL,
  client_fingerprint text NOT NULL,
  observed_mac macaddr,
  observed_ip inet,
  hostname text,
  connection_type text NOT NULL DEFAULT 'UNKNOWN',
  room_hint text,
  signal_dbm integer,
  rx_bytes bigint NOT NULL DEFAULT 0,
  tx_bytes bigint NOT NULL DEFAULT 0,
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  observed_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  update_seq bigint NOT NULL DEFAULT 1,
  CONSTRAINT network_client_current_org_building_fk
    FOREIGN KEY (organization_id, building_id)
    REFERENCES public.buildings(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT network_client_current_device_fk
    FOREIGN KEY (organization_id, building_id, device_id)
    REFERENCES public.network_devices(organization_id, building_id, id) ON DELETE CASCADE,
  CONSTRAINT network_client_current_interface_fk
    FOREIGN KEY (organization_id, building_id, device_id, interface_id)
    REFERENCES public.network_interfaces(organization_id, building_id, device_id, id) ON DELETE RESTRICT,
  CONSTRAINT network_client_current_session_check
    CHECK (char_length(btrim(session_key)) BETWEEN 8 AND 200),
  CONSTRAINT network_client_current_fingerprint_check
    CHECK (char_length(btrim(client_fingerprint)) BETWEEN 8 AND 200),
  CONSTRAINT network_client_current_hostname_check
    CHECK (hostname IS NULL OR char_length(hostname) <= 255),
  CONSTRAINT network_client_current_type_check
    CHECK (connection_type IN ('UNKNOWN', 'ETHERNET', 'WIFI', 'VPN')),
  CONSTRAINT network_client_current_signal_check
    CHECK (signal_dbm IS NULL OR signal_dbm BETWEEN -150 AND 20),
  CONSTRAINT network_client_current_traffic_check
    CHECK (rx_bytes >= 0 AND tx_bytes >= 0),
  CONSTRAINT network_client_current_time_check
    CHECK (
      first_seen_at <= last_seen_at
      AND last_seen_at <= observed_at
      AND expires_at > last_seen_at
    ),
  CONSTRAINT network_client_current_seq_check
    CHECK (update_seq > 0),
  UNIQUE (organization_id, building_id, session_key)
);

CREATE INDEX IF NOT EXISTS network_client_current_building_cursor_idx
  ON public.network_client_current (organization_id, building_id, last_seen_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS network_client_current_expiry_idx
  ON public.network_client_current (expires_at, organization_id, building_id);

CREATE INDEX IF NOT EXISTS network_client_current_fingerprint_idx
  ON public.network_client_current (organization_id, building_id, client_fingerprint, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS public.network_client_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  building_id uuid NOT NULL,
  device_id uuid NOT NULL,
  interface_id uuid,
  session_key text NOT NULL,
  client_fingerprint text NOT NULL,
  observed_mac macaddr,
  address_history jsonb NOT NULL DEFAULT '[]'::jsonb,
  hostname text,
  connection_type text NOT NULL DEFAULT 'UNKNOWN',
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  ended_at timestamptz,
  rx_bytes bigint NOT NULL DEFAULT 0,
  tx_bytes bigint NOT NULL DEFAULT 0,
  safe_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT network_client_sessions_org_building_fk
    FOREIGN KEY (organization_id, building_id)
    REFERENCES public.buildings(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT network_client_sessions_device_fk
    FOREIGN KEY (organization_id, building_id, device_id)
    REFERENCES public.network_devices(organization_id, building_id, id) ON DELETE RESTRICT,
  CONSTRAINT network_client_sessions_interface_fk
    FOREIGN KEY (organization_id, building_id, device_id, interface_id)
    REFERENCES public.network_interfaces(organization_id, building_id, device_id, id) ON DELETE RESTRICT,
  CONSTRAINT network_client_sessions_session_check
    CHECK (char_length(btrim(session_key)) BETWEEN 8 AND 200),
  CONSTRAINT network_client_sessions_fingerprint_check
    CHECK (char_length(btrim(client_fingerprint)) BETWEEN 8 AND 200),
  CONSTRAINT network_client_sessions_address_array_check
    CHECK (jsonb_typeof(address_history) = 'array'),
  CONSTRAINT network_client_sessions_metadata_object_check
    CHECK (jsonb_typeof(safe_metadata) = 'object'),
  CONSTRAINT network_client_sessions_type_check
    CHECK (connection_type IN ('UNKNOWN', 'ETHERNET', 'WIFI', 'VPN')),
  CONSTRAINT network_client_sessions_time_check
    CHECK (first_seen_at <= last_seen_at AND (ended_at IS NULL OR ended_at >= last_seen_at)),
  CONSTRAINT network_client_sessions_traffic_check
    CHECK (rx_bytes >= 0 AND tx_bytes >= 0),
  UNIQUE (organization_id, building_id, session_key)
);

CREATE INDEX IF NOT EXISTS network_client_sessions_building_cursor_idx
  ON public.network_client_sessions (organization_id, building_id, first_seen_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS network_client_sessions_fingerprint_idx
  ON public.network_client_sessions (organization_id, building_id, client_fingerprint, first_seen_at DESC);

CREATE TABLE IF NOT EXISTS public.network_client_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  building_id uuid NOT NULL,
  client_fingerprint text NOT NULL,
  room_id uuid,
  contract_id uuid,
  customer_id uuid,
  source text NOT NULL,
  confidence numeric(5,4) NOT NULL,
  valid_from timestamptz NOT NULL,
  valid_to timestamptz,
  linked_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT network_client_links_org_building_fk
    FOREIGN KEY (organization_id, building_id)
    REFERENCES public.buildings(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT network_client_links_room_fk
    FOREIGN KEY (organization_id, room_id)
    REFERENCES public.rooms(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT network_client_links_contract_fk
    FOREIGN KEY (organization_id, contract_id)
    REFERENCES public.contracts(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT network_client_links_customer_fk
    FOREIGN KEY (organization_id, customer_id)
    REFERENCES public.customers(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT network_client_links_fingerprint_check
    CHECK (char_length(btrim(client_fingerprint)) BETWEEN 8 AND 200),
  CONSTRAINT network_client_links_target_check
    CHECK (room_id IS NOT NULL OR contract_id IS NOT NULL OR customer_id IS NOT NULL),
  CONSTRAINT network_client_links_source_check
    CHECK (source IN ('MANUAL', 'LEASE', 'HOSTNAME', 'IMPORT', 'AUTOMATION')),
  CONSTRAINT network_client_links_confidence_check
    CHECK (confidence BETWEEN 0 AND 1),
  CONSTRAINT network_client_links_time_check
    CHECK (valid_to IS NULL OR valid_to > valid_from),
  UNIQUE (organization_id, id)
);

CREATE INDEX IF NOT EXISTS network_client_links_building_fingerprint_idx
  ON public.network_client_links (organization_id, building_id, client_fingerprint, valid_from DESC, id DESC);

CREATE INDEX IF NOT EXISTS network_client_links_room_idx
  ON public.network_client_links (organization_id, room_id, valid_from DESC)
  WHERE room_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS network_client_links_contract_idx
  ON public.network_client_links (organization_id, contract_id, valid_from DESC)
  WHERE contract_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS network_client_links_customer_idx
  ON public.network_client_links (organization_id, customer_id, valid_from DESC)
  WHERE customer_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.network_device_samples (
  organization_id uuid NOT NULL,
  building_id uuid NOT NULL,
  device_id uuid NOT NULL,
  observed_at timestamptz NOT NULL,
  reachable boolean NOT NULL,
  latency_ms numeric(10,3),
  packet_loss_pct numeric(5,2),
  cpu_pct numeric(5,2),
  memory_used_pct numeric(5,2),
  temperature_c numeric(7,2),
  voltage_v numeric(7,3),
  connection_count integer,
  sample jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT network_device_samples_org_building_fk
    FOREIGN KEY (organization_id, building_id)
    REFERENCES public.buildings(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT network_device_samples_device_fk
    FOREIGN KEY (organization_id, building_id, device_id)
    REFERENCES public.network_devices(organization_id, building_id, id) ON DELETE RESTRICT,
  CONSTRAINT network_device_samples_latency_check
    CHECK (latency_ms IS NULL OR latency_ms BETWEEN 0 AND 600000),
  CONSTRAINT network_device_samples_percent_check
    CHECK (
      (packet_loss_pct IS NULL OR packet_loss_pct BETWEEN 0 AND 100)
      AND (cpu_pct IS NULL OR cpu_pct BETWEEN 0 AND 100)
      AND (memory_used_pct IS NULL OR memory_used_pct BETWEEN 0 AND 100)
    ),
  CONSTRAINT network_device_samples_temperature_check
    CHECK (temperature_c IS NULL OR temperature_c BETWEEN -80 AND 250),
  CONSTRAINT network_device_samples_voltage_check
    CHECK (voltage_v IS NULL OR voltage_v BETWEEN 0 AND 1000),
  CONSTRAINT network_device_samples_connections_check
    CHECK (connection_count IS NULL OR connection_count >= 0),
  CONSTRAINT network_device_samples_payload_check
    CHECK (jsonb_typeof(sample) = 'object'),
  PRIMARY KEY (device_id, observed_at)
) PARTITION BY RANGE (observed_at);

CREATE INDEX IF NOT EXISTS network_device_samples_building_time_idx
  ON public.network_device_samples (organization_id, building_id, observed_at DESC, device_id);

CREATE TABLE IF NOT EXISTS public.network_interface_samples (
  organization_id uuid NOT NULL,
  building_id uuid NOT NULL,
  device_id uuid NOT NULL,
  interface_id uuid NOT NULL,
  observed_at timestamptz NOT NULL,
  link_up boolean NOT NULL,
  rx_bps numeric(20,2),
  tx_bps numeric(20,2),
  utilization_pct numeric(7,3),
  error_delta bigint,
  discard_delta bigint,
  queue_drop_delta bigint,
  sample jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT network_interface_samples_org_building_fk
    FOREIGN KEY (organization_id, building_id)
    REFERENCES public.buildings(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT network_interface_samples_device_fk
    FOREIGN KEY (organization_id, building_id, device_id)
    REFERENCES public.network_devices(organization_id, building_id, id) ON DELETE RESTRICT,
  CONSTRAINT network_interface_samples_interface_fk
    FOREIGN KEY (organization_id, building_id, device_id, interface_id)
    REFERENCES public.network_interfaces(organization_id, building_id, device_id, id) ON DELETE RESTRICT,
  CONSTRAINT network_interface_samples_rate_check
    CHECK ((rx_bps IS NULL OR rx_bps >= 0) AND (tx_bps IS NULL OR tx_bps >= 0)),
  CONSTRAINT network_interface_samples_utilization_check
    CHECK (utilization_pct IS NULL OR utilization_pct BETWEEN 0 AND 100),
  CONSTRAINT network_interface_samples_delta_check
    CHECK (
      (error_delta IS NULL OR error_delta >= 0)
      AND (discard_delta IS NULL OR discard_delta >= 0)
      AND (queue_drop_delta IS NULL OR queue_drop_delta >= 0)
    ),
  CONSTRAINT network_interface_samples_payload_check
    CHECK (jsonb_typeof(sample) = 'object'),
  PRIMARY KEY (interface_id, observed_at)
) PARTITION BY RANGE (observed_at);

CREATE INDEX IF NOT EXISTS network_interface_samples_building_time_idx
  ON public.network_interface_samples (organization_id, building_id, observed_at DESC, interface_id);

CREATE TABLE IF NOT EXISTS public.network_metric_hourly (
  organization_id uuid NOT NULL,
  building_id uuid NOT NULL,
  series_kind text NOT NULL,
  series_id uuid NOT NULL,
  metric_name text NOT NULL,
  bucket_hour timestamptz NOT NULL,
  unit text NOT NULL,
  sample_count bigint NOT NULL,
  min_value numeric,
  max_value numeric,
  avg_value numeric,
  p95_value numeric,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT network_metric_hourly_org_building_fk
    FOREIGN KEY (organization_id, building_id)
    REFERENCES public.buildings(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT network_metric_hourly_kind_check
    CHECK (series_kind IN ('DEVICE', 'INTERFACE')),
  CONSTRAINT network_metric_hourly_name_check
    CHECK (metric_name ~ '^[a-z][a-z0-9_]{1,63}$'),
  CONSTRAINT network_metric_hourly_unit_check
    CHECK (char_length(unit) BETWEEN 1 AND 32),
  CONSTRAINT network_metric_hourly_count_check
    CHECK (sample_count > 0),
  PRIMARY KEY (organization_id, building_id, series_kind, series_id, metric_name, bucket_hour)
);

CREATE INDEX IF NOT EXISTS network_metric_hourly_building_time_idx
  ON public.network_metric_hourly (organization_id, building_id, bucket_hour DESC, metric_name, series_id);

CREATE TABLE IF NOT EXISTS public.network_sla_daily (
  organization_id uuid NOT NULL,
  building_id uuid NOT NULL,
  sla_day date NOT NULL,
  sample_count bigint NOT NULL,
  total_seconds bigint NOT NULL DEFAULT 86400,
  excluded_maintenance_seconds bigint NOT NULL DEFAULT 0,
  eligible_seconds bigint NOT NULL DEFAULT 86400,
  uptime_seconds bigint NOT NULL,
  outage_seconds bigint NOT NULL,
  uptime_pct numeric(7,4) NOT NULL,
  incident_count integer NOT NULL DEFAULT 0,
  mttr_seconds numeric(14,2),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT network_sla_daily_org_building_fk
    FOREIGN KEY (organization_id, building_id)
    REFERENCES public.buildings(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT network_sla_daily_counts_check
    CHECK (sample_count > 0 AND incident_count >= 0),
  CONSTRAINT network_sla_daily_seconds_check
    CHECK (
      total_seconds BETWEEN 1 AND 86400
      AND excluded_maintenance_seconds BETWEEN 0 AND total_seconds
      AND eligible_seconds = total_seconds - excluded_maintenance_seconds
      AND uptime_seconds BETWEEN 0 AND eligible_seconds
      AND outage_seconds = eligible_seconds - uptime_seconds
    ),
  CONSTRAINT network_sla_daily_pct_check
    CHECK (uptime_pct BETWEEN 0 AND 100),
  CONSTRAINT network_sla_daily_mttr_check
    CHECK (mttr_seconds IS NULL OR mttr_seconds >= 0),
  PRIMARY KEY (organization_id, building_id, sla_day)
);

CREATE INDEX IF NOT EXISTS network_sla_daily_building_day_idx
  ON public.network_sla_daily (organization_id, building_id, sla_day DESC);

CREATE OR REPLACE FUNCTION app_private.network_center_reject_append_only_mutation_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
BEGIN
  RAISE EXCEPTION 'Network Center history is append-only'
    USING ERRCODE = '55000';
END;
$fn$;

DROP TRIGGER IF EXISTS network_device_samples_append_only ON public.network_device_samples;
CREATE TRIGGER network_device_samples_append_only
  BEFORE UPDATE OR DELETE ON public.network_device_samples
  FOR EACH ROW EXECUTE FUNCTION app_private.network_center_reject_append_only_mutation_v1();

DROP TRIGGER IF EXISTS network_interface_samples_append_only ON public.network_interface_samples;
CREATE TRIGGER network_interface_samples_append_only
  BEFORE UPDATE OR DELETE ON public.network_interface_samples
  FOR EACH ROW EXECUTE FUNCTION app_private.network_center_reject_append_only_mutation_v1();

CREATE OR REPLACE FUNCTION app_private.network_center_ensure_raw_partitions_v1(
  p_from date,
  p_through date
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
SET timezone TO 'UTC'
AS $fn$
DECLARE
  v_day date;
  v_next date;
  v_name text;
BEGIN
  IF p_from IS NULL OR p_through IS NULL OR p_through < p_from THEN
    RAISE EXCEPTION 'Invalid Network Center partition range' USING ERRCODE = '22023';
  END IF;
  IF p_through > p_from + 62 THEN
    RAISE EXCEPTION 'Network Center partition range exceeds 63 days' USING ERRCODE = '22023';
  END IF;

  v_day := p_from;
  WHILE v_day <= p_through LOOP
    v_next := v_day + 1;

    v_name := 'network_device_samples_' || to_char(v_day, 'YYYYMMDD');
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS public.%I PARTITION OF public.network_device_samples FOR VALUES FROM (%L) TO (%L)',
      v_name,
      v_day,
      v_next
    );
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_name);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated, service_role', v_name);

    v_name := 'network_interface_samples_' || to_char(v_day, 'YYYYMMDD');
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS public.%I PARTITION OF public.network_interface_samples FOR VALUES FROM (%L) TO (%L)',
      v_name,
      v_day,
      v_next
    );
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_name);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated, service_role', v_name);

    v_day := v_next;
  END LOOP;
END;
$fn$;

CREATE OR REPLACE FUNCTION app_private.network_center_rollup_hourly_v1(
  p_hour timestamptz
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
SET timezone TO 'UTC'
AS $fn$
DECLARE
  v_hour timestamptz;
  v_rows integer;
BEGIN
  IF p_hour IS NULL THEN
    RAISE EXCEPTION 'Rollup hour is required' USING ERRCODE = '22023';
  END IF;
  v_hour := date_trunc('hour', p_hour);

  WITH points AS (
    SELECT
      s.organization_id,
      s.building_id,
      'DEVICE'::text AS series_kind,
      s.device_id AS series_id,
      m.metric_name,
      m.metric_value,
      m.unit
    FROM public.network_device_samples s
    CROSS JOIN LATERAL (
      VALUES
        ('reachable_pct'::text, (CASE WHEN s.reachable THEN 100 ELSE 0 END)::numeric, 'percent'::text),
        ('latency_ms'::text, s.latency_ms::numeric, 'ms'::text),
        ('packet_loss_pct'::text, s.packet_loss_pct::numeric, 'percent'::text),
        ('cpu_pct'::text, s.cpu_pct::numeric, 'percent'::text),
        ('memory_used_pct'::text, s.memory_used_pct::numeric, 'percent'::text),
        ('temperature_c'::text, s.temperature_c::numeric, 'celsius'::text),
        ('voltage_v'::text, s.voltage_v::numeric, 'volt'::text),
        ('connection_count'::text, s.connection_count::numeric, 'count'::text)
    ) AS m(metric_name, metric_value, unit)
    WHERE s.observed_at >= v_hour
      AND s.observed_at < v_hour + INTERVAL '1 hour'
      AND m.metric_value IS NOT NULL

    UNION ALL

    SELECT
      s.organization_id,
      s.building_id,
      'INTERFACE'::text AS series_kind,
      s.interface_id AS series_id,
      m.metric_name,
      m.metric_value,
      m.unit
    FROM public.network_interface_samples s
    JOIN public.network_interfaces interface
      ON interface.organization_id = s.organization_id
     AND interface.building_id = s.building_id
     AND interface.device_id = s.device_id
     AND interface.id = s.interface_id
     AND interface.interface_role IN ('WAN', 'UPLINK')
    CROSS JOIN LATERAL (
      VALUES
        ('link_up_pct'::text, (CASE WHEN s.link_up THEN 100 ELSE 0 END)::numeric, 'percent'::text),
        ('rx_bps'::text, s.rx_bps::numeric, 'bps'::text),
        ('tx_bps'::text, s.tx_bps::numeric, 'bps'::text),
        ('utilization_pct'::text, s.utilization_pct::numeric, 'percent'::text),
        ('error_delta'::text, s.error_delta::numeric, 'count'::text),
        ('discard_delta'::text, s.discard_delta::numeric, 'count'::text),
        ('queue_drop_delta'::text, s.queue_drop_delta::numeric, 'count'::text)
    ) AS m(metric_name, metric_value, unit)
    WHERE s.observed_at >= v_hour
      AND s.observed_at < v_hour + INTERVAL '1 hour'
      AND m.metric_value IS NOT NULL
  ),
  aggregated AS (
    SELECT
      organization_id,
      building_id,
      series_kind,
      series_id,
      metric_name,
      unit,
      count(*)::bigint AS sample_count,
      min(metric_value) AS min_value,
      max(metric_value) AS max_value,
      avg(metric_value) AS avg_value,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY metric_value)::numeric AS p95_value
    FROM points
    GROUP BY organization_id, building_id, series_kind, series_id, metric_name, unit
  )
  INSERT INTO public.network_metric_hourly (
    organization_id,
    building_id,
    series_kind,
    series_id,
    metric_name,
    bucket_hour,
    unit,
    sample_count,
    min_value,
    max_value,
    avg_value,
    p95_value,
    updated_at
  )
  SELECT
    organization_id,
    building_id,
    series_kind,
    series_id,
    metric_name,
    v_hour,
    unit,
    sample_count,
    min_value,
    max_value,
    avg_value,
    p95_value,
    now()
  FROM aggregated
  ON CONFLICT (organization_id, building_id, series_kind, series_id, metric_name, bucket_hour)
  DO UPDATE SET
    unit = EXCLUDED.unit,
    sample_count = EXCLUDED.sample_count,
    min_value = EXCLUDED.min_value,
    max_value = EXCLUDED.max_value,
    avg_value = EXCLUDED.avg_value,
    p95_value = EXCLUDED.p95_value,
    updated_at = now();

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END;
$fn$;

CREATE OR REPLACE FUNCTION app_private.network_center_rollup_sla_daily_v1(
  p_day date
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
SET timezone TO 'UTC'
AS $fn$
DECLARE
  v_start timestamptz;
  v_end timestamptz;
  v_rows integer;
BEGIN
  IF p_day IS NULL THEN
    RAISE EXCEPTION 'SLA day is required' USING ERRCODE = '22023';
  END IF;
  v_start := p_day::timestamp AT TIME ZONE 'UTC';
  v_end := (p_day + 1)::timestamp AT TIME ZONE 'UTC';

  WITH reachability AS (
    SELECT
      s.organization_id,
      s.building_id,
      count(*)::bigint AS sample_count,
      avg(CASE WHEN s.reachable THEN 1::numeric ELSE 0::numeric END) AS uptime_ratio
    FROM public.network_device_samples s
    JOIN public.network_devices d
      ON d.organization_id = s.organization_id
     AND d.building_id = s.building_id
     AND d.id = s.device_id
     AND d.device_kind = 'MIKROTIK'
     AND d.is_active
    WHERE s.observed_at >= v_start
      AND s.observed_at < v_end
    GROUP BY s.organization_id, s.building_id
  )
  INSERT INTO public.network_sla_daily (
    organization_id,
    building_id,
    sla_day,
    sample_count,
    total_seconds,
    excluded_maintenance_seconds,
    eligible_seconds,
    uptime_seconds,
    outage_seconds,
    uptime_pct,
    incident_count,
    mttr_seconds,
    updated_at
  )
  SELECT
    r.organization_id,
    r.building_id,
    p_day,
    r.sample_count,
    86400,
    0,
    86400,
    round(86400::numeric * r.uptime_ratio)::bigint,
    86400 - round(86400::numeric * r.uptime_ratio)::bigint,
    round(100::numeric * r.uptime_ratio, 4),
    0,
    NULL,
    now()
  FROM reachability r
  ON CONFLICT (organization_id, building_id, sla_day)
  DO UPDATE SET
    sample_count = EXCLUDED.sample_count,
    total_seconds = EXCLUDED.total_seconds,
    excluded_maintenance_seconds = 0,
    eligible_seconds = EXCLUDED.total_seconds,
    uptime_seconds = EXCLUDED.uptime_seconds,
    outage_seconds = EXCLUDED.outage_seconds,
    uptime_pct = EXCLUDED.uptime_pct,
    incident_count = 0,
    mttr_seconds = NULL,
    updated_at = now();

  GET DIAGNOSTICS v_rows = ROW_COUNT;

  IF to_regclass('public.network_maintenance_windows') IS NOT NULL THEN
    EXECUTE $sql$
      WITH maintenance AS (
        SELECT
          organization_id,
          building_id,
          least(
            86400::bigint,
            greatest(
              0::bigint,
              round(sum(extract(epoch FROM (
                least(ends_at, $3) - greatest(starts_at, $2)
              ))))::bigint
            )
          ) AS excluded_seconds
        FROM public.network_maintenance_windows
        WHERE status <> 'CANCELLED'
          AND starts_at < $3
          AND ends_at > $2
        GROUP BY organization_id, building_id
      ),
      effective_reachability AS (
        SELECT
          sample.organization_id,
          sample.building_id,
          count(*)::bigint AS sample_count,
          avg(CASE WHEN sample.reachable THEN 1::numeric ELSE 0::numeric END) AS uptime_ratio
        FROM public.network_device_samples sample
        JOIN public.network_devices device
          ON device.organization_id = sample.organization_id
         AND device.building_id = sample.building_id
         AND device.id = sample.device_id
         AND device.device_kind = 'MIKROTIK'
         AND device.is_active
        WHERE sample.observed_at >= $2
          AND sample.observed_at < $3
          AND NOT EXISTS (
            SELECT 1
            FROM public.network_maintenance_windows window
            WHERE window.organization_id = sample.organization_id
              AND window.building_id = sample.building_id
              AND window.status <> 'CANCELLED'
              AND sample.observed_at >= window.starts_at
              AND sample.observed_at < window.ends_at
          )
        GROUP BY sample.organization_id, sample.building_id
      ),
      recalculated AS (
        SELECT
          daily.organization_id,
          daily.building_id,
          maintenance.excluded_seconds,
          coalesce(effective.sample_count, daily.sample_count) AS sample_count,
          coalesce(effective.uptime_ratio, daily.uptime_pct / 100) AS uptime_ratio,
          86400 - maintenance.excluded_seconds AS eligible_seconds
        FROM public.network_sla_daily daily
        JOIN maintenance
          ON maintenance.organization_id = daily.organization_id
         AND maintenance.building_id = daily.building_id
        LEFT JOIN effective_reachability effective
          ON effective.organization_id = daily.organization_id
         AND effective.building_id = daily.building_id
        WHERE daily.sla_day = $1
      )
      UPDATE public.network_sla_daily s
      SET
        sample_count = r.sample_count,
        excluded_maintenance_seconds = r.excluded_seconds,
        eligible_seconds = r.eligible_seconds,
        uptime_seconds = CASE
          WHEN r.eligible_seconds = 0 THEN 0
          ELSE round(r.eligible_seconds::numeric * r.uptime_ratio)::bigint
        END,
        outage_seconds = CASE
          WHEN r.eligible_seconds = 0 THEN 0
          ELSE r.eligible_seconds - round(r.eligible_seconds::numeric * r.uptime_ratio)::bigint
        END,
        uptime_pct = CASE
          WHEN r.eligible_seconds = 0 THEN 100
          ELSE round(100::numeric * r.uptime_ratio, 4)
        END,
        updated_at = now()
      FROM recalculated r
      WHERE s.sla_day = $1
        AND s.organization_id = r.organization_id
        AND s.building_id = r.building_id
    $sql$ USING p_day, v_start, v_end;
  END IF;

  IF to_regclass('public.network_incidents') IS NOT NULL THEN
    EXECUTE $sql$
      WITH incident_stats AS (
        SELECT
          organization_id,
          building_id,
          count(*)::integer AS incident_count,
          avg(extract(epoch FROM (resolved_at - opened_at)))
            FILTER (WHERE resolved_at IS NOT NULL AND resolved_at >= opened_at) AS mttr_seconds
        FROM public.network_incidents
        WHERE availability_impact
          AND opened_at < $3
          AND (resolved_at IS NULL OR resolved_at >= $2)
        GROUP BY organization_id, building_id
      )
      UPDATE public.network_sla_daily s
      SET
        incident_count = i.incident_count,
        mttr_seconds = i.mttr_seconds,
        updated_at = now()
      FROM incident_stats i
      WHERE s.sla_day = $1
        AND s.organization_id = i.organization_id
        AND s.building_id = i.building_id
    $sql$ USING p_day, v_start, v_end;
  END IF;

  RETURN v_rows;
END;
$fn$;

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
  v_dropped integer := 0;
  v_hourly_deleted bigint := 0;
  v_daily_deleted bigint := 0;
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
      AND parent.relname IN ('network_device_samples', 'network_interface_samples')
      AND child.relname ~ '^network_(device|interface)_samples_[0-9]{8}$'
  LOOP
    v_partition_day := to_date(right(v_partition.partition_name, 8), 'YYYYMMDD');
    IF v_partition_day < v_cutoff_day THEN
      EXECUTE format('DROP TABLE IF EXISTS public.%I', v_partition.partition_name);
      v_dropped := v_dropped + 1;
    END IF;
  END LOOP;

  DELETE FROM public.network_metric_hourly
  WHERE bucket_hour < date_trunc('hour', p_now - INTERVAL '13 months');
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_hourly_deleted := v_count;

  DELETE FROM public.network_sla_daily
  WHERE sla_day < ((p_now - INTERVAL '36 months') AT TIME ZONE 'UTC')::date;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_daily_deleted := v_count;

  PERFORM app_private.network_center_ensure_raw_partitions_v1(
    (p_now AT TIME ZONE 'UTC')::date - 1,
    (p_now AT TIME ZONE 'UTC')::date + 31
  );

  RETURN jsonb_build_object(
    'raw_partitions_dropped', v_dropped,
    'hourly_rows_deleted', v_hourly_deleted,
    'daily_rows_deleted', v_daily_deleted,
    'raw_retention_days', 14,
    'hourly_retention_months', 13,
    'daily_retention_months', 36
  );
END;
$fn$;

SELECT app_private.network_center_ensure_raw_partitions_v1(
  (now() AT TIME ZONE 'UTC')::date - 1,
  (now() AT TIME ZONE 'UTC')::date + 31
);

ALTER TABLE public.network_device_current ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.network_interface_current ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.network_client_current ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.network_client_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.network_client_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.network_device_samples ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.network_interface_samples ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.network_metric_hourly ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.network_sla_daily ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.network_device_current FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.network_interface_current FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.network_client_current FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.network_client_sessions FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.network_client_links FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.network_device_samples FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.network_interface_samples FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.network_metric_hourly FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.network_sla_daily FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION app_private.network_center_reject_append_only_mutation_v1() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.network_center_ensure_raw_partitions_v1(date, date) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.network_center_rollup_hourly_v1(timestamp with time zone) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.network_center_rollup_sla_daily_v1(date) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.network_center_retention_v1(timestamp with time zone) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE public.network_device_current IS
  'Small worker-owned current projection for one Network Center device.';
COMMENT ON TABLE public.network_client_links IS
  'Time-bounded links from observed fingerprints to iHomeCRM records; MAC is never treated as permanent identity.';
COMMENT ON TABLE public.network_device_samples IS
  'Append-only daily-partitioned raw device telemetry retained for 14 days.';
COMMENT ON TABLE public.network_metric_hourly IS
  'Repeat-safe hourly Network Center metric rollups retained for 13 months.';
COMMENT ON TABLE public.network_sla_daily IS
  'Repeat-safe daily building SLA retained for 36 months.';

COMMIT;

NOTIFY pgrst, 'reload schema';
