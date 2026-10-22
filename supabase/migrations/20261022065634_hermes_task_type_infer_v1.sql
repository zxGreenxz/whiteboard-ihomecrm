-- Hermes Đợt 2b — trang Công việc, Mốc 2c (docs/plans/hermes-crm/CONG-VIEC-THAO-TAC-GHI.md mục 18): bot thật trên TEST 22/10
-- trượt 5/11 ca vì mô hình tự đặt jobType không có trong danh mục ("kiểm tra điện", "Bảo trì", "Dọn vệ sinh", "Sửa chữa") ⇒ máy chủ
-- trả needs_input kèm gợi ý xếp theo chữ cái. Chỉ thay THÂN hai hàm của 20261022031548 (đã áp TEST, chưa áp production; dựng từ thân
-- đang chạy, ghim md5 ở dưới — thân khác ⇒ dừng, không đè bản vá nào). Cùng chữ ký nên OID giữ nguyên: vỏ hermes_task_action_v1
-- (BEGIN ATOMIC, gắn OID) không phải dựng lại.
--  (1) Lõi giải tên: jobType không khớp ⇒ coi như chưa nêu, tự suy theo nội dung + chính chuỗi đó (đầu nội dung, chứa tên loại,
--      đồng nghĩa phổ biến trỏ tới tên loại thật); suy được đúng một ⇒ dùng + cờ đoán (luôn xem trước); không ⇒ hỏi lại kèm tối đa
--      5 gợi ý xếp theo độ gần với nội dung.
--  (2) Chuẩn bị: bản xem trước ghi "(loại X, tự chọn theo nội dung)"; cảnh báo nêu chuỗi loại không khớp và loại đã tự chọn.
-- Quyền, chủ hàm, tầng INVOKER/DEFINER không đổi (đặt lại như 031548). Idempotent; khối kiểm cuối chỉ đọc catalog.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $requires$
BEGIN
  IF to_regprocedure('app_private.hermes_task_resolve_core_v1(jsonb,text,jsonb)') IS NULL OR to_regprocedure('app_private.hermes_task_action_prepare_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb,jsonb)') IS NULL
    OR to_regprocedure('public.hermes_task_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text)') IS NULL
    OR to_regprocedure('public.hermes_write_name_resolve_v1(uuid,uuid[],jsonb)') IS NULL
    OR to_regprocedure('public.hermes_name_fold_v1(text)') IS NULL
    -- Thân đang chạy phải đúng thân 20261022031548 (hoặc đúng thân của file này khi chạy lại).
    OR (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid='app_private.hermes_task_resolve_core_v1(jsonb,text,jsonb)'::regprocedure) NOT IN ('2c7dd0a806a4d97e41439ced11dc59d9','8b1e8543174fab584d9e70083adc258b')
    OR (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid='app_private.hermes_task_action_prepare_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb,jsonb)'::regprocedure) NOT IN ('0a01318d715b78f2e9dda786c8729842','f044e2e6e8127a15a4f534285d08e220') THEN
    RAISE EXCEPTION 'hermes_task_type_infer_dependency_invalid'; END IF;
END $requires$;

-- 1. Lõi giải tên (INVOKER, dưới RLS người hỏi; chỉ tham chiếu public.*).
CREATE OR REPLACE FUNCTION app_private.hermes_task_resolve_core_v1(p_ctx jsonb,p_action text,p_params jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $fn$
DECLARE v_org uuid; v_scope uuid[]; v_building text; v_room text; v_type text; v_person text; v_content text; v_whole boolean:=false;
  v_self boolean:=false; v_res jsonb; v_job jsonb; v_who jsonb; v_guessed boolean:=false; v_date date; v_time time; v_deadline timestamptz;
  v_fold text; v_tfold text; v_title text; v_desc text; v_priority text; v_found jsonb; v_best integer; v_more boolean;
  v_pfold text; v_ambiguous boolean:=false; v_jfold text; v_cwords text[]; v_jwords text[]; v_twanted text;
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

  -- Loại việc (Mốc 2c, bot thật trên TEST 22/10): nêu tên khớp đúng một loại ⇒ dùng. Không khớp (mô hình hay tự đặt "Bảo trì",
  -- "Dọn vệ sinh", "kiểm tra điện"…) ⇒ coi như CHƯA nêu và tự suy theo nội dung + chính chuỗi đó, chấm điểm trên các loại đang bật
  -- mà người hỏi thấy được (RLS): 95 chuỗi loại bỏ khoảng trắng trùng tên loại ("ve sinh" ~ "vesinh") > 90 đầu nội dung (như ô gõ
  -- nhanh của web) > 80 chuỗi loại chứa tên loại > 70 đồng nghĩa trong chuỗi loại > 60 nội dung chứa tên loại > 50 đồng nghĩa trong
  -- nội dung; cùng mức thì tên dài hơn thắng. Đúng một loại điểm cao nhất ⇒ dùng + cờ đoán (luôn xem trước). Không suy được hoặc
  -- hoà ⇒ hỏi lại kèm tối đa 5 gợi ý xếp theo độ gần (điểm, rồi tiền tố chung dài nhất với một từ), không chọn bừa. Đồng nghĩa chỉ
  -- trỏ tới tên loại (bỏ dấu, bỏ khoảng trắng) có trong danh mục thật; công ty không có loại đó thì dòng tự bỏ qua.
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
      FROM public.job_types j WHERE j.organization_id=v_org AND COALESCE(j.is_active,true) AND btrim(COALESCE(j.name,''))<>''),
    u AS (SELECT t.id,t.name,t.k,replace(t.k,' ','') kc FROM t),
    s AS (SELECT u.id,u.name,u.kc,CASE
        WHEN u.kc='' THEN 0
        WHEN v_jfold<>'' AND replace(v_jfold,' ','')=u.kc THEN 95
        WHEN v_fold=u.k OR left(v_fold,char_length(u.k)+1)=u.k||' ' OR v_cwords[1]||COALESCE(v_cwords[2],'')=u.kc
          OR v_cwords[1]||COALESCE(v_cwords[2],'')||COALESCE(v_cwords[3],'')=u.kc THEN 90
        WHEN v_jfold<>'' AND (position(' '||u.k||' ' IN ' '||v_jfold||' ')>0 OR EXISTS(SELECT 1 FROM generate_series(1,cardinality(v_jwords)) i
          WHERE v_jwords[i]||COALESCE(v_jwords[i+1],'')=u.kc OR v_jwords[i]||COALESCE(v_jwords[i+1],'')||COALESCE(v_jwords[i+2],'')=u.kc)) THEN 80
        WHEN v_jfold<>'' AND EXISTS(SELECT 1 FROM syn WHERE syn.kc=u.kc AND position(' '||syn.p||' ' IN ' '||v_jfold||' ')>0) THEN 70
        WHEN position(' '||u.k||' ' IN ' '||v_fold||' ')>0 OR EXISTS(SELECT 1 FROM generate_series(1,cardinality(v_cwords)) i
          WHERE v_cwords[i]||COALESCE(v_cwords[i+1],'')=u.kc OR v_cwords[i]||COALESCE(v_cwords[i+1],'')||COALESCE(v_cwords[i+2],'')=u.kc) THEN 60
        WHEN EXISTS(SELECT 1 FROM syn WHERE syn.kc=u.kc AND position(' '||syn.p||' ' IN ' '||v_fold||' ')>0) THEN 50
        ELSE 0 END AS base FROM u),
    r AS (SELECT s.id,s.name,CASE WHEN s.base>0 THEN s.base*100+least(char_length(s.kc),99) ELSE 0 END AS score,
        CASE WHEN s.base>0 THEN s.base*100+least(char_length(s.kc),99) ELSE
          (SELECT COALESCE(max(n),0) FROM unnest(v_cwords||v_jwords) w(x),generate_series(2,least(char_length(w.x),char_length(s.kc))) n
            WHERE left(w.x,n)=left(s.kc,n)) END AS rank FROM s)
    SELECT COALESCE(jsonb_agg(jsonb_build_object('id',r.id,'name',r.name,'score',r.score) ORDER BY r.rank DESC,r.name,r.id),'[]'::jsonb)
      INTO v_found FROM r;
    v_best:=COALESCE((v_found->0->>'score')::int,0);
    IF v_best>=5000 AND (jsonb_array_length(v_found)=1 OR (v_found->1->>'score')::int<v_best) THEN
      v_job:=jsonb_build_object('id',v_found->0->'id','name',v_found->0->'name'); v_guessed:=true; v_twanted:=v_type;
    ELSIF jsonb_array_length(v_found)=0 AND v_type IS NOT NULL THEN
      RETURN v_job;  -- không thấy loại nào (vd thiếu task_types.view): giữ nguyên kết quả hàm giải tên, không gợi ý
    ELSE
      RETURN jsonb_build_object('status','unresolved','field','jobType','wanted','','why','unspecified',
        'candidates',(SELECT COALESCE(jsonb_agg(jsonb_build_object('name',e->'name') ORDER BY ord),'[]'::jsonb)
          FROM jsonb_array_elements(v_found) WITH ORDINALITY y(e,ord) WHERE ord<=5),
        'more',jsonb_array_length(v_found)>5);
    END IF;
  END IF;

  -- Người nhận (review Mốc 2, chặn 1): chỉ từ KHÔNG thể là tên người mới hiểu là chính người hỏi và được ghi thẳng. "mình", "anh",
  -- "chị", "em" có thể là tên (Minh, Anh…) ⇒ qua hàm giải tên (hồ sơ thấy được + thành viên ACTIVE); không thấy ai tên như vậy
  -- thì hiểu là chính người hỏi nhưng cờ mơ hồ ⇒ LUÔN xem trước. Tên giải ra đúng người hỏi cũng tính là mơ hồ. Trống ⇒ Q31.
  IF v_person IS NOT NULL THEN
    v_pfold:=public.hermes_name_fold_v1(v_person);
    IF v_pfold IN ('toi','tui','self','me','chinh minh','chinh toi','ban than') THEN v_self:=true; v_person:=NULL;
    ELSIF v_pfold IN ('minh','anh','chi','em') THEN v_ambiguous:=true; END IF;
  END IF;
  IF v_person IS NOT NULL THEN
    v_who:=public.hermes_write_name_resolve_v1(v_org,v_scope,jsonb_build_object('person',v_person));
    IF v_who->>'status'='resolved' THEN
      v_who:=v_who->'person';
      IF v_who->>'id'=auth.uid()::text THEN v_ambiguous:=true; END IF;
    ELSIF v_ambiguous AND v_who->>'why'='not_visible' THEN
      v_who:=jsonb_build_object('id',auth.uid(),'name',(SELECT p.full_name FROM public.profiles p WHERE p.id=auth.uid()));
    ELSE RETURN v_who;
    END IF;
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
    'jobType',v_job,'jobTypeGuessed',v_guessed,'jobTypeWanted',left(v_twanted,60),'person',v_who,'personMissing',v_who IS NULL,
    'personAmbiguous',v_ambiguous,'personWanted',CASE WHEN v_ambiguous THEN left(btrim(p_params->>'assigneeName'),40) END,
    'deadline',v_deadline,'deadlineDefaulted',v_date IS NULL,'title',v_title,'description',v_desc,'priority',v_priority);
END $fn$;

-- 2. Chuẩn bị (DEFINER).
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
      'jobTypeWanted',COALESCE(p_resolution->'jobTypeWanted','null'::jsonb),
      'assigneeId',COALESCE(p_resolution#>'{person,id}','null'::jsonb),'assigneeSuggested',false,
      'assigneeAmbiguous',COALESCE(p_resolution->'personAmbiguous','false'::jsonb),'assigneeWanted',COALESCE(p_resolution->'personWanted','null'::jsonb),
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

  -- Lượt có thể ghi (auto/apply): khoá theo (công ty, toà) TRƯỚC khi tính việc trùng (review Mốc 2, mục 4) — hai lời gọi song song
  -- khác requestId không cùng thấy "chưa có việc trùng" rồi cùng tạo; lời gọi sau thấy việc của lời gọi trước (basis lệch hoặc
  -- phải xem trước). Khoá giữ tới hết giao dịch ghi.
  IF p_phase<>'preview' THEN PERFORM pg_advisory_xact_lock(hashtextextended('hermes_task_dup:'||v_org::text||':'||v_building::text,0)); END IF;
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
      OR v->'assigneeSuggested'='true'::jsonb OR v->'assigneeAmbiguous'='true'::jsonb OR NOT v_manages;
    IF v_confirm THEN
      -- Mốc 2c: loại mô hình nêu không khớp ⇒ nói rõ đã tự chọn loại nào thay cho chuỗi đó (để người dùng sửa nếu sai).
      IF v->'jobTypeGuessed'='true'::jsonb THEN v_warnings:=v_warnings||to_jsonb(left(CASE WHEN jsonb_typeof(v->'jobTypeWanted')='string'
        THEN format('Không khớp loại việc ''%s''; tự chọn loại ''%s'' theo nội dung — hỏi lại nếu sai.',left(v->>'jobTypeWanted',60),v_type_name)
        ELSE format('Loại việc ''%s'' do bot chọn theo nội dung.',v_type_name) END,300)); END IF;
      IF v->'roomMissing'='true'::jsonb THEN v_warnings:=v_warnings||to_jsonb('Chưa nêu phòng: việc cho CẢ TOÀ.'::text); END IF;
      IF v->'assigneeAmbiguous'='true'::jsonb THEN v_warnings:=v_warnings||to_jsonb(left(CASE WHEN v_assignee=v_actor
        THEN format('Hiểu ''%s'' là chính anh/chị; nếu là người khác, nêu đủ tên người đó.',v->>'assigneeWanted')
        ELSE format('Hiểu ''%s'' là người nhận %s; nếu ý là chính anh/chị, nói "giao cho tôi".',v->>'assigneeWanted',COALESCE(v_assignee_name,'(không xem được tên)')) END,300));
      END IF;
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
        ||format('Tạo việc ''%s'' (loại %s%s) — %s — giao %s — hạn %s — ưu tiên %s.',v->>'title',v_type_name,
          CASE WHEN v->'jobTypeGuessed'='true'::jsonb THEN ', tự chọn theo nội dung' ELSE '' END,v_place,v_who,
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

ALTER FUNCTION app_private.hermes_task_resolve_core_v1(jsonb,text,jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_task_action_prepare_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_task_resolve_core_v1(jsonb,text,jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION app_private.hermes_task_action_prepare_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
-- Vỏ chạy dưới vai authenticated tới hai hàm qua OID: giữ EXECUTE như 031548.
GRANT EXECUTE ON FUNCTION app_private.hermes_task_resolve_core_v1(jsonb,text,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION app_private.hermes_task_action_prepare_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb,jsonb) TO authenticated;

DO $check$
BEGIN
  IF (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid='app_private.hermes_task_resolve_core_v1(jsonb,text,jsonb)'::regprocedure AND NOT p.prosecdef) IS DISTINCT FROM '8b1e8543174fab584d9e70083adc258b'
    OR (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid='app_private.hermes_task_action_prepare_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb,jsonb)'::regprocedure AND p.prosecdef) IS DISTINCT FROM 'f044e2e6e8127a15a4f534285d08e220'
    OR has_function_privilege('anon','app_private.hermes_task_resolve_core_v1(jsonb,text,jsonb)','EXECUTE')
    OR has_function_privilege('anon','app_private.hermes_task_action_prepare_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb,jsonb)','EXECUTE')
    OR NOT has_function_privilege('authenticated','app_private.hermes_task_action_prepare_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb,jsonb)','EXECUTE') THEN
    RAISE EXCEPTION 'hermes_task_type_infer_check_failed'; END IF;
END $check$;

COMMIT;
NOTIFY pgrst,'reload schema';
