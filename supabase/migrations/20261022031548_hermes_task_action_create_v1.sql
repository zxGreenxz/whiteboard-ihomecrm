-- Hermes Đợt 2b — trang Công việc, Mốc 2 (CV-M1; docs/plans/hermes-crm/CONG-VIEC-THAO-TAC-GHI.md mục 2–3): tạo việc bằng
-- tên trên khung thao tác ghi dùng chung. Chỉ file, chưa áp TEST hay production.
--  (1) Dòng chính sách task.create: khoá tasks.create, quyền CRM tasks.create, lớp reversible, chính sách never. Máy chủ tự
--      đòi xác nhận khi giao người khác, khi phải đoán loại hoặc phòng, khi có việc trùng đang mở, khi người nhận không
--      quản lý toà, khi đề xuất người nhận (Q31, Q32, Q35, Q36). Tự giao, đủ thông tin ⇒ ghi thẳng.
--  (2) Hai bảng: hạn mức theo hạng owner/member (Q37, đổi bằng migration) và sổ việc Hermes tạo (đếm hạn mức, nguồn việc).
--  (3) Hàm dùng chung (luật 17/10): hạn theo giờ công ty (Q30: trống = hết ngày mai); việc trùng đang mở (Q36); người quản
--      lý toà theo quyền hiệu lực, bỏ thành viên OWNER (Q31); hạn mức; câu ngày tiếng Việt.
--  (4) RPC trang bốn tầng, khuôn hàm tạo việc 20261014092945: giải tên INVOKER dưới RLS người hỏi → chuẩn bị DEFINER (guard
--      chung, phạm vi, basis, hạn mức, biên nhận chung) → ghi INVOKER (INSERT jobs dưới RLS; trigger mã việc, người tạo, công
--      ty, thông báo E4 chạy như web) → chốt DEFINER (đối chiếu hàng vừa ghi, sổ việc, audit, chốt biên nhận). Tầng ghi phải
--      nằm ở cấp vỏ: INVOKER gọi từ trong DEFINER chạy dưới chủ hàm và bỏ qua RLS. authenticated không có USAGE app_private:
--      vỏ gắn OID lúc tạo.
-- Toà ảo không nhận (khớp web: danh sách toà khi tạo việc và RLS xem việc đều loại toà ảo). Không đổi hàm hay bảng cũ.
-- Idempotent; khối kiểm cuối chỉ đọc catalog. Mọi phép kiểm tham số đóng khi gặp NULL.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $requires$
BEGIN
  IF to_regclass('app_private.hermes_action_policies') IS NULL OR to_regclass('app_private.hermes_action_receipts') IS NULL
    OR to_regclass('public.jobs') IS NULL OR to_regclass('public.job_types') IS NULL OR to_regclass('public.organization_memberships') IS NULL
    OR to_regclass('public.profiles') IS NULL
    OR to_regprocedure('app_private.hermes_action_guard_v1(jsonb,text)') IS NULL
    OR to_regprocedure('app_private.hermes_action_receipt_begin_v1(jsonb,text,uuid,jsonb)') IS NULL
    OR to_regprocedure('app_private.hermes_action_receipt_finish_v1(jsonb,text,uuid,jsonb,text,text)') IS NULL
    OR to_regprocedure('app_private.hermes_action_reason_v1(text,text,text)') IS NULL
    OR to_regprocedure('public.hermes_write_name_resolve_v1(uuid,uuid[],jsonb)') IS NULL
    OR to_regprocedure('public.hermes_name_fold_v1(text)') IS NULL
    OR to_regprocedure('app_private.hermes_task_assignee_member_v1(uuid,uuid)') IS NULL
    OR to_regprocedure('app_private.authorize_tenant_action_v3(uuid,uuid,text,uuid,uuid)') IS NULL
    OR to_regprocedure('app_private.lock_org_for_decision_v1(uuid)') IS NULL
    OR to_regprocedure('app_private.org_timezone_v1(uuid)') IS NULL
    OR to_regprocedure('public.org_today_v1(uuid)') IS NULL
    OR to_regprocedure('app_private.append_authz_audit_v1(uuid,text,text,uuid,jsonb,jsonb,text)') IS NULL THEN
    RAISE EXCEPTION 'hermes_task_action_dependency_invalid'; END IF;
END $requires$;

-- 1. Chính sách thao tác (danh mục phía SQL của khung chung).
INSERT INTO app_private.hermes_action_policies(action,capability,crm_permission,action_class,confirm,private_only)
  VALUES('task.create','tasks.create','tasks.create','reversible','never',true) ON CONFLICT(action) DO NOTHING;

-- 2a. Hạn mức giao việc qua bot (Q37). organization_id NULL = mặc định; dòng của công ty thắng dòng mặc định. Thiếu dòng ⇒
-- đóng an toàn (từ chối). Số seed phải khớp câu tĩnh của task_quota_user / task_quota_pair ở action-reasons.mjs.
CREATE TABLE IF NOT EXISTS app_private.hermes_task_limits(
  organization_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
  tier text NOT NULL CHECK (tier IN ('owner','member')),
  per_actor_hour integer NOT NULL CHECK (per_actor_hour BETWEEN 1 AND 1000),
  per_pair_hour integer NOT NULL CHECK (per_pair_hour BETWEEN 1 AND 1000),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT hermes_task_limits_key UNIQUE NULLS NOT DISTINCT (organization_id,tier));
ALTER TABLE app_private.hermes_task_limits OWNER TO postgres;
ALTER TABLE app_private.hermes_task_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE app_private.hermes_task_limits FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
INSERT INTO app_private.hermes_task_limits(organization_id,tier,per_actor_hour,per_pair_hour)
  VALUES(NULL,'member',30,10),(NULL,'owner',60,40) ON CONFLICT ON CONSTRAINT hermes_task_limits_key DO NOTHING;

-- 2b. Sổ việc Hermes tạo: hạn mức chỉ đếm việc tạo qua bot (không đếm việc tạo trên web). Không khoá ngoại tới jobs: việc bị
-- huỷ (xoá hẳn) thì dòng sổ vẫn giữ cho hạn mức và nhật ký.
CREATE TABLE IF NOT EXISTS app_private.hermes_task_jobs(
  job_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  assignee_id uuid,
  request_id uuid,
  action text NOT NULL CHECK (action ~ '^[a-z][a-z0-9_]{1,31}\.[a-z][a-z0-9_]{1,31}$'),
  source text NOT NULL CHECK (source IN ('action','recurrence')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp());
ALTER TABLE app_private.hermes_task_jobs OWNER TO postgres;
ALTER TABLE app_private.hermes_task_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE app_private.hermes_task_jobs FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
CREATE INDEX IF NOT EXISTS hermes_task_jobs_actor_recent ON app_private.hermes_task_jobs(organization_id,actor_id,created_at DESC);
CREATE INDEX IF NOT EXISTS hermes_task_jobs_assignee_recent ON app_private.hermes_task_jobs(organization_id,assignee_id,created_at DESC);

-- 3a. Hạn việc theo giờ công ty (Q30). Ngày trống = ngày mai; giờ trống = 23:59:59.999 như ô tạo việc của web. DEFINER chỉ để
-- đọc múi giờ công ty (như org_today_v1); không đọc dữ liệu nghiệp vụ.
CREATE OR REPLACE FUNCTION public.job_deadline_v1(p_organization_id uuid,p_date date DEFAULT NULL,p_time time DEFAULT NULL)
RETURNS timestamptz LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
  SELECT CASE WHEN p_organization_id IS NULL THEN NULL ELSE
    (COALESCE(p_date,public.org_today_v1(p_organization_id)+1)::timestamp+COALESCE(p_time::interval,interval '23:59:59.999'))
      AT TIME ZONE app_private.org_timezone_v1(p_organization_id) END
$fn$;

-- 3b. Việc trùng đang mở (Q36): cùng toà + cùng phòng (hoặc cùng cả toà) + cùng loại + đang làm. INVOKER: web gọi dưới RLS của
-- người dùng; bước chuẩn bị (DEFINER) gọi trên toà đã nằm trong phạm vi web của người hỏi nên ra cùng tập.
CREATE OR REPLACE FUNCTION public.job_open_duplicates_v1(p_organization_id uuid,p_building_id uuid,p_room_id uuid,p_job_type_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $fn$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',d.id,'code',d.code,'title',d.title,'assigneeId',d.assignee_id,'deadline',d.deadline)
    ORDER BY d.created_at DESC,d.id),'[]'::jsonb)
  FROM (SELECT j.id,j.code,j.title,j.assignee_id,j.deadline,j.created_at FROM public.jobs j
    WHERE j.organization_id=p_organization_id AND j.building_id=p_building_id AND j.room_id IS NOT DISTINCT FROM p_room_id
      AND j.job_type_id=p_job_type_id AND j.status='IN_PROGRESS'
    ORDER BY j.created_at DESC,j.id LIMIT 5) d
$fn$;

-- 3c. Người quản lý toà (Q31): thành viên ACTIVE (không phải OWNER) có tasks.edit và buildings.view ở toà theo quyền hiệu lực.
-- Chỉ trả id; tên do vỏ đọc dưới RLS hồ sơ của người hỏi. Người hỏi phải là thành viên và xem được toà đó.
CREATE OR REPLACE FUNCTION app_private.hermes_task_building_managers_v1(p_organization_id uuid,p_building_id uuid)
RETURNS uuid[] LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_ids uuid[];
BEGIN
  IF auth.uid() IS NULL OR p_organization_id IS NULL OR p_building_id IS NULL
    OR NOT COALESCE(app_private.hermes_task_assignee_member_v1(auth.uid(),p_organization_id),false) THEN RETURN '{}'::uuid[]; END IF;
  PERFORM 1 FROM public.buildings b WHERE b.id=p_building_id AND b.organization_id=p_organization_id AND b.deleted_at IS NULL;
  IF NOT FOUND THEN RETURN '{}'::uuid[]; END IF;
  PERFORM app_private.lock_org_for_decision_v1(p_organization_id);
  IF NOT COALESCE((SELECT a.allowed FROM app_private.authorize_tenant_action_v3(auth.uid(),p_organization_id,'buildings.view',p_building_id,NULL) a),false)
    THEN RETURN '{}'::uuid[]; END IF;
  SELECT COALESCE(array_agg(m.user_id ORDER BY m.user_id),'{}'::uuid[]) INTO v_ids
    FROM (SELECT DISTINCT om.user_id FROM public.organization_memberships om
      WHERE om.organization_id=p_organization_id AND om.status='ACTIVE' AND om.revoked_at IS NULL
        AND om.member_type IS DISTINCT FROM 'OWNER'
        AND (om.valid_from IS NULL OR om.valid_from<=clock_timestamp()) AND (om.valid_to IS NULL OR om.valid_to>clock_timestamp())) m
    WHERE COALESCE((SELECT a.allowed FROM app_private.authorize_tenant_action_v3(m.user_id,p_organization_id,'tasks.edit',p_building_id,NULL) a),false)
      AND COALESCE((SELECT a.allowed FROM app_private.authorize_tenant_action_v3(m.user_id,p_organization_id,'buildings.view',p_building_id,NULL) a),false);
  RETURN v_ids;
END $fn$;

-- 3d. Hạn mức (Q37): đếm việc người hỏi tạo qua bot trong 60 phút, theo người tạo và theo cặp hai chiều (kể cả tự giao).
-- Trả NULL khi còn hạn mức, ngược lại mã lý do. Khoá tư vấn theo (công ty, người hỏi) để hai lời gọi song song không cùng lọt.
CREATE OR REPLACE FUNCTION app_private.hermes_task_quota_v1(p_organization_id uuid,p_actor uuid,p_assignees uuid[])
RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_tier text; v_limit app_private.hermes_task_limits; v_used integer; v_assignee uuid;
BEGIN
  IF p_organization_id IS NULL OR p_actor IS NULL OR p_assignees IS NULL OR cardinality(p_assignees)=0
    OR array_position(p_assignees,NULL) IS NOT NULL THEN RAISE EXCEPTION 'hermes_task_invalid' USING ERRCODE='22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('hermes_task_quota:'||p_organization_id::text||':'||p_actor::text,0));
  v_tier:=CASE WHEN EXISTS(SELECT 1 FROM public.organization_memberships m WHERE m.organization_id=p_organization_id AND m.user_id=p_actor
    AND m.status='ACTIVE' AND m.revoked_at IS NULL AND m.member_type='OWNER') THEN 'owner' ELSE 'member' END;
  SELECT * INTO v_limit FROM app_private.hermes_task_limits l WHERE l.tier=v_tier AND (l.organization_id=p_organization_id OR l.organization_id IS NULL)
    ORDER BY (l.organization_id IS NULL) LIMIT 1;
  IF NOT FOUND THEN RETURN 'task_quota_user'; END IF;
  SELECT count(*) INTO v_used FROM app_private.hermes_task_jobs t WHERE t.organization_id=p_organization_id AND t.actor_id=p_actor
    AND t.source='action' AND t.created_at>clock_timestamp()-interval '1 hour';
  IF v_used+cardinality(p_assignees)>v_limit.per_actor_hour THEN RETURN 'task_quota_user'; END IF;
  FOR v_assignee IN SELECT DISTINCT x FROM unnest(p_assignees) x LOOP
    SELECT count(*) INTO v_used FROM app_private.hermes_task_jobs t WHERE t.organization_id=p_organization_id AND t.source='action'
      AND t.created_at>clock_timestamp()-interval '1 hour'
      AND ((t.actor_id=p_actor AND t.assignee_id=v_assignee) OR (t.actor_id=v_assignee AND t.assignee_id=p_actor));
    IF v_used+(SELECT count(*) FROM unnest(p_assignees) y WHERE y=v_assignee)>v_limit.per_pair_hour THEN RETURN 'task_quota_pair'; END IF;
  END LOOP;
  RETURN NULL;
END $fn$;

-- 3e. Câu hạn tiếng Việt cho bản xem trước và kết quả: thứ + ngày theo giờ công ty + khoảng cách tới hôm nay, để người dùng bắt
-- lỗi ngày tương đối. "hết …" khi là cuối ngày.
CREATE OR REPLACE FUNCTION app_private.hermes_task_when_v1(p_organization_id uuid,p_deadline timestamptz,p_defaulted boolean)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_local timestamp; v_day date; v_today date; v_gap integer; v_rel text;
BEGIN
  IF p_organization_id IS NULL OR p_deadline IS NULL THEN RETURN NULL; END IF;
  v_local:=p_deadline AT TIME ZONE app_private.org_timezone_v1(p_organization_id);
  v_day:=v_local::date; v_today:=public.org_today_v1(p_organization_id); v_gap:=v_day-v_today;
  v_rel:=CASE WHEN v_gap=0 THEN 'hôm nay' WHEN v_gap=1 THEN 'ngày mai' WHEN v_gap=2 THEN 'ngày kia'
    WHEN v_gap>2 THEN 'còn '||v_gap||' ngày' ELSE 'đã qua '||(-v_gap)||' ngày' END;
  RETURN CASE WHEN v_local::time>=time '23:59:59' THEN 'hết ' ELSE to_char(v_local,'HH24:MI')||' ' END
    ||(ARRAY['thứ Hai','thứ Ba','thứ Tư','thứ Năm','thứ Sáu','thứ Bảy','Chủ nhật'])[extract(isodow FROM v_day)::int]
    ||' '||to_char(v_day,'DD/MM/YYYY')||' ('||v_rel||CASE WHEN COALESCE(p_defaulted,false) THEN ', mặc định' ELSE '' END||')';
END $fn$;

-- 4a. Lõi giải tên của trang, dưới RLS người hỏi (chỉ tham chiếu public.*: không USAGE app_private lúc chạy). Toà/phòng/loại/người
-- qua hàm giải tên ghi dùng chung (D7); thêm: từ "cả toà", từ chỉ chính mình, đoán loại theo đầu nội dung, hạn, tiêu đề như web.
CREATE OR REPLACE FUNCTION app_private.hermes_task_resolve_core_v1(p_ctx jsonb,p_action text,p_params jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $fn$
DECLARE v_org uuid; v_scope uuid[]; v_building text; v_room text; v_type text; v_person text; v_content text; v_whole boolean:=false;
  v_self boolean:=false; v_res jsonb; v_job jsonb; v_who jsonb; v_guessed boolean:=false; v_date date; v_time time; v_deadline timestamptz;
  v_fold text; v_tfold text; v_title text; v_desc text; v_priority text; v_found jsonb; v_best integer; v_more boolean;
BEGIN
  IF p_action IS NULL OR p_action<>'task.create' OR p_ctx IS NULL OR p_params IS NULL OR jsonb_typeof(p_params)<>'object'
    OR jsonb_typeof(p_params->'content') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'hermes_task_invalid' USING ERRCODE='22023'; END IF;
  v_org:=(p_ctx->>'organizationId')::uuid;
  v_scope:=ARRAY(SELECT jsonb_array_elements_text(p_ctx->'buildingIds')::uuid);
  v_building:=NULLIF(btrim(p_params->>'buildingName'),''); v_room:=NULLIF(btrim(p_params->>'roomName'),'');
  v_type:=NULLIF(btrim(p_params->>'jobType'),''); v_person:=NULLIF(btrim(p_params->>'assigneeName'),'');
  v_content:=btrim(regexp_replace(p_params->>'content','\s+',' ','g'));
  IF v_content='' THEN RETURN jsonb_build_object('status','invalid','reason','invalid_params'); END IF;
  IF v_room IS NOT NULL AND public.hermes_name_fold_v1(v_room) IN ('tn','toa','ca toa','toan toa','toa nha','ca toa nha') THEN
    v_room:=NULL; v_whole:=true; END IF;
  IF v_building IS NULL AND v_room IS NULL THEN
    RETURN jsonb_build_object('status','unresolved','field','building','wanted','','why','unspecified','candidates','[]'::jsonb,'more',false); END IF;
  v_res:=public.hermes_write_name_resolve_v1(v_org,v_scope,jsonb_strip_nulls(jsonb_build_object('building',v_building,'room',v_room)));
  IF v_res->>'status' IS DISTINCT FROM 'resolved' THEN RETURN v_res; END IF;

  -- Loại việc: nêu tên ⇒ hàm giải tên; trống ⇒ loại đang bật có tên (bỏ dấu) là cụm đứng đầu nội dung, lấy tên dài nhất nếu
  -- duy nhất (như ô gõ nhanh của web). Không có hoặc hoà ⇒ hỏi lại kèm danh sách, không chọn bừa.
  IF v_type IS NOT NULL THEN
    v_job:=public.hermes_write_name_resolve_v1(v_org,v_scope,jsonb_build_object('jobType',v_type));
    IF v_job->>'status' IS DISTINCT FROM 'resolved' THEN RETURN v_job; END IF;
    v_job:=v_job->'jobType';
  ELSE
    v_fold:=public.hermes_name_fold_v1(v_content);
    SELECT COALESCE(jsonb_agg(jsonb_build_object('id',t.id,'name',t.name,'len',char_length(t.k)) ORDER BY char_length(t.k) DESC,t.name,t.id),'[]'::jsonb)
      INTO v_found FROM (SELECT j.id,j.name,public.hermes_name_fold_v1(j.name) k FROM public.job_types j
        WHERE j.organization_id=v_org AND COALESCE(j.is_active,true)) t
      WHERE t.k<>'' AND (v_fold=t.k OR left(v_fold,char_length(t.k)+1)=t.k||' ');
    v_best:=(v_found->0->>'len')::int;
    IF jsonb_array_length(v_found)=1 OR (jsonb_array_length(v_found)>1 AND (v_found->1->>'len')::int<v_best) THEN
      v_job:=jsonb_build_object('id',v_found->0->'id','name',v_found->0->'name'); v_guessed:=true;
    ELSE
      SELECT COALESCE(jsonb_agg(jsonb_build_object('name',x.name) ORDER BY x.name),'[]'::jsonb),count(*)>8 INTO v_found,v_more
        FROM (SELECT j.name FROM public.job_types j WHERE j.organization_id=v_org AND COALESCE(j.is_active,true) AND btrim(COALESCE(j.name,''))<>''
          ORDER BY j.name LIMIT 9) x;
      RETURN jsonb_build_object('status','unresolved','field','jobType','wanted','','why','unspecified',
        'candidates',(SELECT COALESCE(jsonb_agg(e ORDER BY ord),'[]'::jsonb) FROM jsonb_array_elements(v_found) WITH ORDINALITY y(e,ord) WHERE ord<=8),
        'more',v_more);
    END IF;
  END IF;

  -- Người nhận: từ chỉ chính mình ⇒ người hỏi; còn lại qua hàm giải tên (hồ sơ thấy được + thành viên ACTIVE); trống ⇒ Q31.
  IF v_person IS NOT NULL AND public.hermes_name_fold_v1(v_person) IN ('toi','minh','tui','em','anh','chi','self','me','chinh minh','ban than') THEN
    v_self:=true; v_person:=NULL; END IF;
  IF v_person IS NOT NULL THEN
    v_who:=public.hermes_write_name_resolve_v1(v_org,v_scope,jsonb_build_object('person',v_person));
    IF v_who->>'status' IS DISTINCT FROM 'resolved' THEN RETURN v_who; END IF;
    v_who:=v_who->'person';
  ELSIF v_self THEN
    v_who:=jsonb_build_object('id',auth.uid(),'name',(SELECT p.full_name FROM public.profiles p WHERE p.id=auth.uid()));
  END IF;

  -- Hạn (Q30): trống ⇒ hết ngày mai giờ công ty; đã qua ⇒ hỏi lại.
  IF jsonb_typeof(p_params->'deadline')='string' THEN
    IF p_params->>'deadline' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RETURN jsonb_build_object('status','invalid','reason','invalid_params'); END IF;
    v_date:=(p_params->>'deadline')::date;
  END IF;
  IF jsonb_typeof(p_params->'deadlineTime')='string' THEN
    IF p_params->>'deadlineTime' !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' THEN RETURN jsonb_build_object('status','invalid','reason','invalid_params'); END IF;
    v_time:=(p_params->>'deadlineTime')::time;
  END IF;
  v_deadline:=public.job_deadline_v1(v_org,v_date,v_time);
  IF v_deadline IS NULL OR v_deadline<=clock_timestamp() THEN RETURN jsonb_build_object('status','invalid','reason','date_out_of_range'); END IF;

  -- Tiêu đề như web: "<loại> <nội dung>", bỏ lặp nếu nội dung đã mở đầu bằng tên loại.
  v_fold:=public.hermes_name_fold_v1(v_content); v_tfold:=public.hermes_name_fold_v1(v_job->>'name');
  v_title:=CASE WHEN v_tfold='' OR v_fold=v_tfold OR left(v_fold,char_length(v_tfold)+1)=v_tfold||' ' THEN v_content
    ELSE btrim(v_job->>'name')||' '||v_content END;
  v_title:=left(btrim(regexp_replace(v_title,'\s+',' ','g')),200);
  v_desc:=COALESCE(NULLIF(btrim(p_params->>'description'),''),v_content);
  v_priority:=COALESCE(NULLIF(p_params->>'priority',''),'NORMAL');
  IF v_priority NOT IN ('NORMAL','LOW','URGENT') THEN RETURN jsonb_build_object('status','invalid','reason','invalid_params'); END IF;
  RETURN jsonb_build_object('status','resolved','building',v_res->'building','room',v_res->'room',
    'wholeBuilding',v_whole AND v_room IS NULL AND jsonb_typeof(v_res->'room') IS DISTINCT FROM 'object',
    'roomMissing',jsonb_typeof(v_res->'room') IS DISTINCT FROM 'object' AND NOT v_whole,
    'jobType',v_job,'jobTypeGuessed',v_guessed,'person',v_who,'personMissing',v_who IS NULL,
    'deadline',v_deadline,'deadlineDefaulted',v_date IS NULL,'title',v_title,'description',v_desc,'priority',v_priority);
END $fn$;

-- 4b. Chuẩn bị (DEFINER): chạy lại guard, kiểm bản đã giải còn đúng phạm vi (lượt 2 nhận bản do connector giữ), tính basis,
-- quyết định xác nhận, dựng bản xem trước; lượt ghi thì kiểm hạn mức rồi mở biên nhận chung và cấp sẵn id việc.
CREATE OR REPLACE FUNCTION app_private.hermes_task_action_prepare_v1(p_binding jsonb,p_action text,p_phase text,p_request_id uuid,p_params jsonb,
  p_resolved jsonb,p_expected_basis text,p_resolution jsonb,p_managers jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE ctx jsonb; v_org uuid; v_actor uuid; v jsonb; v_building uuid; v_room uuid; v_type uuid; v_assignee uuid; v_deadline timestamptz;
  v_building_name text; v_room_name text; v_type_name text; v_assignee_name text; v_dups jsonb; v_manages boolean:=true; v_basis text;
  v_confirm boolean; v_warnings jsonb:='[]'::jsonb; v_text text; v_quota text; v_begin jsonb; v_dup jsonb; v_who text; v_place text;
  v_receipt app_private.hermes_action_receipts;
BEGIN
  IF p_action IS NULL OR p_action<>'task.create' OR p_phase IS NULL OR p_phase NOT IN ('preview','auto','apply')
    OR p_request_id IS NULL OR p_params IS NULL OR jsonb_typeof(p_params)<>'object'
    OR (p_phase='apply' AND (p_resolved IS NULL OR jsonb_typeof(p_resolved)<>'object' OR p_expected_basis IS NULL))
    OR (p_phase<>'apply' AND (p_resolution IS NULL OR jsonb_typeof(p_resolution)<>'object')) THEN
    RAISE EXCEPTION 'hermes_task_invalid' USING ERRCODE='22023'; END IF;
  ctx:=app_private.hermes_action_guard_v1(p_binding,p_action);
  v_org:=(ctx->>'organizationId')::uuid; v_actor:=auth.uid();
  -- requestId đã có biên nhận ⇒ phát lại (hoặc xung đột) TRƯỚC mọi quyết định khác: việc vừa tạo bởi chính mã này không được
  -- thành "việc trùng" đòi xem trước lại, và hạn mức không đếm lại.
  IF p_phase<>'preview' THEN
    SELECT * INTO v_receipt FROM app_private.hermes_action_receipts r WHERE r.organization_id=v_org AND r.user_id=v_actor AND r.request_id=p_request_id;
    IF FOUND THEN
      IF v_receipt.connection_id::text IS DISTINCT FROM ctx->>'connectionId' THEN RAISE EXCEPTION 'hermes_action_context_changed' USING ERRCODE='PT409'; END IF;
      IF v_receipt.action IS DISTINCT FROM p_action OR v_receipt.input->'params' IS DISTINCT FROM p_params THEN
        RETURN jsonb_build_object('kind','rejected','reason','request_conflict'); END IF;
      IF v_receipt.state='started' THEN RAISE EXCEPTION 'hermes_action_outcome_unknown' USING ERRCODE='PT409'; END IF;
      RETURN jsonb_build_object('kind','replay','outcome',v_receipt.result);
    END IF;
  END IF;
  IF p_phase='apply' THEN
    v:=p_resolved;
  ELSIF p_resolution->>'status'='unresolved' THEN
    RETURN jsonb_build_object('kind','needs_input','reason','name_unresolved','field',p_resolution->'field','wanted',p_resolution->'wanted',
      'why',p_resolution->'why','candidates',COALESCE(p_resolution->'candidates','[]'::jsonb),'more',COALESCE(p_resolution->'more','false'::jsonb));
  ELSIF p_resolution->>'status'='invalid' AND p_resolution->>'reason' IN ('date_out_of_range','invalid_params') THEN
    RETURN jsonb_build_object('kind','needs_input','reason',p_resolution->>'reason');
  ELSIF p_resolution->>'status' IS DISTINCT FROM 'resolved' THEN
    RAISE EXCEPTION 'hermes_task_invalid' USING ERRCODE='22023';
  ELSE
    v:=jsonb_build_object('buildingId',p_resolution#>'{building,id}','roomId',COALESCE(p_resolution#>'{room,id}','null'::jsonb),
      'wholeBuilding',p_resolution->'wholeBuilding','roomMissing',p_resolution->'roomMissing',
      'jobTypeId',p_resolution#>'{jobType,id}','jobTypeGuessed',p_resolution->'jobTypeGuessed',
      'assigneeId',COALESCE(p_resolution#>'{person,id}','null'::jsonb),'assigneeSuggested',false,
      'deadline',p_resolution->'deadline','deadlineDefaulted',p_resolution->'deadlineDefaulted',
      'title',p_resolution->'title','description',p_resolution->'description','priority',p_resolution->'priority');
    IF p_resolution->'personMissing'='true'::jsonb THEN
      -- Q31: đúng một người quản lý toà ⇒ đề xuất trong bản xem trước (một câu hỏi); 0 hoặc nhiều ⇒ hỏi kèm danh sách.
      IF jsonb_typeof(p_managers)='array' AND jsonb_array_length(p_managers)=1 THEN
        v:=v||jsonb_build_object('assigneeId',p_managers->0->'id','assigneeSuggested',true);
      ELSE
        RETURN jsonb_build_object('kind','needs_input','reason','name_unresolved','field','person','wanted','','why','unspecified',
          'candidates',(SELECT COALESCE(jsonb_agg(jsonb_build_object('name',e->'name') ORDER BY ord),'[]'::jsonb)
            FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_managers)='array' THEN p_managers ELSE '[]'::jsonb END) WITH ORDINALITY x(e,ord) WHERE ord<=8),
          'more',CASE WHEN jsonb_typeof(p_managers)='array' THEN jsonb_array_length(p_managers)>8 ELSE false END);
      END IF;
    END IF;
  END IF;

  -- Bản đã giải (lượt 1 hay đưa lại ở lượt 2) phải còn đúng phạm vi hiện tại của khoá.
  BEGIN
    v_building:=(v->>'buildingId')::uuid; v_room:=(v->>'roomId')::uuid; v_type:=(v->>'jobTypeId')::uuid;
    v_assignee:=(v->>'assigneeId')::uuid; v_deadline:=(v->>'deadline')::timestamptz;
  EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow THEN
    RAISE EXCEPTION 'hermes_task_invalid' USING ERRCODE='22023';
  END;
  IF v_building IS NULL OR v_type IS NULL OR v_assignee IS NULL OR v_deadline IS NULL
    OR jsonb_typeof(v->'title') IS DISTINCT FROM 'string' OR char_length(v->>'title') NOT BETWEEN 1 AND 200 OR v->>'title' ~ '[\x01-\x1f\x7f]'
    OR jsonb_typeof(v->'description') IS DISTINCT FROM 'string' OR char_length(v->>'description')>4000
    OR v->>'priority' IS NULL OR v->>'priority' NOT IN ('NORMAL','LOW','URGENT') THEN
    RAISE EXCEPTION 'hermes_task_invalid' USING ERRCODE='22023'; END IF;
  IF NOT (v_building IN (SELECT jsonb_array_elements_text(ctx->'buildingIds')::uuid)) THEN RETURN jsonb_build_object('kind','rejected','reason','not_allowed'); END IF;
  SELECT b.name INTO v_building_name FROM public.buildings b WHERE b.id=v_building AND b.organization_id=v_org AND b.deleted_at IS NULL
    AND NOT COALESCE(b.is_virtual,false);
  IF NOT FOUND THEN RETURN jsonb_build_object('kind','rejected','reason','not_allowed'); END IF;
  IF v_room IS NOT NULL THEN
    SELECT r.name INTO v_room_name FROM public.rooms r WHERE r.id=v_room AND r.building_id=v_building AND r.deleted_at IS NULL;
    IF NOT FOUND THEN RETURN jsonb_build_object('kind','rejected','reason','not_allowed'); END IF;
  END IF;
  SELECT j.name INTO v_type_name FROM public.job_types j WHERE j.id=v_type AND j.organization_id=v_org AND COALESCE(j.is_active,true);
  IF NOT FOUND THEN RETURN jsonb_build_object('kind','rejected','reason','state_changed'); END IF;
  IF NOT COALESCE(app_private.hermes_task_assignee_member_v1(v_assignee,v_org),false) THEN RETURN jsonb_build_object('kind','rejected','reason','not_allowed'); END IF;
  IF v_deadline<=clock_timestamp() THEN RETURN jsonb_build_object('kind','needs_input','reason','date_out_of_range'); END IF;
  SELECT p.full_name INTO v_assignee_name FROM public.profiles p WHERE p.id=v_assignee;

  v_dups:=public.job_open_duplicates_v1(v_org,v_building,v_room,v_type);
  IF v_assignee<>v_actor THEN
    PERFORM app_private.lock_org_for_decision_v1(v_org);
    v_manages:=COALESCE((SELECT a.allowed FROM app_private.authorize_tenant_action_v3(v_assignee,v_org,'tasks.edit',v_building,NULL) a),false);
  END IF;
  v_basis:=md5(jsonb_build_array(p_action,v_building,v_room,v_type,v_assignee,v_deadline,v->>'title',v->>'description',v->>'priority',
    v_building_name,(SELECT jsonb_agg(e->'id' ORDER BY e->>'id') FROM jsonb_array_elements(v_dups) e),v_manages)::text);
  IF p_phase='apply' AND p_expected_basis IS DISTINCT FROM v_basis THEN RETURN jsonb_build_object('kind','rejected','reason','state_changed'); END IF;

  IF p_phase<>'apply' THEN
    v_confirm:=p_phase='preview' OR COALESCE(ctx->>'confirm','always')<>'never' OR v_assignee<>v_actor
      OR v->'jobTypeGuessed'='true'::jsonb OR v->'roomMissing'='true'::jsonb OR jsonb_array_length(v_dups)>0
      OR v->'assigneeSuggested'='true'::jsonb OR NOT v_manages;
    IF v_confirm THEN
      IF v->'jobTypeGuessed'='true'::jsonb THEN v_warnings:=v_warnings||to_jsonb(format('Loại việc ''%s'' do bot chọn theo nội dung.',v_type_name)); END IF;
      IF v->'roomMissing'='true'::jsonb THEN v_warnings:=v_warnings||to_jsonb('Chưa nêu phòng: việc cho CẢ TOÀ.'::text); END IF;
      FOR v_dup IN SELECT e FROM jsonb_array_elements(v_dups) e LIMIT 3 LOOP
        v_warnings:=v_warnings||to_jsonb(left(format('Đã có việc %s ''%s'' đang mở ở chỗ này (giao %s, hạn %s) — vẫn tạo thêm?',
          COALESCE(v_dup->>'code','—'),left(v_dup->>'title',80),
          COALESCE((SELECT p.full_name FROM public.profiles p WHERE p.id=(v_dup->>'assigneeId')::uuid),'chưa ai'),
          COALESCE(to_char((v_dup->>'deadline')::timestamptz AT TIME ZONE app_private.org_timezone_v1(v_org),'DD/MM'),'không hạn')),300));
      END LOOP;
      IF NOT v_manages THEN v_warnings:=v_warnings||to_jsonb(left(format('%s không có quyền công việc ở toà %s: vẫn thấy việc nhưng không sửa/hoàn thành được trên web.',
        COALESCE(v_assignee_name,'Người nhận'),v_building_name),300)); END IF;
      v_who:=CASE WHEN v_assignee=v_actor THEN 'chính anh/chị' ELSE COALESCE(v_assignee_name,'(không xem được tên)') END;
      v_place:='toà '||v_building_name||CASE WHEN v_room IS NOT NULL THEN ', phòng '||v_room_name ELSE ', cả toà' END;
      v_text:=CASE WHEN v->'assigneeSuggested'='true'::jsonb
          THEN format('Chưa nêu người nhận — đề xuất giao %s (quản lý toà %s). ',v_who,v_building_name) ELSE '' END
        ||format('Tạo việc ''%s'' (loại %s) — %s — giao %s — hạn %s — ưu tiên %s.',v->>'title',v_type_name,v_place,v_who,
          app_private.hermes_task_when_v1(v_org,v_deadline,v->'deadlineDefaulted'='true'::jsonb),
          CASE v->>'priority' WHEN 'URGENT' THEN 'Gấp' WHEN 'LOW' THEN 'Thấp' ELSE 'Bình thường' END);
      RETURN jsonb_build_object('kind','preview','basis',v_basis,'resolved',v,'confirm','required','warnings',v_warnings,
        'preview',jsonb_strip_nulls(jsonb_build_object('text',v_text,'building',v_building_name,'room',v_room_name,
          'wholeBuilding',v_room IS NULL,'jobType',v_type_name,'jobTypeGuessed',v->'jobTypeGuessed','title',v->>'title',
          'assignee',v_who,'assigneeSelf',v_assignee=v_actor,'assigneeSuggested',v->'assigneeSuggested','assigneeManagesBuilding',v_manages,
          'deadline',to_char(v_deadline AT TIME ZONE app_private.org_timezone_v1(v_org),'YYYY-MM-DD HH24:MI'),
          'deadlineDefaulted',v->'deadlineDefaulted','priority',v->>'priority','duplicates',jsonb_array_length(v_dups))));
    END IF;
  END IF;

  -- Lượt ghi. Hạn mức kiểm TRƯỚC khi mở biên nhận: từ chối trước khi ghi, không chốt (cùng requestId gọi lại sau được).
  v_quota:=app_private.hermes_task_quota_v1(v_org,v_actor,ARRAY[v_assignee]);
  IF v_quota IS NOT NULL THEN RETURN jsonb_build_object('kind','rejected','reason',v_quota); END IF;
  v_begin:=app_private.hermes_action_receipt_begin_v1(p_binding,p_action,p_request_id,jsonb_build_object('params',p_params,'resolved',v));
  IF v_begin->>'state'='replay' THEN RETURN jsonb_build_object('kind','replay','outcome',v_begin->'result'); END IF;
  IF v_begin->>'state'='conflict' THEN RETURN jsonb_build_object('kind','rejected','reason','request_conflict'); END IF;
  IF v_begin->>'state' IS DISTINCT FROM 'new' THEN RAISE EXCEPTION 'hermes_action_outcome_unknown' USING ERRCODE='PT409'; END IF;
  RETURN jsonb_build_object('kind','write','action',p_action,'requestId',p_request_id,'organizationId',v_org,'actorId',v_actor,
    'connectionId',ctx->'connectionId','jobId',gen_random_uuid(),'startedAt',clock_timestamp(),
    'job',jsonb_build_object('buildingId',v_building,'roomId',v_room,'jobTypeId',v_type,'assigneeId',v_assignee,'deadline',v_deadline,
      'title',v->>'title','description',v->>'description','priority',v->>'priority'),
    'deadlineDefaulted',v->'deadlineDefaulted');
END $fn$;

-- 4c. Ghi (INVOKER, chạy dưới vai authenticated với JWT người dùng): INSERT jobs như web, chịu RLS + trigger. Lỗi tạm RAISE lại
-- (cả giao dịch lùi, kể cả biên nhận vừa mở); lỗi khác trả về để bước chốt ánh xạ lý do và chốt biên nhận. Chỉ tham chiếu public.*.
CREATE OR REPLACE FUNCTION app_private.hermes_task_action_write_v1(p_plan jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,public AS $fn$
DECLARE v_job jsonb; v_id uuid; v_constraint text;
BEGIN
  IF p_plan IS NULL OR p_plan->>'kind' IS DISTINCT FROM 'write' THEN RETURN p_plan; END IF;
  IF current_user<>'authenticated' OR auth.uid() IS NULL OR p_plan->>'actorId' IS DISTINCT FROM auth.uid()::text THEN
    RAISE EXCEPTION 'hermes_task_denied' USING ERRCODE='42501'; END IF;
  v_job:=p_plan->'job';
  BEGIN
    INSERT INTO public.jobs(id,user_id,organization_id,title,description,building_id,room_id,job_type_id,priority,assignee_id,assignee_name,deadline,
      status,started_at,visible_to_customer,attachments)
    VALUES((p_plan->>'jobId')::uuid,auth.uid(),(p_plan->>'organizationId')::uuid,v_job->>'title',v_job->>'description',(v_job->>'buildingId')::uuid,
      (v_job->>'roomId')::uuid,(v_job->>'jobTypeId')::uuid,v_job->>'priority',(v_job->>'assigneeId')::uuid,NULL,(v_job->>'deadline')::timestamptz,
      'IN_PROGRESS',(p_plan->>'startedAt')::timestamptz,false,NULL) RETURNING id INTO v_id;
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE IN ('40001','40P01','55P03','PT409') THEN RAISE; END IF;
    GET STACKED DIAGNOSTICS v_constraint=CONSTRAINT_NAME;
    RETURN p_plan||jsonb_build_object('kind','write_failed','sqlstate',SQLSTATE,'message',left(SQLERRM,200),'constraint',NULLIF(v_constraint,''));
  END;
  IF v_id IS DISTINCT FROM (p_plan->>'jobId')::uuid THEN RAISE EXCEPTION 'hermes_task_receipt_invalid' USING ERRCODE='PT409'; END IF;
  RETURN p_plan||jsonb_build_object('kind','written');
END $fn$;

-- 4d. Chốt (DEFINER): kết cục không ghi đi thẳng; lỗi hàm ghi ⇒ lý do đóng + chốt rejected; đã ghi ⇒ đối chiếu hàng vừa ghi với
-- kế hoạch, ghi sổ việc, audit HERMES_TASK_CREATED, chốt applied. Lệch ⇒ RAISE (cả giao dịch lùi).
CREATE OR REPLACE FUNCTION app_private.hermes_task_action_finish_v1(p_binding jsonb,p_action text,p_plan jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_job public.jobs; v_plan jsonb:=p_plan->'job'; v_org uuid; v_outcome jsonb; v_building text; v_room text; v_assignee text; v_when text;
BEGIN
  IF p_plan IS NULL OR jsonb_typeof(p_plan)<>'object' THEN RAISE EXCEPTION 'hermes_task_invalid' USING ERRCODE='22023'; END IF;
  IF p_plan->>'kind' IN ('preview','needs_input','rejected') THEN RETURN p_plan; END IF;
  IF p_plan->>'kind'='replay' THEN RETURN p_plan->'outcome'; END IF;
  IF p_plan->>'action' IS DISTINCT FROM p_action OR p_plan->>'actorId' IS DISTINCT FROM auth.uid()::text THEN
    RAISE EXCEPTION 'hermes_task_receipt_invalid' USING ERRCODE='PT409'; END IF;
  IF p_plan->>'kind'='write_failed' THEN
    RETURN app_private.hermes_action_receipt_finish_v1(p_binding,p_action,(p_plan->>'requestId')::uuid,
      jsonb_build_object('kind','rejected','reason',app_private.hermes_action_reason_v1(p_plan->>'sqlstate',p_plan->>'message',p_plan->>'constraint')),
      p_plan->>'sqlstate',p_plan->>'message');
  END IF;
  IF p_plan->>'kind' IS DISTINCT FROM 'written' THEN RAISE EXCEPTION 'hermes_task_invalid' USING ERRCODE='22023'; END IF;
  v_org:=(p_plan->>'organizationId')::uuid;
  SELECT * INTO v_job FROM public.jobs WHERE id=(p_plan->>'jobId')::uuid FOR SHARE;
  IF NOT FOUND OR v_job.user_id IS DISTINCT FROM auth.uid() OR v_job.organization_id IS DISTINCT FROM v_org
    OR v_job.building_id IS DISTINCT FROM (v_plan->>'buildingId')::uuid OR v_job.room_id IS DISTINCT FROM (v_plan->>'roomId')::uuid
    OR v_job.job_type_id IS DISTINCT FROM (v_plan->>'jobTypeId')::uuid OR v_job.assignee_id IS DISTINCT FROM (v_plan->>'assigneeId')::uuid
    OR v_job.assignee_name IS NOT NULL OR v_job.deadline IS DISTINCT FROM (v_plan->>'deadline')::timestamptz
    OR v_job.title IS DISTINCT FROM v_plan->>'title' OR v_job.description IS DISTINCT FROM v_plan->>'description'
    OR v_job.priority IS DISTINCT FROM v_plan->>'priority' OR v_job.status IS DISTINCT FROM 'IN_PROGRESS' OR v_job.code IS NULL
    OR v_job.completion_time IS NOT NULL OR v_job.attachments IS NOT NULL THEN
    RAISE EXCEPTION 'hermes_task_receipt_invalid' USING ERRCODE='PT409'; END IF;
  INSERT INTO app_private.hermes_task_jobs(job_id,organization_id,actor_id,assignee_id,request_id,action,source)
    VALUES(v_job.id,v_org,v_job.user_id,v_job.assignee_id,(p_plan->>'requestId')::uuid,p_action,'action');
  PERFORM app_private.append_authz_audit_v1(v_org,'HERMES_TASK_CREATED','job',v_job.id,NULL,
    jsonb_build_object('actor',auth.uid(),'connectionId',p_plan->'connectionId','requestId',p_plan->'requestId','jobId',v_job.id,
      'code',v_job.code,'assigneeId',v_job.assignee_id,'action',p_action),'Hermes shared task create');
  SELECT b.name INTO v_building FROM public.buildings b WHERE b.id=v_job.building_id;
  SELECT r.name INTO v_room FROM public.rooms r WHERE r.id=v_job.room_id;
  SELECT p.full_name INTO v_assignee FROM public.profiles p WHERE p.id=v_job.assignee_id;
  v_when:=app_private.hermes_task_when_v1(v_org,v_job.deadline,p_plan->'deadlineDefaulted'='true'::jsonb);
  v_outcome:=jsonb_build_object('kind','applied','link','/tasks?job='||v_job.id::text,'result',jsonb_strip_nulls(jsonb_build_object(
    'text',format('Đã tạo việc %s ''%s'' — toà %s%s — giao %s — hạn %s.',v_job.code,v_job.title,v_building,
      CASE WHEN v_room IS NOT NULL THEN ', phòng '||v_room ELSE ', cả toà' END,
      CASE WHEN v_job.assignee_id=auth.uid() THEN 'chính anh/chị' ELSE COALESCE(v_assignee,'(không xem được tên)') END,v_when),
    'job',jsonb_strip_nulls(jsonb_build_object('code',v_job.code,'title',v_job.title,'building',v_building,'room',v_room,
      'wholeBuilding',v_job.room_id IS NULL,'assignee',CASE WHEN v_job.assignee_id=auth.uid() THEN 'chính anh/chị' ELSE v_assignee END,
      'assigneeSelf',v_job.assignee_id=auth.uid(),
      'deadline',to_char(v_job.deadline AT TIME ZONE app_private.org_timezone_v1(v_org),'YYYY-MM-DD HH24:MI'),'deadlineText',v_when,
      'priority',v_job.priority)),
    'deadlineDefaulted',p_plan->'deadlineDefaulted')));
  RETURN app_private.hermes_action_receipt_finish_v1(p_binding,p_action,(p_plan->>'requestId')::uuid,v_outcome);
END $fn$;

-- 4e. Vỏ public: INVOKER, thân SQL-standard; guard, lõi giải tên, hàm người quản lý toà và ba tầng gắn OID lúc tạo. Đầu hàm theo
-- khuôn lane migrate:forward nhận cho thân ghi; câu lệnh ghim băm ở scripts/hermes-task-function-contract.mjs. Tên người quản lý
-- đọc dưới RLS hồ sơ của người hỏi (chỉ người họ thấy được).
CREATE OR REPLACE FUNCTION public.hermes_task_action_v1(p_binding jsonb,p_action text,p_phase text,p_request_id uuid,p_params jsonb,
  p_resolved jsonb DEFAULT NULL,p_expected_basis text DEFAULT NULL)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,public
BEGIN ATOMIC
  WITH g AS MATERIALIZED (SELECT app_private.hermes_action_guard_v1(p_binding,p_action) AS ctx),
  r AS MATERIALIZED (SELECT g.ctx,CASE WHEN p_phase IN ('preview','auto') THEN app_private.hermes_task_resolve_core_v1(g.ctx,p_action,p_params) END AS resolution FROM g),
  i AS MATERIALIZED (SELECT r.resolution,CASE WHEN r.resolution->>'status'='resolved' AND r.resolution->'personMissing'='true'::jsonb THEN
      app_private.hermes_task_building_managers_v1((r.ctx->>'organizationId')::uuid,(r.resolution#>>'{building,id}')::uuid) END AS ids FROM r),
  m AS MATERIALIZED (SELECT i.resolution,CASE WHEN i.ids IS NOT NULL THEN
      (SELECT COALESCE(jsonb_agg(jsonb_build_object('id',p.id,'name',p.full_name) ORDER BY p.full_name,p.id),'[]'::jsonb) FROM public.profiles p
        WHERE p.full_name IS NOT NULL AND btrim(p.full_name)<>'' AND p.id=ANY(i.ids)) END AS managers FROM i)
  SELECT app_private.hermes_task_action_finish_v1(p_binding,p_action,
    app_private.hermes_task_action_write_v1(
      app_private.hermes_task_action_prepare_v1(p_binding,p_action,p_phase,p_request_id,p_params,p_resolved,p_expected_basis,m.resolution,m.managers))) FROM m;
END;

ALTER FUNCTION public.job_deadline_v1(uuid,date,time) OWNER TO postgres;
ALTER FUNCTION public.job_open_duplicates_v1(uuid,uuid,uuid,uuid) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_task_building_managers_v1(uuid,uuid) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_task_quota_v1(uuid,uuid,uuid[]) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_task_when_v1(uuid,timestamptz,boolean) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_task_resolve_core_v1(jsonb,text,jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_task_action_prepare_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb,jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_task_action_write_v1(jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_task_action_finish_v1(jsonb,text,jsonb) OWNER TO postgres;
ALTER FUNCTION public.hermes_task_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.job_deadline_v1(uuid,date,time) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION public.job_open_duplicates_v1(uuid,uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION app_private.hermes_task_building_managers_v1(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION app_private.hermes_task_quota_v1(uuid,uuid,uuid[]) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION app_private.hermes_task_when_v1(uuid,timestamptz,boolean) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION app_private.hermes_task_resolve_core_v1(jsonb,text,jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION app_private.hermes_task_action_prepare_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION app_private.hermes_task_action_write_v1(jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION app_private.hermes_task_action_finish_v1(jsonb,text,jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION public.hermes_task_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
-- Vỏ chạy dưới vai authenticated: cần EXECUTE trên đúng các hàm nó gắn OID (tới qua OID, không qua tên) và hai hàm public dùng
-- chung mà lõi giải tên gọi. Hạn mức, câu ngày, biên nhận, ánh xạ lý do chỉ hàm DEFINER gọi: không cấp.
GRANT EXECUTE ON FUNCTION public.job_deadline_v1(uuid,date,time) TO authenticated;
GRANT EXECUTE ON FUNCTION public.job_open_duplicates_v1(uuid,uuid,uuid,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION app_private.hermes_task_building_managers_v1(uuid,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION app_private.hermes_task_resolve_core_v1(jsonb,text,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION app_private.hermes_task_action_prepare_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION app_private.hermes_task_action_write_v1(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION app_private.hermes_task_action_finish_v1(jsonb,text,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.hermes_task_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text) TO authenticated;

DO $check$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM app_private.hermes_action_policies WHERE action='task.create' AND capability='tasks.create'
      AND crm_permission='tasks.create' AND action_class='reversible')
    OR NOT EXISTS(SELECT 1 FROM app_private.hermes_task_limits WHERE organization_id IS NULL AND tier='member')
    OR NOT EXISTS(SELECT 1 FROM app_private.hermes_task_limits WHERE organization_id IS NULL AND tier='owner')
    -- Vỏ public: INVOKER + thân SQL-standard (OID gắn lúc tạo), không phải plpgsql tra app_private lúc chạy.
    OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.hermes_task_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text)'::regprocedure
      AND NOT prosecdef AND prosqlbody IS NOT NULL)
    OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='app_private.hermes_task_action_prepare_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb,jsonb)'::regprocedure AND prosecdef)
    OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='app_private.hermes_task_action_finish_v1(jsonb,text,jsonb)'::regprocedure AND prosecdef)
    OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='app_private.hermes_task_building_managers_v1(uuid,uuid)'::regprocedure AND prosecdef)
    -- Tầng ghi và lõi giải tên PHẢI là INVOKER: RLS jobs/profiles của người hỏi là hàng rào.
    OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='app_private.hermes_task_action_write_v1(jsonb)'::regprocedure AND NOT prosecdef)
    OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='app_private.hermes_task_resolve_core_v1(jsonb,text,jsonb)'::regprocedure AND NOT prosecdef)
    OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.job_open_duplicates_v1(uuid,uuid,uuid,uuid)'::regprocedure AND NOT prosecdef)
    OR has_function_privilege('anon','public.hermes_task_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text)','EXECUTE')
    OR has_function_privilege('anon','public.job_deadline_v1(uuid,date,time)','EXECUTE')
    OR has_function_privilege('authenticated','app_private.hermes_task_quota_v1(uuid,uuid,uuid[])','EXECUTE')
    OR has_function_privilege('authenticated','app_private.hermes_task_when_v1(uuid,timestamptz,boolean)','EXECUTE')
    OR has_table_privilege('authenticated','app_private.hermes_task_jobs','SELECT')
    OR has_table_privilege('authenticated','app_private.hermes_task_limits','SELECT') THEN
    RAISE EXCEPTION 'hermes_task_action_check_failed'; END IF;
END $check$;

COMMIT;
NOTIFY pgrst,'reload schema';
