-- =============================================================
-- Vá bảo mật xuyên-tenant (Phase 1 refactor 2026-07-10)
--
-- 3 lỗ hổng:
--   1. get_income_expense_history(uuid): SECURITY DEFINER + GRANT authenticated
--      + KHÔNG guard → bất kỳ user đăng nhập nào cũng đọc được nhật ký phiếu
--      thu/chi của tenant khác (IDOR). Fix: chuyển SECURITY INVOKER, quyền đọc
--      giao cho RLS của income_expense_audit_log với policy mới "thấy phiếu cha
--      (qua chính RLS income_expenses) thì mới thấy nhật ký" — không chép lại
--      27 policy của income_expenses, kế thừa nguyên bộ (kể cả RESTRICTIVE
--      ẩn phiếu hạn chế).
--   2. salary_staff_months(): SECURITY DEFINER đọc salary_bonus_rules LIMIT 1
--      không lọc user_id → trả config thưởng của tenant "đầu tiên" cho mọi
--      user. Fix: scope theo owner resolve từ auth.uid() (mirror pattern
--      monthly_building_profit: super_admin→self, chủ toà→self, staff→owner
--      qua staff_assignments), KHÔNG fallback xuyên-tenant.
--   3. generate_invoices_for_building (v1, impl nội bộ của _v2): SECURITY
--      DEFINER nhận p_user_id tuỳ ý, không guard, chưa từng REVOKE → mặc định
--      PUBLIC gọi được, sinh hoá đơn cho toà của tenant khác. Fix: REVOKE
--      khỏi PUBLIC/anon/authenticated; wrapper _v2 (đã guard
--      can_do_on_building) chạy SECURITY DEFINER nên vẫn gọi được v1.
--
-- Idempotent.
-- =============================================================

BEGIN;

-- ── 1. get_income_expense_history: DEFINER → INVOKER + RLS theo phiếu cha ──

DROP POLICY IF EXISTS income_expense_audit_log_select_owner ON public.income_expense_audit_log;
DROP POLICY IF EXISTS income_expense_audit_log_select_parent_visible ON public.income_expense_audit_log;
CREATE POLICY income_expense_audit_log_select_parent_visible
  ON public.income_expense_audit_log
  FOR SELECT TO authenticated
  USING (
    -- Subquery chịu RLS của income_expenses theo CHÍNH caller → ai thấy phiếu
    -- thì thấy nhật ký, ai không thấy phiếu thì nhật ký cũng ẩn.
    EXISTS (
      SELECT 1 FROM public.income_expenses ie
      WHERE ie.id = income_expense_id
    )
  );

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
SECURITY INVOKER
SET search_path = public
AS $function$
  SELECT id, action, actor_id, actor_name, old_status, new_status, note, created_at
  FROM income_expense_audit_log
  WHERE income_expense_id = p_id
  ORDER BY created_at DESC;
$function$;

GRANT EXECUTE ON FUNCTION public.get_income_expense_history(uuid) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.get_income_expense_history(uuid) FROM anon;

-- ── 2. salary_staff_months: scope theo owner của caller ─────────────────────

CREATE OR REPLACE FUNCTION public.salary_staff_months()
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT COALESCE(
    (
      SELECT rules -> 'staffMonths'
      FROM public.salary_bonus_rules
      WHERE user_id = COALESCE(
        (SELECT sa.user_id FROM public.super_admins sa WHERE sa.user_id = auth.uid()),
        (SELECT b.user_id FROM public.buildings b
          WHERE b.user_id = auth.uid() AND b.deleted_at IS NULL LIMIT 1),
        (SELECT sa.user_id FROM public.staff_assignments sa
          WHERE sa.staff_id = auth.uid() LIMIT 1),
        auth.uid()
      )
      LIMIT 1
    ),
    '{}'::jsonb
  );
$$;

REVOKE ALL ON FUNCTION public.salary_staff_months() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.salary_staff_months() FROM anon;
GRANT EXECUTE ON FUNCTION public.salary_staff_months() TO authenticated;

-- ── 3. generate_invoices_for_building (v1): khoá gọi trực tiếp ──────────────
-- _v2 (SECURITY DEFINER, guard can_do_on_building('invoices','create')) vẫn
-- gọi được v1 vì chạy dưới owner của function.

REVOKE ALL ON FUNCTION public.generate_invoices_for_building(uuid, uuid, text, text)
  FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;

-- =============================================================
-- ROLLBACK (chạy tay nếu cần đảo):
--
-- BEGIN;
-- DROP POLICY IF EXISTS income_expense_audit_log_select_parent_visible
--   ON public.income_expense_audit_log;
-- CREATE POLICY income_expense_audit_log_select_owner ON public.income_expense_audit_log
--   FOR SELECT TO authenticated
--   USING (EXISTS (SELECT 1 FROM public.income_expenses ie
--                  WHERE ie.id = income_expense_id AND ie.user_id = auth.uid()));
-- CREATE OR REPLACE FUNCTION public.get_income_expense_history(p_id uuid)
-- RETURNS TABLE (id uuid, action text, actor_id uuid, actor_name text,
--                old_status text, new_status text, note text, created_at timestamptz)
-- LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $function$
--   SELECT id, action, actor_id, actor_name, old_status, new_status, note, created_at
--   FROM income_expense_audit_log WHERE income_expense_id = p_id
--   ORDER BY created_at DESC;
-- $function$;
-- CREATE OR REPLACE FUNCTION public.salary_staff_months()
-- RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE AS $$
--   SELECT COALESCE((SELECT rules -> 'staffMonths' FROM public.salary_bonus_rules LIMIT 1), '{}'::jsonb);
-- $$;
-- GRANT EXECUTE ON FUNCTION public.generate_invoices_for_building(uuid, uuid, text, text) TO authenticated;
-- NOTIFY pgrst, 'reload schema';
-- COMMIT;
-- =============================================================
