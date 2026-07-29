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
BEGIN
  IF NEW.action_type <> 'CYCLE_ACCESS_PORT' THEN
    RETURN NEW;
  END IF;
  IF NEW.interface_id IS NULL OR NOT EXISTS (
    SELECT 1
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
  ) THEN
    RAISE EXCEPTION 'Managed access interface is required'
      USING ERRCODE = '42501';
  END IF;
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

COMMENT ON TABLE public.network_managed_resources IS
  'Authoritative immutable RouterOS resource identity; browser roles have no direct access.';
COMMENT ON COLUMN public.network_interfaces.managed_resource_id IS
  'Tenant-bound immutable resource link used for command authorization; display names never authorize.';

NOTIFY pgrst, 'reload schema';

COMMIT;
