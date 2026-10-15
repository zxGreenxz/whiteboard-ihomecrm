-- Sửa sau review độc lập cho đợt Hermes 15/10 (sau 8 migration 20261015100000…120200,
-- các file đó giữ nguyên). Chỉ CREATE OR REPLACE, giữ chữ ký, kiểu trả về, owner,
-- search_path và ACL; chạy lại an toàn.
--  P2-1 hermes_task_follow_grant_v1: mỗi lượt nhắc/báo tiến độ kiểm lại Read
--       tasks.view của Hermes (registry ∩ trần công ty ∩ overlay kết nối) như lúc
--       tạo theo dõi, cạnh Action tasks.create và quyền CRM.
--  P3a hermes_task_follow_tick_v1: mỗi theo dõi và mỗi thông báo là một
--       subtransaction; lỗi một dòng không làm hỏng cả lượt mọi công ty. Khoá công
--       ty chờ tối đa lock_timeout của hàm; công ty bận được bỏ qua lượt này thay vì
--       vừa chờ vừa giữ khoá các công ty đã khoá. (Khoá dòng đã lấy trong cùng
--       transaction vẫn giữ đến COMMIT; tách transaction theo công ty cần thủ tục
--       COMMIT riêng, ngoài phạm vi sửa này.)
--  P3b hermes_finance_extend_options_v1: nhánh context chỉ đưa khoá vào effective
--       khi phạm vi chính kết nối (scopeIds) còn phủ một toà của quyền đó, như hook
--       task/follow.
--  P3d hermes_task_follow_member_v1: thêm công ty ACTIVE như hermes_member_v1.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $guard$
BEGIN
  IF to_regclass('app_private.hermes_task_follows') IS NULL THEN
    RAISE EXCEPTION 'hermes_review_fixes_requires_20261015_batch' USING ERRCODE='55000'; END IF;
  IF to_regprocedure('app_private.hermes_task_follow_grant_v1(app_private.hermes_task_follows)') IS NULL
    OR to_regprocedure('app_private.hermes_task_follow_tick_v1(integer)') IS NULL
    OR to_regprocedure('app_private.hermes_task_follow_member_v1(uuid,uuid)') IS NULL
    OR to_regprocedure('app_private.hermes_finance_extend_options_v1(jsonb,text)') IS NULL THEN
    RAISE EXCEPTION 'hermes_review_fixes_requires_20261015_batch' USING ERRCODE='55000'; END IF;
END $guard$;

-- P3d
CREATE OR REPLACE FUNCTION app_private.hermes_task_follow_member_v1(p_org uuid,p_user uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
  SELECT p_org IS NOT NULL AND p_user IS NOT NULL AND EXISTS(SELECT 1 FROM public.organization_memberships m
    JOIN public.organizations o ON o.id=m.organization_id
    WHERE m.user_id=p_user AND m.organization_id=p_org AND o.status='ACTIVE' AND m.status='ACTIVE' AND m.revoked_at IS NULL
      AND (m.valid_from IS NULL OR m.valid_from<=clock_timestamp()) AND (m.valid_to IS NULL OR m.valid_to>clock_timestamp()))
$fn$;

-- P2-1. Standing grant còn hiệu lực? NULL = còn; ngược lại là lý do đóng.
CREATE OR REPLACE FUNCTION app_private.hermes_task_follow_grant_v1(f app_private.hermes_task_follows)
RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE policy app_private.hermes_org_policies; d_create record; d_view record;
BEGIN
  BEGIN PERFORM app_private.hermes_member_v1(f.assigner_user_id,f.organization_id);
  EXCEPTION WHEN insufficient_privilege THEN RETURN 'membership_lost'; END;
  IF NOT EXISTS(SELECT 1 FROM app_private.hermes_assistants a WHERE a.id=f.assistant_id AND a.state='ACTIVE') THEN RETURN 'permission_lost'; END IF;
  policy:=app_private.hermes_effective_org_policy_v1(f.organization_id,NULL,NULL,NULL);
  IF NOT COALESCE(policy.enabled,false) OR NOT('tasks.create'=ANY(policy.action_capabilities))
    OR NOT EXISTS(SELECT 1 FROM app_private.hermes_capabilities h WHERE h.capability='tasks.create' AND h.mode='action' AND h.enabled)
    THEN RETURN 'permission_lost'; END IF;
  -- A standing follow reports job status: it keeps needing the task Read grant
  -- exactly as at creation (registry kill switch and company ceiling here).
  IF NOT EXISTS(SELECT 1 FROM app_private.hermes_capabilities h WHERE h.capability='tasks.view' AND h.mode='read' AND h.enabled)
    THEN RETURN 'permission_lost'; END IF;
  IF NOT('tasks.view'=ANY(policy.read_capabilities))
    THEN RETURN 'permission_lost'; END IF;
  -- Rotation keeps the grant only while some active connection of the same
  -- assistant still carries the action AND the read and covers this building.
  IF NOT EXISTS(SELECT 1 FROM app_private.hermes_connections hc WHERE hc.assistant_id=f.assistant_id AND hc.organization_id=f.organization_id
      AND hc.user_id=f.assigner_user_id AND hc.state='ACTIVE' AND hc.revoked_at IS NULL AND 'tasks.create'=ANY(hc.action_capabilities)
      AND 'tasks.view'=ANY(hc.read_capabilities)
      AND EXISTS(SELECT 1 FROM public.authorization_scopes overlay WHERE overlay.organization_id=f.organization_id
        AND overlay.id=ANY(hc.scope_ids) AND overlay.id=ANY(policy.scope_ids)
        AND (overlay.scope_type='ORGANIZATION' OR (overlay.scope_type='BUILDING' AND overlay.building_id=f.building_id)
          OR (overlay.scope_type='AREA' AND EXISTS(SELECT 1 FROM public.area_buildings ab JOIN public.areas a
            ON a.id=ab.area_id AND a.organization_id=ab.organization_id AND a.deleted_at IS NULL
            WHERE ab.organization_id=f.organization_id AND ab.area_id=overlay.area_id AND ab.building_id=f.building_id)))))
    THEN RETURN 'permission_lost'; END IF;
  SELECT * INTO d_create FROM app_private.authorize_tenant_action_v3(f.assigner_user_id,f.organization_id,'tasks.create',f.building_id,NULL);
  SELECT * INTO d_view FROM app_private.authorize_tenant_action_v3(f.assigner_user_id,f.organization_id,'tasks.view',f.building_id,NULL);
  IF NOT COALESCE(d_create.allowed,false) OR NOT COALESCE(d_view.allowed,false)
    OR (d_create.nearest_deadline IS NOT NULL AND d_create.nearest_deadline<=clock_timestamp())
    OR (d_view.nearest_deadline IS NOT NULL AND d_view.nearest_deadline<=clock_timestamp())
    THEN RETURN 'permission_lost'; END IF;
  RETURN NULL;
END $fn$;

-- P3a. Lượt nhắc/báo cáo (pg_cron hiện có, 15 phút). Kiểm lại standing grant mỗi
-- lượt; gộp theo (người nhận, loại). Một theo dõi lỗi chỉ hoàn tác chính nó (thông
-- báo chờ của nó bị bỏ, lượt sau thử lại); một thông báo lỗi không chặn nhóm khác.
CREATE OR REPLACE FUNCTION app_private.hermes_task_follow_tick_v1(p_limit integer DEFAULT 500)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private SET lock_timeout='2s' AS $fn$
DECLARE v_org uuid; f app_private.hermes_task_follows; j public.jobs; v_now timestamptz; v_reason text; v_found boolean;
  v_groups jsonb:='{}'; v_pending jsonb; v_close integer; v_item jsonb; v_locked boolean; g record; p record; v_parts text[];
  v_checked integer:=0; v_closed integer:=0; v_notified integer:=0; v_failed integer:=0; v_skipped integer:=0;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 5000 THEN RAISE EXCEPTION 'hermes_task_invalid' USING ERRCODE='22023'; END IF;
  IF NOT pg_try_advisory_xact_lock(hashtext('app_private.hermes_task_follow_tick_v1')) THEN
    RETURN jsonb_build_object('busy',true); END IF;
  FOR v_org IN SELECT DISTINCT organization_id FROM app_private.hermes_task_follows WHERE state='ACTIVE' ORDER BY 1 LOOP
    -- A company whose authorization row stays busy past lock_timeout is skipped
    -- this tick instead of being waited on while earlier companies stay locked.
    v_locked:=true;
    BEGIN PERFORM app_private.lock_org_for_decision_v1(v_org);
    EXCEPTION WHEN OTHERS THEN v_locked:=false;
      RAISE WARNING 'hermes_task_follow_tick_v1: organization % skipped (%)',v_org,SQLSTATE;
    END;
    IF NOT v_locked THEN v_skipped:=v_skipped+1; CONTINUE; END IF;
    v_now:=clock_timestamp();
    -- Least recently checked first, so a large company is covered across ticks.
    FOR f IN SELECT * FROM app_private.hermes_task_follows WHERE organization_id=v_org AND state='ACTIVE'
        ORDER BY checked_at NULLS FIRST,id LIMIT p_limit FOR UPDATE SKIP LOCKED LOOP
      v_checked:=v_checked+1; v_pending:='[]'::jsonb; v_close:=0;
      BEGIN
        UPDATE app_private.hermes_task_follows SET checked_at=v_now WHERE id=f.id;
        v_reason:=app_private.hermes_task_follow_grant_v1(f);
        IF v_reason IS NOT NULL THEN
          UPDATE app_private.hermes_task_follows SET state='REVOKED',close_reason=v_reason,closed_at=v_now,version=version+1,updated_at=v_now WHERE id=f.id;
          PERFORM app_private.append_authz_audit_v1(f.organization_id,'HERMES_TASK_FOLLOW_REVOKED','hermes_task_follow',f.id,NULL,
            jsonb_build_object('assigner',f.assigner_user_id,'executor',f.executor_user_id,'jobId',f.job_id,'reason',v_reason),'Standing follow lost authority');
          v_close:=1;
        ELSE
          SELECT * INTO j FROM public.jobs WHERE id=f.job_id AND organization_id=f.organization_id;
          v_found:=FOUND;
          v_item:=jsonb_build_object('jobId',f.job_id,'code',f.job_code,'title',
            CASE WHEN v_found THEN COALESCE(app_private.hermes_task_follow_label_v1(j.title,200),f.job_title) ELSE f.job_title END,
            'deadline',CASE WHEN v_found THEN app_private.hermes_task_follow_iso_v1(j.deadline) END);
          IF NOT v_found OR j.status='COMPLETED' THEN
            UPDATE app_private.hermes_task_follows SET state=CASE WHEN v_found THEN 'DONE' ELSE 'CANCELLED' END,
              close_reason=CASE WHEN v_found THEN 'completed' ELSE 'job_deleted' END,closed_at=v_now,version=version+1,updated_at=v_now WHERE id=f.id;
            v_close:=1;
            IF f.notify_assigner THEN
              v_pending:=v_pending||jsonb_build_array(jsonb_build_array(
                f.organization_id::text||'|'||f.assigner_user_id::text||'|'||CASE WHEN v_found THEN 'done' ELSE 'deleted' END,v_item));
            END IF;
          ELSE
            IF j.assignee_id IS NOT NULL AND j.assignee_id IS DISTINCT FROM f.executor_user_id THEN
              UPDATE app_private.hermes_task_follows SET executor_user_id=j.assignee_id,version=version+1,updated_at=v_now WHERE id=f.id;
            END IF;
            IF j.status='IN_PROGRESS' AND j.deadline IS NOT NULL THEN
              IF f.remind_before_minutes IS NOT NULL AND f.due_notified_at IS NULL AND j.assignee_id IS NOT NULL
                AND v_now>=j.deadline-make_interval(mins=>f.remind_before_minutes) AND v_now<j.deadline THEN
                UPDATE app_private.hermes_task_follows SET due_notified_at=v_now,updated_at=v_now WHERE id=f.id;
                v_pending:=v_pending||jsonb_build_array(jsonb_build_array(f.organization_id::text||'|'||j.assignee_id::text||'|due',v_item));
              END IF;
              IF v_now>=j.deadline AND f.overdue_notified_at IS NULL THEN
                UPDATE app_private.hermes_task_follows SET overdue_notified_at=v_now,updated_at=v_now WHERE id=f.id;
                IF j.assignee_id IS NOT NULL THEN
                  v_pending:=v_pending||jsonb_build_array(jsonb_build_array(f.organization_id::text||'|'||j.assignee_id::text||'|overdue',v_item));
                END IF;
                IF f.notify_assigner AND f.assigner_user_id IS DISTINCT FROM j.assignee_id THEN
                  v_pending:=v_pending||jsonb_build_array(jsonb_build_array(f.organization_id::text||'|'||f.assigner_user_id::text||'|overdue_report',v_item));
                END IF;
              END IF;
            END IF;
          END IF;
        END IF;
      EXCEPTION WHEN OTHERS THEN
        v_pending:='[]'::jsonb; v_close:=0; v_failed:=v_failed+1;
        RAISE WARNING 'hermes_task_follow_tick_v1: follow % skipped (%)',f.id,SQLSTATE;
        -- Rotate the failing follow behind the others; it is retried next tick.
        UPDATE app_private.hermes_task_follows SET checked_at=v_now WHERE id=f.id;
      END;
      v_closed:=v_closed+v_close;
      FOR p IN SELECT x.e->>0 AS k,x.e->1 AS item FROM jsonb_array_elements(v_pending) AS x(e) LOOP
        v_groups:=jsonb_set(v_groups,ARRAY[p.k],COALESCE(v_groups->p.k,'[]'::jsonb)||jsonb_build_array(p.item),true);
      END LOOP;
    END LOOP;
  END LOOP;
  -- A failing notice is skipped (its follows keep their marks: no repeat storm);
  -- the other recipients are still told.
  FOR g IN SELECT key,value FROM jsonb_each(v_groups) ORDER BY key LOOP
    v_parts:=string_to_array(g.key,'|');
    BEGIN
      IF app_private.hermes_task_follow_notify_v1(v_parts[1]::uuid,v_parts[2]::uuid,v_parts[3],g.value,NULL,NULL) IS NOT NULL THEN
        v_notified:=v_notified+1; END IF;
    EXCEPTION WHEN OTHERS THEN v_failed:=v_failed+1;
      RAISE WARNING 'hermes_task_follow_tick_v1: % notice skipped (%)',v_parts[3],SQLSTATE;
    END;
  END LOOP;
  RETURN jsonb_build_object('checked',v_checked,'closed',v_closed,'notified',v_notified,'failed',v_failed,'skippedOrganizations',v_skipped);
END $fn$;

-- P3b. Như 20261015120200, riêng nhánh context giao effective với phạm vi kết nối.
CREATE OR REPLACE FUNCTION app_private.hermes_finance_extend_options_v1(p_result jsonb,p_kind text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE result jsonb:=p_result; org uuid; member jsonb; reads jsonb; actions jsonb; key text; v_mode text; cap jsonb;
  policy app_private.hermes_org_policies; building_ids uuid[]:='{}'::uuid[]; cap_buildings uuid[]; choices jsonb; combined jsonb; kept jsonb;
  read_keys constant text[]:=ARRAY['income_expenses.view','meter_readings.view','deposits.view','reports_finance.analysis'];
  action_keys constant text[]:=ARRAY['income_expenses.create','income_expenses.approve'];
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('org_options','connection_options','context') OR jsonb_typeof(result) IS DISTINCT FROM 'object'
    OR auth.role() IS DISTINCT FROM 'authenticated' OR result->>'userId' IS DISTINCT FROM auth.uid()::text
    THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
  org:=app_private.hermes_uuid_v1(result->'organizationId');
  PERFORM app_private.lock_org_for_decision_v1(org);
  member:=app_private.hermes_member_v1(auth.uid(),org);
  IF member->>'membershipId' IS DISTINCT FROM result->>'membershipId'
    OR member->>'authorizationVersion' IS DISTINCT FROM result->>'authorizationVersion'
    THEN RAISE EXCEPTION 'hermes_domain_context_changed' USING ERRCODE='PT409'; END IF;
  IF p_kind='org_options' THEN
    -- The base wrapper already enforced CRM users.edit. Adds enabled registry
    -- choices only; never enables registry/policy or copies a role.
    FOR key,v_mode IN SELECT h.capability,h.mode FROM app_private.hermes_capabilities h WHERE h.enabled
      AND ((h.capability=ANY(read_keys) AND h.mode='read') OR (h.capability=ANY(action_keys) AND h.mode='action')) ORDER BY h.capability LOOP
      IF NOT(result#>ARRAY['choices',v_mode] ? key) THEN
        result:=jsonb_set(result,ARRAY['choices',v_mode],(result#>ARRAY['choices',v_mode])||to_jsonb(key),false);
      END IF;
    END LOOP;
    RETURN result;
  END IF;
  reads:=public.hermes_domain_capabilities_v2(org);
  actions:=public.hermes_expense_capabilities_v1(org);
  IF reads->>'policyVersion' IS DISTINCT FROM result->>'policyVersion' OR actions->>'policyVersion' IS DISTINCT FROM result->>'policyVersion'
    OR reads->>'membershipId' IS DISTINCT FROM result->>'membershipId' OR actions->>'membershipId' IS DISTINCT FROM result->>'membershipId'
    OR reads->>'authorizationVersion' IS DISTINCT FROM result->>'authorizationVersion'
    OR actions->>'authorizationVersion' IS DISTINCT FROM result->>'authorizationVersion'
    THEN RAISE EXCEPTION 'hermes_domain_context_changed' USING ERRCODE='PT409'; END IF;
  IF p_kind='connection_options' AND result->'enabled' IS DISTINCT FROM 'true'::jsonb THEN RETURN result; END IF;
  policy:=app_private.hermes_effective_org_policy_v1(org,NULL,NULL,NULL);
  FOREACH key IN ARRAY read_keys||action_keys LOOP
    v_mode:=CASE WHEN key=ANY(read_keys) THEN 'read' ELSE 'action' END;
    cap:=(CASE v_mode WHEN 'read' THEN reads ELSE actions END)->'permissions'->key;
    CONTINUE WHEN cap->'allowed' IS DISTINCT FROM 'true'::jsonb;
    IF p_kind='connection_options' THEN
      IF NOT(result->v_mode ? key) THEN result:=jsonb_set(result,ARRAY[v_mode],(result->v_mode)||to_jsonb(key),false); END IF;
      SELECT COALESCE(array_agg(DISTINCT value::uuid),'{}'::uuid[]) INTO building_ids FROM (
        SELECT unnest(building_ids)::text value UNION SELECT jsonb_array_elements_text(cap->'buildingIds')) merged;
    ELSIF result#>ARRAY['restrictions',v_mode] ? key AND result#>ARRAY['companyCeilings',v_mode] ? key
      AND NOT(result#>ARRAY['effective',v_mode] ? key) THEN
      -- Effective only where this connection's own saved scope (∩ company scope)
      -- still covers a building of the current CRM grant, as the task hooks do.
      SELECT COALESCE(array_agg(value::uuid),'{}'::uuid[]) INTO cap_buildings
        FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(cap->'buildingIds')='array' THEN cap->'buildingIds' ELSE '[]'::jsonb END);
      IF jsonb_typeof(result->'scopeIds')='array' AND EXISTS(SELECT 1 FROM public.authorization_scopes scope
          LEFT JOIN public.buildings b ON b.id=scope.building_id AND b.organization_id=org AND b.deleted_at IS NULL
          LEFT JOIN public.areas a ON a.id=scope.area_id AND a.organization_id=org AND a.deleted_at IS NULL
          WHERE scope.organization_id=org AND scope.id=ANY(policy.scope_ids) AND scope.cashbook_id IS NULL
            AND result->'scopeIds' ? scope.id::text AND (
            (scope.scope_type='ORGANIZATION' AND scope.building_id IS NULL AND scope.area_id IS NULL AND cardinality(cap_buildings)>0) OR
            (scope.scope_type='BUILDING' AND b.id=ANY(cap_buildings) AND scope.area_id IS NULL) OR
            (scope.scope_type='AREA' AND a.id IS NOT NULL AND scope.building_id IS NULL AND EXISTS(SELECT 1 FROM public.area_buildings ab
              WHERE ab.organization_id=org AND ab.area_id=a.id AND ab.building_id=ANY(cap_buildings))))) THEN
        result:=jsonb_set(result,ARRAY['effective',v_mode],(result#>ARRAY['effective',v_mode])||to_jsonb(key),false);
      END IF;
    END IF;
  END LOOP;
  IF p_kind='context' THEN RETURN result; END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('scopeId',scope.id,'scopeType',scope.scope_type,
    'label',CASE scope.scope_type WHEN 'ORGANIZATION' THEN 'Toàn tổ chức' WHEN 'BUILDING' THEN 'Toà: '||COALESCE(b.name,'(chưa đặt tên)')
      WHEN 'AREA' THEN 'Khu vực: '||COALESCE(a.name,'(chưa đặt tên)') END,
    'buildingId',scope.building_id,'areaId',scope.area_id,'cashbookId',NULL) ORDER BY scope.id),'[]') INTO choices
    FROM public.authorization_scopes scope
    LEFT JOIN public.buildings b ON b.id=scope.building_id AND b.organization_id=org AND b.deleted_at IS NULL
    LEFT JOIN public.areas a ON a.id=scope.area_id AND a.organization_id=org AND a.deleted_at IS NULL
    WHERE scope.organization_id=org AND scope.id=ANY(policy.scope_ids) AND scope.cashbook_id IS NULL AND (
      (scope.scope_type='ORGANIZATION' AND scope.building_id IS NULL AND scope.area_id IS NULL AND cardinality(building_ids)>0) OR
      (scope.scope_type='BUILDING' AND b.id=ANY(building_ids) AND scope.area_id IS NULL) OR
      (scope.scope_type='AREA' AND a.id IS NOT NULL AND scope.building_id IS NULL AND EXISTS(SELECT 1 FROM public.area_buildings ab
        WHERE ab.organization_id=org AND ab.area_id=a.id AND ab.building_id=ANY(building_ids))));
  SELECT COALESCE(jsonb_agg(value ORDER BY value->>'scopeId'),'[]') INTO combined FROM (
    SELECT DISTINCT ON (value->>'scopeId') value FROM jsonb_array_elements((result->'scopes')||choices) ORDER BY value->>'scopeId') selected;
  IF jsonb_array_length(combined)>256 THEN RAISE EXCEPTION 'hermes_domain_scope_too_large' USING ERRCODE='22023'; END IF;
  result:=jsonb_set(result,'{scopes}',combined,false);
  IF jsonb_array_length(combined)=0 THEN
    -- Nothing selectable: do not offer keys that could never be used.
    SELECT COALESCE(jsonb_agg(value ORDER BY value),'[]') INTO kept FROM jsonb_array_elements(result->'read') value WHERE NOT(value#>>'{}'=ANY(read_keys));
    result:=jsonb_set(result,'{read}',kept,false);
    SELECT COALESCE(jsonb_agg(value ORDER BY value),'[]') INTO kept FROM jsonb_array_elements(result->'action') value WHERE NOT(value#>>'{}'=ANY(action_keys));
    result:=jsonb_set(result,'{action}',kept,false);
  END IF;
  RETURN result;
END $fn$;

-- Owner/ACL giữ như bản cũ: helper riêng tư, không role API nào được EXECUTE.
ALTER FUNCTION app_private.hermes_task_follow_member_v1(uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_task_follow_member_v1(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
ALTER FUNCTION app_private.hermes_task_follow_grant_v1(app_private.hermes_task_follows) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_task_follow_grant_v1(app_private.hermes_task_follows) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
ALTER FUNCTION app_private.hermes_task_follow_tick_v1(integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_task_follow_tick_v1(integer) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
ALTER FUNCTION app_private.hermes_finance_extend_options_v1(jsonb,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_finance_extend_options_v1(jsonb,text) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;

DO $kiem$
BEGIN
  IF has_function_privilege('authenticated','app_private.hermes_task_follow_tick_v1(integer)','EXECUTE')
    OR has_function_privilege('authenticated','app_private.hermes_task_follow_grant_v1(app_private.hermes_task_follows)','EXECUTE')
    OR has_function_privilege('authenticated','app_private.hermes_task_follow_member_v1(uuid,uuid)','EXECUTE')
    OR has_function_privilege('authenticated','app_private.hermes_finance_extend_options_v1(jsonb,text)','EXECUTE')
    OR has_function_privilege('anon','app_private.hermes_task_follow_tick_v1(integer)','EXECUTE')
    THEN RAISE EXCEPTION 'hermes_review_fixes_acl_leak'; END IF;
END $kiem$;
COMMIT;
NOTIFY pgrst,'reload schema';
