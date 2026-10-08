-- Mốc chỉ số trả phòng lấy từ chỉ số chốt khi quyết toán (chủ chốt 08/10/2026).
--
-- Trước đây số điện cuối được hỏi hai nơi: khối "Chỉ số điện, nước khi bàn giao" ở bước 1
-- (bảng mốc, mặc định tích "bổ sung sau") và ô "Tiền điện (chốt số)" ở bước 2 (ghi
-- meter_readings mã TLY… và dòng điện của hoá đơn quyết toán). Người dùng nhập ở bước 2,
-- không gì chép sang bảng mốc ⇒ 13/14 mốc trả phòng báo "chưa đủ chỉ số" dù 9 hồ sơ đã có số.
--
-- 1. Mốc trả phòng còn MISSING mà mọi đồng hồ đang chạy đã có chỉ số chốt APPROVED của chính
--    hợp đồng, đúng ngày trả phòng ⇒ ghi thành VERIFIED bằng chính số đó (một bản sửa có lịch sử).
--    Gọi lúc tạo mốc (quyết toán ngay: chỉ số chốt ghi trước mốc trong cùng giao dịch) và khi hồ sơ
--    trả phòng chuyển FINALIZED (quyết toán sau, nhượng phòng). Chỉ ghi bảng mốc, không đụng tiền.
-- 2. Sửa mốc trả phòng chỉ thành REVIEW khi số mới khác số chốt đã tính tiền; xác nhận lại đúng
--    số đang ghi lúc REVIEW = đã đối soát (trước đây REVIEW không có đường ra).
-- 3. Khung chờ chỉ còn việc thật: đã quyết toán mà chưa có số chốt, hoặc REVIEW. Bỏ cọc không vào
--    khung (cọc cấn mọi khoản; số đầu khách sau do quản lý nhập). Hồ sơ còn chờ quyết toán đã nằm
--    ở tab "Chờ quyết toán", số chốt nhập lúc quyết toán.
-- 4. Đổ lại các mốc MISSING của hồ sơ đã quyết toán có chỉ số chốt; người ghi lịch sử là người
--    đã quyết toán hồ sơ đó.

CREATE OR REPLACE FUNCTION app_private.sync_move_out_boundary_from_final_reading_v1(p_set_id uuid)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE s public.contract_meter_boundary_sets%ROWTYPE; v_actor uuid:=auth.uid(); v_payload jsonb;
  v_meters bigint; v_covered bigint; v_day_end timestamptz;
BEGIN
  -- Lịch sử mốc bắt buộc có người ghi; không có phiên đăng nhập thì để nguyên.
  IF v_actor IS NULL THEN RETURN false; END IF;
  SELECT * INTO s FROM public.contract_meter_boundary_sets WHERE id=p_set_id FOR UPDATE;
  IF NOT FOUND OR s.kind<>'MOVE_OUT' OR s.state<>'MISSING' THEN RETURN false; END IF;
  -- Giờ đo không biết chính xác: lấy lúc ghi chỉ số chốt, không muộn hơn cuối ngày trả phòng.
  v_day_end:=LEAST(clock_timestamp(),((s.effective_on+1)::timestamp AT TIME ZONE app_private.org_timezone_v1(s.organization_id))-interval '1 second');
  WITH active AS (
    SELECT m.id FROM public.meters m
    WHERE m.organization_id=s.organization_id AND m.room_id=s.room_id AND m.building_id=s.building_id
      AND m.status='ACTIVE' AND m.deleted_at IS NULL
  ), final_readings AS (
    SELECT DISTINCT ON (r.meter_id) r.meter_id,r.current_reading,r.reading_code,r.created_at
    FROM public.meter_readings r JOIN active a ON a.id=r.meter_id
    WHERE r.contract_id=s.contract_id AND r.reading_date=s.effective_on AND r.status='APPROVED' AND r.deleted_at IS NULL
      AND r.current_reading IS NOT NULL AND r.current_reading>=0 AND r.current_reading<>'NaN'::numeric
    ORDER BY r.meter_id,r.created_at DESC,r.id DESC
  )
  SELECT (SELECT count(*) FROM active),count(f.meter_id),
    jsonb_build_object('state','VERIFIED','reason',NULL,'readings',COALESCE(jsonb_agg(jsonb_build_object(
      'meter_id',f.meter_id,'reading',f.current_reading,'measured_at',LEAST(f.created_at,v_day_end),
      'evidence','Chỉ số chốt khi quyết toán '||COALESCE(f.reading_code,'')) ORDER BY f.meter_id),'[]'::jsonb))
  INTO v_meters,v_covered,v_payload FROM final_readings f;
  IF v_meters=0 OR v_covered<>v_meters THEN RETURN false; END IF;
  INSERT INTO app_private.contract_meter_boundary_history(set_id,revision,actor_id,reason,idempotency_key,payload_hash,before_snapshot,requested_payload)
    VALUES(s.id,s.revision+1,v_actor,'Lấy từ chỉ số chốt khi quyết toán','final-reading-sync:'||s.id::text||':'||(s.revision+1)::text,
      md5(v_payload::text),app_private.meter_boundary_set_response_v1(s.id),v_payload);
  UPDATE public.contract_meter_boundary_sets SET revision=revision+1,state='VERIFIED',reason=NULL,updated_at=clock_timestamp() WHERE id=s.id;
  PERFORM app_private.insert_meter_boundary_revision_v1(s.id,v_payload);
  RETURN true;
END $fn$;

CREATE OR REPLACE FUNCTION app_private.sync_move_out_boundary_on_exit_finalized_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_set uuid;
BEGIN
  SELECT id INTO v_set FROM public.contract_meter_boundary_sets
    WHERE organization_id=NEW.organization_id AND contract_id=NEW.contract_id AND kind='MOVE_OUT';
  IF v_set IS NOT NULL THEN PERFORM app_private.sync_move_out_boundary_from_final_reading_v1(v_set); END IF;
  RETURN NULL;
END $fn$;
DROP TRIGGER IF EXISTS sync_move_out_boundary_on_finalize ON public.contract_exit_cases;
CREATE TRIGGER sync_move_out_boundary_on_finalize AFTER UPDATE OF state ON public.contract_exit_cases
  FOR EACH ROW WHEN (NEW.state='FINALIZED' AND OLD.state IS DISTINCT FROM 'FINALIZED')
  EXECUTE FUNCTION app_private.sync_move_out_boundary_on_exit_finalized_v1();

-- Như 20260928023413, thêm bước đồng bộ cho mốc trả phòng vừa tạo.
CREATE OR REPLACE FUNCTION app_private.record_contract_meter_boundary_set_v1(p_organization_id uuid,p_contract_id uuid,p_room_id uuid,p_kind text,p_effective_on date,p_payload jsonb,p_action text DEFAULT 'contracts.edit')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE c public.contracts%ROWTYPE;s public.contract_meter_boundary_sets%ROWTYPE;v_building uuid;v_hash text;
BEGIN
  IF auth.uid() IS NULL OR NOT COALESCE(p_organization_id=ANY(public.my_org_ids()),false) THEN RAISE EXCEPTION 'Wrong handover organization' USING ERRCODE='42501'; END IF;
  PERFORM app_private.lock_org_for_decision_v1(p_organization_id);
  SELECT * INTO c FROM public.contracts WHERE id=p_contract_id AND organization_id=p_organization_id AND deleted_at IS NULL FOR UPDATE;
  SELECT building_id INTO v_building FROM public.rooms WHERE id=p_room_id AND organization_id=p_organization_id;
  IF c.id IS NULL OR c.room_id IS DISTINCT FROM p_room_id OR v_building IS NULL OR NOT EXISTS(SELECT 1 FROM public.buildings WHERE id=v_building AND organization_id=p_organization_id) THEN
    RAISE EXCEPTION 'Handover subject scope mismatch' USING ERRCODE='42501'; END IF;
  PERFORM app_private.assert_meter_boundary_writer_v1(p_organization_id,v_building,p_action);
  -- This private helper is only invoked with the contract returned by the
  -- signing transaction. xmin differs from the parent xid after a savepoint.
  IF p_action='contracts.create' AND (p_kind IS DISTINCT FROM 'MOVE_IN' OR c.created_at<transaction_timestamp()) THEN
    RAISE EXCEPTION 'Create authority can only record the incoming contract just created in this transaction' USING ERRCODE='42501'; END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('MOVE_IN','MOVE_OUT') OR p_effective_on IS NULL OR p_effective_on>public.org_today_v1(p_organization_id)
    OR (p_kind='MOVE_OUT' AND (c.status<>'TERMINATED' OR c.actual_end_date IS DISTINCT FROM p_effective_on))
    OR (p_kind='MOVE_IN' AND (c.status NOT IN ('ACTIVE','EXTENDED') OR c.actual_end_date IS NOT NULL OR c.start_date IS DISTINCT FROM p_effective_on)) THEN
    RAISE EXCEPTION 'Boundary must match the actual handover' USING ERRCODE='55000'; END IF;
  v_hash:=md5(p_payload::text);
  SELECT * INTO s FROM public.contract_meter_boundary_sets WHERE organization_id=p_organization_id AND contract_id=p_contract_id AND kind=p_kind FOR UPDATE;
  IF FOUND THEN
    IF s.room_id IS DISTINCT FROM p_room_id OR s.effective_on IS DISTINCT FROM p_effective_on OR s.initial_payload_hash IS DISTINCT FROM v_hash THEN
      RAISE EXCEPTION 'Handover meter intent already recorded differently' USING ERRCODE='23505'; END IF;
    RETURN app_private.meter_boundary_set_response_v1(s.id);
  END IF;
  PERFORM app_private.validate_meter_boundary_payload_v1(p_organization_id,p_room_id,v_building,p_payload);
  IF p_kind='MOVE_IN' AND p_payload->>'state'<>'VERIFIED' THEN RAISE EXCEPTION 'Incoming handover needs its own verified readings' USING ERRCODE='55000'; END IF;
  INSERT INTO public.contract_meter_boundary_sets(organization_id,building_id,room_id,contract_id,kind,effective_on,state,reason,recorded_by,initial_payload_hash)
    VALUES(p_organization_id,v_building,p_room_id,p_contract_id,p_kind,p_effective_on,p_payload->>'state',p_payload->>'reason',auth.uid(),v_hash) RETURNING * INTO s;
  PERFORM app_private.insert_meter_boundary_revision_v1(s.id,p_payload);
  -- Quyết toán ngay: chỉ số chốt đã ghi trước mốc trong cùng giao dịch.
  IF p_kind='MOVE_OUT' AND s.state='MISSING' THEN PERFORM app_private.sync_move_out_boundary_from_final_reading_v1(s.id); END IF;
  RETURN app_private.meter_boundary_set_response_v1(s.id);
END $fn$;

-- Như 20260928023413, đổi cách tính REVIEW: mốc trả phòng chỉ lệch tiền khi khác số chốt đã tính
-- trên hoá đơn quyết toán; xác nhận lại đúng số đang ghi lúc REVIEW là đã đối soát.
CREATE OR REPLACE FUNCTION public.revise_contract_meter_boundary_set_v1(p_organization_id uuid,p_set_id uuid,p_expected_revision bigint,p_idempotency_key text,p_reason text,p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE s public.contract_meter_boundary_sets%ROWTYPE;h app_private.contract_meter_boundary_history%ROWTYPE;v_hash text;v_ids uuid[];v_state text;
  v_reconfirm boolean:=false;v_conflict boolean:=false;
BEGIN
  IF auth.uid() IS NULL OR NOT COALESCE(p_organization_id=ANY(public.my_org_ids()),false) THEN RAISE EXCEPTION 'Wrong handover organization' USING ERRCODE='42501'; END IF;
  IF NULLIF(btrim(p_reason),'') IS NULL OR p_idempotency_key IS NULL OR p_idempotency_key!~'^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' THEN RAISE EXCEPTION 'Correction needs a reason and request key' USING ERRCODE='22023'; END IF;
  PERFORM app_private.lock_org_for_decision_v1(p_organization_id);
  SELECT * INTO s FROM public.contract_meter_boundary_sets WHERE id=p_set_id AND organization_id=p_organization_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Meter boundary not found' USING ERRCODE='42501'; END IF;
  PERFORM app_private.assert_meter_boundary_writer_v1(s.organization_id,s.building_id);
  v_hash:=md5(jsonb_build_object('set_id',s.id,'expected_revision',p_expected_revision,'reason',btrim(p_reason),'payload',p_payload)::text);
  SELECT * INTO h FROM app_private.contract_meter_boundary_history WHERE set_id=s.id AND actor_id=auth.uid() AND idempotency_key=p_idempotency_key;
  IF FOUND THEN
    IF h.payload_hash<>v_hash THEN RAISE EXCEPTION 'Correction key reused with different facts' USING ERRCODE='23505'; END IF;
    RETURN app_private.meter_boundary_set_response_v1(s.id);
  END IF;
  IF p_expected_revision IS NULL OR s.revision<>p_expected_revision THEN RAISE EXCEPTION 'Meter boundary changed; reload' USING ERRCODE='PT409'; END IF;
  PERFORM app_private.validate_meter_boundary_payload_v1(s.organization_id,s.room_id,s.building_id,p_payload);
  IF s.state='REVIEW' AND p_payload->>'state'='VERIFIED' THEN
    SELECT count(*)=jsonb_array_length(p_payload->'readings') AND bool_and(EXISTS(SELECT 1 FROM jsonb_array_elements(p_payload->'readings') x
        WHERE (x->>'meter_id')::uuid=b.meter_id AND (x->>'reading')::numeric=b.reading))
      INTO v_reconfirm FROM public.contract_meter_boundaries b WHERE b.set_id=s.id AND b.revision=s.revision;
    v_reconfirm:=COALESCE(v_reconfirm,false);
  END IF;
  IF s.kind='MOVE_OUT' THEN
    SELECT EXISTS(SELECT 1 FROM jsonb_array_elements(p_payload->'readings') x
      JOIN LATERAL (SELECT r.current_reading FROM public.meter_readings r
        WHERE r.meter_id=(x->>'meter_id')::uuid AND r.contract_id=s.contract_id AND r.reading_date=s.effective_on
          AND r.status='APPROVED' AND r.deleted_at IS NULL AND r.current_reading IS NOT NULL
        ORDER BY r.created_at DESC,r.id DESC LIMIT 1) billed ON true
      WHERE billed.current_reading<>(x->>'reading')::numeric) INTO v_conflict;
  END IF;
  IF v_reconfirm OR (s.kind='MOVE_OUT' AND NOT v_conflict) THEN
    v_ids:=ARRAY[]::uuid[];
    v_state:=p_payload->>'state';
  ELSE
    SELECT COALESCE(array_agg(DISTINCT x.id ORDER BY x.id),ARRAY[]::uuid[]) INTO v_ids FROM (
      SELECT id FROM public.invoices WHERE organization_id=s.organization_id AND contract_id=s.contract_id AND deleted_at IS NULL AND billing_month>=to_char(s.effective_on,'YYYY-MM')
        AND (approved_at IS NOT NULL OR status::text IN ('APPROVED','OVERDUE','PARTIAL_PAID','PAID','ISSUED'))
      UNION SELECT unnest(s.affected_invoice_ids)) x;
    v_state:=CASE WHEN cardinality(v_ids)>0 OR s.state='REVIEW' THEN 'REVIEW' ELSE p_payload->>'state' END;
  END IF;
  INSERT INTO app_private.contract_meter_boundary_history(set_id,revision,actor_id,reason,idempotency_key,payload_hash,before_snapshot,requested_payload)
    VALUES(s.id,s.revision+1,auth.uid(),btrim(p_reason),p_idempotency_key,v_hash,app_private.meter_boundary_set_response_v1(s.id),p_payload);
  UPDATE public.contract_meter_boundary_sets SET revision=revision+1,state=v_state,reason=CASE WHEN v_state='VERIFIED' THEN NULL ELSE btrim(p_reason) END,
    affected_invoice_ids=v_ids,updated_at=clock_timestamp() WHERE id=s.id;
  PERFORM app_private.insert_meter_boundary_revision_v1(s.id,p_payload);
  RETURN app_private.meter_boundary_set_response_v1(s.id);
END $fn$;

-- Như 20260928035400, chỉ giữ việc thật và trả thêm trạng thái/loại thanh lý để hiển thị.
CREATE OR REPLACE FUNCTION public.list_contract_meter_followups_v1(
  p_organization_id uuid,p_building_ids uuid[] DEFAULT NULL,p_limit integer DEFAULT 10,p_offset integer DEFAULT 0
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE result jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT COALESCE(p_organization_id=ANY(public.my_org_ids()),false) THEN
    RAISE EXCEPTION 'Không có quyền tổ chức' USING ERRCODE='42501';
  END IF;
  IF p_limit IS NULL OR p_limit<1 OR p_limit>100 OR p_offset IS NULL OR p_offset<0 THEN
    RAISE EXCEPTION 'Phân trang không hợp lệ' USING ERRCODE='22023';
  END IF;
  WITH eligible AS MATERIALIZED (
    SELECT s.id,s.contract_id,c.contract_number,b.name building_name,r.name room_name,s.effective_on,s.state,
      e.state exit_state,e.current_kind exit_kind
    FROM public.contract_meter_boundary_sets s
    JOIN public.contracts c ON c.id=s.contract_id AND c.organization_id=s.organization_id AND c.deleted_at IS NULL
    JOIN public.rooms r ON r.id=s.room_id AND r.organization_id=s.organization_id AND r.deleted_at IS NULL
    JOIN public.buildings b ON b.id=s.building_id AND b.organization_id=s.organization_id AND b.deleted_at IS NULL
    LEFT JOIN public.contract_exit_cases e ON e.contract_id=s.contract_id AND e.organization_id=s.organization_id
    WHERE s.organization_id=p_organization_id AND s.kind='MOVE_OUT'
      AND COALESCE(e.current_kind,'')<>'FORFEIT'
      AND (s.state='REVIEW' OR (s.state='MISSING' AND e.state='FINALIZED'))
      AND (COALESCE(cardinality(p_building_ids),0)=0 OR s.building_id=ANY(p_building_ids))
      AND public.can_access_building(s.building_id)
      AND NOT COALESCE(public.is_super_admin() AND s.organization_id=ANY(public.sandbox_org_ids()),false)
      AND EXISTS(SELECT 1 FROM app_private.authorized_scope_v3('contracts.view',p_organization_id) a
        WHERE a.org_wide OR s.building_id=ANY(a.building_ids))
  ), page AS (SELECT * FROM eligible ORDER BY effective_on,id LIMIT p_limit OFFSET p_offset)
  SELECT jsonb_build_object('items',COALESCE((SELECT jsonb_agg(to_jsonb(page) ORDER BY effective_on,id) FROM page),'[]'::jsonb),
    'total',(SELECT count(*) FROM eligible),'limit',p_limit,'offset',p_offset) INTO result;
  RETURN result;
END $fn$;

-- Đổ lại: hồ sơ đã quyết toán mà mốc còn MISSING dù đã có chỉ số chốt. Chạy lại không đổi gì
-- (mốc đã VERIFIED thì hàm đồng bộ bỏ qua).
DO $backfill$
DECLARE r record; v_claim_sub text:=current_setting('request.jwt.claim.sub',true); v_claims text:=current_setting('request.jwt.claims',true);
BEGIN
  FOR r IN SELECT s.id,COALESCE(e.settlement_actor,s.recorded_by) actor
    FROM public.contract_meter_boundary_sets s
    JOIN public.contract_exit_cases e ON e.contract_id=s.contract_id AND e.organization_id=s.organization_id
    WHERE s.kind='MOVE_OUT' AND s.state='MISSING' AND e.state='FINALIZED'
    ORDER BY s.effective_on,s.id
  LOOP
    PERFORM set_config('request.jwt.claim.sub',r.actor::text,true);
    PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',r.actor,'role','authenticated')::text,true);
    PERFORM app_private.sync_move_out_boundary_from_final_reading_v1(r.id);
  END LOOP;
  PERFORM set_config('request.jwt.claim.sub',COALESCE(v_claim_sub,''),true);
  PERFORM set_config('request.jwt.claims',COALESCE(v_claims,''),true);
END $backfill$;

REVOKE ALL ON FUNCTION app_private.sync_move_out_boundary_from_final_reading_v1(uuid),app_private.sync_move_out_boundary_on_exit_finalized_v1(),
  app_private.record_contract_meter_boundary_set_v1(uuid,uuid,uuid,text,date,jsonb,text)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.revise_contract_meter_boundary_set_v1(uuid,uuid,bigint,text,text,jsonb) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.revise_contract_meter_boundary_set_v1(uuid,uuid,bigint,text,text,jsonb) TO authenticated;
REVOKE ALL ON FUNCTION public.list_contract_meter_followups_v1(uuid,uuid[],integer,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.list_contract_meter_followups_v1(uuid,uuid[],integer,integer) TO authenticated;
NOTIFY pgrst,'reload schema';
