-- Đánh dấu phiếu thu/chi "đã kiểm tra" — một loại check pháp lý nhẹ,
-- không thay đổi approval_status. Một phiếu chỉ có 1 người kiểm tại 1 thời điểm.
-- Bấm lại khi đã kiểm → bỏ kiểm (chỉ chủ kiểm hoặc super admin).

ALTER TABLE public.income_expenses
  ADD COLUMN IF NOT EXISTS verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS verified_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS verified_by_name text,
  ADD COLUMN IF NOT EXISTS verified_note text;

CREATE INDEX IF NOT EXISTS income_expenses_verified_at_idx
  ON public.income_expenses (verified_at) WHERE verified_at IS NOT NULL;

-- RPC toggle verify. SECURITY DEFINER vì cần đọc/ghi qua RLS một lần
-- nhưng giữ kiểm tra quyền nội suy (caller phải có quyền xem phiếu).
CREATE OR REPLACE FUNCTION public.verify_income_expense(
  p_id uuid,
  p_note text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_voucher record;
  v_can_see boolean;
  v_full_name text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Phải đăng nhập';
  END IF;

  SELECT id, building_id, account_id, verified_at, verified_by, verified_by_name
    INTO v_voucher
    FROM public.income_expenses
   WHERE id = p_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Không tìm thấy phiếu';
  END IF;

  -- Caller phải có quyền xem phiếu (đồng bộ với policy SELECT)
  SELECT (
    public.is_super_admin()
    OR public.is_admin()
    OR (v_voucher.building_id IS NOT NULL AND public.can_access_building(v_voucher.building_id))
    OR public.is_account_shared_with_me(v_voucher.account_id)
  ) INTO v_can_see;
  IF NOT v_can_see THEN
    RAISE EXCEPTION 'Không có quyền xem phiếu này';
  END IF;

  -- Đã có người kiểm trước đó → toggle bỏ kiểm (chỉ chủ kiểm hoặc super admin).
  IF v_voucher.verified_at IS NOT NULL THEN
    IF v_voucher.verified_by = v_uid OR public.is_super_admin() THEN
      UPDATE public.income_expenses
         SET verified_at = NULL,
             verified_by = NULL,
             verified_by_name = NULL,
             verified_note = NULL
       WHERE id = p_id;
      RETURN;
    ELSE
      RAISE EXCEPTION 'Phiếu đã được % kiểm — chỉ super admin hoặc người kiểm mới bỏ được', COALESCE(v_voucher.verified_by_name, 'người khác');
    END IF;
  END IF;

  SELECT COALESCE(full_name, email, 'Người dùng') INTO v_full_name
    FROM public.profiles WHERE id = v_uid;

  UPDATE public.income_expenses
     SET verified_at = now(),
         verified_by = v_uid,
         verified_by_name = v_full_name,
         verified_note = NULLIF(BTRIM(COALESCE(p_note, '')), '')
   WHERE id = p_id;
END;
$$;

REVOKE ALL ON FUNCTION public.verify_income_expense(uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.verify_income_expense(uuid, text) TO authenticated;
