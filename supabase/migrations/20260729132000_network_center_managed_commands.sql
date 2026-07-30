-- Network Center: immutable RouterOS resources and fail-closed access-port targets.

BEGIN;

SELECT pg_advisory_xact_lock(20260729132000::bigint);

CREATE TABLE public.network_managed_resources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  building_id uuid NOT NULL,
  device_id uuid NOT NULL,
  resource_kind text NOT NULL
    CHECK (resource_kind IN ('ROUTER', 'INTERFACE', 'MANAGED_USER')),
  stable_key text NOT NULL
    CHECK (char_length(btrim(stable_key)) BETWEEN 1 AND 160),
  display_name text NOT NULL
    CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 160),
  enrolled_role text,
  protected boolean NOT NULL DEFAULT true,
  ownership_marker text,
  enrollment_state text NOT NULL DEFAULT 'DISCOVERED'
    CHECK (enrollment_state IN ('DISCOVERED', 'ENROLLED', 'REVOKED')),
  last_verified_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT network_managed_resources_device_fk
    FOREIGN KEY (organization_id, building_id, device_id)
    REFERENCES public.network_devices(organization_id, building_id, id)
    ON DELETE CASCADE,
  CONSTRAINT network_managed_resources_kind_fields_check CHECK (
    (
      resource_kind = 'INTERFACE'
      AND enrolled_role IN (
        'WAN', 'LAN', 'ACCESS', 'UPLINK', 'MANAGEMENT', 'UNKNOWN'
      )
      AND ownership_marker = 'routeros-default-name'
      AND stable_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'
    )
    OR (
      resource_kind = 'MANAGED_USER'
      AND enrolled_role IS NULL
      AND ownership_marker ~
        '^ihomecrm-network-center:v1:[A-Za-z0-9][A-Za-z0-9._-]{7,63}$'
    )
    OR (
      resource_kind = 'ROUTER'
      AND enrolled_role IS NULL
      AND ownership_marker IS NOT NULL
    )
  ),
  UNIQUE (device_id, resource_kind, stable_key),
  UNIQUE (organization_id, building_id, device_id, id)
);

CREATE INDEX network_managed_resources_scope_idx
  ON public.network_managed_resources (
    organization_id, building_id, device_id,
    resource_kind, enrollment_state, id
  );

ALTER TABLE public.network_managed_resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.network_managed_resources FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.network_managed_resources
  FROM PUBLIC, anon, authenticated, service_role;

ALTER TABLE public.network_commands
  ADD COLUMN IF NOT EXISTS managed_target jsonb,
  ADD COLUMN IF NOT EXISTS intent_type text,
  ADD COLUMN IF NOT EXISTS pre_observation jsonb,
  ADD COLUMN IF NOT EXISTS expected_postcondition jsonb,
  ADD COLUMN IF NOT EXISTS observation_deadline timestamptz,
  ADD COLUMN IF NOT EXISTS transition_version bigint NOT NULL DEFAULT 1;

ALTER TABLE public.network_config_snapshots
  ADD COLUMN IF NOT EXISTS encrypted_artifact_hash character(64);

DO $snapshot_constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.network_config_snapshots'::regclass
      AND conname = 'network_config_snapshots_encrypted_hash_check'
  ) THEN
    ALTER TABLE public.network_config_snapshots
      ADD CONSTRAINT network_config_snapshots_encrypted_hash_check CHECK (
        encrypted_artifact_hash IS NULL
        OR encrypted_artifact_hash ~ '^[a-f0-9]{64}$'
      );
  END IF;
END;
$snapshot_constraints$;

UPDATE public.network_commands command
SET
  managed_target = coalesce(command.managed_target, jsonb_strip_nulls(
    jsonb_build_object(
      'deviceId', command.device_id,
      'interfaceId', command.interface_id
    )
  )),
  intent_type = coalesce(command.intent_type, command.action_type),
  expected_postcondition = coalesce(command.expected_postcondition, CASE command.action_type
    WHEN 'FLUSH_DNS_CACHE' THEN jsonb_build_object('kind', 'DNS_COMMAND_ACK')
    WHEN 'RENEW_DHCP_LEASE' THEN jsonb_build_object(
      'kind', 'DHCP_BOUND_LEASE_NEWER_EXPIRY',
      'notApplicableCode', 'DHCP_RENEW_NOT_APPLICABLE'
    )
    WHEN 'CYCLE_ACCESS_PORT' THEN jsonb_build_object(
      'kind', 'IMMUTABLE_ACCESS_INTERFACE_CYCLE'
    )
    WHEN 'REBOOT_ROUTER' THEN jsonb_build_object('kind', 'NEW_BOOT_IDENTITY_AND_UPTIME')
    ELSE jsonb_build_object('kind', 'REDACTED_AND_ENCRYPTED_SNAPSHOT_HASHES')
  END),
  observation_deadline = coalesce(command.observation_deadline, command.created_at +
    CASE command.action_type
      WHEN 'REBOOT_ROUTER' THEN INTERVAL '10 minutes'
      WHEN 'CYCLE_ACCESS_PORT' THEN INTERVAL '3 minutes'
      WHEN 'CAPTURE_SNAPSHOT' THEN INTERVAL '10 minutes'
      ELSE INTERVAL '2 minutes'
    END
  )
WHERE command.managed_target IS NULL
   OR command.intent_type IS NULL
   OR command.expected_postcondition IS NULL
   OR command.observation_deadline IS NULL;

ALTER TABLE public.network_commands
  ALTER COLUMN managed_target SET NOT NULL,
  ALTER COLUMN intent_type SET NOT NULL,
  ALTER COLUMN expected_postcondition SET NOT NULL,
  ALTER COLUMN observation_deadline SET NOT NULL;

DO $constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.network_commands'::regclass
      AND conname = 'network_commands_typed_intent_check'
  ) THEN
    ALTER TABLE public.network_commands
      ADD CONSTRAINT network_commands_typed_intent_check CHECK (
        intent_type = action_type
        AND jsonb_typeof(managed_target) = 'object'
        AND octet_length(managed_target::text) <= 16384
        AND (pre_observation IS NULL OR (
          jsonb_typeof(pre_observation) = 'object'
          AND octet_length(pre_observation::text) <= 65536
        ))
        AND jsonb_typeof(expected_postcondition) = 'object'
        AND octet_length(expected_postcondition::text) <= 16384
        AND observation_deadline >= created_at
        AND transition_version > 0
      );
  END IF;
END;
$constraints$;

CREATE TABLE public.network_command_observations (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  building_id uuid NOT NULL,
  command_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  device_id uuid NOT NULL,
  attempt_no integer NOT NULL,
  lease_token uuid NOT NULL,
  fencing_generation bigint NOT NULL,
  transition_version_before bigint NOT NULL,
  observation_kind text NOT NULL CHECK (
    observation_kind IN ('PRE_ACTION', 'POST_ACTION', 'RECONCILIATION')
  ),
  evidence jsonb NOT NULL CHECK (
    jsonb_typeof(evidence) = 'object'
    AND octet_length(evidence::text) <= 65536
  ),
  evidence_hash character(64) NOT NULL
    CHECK (evidence_hash ~ '^[a-f0-9]{64}$'),
  observed_at timestamptz NOT NULL,
  worker_id text NOT NULL CHECK (
    worker_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$'
  ),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT network_command_observations_scope_fk
    FOREIGN KEY (organization_id, building_id, command_id)
    REFERENCES public.network_commands(organization_id, building_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT network_command_observations_attempt_fk
    FOREIGN KEY (organization_id, building_id, attempt_id)
    REFERENCES public.network_command_attempts(organization_id, building_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT network_command_observations_device_fk
    FOREIGN KEY (organization_id, building_id, device_id)
    REFERENCES public.network_devices(organization_id, building_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT network_command_observations_attempt_check CHECK (attempt_no > 0),
  CONSTRAINT network_command_observations_fencing_check CHECK (fencing_generation > 0),
  CONSTRAINT network_command_observations_version_check
    CHECK (transition_version_before > 0),
  UNIQUE (command_id, id)
);

CREATE INDEX network_command_observations_command_idx
  ON public.network_command_observations (
    organization_id, building_id, command_id,
    transition_version_before DESC, observed_at DESC, id DESC
  );

ALTER TABLE public.network_command_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.network_command_observations FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.network_command_observations
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION app_private.network_center_guard_command_observations_v1()
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
  RAISE EXCEPTION 'Network Center command observations are append-only'
    USING ERRCODE = '55000';
END;
$fn$;

DROP TRIGGER IF EXISTS network_command_observations_append_only
  ON public.network_command_observations;
CREATE TRIGGER network_command_observations_append_only
  BEFORE UPDATE OR DELETE ON public.network_command_observations
  FOR EACH ROW EXECUTE FUNCTION
    app_private.network_center_guard_command_observations_v1();

CREATE OR REPLACE FUNCTION app_private.network_center_guard_managed_resource_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (
      SELECT 1
      FROM public.network_devices device
      WHERE device.organization_id = OLD.organization_id
        AND device.building_id = OLD.building_id
        AND device.id = OLD.device_id
    ) THEN
      RAISE EXCEPTION 'Managed resource cannot be deleted while its device exists'
        USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;

  IF ROW(
    NEW.organization_id, NEW.building_id, NEW.device_id,
    NEW.resource_kind, NEW.stable_key, NEW.ownership_marker
  ) IS DISTINCT FROM ROW(
    OLD.organization_id, OLD.building_id, OLD.device_id,
    OLD.resource_kind, OLD.stable_key, OLD.ownership_marker
  ) THEN
    RAISE EXCEPTION 'Managed resource stable_key and ownership cannot change'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.enrollment_state = 'REVOKED'
     AND NEW.enrollment_state <> 'REVOKED' THEN
    RAISE EXCEPTION 'Managed resource enrollment_state REVOKED is terminal'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.enrollment_state = 'ENROLLED'
     AND NEW.enrolled_role IS DISTINCT FROM OLD.enrolled_role THEN
    RAISE EXCEPTION 'Managed resource enrolled role cannot change'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.protected AND NOT NEW.protected AND NOT (
    OLD.resource_kind = 'INTERFACE'
    AND OLD.enrollment_state = 'DISCOVERED'
    AND NEW.enrollment_state = 'ENROLLED'
    AND OLD.enrolled_role = 'ACCESS'
    AND NEW.enrolled_role = 'ACCESS'
    AND OLD.stable_key ~* '^ether([2-9]|[1-9][0-9])$'
  ) THEN
    RAISE EXCEPTION 'Managed resource protection cannot be downgraded'
      USING ERRCODE = '55000';
  END IF;
  IF NOT (
    NEW.enrollment_state = OLD.enrollment_state
    OR (
      OLD.enrollment_state = 'DISCOVERED'
      AND NEW.enrollment_state IN ('ENROLLED', 'REVOKED')
    )
    OR (
      OLD.enrollment_state = 'ENROLLED'
      AND NEW.enrollment_state = 'REVOKED'
    )
  ) THEN
    RAISE EXCEPTION 'Managed resource enrollment_state transition is invalid'
      USING ERRCODE = '55000';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS network_managed_resources_immutable_guard
  ON public.network_managed_resources;
CREATE TRIGGER network_managed_resources_immutable_guard
  BEFORE UPDATE OR DELETE ON public.network_managed_resources
  FOR EACH ROW EXECUTE FUNCTION
    app_private.network_center_guard_managed_resource_v1();

ALTER TABLE public.network_interfaces
  ADD COLUMN IF NOT EXISTS managed_resource_id uuid;

UPDATE public.network_interfaces
SET is_managed = false
WHERE managed_resource_id IS NULL;

ALTER TABLE public.network_interfaces
  DROP CONSTRAINT IF EXISTS network_interfaces_managed_resource_fk;
ALTER TABLE public.network_interfaces
  ADD CONSTRAINT network_interfaces_managed_resource_fk
  FOREIGN KEY (
    organization_id, building_id, device_id, managed_resource_id
  ) REFERENCES public.network_managed_resources(
    organization_id, building_id, device_id, id
  ) ON DELETE SET NULL (managed_resource_id);

CREATE UNIQUE INDEX IF NOT EXISTS network_interfaces_managed_resource_uidx
  ON public.network_interfaces (managed_resource_id)
  WHERE managed_resource_id IS NOT NULL;

CREATE OR REPLACE FUNCTION app_private.network_center_bind_managed_interface_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_immutable_key text;
  v_resource_id uuid;
  v_safe_access boolean;
  v_role text;
  v_protected boolean;
  v_state text;
BEGIN
  v_immutable_key := nullif(btrim(
    coalesce(NEW.display_metadata->>'immutableKey', '')
  ), '');
  IF v_immutable_key IS NULL THEN
    IF (TG_OP = 'UPDATE' AND OLD.managed_resource_id IS NOT NULL)
       OR NEW.managed_resource_id IS NOT NULL THEN
      RAISE EXCEPTION 'Managed interface immutable identity cannot be removed'
        USING ERRCODE = '55000';
    END IF;
    NEW.is_managed := false;
    RETURN NEW;
  END IF;
  IF v_immutable_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'
     OR NOT EXISTS (
       SELECT 1
       FROM public.network_devices device
       WHERE device.organization_id = NEW.organization_id
         AND device.building_id = NEW.building_id
         AND device.id = NEW.device_id
         AND device.device_kind = 'MIKROTIK'
     ) THEN
    RAISE EXCEPTION 'Invalid managed interface identity'
      USING ERRCODE = '22023';
  END IF;
  IF NEW.interface_key IS DISTINCT FROM v_immutable_key
     OR (
       TG_OP = 'UPDATE'
       AND OLD.managed_resource_id IS NOT NULL
       AND (
         OLD.interface_key IS DISTINCT FROM v_immutable_key
         OR NEW.managed_resource_id IS DISTINCT FROM OLD.managed_resource_id
       )
     ) THEN
    RAISE EXCEPTION 'Managed interface immutable identity cannot be rebound'
      USING ERRCODE = '55000';
  END IF;

  IF lower(v_immutable_key) = 'ether1' THEN
    NEW.interface_role := 'WAN';
    NEW.is_protected := true;
  END IF;
  v_safe_access := NEW.interface_kind = 'ETHERNET'
    AND NEW.interface_role = 'ACCESS'
    AND NEW.is_protected = false
    AND v_immutable_key ~* '^ether([2-9]|[1-9][0-9])$';
  v_role := NEW.interface_role;
  v_protected := true;
  v_state := CASE WHEN lower(v_immutable_key) = 'ether1'
    THEN 'ENROLLED' ELSE 'DISCOVERED' END;

  INSERT INTO public.network_managed_resources (
    organization_id, building_id, device_id, resource_kind,
    stable_key, display_name, enrolled_role, protected,
    ownership_marker, enrollment_state, last_verified_at,
    metadata
  ) VALUES (
    NEW.organization_id, NEW.building_id, NEW.device_id, 'INTERFACE',
    v_immutable_key, NEW.display_name, v_role, v_protected,
    'routeros-default-name', v_state, clock_timestamp(),
    jsonb_build_object(
      'source', 'routeros-inventory',
      'eligibleAccess', v_safe_access
    )
  )
  ON CONFLICT (device_id, resource_kind, stable_key) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    enrolled_role = CASE
      WHEN public.network_managed_resources.enrollment_state = 'DISCOVERED'
        THEN EXCLUDED.enrolled_role
      ELSE public.network_managed_resources.enrolled_role
    END,
    protected = CASE
      WHEN public.network_managed_resources.enrollment_state = 'ENROLLED'
        THEN public.network_managed_resources.protected
          OR coalesce((EXCLUDED.metadata->>'eligibleAccess')::boolean, false) = false
      ELSE public.network_managed_resources.protected OR EXCLUDED.protected
    END,
    enrollment_state = CASE
      WHEN public.network_managed_resources.enrollment_state = 'REVOKED'
        THEN 'REVOKED'
      ELSE public.network_managed_resources.enrollment_state
    END,
    last_verified_at = EXCLUDED.last_verified_at,
    metadata = public.network_managed_resources.metadata
      || EXCLUDED.metadata
  RETURNING id, enrolled_role, protected, enrollment_state
  INTO v_resource_id, v_role, v_protected, v_state;

  NEW.interface_key := v_immutable_key;
  NEW.managed_resource_id := v_resource_id;
  NEW.is_managed := true;
  NEW.is_protected := NEW.is_protected OR v_protected;
  NEW.interface_role := v_role;
  NEW.display_metadata := NEW.display_metadata
    || jsonb_build_object('immutableKey', v_immutable_key);
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS network_interfaces_bind_managed_resource
  ON public.network_interfaces;
CREATE TRIGGER network_interfaces_bind_managed_resource
  BEFORE INSERT OR UPDATE OF
    organization_id, building_id, device_id, interface_key,
    display_name, interface_kind, interface_role, is_protected,
    display_metadata, managed_resource_id
  ON public.network_interfaces
  FOR EACH ROW EXECUTE FUNCTION
    app_private.network_center_bind_managed_interface_v1();

CREATE OR REPLACE FUNCTION app_private.network_center_enroll_access_interface_v1(
  p_resource_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_interface_id uuid;
BEGIN
  SELECT interface.id INTO v_interface_id
  FROM public.network_managed_resources resource
  JOIN public.network_interfaces interface
    ON interface.organization_id = resource.organization_id
   AND interface.building_id = resource.building_id
   AND interface.device_id = resource.device_id
   AND interface.managed_resource_id = resource.id
  WHERE resource.id = p_resource_id
    AND resource.resource_kind = 'INTERFACE'
    AND resource.enrollment_state = 'DISCOVERED'
    AND resource.enrolled_role = 'ACCESS'
    AND resource.protected
    AND resource.metadata->>'eligibleAccess' = 'true'
    AND resource.stable_key ~* '^ether([2-9]|[1-9][0-9])$'
    AND interface.interface_kind = 'ETHERNET'
    AND interface.interface_role = 'ACCESS'
    AND interface.is_protected
    AND interface.is_managed
    AND interface.is_enabled
    AND interface.interface_key = resource.stable_key
  FOR UPDATE OF resource, interface;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Physical access resource is not eligible for enrollment'
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.network_managed_resources
  SET enrollment_state = 'ENROLLED', protected = false,
      last_verified_at = clock_timestamp()
  WHERE id = p_resource_id;

  UPDATE public.network_interfaces
  SET is_protected = false
  WHERE id = v_interface_id;
END;
$fn$;

CREATE OR REPLACE FUNCTION app_private.network_center_managed_interface_mapping_v1(
  p_device_id uuid
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'managedResourceId', resource.id,
    'id', interface.id,
    'interfaceKey', interface.interface_key,
    'currentName', interface.display_name,
    'immutableKey', resource.stable_key,
    'enrolledRole', coalesce(resource.enrolled_role, 'UNKNOWN'),
    'protected', interface.is_protected OR coalesce(resource.protected, true),
    'enrollmentState', coalesce(resource.enrollment_state, 'DISCOVERED')
  ) ORDER BY interface.interface_key, interface.id), '[]'::jsonb)
  FROM public.network_interfaces interface
  LEFT JOIN public.network_managed_resources resource
    ON resource.organization_id = interface.organization_id
   AND resource.building_id = interface.building_id
   AND resource.device_id = interface.device_id
   AND resource.id = interface.managed_resource_id
  WHERE interface.device_id = p_device_id
$fn$;

CREATE OR REPLACE FUNCTION app_private.network_center_guard_managed_command_target_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_resource public.network_managed_resources%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.pre_observation := NULL;
    NEW.transition_version := 1;
  END IF;
  NEW.intent_type := NEW.action_type;
  NEW.managed_target := jsonb_strip_nulls(jsonb_build_object(
    'deviceId', NEW.device_id,
    'interfaceId', NEW.interface_id
  ));
  NEW.expected_postcondition := CASE NEW.action_type
    WHEN 'FLUSH_DNS_CACHE' THEN jsonb_build_object('kind', 'DNS_COMMAND_ACK')
    WHEN 'RENEW_DHCP_LEASE' THEN jsonb_build_object(
      'kind', 'DHCP_BOUND_LEASE_NEWER_EXPIRY',
      'notApplicableCode', 'DHCP_RENEW_NOT_APPLICABLE'
    )
    WHEN 'CYCLE_ACCESS_PORT' THEN jsonb_build_object(
      'kind', 'IMMUTABLE_ACCESS_INTERFACE_CYCLE'
    )
    WHEN 'REBOOT_ROUTER' THEN jsonb_build_object(
      'kind', 'NEW_BOOT_IDENTITY_AND_UPTIME'
    )
    ELSE jsonb_build_object(
      'kind', 'REDACTED_AND_ENCRYPTED_SNAPSHOT_HASHES'
    )
  END;
  NEW.observation_deadline := coalesce(NEW.observation_deadline, NEW.created_at +
    CASE NEW.action_type
      WHEN 'REBOOT_ROUTER' THEN INTERVAL '10 minutes'
      WHEN 'CYCLE_ACCESS_PORT' THEN INTERVAL '3 minutes'
      WHEN 'CAPTURE_SNAPSHOT' THEN INTERVAL '10 minutes'
      ELSE INTERVAL '2 minutes'
    END
  );

  IF NEW.action_type <> 'CYCLE_ACCESS_PORT' THEN RETURN NEW; END IF;

  SELECT resource.* INTO v_resource
    FROM public.network_interfaces interface
    JOIN public.network_managed_resources resource
      ON resource.organization_id = interface.organization_id
     AND resource.building_id = interface.building_id
     AND resource.device_id = interface.device_id
     AND resource.id = interface.managed_resource_id
    WHERE interface.organization_id = NEW.organization_id
      AND interface.building_id = NEW.building_id
      AND interface.device_id = NEW.device_id
      AND interface.id = NEW.interface_id
      AND interface.is_managed
      AND interface.is_enabled
      AND interface.interface_kind = 'ETHERNET'
      AND interface.interface_role = 'ACCESS'
      AND interface.is_protected = false
      AND resource.resource_kind = 'INTERFACE'
      AND resource.stable_key = interface.interface_key
      AND resource.stable_key ~* '^ether([2-9]|[1-9][0-9])$'
      AND resource.enrollment_state = 'ENROLLED'
      AND resource.enrolled_role = 'ACCESS'
      AND resource.protected = false
    FOR KEY SHARE OF resource
  ;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Managed access interface is required'
      USING ERRCODE = '42501';
  END IF;
  NEW.managed_target := NEW.managed_target || jsonb_build_object(
    'managedResourceId', v_resource.id,
    'immutableKey', v_resource.stable_key
  );
  NEW.expected_postcondition := NEW.expected_postcondition || jsonb_build_object(
    'managedResourceId', v_resource.id,
    'immutableKey', v_resource.stable_key
  );
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS network_commands_managed_target_guard
  ON public.network_commands;
CREATE TRIGGER network_commands_managed_target_guard
  BEFORE INSERT OR UPDATE OF
    organization_id, building_id, device_id, interface_id, action_type
  ON public.network_commands
  FOR EACH ROW EXECUTE FUNCTION
    app_private.network_center_guard_managed_command_target_v1();

UPDATE public.network_commands command
SET
  managed_target = command.managed_target || jsonb_build_object(
    'managedResourceId', resource.id,
    'immutableKey', resource.stable_key
  ),
  expected_postcondition = command.expected_postcondition || jsonb_build_object(
    'managedResourceId', resource.id,
    'immutableKey', resource.stable_key
  )
FROM public.network_interfaces interface
JOIN public.network_managed_resources resource
  ON resource.organization_id = interface.organization_id
 AND resource.building_id = interface.building_id
 AND resource.device_id = interface.device_id
 AND resource.id = interface.managed_resource_id
WHERE command.action_type = 'CYCLE_ACCESS_PORT'
  AND command.organization_id = interface.organization_id
  AND command.building_id = interface.building_id
  AND command.device_id = interface.device_id
  AND command.interface_id = interface.id;

CREATE OR REPLACE FUNCTION app_private.network_center_guard_command_success_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_transition_authority text := current_setting(
    'app.network_center_transition_authority', true
  );
  v_success_authority text := current_setting(
    'app.network_center_success_authority', true
  );
BEGIN
  IF ROW(
    NEW.managed_target, NEW.intent_type,
    NEW.expected_postcondition, NEW.observation_deadline
  ) IS DISTINCT FROM ROW(
    OLD.managed_target, OLD.intent_type,
    OLD.expected_postcondition, OLD.observation_deadline
  ) THEN
    RAISE EXCEPTION 'Typed command intent fields cannot change'
      USING ERRCODE = '55000';
  END IF;
  IF (
    NEW.pre_observation IS DISTINCT FROM OLD.pre_observation
    OR NEW.transition_version IS DISTINCT FROM OLD.transition_version
  ) AND v_transition_authority IS DISTINCT FROM OLD.id::text THEN
    RAISE EXCEPTION 'Command observation state requires fenced SQL transition'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.status = 'SUCCEEDED'
     AND OLD.status IS DISTINCT FROM 'SUCCEEDED'
     AND v_success_authority IS DISTINCT FROM OLD.id::text THEN
    RAISE EXCEPTION 'Only typed SQL postcondition evaluation may write SUCCEEDED'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS network_commands_success_authority
  ON public.network_commands;
CREATE TRIGGER network_commands_success_authority
  BEFORE UPDATE ON public.network_commands
  FOR EACH ROW EXECUTE FUNCTION
    app_private.network_center_guard_command_success_v1();

CREATE OR REPLACE FUNCTION app_private.network_center_evaluate_postcondition_v1(
  p_command public.network_commands,
  p_before jsonb,
  p_after jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_before_expiry numeric;
  v_after_expiry numeric;
  v_before_uptime numeric;
  v_after_uptime numeric;
  v_before_at timestamptz;
  v_after_at timestamptz;
BEGIN
  p_before := coalesce(p_before, '{}'::jsonb);
  p_after := coalesce(p_after, '{}'::jsonb);
  BEGIN
    v_before_at := nullif(p_before->>'observedAt', '')::timestamptz;
    v_after_at := nullif(p_after->>'observedAt', '')::timestamptz;
  EXCEPTION WHEN others THEN
    RETURN jsonb_build_object(
      'outcome', 'UNCERTAIN', 'code', 'INVALID_OBSERVATION_TIME'
    );
  END;
  IF v_before_at IS NULL OR v_after_at IS NULL
     OR v_after_at < v_before_at
     OR v_after_at > p_command.observation_deadline THEN
    RETURN jsonb_build_object(
      'outcome', 'UNCERTAIN', 'code', 'OBSERVATION_DEADLINE_EXCEEDED'
    );
  END IF;

  IF p_command.action_type = 'FLUSH_DNS_CACHE' THEN
    IF p_after #>> '{dns,commandAck}' = 'true' THEN
      RETURN jsonb_build_object(
        'outcome', 'SUCCEEDED', 'dnsAck', true,
        'expected', p_command.expected_postcondition
      );
    END IF;
  ELSIF p_command.action_type = 'RENEW_DHCP_LEASE' THEN
    IF p_before #>> '{dhcp,notApplicable}' = 'true'
       OR p_after #>> '{dhcp,notApplicable}' = 'true' THEN
      RETURN jsonb_build_object(
        'outcome', 'FAILED', 'code', 'DHCP_RENEW_NOT_APPLICABLE',
        'notApplicable', true
      );
    END IF;
    IF coalesce(p_before #>> '{dhcp,expiresInSeconds}', '') ~ '^\d+(?:\.\d+)?$'
       AND coalesce(p_after #>> '{dhcp,expiresInSeconds}', '') ~ '^\d+(?:\.\d+)?$' THEN
      v_before_expiry := (p_before #>> '{dhcp,expiresInSeconds}')::numeric;
      v_after_expiry := (p_after #>> '{dhcp,expiresInSeconds}')::numeric;
      IF lower(coalesce(p_before #>> '{dhcp,status}', '')) = 'bound'
         AND lower(coalesce(p_after #>> '{dhcp,status}', '')) = 'bound'
         AND p_before #>> '{dhcp,leaseKey}' = p_after #>> '{dhcp,leaseKey}'
         AND v_after_expiry > v_before_expiry THEN
        RETURN jsonb_build_object(
          'outcome', 'SUCCEEDED',
          'leaseExpiresInSeconds', v_after_expiry,
          'previousLeaseExpiresInSeconds', v_before_expiry
        );
      END IF;
    END IF;
  ELSIF p_command.action_type = 'CYCLE_ACCESS_PORT' THEN
    IF p_after #>> '{accessInterface,managedResourceId}' =
         p_command.managed_target->>'managedResourceId'
       AND p_after #>> '{accessInterface,immutableKey}' =
         p_command.managed_target->>'immutableKey'
       AND p_after #>> '{accessInterface,disabledObserved}' = 'true'
       AND p_after #>> '{accessInterface,enabledObserved}' = 'true'
       AND p_after #>> '{accessInterface,enabled}' = 'true' THEN
      RETURN jsonb_build_object(
        'outcome', 'SUCCEEDED',
        'managedResourceId', p_command.managed_target->>'managedResourceId',
        'immutableKey', p_command.managed_target->>'immutableKey',
        'disabledObserved', true, 'enabledObserved', true
      );
    END IF;
  ELSIF p_command.action_type = 'REBOOT_ROUTER' THEN
    IF coalesce(p_before #>> '{boot,uptimeSeconds}', '') ~ '^\d+(?:\.\d+)?$'
       AND coalesce(p_after #>> '{boot,uptimeSeconds}', '') ~ '^\d+(?:\.\d+)?$' THEN
      v_before_uptime := (p_before #>> '{boot,uptimeSeconds}')::numeric;
      v_after_uptime := (p_after #>> '{boot,uptimeSeconds}')::numeric;
      IF nullif(p_before #>> '{boot,bootId}', '') IS NOT NULL
         AND nullif(p_after #>> '{boot,bootId}', '') IS NOT NULL
         AND p_before #>> '{boot,bootId}' <> p_after #>> '{boot,bootId}'
         AND v_after_uptime >= 0
         AND v_after_uptime < v_before_uptime THEN
        RETURN jsonb_build_object(
          'outcome', 'SUCCEEDED',
          'bootId', p_after #>> '{boot,bootId}',
          'uptimeSeconds', v_after_uptime,
          'previousBootId', p_before #>> '{boot,bootId}',
          'previousUptimeSeconds', v_before_uptime
        );
      END IF;
    END IF;
  ELSIF p_command.action_type = 'CAPTURE_SNAPSHOT' THEN
    IF coalesce(p_after #>> '{snapshot,redactedContentHash}', '') ~ '^[a-f0-9]{64}$'
       AND coalesce(p_after #>> '{snapshot,encryptedArtifactHash}', '') ~ '^[a-f0-9]{64}$'
       AND EXISTS (
         SELECT 1
         FROM public.network_config_snapshots snapshot
         WHERE snapshot.organization_id = p_command.organization_id
           AND snapshot.building_id = p_command.building_id
           AND snapshot.device_id = p_command.device_id
           AND snapshot.command_id = p_command.id
           AND snapshot.content_hash =
             p_after #>> '{snapshot,redactedContentHash}'
           AND snapshot.encrypted_artifact_hash =
             p_after #>> '{snapshot,encryptedArtifactHash}'
       ) THEN
      RETURN jsonb_build_object(
        'outcome', 'SUCCEEDED',
        'redactedContentHash', p_after #>> '{snapshot,redactedContentHash}',
        'encryptedArtifactHash', p_after #>> '{snapshot,encryptedArtifactHash}'
      );
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'outcome', 'UNCERTAIN',
    'code', 'POSTCONDITION_NOT_PROVEN',
    'expected', p_command.expected_postcondition
  );
END;
$fn$;

CREATE OR REPLACE FUNCTION app_private.network_center_record_command_observation_v1(
  p_worker_id text,
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
SET search_path TO 'pg_catalog', 'app_private', 'public', 'extensions'
AS $fn$
DECLARE
  v_command public.network_commands%ROWTYPE;
  v_existing public.network_command_observations%ROWTYPE;
  v_attempt_id uuid;
  v_evidence_hash character(64);
  v_first_pre_at timestamptz;
BEGIN
  p_worker_id := btrim(coalesce(p_worker_id, ''));
  p_observation_kind := upper(btrim(coalesce(p_observation_kind, '')));
  IF p_worker_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$'
     OR p_command_id IS NULL OR p_lease_token IS NULL
     OR p_fencing_generation < 1 OR p_transition_version < 1
     OR p_observation_id IS NULL
     OR p_observation_kind NOT IN (
       'PRE_ACTION', 'POST_ACTION', 'RECONCILIATION'
     )
     OR p_observed_at IS NULL
     OR p_evidence IS NULL OR jsonb_typeof(p_evidence) <> 'object'
     OR octet_length(p_evidence::text) > 65536 THEN
    RAISE EXCEPTION 'Invalid typed command observation' USING ERRCODE = '22023';
  END IF;
  PERFORM app_private.network_center_assert_safe_json_v1(
    p_evidence, 'typed command observation'
  );
  v_evidence_hash := encode(
    extensions.digest(convert_to(p_evidence::text, 'UTF8'), 'sha256'), 'hex'
  );

  SELECT observation.* INTO v_existing
  FROM public.network_command_observations observation
  WHERE observation.id = p_observation_id;
  IF FOUND THEN
    IF v_existing.command_id IS DISTINCT FROM p_command_id
       OR v_existing.lease_token IS DISTINCT FROM p_lease_token
       OR v_existing.fencing_generation IS DISTINCT FROM p_fencing_generation
       OR v_existing.transition_version_before IS DISTINCT FROM p_transition_version
       OR v_existing.observation_kind IS DISTINCT FROM p_observation_kind
       OR v_existing.observed_at IS DISTINCT FROM p_observed_at
       OR v_existing.worker_id IS DISTINCT FROM p_worker_id
       OR v_existing.evidence_hash IS DISTINCT FROM v_evidence_hash THEN
      RAISE EXCEPTION 'Command observation idempotency conflict'
        USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'accepted', true, 'duplicate', true,
      'commandId', p_command_id,
      'transitionVersion', p_transition_version + 1
    );
  END IF;

  SELECT command.* INTO v_command
  FROM public.network_commands command
  JOIN public.network_device_leases lease
    ON lease.organization_id = command.organization_id
   AND lease.building_id = command.building_id
   AND lease.device_id = command.device_id
   AND lease.command_id = command.id
   AND lease.lease_token = p_lease_token
   AND lease.lease_owner = p_worker_id
   AND lease.generation = p_fencing_generation
   AND lease.expires_at > clock_timestamp()
  WHERE command.id = p_command_id
    AND command.lease_token = p_lease_token
    AND command.lease_owner = p_worker_id
    AND command.lease_expires_at > clock_timestamp()
    AND command.transition_version = p_transition_version
    AND command.status IN ('LEASED', 'RUNNING', 'RECONCILING')
  FOR UPDATE OF command, lease;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Stale command observation fencing or transition version'
      USING ERRCODE = '55000',
        DETAIL = jsonb_build_object(
          'code', 'NETWORK_CENTER_STALE_TRANSITION',
          'commandId', p_command_id,
          'fencingGeneration', p_fencing_generation,
          'transitionVersion', p_transition_version
        )::text;
  END IF;
  IF p_observed_at < v_command.created_at - INTERVAL '5 minutes'
     OR p_observed_at > clock_timestamp() + INTERVAL '5 minutes'
     OR p_observed_at > v_command.observation_deadline THEN
    RAISE EXCEPTION 'Command observation is outside its trusted time window'
      USING ERRCODE = '22023';
  END IF;

  SELECT attempt.id INTO v_attempt_id
  FROM public.network_command_attempts attempt
  WHERE attempt.organization_id = v_command.organization_id
    AND attempt.building_id = v_command.building_id
    AND attempt.command_id = v_command.id
    AND attempt.attempt_no = v_command.attempt_count
    AND attempt.lease_token = p_lease_token
    AND attempt.worker_id = p_worker_id
  FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Command attempt does not match active fence'
      USING ERRCODE = '55000';
  END IF;

  SELECT min(observation.observed_at) INTO v_first_pre_at
  FROM public.network_command_observations observation
  WHERE observation.command_id = v_command.id
    AND observation.observation_kind = 'PRE_ACTION';
  IF p_observation_kind = 'PRE_ACTION' AND v_first_pre_at IS NOT NULL THEN
    RAISE EXCEPTION 'Command pre-observation is already frozen'
      USING ERRCODE = '55000';
  END IF;
  IF p_observation_kind IN ('POST_ACTION', 'RECONCILIATION')
     AND (v_first_pre_at IS NULL OR p_observed_at < v_first_pre_at) THEN
    RAISE EXCEPTION 'Post-observation requires an earlier durable pre-observation'
      USING ERRCODE = '55000';
  END IF;

  INSERT INTO public.network_command_observations (
    id, organization_id, building_id, command_id, attempt_id, device_id,
    attempt_no, lease_token, fencing_generation, transition_version_before,
    observation_kind, evidence, evidence_hash, observed_at, worker_id
  ) VALUES (
    p_observation_id, v_command.organization_id, v_command.building_id,
    v_command.id, v_attempt_id, v_command.device_id, v_command.attempt_count,
    p_lease_token, p_fencing_generation, p_transition_version,
    p_observation_kind, p_evidence, v_evidence_hash, p_observed_at, p_worker_id
  );

  PERFORM set_config(
    'app.network_center_transition_authority', v_command.id::text, true
  );
  UPDATE public.network_commands command
  SET
    pre_observation = CASE
      WHEN p_observation_kind = 'PRE_ACTION'
        THEN p_evidence || jsonb_build_object('observedAt', p_observed_at)
      ELSE command.pre_observation
    END,
    transition_version = command.transition_version + 1
  WHERE command.id = p_command_id
    AND command.transition_version = p_transition_version;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Stale command observation compare-and-swap'
      USING ERRCODE = '55000';
  END IF;
  RETURN jsonb_build_object(
    'accepted', true, 'duplicate', false,
    'commandId', p_command_id,
    'status', v_command.status,
    'transitionVersion', p_transition_version + 1
  );
END;
$fn$;

CREATE OR REPLACE FUNCTION app_private.network_center_transition_command_v1(
  p_worker_id text,
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
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_command public.network_commands%ROWTYPE;
  v_before jsonb;
  v_after jsonb;
  v_decision jsonb;
  v_database_outcome text;
  v_result jsonb := coalesce(p_result, '{}'::jsonb) - 'reconciliationDecision';
  v_response jsonb;
BEGIN
  p_worker_id := btrim(coalesce(p_worker_id, ''));
  p_outcome := upper(btrim(coalesce(p_outcome, '')));
  IF p_worker_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$'
     OR p_command_id IS NULL OR p_lease_token IS NULL
     OR p_fencing_generation < 1 OR p_transition_version < 1
     OR p_outcome NOT IN (
       'EVALUATE_POSTCONDITION', 'RETRYABLE_FAILURE', 'FAILED',
       'UNCERTAIN', 'CANCELLED_BY_KILL_SWITCH'
     )
     OR jsonb_typeof(v_result) <> 'object'
     OR octet_length(v_result::text) > 65536
     OR (p_rollback IS NOT NULL AND (
       jsonb_typeof(p_rollback) <> 'object'
       OR octet_length(p_rollback::text) > 65536
     ))
     OR p_retry_delay_seconds NOT BETWEEN 5 AND 3600 THEN
    RAISE EXCEPTION 'Invalid typed command transition' USING ERRCODE = '22023';
  END IF;

  SELECT command.* INTO v_command
  FROM public.network_commands command
  JOIN public.network_device_leases lease
    ON lease.organization_id = command.organization_id
   AND lease.building_id = command.building_id
   AND lease.device_id = command.device_id
   AND lease.command_id = command.id
   AND lease.lease_token = p_lease_token
   AND lease.lease_owner = p_worker_id
   AND lease.generation = p_fencing_generation
   AND lease.expires_at > clock_timestamp()
  WHERE command.id = p_command_id
    AND command.lease_token = p_lease_token
    AND command.lease_owner = p_worker_id
    AND command.lease_expires_at > clock_timestamp()
    AND command.transition_version = p_transition_version
    AND command.status IN ('LEASED', 'RUNNING', 'RECONCILING')
  FOR UPDATE OF command, lease;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Stale command fencing or transition version'
      USING ERRCODE = '55000',
        DETAIL = jsonb_build_object(
          'code', 'NETWORK_CENTER_STALE_TRANSITION',
          'commandId', p_command_id,
          'fencingGeneration', p_fencing_generation,
          'transitionVersion', p_transition_version
        )::text;
  END IF;

  SELECT observation.evidence || jsonb_build_object(
    'observedAt', observation.observed_at
  ) INTO v_before
  FROM public.network_command_observations observation
  WHERE observation.command_id = v_command.id
    AND observation.observation_kind = 'PRE_ACTION'
  ORDER BY observation.transition_version_before, observation.observed_at,
    observation.id
  LIMIT 1;
  v_before := coalesce(v_command.pre_observation, v_before);

  SELECT observation.evidence || jsonb_build_object(
    'observedAt', observation.observed_at
  ) INTO v_after
  FROM public.network_command_observations observation
  WHERE observation.command_id = v_command.id
    AND observation.observation_kind IN ('POST_ACTION', 'RECONCILIATION')
  ORDER BY observation.transition_version_before DESC,
    observation.observed_at DESC, observation.id DESC
  LIMIT 1;

  IF p_outcome = 'EVALUATE_POSTCONDITION' THEN
    v_decision := app_private.network_center_evaluate_postcondition_v1(
      v_command, v_before, v_after
    );
    v_database_outcome := CASE v_decision->>'outcome'
      WHEN 'SUCCEEDED' THEN 'SUCCEEDED'
      WHEN 'FAILED' THEN 'FAILED'
      ELSE 'UNCERTAIN'
    END;
    v_result := v_result || jsonb_build_object(
      'postcondition', v_decision,
      'transitionVersion', p_transition_version + 1
    );
    IF v_database_outcome = 'FAILED'
       AND v_decision ? 'code' AND NOT v_result ? 'code' THEN
      v_result := v_result || jsonb_build_object('code', v_decision->>'code');
    END IF;
  ELSE
    v_database_outcome := p_outcome;
  END IF;

  PERFORM set_config(
    'app.network_center_transition_authority', v_command.id::text, true
  );
  UPDATE public.network_commands command
  SET transition_version = command.transition_version + 1
  WHERE command.id = p_command_id
    AND command.transition_version = p_transition_version;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Stale command transition compare-and-swap'
      USING ERRCODE = '55000';
  END IF;

  IF v_database_outcome = 'SUCCEEDED' THEN
    PERFORM set_config(
      'app.network_center_success_authority', v_command.id::text, true
    );
  END IF;
  v_response := public.network_center_worker_complete_v1(
    p_worker_id, p_command_id, p_lease_token, v_database_outcome,
    v_result, p_rollback, p_retry_delay_seconds
  );
  RETURN v_response || jsonb_build_object(
    'transitionVersion', p_transition_version + 1
  );
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
DECLARE
  v_now timestamptz := clock_timestamp();
BEGIN
  IF p_worker_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$'
     OR p_limit NOT BETWEEN 1 AND 20
     OR p_lease_seconds NOT BETWEEN 15 AND 300 THEN
    RAISE EXCEPTION 'Invalid reconciliation claim request'
      USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  WITH candidates AS MATERIALIZED (
    SELECT command.*, gen_random_uuid() AS new_token
    FROM public.network_commands command
    WHERE command.status = 'UNCERTAIN'
      AND command.reconciliation_state = 'REQUIRED'
      AND NOT EXISTS (
        SELECT 1
        FROM public.network_device_leases lease
        WHERE lease.device_id = command.device_id
          AND lease.expires_at > v_now
      )
    ORDER BY command.updated_at, command.id
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  ),
  leases AS (
    INSERT INTO public.network_device_leases (
      device_id, organization_id, building_id, command_id, lease_token,
      lease_owner, acquired_at, heartbeat_at, expires_at, generation
    )
    SELECT
      candidate.device_id, candidate.organization_id, candidate.building_id,
      candidate.id, candidate.new_token, p_worker_id, v_now, v_now,
      v_now + make_interval(secs => p_lease_seconds), 1
    FROM candidates candidate
    ON CONFLICT ON CONSTRAINT network_device_leases_pkey DO UPDATE SET
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
  ),
  claimed AS (
    UPDATE public.network_commands command
    SET
      status = 'RECONCILING',
      reconciliation_state = 'IN_PROGRESS',
      lease_token = lease.lease_token,
      lease_owner = p_worker_id,
      lease_expires_at = lease.expires_at,
      updated_at = v_now
    FROM leases lease
    WHERE command.id = lease.command_id
    RETURNING command.*
  ),
  events AS (
    INSERT INTO public.network_command_events (
      organization_id, building_id, command_id, attempt_id, event_seq,
      event_kind, occurred_at, worker_id, payload
    )
    SELECT
      claimed.organization_id, claimed.building_id, claimed.id,
      (
        SELECT attempt.id
        FROM public.network_command_attempts attempt
        WHERE attempt.command_id = claimed.id
        ORDER BY attempt.attempt_no DESC
        LIMIT 1
      ),
      coalesce((
        SELECT max(event.event_seq) + 1
        FROM public.network_command_events event
        WHERE event.command_id = claimed.id
      ), 1),
      'RECONCILIATION_STARTED', v_now, p_worker_id,
      jsonb_build_object('leaseExpiresAt', claimed.lease_expires_at)
    FROM claimed
    RETURNING command_id
  )
  SELECT
    claimed.id, claimed.organization_id, claimed.building_id,
    claimed.device_id, claimed.interface_id, claimed.action_type,
    claimed.reason, claimed.sanitized_parameters, claimed.attempt_count,
    claimed.lease_token, claimed.lease_expires_at
  FROM claimed
  JOIN events ON events.command_id = claimed.id;
END;
$fn$;

CREATE OR REPLACE FUNCTION app_private.network_center_claim_commands_v1(
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
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_now timestamptz := clock_timestamp();
BEGIN
  p_worker_id := btrim(coalesce(p_worker_id, ''));
  IF p_worker_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$'
     OR p_limit NOT BETWEEN 1 AND 20
     OR p_lease_seconds NOT BETWEEN 15 AND 300 THEN
    RAISE EXCEPTION 'Invalid command claim request' USING ERRCODE = '22023';
  END IF;

  PERFORM app_private.network_center_reclaim_expired_commands_v1(v_now);

  RETURN QUERY
  WITH candidates AS MATERIALIZED (
    SELECT
      command.id,
      command.organization_id,
      command.building_id,
      command.device_id,
      gen_random_uuid() AS token
    FROM public.network_commands command
    WHERE command.status IN ('QUEUED', 'RETRY_WAIT')
      AND command.available_at <= v_now
      AND command.attempt_count < command.max_attempts
      AND (
        command.action_type = 'CAPTURE_SNAPSHOT'
        OR EXISTS (
          SELECT 1
          FROM public.network_site_settings settings
          WHERE settings.organization_id = command.organization_id
            AND settings.building_id = command.building_id
            AND NOT settings.changes_paused
        )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.network_device_leases lease
        WHERE lease.device_id = command.device_id
          AND lease.expires_at > v_now
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.network_commands unresolved
        WHERE unresolved.device_id = command.device_id
          AND unresolved.status = 'UNCERTAIN'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.network_commands earlier
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
    ORDER BY
      command.priority DESC, command.available_at, command.created_at,
      command.id
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  ),
  leased AS (
    INSERT INTO public.network_device_leases (
      device_id, organization_id, building_id, command_id, lease_token,
      lease_owner, acquired_at, heartbeat_at, expires_at, generation
    )
    SELECT
      candidate.device_id,
      candidate.organization_id,
      candidate.building_id,
      candidate.id,
      candidate.token,
      p_worker_id,
      v_now,
      v_now,
      v_now + make_interval(secs => p_lease_seconds),
      1
    FROM candidates candidate
    ON CONFLICT ON CONSTRAINT network_device_leases_pkey DO UPDATE SET
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
    RETURNING
      public.network_device_leases.device_id,
      public.network_device_leases.command_id,
      public.network_device_leases.lease_token,
      public.network_device_leases.expires_at
  ),
  claimed AS (
    UPDATE public.network_commands command
    SET
      status = 'LEASED',
      lease_token = lease.lease_token,
      lease_owner = p_worker_id,
      lease_expires_at = lease.expires_at,
      attempt_count = command.attempt_count + 1,
      started_at = coalesce(command.started_at, v_now),
      updated_at = v_now
    FROM leased lease
    WHERE command.id = lease.command_id
    RETURNING command.*
  ),
  attempts AS (
    INSERT INTO public.network_command_attempts (
      organization_id, building_id, command_id, device_id, attempt_no,
      worker_id, lease_token, outcome, started_at
    )
    SELECT
      claimed.organization_id,
      claimed.building_id,
      claimed.id,
      claimed.device_id,
      claimed.attempt_count,
      p_worker_id,
      claimed.lease_token,
      'STARTED',
      v_now
    FROM claimed
    RETURNING
      public.network_command_attempts.id,
      public.network_command_attempts.organization_id,
      public.network_command_attempts.building_id,
      public.network_command_attempts.command_id
  ),
  events AS (
    INSERT INTO public.network_command_events (
      organization_id, building_id, command_id, attempt_id, event_seq,
      event_kind, occurred_at, worker_id, payload
    )
    SELECT
      attempts.organization_id,
      attempts.building_id,
      attempts.command_id,
      attempts.id,
      coalesce((
        SELECT max(existing_event.event_seq) + 1
        FROM public.network_command_events existing_event
        WHERE existing_event.command_id = attempts.command_id
      ), 1),
      'LEASED',
      v_now,
      p_worker_id,
      jsonb_build_object(
        'attemptNo', claimed.attempt_count,
        'leaseExpiresAt', claimed.lease_expires_at
      )
    FROM claimed
    JOIN attempts ON attempts.command_id = claimed.id
    RETURNING public.network_command_events.command_id
  )
  SELECT
    claimed.id,
    claimed.organization_id,
    claimed.building_id,
    claimed.device_id,
    claimed.interface_id,
    claimed.action_type,
    claimed.reason,
    claimed.sanitized_parameters,
    claimed.attempt_count,
    claimed.lease_token,
    claimed.lease_expires_at
  FROM claimed
  JOIN attempts ON attempts.command_id = claimed.id
  JOIN events ON events.command_id = claimed.id
  ORDER BY claimed.priority DESC, claimed.created_at, claimed.id;
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
DECLARE
  v_regular jsonb;
  v_reconcile jsonb;
BEGIN
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'commandId', claim.command_id, 'organizationId', claim.organization_id,
    'buildingId', claim.building_id, 'deviceId', claim.device_id,
    'interfaceId', claim.interface_id, 'actionType', claim.action_type,
    'reason', claim.reason, 'parameters', claim.sanitized_parameters,
    'attemptNo', claim.attempt_no, 'leaseToken', claim.lease_token,
    'leaseExpiresAt', claim.lease_expires_at, 'reconciliation', false,
    'intentType', command.intent_type, 'managedTarget', command.managed_target,
    'preObservation', command.pre_observation,
    'expectedPostcondition', command.expected_postcondition,
    'observationDeadline', command.observation_deadline,
    'transitionVersion', command.transition_version,
    'fencingGeneration', lease.generation
  )), '[]'::jsonb) INTO v_regular
  FROM app_private.network_center_claim_commands_v1(
    p_worker_id, p_limit, p_lease_seconds
  ) claim
  JOIN public.network_commands command ON command.id = claim.command_id
  JOIN public.network_device_leases lease
    ON lease.device_id = command.device_id
   AND lease.command_id = command.id
   AND lease.lease_token = claim.lease_token
   AND lease.lease_owner = p_worker_id;

  IF jsonb_array_length(v_regular) < p_limit THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'commandId', claim.command_id, 'organizationId', claim.organization_id,
      'buildingId', claim.building_id, 'deviceId', claim.device_id,
      'interfaceId', claim.interface_id, 'actionType', claim.action_type,
      'reason', claim.reason, 'parameters', claim.sanitized_parameters,
      'attemptNo', claim.attempt_no, 'leaseToken', claim.lease_token,
      'leaseExpiresAt', claim.lease_expires_at, 'reconciliation', true,
      'intentType', command.intent_type, 'managedTarget', command.managed_target,
      'preObservation', command.pre_observation,
      'expectedPostcondition', command.expected_postcondition,
      'observationDeadline', command.observation_deadline,
      'transitionVersion', command.transition_version,
      'fencingGeneration', lease.generation
    )), '[]'::jsonb) INTO v_reconcile
    FROM app_private.network_center_claim_reconciliation_v1(
      p_worker_id, p_limit - jsonb_array_length(v_regular), p_lease_seconds
    ) claim
    JOIN public.network_commands command ON command.id = claim.command_id
    JOIN public.network_device_leases lease
      ON lease.device_id = command.device_id
     AND lease.command_id = command.id
     AND lease.lease_token = claim.lease_token
     AND lease.lease_owner = p_worker_id;
  ELSE
    v_reconcile := '[]'::jsonb;
  END IF;
  RETURN jsonb_build_object(
    'items', v_regular || coalesce(v_reconcile, '[]'::jsonb)
  );
END;
$fn$;

ALTER FUNCTION app_private.network_center_retention_v1(
  timestamp with time zone
) RENAME TO network_center_retention_pre_observations_v1;

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
  v_organization record;
  v_command_ids uuid[];
  v_count bigint;
  v_observations_deleted bigint := 0;
  v_report jsonb;
BEGIN
  IF p_now IS NULL THEN
    RAISE EXCEPTION 'Retention timestamp is required' USING ERRCODE = '22023';
  END IF;

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

    INSERT INTO app_private.network_center_command_retention_contexts (
      backend_pid, transaction_id
    ) VALUES (
      pg_backend_pid(), txid_current()
    ) ON CONFLICT (backend_pid, transaction_id) DO NOTHING;
    PERFORM set_config(
      'app_private.network_center_command_retention', 'on', true
    );

    DELETE FROM public.network_command_observations observation
    WHERE observation.command_id = ANY(v_command_ids);
    GET DIAGNOSTICS v_count = ROW_COUNT;
    v_observations_deleted := v_observations_deleted + v_count;
  END LOOP;

  v_report := app_private.network_center_retention_pre_observations_v1(p_now);

  DELETE FROM app_private.network_center_command_retention_contexts context
  WHERE context.backend_pid = pg_backend_pid()
    AND context.transaction_id = txid_current();
  PERFORM set_config(
    'app_private.network_center_command_retention', 'off', true
  );

  RETURN v_report || jsonb_build_object(
    'command_observations_deleted', v_observations_deleted
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
  v_encrypted_artifact_hash text;
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
  v_encrypted_artifact_hash := lower(btrim(coalesce(
    p_payload->>'encryptedArtifactHash', ''
  )));
  v_artifact_key := nullif(btrim(coalesce(p_payload->>'artifactKey', '')), '');
  IF v_source NOT IN ('MANUAL', 'SCHEDULED', 'PRE_ACTION', 'POST_ACTION')
     OR jsonb_typeof(v_normalized) <> 'object'
     OR octet_length(v_normalized::text) > 1048576
     OR jsonb_typeof(v_lines) <> 'array'
     OR octet_length(v_lines::text) > 1048576
     OR v_hash !~ '^[a-f0-9]{64}$'
     OR v_encrypted_artifact_hash !~ '^[a-f0-9]{64}$'
     OR (v_artifact_key IS NOT NULL AND (
       char_length(v_artifact_key) NOT BETWEEN 8 AND 500
       OR v_artifact_key !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]+$'
     )) THEN
    RAISE EXCEPTION 'Malformed or unbounded redacted snapshot'
      USING ERRCODE = '22023';
  END IF;
  PERFORM app_private.network_center_assert_safe_json_v1(
    v_normalized, 'normalized configuration snapshot'
  );
  PERFORM app_private.network_center_assert_safe_json_v1(
    v_lines, 'redacted configuration lines'
  );
  SELECT device.* INTO v_device
  FROM public.network_devices device
  WHERE device.id = (p_payload->>'deviceId')::uuid
    AND device.device_kind = 'MIKROTIK'
    AND device.is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Snapshot device not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_command_id IS NOT NULL THEN
    SELECT command.* INTO v_command
    FROM public.network_commands command
    WHERE command.id = v_command_id
      AND command.organization_id = v_device.organization_id
      AND command.building_id = v_device.building_id
      AND command.device_id = v_device.id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Snapshot command not found' USING ERRCODE = 'P0002';
    END IF;
  END IF;
  INSERT INTO public.network_config_snapshots (
    id, organization_id, building_id, device_id, command_id, source,
    schema_version, normalized_content, redacted_lines, content_hash,
    encrypted_artifact_hash, artifact_key, created_by, worker_id
  ) VALUES (
    v_snapshot_id, v_device.organization_id, v_device.building_id, v_device.id,
    v_command_id, v_source, coalesce((p_payload->>'schemaVersion')::integer, 1),
    v_normalized, v_lines, v_hash, v_encrypted_artifact_hash,
    v_artifact_key, v_command.requested_by, p_worker_id
  ) ON CONFLICT (id) DO NOTHING;
  SELECT snapshot.* INTO v_snapshot
  FROM public.network_config_snapshots snapshot
  WHERE snapshot.id = v_snapshot_id
    AND snapshot.organization_id = v_device.organization_id
    AND snapshot.building_id = v_device.building_id
    AND snapshot.device_id = v_device.id;
  IF NOT FOUND
     OR v_snapshot.content_hash IS DISTINCT FROM v_hash
     OR v_snapshot.encrypted_artifact_hash IS DISTINCT FROM
       v_encrypted_artifact_hash THEN
    RAISE EXCEPTION 'Snapshot idempotency conflict' USING ERRCODE = '23505';
  END IF;
  RETURN jsonb_build_object(
    'snapshotId', v_snapshot.id,
    'contentHash', v_snapshot.content_hash,
    'encryptedArtifactHash', v_snapshot.encrypted_artifact_hash,
    'createdAt', v_snapshot.created_at,
    'source', v_snapshot.source
  );
END;
$fn$;

CREATE OR REPLACE FUNCTION public.network_center_get_command_v1(
  p_building_id uuid,
  p_command_id uuid,
  p_request_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_command public.network_commands%ROWTYPE;
  v_scope record;
BEGIN
  IF p_building_id IS NULL
     OR ((p_command_id IS NULL) = (p_request_id IS NULL)) THEN
    RAISE EXCEPTION 'Exactly one command or request identity is required'
      USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_scope
  FROM app_private.network_center_require_view_v1(p_building_id);
  SELECT command.* INTO v_command
  FROM public.network_commands command
  WHERE command.organization_id = v_scope.organization_id
    AND command.building_id = p_building_id
    AND (
      (p_command_id IS NOT NULL AND command.id = p_command_id)
      OR (
        p_request_id IS NOT NULL
        AND command.idempotency_key = p_request_id::text
        AND command.requested_by = auth.uid()
      )
    );
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Network Center command not found' USING ERRCODE = 'P0002';
  END IF;
  RETURN jsonb_build_object(
    'id', v_command.id,
    'requestId', v_command.idempotency_key,
    'actionType', v_command.action_type,
    'reason', v_command.reason,
    'parameters', v_command.sanitized_parameters,
    'target', v_command.target_display,
    'requestedBy', v_command.requested_by,
    'status', v_command.status,
    'attemptCount', v_command.attempt_count,
    'result', v_command.result,
    'rollback', v_command.rollback,
    'reconciliationState', v_command.reconciliation_state,
    'transitionVersion', v_command.transition_version,
    'createdAt', v_command.created_at,
    'startedAt', v_command.started_at,
    'finishedAt', v_command.finished_at
  );
END;
$fn$;

REVOKE ALL ON FUNCTION
  app_private.network_center_guard_managed_resource_v1()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION
  app_private.network_center_bind_managed_interface_v1()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION
  app_private.network_center_enroll_access_interface_v1(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION
  app_private.network_center_managed_interface_mapping_v1(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION
  app_private.network_center_guard_managed_command_target_v1()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION
  app_private.network_center_guard_command_success_v1()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION
  app_private.network_center_guard_command_observations_v1()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION
  app_private.network_center_evaluate_postcondition_v1(
    public.network_commands, jsonb, jsonb
  ) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION
  app_private.network_center_record_command_observation_v1(
    text, uuid, uuid, bigint, bigint, uuid, text,
    timestamp with time zone, jsonb
  ) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION
  app_private.network_center_transition_command_v1(
    text, uuid, uuid, bigint, bigint, text, jsonb, jsonb, integer
  ) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION
  app_private.network_center_retention_pre_observations_v1(
    timestamp with time zone
  ) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION
  app_private.network_center_retention_v1(timestamp with time zone)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.network_center_worker_snapshot_v1(text, jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.network_center_get_command_v1(uuid, uuid, uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.network_center_get_command_v1(uuid, uuid, uuid)
  TO authenticated;

COMMENT ON TABLE public.network_managed_resources IS
  'Authoritative immutable RouterOS resource identity; browser roles have no direct access.';
COMMENT ON COLUMN public.network_interfaces.managed_resource_id IS
  'Tenant-bound immutable resource link used for command authorization; display names never authorize.';
COMMENT ON TABLE public.network_command_observations IS
  'Append-only typed router evidence consumed by the fenced SQL command transition.';

NOTIFY pgrst, 'reload schema';

COMMIT;
