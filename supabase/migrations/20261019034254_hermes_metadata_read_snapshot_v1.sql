-- TG-L: only the eleven Hermes capability metadata endpoints use this read lane.
-- STABLE throughout the helper closure gives every decision the statement snapshot.
-- Writer/queue/session/refresh helpers and connection allowlists remain unchanged.
-- The three chat_zalo keys are organization-only CRM permissions; org_wide is
-- deliberately used rather than ANY building/cashbook scope.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $preflight$
DECLARE r record; p record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('app_private.hermes_metadata_org_allowed_v1(uuid,text)','','6000fa3dbe4bad0712624010dee22448'),
    ('app_private.hermes_metadata_member_v1(uuid,uuid)','','b6e14e17b2bb07366cccd630942679e6'),
    ('app_private.hermes_metadata_domain_grant_v1(uuid,text,boolean,jsonb)','','e9f287dc65d6e2f49c747d1cf6cd4d7c'),
    ('app_private.hermes_metadata_w2_grant_v1(uuid,text,boolean,jsonb,jsonb)','','9d2441a5dad6e59497fea613c923aec0'),
    ('public.hermes_group_action_context_v1(uuid)','708b0cd33a925bd153083202f6ad1718','05b8476345515e43d02a05934ae0efae'),
    ('public.hermes_work_memory_capabilities_v1(uuid)','50fdbc4c1553ae70f81e66faba960fee','ac3f5334e0e39fbc839dc7870804689b'),
    ('public.hermes_room_schedule_capabilities_v1(uuid)','f385aa5789aecadee4ff16344c3a6671','ec02c40dce9f83dbf728c59a361a726e'),
    ('public.hermes_room_pass_capabilities_v1(uuid)','ecad3ab9a316c104f203ae5364caf793','4653cf6d18f8bdcdee758fbab7405769'),
    ('public.hermes_task_create_capabilities_v1(uuid)','539c7484c89bd7f92679b36fa254dceb','678cfe54d65dd0dca0d7dd983f0a09b4'),
    ('public.hermes_task_follow_capabilities_v1(uuid)','fe5b631081607424411ba0693d3e8a6c','d8f47da8bc58b0f4c60c5f6dc15e4b70'),
    ('public.hermes_customer_create_capabilities_v1(uuid)','09b0d4be1b8018eaae9955c85e017921','a97b992bfbb2042efc46b2920c49b4af'),
    ('public.hermes_expense_capabilities_v1(uuid)','7095b8393406476f3163a2f046f14d82','bdcbd320c7a1eae9198e05961bddf07c'),
    ('public.hermes_domain_capabilities_v1(uuid)','8a560e1985c294c03bd3349a7383c366','73ae6a7e6939694d30153de6c4647a19'),
    ('public.hermes_domain_capabilities_v2(uuid)','76a325c3c967a8dc39ca095ea1d6139e','51280959d5c993181b0b73a1bc4e0c0d'),
    ('public.hermes_domain_capabilities_v3(uuid)','8ac4c74ab42e7cf434f7a17c3289d629','8dbc72520a081fef9d69dbb1e8090bc8')
  ) AS expected(signature,old_digest,new_digest) LOOP
    SELECT pr.*,pg_get_userbyid(pr.proowner) AS owner INTO p FROM pg_proc pr
      WHERE pr.oid=to_regprocedure(r.signature);
    IF FOUND THEN
      IF p.owner<>'postgres' OR NOT p.prosecdef OR p.provolatile NOT IN ('v','s')
        OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, app_private']::text[]
        OR EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
          WHERE a.privilege_type<>'EXECUTE' OR a.is_grantable OR a.grantee=0
            OR pg_get_userbyid(a.grantee) NOT IN ('postgres','authenticated'))
        OR md5(replace(p.prosrc,chr(13),'')) NOT IN (r.old_digest,r.new_digest)
        THEN RAISE EXCEPTION 'hermes_metadata_catalog_drift: %',r.signature; END IF;
    ELSIF r.old_digest<>'' THEN RAISE EXCEPTION 'hermes_metadata_function_missing: %',r.signature;
    END IF;
  END LOOP;
END $preflight$;

-- Bind the reviewed read dependency closure. A changed evaluator needs another
-- review; an object merely existing is not proof that it is the same function.
DO $read_dependencies$
DECLARE r record; p record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('public.get_authorization_context_v1(uuid)','6c96011c8ffe52287554b522a3a23970'),
    ('app_private.is_actor_offboarded_v1()','50c6ed920803c2bf3b7fca8ba7e8b2e6'),
    ('app_private.authorized_scope_v3(text,uuid)','af15b5b6607ed762a093f4706c9c2dd5'),
    ('app_private.hermes_effective_org_policy_v1(uuid,text[],text[],uuid[])','2d656c9fcac3ec1f61273a1410bb8a5b'),
    ('app_private.hermes_w2_read_keys_v1()','2f4c2e62001c8ba9b65a233879b5960a'),
    ('app_private.hermes_w2_self_keys_v1()','f211ba9fa3e2c5c233fc9708a3061713'),
    ('public.can_access_org_entity(text,text)','cbbdf5e1021e74393b7f22c219af5974'),
    ('public.is_super_admin()','9d747f251c31d9b13258f40552b1e0f4'),
    ('app_private.has_any_scope_v3(text)','eb895d15c045138b0723ef3450858f9d'),
    ('app_private.scope_covers_v3(text,uuid,uuid,uuid,uuid,uuid,uuid)','ea5b82517395086b111a0915746c7d62')
  ) AS expected(signature,digest) LOOP
    SELECT pr.* INTO p FROM pg_proc pr WHERE pr.oid=to_regprocedure(r.signature);
    IF NOT FOUND OR p.provolatile NOT IN ('s','i') OR NOT p.prosecdef
      OR pg_get_userbyid(p.proowner)<>'postgres' OR md5(replace(p.prosrc,chr(13),''))<>r.digest
      THEN RAISE EXCEPTION 'hermes_metadata_read_dependency_drift: %',r.signature; END IF;
  END LOOP;
END $read_dependencies$;


-- The canonical read evaluator rejects revoked memberships and scoped DENY.
-- Preserve the writer's malformed zero-edge override rejection as well: the
-- generic RLS read helper deliberately ignores such rows instead of raising.
-- Only these three organization-scoped keys are accepted by this private port.
CREATE OR REPLACE FUNCTION app_private.hermes_metadata_org_allowed_v1(p_org uuid,p_key text)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
BEGIN
  IF p_key IS NULL OR p_key NOT IN ('chat_zalo.view','chat_zalo.send','chat_zalo.manage_automation')
    THEN RAISE EXCEPTION 'hermes_metadata_permission_invalid' USING ERRCODE='22023'; END IF;
  IF EXISTS(SELECT 1 FROM public.permission_definitions pd
      WHERE pd.key=p_key AND pd.permission_domain='TENANT' AND pd.is_active
        AND (pd.scope_kinds IS DISTINCT FROM ARRAY['ORGANIZATION']::text[]
          OR pd.required_dimensions IS DISTINCT FROM '{}'::text[] OR pd.requires_cashbook_possession))
    THEN RAISE EXCEPTION 'hermes_metadata_permission_contract_changed' USING ERRCODE='42501'; END IF;
  IF EXISTS(SELECT 1 FROM public.permission_definitions pd
      JOIN public.organization_memberships m ON m.user_id=auth.uid() AND m.organization_id=p_org
      JOIN public.organizations org ON org.id=m.organization_id AND org.status='ACTIVE'
      JOIN public.member_permission_overrides ov ON ov.organization_id=m.organization_id AND ov.membership_id=m.id
        AND ov.permission_key=pd.key AND ov.revoked_at IS NULL AND (ov.expires_at IS NULL OR ov.expires_at>now())
      WHERE pd.key=p_key AND pd.permission_domain='TENANT' AND pd.is_active
        AND m.status='ACTIVE' AND m.revoked_at IS NULL
        AND COALESCE(m.valid_from,'-infinity'::timestamptz)<=now() AND (m.valid_to IS NULL OR m.valid_to>now())
        AND NOT EXISTS(SELECT 1 FROM app_private.tenant_emergency_denies d WHERE d.organization_id=p_org
          AND (d.permission_key IS NULL OR d.permission_key=p_key) AND d.active_from<=now()
          AND (d.expires_at IS NULL OR d.expires_at>now()))
        AND NOT EXISTS(SELECT 1 FROM public.member_override_scopes edge
          WHERE edge.organization_id=p_org AND edge.override_id=ov.id))
    THEN RAISE EXCEPTION 'authorize_tenant_action_v3: open zero-edge override for % in org %',p_key,p_org USING ERRCODE='23514'; END IF;
  RETURN COALESCE((SELECT scope.org_wide FROM app_private.authorized_scope_v3(p_key,p_org) scope),false);
END $fn$;

CREATE OR REPLACE FUNCTION app_private.hermes_metadata_member_v1(p_user uuid,p_org uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private
AS $fn$
DECLARE v_count integer; v_org_count integer; v_super boolean; v_member uuid; v_version bigint;
  v_now timestamptz:=now();
BEGIN
  IF p_user IS NULL OR p_org IS NULL THEN RAISE EXCEPTION 'hermes_membership_required' USING ERRCODE='42501'; END IF;
  SELECT count(*),min(m.id::text)::uuid INTO v_count,v_member
  FROM public.organization_memberships m JOIN public.organizations o ON o.id=m.organization_id
  WHERE m.user_id=p_user AND m.organization_id=p_org AND o.status='ACTIVE'
    AND m.status='ACTIVE' AND m.revoked_at IS NULL
    AND COALESCE(m.valid_from,'-infinity'::timestamptz)<=v_now
    AND (m.valid_to IS NULL OR m.valid_to>v_now);
  IF v_count<>1 THEN RAISE EXCEPTION 'hermes_membership_required' USING ERRCODE='42501'; END IF;
  SELECT EXISTS(SELECT 1 FROM public.super_admins WHERE user_id=p_user) INTO v_super;
  IF NOT v_super THEN
    SELECT count(DISTINCT m.organization_id) INTO v_org_count
    FROM public.organization_memberships m JOIN public.organizations o ON o.id=m.organization_id
    WHERE m.user_id=p_user AND o.status='ACTIVE' AND m.status='ACTIVE' AND m.revoked_at IS NULL
      AND COALESCE(m.valid_from,'-infinity'::timestamptz)<=v_now
      AND (m.valid_to IS NULL OR m.valid_to>v_now);
    IF v_org_count<>1 THEN RAISE EXCEPTION 'hermes_ordinary_org_ambiguous' USING ERRCODE='42501'; END IF;
  END IF;
  SELECT authorization_version INTO v_version FROM public.organizations WHERE id=p_org;
  RETURN jsonb_build_object('membershipId',v_member,'authorizationVersion',v_version,'isSuperadmin',v_super);
END
$fn$;

CREATE OR REPLACE FUNCTION app_private.hermes_metadata_domain_grant_v1(p_org uuid,p_key text,p_enabled boolean,p_context jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_allowed boolean; v_org_wide boolean:=false; v_buildings uuid[]:='{}'::uuid[];
BEGIN
  IF p_org IS NULL OR p_key IS NULL OR jsonb_typeof(p_context) IS DISTINCT FROM 'object'
    THEN RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023'; END IF;
  v_allowed:=COALESCE(p_enabled AND p_context->'permissions'->p_key='true'::jsonb,false);
  IF v_allowed THEN
    SELECT COALESCE(bool_or(scope.org_wide),false) INTO v_org_wide FROM app_private.authorized_scope_v3(p_key,p_org) scope;
    SELECT COALESCE(array_agg(DISTINCT b.id ORDER BY b.id),'{}'::uuid[]) INTO v_buildings
      FROM app_private.authorized_scope_v3(p_key,p_org) scope
      JOIN public.buildings b ON b.organization_id=p_org AND b.deleted_at IS NULL
        AND (scope.org_wide OR b.id=ANY(scope.building_ids));
    IF cardinality(v_buildings)>256 THEN RAISE EXCEPTION 'hermes_domain_scope_too_large' USING ERRCODE='22023'; END IF;
  END IF;
  RETURN jsonb_build_object('allowed',v_allowed,'companyEnabled',COALESCE(p_enabled,false),
    'buildingIds',to_jsonb(v_buildings),'orgWide',v_allowed AND v_org_wide);
END $fn$;

CREATE OR REPLACE FUNCTION app_private.hermes_metadata_w2_grant_v1(p_org uuid,p_key text,p_enabled boolean,p_context jsonb,p_member jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_state jsonb; v_allowed boolean;
BEGIN
  IF p_org IS NULL OR p_key IS NULL OR jsonb_typeof(p_context) IS DISTINCT FROM 'object' OR jsonb_typeof(p_member) IS DISTINCT FROM 'object'
    THEN RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023'; END IF;
  IF p_key='assistant.salary.self' THEN
    -- /finance/my-salary không có khoá web: thành viên nào cũng mở được, trang tự kiểm cấu hình
    -- lương của CHÍNH người xem (Gói C kiểm khi đọc).
    v_allowed:=COALESCE(p_enabled,false);
  ELSIF p_key='assistant.bank_events.read' THEN
    -- /bien-dong-so-du: RequireSuperAdmin; bank_event_admin_v1 chỉ is_super_admin().
    v_allowed:=COALESCE(p_enabled,false) AND p_member->'isSuperadmin'='true'::jsonb;
  ELSE
    v_state:=app_private.hermes_metadata_domain_grant_v1(p_org,p_key,p_enabled,p_context);
    IF p_key=ANY(app_private.hermes_w2_self_keys_v1()) THEN RETURN jsonb_set(v_state,'{buildingIds}','[]'::jsonb,false); END IF;
    RETURN v_state;
  END IF;
  RETURN jsonb_build_object('allowed',v_allowed,'companyEnabled',COALESCE(p_enabled,false),'buildingIds','[]'::jsonb,'orgWide',false);
END $fn$;

CREATE OR REPLACE FUNCTION public.hermes_group_action_context_v1(p_organization_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_auth jsonb; v_policy app_private.hermes_org_policies; v_allowed boolean:=false; v_read boolean:=false;
BEGIN
  IF auth.uid() IS NULL OR auth.role() IS DISTINCT FROM 'authenticated' OR p_organization_id IS NULL
    THEN RAISE EXCEPTION 'hermes_group_denied' USING ERRCODE='42501'; END IF;

  v_auth:=public.get_authorization_context_v1(p_organization_id);
  IF v_auth->>'organizationId' IS DISTINCT FROM p_organization_id::text
    OR v_auth->'isOffboarded' IS DISTINCT FROM 'false'::jsonb OR v_auth->>'membershipId' IS NULL
    OR v_auth->>'authorizationVersion' IS NULL
    THEN RAISE EXCEPTION 'hermes_group_denied' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_policy FROM app_private.hermes_effective_org_policy_v1(p_organization_id,ARRAY['chat_zalo.view']::text[],ARRAY['chat_zalo.send']::text[],'{}'::uuid[]);
  IF v_policy.organization_id IS NULL THEN RAISE EXCEPTION 'hermes_group_policy_absent' USING ERRCODE='42501'; END IF;
  IF v_policy.enabled AND 'chat_zalo.view'=ANY(v_policy.read_capabilities)
    AND EXISTS(SELECT 1 FROM app_private.hermes_capabilities WHERE capability='chat_zalo.view' AND mode='read' AND enabled) THEN
    v_read:=app_private.hermes_metadata_org_allowed_v1(p_organization_id,'chat_zalo.view');
  END IF;
  IF v_policy.enabled AND 'chat_zalo.send'=ANY(v_policy.action_capabilities)
    AND EXISTS(SELECT 1 FROM app_private.hermes_capabilities WHERE capability='chat_zalo.send' AND mode='action' AND enabled)
    THEN
    v_allowed:=app_private.hermes_metadata_org_allowed_v1(p_organization_id,'chat_zalo.send');
  END IF;
  RETURN jsonb_build_object('organizationId',p_organization_id,'userId',auth.uid(),
    'membershipId',v_auth->>'membershipId','authorizationVersion',(v_auth->>'authorizationVersion')::bigint,
    'policyVersion',v_policy.version,'allowed',COALESCE(v_allowed,false),
    'companyEnabled',v_policy.enabled AND 'chat_zalo.send'=ANY(v_policy.action_capabilities),
    'readAllowed',COALESCE(v_read,false),'readCompanyEnabled',v_policy.enabled AND 'chat_zalo.view'=ANY(v_policy.read_capabilities));
END $fn$;

CREATE OR REPLACE FUNCTION public.hermes_work_memory_capabilities_v1(p_organization_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE member jsonb; policy app_private.hermes_org_policies; r boolean; w boolean;
BEGIN
  IF auth.role() IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL OR p_organization_id IS NULL
    THEN RAISE EXCEPTION 'hermes_memory_denied' USING ERRCODE='42501'; END IF;

  member:=app_private.hermes_metadata_member_v1(auth.uid(),p_organization_id);
  IF app_private.is_actor_offboarded_v1() THEN RAISE EXCEPTION 'hermes_memory_denied' USING ERRCODE='42501'; END IF;
  policy:=app_private.hermes_effective_org_policy_v1(p_organization_id,
    ARRAY['assistant.memory.read'],ARRAY['assistant.memory.write'],'{}'::uuid[]);
  r:=policy.enabled AND 'assistant.memory.read'=ANY(policy.read_capabilities)
    AND EXISTS(SELECT 1 FROM app_private.hermes_capabilities WHERE capability='assistant.memory.read' AND mode='read' AND enabled);
  w:=policy.enabled AND 'assistant.memory.write'=ANY(policy.action_capabilities)
    AND EXISTS(SELECT 1 FROM app_private.hermes_capabilities WHERE capability='assistant.memory.write' AND mode='action' AND enabled);
  RETURN member||jsonb_build_object('organizationId',p_organization_id,'userId',auth.uid(),
    'policyVersion',policy.version,'readAllowed',COALESCE(r,false),'writeAllowed',COALESCE(w,false));
END $fn$;

CREATE OR REPLACE FUNCTION public.hermes_room_schedule_capabilities_v1(p_organization_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE member jsonb; policy app_private.hermes_org_policies; decision record; v_enabled boolean;
BEGIN
  IF auth.role() IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL OR p_organization_id IS NULL
    THEN RAISE EXCEPTION 'hermes_schedule_denied' USING ERRCODE='42501'; END IF;

  member:=app_private.hermes_metadata_member_v1(auth.uid(),p_organization_id);
  IF app_private.is_actor_offboarded_v1() THEN RAISE EXCEPTION 'hermes_schedule_denied' USING ERRCODE='42501'; END IF;
  policy:=app_private.hermes_effective_org_policy_v1(p_organization_id,'{}'::text[],ARRAY['chat_zalo.manage_automation'],'{}'::uuid[]);
  SELECT app_private.hermes_metadata_org_allowed_v1(p_organization_id,'chat_zalo.manage_automation') AS allowed,
    o.authorization_version INTO decision FROM public.organizations o WHERE o.id=p_organization_id;
  IF decision.authorization_version::text IS DISTINCT FROM member->>'authorizationVersion'
    THEN RAISE EXCEPTION 'hermes_context_changed' USING ERRCODE='PT409'; END IF;
  v_enabled:=policy.enabled AND 'chat_zalo.manage_automation'=ANY(policy.action_capabilities)
    AND EXISTS(SELECT 1 FROM app_private.hermes_capabilities WHERE capability='chat_zalo.manage_automation' AND mode='action' AND enabled);
  RETURN member||jsonb_build_object('organizationId',p_organization_id,'userId',auth.uid(),'policyVersion',policy.version,
    'allowed',COALESCE(v_enabled AND decision.allowed,false),'companyEnabled',COALESCE(v_enabled,false));
END $fn$;

CREATE OR REPLACE FUNCTION public.hermes_room_pass_capabilities_v1(p_organization_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE member jsonb; context jsonb; policy app_private.hermes_org_policies; enabled boolean; allowed boolean; buildings uuid[];
BEGIN
 IF auth.role() IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'hermes_action_denied' USING ERRCODE='42501'; END IF;

 member:=app_private.hermes_metadata_member_v1(auth.uid(),p_organization_id); context:=public.get_authorization_context_v1(p_organization_id);
 IF context->>'membershipId' IS DISTINCT FROM member->>'membershipId' OR context->>'authorizationVersion' IS DISTINCT FROM member->>'authorizationVersion'
   OR context->>'organizationId' IS DISTINCT FROM p_organization_id::text OR context->'isOffboarded' IS DISTINCT FROM 'false'::jsonb
   THEN RAISE EXCEPTION 'hermes_action_context_changed' USING ERRCODE='PT409'; END IF;
 policy:=app_private.hermes_effective_org_policy_v1(p_organization_id,'{}'::text[],ARRAY['sale_phong.manage_pass_listings'],NULL);
 enabled:=policy.enabled AND 'sale_phong.manage_pass_listings'=ANY(policy.action_capabilities)
   AND EXISTS(SELECT 1 FROM app_private.hermes_capabilities cap WHERE cap.capability='sale_phong.manage_pass_listings' AND cap.mode='action' AND cap.enabled);
 allowed:=COALESCE(enabled AND context#>'{permissions,sale_phong.manage_pass_listings}'='true'::jsonb,false);
 SELECT COALESCE(array_agg(b.id ORDER BY b.id),'{}'::uuid[]) INTO buildings FROM public.buildings b
   CROSS JOIN app_private.authorized_scope_v3('sale_phong.manage_pass_listings',p_organization_id) scope
   WHERE allowed AND b.organization_id=p_organization_id AND b.deleted_at IS NULL AND (scope.org_wide OR b.id=ANY(scope.building_ids));
 IF cardinality(buildings)>256 THEN RAISE EXCEPTION 'hermes_action_invalid' USING ERRCODE='22023'; END IF;
 RETURN member||jsonb_build_object('organizationId',p_organization_id,'userId',auth.uid(),'policyVersion',policy.version,
   'allowed',allowed,'companyEnabled',COALESCE(enabled,false),'buildingIds',to_jsonb(buildings));
END $fn$;

CREATE OR REPLACE FUNCTION public.hermes_task_create_capabilities_v1(p_organization_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE member jsonb; context jsonb; policy app_private.hermes_org_policies; enabled boolean; allowed boolean; buildings uuid[];
BEGIN
 IF auth.role() IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'hermes_action_denied' USING ERRCODE='42501'; END IF;

 member:=app_private.hermes_metadata_member_v1(auth.uid(),p_organization_id); context:=public.get_authorization_context_v1(p_organization_id);
 IF context->>'membershipId' IS DISTINCT FROM member->>'membershipId' OR context->>'authorizationVersion' IS DISTINCT FROM member->>'authorizationVersion'
   OR context->>'organizationId' IS DISTINCT FROM p_organization_id::text OR context->'isOffboarded' IS DISTINCT FROM 'false'::jsonb
   THEN RAISE EXCEPTION 'hermes_action_context_changed' USING ERRCODE='PT409'; END IF;
 policy:=app_private.hermes_effective_org_policy_v1(p_organization_id,'{}'::text[],ARRAY['tasks.create'],NULL);
 enabled:=policy.enabled AND 'tasks.create'=ANY(policy.action_capabilities)
   AND EXISTS(SELECT 1 FROM app_private.hermes_capabilities cap WHERE cap.capability='tasks.create' AND cap.mode='action' AND cap.enabled);
 allowed:=COALESCE(enabled AND context#>'{permissions,tasks.create}'='true'::jsonb,false);
 SELECT COALESCE(array_agg(b.id ORDER BY b.id),'{}'::uuid[]) INTO buildings FROM public.buildings b
   CROSS JOIN app_private.authorized_scope_v3('tasks.create',p_organization_id) scope
   WHERE allowed AND b.organization_id=p_organization_id AND b.deleted_at IS NULL AND (scope.org_wide OR b.id=ANY(scope.building_ids));
 IF cardinality(buildings)>256 THEN RAISE EXCEPTION 'hermes_action_invalid' USING ERRCODE='22023'; END IF;
 RETURN member||jsonb_build_object('organizationId',p_organization_id,'userId',auth.uid(),'policyVersion',policy.version,
   'allowed',allowed,'companyEnabled',COALESCE(enabled,false),'buildingIds',to_jsonb(buildings));
END $fn$;

CREATE OR REPLACE FUNCTION public.hermes_task_follow_capabilities_v1(p_organization_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE member jsonb; context jsonb; policy app_private.hermes_org_policies; result jsonb:='{}'; r record;
  v_enabled boolean; v_allowed boolean; v_buildings uuid[];
BEGIN
  IF auth.role() IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL OR p_organization_id IS NULL
    THEN RAISE EXCEPTION 'hermes_task_denied' USING ERRCODE='42501'; END IF;

  member:=app_private.hermes_metadata_member_v1(auth.uid(),p_organization_id);
  IF app_private.is_actor_offboarded_v1() THEN RAISE EXCEPTION 'hermes_task_denied' USING ERRCODE='42501'; END IF;
  context:=public.get_authorization_context_v1(p_organization_id);
  IF context->>'membershipId' IS DISTINCT FROM member->>'membershipId' OR context->>'authorizationVersion' IS DISTINCT FROM member->>'authorizationVersion'
    OR context->>'organizationId' IS DISTINCT FROM p_organization_id::text OR context->'isOffboarded' IS DISTINCT FROM 'false'::jsonb
    THEN RAISE EXCEPTION 'hermes_task_context_changed' USING ERRCODE='PT409'; END IF;
  policy:=app_private.hermes_effective_org_policy_v1(p_organization_id,ARRAY['assistant.memory.supervise'],ARRAY['tasks.edit','tasks.delete'],NULL);
  FOR r IN SELECT * FROM (VALUES ('tasks.edit','action','tasks.edit'),('tasks.delete','action','tasks.delete'),
      ('assistant.memory.supervise','read','users.view')) AS v(capability,mode,crm) LOOP
    v_enabled:=COALESCE(policy.enabled,false) AND EXISTS(SELECT 1 FROM app_private.hermes_capabilities h
        WHERE h.capability=r.capability AND h.mode=r.mode AND h.enabled)
      AND (CASE r.mode WHEN 'read' THEN r.capability=ANY(policy.read_capabilities) ELSE r.capability=ANY(policy.action_capabilities) END);
    v_allowed:=v_enabled AND COALESCE(context->'permissions'->r.crm='true'::jsonb,false);
    v_buildings:='{}';
    IF v_allowed AND r.mode='action' THEN
      SELECT COALESCE(array_agg(b.id ORDER BY b.id),'{}'::uuid[]) INTO v_buildings FROM public.buildings b
        CROSS JOIN app_private.authorized_scope_v3(r.crm,p_organization_id) scope
        WHERE b.organization_id=p_organization_id AND b.deleted_at IS NULL AND (COALESCE(scope.org_wide,false) OR b.id=ANY(COALESCE(scope.building_ids,'{}'::uuid[])));
      IF cardinality(v_buildings)>256 THEN RAISE EXCEPTION 'hermes_task_scope_too_large' USING ERRCODE='22023'; END IF;
      v_allowed:=cardinality(v_buildings)>0;
    END IF;
    result:=result||jsonb_build_object(r.capability,jsonb_build_object('allowed',v_allowed,'companyEnabled',v_enabled,'buildingIds',to_jsonb(v_buildings)));
  END LOOP;
  RETURN member||jsonb_build_object('organizationId',p_organization_id,'userId',auth.uid(),'policyVersion',policy.version,'permissions',result);
END $fn$;

CREATE OR REPLACE FUNCTION public.hermes_customer_create_capabilities_v1(p_organization_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE member jsonb;context jsonb;policy app_private.hermes_org_policies;enabled boolean;allowed boolean;key text;permissions jsonb:='{}';
BEGIN
 IF auth.role() IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'hermes_customer_denied' USING ERRCODE='42501';END IF;

 member:=app_private.hermes_metadata_member_v1(auth.uid(),p_organization_id);context:=public.get_authorization_context_v1(p_organization_id);
 IF context->>'membershipId' IS DISTINCT FROM member->>'membershipId' OR context->>'authorizationVersion' IS DISTINCT FROM member->>'authorizationVersion'
  OR context->>'organizationId' IS DISTINCT FROM p_organization_id::text OR context->'isOffboarded' IS DISTINCT FROM 'false'::jsonb
  THEN RAISE EXCEPTION 'hermes_customer_context_changed' USING ERRCODE='PT409';END IF;
 policy:=app_private.hermes_effective_org_policy_v1(p_organization_id,'{}'::text[],ARRAY['customers.create','leads.create'],NULL);
 FOREACH key IN ARRAY ARRAY['customers.create','leads.create'] LOOP
  enabled:=policy.enabled AND key=ANY(policy.action_capabilities) AND EXISTS(SELECT 1 FROM app_private.hermes_capabilities cap WHERE cap.capability=key AND cap.mode='action' AND cap.enabled);
  allowed:=COALESCE(enabled AND context->'permissions'->key='true'::jsonb AND public.can_access_org_entity(split_part(key,'.',1),'create'),false);
  permissions:=permissions||jsonb_build_object(key,jsonb_build_object('allowed',allowed,'companyEnabled',COALESCE(enabled,false)));
 END LOOP;
 RETURN member||jsonb_build_object('organizationId',p_organization_id,'userId',auth.uid(),'policyVersion',policy.version,'permissions',permissions);
END $fn$;

CREATE OR REPLACE FUNCTION public.hermes_expense_capabilities_v1(p_organization_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE member jsonb; context jsonb; policy app_private.hermes_org_policies; enabled boolean; allowed boolean; key text;
  buildings uuid[]; permissions jsonb:='{}';
BEGIN
  IF auth.role() IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL OR p_organization_id IS NULL
    THEN RAISE EXCEPTION 'hermes_expense_denied' USING ERRCODE='42501'; END IF;

  member:=app_private.hermes_metadata_member_v1(auth.uid(),p_organization_id);
  IF app_private.is_actor_offboarded_v1() THEN RAISE EXCEPTION 'hermes_expense_denied' USING ERRCODE='42501'; END IF;
  context:=public.get_authorization_context_v1(p_organization_id);
  IF context->>'membershipId' IS DISTINCT FROM member->>'membershipId' OR context->>'authorizationVersion' IS DISTINCT FROM member->>'authorizationVersion'
    OR context->>'organizationId' IS DISTINCT FROM p_organization_id::text OR context->'isOffboarded' IS DISTINCT FROM 'false'::jsonb
    THEN RAISE EXCEPTION 'hermes_expense_context_changed' USING ERRCODE='PT409'; END IF;
  policy:=app_private.hermes_effective_org_policy_v1(p_organization_id,'{}'::text[],ARRAY['income_expenses.create','income_expenses.approve'],NULL);
  FOREACH key IN ARRAY ARRAY['income_expenses.create','income_expenses.approve'] LOOP
    enabled:=policy.enabled AND key=ANY(policy.action_capabilities) AND EXISTS(
      SELECT 1 FROM app_private.hermes_capabilities cap WHERE cap.capability=key AND cap.mode='action' AND cap.enabled);
    allowed:=COALESCE(enabled AND context->'permissions'->key='true'::jsonb,false);
    SELECT COALESCE(array_agg(b.id ORDER BY b.id),'{}'::uuid[]) INTO buildings FROM public.buildings b
      CROSS JOIN app_private.authorized_scope_v3(key,p_organization_id) scope
      WHERE allowed AND b.organization_id=p_organization_id AND b.deleted_at IS NULL
        AND (COALESCE(scope.org_wide,false) OR b.id=ANY(COALESCE(scope.building_ids,'{}'::uuid[])));
    IF cardinality(buildings)>256 THEN RAISE EXCEPTION 'hermes_expense_invalid' USING ERRCODE='22023'; END IF;
    permissions:=permissions||jsonb_build_object(key,jsonb_build_object('allowed',allowed,'companyEnabled',COALESCE(enabled,false),'buildingIds',to_jsonb(buildings)));
  END LOOP;
  RETURN member||jsonb_build_object('organizationId',p_organization_id,'userId',auth.uid(),'policyVersion',policy.version,'permissions',permissions);
END $fn$;

CREATE OR REPLACE FUNCTION public.hermes_domain_capabilities_v1(p_organization_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE member jsonb; policy app_private.hermes_org_policies; context jsonb; key text;
  result jsonb:='{}'; enabled boolean; allowed boolean; buildings uuid[];
  keys text[]:=ARRAY['customers.view','leads.view','contracts.view','invoices.view','assets.view','services.view','tasks.view','reports_real_estate.occupancy'];
BEGIN
  IF auth.role() IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL OR p_organization_id IS NULL
    THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;

  member:=app_private.hermes_metadata_member_v1(auth.uid(),p_organization_id);
  IF app_private.is_actor_offboarded_v1() THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
  context:=public.get_authorization_context_v1(p_organization_id);
  IF context->>'organizationId' IS DISTINCT FROM p_organization_id::text OR context->'isOffboarded' IS DISTINCT FROM 'false'::jsonb
    OR context->>'membershipId' IS DISTINCT FROM member->>'membershipId'
    OR context->>'authorizationVersion' IS DISTINCT FROM member->>'authorizationVersion'
    THEN RAISE EXCEPTION 'hermes_domain_context_changed' USING ERRCODE='PT409'; END IF;
  policy:=app_private.hermes_effective_org_policy_v1(p_organization_id,keys,'{}'::text[],NULL);
  FOREACH key IN ARRAY keys LOOP
    enabled:=policy.enabled AND key=ANY(policy.read_capabilities) AND EXISTS(
      SELECT 1 FROM app_private.hermes_capabilities h WHERE h.capability=key AND h.mode='read' AND h.enabled);
    allowed:=enabled AND context->'permissions'->key='true'::jsonb;
    buildings:='{}';
    IF COALESCE(allowed,false) THEN
      SELECT COALESCE(array_agg(b.id ORDER BY b.id),'{}'::uuid[]) INTO buildings
      FROM app_private.authorized_scope_v3(key,p_organization_id) scope
      JOIN public.buildings b ON b.organization_id=p_organization_id AND b.deleted_at IS NULL
        AND (scope.org_wide OR b.id=ANY(scope.building_ids));
      IF cardinality(buildings)>256 THEN RAISE EXCEPTION 'hermes_domain_scope_too_large' USING ERRCODE='22023'; END IF;
    END IF;
    result:=result||jsonb_build_object(key,jsonb_build_object('allowed',COALESCE(allowed,false),'companyEnabled',COALESCE(enabled,false),'buildingIds',to_jsonb(buildings)));
  END LOOP;
  RETURN member||jsonb_build_object('organizationId',p_organization_id,'userId',auth.uid(),'policyVersion',policy.version,'permissions',result);
END $fn$;

CREATE OR REPLACE FUNCTION public.hermes_domain_capabilities_v2(p_organization_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE member jsonb; policy app_private.hermes_org_policies; context jsonb; key text; state jsonb; result jsonb:='{}'; enabled boolean;
  keys constant text[]:=ARRAY['income_expenses.view','meter_readings.view','deposits.view','reports_finance.analysis'];
BEGIN
  IF auth.role() IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL OR p_organization_id IS NULL
    THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;

  member:=app_private.hermes_metadata_member_v1(auth.uid(),p_organization_id);
  IF app_private.is_actor_offboarded_v1() THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
  context:=public.get_authorization_context_v1(p_organization_id);
  IF context->>'organizationId' IS DISTINCT FROM p_organization_id::text OR context->'isOffboarded' IS DISTINCT FROM 'false'::jsonb
    OR context->>'membershipId' IS DISTINCT FROM member->>'membershipId'
    OR context->>'authorizationVersion' IS DISTINCT FROM member->>'authorizationVersion'
    THEN RAISE EXCEPTION 'hermes_domain_context_changed' USING ERRCODE='PT409'; END IF;
  policy:=app_private.hermes_effective_org_policy_v1(p_organization_id,keys,'{}'::text[],NULL);
  FOREACH key IN ARRAY keys LOOP
    enabled:=policy.enabled AND key=ANY(policy.read_capabilities) AND EXISTS(
      SELECT 1 FROM app_private.hermes_capabilities h WHERE h.capability=key AND h.mode='read' AND h.enabled);
    state:=app_private.hermes_metadata_domain_grant_v1(p_organization_id,key,enabled,context);
    result:=result||jsonb_build_object(key,state-'orgWide');
  END LOOP;
  RETURN member||jsonb_build_object('organizationId',p_organization_id,'userId',auth.uid(),'policyVersion',policy.version,'permissions',result);
END $fn$;

CREATE OR REPLACE FUNCTION public.hermes_domain_capabilities_v3(p_organization_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE member jsonb; policy app_private.hermes_org_policies; context jsonb; key text; state jsonb; result jsonb:='{}'; enabled boolean;
  keys constant text[]:=app_private.hermes_w2_read_keys_v1();
BEGIN
  IF auth.role() IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL OR p_organization_id IS NULL
    THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;

  member:=app_private.hermes_metadata_member_v1(auth.uid(),p_organization_id);
  IF app_private.is_actor_offboarded_v1() THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
  context:=public.get_authorization_context_v1(p_organization_id);
  IF context->>'organizationId' IS DISTINCT FROM p_organization_id::text OR context->'isOffboarded' IS DISTINCT FROM 'false'::jsonb
    OR context->>'membershipId' IS DISTINCT FROM member->>'membershipId'
    OR context->>'authorizationVersion' IS DISTINCT FROM member->>'authorizationVersion'
    THEN RAISE EXCEPTION 'hermes_domain_context_changed' USING ERRCODE='PT409'; END IF;
  policy:=app_private.hermes_effective_org_policy_v1(p_organization_id,keys,'{}'::text[],NULL);
  FOREACH key IN ARRAY keys LOOP
    enabled:=policy.enabled AND key=ANY(policy.read_capabilities) AND EXISTS(
      SELECT 1 FROM app_private.hermes_capabilities h WHERE h.capability=key AND h.mode='read' AND h.enabled);
    state:=app_private.hermes_metadata_w2_grant_v1(p_organization_id,key,enabled,context,member);
    result:=result||jsonb_build_object(key,state-'orgWide');
  END LOOP;
  RETURN member||jsonb_build_object('organizationId',p_organization_id,'userId',auth.uid(),'policyVersion',policy.version,'permissions',result);
END $fn$;

ALTER FUNCTION app_private.hermes_metadata_org_allowed_v1(uuid,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_metadata_org_allowed_v1(uuid,text) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
ALTER FUNCTION app_private.hermes_metadata_member_v1(uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_metadata_member_v1(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
ALTER FUNCTION app_private.hermes_metadata_domain_grant_v1(uuid,text,boolean,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_metadata_domain_grant_v1(uuid,text,boolean,jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
ALTER FUNCTION app_private.hermes_metadata_w2_grant_v1(uuid,text,boolean,jsonb,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_metadata_w2_grant_v1(uuid,text,boolean,jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
ALTER FUNCTION public.hermes_group_action_context_v1(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.hermes_group_action_context_v1(uuid) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_group_action_context_v1(uuid) TO authenticated;
ALTER FUNCTION public.hermes_work_memory_capabilities_v1(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.hermes_work_memory_capabilities_v1(uuid) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_work_memory_capabilities_v1(uuid) TO authenticated;
ALTER FUNCTION public.hermes_room_schedule_capabilities_v1(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.hermes_room_schedule_capabilities_v1(uuid) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_room_schedule_capabilities_v1(uuid) TO authenticated;
ALTER FUNCTION public.hermes_room_pass_capabilities_v1(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.hermes_room_pass_capabilities_v1(uuid) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_room_pass_capabilities_v1(uuid) TO authenticated;
ALTER FUNCTION public.hermes_task_create_capabilities_v1(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.hermes_task_create_capabilities_v1(uuid) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_task_create_capabilities_v1(uuid) TO authenticated;
ALTER FUNCTION public.hermes_task_follow_capabilities_v1(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.hermes_task_follow_capabilities_v1(uuid) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_task_follow_capabilities_v1(uuid) TO authenticated;
ALTER FUNCTION public.hermes_customer_create_capabilities_v1(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.hermes_customer_create_capabilities_v1(uuid) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_customer_create_capabilities_v1(uuid) TO authenticated;
ALTER FUNCTION public.hermes_expense_capabilities_v1(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.hermes_expense_capabilities_v1(uuid) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_expense_capabilities_v1(uuid) TO authenticated;
ALTER FUNCTION public.hermes_domain_capabilities_v1(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.hermes_domain_capabilities_v1(uuid) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_domain_capabilities_v1(uuid) TO authenticated;
ALTER FUNCTION public.hermes_domain_capabilities_v2(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.hermes_domain_capabilities_v2(uuid) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_domain_capabilities_v2(uuid) TO authenticated;
ALTER FUNCTION public.hermes_domain_capabilities_v3(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.hermes_domain_capabilities_v3(uuid) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_domain_capabilities_v3(uuid) TO authenticated;

DO $postflight$
DECLARE r record; p record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('app_private.hermes_metadata_org_allowed_v1(uuid,text)','','6000fa3dbe4bad0712624010dee22448'),
    ('app_private.hermes_metadata_member_v1(uuid,uuid)','','b6e14e17b2bb07366cccd630942679e6'),
    ('app_private.hermes_metadata_domain_grant_v1(uuid,text,boolean,jsonb)','','e9f287dc65d6e2f49c747d1cf6cd4d7c'),
    ('app_private.hermes_metadata_w2_grant_v1(uuid,text,boolean,jsonb,jsonb)','','9d2441a5dad6e59497fea613c923aec0'),
    ('public.hermes_group_action_context_v1(uuid)','708b0cd33a925bd153083202f6ad1718','05b8476345515e43d02a05934ae0efae'),
    ('public.hermes_work_memory_capabilities_v1(uuid)','50fdbc4c1553ae70f81e66faba960fee','ac3f5334e0e39fbc839dc7870804689b'),
    ('public.hermes_room_schedule_capabilities_v1(uuid)','f385aa5789aecadee4ff16344c3a6671','ec02c40dce9f83dbf728c59a361a726e'),
    ('public.hermes_room_pass_capabilities_v1(uuid)','ecad3ab9a316c104f203ae5364caf793','4653cf6d18f8bdcdee758fbab7405769'),
    ('public.hermes_task_create_capabilities_v1(uuid)','539c7484c89bd7f92679b36fa254dceb','678cfe54d65dd0dca0d7dd983f0a09b4'),
    ('public.hermes_task_follow_capabilities_v1(uuid)','fe5b631081607424411ba0693d3e8a6c','d8f47da8bc58b0f4c60c5f6dc15e4b70'),
    ('public.hermes_customer_create_capabilities_v1(uuid)','09b0d4be1b8018eaae9955c85e017921','a97b992bfbb2042efc46b2920c49b4af'),
    ('public.hermes_expense_capabilities_v1(uuid)','7095b8393406476f3163a2f046f14d82','bdcbd320c7a1eae9198e05961bddf07c'),
    ('public.hermes_domain_capabilities_v1(uuid)','8a560e1985c294c03bd3349a7383c366','73ae6a7e6939694d30153de6c4647a19'),
    ('public.hermes_domain_capabilities_v2(uuid)','76a325c3c967a8dc39ca095ea1d6139e','51280959d5c993181b0b73a1bc4e0c0d'),
    ('public.hermes_domain_capabilities_v3(uuid)','8ac4c74ab42e7cf434f7a17c3289d629','8dbc72520a081fef9d69dbb1e8090bc8')
  ) AS expected(signature,old_digest,new_digest) LOOP
    SELECT pr.* INTO STRICT p FROM pg_proc pr WHERE pr.oid=to_regprocedure(r.signature);
    IF p.provolatile<>'s' OR NOT p.prosecdef OR pg_get_userbyid(p.proowner)<>'postgres'
      OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, app_private']::text[]
      OR EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.privilege_type<>'EXECUTE' OR a.is_grantable OR a.grantee=0
          OR (pg_get_userbyid(a.grantee)<>'postgres'
            AND (r.signature NOT LIKE 'public.%' OR pg_get_userbyid(a.grantee)<>'authenticated')))
      OR md5(replace(p.prosrc,chr(13),''))<>r.new_digest
      THEN RAISE EXCEPTION 'hermes_metadata_postflight_failed: %',r.signature; END IF;
  END LOOP;
END $postflight$;
COMMIT;
NOTIFY pgrst,'reload schema';
