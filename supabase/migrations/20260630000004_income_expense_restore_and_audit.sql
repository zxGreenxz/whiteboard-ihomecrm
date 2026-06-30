-- =============================================================
-- Khôi phục phiếu thu/chi đã huỷ (Super Admin) + Nhật ký thao tác
--
-- Bối cảnh
-- ────────
-- Huỷ phiếu (useCancelIncomeExpense) chỉ đổi approval_status='CANCELLED'.
-- Riêng phiếu THU mirror từ thanh toán hoá đơn (type='INCOME', có payment_id)
-- còn XOÁ luôn payment row → FK ON DELETE SET NULL làm payment_id=NULL và
-- trigger recompute hoá đơn về chưa thu.
--
-- Tính năng
-- ─────────
--   1. Bảng income_expense_audit_log: ghi lại mọi thao tác HUỶ/KHÔI PHỤC
--      (ai, lúc nào, ghi chú) để soi lịch sử.
--   2. restore_income_expense(p_id): CHỈ super admin. Đưa phiếu về 'APPROVED'
--      (Đã ghi nhận). Nếu là phiếu thu theo hoá đơn đã mất payment → tạo lại
--      payment (có chặn trùng) để hoá đơn trở lại đã thu. Ghi nhật ký 'RESTORED'.
--   3. log_income_expense_action(p_id, action, note): helper ghi nhật ký, dùng
--      cho cả nhánh HUỶ (gọi từ FE) lẫn nội bộ.
--   4. get_income_expense_history(p_id): đọc nhật ký 1 phiếu (SECURITY DEFINER
--      để FE không vướng RLS).
--
-- Idempotent.
-- =============================================================

BEGIN;

-- ── 1. Bảng nhật ký ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.income_expense_audit_log (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  income_expense_id uuid NOT NULL REFERENCES public.income_expenses(id) ON DELETE CASCADE,
  action            text NOT NULL,            -- 'CANCELLED' | 'RESTORED'
  actor_id          uuid,
  actor_name        text,
  old_status        text,
  new_status        text,
  note              text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ie_audit_log_ie_id
  ON public.income_expense_audit_log(income_expense_id, created_at DESC);

ALTER TABLE public.income_expense_audit_log ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON public.income_expense_audit_log TO authenticated;

-- Super admin toàn quyền; chủ phiếu chỉ được đọc nhật ký phiếu của mình.
-- (INSERT thực tế đi qua các hàm SECURITY DEFINER bên dưới nên không cần
--  insert policy cho user thường.)
DROP POLICY IF EXISTS income_expense_audit_log_super_admin_all ON public.income_expense_audit_log;
CREATE POLICY income_expense_audit_log_super_admin_all ON public.income_expense_audit_log
  FOR ALL TO authenticated
  USING (public.is_super_admin())
  WITH CHECK (public.is_super_admin());

DROP POLICY IF EXISTS income_expense_audit_log_select_owner ON public.income_expense_audit_log;
CREATE POLICY income_expense_audit_log_select_owner ON public.income_expense_audit_log
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.income_expenses ie
      WHERE ie.id = income_expense_id AND ie.user_id = auth.uid()
    )
  );

-- ── 2. Helper ghi nhật ký ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.log_income_expense_action(
  p_id uuid,
  p_action text,
  p_note text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_actor_name text;
  v_status     text;
BEGIN
  IF auth.uid() IS NULL THEN RETURN; END IF;

  SELECT approval_status INTO v_status FROM income_expenses WHERE id = p_id;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT full_name INTO v_actor_name FROM profiles WHERE id = auth.uid();

  INSERT INTO income_expense_audit_log
    (income_expense_id, action, actor_id, actor_name, new_status, note)
  VALUES
    (p_id, p_action, auth.uid(), v_actor_name, v_status, p_note);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.log_income_expense_action(uuid, text, text) TO authenticated;

-- ── 3. Khôi phục phiếu (CHỈ super admin) ─────────────────────
CREATE OR REPLACE FUNCTION public.restore_income_expense(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_rec              RECORD;
  v_amount           numeric(15, 2);
  v_payment_id       uuid;
  v_existing_payment uuid;
  v_actor_name       text;
  v_note             text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;

  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Chỉ Super Admin mới được khôi phục phiếu đã huỷ'
      USING ERRCODE = '42501';
  END IF;

  SELECT id, type, invoice_id, payment_id, approval_status,
         voucher_date, total_amount, user_id
  INTO v_rec
  FROM income_expenses
  WHERE id = p_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Không tìm thấy phiếu' USING ERRCODE = 'P0002';
  END IF;

  IF v_rec.approval_status <> 'CANCELLED' THEN
    RAISE EXCEPTION 'Phiếu không ở trạng thái Đã huỷ' USING ERRCODE = 'P0001';
  END IF;

  -- (1) Đưa về Đã ghi nhận
  UPDATE income_expenses
  SET approval_status = 'APPROVED',
      approved_by     = auth.uid(),
      approved_at     = now()
  WHERE id = p_id;

  -- (2) Phiếu THU theo hoá đơn đã mất payment khi huỷ → phục hồi thanh toán.
  --     Chặn trùng: nếu hoá đơn đã có payment cùng số tiền + cùng ngày (vd user
  --     đã thu lại bằng tay) thì chỉ nối lại payment_id, KHÔNG tạo phiếu trùng.
  IF v_rec.type = 'INCOME'
     AND v_rec.invoice_id IS NOT NULL
     AND v_rec.payment_id IS NULL THEN

    v_amount := COALESCE(v_rec.total_amount, 0);

    SELECT id INTO v_existing_payment
    FROM payments
    WHERE invoice_id   = v_rec.invoice_id
      AND amount       = v_amount
      AND payment_date = v_rec.voucher_date
    LIMIT 1;

    IF v_existing_payment IS NOT NULL THEN
      v_payment_id := v_existing_payment;
    ELSIF v_amount > 0 THEN
      INSERT INTO payments
        (user_id, invoice_id, amount, payment_method, payment_date, notes)
      VALUES
        (v_rec.user_id, v_rec.invoice_id, v_amount, 'TM', v_rec.voucher_date,
         'Khôi phục từ phiếu thu đã huỷ')
      RETURNING id INTO v_payment_id;
    END IF;

    IF v_payment_id IS NOT NULL THEN
      UPDATE income_expenses SET payment_id = v_payment_id WHERE id = p_id;
    END IF;
  END IF;

  -- (3) Ghi nhật ký
  SELECT full_name INTO v_actor_name FROM profiles WHERE id = auth.uid();
  v_note := CASE
    WHEN v_payment_id IS NOT NULL
      THEN 'Khôi phục phiếu + phục hồi thanh toán hoá đơn'
    ELSE 'Khôi phục phiếu'
  END;

  INSERT INTO income_expense_audit_log
    (income_expense_id, action, actor_id, actor_name, old_status, new_status, note)
  VALUES
    (p_id, 'RESTORED', auth.uid(), v_actor_name, 'CANCELLED', 'APPROVED', v_note);

  RETURN jsonb_build_object('id', p_id, 'restored_payment_id', v_payment_id);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.restore_income_expense(uuid) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.restore_income_expense(uuid) FROM anon;

-- ── 4. Đọc nhật ký 1 phiếu ───────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_income_expense_history(p_id uuid)
RETURNS TABLE (
  id          uuid,
  action      text,
  actor_id    uuid,
  actor_name  text,
  old_status  text,
  new_status  text,
  note        text,
  created_at  timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
  SELECT id, action, actor_id, actor_name, old_status, new_status, note, created_at
  FROM income_expense_audit_log
  WHERE income_expense_id = p_id
  ORDER BY created_at DESC;
$function$;

GRANT EXECUTE ON FUNCTION public.get_income_expense_history(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
