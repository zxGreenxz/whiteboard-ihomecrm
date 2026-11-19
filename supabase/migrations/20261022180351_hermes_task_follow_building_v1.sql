-- Hermes Đợt 2b — trang Công việc, Mốc 4 (docs/plans/hermes-crm/CONG-VIEC-THAO-TAC-GHI.md mục 4, 21): đóng mục (3) của known-gap
-- hermes-pham-vi-toa-chua-giao-web (tooling/known-gaps.yaml). Lượt theo dõi việc (crm_task_follow_*) kiểm lại quyền mỗi lượt nhắc 15 phút
-- bằng app_private.hermes_task_follow_grant_v1(app_private.hermes_task_follows); hàm chỉ kiểm tasks.create/tasks.view theo khoá, nên lượt tạo TRƯỚC khi áp 20261021170452
-- (PR #261: phạm vi đọc ∩ tập toà web) ở toà mà web giấu người giao vẫn báo tiến độ việc đó. Thêm đúng một điều kiện: người giao phải
-- còn buildings.view ở toà của việc (authorize_tenant_action_v3, như hàm lấy toà web); mất ⇒ 'permission_lost' ⇒ lượt nhắc đóng theo
-- dõi (hermes_task_follow_tick_v1, không đổi). Việc không gắn toà giữ luật cũ.
-- Dựng từ thân ĐANG CHẠY production + TEST (20261015130000, md5 ghim dưới; thân khác ⇒ dừng), cùng chữ ký, cùng ACL (không vai API nào
-- được gọi). Không DROP, không ghi dữ liệu. Idempotent.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $requires$
BEGIN
  IF to_regprocedure('app_private.authorize_tenant_action_v3(uuid,uuid,text,uuid,uuid)') IS NULL
    OR COALESCE((SELECT md5(replace(p.prosrc,chr(13),'')) FROM pg_proc p WHERE p.oid=to_regprocedure('app_private.hermes_task_follow_grant_v1(app_private.hermes_task_follows)')),'') NOT IN ('9048fb1c6db22d3b883e8c4d9a6e4f89','689441d09c72fda81b77b7528e6b50dc') THEN
    RAISE EXCEPTION 'hermes_task_follow_building_dependency_invalid'; END IF;
END $requires$;

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
  -- Known-gap hermes-pham-vi-toa-chua-giao-web mục (3) (Đợt 2b Công việc Mốc 4): lượt theo dõi tạo TRƯỚC khi áp 20261021170452 (PR #261)
  -- ở toà mà web giấu người giao (mất buildings.view ở toà) không còn báo tiến độ việc đó: đóng như mất quyền. Việc không gắn toà giữ
  -- luật cũ (khoá module, không có toà để giấu).
  IF f.building_id IS NOT NULL AND NOT COALESCE((SELECT a.allowed FROM app_private.authorize_tenant_action_v3(f.assigner_user_id,f.organization_id,
      'buildings.view',f.building_id,NULL) a),false)
    THEN RETURN 'permission_lost'; END IF;
  RETURN NULL;
END $fn$;

ALTER FUNCTION app_private.hermes_task_follow_grant_v1(app_private.hermes_task_follows) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_task_follow_grant_v1(app_private.hermes_task_follows) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;

DO $check$
BEGIN
  IF (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid='app_private.hermes_task_follow_grant_v1(app_private.hermes_task_follows)'::regprocedure AND p.prosecdef) IS DISTINCT FROM '689441d09c72fda81b77b7528e6b50dc'
    OR has_function_privilege('authenticated','app_private.hermes_task_follow_grant_v1(app_private.hermes_task_follows)','EXECUTE') OR has_function_privilege('anon','app_private.hermes_task_follow_grant_v1(app_private.hermes_task_follows)','EXECUTE')
    THEN RAISE EXCEPTION 'hermes_task_follow_building_check_failed'; END IF;
END $check$;
COMMIT;
NOTIFY pgrst,'reload schema';
