-- Ghi nhận nội dung trả phòng trên hồ sơ, gồm cả quyết toán sau và bỏ cọc.
-- Hồ sơ cũ giữ NULL; ghi chú mới là sự kiện bàn giao bất biến, không phải lý do đổi loại.
-- Không đổi luồng tính tiền, finalizer hay các kiểm tra quyền/khóa hiện hành.
ALTER TABLE public.contract_exit_cases ADD COLUMN IF NOT EXISTS return_note text;
COMMENT ON COLUMN public.contract_exit_cases.return_note IS
  'Nội dung thanh lý lúc xác nhận trả phòng; bất biến, NULL với hồ sơ trước khi có trường này.';

CREATE OR REPLACE FUNCTION app_private.contract_exit_case_response_v1(p_case uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
  SELECT jsonb_build_object('id',c.id,'organization_id',c.organization_id,'building_id',c.building_id,
    'contract_id',c.contract_id,'room_at_handover_id',c.room_at_handover_id,'actual_move_out_on',c.actual_move_out_on,
    'initial_kind',c.initial_kind,'current_kind',c.current_kind,'settlement_mode',c.settlement_mode,'state',c.state,
    'version',c.version,'created_at',c.created_at,'updated_at',c.updated_at,'contract_number',c.contract_number,
    'building_name',c.building_name,'room_name',c.room_name,'customer_name',c.customer_name,'return_note',c.return_note,
    'settlement_result',CASE WHEN public.can_do_on_building('contracts','edit',c.building_id) THEN c.settlement_result ELSE NULL END,
    'kind_history',COALESCE((SELECT jsonb_agg(jsonb_build_object('before_kind',h.before_kind,'after_kind',h.after_kind,
      'reason',h.reason,'version',h.version,'changed_at',h.changed_at,'changed_by',h.actor_id,
      'actor_name',(SELECT p.full_name FROM public.profiles p WHERE p.id=h.actor_id)) ORDER BY h.version) FROM app_private.contract_exit_kind_history h WHERE h.case_id=c.id),'[]'::jsonb))
  FROM public.contract_exit_cases c WHERE c.id=p_case
$fn$;

-- Không giữ hai overload defaulted vì PostgREST không chọn được chữ ký.
-- Client cũ thiếu tham số vẫn resolve chữ ký mới rồi nhận lỗi 22023 rõ ràng.
DROP FUNCTION IF EXISTS public.confirm_contract_return_v1(uuid,uuid,timestamptz,text,date,text,text,jsonb,jsonb);
CREATE OR REPLACE FUNCTION public.confirm_contract_return_v1(p_organization_id uuid,p_contract_id uuid,p_expected_contract_updated_at timestamptz,p_idempotency_key text,
  p_actual_move_out_on date,p_initial_kind text,p_settlement_mode text,p_settlement jsonb DEFAULT NULL,p_meter_boundary jsonb DEFAULT NULL,p_return_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE c public.contracts%ROWTYPE; v_room public.rooms%ROWTYPE; v_building public.buildings%ROWTYPE;
  e public.contract_exit_cases%ROWTYPE; v_key text:=btrim(p_idempotency_key); v_hash text; v_result jsonb; v_legacy uuid; v_party jsonb; v_customer text;
  v_return_note text:=NULLIF(btrim(p_return_note,E' \t\n\r\f'||chr(11)),'');
BEGIN
  IF v_return_note IS NULL THEN
    RAISE EXCEPTION 'Vui lòng nhập nội dung thanh lý để đối chiếu sau này' USING ERRCODE='22023';
  END IF;
  IF p_actual_move_out_on IS NULL OR p_initial_kind IS NULL OR p_initial_kind NOT IN ('NATURAL_EXPIRY','EARLY_RETURN','FORFEIT')
    OR p_settlement_mode IS NULL OR p_settlement_mode NOT IN ('DEFERRED','IMMEDIATE') OR v_key IS NULL
    OR v_key!~'^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' THEN RAISE EXCEPTION 'Actual date, initial kind, mode and request key are required' USING ERRCODE='22023'; END IF;
  IF (p_settlement_mode='DEFERRED' AND p_settlement IS NOT NULL) OR (p_settlement_mode='IMMEDIATE' AND jsonb_typeof(p_settlement) IS DISTINCT FROM 'object') THEN
    RAISE EXCEPTION 'Settlement payload does not match return mode' USING ERRCODE='22023';
  END IF;
  IF auth.uid() IS NULL OR NOT COALESCE(p_organization_id=ANY(public.my_org_ids()),false) THEN RAISE EXCEPTION 'Organization is outside the writable scope' USING ERRCODE='42501'; END IF;
  PERFORM app_private.lock_org_for_decision_v1(p_organization_id);
  SELECT * INTO c FROM public.contracts WHERE id=p_contract_id AND organization_id=p_organization_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Contract not found' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_room FROM public.rooms WHERE id=c.room_id;
  SELECT * INTO v_building FROM public.buildings WHERE id=v_room.building_id;
  IF v_room.organization_id IS DISTINCT FROM c.organization_id OR v_building.organization_id IS DISTINCT FROM c.organization_id THEN
    RAISE EXCEPTION 'Contract room scope mismatch' USING ERRCODE='42501'; END IF;
  PERFORM app_private.assert_contract_exit_writer_v1(c.organization_id,v_room.building_id);
  v_hash:=md5(jsonb_build_object('contract_id',p_contract_id,'expected_updated_at',p_expected_contract_updated_at,'actual_date',p_actual_move_out_on,
    'initial_kind',p_initial_kind,'mode',p_settlement_mode,'settlement',p_settlement,'meter_boundary',p_meter_boundary,'return_note',v_return_note)::text);
  SELECT * INTO e FROM public.contract_exit_cases WHERE contract_id=p_contract_id FOR UPDATE;
  IF FOUND THEN
    IF e.physical_actor=auth.uid() AND e.physical_idempotency_key=v_key THEN
      IF e.physical_payload_hash<>v_hash THEN RAISE EXCEPTION 'Request key reused with different return intent' USING ERRCODE='23505'; END IF;
      RETURN app_private.contract_exit_case_response_v1(e.id);
    END IF;
    RAISE EXCEPTION 'Contract has already been physically returned' USING ERRCODE='PT409';
  END IF;
  IF p_expected_contract_updated_at IS NULL OR c.updated_at IS DISTINCT FROM p_expected_contract_updated_at THEN
    RAISE EXCEPTION 'Contract changed; reload before returning' USING ERRCODE='PT409'; END IF;
  IF p_actual_move_out_on>public.org_today_v1(p_organization_id) THEN
    RAISE EXCEPTION 'Actual return date cannot be in the future; use a planned notice' USING ERRCODE='22023'; END IF;
  IF c.status NOT IN ('ACTIVE','EXTENDED') OR c.room_id IS NULL OR c.actual_end_date IS NOT NULL OR p_actual_move_out_on<c.start_date
    OR EXISTS(SELECT 1 FROM public.contract_terminations t WHERE t.contract_id=c.id) THEN
    RAISE EXCEPTION 'Contract is not eligible for an actual return' USING ERRCODE='55000'; END IF;
  IF EXISTS(SELECT 1 FROM public.contract_customers cc JOIN public.customers cu ON cu.id=cc.customer_id
    WHERE cc.contract_id=c.id AND cu.organization_id IS DISTINCT FROM c.organization_id) THEN
    RAISE EXCEPTION 'Party scope mismatch' USING ERRCODE='42501'; END IF;
  SELECT jsonb_build_object('tenant_id',c.tenant_id,'parent_contract_id',c.parent_contract_id,
    'customers',COALESCE((SELECT jsonb_agg(jsonb_build_object('customer_id',cc.customer_id,'is_representative',cc.is_representative) ORDER BY cc.customer_id)
      FROM public.contract_customers cc WHERE cc.contract_id=c.id),'[]'::jsonb),
    'tenants',COALESCE((SELECT jsonb_agg(ct.tenant_id ORDER BY ct.tenant_id) FROM public.contract_tenants ct WHERE ct.contract_id=c.id),'[]'::jsonb)) INTO v_party;
  SELECT cu.full_name INTO v_customer FROM public.contract_customers cc JOIN public.customers cu ON cu.id=cc.customer_id
    WHERE cc.contract_id=c.id ORDER BY cc.is_representative DESC,cc.customer_id LIMIT 1;
  INSERT INTO public.contract_exit_cases(organization_id,building_id,contract_id,room_at_handover_id,actual_move_out_on,initial_kind,current_kind,
    settlement_mode,party_snapshot,physical_actor,physical_idempotency_key,physical_payload_hash,contract_number,building_name,room_name,customer_name,return_note)
    VALUES(c.organization_id,v_room.building_id,c.id,c.room_id,p_actual_move_out_on,p_initial_kind,p_initial_kind,
      p_settlement_mode,v_party,auth.uid(),v_key,v_hash,c.contract_number,v_building.name,v_room.name,v_customer,v_return_note) RETURNING * INTO e;
  -- Pass listings belong to the departing occupancy. A retry exits above, so it
  -- cannot retire a listing created for the next tenant after this handover.
  UPDATE public.room_pass_listings SET active=false,updated_at=clock_timestamp()
    WHERE room_id=c.room_id AND active
      AND (organization_id=c.organization_id OR (organization_id IS NULL AND user_id=c.user_id));
  IF p_settlement_mode='DEFERRED' THEN
    -- Absolutely no call to a financial/termination writer in this branch.
    UPDATE public.contracts SET status='TERMINATED',actual_end_date=p_actual_move_out_on,updated_at=clock_timestamp() WHERE id=c.id;
  ELSE
    v_result:=app_private.run_contract_exit_settlement_v1(e.id,p_initial_kind,p_settlement,v_key,false);
    SELECT id INTO v_legacy FROM public.contract_terminations WHERE contract_id=c.id AND actual_move_out_date=p_actual_move_out_on AND status='COMPLETED';
    IF v_legacy IS NULL THEN RAISE EXCEPTION 'Settlement did not record its financial audit' USING ERRCODE='55000'; END IF;
    UPDATE public.contract_exit_cases SET state='FINALIZED',version=version+1,updated_at=clock_timestamp(),finalized_at=clock_timestamp(),
      settlement_actor=auth.uid(),settlement_idempotency_key=v_key,settlement_payload_hash=v_hash,settlement_result=v_result,legacy_termination_id=v_legacy WHERE id=e.id;
  END IF;
  PERFORM app_private.record_contract_meter_boundary_set_v1(c.organization_id,c.id,c.room_id,'MOVE_OUT',p_actual_move_out_on,
    COALESCE(p_meter_boundary,jsonb_build_object('state','MISSING','reason','Chưa ghi chỉ số khi trả phòng','readings','[]'::jsonb)));
  RETURN app_private.contract_exit_case_response_v1(e.id);
END $fn$;

REVOKE ALL ON FUNCTION app_private.contract_exit_case_response_v1(uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.confirm_contract_return_v1(uuid,uuid,timestamptz,text,date,text,text,jsonb,jsonb,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.confirm_contract_return_v1(uuid,uuid,timestamptz,text,date,text,text,jsonb,jsonb,text) TO authenticated;
NOTIFY pgrst, 'reload schema';
