-- Hermes Đợt 2b — trang Công việc, Mốc 5 (docs/plans/hermes-crm/CONG-VIEC-THAO-TAC-GHI.md mục 2, 5, 22): việc định kỳ bằng tên —
-- task.recurring_create / task.recurring_update / task.recurring_pause (resume = chạy lại) / task.recurring_delete. Chỉ file, chưa áp.
-- Cùng vỏ public.hermes_task_action_v1 (BEGIN ATOMIC, gắn OID — không dựng lại). Thay THÂN bốn tầng vỏ gắn, dựng từ thân của
-- 20261022164201 (Mốc 4; md5 ghim ở dưới — thân khác ⇒ dừng, không đè bản vá nào); cùng chữ ký ⇒ OID giữ nguyên. Áp SAU 164201 và SAU
-- 20261023042424_job_recurrence_v1 (bảng + hàm ghi CRM dùng chung).
--  (1) Lõi giải tên: tạo đi chung nhánh một mục của task.create (toà / phòng / loại / người nhận / tiêu đề như web) + lịch thô; sửa /
--      tạm dừng / xoá tìm ĐÚNG MỘT quy tắc (mã DK-NNNN hoặc nội dung bỏ dấu) dưới RLS người hỏi, mơ hồ ⇒ hỏi lại, không tự chọn.
--  (2) Chuẩn bị (DEFINER, hàm mới hermes_task_recurring_prepare_v1): guard chung, phát lại, Q31, phạm vi toà của khoá, chuẩn hoá lịch
--      như trigger CRM, ba lần tới, trần 100 quy tắc, basis (tạo: bản đã giải; còn lại: id + version quy tắc + thay đổi), LUÔN xem
--      trước, khoá dòng quy tắc NOWAIT ở lượt có thể ghi, mở biên nhận.
--  (3) Ghi (INVOKER): gọi đúng public.job_recurrence_create_v1 / _update_v1 / _set_paused_v1 / _delete_v1 dưới RLS + trigger kiểm khoá.
--  (4) Chốt (DEFINER, hàm mới hermes_task_recurring_finish_v1): đối chiếu dòng quy tắc với kế hoạch, audit HERMES_TASK_RECURRING_*,
--      chốt biên nhận; vượt trần ⇒ recurrence_quota.
-- KHÔNG chèn dòng chính sách: bốn thao tác TẮT tới khi phiên chính chèn bằng migration riêng. Idempotent; khối kiểm cuối chỉ đọc catalog.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $requires$
BEGIN
  IF to_regclass('public.job_recurrence_rules') IS NULL
    OR to_regprocedure('public.job_recurrence_create_v1(uuid,uuid,uuid,uuid,text,text,uuid,text,text,integer,integer[],integer,date,date,integer)') IS NULL
    OR to_regprocedure('public.job_recurrence_update_v1(uuid,integer,jsonb)') IS NULL
    OR to_regprocedure('public.job_recurrence_set_paused_v1(uuid,integer,boolean)') IS NULL
    OR to_regprocedure('public.job_recurrence_delete_v1(uuid,integer)') IS NULL
    OR to_regprocedure('public.job_recurrence_dates_v1(text,integer,smallint[],integer,date,date,date,date)') IS NULL
    OR to_regprocedure('public.job_recurrence_schedule_text_v1(text,integer,smallint[],integer)') IS NULL
    OR to_regprocedure('public.org_today_v1(uuid)') IS NULL
    OR to_regprocedure('app_private.hermes_task_batch_prepare_v1(jsonb,text,uuid,jsonb,jsonb,text,jsonb)') IS NULL
    OR to_regprocedure('app_private.hermes_task_assignee_member_v1(uuid,uuid)') IS NULL
    OR to_regprocedure('app_private.authorize_tenant_action_v3(uuid,uuid,text,uuid,uuid)') IS NULL
    OR to_regprocedure('app_private.lock_org_for_decision_v1(uuid)') IS NULL
    -- Thân đang chạy phải đúng thân 20261022164201 (hoặc đúng thân của file này khi chạy lại).
    OR (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid='app_private.hermes_task_resolve_core_v1(jsonb,text,jsonb)'::regprocedure) NOT IN ('c69e78e1d9765ca073f0a5dd89d142d0','0a399cc52caa8dbb12cf6e8cc7936f42')
    OR (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid='app_private.hermes_task_action_prepare_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb,jsonb)'::regprocedure) NOT IN ('50fab164254d23455ca31d5442ae73f3','1f0b98d1a0ace9c61da52858f4fefac5')
    OR (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid='app_private.hermes_task_action_write_v1(jsonb)'::regprocedure) NOT IN ('564705393a88b2ed75911a68e8dff5dd','b8877759e02fbe3a55536b0fe8c54638')
    OR (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid='app_private.hermes_task_action_finish_v1(jsonb,text,jsonb)'::regprocedure) NOT IN ('2a352c005cf388869fa54289fb6e03dc','6a9ad71cdc880001faeaa1070f637528') THEN
    RAISE EXCEPTION 'hermes_task_recurring_dependency_invalid'; END IF;
END $requires$;

-- KHOÁ ĐỂ TẮT: file này KHÔNG chèn dòng chính sách nào cho task.recurring_*. Không có dòng chính sách ⇒ danh mục thao tác sống
-- (hermes_action_capabilities_v1) không có bốn thao tác ⇒ connector không quảng bá, guard từ chối. Bật = một migration riêng của
-- phiên chính chèn bốn dòng (CONG-VIEC-THAO-TAC-GHI.md mục 22).

-- 1. Chuẩn bị (DEFINER) của bốn thao tác việc định kỳ: guard chung, phát lại theo requestId, Q31, kiểm phạm vi, chuẩn hoá + kiểm lịch,
--    trần 100 quy tắc, basis, LUÔN xem trước, mở biên nhận ở lượt ghi. Lượt có thể ghi khoá dòng quy tắc NOWAIT (bận ⇒ 55P03 ⇒
--    state_changed): bộ sinh / web không khoá dòng công ty nên không có vòng với guard, nhưng không chờ dòng đang bị giữ.
CREATE OR REPLACE FUNCTION app_private.hermes_task_recurring_prepare_v1(p_binding jsonb,p_action text,p_phase text,p_request_id uuid,
  p_params jsonb,p_resolved jsonb,p_expected_basis text,p_resolution jsonb,p_managers jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE ctx jsonb; v_org uuid; v_actor uuid; v jsonb; v_receipt app_private.hermes_action_receipts; v_begin jsonb; v_today date; s jsonb;
  v_building uuid; v_room uuid; v_type uuid; v_assignee uuid; v_building_name text; v_room_name text; v_type_name text; v_assignee_name text;
  v_manages boolean:=true; v_warnings jsonb:='[]'::jsonb; v_text text; v_basis text; v_who text; v_place text; v_n integer;
  v_freq text; v_every integer; v_days smallint[]; v_md integer; v_start date; v_end date; v_due integer; v_next date[]; v_sched text;
  v_rule public.job_recurrence_rules; c jsonb; v_changes jsonb:='{}'::jsonb; v_diff text[]:='{}'::text[]; v_resume boolean; v_rid uuid;
  v_old_sched text; v_new_assignee uuid; v_from date;
BEGIN
  IF p_action IS NULL OR p_action NOT IN ('task.recurring_create','task.recurring_update','task.recurring_pause','task.recurring_delete')
    OR p_phase IS NULL OR p_phase NOT IN ('preview','auto','apply') OR p_request_id IS NULL OR p_params IS NULL OR jsonb_typeof(p_params)<>'object'
    OR (p_phase='apply' AND (p_resolved IS NULL OR jsonb_typeof(p_resolved)<>'object' OR p_expected_basis IS NULL))
    OR (p_phase<>'apply' AND (p_resolution IS NULL OR jsonb_typeof(p_resolution)<>'object')) THEN
    RAISE EXCEPTION 'hermes_task_invalid' USING ERRCODE='22023'; END IF;
  ctx:=app_private.hermes_action_guard_v1(p_binding,p_action);
  v_org:=(ctx->>'organizationId')::uuid; v_actor:=auth.uid(); v_today:=public.org_today_v1(v_org);
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
  IF p_phase<>'apply' THEN
    IF p_resolution->>'status'='unresolved' THEN
      RETURN jsonb_build_object('kind','needs_input','reason','name_unresolved','field',p_resolution->'field','wanted',p_resolution->'wanted',
        'why',p_resolution->'why','candidates',COALESCE(p_resolution->'candidates','[]'::jsonb),'more',COALESCE(p_resolution->'more','false'::jsonb));
    ELSIF p_resolution->>'status'='invalid' AND p_resolution->>'reason' IN ('date_out_of_range','invalid_params','recurrence_unchanged') THEN
      RETURN jsonb_build_object('kind','needs_input','reason',p_resolution->>'reason');
    ELSIF p_resolution->>'status' IS DISTINCT FROM 'resolved' THEN
      RAISE EXCEPTION 'hermes_task_invalid' USING ERRCODE='22023';
    END IF;
  END IF;

  IF p_action='task.recurring_create' THEN
    IF p_phase='apply' THEN v:=p_resolved;
    ELSE
      v:=jsonb_build_object('buildingId',p_resolution#>'{building,id}','roomId',COALESCE(p_resolution#>'{room,id}','null'::jsonb),
        'roomMissing',COALESCE(p_resolution->'roomMissing','false'::jsonb),'jobTypeId',p_resolution#>'{jobType,id}',
        'jobTypeGuessed',COALESCE(p_resolution->'jobTypeGuessed','false'::jsonb),'jobTypeWanted',COALESCE(p_resolution->'jobTypeWanted','null'::jsonb),
        'assigneeId',COALESCE(p_resolution#>'{person,id}','null'::jsonb),'assigneeSuggested',false,
        'assigneeAmbiguous',COALESCE(p_resolution->'personAmbiguous','false'::jsonb),'assigneeWanted',COALESCE(p_resolution->'personWanted','null'::jsonb),
        'title',p_resolution->'title','description',p_resolution->'description','priority',p_resolution->'priority');
      IF p_resolution->'personMissing'='true'::jsonb THEN
        IF jsonb_typeof(p_managers)='array' AND jsonb_array_length(p_managers)=1 THEN
          v:=v||jsonb_build_object('assigneeId',p_managers->0->'id','assigneeSuggested',true);
        ELSE
          RETURN jsonb_build_object('kind','needs_input','reason','name_unresolved','field','person','wanted','','why','unspecified',
            'candidates',(SELECT COALESCE(jsonb_agg(jsonb_build_object('name',e->'name') ORDER BY ord),'[]'::jsonb)
              FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_managers)='array' THEN p_managers ELSE '[]'::jsonb END) WITH ORDINALITY x(e,ord) WHERE ord<=8),
            'more',CASE WHEN jsonb_typeof(p_managers)='array' THEN jsonb_array_length(p_managers)>8 ELSE false END);
        END IF;
      END IF;
      -- Lịch thô từ lõi giải tên ⇒ chuẩn hoá theo đúng luật của trigger CRM (thứ / ngày mặc định theo ngày bắt đầu).
      s:=COALESCE(p_resolution->'schedule','{}'::jsonb);
      v_freq:=s->>'frequency';
      IF v_freq IS NULL OR v_freq NOT IN ('daily','weekly','monthly')
        OR (s ? 'every' AND COALESCE(s->>'every','') !~ '^[0-9]{1,2}$')
        OR (s ? 'monthDay' AND COALESCE(s->>'monthDay','') !~ '^-?[0-9]{1,2}$')
        OR (s ? 'dueDays' AND COALESCE(s->>'dueDays','') !~ '^[0-9]{1,2}$')
        OR (s ? 'startDate' AND COALESCE(s->>'startDate','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
        OR (s ? 'endDate' AND COALESCE(s->>'endDate','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
        OR (s ? 'weekdays' AND (jsonb_typeof(s->'weekdays') IS DISTINCT FROM 'array' OR v_freq<>'weekly'
          OR EXISTS(SELECT 1 FROM jsonb_array_elements(s->'weekdays') e WHERE jsonb_typeof(e) IS DISTINCT FROM 'string'
            OR e#>>'{}' NOT IN ('MON','TUE','WED','THU','FRI','SAT','SUN'))))
        OR (s ? 'monthDay' AND v_freq<>'monthly') THEN
        RETURN jsonb_build_object('kind','needs_input','reason','invalid_params'); END IF;
      v_every:=COALESCE((s->>'every')::integer,1); v_md:=(s->>'monthDay')::integer; v_due:=COALESCE((s->>'dueDays')::integer,0);
      IF v_every NOT BETWEEN 1 AND 12 OR v_due NOT BETWEEN 0 AND 30 OR (v_md IS NOT NULL AND v_md<>-1 AND v_md NOT BETWEEN 1 AND 31) THEN
        RETURN jsonb_build_object('kind','needs_input','reason','invalid_params'); END IF;
      BEGIN
        v_start:=COALESCE((s->>'startDate')::date,v_today); v_end:=(s->>'endDate')::date;
      EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
        RETURN jsonb_build_object('kind','needs_input','reason','invalid_params');
      END;
      IF v_freq='weekly' THEN
        v_days:=COALESCE((SELECT array_agg(DISTINCT array_position(ARRAY['MON','TUE','WED','THU','FRI','SAT','SUN'],e#>>'{}')::smallint
            ORDER BY array_position(ARRAY['MON','TUE','WED','THU','FRI','SAT','SUN'],e#>>'{}')::smallint)
          FROM jsonb_array_elements(COALESCE(s->'weekdays','[]'::jsonb)) e),ARRAY[date_part('isodow',v_start)::smallint]);
      ELSIF v_freq='monthly' THEN v_md:=COALESCE(v_md,date_part('day',v_start)::integer);
      END IF;
      v:=v||jsonb_build_object('frequency',v_freq,'every',v_every,'weekdays',CASE WHEN v_days IS NULL THEN 'null'::jsonb ELSE to_jsonb(v_days) END,
        'monthDay',v_md,'startDate',v_start,'endDate',v_end,'dueDays',v_due);
    END IF;
    BEGIN
      v_building:=(v->>'buildingId')::uuid; v_room:=(v->>'roomId')::uuid; v_type:=(v->>'jobTypeId')::uuid; v_assignee:=(v->>'assigneeId')::uuid;
      v_freq:=v->>'frequency'; v_every:=(v->>'every')::integer; v_md:=(v->>'monthDay')::integer; v_due:=(v->>'dueDays')::integer;
      v_start:=(v->>'startDate')::date; v_end:=(v->>'endDate')::date;
      v_days:=CASE WHEN jsonb_typeof(v->'weekdays')='array' THEN ARRAY(SELECT x::smallint FROM jsonb_array_elements_text(v->'weekdays') x) END;
    EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow OR numeric_value_out_of_range THEN
      RAISE EXCEPTION 'hermes_task_invalid' USING ERRCODE='22023';
    END;
    IF v_building IS NULL OR v_type IS NULL OR v_assignee IS NULL OR v_freq IS NULL OR v_freq NOT IN ('daily','weekly','monthly')
      OR v_every IS NULL OR v_every NOT BETWEEN 1 AND 12 OR v_due IS NULL OR v_due NOT BETWEEN 0 AND 30 OR v_start IS NULL
      OR (v_freq='weekly')<>(v_days IS NOT NULL) OR (v_freq='monthly')<>(v_md IS NOT NULL)
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
    IF v_start<v_today OR (v_end IS NOT NULL AND v_end<v_start) THEN RETURN jsonb_build_object('kind','needs_input','reason','date_out_of_range'); END IF;
    v_next:=ARRAY(SELECT x FROM public.job_recurrence_dates_v1(v_freq,v_every,v_days,v_md,v_start,v_end,v_today,v_today+400) x ORDER BY 1 LIMIT 3);
    IF cardinality(v_next)=0 THEN RETURN jsonb_build_object('kind','needs_input','reason','date_out_of_range'); END IF;
    SELECT p.full_name INTO v_assignee_name FROM public.profiles p WHERE p.id=v_assignee;
    IF v_assignee<>v_actor THEN
      PERFORM app_private.lock_org_for_decision_v1(v_org);
      v_manages:=COALESCE((SELECT a.allowed FROM app_private.authorize_tenant_action_v3(v_assignee,v_org,'tasks.edit',v_building,NULL) a),false);
    END IF;
    -- Trần 100 quy tắc đang chạy (trigger CRM kiểm lại dưới khoá tư vấn theo công ty lúc ghi).
    SELECT count(*) INTO v_n FROM public.job_recurrence_rules r WHERE r.organization_id=v_org AND r.deleted_at IS NULL AND r.paused_at IS NULL
      AND (r.end_date IS NULL OR r.end_date>=v_today);
    IF v_n>=100 THEN RETURN jsonb_build_object('kind','rejected','reason','recurrence_quota'); END IF;
    v_sched:=public.job_recurrence_schedule_text_v1(v_freq,v_every,v_days,v_md);
    v_basis:=md5(jsonb_build_array(p_action,v_building,v_room,v_type,v_assignee,v->>'title',v->>'description',v->>'priority',v_freq,v_every,
      v_days,v_md,v_start,v_end,v_due,v_building_name,v_manages)::text);
    IF p_phase='apply' AND p_expected_basis IS DISTINCT FROM v_basis THEN RETURN jsonb_build_object('kind','rejected','reason','state_changed'); END IF;
    IF p_phase<>'apply' THEN
      IF v->'jobTypeGuessed'='true'::jsonb THEN v_warnings:=v_warnings||to_jsonb(left(CASE WHEN jsonb_typeof(v->'jobTypeWanted')='string'
        THEN format('Không khớp loại việc ''%s''; tự chọn loại ''%s'' theo nội dung — hỏi lại nếu sai.',left(v->>'jobTypeWanted',60),v_type_name)
        ELSE format('Loại việc ''%s'' do bot chọn theo nội dung.',v_type_name) END,300)); END IF;
      IF v->'roomMissing'='true'::jsonb THEN v_warnings:=v_warnings||to_jsonb('Chưa nêu phòng: mỗi lần sinh một việc cho CẢ TOÀ.'::text); END IF;
      IF v->'assigneeAmbiguous'='true'::jsonb THEN v_warnings:=v_warnings||to_jsonb(left(CASE WHEN v_assignee=v_actor
        THEN format('Hiểu ''%s'' là chính anh/chị; nếu là người khác, nêu đủ tên người đó.',v->>'assigneeWanted')
        ELSE format('Hiểu ''%s'' là người nhận %s; nếu ý là chính anh/chị, nói "giao cho tôi".',v->>'assigneeWanted',COALESCE(v_assignee_name,'(không xem được tên)')) END,300));
      END IF;
      IF NOT v_manages THEN v_warnings:=v_warnings||to_jsonb(left(format('%s không có quyền công việc ở toà %s: vẫn thấy việc nhưng không sửa/hoàn thành được trên web.',
        COALESCE(v_assignee_name,'Người nhận'),v_building_name),300)); END IF;
      v_who:=CASE WHEN v_assignee=v_actor THEN 'chính anh/chị' ELSE COALESCE(v_assignee_name,'(không xem được tên)') END;
      v_place:='toà '||v_building_name||CASE WHEN v_room IS NOT NULL THEN ', phòng '||v_room_name ELSE ', cả toà' END;
      v_text:=CASE WHEN v->'assigneeSuggested'='true'::jsonb
          THEN format('Chưa nêu người nhận — đề xuất giao %s (quản lý toà %s). ',v_who,v_building_name) ELSE '' END
        ||format('Tạo việc định kỳ ''%s'' (loại %s%s) — %s — giao %s — %s, từ %s%s; hạn %s. Ba lần tới: %s. Việc đã sinh là việc thường ở /tasks.',
          v->>'title',v_type_name,CASE WHEN v->'jobTypeGuessed'='true'::jsonb THEN ', tự chọn theo nội dung' ELSE '' END,v_place,v_who,v_sched,
          to_char(v_start,'DD/MM/YYYY'),CASE WHEN v_end IS NOT NULL THEN ' tới '||to_char(v_end,'DD/MM/YYYY') ELSE '' END,
          CASE WHEN v_due=0 THEN 'cuối ngày sinh' ELSE format('cuối ngày thứ %s sau ngày sinh',v_due) END,
          (SELECT string_agg(to_char(x,'DD/MM'),', ' ORDER BY x) FROM unnest(v_next) x));
      RETURN jsonb_build_object('kind','preview','basis',v_basis,'resolved',v,'confirm','required','warnings',v_warnings,
        'preview',jsonb_strip_nulls(jsonb_build_object('text',left(v_text,2000),'building',v_building_name,'room',v_room_name,'wholeBuilding',v_room IS NULL,
          'jobType',v_type_name,'title',v->>'title','assignee',v_who,'assigneeSelf',v_assignee=v_actor,'assigneeSuggested',v->'assigneeSuggested',
          'assigneeManagesBuilding',v_manages,'schedule',v_sched,'startDate',v_start,'endDate',v_end,'dueDays',v_due,
          'nextDates',to_jsonb(v_next),'priority',v->>'priority')));
    END IF;
    v_begin:=app_private.hermes_action_receipt_begin_v1(p_binding,p_action,p_request_id,jsonb_build_object('params',p_params,'resolved',v));
    IF v_begin->>'state'='replay' THEN RETURN jsonb_build_object('kind','replay','outcome',v_begin->'result'); END IF;
    IF v_begin->>'state'='conflict' THEN RETURN jsonb_build_object('kind','rejected','reason','request_conflict'); END IF;
    IF v_begin->>'state' IS DISTINCT FROM 'new' THEN RAISE EXCEPTION 'hermes_action_outcome_unknown' USING ERRCODE='PT409'; END IF;
    RETURN jsonb_build_object('kind','write','action',p_action,'requestId',p_request_id,'organizationId',v_org,'actorId',v_actor,
      'connectionId',ctx->'connectionId','rule',jsonb_build_object('buildingId',v_building,'roomId',v_room,'jobTypeId',v_type,'assigneeId',v_assignee,
        'title',v->>'title','description',v->>'description','priority',v->>'priority','frequency',v_freq,'every',v_every,
        'weekdays',CASE WHEN v_days IS NULL THEN 'null'::jsonb ELSE to_jsonb(v_days) END,'monthDay',v_md,'startDate',v_start,'endDate',v_end,'dueDays',v_due));
  END IF;

  -- Sửa / tạm dừng-chạy lại / xoá: một quy tắc đã giải đúng (lõi giải tên không bao giờ tự chọn khi mơ hồ).
  IF p_phase='apply' THEN v:=p_resolved;
  ELSE v:=jsonb_build_object('ruleId',p_resolution#>'{rule,id}','resume',COALESCE(p_resolution->'resume','false'::jsonb));
  END IF;
  BEGIN v_rid:=(v->>'ruleId')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'hermes_task_invalid' USING ERRCODE='22023';
  END;
  IF v_rid IS NULL THEN RAISE EXCEPTION 'hermes_task_invalid' USING ERRCODE='22023'; END IF;
  IF p_phase<>'preview' THEN
    SELECT * INTO v_rule FROM public.job_recurrence_rules r WHERE r.id=v_rid AND r.organization_id=v_org FOR UPDATE NOWAIT;
  ELSE
    SELECT * INTO v_rule FROM public.job_recurrence_rules r WHERE r.id=v_rid AND r.organization_id=v_org;
  END IF;
  IF NOT FOUND OR v_rule.deleted_at IS NOT NULL THEN RETURN jsonb_build_object('kind','rejected','reason','state_changed'); END IF;
  IF NOT (v_rule.building_id IN (SELECT jsonb_array_elements_text(ctx->'buildingIds')::uuid)) THEN RETURN jsonb_build_object('kind','rejected','reason','not_allowed'); END IF;
  SELECT b.name INTO v_building_name FROM public.buildings b WHERE b.id=v_rule.building_id;
  SELECT r.name INTO v_room_name FROM public.rooms r WHERE r.id=v_rule.room_id;
  SELECT p.full_name INTO v_assignee_name FROM public.profiles p WHERE p.id=v_rule.assignee_id;
  v_old_sched:=public.job_recurrence_schedule_text_v1(v_rule.frequency,v_rule.every,v_rule.weekdays,v_rule.month_day);
  v_place:=v_building_name||CASE WHEN v_rule.room_id IS NOT NULL THEN ' phòng '||v_room_name ELSE ', cả toà' END;
  v_from:=GREATEST(v_today,COALESCE(v_rule.last_generated_date+1,v_today));

  IF p_action='task.recurring_pause' THEN
    v_resume:=COALESCE(v->'resume'='true'::jsonb,false);
    IF v_resume=(v_rule.paused_at IS NULL) THEN RETURN jsonb_build_object('kind','needs_input','reason','recurrence_unchanged'); END IF;
    IF v_resume THEN
      v_next:=ARRAY(SELECT x FROM public.job_recurrence_dates_v1(v_rule.frequency,v_rule.every,v_rule.weekdays,v_rule.month_day,v_rule.start_date,
        v_rule.end_date,v_today,v_today+400) x ORDER BY 1 LIMIT 3);
      v_text:=format('Chạy lại việc định kỳ %s ''%s'' — %s — %s, giao %s. Không sinh bù các ngày đã dừng. Lần tới: %s.',v_rule.code,v_rule.title,v_place,
        v_old_sched,COALESCE(v_assignee_name,'chưa giao'),COALESCE((SELECT string_agg(to_char(x,'DD/MM'),', ' ORDER BY x) FROM unnest(v_next) x),'không còn ngày nào (đã qua ngày kết thúc)'));
    ELSE
      v_text:=format('Tạm dừng việc định kỳ %s ''%s'' — %s — %s, giao %s. Không sinh việc mới cho tới khi chạy lại; việc đã sinh giữ nguyên.',
        v_rule.code,v_rule.title,v_place,v_old_sched,COALESCE(v_assignee_name,'chưa giao'));
    END IF;
    v_basis:=md5(jsonb_build_array(p_action,v_rule.id,v_rule.version,v_resume)::text);
  ELSIF p_action='task.recurring_delete' THEN
    v_text:=format('Xoá việc định kỳ %s ''%s'' — %s — %s, giao %s. Không sinh việc mới nữa; việc đã sinh giữ nguyên. Không khôi phục quy tắc qua bot.',
      v_rule.code,v_rule.title,v_place,v_old_sched,COALESCE(v_assignee_name,'chưa giao'));
    v_basis:=md5(jsonb_build_array(p_action,v_rule.id,v_rule.version)::text);
  ELSE
    -- Sửa: chỉ cột thật sự đổi vào kế hoạch (khoá là tên cột của public.job_recurrence_update_v1); lịch mới chuẩn hoá như trigger CRM.
    IF p_phase<>'apply' THEN
      c:=COALESCE(p_resolution->'changes','{}'::jsonb);
      IF (c ? 'frequency' AND c->>'frequency' NOT IN ('daily','weekly','monthly'))
        OR (c ? 'every' AND COALESCE(c->>'every','') !~ '^[0-9]{1,2}$') OR (c ? 'monthDay' AND COALESCE(c->>'monthDay','') !~ '^-?[0-9]{1,2}$')
        OR (c ? 'dueDays' AND COALESCE(c->>'dueDays','') !~ '^[0-9]{1,2}$')
        OR (c ? 'startDate' AND COALESCE(c->>'startDate','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
        OR (c ? 'endDate' AND COALESCE(c->>'endDate','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
        OR (c ? 'weekdays' AND (jsonb_typeof(c->'weekdays') IS DISTINCT FROM 'array'
          OR EXISTS(SELECT 1 FROM jsonb_array_elements(c->'weekdays') e WHERE jsonb_typeof(e) IS DISTINCT FROM 'string'
            OR e#>>'{}' NOT IN ('MON','TUE','WED','THU','FRI','SAT','SUN')))) THEN
        RETURN jsonb_build_object('kind','needs_input','reason','invalid_params'); END IF;
      v_freq:=COALESCE(c->>'frequency',v_rule.frequency); v_every:=COALESCE((c->>'every')::integer,v_rule.every);
      v_due:=COALESCE((c->>'dueDays')::integer,v_rule.due_days);
      BEGIN
        v_start:=COALESCE((c->>'startDate')::date,v_rule.start_date);
        v_end:=CASE WHEN c ? 'endDate' THEN (c->>'endDate')::date ELSE v_rule.end_date END;
      EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
        RETURN jsonb_build_object('kind','needs_input','reason','invalid_params');
      END;
      IF v_freq='weekly' THEN
        v_days:=CASE WHEN c ? 'weekdays' THEN (SELECT array_agg(DISTINCT array_position(ARRAY['MON','TUE','WED','THU','FRI','SAT','SUN'],e#>>'{}')::smallint
            ORDER BY array_position(ARRAY['MON','TUE','WED','THU','FRI','SAT','SUN'],e#>>'{}')::smallint) FROM jsonb_array_elements(c->'weekdays') e)
          WHEN v_rule.frequency='weekly' THEN v_rule.weekdays END;
        v_days:=COALESCE(v_days,ARRAY[date_part('isodow',v_start)::smallint]); v_md:=NULL;
      ELSIF v_freq='monthly' THEN
        v_md:=COALESCE((c->>'monthDay')::integer,CASE WHEN v_rule.frequency='monthly' THEN v_rule.month_day END,date_part('day',v_start)::integer);
        v_days:=NULL;
      ELSE v_days:=NULL; v_md:=NULL;
      END IF;
      IF (c ? 'weekdays' AND v_freq<>'weekly') OR (c ? 'monthDay' AND v_freq<>'monthly') OR v_every NOT BETWEEN 1 AND 12 OR v_due NOT BETWEEN 0 AND 30
        OR (v_md IS NOT NULL AND v_md<>-1 AND v_md NOT BETWEEN 1 AND 31) THEN
        RETURN jsonb_build_object('kind','needs_input','reason','invalid_params'); END IF;
      IF c ? 'title' AND c->>'title' IS DISTINCT FROM v_rule.title THEN v_changes:=v_changes||jsonb_build_object('title',c->>'title'); END IF;
      IF c ? 'description' AND c->>'description' IS DISTINCT FROM COALESCE(v_rule.description,'') THEN
        v_changes:=v_changes||jsonb_build_object('description',c->>'description'); END IF;
      IF c ? 'priority' AND c->>'priority' IS DISTINCT FROM v_rule.priority THEN v_changes:=v_changes||jsonb_build_object('priority',c->>'priority'); END IF;
      IF jsonb_typeof(c->'assignee')='object' AND (c#>>'{assignee,id}')::uuid IS DISTINCT FROM v_rule.assignee_id THEN
        v_changes:=v_changes||jsonb_build_object('assignee_id',c#>'{assignee,id}'); END IF;
      IF v_freq IS DISTINCT FROM v_rule.frequency THEN v_changes:=v_changes||jsonb_build_object('frequency',v_freq); END IF;
      IF v_every IS DISTINCT FROM v_rule.every::integer THEN v_changes:=v_changes||jsonb_build_object('every',v_every); END IF;
      IF v_days IS DISTINCT FROM v_rule.weekdays THEN v_changes:=v_changes||jsonb_build_object('weekdays',CASE WHEN v_days IS NULL THEN 'null'::jsonb ELSE to_jsonb(v_days) END); END IF;
      IF v_md IS DISTINCT FROM v_rule.month_day::integer THEN v_changes:=v_changes||jsonb_build_object('month_day',v_md); END IF;
      IF v_start IS DISTINCT FROM v_rule.start_date THEN v_changes:=v_changes||jsonb_build_object('start_date',v_start); END IF;
      IF v_end IS DISTINCT FROM v_rule.end_date THEN v_changes:=v_changes||jsonb_build_object('end_date',v_end); END IF;
      IF v_due IS DISTINCT FROM v_rule.due_days::integer THEN v_changes:=v_changes||jsonb_build_object('due_days',v_due); END IF;
      IF v_changes='{}'::jsonb THEN RETURN jsonb_build_object('kind','needs_input','reason','recurrence_unchanged'); END IF;
      v:=v||jsonb_build_object('changes',v_changes,'assigneeAmbiguous',COALESCE(c->'assigneeAmbiguous','false'::jsonb),
        'assigneeWanted',COALESCE(c->'assigneeWanted','null'::jsonb));
    END IF;
    v_changes:=v->'changes';
    IF jsonb_typeof(v_changes) IS DISTINCT FROM 'object' OR v_changes='{}'::jsonb OR EXISTS(SELECT 1 FROM jsonb_object_keys(v_changes) k WHERE k NOT IN
        ('title','description','assignee_id','priority','frequency','every','weekdays','month_day','start_date','end_date','due_days')) THEN
      RAISE EXCEPTION 'hermes_task_invalid' USING ERRCODE='22023'; END IF;
    -- Lịch sau khi sửa (cả lượt 2: tính lại từ quy tắc đang chạy + thay đổi).
    BEGIN
      v_freq:=COALESCE(v_changes->>'frequency',v_rule.frequency); v_every:=COALESCE((v_changes->>'every')::integer,v_rule.every);
      v_days:=CASE WHEN v_changes ? 'weekdays' THEN CASE WHEN jsonb_typeof(v_changes->'weekdays')='array'
          THEN ARRAY(SELECT x::smallint FROM jsonb_array_elements_text(v_changes->'weekdays') x) END ELSE v_rule.weekdays END;
      v_md:=CASE WHEN v_changes ? 'month_day' THEN (v_changes->>'month_day')::integer ELSE v_rule.month_day END;
      v_start:=CASE WHEN v_changes ? 'start_date' THEN (v_changes->>'start_date')::date ELSE v_rule.start_date END;
      v_end:=CASE WHEN v_changes ? 'end_date' THEN (v_changes->>'end_date')::date ELSE v_rule.end_date END;
      v_due:=COALESCE((v_changes->>'due_days')::integer,v_rule.due_days);
      v_new_assignee:=CASE WHEN v_changes ? 'assignee_id' THEN (v_changes->>'assignee_id')::uuid ELSE v_rule.assignee_id END;
    EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow OR numeric_value_out_of_range THEN
      RAISE EXCEPTION 'hermes_task_invalid' USING ERRCODE='22023';
    END;
    IF v_freq NOT IN ('daily','weekly','monthly') OR (v_freq='weekly')<>(v_days IS NOT NULL) OR (v_freq='monthly')<>(v_md IS NOT NULL)
      OR (v_changes ? 'title' AND (char_length(v_changes->>'title') NOT BETWEEN 1 AND 200 OR v_changes->>'title' ~ '[\x01-\x1f\x7f]'))
      OR (v_changes ? 'description' AND char_length(v_changes->>'description')>4000)
      OR (v_changes ? 'priority' AND v_changes->>'priority' NOT IN ('NORMAL','LOW','URGENT')) THEN
      RAISE EXCEPTION 'hermes_task_invalid' USING ERRCODE='22023'; END IF;
    IF (v_changes ? 'start_date' AND v_start<v_today) OR (v_end IS NOT NULL AND v_end<v_start) THEN
      RETURN jsonb_build_object('kind','needs_input','reason','date_out_of_range'); END IF;
    IF v_changes ? 'assignee_id' AND v_new_assignee IS NOT NULL AND NOT COALESCE(app_private.hermes_task_assignee_member_v1(v_new_assignee,v_org),false) THEN
      RETURN jsonb_build_object('kind','rejected','reason','not_allowed'); END IF;
    v_next:=ARRAY(SELECT x FROM public.job_recurrence_dates_v1(v_freq,v_every,v_days,v_md,v_start,v_end,v_from,v_from+400) x ORDER BY 1 LIMIT 3);
    v_sched:=public.job_recurrence_schedule_text_v1(v_freq,v_every,v_days,v_md);
    IF v_changes ? 'title' THEN v_diff:=v_diff||format('tiêu đề ''%s'' → ''%s''',left(v_rule.title,60),left(v_changes->>'title',60)); END IF;
    IF v_changes ? 'description' THEN v_diff:=v_diff||'mô tả mới'::text; END IF;
    IF v_changes ? 'priority' THEN v_diff:=v_diff||format('ưu tiên %s → %s',v_rule.priority,v_changes->>'priority'); END IF;
    IF v_changes ? 'assignee_id' THEN
      SELECT p.full_name INTO v_who FROM public.profiles p WHERE p.id=v_new_assignee;
      v_diff:=v_diff||format('người nhận %s → %s',COALESCE(v_assignee_name,'chưa giao'),CASE WHEN v_new_assignee=v_actor THEN 'chính anh/chị'
        ELSE COALESCE(v_who,'(không xem được tên)') END);
      IF v->'assigneeAmbiguous'='true'::jsonb THEN v_warnings:=v_warnings||to_jsonb(left(CASE WHEN v_new_assignee=v_actor
        THEN format('Hiểu ''%s'' là chính anh/chị; nếu là người khác, nêu đủ tên người đó.',v->>'assigneeWanted')
        ELSE format('Hiểu ''%s'' là người nhận %s; nếu ý là chính anh/chị, nói "giao cho tôi".',v->>'assigneeWanted',COALESCE(v_who,'(không xem được tên)')) END,300));
      END IF;
      IF v_new_assignee IS NOT NULL AND v_new_assignee<>v_actor THEN
        PERFORM app_private.lock_org_for_decision_v1(v_org);
        IF NOT COALESCE((SELECT a.allowed FROM app_private.authorize_tenant_action_v3(v_new_assignee,v_org,'tasks.edit',v_rule.building_id,NULL) a),false) THEN
          v_warnings:=v_warnings||to_jsonb(left(format('%s không có quyền công việc ở toà %s: vẫn thấy việc nhưng không sửa/hoàn thành được trên web.',
            COALESCE(v_who,'Người nhận'),v_building_name),300));
        END IF;
      END IF;
    END IF;
    IF v_sched IS DISTINCT FROM v_old_sched THEN v_diff:=v_diff||format('lịch %s → %s',v_old_sched,v_sched); END IF;
    IF v_changes ? 'start_date' THEN v_diff:=v_diff||format('từ ngày %s',to_char(v_start,'DD/MM/YYYY')); END IF;
    IF v_changes ? 'end_date' THEN v_diff:=v_diff||format('tới ngày %s',COALESCE(to_char(v_end,'DD/MM/YYYY'),'không hạn')); END IF;
    IF v_changes ? 'due_days' THEN v_diff:=v_diff||format('hạn %s',CASE WHEN v_due=0 THEN 'cuối ngày sinh' ELSE format('cuối ngày thứ %s sau ngày sinh',v_due) END); END IF;
    v_text:=format('Sửa việc định kỳ %s ''%s'' (%s): %s. Ba lần tới: %s. Việc đã sinh không đổi.',v_rule.code,v_rule.title,v_place,
      array_to_string(v_diff,'; '),COALESCE((SELECT string_agg(to_char(x,'DD/MM'),', ' ORDER BY x) FROM unnest(v_next) x),'không còn ngày nào'));
    v_basis:=md5(jsonb_build_array(p_action,v_rule.id,v_rule.version,v_changes)::text);
  END IF;
  IF p_phase='apply' AND p_expected_basis IS DISTINCT FROM v_basis THEN RETURN jsonb_build_object('kind','rejected','reason','state_changed'); END IF;
  IF p_phase<>'apply' THEN
    RETURN jsonb_build_object('kind','preview','basis',v_basis,'resolved',v,'confirm','required','warnings',v_warnings,
      'preview',jsonb_strip_nulls(jsonb_build_object('text',left(v_text,2000),'code',v_rule.code,'title',v_rule.title,'building',v_building_name,
        'room',v_room_name,'schedule',v_old_sched,'paused',v_rule.paused_at IS NOT NULL,'nextDates',CASE WHEN v_next IS NULL THEN NULL ELSE to_jsonb(v_next) END)));
  END IF;
  v_begin:=app_private.hermes_action_receipt_begin_v1(p_binding,p_action,p_request_id,jsonb_build_object('params',p_params,'resolved',v));
  IF v_begin->>'state'='replay' THEN RETURN jsonb_build_object('kind','replay','outcome',v_begin->'result'); END IF;
  IF v_begin->>'state'='conflict' THEN RETURN jsonb_build_object('kind','rejected','reason','request_conflict'); END IF;
  IF v_begin->>'state' IS DISTINCT FROM 'new' THEN RAISE EXCEPTION 'hermes_action_outcome_unknown' USING ERRCODE='PT409'; END IF;
  RETURN jsonb_build_object('kind','write','action',p_action,'requestId',p_request_id,'organizationId',v_org,'actorId',v_actor,
    'connectionId',ctx->'connectionId','ruleId',v_rule.id,'code',v_rule.code,'expectedVersion',v_rule.version,'resume',v->'resume',
    'changes',CASE WHEN p_action='task.recurring_update' THEN v_changes END);
END $fn$;

-- 2. Chốt (DEFINER) của bốn thao tác: ghi lỗi ⇒ lý do (vượt trần ⇒ recurrence_quota); ghi xong ⇒ đối chiếu dòng quy tắc với kế hoạch,
--    audit HERMES_TASK_RECURRING_*, chốt biên nhận với câu tóm tắt + quy tắc + ba lần tới.
CREATE OR REPLACE FUNCTION app_private.hermes_task_recurring_finish_v1(p_binding jsonb,p_action text,p_plan jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE r public.job_recurrence_rules; v_plan jsonb:=p_plan->'rule'; v_org uuid; v_reason text; v_event text; v_text text; v_today date;
  v_building text; v_room text; v_assignee text; v_sched text; v_next date[]; v_place text;
BEGIN
  IF p_action IS NULL OR p_action NOT IN ('task.recurring_create','task.recurring_update','task.recurring_pause','task.recurring_delete')
    OR p_plan IS NULL OR jsonb_typeof(p_plan)<>'object' OR p_plan->>'action' IS DISTINCT FROM p_action
    OR p_plan->>'actorId' IS DISTINCT FROM auth.uid()::text THEN
    RAISE EXCEPTION 'hermes_task_receipt_invalid' USING ERRCODE='PT409'; END IF;
  IF p_plan->>'kind'='write_failed' THEN
    v_reason:=CASE WHEN p_plan->>'message' LIKE 'job\_recurrence\_limit%' THEN 'recurrence_quota'
      WHEN p_plan->>'sqlstate' IN ('P0002','40001') OR p_plan->>'message' LIKE 'job\_recurrence\_unchanged%'
        OR p_plan->>'message' LIKE 'job\_recurrence\_deleted%' THEN 'state_changed'
      ELSE app_private.hermes_action_reason_v1(p_plan->>'sqlstate',p_plan->>'message',p_plan->>'constraint') END;
    RETURN app_private.hermes_action_receipt_finish_v1(p_binding,p_action,(p_plan->>'requestId')::uuid,
      jsonb_build_object('kind','rejected','reason',v_reason),p_plan->>'sqlstate',p_plan->>'message');
  END IF;
  IF p_plan->>'kind' IS DISTINCT FROM 'written' THEN RAISE EXCEPTION 'hermes_task_invalid' USING ERRCODE='22023'; END IF;
  v_org:=(p_plan->>'organizationId')::uuid; v_today:=public.org_today_v1(v_org);
  SELECT * INTO r FROM public.job_recurrence_rules x WHERE x.id=(p_plan->>'ruleId')::uuid FOR SHARE;
  IF NOT FOUND OR r.organization_id IS DISTINCT FROM v_org THEN RAISE EXCEPTION 'hermes_task_receipt_invalid' USING ERRCODE='PT409'; END IF;
  IF p_action='task.recurring_create' THEN
    IF r.created_by IS DISTINCT FROM auth.uid() OR r.building_id IS DISTINCT FROM (v_plan->>'buildingId')::uuid
      OR r.room_id IS DISTINCT FROM (v_plan->>'roomId')::uuid OR r.job_type_id IS DISTINCT FROM (v_plan->>'jobTypeId')::uuid
      OR r.assignee_id IS DISTINCT FROM (v_plan->>'assigneeId')::uuid OR r.title IS DISTINCT FROM btrim(v_plan->>'title')
      OR r.priority IS DISTINCT FROM v_plan->>'priority' OR r.frequency IS DISTINCT FROM v_plan->>'frequency'
      OR r.every IS DISTINCT FROM (v_plan->>'every')::smallint OR r.month_day IS DISTINCT FROM (v_plan->>'monthDay')::smallint
      OR r.start_date IS DISTINCT FROM (v_plan->>'startDate')::date OR r.end_date IS DISTINCT FROM (v_plan->>'endDate')::date
      OR r.due_days IS DISTINCT FROM (v_plan->>'dueDays')::smallint OR r.deleted_at IS NOT NULL OR r.paused_at IS NOT NULL OR r.version<>1
      OR r.weekdays IS DISTINCT FROM (CASE WHEN jsonb_typeof(v_plan->'weekdays')='array'
        THEN ARRAY(SELECT x::smallint FROM jsonb_array_elements_text(v_plan->'weekdays') x) END) THEN
      RAISE EXCEPTION 'hermes_task_receipt_invalid' USING ERRCODE='PT409'; END IF;
    v_event:='HERMES_TASK_RECURRING_CREATED';
  ELSE
    IF r.code IS DISTINCT FROM p_plan->>'code' OR r.version<=(p_plan->>'expectedVersion')::integer
      OR (p_action='task.recurring_delete' AND r.deleted_at IS NULL)
      OR (p_action<>'task.recurring_delete' AND r.deleted_at IS NOT NULL)
      OR (p_action='task.recurring_pause' AND (r.paused_at IS NULL) IS DISTINCT FROM (p_plan->'resume'='true'::jsonb)) THEN
      RAISE EXCEPTION 'hermes_task_receipt_invalid' USING ERRCODE='PT409'; END IF;
    v_event:=CASE p_action WHEN 'task.recurring_delete' THEN 'HERMES_TASK_RECURRING_DELETED' WHEN 'task.recurring_update' THEN 'HERMES_TASK_RECURRING_UPDATED'
      ELSE CASE WHEN r.paused_at IS NULL THEN 'HERMES_TASK_RECURRING_RESUMED' ELSE 'HERMES_TASK_RECURRING_PAUSED' END END;
  END IF;
  PERFORM app_private.append_authz_audit_v1(v_org,v_event,'job_recurrence_rule',r.id,NULL,
    jsonb_strip_nulls(jsonb_build_object('actor',auth.uid(),'connectionId',p_plan->'connectionId','requestId',p_plan->'requestId','ruleId',r.id,
      'code',r.code,'title',r.title,'buildingId',r.building_id,'assigneeId',r.assignee_id,'version',r.version,'changes',p_plan->'changes',
      'action',p_action)),'Hermes shared task recurrence');
  SELECT b.name INTO v_building FROM public.buildings b WHERE b.id=r.building_id;
  SELECT rm.name INTO v_room FROM public.rooms rm WHERE rm.id=r.room_id;
  SELECT p.full_name INTO v_assignee FROM public.profiles p WHERE p.id=r.assignee_id;
  v_sched:=public.job_recurrence_schedule_text_v1(r.frequency,r.every,r.weekdays,r.month_day);
  v_place:='toà '||v_building||CASE WHEN r.room_id IS NOT NULL THEN ', phòng '||v_room ELSE ', cả toà' END;
  IF r.deleted_at IS NULL AND r.paused_at IS NULL THEN
    v_next:=ARRAY(SELECT x FROM public.job_recurrence_dates_v1(r.frequency,r.every,r.weekdays,r.month_day,r.start_date,r.end_date,
      GREATEST(v_today,COALESCE(r.last_generated_date+1,v_today)),GREATEST(v_today,COALESCE(r.last_generated_date+1,v_today))+400) x ORDER BY 1 LIMIT 3);
  END IF;
  v_text:=CASE p_action
    WHEN 'task.recurring_create' THEN format('Đã tạo việc định kỳ %s ''%s'' — %s — giao %s — %s. Ba lần tới: %s.',r.code,r.title,v_place,
      CASE WHEN r.assignee_id=auth.uid() THEN 'chính anh/chị' ELSE COALESCE(v_assignee,'(không xem được tên)') END,v_sched,
      COALESCE((SELECT string_agg(to_char(x,'DD/MM'),', ' ORDER BY x) FROM unnest(v_next) x),'—'))
    WHEN 'task.recurring_update' THEN format('Đã sửa việc định kỳ %s ''%s'' — %s — %s. Ba lần tới: %s.',r.code,r.title,v_place,v_sched,
      COALESCE((SELECT string_agg(to_char(x,'DD/MM'),', ' ORDER BY x) FROM unnest(v_next) x),'không còn ngày nào'))
    WHEN 'task.recurring_delete' THEN format('Đã xoá việc định kỳ %s ''%s''. Việc đã sinh giữ nguyên.',r.code,r.title)
    ELSE CASE WHEN r.paused_at IS NULL THEN format('Đã chạy lại việc định kỳ %s ''%s''. Lần tới: %s.',r.code,r.title,
        COALESCE((SELECT string_agg(to_char(x,'DD/MM'),', ' ORDER BY x) FROM unnest(v_next) x),'không còn ngày nào'))
      ELSE format('Đã tạm dừng việc định kỳ %s ''%s''. Việc đã sinh giữ nguyên.',r.code,r.title) END END;
  RETURN app_private.hermes_action_receipt_finish_v1(p_binding,p_action,(p_plan->>'requestId')::uuid,
    jsonb_build_object('kind','applied','link','/tasks','result',jsonb_strip_nulls(jsonb_build_object('text',left(v_text,2000),
      'rule',jsonb_strip_nulls(jsonb_build_object('code',r.code,'title',r.title,'building',v_building,'room',v_room,'wholeBuilding',r.room_id IS NULL,
        'assignee',CASE WHEN r.assignee_id=auth.uid() THEN 'chính anh/chị' ELSE v_assignee END,'schedule',v_sched,'startDate',r.start_date,
        'endDate',r.end_date,'dueDays',r.due_days,'priority',r.priority,'paused',r.paused_at IS NOT NULL,'deleted',r.deleted_at IS NOT NULL,
        'nextDates',CASE WHEN v_next IS NULL THEN NULL ELSE to_jsonb(v_next) END))))));
END $fn$;


-- 3. Lõi giải tên (INVOKER, dưới RLS người hỏi; chỉ tham chiếu public.*): thân 164201 + nhánh việc định kỳ.
CREATE OR REPLACE FUNCTION app_private.hermes_task_resolve_core_v1(p_ctx jsonb,p_action text,p_params jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $fn$
DECLARE v_org uuid; v_scope uuid[]; v_building text; v_room text; v_type text; v_person text; v_content text; v_whole boolean:=false;
  v_self boolean:=false; v_res jsonb; v_job jsonb; v_who jsonb; v_guessed boolean:=false; v_date date; v_time time; v_deadline timestamptz;
  v_fold text; v_tfold text; v_title text; v_desc text; v_priority text; v_found jsonb; v_best integer; v_more boolean;
  v_pfold text; v_ambiguous boolean:=false; v_jfold text; v_cwords text[]; v_jwords text[]; v_twanted text;
  v_jq text; v_code text; v_hits jsonb; v_hit jsonb; v_closed boolean; v_changes jsonb;
  v_batch boolean:=false; v_common jsonb; v_who_name text; v_managed jsonb; v_items jsonb; v_item jsonb; v_out jsonb:='[]'::jsonb; v_one jsonb;
  v_i integer;
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
      ELSE
        IF v_pfold IN ('minh','anh','chi','em') THEN v_ambiguous:=true; END IF;
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
      IF v_res->>'status' IS DISTINCT FROM 'resolved' THEN RETURN v_res; END IF;
    END IF;
    v_jfold:=public.hermes_name_fold_v1(v_jq);
    v_code:=upper(replace(v_jq,' ',''));
    WITH c AS (SELECT j.id,j.code,j.title,j.status,j.building_id,j.room_id,j.assignee_id,j.deadline,j.created_at,j.user_id
        FROM public.jobs j WHERE j.organization_id=v_org AND j.building_id=ANY(v_scope)
          AND (v_res IS NULL OR j.building_id=(v_res#>>'{building,id}')::uuid)
          AND (v_res IS NULL OR jsonb_typeof(v_res->'room') IS DISTINCT FROM 'object' OR j.room_id IS NOT DISTINCT FROM (v_res#>>'{room,id}')::uuid)),
    m AS (SELECT c.*,CASE
        WHEN upper(COALESCE(c.code,''))=v_code THEN 1
        WHEN v_jq ~ '^[0-9]{3,4}$' AND right(COALESCE(c.code,''),4)=lpad(v_jq,4,'0') THEN 2
        WHEN v_jfold IN ('vua giao','vua tao','viec vua giao','viec vua tao','viec moi giao','viec moi tao') AND c.user_id=auth.uid()
          AND c.created_at>clock_timestamp()-interval '24 hours' THEN 3
        WHEN char_length(v_jfold)>=3 AND position(v_jfold IN public.hermes_name_fold_v1(COALESCE(c.title,'')))>0 THEN 4 END AS how FROM c),
    best AS (SELECT min(m.how) h FROM m WHERE m.how=1 OR (m.how IS NOT NULL AND m.status='IN_PROGRESS')),
    hit AS (SELECT m.* FROM m,best WHERE m.how=best.h AND (m.how=1 OR m.status='IN_PROGRESS')
        AND (m.how<>3 OR m.created_at=(SELECT max(x.created_at) FROM m x WHERE x.how=3 AND x.status='IN_PROGRESS')))
    SELECT COALESCE((SELECT jsonb_agg(jsonb_build_object('id',hit.id,'code',hit.code,'title',hit.title,'status',hit.status,'buildingId',hit.building_id,
          'roomId',hit.room_id,'assigneeId',hit.assignee_id,'deadline',hit.deadline,'how',hit.how) ORDER BY hit.created_at DESC,hit.id) FROM hit),'[]'::jsonb),
      COALESCE((SELECT bool_or(m.status IS DISTINCT FROM 'IN_PROGRESS') FROM m WHERE m.how IS NOT NULL),false)
      INTO v_hits,v_closed;
    IF jsonb_array_length(v_hits)=0 THEN
      IF v_closed THEN RETURN jsonb_build_object('status','closed'); END IF;
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
      ELSE
        IF v_pfold IN ('minh','anh','chi','em') THEN v_ambiguous:=true; END IF;
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
    IF (jsonb_typeof(p_params->'items') IS NOT DISTINCT FROM 'array') = (v_who_name IS NOT NULL) THEN
      RETURN jsonb_build_object('status','invalid','reason','invalid_params'); END IF;
    IF v_who_name IS NULL THEN
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
          v_one:=v_job; EXIT one;  -- không thấy loại nào (vd thiếu task_types.view): giữ nguyên kết quả hàm giải tên, không gợi ý
        ELSE
          v_one:=jsonb_build_object('status','unresolved','field','jobType','wanted','','why','unspecified',
            'candidates',(SELECT COALESCE(jsonb_agg(jsonb_build_object('name',e->'name') ORDER BY ord),'[]'::jsonb)
              FROM jsonb_array_elements(v_found) WITH ORDINALITY y(e,ord) WHERE ord<=5),
            'more',jsonb_array_length(v_found)>5); EXIT one;
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
        ELSE v_one:=v_who; EXIT one;
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

-- 4. Chuẩn bị (DEFINER): rẽ sang hàm riêng cho việc định kỳ (Mốc 5), sửa/huỷ (Mốc 3) và lô (Mốc 4).
CREATE OR REPLACE FUNCTION app_private.hermes_task_action_prepare_v1(p_binding jsonb,p_action text,p_phase text,p_request_id uuid,p_params jsonb,
  p_resolved jsonb,p_expected_basis text,p_resolution jsonb,p_managers jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE ctx jsonb; v_org uuid; v_actor uuid; v jsonb; v_building uuid; v_room uuid; v_type uuid; v_assignee uuid; v_deadline timestamptz;
  v_building_name text; v_room_name text; v_type_name text; v_assignee_name text; v_dups jsonb; v_manages boolean:=true; v_basis text;
  v_confirm boolean; v_warnings jsonb:='[]'::jsonb; v_text text; v_quota text; v_begin jsonb; v_dup jsonb; v_who text; v_place text;
  v_receipt app_private.hermes_action_receipts;
BEGIN
  -- Mốc 5: bốn thao tác việc định kỳ có bước chuẩn bị riêng (app_private.hermes_task_recurring_prepare_v1), cùng guard + biên nhận chung.
  IF p_action IN ('task.recurring_create','task.recurring_update','task.recurring_pause','task.recurring_delete') THEN
    RETURN app_private.hermes_task_recurring_prepare_v1(p_binding,p_action,p_phase,p_request_id,p_params,p_resolved,p_expected_basis,p_resolution,p_managers);
  END IF;
  -- Mốc 3: task.update / task.cancel có bước chuẩn bị riêng (app_private.hermes_task_edit_prepare_v1), cùng guard + biên nhận chung.
  IF p_action IN ('task.update','task.cancel') THEN
    RETURN app_private.hermes_task_edit_prepare_v1(p_binding,p_action,p_phase,p_request_id,p_params,p_resolved,p_expected_basis,p_resolution);
  END IF;
  -- Mốc 4: task.create_batch có bước chuẩn bị riêng (app_private.hermes_task_batch_prepare_v1), cùng guard + biên nhận chung.
  IF p_action='task.create_batch' THEN
    RETURN app_private.hermes_task_batch_prepare_v1(p_binding,p_phase,p_request_id,p_params,p_resolved,p_expected_basis,p_resolution);
  END IF;
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

-- 5. Ghi (INVOKER): việc định kỳ qua hàm ghi CRM dùng chung; INSERT (tạo, lô) / UPDATE (sửa) / DELETE (huỷ) dưới RLS như web.
CREATE OR REPLACE FUNCTION app_private.hermes_task_action_write_v1(p_plan jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,public AS $fn$
DECLARE v_job jsonb; v_id uuid; v_constraint text; v_i integer:=0;
BEGIN
  IF p_plan IS NULL OR p_plan->>'kind' IS DISTINCT FROM 'write' THEN RETURN p_plan; END IF;
  IF current_user<>'authenticated' OR auth.uid() IS NULL OR p_plan->>'actorId' IS DISTINCT FROM auth.uid()::text THEN
    RAISE EXCEPTION 'hermes_task_denied' USING ERRCODE='42501'; END IF;
  IF p_plan->>'action' IN ('task.recurring_create','task.recurring_update','task.recurring_pause','task.recurring_delete') THEN
    -- Mốc 5: hàm ghi CRM dùng chung (web về sau gọi cùng hàm). Lỗi tạm (kể cả 40001 version lệch) ⇒ RAISE; lỗi khác ⇒ write_failed.
    v_job:=p_plan->'rule';
    BEGIN
      IF p_plan->>'action'='task.recurring_create' THEN
        SELECT x.id INTO v_id FROM public.job_recurrence_create_v1((p_plan->>'organizationId')::uuid,(v_job->>'buildingId')::uuid,
          (v_job->>'roomId')::uuid,(v_job->>'jobTypeId')::uuid,v_job->>'title',v_job->>'description',(v_job->>'assigneeId')::uuid,v_job->>'priority',
          v_job->>'frequency',(v_job->>'every')::integer,
          CASE WHEN jsonb_typeof(v_job->'weekdays')='array' THEN ARRAY(SELECT w::integer FROM jsonb_array_elements_text(v_job->'weekdays') w) END,
          (v_job->>'monthDay')::integer,(v_job->>'startDate')::date,(v_job->>'endDate')::date,(v_job->>'dueDays')::integer) x;
      ELSIF p_plan->>'action'='task.recurring_update' THEN
        SELECT x.id INTO v_id FROM public.job_recurrence_update_v1((p_plan->>'ruleId')::uuid,(p_plan->>'expectedVersion')::integer,p_plan->'changes') x;
      ELSIF p_plan->>'action'='task.recurring_pause' THEN
        SELECT x.id INTO v_id FROM public.job_recurrence_set_paused_v1((p_plan->>'ruleId')::uuid,(p_plan->>'expectedVersion')::integer,
          NOT COALESCE(p_plan->'resume'='true'::jsonb,false)) x;
      ELSE
        SELECT x.id INTO v_id FROM public.job_recurrence_delete_v1((p_plan->>'ruleId')::uuid,(p_plan->>'expectedVersion')::integer) x;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      IF SQLSTATE IN ('40001','40P01','55P03','PT409') THEN RAISE; END IF;
      GET STACKED DIAGNOSTICS v_constraint=CONSTRAINT_NAME;
      RETURN p_plan||jsonb_build_object('kind','write_failed','sqlstate',SQLSTATE,'message',left(SQLERRM,200),'constraint',NULLIF(v_constraint,''));
    END;
    IF v_id IS NULL OR (p_plan->>'action'<>'task.recurring_create' AND v_id IS DISTINCT FROM (p_plan->>'ruleId')::uuid) THEN
      RAISE EXCEPTION 'hermes_task_receipt_invalid' USING ERRCODE='PT409'; END IF;
    RETURN p_plan||jsonb_build_object('kind','written','ruleId',v_id);
  END IF;
  IF p_plan->>'action'='task.create_batch' THEN
    -- Mốc 4 (CV8): cả lô hoặc không gì — mọi INSERT trong MỘT khối con, dưới RLS + trigger như web; một dòng lỗi ⇒ cả khối lùi,
    -- kế hoạch mang write_failed kèm số dòng (item). Lỗi tạm ⇒ RAISE (cả giao dịch lùi, kể cả biên nhận).
    BEGIN
      FOR v_job IN SELECT x.e FROM jsonb_array_elements(p_plan->'jobs') WITH ORDINALITY x(e,o) ORDER BY x.o LOOP
        v_i:=v_i+1;
        INSERT INTO public.jobs(id,user_id,organization_id,title,description,building_id,room_id,job_type_id,priority,assignee_id,assignee_name,deadline,
          status,started_at,visible_to_customer,attachments)
        VALUES((v_job->>'jobId')::uuid,auth.uid(),(p_plan->>'organizationId')::uuid,v_job->>'title',v_job->>'description',(v_job->>'buildingId')::uuid,
          (v_job->>'roomId')::uuid,(v_job->>'jobTypeId')::uuid,v_job->>'priority',(v_job->>'assigneeId')::uuid,NULL,(v_job->>'deadline')::timestamptz,
          'IN_PROGRESS',(p_plan->>'startedAt')::timestamptz,false,NULL) RETURNING id INTO v_id;
        IF v_id IS DISTINCT FROM (v_job->>'jobId')::uuid THEN RAISE EXCEPTION 'hermes_task_receipt_invalid' USING ERRCODE='PT409'; END IF;
      END LOOP;
    EXCEPTION WHEN OTHERS THEN
      IF SQLSTATE IN ('40001','40P01','55P03','PT409') THEN RAISE; END IF;
      GET STACKED DIAGNOSTICS v_constraint=CONSTRAINT_NAME;
      RETURN p_plan||jsonb_build_object('kind','write_failed','sqlstate',SQLSTATE,'message',left(SQLERRM,200),'constraint',NULLIF(v_constraint,''),'item',v_i);
    END;
    RETURN p_plan||jsonb_build_object('kind','written');
  END IF;
  v_job:=p_plan->'job';
  BEGIN
    IF p_plan->>'action'='task.update' THEN
      -- Mốc 3: chỉ cột có trong kế hoạch; RLS UPDATE jobs (tasks.edit ở toà) + trigger như web. 0 hàng ⇒ RLS chặn.
      UPDATE public.jobs SET title=CASE WHEN v_job ? 'title' THEN v_job->>'title' ELSE title END,
        description=CASE WHEN v_job ? 'description' THEN v_job->>'description' ELSE description END,
        priority=CASE WHEN v_job ? 'priority' THEN v_job->>'priority' ELSE priority END,
        assignee_id=CASE WHEN v_job ? 'assigneeId' THEN (v_job->>'assigneeId')::uuid ELSE assignee_id END,
        deadline=CASE WHEN v_job ? 'deadline' THEN (v_job->>'deadline')::timestamptz ELSE deadline END,
        completion_description=CASE WHEN v_job ? 'note' THEN v_job->>'note' ELSE completion_description END
        WHERE id=(p_plan->>'jobId')::uuid AND status='IN_PROGRESS' RETURNING id INTO v_id;
    ELSIF p_plan->>'action'='task.cancel' THEN
      -- Mốc 3: xoá hẳn như web (RLS DELETE jobs: tasks.delete ở toà). 0 hàng ⇒ RLS chặn.
      DELETE FROM public.jobs WHERE id=(p_plan->>'jobId')::uuid AND status='IN_PROGRESS' RETURNING id INTO v_id;
    ELSE
    INSERT INTO public.jobs(id,user_id,organization_id,title,description,building_id,room_id,job_type_id,priority,assignee_id,assignee_name,deadline,
      status,started_at,visible_to_customer,attachments)
    VALUES((p_plan->>'jobId')::uuid,auth.uid(),(p_plan->>'organizationId')::uuid,v_job->>'title',v_job->>'description',(v_job->>'buildingId')::uuid,
      (v_job->>'roomId')::uuid,(v_job->>'jobTypeId')::uuid,v_job->>'priority',(v_job->>'assigneeId')::uuid,NULL,(v_job->>'deadline')::timestamptz,
      'IN_PROGRESS',(p_plan->>'startedAt')::timestamptz,false,NULL) RETURNING id INTO v_id;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE IN ('40001','40P01','55P03','PT409') THEN RAISE; END IF;
    GET STACKED DIAGNOSTICS v_constraint=CONSTRAINT_NAME;
    RETURN p_plan||jsonb_build_object('kind','write_failed','sqlstate',SQLSTATE,'message',left(SQLERRM,200),'constraint',NULLIF(v_constraint,''));
  END;
  IF v_id IS NULL AND p_plan->>'action' IN ('task.update','task.cancel') THEN
    RETURN p_plan||jsonb_build_object('kind','write_failed','sqlstate','42501','message','row_level_security','constraint',NULL); END IF;
  IF v_id IS DISTINCT FROM (p_plan->>'jobId')::uuid THEN RAISE EXCEPTION 'hermes_task_receipt_invalid' USING ERRCODE='PT409'; END IF;
  RETURN p_plan||jsonb_build_object('kind','written');
END $fn$;

-- 6. Chốt (DEFINER): rẽ sang hàm riêng cho việc định kỳ, sửa/huỷ và lô.
CREATE OR REPLACE FUNCTION app_private.hermes_task_action_finish_v1(p_binding jsonb,p_action text,p_plan jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_job public.jobs; v_plan jsonb:=p_plan->'job'; v_org uuid; v_outcome jsonb; v_building text; v_room text; v_assignee text; v_when text;
BEGIN
  IF p_plan IS NULL OR jsonb_typeof(p_plan)<>'object' THEN RAISE EXCEPTION 'hermes_task_invalid' USING ERRCODE='22023'; END IF;
  IF p_plan->>'kind' IN ('preview','needs_input','rejected') THEN RETURN p_plan; END IF;
  IF p_plan->>'kind'='replay' THEN RETURN p_plan->'outcome'; END IF;
  IF p_plan->>'action' IS DISTINCT FROM p_action OR p_plan->>'actorId' IS DISTINCT FROM auth.uid()::text THEN
    RAISE EXCEPTION 'hermes_task_receipt_invalid' USING ERRCODE='PT409'; END IF;
  -- Mốc 5: việc định kỳ chốt ở app_private.hermes_task_recurring_finish_v1 (kể cả ghi lỗi: vượt trần ⇒ recurrence_quota).
  IF p_action IN ('task.recurring_create','task.recurring_update','task.recurring_pause','task.recurring_delete') THEN RETURN app_private.hermes_task_recurring_finish_v1(p_binding,p_action,p_plan); END IF;
  IF p_plan->>'kind'='write_failed' THEN
    RETURN app_private.hermes_action_receipt_finish_v1(p_binding,p_action,(p_plan->>'requestId')::uuid,
      jsonb_build_object('kind','rejected','reason',app_private.hermes_action_reason_v1(p_plan->>'sqlstate',p_plan->>'message',p_plan->>'constraint')),
      p_plan->>'sqlstate',p_plan->>'message');
  END IF;
  IF p_plan->>'kind' IS DISTINCT FROM 'written' THEN RAISE EXCEPTION 'hermes_task_invalid' USING ERRCODE='22023'; END IF;
  -- Mốc 3: task.update / task.cancel chốt ở app_private.hermes_task_edit_finish_v1.
  IF p_action IN ('task.update','task.cancel') THEN RETURN app_private.hermes_task_edit_finish_v1(p_binding,p_action,p_plan); END IF;
  -- Mốc 4: task.create_batch chốt ở app_private.hermes_task_batch_finish_v1.
  IF p_action='task.create_batch' THEN RETURN app_private.hermes_task_batch_finish_v1(p_binding,p_plan); END IF;
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
    -- jobId (review Mốc 2, mục 5): để bot gọi tiếp crm_task_follow_set (giao rồi theo dõi); SOUL dặn không đọc UUID cho người dùng.
    'job',jsonb_strip_nulls(jsonb_build_object('jobId',v_job.id,'code',v_job.code,'title',v_job.title,'building',v_building,'room',v_room,
      'wholeBuilding',v_job.room_id IS NULL,'assignee',CASE WHEN v_job.assignee_id=auth.uid() THEN 'chính anh/chị' ELSE v_assignee END,
      'assigneeSelf',v_job.assignee_id=auth.uid(),
      'deadline',to_char(v_job.deadline AT TIME ZONE app_private.org_timezone_v1(v_org),'YYYY-MM-DD HH24:MI'),'deadlineText',v_when,
      'priority',v_job.priority)),
    'deadlineDefaulted',p_plan->'deadlineDefaulted')));
  RETURN app_private.hermes_action_receipt_finish_v1(p_binding,p_action,(p_plan->>'requestId')::uuid,v_outcome);
END $fn$;

ALTER FUNCTION app_private.hermes_task_recurring_prepare_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb,jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_task_recurring_finish_v1(jsonb,text,jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_task_resolve_core_v1(jsonb,text,jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_task_action_prepare_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb,jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_task_action_write_v1(jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_task_action_finish_v1(jsonb,text,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_task_recurring_prepare_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION app_private.hermes_task_recurring_finish_v1(jsonb,text,jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION app_private.hermes_task_resolve_core_v1(jsonb,text,jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION app_private.hermes_task_action_prepare_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION app_private.hermes_task_action_write_v1(jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION app_private.hermes_task_action_finish_v1(jsonb,text,jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
-- Vỏ chạy dưới vai authenticated tới bốn tầng qua OID: giữ EXECUTE như 031548. Hai hàm mới chỉ hàm DEFINER gọi: không cấp.
GRANT EXECUTE ON FUNCTION app_private.hermes_task_resolve_core_v1(jsonb,text,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION app_private.hermes_task_action_prepare_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION app_private.hermes_task_action_write_v1(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION app_private.hermes_task_action_finish_v1(jsonb,text,jsonb) TO authenticated;

DO $check$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='app_private.hermes_task_recurring_prepare_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb,jsonb)'::regprocedure AND prosecdef)
    OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='app_private.hermes_task_recurring_finish_v1(jsonb,text,jsonb)'::regprocedure AND prosecdef)
    OR (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid='app_private.hermes_task_resolve_core_v1(jsonb,text,jsonb)'::regprocedure AND NOT p.prosecdef) IS DISTINCT FROM '0a399cc52caa8dbb12cf6e8cc7936f42'
    OR (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid='app_private.hermes_task_action_prepare_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb,jsonb)'::regprocedure AND p.prosecdef) IS DISTINCT FROM '1f0b98d1a0ace9c61da52858f4fefac5'
    OR (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid='app_private.hermes_task_action_write_v1(jsonb)'::regprocedure AND NOT p.prosecdef) IS DISTINCT FROM 'b8877759e02fbe3a55536b0fe8c54638'
    OR (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid='app_private.hermes_task_action_finish_v1(jsonb,text,jsonb)'::regprocedure AND p.prosecdef) IS DISTINCT FROM '6a9ad71cdc880001faeaa1070f637528'
    OR has_function_privilege('authenticated','app_private.hermes_task_recurring_prepare_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb,jsonb)','EXECUTE')
    OR has_function_privilege('authenticated','app_private.hermes_task_recurring_finish_v1(jsonb,text,jsonb)','EXECUTE')
    OR has_function_privilege('anon','app_private.hermes_task_action_prepare_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb,jsonb)','EXECUTE') THEN
    RAISE EXCEPTION 'hermes_task_recurring_check_failed'; END IF;
END $check$;

COMMIT;
NOTIFY pgrst,'reload schema';
