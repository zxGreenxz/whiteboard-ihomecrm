-- =============================================================================
-- cancel_utility_bill — Hủy 1 phiếu chi Đóng tiền Điện nước (NCC)
--
-- Soft-delete (deleted_at = now()) → phiếu rời khỏi sổ quỹ (view current_amount
-- lọc deleted_at IS NULL) và khỏi mọi query utility. Chỉ cho hủy phiếu do máy
-- sinh từ màn Đóng tiền Điện nước (system_source='utility.bill').
--
-- Quyền: người tạo phiếu, hoặc có quyền trên toà (can_access_building /
-- ie_all_buildings_scope), hoặc admin/super. SECURITY DEFINER → tự kiểm quyền.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.cancel_utility_bill(
  p_voucher_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_bld    uuid;
  v_owner  uuid;
  v_src    text;
  v_del    timestamptz;
  v_creator uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;

  SELECT ie.building_id, ie.system_source, ie.deleted_at, ie.user_id
    INTO v_bld, v_src, v_del, v_creator
    FROM income_expenses ie
   WHERE ie.id = p_voucher_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Không tìm thấy phiếu' USING ERRCODE = 'P0002';
  END IF;
  IF v_del IS NOT NULL THEN
    RAISE EXCEPTION 'Phiếu đã bị hủy trước đó';
  END IF;
  IF v_src IS DISTINCT FROM 'utility.bill' THEN
    RAISE EXCEPTION 'Phiếu này không phải phiếu Đóng tiền Điện nước';
  END IF;

  -- Chủ toà (để so quyền)
  SELECT b.user_id INTO v_owner FROM buildings b WHERE b.id = v_bld;

  IF NOT (v_creator = auth.uid()
          OR public.can_access_building(v_bld)
          OR public.ie_all_buildings_scope(v_bld)
          OR v_owner = auth.uid()
          OR public.is_admin() OR public.is_super_admin()) THEN
    RAISE EXCEPTION 'Bạn không có quyền hủy phiếu này' USING ERRCODE = '42501';
  END IF;

  UPDATE income_expenses
     SET deleted_at = now()
   WHERE id = p_voucher_id AND deleted_at IS NULL;

  RETURN jsonb_build_object('ok', true, 'voucher_id', p_voucher_id);
END;
$$;

REVOKE ALL ON FUNCTION public.cancel_utility_bill(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_utility_bill(uuid) TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
