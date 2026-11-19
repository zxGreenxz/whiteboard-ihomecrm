-- Đợt 3 trang HOÁ ĐƠN — Mốc 4 (23/10/2026; docs/plans/hermes-crm/HOA-DON-THAO-TAC-GHI.md mục 4.2, 6.2): hàm DÙNG CHUNG web ⇄ trợ lý cho
-- việc ghi chỉ số công tơ tháng (luật 17/10: ≥ 2 nơi + tiền ⇒ hàm SQL). File không chứa hàm trợ lý (lệ hàm dùng chung).
--  (1) public.meter_readings_plan_v1(toà, ngày chốt, dòng[], replace) STABLE INVOKER search_path='': kế hoạch từng dòng, không ghi.
--      Dòng {meterId} hoặc {roomId, meterType, meterCode} + value (+ notes, imageUrl). Chỉ số đầu ĐÚNG luật trigger
--      auto_populate_previous_reading (dòng chưa xoá mới nhất theo reading_date, created_at; không có thì meters.initial_reading; không
--      có nữa thì 0) — đó là số CHECK meter_readings_current_gte_previous so. Hoá đơn tháng lại lấy chỉ số đầu từ dòng APPROVED mới nhất
--      và KHÔNG đọc initial_reading (excelInvoiceRows.ts, GenerateInvoiceDialog.tsx): khi hai số lệch (công tơ chưa có chỉ số đã duyệt,
--      hoặc dòng mới nhất chưa duyệt) kế hoạch cảnh báo để người ghi biết hoá đơn sẽ tính từ đâu. Trạng thái dòng: ok | replace |
--      duplicate_month | lower_than_previous | used_by_invoice | has_later_reading | meter_not_found | meter_ambiguous |
--      duplicate_in_batch | invalid_value | invalid_row.
--      * Trùng tháng chỉ tính chỉ số THÁNG: dòng chưa xoá cùng settlement_month, không phải chỉ số chốt trả phòng (mã TLY…) và không
--        gắn ranh giới hợp đồng (boundary_id). Mỗi (công tơ, kỳ) có thể có hai chỉ số hợp lệ (chốt trả phòng + tháng) ⇒ KHÔNG thêm unique
--        (sẽ làm 23505 lượt chốt trả phòng); production có sẵn 12 cặp trùng tháng ⇒ cũng không thể thêm.
--      * replace (người dùng nói "sửa"): thay số của dòng tháng cũ khi dòng đó là duy nhất, chưa lên hoá đơn còn hiệu lực (suy bằng dòng
--        SERVICE cùng phòng/kỳ/số cuối; KHÔNG xét service_id — đo production 23/10: dòng hoá đơn mang service_id khác của công tơ,
--        bỏ điều kiện đó thì 663/692 chỉ số tháng 07–09 khớp số cuối hoá đơn cùng kỳ) và không có chỉ số
--        sau nó.
--      * Có chỉ số ngày SAU ngày chốt ⇒ has_later_reading: trigger lấy chỉ số đầu theo reading_date mới nhất nên ghi lùi ngày làm lệch
--        chuỗi chỉ số (án lệ 23/09: 4 bản nhận chỉ số đầu cũ).
--  (2) public.record_meter_readings_v2(toà, ngày chốt, dòng[], replace, idempotency_key) SECURITY DEFINER: hàm ghi. Tự kiểm auth.uid()
--      bằng ĐÚNG biểu thức policy của bảng (meter_readings_insert_rbac / _update_rbac + meter_readings_org_boundary); khoá tư vấn
--      THEO TOÀ (hai người ghi cùng lúc vẫn chỉ một dòng/tháng — rào chống trùng nằm trong hàm, không phải unique); idempotency
--      canonical_write_operations('meter.readings.v2', toà, người, khoá) + băm; gọi lại (1) dưới khoá (một nguồn luật) và từ chối CẢ LÔ
--      khi có dòng không ghi được (22023 meter_readings_rejected, DETAIL = dòng lỗi dạng JSON). INSERT status APPROVED, approved_by =
--      người ghi (như form web); trigger hiện có vẫn điền settlement_month, previous_reading, recorded_by, mã CSS…
-- Không ghi dữ liệu, không đổi hàm/bảng cũ. Idempotent (CREATE OR REPLACE); khối kiểm cuối chỉ đọc catalog. Áp SAU khi TEST = production
-- về các trigger được ghim md5 bên dưới (thân production 23/10).
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $requires$
BEGIN
  IF to_regclass('public.meter_readings') IS NULL OR to_regclass('public.meters') IS NULL OR to_regclass('public.rooms') IS NULL
    OR to_regclass('public.invoices') IS NULL OR to_regclass('public.invoice_items') IS NULL OR to_regclass('app_private.canonical_write_operations') IS NULL
    OR to_regprocedure('public.org_today_v1(uuid)') IS NULL OR to_regprocedure('public.is_super_admin()') IS NULL
    OR to_regprocedure('public.my_org_ids()') IS NULL OR to_regprocedure('app_private.buildings_for_v3(text)') IS NULL
    -- Kế hoạch chép luật của hai trigger này: thân đổi thì phải soát lại kế hoạch trước khi áp.
    OR (SELECT md5(replace(p.prosrc,chr(13),'')) FROM pg_proc p WHERE p.oid='public.auto_populate_previous_reading()'::regprocedure)
      IS DISTINCT FROM 'f82612341883caee4e9099402bc8a188'
    OR (SELECT md5(replace(p.prosrc,chr(13),'')) FROM pg_proc p WHERE p.oid='public.auto_populate_meter_reading_fields()'::regprocedure)
      IS DISTINCT FROM '2b5b19a6806b9a3254d6a8fe57884f8c'
    OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.meter_readings'::regclass AND conname='meter_readings_current_gte_previous') THEN
    RAISE EXCEPTION 'meter_readings_v2_dependency_invalid'; END IF;
END $requires$;

-- 1. Kế hoạch (không ghi). INVOKER: người dùng gọi thì đọc dưới RLS của họ; hàm ghi (DEFINER, chủ postgres) gọi lại sau khi tự kiểm quyền.
CREATE OR REPLACE FUNCTION public.meter_readings_plan_v1(p_building_id uuid,p_reading_date date,p_rows jsonb,p_replace boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
DECLARE
  v_org uuid; v_today date; v_month text; v_out jsonb:='[]'::jsonb; v_r jsonb; v_n int:=0; v_status text; v_warn jsonb; v_seen uuid[]:='{}';
  v_value numeric; v_type text; v_code text; v_count int; v_cands jsonb;
  v_meter uuid; v_meter_code text; v_meter_type text; v_room uuid; v_service uuid; v_initial numeric; v_meter_status text; v_room_name text;
  v_prev numeric; v_start numeric; v_avg numeric; v_cons numeric; v_later date;
  v_ex uuid; v_ex_value numeric; v_ex_prev numeric; v_ex_date date; v_ex_updated timestamptz; v_ex_code text; v_ex_created timestamptz; v_ex_count int;
  v_ok int:=0; v_replace int:=0; v_blocked int:=0; v_top jsonb:='[]'::jsonb;
BEGIN
  IF current_user NOT IN ('authenticated','postgres') THEN RAISE EXCEPTION 'meter_readings_plan_denied' USING ERRCODE='42501'; END IF;
  IF p_building_id IS NULL OR p_reading_date IS NULL OR p_rows IS NULL OR jsonb_typeof(p_rows)<>'array' OR jsonb_array_length(p_rows) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'meter_readings_plan_invalid' USING ERRCODE='22023'; END IF;
  SELECT b.organization_id INTO v_org FROM public.buildings b WHERE b.id=p_building_id AND b.deleted_at IS NULL;
  IF NOT FOUND OR v_org IS NULL THEN
    RETURN jsonb_build_object('ok',false,'buildingId',p_building_id,'blockers',jsonb_build_array('building_not_found'),'rows','[]'::jsonb); END IF;
  v_today:=public.org_today_v1(v_org);
  v_month:=to_char(p_reading_date,'YYYY-MM');
  IF p_reading_date>v_today THEN v_top:=v_top||jsonb_build_array(jsonb_build_object('code','future_date','today',v_today)); END IF;
  FOR v_r IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
    v_n:=v_n+1; v_status:=NULL; v_warn:='[]'::jsonb; v_cands:=NULL; v_value:=NULL;
    v_meter:=NULL; v_meter_code:=NULL; v_meter_type:=NULL; v_room:=NULL; v_service:=NULL; v_initial:=NULL; v_meter_status:=NULL; v_room_name:=NULL;
    v_prev:=NULL; v_start:=NULL; v_avg:=NULL; v_cons:=NULL; v_later:=NULL; v_ex:=NULL; v_ex_value:=NULL; v_ex_prev:=NULL; v_ex_date:=NULL;
    v_ex_updated:=NULL; v_ex_code:=NULL; v_ex_created:=NULL; v_ex_count:=0;
    IF jsonb_typeof(v_r) IS DISTINCT FROM 'object' OR jsonb_typeof(v_r->'value') IS DISTINCT FROM 'number'
      OR (v_r ? 'meterId' AND jsonb_typeof(v_r->'meterId') IS DISTINCT FROM 'string')
      OR (NOT v_r ? 'meterId' AND jsonb_typeof(v_r->'roomId') IS DISTINCT FROM 'string') THEN v_status:='invalid_row';
    ELSE
      v_value:=(v_r->>'value')::numeric;
      IF v_value<0 OR v_value>=100000000 OR round(v_value,2)<>v_value THEN v_status:='invalid_value'; END IF;
    END IF;
    -- Công tơ: theo id (form web), hoặc phòng + loại (+ mã) với công tơ ACTIVE chưa xoá của đúng toà.
    IF v_status IS NULL AND v_r ? 'meterId' THEN
      SELECT m.id,m.code,m.meter_type::text,m.room_id,m.service_id,m.initial_reading,m.status
        INTO v_meter,v_meter_code,v_meter_type,v_room,v_service,v_initial,v_meter_status
        FROM public.meters m WHERE m.id=(v_r->>'meterId')::uuid AND m.building_id=p_building_id AND m.deleted_at IS NULL;
      IF NOT FOUND THEN v_status:='meter_not_found'; END IF;
    ELSIF v_status IS NULL THEN
      v_type:=upper(COALESCE(NULLIF(btrim(v_r->>'meterType'),''),'ELECTRICITY'));
      v_code:=NULLIF(btrim(v_r->>'meterCode'),'');
      SELECT count(*) INTO v_count FROM public.meters m WHERE m.room_id=(v_r->>'roomId')::uuid AND m.building_id=p_building_id
        AND m.deleted_at IS NULL AND m.status='ACTIVE' AND m.meter_type::text=v_type AND (v_code IS NULL OR upper(m.code)=upper(v_code));
      IF v_count=0 THEN v_status:='meter_not_found';
      ELSIF v_count>1 THEN
        v_status:='meter_ambiguous';
        SELECT jsonb_agg(c ORDER BY c) INTO v_cands FROM (SELECT m.code c FROM public.meters m WHERE m.room_id=(v_r->>'roomId')::uuid
          AND m.building_id=p_building_id AND m.deleted_at IS NULL AND m.status='ACTIVE' AND m.meter_type::text=v_type ORDER BY m.code LIMIT 8) x;
      ELSE
        SELECT m.id,m.code,m.meter_type::text,m.room_id,m.service_id,m.initial_reading,m.status
          INTO v_meter,v_meter_code,v_meter_type,v_room,v_service,v_initial,v_meter_status
          FROM public.meters m WHERE m.room_id=(v_r->>'roomId')::uuid AND m.building_id=p_building_id AND m.deleted_at IS NULL AND m.status='ACTIVE'
            AND m.meter_type::text=v_type AND (v_code IS NULL OR upper(m.code)=upper(v_code));
      END IF;
    END IF;
    IF v_room IS NULL AND v_status IS DISTINCT FROM 'invalid_row' AND NOT v_r ? 'meterId' THEN v_room:=(v_r->>'roomId')::uuid; END IF;
    IF v_room IS NOT NULL THEN SELECT r.name INTO v_room_name FROM public.rooms r WHERE r.id=v_room; END IF;
    IF v_meter IS NOT NULL THEN
      IF v_meter=ANY(v_seen) THEN v_status:=COALESCE(v_status,'duplicate_in_batch'); ELSE v_seen:=v_seen||v_meter; END IF;
      -- Dòng tháng đang có (không tính chốt trả phòng TLY… và dòng gắn ranh giới hợp đồng).
      SELECT count(*) INTO v_ex_count FROM public.meter_readings mr WHERE mr.meter_id=v_meter AND mr.deleted_at IS NULL
        AND mr.settlement_month=v_month AND COALESCE(mr.reading_code,'') NOT LIKE 'TLY%' AND mr.boundary_id IS NULL;
      IF v_ex_count>0 THEN
        SELECT mr.id,mr.current_reading,mr.previous_reading,mr.reading_date,mr.updated_at,mr.reading_code,mr.created_at
          INTO v_ex,v_ex_value,v_ex_prev,v_ex_date,v_ex_updated,v_ex_code,v_ex_created
          FROM public.meter_readings mr WHERE mr.meter_id=v_meter AND mr.deleted_at IS NULL AND mr.settlement_month=v_month
            AND COALESCE(mr.reading_code,'') NOT LIKE 'TLY%' AND mr.boundary_id IS NULL ORDER BY mr.reading_date DESC,mr.created_at DESC LIMIT 1;
      END IF;
      -- Chỉ số đầu ĐÚNG trigger (dòng thay thì giữ số đầu đã lưu của chính nó); số đầu của hoá đơn = dòng APPROVED mới nhất.
      IF v_ex IS NOT NULL AND COALESCE(p_replace,false) THEN v_prev:=v_ex_prev;
      ELSE
        SELECT mr.current_reading INTO v_prev FROM public.meter_readings mr WHERE mr.meter_id=v_meter AND mr.deleted_at IS NULL
          ORDER BY mr.reading_date DESC,mr.created_at DESC LIMIT 1;
        IF NOT FOUND THEN v_prev:=COALESCE(v_initial,0); END IF;
      END IF;
      SELECT mr.current_reading INTO v_start FROM public.meter_readings mr WHERE mr.meter_id=v_meter AND mr.deleted_at IS NULL
        AND mr.status='APPROVED' AND (v_ex IS NULL OR NOT COALESCE(p_replace,false) OR mr.id<>v_ex) ORDER BY mr.reading_date DESC,mr.created_at DESC LIMIT 1;
      SELECT max(mr.reading_date) INTO v_later FROM public.meter_readings mr WHERE mr.meter_id=v_meter AND mr.deleted_at IS NULL
        AND (v_ex IS NULL OR NOT COALESCE(p_replace,false) OR mr.id<>v_ex)
        AND (mr.reading_date>p_reading_date OR (v_ex IS NOT NULL AND COALESCE(p_replace,false)
          AND (mr.reading_date>v_ex_date OR (mr.reading_date=v_ex_date AND mr.created_at>v_ex_created))));
      SELECT avg(x.c) INTO v_avg FROM (SELECT mr.consumption c FROM public.meter_readings mr WHERE mr.meter_id=v_meter AND mr.deleted_at IS NULL
        AND mr.status='APPROVED' AND COALESCE(mr.reading_code,'') NOT LIKE 'TLY%' AND (v_ex IS NULL OR mr.id<>v_ex)
        ORDER BY mr.reading_date DESC,mr.created_at DESC LIMIT 3) x;
      IF v_status IS NULL THEN
        v_status:=CASE
          WHEN v_ex IS NOT NULL AND (NOT COALESCE(p_replace,false) OR v_ex_count>1) THEN 'duplicate_month'
          WHEN v_later IS NOT NULL THEN 'has_later_reading'
          WHEN v_ex IS NOT NULL AND EXISTS(SELECT 1 FROM public.invoices i JOIN public.invoice_items it ON it.invoice_id=i.id
              WHERE i.room_id=v_room AND i.billing_month=v_month AND i.deleted_at IS NULL AND i.status::text<>'CANCELLED'
                AND it.type::text='SERVICE' AND it.current_reading=v_ex_value) THEN 'used_by_invoice'
          WHEN v_value<v_prev THEN 'lower_than_previous'
          WHEN v_ex IS NOT NULL THEN 'replace'
          ELSE 'ok' END;
      END IF;
      IF v_status IN ('ok','replace') THEN
        v_cons:=v_value-v_prev;
        IF v_cons=0 THEN v_warn:=v_warn||jsonb_build_array(jsonb_build_object('code','zero_consumption')); END IF;
        IF v_avg>0 AND v_cons>=3*v_avg THEN
          v_warn:=v_warn||jsonb_build_array(jsonb_build_object('code','high_consumption','avg3',round(v_avg,2),'ratio',round(v_cons/v_avg,1))); END IF;
        -- Bẫy chỉ số đầu: hoá đơn tháng lấy dòng APPROVED mới nhất, KHÔNG lấy meters.initial_reading.
        IF v_start IS NULL THEN
          v_warn:=v_warn||jsonb_build_array(jsonb_build_object('code','no_approved_start','previous',v_prev,'initialReading',v_initial));
        ELSIF v_start<>v_prev THEN
          v_warn:=v_warn||jsonb_build_array(jsonb_build_object('code','start_differs','approvedStart',v_start,'previous',v_prev)); END IF;
        IF v_meter_status IS DISTINCT FROM 'ACTIVE' THEN
          v_warn:=v_warn||jsonb_build_array(jsonb_build_object('code','meter_inactive','meterStatus',v_meter_status)); END IF;
      END IF;
    END IF;
    IF v_status='ok' THEN v_ok:=v_ok+1; ELSIF v_status='replace' THEN v_replace:=v_replace+1; ELSE v_blocked:=v_blocked+1; END IF;
    v_out:=v_out||jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('n',v_n,'status',v_status,'meterId',v_meter,'meterCode',v_meter_code,
      'meterType',v_meter_type,'roomId',v_room,'roomName',v_room_name,'value',v_value,'previous',v_prev,'approvedStart',v_start,
      'consumption',v_cons,'avg3',round(v_avg,2),'laterReadingDate',v_later,'candidates',v_cands,
      'existing',CASE WHEN v_ex IS NOT NULL THEN jsonb_build_object('id',v_ex,'value',v_ex_value,'previous',v_ex_prev,'readingDate',v_ex_date,
        'updatedAt',v_ex_updated,'code',v_ex_code,'count',v_ex_count) END,
      'notes',NULLIF(btrim(v_r->>'notes'),''),'imageUrl',NULLIF(btrim(v_r->>'imageUrl'),''),'warnings',v_warn)));
  END LOOP;
  RETURN jsonb_build_object('ok',v_blocked=0,'buildingId',p_building_id,'organizationId',v_org,'readingDate',p_reading_date,'settlementMonth',v_month,
    'today',v_today,'replace',COALESCE(p_replace,false),'warnings',v_top,'blockers','[]'::jsonb,
    'counts',jsonb_build_object('ok',v_ok,'replace',v_replace,'blocked',v_blocked),'rows',v_out);
END $fn$;

-- 2. Hàm ghi (DEFINER). Lô cả-hoặc-không; dòng không ghi được ⇒ 22023 meter_readings_rejected, DETAIL = [{n,status,roomName,meterCode,…}].
CREATE OR REPLACE FUNCTION public.record_meter_readings_v2(p_building_id uuid,p_reading_date date,p_rows jsonb,p_replace boolean DEFAULT false,
  p_idempotency_key text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE
  v_actor uuid:=auth.uid(); v_org uuid; v_key text:=NULLIF(btrim(p_idempotency_key),''); v_hash text; v_op app_private.canonical_write_operations%ROWTYPE;
  v_plan jsonb; v_row jsonb; v_bad jsonb; v_id uuid; v_code text; v_prev numeric; v_created jsonb:='[]'::jsonb; v_replaced jsonb:='[]'::jsonb;
  v_response jsonb; v_item jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE='42501'; END IF;
  IF p_building_id IS NULL OR p_reading_date IS NULL OR p_rows IS NULL OR jsonb_typeof(p_rows)<>'array' OR jsonb_array_length(p_rows) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'Danh sách chỉ số không hợp lệ (1–500 dòng, có toà và ngày chốt)' USING ERRCODE='22023'; END IF;
  IF v_key IS NOT NULL AND v_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' THEN
    RAISE EXCEPTION 'idempotency_key phải dài 8-200 ký tự ASCII an toàn' USING ERRCODE='22023'; END IF;
  SELECT b.organization_id INTO v_org FROM public.buildings b WHERE b.id=p_building_id AND b.deleted_at IS NULL;
  IF NOT FOUND OR v_org IS NULL THEN RAISE EXCEPTION 'Không tìm thấy toà nhà' USING ERRCODE='42501'; END IF;
  -- ĐÚNG biểu thức policy của bảng (DEFINER bỏ qua RLS nên phải tự kiểm): meter_readings_org_boundary + meter_readings_insert_rbac.
  IF NOT (public.is_super_admin() OR v_org=ANY(public.my_org_ids())) THEN
    RAISE EXCEPTION 'Toà nhà thuộc tổ chức khác' USING ERRCODE='42501'; END IF;
  IF NOT (public.is_super_admin() OR p_building_id=ANY(app_private.buildings_for_v3('meter_readings.create'))) THEN
    RAISE EXCEPTION 'Không có quyền ghi chỉ số cho toà này' USING ERRCODE='42501'; END IF;
  -- Một lượt ghi một lúc trên một toà: rào chống trùng (công tơ, tháng) giữa hai người ghi cùng lúc.
  PERFORM pg_advisory_xact_lock(hashtextextended('meter_readings.v2:'||p_building_id::text,0));
  IF v_key IS NOT NULL THEN
    v_hash:=md5(jsonb_build_object('building',p_building_id,'date',p_reading_date,'rows',p_rows,'replace',COALESCE(p_replace,false))::text);
    INSERT INTO app_private.canonical_write_operations(organization_id,operation,subject_scope,actor_id,idempotency_key,payload_hash)
      VALUES(v_org,'meter.readings.v2',p_building_id::text,v_actor,v_key,v_hash)
      ON CONFLICT(organization_id,operation,subject_scope,actor_id,idempotency_key) DO NOTHING;
    SELECT * INTO v_op FROM app_private.canonical_write_operations o WHERE o.organization_id=v_org AND o.operation='meter.readings.v2'
      AND o.subject_scope=p_building_id::text AND o.actor_id=v_actor AND o.idempotency_key=v_key FOR UPDATE;
    IF v_op.payload_hash<>v_hash THEN RAISE EXCEPTION 'idempotency_key đã dùng với nội dung khác' USING ERRCODE='23505'; END IF;
    IF v_op.completed_at IS NOT NULL THEN RETURN v_op.response_payload; END IF;
  END IF;
  v_plan:=public.meter_readings_plan_v1(p_building_id,p_reading_date,p_rows,COALESCE(p_replace,false));
  IF NOT COALESCE((v_plan->>'ok')::boolean,false) THEN
    SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object('n',r->'n','status',r->'status','roomName',r->'roomName','meterCode',r->'meterCode',
        'previous',r->'previous','existingValue',r#>'{existing,value}','laterReadingDate',r->'laterReadingDate')) ORDER BY (r->>'n')::int)
      INTO v_bad FROM jsonb_array_elements(COALESCE(v_plan->'rows','[]'::jsonb)) r WHERE r->>'status' NOT IN ('ok','replace');
    RAISE EXCEPTION 'meter_readings_rejected' USING ERRCODE='22023',
      DETAIL=COALESCE(v_bad,jsonb_build_array(jsonb_build_object('status',v_plan->'blockers'->>0)))::text,
      HINT=COALESCE(v_bad->0->>'status',v_plan->'blockers'->>0);
  END IF;
  IF (v_plan#>>'{counts,replace}')::int>0 AND NOT (public.is_super_admin() OR p_building_id=ANY(app_private.buildings_for_v3('meter_readings.edit'))) THEN
    RAISE EXCEPTION 'Không có quyền sửa chỉ số cho toà này' USING ERRCODE='42501'; END IF;
  BEGIN
    FOR v_row IN SELECT value FROM jsonb_array_elements(v_plan->'rows') ORDER BY (value->>'n')::int LOOP
      IF v_row->>'status'='ok' THEN
        INSERT INTO public.meter_readings(user_id,organization_id,meter_id,reading_date,current_reading,notes,meter_image_url,status,approved_by,approved_at)
          VALUES(v_actor,v_org,(v_row->>'meterId')::uuid,p_reading_date,(v_row->>'value')::numeric,v_row->>'notes',v_row->>'imageUrl','APPROVED',v_actor,now())
          RETURNING id,reading_code,previous_reading INTO v_id,v_code,v_prev;
      ELSE
        UPDATE public.meter_readings mr SET current_reading=(v_row->>'value')::numeric,reading_date=p_reading_date,
            notes=COALESCE(v_row->>'notes',mr.notes),meter_image_url=COALESCE(v_row->>'imageUrl',mr.meter_image_url),
            status='APPROVED',approved_by=v_actor,approved_at=now()
          WHERE mr.id=(v_row#>>'{existing,id}')::uuid AND mr.deleted_at IS NULL AND mr.updated_at=(v_row#>>'{existing,updatedAt}')::timestamptz
          RETURNING mr.id,mr.reading_code,mr.previous_reading INTO v_id,v_code,v_prev;
        IF NOT FOUND THEN RAISE EXCEPTION 'meter_readings_state_changed' USING ERRCODE='40001'; END IF;
      END IF;
      -- Dưới khoá toà, trigger phải tính đúng số đầu như kế hoạch; lệch = có đường ghi khác chen vào (không qua khoá) ⇒ lùi cả lô.
      IF v_prev IS DISTINCT FROM (v_row->>'previous')::numeric THEN RAISE EXCEPTION 'meter_readings_state_changed' USING ERRCODE='40001'; END IF;
      v_item:=jsonb_strip_nulls(jsonb_build_object('n',v_row->'n','id',v_id,'code',v_code,'meterId',v_row->'meterId','meterCode',v_row->'meterCode',
        'roomId',v_row->'roomId','roomName',v_row->'roomName','previous',v_prev,'value',(v_row->>'value')::numeric,
        'consumption',(v_row->>'value')::numeric-v_prev));
      IF v_row->>'status'='ok' THEN v_created:=v_created||jsonb_build_array(v_item); ELSE v_replaced:=v_replaced||jsonb_build_array(v_item); END IF;
    END LOOP;
  EXCEPTION WHEN check_violation THEN
    RAISE EXCEPTION 'Chỉ số mới không hợp lệ (phải ≥ chỉ số kỳ trước)' USING ERRCODE='23514';
  END;
  v_response:=jsonb_build_object('buildingId',p_building_id,'organizationId',v_org,'readingDate',p_reading_date,'settlementMonth',v_plan->'settlementMonth',
    'created',v_created,'replaced',v_replaced,'count',jsonb_array_length(v_created)+jsonb_array_length(v_replaced));
  IF v_key IS NOT NULL THEN
    UPDATE app_private.canonical_write_operations SET subject_id=p_building_id,completed_at=clock_timestamp(),response_payload=v_response
      WHERE organization_id=v_org AND operation='meter.readings.v2' AND subject_scope=p_building_id::text AND actor_id=v_actor AND idempotency_key=v_key;
  END IF;
  RETURN v_response;
END $fn$;

ALTER FUNCTION public.meter_readings_plan_v1(uuid,date,jsonb,boolean) OWNER TO postgres;
ALTER FUNCTION public.record_meter_readings_v2(uuid,date,jsonb,boolean,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.meter_readings_plan_v1(uuid,date,jsonb,boolean) FROM PUBLIC,anon,service_role;
REVOKE ALL ON FUNCTION public.record_meter_readings_v2(uuid,date,jsonb,boolean,text) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.meter_readings_plan_v1(uuid,date,jsonb,boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_meter_readings_v2(uuid,date,jsonb,boolean,text) TO authenticated;

DO $check$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.meter_readings_plan_v1(uuid,date,jsonb,boolean)'::regprocedure
      AND NOT prosecdef AND provolatile='s' AND replace(COALESCE(array_to_string(proconfig,','),''),'"','')='search_path=')
    OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.record_meter_readings_v2(uuid,date,jsonb,boolean,text)'::regprocedure AND prosecdef AND provolatile='v')
    OR has_function_privilege('anon','public.record_meter_readings_v2(uuid,date,jsonb,boolean,text)','EXECUTE')
    OR has_function_privilege('anon','public.meter_readings_plan_v1(uuid,date,jsonb,boolean)','EXECUTE')
    OR NOT has_function_privilege('authenticated','public.record_meter_readings_v2(uuid,date,jsonb,boolean,text)','EXECUTE')
    OR NOT has_function_privilege('authenticated','public.meter_readings_plan_v1(uuid,date,jsonb,boolean)','EXECUTE') THEN
    RAISE EXCEPTION 'meter_readings_v2_catalog_invalid'; END IF;
END $check$;
COMMIT;
