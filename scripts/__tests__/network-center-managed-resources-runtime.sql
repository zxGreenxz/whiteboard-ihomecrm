\set ON_ERROR_STOP on

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE TEMP TABLE _t10_fixture ON COMMIT DROP AS
SELECT
  router.id AS router_id,
  router.organization_id,
  router.building_id,
  (SELECT id FROM auth.users ORDER BY id LIMIT 1) AS actor_id
FROM public.network_devices router
WHERE router.device_kind = 'MIKROTIK'
  AND router.is_active
ORDER BY router.id
LIMIT 1;

DO $preflight$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM _t10_fixture
    WHERE router_id IS NOT NULL AND actor_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Task 10 runtime proof requires a router and auth actor';
  END IF;
  IF to_regclass('public.network_managed_resources') IS NULL
     OR to_regprocedure(
       'public.network_center_worker_inventory_v1(text,jsonb)'
     ) IS NULL THEN
    RAISE EXCEPTION 'Task 10 migration is unavailable';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION pg_temp.t10_assert(
  p_condition boolean,
  p_message text
)
RETURNS void
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF coalesce(p_condition, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'TASK10_RUNTIME_ASSERTION: %', p_message;
  END IF;
END;
$fn$;

CREATE OR REPLACE FUNCTION pg_temp.t10_inventory(
  p_interfaces jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_fixture _t10_fixture%ROWTYPE;
  v_result jsonb;
BEGIN
  SELECT * INTO v_fixture FROM _t10_fixture;
  SELECT public.network_center_worker_inventory_v1(
    'task10-runtime',
    jsonb_build_object(
      'routerDeviceId', v_fixture.router_id,
      'discoveryRunId', gen_random_uuid(),
      'observedAt', clock_timestamp(),
      'batchIndex', 0,
      'batchCount', 1,
      'interfaces', p_interfaces,
      'aruba', '[]'::jsonb,
      'quarantine', '[]'::jsonb
    )
  ) INTO v_result;
  RETURN v_result;
END;
$fn$;

DO $inventory_identity$
DECLARE
  v_fixture _t10_fixture%ROWTYPE;
  v_safe_id uuid;
  v_safe_resource_id uuid;
  v_wan_id uuid;
  v_unmanaged_id uuid;
  v_protected_resource_id uuid;
  v_original_safe_id uuid;
BEGIN
  SELECT * INTO v_fixture FROM _t10_fixture;
  PERFORM pg_temp.t10_inventory(jsonb_build_array(
    jsonb_build_object(
      'interfaceKey', 'ether4',
      'displayName', 'ether4',
      'interfaceKind', 'ETHERNET',
      'interfaceRole', 'ACCESS',
      'isProtected', false,
      'isEnabled', true,
      'sortOrder', 4,
      'metadata', jsonb_build_object(
        'immutableKey', 'ether4', 'currentName', 'ether4'
      )
    ),
    jsonb_build_object(
      'interfaceKey', 'ether1',
      'displayName', 'room-101',
      'interfaceKind', 'ETHERNET',
      'interfaceRole', 'ACCESS',
      'isProtected', false,
      'isEnabled', true,
      'sortOrder', 1,
      'metadata', jsonb_build_object(
        'immutableKey', 'ether1', 'currentName', 'room-101'
      )
    ),
    jsonb_build_object(
      'interfaceKey', 'ether29',
      'displayName', 'ether29',
      'interfaceKind', 'ETHERNET',
      'interfaceRole', 'ACCESS',
      'isProtected', true,
      'isEnabled', true,
      'sortOrder', 29,
      'metadata', jsonb_build_object(
        'immutableKey', 'ether29', 'currentName', 'ether29'
      )
    ),
    jsonb_build_object(
      'interfaceKey', 'bridge-lan',
      'displayName', 'bridge-lan',
      'interfaceKind', 'BRIDGE',
      'interfaceRole', 'LAN',
      'isProtected', false,
      'isEnabled', true,
      'sortOrder', 10,
      'metadata', jsonb_build_object('currentName', 'bridge-lan')
    )
  ));

  SELECT interface.id, interface.managed_resource_id
  INTO v_safe_id, v_safe_resource_id
  FROM public.network_interfaces interface
  WHERE interface.device_id = v_fixture.router_id
    AND interface.interface_key = 'ether4';
  SELECT interface.id INTO v_wan_id
  FROM public.network_interfaces interface
  WHERE interface.device_id = v_fixture.router_id
    AND interface.interface_key = 'ether1';
  SELECT interface.id INTO v_unmanaged_id
  FROM public.network_interfaces interface
  WHERE interface.device_id = v_fixture.router_id
    AND interface.interface_key = 'bridge-lan';
  SELECT interface.managed_resource_id INTO v_protected_resource_id
  FROM public.network_interfaces interface
  WHERE interface.device_id = v_fixture.router_id
    AND interface.interface_key = 'ether29';

  PERFORM pg_temp.t10_assert(
    v_safe_id IS NOT NULL AND v_safe_resource_id IS NOT NULL,
    'safe physical access port must bind to a managed resource'
  );
  PERFORM pg_temp.t10_assert(
    EXISTS (
      SELECT 1
      FROM public.network_interfaces interface
      JOIN public.network_managed_resources resource
        ON resource.id = interface.managed_resource_id
      WHERE interface.id = v_safe_id
        AND interface.display_name = 'ether4'
        AND interface.interface_role = 'ACCESS'
        AND interface.is_protected
        AND resource.stable_key = 'ether4'
        AND resource.enrollment_state = 'DISCOVERED'
        AND resource.enrolled_role = 'ACCESS'
        AND resource.protected
      ),
    'safe access discovery must remain protected until private enrollment'
  );
  PERFORM app_private.network_center_enroll_access_interface_v1(v_safe_resource_id);
  PERFORM pg_temp.t10_assert(
    EXISTS (
      SELECT 1
      FROM public.network_interfaces interface
      JOIN public.network_managed_resources resource
        ON resource.id = interface.managed_resource_id
      WHERE interface.id = v_safe_id
        AND interface.is_protected = false
        AND resource.enrollment_state = 'ENROLLED'
        AND resource.protected = false
    ),
    'private enrollment must be required before safe access is cycleable'
  );
  BEGIN
    PERFORM app_private.network_center_enroll_access_interface_v1(
      v_protected_resource_id
    );
    RAISE EXCEPTION 'protected access interface was privately enrolled';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  PERFORM pg_temp.t10_assert(
    EXISTS (
      SELECT 1
      FROM public.network_interfaces interface
      JOIN public.network_managed_resources resource
        ON resource.id = interface.managed_resource_id
      WHERE resource.id = v_protected_resource_id
        AND interface.is_protected
        AND resource.protected
        AND resource.enrollment_state = 'DISCOVERED'
        AND resource.metadata->>'eligibleAccess' = 'false'
    ),
    'protected access discovery must remain ineligible for private enrollment'
  );
  PERFORM pg_temp.t10_assert(
    EXISTS (
      SELECT 1
      FROM public.network_interfaces interface
      JOIN public.network_managed_resources resource
        ON resource.id = interface.managed_resource_id
      WHERE interface.id = v_wan_id
        AND interface.display_name = 'room-101'
        AND interface.interface_key = 'ether1'
        AND interface.interface_role = 'WAN'
        AND interface.is_protected
        AND resource.stable_key = 'ether1'
        AND resource.protected
    ),
    'renamed ether1 must remain WAN and protected by default-name'
  );
  PERFORM pg_temp.t10_assert(
    EXISTS (
      SELECT 1 FROM public.network_interfaces interface
      WHERE interface.id = v_unmanaged_id
        AND interface.managed_resource_id IS NULL
        AND NOT interface.is_managed
    ),
    'an interface without immutable identity must remain unmanaged'
  );

  v_original_safe_id := v_safe_id;
  PERFORM pg_temp.t10_inventory(jsonb_build_array(
    jsonb_build_object(
      'interfaceKey', 'ether4',
      'displayName', 'room-401',
      'interfaceKind', 'ETHERNET',
      'interfaceRole', 'ACCESS',
      'isProtected', false,
      'isEnabled', true,
      'sortOrder', 99,
      'metadata', jsonb_build_object(
        'immutableKey', 'ether4', 'currentName', 'room-401'
      )
    )
  ));
  PERFORM pg_temp.t10_assert(
    (SELECT count(*) FROM public.network_interfaces interface
      WHERE interface.device_id = v_fixture.router_id
        AND interface.interface_key = 'ether4') = 1
      AND (SELECT id FROM public.network_interfaces interface
        WHERE interface.device_id = v_fixture.router_id
          AND interface.interface_key = 'ether4') = v_original_safe_id
      AND (SELECT display_name FROM public.network_interfaces interface
        WHERE interface.id = v_original_safe_id) = 'room-401',
    'renaming an access port must preserve its interface and resource identity'
  );
END
$inventory_identity$;

DO $authoritative_mapping$
DECLARE
  v_fixture _t10_fixture%ROWTYPE;
  v_mapping jsonb;
  v_safe jsonb;
  v_unmanaged jsonb;
BEGIN
  SELECT * INTO v_fixture FROM _t10_fixture;
  v_mapping := app_private.network_center_managed_interface_mapping_v1(
    v_fixture.router_id
  );
  SELECT item.value INTO v_safe
  FROM jsonb_array_elements(v_mapping) item
  WHERE item.value->>'interfaceKey' = 'ether4';
  SELECT item.value INTO v_unmanaged
  FROM jsonb_array_elements(v_mapping) item
  WHERE item.value->>'interfaceKey' = 'bridge-lan';

  PERFORM pg_temp.t10_assert(
    v_safe->>'managedResourceId' IS NOT NULL
      AND v_safe->>'currentName' = 'room-401'
      AND v_safe->>'immutableKey' = 'ether4'
      AND v_safe->>'enrolledRole' = 'ACCESS'
      AND (v_safe->>'protected')::boolean = false
      AND v_safe->>'enrollmentState' = 'ENROLLED',
    'worker mapping must return authoritative enrolled resource fields'
  );
  PERFORM pg_temp.t10_assert(
    v_unmanaged->'managedResourceId' = 'null'::jsonb
      AND v_unmanaged->'immutableKey' = 'null'::jsonb
      AND (v_unmanaged->>'protected')::boolean
      AND v_unmanaged->>'enrollmentState' = 'DISCOVERED',
    'worker mapping must keep resources without an immutable link fail closed'
  );
END
$authoritative_mapping$;

DO $command_guard$
DECLARE
  v_fixture _t10_fixture%ROWTYPE;
  v_safe_id uuid;
  v_wan_id uuid;
  v_unmanaged_id uuid;
  v_safe_resource_id uuid;
  v_orphan_resource_id uuid := gen_random_uuid();
BEGIN
  SELECT * INTO v_fixture FROM _t10_fixture;
  SELECT id, managed_resource_id INTO v_safe_id, v_safe_resource_id
  FROM public.network_interfaces
  WHERE device_id = v_fixture.router_id AND interface_key = 'ether4';
  SELECT id INTO v_wan_id FROM public.network_interfaces
  WHERE device_id = v_fixture.router_id AND interface_key = 'ether1';
  SELECT id INTO v_unmanaged_id FROM public.network_interfaces
  WHERE device_id = v_fixture.router_id AND interface_key = 'bridge-lan';

  INSERT INTO public.network_commands (
    organization_id, building_id, device_id, interface_id,
    action_type, reason, sanitized_parameters, target_display,
    requested_by, request_hash, semantic_fingerprint, idempotency_key
  ) VALUES (
    v_fixture.organization_id, v_fixture.building_id,
    v_fixture.router_id, v_safe_id,
    'CYCLE_ACCESS_PORT', 'Task 10 safe access proof',
    jsonb_build_object('durationSeconds', 5), '{}'::jsonb,
    v_fixture.actor_id, repeat('a', 64), repeat('b', 64),
    'task10-safe-access-proof'
  );

  PERFORM pg_temp.t10_inventory(jsonb_build_array(
    jsonb_build_object(
      'interfaceKey', 'ether4',
      'displayName', 'recovery-ether4',
      'interfaceKind', 'ETHERNET',
      'interfaceRole', 'ACCESS',
      'isProtected', true,
      'isEnabled', true,
      'sortOrder', 4,
      'metadata', jsonb_build_object(
        'immutableKey', 'ether4', 'currentName', 'recovery-ether4'
      )
    )
  ));
  PERFORM pg_temp.t10_assert(
    EXISTS (
      SELECT 1
      FROM public.network_interfaces interface
      JOIN public.network_managed_resources resource
        ON resource.id = interface.managed_resource_id
      WHERE interface.id = v_safe_id
        AND interface.is_protected
        AND resource.enrollment_state = 'ENROLLED'
        AND resource.protected
    ),
    'an enrolled access resource must be monotonically re-protected after protected inventory'
  );

  BEGIN
    INSERT INTO public.network_commands (
      organization_id, building_id, device_id, interface_id,
      action_type, reason, sanitized_parameters, target_display,
      requested_by, request_hash, semantic_fingerprint, idempotency_key
    ) VALUES (
      v_fixture.organization_id, v_fixture.building_id,
      v_fixture.router_id, v_wan_id,
      'CYCLE_ACCESS_PORT', 'Task 10 renamed WAN rejection',
      jsonb_build_object('durationSeconds', 5), '{}'::jsonb,
      v_fixture.actor_id, repeat('c', 64), repeat('d', 64),
      'task10-renamed-wan-proof'
    );
    RAISE EXCEPTION 'renamed WAN cycle was accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    INSERT INTO public.network_commands (
      organization_id, building_id, device_id, interface_id,
      action_type, reason, sanitized_parameters, target_display,
      requested_by, request_hash, semantic_fingerprint, idempotency_key
    ) VALUES (
      v_fixture.organization_id, v_fixture.building_id,
      v_fixture.router_id, v_unmanaged_id,
      'CYCLE_ACCESS_PORT', 'Task 10 unmanaged rejection',
      jsonb_build_object('durationSeconds', 5), '{}'::jsonb,
      v_fixture.actor_id, repeat('e', 64), repeat('f', 64),
      'task10-unmanaged-proof'
    );
    RAISE EXCEPTION 'unmanaged interface cycle was accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    UPDATE public.network_managed_resources
    SET stable_key = 'ether99'
    WHERE id = v_safe_resource_id;
    RAISE EXCEPTION 'managed stable key mutation was accepted';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;
  END;

  BEGIN
    UPDATE public.network_interfaces
    SET display_metadata = display_metadata - 'immutableKey'
    WHERE id = v_safe_id;
    RAISE EXCEPTION 'managed interface immutable metadata removal was accepted';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;
  END;

  BEGIN
    UPDATE public.network_interfaces
    SET interface_key = 'ether5',
        display_metadata = jsonb_set(
          display_metadata,
          '{immutableKey}',
          to_jsonb('ether5'::text)
        )
    WHERE id = v_safe_id;
    RAISE EXCEPTION 'managed interface immutable identity rebind was accepted';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;
  END;

  INSERT INTO public.network_managed_resources (
    id, organization_id, building_id, device_id, resource_kind,
    stable_key, display_name, enrolled_role, protected,
    ownership_marker, enrollment_state
  ) VALUES (
    v_orphan_resource_id, v_fixture.organization_id,
    v_fixture.building_id, v_fixture.router_id, 'INTERFACE',
    'ether9', 'ether9', 'ACCESS', false,
    'routeros-default-name', 'ENROLLED'
  );
  BEGIN
    UPDATE public.network_interfaces
    SET interface_key = 'ether9', managed_resource_id = v_orphan_resource_id
    WHERE id = v_unmanaged_id;
    RAISE EXCEPTION 'unmanaged interface accepted an injected resource link';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;
  END;

  UPDATE public.network_managed_resources
  SET enrollment_state = 'REVOKED'
  WHERE id = v_safe_resource_id;
  BEGIN
    INSERT INTO public.network_commands (
      organization_id, building_id, device_id, interface_id,
      action_type, reason, sanitized_parameters, target_display,
      requested_by, request_hash, semantic_fingerprint, idempotency_key
    ) VALUES (
      v_fixture.organization_id, v_fixture.building_id,
      v_fixture.router_id, v_safe_id,
      'CYCLE_ACCESS_PORT', 'Task 10 revoked rejection',
      jsonb_build_object('durationSeconds', 5), '{}'::jsonb,
      v_fixture.actor_id, repeat('1', 64), repeat('2', 64),
      'task10-revoked-proof'
    );
    RAISE EXCEPTION 'revoked managed interface cycle was accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$command_guard$;

DO $device_cascade$
DECLARE
  v_fixture _t10_fixture%ROWTYPE;
  v_router_id uuid := gen_random_uuid();
BEGIN
  SELECT * INTO v_fixture FROM _t10_fixture;
  INSERT INTO public.network_devices (
    id, organization_id, building_id, device_kind, external_key,
    display_name, vendor, lifecycle_status, write_capability,
    is_active, inventory_metadata
  ) VALUES (
    v_router_id, v_fixture.organization_id, v_fixture.building_id,
    'MIKROTIK', 'slot:task10-cascade', 'Task 10 cascade router',
    'MikroTik', 'DISABLED', true, false, '{}'::jsonb
  );
  INSERT INTO public.network_interfaces (
    organization_id, building_id, device_id, interface_key,
    display_name, interface_kind, interface_role, is_protected,
    is_managed, display_metadata
  ) VALUES (
    v_fixture.organization_id, v_fixture.building_id, v_router_id,
    'ether4', 'ether4', 'ETHERNET', 'ACCESS', false, true,
    jsonb_build_object('immutableKey', 'ether4')
  );
  PERFORM pg_temp.t10_assert(
    EXISTS (
      SELECT 1 FROM public.network_managed_resources
      WHERE device_id = v_router_id
    ),
    'fixture router must own a managed resource before cascade proof'
  );
  DELETE FROM public.network_devices WHERE id = v_router_id;
  PERFORM pg_temp.t10_assert(
    NOT EXISTS (
      SELECT 1 FROM public.network_managed_resources
      WHERE device_id = v_router_id
    ),
    'device cascade must remove its managed resources without orphaning'
  );
END
$device_cascade$;

SET LOCAL ROLE authenticated;
DO $browser_acl$
BEGIN
  BEGIN
    PERFORM 1 FROM public.network_managed_resources LIMIT 1;
    RAISE EXCEPTION 'authenticated browser role read managed resources';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$browser_acl$;
RESET ROLE;

SELECT jsonb_build_object(
  'status', 'PASS',
  'proofs', jsonb_build_array(
    'renamed_ether1_protected',
    'stable_interface_rename',
    'unmanaged_fail_closed',
    'discovery_stays_protected',
    'private_enrollment_required',
    'enrolled_resource_monotonic_reprotect',
    'authoritative_interface_mapping',
    'safe_cycle_allowed',
    'unsafe_cycle_rejected',
    'immutable_resource_guard',
    'immutable_interface_rebind_rejected',
    'unmanaged_link_injection_rejected',
    'revoked_resource_rejected',
    'device_cascade_preserved',
    'browser_acl_denied'
  )
) AS task10_managed_resource_runtime_proof;

ROLLBACK;
