-- Lượt 8 Hoá đơn (24/10/2026, sửa theo nghiệm thu bot trên TEST; docs/plans/hermes-crm/HOA-DON-THAO-TAC-GHI.md mục 4.2, 6.2): hàm DÙNG CHUNG
-- web ⇄ trợ lý public.meter_readings_plan_v1 — ghi chỉ số tháng này không còn bị coi là "trùng tháng" / "có chỉ số ngày sau" vì CHỈ SỐ
-- CHỐT KỲ TRƯỚC ghi trước ngày. File không chứa hàm trợ lý (lệ hàm dùng chung). Thay thân tại chỗ (cùng chữ ký, cùng kiểu trả) nên form
-- Ghi chỉ số của web (record_meter_readings_v2) và invoice.meter_record của trợ lý cùng nhận bản sửa.
-- Vì sao (đo production + TEST 24/10, chỉ đọc): lập hoá đơn tháng Excel (useExcelInvoiceData.ts) ghi số cuối kỳ của kỳ M lúc lập hoá đơn
-- (cuối tháng M−1) với reading_date = ngày cuối kỳ M (ngày TƯƠNG LAI) ⇒ trigger auto_populate_meter_reading_fields đặt settlement_month = M:
-- 258 chỉ số kỳ 10/2026 tạo 29–30/09 mang ngày 31/10 (gần như mọi chỉ số kỳ 08–10). Ghi chỉ số đọc hôm nay (24/10) thì kế hoạch cũ:
--   * thấy dòng kỳ 10 đó ⇒ duplicate_month; người dùng nói "sửa" ⇒ dòng đó đã lên hoá đơn kỳ 10 ⇒ used_by_invoice;
--   * nếu qua được trùng thì ngày 31/10 > 24/10 ⇒ has_later_reading.
-- Bản sửa:
--   * Chỉ số CHỐT KỲ TRƯỚC ghi trước ngày = tạo (giờ công ty) TRƯỚC ngày chốt mới VÀ reading_date SAU ngày chốt mới: không tính vào trùng
--     tháng ⇒ không bị thay. Không loại dòng mang ngày ≤ ngày chốt (kể cả đã lên hoá đơn): dòng mới khi đó thành "APPROVED mới nhất theo
--     reading_date" = số đầu hoá đơn kỳ sau (GenerateInvoiceDialog / useExcelInvoiceData) ⇒ phần tiêu thụ trước nó không vào hoá đơn nào.
--   * has_later_reading theo ngày đọc thật LEAST(reading_date, ngày tạo): chỉ chỉ số đọc thật SAU ngày chốt mới chặn.
--   * Chỉ số tháng ĐÃ LÊN HOÁ ĐƠN ⇒ used_by_invoice ngay (trước đây duplicate_month gợi ý "nói sửa" rồi mới từ chối); "sửa" khi tháng chỉ
--     còn chỉ số chốt kỳ trước đã lên hoá đơn cùng kỳ ⇒ used_by_invoice (sửa số trên hoá đơn = điều chỉnh hoá đơn trên web). Ghi đè chỉ
--     với chỉ số tháng chưa lên hoá đơn (luật cũ giữ nguyên).
--   * Chỉ số đầu giữ ĐÚNG luật trigger auto_populate_previous_reading (dòng mới nhất theo reading_date ⇒ chính chỉ số chốt kỳ trước) —
--     record_meter_readings_v2 vẫn đối chiếu số đầu trigger = kế hoạch; CHECK current >= previous không đổi.
-- Không ghi dữ liệu, không đổi hàm khác. Idempotent (CREATE OR REPLACE). $requires$ ghim md5 thân đang chạy (20261022183026, hoặc chính
-- bản này khi chạy lại) và hai trigger; khối kiểm cuối chỉ đọc catalog.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $requires$
BEGIN
  IF to_regclass('public.meter_readings') IS NULL OR to_regclass('public.meters') IS NULL OR to_regclass('public.invoice_items') IS NULL
    OR to_regprocedure('public.record_meter_readings_v2(uuid,date,jsonb,boolean,text)') IS NULL
    OR (SELECT md5(replace(p.prosrc,chr(13),'')) FROM pg_proc p WHERE p.oid='public.meter_readings_plan_v1(uuid,date,jsonb,boolean)'::regprocedure)
      NOT IN ('af9c3e629883c9e1eb604c77b585506b','9e1af9c918bb91b100532ac6179a1d22')
    OR (SELECT md5(replace(p.prosrc,chr(13),'')) FROM pg_proc p WHERE p.oid='public.auto_populate_previous_reading()'::regprocedure)
      IS DISTINCT FROM 'f82612341883caee4e9099402bc8a188'
    OR (SELECT md5(replace(p.prosrc,chr(13),'')) FROM pg_proc p WHERE p.oid='public.auto_populate_meter_reading_fields()'::regprocedure)
      IS DISTINCT FROM '2b5b19a6806b9a3254d6a8fe57884f8c' THEN
    RAISE EXCEPTION 'meter_readings_plan_previous_period_dependency_invalid'; END IF;
END $requires$;

CREATE OR REPLACE FUNCTION public.meter_readings_plan_v1(p_building_id uuid,p_reading_date date,p_rows jsonb,p_replace boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
DECLARE
  v_org uuid; v_today date; v_month text; v_out jsonb:='[]'::jsonb; v_r jsonb; v_n int:=0; v_status text; v_warn jsonb; v_seen uuid[]:='{}';
  v_value numeric; v_type text; v_code text; v_count int; v_cands jsonb;
  v_meter uuid; v_meter_code text; v_meter_type text; v_room uuid; v_service uuid; v_initial numeric; v_meter_status text; v_room_name text;
  v_prev numeric; v_start numeric; v_avg numeric; v_cons numeric; v_later date;
  v_ex uuid; v_ex_value numeric; v_ex_prev numeric; v_ex_date date; v_ex_updated timestamptz; v_ex_code text; v_ex_created timestamptz; v_ex_count int; v_ex_eff date;
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
    v_ex_updated:=NULL; v_ex_code:=NULL; v_ex_created:=NULL; v_ex_count:=0; v_ex_eff:=NULL;
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
      -- Dòng tháng đang có: không tính chốt trả phòng TLY…, dòng gắn ranh giới hợp đồng, và CHỈ SỐ CHỐT KỲ TRƯỚC ghi trước ngày (tạo trước
      -- ngày chốt mới, mang ngày sau nó — lập hoá đơn tháng ghi số cuối kỳ với reading_date = cuối kỳ): đó là số đầu, không phải số trùng.
      SELECT count(*) INTO v_ex_count FROM public.meter_readings mr WHERE mr.meter_id=v_meter AND mr.deleted_at IS NULL
        AND mr.settlement_month=v_month AND COALESCE(mr.reading_code,'') NOT LIKE 'TLY%' AND mr.boundary_id IS NULL AND NOT (mr.reading_date>p_reading_date AND (mr.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date<p_reading_date);
      IF v_ex_count>0 THEN
        SELECT mr.id,mr.current_reading,mr.previous_reading,mr.reading_date,mr.updated_at,mr.reading_code,mr.created_at
          INTO v_ex,v_ex_value,v_ex_prev,v_ex_date,v_ex_updated,v_ex_code,v_ex_created
          FROM public.meter_readings mr WHERE mr.meter_id=v_meter AND mr.deleted_at IS NULL AND mr.settlement_month=v_month
            AND COALESCE(mr.reading_code,'') NOT LIKE 'TLY%' AND mr.boundary_id IS NULL AND NOT (mr.reading_date>p_reading_date AND (mr.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date<p_reading_date)
          ORDER BY mr.reading_date DESC,mr.created_at DESC LIMIT 1;
        v_ex_eff:=LEAST(v_ex_date,(v_ex_created AT TIME ZONE 'Asia/Ho_Chi_Minh')::date);
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
      -- "Có chỉ số ngày sau" theo NGÀY ĐỌC THẬT LEAST(reading_date, ngày tạo): chỉ số chốt cuối kỳ ghi trước ngày không chặn chỉ số mới.
      SELECT max(x.eff) INTO v_later FROM (SELECT LEAST(mr.reading_date,(mr.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date) eff,mr.created_at FROM public.meter_readings mr
          WHERE mr.meter_id=v_meter AND mr.deleted_at IS NULL AND (v_ex IS NULL OR NOT COALESCE(p_replace,false) OR mr.id<>v_ex)) x
        WHERE x.eff>p_reading_date OR (v_ex IS NOT NULL AND COALESCE(p_replace,false)
          AND (x.eff>v_ex_eff OR (x.eff=v_ex_eff AND x.created_at>v_ex_created)));
      SELECT avg(x.c) INTO v_avg FROM (SELECT mr.consumption c FROM public.meter_readings mr WHERE mr.meter_id=v_meter AND mr.deleted_at IS NULL
        AND mr.status='APPROVED' AND COALESCE(mr.reading_code,'') NOT LIKE 'TLY%' AND (v_ex IS NULL OR mr.id<>v_ex)
        ORDER BY mr.reading_date DESC,mr.created_at DESC LIMIT 3) x;
      IF v_status IS NULL THEN
        v_status:=CASE
          -- Chỉ số tháng đã lên hoá đơn ⇒ nói ngay (không gợi ý "nói sửa" để rồi mới từ chối). "Sửa" khi tháng chỉ còn chỉ số chốt kỳ trước
          -- đã lên hoá đơn cùng kỳ = sửa số trên hoá đơn ⇒ cũng used_by_invoice (điều chỉnh hoá đơn trên web).
          WHEN v_ex IS NOT NULL AND EXISTS(SELECT 1 FROM public.invoices i JOIN public.invoice_items it ON it.invoice_id=i.id
              WHERE i.room_id=v_room AND i.billing_month=v_month AND i.deleted_at IS NULL AND i.status::text<>'CANCELLED'
                AND it.type::text='SERVICE' AND it.current_reading=v_ex_value) THEN 'used_by_invoice'
          WHEN v_ex IS NULL AND COALESCE(p_replace,false) AND EXISTS(SELECT 1 FROM public.meter_readings mr WHERE mr.meter_id=v_meter
              AND mr.deleted_at IS NULL AND mr.settlement_month=v_month AND COALESCE(mr.reading_code,'') NOT LIKE 'TLY%' AND mr.boundary_id IS NULL
              AND EXISTS(SELECT 1 FROM public.invoices i JOIN public.invoice_items it ON it.invoice_id=i.id
              WHERE i.room_id=v_room AND i.billing_month=v_month AND i.deleted_at IS NULL AND i.status::text<>'CANCELLED'
                AND it.type::text='SERVICE' AND it.current_reading=mr.current_reading)) THEN 'used_by_invoice'
          WHEN v_ex IS NOT NULL AND (NOT COALESCE(p_replace,false) OR v_ex_count>1) THEN 'duplicate_month'
          WHEN v_later IS NOT NULL THEN 'has_later_reading'
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

ALTER FUNCTION public.meter_readings_plan_v1(uuid,date,jsonb,boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.meter_readings_plan_v1(uuid,date,jsonb,boolean) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.meter_readings_plan_v1(uuid,date,jsonb,boolean) TO authenticated;

DO $check$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.meter_readings_plan_v1(uuid,date,jsonb,boolean)'::regprocedure
      AND NOT prosecdef AND provolatile='s' AND replace(COALESCE(array_to_string(proconfig,','),''),'"','')='search_path='
      AND md5(replace(prosrc,chr(13),''))='9e1af9c918bb91b100532ac6179a1d22')
    OR has_function_privilege('anon','public.meter_readings_plan_v1(uuid,date,jsonb,boolean)','EXECUTE')
    OR NOT has_function_privilege('authenticated','public.meter_readings_plan_v1(uuid,date,jsonb,boolean)','EXECUTE') THEN
    RAISE EXCEPTION 'meter_readings_plan_previous_period_catalog_invalid'; END IF;
END $check$;
COMMIT;
