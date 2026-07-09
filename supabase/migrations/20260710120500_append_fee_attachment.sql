-- =============================================================================
-- append_fee_attachment — đính NHANH 1 ảnh vào phiếu (nút camera trên dòng).
--
-- Concurrent-safe: append server-side (attachments || url) thay vì FE gửi cả
-- mảng (2 người cùng đính ảnh sẽ không đè mất ảnh của nhau — khác đường Sửa
-- phiếu vốn thay cả mảng có chủ ý). Gate quyền như update_period_fee.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.append_fee_attachment(
  p_voucher_id uuid,
  p_url        text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_bld     uuid;
  v_owner   uuid;
  v_del     timestamptz;
  v_creator uuid;
  v_can     boolean;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF NULLIF(btrim(p_url), '') IS NULL THEN
    RAISE EXCEPTION 'Thiếu ảnh cần đính';
  END IF;

  SELECT ie.building_id, ie.deleted_at, ie.user_id
    INTO v_bld, v_del, v_creator
    FROM income_expenses ie
   WHERE ie.id = p_voucher_id
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Không tìm thấy phiếu' USING ERRCODE = 'P0002'; END IF;
  IF v_del IS NOT NULL THEN RAISE EXCEPTION 'Phiếu đã bị hủy'; END IF;

  SELECT b.user_id INTO v_owner FROM buildings b WHERE b.id = v_bld;

  v_can := public.is_admin() OR public.is_super_admin() OR v_owner = auth.uid()
           OR v_creator = auth.uid()
           OR (v_bld IS NOT NULL AND public.can_do_on_building('income_expenses', 'edit', v_bld));
  IF NOT v_can THEN
    RAISE EXCEPTION 'Bạn không có quyền sửa phiếu này' USING ERRCODE = '42501';
  END IF;

  UPDATE income_expenses
     SET attachments = COALESCE(attachments, '[]'::jsonb) || to_jsonb(p_url)
   WHERE id = p_voucher_id;

  RETURN jsonb_build_object('ok', true, 'voucher_id', p_voucher_id);
END;
$$;

REVOKE ALL ON FUNCTION public.append_fee_attachment(uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.append_fee_attachment(uuid,text) TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
