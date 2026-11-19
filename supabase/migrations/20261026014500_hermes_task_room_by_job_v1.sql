-- Hermes trang Công việc, lượt 16 (C3k) — một lỗi máy chủ theo nghiệm thu C3h trên TEST (connector 726d4746, SOUL v4.26, 25/10):
--  CV-H04 "Huỷ giúp anh việc sửa khoá cửa phòng 302": task.cancel / task.update chỉ nêu phòng mà phòng trùng nhiều toà ⇒ máy chủ hỏi
--  chọn toà trong MỌI toà có phòng 302 (8 toà đầu, thiếu đúng 417LVT có việc) ⇒ bot không nêu được ứng viên đúng. Nay: chưa nêu toà
--  ⇒ để việc khớp chọn trong các phòng cùng khoá ở mọi toà trong phạm vi khoá (một việc ⇒ xem trước, nêu toà; nhiều ⇒ hỏi chọn việc
--  kèm toà; không việc nào ⇒ hỏi toà như cũ).
-- Thay một thân: lõi của vỏ hermes_task_action_v1, app_private.hermes_task_resolve_core_v1 (thân 20261025003100, md5 adea03b28b36d0f221b0b8244055959d,
-- production = TEST) — chỉ nhánh tìm việc của task.update / task.cancel; mọi nhánh khác giữ từng byte. INVOKER như cũ (RLS người hỏi).
-- Không ghi dữ liệu, không khoá mới, không đổi kiểu trả về. Không cần connector mới (dạng trả về như cũ). Không DROP. Idempotent.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $requires$
BEGIN
  IF to_regprocedure('public.hermes_write_name_resolve_v1(uuid,uuid[],jsonb)') IS NULL
    OR to_regprocedure('public.hermes_room_key_v1(text)') IS NULL
    OR to_regclass('public.rooms') IS NULL
    -- Thân đang chạy phải đúng thân 20261025003100 (hoặc đúng thân của file này khi chạy lại).
    OR (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid='app_private.hermes_task_resolve_core_v1(jsonb,text,jsonb)'::regprocedure) NOT IN ('adea03b28b36d0f221b0b8244055959d','3ca074bbadcf365e24dfcb5e132ca919') THEN
    RAISE EXCEPTION 'hermes_task_room_by_job_dependency_invalid'; END IF;
END $requires$;

-- 1. Lõi (INVOKER): thân 20261025003100 + chọn toà theo việc khi phòng trùng.
CREATE OR REPLACE FUNCTION app_private.hermes_task_resolve_core_v1(p_ctx jsonb,p_action text,p_params jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $fn$
DECLARE v_org uuid; v_scope uuid[]; v_building text; v_room text; v_type text; v_person text; v_content text; v_whole boolean:=false;
  v_self boolean:=false; v_res jsonb; v_job jsonb; v_who jsonb; v_guessed boolean:=false; v_date date; v_time time; v_deadline timestamptz;
  v_fold text; v_tfold text; v_title text; v_desc text; v_priority text; v_found jsonb; v_best integer; v_more boolean;
  v_pfold text; v_ambiguous boolean:=false; v_jfold text; v_cwords text[]; v_jwords text[]; v_twanted text;
  v_jq text; v_code text; v_hits jsonb; v_hit jsonb; v_closed boolean; v_changes jsonb;
  v_jtext text; v_jroom text; v_jroomkey text; v_jbids uuid[]:='{}'::uuid[]; v_key text; v_kid uuid;
  v_batch boolean:=false; v_common jsonb; v_who_name text; v_managed jsonb; v_items jsonb; v_item jsonb; v_out jsonb:='[]'::jsonb; v_one jsonb;
  v_i integer; v_rooms integer; v_roomamb jsonb; v_rkey text;
BEGIN
  IF p_action IS NULL OR p_action NOT IN ('task.create','task.create_batch','task.update','task.cancel','task.recurring_create','task.recurring_update',
    'task.recurring_pause','task.recurring_delete') OR p_ctx IS NULL OR p_params IS NULL OR jsonb_typeof(p_params)<>'object'
    OR (p_action IN ('task.create','task.recurring_create') AND jsonb_typeof(p_params->'content') IS DISTINCT FROM 'string') THEN
    RAISE EXCEPTION 'hermes_task_invalid' USING ERRCODE='22023'; END IF;
  v_org:=(p_ctx->>'organizationId')::uuid;
  v_scope:=ARRAY(SELECT jsonb_array_elements_text(p_ctx->'buildingIds')::uuid);

  -- Mốc 5 (việc định kỳ). Tạo: đi CHUNG nhánh một mục của task.create bên dưới (toà / phòng / loại / người nhận / tiêu đề đúng luật,
  -- dưới RLS người hỏi), lúc trả về bỏ hạn và gắn lịch thô cho bước chuẩn bị (DEFINER) chuẩn hoá theo giờ công ty. Sửa / tạm dừng / xoá:
  -- tìm ĐÚNG MỘT quy tắc chưa xoá — mã DK-NNNN (khớp bằng, chấp nhận "dk3", "DK 0003") hoặc nội dung bỏ dấu chứa chuỗi — người hỏi
  -- thấy qua RLS và trong phạm vi toà của khoá; mơ hồ ⇒ hỏi lại kèm mã + nội dung + phòng + lịch (+ toà), KHÔNG BAO GIỜ tự chọn.
  IF p_action IN ('task.recurring_update','task.recurring_pause','task.recurring_delete') THEN
    v_jq:=NULLIF(btrim(regexp_replace(COALESCE(p_params->>'rule',''),'\s+',' ','g')),'');
    IF v_jq IS NULL THEN
      RETURN jsonb_build_object('status','unresolved','field','recurrence','wanted','','why','unspecified','candidates','[]'::jsonb,'more',false); END IF;
    v_jfold:=public.hermes_name_fold_v1(v_jq);
    v_code:=upper(regexp_replace(v_jq,'[\s-]+','','g'));
    v_code:=CASE WHEN v_code ~ '^DK[0-9]{1,9}$' THEN 'DK-'||lpad(substr(v_code,3),4,'0') END;
    WITH m AS (SELECT r.id,r.code,r.title,r.building_id,r.room_id,r.assignee_id,r.version,r.paused_at,r.frequency,r.every,r.weekdays,r.month_day,
        CASE WHEN r.code=v_code THEN 1 WHEN char_length(v_jfold)>=3 AND position(v_jfold IN public.hermes_name_fold_v1(r.title))>0 THEN 2 END AS how
        FROM public.job_recurrence_rules r WHERE r.organization_id=v_org AND r.deleted_at IS NULL AND r.building_id=ANY(v_scope)),
      best AS (SELECT min(m.how) h FROM m WHERE m.how IS NOT NULL)
    SELECT COALESCE(jsonb_agg(jsonb_build_object('id',m.id,'code',m.code,'title',m.title,'buildingId',m.building_id,'roomId',m.room_id,
        'assigneeId',m.assignee_id,'version',m.version,'paused',m.paused_at IS NOT NULL,
        'schedule',public.job_recurrence_schedule_text_v1(m.frequency,m.every,m.weekdays,m.month_day)) ORDER BY m.code),'[]'::jsonb)
      INTO v_hits FROM m,best WHERE m.how=best.h;
    IF jsonb_array_length(v_hits)=0 THEN
      RETURN jsonb_build_object('status','unresolved','field','recurrence','wanted',left(v_jq,120),'why','not_visible','candidates','[]'::jsonb,'more',false);
    ELSIF jsonb_array_length(v_hits)>1 THEN
      RETURN jsonb_build_object('status','unresolved','field','recurrence','wanted',left(v_jq,120),'why','ambiguous',
        'candidates',(SELECT COALESCE(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('name',left(format('%s · %s (%s, %s)',e->>'code',left(e->>'title',60),
              COALESCE((SELECT rm.name FROM public.rooms rm WHERE rm.id=(e->>'roomId')::uuid),'cả toà'),e->>'schedule'),120),
            'buildingName',(SELECT left(b.name,120) FROM public.buildings b WHERE b.id=(e->>'buildingId')::uuid))) ORDER BY ord),'[]'::jsonb)
          FROM jsonb_array_elements(v_hits) WITH ORDINALITY y(e,ord) WHERE ord<=8),
        'more',jsonb_array_length(v_hits)>8);
    END IF;
    v_hit:=v_hits->0;
    IF p_action='task.recurring_delete' THEN RETURN jsonb_build_object('status','resolved','rule',v_hit,'personMissing',false); END IF;
    IF p_action='task.recurring_pause' THEN
      -- resume=true ⇒ muốn chạy; trạng thái đã đúng như muốn ⇒ không đổi gì (hỏi lại, không ghi).
      IF COALESCE(p_params->'resume'='true'::jsonb,false)<>(v_hit->'paused'='true'::jsonb) THEN
        RETURN jsonb_build_object('status','invalid','reason','recurrence_unchanged'); END IF;
      RETURN jsonb_build_object('status','resolved','rule',v_hit,'resume',COALESCE(p_params->'resume'='true'::jsonb,false),'personMissing',false);
    END IF;
    -- task.recurring_update: ít nhất một thay đổi; người nhận mới theo đúng luật của task.update; lịch thô (bước chuẩn bị kiểm).
    v_changes:='{}'::jsonb;
    IF NULLIF(btrim(p_params->>'content'),'') IS NOT NULL THEN
      v_changes:=v_changes||jsonb_build_object('title',left(btrim(regexp_replace(p_params->>'content','\s+',' ','g')),200)); END IF;
    IF NULLIF(btrim(p_params->>'description'),'') IS NOT NULL THEN v_changes:=v_changes||jsonb_build_object('description',left(btrim(p_params->>'description'),4000)); END IF;
    IF NULLIF(p_params->>'priority','') IS NOT NULL THEN
      IF p_params->>'priority' NOT IN ('NORMAL','LOW','URGENT') THEN RETURN jsonb_build_object('status','invalid','reason','invalid_params'); END IF;
      v_changes:=v_changes||jsonb_build_object('priority',p_params->>'priority');
    END IF;
    v_changes:=v_changes||jsonb_strip_nulls(jsonb_build_object('frequency',p_params->'frequency','every',p_params->'every','weekdays',p_params->'weekdays',
      'monthDay',p_params->'monthDay','startDate',p_params->'startDate','endDate',p_params->'endDate','dueDays',p_params->'dueDays'));
    v_person:=NULLIF(btrim(p_params->>'assigneeName'),'');
    IF v_person IS NOT NULL THEN
      v_pfold:=public.hermes_name_fold_v1(v_person);
      IF v_pfold IN ('toi','tui','self','me','chinh minh','chinh toi','ban than') THEN
        v_who:=jsonb_build_object('id',auth.uid(),'name',(SELECT p.full_name FROM public.profiles p WHERE p.id=auth.uid()));
      -- Lượt 13: danh xưng trơn ("anh", "chị", "em", "a", "ảnh", "ổng", "bả", "anh ấy"…) không phải tên ⇒ hỏi giao cho ai; không thành
      -- chính người hỏi, không thành người quản lý.
      ELSIF btrim(regexp_replace(v_pfold,'[^a-z0-9]+',' ','g')) ~ '^(anh|chi|em|co|chu|bac|ong|ba|thay|di|cau|ban|a|c|e)( (ay|ta|kia|do))?$' THEN
        RETURN jsonb_build_object('status','unresolved','field','person','wanted','','why','unspecified','candidates','[]'::jsonb,'more',false);
      ELSE
        IF v_pfold='minh' THEN v_ambiguous:=true; END IF;
        v_who:=public.hermes_write_name_resolve_v1(v_org,v_scope,jsonb_build_object('person',v_person));
        IF v_who->>'status'='resolved' THEN
          v_who:=v_who->'person';
          IF v_who->>'id'=auth.uid()::text THEN v_ambiguous:=true; END IF;
        ELSIF v_ambiguous AND v_who->>'why'='not_visible' THEN
          v_who:=jsonb_build_object('id',auth.uid(),'name',(SELECT p.full_name FROM public.profiles p WHERE p.id=auth.uid()));
        ELSE RETURN v_who;
        END IF;
      END IF;
      v_changes:=v_changes||jsonb_build_object('assignee',v_who,'assigneeAmbiguous',v_ambiguous,
        'assigneeWanted',CASE WHEN v_ambiguous THEN left(v_person,40) END);
    END IF;
    IF v_changes='{}'::jsonb THEN RETURN jsonb_build_object('status','invalid','reason','invalid_params'); END IF;
    RETURN jsonb_build_object('status','resolved','rule',v_hit,'changes',jsonb_strip_nulls(v_changes),'personMissing',false);
  END IF;

  -- Mốc 3 (task.update / task.cancel): tìm ĐÚNG MỘT việc. Mã đầy đủ (mọi trạng thái); 3–4 số cuối của mã, "vừa giao"/"vừa tạo"
  -- (việc mới nhất người hỏi tạo trong 24 giờ) hoặc tiêu đề bỏ dấu chứa chuỗi — chỉ việc ĐANG MỞ. Chỉ trong việc người hỏi thấy
  -- qua RLS và trong phạm vi toà của khoá; nêu toà/phòng thì lọc thêm. Khớp nhiều ⇒ hỏi lại kèm mã + tiêu đề + phòng + người nhận
  -- (+ toà), KHÔNG BAO GIỜ tự chọn (sự cố huỷ nhầm việc cùng tên ở toà khác 21/10). Chỉ khớp việc đã xong ⇒ 'closed'.
  IF p_action IN ('task.update','task.cancel') THEN
    v_jq:=NULLIF(btrim(regexp_replace(COALESCE(p_params->>'job',''),'\s+',' ','g')),'');
    IF v_jq IS NULL THEN
      RETURN jsonb_build_object('status','unresolved','field','job','wanted','','why','unspecified','candidates','[]'::jsonb,'more',false); END IF;
    v_building:=NULLIF(btrim(p_params->>'buildingName'),''); v_room:=NULLIF(btrim(p_params->>'roomName'),'');
    IF v_room IS NOT NULL AND public.hermes_name_fold_v1(v_room) IN ('tn','toa','ca toa','toan toa','toa nha','ca toa nha') THEN v_room:=NULL; END IF;
    IF v_building IS NOT NULL OR v_room IS NOT NULL THEN
      v_res:=public.hermes_write_name_resolve_v1(v_org,v_scope,jsonb_strip_nulls(jsonb_build_object('building',v_building,'room',v_room)));
      -- Lượt 16 (nghiệm thu C3h CV-H04: "huỷ việc sửa khoá cửa phòng 302" ⇒ hỏi chọn 8 trong ~20 toà có phòng 302, thiếu đúng toà có
      -- việc): chỉ nêu phòng mà phòng trùng nhiều toà ⇒ để VIỆC khớp chọn — lọc theo khoá phòng (luật của bộ giải tên) ở mọi toà trong
      -- phạm vi. Một việc khớp ⇒ xem trước việc đó (nêu toà); nhiều ⇒ hỏi chọn việc (kèm toà), KHÔNG BAO GIỜ tự chọn; không việc nào
      -- ⇒ hỏi toà như cũ.
      IF v_building IS NULL AND v_res->>'status'='unresolved' AND v_res->>'field'='room' AND v_res->>'why'='ambiguous'
        AND public.hermes_room_key_v1(v_room)<>'' THEN
        v_roomamb:=v_res; v_rkey:=public.hermes_room_key_v1(v_room); v_res:=NULL; v_room:=NULL;
      ELSIF v_res->>'status' IS DISTINCT FROM 'resolved' THEN RETURN v_res; END IF;
    END IF;
    v_jfold:=public.hermes_name_fold_v1(v_jq);
    -- Lượt 12: người dùng chọn một dòng trong danh sách máy chủ đã đưa ("<mã> · <tiêu đề> (<phòng>, <người nhận>)") ⇒ lấy mã ở đầu nhãn.
    v_code:=upper(replace(COALESCE(substring(v_jq from '^([^ ·]+) · '),v_jq),' ',''));
    -- Nghiệm thu 23–24/10: người dùng hay kèm phòng / toà vào chuỗi tìm ("việc sửa vòi nước phòng 203", "… toà 111PVC"). Tách "phòng N"
    -- và tên / mã toà (trong phạm vi khoá) khỏi chuỗi khớp tiêu đề; chưa nêu riêng phòng / toà thì lọc theo phần tách ra (một toà duy
    -- nhất; phòng theo khoá phòng ở mọi toà). Bỏ "việc" đứng đầu, giới từ đứng cuối; so theo từ (bỏ dấu, dấu câu thành khoảng trắng).
    v_jroom:=substring(v_jfold from '(?:^| )(?:phong|ph|p)\.? ?([0-9]{1,4}[a-z]?)(?: |,|$)');
    v_jtext:=v_jfold;
    IF v_jroom IS NOT NULL THEN
      v_jtext:=regexp_replace(' '||v_jtext||' ',' (phong|ph|p)\.? ?'||v_jroom||'(?= |,)',' ');
      v_jroomkey:=public.hermes_room_key_v1(v_jroom);
    END IF;
    v_jtext:=btrim(regexp_replace(regexp_replace(v_jtext,'[^a-z0-9]+',' ','g'),' +',' ','g'));
    FOR v_key,v_kid IN SELECT x.k,x.id FROM (SELECT DISTINCT b.id,kk.k FROM public.buildings b
        CROSS JOIN LATERAL (SELECT btrim(regexp_replace(public.hermes_name_fold_v1(b.name),'[^a-z0-9]+',' ','g')) k
          UNION SELECT btrim(regexp_replace(public.hermes_name_fold_v1(a.alias),'[^a-z0-9]+',' ','g'))
            FROM unnest(string_to_array(COALESCE(b.code,''),',')) a(alias)) kk
        WHERE b.organization_id=v_org AND b.id=ANY(v_scope) AND b.deleted_at IS NULL AND char_length(kk.k)>=3
          AND position(' '||kk.k||' ' IN ' '||v_jtext||' ')>0) x ORDER BY char_length(x.k) DESC,x.k LOOP
      v_jtext:=btrim(replace(replace(' '||v_jtext||' ',' toa nha '||v_key||' ',' '),' toa '||v_key||' ',' '));
      v_jtext:=btrim(replace(' '||v_jtext||' ',' '||v_key||' ',' '));
      IF NOT v_kid=ANY(v_jbids) THEN v_jbids:=v_jbids||v_kid; END IF;
    END LOOP;
    v_jtext:=btrim(regexp_replace(v_jtext,'^((cai|cong) )?viec( |$)',''));
    v_jtext:=btrim(regexp_replace(v_jtext,'( (o|tai|cua|trong|toa|phong))+$',''));
    -- Phần tách ra là một cách khớp THÊM (tiêu đề chứa phần chữ còn lại + đúng phòng / toà tách được); luật cũ (cả chuỗi nằm trong
    -- tiêu đề) giữ nguyên — việc "cả toà" có ghi phòng trong tiêu đề vẫn tìm được.
    WITH c AS (SELECT j.id,j.code,j.title,j.status,j.building_id,j.room_id,j.assignee_id,j.deadline,j.created_at,j.user_id,
          (v_room IS NOT NULL OR v_jroomkey IS NULL OR v_jroomkey='' OR EXISTS(SELECT 1 FROM public.rooms r WHERE r.id=j.room_id
            AND (public.hermes_room_key_v1(r.name)=v_jroomkey OR EXISTS(SELECT 1 FROM unnest(string_to_array(COALESCE(r.code,''),',')) a(alias)
              WHERE btrim(a.alias)<>'' AND public.hermes_room_key_v1(a.alias)=v_jroomkey))))
          AND (v_building IS NOT NULL OR cardinality(v_jbids)<>1 OR j.building_id=v_jbids[1]) AS at_place
        FROM public.jobs j WHERE j.organization_id=v_org AND j.building_id=ANY(v_scope)
          AND (v_res IS NULL OR j.building_id=(v_res#>>'{building,id}')::uuid)
          AND (v_res IS NULL OR jsonb_typeof(v_res->'room') IS DISTINCT FROM 'object' OR j.room_id IS NOT DISTINCT FROM (v_res#>>'{room,id}')::uuid)
          AND (v_rkey IS NULL OR EXISTS(SELECT 1 FROM public.rooms r JOIN public.buildings b ON b.id=r.building_id
            WHERE r.id=j.room_id AND r.deleted_at IS NULL AND b.deleted_at IS NULL AND NOT COALESCE(b.is_virtual,false)
              AND (public.hermes_room_key_v1(r.name)=v_rkey OR EXISTS(SELECT 1 FROM unnest(string_to_array(COALESCE(r.code,''),',')) a(alias)
                WHERE btrim(a.alias)<>'' AND public.hermes_room_key_v1(a.alias)=v_rkey))))),
    m AS (SELECT c.*,CASE
        WHEN upper(COALESCE(c.code,''))=v_code THEN 1
        WHEN v_jq ~ '^[0-9]{3,4}$' AND right(COALESCE(c.code,''),4)=lpad(v_jq,4,'0') THEN 2
        WHEN v_jfold IN ('vua giao','vua tao','viec vua giao','viec vua tao','viec moi giao','viec moi tao') AND c.user_id=auth.uid()
          AND c.created_at>clock_timestamp()-interval '24 hours' THEN 3
        WHEN char_length(v_jfold)>=3 AND position(v_jfold IN public.hermes_name_fold_v1(COALESCE(c.title,'')))>0 THEN 4
        WHEN (v_jroomkey<>'' OR cardinality(v_jbids)>0) AND c.at_place AND char_length(v_jtext)>=3
          AND position(v_jtext IN btrim(regexp_replace(public.hermes_name_fold_v1(COALESCE(c.title,'')),'[^a-z0-9]+',' ','g')))>0 THEN 4
        WHEN v_jtext='' AND (v_jroomkey<>'' OR cardinality(v_jbids)=1) AND c.at_place THEN 4 END AS how FROM c),
    best AS (SELECT min(m.how) h FROM m WHERE m.how=1 OR (m.how IS NOT NULL AND m.status='IN_PROGRESS')),
    hit AS (SELECT m.* FROM m,best WHERE m.how=best.h AND (m.how=1 OR m.status='IN_PROGRESS')
        AND (m.how<>3 OR m.created_at=(SELECT max(x.created_at) FROM m x WHERE x.how=3 AND x.status='IN_PROGRESS')))
    SELECT COALESCE((SELECT jsonb_agg(jsonb_build_object('id',hit.id,'code',hit.code,'title',hit.title,'status',hit.status,'buildingId',hit.building_id,
          'roomId',hit.room_id,'assigneeId',hit.assignee_id,'deadline',hit.deadline,'how',hit.how) ORDER BY hit.created_at DESC,hit.id) FROM hit),'[]'::jsonb),
      COALESCE((SELECT bool_or(m.status IS DISTINCT FROM 'IN_PROGRESS') FROM m WHERE m.how IS NOT NULL),false)
      INTO v_hits,v_closed;
    IF jsonb_array_length(v_hits)=0 THEN
      IF v_closed THEN RETURN jsonb_build_object('status','closed'); END IF;
      IF v_roomamb IS NOT NULL THEN RETURN v_roomamb; END IF;
      RETURN jsonb_build_object('status','unresolved','field','job','wanted',left(v_jq,120),'why','not_visible','candidates','[]'::jsonb,'more',false);
    ELSIF jsonb_array_length(v_hits)>1 THEN
      RETURN jsonb_build_object('status','unresolved','field','job','wanted',left(v_jq,120),'why','ambiguous',
        'candidates',(SELECT COALESCE(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('name',left(format('%s · %s (%s, %s)',COALESCE(e->>'code','—'),left(e->>'title',60),
              COALESCE((SELECT r.name FROM public.rooms r WHERE r.id=(e->>'roomId')::uuid),'cả toà'),
              COALESCE((SELECT p.full_name FROM public.profiles p WHERE p.id=(e->>'assigneeId')::uuid),'chưa giao')),120),
            'buildingName',(SELECT left(b.name,120) FROM public.buildings b WHERE b.id=(e->>'buildingId')::uuid))) ORDER BY ord),'[]'::jsonb)
          FROM jsonb_array_elements(v_hits) WITH ORDINALITY y(e,ord) WHERE ord<=8),
        'more',jsonb_array_length(v_hits)>8);
    END IF;
    v_hit:=v_hits->0;
    IF v_hit->>'status' IS DISTINCT FROM 'IN_PROGRESS' THEN RETURN jsonb_build_object('status','closed','jobId',v_hit->'id'); END IF;
    IF p_action='task.cancel' THEN RETURN jsonb_build_object('status','resolved','job',v_hit,'personMissing',false); END IF;
    -- task.update: ít nhất một thay đổi. Người nhận mới theo đúng luật của task.create (token tự xưng rõ ràng ⇒ chính mình; mình/anh/
    -- chị/em/tên chính mình ⇒ giải tên + cờ mơ hồ). Hạn: ngày/giờ thô — bước chuẩn bị (DEFINER) tính theo múi giờ công ty.
    v_changes:='{}'::jsonb;
    IF NULLIF(btrim(p_params->>'note'),'') IS NOT NULL THEN v_changes:=v_changes||jsonb_build_object('note',left(btrim(p_params->>'note'),1000)); END IF;
    IF NULLIF(btrim(p_params->>'content'),'') IS NOT NULL THEN
      v_changes:=v_changes||jsonb_build_object('title',left(btrim(regexp_replace(p_params->>'content','\s+',' ','g')),200)); END IF;
    IF NULLIF(btrim(p_params->>'description'),'') IS NOT NULL THEN v_changes:=v_changes||jsonb_build_object('description',left(btrim(p_params->>'description'),4000)); END IF;
    IF NULLIF(p_params->>'priority','') IS NOT NULL THEN
      IF p_params->>'priority' NOT IN ('NORMAL','LOW','URGENT') THEN RETURN jsonb_build_object('status','invalid','reason','invalid_params'); END IF;
      v_changes:=v_changes||jsonb_build_object('priority',p_params->>'priority');
    END IF;
    IF jsonb_typeof(p_params->'deadline')='string' THEN
      IF p_params->>'deadline' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RETURN jsonb_build_object('status','invalid','reason','invalid_params'); END IF;
      v_changes:=v_changes||jsonb_build_object('deadlineDate',p_params->>'deadline');
    END IF;
    IF jsonb_typeof(p_params->'deadlineTime')='string' THEN
      IF p_params->>'deadlineTime' !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' THEN RETURN jsonb_build_object('status','invalid','reason','invalid_params'); END IF;
      v_changes:=v_changes||jsonb_build_object('deadlineTime',p_params->>'deadlineTime');
    END IF;
    v_person:=NULLIF(btrim(p_params->>'assigneeName'),'');
    IF v_person IS NOT NULL THEN
      v_pfold:=public.hermes_name_fold_v1(v_person);
      IF v_pfold IN ('toi','tui','self','me','chinh minh','chinh toi','ban than') THEN
        v_who:=jsonb_build_object('id',auth.uid(),'name',(SELECT p.full_name FROM public.profiles p WHERE p.id=auth.uid()));
      -- Lượt 13: danh xưng trơn ("anh", "chị", "em", "a", "ảnh", "ổng", "bả", "anh ấy"…) không phải tên ⇒ hỏi giao cho ai; không thành
      -- chính người hỏi, không thành người quản lý.
      ELSIF btrim(regexp_replace(v_pfold,'[^a-z0-9]+',' ','g')) ~ '^(anh|chi|em|co|chu|bac|ong|ba|thay|di|cau|ban|a|c|e)( (ay|ta|kia|do))?$' THEN
        RETURN jsonb_build_object('status','unresolved','field','person','wanted','','why','unspecified','candidates','[]'::jsonb,'more',false);
      ELSE
        IF v_pfold='minh' THEN v_ambiguous:=true; END IF;
        v_who:=public.hermes_write_name_resolve_v1(v_org,v_scope,jsonb_build_object('person',v_person));
        IF v_who->>'status'='resolved' THEN
          v_who:=v_who->'person';
          IF v_who->>'id'=auth.uid()::text THEN v_ambiguous:=true; END IF;
        ELSIF v_ambiguous AND v_who->>'why'='not_visible' THEN
          v_who:=jsonb_build_object('id',auth.uid(),'name',(SELECT p.full_name FROM public.profiles p WHERE p.id=auth.uid()));
        ELSE RETURN v_who;
        END IF;
      END IF;
      v_changes:=v_changes||jsonb_build_object('assignee',v_who,'assigneeAmbiguous',v_ambiguous,
        'assigneeWanted',CASE WHEN v_ambiguous THEN left(v_person,40) END);
    END IF;
    IF v_changes='{}'::jsonb THEN RETURN jsonb_build_object('status','invalid','reason','invalid_params'); END IF;
    RETURN jsonb_build_object('status','resolved','job',v_hit,'changes',jsonb_strip_nulls(v_changes),'personMissing',false);
  END IF;
  -- Mốc 4 (task.create_batch): mỗi mục chạy ĐÚNG luật của task.create ở dưới (giải tên, đoán loại, người nhận, hạn, tiêu đề) dưới RLS
  -- người hỏi. Mục = giá trị chung (buildingName, jobType, content, description, assigneeName, deadline, deadlineTime, priority) đè bởi giá
  -- trị riêng của mục ("toà X, mỗi phòng một việc" chỉ nêu toà một lần); chuỗi trống = không nêu. buildingsManagedBy thay items: chỉ giải người ở đây và MỘT mẫu không toà (người nhận trống =
  -- chính người đó); bước chuẩn bị (DEFINER) trải mẫu ra mọi toà người đó quản lý trong phạm vi khoá. Mục đầu tiên chưa giải được
  -- ⇒ trả kết quả đó kèm số mục (item, đếm từ 1).
  v_batch:=p_action='task.create_batch';
  IF v_batch THEN
    v_common:=(SELECT COALESCE(jsonb_object_agg(e.key,e.value),'{}'::jsonb) FROM jsonb_each(p_params) e
      WHERE e.key IN ('buildingName','jobType','content','description','assigneeName','deadline','deadlineTime','priority')
        AND jsonb_typeof(e.value)<>'null' AND NOT (jsonb_typeof(e.value)='string' AND btrim(e.value#>>'{}')=''));
    v_who_name:=NULLIF(btrim(COALESCE(p_params->>'buildingsManagedBy','')),'');
    -- Lượt 14 (nghiệm thu: "toà 102LVT, mỗi phòng một việc" ⇒ bot phải hỏi xin danh sách phòng): perRoom=true + buildingName (không items,
    -- không buildingsManagedBy) = mỗi phòng chưa xoá của toà mà người hỏi thấy (RLS) một mục, theo tên phòng. > 20 phòng ⇒ batch_too_large
    -- kèm số phòng thật (rooms) để bot đề nghị chia lô; toà không có phòng ⇒ hỏi lại phòng.
    IF p_params->'perRoom'='true'::jsonb THEN
      IF NOT (v_common ? 'buildingName') OR jsonb_typeof(p_params->'items')='array' OR v_who_name IS NOT NULL THEN
        RETURN jsonb_build_object('status','invalid','reason','invalid_params'); END IF;
      v_res:=public.hermes_write_name_resolve_v1(v_org,v_scope,jsonb_build_object('building',v_common->>'buildingName'));
      IF v_res->>'status' IS DISTINCT FROM 'resolved' THEN RETURN v_res; END IF;
      SELECT count(*)::integer,COALESCE(jsonb_agg(v_common||jsonb_build_object('roomName',r.name) ORDER BY r.name,r.id),'[]'::jsonb)
        INTO v_rooms,v_items FROM public.rooms r
        WHERE r.organization_id=v_org AND r.building_id=(v_res#>>'{building,id}')::uuid AND r.deleted_at IS NULL AND btrim(COALESCE(r.name,''))<>'';
      IF v_rooms=0 THEN
        RETURN jsonb_build_object('status','unresolved','field','room','wanted','','why','unspecified','candidates','[]'::jsonb,'more',false); END IF;
      IF v_rooms>20 THEN RETURN jsonb_build_object('status','invalid','reason','batch_too_large','rooms',v_rooms); END IF;
    ELSIF (jsonb_typeof(p_params->'items') IS NOT DISTINCT FROM 'array') = (v_who_name IS NOT NULL) THEN
      RETURN jsonb_build_object('status','invalid','reason','invalid_params');
    ELSIF v_who_name IS NULL THEN
      IF jsonb_array_length(p_params->'items')=0 THEN RETURN jsonb_build_object('status','invalid','reason','invalid_params'); END IF;
      IF jsonb_array_length(p_params->'items')>20 THEN RETURN jsonb_build_object('status','invalid','reason','batch_too_large'); END IF;
      SELECT jsonb_agg(v_common||COALESCE((SELECT jsonb_object_agg(f.key,f.value)
          FROM jsonb_each(CASE WHEN jsonb_typeof(x.e)='object' THEN x.e ELSE '{}'::jsonb END) f
          WHERE f.key IN ('buildingName','roomName','jobType','content','description','assigneeName','deadline','deadlineTime','priority')
            AND jsonb_typeof(f.value)<>'null' AND NOT (jsonb_typeof(f.value)='string' AND btrim(f.value#>>'{}')='')),'{}'::jsonb) ORDER BY x.ord)
        INTO v_items FROM jsonb_array_elements(p_params->'items') WITH ORDINALITY x(e,ord);
    ELSE
      -- buildingsManagedBy = mọi toà người đó quản lý: nêu thêm một toà là mâu thuẫn ⇒ invalid_params (không lặng lẽ bỏ).
      IF v_common ? 'buildingName' THEN RETURN jsonb_build_object('status','invalid','reason','invalid_params'); END IF;
      v_who:=public.hermes_write_name_resolve_v1(v_org,v_scope,jsonb_build_object('person',v_who_name));
      IF v_who->>'status' IS DISTINCT FROM 'resolved' THEN RETURN v_who; END IF;
      v_managed:=v_who->'person';
      v_items:=jsonb_build_array(v_common||jsonb_build_object('_template',true)
        ||CASE WHEN v_common ? 'assigneeName' THEN '{}'::jsonb ELSE jsonb_build_object('_assignee',v_managed) END);
    END IF;
  ELSE
    v_items:=jsonb_build_array(p_params);
  END IF;
  FOR v_i IN 0..jsonb_array_length(v_items)-1 LOOP
    v_item:=v_items->v_i;
    v_whole:=false; v_self:=false; v_res:=NULL; v_job:=NULL; v_who:=NULL; v_guessed:=false; v_date:=NULL; v_time:=NULL;
    v_ambiguous:=false; v_twanted:=NULL; v_found:=NULL; v_one:=NULL;
    <<one>>
    BEGIN
      v_building:=NULLIF(btrim(v_item->>'buildingName'),''); v_room:=NULLIF(btrim(v_item->>'roomName'),'');
      v_type:=NULLIF(btrim(v_item->>'jobType'),''); v_person:=NULLIF(btrim(v_item->>'assigneeName'),'');
      v_content:=btrim(regexp_replace(v_item->>'content','\s+',' ','g'));
      IF COALESCE(v_content,'')='' THEN v_one:=jsonb_build_object('status','invalid','reason','invalid_params'); EXIT one; END IF;
      IF v_room IS NOT NULL AND public.hermes_name_fold_v1(v_room) IN ('tn','toa','ca toa','toan toa','toa nha','ca toa nha') THEN
        v_room:=NULL; v_whole:=true; END IF;
      IF v_item ? '_template' THEN
        v_res:=jsonb_build_object('status','resolved'); v_room:=NULL; v_whole:=true;
      ELSE
      IF v_building IS NULL AND v_room IS NULL THEN
        v_one:=jsonb_build_object('status','unresolved','field','building','wanted','','why','unspecified','candidates','[]'::jsonb,'more',false); EXIT one; END IF;
      v_res:=public.hermes_write_name_resolve_v1(v_org,v_scope,jsonb_strip_nulls(jsonb_build_object('building',v_building,'room',v_room)));
      IF v_res->>'status' IS DISTINCT FROM 'resolved' THEN v_one:=v_res; EXIT one; END IF;
      END IF;

      -- Loại việc (Mốc 2c, bot thật trên TEST 22/10): nêu tên khớp đúng một loại ⇒ dùng. Không khớp (mô hình hay tự đặt "Bảo trì",
      -- "Dọn vệ sinh", "kiểm tra điện"…) ⇒ coi như CHƯA nêu và tự suy theo nội dung + chính chuỗi đó, chấm điểm trên các loại đang bật
      -- mà người hỏi thấy được (RLS): 95 chuỗi loại bỏ khoảng trắng trùng tên loại ("ve sinh" ~ "vesinh") > 90 đầu nội dung (như ô gõ
      -- nhanh của web) > 80 chuỗi loại chứa tên loại > 70 đồng nghĩa trong chuỗi loại > 60 nội dung chứa tên loại > 50 đồng nghĩa trong
      -- nội dung; cùng mức thì tên dài hơn thắng. Đúng một loại điểm cao nhất ⇒ dùng + cờ đoán (luôn xem trước). Không suy được hoặc
      -- hoà ⇒ hỏi lại kèm tối đa 5 gợi ý xếp theo độ gần (điểm, rồi tiền tố chung dài nhất với một từ), không chọn bừa. Đồng nghĩa chỉ
      -- trỏ tới tên loại (bỏ dấu, bỏ khoảng trắng) có trong danh mục thật; công ty không có loại đó thì dòng tự bỏ qua. Lượt 12: thêm 92
      -- chuỗi loại mở đầu bằng tên loại; loại được NÊU rõ (tên hoặc cụm đồng nghĩa đứng đầu) không còn là đoán (xem dưới).
      IF v_type IS NOT NULL THEN
        v_job:=public.hermes_write_name_resolve_v1(v_org,v_scope,jsonb_build_object('jobType',v_type));
        IF v_job->>'status'='resolved' THEN v_job:=v_job->'jobType'; END IF;
      END IF;
      IF v_type IS NULL OR v_job ? 'status' THEN
        -- So theo từ: bỏ dấu (hàm dùng chung) rồi mọi ký tự không phải chữ/số thành một khoảng trắng ("nước," = "nuoc").
        v_fold:=btrim(regexp_replace(public.hermes_name_fold_v1(v_content),'[^a-z0-9]+',' ','g'));
        v_jfold:=CASE WHEN v_type IS NULL THEN '' ELSE btrim(regexp_replace(public.hermes_name_fold_v1(v_type),'[^a-z0-9]+',' ','g')) END;
        v_cwords:=string_to_array(v_fold,' ');
        v_jwords:=CASE WHEN v_jfold='' THEN '{}'::text[] ELSE string_to_array(v_jfold,' ') END;
        WITH syn(p,kc) AS (VALUES ('sua chua','sua'),('sua sang','sua'),('bao tri','sua'),('bao duong','sua'),('khac phuc','sua'),
            ('hu hong','sua'),('bi hu','sua'),('hong','sua'),('lap dat','sua'),('dieu chinh','sua'),
            ('kiem tra','check'),('ra soat','check'),('kiem dinh','check'),('xem xet','check'),
            ('nhan phong','checkin'),('ky hop dong','checkin'),('lam hop dong','checkin'),('dan khach','checkin'),
            ('don dep','vesinh'),('don phong','vesinh'),('don ve sinh','vesinh'),('don rac','vesinh'),('lau chui','vesinh'),('lau don','vesinh'),
            ('quet don','vesinh'),('quet rac','vesinh'),('chui rua','vesinh'),('ve sinh','vesinh'),
            ('don dep','ve'),('don phong','ve'),('don ve sinh','ve'),('lau chui','ve'),('quet don','ve'),('chui rua','ve'),
            ('thay the','thay'),('thay moi','thay'),('doi moi','thay'),
            ('mua sam','mua'),('dat mua','mua'),
            ('giat ui','giat'),('giat say','giat'),('giat giu','giat'),
            ('thong tac','thong'),('thong cong','thong'),('tac nghen','thong'),('bi tac','thong'),('nghet','thong'),
            ('trang tri','decor'),('bai tri','decor'),
            ('tang ca','ot'),('ngoai gio','ot'),('thu tien','ot')),
        t AS (SELECT j.id,j.name,btrim(regexp_replace(public.hermes_name_fold_v1(j.name),'[^a-z0-9]+',' ','g')) k
          FROM public.job_types j WHERE j.organization_id=v_org AND COALESCE(j.is_active,true) AND btrim(COALESCE(j.name,''))<>''
            AND NOT public.job_type_building_like_v1(v_org,j.name)),
        u AS (SELECT t.id,t.name,t.k,replace(t.k,' ','') kc FROM t),
        s AS (SELECT u.id,u.name,u.kc,CASE
            WHEN u.kc='' THEN 0
            WHEN v_jfold<>'' AND replace(v_jfold,' ','')=u.kc THEN 95
            WHEN v_jfold<>'' AND (left(v_jfold,char_length(u.k)+1)=u.k||' ' OR v_jwords[1]||COALESCE(v_jwords[2],'')=u.kc
              OR v_jwords[1]||COALESCE(v_jwords[2],'')||COALESCE(v_jwords[3],'')=u.kc) THEN 92
            WHEN v_fold=u.k OR left(v_fold,char_length(u.k)+1)=u.k||' ' OR v_cwords[1]||COALESCE(v_cwords[2],'')=u.kc
              OR v_cwords[1]||COALESCE(v_cwords[2],'')||COALESCE(v_cwords[3],'')=u.kc THEN 90
            WHEN v_jfold<>'' AND (position(' '||u.k||' ' IN ' '||v_jfold||' ')>0 OR EXISTS(SELECT 1 FROM generate_series(1,cardinality(v_jwords)) i
              WHERE v_jwords[i]||COALESCE(v_jwords[i+1],'')=u.kc OR v_jwords[i]||COALESCE(v_jwords[i+1],'')||COALESCE(v_jwords[i+2],'')=u.kc)) THEN 80
            WHEN v_jfold<>'' AND EXISTS(SELECT 1 FROM syn WHERE syn.kc=u.kc AND position(' '||syn.p||' ' IN ' '||v_jfold||' ')>0) THEN 70
            WHEN position(' '||u.k||' ' IN ' '||v_fold||' ')>0 OR EXISTS(SELECT 1 FROM generate_series(1,cardinality(v_cwords)) i
              WHERE v_cwords[i]||COALESCE(v_cwords[i+1],'')=u.kc OR v_cwords[i]||COALESCE(v_cwords[i+1],'')||COALESCE(v_cwords[i+2],'')=u.kc) THEN 60
            WHEN EXISTS(SELECT 1 FROM syn WHERE syn.kc=u.kc AND position(' '||syn.p||' ' IN ' '||v_fold||' ')>0) THEN 50
            ELSE 0 END AS base,
            EXISTS(SELECT 1 FROM syn WHERE syn.kc=u.kc AND (v_fold=syn.p OR left(v_fold,char_length(syn.p)+1)=syn.p||' '
              OR v_jfold=syn.p OR left(v_jfold,char_length(syn.p)+1)=syn.p||' ')) AS lead FROM u),
        r AS (SELECT s.id,s.name,CASE WHEN s.base>0 THEN s.base*100+least(char_length(s.kc),99) ELSE 0 END AS score,
            CASE WHEN s.base>0 THEN s.base*100+least(char_length(s.kc),99) ELSE
              (SELECT COALESCE(max(n),0) FROM unnest(v_cwords||v_jwords) w(x),generate_series(2,least(char_length(w.x),char_length(s.kc))) n
                WHERE left(w.x,n)=left(s.kc,n)) END AS rank,
            EXISTS(SELECT 1 FROM public.jobs x WHERE x.organization_id=v_org AND x.job_type_id=s.id) AS used,s.lead,s.kc FROM s)
        SELECT COALESCE(jsonb_agg(jsonb_build_object('id',r.id,'name',r.name,'score',r.score,'used',r.used,'lead',r.lead,'kc',r.kc) ORDER BY r.rank DESC,r.name,r.id),'[]'::jsonb)
          INTO v_found FROM r;
        v_best:=COALESCE((v_found->0->>'score')::int,0);
        IF v_best>=5000 AND (jsonb_array_length(v_found)=1 OR (v_found->1->>'score')::int<v_best) THEN
          -- Lượt 12 (nghiệm thu sau C1): KHÔNG phải đoán (không cờ, không xem trước vì loại, lô không cảnh báo) khi loại duy nhất điểm cao
          -- nhất được NÊU rõ: chuỗi loại trùng tên loại bỏ dấu / hoa thường / dấu câu / khoảng trắng (95: "ve sinh" = "vesinh"); hoặc chuỗi
          -- loại mở đầu bằng tên loại (92: "sửa vòi nước"), nội dung mở đầu bằng tên loại (90, như cú pháp "<loại> <mô tả>" của ô gõ nhanh
          -- web), nội dung / chuỗi loại mở đầu bằng cụm đồng nghĩa trỏ tới loại đó ("Kiểm tra điện" → check) — ba trường hợp sau chỉ khi
          -- chuỗi loại không trỏ sang loại KHÁC (không loại nào khác ở mức 80 / 70, trừ loại có tên nằm lọt trong tên loại đứng đầu:
          -- "vệ" trong "vệ sinh"). Từ giữa nội dung vẫn là đoán (luôn xem trước).
          v_job:=jsonb_build_object('id',v_found->0->'id','name',v_found->0->'name'); v_twanted:=v_type;
          v_guessed:=NOT (v_best>=9500 OR ((v_best>=9000 OR v_found->0->'lead'='true'::jsonb) AND NOT EXISTS(SELECT 1
            FROM jsonb_array_elements(v_found) WITH ORDINALITY y(e,ord) WHERE y.ord>1 AND (y.e->>'score')::int BETWEEN 7000 AND 8999
              AND strpos(v_found->0->>'kc',y.e->>'kc')=0)));
        ELSIF jsonb_array_length(v_found)=0 AND v_type IS NOT NULL THEN
          v_one:=v_job; EXIT one;  -- không thấy loại nào (vd thiếu task_types.view): giữ nguyên kết quả hàm giải tên, không gợi ý
        ELSE
          -- Nghiệm thu: gợi ý không nêu loại chưa từng dùng mà cũng không có điểm (danh mục production có "ml", "thông": 0 việc).
          v_one:=jsonb_build_object('status','unresolved','field','jobType','wanted','','why','unspecified',
            'candidates',(SELECT COALESCE(jsonb_agg(jsonb_build_object('name',f.e->'name') ORDER BY f.n),'[]'::jsonb) FROM (
                SELECT y.e,row_number() OVER (ORDER BY y.ord) n FROM jsonb_array_elements(v_found) WITH ORDINALITY y(e,ord)
                WHERE y.e->'used'='true'::jsonb OR (y.e->>'score')::int>0) f WHERE f.n<=5),
            'more',(SELECT count(*) FROM jsonb_array_elements(v_found) e WHERE e->'used'='true'::jsonb OR (e->>'score')::int>0)>5); EXIT one;
        END IF;
      END IF;

      -- Người nhận (review Mốc 2, chặn 1): chỉ từ KHÔNG thể là tên người mới hiểu là chính người hỏi (lượt 13: tự giao LUÔN xem trước). "mình", "anh",
      -- "chị", "em" có thể là tên (Minh, Anh…) ⇒ qua hàm giải tên (hồ sơ thấy được + thành viên ACTIVE); không thấy ai tên như vậy
      -- thì hiểu là chính người hỏi nhưng cờ mơ hồ ⇒ LUÔN xem trước. Tên giải ra đúng người hỏi cũng tính là mơ hồ. Trống ⇒ Q31.
      IF v_person IS NOT NULL THEN
        v_pfold:=public.hermes_name_fold_v1(v_person);
        IF v_pfold IN ('toi','tui','self','me','chinh minh','chinh toi','ban than') THEN v_self:=true; v_person:=NULL;
        -- Lượt 13 (nghiệm thu: bot gửi "anh" / "tôi" khi người dùng không tự giao): danh xưng trơn ("anh", "chị", "em", "a", "ảnh", "ổng",
        -- "bả", "anh ấy"…) không phải tên ⇒ hỏi giao cho ai; không thành chính người hỏi, không thành người quản lý (Q31).
        ELSIF btrim(regexp_replace(v_pfold,'[^a-z0-9]+',' ','g')) ~ '^(anh|chi|em|co|chu|bac|ong|ba|thay|di|cau|ban|a|c|e)( (ay|ta|kia|do))?$' THEN
          v_one:=jsonb_build_object('status','unresolved','field','person','wanted','','why','unspecified',
            'candidates','[]'::jsonb,'more',false); EXIT one;
        ELSIF v_pfold='minh' THEN v_ambiguous:=true; END IF;
      END IF;
      IF v_person IS NOT NULL THEN
        v_who:=public.hermes_write_name_resolve_v1(v_org,v_scope,jsonb_build_object('person',v_person));
        IF v_who->>'status'='resolved' THEN
          v_who:=v_who->'person';
          IF v_who->>'id'=auth.uid()::text THEN v_ambiguous:=true; END IF;
        ELSIF v_ambiguous AND v_who->>'why'='not_visible' THEN
          v_who:=jsonb_build_object('id',auth.uid(),'name',(SELECT p.full_name FROM public.profiles p WHERE p.id=auth.uid()));
        ELSE
          -- Lượt 12: tên mơ hồ (nhiều người) ở task.create ⇒ kèm id ứng viên (mỗi tên giải lại đúng một người dưới RLS người hỏi; tên
          -- trùng hẳn nhau thì bỏ) để bước chuẩn bị ghi lời mời chọn như Q31. Khoá 'offer' không ra khỏi bước chuẩn bị.
          IF NOT v_batch AND p_action='task.create' AND v_who->>'why'='ambiguous' THEN
            v_who:=v_who||jsonb_build_object('offer',jsonb_build_object('buildingId',v_res#>'{building,id}','ids',
              (SELECT COALESCE(jsonb_agg(x.id ORDER BY x.ord),'[]'::jsonb) FROM (SELECT c.ord,public.hermes_write_name_resolve_v1(v_org,v_scope,
                  jsonb_build_object('person',c.e->>'name'))#>'{person,id}' AS id FROM jsonb_array_elements(v_who->'candidates') WITH ORDINALITY c(e,ord)) x
                WHERE jsonb_typeof(x.id)='string')));
          END IF;
          v_one:=v_who; EXIT one;
        END IF;
      ELSIF v_self THEN
        v_who:=jsonb_build_object('id',auth.uid(),'name',(SELECT p.full_name FROM public.profiles p WHERE p.id=auth.uid()));
      ELSIF jsonb_typeof(v_item->'_assignee')='object' THEN
        v_who:=v_item->'_assignee';
      END IF;

      -- Hạn (Q30): trống ⇒ hết ngày mai giờ công ty; đã qua ⇒ hỏi lại.
      IF jsonb_typeof(v_item->'deadline')='string' THEN
        IF v_item->>'deadline' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN v_one:=jsonb_build_object('status','invalid','reason','invalid_params'); EXIT one; END IF;
        v_date:=(v_item->>'deadline')::date;
      END IF;
      IF jsonb_typeof(v_item->'deadlineTime')='string' THEN
        IF v_item->>'deadlineTime' !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' THEN v_one:=jsonb_build_object('status','invalid','reason','invalid_params'); EXIT one; END IF;
        v_time:=(v_item->>'deadlineTime')::time;
      END IF;
      v_deadline:=public.job_deadline_v1(v_org,v_date,v_time);
      IF v_deadline IS NULL OR v_deadline<=clock_timestamp() THEN v_one:=jsonb_build_object('status','invalid','reason','date_out_of_range'); EXIT one; END IF;

      -- Tiêu đề như web: "<loại> <nội dung>", bỏ lặp nếu nội dung đã mở đầu bằng tên loại.
      v_fold:=public.hermes_name_fold_v1(v_content); v_tfold:=public.hermes_name_fold_v1(v_job->>'name');
      v_title:=CASE WHEN v_tfold='' OR v_fold=v_tfold OR left(v_fold,char_length(v_tfold)+1)=v_tfold||' ' THEN v_content
        ELSE btrim(v_job->>'name')||' '||v_content END;
      v_title:=left(btrim(regexp_replace(v_title,'\s+',' ','g')),200);
      v_desc:=COALESCE(NULLIF(btrim(v_item->>'description'),''),v_content);
      v_priority:=COALESCE(NULLIF(v_item->>'priority',''),'NORMAL');
      IF v_priority NOT IN ('NORMAL','LOW','URGENT') THEN v_one:=jsonb_build_object('status','invalid','reason','invalid_params'); EXIT one; END IF;
      v_one:=jsonb_build_object('status','resolved','building',v_res->'building','room',v_res->'room',
        'wholeBuilding',v_whole AND v_room IS NULL AND jsonb_typeof(v_res->'room') IS DISTINCT FROM 'object',
        'roomMissing',jsonb_typeof(v_res->'room') IS DISTINCT FROM 'object' AND NOT v_whole,
        'jobType',v_job,'jobTypeGuessed',v_guessed,'jobTypeWanted',left(v_twanted,60),'person',v_who,'personMissing',v_who IS NULL,
        'personAmbiguous',v_ambiguous,'personWanted',CASE WHEN v_ambiguous THEN left(btrim(v_item->>'assigneeName'),40) END,
        'deadline',v_deadline,'deadlineDefaulted',v_date IS NULL,'title',v_title,'description',v_desc,'priority',v_priority); EXIT one;
    END one;
    IF v_one->>'status' IS DISTINCT FROM 'resolved' THEN
      RETURN CASE WHEN v_batch THEN v_one||jsonb_build_object('item',v_i+1) ELSE v_one END;
    END IF;
    v_out:=v_out||jsonb_build_array(v_one);
  END LOOP;
  IF NOT v_batch AND p_action='task.recurring_create' THEN
    RETURN ((v_out->0)-'deadline'-'deadlineDefaulted')||jsonb_build_object('schedule',jsonb_strip_nulls(jsonb_build_object('frequency',p_params->'frequency',
      'every',p_params->'every','weekdays',p_params->'weekdays','monthDay',p_params->'monthDay','startDate',p_params->'startDate',
      'endDate',p_params->'endDate','dueDays',p_params->'dueDays')));
  END IF;
  IF NOT v_batch THEN RETURN v_out->0; END IF;
  RETURN jsonb_strip_nulls(jsonb_build_object('status','resolved','batch',true,'items',v_out,'personMissing',false,'managedBy',v_managed));
END $fn$;

ALTER FUNCTION app_private.hermes_task_resolve_core_v1(jsonb,text,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_task_resolve_core_v1(jsonb,text,jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
-- Lõi: vai authenticated gọi (như 20261022031548 / 20261025003100).
GRANT EXECUTE ON FUNCTION app_private.hermes_task_resolve_core_v1(jsonb,text,jsonb) TO authenticated;

DO $check$
BEGIN
  IF (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid='app_private.hermes_task_resolve_core_v1(jsonb,text,jsonb)'::regprocedure AND NOT p.prosecdef) IS DISTINCT FROM '3ca074bbadcf365e24dfcb5e132ca919'
    OR NOT has_function_privilege('authenticated','app_private.hermes_task_resolve_core_v1(jsonb,text,jsonb)','EXECUTE')
    OR has_function_privilege('anon','app_private.hermes_task_resolve_core_v1(jsonb,text,jsonb)','EXECUTE') THEN
    RAISE EXCEPTION 'hermes_task_room_by_job_check_failed'; END IF;
END $check$;

COMMIT;
NOTIFY pgrst,'reload schema';
