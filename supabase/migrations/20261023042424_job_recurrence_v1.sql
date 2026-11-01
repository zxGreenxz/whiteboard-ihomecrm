-- Việc định kỳ (CRM, tính năng mới) — Đợt 2b Công việc Mốc 5 (23/10/2026; docs/plans/hermes-crm/CONG-VIEC-THAO-TAC-GHI.md mục 5, 22).
-- Phần dùng chung của CRM, web gọi lại được về sau (Q40 = b: chưa có giao diện): hai bảng, RLS soi gương jobs, trigger kiểm/chuẩn hoá,
-- hàm ngày sinh, câu mô tả lịch, bốn hàm ghi (tạo / sửa / tạm dừng-chạy lại / xoá mềm). Bộ sinh việc ở migration kế tiếp.
--  * public.job_recurrence_rules: một quy tắc = một việc mẫu (toà, phòng, loại, tiêu đề, người nhận, ưu tiên) + lịch (daily / weekly /
--    monthly, mỗi N, thứ trong tuần ISO 1–7, ngày trong tháng -1–31 với -1 = cuối tháng, từ ngày, tới ngày, hạn = ngày sinh + N ngày).
--    Mã DK-NNNN theo công ty. Xoá là xoá mềm (deleted_at): giữ lịch sử lần sinh. Tạm dừng có lý do (user / permission_lost /
--    membership_lost / target_deleted). version tăng khi cột người dùng thấy đổi (CAS cho web và Hermes).
--  * public.job_recurrence_occurrences: khoá tự nhiên (quy tắc, ngày) — một quy tắc không bao giờ sinh hai việc cho một ngày.
--  * RLS: SELECT như jobs (buildings.view qua accessible_building_ids); INSERT đòi tasks.create ở toà, UPDATE tasks.edit hoặc
--    tasks.delete ở toà (app_private.buildings_for_v3 như jobs) + ranh giới công ty. Trigger (DEFINER, chỉ khi vai API) kiểm lại đúng
--    khoá: xoá mềm đòi tasks.delete, đổi khác đòi tasks.edit (authorize_tenant_action_v3); cột bất biến; trần 100 quy tắc đang chạy
--    mỗi công ty; cấp mã dưới khoá tư vấn theo công ty. Vai API chỉ có quyền cột ghi được (không DELETE).
--  * Hàm ghi INVOKER, search_path rỗng: chạy dưới RLS người gọi (Hermes gọi từ tầng ghi INVOKER, web gọi thẳng).
-- Không DROP, không ghi dữ liệu nghiệp vụ. Idempotent.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $requires$
BEGIN
  IF to_regclass('public.jobs') IS NULL OR to_regclass('public.buildings') IS NULL OR to_regclass('public.rooms') IS NULL
    OR to_regclass('public.job_types') IS NULL OR to_regclass('public.organizations') IS NULL
    OR to_regprocedure('app_private.buildings_for_v3(text)') IS NULL
    OR to_regprocedure('app_private.authorize_tenant_action_v3(uuid,uuid,text,uuid,uuid)') IS NULL
    OR to_regprocedure('public.accessible_building_ids()') IS NULL OR to_regprocedure('public.has_full_building_scope()') IS NULL
    OR to_regprocedure('public.is_super_admin()') IS NULL OR to_regprocedure('public.is_admin()') IS NULL
    OR to_regprocedure('public.my_org_ids()') IS NULL OR to_regprocedure('public.org_today_v1(uuid)') IS NULL THEN
    RAISE EXCEPTION 'job_recurrence_dependency_invalid'; END IF;
END $requires$;

-- 1. Bảng quy tắc.
CREATE TABLE IF NOT EXISTS public.job_recurrence_rules(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  code text NOT NULL CHECK (code ~ '^DK-[0-9]{4,9}$'),
  building_id uuid NOT NULL REFERENCES public.buildings(id) ON DELETE CASCADE,
  room_id uuid,
  job_type_id uuid NOT NULL,
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 200 AND title !~ '[\x01-\x1f\x7f]'),
  description text CHECK (description IS NULL OR char_length(description)<=4000),
  assignee_id uuid,
  priority text NOT NULL DEFAULT 'NORMAL' CHECK (priority IN ('NORMAL','LOW','URGENT')),
  frequency text NOT NULL CHECK (frequency IN ('daily','weekly','monthly')),
  every smallint NOT NULL DEFAULT 1 CHECK (every BETWEEN 1 AND 12),
  weekdays smallint[] CHECK (weekdays IS NULL OR (cardinality(weekdays) BETWEEN 1 AND 7 AND weekdays <@ ARRAY[1,2,3,4,5,6,7]::smallint[])),
  month_day smallint CHECK (month_day IS NULL OR month_day=-1 OR month_day BETWEEN 1 AND 31),
  start_date date NOT NULL,
  end_date date,
  due_days smallint NOT NULL DEFAULT 0 CHECK (due_days BETWEEN 0 AND 30),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  paused_at timestamptz,
  paused_reason text CHECK (paused_reason IS NULL OR paused_reason IN ('user','permission_lost','membership_lost','target_deleted')),
  deleted_at timestamptz,
  last_generated_date date,
  CONSTRAINT job_recurrence_rules_code_key UNIQUE (organization_id,code),
  CONSTRAINT job_recurrence_rules_paused_reason CHECK ((paused_at IS NULL)=(paused_reason IS NULL)),
  CONSTRAINT job_recurrence_rules_end_after_start CHECK (end_date IS NULL OR end_date>=start_date),
  CONSTRAINT job_recurrence_rules_schedule CHECK ((frequency='daily' AND weekdays IS NULL AND month_day IS NULL)
    OR (frequency='weekly' AND weekdays IS NOT NULL AND month_day IS NULL) OR (frequency='monthly' AND weekdays IS NULL AND month_day IS NOT NULL)));
CREATE INDEX IF NOT EXISTS job_recurrence_rules_running_idx ON public.job_recurrence_rules(organization_id) WHERE deleted_at IS NULL AND paused_at IS NULL;
CREATE INDEX IF NOT EXISTS job_recurrence_rules_building_idx ON public.job_recurrence_rules(building_id);

-- 2. Bảng lần sinh: khoá (quy tắc, ngày) chống sinh trùng; việc bị xoá thì job_id về NULL, lần sinh vẫn còn (không sinh lại).
CREATE TABLE IF NOT EXISTS public.job_recurrence_occurrences(
  rule_id uuid NOT NULL REFERENCES public.job_recurrence_rules(id) ON DELETE CASCADE,
  occurrence_date date NOT NULL,
  organization_id uuid NOT NULL,
  job_id uuid REFERENCES public.jobs(id) ON DELETE SET NULL,
  outcome text NOT NULL CHECK (outcome IN ('generated','skipped')),
  reason text CHECK (reason IS NULL OR reason IN ('permission_lost','membership_lost','target_deleted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (rule_id,occurrence_date));
CREATE INDEX IF NOT EXISTS job_recurrence_occurrences_job_idx ON public.job_recurrence_occurrences(job_id) WHERE job_id IS NOT NULL;

-- 3. Trigger kiểm + chuẩn hoá (DEFINER: đếm trần / cấp mã / kiểm đúng khoá không phụ thuộc RLS người gọi). Hai trigger cùng hàm:
--    'api' khi vai API (authenticated/anon) ghi — kiểm quyền, cột bất biến, ngày bắt đầu; 'system' khi hàm DEFINER (bộ sinh) ghi.
CREATE OR REPLACE FUNCTION app_private.job_recurrence_guard_v1()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $fn$
DECLARE v_api boolean:=TG_ARGV[0]='api'; v_actor uuid:=auth.uid(); v_today date; v_n integer; v_need text;
BEGIN
  IF TG_OP='INSERT' THEN
    IF v_api THEN
      IF v_actor IS NULL THEN RAISE EXCEPTION 'job_recurrence_denied' USING ERRCODE='42501'; END IF;
      NEW.created_by:=v_actor;
    ELSIF NEW.created_by IS NULL THEN RAISE EXCEPTION 'job_recurrence_invalid' USING ERRCODE='22023';
    END IF;
    v_today:=public.org_today_v1(NEW.organization_id);
    NEW.start_date:=COALESCE(NEW.start_date,v_today);
    IF v_api AND NEW.start_date<v_today THEN RAISE EXCEPTION 'job_recurrence_start_past' USING ERRCODE='22023'; END IF;
  ELSE
    IF OLD.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'job_recurrence_deleted' USING ERRCODE='22023'; END IF;
    IF NEW.id<>OLD.id OR NEW.organization_id<>OLD.organization_id OR NEW.code<>OLD.code OR NEW.building_id<>OLD.building_id
      OR NEW.room_id IS DISTINCT FROM OLD.room_id OR NEW.job_type_id<>OLD.job_type_id OR NEW.created_by<>OLD.created_by
      OR NEW.created_at<>OLD.created_at THEN
      RAISE EXCEPTION 'job_recurrence_immutable' USING ERRCODE='22023'; END IF;
    v_today:=public.org_today_v1(NEW.organization_id);
    IF v_api THEN
      IF v_actor IS NULL THEN RAISE EXCEPTION 'job_recurrence_denied' USING ERRCODE='42501'; END IF;
      NEW.last_generated_date:=OLD.last_generated_date; NEW.version:=OLD.version;
      -- Xoá mềm đòi tasks.delete và chỉ được đổi đúng deleted_at; đổi khác đòi tasks.edit (cùng hàm quyền mà policy dựa vào).
      v_need:=CASE WHEN NEW.deleted_at IS NOT NULL THEN 'tasks.delete' ELSE 'tasks.edit' END;
      IF NOT COALESCE(public.is_super_admin(),false) AND NOT COALESCE((SELECT a.allowed FROM app_private.authorize_tenant_action_v3(v_actor,
          OLD.organization_id,v_need,OLD.building_id,NULL) a),false) THEN
        RAISE EXCEPTION 'job_recurrence_denied' USING ERRCODE='42501'; END IF;
      IF NEW.deleted_at IS NOT NULL THEN
        IF pg_catalog.to_jsonb(NEW)-'deleted_at' IS DISTINCT FROM pg_catalog.to_jsonb(OLD)-'deleted_at' THEN
          RAISE EXCEPTION 'job_recurrence_invalid' USING ERRCODE='22023'; END IF;
        NEW.deleted_at:=now(); NEW.version:=OLD.version+1; NEW.updated_at:=now();
        RETURN NEW;
      END IF;
      -- Tạm dừng (lý do user) / chạy lại (không bù các ngày đã dừng: lần sinh kế tiếp tính từ hôm nay).
      IF (NEW.paused_at IS NULL) IS DISTINCT FROM (OLD.paused_at IS NULL) THEN
        IF NEW.paused_at IS NOT NULL THEN NEW.paused_at:=now(); NEW.paused_reason:='user';
        ELSE NEW.paused_reason:=NULL;
          NEW.last_generated_date:=GREATEST(COALESCE(OLD.last_generated_date,OLD.start_date-1),v_today-1);
        END IF;
      ELSE NEW.paused_at:=OLD.paused_at; NEW.paused_reason:=OLD.paused_reason;
      END IF;
      IF NEW.start_date IS DISTINCT FROM OLD.start_date AND NEW.start_date<v_today THEN
        RAISE EXCEPTION 'job_recurrence_start_past' USING ERRCODE='22023'; END IF;
    END IF;
  END IF;
  -- Chuẩn hoá lịch (cả hai đường): daily bỏ thứ/ngày; weekly mặc định thứ của ngày bắt đầu; monthly mặc định ngày của ngày bắt đầu.
  NEW.title:=pg_catalog.btrim(NEW.title); NEW.description:=NULLIF(pg_catalog.btrim(NEW.description),'');
  IF NEW.frequency='daily' THEN NEW.weekdays:=NULL; NEW.month_day:=NULL;
  ELSIF NEW.frequency='weekly' THEN
    NEW.month_day:=NULL;
    NEW.weekdays:=COALESCE((SELECT pg_catalog.array_agg(DISTINCT x ORDER BY x) FROM pg_catalog.unnest(NEW.weekdays) x WHERE x IS NOT NULL),
      ARRAY[pg_catalog.date_part('isodow',NEW.start_date)::smallint]);
  ELSIF NEW.frequency='monthly' THEN
    NEW.weekdays:=NULL; NEW.month_day:=COALESCE(NEW.month_day,pg_catalog.date_part('day',NEW.start_date)::smallint);
  END IF;
  IF TG_OP='INSERT' THEN
    IF NOT EXISTS(SELECT 1 FROM public.buildings b WHERE b.id=NEW.building_id AND b.organization_id=NEW.organization_id AND b.deleted_at IS NULL
        AND NOT COALESCE(b.is_virtual,false))
      OR (NEW.room_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.rooms r WHERE r.id=NEW.room_id AND r.building_id=NEW.building_id
        AND r.deleted_at IS NULL))
      OR NOT EXISTS(SELECT 1 FROM public.job_types j WHERE j.id=NEW.job_type_id AND j.organization_id=NEW.organization_id
        AND COALESCE(j.is_active,true)) THEN
      RAISE EXCEPTION 'job_recurrence_target_invalid' USING ERRCODE='22023'; END IF;
    -- Trần + mã dưới cùng khoá tư vấn theo công ty: hai lần tạo song song không vượt trần, không trùng mã.
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('job_recurrence:'||NEW.organization_id::text,0));
    SELECT count(*) INTO v_n FROM public.job_recurrence_rules r WHERE r.organization_id=NEW.organization_id AND r.deleted_at IS NULL
      AND r.paused_at IS NULL AND (r.end_date IS NULL OR r.end_date>=v_today);
    IF v_n>=100 THEN RAISE EXCEPTION 'job_recurrence_limit' USING ERRCODE='54000'; END IF;
    SELECT COALESCE(max(pg_catalog.substr(r.code,4)::integer),0)+1 INTO v_n FROM public.job_recurrence_rules r
      WHERE r.organization_id=NEW.organization_id AND r.code ~ '^DK-[0-9]{1,9}$';
    NEW.code:='DK-'||pg_catalog.lpad(v_n::text,4,'0');
    NEW.version:=1; NEW.created_at:=now(); NEW.updated_at:=now(); NEW.paused_at:=NULL; NEW.paused_reason:=NULL; NEW.deleted_at:=NULL;
    NEW.last_generated_date:=NEW.start_date-1;
  ELSIF pg_catalog.to_jsonb(NEW)-ARRAY['last_generated_date','updated_at','version'] IS DISTINCT FROM
        pg_catalog.to_jsonb(OLD)-ARRAY['last_generated_date','updated_at','version'] THEN
    NEW.version:=OLD.version+1; NEW.updated_at:=now();
  ELSE NEW.version:=OLD.version;
  END IF;
  RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS job_recurrence_rules_api_guard ON public.job_recurrence_rules;
DROP TRIGGER IF EXISTS job_recurrence_rules_system_guard ON public.job_recurrence_rules;
CREATE TRIGGER job_recurrence_rules_api_guard BEFORE INSERT OR UPDATE ON public.job_recurrence_rules FOR EACH ROW
  WHEN (current_user IN ('authenticated','anon')) EXECUTE FUNCTION app_private.job_recurrence_guard_v1('api');
CREATE TRIGGER job_recurrence_rules_system_guard BEFORE INSERT OR UPDATE ON public.job_recurrence_rules FOR EACH ROW
  WHEN (current_user NOT IN ('authenticated','anon')) EXECUTE FUNCTION app_private.job_recurrence_guard_v1('system');

-- 4. RLS (soi gương policy jobs đọc 23/10 trên production).
ALTER TABLE public.job_recurrence_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.job_recurrence_occurrences ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS job_recurrence_rules_org_boundary ON public.job_recurrence_rules;
DROP POLICY IF EXISTS job_recurrence_rules_select ON public.job_recurrence_rules;
DROP POLICY IF EXISTS job_recurrence_rules_insert ON public.job_recurrence_rules;
DROP POLICY IF EXISTS job_recurrence_rules_update ON public.job_recurrence_rules;
DROP POLICY IF EXISTS job_recurrence_occurrences_select ON public.job_recurrence_occurrences;
CREATE POLICY job_recurrence_rules_org_boundary ON public.job_recurrence_rules AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_super_admin()) OR organization_id IN (SELECT pg_catalog.unnest(public.my_org_ids())))
  WITH CHECK ((SELECT public.is_super_admin()) OR organization_id IN (SELECT pg_catalog.unnest(public.my_org_ids())));
CREATE POLICY job_recurrence_rules_select ON public.job_recurrence_rules FOR SELECT TO authenticated
  USING ((SELECT public.is_super_admin()) OR (SELECT public.is_admin()) OR (SELECT public.has_full_building_scope())
    OR building_id IN (SELECT public.accessible_building_ids()));
CREATE POLICY job_recurrence_rules_insert ON public.job_recurrence_rules FOR INSERT TO authenticated
  WITH CHECK ((SELECT public.is_super_admin()) OR building_id=ANY(app_private.buildings_for_v3('tasks.create'::text)));
CREATE POLICY job_recurrence_rules_update ON public.job_recurrence_rules FOR UPDATE TO authenticated
  USING ((SELECT public.is_super_admin()) OR building_id=ANY(app_private.buildings_for_v3('tasks.edit'::text))
    OR building_id=ANY(app_private.buildings_for_v3('tasks.delete'::text)))
  WITH CHECK ((SELECT public.is_super_admin()) OR building_id=ANY(app_private.buildings_for_v3('tasks.edit'::text))
    OR building_id=ANY(app_private.buildings_for_v3('tasks.delete'::text)));
CREATE POLICY job_recurrence_occurrences_select ON public.job_recurrence_occurrences FOR SELECT TO authenticated
  USING (EXISTS(SELECT 1 FROM public.job_recurrence_rules r WHERE r.id=rule_id));

ALTER TABLE public.job_recurrence_rules OWNER TO postgres;
ALTER TABLE public.job_recurrence_occurrences OWNER TO postgres;
REVOKE ALL ON TABLE public.job_recurrence_rules,public.job_recurrence_occurrences FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON TABLE public.job_recurrence_rules,public.job_recurrence_occurrences TO authenticated;
GRANT INSERT (organization_id,building_id,room_id,job_type_id,title,description,assignee_id,priority,frequency,every,weekdays,month_day,
  start_date,end_date,due_days) ON TABLE public.job_recurrence_rules TO authenticated;
GRANT UPDATE (title,description,assignee_id,priority,frequency,every,weekdays,month_day,start_date,end_date,due_days,paused_at,deleted_at)
  ON TABLE public.job_recurrence_rules TO authenticated;

-- 5. Ngày sinh (thuần): mọi ngày đến hạn trong [p_from, p_to] ∩ [start, end]. Tháng tính từ tháng neo, không cộng dồn: ngày 29–31
--    rơi vào tháng thiếu ⇒ ngày cuối tháng đó, tháng sau trở lại đúng ngày (bài học phiếu định kỳ). Tuần neo theo tuần ISO của ngày
--    bắt đầu. Tối đa 400 ngày một lần gọi.
CREATE OR REPLACE FUNCTION public.job_recurrence_dates_v1(p_frequency text,p_every integer,p_weekdays smallint[],p_month_day integer,
  p_start date,p_end date,p_from date,p_to date)
RETURNS SETOF date LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path='' AS $fn$
DECLARE v_every integer:=GREATEST(COALESCE(p_every,1),1); v_lo date; v_hi date; d date; v_days smallint[]; v_md integer; v_month date;
  v_last integer; v_m integer; v_anchor date;
BEGIN
  IF p_frequency IS NULL OR p_start IS NULL OR p_from IS NULL OR p_to IS NULL THEN RETURN; END IF;
  v_lo:=GREATEST(p_from,p_start);
  v_hi:=CASE WHEN p_end IS NULL THEN p_to ELSE LEAST(p_to,p_end) END;
  v_hi:=LEAST(v_hi,v_lo+400);
  IF v_hi<v_lo THEN RETURN; END IF;
  IF p_frequency='daily' THEN
    d:=v_lo+((v_every-((v_lo-p_start)%v_every))%v_every);
    WHILE d<=v_hi LOOP RETURN NEXT d; d:=d+v_every; END LOOP;
  ELSIF p_frequency='weekly' THEN
    v_days:=COALESCE(p_weekdays,ARRAY[pg_catalog.date_part('isodow',p_start)::smallint]);
    v_anchor:=p_start-(pg_catalog.date_part('isodow',p_start)::integer-1);
    d:=v_lo;
    WHILE d<=v_hi LOOP
      IF pg_catalog.date_part('isodow',d)::smallint=ANY(v_days)
        AND (((d-(pg_catalog.date_part('isodow',d)::integer-1))-v_anchor)/7)%v_every=0 THEN RETURN NEXT d; END IF;
      d:=d+1;
    END LOOP;
  ELSIF p_frequency='monthly' THEN
    v_md:=COALESCE(p_month_day,pg_catalog.date_part('day',p_start)::integer);
    v_month:=pg_catalog.date_trunc('month',v_lo)::date;
    WHILE v_month<=v_hi LOOP
      v_m:=(pg_catalog.date_part('year',v_month)::integer*12+pg_catalog.date_part('month',v_month)::integer)
        -(pg_catalog.date_part('year',p_start)::integer*12+pg_catalog.date_part('month',p_start)::integer);
      IF v_m>=0 AND v_m%v_every=0 THEN
        v_last:=pg_catalog.date_part('day',(v_month+interval '1 month'-interval '1 day'))::integer;
        d:=v_month+(CASE WHEN v_md=-1 OR v_md>v_last THEN v_last ELSE v_md END)-1;
        IF d BETWEEN v_lo AND v_hi THEN RETURN NEXT d; END IF;
      END IF;
      v_month:=(v_month+interval '1 month')::date;
    END LOOP;
  END IF;
END $fn$;

-- 6. Câu mô tả lịch (thuần), dùng chung cho bản xem trước của Hermes, báo cáo và web về sau.
CREATE OR REPLACE FUNCTION public.job_recurrence_schedule_text_v1(p_frequency text,p_every integer,p_weekdays smallint[],p_month_day integer)
RETURNS text LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path='' AS $fn$
  SELECT CASE p_frequency
    WHEN 'daily' THEN CASE WHEN COALESCE(p_every,1)<=1 THEN 'hằng ngày' ELSE 'mỗi '||p_every::text||' ngày' END
    WHEN 'weekly' THEN CASE WHEN COALESCE(p_every,1)<=1 THEN 'mỗi ' ELSE 'mỗi '||p_every::text||' tuần vào ' END
      ||COALESCE((SELECT pg_catalog.string_agg(CASE d WHEN 1 THEN 'thứ Hai' WHEN 2 THEN 'thứ Ba' WHEN 3 THEN 'thứ Tư' WHEN 4 THEN 'thứ Năm'
          WHEN 5 THEN 'thứ Sáu' WHEN 6 THEN 'thứ Bảy' ELSE 'Chủ nhật' END,', ' ORDER BY d) FROM pg_catalog.unnest(p_weekdays) d),'thứ ?')
    WHEN 'monthly' THEN CASE WHEN p_month_day=-1 THEN 'ngày cuối tháng' ELSE 'ngày '||COALESCE(p_month_day::text,'?') END
      ||CASE WHEN COALESCE(p_every,1)<=1 THEN ' hằng tháng' ELSE ', mỗi '||p_every::text||' tháng' END
  END
$fn$;

-- 7. Hàm ghi (INVOKER, dưới RLS người gọi). Lỗi: 42501 không có quyền, 22023 dữ liệu sai, P0002 không thấy quy tắc, 40001 version lệch,
--    54000 vượt trần 100 quy tắc đang chạy.
CREATE OR REPLACE FUNCTION public.job_recurrence_create_v1(p_organization_id uuid,p_building_id uuid,p_room_id uuid,p_job_type_id uuid,
  p_title text,p_description text,p_assignee_id uuid,p_priority text,p_frequency text,p_every integer,p_weekdays integer[],p_month_day integer,
  p_start_date date,p_end_date date,p_due_days integer)
RETURNS public.job_recurrence_rules LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $fn$
DECLARE v public.job_recurrence_rules;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'job_recurrence_denied' USING ERRCODE='42501'; END IF;
  INSERT INTO public.job_recurrence_rules(organization_id,building_id,room_id,job_type_id,title,description,assignee_id,priority,frequency,every,
    weekdays,month_day,start_date,end_date,due_days)
  VALUES(p_organization_id,p_building_id,p_room_id,p_job_type_id,p_title,p_description,p_assignee_id,COALESCE(p_priority,'NORMAL'),p_frequency,
    COALESCE(p_every,1),p_weekdays::smallint[],p_month_day,p_start_date,p_end_date,COALESCE(p_due_days,0))
  RETURNING * INTO v;
  RETURN v;
END $fn$;

-- p_changes: khoá là tên cột ghi được (title, description, assignee_id, priority, frequency, every, weekdays, month_day, start_date,
-- end_date, due_days); giá trị null = xoá (chỉ cột cho phép null).
CREATE OR REPLACE FUNCTION public.job_recurrence_update_v1(p_rule_id uuid,p_expected_version integer,p_changes jsonb)
RETURNS public.job_recurrence_rules LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $fn$
DECLARE v public.job_recurrence_rules; c jsonb:=COALESCE(p_changes,'{}'::jsonb);
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'job_recurrence_denied' USING ERRCODE='42501'; END IF;
  IF pg_catalog.jsonb_typeof(c)<>'object' OR c='{}'::jsonb OR EXISTS(SELECT 1 FROM pg_catalog.jsonb_object_keys(c) k WHERE k NOT IN ('title',
      'description','assignee_id','priority','frequency','every','weekdays','month_day','start_date','end_date','due_days')) THEN
    RAISE EXCEPTION 'job_recurrence_invalid' USING ERRCODE='22023'; END IF;
  SELECT * INTO v FROM public.job_recurrence_rules r WHERE r.id=p_rule_id AND r.deleted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'job_recurrence_not_found' USING ERRCODE='P0002'; END IF;
  IF p_expected_version IS NOT NULL AND v.version<>p_expected_version THEN RAISE EXCEPTION 'job_recurrence_conflict' USING ERRCODE='40001'; END IF;
  UPDATE public.job_recurrence_rules r SET
    title=CASE WHEN c ? 'title' THEN c->>'title' ELSE r.title END,
    description=CASE WHEN c ? 'description' THEN c->>'description' ELSE r.description END,
    assignee_id=CASE WHEN c ? 'assignee_id' THEN (c->>'assignee_id')::uuid ELSE r.assignee_id END,
    priority=CASE WHEN c ? 'priority' THEN c->>'priority' ELSE r.priority END,
    frequency=CASE WHEN c ? 'frequency' THEN c->>'frequency' ELSE r.frequency END,
    every=CASE WHEN c ? 'every' THEN (c->>'every')::smallint ELSE r.every END,
    weekdays=CASE WHEN c ? 'weekdays' THEN (SELECT pg_catalog.array_agg(x::smallint) FROM pg_catalog.jsonb_array_elements_text(
      CASE WHEN pg_catalog.jsonb_typeof(c->'weekdays')='array' THEN c->'weekdays' ELSE '[]'::jsonb END) x) ELSE r.weekdays END,
    month_day=CASE WHEN c ? 'month_day' THEN (c->>'month_day')::smallint ELSE r.month_day END,
    start_date=CASE WHEN c ? 'start_date' THEN (c->>'start_date')::date ELSE r.start_date END,
    end_date=CASE WHEN c ? 'end_date' THEN (c->>'end_date')::date ELSE r.end_date END,
    due_days=CASE WHEN c ? 'due_days' THEN (c->>'due_days')::smallint ELSE r.due_days END
  WHERE r.id=p_rule_id AND r.deleted_at IS NULL AND r.version=v.version
  RETURNING * INTO v;
  IF NOT FOUND THEN
    IF EXISTS(SELECT 1 FROM public.job_recurrence_rules r WHERE r.id=p_rule_id AND r.version<>v.version) THEN
      RAISE EXCEPTION 'job_recurrence_conflict' USING ERRCODE='40001'; END IF;
    RAISE EXCEPTION 'job_recurrence_denied' USING ERRCODE='42501';
  END IF;
  RETURN v;
END $fn$;

CREATE OR REPLACE FUNCTION public.job_recurrence_set_paused_v1(p_rule_id uuid,p_expected_version integer,p_paused boolean)
RETURNS public.job_recurrence_rules LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $fn$
DECLARE v public.job_recurrence_rules;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'job_recurrence_denied' USING ERRCODE='42501'; END IF;
  IF p_paused IS NULL THEN RAISE EXCEPTION 'job_recurrence_invalid' USING ERRCODE='22023'; END IF;
  SELECT * INTO v FROM public.job_recurrence_rules r WHERE r.id=p_rule_id AND r.deleted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'job_recurrence_not_found' USING ERRCODE='P0002'; END IF;
  IF p_expected_version IS NOT NULL AND v.version<>p_expected_version THEN RAISE EXCEPTION 'job_recurrence_conflict' USING ERRCODE='40001'; END IF;
  IF (v.paused_at IS NOT NULL)=p_paused THEN RAISE EXCEPTION 'job_recurrence_unchanged' USING ERRCODE='22023'; END IF;
  UPDATE public.job_recurrence_rules r SET paused_at=CASE WHEN p_paused THEN now() END
    WHERE r.id=p_rule_id AND r.deleted_at IS NULL AND r.version=v.version RETURNING * INTO v;
  IF NOT FOUND THEN
    IF EXISTS(SELECT 1 FROM public.job_recurrence_rules r WHERE r.id=p_rule_id AND r.version<>v.version) THEN
      RAISE EXCEPTION 'job_recurrence_conflict' USING ERRCODE='40001'; END IF;
    RAISE EXCEPTION 'job_recurrence_denied' USING ERRCODE='42501';
  END IF;
  RETURN v;
END $fn$;

CREATE OR REPLACE FUNCTION public.job_recurrence_delete_v1(p_rule_id uuid,p_expected_version integer)
RETURNS public.job_recurrence_rules LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $fn$
DECLARE v public.job_recurrence_rules;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'job_recurrence_denied' USING ERRCODE='42501'; END IF;
  SELECT * INTO v FROM public.job_recurrence_rules r WHERE r.id=p_rule_id AND r.deleted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'job_recurrence_not_found' USING ERRCODE='P0002'; END IF;
  IF p_expected_version IS NOT NULL AND v.version<>p_expected_version THEN RAISE EXCEPTION 'job_recurrence_conflict' USING ERRCODE='40001'; END IF;
  UPDATE public.job_recurrence_rules r SET deleted_at=now()
    WHERE r.id=p_rule_id AND r.deleted_at IS NULL AND r.version=v.version RETURNING * INTO v;
  IF NOT FOUND THEN
    IF EXISTS(SELECT 1 FROM public.job_recurrence_rules r WHERE r.id=p_rule_id AND r.version<>v.version) THEN
      RAISE EXCEPTION 'job_recurrence_conflict' USING ERRCODE='40001'; END IF;
    RAISE EXCEPTION 'job_recurrence_denied' USING ERRCODE='42501';
  END IF;
  RETURN v;
END $fn$;

ALTER FUNCTION app_private.job_recurrence_guard_v1() OWNER TO postgres;
ALTER FUNCTION public.job_recurrence_dates_v1(text,integer,smallint[],integer,date,date,date,date) OWNER TO postgres;
ALTER FUNCTION public.job_recurrence_schedule_text_v1(text,integer,smallint[],integer) OWNER TO postgres;
ALTER FUNCTION public.job_recurrence_create_v1(uuid,uuid,uuid,uuid,text,text,uuid,text,text,integer,integer[],integer,date,date,integer) OWNER TO postgres;
ALTER FUNCTION public.job_recurrence_update_v1(uuid,integer,jsonb) OWNER TO postgres;
ALTER FUNCTION public.job_recurrence_set_paused_v1(uuid,integer,boolean) OWNER TO postgres;
ALTER FUNCTION public.job_recurrence_delete_v1(uuid,integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.job_recurrence_guard_v1() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.job_recurrence_dates_v1(text,integer,smallint[],integer,date,date,date,date) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.job_recurrence_schedule_text_v1(text,integer,smallint[],integer) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.job_recurrence_create_v1(uuid,uuid,uuid,uuid,text,text,uuid,text,text,integer,integer[],integer,date,date,integer)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.job_recurrence_update_v1(uuid,integer,jsonb) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.job_recurrence_set_paused_v1(uuid,integer,boolean) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.job_recurrence_delete_v1(uuid,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.job_recurrence_dates_v1(text,integer,smallint[],integer,date,date,date,date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.job_recurrence_schedule_text_v1(text,integer,smallint[],integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.job_recurrence_create_v1(uuid,uuid,uuid,uuid,text,text,uuid,text,text,integer,integer[],integer,date,date,integer)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.job_recurrence_update_v1(uuid,integer,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.job_recurrence_set_paused_v1(uuid,integer,boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.job_recurrence_delete_v1(uuid,integer) TO authenticated;

DO $check$
BEGIN
  IF NOT (SELECT c.relrowsecurity FROM pg_catalog.pg_class c WHERE c.oid='public.job_recurrence_rules'::regclass)
    OR NOT (SELECT c.relrowsecurity FROM pg_catalog.pg_class c WHERE c.oid='public.job_recurrence_occurrences'::regclass)
    OR (SELECT count(*) FROM pg_catalog.pg_trigger t WHERE t.tgrelid='public.job_recurrence_rules'::regclass AND NOT t.tgisinternal
      AND t.tgname IN ('job_recurrence_rules_api_guard','job_recurrence_rules_system_guard'))<>2
    OR NOT (SELECT p.prosecdef FROM pg_catalog.pg_proc p WHERE p.oid='app_private.job_recurrence_guard_v1()'::regprocedure)
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid IN ('public.job_recurrence_create_v1(uuid,uuid,uuid,uuid,text,text,uuid,text,text,integer,integer[],integer,date,date,integer)'::regprocedure,
        'public.job_recurrence_update_v1(uuid,integer,jsonb)'::regprocedure,'public.job_recurrence_set_paused_v1(uuid,integer,boolean)'::regprocedure,
        'public.job_recurrence_delete_v1(uuid,integer)'::regprocedure) AND p.prosecdef)
    OR has_table_privilege('anon','public.job_recurrence_rules','SELECT') OR has_table_privilege('authenticated','public.job_recurrence_rules','DELETE')
    OR has_table_privilege('authenticated','public.job_recurrence_occurrences','INSERT')
    OR has_function_privilege('anon','public.job_recurrence_create_v1(uuid,uuid,uuid,uuid,text,text,uuid,text,text,integer,integer[],integer,date,date,integer)','EXECUTE')
    OR has_function_privilege('authenticated','app_private.job_recurrence_guard_v1()','EXECUTE') THEN
    RAISE EXCEPTION 'job_recurrence_check_failed'; END IF;
END $check$;
COMMIT;
NOTIFY pgrst,'reload schema';
