-- =============================================================
-- Super Admin bypass — Round 2: SECURITY DEFINER RPCs & Storage
--
-- Round 1 (20260514000004) added <t>_super_admin_all policies for
-- the 5 RLS-only tables that were missed. But several restrictions
-- live OUTSIDE plain table RLS:
--
--   1. SECURITY DEFINER RPCs that hard-code WHERE user_id = auth.uid().
--      Even with RLS bypass, these RPCs silently fail for super admin
--      acting on rows owned by other users:
--        • approve_voucher / unapprove_voucher
--        • soft_delete_customer
--        • delete_staff_member
--
--   2. storage.objects policies that restrict UPDATE/DELETE by owner
--      or by storage.foldername(name)[1] = auth.uid()::text. Affects:
--        • document-templates
--        • payment-receipts
--        • income-expense-attachments
--        • ui-references
--        • meter-images / customer-images (less critical, see below)
--
-- Strategy: leave existing checks intact, OR-merge a super-admin
-- branch. For RPCs that's `OR public.is_super_admin()` in the WHERE
-- clause. For storage that's an additional permissive ALL policy.
--
-- Idempotent.
-- =============================================================

BEGIN;

-- ── 1. approve_voucher: allow super admin to approve any voucher ───
CREATE OR REPLACE FUNCTION public.approve_voucher(voucher_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
BEGIN
  UPDATE income_expenses
  SET
    approval_status = 'APPROVED',
    approved_by = auth.uid(),
    approved_at = NOW()
  WHERE id = voucher_id
    AND (user_id = auth.uid() OR public.is_super_admin());
END;
$function$;

-- ── 2. unapprove_voucher ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.unapprove_voucher(voucher_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
BEGIN
  UPDATE income_expenses
  SET
    approval_status = 'UNAPPROVED',
    approved_by = NULL,
    approved_at = NULL
  WHERE id = voucher_id
    AND (user_id = auth.uid() OR public.is_super_admin());
END;
$function$;

-- ── 3. soft_delete_customer ───────────────────────────────────────
CREATE OR REPLACE FUNCTION public.soft_delete_customer(p_customer_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  UPDATE customers
  SET deleted_at = NOW()
  WHERE id = p_customer_id
    AND (user_id = auth.uid() OR public.is_super_admin())
    AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Customer not found or not authorized';
  END IF;
END;
$function$;

-- ── 4. delete_staff_member: super admin can delete any staff ──────
-- Keep "can't self-delete" guard. Skip the staff_assignments
-- employer check when caller is super admin.
CREATE OR REPLACE FUNCTION public.delete_staff_member(p_staff_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;

  IF p_staff_id = auth.uid() THEN
    RAISE EXCEPTION 'Không thể tự xoá tài khoản của chính bạn' USING ERRCODE = '42501';
  END IF;

  IF NOT public.is_super_admin() AND NOT EXISTS (
    SELECT 1 FROM public.staff_assignments
    WHERE staff_id = p_staff_id AND user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Bạn không có quyền xoá nhân viên này' USING ERRCODE = '42501';
  END IF;

  DELETE FROM public.roles WHERE user_id = p_staff_id;
  DELETE FROM auth.users WHERE id = p_staff_id;
END;
$function$;

-- ── 5. Storage: blanket super-admin policy on storage.objects ─────
-- Postgres OR-merges this with the existing bucket-level policies,
-- so super admin can SELECT/INSERT/UPDATE/DELETE any object in any
-- bucket while non-super-admins keep their narrow access.
DROP POLICY IF EXISTS "storage_objects_super_admin_all" ON storage.objects;
CREATE POLICY "storage_objects_super_admin_all" ON storage.objects
  FOR ALL TO authenticated
  USING (public.is_super_admin())
  WITH CHECK (public.is_super_admin());

NOTIFY pgrst, 'reload schema';
COMMIT;
