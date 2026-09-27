-- LIVE production catalog, read-only snapshot 2026-09-27T12:35:40.599Z
-- public.transfer_contract(p_contract_id uuid, p_new_customer_id uuid, p_new_rent_price numeric, p_new_deposit numeric, p_transfer_date date, p_notes text) md5(prosrc)=c9b15b89aa8624cc6c1bd85efe4d26b1
CREATE OR REPLACE FUNCTION public.transfer_contract(p_contract_id uuid, p_new_customer_id uuid, p_new_rent_price numeric DEFAULT NULL::numeric, p_new_deposit numeric DEFAULT NULL::numeric, p_transfer_date date DEFAULT CURRENT_DATE, p_notes text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_room uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  SELECT room_id INTO v_room FROM public.contracts
   WHERE id = p_contract_id AND deleted_at IS NULL;
  IF NOT (
    public.is_super_admin()
    OR (v_room IS NOT NULL AND public.can_do_on_building('contracts','edit',
          (SELECT building_id FROM public.rooms WHERE id = v_room)))
  ) THEN
    RAISE EXCEPTION 'Bạn không có quyền thao tác trên hợp đồng này' USING ERRCODE = '42501';
  END IF;
  RETURN public.transfer_contract_impl(p_contract_id, p_new_customer_id, p_new_rent_price, p_new_deposit, p_transfer_date, p_notes);
END $function$

