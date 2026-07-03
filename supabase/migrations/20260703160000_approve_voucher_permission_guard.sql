-- =============================================================================
-- FIX C1 (audit thanh lý 2026-07-03): approve_voucher / unapprove_voucher
--
-- Trước: guard chỉ (user_id = auth.uid() OR is_super_admin()) → nhân viên có
-- quyền income_expenses.approve theo toà bấm Duyệt phiếu của CHỦ tạo (vd phiếu
-- forfeit "Doanh thu bỏ cọc" mang user_id = chủ HĐ) → UPDATE khớp 0 dòng →
-- RPC trả void không lỗi → FE toast "Phiếu đã được duyệt" GIẢ → luồng bỏ cọc
-- treo im lặng (cọc không vào KQKD, hoá đơn thanh lý không tất toán).
--
-- Sau:
--   1. Thêm nhánh quyền can_do_on_building('income_expenses','approve', building_id)
--      (cùng chuẩn với các RPC hợp đồng).
--   2. GET DIAGNOSTICS + RAISE 42501 khi 0 dòng → FE hiện lỗi thật.
--   3. Thêm deleted_at IS NULL (không duyệt phiếu đã xoá mềm).
-- Chữ ký hàm GIỮ NGUYÊN → không cần đổi FE.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.approve_voucher(voucher_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_rows integer;
BEGIN
  UPDATE income_expenses ie
  SET
    approval_status = 'APPROVED',
    approved_by = auth.uid(),
    approved_at = NOW()
  WHERE ie.id = voucher_id
    AND ie.deleted_at IS NULL
    AND (
      ie.user_id = auth.uid()
      OR public.is_super_admin()
      OR (
        ie.building_id IS NOT NULL
        AND public.can_do_on_building('income_expenses', 'approve', ie.building_id)
      )
    );
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RAISE EXCEPTION 'Không thể duyệt phiếu: phiếu không tồn tại hoặc bạn không có quyền duyệt phiếu này'
      USING ERRCODE = '42501';
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.unapprove_voucher(voucher_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_rows integer;
BEGIN
  UPDATE income_expenses ie
  SET
    approval_status = 'UNAPPROVED',
    approved_by = NULL,
    approved_at = NULL
  WHERE ie.id = voucher_id
    AND ie.deleted_at IS NULL
    AND (
      ie.user_id = auth.uid()
      OR public.is_super_admin()
      OR (
        ie.building_id IS NOT NULL
        AND public.can_do_on_building('income_expenses', 'approve', ie.building_id)
      )
    );
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RAISE EXCEPTION 'Không thể huỷ duyệt phiếu: phiếu không tồn tại hoặc bạn không có quyền'
      USING ERRCODE = '42501';
  END IF;
END;
$function$;
