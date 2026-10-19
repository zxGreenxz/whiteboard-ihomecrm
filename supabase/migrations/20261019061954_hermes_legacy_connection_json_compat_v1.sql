-- Preserve the v1 wire shape for legacy allowlists during schema-first rollout
-- and connector rollback. Inherited CRM intent still requires the v2 adapter.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

CREATE OR REPLACE FUNCTION app_private.hermes_connection_json_v1(p_row app_private.hermes_connections)
RETURNS jsonb LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog,app_private AS $fn$
 SELECT jsonb_build_object('id',p_row.id,'assistantId',p_row.assistant_id,'organizationId',p_row.organization_id,
  'userId',p_row.user_id,'state',lower(p_row.state),'epoch',p_row.epoch,
  'restrictions',jsonb_build_object('read',p_row.read_capabilities,'action',p_row.action_capabilities),'scopeIds',p_row.scope_ids)
 || CASE WHEN p_row.permission_mode='inherit_crm' THEN
  jsonb_build_object('permissionMode',p_row.permission_mode,
   'exclusions',jsonb_build_object('read',p_row.excluded_read,'action',p_row.excluded_action),'scopeMode',p_row.scope_mode)
 ELSE '{}'::jsonb END
$fn$;

ALTER FUNCTION app_private.hermes_connection_json_v1(app_private.hermes_connections) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_connection_json_v1(app_private.hermes_connections)
 FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
COMMIT;
