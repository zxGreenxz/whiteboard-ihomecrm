-- Forward candidate: apply only through the reviewed migration lane.
-- Human administration only. Existing mutation RPC remains the sole writer.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

CREATE OR REPLACE FUNCTION public.hermes_org_policy_options_v1(p_org uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private
AS $fn$
DECLARE v_actor uuid:=auth.uid(); v_member jsonb; v_policy app_private.hermes_org_policies;
  v_read jsonb; v_scopes jsonb; v_stored_scopes jsonb;
BEGIN
  IF v_actor IS NULL OR auth.role() IS DISTINCT FROM 'authenticated' OR p_org IS NULL THEN
    RAISE EXCEPTION 'hermes_not_permitted' USING ERRCODE='42501'; END IF;
  PERFORM app_private.lock_org_for_decision_v1(p_org);
  v_member:=app_private.hermes_member_v1(v_actor,p_org);
  IF app_private.is_actor_offboarded_v1() THEN RAISE EXCEPTION 'hermes_not_permitted' USING ERRCODE='42501'; END IF;
  PERFORM app_private.require_perm_v1(p_org,'users.edit','quản lý quyền trợ lý Hermes');
  SELECT * INTO v_policy FROM app_private.hermes_org_policies WHERE organization_id=p_org FOR SHARE;
  SELECT COALESCE(jsonb_agg(capability ORDER BY capability),'[]'::jsonb) INTO v_read
    FROM app_private.hermes_capabilities WHERE mode='read' AND enabled
      AND capability IN ('assistant.context.read','rooms.view');

  -- Scope labels are projected only after validating each referenced object's
  -- organization; an inconsistent relation never leaks a different org's name.
  WITH valid_scopes AS (
    SELECT s.id,s.scope_type,s.building_id,s.area_id,
      CASE s.scope_type WHEN 'ORGANIZATION' THEN 'Toàn tổ chức'
        WHEN 'BUILDING' THEN 'Toà: '||COALESCE(b.name,'(chưa đặt tên)')
        WHEN 'AREA' THEN 'Khu vực: '||COALESCE(a.name,'(chưa đặt tên)') END AS label
    FROM public.authorization_scopes s
    LEFT JOIN public.buildings b ON b.id=s.building_id AND b.organization_id=p_org AND b.deleted_at IS NULL
    LEFT JOIN public.areas a ON a.id=s.area_id AND a.organization_id=p_org AND a.deleted_at IS NULL
    WHERE s.organization_id=p_org AND
      ((s.scope_type='ORGANIZATION' AND s.building_id IS NULL AND s.area_id IS NULL AND s.cashbook_id IS NULL)
       OR (s.scope_type='BUILDING' AND b.id IS NOT NULL AND s.area_id IS NULL AND s.cashbook_id IS NULL)
       OR (s.scope_type='AREA' AND a.id IS NOT NULL AND s.building_id IS NULL AND s.cashbook_id IS NULL))
    ORDER BY s.id LIMIT 257
  ) SELECT COALESCE(jsonb_agg(jsonb_build_object('scopeId',id,'scopeType',scope_type,'label',label,
      'buildingId',building_id,'areaId',area_id,'cashbookId',NULL) ORDER BY id),'[]'::jsonb)
    INTO v_scopes FROM valid_scopes;
  IF jsonb_array_length(v_scopes)>256 THEN RAISE EXCEPTION 'hermes_scope_too_large' USING ERRCODE='22023'; END IF;

  -- Preserve every stored ID without making it available for a new grant.
  -- Unavailable, deleted or foreign references receive no object label.
  SELECT COALESCE(jsonb_agg(jsonb_build_object('scopeId',stored.id,
      'label',COALESCE(choice.item->>'label','Phạm vi chưa có trong danh sách hiện tại'),
      'available',choice.item IS NOT NULL) ORDER BY stored.id),'[]'::jsonb)
    INTO v_stored_scopes FROM unnest(COALESCE(v_policy.scope_ids,'{}'::uuid[])) stored(id)
    LEFT JOIN LATERAL (SELECT item FROM jsonb_array_elements(v_scopes) item
      WHERE item->>'scopeId'=stored.id::text) choice ON true;
  RETURN v_member||jsonb_build_object('userId',v_actor,'organizationId',p_org,
    'policy',jsonb_build_object('organizationId',p_org,'version',COALESCE(v_policy.version,0),
      'enabled',COALESCE(v_policy.enabled,false),'read',COALESCE(v_policy.read_capabilities,'{}'::text[]),
      'action',COALESCE(v_policy.action_capabilities,'{}'::text[]),'scopeIds',COALESCE(v_policy.scope_ids,'{}'::uuid[])),
    'choices',jsonb_build_object('read',v_read,'action','[]'::jsonb,'scopes',v_scopes),
    'storedScopes',v_stored_scopes);
END
$fn$;
ALTER FUNCTION public.hermes_org_policy_options_v1(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.hermes_org_policy_options_v1(uuid) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_org_policy_options_v1(uuid) TO authenticated;
COMMIT;
