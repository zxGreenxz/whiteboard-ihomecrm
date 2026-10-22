-- Rollout order: seven Sale schema migrations, then the broker and web release
-- accepting these six keys, then this activation. Never activate on the old broker.
-- This enables the delivered Sale surface, not CRM grants. Existing live CRM,
-- company policy, connection exclusions and scope remain intersected by the RPCs.
-- Registry projection refreshes inherit_crm limits without changing identity,
-- scope intent, exclusions, credentials or epoch; legacy/revoked intent stays intact.
-- Do not enable income_expenses.* or other Claude action-framework keys here.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $activate_sale$
DECLARE
  required_keys constant text[]:=ARRAY[
    'rooms.edit','sale_phong.manage_images','sale_phong.lock_room',
    'deposits.create','deposits.edit','sale_phong.edit'
  ];
  signature text;
BEGIN
  IF to_regclass('app_private.hermes_capabilities') IS NULL
    OR to_regclass('app_private.hermes_connections') IS NULL
    OR to_regclass('app_private.hermes_sale_action_receipts') IS NULL
    OR to_regclass('app_private.hermes_sale_policy_receipts') IS NULL
    OR to_regclass('app_private.room_sale_policies_v1') IS NULL THEN
    RAISE EXCEPTION 'hermes_sale_activation_dependencies_missing';
  END IF;

  FOREACH signature IN ARRAY ARRAY[
    'public.hermes_sale_actions_v1(jsonb,text,jsonb)',
    'public.hermes_sale_capabilities_v1(uuid)',
    'public.hermes_sale_policy_actions_v1(jsonb,text,jsonb)',
    'public.hermes_sale_policy_capabilities_v1(uuid)',
    'public.hermes_org_policy_options_v9(uuid)',
    'public.hermes_connection_options_v9(uuid)',
    'public.hermes_connection_context_v9(uuid)',
    'public.update_room_sale_info_v1(uuid,uuid,text,uuid,jsonb)',
    'public.get_sale_room_inventory_v1(uuid,uuid,uuid)',
    'public.save_room_sale_policy_v1(uuid,uuid,text,uuid,jsonb)',
    'public.cancel_room_sale_policy_v1(uuid,uuid,bigint,uuid,text)',
    'public.hermes_available_rooms_page_v1(jsonb,uuid,uuid[],text,text[],integer,integer)',
    'app_private.hermes_sale_keys_v1(text,jsonb)',
    'app_private.hermes_refresh_registry_projection_v2()',
    'app_private.hermes_project_connection_limits_v2()'
  ] LOOP
    IF to_regprocedure(signature) IS NULL THEN
      RAISE EXCEPTION 'hermes_sale_activation_function_missing: %',signature;
    END IF;
  END LOOP;

  -- v1 originally existed before direct sale_phong.edit. Require its forward
  -- implementation too, so the five roles can use their scoped metadata grant.
  IF NOT ('sale_phong.edit'=ANY(app_private.hermes_sale_keys_v1('patch','{}'::jsonb)))
    OR NOT ('sale_phong.edit'=ANY(app_private.hermes_sale_keys_v1('observe','{}'::jsonb))) THEN
    RAISE EXCEPTION 'hermes_sale_activation_direct_edit_missing';
  END IF;

  IF NOT EXISTS(SELECT 1 FROM pg_trigger
    WHERE tgrelid='app_private.hermes_capabilities'::regclass
      AND tgname='hermes_registry_projection_v2' AND NOT tgisinternal AND tgenabled='O'
      AND tgfoid='app_private.hermes_refresh_registry_projection_v2()'::regprocedure)
    OR NOT EXISTS(SELECT 1 FROM pg_trigger
    WHERE tgrelid='app_private.hermes_connections'::regclass
      AND tgname='hermes_connection_limits_projection_v2' AND NOT tgisinternal AND tgenabled='O'
      AND tgfoid='app_private.hermes_project_connection_limits_v2()'::regprocedure) THEN
    RAISE EXCEPTION 'hermes_sale_activation_projection_missing';
  END IF;

  PERFORM 1 FROM app_private.hermes_capabilities
    WHERE capability=ANY(required_keys) ORDER BY capability FOR UPDATE;
  IF (SELECT count(*) FROM app_private.hermes_capabilities
      WHERE capability=ANY(required_keys) AND mode='action')<>6 THEN
    RAISE EXCEPTION 'hermes_sale_activation_registry_invalid';
  END IF;

  UPDATE app_private.hermes_capabilities SET enabled=true
    WHERE capability=ANY(required_keys) AND mode='action' AND NOT enabled;

  IF (SELECT count(*) FROM app_private.hermes_capabilities
      WHERE capability=ANY(required_keys) AND mode='action' AND enabled)<>6 THEN
    RAISE EXCEPTION 'hermes_sale_activation_incomplete';
  END IF;
END
$activate_sale$;
COMMIT;
NOTIFY pgrst,'reload schema';
