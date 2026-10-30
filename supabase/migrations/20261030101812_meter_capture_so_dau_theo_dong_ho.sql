-- Số đầu theo đồng hồ: đồng hồ thuộc phòng, không thuộc hợp đồng. Từ hoá đơn thứ hai của hợp đồng, số đầu là
-- chỉ số APPROVED mới nhất của đồng hồ ở mọi hợp đồng, kể cả chỉ số ghi tay không gắn hợp đồng (như trigger
-- auto_populate_previous_reading và Mode Excel). Hoá đơn đầu tiên giữ nguyên đường cũ của 20261023150206.
BEGIN;

-- Chỉ ghi đè thân đã review của 20261023150206 (đang chạy trên production 30/10/2026) hoặc thân của chính file này.
DO $requires$
DECLARE v_expected jsonb:='{"meter_capture_previous_value_v1":["615cf1a7c1a310abc0c8742e347d0deb","f052713cf429befe322ff01dce2f53f9"],
 "meter_capture_anomaly_v1":["dbb94bccd38281724cfbcb2b85ffc9e2","e1e302ead1fde12e890fb6e1445900e7"],
 "meter_capture_resolve_billing_v1":["c3f0fe249f3a2f1d8284b675c2698be3","4f6d6642f561af550b38c1d54ef1357c"]}';v_name text;
BEGIN
 FOR v_name IN SELECT jsonb_object_keys(v_expected) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='app_private' AND p.proname=v_name AND v_expected->v_name ? md5(replace(p.prosrc,chr(13),''))) THEN
   RAISE EXCEPTION '% drifted from the reviewed body; rebase this migration',v_name USING ERRCODE='55000';
  END IF;
 END LOOP;
END $requires$;

-- Cùng điều kiện "đã có hoá đơn trước" mà các bước MOVE_IN/initial của resolver dùng: không có thì là hoá đơn đầu tiên.
CREATE OR REPLACE FUNCTION app_private.meter_capture_has_prior_invoice_v1(p_org uuid,p_contract uuid,p_month text,p_purpose text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
 SELECT EXISTS(SELECT 1 FROM public.invoices i WHERE i.organization_id=p_org AND i.contract_id=p_contract AND i.deleted_at IS NULL
  AND i.status::text<>'CANCELLED' AND (i.billing_month<p_month OR (p_purpose='MOVE_OUT' AND i.billing_month=p_month)))
$$;
REVOKE ALL ON FUNCTION app_private.meter_capture_has_prior_invoice_v1(uuid,uuid,text,text) FROM PUBLIC,anon,authenticated,service_role;

-- Chỉ số APPROVED mới nhất của đồng hồ trước mốc, không lọc hợp đồng; thứ tự như trigger cũ và Mode Excel.
-- p_before: nhận reading_date < p_before. p_at: ngày đó chỉ nhận chỉ số không có capture (MOVE_OUT nhận thêm
-- capture MONTHLY cùng ngày). MOVE_OUT nhận cả chỉ số dán ngày sau p_at nhưng đã ghi (giờ VN) đến hết ngày
-- p_at: Mode Excel ghi kỳ M+1 vào cuối tháng M và dán reading_date cuối tháng M+1.
CREATE OR REPLACE FUNCTION app_private.meter_capture_meter_latest_v1(p_org uuid,p_meter uuid,p_before date,p_at date,p_purpose text)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
 SELECT r.id FROM public.meter_readings r LEFT JOIN app_private.meter_captures cap ON cap.reading_id=r.id
 WHERE r.organization_id=p_org AND r.meter_id=p_meter AND r.status='APPROVED' AND r.deleted_at IS NULL AND cap.superseded_by IS NULL
  AND (r.reading_date<p_before
   OR (r.reading_date=p_at AND (cap.id IS NULL OR (p_purpose='MOVE_OUT' AND cap.purpose='MONTHLY')))
   OR (p_purpose='MOVE_OUT' AND r.reading_date>p_at AND (r.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date<=p_at))
 ORDER BY r.reading_date DESC,r.created_at DESC,r.id DESC LIMIT 1
$$;
REVOKE ALL ON FUNCTION app_private.meter_capture_meter_latest_v1(uuid,uuid,date,date,text) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION app_private.meter_capture_previous_value_v1(p_id uuid)
RETURNS numeric LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
DECLARE c app_private.meter_captures%ROWTYPE;v_previous numeric;v_start_date date;
BEGIN
 SELECT * INTO c FROM app_private.meter_captures WHERE id=p_id;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF c.status='CONFIRMED' THEN RETURN c.previous_value; END IF;
 SELECT previous_value INTO v_previous FROM app_private.meter_captures old
  WHERE old.organization_id=c.organization_id AND old.meter_id=c.meter_id AND old.contract_id=c.contract_id
   AND old.reading_date=c.reading_date AND old.purpose=c.purpose AND old.status='CONFIRMED' AND old.superseded_by IS NULL;
 IF FOUND THEN RETURN v_previous; END IF;
 SELECT start_date INTO v_start_date FROM public.contracts WHERE id=c.contract_id AND organization_id=c.organization_id AND deleted_at IS NULL;
 -- Keep authorized capture history readable after the contract is retired.
 -- A pending capture has no live billing baseline in that case; do not invoke
 -- the active-contract resolver and fail every row in the organization list.
 -- Confirmation still checks the live contract independently under its lock.
 IF NOT FOUND THEN RETURN c.previous_value; END IF;
 IF app_private.meter_capture_has_prior_invoice_v1(c.organization_id,c.contract_id,c.month,c.purpose) THEN
  SELECT r.current_reading INTO v_previous FROM public.meter_readings r
   WHERE r.id=app_private.meter_capture_meter_latest_v1(c.organization_id,c.meter_id,c.reading_date,c.reading_date,c.purpose);
 ELSE
  SELECT r.current_reading INTO v_previous FROM public.meter_readings r
   LEFT JOIN app_private.meter_captures cap ON cap.reading_id=r.id
   WHERE r.meter_id=c.meter_id AND r.contract_id=c.contract_id AND r.organization_id=c.organization_id
    AND r.deleted_at IS NULL AND r.status='APPROVED' AND r.reading_date>=v_start_date AND r.reading_date<=c.reading_date
    AND cap.superseded_by IS NULL AND (r.reading_date<c.reading_date OR cap.id IS NULL OR (c.purpose='MOVE_OUT' AND cap.purpose='MONTHLY'))
   ORDER BY r.reading_date DESC,r.created_at DESC,r.id DESC LIMIT 1;
 END IF;
 IF v_previous IS NULL THEN
  SELECT (x#>>'{start,value}')::numeric INTO v_previous FROM jsonb_array_elements(app_private.meter_capture_resolve_billing_v1(c.organization_id,
   jsonb_build_object('contractId',c.contract_id,'month',c.month,'readingDate',c.reading_date,'purpose',c.purpose))->'meters') x WHERE x->>'meterId'=c.meter_id::text;
 END IF;
 RETURN v_previous;
END $$;

CREATE OR REPLACE FUNCTION app_private.meter_capture_anomaly_v1(p_capture_id uuid,p_value numeric,p_previous numeric DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
DECLARE c app_private.meter_captures%ROWTYPE;v_median numeric;v_previous numeric:=p_previous;v_meter_wide boolean;
BEGIN
 IF p_value IS NULL THEN RETURN '[]'::jsonb; END IF;
 SELECT * INTO c FROM app_private.meter_captures WHERE id=p_capture_id;
 -- Hoá đơn đầu tiên: lịch sử của hợp đồng như cũ. Từ hoá đơn thứ hai: lịch sử của đồng hồ.
 v_meter_wide:=app_private.meter_capture_has_prior_invoice_v1(c.organization_id,c.contract_id,c.month,c.purpose);
 SELECT percentile_cont(0.5) WITHIN GROUP(ORDER BY delta)::numeric INTO v_median FROM (
  SELECT current_reading-previous_reading delta FROM public.meter_readings r WHERE r.organization_id=c.organization_id
   AND r.meter_id=c.meter_id AND (v_meter_wide OR r.contract_id=c.contract_id) AND r.deleted_at IS NULL AND r.status='APPROVED' AND NOT EXISTS(SELECT 1 FROM app_private.meter_captures retired WHERE retired.reading_id=r.id AND retired.superseded_by IS NOT NULL)
   AND r.reading_date<=c.reading_date AND r.created_at<c.created_at AND r.current_reading>r.previous_reading
   ORDER BY r.reading_date DESC,r.created_at DESC LIMIT 3) h;
 IF v_median IS NULL THEN RETURN '["BASELINE_UNAVAILABLE"]'::jsonb; END IF;
 IF v_previous IS NULL THEN
  SELECT current_reading INTO v_previous FROM public.meter_readings r WHERE r.organization_id=c.organization_id AND r.meter_id=c.meter_id AND (v_meter_wide OR r.contract_id=c.contract_id)
   AND r.deleted_at IS NULL AND r.status='APPROVED' AND NOT EXISTS(SELECT 1 FROM app_private.meter_captures retired WHERE retired.reading_id=r.id AND retired.superseded_by IS NOT NULL) AND r.reading_date<=c.reading_date AND r.created_at<c.created_at ORDER BY r.reading_date DESC,r.created_at DESC LIMIT 1;
 END IF;
 IF v_previous IS NULL THEN RETURN '["BASELINE_UNAVAILABLE"]'::jsonb; END IF;
 IF p_value-v_previous>GREATEST(100,3*v_median) THEN RETURN '["ABNORMAL_INCREASE"]'::jsonb; END IF;
 RETURN '[]'::jsonb;
END $$;

CREATE OR REPLACE FUNCTION app_private.meter_capture_resolve_billing_v1(p_org uuid,p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
DECLARE c public.contracts%ROWTYPE; m record; v_building uuid; v_from date; v_to date; v_start jsonb; v_end jsonb;
 v_id uuid; v_rows jsonb:='[]'; v_purpose text:=COALESCE(p_payload->>'purpose','MONTHLY'); v_prior boolean;
BEGIN
 SELECT * INTO c FROM public.contracts WHERE id=(p_payload->>'contractId')::uuid AND organization_id=p_org AND deleted_at IS NULL;
 SELECT building_id INTO v_building FROM public.rooms WHERE id=c.room_id AND organization_id=p_org;
 PERFORM app_private.meter_capture_scope_v1(p_org,v_building,'meter_readings.view');
 IF p_payload->>'month' !~ '^\d{4}-(0[1-9]|1[0-2])$' OR v_purpose NOT IN ('MONTHLY','MOVE_OUT') THEN
  RAISE EXCEPTION 'Invalid meter billing period' USING ERRCODE='22023'; END IF;
 v_from:=GREATEST((p_payload->>'month'||'-01')::date,c.start_date);
 v_to:=LEAST(COALESCE((p_payload->>'readingDate')::date,((v_from+interval '1 month')::date-1)),COALESCE(c.actual_end_date,c.end_date));
 IF v_to<v_from THEN RAISE EXCEPTION 'Meter billing period outside contract' USING ERRCODE='22023'; END IF;
 v_prior:=app_private.meter_capture_has_prior_invoice_v1(p_org,c.id,p_payload->>'month',v_purpose);
 FOR m IN SELECT meters.*,p.decimal_places,p.register_code FROM public.meters meters LEFT JOIN app_private.meter_capture_profiles p ON p.meter_id=meters.id
  WHERE meters.organization_id=p_org AND meters.room_id=c.room_id AND meters.building_id=v_building AND meters.deleted_at IS NULL AND meters.status='ACTIVE' AND meters.meter_type::text='ELECTRICITY' ORDER BY meters.id
 LOOP
  v_start:=NULL;v_end:=NULL;
  IF v_prior THEN
   -- Từ hoá đơn thứ hai: chỉ số mới nhất của đồng hồ, không lọc hợp đồng. Không có thì đi tiếp các bước cũ.
   v_id:=app_private.meter_capture_meter_latest_v1(p_org,m.id,CASE WHEN v_purpose='MOVE_OUT' THEN v_to ELSE v_from END,CASE WHEN v_purpose='MOVE_OUT' THEN v_to END,v_purpose);
  ELSE
   SELECT r.id INTO v_id FROM public.meter_readings r WHERE r.organization_id=p_org AND r.contract_id=c.id AND r.meter_id=m.id
    AND r.status='APPROVED' AND NOT EXISTS(SELECT 1 FROM app_private.meter_captures retired WHERE retired.reading_id=r.id AND retired.superseded_by IS NOT NULL) AND r.deleted_at IS NULL AND r.reading_date>=c.start_date AND r.reading_date<v_from
    AND v_purpose='MONTHLY'
    ORDER BY r.reading_date DESC,r.created_at DESC,r.id DESC LIMIT 1;
  END IF;
  IF v_id IS NOT NULL THEN v_start:=app_private.meter_capture_reading_point_v1(v_id); END IF;
  IF v_purpose='MOVE_OUT' AND v_start IS NULL THEN
   SELECT l.end_reading_id INTO v_id FROM app_private.meter_capture_evidence_links l JOIN public.invoices i ON i.id=l.document_id
    WHERE l.document_kind='INVOICE' AND l.organization_id=p_org AND l.contract_id=c.id AND l.meter_id=m.id
    AND i.organization_id=p_org AND i.contract_id=c.id AND i.deleted_at IS NULL AND i.status::text<>'CANCELLED'
    AND NOT EXISTS(SELECT 1 FROM app_private.meter_captures retired WHERE retired.reading_id=l.end_reading_id AND retired.superseded_by IS NOT NULL)
    AND (l.source->>'purpose'='MOVE_OUT' OR i.billing_month<=p_payload->>'month') AND (l.source->>'readingDate')::date<=v_to
    ORDER BY (l.source->>'readingDate')::date DESC,i.created_at DESC LIMIT 1;
   IF v_id IS NOT NULL THEN v_start:=app_private.meter_capture_reading_point_v1(v_id); END IF;
  END IF;
  IF v_start IS NULL AND (SELECT count(*) FROM public.meters x WHERE x.organization_id=p_org AND x.room_id=c.room_id AND x.status='ACTIVE' AND x.deleted_at IS NULL AND x.meter_type::text='ELECTRICITY')=1 THEN
   SELECT jsonb_build_object('readingId',NULL,'value',ii.current_reading::text,'version','invoice:'||i.id::text||':'||ii.id::text||':'||i.updated_at::text,
    'captureId',NULL,'kind','invoice','readingDate',COALESCE(ii.to_date,i.issue_date)) INTO v_start
   FROM public.invoices i JOIN public.invoice_items ii ON ii.invoice_id=i.id WHERE i.organization_id=p_org AND i.contract_id=c.id
    AND NOT EXISTS(SELECT 1 FROM app_private.meter_capture_evidence_links billed JOIN app_private.meter_captures retired ON retired.reading_id IN (billed.start_reading_id,billed.end_reading_id) WHERE billed.document_kind='INVOICE' AND billed.document_id=i.id AND retired.superseded_by IS NOT NULL)
    AND i.deleted_at IS NULL AND i.status::text<>'CANCELLED' AND (i.billing_month<p_payload->>'month' OR (v_purpose='MOVE_OUT' AND i.billing_month=p_payload->>'month' AND COALESCE(ii.to_date,i.issue_date)<=v_to)) AND i.issue_date>=c.start_date
    AND (ii.service_id IS NOT DISTINCT FROM m.service_id OR (m.service_id IS NULL AND EXISTS(SELECT 1 FROM public.contract_services cs WHERE cs.organization_id=p_org AND cs.contract_id=c.id AND cs.service_id=ii.service_id))) AND ii.current_reading IS NOT NULL
    AND (SELECT count(*) FROM public.invoice_items same_line WHERE same_line.invoice_id=i.id AND same_line.current_reading IS NOT NULL AND
     (same_line.service_id IS NOT DISTINCT FROM m.service_id OR (m.service_id IS NULL AND EXISTS(SELECT 1 FROM public.contract_services cs WHERE cs.organization_id=p_org AND cs.contract_id=c.id AND cs.service_id=same_line.service_id))))=1
    ORDER BY i.billing_month DESC,i.issue_date DESC,i.created_at DESC,ii.sort_order DESC LIMIT 1;
  END IF;
  IF v_start IS NULL THEN
   SELECT jsonb_build_object('readingId',NULL,'value',b.reading::text,'version','boundary:'||s.id::text||':'||s.revision::text,
    'captureId',NULL,'kind','boundary','readingDate',s.effective_on) INTO v_start
   FROM public.contract_meter_boundary_sets s JOIN public.contract_meter_boundaries b ON b.set_id=s.id AND b.revision=s.revision
   WHERE s.organization_id=p_org AND s.contract_id=c.id AND s.kind='MOVE_IN' AND s.state='VERIFIED' AND b.meter_id=m.id AND b.state='VERIFIED'
    AND NOT EXISTS(SELECT 1 FROM public.invoices i WHERE i.organization_id=p_org AND i.contract_id=c.id AND i.deleted_at IS NULL AND i.status::text<>'CANCELLED' AND (i.billing_month<p_payload->>'month' OR (v_purpose='MOVE_OUT' AND i.billing_month=p_payload->>'month')));
  END IF;
  IF v_start IS NULL AND c.initial_electricity_reading IS NOT NULL AND
   NOT EXISTS(SELECT 1 FROM public.invoices i WHERE i.organization_id=p_org AND i.contract_id=c.id AND i.deleted_at IS NULL AND i.status::text<>'CANCELLED' AND (i.billing_month<p_payload->>'month' OR (v_purpose='MOVE_OUT' AND i.billing_month=p_payload->>'month'))) AND
   (SELECT count(*) FROM public.meters x WHERE x.organization_id=p_org AND x.room_id=c.room_id AND x.status='ACTIVE' AND x.deleted_at IS NULL AND x.meter_type::text='ELECTRICITY')=1 THEN
   v_start:=jsonb_build_object('readingId',NULL,'value',c.initial_electricity_reading::text,'version',c.updated_at::text,'captureId',NULL,'kind','contractInitial','readingDate',c.start_date);
  END IF;
  SELECT r.id INTO v_id FROM public.meter_readings r JOIN app_private.meter_captures cap ON cap.reading_id=r.id
   WHERE r.organization_id=p_org AND r.contract_id=c.id AND r.meter_id=m.id AND r.status='APPROVED' AND NOT EXISTS(SELECT 1 FROM app_private.meter_captures retired WHERE retired.reading_id=r.id AND retired.superseded_by IS NOT NULL) AND r.deleted_at IS NULL
    AND r.reading_date>=v_from AND r.reading_date<=v_to AND cap.purpose=v_purpose AND cap.status='CONFIRMED'
    AND (v_purpose<>'MOVE_OUT' OR r.reading_date=v_to)
   ORDER BY r.reading_date DESC,r.created_at DESC,r.id DESC LIMIT 1;
  IF v_id IS NOT NULL THEN v_end:=app_private.meter_capture_reading_point_v1(v_id); END IF;
  v_rows:=v_rows||jsonb_build_array(jsonb_build_object('meterId',m.id,'meterName',COALESCE(m.name,m.code),'meterType',m.meter_type,'serviceId',m.service_id,
   'decimalPlaces',COALESCE(m.decimal_places,2),'registerCode',COALESCE(m.register_code,''),'start',v_start,'end',v_end,
   'issues',(CASE WHEN v_start IS NULL THEN '["MISSING_START"]' ELSE '[]' END)::jsonb||(CASE WHEN v_end IS NULL THEN '["MISSING_END"]' ELSE '[]' END)::jsonb||
    (CASE WHEN EXISTS(SELECT 1 FROM app_private.meter_capture_evidence_links l
      JOIN app_private.meter_captures retired ON retired.reading_id IN (l.start_reading_id,l.end_reading_id)
      WHERE l.organization_id=p_org AND l.contract_id=c.id AND l.meter_id=m.id AND retired.superseded_by IS NOT NULL
       AND (l.source->>'readingDate')::date<=v_to AND (
        (l.document_kind='INVOICE' AND EXISTS(SELECT 1 FROM public.invoices billed WHERE billed.id=l.document_id AND billed.organization_id=p_org AND billed.deleted_at IS NULL AND billed.status::text<>'CANCELLED')) OR
        (l.document_kind='EXIT' AND EXISTS(SELECT 1 FROM public.contract_exit_cases exited WHERE exited.id=l.document_id AND exited.organization_id=p_org AND exited.state::text='FINALIZED'))))
     THEN '["BILLED_READING_REPLACED"]' ELSE '[]' END)::jsonb));
 END LOOP;
 RETURN jsonb_build_object('meters',v_rows);
END $$;

COMMIT;
