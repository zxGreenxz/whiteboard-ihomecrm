-- =============================================================================
-- Network Center hardening 1/4: server-owned worker identity and assignments.
--
-- The tables are deliberately inert to browser and service roles. Only the
-- service-role admin RPCs below can provision or change registry state. Worker
-- request RPCs consume the private digest authenticator in the later cutover
-- migration; no plaintext worker secret is stored in PostgreSQL.
-- =============================================================================

BEGIN;

ALTER TABLE public.network_devices
  ADD CONSTRAINT network_devices_worker_assignment_identity_key
  UNIQUE (organization_id, building_id, id, device_kind);

CREATE TABLE public.network_workers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_key text NOT NULL UNIQUE
    CHECK (worker_key ~ '^[a-z0-9][a-z0-9._-]{2,63}$'),
  display_name text NOT NULL
    CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 128),
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'DRAINING', 'DISABLED')),
  capabilities text[] NOT NULL DEFAULT '{}'::text[]
    CHECK (cardinality(capabilities) <= 32),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE public.network_worker_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id uuid NOT NULL
    REFERENCES public.network_workers(id) ON DELETE CASCADE,
  secret_digest character(64) NOT NULL
    CHECK (secret_digest ~ '^[a-f0-9]{64}$'),
  fingerprint text NOT NULL UNIQUE
    CHECK (fingerprint ~ '^sha256:[a-f0-9]{12,64}$'),
  not_before timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_by text NOT NULL DEFAULT 'service_role'
    CHECK (char_length(created_by) BETWEEN 1 AND 128),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (secret_digest),
  CONSTRAINT network_worker_credentials_valid_window
    CHECK (expires_at > not_before),
  CONSTRAINT network_worker_credentials_max_lifetime
    CHECK (expires_at <= not_before + INTERVAL '90 days')
);

CREATE INDEX network_worker_credentials_worker_window_idx
  ON public.network_worker_credentials
  (worker_id, revoked_at, not_before, expires_at, id);

CREATE TABLE public.network_worker_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id uuid NOT NULL
    REFERENCES public.network_workers(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL,
  building_id uuid NOT NULL,
  device_id uuid NOT NULL,
  device_kind text NOT NULL DEFAULT 'MIKROTIK'
    CHECK (device_kind = 'MIKROTIK'),
  can_poll boolean NOT NULL DEFAULT false,
  can_inventory boolean NOT NULL DEFAULT false,
  can_execute boolean NOT NULL DEFAULT false,
  active_from timestamptz NOT NULL DEFAULT clock_timestamp(),
  active_until timestamptz,
  assignment_version bigint NOT NULL DEFAULT 1
    CHECK (assignment_version > 0),
  created_by text NOT NULL DEFAULT 'service_role'
    CHECK (char_length(created_by) BETWEEN 1 AND 128),
  updated_by text NOT NULL DEFAULT 'service_role'
    CHECK (char_length(updated_by) BETWEEN 1 AND 128),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT network_worker_assignments_org_building_fk
    FOREIGN KEY (organization_id, building_id)
    REFERENCES public.buildings(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT network_worker_assignments_device_fk
    FOREIGN KEY (organization_id, building_id, device_id, device_kind)
    REFERENCES public.network_devices(organization_id, building_id, id, device_kind)
    ON DELETE RESTRICT,
  CONSTRAINT network_worker_assignments_active_window
    CHECK (active_until IS NULL OR active_until > active_from)
);

CREATE INDEX network_worker_assignments_worker_scope_idx
  ON public.network_worker_assignments
  (worker_id, organization_id, building_id, device_id, active_from DESC);

CREATE INDEX network_worker_assignments_device_scope_idx
  ON public.network_worker_assignments
  (organization_id, building_id, device_id, worker_id)
  WHERE active_until IS NULL;

CREATE INDEX network_worker_assignments_device_identity_idx
  ON public.network_worker_assignments
  (organization_id, building_id, device_id, device_kind);

CREATE UNIQUE INDEX network_worker_assignments_one_active_scope_idx
  ON public.network_worker_assignments
  (worker_id, organization_id, building_id, device_id)
  WHERE active_until IS NULL;

CREATE UNIQUE INDEX network_worker_assignments_one_active_poller_per_device_idx
  ON public.network_worker_assignments
  (organization_id, building_id, device_id)
  WHERE can_poll AND active_until IS NULL;

DROP TRIGGER IF EXISTS network_workers_set_updated_at ON public.network_workers;
CREATE TRIGGER network_workers_set_updated_at
  BEFORE UPDATE ON public.network_workers
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS network_worker_assignments_set_updated_at
  ON public.network_worker_assignments;
CREATE TRIGGER network_worker_assignments_set_updated_at
  BEFORE UPDATE ON public.network_worker_assignments
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.network_workers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.network_worker_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.network_worker_assignments ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.network_workers
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.network_worker_credentials
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.network_worker_assignments
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION app_private.network_center_authenticate_worker_v2(
  p_secret_digest text
)
RETURNS TABLE (
  worker_id uuid,
  worker_key text,
  worker_status text,
  capabilities text[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $fn$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_credential_id uuid;
BEGIN
  IF p_secret_digest IS NULL
     OR p_secret_digest !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'Worker authentication failed' USING ERRCODE = '28000';
  END IF;

  SELECT
    worker.id,
    worker.worker_key,
    worker.status,
    worker.capabilities,
    credential.id
  INTO
    worker_id,
    worker_key,
    worker_status,
    capabilities,
    v_credential_id
  FROM public.network_worker_credentials credential
  JOIN public.network_workers worker ON worker.id = credential.worker_id
  WHERE credential.secret_digest = p_secret_digest::character(64)
    AND credential.revoked_at IS NULL
    AND credential.not_before <= v_now
    AND credential.expires_at > v_now
    AND worker.status IN ('ACTIVE', 'DRAINING');

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Worker authentication failed' USING ERRCODE = '28000';
  END IF;

  UPDATE public.network_worker_credentials credential
  SET last_used_at = v_now
  WHERE credential.id = v_credential_id
    AND (
      credential.last_used_at IS NULL
      OR credential.last_used_at < v_now - INTERVAL '5 minutes'
    );

  RETURN NEXT;
END;
$fn$;

CREATE OR REPLACE FUNCTION app_private.network_center_replace_worker_assignments_v1(
  p_worker_id uuid,
  p_assignments jsonb,
  p_allow_empty boolean,
  p_actor text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $fn$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_item jsonb;
  v_organization_id uuid;
  v_building_id uuid;
  v_device_id uuid;
  v_can_poll boolean;
  v_can_inventory boolean;
  v_can_execute boolean;
  v_seen_devices uuid[] := '{}'::uuid[];
  v_count integer := 0;
BEGIN
  IF p_worker_id IS NULL OR p_actor IS NULL
     OR char_length(p_actor) NOT BETWEEN 1 AND 128 THEN
    RAISE EXCEPTION 'Invalid worker assignment request' USING ERRCODE = '22023';
  END IF;
  IF p_assignments IS NULL
     OR jsonb_typeof(p_assignments) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_assignments) > 100
     OR (NOT p_allow_empty AND jsonb_array_length(p_assignments) = 0) THEN
    RAISE EXCEPTION 'Worker assignments must be a bounded array'
      USING ERRCODE = '22023';
  END IF;

  PERFORM 1
  FROM public.network_workers worker
  WHERE worker.id = p_worker_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Worker not found' USING ERRCODE = 'P0002';
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_assignments)
  LOOP
    IF jsonb_typeof(v_item) <> 'object' THEN
      RAISE EXCEPTION 'Each worker assignment must be an object'
        USING ERRCODE = '22023';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM jsonb_object_keys(v_item) AS key_name
      WHERE key_name NOT IN (
        'organizationId', 'buildingId', 'deviceId',
        'canPoll', 'canInventory', 'canExecute'
      )
    ) THEN
      RAISE EXCEPTION 'Worker assignment contains an unsupported field'
        USING ERRCODE = '22023';
    END IF;

    BEGIN
      v_organization_id := (v_item->>'organizationId')::uuid;
      v_building_id := (v_item->>'buildingId')::uuid;
      v_device_id := (v_item->>'deviceId')::uuid;
      v_can_poll := coalesce((v_item->>'canPoll')::boolean, false);
      v_can_inventory := coalesce((v_item->>'canInventory')::boolean, false);
      v_can_execute := coalesce((v_item->>'canExecute')::boolean, false);
    EXCEPTION
      WHEN invalid_text_representation OR datetime_field_overflow THEN
        RAISE EXCEPTION 'Worker assignment contains an invalid field'
          USING ERRCODE = '22023';
    END;

    IF v_organization_id IS NULL OR v_building_id IS NULL OR v_device_id IS NULL THEN
      RAISE EXCEPTION 'Worker assignment target or interval is invalid'
        USING ERRCODE = '22023';
    END IF;
    IF v_device_id = ANY(v_seen_devices) THEN
      RAISE EXCEPTION 'Worker assignment contains a duplicate device'
        USING ERRCODE = '22023';
    END IF;

    PERFORM 1
    FROM public.network_devices device
    WHERE device.organization_id = v_organization_id
      AND device.building_id = v_building_id
      AND device.id = v_device_id
      AND device.device_kind = 'MIKROTIK'
      AND device.is_active;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Worker assignment target is not an active MikroTik'
        USING ERRCODE = '23503';
    END IF;

    v_seen_devices := array_append(v_seen_devices, v_device_id);
  END LOOP;

  UPDATE public.network_worker_assignments assignment
  SET
    active_until = greatest(v_now, assignment.active_from + INTERVAL '1 microsecond'),
    assignment_version = assignment.assignment_version + 1,
    updated_by = p_actor,
    updated_at = v_now
  WHERE assignment.worker_id = p_worker_id
    AND assignment.active_until IS NULL;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_assignments)
  LOOP
    v_organization_id := (v_item->>'organizationId')::uuid;
    v_building_id := (v_item->>'buildingId')::uuid;
    v_device_id := (v_item->>'deviceId')::uuid;
    v_can_poll := coalesce((v_item->>'canPoll')::boolean, false);
    v_can_inventory := coalesce((v_item->>'canInventory')::boolean, false);
    v_can_execute := coalesce((v_item->>'canExecute')::boolean, false);

    INSERT INTO public.network_worker_assignments (
      worker_id,
      organization_id,
      building_id,
      device_id,
      device_kind,
      can_poll,
      can_inventory,
      can_execute,
      active_from,
      active_until,
      created_by,
      updated_by
    ) VALUES (
      p_worker_id,
      v_organization_id,
      v_building_id,
      v_device_id,
      'MIKROTIK',
      v_can_poll,
      v_can_inventory,
      v_can_execute,
      v_now,
      NULL,
      p_actor,
      p_actor
    );
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.network_center_admin_provision_worker_v1(
  p_worker_key text,
  p_display_name text,
  p_secret_digest text,
  p_fingerprint text,
  p_expires_at timestamptz,
  p_assignments jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $fn$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_worker_id uuid;
  v_assignment_count integer;
BEGIN
  IF p_worker_key IS NULL
     OR p_worker_key !~ '^[a-z0-9][a-z0-9._-]{2,63}$'
     OR p_display_name IS NULL
     OR char_length(btrim(p_display_name)) NOT BETWEEN 1 AND 128
     OR p_secret_digest IS NULL
     OR p_secret_digest !~ '^[a-f0-9]{64}$'
     OR p_fingerprint IS NULL
     OR p_fingerprint !~ '^sha256:[a-f0-9]{12,64}$'
     OR p_expires_at IS NULL
     OR p_expires_at <= v_now + INTERVAL '5 minutes'
     OR p_expires_at > v_now + INTERVAL '90 days' THEN
    RAISE EXCEPTION 'Invalid worker provision request' USING ERRCODE = '22023';
  END IF;
  IF p_assignments IS NULL
     OR jsonb_typeof(p_assignments) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_assignments) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'Worker assignments must contain between 1 and 100 items'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.network_workers (
    worker_key,
    display_name,
    capabilities
  ) VALUES (
    p_worker_key,
    btrim(p_display_name),
    ARRAY[
      'HEARTBEAT', 'POLL', 'TELEMETRY', 'INVENTORY',
      'EXECUTE', 'INCIDENT', 'SNAPSHOT', 'MAINTENANCE'
    ]::text[]
  )
  RETURNING id INTO v_worker_id;

  INSERT INTO public.network_worker_credentials (
    worker_id,
    secret_digest,
    fingerprint,
    not_before,
    expires_at
  ) VALUES (
    v_worker_id,
    p_secret_digest::character(64),
    p_fingerprint,
    v_now,
    p_expires_at
  );

  v_assignment_count := app_private.network_center_replace_worker_assignments_v1(
    v_worker_id,
    p_assignments,
    false,
    'service_role:provision'
  );

  RETURN jsonb_build_object(
    'workerId', v_worker_id,
    'workerKey', p_worker_key,
    'status', 'ACTIVE',
    'credentialFingerprint', p_fingerprint,
    'assignmentCount', v_assignment_count
  );
END;
$fn$;

CREATE OR REPLACE FUNCTION public.network_center_admin_rotate_worker_credential_v1(
  p_worker_key text,
  p_secret_digest text,
  p_fingerprint text,
  p_not_before timestamptz,
  p_expires_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $fn$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_worker_id uuid;
  v_overlap_count integer;
BEGIN
  IF p_worker_key IS NULL
     OR p_secret_digest IS NULL
     OR p_secret_digest !~ '^[a-f0-9]{64}$'
     OR p_fingerprint IS NULL
     OR p_fingerprint !~ '^sha256:[a-f0-9]{12,64}$'
     OR p_not_before IS NULL
     OR p_not_before < v_now - INTERVAL '5 minutes'
     OR p_not_before > v_now + INTERVAL '24 hours'
     OR p_expires_at IS NULL
     OR p_expires_at <= p_not_before
     OR p_expires_at > p_not_before + INTERVAL '90 days' THEN
    RAISE EXCEPTION 'Invalid worker credential rotation request'
      USING ERRCODE = '22023';
  END IF;

  SELECT worker.id
  INTO v_worker_id
  FROM public.network_workers worker
  WHERE worker.worker_key = p_worker_key
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Worker not found' USING ERRCODE = 'P0002';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.network_worker_credentials credential
    WHERE credential.worker_id = v_worker_id
      AND credential.revoked_at IS NULL
      AND credential.not_before > p_not_before
  ) THEN
    RAISE EXCEPTION 'Cannot rotate before an already scheduled credential'
      USING ERRCODE = '22023';
  END IF;

  SELECT count(*)::integer
  INTO v_overlap_count
  FROM public.network_worker_credentials credential
  WHERE credential.worker_id = v_worker_id
    AND credential.revoked_at IS NULL
    AND credential.not_before <= p_not_before
    AND credential.not_before < p_expires_at
    AND credential.expires_at > p_not_before;
  IF v_overlap_count > 1 THEN
    RAISE EXCEPTION 'Credential rotation would overlap more than two versions'
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.network_worker_credentials credential
  SET expires_at = least(
    credential.expires_at,
    p_not_before + INTERVAL '24 hours'
  )
  WHERE credential.worker_id = v_worker_id
    AND credential.revoked_at IS NULL
    AND credential.not_before <= p_not_before
    AND credential.not_before < p_expires_at
    AND credential.expires_at > p_not_before;

  INSERT INTO public.network_worker_credentials (
    worker_id,
    secret_digest,
    fingerprint,
    not_before,
    expires_at,
    created_by
  ) VALUES (
    v_worker_id,
    p_secret_digest::character(64),
    p_fingerprint,
    p_not_before,
    p_expires_at,
    'service_role:rotate'
  );

  UPDATE public.network_workers worker
  SET version = worker.version + 1
  WHERE worker.id = v_worker_id;

  RETURN jsonb_build_object(
    'workerId', v_worker_id,
    'workerKey', p_worker_key,
    'credentialFingerprint', p_fingerprint,
    'notBefore', p_not_before,
    'expiresAt', p_expires_at
  );
END;
$fn$;

CREATE OR REPLACE FUNCTION public.network_center_admin_revoke_worker_credential_v1(
  p_worker_key text,
  p_fingerprint text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $fn$
DECLARE
  v_worker_id uuid;
  v_credential_id uuid;
BEGIN
  IF p_worker_key IS NULL OR p_fingerprint IS NULL
     OR p_fingerprint !~ '^sha256:[a-f0-9]{12,64}$' THEN
    RAISE EXCEPTION 'Invalid worker credential revoke request'
      USING ERRCODE = '22023';
  END IF;

  SELECT worker.id
  INTO v_worker_id
  FROM public.network_workers worker
  WHERE worker.worker_key = p_worker_key
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Worker not found' USING ERRCODE = 'P0002';
  END IF;

  UPDATE public.network_worker_credentials credential
  SET revoked_at = clock_timestamp()
  WHERE credential.worker_id = v_worker_id
    AND credential.fingerprint = p_fingerprint
    AND credential.revoked_at IS NULL
  RETURNING credential.id INTO v_credential_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active worker credential not found' USING ERRCODE = 'P0002';
  END IF;

  UPDATE public.network_workers worker
  SET version = worker.version + 1
  WHERE worker.id = v_worker_id;

  RETURN jsonb_build_object(
    'workerId', v_worker_id,
    'workerKey', p_worker_key,
    'credentialFingerprint', p_fingerprint,
    'revoked', true
  );
END;
$fn$;

CREATE OR REPLACE FUNCTION public.network_center_admin_set_worker_assignments_v1(
  p_worker_key text,
  p_assignments jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $fn$
DECLARE
  v_worker_id uuid;
  v_assignment_count integer;
BEGIN
  IF p_worker_key IS NULL OR p_worker_key !~ '^[a-z0-9][a-z0-9._-]{2,63}$'
     OR p_assignments IS NULL
     OR jsonb_typeof(p_assignments) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_assignments) > 100 THEN
    RAISE EXCEPTION 'Invalid worker assignment update request'
      USING ERRCODE = '22023';
  END IF;

  SELECT worker.id
  INTO v_worker_id
  FROM public.network_workers worker
  WHERE worker.worker_key = p_worker_key
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Worker not found' USING ERRCODE = 'P0002';
  END IF;

  v_assignment_count := app_private.network_center_replace_worker_assignments_v1(
    v_worker_id,
    p_assignments,
    true,
    'service_role:assign'
  );

  UPDATE public.network_workers worker
  SET version = worker.version + 1
  WHERE worker.id = v_worker_id;

  RETURN jsonb_build_object(
    'workerId', v_worker_id,
    'workerKey', p_worker_key,
    'assignmentCount', v_assignment_count
  );
END;
$fn$;

REVOKE ALL ON FUNCTION app_private.network_center_authenticate_worker_v2(text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.network_center_replace_worker_assignments_v1(uuid, jsonb, boolean, text)
  FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.network_center_admin_provision_worker_v1(text, text, text, text, timestamptz, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.network_center_admin_rotate_worker_credential_v1(text, text, text, timestamptz, timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.network_center_admin_revoke_worker_credential_v1(text, text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.network_center_admin_set_worker_assignments_v1(text, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.network_center_admin_provision_worker_v1(text, text, text, text, timestamptz, jsonb)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.network_center_admin_rotate_worker_credential_v1(text, text, text, timestamptz, timestamptz)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.network_center_admin_revoke_worker_credential_v1(text, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.network_center_admin_set_worker_assignments_v1(text, jsonb)
  TO service_role;

COMMENT ON TABLE public.network_workers IS
  'Server-owned Network Center worker principals. No browser or direct service-role table access.';
COMMENT ON TABLE public.network_worker_credentials IS
  'Per-worker SHA-256 verifier records with bounded rotation overlap; plaintext secrets never enter PostgreSQL.';
COMMENT ON TABLE public.network_worker_assignments IS
  'Explicit tenant/building/MikroTik assignments. There is no fleet wildcard assignment.';

COMMIT;

NOTIFY pgrst, 'reload schema';
