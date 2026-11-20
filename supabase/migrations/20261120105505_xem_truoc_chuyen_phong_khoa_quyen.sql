-- PostgREST mở giao dịch cho phép khóa dòng khi gọi RPC xem trước bằng POST.
-- Khóa tổ chức trước khi đọc quyền để lấy quyết định mới nhất sau khi chờ.
BEGIN;

CREATE OR REPLACE FUNCTION public.preview_room_transfer_v1(
  p_org uuid,p_contract_id uuid,p_new_room_id uuid,p_transfer_date date,
  p_new_rent_price numeric DEFAULT NULL,p_new_deposit numeric DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE source_building uuid; destination_building uuid; quote jsonb; allowed boolean;
BEGIN
  IF auth.uid() IS NULL OR NOT coalesce(p_org=ANY(public.my_org_ids()),false) THEN
    RAISE EXCEPTION 'Không có quyền xem chuyển phòng tại tổ chức này' USING ERRCODE='42501';
  END IF;
  PERFORM app_private.lock_org_for_decision_v1(p_org);
  SELECT r.building_id INTO source_building FROM public.contracts c JOIN public.rooms r
    ON r.id=c.room_id AND r.organization_id=c.organization_id
    WHERE c.id=p_contract_id AND c.organization_id=p_org AND c.deleted_at IS NULL;
  SELECT a.allowed INTO allowed FROM app_private.authorize_tenant_action_v3(auth.uid(),p_org,'contracts.edit',source_building,NULL) a;
  IF source_building IS NULL OR NOT coalesce(allowed,false) OR NOT coalesce(public.can_access_building(source_building),false)
     OR NOT coalesce(public.can_do_on_building('contracts','edit',source_building),false) THEN
    RAISE EXCEPTION 'Không có quyền thao tác hợp đồng tại tòa nhà này' USING ERRCODE='42501';
  END IF;
  PERFORM app_private.require_building_perm_v1(source_building,'chuyển phòng','contracts.transfer');
  SELECT building_id INTO destination_building FROM public.rooms
    WHERE id=p_new_room_id AND organization_id=p_org AND deleted_at IS NULL;
  IF destination_building IS NULL THEN RAISE EXCEPTION 'Phòng mới không tồn tại' USING ERRCODE='22023'; END IF;
  IF destination_building<>source_building THEN
    RAISE EXCEPTION 'Phòng mới thuộc toà khác. Hãy trả phòng rồi tạo hợp đồng ở tòa mới.' USING ERRCODE='42501';
  END IF;
  quote:=app_private.quote_room_transfer_deposit_v1(p_contract_id,p_new_room_id,p_new_deposit)
       ||app_private.quote_room_transfer_rent_v1(p_org,p_contract_id,p_transfer_date,p_new_rent_price);
  IF quote->>'invoice_id' IS NOT NULL AND NOT coalesce(public.can_do_on_building('invoices','view',source_building),false) THEN
    RAISE EXCEPTION 'Cần quyền xem hóa đơn tại tòa nhà này để đối chiếu kỳ chuyển phòng.' USING ERRCODE='42501';
  END IF;
  quote:=quote||app_private.room_transfer_invoice_balance_v1((quote->>'invoice_id')::uuid,(quote->>'rent_delta')::numeric,
    (quote->>'rent_item_id')::uuid);
  RETURN quote||jsonb_build_object('quote_key',md5(jsonb_build_array(p_org,p_contract_id,p_new_room_id,p_transfer_date,quote)::text));
END $fn$;

REVOKE ALL ON FUNCTION public.preview_room_transfer_v1(uuid,uuid,uuid,date,numeric,numeric) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.preview_room_transfer_v1(uuid,uuid,uuid,date,numeric,numeric) TO authenticated;
NOTIFY pgrst, 'reload schema';
COMMIT;
