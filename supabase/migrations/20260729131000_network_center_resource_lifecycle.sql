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

ALTER TABLE public.network_devices
  ADD COLUMN IF NOT EXISTS aruba_stable_key text,
  ADD COLUMN IF NOT EXISTS aruba_identity_source text,
  ADD COLUMN IF NOT EXISTS aruba_discovery_state text,
  ADD COLUMN IF NOT EXISTS aruba_discovery_first_seen_at timestamptz,
  ADD COLUMN IF NOT EXISTS aruba_discovery_last_seen_at timestamptz;

UPDATE public.network_devices device
SET
  aruba_stable_key = CASE
    WHEN device.serial_number ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'
      THEN 'serial:' || upper(device.serial_number)
    WHEN device.external_key ~* '^[0-9a-f][02468ace](:[0-9a-f]{2}){5}$'
      AND lower(device.external_key) NOT IN (
        '00:00:00:00:00:00', 'ff:ff:ff:ff:ff:ff'
      )
      THEN 'mac:' || lower(device.external_key)
    ELSE 'legacy:' || encode(extensions.digest(
      convert_to(device.id::text || E'\x1f' || device.external_key, 'UTF8'),
      'sha256'
    ), 'hex')
  END,
  aruba_identity_source = CASE
    WHEN device.serial_number ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'
      THEN 'SERIAL'
    WHEN device.external_key ~* '^[0-9a-f][02468ace](:[0-9a-f]{2}){5}$'
      AND lower(device.external_key) NOT IN (
        '00:00:00:00:00:00', 'ff:ff:ff:ff:ff:ff'
      )
      THEN 'HARDWARE_MAC'
    ELSE 'LEGACY'
  END,
  aruba_discovery_first_seen_at = coalesce(
    device.aruba_discovery_first_seen_at, device.created_at
  ),
  aruba_discovery_last_seen_at = coalesce(
    device.aruba_discovery_last_seen_at, device.updated_at, device.created_at
  )
WHERE device.device_kind = 'ARUBA'
  AND device.aruba_stable_key IS NULL;

UPDATE public.network_devices device
SET aruba_discovery_state = CASE
  WHEN device.inventory_metadata->>'discovery' = 'routeros-neighbor'
    THEN 'DISCOVERED'
  ELSE 'PINNED'
END
WHERE device.device_kind = 'ARUBA'
  AND device.aruba_discovery_state IS NULL;

ALTER TABLE public.network_devices
  DROP CONSTRAINT IF EXISTS network_devices_lifecycle_check;
ALTER TABLE public.network_devices
  ADD CONSTRAINT network_devices_lifecycle_check
  CHECK (lifecycle_status IN (
    'UNPROVISIONED', 'PROVISIONING', 'ONLINE', 'OFFLINE', 'STALE', 'DISABLED'
  ));

ALTER TABLE public.network_devices
  DROP CONSTRAINT IF EXISTS network_devices_aruba_stable_identity_check;
ALTER TABLE public.network_devices
  ADD CONSTRAINT network_devices_aruba_stable_identity_check
  CHECK (
    (
      device_kind = 'ARUBA'
      AND aruba_stable_key IS NOT NULL
      AND aruba_identity_source IS NOT NULL
      AND aruba_discovery_state IN ('DISCOVERED', 'PINNED')
      AND parent_device_id IS NOT NULL
      AND aruba_discovery_first_seen_at IS NOT NULL
      AND aruba_discovery_last_seen_at IS NOT NULL
      AND aruba_discovery_last_seen_at >= aruba_discovery_first_seen_at
      AND (
        (
          aruba_identity_source = 'SERIAL'
          AND aruba_stable_key ~ '^serial:[A-Z0-9][A-Z0-9._:-]{0,152}$'
        )
        OR (
          aruba_identity_source = 'HARDWARE_MAC'
          AND aruba_stable_key ~
            '^mac:[0-9a-f][02468ace](:[0-9a-f]{2}){5}$'
          AND aruba_stable_key NOT IN (
            'mac:00:00:00:00:00:00', 'mac:ff:ff:ff:ff:ff:ff'
          )
        )
        OR (
          aruba_identity_source = 'LEGACY'
          AND aruba_stable_key ~ '^legacy:[a-f0-9]{64}$'
        )
      )
    )
    OR (
      device_kind <> 'ARUBA'
      AND aruba_stable_key IS NULL
      AND aruba_identity_source IS NULL
      AND aruba_discovery_state IS NULL
      AND aruba_discovery_first_seen_at IS NULL
      AND aruba_discovery_last_seen_at IS NULL
    )
  );

CREATE OR REPLACE FUNCTION app_private.network_center_guard_aruba_parent_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
BEGIN
  IF NEW.device_kind = 'ARUBA' AND NOT EXISTS (
    SELECT 1
    FROM public.network_devices parent
    WHERE parent.organization_id = NEW.organization_id
      AND parent.building_id = NEW.building_id
      AND parent.id = NEW.parent_device_id
      AND parent.device_kind = 'MIKROTIK'
  ) THEN
    RAISE EXCEPTION 'Aruba parent must be a MikroTik in the same building'
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS network_devices_aruba_parent_guard
  ON public.network_devices;
CREATE TRIGGER network_devices_aruba_parent_guard
  BEFORE INSERT OR UPDATE OF
    organization_id, building_id, device_kind, parent_device_id
  ON public.network_devices
  FOR EACH ROW EXECUTE FUNCTION
    app_private.network_center_guard_aruba_parent_v1();

DROP INDEX IF EXISTS public.network_devices_external_key_uidx;
CREATE UNIQUE INDEX network_devices_external_key_uidx
  ON public.network_devices (
    organization_id, building_id, device_kind, external_key
  )
  WHERE device_kind <> 'ARUBA';

CREATE UNIQUE INDEX IF NOT EXISTS network_devices_aruba_stable_key_uidx
  ON public.network_devices (parent_device_id, aruba_stable_key)
  WHERE device_kind = 'ARUBA';

DROP INDEX IF EXISTS public.network_devices_aruba_age_idx;
CREATE INDEX network_devices_aruba_age_idx
  ON public.network_devices (
    organization_id, aruba_discovery_last_seen_at, id
  )
  WHERE device_kind = 'ARUBA';

CREATE INDEX IF NOT EXISTS network_devices_aruba_first_seen_idx
  ON public.network_devices (
    parent_device_id, aruba_discovery_first_seen_at, id
  )
  WHERE device_kind = 'ARUBA';

CREATE TABLE IF NOT EXISTS app_private.network_aruba_router_state (
  organization_id uuid NOT NULL,
  building_id uuid NOT NULL,
  router_device_id uuid PRIMARY KEY,
  enrollment_started_at timestamptz NOT NULL,
  last_discovery_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (organization_id, building_id, router_device_id)
    REFERENCES public.network_devices(organization_id, building_id, id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS app_private.network_aruba_discovery_runs (
  discovery_run_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  building_id uuid NOT NULL,
  router_device_id uuid NOT NULL,
  observed_at timestamptz NOT NULL,
  batch_count integer NOT NULL CHECK (batch_count BETWEEN 1 AND 4096),
  new_identity_count integer NOT NULL DEFAULT 0
    CHECK (new_identity_count BETWEEN 0 AND 64),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (organization_id, building_id, router_device_id)
    REFERENCES public.network_devices(organization_id, building_id, id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS app_private.network_aruba_discovery_batches (
  discovery_run_id uuid NOT NULL
    REFERENCES app_private.network_aruba_discovery_runs(discovery_run_id)
    ON DELETE CASCADE,
  batch_index integer NOT NULL CHECK (batch_index BETWEEN 0 AND 4095),
  payload_hash character(64) NOT NULL
    CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  response jsonb NOT NULL CHECK (jsonb_typeof(response) = 'object'),
  processed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (discovery_run_id, batch_index)
);

CREATE TABLE IF NOT EXISTS app_private.network_aruba_discovery_candidates (
  organization_id uuid NOT NULL,
  building_id uuid NOT NULL,
  router_device_id uuid NOT NULL,
  stable_key text NOT NULL,
  identity_source text NOT NULL
    CHECK (identity_source IN ('SERIAL', 'HARDWARE_MAC')),
  external_key text NOT NULL,
  display_name text NOT NULL,
  model text,
  serial_number text,
  uplink_interface_key text,
  management_address inet,
  sort_order integer NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  aliases jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(aliases) = 'array'),
  inventory_metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(inventory_metadata) = 'object'),
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  sighting_count integer NOT NULL DEFAULT 1 CHECK (sighting_count >= 1),
  last_discovery_run_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (router_device_id, stable_key),
  FOREIGN KEY (organization_id, building_id, router_device_id)
    REFERENCES public.network_devices(organization_id, building_id, id)
    ON DELETE CASCADE,
  CHECK (last_seen_at >= first_seen_at)
);

CREATE TABLE IF NOT EXISTS app_private.network_aruba_aliases (
  organization_id uuid NOT NULL,
  building_id uuid NOT NULL,
  router_device_id uuid NOT NULL,
  stable_key text NOT NULL,
  alias text NOT NULL CHECK (char_length(alias) BETWEEN 1 AND 160),
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  tombstoned_at timestamptz,
  PRIMARY KEY (router_device_id, stable_key, alias),
  FOREIGN KEY (organization_id, building_id, router_device_id)
    REFERENCES public.network_devices(organization_id, building_id, id)
    ON DELETE CASCADE,
  CHECK (last_seen_at >= first_seen_at)
);

CREATE TABLE IF NOT EXISTS app_private.network_aruba_quarantine (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  building_id uuid NOT NULL,
  router_device_id uuid NOT NULL,
  discovery_run_id uuid NOT NULL
    REFERENCES app_private.network_aruba_discovery_runs(discovery_run_id)
    ON DELETE CASCADE,
  batch_index integer NOT NULL CHECK (batch_index BETWEEN 0 AND 4095),
  reason_code text NOT NULL CHECK (reason_code IN (
    'ARUBA_STABLE_IDENTITY_INVALID',
    'ARUBA_ITEM_INVALID',
    'ARUBA_IDENTITY_RATE_LIMITED',
    'ARUBA_WORKER_QUARANTINE_INVALID'
  )),
  fingerprint character(64) NOT NULL
    CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (discovery_run_id, batch_index, reason_code, fingerprint),
  FOREIGN KEY (organization_id, building_id, router_device_id)
    REFERENCES public.network_devices(organization_id, building_id, id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS network_aruba_candidates_age_idx
  ON app_private.network_aruba_discovery_candidates (
    organization_id, last_seen_at, router_device_id, stable_key
  );
CREATE INDEX IF NOT EXISTS network_aruba_aliases_retention_idx
  ON app_private.network_aruba_aliases (
    organization_id, tombstoned_at, router_device_id, stable_key, alias
  ) WHERE tombstoned_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS network_aruba_quarantine_retention_idx
  ON app_private.network_aruba_quarantine (
    organization_id, observed_at, router_device_id, id
  );
CREATE INDEX IF NOT EXISTS network_aruba_quarantine_router_idx
  ON app_private.network_aruba_quarantine (
    router_device_id, observed_at DESC, id DESC
  );
CREATE INDEX IF NOT EXISTS network_aruba_runs_age_idx
  ON app_private.network_aruba_discovery_runs (
    organization_id, created_at, discovery_run_id
  );

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

CREATE OR REPLACE FUNCTION public.network_center_worker_inventory_v1(
  p_worker_id text,
  p_payload jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private', 'extensions'
AS $fn$
DECLARE
  v_router public.network_devices%ROWTYPE;
  v_run app_private.network_aruba_discovery_runs%ROWTYPE;
  v_state app_private.network_aruba_router_state%ROWTYPE;
  v_candidate app_private.network_aruba_discovery_candidates%ROWTYPE;
  v_interfaces jsonb := '[]'::jsonb;
  v_aruba jsonb := '[]'::jsonb;
  v_response jsonb;
  v_item jsonb;
  v_aliases jsonb;
  v_metadata jsonb;
  v_run_id uuid;
  v_observed_at timestamptz;
  v_request_now timestamptz := clock_timestamp();
  v_now timestamptz;
  v_batch_index integer;
  v_batch_count integer;
  v_payload_hash character(64);
  v_existing_hash character(64);
  v_existing_response jsonb;
  v_stable_identity text;
  v_identity_source text;
  v_stable_key text;
  v_external_key text;
  v_display_name text;
  v_model text;
  v_serial_number text;
  v_uplink_interface_key text;
  v_management_address inet;
  v_sort_order integer;
  v_lifecycle_status text;
  v_device_id uuid;
  v_alias_text text;
  v_fingerprint character(64);
  v_quarantine_code text;
  v_quarantined_count integer := 0;
  v_new_today bigint;
  v_enrollment_count bigint;
  v_can_enroll boolean;
  v_seen_stable_keys text[] := ARRAY[]::text[];
  v_inserted integer;
  v_item_invalid boolean;
BEGIN
  IF p_worker_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$'
     OR p_payload IS NULL
     OR jsonb_typeof(p_payload) <> 'object'
     OR octet_length(p_payload::text) > 524288
     OR coalesce(p_payload->>'routerDeviceId', '') !~
       '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
     OR coalesce(p_payload->>'discoveryRunId', '') !~
       '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
     OR coalesce(p_payload->>'batchIndex', '') !~ '^[0-9]{1,4}$'
     OR coalesce(p_payload->>'batchCount', '') !~ '^[0-9]{1,4}$'
     OR jsonb_typeof(coalesce(p_payload->'interfaces', '[]'::jsonb)) <> 'array'
     OR jsonb_typeof(coalesce(p_payload->'aruba', '[]'::jsonb)) <> 'array'
     OR jsonb_typeof(coalesce(p_payload->'quarantine', '[]'::jsonb)) <> 'array'
     OR jsonb_array_length(coalesce(p_payload->'interfaces', '[]'::jsonb)) > 256
     OR jsonb_array_length(coalesce(p_payload->'aruba', '[]'::jsonb)) > 256
     OR jsonb_array_length(coalesce(p_payload->'quarantine', '[]'::jsonb)) > 256 THEN
    RAISE EXCEPTION 'Invalid or oversized inventory payload'
      USING ERRCODE = '22023';
  END IF;

  BEGIN
    v_run_id := (p_payload->>'discoveryRunId')::uuid;
    v_observed_at := (p_payload->>'observedAt')::timestamptz;
    v_batch_index := (p_payload->>'batchIndex')::integer;
    v_batch_count := (p_payload->>'batchCount')::integer;
  EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow THEN
    RAISE EXCEPTION 'Invalid inventory run metadata' USING ERRCODE = '22023';
  END;
  IF v_batch_count NOT BETWEEN 1 AND 4096
     OR v_batch_index < 0 OR v_batch_index >= v_batch_count
     OR v_observed_at IS NULL
     OR v_observed_at < v_request_now - INTERVAL '24 hours'
     OR v_observed_at > v_request_now + INTERVAL '5 minutes' THEN
    RAISE EXCEPTION 'Invalid inventory run bounds' USING ERRCODE = '22023';
  END IF;

  PERFORM app_private.network_center_assert_safe_json_v1(
    p_payload, 'inventory discovery payload'
  );
  v_payload_hash := encode(extensions.digest(
    convert_to(p_payload::text, 'UTF8'), 'sha256'
  ), 'hex');

  SELECT router.* INTO v_router
  FROM public.network_devices router
  WHERE router.id = (p_payload->>'routerDeviceId')::uuid
    AND router.device_kind = 'MIKROTIK'
    AND router.is_active
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Inventory router not found' USING ERRCODE = 'P0002';
  END IF;
  v_now := clock_timestamp();

  INSERT INTO app_private.network_aruba_router_state (
    organization_id, building_id, router_device_id,
    enrollment_started_at, last_discovery_at
  ) VALUES (
    v_router.organization_id, v_router.building_id, v_router.id,
    v_now, v_now
  )
  ON CONFLICT (router_device_id) DO UPDATE SET
    last_discovery_at = GREATEST(
      app_private.network_aruba_router_state.last_discovery_at,
      EXCLUDED.last_discovery_at
    ),
    updated_at = clock_timestamp();

  SELECT state.* INTO v_state
  FROM app_private.network_aruba_router_state state
  WHERE state.router_device_id = v_router.id
  FOR UPDATE;

  INSERT INTO app_private.network_aruba_discovery_runs (
    discovery_run_id, organization_id, building_id, router_device_id,
    observed_at, batch_count
  ) VALUES (
    v_run_id, v_router.organization_id, v_router.building_id,
    v_router.id, v_observed_at, v_batch_count
  ) ON CONFLICT (discovery_run_id) DO NOTHING;

  SELECT run.* INTO v_run
  FROM app_private.network_aruba_discovery_runs run
  WHERE run.discovery_run_id = v_run_id
  FOR UPDATE;
  IF v_run.router_device_id IS DISTINCT FROM v_router.id
     OR v_run.observed_at IS DISTINCT FROM v_observed_at
     OR v_run.batch_count IS DISTINCT FROM v_batch_count THEN
    RAISE EXCEPTION 'Discovery run metadata cannot change'
      USING ERRCODE = '23505';
  END IF;

  SELECT batch.payload_hash, batch.response
  INTO v_existing_hash, v_existing_response
  FROM app_private.network_aruba_discovery_batches batch
  WHERE batch.discovery_run_id = v_run_id
    AND batch.batch_index = v_batch_index
  FOR UPDATE;
  IF FOUND THEN
    IF v_existing_hash IS DISTINCT FROM v_payload_hash THEN
      RAISE EXCEPTION 'Discovery batch replay changed payload'
        USING ERRCODE = '23505';
    END IF;
    RETURN v_existing_response;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(
      coalesce(p_payload->'interfaces', '[]'::jsonb)
    ) AS item("interfaceKey" text)
    GROUP BY btrim(item."interfaceKey")
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Interface keys must be unique within a batch'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(
      coalesce(p_payload->'interfaces', '[]'::jsonb)
    ) AS item(
      "interfaceKey" text, "displayName" text, "interfaceKind" text,
      "interfaceRole" text, "macAddress" text, "ifIndex" integer,
      "nominalSpeedBps" bigint, "sortOrder" integer, metadata jsonb
    )
    WHERE char_length(btrim(coalesce(item."interfaceKey", ''))) NOT BETWEEN 1 AND 160
       OR char_length(btrim(coalesce(
         item."displayName", item."interfaceKey", ''
       ))) NOT BETWEEN 1 AND 160
       OR upper(btrim(coalesce(item."interfaceKind", 'OTHER'))) NOT IN (
         'ETHERNET', 'WIRELESS', 'WIREGUARD', 'BRIDGE',
         'VLAN', 'LOOPBACK', 'OTHER'
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
    RAISE EXCEPTION 'Malformed interface inventory item'
      USING ERRCODE = '22023';
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
    FROM jsonb_to_recordset(
      coalesce(p_payload->'interfaces', '[]'::jsonb)
    ) AS item(
      "interfaceKey" text, "displayName" text, "interfaceKind" text,
      "interfaceRole" text, "macAddress" text, "ifIndex" integer,
      "nominalSpeedBps" bigint, "isProtected" boolean,
      "sortOrder" integer, "isEnabled" boolean, metadata jsonb
    )
  ), upserted AS (
    INSERT INTO public.network_interfaces (
      organization_id, building_id, device_id, interface_key, display_name,
      interface_kind, interface_role, mac_address, if_index,
      nominal_speed_bps, is_protected, sort_order, is_enabled,
      is_managed, display_metadata
    )
    SELECT
      v_router.organization_id, v_router.building_id, v_router.id,
      input.interface_key, input.display_name, input.interface_kind,
      input.interface_role, input.mac_address, input.if_index,
      input.nominal_speed_bps,
      input.requested_protection OR input.interface_role IN (
        'WAN', 'UPLINK', 'MANAGEMENT'
      ),
      input.sort_order, input.is_enabled, true, input.display_metadata
    FROM input
    ON CONFLICT (device_id, interface_key) DO UPDATE SET
      display_name = EXCLUDED.display_name,
      interface_kind = EXCLUDED.interface_kind,
      interface_role = EXCLUDED.interface_role,
      mac_address = EXCLUDED.mac_address,
      if_index = EXCLUDED.if_index,
      nominal_speed_bps = EXCLUDED.nominal_speed_bps,
      is_protected = public.network_interfaces.is_protected
        OR EXCLUDED.is_protected,
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

  FOR v_item IN
    SELECT item.value
    FROM jsonb_array_elements(
      coalesce(p_payload->'quarantine', '[]'::jsonb)
    ) AS item(value)
  LOOP
    v_quarantine_code := coalesce(v_item->>'code', '');
    v_fingerprint := lower(coalesce(v_item->>'fingerprint', ''));
    IF v_quarantine_code <> 'ARUBA_STABLE_IDENTITY_INVALID'
       OR v_fingerprint !~ '^[a-f0-9]{64}$' THEN
      v_quarantine_code := 'ARUBA_WORKER_QUARANTINE_INVALID';
      v_fingerprint := encode(extensions.digest(
        convert_to(v_item::text, 'UTF8'), 'sha256'
      ), 'hex');
    END IF;
    INSERT INTO app_private.network_aruba_quarantine (
      organization_id, building_id, router_device_id,
      discovery_run_id, batch_index, reason_code, fingerprint, observed_at
    ) VALUES (
      v_router.organization_id, v_router.building_id, v_router.id,
      v_run_id, v_batch_index, v_quarantine_code, v_fingerprint, v_now
    ) ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_inserted = ROW_COUNT;
    v_quarantined_count := v_quarantined_count + v_inserted;
  END LOOP;

  FOR v_item IN
    SELECT item.value
    FROM jsonb_array_elements(
      coalesce(p_payload->'aruba', '[]'::jsonb)
    ) AS item(value)
  LOOP
    v_item_invalid := jsonb_typeof(v_item) <> 'object';
    v_stable_identity := btrim(coalesce(v_item->>'stableIdentity', ''));
    v_identity_source := upper(btrim(coalesce(v_item->>'identitySource', '')));
    v_external_key := btrim(coalesce(v_item->>'externalKey', ''));
    v_display_name := btrim(coalesce(v_item->>'displayName', ''));
    v_aliases := coalesce(v_item->'aliases', '[]'::jsonb);
    v_metadata := coalesce(v_item->'metadata', '{}'::jsonb);
    v_model := nullif(btrim(coalesce(v_item->>'model', '')), '');
    v_uplink_interface_key := nullif(btrim(coalesce(
      v_item->>'uplinkInterfaceKey', ''
    )), '');
    v_sort_order := CASE
      WHEN coalesce(v_item->>'sortOrder', '') ~ '^[0-9]{1,9}$'
        THEN (v_item->>'sortOrder')::integer
      ELSE 0
    END;
    v_lifecycle_status := upper(btrim(coalesce(
      v_item->>'lifecycleStatus', 'ONLINE'
    )));
    v_serial_number := CASE WHEN v_identity_source = 'SERIAL'
      THEN v_stable_identity ELSE NULL END;
    v_stable_key := CASE v_identity_source
      WHEN 'SERIAL' THEN 'serial:' || v_stable_identity
      WHEN 'HARDWARE_MAC' THEN 'mac:' || lower(v_stable_identity)
      ELSE ''
    END;
    v_management_address := NULL;
    BEGIN
      IF nullif(btrim(coalesce(v_item->>'managementAddress', '')), '')
         IS NOT NULL THEN
        v_management_address := btrim(v_item->>'managementAddress')::inet;
      END IF;
    EXCEPTION WHEN invalid_text_representation THEN
      v_management_address := NULL;
      v_stable_key := '';
    END;

    IF jsonb_typeof(v_aliases) <> 'array' THEN
      v_item_invalid := true;
      v_aliases := '[]'::jsonb;
    END IF;
    IF jsonb_typeof(v_metadata) <> 'object' THEN
      v_item_invalid := true;
      v_metadata := '{}'::jsonb;
    END IF;

    IF v_item_invalid
       OR lower(coalesce(v_item->>'displayOnly', '')) <> 'true'
       OR char_length(v_display_name) NOT BETWEEN 1 AND 160
       OR jsonb_array_length(v_aliases) > 32
       OR EXISTS (
         SELECT 1 FROM jsonb_array_elements(v_aliases) alias(value)
         WHERE jsonb_typeof(alias.value) <> 'string'
            OR char_length(btrim(alias.value #>> '{}')) NOT BETWEEN 1 AND 160
       )
       OR octet_length(v_metadata::text) > 16384
       OR v_sort_order < 0
       OR v_lifecycle_status NOT IN ('ONLINE', 'OFFLINE')
       OR (
         v_identity_source = 'SERIAL'
         AND v_stable_identity !~ '^[A-Z0-9][A-Z0-9._:-]{0,152}$'
       )
       OR (
         v_identity_source = 'HARDWARE_MAC'
         AND (
           lower(v_stable_identity) !~
             '^[0-9a-f][02468ace](:[0-9a-f]{2}){5}$'
           OR lower(v_stable_identity) IN (
             '00:00:00:00:00:00', 'ff:ff:ff:ff:ff:ff'
           )
         )
       )
       OR v_identity_source NOT IN ('SERIAL', 'HARDWARE_MAC')
       OR v_external_key IS DISTINCT FROM v_stable_key
       OR v_stable_key = ''
       OR v_stable_key = ANY(v_seen_stable_keys) THEN
      v_fingerprint := encode(extensions.digest(
        convert_to(v_item::text, 'UTF8'), 'sha256'
      ), 'hex');
      INSERT INTO app_private.network_aruba_quarantine (
        organization_id, building_id, router_device_id,
        discovery_run_id, batch_index, reason_code, fingerprint, observed_at
      ) VALUES (
        v_router.organization_id, v_router.building_id, v_router.id,
        v_run_id, v_batch_index, 'ARUBA_ITEM_INVALID', v_fingerprint, v_now
      ) ON CONFLICT DO NOTHING;
      GET DIAGNOSTICS v_inserted = ROW_COUNT;
      v_quarantined_count := v_quarantined_count + v_inserted;
      CONTINUE;
    END IF;
    v_seen_stable_keys := array_append(v_seen_stable_keys, v_stable_key);
    v_device_id := NULL;

    SELECT device.id INTO v_device_id
    FROM public.network_devices device
    WHERE device.parent_device_id = v_router.id
      AND device.device_kind = 'ARUBA'
      AND device.aruba_stable_key = v_stable_key
    FOR UPDATE;

    IF FOUND THEN
      UPDATE public.network_devices device
      SET external_key = v_external_key,
          display_name = v_display_name,
          vendor = 'Aruba',
          model = v_model,
          serial_number = v_serial_number,
          uplink_interface_key = v_uplink_interface_key,
          lifecycle_status = v_lifecycle_status,
          write_capability = false,
          is_active = true,
          credential_ref = NULL,
          inventory_metadata = (v_metadata - 'managementAddress')
            || CASE WHEN v_management_address IS NULL THEN '{}'::jsonb
              ELSE jsonb_build_object(
                'managementAddress', host(v_management_address)
              ) END,
          aruba_discovery_last_seen_at = GREATEST(
            device.aruba_discovery_last_seen_at, v_now
          ),
          updated_at = v_now
      WHERE device.id = v_device_id;
      v_can_enroll := true;
    ELSE
      INSERT INTO app_private.network_aruba_discovery_candidates (
        organization_id, building_id, router_device_id, stable_key,
        identity_source, external_key, display_name, model, serial_number,
        uplink_interface_key, management_address, sort_order, aliases,
        inventory_metadata, first_seen_at, last_seen_at,
        sighting_count, last_discovery_run_id
      ) VALUES (
        v_router.organization_id, v_router.building_id, v_router.id,
        v_stable_key, v_identity_source, v_external_key, v_display_name,
        v_model, v_serial_number, v_uplink_interface_key,
        v_management_address, v_sort_order, v_aliases, v_metadata,
        v_now, v_now, 1, v_run_id
      )
      ON CONFLICT (router_device_id, stable_key) DO UPDATE SET
        external_key = EXCLUDED.external_key,
        display_name = EXCLUDED.display_name,
        model = EXCLUDED.model,
        serial_number = EXCLUDED.serial_number,
        uplink_interface_key = EXCLUDED.uplink_interface_key,
        management_address = EXCLUDED.management_address,
        sort_order = EXCLUDED.sort_order,
        aliases = EXCLUDED.aliases,
        inventory_metadata = EXCLUDED.inventory_metadata,
        last_seen_at = GREATEST(
          app_private.network_aruba_discovery_candidates.last_seen_at,
          EXCLUDED.last_seen_at
        ),
        sighting_count =
          app_private.network_aruba_discovery_candidates.sighting_count
          + CASE WHEN
              app_private.network_aruba_discovery_candidates.last_discovery_run_id
                IS DISTINCT FROM EXCLUDED.last_discovery_run_id
            THEN 1 ELSE 0 END,
        last_discovery_run_id = EXCLUDED.last_discovery_run_id,
        updated_at = clock_timestamp();

      SELECT candidate.* INTO v_candidate
      FROM app_private.network_aruba_discovery_candidates candidate
      WHERE candidate.router_device_id = v_router.id
        AND candidate.stable_key = v_stable_key
      FOR UPDATE;

      SELECT count(*) INTO v_new_today
      FROM public.network_devices device
      WHERE device.parent_device_id = v_router.id
        AND device.device_kind = 'ARUBA'
        AND device.aruba_identity_source IN ('SERIAL', 'HARDWARE_MAC')
        AND device.aruba_discovery_first_seen_at >= v_now - INTERVAL '24 hours';
      SELECT count(*) INTO v_enrollment_count
      FROM public.network_devices device
      WHERE device.parent_device_id = v_router.id
        AND device.device_kind = 'ARUBA'
        AND device.aruba_identity_source IN ('SERIAL', 'HARDWARE_MAC')
        AND device.aruba_discovery_first_seen_at >= v_state.enrollment_started_at;

      v_can_enroll := v_run.new_identity_count < 64 AND (
        (
          v_now < v_state.enrollment_started_at + INTERVAL '24 hours'
          AND v_enrollment_count < 512
        )
        OR (
          v_now >= v_state.enrollment_started_at + INTERVAL '24 hours'
          AND v_new_today < 128
          AND v_candidate.sighting_count >= 3
          AND v_candidate.last_seen_at >=
            v_candidate.first_seen_at + INTERVAL '10 minutes'
        )
      );

      IF v_can_enroll THEN
        INSERT INTO public.network_devices (
          organization_id, building_id, device_kind, external_key,
          display_name, vendor, model, serial_number, parent_device_id,
          uplink_interface_key, sort_order, lifecycle_status,
          write_capability, is_active, credential_ref, inventory_metadata,
          aruba_stable_key, aruba_identity_source,
          aruba_discovery_state, aruba_discovery_first_seen_at,
          aruba_discovery_last_seen_at
        ) VALUES (
          v_router.organization_id, v_router.building_id, 'ARUBA',
          v_external_key, v_display_name, 'Aruba', v_model, v_serial_number,
          v_router.id, v_uplink_interface_key, v_sort_order,
          v_lifecycle_status, false, true, NULL,
          (v_metadata - 'managementAddress')
            || CASE WHEN v_management_address IS NULL THEN '{}'::jsonb
              ELSE jsonb_build_object(
                'managementAddress', host(v_management_address)
              ) END,
          v_stable_key, v_identity_source, 'DISCOVERED', v_now, v_now
        )
        ON CONFLICT (parent_device_id, aruba_stable_key)
          WHERE device_kind = 'ARUBA'
        DO UPDATE SET
          display_name = EXCLUDED.display_name,
          model = EXCLUDED.model,
          serial_number = EXCLUDED.serial_number,
          uplink_interface_key = EXCLUDED.uplink_interface_key,
          lifecycle_status = EXCLUDED.lifecycle_status,
          is_active = true,
          inventory_metadata = EXCLUDED.inventory_metadata,
          aruba_discovery_last_seen_at = GREATEST(
            public.network_devices.aruba_discovery_last_seen_at, v_now
          ),
          updated_at = v_now
        RETURNING id INTO v_device_id;

        UPDATE app_private.network_aruba_discovery_runs run
        SET new_identity_count = run.new_identity_count + 1,
            updated_at = v_now
        WHERE run.discovery_run_id = v_run_id
        RETURNING run.* INTO v_run;
        DELETE FROM app_private.network_aruba_discovery_candidates candidate
        WHERE candidate.router_device_id = v_router.id
          AND candidate.stable_key = v_stable_key;
      ELSE
        v_fingerprint := encode(extensions.digest(
          convert_to(v_stable_key, 'UTF8'), 'sha256'
        ), 'hex');
        INSERT INTO app_private.network_aruba_quarantine (
          organization_id, building_id, router_device_id,
          discovery_run_id, batch_index, reason_code, fingerprint, observed_at
        ) VALUES (
          v_router.organization_id, v_router.building_id, v_router.id,
          v_run_id, v_batch_index, 'ARUBA_IDENTITY_RATE_LIMITED',
          v_fingerprint, v_now
        ) ON CONFLICT DO NOTHING;
        GET DIAGNOSTICS v_inserted = ROW_COUNT;
        v_quarantined_count := v_quarantined_count + v_inserted;
      END IF;
    END IF;

    FOR v_alias_text IN
      SELECT btrim(alias.value #>> '{}')
      FROM jsonb_array_elements(v_aliases) alias(value)
    LOOP
      INSERT INTO app_private.network_aruba_aliases (
        organization_id, building_id, router_device_id, stable_key,
        alias, first_seen_at, last_seen_at, tombstoned_at
      ) VALUES (
        v_router.organization_id, v_router.building_id, v_router.id,
        v_stable_key, v_alias_text, v_now, v_now, NULL
      )
      ON CONFLICT (router_device_id, stable_key, alias) DO UPDATE SET
        last_seen_at = GREATEST(
          app_private.network_aruba_aliases.last_seen_at,
          EXCLUDED.last_seen_at
        ),
        tombstoned_at = NULL;
    END LOOP;
    UPDATE app_private.network_aruba_aliases alias
    SET tombstoned_at = coalesce(alias.tombstoned_at, v_now)
    WHERE alias.router_device_id = v_router.id
      AND alias.stable_key = v_stable_key
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(v_aliases) current_alias(value)
        WHERE btrim(current_alias.value #>> '{}') = alias.alias
      );

    IF v_can_enroll AND v_device_id IS NOT NULL THEN
      v_aruba := v_aruba || jsonb_build_array(jsonb_build_object(
        'externalKey', v_external_key,
        'id', v_device_id
      ));
    END IF;
  END LOOP;

  WITH victims AS MATERIALIZED (
    SELECT quarantine.id
    FROM app_private.network_aruba_quarantine quarantine
    WHERE quarantine.router_device_id = v_router.id
    ORDER BY quarantine.observed_at DESC, quarantine.id DESC
    OFFSET 1000
    LIMIT 512
  )
  DELETE FROM app_private.network_aruba_quarantine quarantine
  USING victims
  WHERE quarantine.id = victims.id;

  v_response := jsonb_build_object(
    'routerDeviceId', v_router.id,
    'interfaces', v_interfaces,
    'aruba', v_aruba,
    'interfaceCount', jsonb_array_length(v_interfaces),
    'arubaCount', jsonb_array_length(v_aruba),
    'inventoryStatus', CASE WHEN v_quarantined_count > 0
      THEN 'DEGRADED' ELSE 'OK' END,
    'quarantinedCount', v_quarantined_count
  );

  INSERT INTO app_private.network_aruba_discovery_batches (
    discovery_run_id, batch_index, payload_hash, response
  ) VALUES (
    v_run_id, v_batch_index, v_payload_hash, v_response
  );
  RETURN v_response;
END;
$fn$;

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
          SELECT connection.management_ip::text
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

CREATE OR REPLACE FUNCTION app_private.network_center_aruba_retention_v1(
  p_now timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
SET timezone TO 'UTC'
AS $fn$
DECLARE
  v_organization record;
  v_router record;
  v_count bigint;
  v_stale bigint := 0;
  v_inactive bigint := 0;
  v_pinned bigint := 0;
  v_purged bigint := 0;
  v_candidates bigint := 0;
  v_aliases_tombstoned bigint := 0;
  v_aliases bigint := 0;
  v_quarantine bigint := 0;
  v_runs bigint := 0;
BEGIN
  IF p_now IS NULL THEN
    RAISE EXCEPTION 'Aruba retention timestamp is required'
      USING ERRCODE = '22023';
  END IF;

  FOR v_organization IN
    SELECT DISTINCT device.organization_id
    FROM public.network_devices device
    WHERE device.device_kind = 'ARUBA'
    UNION
    SELECT candidate.organization_id
    FROM app_private.network_aruba_discovery_candidates candidate
    UNION
    SELECT alias.organization_id
    FROM app_private.network_aruba_aliases alias
    UNION
    SELECT quarantine.organization_id
    FROM app_private.network_aruba_quarantine quarantine
    UNION
    SELECT run.organization_id
    FROM app_private.network_aruba_discovery_runs run
    ORDER BY organization_id
  LOOP
    WITH victims AS MATERIALIZED (
      SELECT device.id
      FROM public.network_devices device
      WHERE device.organization_id = v_organization.organization_id
        AND device.device_kind = 'ARUBA'
        AND device.is_active
        AND device.lifecycle_status <> 'STALE'
        AND device.aruba_discovery_last_seen_at < p_now - INTERVAL '24 hours'
      ORDER BY device.aruba_discovery_last_seen_at, device.id
      FOR UPDATE SKIP LOCKED
      LIMIT 1000
    )
    UPDATE public.network_devices device
    SET lifecycle_status = 'STALE', updated_at = clock_timestamp()
    FROM victims
    WHERE device.id = victims.id;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    v_stale := v_stale + v_count;

    WITH victims AS MATERIALIZED (
      SELECT device.id
      FROM public.network_devices device
      WHERE device.organization_id = v_organization.organization_id
        AND device.device_kind = 'ARUBA'
        AND device.is_active
        AND device.aruba_discovery_last_seen_at < p_now - INTERVAL '7 days'
      ORDER BY device.aruba_discovery_last_seen_at, device.id
      FOR UPDATE SKIP LOCKED
      LIMIT 1000
    )
    UPDATE public.network_devices device
    SET is_active = false, lifecycle_status = 'STALE',
        updated_at = clock_timestamp()
    FROM victims
    WHERE device.id = victims.id;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    v_inactive := v_inactive + v_count;

    UPDATE public.network_devices device
    SET aruba_discovery_state = 'PINNED', updated_at = clock_timestamp()
    WHERE device.organization_id = v_organization.organization_id
      AND device.device_kind = 'ARUBA'
      AND device.aruba_discovery_state = 'DISCOVERED'
      AND (
        EXISTS (
          SELECT 1 FROM public.network_devices child
          WHERE child.parent_device_id = device.id
        )
        OR EXISTS (
          SELECT 1 FROM public.network_device_connections connection
          WHERE connection.device_id = device.id
        )
        OR EXISTS (
          SELECT 1 FROM public.network_desired_state_versions desired
          WHERE desired.router_device_id = device.id
        )
        OR EXISTS (
          SELECT 1 FROM public.network_client_sessions session
          WHERE session.device_id = device.id
        )
        OR EXISTS (
          SELECT 1 FROM public.network_incidents incident
          WHERE incident.device_id = device.id
        )
        OR EXISTS (
          SELECT 1 FROM public.network_commands command
          WHERE command.device_id = device.id
        )
        OR EXISTS (
          SELECT 1 FROM public.network_config_snapshots snapshot
          WHERE snapshot.device_id = device.id
        )
      );
    GET DIAGNOSTICS v_count = ROW_COUNT;
    v_pinned := v_pinned + v_count;

    WITH victims AS MATERIALIZED (
      SELECT alias.router_device_id, alias.stable_key, alias.alias
      FROM app_private.network_aruba_aliases alias
      WHERE alias.organization_id = v_organization.organization_id
        AND alias.tombstoned_at IS NULL
        AND alias.last_seen_at < p_now - INTERVAL '30 days'
        AND NOT EXISTS (
          SELECT 1
          FROM public.network_devices device
          WHERE device.parent_device_id = alias.router_device_id
            AND device.device_kind = 'ARUBA'
            AND device.aruba_stable_key = alias.stable_key
            AND device.aruba_discovery_last_seen_at >=
              p_now - INTERVAL '30 days'
        )
        AND NOT EXISTS (
          SELECT 1
          FROM app_private.network_aruba_discovery_candidates candidate
          WHERE candidate.router_device_id = alias.router_device_id
            AND candidate.stable_key = alias.stable_key
            AND candidate.last_seen_at >= p_now - INTERVAL '30 days'
        )
      ORDER BY alias.last_seen_at, alias.router_device_id,
               alias.stable_key, alias.alias
      FOR UPDATE SKIP LOCKED
      LIMIT 1000
    )
    UPDATE app_private.network_aruba_aliases alias
    SET tombstoned_at = p_now
    FROM victims
    WHERE alias.router_device_id = victims.router_device_id
      AND alias.stable_key = victims.stable_key
      AND alias.alias = victims.alias;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    v_aliases_tombstoned := v_aliases_tombstoned + v_count;

    WITH victims AS MATERIALIZED (
      SELECT candidate.router_device_id, candidate.stable_key
      FROM app_private.network_aruba_discovery_candidates candidate
      WHERE candidate.organization_id = v_organization.organization_id
        AND candidate.last_seen_at < p_now - INTERVAL '30 days'
      ORDER BY candidate.last_seen_at, candidate.router_device_id,
               candidate.stable_key
      FOR UPDATE SKIP LOCKED
      LIMIT 1000
    )
    DELETE FROM app_private.network_aruba_discovery_candidates candidate
    USING victims
    WHERE candidate.router_device_id = victims.router_device_id
      AND candidate.stable_key = victims.stable_key;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    v_candidates := v_candidates + v_count;

    WITH victims AS MATERIALIZED (
      SELECT device.id
      FROM public.network_devices device
      WHERE device.organization_id = v_organization.organization_id
        AND device.device_kind = 'ARUBA'
        AND device.aruba_discovery_state = 'DISCOVERED'
        AND device.aruba_discovery_last_seen_at < p_now - INTERVAL '30 days'
      ORDER BY device.aruba_discovery_last_seen_at, device.id
      FOR UPDATE SKIP LOCKED
      LIMIT 1000
    )
    DELETE FROM public.network_devices device
    USING victims
    WHERE device.id = victims.id
      AND device.aruba_discovery_state = 'DISCOVERED';
    GET DIAGNOSTICS v_count = ROW_COUNT;
    v_purged := v_purged + v_count;

    WITH victims AS MATERIALIZED (
      SELECT alias.router_device_id, alias.stable_key, alias.alias
      FROM app_private.network_aruba_aliases alias
      WHERE alias.organization_id = v_organization.organization_id
        AND alias.tombstoned_at < p_now - INTERVAL '90 days'
      ORDER BY alias.tombstoned_at, alias.router_device_id,
               alias.stable_key, alias.alias
      FOR UPDATE SKIP LOCKED
      LIMIT 1000
    )
    DELETE FROM app_private.network_aruba_aliases alias
    USING victims
    WHERE alias.router_device_id = victims.router_device_id
      AND alias.stable_key = victims.stable_key
      AND alias.alias = victims.alias;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    v_aliases := v_aliases + v_count;

    WITH victims AS MATERIALIZED (
      SELECT quarantine.id
      FROM app_private.network_aruba_quarantine quarantine
      WHERE quarantine.organization_id = v_organization.organization_id
        AND quarantine.observed_at < p_now - INTERVAL '7 days'
      ORDER BY quarantine.observed_at, quarantine.id
      FOR UPDATE SKIP LOCKED
      LIMIT 1000
    )
    DELETE FROM app_private.network_aruba_quarantine quarantine
    USING victims
    WHERE quarantine.id = victims.id;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    v_quarantine := v_quarantine + v_count;

    FOR v_router IN
      SELECT DISTINCT quarantine.router_device_id
      FROM app_private.network_aruba_quarantine quarantine
      WHERE quarantine.organization_id = v_organization.organization_id
      ORDER BY quarantine.router_device_id
    LOOP
      WITH bounded AS MATERIALIZED (
        SELECT quarantine.id, quarantine.observed_at
        FROM app_private.network_aruba_quarantine quarantine
        WHERE quarantine.router_device_id = v_router.router_device_id
        ORDER BY quarantine.observed_at DESC, quarantine.id DESC
        LIMIT 2000
      ), ranked AS MATERIALIZED (
        SELECT bounded.id,
               row_number() OVER (
                 ORDER BY bounded.observed_at DESC, bounded.id DESC
               ) AS keep_rank
        FROM bounded
      ), victims AS (
        SELECT ranked.id
        FROM ranked
        WHERE ranked.keep_rank > 1000
        ORDER BY ranked.keep_rank DESC
        LIMIT 1000
      )
      DELETE FROM app_private.network_aruba_quarantine quarantine
      USING victims
      WHERE quarantine.id = victims.id;
      GET DIAGNOSTICS v_count = ROW_COUNT;
      v_quarantine := v_quarantine + v_count;
    END LOOP;

    WITH victims AS MATERIALIZED (
      SELECT run.discovery_run_id
      FROM app_private.network_aruba_discovery_runs run
      WHERE run.organization_id = v_organization.organization_id
        AND run.created_at < p_now - INTERVAL '7 days'
      ORDER BY run.created_at, run.discovery_run_id
      FOR UPDATE SKIP LOCKED
      LIMIT 1000
    )
    DELETE FROM app_private.network_aruba_discovery_runs run
    USING victims
    WHERE run.discovery_run_id = victims.discovery_run_id;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    v_runs := v_runs + v_count;
  END LOOP;

  RETURN jsonb_build_object(
    'aruba_stale_marked', v_stale,
    'aruba_inactive_marked', v_inactive,
    'aruba_devices_pinned', v_pinned,
    'aruba_devices_purged', v_purged,
    'aruba_candidates_deleted', v_candidates,
    'aruba_aliases_tombstoned', v_aliases_tombstoned,
    'aruba_aliases_deleted', v_aliases,
    'aruba_quarantine_deleted', v_quarantine,
    'aruba_runs_deleted', v_runs,
    'aruba_stale_hours', 24,
    'aruba_inactive_days', 7,
    'aruba_discovery_retention_days', 30,
    'aruba_candidate_retention_days', 30,
    'aruba_alias_retention_days', 90,
    'aruba_quarantine_retention_days', 7,
    'aruba_quarantine_per_router', 1000
  );
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
  v_organization record;
  v_command_ids uuid[];
  v_dropped integer := 0;
  v_hourly_deleted bigint := 0;
  v_daily_deleted bigint := 0;
  v_sessions_deleted bigint := 0;
  v_commands_deleted bigint := 0;
  v_count bigint;
  v_aruba_report jsonb;
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

  v_aruba_report := app_private.network_center_aruba_retention_v1(p_now);

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
  ) || v_aruba_report;
END;
$fn$;

REVOKE ALL ON FUNCTION app_private.network_center_guard_command_immutable_v1()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.network_center_guard_aruba_parent_v1()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE app_private.network_center_command_retention_contexts
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE
  app_private.network_aruba_router_state,
  app_private.network_aruba_discovery_runs,
  app_private.network_aruba_discovery_batches,
  app_private.network_aruba_discovery_candidates,
  app_private.network_aruba_aliases,
  app_private.network_aruba_quarantine
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
REVOKE ALL ON FUNCTION app_private.network_center_aruba_retention_v1(
  timestamp with time zone
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.network_center_retention_v1(
  timestamp with time zone
) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON COLUMN public.network_commands.semantic_fingerprint IS
  'SHA-256 of canonical tenant, target, action and sanitized parameters; excludes reason and browser idempotency key.';
COMMENT ON TABLE app_private.network_center_command_retention_contexts IS
  'Transaction-bound retention capability keyed by backend PID and transaction ID; API roles have no access.';
COMMENT ON COLUMN public.network_devices.aruba_stable_key IS
  'Router-scoped Aruba identity derived from serial first, otherwise validated unicast hardware MAC; never a mutable display alias.';
COMMENT ON FUNCTION app_private.network_center_retention_v1(
  timestamp with time zone
) IS
  'Bounded repeat-safe retention for telemetry, client history and summarized terminal command data.';

COMMIT;

NOTIFY pgrst, 'reload schema';
