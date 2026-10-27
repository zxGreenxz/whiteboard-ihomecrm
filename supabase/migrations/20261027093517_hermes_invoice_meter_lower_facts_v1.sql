-- Hermes trang Hoá đơn, nghiệm thu E03 (27/10) — "Điện phòng 102 toà 15 tháng này 8500": chỉ số mới nhỏ hơn số đầu 8.580 ⇒ máy chủ trả
--  meter_lower_than_previous chỉ với câu tĩnh "Chỉ số mới nhỏ hơn chỉ số đầu; hỏi lại số trên công tơ." — không có số đầu; SOUL dặn tự tra
--  báo cáo nhưng mô hình không làm (trượt lặp nhiều vòng). Nay lý do kèm facts {room, value, previous, meterCode?} của đúng dòng quyết định
--  lý do (khuôn đóng theo mã như period_closed / adjust_below_collected, lượt 14) ⇒ connector dựng câu "Chỉ số mới 8.500 nhỏ hơn chỉ số đầu
--  8.580 (phòng 102); hỏi lại số trên công tơ." Lô còn dòng ghi được vẫn ra bản xem trước nêu dòng lệch ở excluded như cũ.
-- Thay một thân: bước ghi chỉ số của vỏ trang (thân 20261022183445, md5 bcaeccc890b87c70119a2d9d87e4e826, đã áp production) — chỉ nhánh từ chối khi không còn
--  dòng ghi được ở lượt xem trước; mọi nhánh khác giữ từng byte. DEFINER như cũ, cùng chữ ký và kiểu trả về; vỏ trang gắn theo OID nên không đổi.
-- Phát hành: connector có khuôn facts của meter_lower_than_previous (broker.mjs) TRƯỚC; connector cũ gặp thân này coi facts lạ là khuôn lệch
--  (backend_unavailable). Không ghi dữ liệu, không khoá mới. Không DROP. Idempotent.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $requires$
BEGIN
  IF to_regprocedure('public.meter_readings_plan_v1(uuid,date,jsonb,boolean)') IS NULL
    OR to_regprocedure('public.record_meter_readings_v2(uuid,date,jsonb,boolean,text)') IS NULL
    OR to_regprocedure('app_private.hermes_invoice_reading_text_v1(numeric)') IS NULL
    OR to_regprocedure('public.hermes_invoice_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text)') IS NULL
    -- Thân đang chạy phải đúng thân 20261022183445 (hoặc đúng thân của file này khi chạy lại).
    OR (SELECT md5(replace(p.prosrc,chr(13),'')) FROM pg_proc p WHERE p.oid='app_private.hermes_invoice_meter_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb)'::regprocedure)
      NOT IN ('bcaeccc890b87c70119a2d9d87e4e826','a1ffa3cf9bd1005e6042e71b7a2a0aa6') THEN
    RAISE EXCEPTION 'hermes_invoice_meter_lower_facts_dependency_invalid'; END IF;
END $requires$;

-- 1. Bước ghi (DEFINER): thân 20261022183445 + dữ kiện của dòng nhỏ hơn số đầu.
CREATE OR REPLACE FUNCTION app_private.hermes_invoice_meter_step_v1(p_binding jsonb,p_action text,p_phase text,p_request_id uuid,p_params jsonb,
  p_resolved jsonb,p_expected_basis text,p_resolution jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE
  ctx jsonb; v_org uuid; v_resolved jsonb; v_begin jsonb; v_outcome jsonb; v_constraint text; v_building uuid; v_type text; v_unit text; v_type_text text;
  v_today date; v_month text; v_date date; v_replace boolean; v_rows jsonb; v_plan jsonb; v_write jsonb; v_skip jsonb; v_basis text; v_r jsonb; v_p jsonb;
  v_items jsonb:='[]'::jsonb; v_excluded jsonb:='[]'::jsonb; v_warnings jsonb:='[]'::jsonb; v_text text; v_w jsonb; v_run jsonb; v_reason text;
  v_n int;
BEGIN
  IF p_action IS DISTINCT FROM 'invoice.meter_record' OR p_phase IS NULL OR p_phase NOT IN ('preview','auto','apply')
    OR p_request_id IS NULL OR p_params IS NULL OR jsonb_typeof(p_params)<>'object'
    OR (p_phase='apply' AND (p_resolved IS NULL OR jsonb_typeof(p_resolved)<>'object' OR p_expected_basis IS NULL)) THEN
    RAISE EXCEPTION 'hermes_action_invalid' USING ERRCODE='22023'; END IF;
  -- Guard dùng chung đã khoá dòng công ty (hermes_private_command_connection_v1 → lock_org_for_decision_v1) cho cả giao dịch.
  ctx:=app_private.hermes_action_guard_v1(p_binding,p_action);
  v_org:=(ctx->>'organizationId')::uuid;
  IF p_phase='apply' THEN v_resolved:=p_resolved;
  ELSIF p_resolution->>'status'='unresolved' THEN
    RETURN jsonb_build_object('kind','needs_input','reason','name_unresolved','field',p_resolution->'field','wanted',p_resolution->'wanted',
      'why',p_resolution->'why','candidates',COALESCE(p_resolution->'candidates','[]'::jsonb),'more',COALESCE(p_resolution->'more','false'::jsonb));
  ELSIF p_resolution->>'status'='rejected' THEN RETURN jsonb_build_object('kind','rejected','reason',p_resolution->>'reason');
  ELSIF p_resolution->>'status'='resolved' THEN v_resolved:=p_resolution->'resolved';
  ELSE RAISE EXCEPTION 'hermes_action_invalid' USING ERRCODE='22023';
  END IF;
  -- Phát lại TRƯỚC mọi kiểm phạm vi/phòng/chỉ số và mọi khoá: requestId đã có biên nhận ⇒ đúng kết quả đã chốt.
  IF p_phase='apply' AND EXISTS(SELECT 1 FROM app_private.hermes_action_receipts r WHERE r.organization_id=v_org AND r.user_id=auth.uid()
      AND r.request_id=p_request_id) THEN
    v_begin:=app_private.hermes_action_receipt_begin_v1(p_binding,p_action,p_request_id,jsonb_build_object('params',p_params,'resolved',v_resolved));
    IF v_begin->>'state'='replay' THEN RETURN v_begin->'result'; END IF;
    IF v_begin->>'state'='conflict' THEN RETURN jsonb_build_object('kind','rejected','reason','request_conflict'); END IF;
    RAISE EXCEPTION 'hermes_action_outcome_unknown' USING ERRCODE='PT409';
  END IF;

  -- Bản đã giải phải còn trong phạm vi guard: toà ∈ guard, cùng loại công tơ, đúng số dòng, mỗi phòng thuộc đúng toà/công ty.
  v_building:=NULLIF(v_resolved->>'buildingId','')::uuid;
  v_type:=CASE COALESCE(p_params->>'meterType','dien') WHEN 'dien' THEN 'ELECTRICITY' WHEN 'nuoc' THEN 'WATER' END;
  IF v_building IS NULL OR NOT (v_building IN (SELECT jsonb_array_elements_text(ctx->'buildingIds')::uuid)) OR v_type IS NULL
    OR v_resolved->>'meterType' IS DISTINCT FROM v_type OR jsonb_typeof(v_resolved->'rows') IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_params->'readings') IS DISTINCT FROM 'array'
    OR jsonb_array_length(v_resolved->'rows')<>jsonb_array_length(p_params->'readings')
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_resolved->'rows') WITH ORDINALITY x(r,i) WHERE (x.r->>'n')::int IS DISTINCT FROM x.i::int
      OR NOT EXISTS(SELECT 1 FROM public.rooms rm WHERE rm.id=NULLIF(x.r->>'roomId','')::uuid AND rm.building_id=v_building
        AND rm.organization_id=v_org AND rm.deleted_at IS NULL)) THEN
    RETURN jsonb_build_object('kind','rejected','reason','not_allowed'); END IF;
  v_replace:=COALESCE((p_params->>'replace')::boolean,false);
  -- ĐÚNG biểu thức quyền của record_meter_readings_v2 (policy của bảng): xem trước không bao giờ "được" rồi ghi "không được".
  IF NOT (public.is_super_admin() OR (v_org=ANY(public.my_org_ids()) AND v_building=ANY(app_private.buildings_for_v3('meter_readings.create'))))
    OR (v_replace AND NOT (public.is_super_admin() OR v_building=ANY(app_private.buildings_for_v3('meter_readings.edit')))) THEN
    RETURN jsonb_build_object('kind','rejected','reason','not_allowed'); END IF;
  -- Ngày chốt (Q16 = a).
  v_today:=public.org_today_v1(v_org);
  v_month:=NULLIF(p_params->>'month','');
  IF v_month IS NULL OR v_month=to_char(v_today,'YYYY-MM') THEN v_date:=v_today;
  ELSIF v_month<to_char(v_today,'YYYY-MM') THEN v_date:=(to_date(v_month||'-01','YYYY-MM-DD')+interval '1 month'-interval '1 day')::date;
  ELSE RETURN jsonb_build_object('kind','rejected','reason','date_out_of_range'); END IF;
  IF p_phase='apply' AND NOT pg_try_advisory_xact_lock(hashtextextended('meter_readings.v2:'||v_building::text,0)) THEN
    RAISE EXCEPTION 'meter_readings_busy' USING ERRCODE='55P03'; END IF;
  SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object('roomId',x.r->>'roomId','meterType',v_type,'meterCode',x.r->>'meterCode',
      'value',p_params->'readings'->(x.i::int-1)->'value')) ORDER BY x.i) INTO v_rows
    FROM jsonb_array_elements(v_resolved->'rows') WITH ORDINALITY x(r,i);
  v_plan:=public.meter_readings_plan_v1(v_building,v_date,v_rows,v_replace);
  IF jsonb_array_length(COALESCE(v_plan->'blockers','[]'::jsonb))>0 THEN RETURN jsonb_build_object('kind','rejected','reason','not_allowed'); END IF;
  -- Nhãn dòng: tên phòng, kèm mã công tơ CHỈ khi người dùng nêu mã ở dòng đó.
  SELECT COALESCE(jsonb_agg(r ORDER BY (r->>'n')::int) FILTER (WHERE r->>'status' IN ('ok','replace')),'[]'::jsonb),
         COALESCE(jsonb_agg(r ORDER BY (r->>'n')::int) FILTER (WHERE r->>'status' NOT IN ('ok','replace')),'[]'::jsonb)
    INTO v_write,v_skip FROM (SELECT p||jsonb_build_object('label',COALESCE(p->>'roomName','dòng '||(p->>'n'))
      ||CASE WHEN v_resolved->'rows'->((p->>'n')::int-1) ? 'meterCode' THEN COALESCE(' ('||(p->>'meterCode')||')','') ELSE '' END) r
      FROM jsonb_array_elements(v_plan->'rows') p) x;
  IF jsonb_array_length(v_write)=0 THEN
    -- Lượt 2 sau bản xem trước có ≥ 1 dòng: dữ liệu đã đổi ⇒ xem trước lại.
    IF p_phase='apply' THEN RETURN jsonb_build_object('kind','rejected','reason','state_changed'); END IF;
    -- E03: nhỏ hơn số đầu ⇒ kèm dữ kiện của ĐÚNG dòng quyết định lý do (dòng bị loại đầu tiên): tên phòng (bỏ ký tự điều khiển, ≤ 120 ký tự),
    -- số mới, số đầu (chuỗi số trơn; connector đổi sang kiểu Việt) và mã công tơ CHỈ khi người dùng nêu mã ở dòng đó (như nhãn dòng).
    -- Phòng đã qua kiểm phạm vi + quyền ghi ở trên; đúng số mà bản xem trước nêu ở excluded khi lô còn dòng ghi được.
    IF v_skip->0->>'status'='lower_than_previous' THEN
      v_r:=v_skip->0;
      RETURN jsonb_build_object('kind','rejected','reason','meter_lower_than_previous','facts',jsonb_strip_nulls(jsonb_build_object(
        'room',NULLIF(left(btrim(regexp_replace(COALESCE(v_r->>'roomName',v_resolved->'rows'->((v_r->>'n')::int-1)->>'roomName',''),'[[:cntrl:]]+',' ','g')),120),''),
        'value',trim_scale((v_r->>'value')::numeric)::text,'previous',trim_scale((v_r->>'previous')::numeric)::text,
        'meterCode',CASE WHEN v_resolved->'rows'->((v_r->>'n')::int-1) ? 'meterCode'
          THEN NULLIF(left(btrim(regexp_replace(COALESCE(v_r->>'meterCode',''),'[[:cntrl:]]+',' ','g')),40),'') END)));
    END IF;
    RETURN jsonb_build_object('kind','rejected','reason',CASE v_skip->0->>'status'
      WHEN 'meter_not_found' THEN 'meter_not_found' WHEN 'meter_ambiguous' THEN 'meter_ambiguous'
      WHEN 'duplicate_month' THEN 'meter_duplicate_month' WHEN 'lower_than_previous' THEN 'meter_lower_than_previous'
      WHEN 'used_by_invoice' THEN 'meter_used_by_invoice' WHEN 'has_later_reading' THEN 'meter_has_later_reading' ELSE 'invalid_params' END);
  END IF;
  v_basis:=md5(jsonb_build_array(p_action,v_building,v_date,v_type,v_replace,
    (SELECT jsonb_agg(jsonb_build_array(r->'n',r->'meterId',r->'value',r->'previous',r->'status',r#>'{existing,id}',r#>'{existing,updatedAt}')
      ORDER BY (r->>'n')::int) FROM jsonb_array_elements(v_write) r),
    (SELECT jsonb_agg(jsonb_build_array(r->'n',r->'status')) FROM jsonb_array_elements(v_skip) r))::text);
  v_unit:=CASE v_type WHEN 'ELECTRICITY' THEN 'kWh' ELSE 'm³' END;
  v_type_text:=CASE v_type WHEN 'ELECTRICITY' THEN 'ĐIỆN' ELSE 'NƯỚC' END;
  -- Dòng bị loại (nêu ra, KHÔNG nằm trong tập sẽ ghi).
  SELECT COALESCE(jsonb_agg(left(format('%s: %s — không ghi',r->>'label',
      CASE r->>'status'
        WHEN 'duplicate_month' THEN format('tháng %s đã có chỉ số %s (người dùng nói "sửa" mới thay)',to_char(v_date,'MM/YYYY'),
          app_private.hermes_invoice_reading_text_v1((r#>>'{existing,value}')::numeric))
        WHEN 'lower_than_previous' THEN format('chỉ số %s nhỏ hơn số đầu %s',app_private.hermes_invoice_reading_text_v1((r->>'value')::numeric),
          app_private.hermes_invoice_reading_text_v1((r->>'previous')::numeric))
        WHEN 'used_by_invoice' THEN 'chỉ số tháng này đã lên hoá đơn; sửa bằng điều chỉnh hoá đơn trên web'
        WHEN 'has_later_reading' THEN format('đã có chỉ số ngày %s sau ngày chốt; sửa trên web',to_char((r->>'laterReadingDate')::date,'DD/MM/YYYY'))
        WHEN 'meter_not_found' THEN format('phòng không có công tơ %s đang dùng%s',lower(v_type_text),COALESCE(' mã '||(v_resolved->'rows'->((r->>'n')::int-1)->>'meterCode'),''))
        WHEN 'meter_ambiguous' THEN format('phòng có nhiều công tơ %s (%s); nêu mã công tơ',lower(v_type_text),
          (SELECT string_agg(c,', ') FROM jsonb_array_elements_text(COALESCE(r->'candidates','[]'::jsonb)) c))
        WHEN 'duplicate_in_batch' THEN 'công tơ đã có ở dòng trước trong lô'
        ELSE 'chỉ số không hợp lệ' END),300) ORDER BY (r->>'n')::int),'[]'::jsonb) INTO v_excluded FROM jsonb_array_elements(v_skip) r;

  IF p_phase<>'apply' THEN
    FOR v_p IN SELECT value FROM jsonb_array_elements(v_write) LOOP
      v_items:=v_items||jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('room',v_p->>'roomName','meterCode',v_p->>'meterCode',
        'previous',trim_scale((v_p->>'previous')::numeric)::text,'value',trim_scale((v_p->>'value')::numeric)::text,'consumption',trim_scale((v_p->>'consumption')::numeric)::text,
        'replace',CASE WHEN v_p->>'status'='replace' THEN 'true' END,
        'text',left(format('%s: %s%s → %s (%s %s)',v_p->>'label',
          CASE WHEN v_p->>'status'='replace' THEN format('THAY số cũ %s; ',app_private.hermes_invoice_reading_text_v1((v_p#>>'{existing,value}')::numeric)) ELSE '' END,
          app_private.hermes_invoice_reading_text_v1((v_p->>'previous')::numeric),app_private.hermes_invoice_reading_text_v1((v_p->>'value')::numeric),
          app_private.hermes_invoice_reading_text_v1((v_p->>'consumption')::numeric),v_unit),300))));
      -- Cảnh báo (≤ 10, mỗi câu ≤ 300 ký tự). Mã chưa có câu thì bỏ qua — không bao giờ nối NULL.
      FOR v_w IN SELECT value FROM jsonb_array_elements(COALESCE(v_p->'warnings','[]'::jsonb)) LOOP
        v_text:=CASE v_w->>'code'
          WHEN 'high_consumption' THEN format('%s: tiêu thụ %s %s, gấp %s lần trung bình 3 kỳ (%s %s) — đọc lại số cho người dùng.',v_p->>'roomName',
            app_private.hermes_invoice_reading_text_v1((v_p->>'consumption')::numeric),v_unit,replace((v_w->>'ratio'),'.',','),
            app_private.hermes_invoice_reading_text_v1((v_w->>'avg3')::numeric),v_unit)
          WHEN 'zero_consumption' THEN format('%s: tiêu thụ 0 %s (chỉ số không đổi).',v_p->>'roomName',v_unit)
          WHEN 'no_approved_start' THEN format('%s: công tơ chưa có chỉ số đã duyệt; hoá đơn tháng tính chỉ số đầu = 0 (không lấy chỉ số ban đầu %s của công tơ). Nhập chỉ số đầu trên web trước khi lập hoá đơn.',
            v_p->>'roomName',app_private.hermes_invoice_reading_text_v1((v_w->>'initialReading')::numeric))
          WHEN 'start_differs' THEN format('%s: hoá đơn tháng sẽ lấy chỉ số đầu %s (dòng đã duyệt mới nhất), khác số đầu %s của dòng này.',v_p->>'roomName',
            app_private.hermes_invoice_reading_text_v1((v_w->>'approvedStart')::numeric),app_private.hermes_invoice_reading_text_v1((v_w->>'previous')::numeric))
          WHEN 'meter_inactive' THEN format('%s: công tơ đang ở trạng thái %s.',v_p->>'roomName',v_w->>'meterStatus')
          ELSE NULL END;
        IF v_text IS NOT NULL THEN v_warnings:=v_warnings||jsonb_build_array(left(v_text,300)); END IF;
      END LOOP;
    END LOOP;
    SELECT COALESCE(jsonb_agg(w),'[]'::jsonb) INTO v_warnings FROM (SELECT w FROM jsonb_array_elements(v_warnings) w WHERE jsonb_typeof(w)='string' LIMIT 10) x;
    RETURN jsonb_build_object('kind','preview','basis',v_basis,'resolved',v_resolved,'confirm','required','warnings',v_warnings,
      'preview',jsonb_strip_nulls(jsonb_build_object(
        'summary',format('Sẽ ghi %s chỉ số %s toà %s, ngày chốt %s, tháng %s%s.',jsonb_array_length(v_write),v_type_text,v_resolved->>'buildingName',
          app_private.hermes_vn_date_text_v1(v_date,v_today),to_char(v_date,'MM/YYYY'),
          CASE WHEN (v_plan#>>'{counts,replace}')::int>0 THEN format(' (%s dòng THAY số cũ)',(v_plan#>>'{counts,replace}')::int) ELSE '' END),
        'items',v_items,'excluded',CASE WHEN jsonb_array_length(v_excluded)>0 THEN v_excluded END,
        'note','Không kèm ảnh công tơ (thêm ở trang Ghi chỉ số trên web nếu cần).')));
  END IF;

  -- Lượt 2: cả tập hoặc không gì. Biên nhận mở trong cùng khối con: lệch bản đã xem hay hàm ghi từ chối ⇒ lùi cả lô lẫn biên nhận.
  BEGIN
    v_begin:=app_private.hermes_action_receipt_begin_v1(p_binding,p_action,p_request_id,jsonb_build_object('params',p_params,'resolved',v_resolved));
    IF v_begin->>'state'='replay' THEN RETURN v_begin->'result'; END IF;
    IF v_begin->>'state'='conflict' THEN RETURN jsonb_build_object('kind','rejected','reason','request_conflict'); END IF;
    IF v_begin->>'state' IS DISTINCT FROM 'new' THEN RAISE EXCEPTION 'hermes_action_outcome_unknown' USING ERRCODE='PT409'; END IF;
    IF v_basis IS DISTINCT FROM p_expected_basis THEN RAISE EXCEPTION 'hermes_invoice_meter_state_changed' USING ERRCODE='HS001'; END IF;
    v_run:=public.record_meter_readings_v2(v_building,v_date,
      (SELECT jsonb_agg(jsonb_build_object('meterId',r->'meterId','value',r->'value') ORDER BY (r->>'n')::int) FROM jsonb_array_elements(v_write) r),
      v_replace,'hermes-meter:'||p_request_id::text);
    -- Hậu điều kiện: hàm ghi ghi đúng số dòng đã xem.
    IF (v_run->>'count')::int IS DISTINCT FROM jsonb_array_length(v_write) THEN RAISE EXCEPTION 'hermes_invoice_meter_postcondition' USING ERRCODE='HS001'; END IF;
    SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object('room',x->>'roomName','meterCode',x->>'meterCode','code',x->>'code',
        'previous',trim_scale((x->>'previous')::numeric)::text,'value',trim_scale((x->>'value')::numeric)::text,'consumption',trim_scale((x->>'consumption')::numeric)::text,
        'text',left(format('%s: %s → %s (%s %s)%s',v_write->((x->>'n')::int-1)->>'label',
          app_private.hermes_invoice_reading_text_v1((x->>'previous')::numeric),app_private.hermes_invoice_reading_text_v1((x->>'value')::numeric),
          app_private.hermes_invoice_reading_text_v1((x->>'consumption')::numeric),v_unit,COALESCE(', mã '||(x->>'code'),'')),300)))
        ORDER BY (x->>'n')::int)
      INTO v_items FROM jsonb_array_elements(COALESCE(v_run->'created','[]'::jsonb)||COALESCE(v_run->'replaced','[]'::jsonb)) x;
    v_outcome:=jsonb_build_object('kind','applied','result',jsonb_strip_nulls(jsonb_build_object(
        'text',format('Đã ghi %s chỉ số %s toà %s, ngày chốt %s (tháng %s)%s.',(v_run->>'count')::int,v_type_text,v_resolved->>'buildingName',
          to_char(v_date,'DD/MM/YYYY'),to_char(v_date,'MM/YYYY'),
          CASE WHEN jsonb_array_length(COALESCE(v_run->'replaced','[]'::jsonb))>0 THEN format('; thay %s dòng cũ',jsonb_array_length(v_run->'replaced')) ELSE '' END),
        'count',(v_run->>'count')::int::text,'readings',v_items,
        'excluded',CASE WHEN jsonb_array_length(v_excluded)>0 THEN v_excluded END)),
      'link','/meter-readings');
    RETURN app_private.hermes_action_receipt_finish_v1(p_binding,p_action,p_request_id,v_outcome);
  EXCEPTION
    WHEN SQLSTATE 'HS001' THEN RETURN jsonb_build_object('kind','rejected','reason','state_changed');
    WHEN OTHERS THEN
      IF SQLSTATE IN ('40001','40P01','55P03','PT409') THEN RAISE; END IF;
      -- Hàm ghi từ chối lô (dữ liệu đổi sau bản xem trước) hay vi phạm CHECK chỉ số ⇒ xem trước lại.
      IF SQLERRM='meter_readings_rejected' OR SQLSTATE='23514' THEN RETURN jsonb_build_object('kind','rejected','reason','state_changed'); END IF;
      GET STACKED DIAGNOSTICS v_constraint=CONSTRAINT_NAME;
      v_reason:=app_private.hermes_action_reason_v1(SQLSTATE,SQLERRM,NULLIF(v_constraint,''));
      RETURN jsonb_build_object('kind','rejected','reason',v_reason);
  END;
END $fn$;

ALTER FUNCTION app_private.hermes_invoice_meter_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_invoice_meter_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
-- Vỏ INVOKER chạy dưới authenticated gắn OID hàm này (như 20261022183445).
GRANT EXECUTE ON FUNCTION app_private.hermes_invoice_meter_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb) TO authenticated;

DO $check$
BEGIN
  IF (SELECT md5(replace(p.prosrc,chr(13),'')) FROM pg_proc p WHERE p.oid='app_private.hermes_invoice_meter_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb)'::regprocedure AND p.prosecdef) IS DISTINCT FROM 'a1ffa3cf9bd1005e6042e71b7a2a0aa6'
    OR NOT has_function_privilege('authenticated','app_private.hermes_invoice_meter_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb)','EXECUTE')
    OR has_function_privilege('anon','app_private.hermes_invoice_meter_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb)','EXECUTE')
    OR NOT EXISTS(SELECT 1 FROM pg_depend WHERE classid='pg_proc'::regclass
      AND objid='public.hermes_invoice_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text)'::regprocedure
      AND refobjid='app_private.hermes_invoice_meter_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb)'::regprocedure) THEN
    RAISE EXCEPTION 'hermes_invoice_meter_lower_facts_check_failed'; END IF;
END $check$;

COMMIT;
