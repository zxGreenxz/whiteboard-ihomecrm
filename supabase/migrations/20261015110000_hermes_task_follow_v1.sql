-- P7.06/P7.07 · Theo dõi, nhắc, báo cáo và huỷ việc đã giao qua connector Hermes.
-- public.jobs vẫn là nền nhiệm vụ CRM duy nhất; tạo/giao giữ ở
-- hermes_task_create_action_v1. Phong bì theo dõi chỉ thêm mục tiêu, hạn nhắc,
-- chuỗi giao và provenance (người giao = actor, người thực hiện = assignee).
-- Không đọc personal memory/private history, không giả danh người nhận, không
-- engine/PIN Copilot. Capability mới cài TẮT; quyền thật = quyền CRM hiện tại ∩
-- Đọc/Thao tác Hermes. Hoàn thành việc vẫn qua CRM (ảnh, vị trí, lương).
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

INSERT INTO app_private.hermes_capabilities(capability,mode,enabled) VALUES
  ('tasks.edit','action',false),('tasks.delete','action',false)
  ON CONFLICT(capability) DO NOTHING;

CREATE TABLE IF NOT EXISTS app_private.hermes_task_follows(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  job_id uuid NOT NULL,
  job_code text NOT NULL CHECK(char_length(job_code) BETWEEN 1 AND 64),
  job_title text NOT NULL CHECK(char_length(job_title) BETWEEN 1 AND 200),
  building_id uuid NOT NULL,
  assigner_user_id uuid NOT NULL REFERENCES auth.users(id),
  assistant_id uuid NOT NULL,
  connection_id uuid NOT NULL REFERENCES app_private.hermes_connections(id),
  executor_user_id uuid NOT NULL,
  mode text NOT NULL CHECK(mode IN ('self','supervisor')),
  parent_follow_id uuid REFERENCES app_private.hermes_task_follows(id),
  depth smallint NOT NULL DEFAULT 0 CHECK(depth BETWEEN 0 AND 3),
  objective text NOT NULL CHECK(char_length(objective) BETWEEN 1 AND 500),
  remind_before_minutes integer CHECK(remind_before_minutes IS NULL OR remind_before_minutes BETWEEN 0 AND 10080),
  notify_assigner boolean NOT NULL DEFAULT true,
  state text NOT NULL DEFAULT 'ACTIVE' CHECK(state IN ('ACTIVE','DONE','CANCELLED','REVOKED')),
  close_reason text CHECK(close_reason IN ('stopped','job_cancelled','job_deleted','completed','permission_lost','membership_lost')),
  version bigint NOT NULL DEFAULT 1 CHECK(version BETWEEN 1 AND 9007199254740990),
  due_notified_at timestamptz,
  overdue_notified_at timestamptz,
  progress_notification_id uuid,
  checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  closed_at timestamptz,
  closed_by uuid,
  FOREIGN KEY(assistant_id,organization_id,assigner_user_id) REFERENCES app_private.hermes_assistants(id,organization_id,user_id),
  CHECK((state='ACTIVE')=(close_reason IS NULL AND closed_at IS NULL)),
  CHECK(objective !~ '[\x01-\x1F\x7F-\x9F]' AND position(chr(8232) IN objective)=0 AND position(chr(8233) IN objective)=0)
);
CREATE UNIQUE INDEX IF NOT EXISTS hermes_task_follows_active_job ON app_private.hermes_task_follows(job_id,assigner_user_id) WHERE state='ACTIVE';
CREATE INDEX IF NOT EXISTS hermes_task_follows_active ON app_private.hermes_task_follows(organization_id,checked_at NULLS FIRST,id) WHERE state='ACTIVE';
CREATE INDEX IF NOT EXISTS hermes_task_follows_assigner ON app_private.hermes_task_follows(organization_id,assigner_user_id,created_at);
CREATE INDEX IF NOT EXISTS hermes_task_follows_executor ON app_private.hermes_task_follows(organization_id,executor_user_id,state);

-- Idempotency ledger. A replay with the same requestId returns the recorded
-- result; a changed intent or another connection is a conflict, never a retry.
CREATE TABLE IF NOT EXISTS app_private.hermes_task_follow_receipts(
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  user_id uuid NOT NULL REFERENCES auth.users(id),
  request_id uuid NOT NULL,
  connection_id uuid NOT NULL REFERENCES app_private.hermes_connections(id),
  operation text NOT NULL CHECK(operation IN ('set','stop','progress','cancel')),
  input jsonb NOT NULL,
  plan jsonb,
  result jsonb,
  transaction_id bigint NOT NULL DEFAULT txid_current(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(organization_id,user_id,request_id)
);
ALTER TABLE app_private.hermes_task_follows OWNER TO postgres;
ALTER TABLE app_private.hermes_task_follow_receipts OWNER TO postgres;
ALTER TABLE app_private.hermes_task_follows ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.hermes_task_follow_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE app_private.hermes_task_follows,app_private.hermes_task_follow_receipts
  FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;

-- ---------------------------------------------------------------------------
-- Chống vòng lặp giao việc ở chính sổ tạo việc Hermes (không đổi hàm tạo việc):
-- mỗi người tối đa 30 việc/giờ qua Hermes; một cặp người (hai chiều, kể cả tự
-- giao cho chính mình) tối đa 10 việc/giờ. Từ chối là 22023, không phải lỗi mơ hồ.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_private.hermes_task_dispatch_quota_v1()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,app_private AS $fn$
DECLARE v_assignee text; v_count integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('hermes_task_dispatch:'||NEW.organization_id::text||':'||NEW.user_id::text,0));
  SELECT count(*) INTO v_count FROM app_private.hermes_task_create_receipts r
    WHERE r.organization_id=NEW.organization_id AND r.user_id=NEW.user_id AND r.started_at>clock_timestamp()-interval '1 hour';
  IF v_count>=30 THEN RAISE EXCEPTION 'hermes_task_quota_exceeded' USING ERRCODE='22023'; END IF;
  IF jsonb_typeof(NEW.input->'assigneeId')='string' THEN
    v_assignee:=NEW.input->>'assigneeId';
    SELECT count(*) INTO v_count FROM app_private.hermes_task_create_receipts r
      WHERE r.organization_id=NEW.organization_id AND r.started_at>clock_timestamp()-interval '1 hour'
        AND ((r.user_id=NEW.user_id AND r.input->>'assigneeId'=v_assignee)
          OR (r.user_id::text=v_assignee AND r.input->>'assigneeId'=NEW.user_id::text));
    IF v_count>=10 THEN RAISE EXCEPTION 'hermes_task_loop_blocked' USING ERRCODE='22023'; END IF;
  END IF;
  RETURN NEW;
END $fn$;
DROP TRIGGER IF EXISTS hermes_task_dispatch_quota ON app_private.hermes_task_create_receipts;
CREATE TRIGGER hermes_task_dispatch_quota BEFORE INSERT ON app_private.hermes_task_create_receipts
  FOR EACH ROW EXECUTE FUNCTION app_private.hermes_task_dispatch_quota_v1();

-- ---------------------------------------------------------------------------
-- Bộ kiểm dữ liệu vào (bounded, không ký tự điều khiển, không chuỗi bí mật).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_private.hermes_task_follow_int_v1(p jsonb,p_min integer,p_max integer)
RETURNS integer LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
BEGIN
  IF p IS NULL OR jsonb_typeof(p)<>'number' OR (p#>>'{}') !~ '^[0-9]{1,6}$' OR (p#>>'{}')::integer NOT BETWEEN p_min AND p_max
    THEN RAISE EXCEPTION 'hermes_task_invalid' USING ERRCODE='22023'; END IF;
  RETURN (p#>>'{}')::integer;
END $fn$;

CREATE OR REPLACE FUNCTION app_private.hermes_task_follow_text_v1(p jsonb,p_max integer,p_multiline boolean)
RETURNS text LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE v text;
BEGIN
  IF p IS NULL OR jsonb_typeof(p)<>'string' THEN RAISE EXCEPTION 'hermes_task_invalid' USING ERRCODE='22023'; END IF;
  v:=p#>>'{}';
  IF char_length(btrim(v,E' \n'))<1 OR char_length(v)>p_max OR btrim(v,E' \n')<>v
    OR (CASE WHEN p_multiline THEN replace(v,E'\n','') ELSE v END) ~ '[\x01-\x1F\x7F-\x9F]'
    OR position(chr(8232) IN v)>0 OR position(chr(8233) IN v)>0
    OR v ~ '(hc_[A-Za-z0-9_-]{43}|hzn_[A-Za-z0-9_-]{20,}|sb_secret_[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)'
    THEN RAISE EXCEPTION 'hermes_task_invalid' USING ERRCODE='22023'; END IF;
  RETURN v;
END $fn$;

CREATE OR REPLACE FUNCTION app_private.hermes_task_follow_label_v1(p text,p_max integer)
RETURNS text LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
  SELECT NULLIF(left(btrim(regexp_replace(translate(COALESCE(p,''),chr(8232)||chr(8233),'  '),'[[:cntrl:]]',' ','g')),p_max),'')
$fn$;

CREATE OR REPLACE FUNCTION app_private.hermes_task_follow_iso_v1(p timestamptz)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
  SELECT CASE WHEN p IS NULL THEN NULL ELSE to_char(p AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END
$fn$;

CREATE OR REPLACE FUNCTION app_private.hermes_task_follow_member_v1(p_org uuid,p_user uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
  SELECT p_org IS NOT NULL AND p_user IS NOT NULL AND EXISTS(SELECT 1 FROM public.organization_memberships m
    WHERE m.user_id=p_user AND m.organization_id=p_org AND m.status='ACTIVE' AND m.revoked_at IS NULL
      AND (m.valid_from IS NULL OR m.valid_from<=clock_timestamp()) AND (m.valid_to IS NULL OR m.valid_to>clock_timestamp()))
$fn$;

CREATE OR REPLACE FUNCTION app_private.hermes_task_follow_name_v1(p_user uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
  SELECT app_private.hermes_task_follow_label_v1((SELECT p.full_name FROM public.profiles p WHERE p.id=p_user),120)
$fn$;

CREATE OR REPLACE FUNCTION app_private.hermes_task_follow_json_v1(f app_private.hermes_task_follows)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app_private AS $fn$
  SELECT jsonb_build_object('id',f.id,'version',f.version,'state',lower(f.state),'closeReason',f.close_reason,
    'jobId',f.job_id,'jobCode',f.job_code,'assignerUserId',f.assigner_user_id,'executorUserId',f.executor_user_id,
    'mode',f.mode,'depth',f.depth,'parentFollowId',f.parent_follow_id,'objective',f.objective,
    'remindBeforeMinutes',f.remind_before_minutes,'notifyAssigner',f.notify_assigner,
    'createdAt',app_private.hermes_task_follow_iso_v1(f.created_at))
$fn$;

-- ---------------------------------------------------------------------------
-- Danh tính kết nối: cùng khoá token/session/org và ngữ cảnh CRM sống như tạo việc.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_private.hermes_task_follow_connection_v1(p_binding jsonb)
RETURNS app_private.hermes_connections LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE c app_private.hermes_connections; s app_private.hermes_sessions; policy app_private.hermes_org_policies;
  member jsonb; context jsonb; k text;
BEGIN
  PERFORM app_private.hermes_request_v1(p_binding,ARRAY['connectionId','tokenDigest','expectedEpoch','expectedPolicyVersion',
    'expectedMembershipId','expectedAuthorizationVersion','expectedSessionRevision']);
  IF auth.role() IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'hermes_task_denied' USING ERRCODE='42501'; END IF;
  PERFORM app_private.hermes_uuid_v1(p_binding->'connectionId');
  PERFORM app_private.hermes_uuid_v1(p_binding->'expectedMembershipId');
  FOREACH k IN ARRAY ARRAY['expectedEpoch','expectedAuthorizationVersion','expectedSessionRevision'] LOOP
    IF app_private.hermes_integer_v1(p_binding->k)<1 THEN RAISE EXCEPTION 'hermes_task_invalid' USING ERRCODE='22023'; END IF;
  END LOOP;
  IF (CASE WHEN p_binding->'expectedPolicyVersion'='0'::jsonb THEN 0 ELSE app_private.hermes_integer_v1(p_binding->'expectedPolicyVersion') END)<0
    OR jsonb_typeof(p_binding->'tokenDigest') IS DISTINCT FROM 'string' OR p_binding->>'tokenDigest' !~ '^[a-f0-9]{64}$'
    THEN RAISE EXCEPTION 'hermes_task_invalid' USING ERRCODE='22023'; END IF;
  c:=app_private.hermes_private_command_connection_v1(p_binding->>'tokenDigest');
  SELECT * INTO s FROM app_private.hermes_sessions WHERE id=c.credential_ref;
  IF c.user_id IS DISTINCT FROM auth.uid() OR s.provider_session_id::text IS DISTINCT FROM auth.jwt()->>'session_id'
    OR NOT app_private.hermes_session_gate_v1(s) THEN RAISE EXCEPTION 'hermes_task_denied' USING ERRCODE='42501'; END IF;
  member:=app_private.hermes_member_v1(c.user_id,c.organization_id);
  policy:=app_private.hermes_effective_org_policy_v1(c.organization_id,c.read_capabilities,c.action_capabilities,c.scope_ids);
  IF c.id::text IS DISTINCT FROM p_binding->>'connectionId' OR c.epoch::text IS DISTINCT FROM p_binding->>'expectedEpoch'
    OR s.revision::text IS DISTINCT FROM p_binding->>'expectedSessionRevision' OR policy.version::text IS DISTINCT FROM p_binding->>'expectedPolicyVersion'
    OR member->>'membershipId' IS DISTINCT FROM p_binding->>'expectedMembershipId'
    OR member->>'authorizationVersion' IS DISTINCT FROM p_binding->>'expectedAuthorizationVersion'
    THEN RAISE EXCEPTION 'hermes_task_context_changed' USING ERRCODE='PT409'; END IF;
  context:=public.get_authorization_context_v1(c.organization_id);
  IF context->>'membershipId' IS DISTINCT FROM member->>'membershipId' OR context->>'authorizationVersion' IS DISTINCT FROM member->>'authorizationVersion'
    OR context->>'organizationId' IS DISTINCT FROM c.organization_id::text OR context->'isOffboarded' IS DISTINCT FROM 'false'::jsonb
    THEN RAISE EXCEPTION 'hermes_task_context_changed' USING ERRCODE='PT409'; END IF;
  RETURN c;
END $fn$;

-- Registry ∩ trần công ty ∩ giới hạn kết nối ∩ quyền CRM hiện tại của chính actor.
CREATE OR REPLACE FUNCTION app_private.hermes_task_follow_capable_v1(c app_private.hermes_connections,p_capability text,p_mode text,p_crm text)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE policy app_private.hermes_org_policies;
BEGIN
  policy:=app_private.hermes_effective_org_policy_v1(c.organization_id,c.read_capabilities,c.action_capabilities,c.scope_ids);
  RETURN COALESCE(policy.enabled,false)
    AND EXISTS(SELECT 1 FROM app_private.hermes_capabilities h WHERE h.capability=p_capability AND h.mode=p_mode AND h.enabled)
    AND CASE p_mode WHEN 'read' THEN p_capability=ANY(c.read_capabilities) AND p_capability=ANY(policy.read_capabilities)
      WHEN 'action' THEN p_capability=ANY(c.action_capabilities) AND p_capability=ANY(policy.action_capabilities) ELSE false END
    AND COALESCE(public.get_authorization_context_v1(c.organization_id)->'permissions'->p_crm='true'::jsonb,false);
END $fn$;

-- Tòa nhà mà quyền CRM p_crm của actor ∩ phạm vi đã giao cho kết nối cùng cho phép.
CREATE OR REPLACE FUNCTION app_private.hermes_task_follow_buildings_v1(c app_private.hermes_connections,p_crm text)
RETURNS uuid[] LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE policy app_private.hermes_org_policies; v_scopes uuid[]; v_result uuid[];
BEGIN
  policy:=app_private.hermes_effective_org_policy_v1(c.organization_id,c.read_capabilities,c.action_capabilities,c.scope_ids);
  SELECT COALESCE(array_agg(id),'{}'::uuid[]) INTO v_scopes FROM (
    SELECT unnest(c.scope_ids) id INTERSECT SELECT unnest(policy.scope_ids) id) selected;
  SELECT COALESCE(array_agg(b.id ORDER BY b.id),'{}'::uuid[]) INTO v_result
    FROM public.buildings b CROSS JOIN app_private.authorized_scope_v3(p_crm,c.organization_id) scope
    WHERE b.organization_id=c.organization_id AND b.deleted_at IS NULL
      AND (COALESCE(scope.org_wide,false) OR b.id=ANY(COALESCE(scope.building_ids,'{}'::uuid[])))
      AND EXISTS(SELECT 1 FROM public.authorization_scopes overlay WHERE overlay.organization_id=c.organization_id AND overlay.id=ANY(v_scopes)
        AND (overlay.scope_type='ORGANIZATION' OR (overlay.scope_type='BUILDING' AND overlay.building_id=b.id)
          OR (overlay.scope_type='AREA' AND EXISTS(SELECT 1 FROM public.area_buildings ab JOIN public.areas a
            ON a.id=ab.area_id AND a.organization_id=ab.organization_id AND a.deleted_at IS NULL
            WHERE ab.organization_id=c.organization_id AND ab.area_id=overlay.area_id AND ab.building_id=b.id))));
  IF cardinality(v_result)>256 THEN RAISE EXCEPTION 'hermes_task_scope_too_large' USING ERRCODE='22023'; END IF;
  RETURN v_result;
END $fn$;

CREATE OR REPLACE FUNCTION app_private.hermes_task_follow_building_v1(c app_private.hermes_connections,p_crm text,p_building uuid)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE member jsonb; decision record;
BEGIN
  IF p_building IS NULL THEN RETURN false; END IF;
  member:=app_private.hermes_member_v1(c.user_id,c.organization_id);
  SELECT * INTO decision FROM app_private.authorize_tenant_action_v3(c.user_id,c.organization_id,p_crm,p_building,NULL);
  RETURN COALESCE(decision.allowed,false) AND decision.authorization_version::text IS NOT DISTINCT FROM member->>'authorizationVersion'
    AND (decision.nearest_deadline IS NULL OR decision.nearest_deadline>clock_timestamp())
    AND p_building=ANY(app_private.hermes_task_follow_buildings_v1(c,p_crm));
END $fn$;

-- Standing grant còn hiệu lực? NULL = còn; ngược lại là lý do đóng. Dùng ở mỗi lượt
-- nhắc và trước khi báo tiến độ (M09: kiểm quyền mới nhất khi báo kết quả).
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
  -- Rotation keeps the grant only while some active connection of the same
  -- assistant still carries the action and covers this building.
  IF NOT EXISTS(SELECT 1 FROM app_private.hermes_connections hc WHERE hc.assistant_id=f.assistant_id AND hc.organization_id=f.organization_id
      AND hc.user_id=f.assigner_user_id AND hc.state='ACTIVE' AND hc.revoked_at IS NULL AND 'tasks.create'=ANY(hc.action_capabilities)
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

-- ---------------------------------------------------------------------------
-- Một đường báo: chuông IN_APP (gộp vào thông báo chưa đọc cùng loại) + push gọi
-- ngay qua pg_net theo mẫu zalo_canh_gac_bao_v1. Thiếu JWT (TEST đã đánh dấu) thì
-- chỉ ghi chuông, push_state='SKIPPED' kèm lý do; không gửi lặp nhờ idempotencyKey.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_private.hermes_task_follow_notify_v1(p_org uuid,p_user uuid,p_kind text,
  p_items jsonb,p_detail text,p_job uuid)
RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,app_private,public AS $fn$
DECLARE v_in boolean; v_push boolean; v_gate_error text; v_existing record; v_items jsonb; v_id uuid;
  v_subject text; v_lines text; v_count integer; v_content text; v_url text; v_jwt text; v_push_error text; v_key text;
BEGIN
  IF p_kind NOT IN ('due','overdue','overdue_report','done','deleted','progress','cancelled')
    OR jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR NOT app_private.hermes_task_follow_member_v1(p_org,p_user) THEN RETURN NULL; END IF;
  BEGIN
    SELECT g.g_in_app,g.g_push INTO v_in,v_push FROM app_private.notify_gate_v1(p_user,p_org,'E4',NULL) g;
  EXCEPTION WHEN OTHERS THEN v_in:=true; v_push:=true; v_gate_error:=left(SQLSTATE||': '||SQLERRM,200);
  END;
  IF NOT COALESCE(v_in,true) THEN RETURN NULL; END IF;
  SELECT n.id,n.metadata INTO v_existing FROM public.notifications n
    WHERE n.user_id=p_user AND n.organization_id=p_org AND n.status='PENDING' AND n.metadata->>'event'='HERMES_TASK'
      AND n.metadata->>'kind'=p_kind AND n.job_id IS NOT DISTINCT FROM p_job AND n.created_at>clock_timestamp()-interval '24 hours'
    ORDER BY n.created_at DESC LIMIT 1 FOR UPDATE;
  SELECT COALESCE(jsonb_agg(item ORDER BY ordinality),'[]') INTO v_items FROM (
    SELECT DISTINCT ON (item->>'jobId') item,ordinality FROM jsonb_array_elements(
      COALESCE(v_existing.metadata->'jobs','[]'::jsonb)||p_items) WITH ORDINALITY AS e(item,ordinality)
    ORDER BY item->>'jobId',ordinality DESC) merged;
  SELECT COALESCE(jsonb_agg(item ORDER BY ordinality),'[]') INTO v_items FROM jsonb_array_elements(v_items) WITH ORDINALITY AS e(item,ordinality) WHERE ordinality<=20;
  v_count:=jsonb_array_length(v_items);
  IF v_count=0 THEN RETURN NULL; END IF;
  SELECT string_agg(COALESCE(item->>'code','')||' '||COALESCE(item->>'title','')||
      CASE WHEN item->>'deadline' IS NULL THEN '' ELSE ' (hạn '||to_char((item->>'deadline')::timestamptz AT TIME ZONE 'Asia/Ho_Chi_Minh','HH24:MI DD/MM')||')' END,'; ')
    INTO v_lines FROM (SELECT item FROM jsonb_array_elements(v_items) WITH ORDINALITY AS e(item,ordinality) ORDER BY ordinality LIMIT 3) shown;
  v_subject:=CASE p_kind WHEN 'due' THEN 'Việc sắp tới hạn' WHEN 'overdue' THEN 'Việc của bạn đã quá hạn'
    WHEN 'overdue_report' THEN 'Việc bạn giao đã quá hạn' WHEN 'done' THEN 'Việc bạn giao đã hoàn thành'
    WHEN 'deleted' THEN 'Việc bạn theo dõi không còn trong CRM' WHEN 'progress' THEN 'Cập nhật tiến độ việc bạn giao'
    ELSE 'Việc đã được huỷ' END;
  v_content:=left(COALESCE(v_lines,'')||CASE WHEN v_count>3 THEN ' và '||(v_count-3)::text||' việc khác' ELSE '' END||
    CASE WHEN p_detail IS NULL THEN '' ELSE ' — '||p_detail END,1000);
  IF char_length(v_content)=0 THEN v_content:=v_subject; END IF;
  v_url:=CASE WHEN p_job IS NOT NULL THEN '/tasks?job='||p_job::text ELSE '/tasks' END;
  IF v_existing.id IS NOT NULL THEN
    UPDATE public.notifications SET subject=v_subject,content=v_content,
      metadata=metadata||jsonb_build_object('jobs',v_items,'count',v_count,'updatedAt',app_private.hermes_task_follow_iso_v1(clock_timestamp()))
      WHERE id=v_existing.id RETURNING id INTO v_id;
  ELSE
    INSERT INTO public.notifications(organization_id,user_id,type,channel,status,subject,content,job_id,metadata)
      VALUES(p_org,p_user,'ACTION_REQUIRED','IN_APP','PENDING',v_subject,v_content,p_job,
        jsonb_build_object('event','HERMES_TASK','kind',p_kind,'url',v_url,'jobs',v_items,'count',v_count))
      RETURNING id INTO v_id;
  END IF;
  IF v_gate_error IS NOT NULL THEN
    UPDATE public.notifications SET metadata=metadata||jsonb_build_object('gateError',v_gate_error) WHERE id=v_id;
  END IF;
  IF NOT COALESCE(v_push,true) THEN
    UPDATE public.notifications SET push_state='SKIPPED' WHERE id=v_id;
    RETURN v_id;
  END IF;
  BEGIN v_jwt:=app_private.lifecycle_reminder_service_jwt_v1();
  EXCEPTION WHEN OTHERS THEN v_jwt:=NULL; v_push_error:=left(SQLSTATE||': '||SQLERRM,200);
  END;
  IF v_jwt IS NULL THEN
    UPDATE public.notifications SET push_state='SKIPPED',
      metadata=metadata||jsonb_build_object('pushError',COALESCE(v_push_error,'service_jwt_unavailable')) WHERE id=v_id;
    RETURN v_id;
  END IF;
  SELECT md5(p_kind||':'||string_agg(item->>'jobId',',' ORDER BY item->>'jobId')||':'||COALESCE(p_detail,'')) INTO v_key
    FROM jsonb_array_elements(v_items) AS e(item);
  BEGIN
    PERFORM net.http_post(
      url := 'https://tryymsxyyckgbrmmvozx.supabase.co/functions/v1/send-push',
      body := jsonb_build_object('userId',p_user,'title',v_subject,'body',v_content,'url',v_url,'tag','hermes-task-'||p_kind,
        'idempotencyKey',left('hermes-task:'||v_key||':'||p_user::text,128)),
      headers := jsonb_build_object('Authorization','Bearer '||v_jwt,'Content-Type','application/json'),
      timeout_milliseconds := 30000);
  EXCEPTION WHEN OTHERS THEN
    UPDATE public.notifications SET push_state='FAILED',
      metadata=metadata||jsonb_build_object('pushError',left(SQLSTATE||': '||SQLERRM,200)) WHERE id=v_id;
  END;
  RETURN v_id;
END $fn$;

-- ---------------------------------------------------------------------------
-- Đọc: việc giao cho tôi / tôi giao / cả nhóm trong phạm vi tasks.view thật.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.hermes_task_follow_read_v1(p_binding jsonb,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE c app_private.hermes_connections; v_role text; v_status text; v_assignee uuid; v_limit integer; v_offset integer;
  v_buildings uuid[]; v_now timestamptz; v_rows jsonb; v_next integer;
BEGIN
  PERFORM app_private.hermes_request_v1(p_input,ARRAY['organizationId','role','assigneeUserId','status','limit','offset']);
  PERFORM app_private.hermes_uuid_v1(p_input->'organizationId');
  v_role:=p_input->>'role'; v_status:=p_input->>'status';
  IF jsonb_typeof(p_input->'role') IS DISTINCT FROM 'string' OR v_role NOT IN ('assigned_to_me','assigned_by_me','team')
    OR jsonb_typeof(p_input->'status') IS DISTINCT FROM 'string' OR v_status NOT IN ('open','completed','all')
    THEN RAISE EXCEPTION 'hermes_task_invalid' USING ERRCODE='22023'; END IF;
  IF p_input->'assigneeUserId'<>'null'::jsonb THEN
    IF v_role<>'team' THEN RAISE EXCEPTION 'hermes_task_invalid' USING ERRCODE='22023'; END IF;
    v_assignee:=app_private.hermes_uuid_v1(p_input->'assigneeUserId');
  END IF;
  v_limit:=app_private.hermes_task_follow_int_v1(p_input->'limit',1,50);
  v_offset:=app_private.hermes_task_follow_int_v1(p_input->'offset',0,200);
  c:=app_private.hermes_task_follow_connection_v1(p_binding);
  IF p_input->>'organizationId' IS DISTINCT FROM c.organization_id::text
    OR NOT app_private.hermes_task_follow_capable_v1(c,'tasks.view','read','tasks.view')
    THEN RAISE EXCEPTION 'hermes_task_denied' USING ERRCODE='42501'; END IF;
  v_buildings:=app_private.hermes_task_follow_buildings_v1(c,'tasks.view');
  v_now:=clock_timestamp();
  SELECT COALESCE(jsonb_agg(item ORDER BY ord),'[]') INTO v_rows FROM (
    SELECT row_number() OVER (ORDER BY (j.deadline IS NULL),j.deadline,j.id) ord,jsonb_build_object(
      'id',j.id,'code',COALESCE(app_private.hermes_task_follow_label_v1(j.code,64),'—'),
      'title',COALESCE(app_private.hermes_task_follow_label_v1(j.title,200),'(không tiêu đề)'),
      'status',j.status,'buildingId',j.building_id,'roomId',j.room_id,'deadline',app_private.hermes_task_follow_iso_v1(j.deadline),
      'overdue',(j.status='IN_PROGRESS' AND j.deadline IS NOT NULL AND j.deadline<=v_now),
      'assigneeId',j.assignee_id,'assigneeName',app_private.hermes_task_follow_name_v1(j.assignee_id),'createdBy',j.user_id,
      'progressNote',CASE WHEN j.completion_description IS NULL THEN NULL ELSE left(j.completion_description,1000) END,
      'progressDigest',md5(COALESCE(j.completion_description,'')),
      'follows',COALESCE((SELECT jsonb_agg(x.follow ORDER BY x.created_at,x.id) FROM (
        SELECT app_private.hermes_task_follow_json_v1(f) follow,f.created_at,f.id FROM app_private.hermes_task_follows f
          WHERE f.job_id=j.id AND f.organization_id=c.organization_id AND f.state='ACTIVE'
          AND (f.assigner_user_id=c.user_id OR f.executor_user_id=c.user_id) ORDER BY f.created_at,f.id LIMIT 5) x),'[]'::jsonb)) item
    FROM public.jobs j
    WHERE j.organization_id=c.organization_id AND j.building_id=ANY(v_buildings)
      AND (v_status='all' OR (v_status='open' AND j.status='IN_PROGRESS') OR (v_status='completed' AND j.status='COMPLETED'))
      AND CASE v_role WHEN 'assigned_to_me' THEN j.assignee_id=c.user_id
        WHEN 'assigned_by_me' THEN j.user_id=c.user_id OR EXISTS(SELECT 1 FROM app_private.hermes_task_follows f
          WHERE f.job_id=j.id AND f.organization_id=c.organization_id AND f.assigner_user_id=c.user_id AND f.state='ACTIVE')
        ELSE v_assignee IS NULL OR j.assignee_id=v_assignee END
    ORDER BY (j.deadline IS NULL),j.deadline,j.id LIMIT v_limit+1 OFFSET v_offset) found;
  IF jsonb_array_length(v_rows)>v_limit THEN
    SELECT jsonb_agg(value ORDER BY ordinality) INTO v_rows FROM jsonb_array_elements(v_rows) WITH ORDINALITY WHERE ordinality<=v_limit;
    v_next:=CASE WHEN v_offset+v_limit<=200 THEN v_offset+v_limit ELSE NULL END;
  END IF;
  IF octet_length(v_rows::text)>60000 THEN RAISE EXCEPTION 'hermes_task_response_too_large' USING ERRCODE='22023'; END IF;
  -- Final lifetime check: a slow read cannot outlive the credential.
  PERFORM app_private.hermes_private_command_connection_v1(p_binding->>'tokenDigest');
  RETURN jsonb_build_object('organizationId',c.organization_id,'role',v_role,'status',v_status,
    'readAt',app_private.hermes_task_follow_iso_v1(v_now),'items',v_rows,'offset',v_offset,'nextOffset',v_next);
END $fn$;

-- ---------------------------------------------------------------------------
-- Ghi: guard (definer) → apply (invoker, RLS/trigger CRM) → finish (definer).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_private.hermes_task_follow_guard_v1(p_binding jsonb,p_operation text,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE c app_private.hermes_connections; receipt app_private.hermes_task_follow_receipts; j public.jobs;
  f app_private.hermes_task_follows; parent app_private.hermes_task_follows;
  v_request uuid; v_job uuid; v_follow uuid; v_parent uuid; v_text text; v_remind integer; v_notify boolean;
  v_depth integer:=0; v_capability text; v_count integer; v_mode text; v_plan jsonb; v_result jsonb; v_now timestamptz:=clock_timestamp();
BEGIN
  IF p_operation='set' THEN
    PERFORM app_private.hermes_request_v1(p_input,ARRAY['organizationId','requestId','jobId','objective','remindBeforeMinutes','notifyAssigner','parentFollowId']);
    v_capability:='tasks.create';
  ELSIF p_operation='stop' THEN
    PERFORM app_private.hermes_request_v1(p_input,ARRAY['organizationId','requestId','followId','expectedVersion']);
    v_capability:='tasks.create';
  ELSIF p_operation='progress' THEN
    PERFORM app_private.hermes_request_v1(p_input,ARRAY['organizationId','requestId','jobId','note','expectedNoteDigest']);
    v_capability:='tasks.edit';
  ELSIF p_operation='cancel' THEN
    PERFORM app_private.hermes_request_v1(p_input,ARRAY['organizationId','requestId','jobId','reason']);
    v_capability:='tasks.delete';
  ELSE RAISE EXCEPTION 'hermes_task_invalid' USING ERRCODE='22023'; END IF;
  PERFORM app_private.hermes_uuid_v1(p_input->'organizationId');
  v_request:=app_private.hermes_uuid_v1(p_input->'requestId');
  c:=app_private.hermes_task_follow_connection_v1(p_binding);
  IF p_input->>'organizationId' IS DISTINCT FROM c.organization_id::text
    OR NOT app_private.hermes_task_follow_capable_v1(c,v_capability,'action',v_capability)
    -- A standing follow reports job status: it also needs the task Read grant.
    OR (p_operation IN ('set','stop') AND NOT app_private.hermes_task_follow_capable_v1(c,'tasks.view','read','tasks.view'))
    THEN RAISE EXCEPTION 'hermes_task_denied' USING ERRCODE='42501'; END IF;
  SELECT * INTO receipt FROM app_private.hermes_task_follow_receipts r
    WHERE r.organization_id=c.organization_id AND r.user_id=c.user_id AND r.request_id=v_request FOR UPDATE;
  IF FOUND THEN
    IF receipt.connection_id IS DISTINCT FROM c.id OR receipt.operation IS DISTINCT FROM p_operation OR receipt.input IS DISTINCT FROM p_input
      THEN RAISE EXCEPTION 'hermes_task_intent_changed' USING ERRCODE='PT409'; END IF;
    IF receipt.result IS NULL THEN RAISE EXCEPTION 'hermes_task_outcome_unknown' USING ERRCODE='PT409'; END IF;
    RETURN jsonb_build_object('final',true,'result',receipt.result);
  END IF;

  IF p_operation='set' THEN
    v_job:=app_private.hermes_uuid_v1(p_input->'jobId');
    v_text:=app_private.hermes_task_follow_text_v1(p_input->'objective',500,false);
    IF p_input->'remindBeforeMinutes'<>'null'::jsonb THEN
      v_remind:=app_private.hermes_task_follow_int_v1(p_input->'remindBeforeMinutes',0,10080); END IF;
    IF jsonb_typeof(p_input->'notifyAssigner') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'hermes_task_invalid' USING ERRCODE='22023'; END IF;
    v_notify:=(p_input->>'notifyAssigner')::boolean;
    IF p_input->'parentFollowId'<>'null'::jsonb THEN v_parent:=app_private.hermes_uuid_v1(p_input->'parentFollowId'); END IF;
    SELECT * INTO j FROM public.jobs WHERE id=v_job AND organization_id=c.organization_id FOR SHARE;
    IF NOT FOUND OR NOT app_private.hermes_task_follow_building_v1(c,'tasks.create',j.building_id)
      OR NOT app_private.hermes_task_follow_building_v1(c,'tasks.view',j.building_id)
      THEN RAISE EXCEPTION 'hermes_task_denied' USING ERRCODE='42501'; END IF;
    IF j.status<>'IN_PROGRESS' OR j.assignee_id IS NULL OR (v_remind IS NOT NULL AND j.deadline IS NULL)
      THEN RAISE EXCEPTION 'hermes_task_follow_not_trackable' USING ERRCODE='22023'; END IF;
    IF NOT app_private.hermes_task_follow_member_v1(c.organization_id,j.assignee_id)
      THEN RAISE EXCEPTION 'hermes_task_denied' USING ERRCODE='42501'; END IF;
    IF v_parent IS NOT NULL THEN
      SELECT * INTO parent FROM app_private.hermes_task_follows WHERE id=v_parent AND organization_id=c.organization_id FOR SHARE;
      IF NOT FOUND OR parent.state<>'ACTIVE' OR parent.executor_user_id IS DISTINCT FROM c.user_id
        THEN RAISE EXCEPTION 'hermes_task_follow_parent_invalid' USING ERRCODE='22023'; END IF;
      v_depth:=parent.depth+1;
      IF v_depth>3 THEN RAISE EXCEPTION 'hermes_task_follow_loop' USING ERRCODE='22023'; END IF;
    END IF;
    -- Không giao ngược lên chuỗi đang giao việc cho chính actor (A→B, B→A...).
    IF j.assignee_id<>c.user_id AND j.assignee_id IN (
      WITH RECURSIVE upstream AS (
        SELECT u.id,u.parent_follow_id,u.assigner_user_id FROM app_private.hermes_task_follows u
          WHERE u.organization_id=c.organization_id AND ((u.state='ACTIVE' AND u.executor_user_id=c.user_id) OR u.id=v_parent)
        UNION
        SELECT p.id,p.parent_follow_id,p.assigner_user_id FROM app_private.hermes_task_follows p
          JOIN upstream ON p.id=upstream.parent_follow_id WHERE p.organization_id=c.organization_id)
      SELECT upstream.assigner_user_id FROM upstream)
      THEN RAISE EXCEPTION 'hermes_task_follow_loop' USING ERRCODE='22023'; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('hermes_task_follow:'||c.organization_id::text||':'||c.user_id::text,0));
    SELECT count(*) INTO v_count FROM app_private.hermes_task_follows
      WHERE organization_id=c.organization_id AND assigner_user_id=c.user_id AND created_at>v_now-interval '1 hour';
    IF v_count>=30 THEN RAISE EXCEPTION 'hermes_task_quota_exceeded' USING ERRCODE='22023'; END IF;
    SELECT count(*) INTO v_count FROM app_private.hermes_task_follows
      WHERE organization_id=c.organization_id AND assigner_user_id=c.user_id AND state='ACTIVE';
    IF v_count>=200 THEN RAISE EXCEPTION 'hermes_task_quota_exceeded' USING ERRCODE='22023'; END IF;
    IF EXISTS(SELECT 1 FROM app_private.hermes_task_follows WHERE job_id=j.id AND assigner_user_id=c.user_id AND state='ACTIVE')
      THEN RAISE EXCEPTION 'hermes_task_follow_exists' USING ERRCODE='PT409'; END IF;
    v_mode:=CASE WHEN j.user_id=c.user_id THEN 'self' ELSE 'supervisor' END;
    INSERT INTO app_private.hermes_task_follows(organization_id,job_id,job_code,job_title,building_id,assigner_user_id,assistant_id,
      connection_id,executor_user_id,mode,parent_follow_id,depth,objective,remind_before_minutes,notify_assigner,created_at,updated_at)
    VALUES(c.organization_id,j.id,COALESCE(app_private.hermes_task_follow_label_v1(j.code,64),'—'),
      COALESCE(app_private.hermes_task_follow_label_v1(j.title,200),'(không tiêu đề)'),j.building_id,c.user_id,c.assistant_id,
      c.id,j.assignee_id,v_mode,v_parent,v_depth,v_text,v_remind,v_notify,v_now,v_now) RETURNING * INTO f;
    v_result:=jsonb_build_object('organizationId',c.organization_id,'requestId',v_request,'outcome','applied',
      'follow',app_private.hermes_task_follow_json_v1(f)||jsonb_build_object('deadline',app_private.hermes_task_follow_iso_v1(j.deadline)));
    INSERT INTO app_private.hermes_task_follow_receipts(organization_id,user_id,request_id,connection_id,operation,input,result)
      VALUES(c.organization_id,c.user_id,v_request,c.id,p_operation,p_input,v_result);
    PERFORM app_private.append_authz_audit_v1(c.organization_id,'HERMES_TASK_FOLLOW_SET','hermes_task_follow',f.id,NULL,
      jsonb_build_object('actor',c.user_id,'executor',j.assignee_id,'jobId',j.id,'connectionId',c.id,'assistantId',c.assistant_id,
        'requestId',v_request,'mode',v_mode,'parentFollowId',v_parent,'depth',v_depth,'remindBeforeMinutes',v_remind,'notifyAssigner',v_notify),
      'Hermes standing follow');
    RETURN jsonb_build_object('final',true,'result',v_result);
  END IF;

  IF p_operation='stop' THEN
    v_follow:=app_private.hermes_uuid_v1(p_input->'followId');
    PERFORM app_private.hermes_integer_v1(p_input->'expectedVersion');
    SELECT * INTO f FROM app_private.hermes_task_follows WHERE id=v_follow AND organization_id=c.organization_id FOR UPDATE;
    IF NOT FOUND OR f.assigner_user_id<>c.user_id THEN RAISE EXCEPTION 'hermes_task_denied' USING ERRCODE='42501'; END IF;
    IF f.state<>'ACTIVE' OR f.version::text IS DISTINCT FROM p_input->>'expectedVersion'
      THEN RAISE EXCEPTION 'hermes_task_context_changed' USING ERRCODE='PT409'; END IF;
    UPDATE app_private.hermes_task_follows SET state='CANCELLED',close_reason='stopped',closed_at=v_now,closed_by=c.user_id,
      version=version+1,updated_at=v_now WHERE id=f.id RETURNING * INTO f;
    v_result:=jsonb_build_object('organizationId',c.organization_id,'requestId',v_request,'outcome','applied',
      'follow',app_private.hermes_task_follow_json_v1(f));
    INSERT INTO app_private.hermes_task_follow_receipts(organization_id,user_id,request_id,connection_id,operation,input,result)
      VALUES(c.organization_id,c.user_id,v_request,c.id,p_operation,p_input,v_result);
    PERFORM app_private.append_authz_audit_v1(c.organization_id,'HERMES_TASK_FOLLOW_STOPPED','hermes_task_follow',f.id,NULL,
      jsonb_build_object('actor',c.user_id,'executor',f.executor_user_id,'jobId',f.job_id,'connectionId',c.id,'requestId',v_request,'channel','external_mcp'),
      'Hermes standing follow stopped');
    RETURN jsonb_build_object('final',true,'result',v_result);
  END IF;

  v_job:=app_private.hermes_uuid_v1(p_input->'jobId');
  IF p_operation='progress' THEN
    v_text:=app_private.hermes_task_follow_text_v1(p_input->'note',1000,true);
    IF jsonb_typeof(p_input->'expectedNoteDigest') IS DISTINCT FROM 'string' OR p_input->>'expectedNoteDigest' !~ '^[a-f0-9]{32}$'
      THEN RAISE EXCEPTION 'hermes_task_invalid' USING ERRCODE='22023'; END IF;
  ELSE
    v_text:=app_private.hermes_task_follow_text_v1(p_input->'reason',300,false);
  END IF;
  -- FOR UPDATE: the invoker step may DELETE this row; never upgrade the lock later.
  SELECT * INTO j FROM public.jobs WHERE id=v_job AND organization_id=c.organization_id FOR UPDATE;
  IF NOT FOUND OR NOT app_private.hermes_task_follow_building_v1(c,v_capability,j.building_id)
    -- Progress is reported by the two parties of the job; not on behalf of others.
    OR (p_operation='progress' AND c.user_id IS DISTINCT FROM j.assignee_id AND c.user_id IS DISTINCT FROM j.user_id)
    THEN RAISE EXCEPTION 'hermes_task_denied' USING ERRCODE='42501'; END IF;
  IF j.status<>'IN_PROGRESS' THEN RAISE EXCEPTION 'hermes_task_context_changed' USING ERRCODE='PT409'; END IF;
  IF p_operation='progress' AND md5(COALESCE(j.completion_description,''))<>p_input->>'expectedNoteDigest'
    THEN RAISE EXCEPTION 'hermes_task_context_changed' USING ERRCODE='PT409'; END IF;
  -- Never cascade inventory: a job with recorded material use is cancelled in CRM.
  IF p_operation='cancel' AND (EXISTS(SELECT 1 FROM public.material_usages mu WHERE mu.job_id=j.id) OR j.completion_attachments IS NOT NULL)
    THEN RAISE EXCEPTION 'hermes_task_cancel_blocked' USING ERRCODE='22023'; END IF;
  v_plan:=jsonb_build_object('operation',p_operation,'organizationId',c.organization_id,'actorId',c.user_id,'connectionId',c.id,
    'requestId',v_request,'jobId',j.id,'text',v_text,'code',COALESCE(app_private.hermes_task_follow_label_v1(j.code,64),'—'),
    'title',COALESCE(app_private.hermes_task_follow_label_v1(j.title,200),'(không tiêu đề)'),'assigneeId',j.assignee_id,
    'creatorId',j.user_id,'buildingId',j.building_id);
  INSERT INTO app_private.hermes_task_follow_receipts(organization_id,user_id,request_id,connection_id,operation,input,plan)
    VALUES(c.organization_id,c.user_id,v_request,c.id,p_operation,p_input,v_plan);
  RETURN jsonb_build_object('final',false,'plan',v_plan);
END $fn$;

-- Only the invoker touches canonical jobs: CRM RLS (tasks.edit/tasks.delete),
-- triggers and cascades apply exactly as in the CRM UI.
CREATE OR REPLACE FUNCTION app_private.hermes_task_follow_apply_v1(p_step jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,public AS $fn$
DECLARE v_plan jsonb:=p_step->'plan'; v_id uuid;
BEGIN
  IF auth.role() IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'hermes_task_denied' USING ERRCODE='42501'; END IF;
  IF p_step->'final'='true'::jsonb THEN RETURN p_step; END IF;
  IF v_plan->>'actorId' IS DISTINCT FROM auth.uid()::text THEN RAISE EXCEPTION 'hermes_task_denied' USING ERRCODE='42501'; END IF;
  IF v_plan->>'operation'='progress' THEN
    UPDATE public.jobs SET completion_description=v_plan->>'text'
      WHERE id=(v_plan->>'jobId')::uuid AND status='IN_PROGRESS' RETURNING id INTO v_id;
  ELSIF v_plan->>'operation'='cancel' THEN
    DELETE FROM public.jobs WHERE id=(v_plan->>'jobId')::uuid AND status='IN_PROGRESS' RETURNING id INTO v_id;
  ELSE RAISE EXCEPTION 'hermes_task_invalid' USING ERRCODE='22023'; END IF;
  IF v_id IS NULL THEN RAISE EXCEPTION 'hermes_task_denied' USING ERRCODE='42501'; END IF;
  RETURN p_step;
END $fn$;

CREATE OR REPLACE FUNCTION app_private.hermes_task_follow_finish_v1(p_binding jsonb,p_operation text,p_input jsonb,p_step jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE c app_private.hermes_connections; receipt app_private.hermes_task_follow_receipts; v_plan jsonb:=p_step->'plan';
  j public.jobs; f app_private.hermes_task_follows; v_result jsonb; v_now timestamptz:=clock_timestamp(); v_actor text;
  v_notified integer:=0; v_closed integer:=0; v_id uuid; v_item jsonb; v_job uuid;
BEGIN
  IF p_step->'final'='true'::jsonb THEN RETURN p_step->'result'; END IF;
  c:=app_private.hermes_task_follow_connection_v1(p_binding);
  SELECT * INTO receipt FROM app_private.hermes_task_follow_receipts r WHERE r.organization_id=c.organization_id AND r.user_id=c.user_id
    AND r.request_id=(v_plan->>'requestId')::uuid FOR UPDATE;
  IF NOT FOUND OR receipt.result IS NOT NULL OR receipt.transaction_id IS DISTINCT FROM txid_current() OR receipt.plan IS DISTINCT FROM v_plan
    OR receipt.operation IS DISTINCT FROM p_operation OR receipt.input IS DISTINCT FROM p_input OR receipt.connection_id IS DISTINCT FROM c.id
    THEN RAISE EXCEPTION 'hermes_task_receipt_invalid' USING ERRCODE='PT409'; END IF;
  v_job:=(v_plan->>'jobId')::uuid;
  v_actor:=COALESCE(app_private.hermes_task_follow_name_v1(c.user_id),'Người dùng CRM');
  v_item:=jsonb_build_object('jobId',v_job,'code',v_plan->>'code','title',v_plan->>'title');
  IF p_operation='progress' THEN
    SELECT * INTO j FROM public.jobs WHERE id=v_job;
    IF NOT FOUND OR j.status<>'IN_PROGRESS' OR j.completion_description IS DISTINCT FROM v_plan->>'text'
      THEN RAISE EXCEPTION 'hermes_task_receipt_invalid' USING ERRCODE='PT409'; END IF;
    FOR f IN SELECT * FROM app_private.hermes_task_follows WHERE job_id=v_job AND organization_id=c.organization_id AND state='ACTIVE'
        AND notify_assigner AND assigner_user_id<>c.user_id ORDER BY id FOR UPDATE LOOP
      IF app_private.hermes_task_follow_grant_v1(f) IS NOT NULL THEN CONTINUE; END IF;
      v_id:=app_private.hermes_task_follow_notify_v1(f.organization_id,f.assigner_user_id,'progress',jsonb_build_array(v_item),
        v_actor||': '||left(v_plan->>'text',300),v_job);
      IF v_id IS NOT NULL THEN
        UPDATE app_private.hermes_task_follows SET progress_notification_id=v_id,updated_at=v_now WHERE id=f.id;
        v_notified:=v_notified+1;
      END IF;
    END LOOP;
    v_result:=jsonb_build_object('organizationId',c.organization_id,'requestId',receipt.request_id,'outcome','applied',
      'job',jsonb_build_object('id',j.id,'code',v_plan->>'code','status',j.status,'progressDigest',md5(COALESCE(j.completion_description,''))),
      'notified',v_notified);
    PERFORM app_private.append_authz_audit_v1(c.organization_id,'HERMES_TASK_PROGRESS','job',v_job,NULL,
      jsonb_build_object('actor',c.user_id,'executor',j.assignee_id,'jobId',v_job,'connectionId',c.id,'requestId',receipt.request_id,'notified',v_notified),
      'Hermes task progress note');
  ELSIF p_operation='cancel' THEN
    IF EXISTS(SELECT 1 FROM public.jobs WHERE id=v_job) THEN RAISE EXCEPTION 'hermes_task_receipt_invalid' USING ERRCODE='PT409'; END IF;
    FOR f IN UPDATE app_private.hermes_task_follows SET state='CANCELLED',close_reason='job_cancelled',closed_at=v_now,closed_by=c.user_id,
        version=version+1,updated_at=v_now WHERE job_id=v_job AND organization_id=c.organization_id AND state='ACTIVE' RETURNING * LOOP
      v_closed:=v_closed+1;
      IF f.notify_assigner AND f.assigner_user_id<>c.user_id AND app_private.hermes_task_follow_member_v1(f.organization_id,f.assigner_user_id) THEN
        IF app_private.hermes_task_follow_notify_v1(f.organization_id,f.assigner_user_id,'cancelled',jsonb_build_array(v_item),
          'do '||v_actor||' huỷ. Lý do: '||(v_plan->>'text'),NULL) IS NOT NULL THEN v_notified:=v_notified+1; END IF;
      END IF;
    END LOOP;
    IF (v_plan->>'assigneeId') IS NOT NULL AND v_plan->>'assigneeId'<>c.user_id::text THEN
      IF app_private.hermes_task_follow_notify_v1(c.organization_id,(v_plan->>'assigneeId')::uuid,'cancelled',jsonb_build_array(v_item),
        'do '||v_actor||' huỷ. Lý do: '||(v_plan->>'text'),NULL) IS NOT NULL THEN v_notified:=v_notified+1; END IF;
    END IF;
    v_result:=jsonb_build_object('organizationId',c.organization_id,'requestId',receipt.request_id,'outcome','applied',
      'job',jsonb_build_object('id',v_job,'code',v_plan->>'code','title',v_plan->>'title','status','DELETED','assigneeId',v_plan->'assigneeId'),
      'closedFollows',v_closed,'notified',v_notified);
    PERFORM app_private.append_authz_audit_v1(c.organization_id,'HERMES_TASK_CANCELLED','job',v_job,
      jsonb_build_object('code',v_plan->>'code','title',v_plan->>'title','assigneeId',v_plan->'assigneeId','creatorId',v_plan->'creatorId','buildingId',v_plan->'buildingId'),
      jsonb_build_object('actor',c.user_id,'executor',v_plan->'assigneeId','jobId',v_job,'connectionId',c.id,'requestId',receipt.request_id,
        'closedFollows',v_closed,'notified',v_notified),left('Hermes task cancel: '||(v_plan->>'text'),400));
  ELSE RAISE EXCEPTION 'hermes_task_invalid' USING ERRCODE='22023'; END IF;
  UPDATE app_private.hermes_task_follow_receipts SET result=v_result
    WHERE organization_id=c.organization_id AND user_id=c.user_id AND request_id=receipt.request_id;
  RETURN v_result;
END $fn$;

-- SQL-standard body binds private helper OIDs at definition time; this invoker
-- needs no USAGE on app_private. Never change to definer.
CREATE OR REPLACE FUNCTION public.hermes_task_follow_action_v1(p_binding jsonb,p_operation text,p_input jsonb)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,public
BEGIN ATOMIC
 SELECT app_private.hermes_task_follow_finish_v1(p_binding,p_operation,p_input,
  app_private.hermes_task_follow_apply_v1(app_private.hermes_task_follow_guard_v1(p_binding,p_operation,p_input)));
END;

-- ---------------------------------------------------------------------------
-- Năng lực hiện có của chính user (broker auth adapter + options hook).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.hermes_task_follow_capabilities_v1(p_organization_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE member jsonb; context jsonb; policy app_private.hermes_org_policies; result jsonb:='{}'; r record;
  v_enabled boolean; v_allowed boolean; v_buildings uuid[];
BEGIN
  IF auth.role() IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL OR p_organization_id IS NULL
    THEN RAISE EXCEPTION 'hermes_task_denied' USING ERRCODE='42501'; END IF;
  PERFORM app_private.lock_org_for_decision_v1(p_organization_id);
  member:=app_private.hermes_member_v1(auth.uid(),p_organization_id);
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

-- ---------------------------------------------------------------------------
-- Web CRM (JWT người dùng, không cần kết nối): xem và dừng theo dõi của chính mình.
-- Dừng luôn khả dụng để thu hồi standing grant kể cả khi Hermes đã mất quyền.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.hermes_my_task_follows_v1(p_org uuid,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_user uuid:=auth.uid(); v_role text; v_state text; v_offset integer; v_view uuid[]; v_rows jsonb; v_next integer; v_now timestamptz:=clock_timestamp();
BEGIN
  IF auth.role() IS DISTINCT FROM 'authenticated' OR v_user IS NULL OR p_org IS NULL THEN RAISE EXCEPTION 'hermes_task_denied' USING ERRCODE='42501'; END IF;
  PERFORM app_private.hermes_request_v1(p_input,ARRAY['role','state','offset']);
  v_role:=p_input->>'role'; v_state:=p_input->>'state';
  IF jsonb_typeof(p_input->'role') IS DISTINCT FROM 'string' OR v_role NOT IN ('assigned_by_me','assigned_to_me')
    OR jsonb_typeof(p_input->'state') IS DISTINCT FROM 'string' OR v_state NOT IN ('active','closed')
    THEN RAISE EXCEPTION 'hermes_task_invalid' USING ERRCODE='22023'; END IF;
  v_offset:=app_private.hermes_task_follow_int_v1(p_input->'offset',0,200);
  PERFORM app_private.hermes_member_v1(v_user,p_org);
  IF app_private.is_actor_offboarded_v1() THEN RAISE EXCEPTION 'hermes_task_denied' USING ERRCODE='42501'; END IF;
  -- Live job fields only where the viewer still may see them now.
  SELECT COALESCE(array_agg(b.id),'{}'::uuid[]) INTO v_view FROM public.buildings b
    CROSS JOIN app_private.authorized_scope_v3('tasks.view',p_org) scope
    WHERE b.organization_id=p_org AND b.deleted_at IS NULL AND (COALESCE(scope.org_wide,false) OR b.id=ANY(COALESCE(scope.building_ids,'{}'::uuid[])));
  SELECT COALESCE(jsonb_agg(item ORDER BY ord),'[]') INTO v_rows FROM (
    SELECT row_number() OVER (ORDER BY f.updated_at DESC,f.id) ord,jsonb_build_object(
      'id',f.id,'version',f.version,'state',lower(f.state),'closeReason',f.close_reason,'objective',f.objective,
      'jobId',CASE WHEN visible.id IS NULL THEN NULL ELSE f.job_id END,'jobCode',f.job_code,
      'jobTitle',COALESCE(app_private.hermes_task_follow_label_v1(visible.title,200),f.job_title),
      'jobStatus',CASE WHEN visible.id IS NOT NULL THEN visible.status
        WHEN f.close_reason IN ('job_cancelled','job_deleted') THEN 'DELETED' WHEN f.close_reason='completed' THEN 'COMPLETED' ELSE 'UNKNOWN' END,
      'deadline',app_private.hermes_task_follow_iso_v1(visible.deadline),
      'overdue',COALESCE(visible.status='IN_PROGRESS' AND visible.deadline IS NOT NULL AND visible.deadline<=v_now,false),
      'assignerUserId',f.assigner_user_id,'assignerName',app_private.hermes_task_follow_name_v1(f.assigner_user_id),
      'executorUserId',COALESCE(visible.assignee_id,f.executor_user_id),
      'executorName',app_private.hermes_task_follow_name_v1(COALESCE(visible.assignee_id,f.executor_user_id)),
      'mode',f.mode,'depth',f.depth,'remindBeforeMinutes',f.remind_before_minutes,'notifyAssigner',f.notify_assigner,
      'createdAt',app_private.hermes_task_follow_iso_v1(f.created_at),'updatedAt',app_private.hermes_task_follow_iso_v1(f.updated_at),
      'closedAt',app_private.hermes_task_follow_iso_v1(f.closed_at)) item
    FROM app_private.hermes_task_follows f
    LEFT JOIN LATERAL (SELECT j.id,j.title,j.status,j.deadline,j.assignee_id FROM public.jobs j
      WHERE j.id=f.job_id AND j.organization_id=f.organization_id
        AND ((v_role='assigned_to_me' AND j.assignee_id=v_user) OR (f.state='ACTIVE' AND j.building_id=ANY(v_view)))) visible ON true
    WHERE f.organization_id=p_org
      AND ((v_role='assigned_by_me' AND f.assigner_user_id=v_user) OR (v_role='assigned_to_me' AND f.executor_user_id=v_user))
      AND ((v_state='active' AND f.state='ACTIVE') OR (v_state='closed' AND f.state<>'ACTIVE'))
    ORDER BY f.updated_at DESC,f.id LIMIT 51 OFFSET v_offset) found;
  IF jsonb_array_length(v_rows)>50 THEN
    SELECT jsonb_agg(value ORDER BY ordinality) INTO v_rows FROM jsonb_array_elements(v_rows) WITH ORDINALITY WHERE ordinality<=50;
    v_next:=CASE WHEN v_offset+50<=200 THEN v_offset+50 ELSE NULL END;
  END IF;
  RETURN jsonb_build_object('organizationId',p_org,'userId',v_user,'role',v_role,'state',v_state,'items',v_rows,'offset',v_offset,'nextOffset',v_next);
END $fn$;

CREATE OR REPLACE FUNCTION public.hermes_my_task_follow_stop_v1(p_org uuid,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_user uuid:=auth.uid(); f app_private.hermes_task_follows; v_now timestamptz:=clock_timestamp();
BEGIN
  IF auth.role() IS DISTINCT FROM 'authenticated' OR v_user IS NULL OR p_org IS NULL THEN RAISE EXCEPTION 'hermes_task_denied' USING ERRCODE='42501'; END IF;
  PERFORM app_private.hermes_request_v1(p_input,ARRAY['followId','expectedVersion']);
  PERFORM app_private.hermes_uuid_v1(p_input->'followId'); PERFORM app_private.hermes_integer_v1(p_input->'expectedVersion');
  PERFORM app_private.lock_org_for_decision_v1(p_org);
  PERFORM app_private.hermes_member_v1(v_user,p_org);
  SELECT * INTO f FROM app_private.hermes_task_follows WHERE id=(p_input->>'followId')::uuid AND organization_id=p_org FOR UPDATE;
  IF NOT FOUND OR f.assigner_user_id<>v_user THEN RAISE EXCEPTION 'hermes_task_denied' USING ERRCODE='42501'; END IF;
  IF f.state<>'ACTIVE' OR f.version::text IS DISTINCT FROM p_input->>'expectedVersion'
    THEN RAISE EXCEPTION 'hermes_task_context_changed' USING ERRCODE='PT409'; END IF;
  UPDATE app_private.hermes_task_follows SET state='CANCELLED',close_reason='stopped',closed_at=v_now,closed_by=v_user,
    version=version+1,updated_at=v_now WHERE id=f.id RETURNING * INTO f;
  PERFORM app_private.append_authz_audit_v1(p_org,'HERMES_TASK_FOLLOW_STOPPED','hermes_task_follow',f.id,NULL,
    jsonb_build_object('actor',v_user,'executor',f.executor_user_id,'jobId',f.job_id,'channel','crm_web'),'Standing follow stopped in CRM');
  RETURN jsonb_build_object('organizationId',p_org,'userId',v_user,'id',f.id,'version',f.version,'state','cancelled','closeReason','stopped');
END $fn$;

-- ---------------------------------------------------------------------------
-- Lượt nhắc/báo cáo (pg_cron hiện có, 15 phút). Mỗi lượt kiểm lại standing grant,
-- thành viên và quyền CRM của người giao; người nhận phải còn là thành viên.
-- Gộp theo (người nhận, loại): một thông báo cho nhiều việc.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_private.hermes_task_follow_tick_v1(p_limit integer DEFAULT 500)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_org uuid; f app_private.hermes_task_follows; j public.jobs; v_now timestamptz; v_reason text; v_found boolean;
  v_groups jsonb:='{}'; v_key text; v_item jsonb; v_checked integer:=0; v_closed integer:=0; v_notified integer:=0; g record; v_parts text[];
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 5000 THEN RAISE EXCEPTION 'hermes_task_invalid' USING ERRCODE='22023'; END IF;
  IF NOT pg_try_advisory_xact_lock(hashtext('app_private.hermes_task_follow_tick_v1')) THEN
    RETURN jsonb_build_object('busy',true); END IF;
  FOR v_org IN SELECT DISTINCT organization_id FROM app_private.hermes_task_follows WHERE state='ACTIVE' ORDER BY 1 LOOP
    PERFORM app_private.lock_org_for_decision_v1(v_org);
    v_now:=clock_timestamp();
    -- Least recently checked first, so a large company is covered across ticks.
    FOR f IN SELECT * FROM app_private.hermes_task_follows WHERE organization_id=v_org AND state='ACTIVE'
        ORDER BY checked_at NULLS FIRST,id LIMIT p_limit FOR UPDATE SKIP LOCKED LOOP
      v_checked:=v_checked+1;
      UPDATE app_private.hermes_task_follows SET checked_at=v_now WHERE id=f.id;
      v_reason:=app_private.hermes_task_follow_grant_v1(f);
      IF v_reason IS NOT NULL THEN
        UPDATE app_private.hermes_task_follows SET state='REVOKED',close_reason=v_reason,closed_at=v_now,version=version+1,updated_at=v_now WHERE id=f.id;
        PERFORM app_private.append_authz_audit_v1(f.organization_id,'HERMES_TASK_FOLLOW_REVOKED','hermes_task_follow',f.id,NULL,
          jsonb_build_object('assigner',f.assigner_user_id,'executor',f.executor_user_id,'jobId',f.job_id,'reason',v_reason),'Standing follow lost authority');
        v_closed:=v_closed+1; CONTINUE;
      END IF;
      SELECT * INTO j FROM public.jobs WHERE id=f.job_id AND organization_id=f.organization_id;
      v_found:=FOUND;
      v_item:=jsonb_build_object('jobId',f.job_id,'code',f.job_code,'title',
        CASE WHEN v_found THEN COALESCE(app_private.hermes_task_follow_label_v1(j.title,200),f.job_title) ELSE f.job_title END,
        'deadline',CASE WHEN v_found THEN app_private.hermes_task_follow_iso_v1(j.deadline) END);
      IF NOT v_found OR j.status='COMPLETED' THEN
        UPDATE app_private.hermes_task_follows SET state=CASE WHEN v_found THEN 'DONE' ELSE 'CANCELLED' END,
          close_reason=CASE WHEN v_found THEN 'completed' ELSE 'job_deleted' END,closed_at=v_now,version=version+1,updated_at=v_now WHERE id=f.id;
        v_closed:=v_closed+1;
        IF f.notify_assigner THEN
          v_key:=f.organization_id::text||'|'||f.assigner_user_id::text||'|'||CASE WHEN v_found THEN 'done' ELSE 'deleted' END;
          v_groups:=jsonb_set(v_groups,ARRAY[v_key],COALESCE(v_groups->v_key,'[]'::jsonb)||jsonb_build_array(v_item),true);
        END IF;
        CONTINUE;
      END IF;
      IF j.assignee_id IS NOT NULL AND j.assignee_id IS DISTINCT FROM f.executor_user_id THEN
        UPDATE app_private.hermes_task_follows SET executor_user_id=j.assignee_id,version=version+1,updated_at=v_now WHERE id=f.id;
      END IF;
      IF j.status<>'IN_PROGRESS' OR j.deadline IS NULL THEN CONTINUE; END IF;
      IF f.remind_before_minutes IS NOT NULL AND f.due_notified_at IS NULL AND j.assignee_id IS NOT NULL
        AND v_now>=j.deadline-make_interval(mins=>f.remind_before_minutes) AND v_now<j.deadline THEN
        UPDATE app_private.hermes_task_follows SET due_notified_at=v_now,updated_at=v_now WHERE id=f.id;
        v_key:=f.organization_id::text||'|'||j.assignee_id::text||'|due';
        v_groups:=jsonb_set(v_groups,ARRAY[v_key],COALESCE(v_groups->v_key,'[]'::jsonb)||jsonb_build_array(v_item),true);
      END IF;
      IF v_now>=j.deadline AND f.overdue_notified_at IS NULL THEN
        UPDATE app_private.hermes_task_follows SET overdue_notified_at=v_now,updated_at=v_now WHERE id=f.id;
        IF j.assignee_id IS NOT NULL THEN
          v_key:=f.organization_id::text||'|'||j.assignee_id::text||'|overdue';
          v_groups:=jsonb_set(v_groups,ARRAY[v_key],COALESCE(v_groups->v_key,'[]'::jsonb)||jsonb_build_array(v_item),true);
        END IF;
        IF f.notify_assigner AND f.assigner_user_id IS DISTINCT FROM j.assignee_id THEN
          v_key:=f.organization_id::text||'|'||f.assigner_user_id::text||'|overdue_report';
          v_groups:=jsonb_set(v_groups,ARRAY[v_key],COALESCE(v_groups->v_key,'[]'::jsonb)||jsonb_build_array(v_item),true);
        END IF;
      END IF;
    END LOOP;
  END LOOP;
  FOR g IN SELECT key,value FROM jsonb_each(v_groups) ORDER BY key LOOP
    v_parts:=string_to_array(g.key,'|');
    IF app_private.hermes_task_follow_notify_v1(v_parts[1]::uuid,v_parts[2]::uuid,v_parts[3],g.value,NULL,NULL) IS NOT NULL THEN
      v_notified:=v_notified+1; END IF;
  END LOOP;
  RETURN jsonb_build_object('checked',v_checked,'closed',v_closed,'notified',v_notified);
END $fn$;

-- ---------------------------------------------------------------------------
-- Quyền thực thi.
-- ---------------------------------------------------------------------------
DO $acl$ DECLARE sig text; BEGIN
  FOREACH sig IN ARRAY ARRAY[
    'app_private.hermes_task_dispatch_quota_v1()','app_private.hermes_task_follow_int_v1(jsonb,integer,integer)',
    'app_private.hermes_task_follow_text_v1(jsonb,integer,boolean)','app_private.hermes_task_follow_label_v1(text,integer)',
    'app_private.hermes_task_follow_iso_v1(timestamptz)','app_private.hermes_task_follow_member_v1(uuid,uuid)',
    'app_private.hermes_task_follow_name_v1(uuid)','app_private.hermes_task_follow_json_v1(app_private.hermes_task_follows)',
    'app_private.hermes_task_follow_connection_v1(jsonb)','app_private.hermes_task_follow_capable_v1(app_private.hermes_connections,text,text,text)',
    'app_private.hermes_task_follow_buildings_v1(app_private.hermes_connections,text)',
    'app_private.hermes_task_follow_building_v1(app_private.hermes_connections,text,uuid)',
    'app_private.hermes_task_follow_grant_v1(app_private.hermes_task_follows)',
    'app_private.hermes_task_follow_notify_v1(uuid,uuid,text,jsonb,text,uuid)',
    'app_private.hermes_task_follow_guard_v1(jsonb,text,jsonb)','app_private.hermes_task_follow_apply_v1(jsonb)',
    'app_private.hermes_task_follow_finish_v1(jsonb,text,jsonb,jsonb)','app_private.hermes_task_follow_tick_v1(integer)',
    'public.hermes_task_follow_read_v1(jsonb,jsonb)','public.hermes_task_follow_action_v1(jsonb,text,jsonb)',
    'public.hermes_task_follow_capabilities_v1(uuid)','public.hermes_my_task_follows_v1(uuid,jsonb)',
    'public.hermes_my_task_follow_stop_v1(uuid,jsonb)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO postgres',sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor',sig);
  END LOOP;
END $acl$;
-- The invoker wrapper reaches only these three private steps by bound OID.
GRANT EXECUTE ON FUNCTION app_private.hermes_task_follow_guard_v1(jsonb,text,jsonb),app_private.hermes_task_follow_apply_v1(jsonb),
  app_private.hermes_task_follow_finish_v1(jsonb,text,jsonb,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.hermes_task_follow_read_v1(jsonb,jsonb),public.hermes_task_follow_action_v1(jsonb,text,jsonb),
  public.hermes_task_follow_capabilities_v1(uuid),public.hermes_my_task_follows_v1(uuid,jsonb),
  public.hermes_my_task_follow_stop_v1(uuid,jsonb) TO authenticated;

-- Lịch: dùng pg_cron sẵn có của nền tảng (cùng cơ chế canh gác Zalo/nhắc vòng đời).
-- DB diễn tập không có cron thì bỏ qua; cron.schedule theo tên là ghi đè.
DO $cronblock$
BEGIN
  IF to_regnamespace('cron') IS NULL THEN
    RAISE NOTICE 'Không có schema cron — bỏ qua đăng ký lịch nhắc việc Hermes.';
    RETURN;
  END IF;
  PERFORM cron.schedule('hermes-task-follow-15m','*/15 * * * *','SELECT app_private.hermes_task_follow_tick_v1();');
END
$cronblock$;

DO $kiem$
BEGIN
  IF has_function_privilege('authenticated','app_private.hermes_task_follow_tick_v1(integer)','EXECUTE')
    OR has_function_privilege('authenticated','app_private.hermes_task_follow_notify_v1(uuid,uuid,text,jsonb,text,uuid)','EXECUTE')
    OR has_function_privilege('anon','public.hermes_task_follow_action_v1(jsonb,text,jsonb)','EXECUTE')
    OR has_table_privilege('authenticated','app_private.hermes_task_follows','SELECT')
    THEN RAISE EXCEPTION 'hermes_task_follow_acl_leak'; END IF;
END $kiem$;
COMMIT;
NOTIFY pgrst,'reload schema';
