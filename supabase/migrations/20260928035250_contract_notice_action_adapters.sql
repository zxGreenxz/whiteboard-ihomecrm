-- Narrow P2 notice decision adapters. Current renewal/transfer RPCs retain all operational and financial behavior.
CREATE TABLE IF NOT EXISTS public.contract_notice_transition_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL REFERENCES public.organizations(id),
  contract_id uuid NOT NULL REFERENCES public.contracts(id),building_id uuid NOT NULL REFERENCES public.buildings(id),
  previous_room_id uuid REFERENCES public.rooms(id),result_contract_id uuid NOT NULL REFERENCES public.contracts(id),
  operation text NOT NULL CHECK(operation IN ('RENEW','TRANSFER_ROOM')),notice_choice text NOT NULL CHECK(notice_choice IN ('KEEP','CANCEL')),
  previous_notice_date date,expected_updated_at timestamptz NOT NULL,reason text NOT NULL,actor_id uuid NOT NULL,
  request_id uuid NOT NULL UNIQUE,intent_hash text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK(operation<>'TRANSFER_ROOM' OR notice_choice='CANCEL')
);
ALTER TABLE public.contract_notice_transition_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS contract_notice_transition_events_read ON public.contract_notice_transition_events;
CREATE POLICY contract_notice_transition_events_read ON public.contract_notice_transition_events FOR SELECT TO authenticated USING(
  organization_id=ANY(public.my_org_ids()) AND public.can_access_building(building_id)
  AND EXISTS(SELECT 1 FROM app_private.authorized_scope_v3('contracts.view',organization_id) s WHERE s.org_wide OR building_id=ANY(s.building_ids)));
DROP POLICY IF EXISTS contract_notice_transition_events_hide_sandbox_admin ON public.contract_notice_transition_events;
CREATE POLICY contract_notice_transition_events_hide_sandbox_admin ON public.contract_notice_transition_events AS RESTRICTIVE FOR ALL TO authenticated
  USING(NOT COALESCE(organization_id=ANY(public.sandbox_org_ids()),false) OR COALESCE(organization_id=ANY(public.my_org_ids()),false))
  WITH CHECK(NOT COALESCE(organization_id=ANY(public.sandbox_org_ids()),false) OR COALESCE(organization_id=ANY(public.my_org_ids()),false));
REVOKE ALL ON public.contract_notice_transition_events FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.contract_notice_transition_events TO authenticated;

CREATE OR REPLACE FUNCTION app_private.apply_contract_notice_transition_v1(p_org uuid,p_contract uuid,p_expected_at timestamptz,p_operation text,
  p_choice text,p_request uuid,p_reason text,p_core_args jsonb)
RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE c public.contracts%ROWTYPE;h public.contract_notice_transition_events%ROWTYPE;v_building uuid;v_old_room uuid;v_new_room uuid;
  v_hash text;v_result uuid;v_allowed boolean;v_reason text;v_prior date;v_result_date date;
BEGIN
  IF auth.uid() IS NULL OR NOT COALESCE(p_org=ANY(public.my_org_ids()),false) THEN RAISE EXCEPTION 'Không có quyền tổ chức' USING ERRCODE='42501'; END IF;
  IF p_operation IS NULL OR p_operation NOT IN ('RENEW','TRANSFER_ROOM') OR p_choice IS NULL OR p_choice NOT IN ('KEEP','CANCEL')
    OR (p_operation='TRANSFER_ROOM' AND p_choice<>'CANCEL') OR p_request IS NULL OR length(p_reason)>2000 THEN RAISE EXCEPTION 'Cần chọn giữ hoặc hủy báo dọn và mã yêu cầu hợp lệ' USING ERRCODE='22023'; END IF;
  PERFORM app_private.lock_org_for_decision_v1(p_org);
  IF p_operation='TRANSFER_ROOM' THEN
    SELECT room_id INTO v_old_room FROM public.contracts WHERE id=p_contract AND organization_id=p_org AND deleted_at IS NULL;
    v_new_room:=(p_core_args->>'new_room_id')::uuid;
    -- Follow the existing room-transfer lock order; never hold a contract row before its room locks.
    IF v_old_room IS NOT NULL AND v_new_room IS NOT NULL THEN
      PERFORM pg_advisory_xact_lock(hashtextextended('room:'||LEAST(v_old_room,v_new_room)::text,0));
      IF v_old_room<>v_new_room THEN PERFORM pg_advisory_xact_lock(hashtextextended('room:'||GREATEST(v_old_room,v_new_room)::text,0)); END IF;
    END IF;
  END IF;
  SELECT * INTO c FROM public.contracts WHERE id=p_contract AND organization_id=p_org AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Không tìm thấy hợp đồng trong tổ chức này' USING ERRCODE='42501'; END IF;
  SELECT building_id INTO v_building FROM public.rooms WHERE id=c.room_id AND organization_id=p_org;
  SELECT allowed INTO v_allowed FROM app_private.authorize_tenant_action_v3(auth.uid(),p_org,'contracts.edit',v_building,NULL);
  IF v_building IS NULL OR NOT COALESCE(public.can_access_building(v_building),false) OR NOT COALESCE(public.can_do_on_building('contracts','edit',v_building),false)
    OR NOT COALESCE(v_allowed,false) THEN RAISE EXCEPTION 'Không có quyền thao tác hợp đồng tại tòa nhà này' USING ERRCODE='42501'; END IF;
  v_reason:=COALESCE(NULLIF(btrim(p_reason),''),CASE WHEN p_operation='RENEW' THEN CASE WHEN p_choice='KEEP' THEN 'Giữ báo dọn khi gia hạn hợp đồng' ELSE 'Hủy báo dọn khi gia hạn hợp đồng' END ELSE 'Hủy báo dọn phòng cũ khi chuyển phòng' END);
  v_hash:=md5(jsonb_build_object('contract',p_contract,'expected_at',p_expected_at,'operation',p_operation,'choice',p_choice,'reason',v_reason,'args',p_core_args)::text);
  SELECT * INTO h FROM public.contract_notice_transition_events WHERE request_id=p_request;
  IF FOUND THEN
    IF h.organization_id<>p_org OR h.contract_id<>p_contract OR h.actor_id<>auth.uid() OR h.intent_hash<>v_hash THEN RAISE EXCEPTION 'Mã yêu cầu đã dùng cho dữ kiện khác' USING ERRCODE='23505'; END IF;
    RETURN h.result_contract_id;
  END IF;
  IF p_expected_at IS NULL OR c.updated_at IS DISTINCT FROM p_expected_at OR (p_operation='TRANSFER_ROOM' AND c.room_id IS DISTINCT FROM v_old_room) THEN RAISE EXCEPTION 'Hợp đồng đã thay đổi; vui lòng tải lại trước khi tiếp tục' USING ERRCODE='PT409'; END IF;
  v_prior:=c.expected_move_out_date;
  IF p_choice='CANCEL' AND v_prior IS NOT NULL THEN
    UPDATE public.contracts SET expected_move_out_date=NULL,updated_at=clock_timestamp() WHERE id=c.id RETURNING * INTO c;
    INSERT INTO public.contract_move_out_notice_events(organization_id,contract_id,actor_id,previous_date,new_date,reason,contract_updated_at)
      VALUES(p_org,c.id,auth.uid(),v_prior,NULL,v_reason,c.updated_at);
  END IF;
  -- Exact current APIs and inputs. No replacement renew/transfer or financial logic.
  IF p_operation='RENEW' THEN
    v_result:=public.renew_contract(c.id,(p_core_args->>'new_end_date')::date,(p_core_args->>'new_rent_price')::numeric,(p_core_args->>'new_deposit')::numeric,p_core_args->>'notes');
  ELSE
    v_result:=public.transfer_room(c.id,(p_core_args->>'new_room_id')::uuid,(p_core_args->>'new_rent_price')::numeric,(p_core_args->>'transfer_date')::date,p_core_args->>'notes');
  END IF;
  SELECT expected_move_out_date INTO v_result_date FROM public.contracts WHERE id=v_result AND organization_id=p_org;
  IF NOT FOUND OR v_result_date IS DISTINCT FROM (CASE WHEN p_choice='KEEP' THEN v_prior ELSE NULL END) THEN RAISE EXCEPTION 'Báo dọn sau thao tác không đúng lựa chọn; thay đổi đã được hoàn tác' USING ERRCODE='55000'; END IF;
  INSERT INTO public.contract_notice_transition_events(organization_id,contract_id,building_id,previous_room_id,result_contract_id,operation,notice_choice,
    previous_notice_date,expected_updated_at,reason,actor_id,request_id,intent_hash)
  VALUES(p_org,c.id,v_building,c.room_id,v_result,p_operation,p_choice,v_prior,p_expected_at,v_reason,auth.uid(),p_request,v_hash);
  RETURN v_result;
END $fn$;
REVOKE ALL ON FUNCTION app_private.apply_contract_notice_transition_v1(uuid,uuid,timestamptz,text,text,uuid,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.renew_contract_with_notice_v1(p_organization_id uuid,p_contract_id uuid,p_expected_updated_at timestamptz,p_new_end_date date,
  p_notice_choice text,p_request_id uuid,p_new_rent_price numeric DEFAULT NULL,p_new_deposit numeric DEFAULT NULL,p_notes text DEFAULT NULL,p_notice_reason text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
BEGIN
  IF auth.uid() IS NULL OR NOT COALESCE(p_organization_id=ANY(public.my_org_ids()),false) THEN RAISE EXCEPTION 'Không có quyền tổ chức' USING ERRCODE='42501'; END IF;
  RETURN app_private.apply_contract_notice_transition_v1(p_organization_id,p_contract_id,p_expected_updated_at,'RENEW',p_notice_choice,p_request_id,p_notice_reason,
    jsonb_build_object('new_end_date',p_new_end_date,'new_rent_price',p_new_rent_price,'new_deposit',p_new_deposit,'notes',p_notes));
END $fn$;
CREATE OR REPLACE FUNCTION public.transfer_room_with_notice_v1(p_organization_id uuid,p_contract_id uuid,p_expected_updated_at timestamptz,p_new_room_id uuid,
  p_transfer_date date,p_request_id uuid,p_new_rent_price numeric DEFAULT NULL,p_notes text DEFAULT NULL,p_notice_reason text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
BEGIN
  IF auth.uid() IS NULL OR NOT COALESCE(p_organization_id=ANY(public.my_org_ids()),false) THEN RAISE EXCEPTION 'Không có quyền tổ chức' USING ERRCODE='42501'; END IF;
  RETURN app_private.apply_contract_notice_transition_v1(p_organization_id,p_contract_id,p_expected_updated_at,'TRANSFER_ROOM','CANCEL',p_request_id,p_notice_reason,
    jsonb_build_object('new_room_id',p_new_room_id,'new_rent_price',p_new_rent_price,'transfer_date',p_transfer_date,'notes',p_notes));
END $fn$;
REVOKE ALL ON FUNCTION public.renew_contract_with_notice_v1(uuid,uuid,timestamptz,date,text,uuid,numeric,numeric,text,text),public.transfer_room_with_notice_v1(uuid,uuid,timestamptz,uuid,date,uuid,numeric,text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.renew_contract_with_notice_v1(uuid,uuid,timestamptz,date,text,uuid,numeric,numeric,text,text),public.transfer_room_with_notice_v1(uuid,uuid,timestamptz,uuid,date,uuid,numeric,text,text) TO authenticated;
