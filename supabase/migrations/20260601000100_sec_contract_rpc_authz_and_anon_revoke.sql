-- =============================================================================
-- Security: vá Broken Object-Level Authorization trên RPC vòng đời hợp đồng
--           + siết quyền EXECUTE cho role anon.
--
-- BỐI CẢNH: các RPC dưới đây là SECURITY DEFINER (bỏ qua RLS) và đang được
-- GRANT EXECUTE cho anon, nhưng KHÔNG kiểm tra caller có quyền trên hợp đồng.
-- Bất kỳ ai biết UUID hợp đồng đều có thể gia hạn / thanh lý / nhượng HĐ của
-- người khác. Migration này thêm 1 lớp kiểm quyền (đồng bộ policy
-- contracts_update_rbac) BẰNG CÁCH BỌC WRAPPER — giữ NGUYÊN VẸN logic tài chính
-- gốc trong hàm *_impl (không gõ lại thân hàm => không rủi ro sai sót).
--
-- KHÔNG đụng tới bất kỳ dòng dữ liệu nào. Chỉ thay đổi định nghĩa hàm + quyền.
-- An toàn chạy lại (idempotent ở mức hợp lý nhờ IF EXISTS / CREATE OR REPLACE).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) renew_contract  (đang dùng: useContractOperations.ts)
-- -----------------------------------------------------------------------------
ALTER FUNCTION public.renew_contract(uuid, date, numeric, numeric, text)
  RENAME TO renew_contract_impl;

CREATE OR REPLACE FUNCTION public.renew_contract(
  p_contract_id   uuid,
  p_new_end_date  date,
  p_new_rent_price numeric DEFAULT NULL,
  p_new_deposit    numeric DEFAULT NULL,
  p_notes          text    DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
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
  RETURN public.renew_contract_impl(p_contract_id, p_new_end_date, p_new_rent_price, p_new_deposit, p_notes);
END $$;

REVOKE ALL     ON FUNCTION public.renew_contract_impl(uuid, date, numeric, numeric, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.renew_contract(uuid, date, numeric, numeric, text)      FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.renew_contract(uuid, date, numeric, numeric, text)      TO authenticated;

-- -----------------------------------------------------------------------------
-- 2) transfer_contract  (đang dùng)
-- -----------------------------------------------------------------------------
ALTER FUNCTION public.transfer_contract(uuid, uuid, numeric, numeric, date, text)
  RENAME TO transfer_contract_impl;

CREATE OR REPLACE FUNCTION public.transfer_contract(
  p_contract_id    uuid,
  p_new_customer_id uuid,
  p_new_rent_price numeric DEFAULT NULL,
  p_new_deposit    numeric DEFAULT NULL,
  p_transfer_date  date    DEFAULT CURRENT_DATE,
  p_notes          text    DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
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
END $$;

REVOKE ALL     ON FUNCTION public.transfer_contract_impl(uuid, uuid, numeric, numeric, date, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.transfer_contract(uuid, uuid, numeric, numeric, date, text)      FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.transfer_contract(uuid, uuid, numeric, numeric, date, text)      TO authenticated;

-- -----------------------------------------------------------------------------
-- 3) terminate_contract_forfeit  (đang dùng) — logic tài chính phức tạp, giữ nguyên
-- -----------------------------------------------------------------------------
ALTER FUNCTION public.terminate_contract_forfeit(uuid, date)
  RENAME TO terminate_contract_forfeit_impl;

CREATE OR REPLACE FUNCTION public.terminate_contract_forfeit(
  p_contract_id uuid,
  p_forfeit_date date)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
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
  RETURN public.terminate_contract_forfeit_impl(p_contract_id, p_forfeit_date);
END $$;

REVOKE ALL     ON FUNCTION public.terminate_contract_forfeit_impl(uuid, date) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.terminate_contract_forfeit(uuid, date)      FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.terminate_contract_forfeit(uuid, date)      TO authenticated;

-- -----------------------------------------------------------------------------
-- 4) terminate_contract_move_out  (đang dùng) — logic tài chính phức tạp, giữ nguyên
-- -----------------------------------------------------------------------------
ALTER FUNCTION public.terminate_contract_move_out(uuid, date, numeric, numeric, numeric, numeric, text)
  RENAME TO terminate_contract_move_out_impl;

CREATE OR REPLACE FUNCTION public.terminate_contract_move_out(
  p_contract_id     uuid,
  p_move_out_date   date,
  p_deposit_refund  numeric DEFAULT 0,
  p_penalty_fee     numeric DEFAULT 0,
  p_excess_rent     numeric DEFAULT 0,
  p_outstanding_debt numeric DEFAULT 0,
  p_notes           text    DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
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
  RETURN public.terminate_contract_move_out_impl(
    p_contract_id, p_move_out_date, p_deposit_refund, p_penalty_fee,
    p_excess_rent, p_outstanding_debt, p_notes);
END $$;

REVOKE ALL     ON FUNCTION public.terminate_contract_move_out_impl(uuid, date, numeric, numeric, numeric, numeric, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.terminate_contract_move_out(uuid, date, numeric, numeric, numeric, numeric, text)      FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.terminate_contract_move_out(uuid, date, numeric, numeric, numeric, numeric, text)      TO authenticated;

-- -----------------------------------------------------------------------------
-- 5) RPC vòng đời HĐ KHÔNG dùng ở frontend (dead code) — thu hồi toàn bộ quyền gọi
--    của client. Không drop để phòng tham chiếu nội bộ; chỉ chặn anon/authenticated.
-- -----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.create_new_contract_extension(uuid, integer, numeric, numeric, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_simple_extension(uuid, integer, numeric, text)                 FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_tenant_transfer(uuid, uuid, date, numeric, text)               FROM PUBLIC, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 6) Hardening: pin search_path cho các SECURITY DEFINER function còn thiếu
--    (linter "Function Search Path Mutable"). Không đổi thân hàm.
-- -----------------------------------------------------------------------------
ALTER FUNCTION public.approve_meter_reading(uuid)                              SET search_path = public;
ALTER FUNCTION public.approve_voucher(uuid)                                    SET search_path = public;
ALTER FUNCTION public.bulk_approve_meter_readings(uuid[])                      SET search_path = public;
ALTER FUNCTION public.bulk_create_meter_readings(jsonb)                        SET search_path = public;
ALTER FUNCTION public.generate_invoices_for_building(uuid, uuid, text, text)   SET search_path = public;
ALTER FUNCTION public.generate_recurring_vouchers(uuid)                        SET search_path = public;
ALTER FUNCTION public.recompute_invoice_after_item_change()                    SET search_path = public;
ALTER FUNCTION public.recompute_invoice_after_payment_change()                 SET search_path = public;
ALTER FUNCTION public.recompute_invoice_after_voucher_change()                 SET search_path = public;
ALTER FUNCTION public.recompute_invoice_for_id(uuid)                           SET search_path = public;
ALTER FUNCTION public.unapprove_voucher(uuid)                                  SET search_path = public;
ALTER FUNCTION public.create_new_contract_extension(uuid, integer, numeric, numeric, text) SET search_path = public;
ALTER FUNCTION public.create_simple_extension(uuid, integer, numeric, text)                SET search_path = public;
ALTER FUNCTION public.create_tenant_transfer(uuid, uuid, date, numeric, text)              SET search_path = public;

-- -----------------------------------------------------------------------------
-- 7) Hardening super_admins: thu hồi quyền GHI của anon/authenticated (RLS vẫn
--    là chốt chính qua is_super_admin()). Giữ SELECT cho authenticated để RLS
--    đánh giá được; chặn anon hoàn toàn. Ghi chỉ qua service_role/postgres.
-- -----------------------------------------------------------------------------
REVOKE ALL ON public.super_admins FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.super_admins FROM authenticated;
GRANT  SELECT ON public.super_admins TO authenticated;
