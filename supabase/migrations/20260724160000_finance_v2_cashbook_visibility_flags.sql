-- Finance V2 — cờ hiển thị sổ quỹ cho client (UX trang Sổ quỹ, nợ Vòng 2).
--
-- Hiện trạng: policy ie_canonical_writer_read cho MỌI member thấy TÊN mọi sổ
-- trong org, nhưng view accounts_with_balance (security_invoker) chỉ cộng được
-- posting lines của sổ user là CUSTODIAN (RLS finance_v2_can_read_posting_v1)
-- → sổ không-binding hiện "0 đ" GIẢ; icon Sửa/Xoá/Khoá vẫn hiện, bấm vào mới
-- 42501 (server fail-closed đúng, UX sai).
--
-- RPC này cho client biết TRƯỚC, với đúng nguồn truth server:
--   balance_visible : org route CANONICAL/FROZEN → ĐÚNG BẰNG predicate RLS
--                     finance_v2_can_read_posting_v1 (không thêm bypass nào —
--                     kể cả super admin: view cũng không bypass được RLS lines).
--                     Org route LEGACY → true (giữ nguyên hành vi cũ).
--   can_manage      : mirror policy UPDATE accounts (owner ∨
--                     staff_can('cashbooks','edit', owner) ∨ super admin).
--   can_delete      : mirror policy DELETE accounts (owner ∨
--                     staff_can('cashbooks','delete', owner) ∨ super admin).
-- Chỉ trả id + boolean (không tên/số tiền); scope my_org_ids() như
-- accounts_org_boundary — không lộ sổ org khác qua SECURITY DEFINER.

BEGIN;

CREATE OR REPLACE FUNCTION public.list_cashbook_visibility_v2()
RETURNS TABLE (
  cashbook_id uuid,
  balance_visible boolean,
  can_manage boolean,
  can_delete boolean
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $fn$
  SELECT a.id,
         CASE
           WHEN app_private.finance_v2_route_pure_v1(
                  'income_expense.read_semantics.v2', a.organization_id)
                IN ('CANONICAL', 'FROZEN')
             THEN app_private.finance_v2_can_read_posting_v1(a.organization_id, a.id)
           ELSE true
         END,
         (SELECT public.is_super_admin())
           OR a.user_id = auth.uid()
           OR public.staff_can('cashbooks', 'edit', a.user_id),
         (SELECT public.is_super_admin())
           OR a.user_id = auth.uid()
           OR public.staff_can('cashbooks', 'delete', a.user_id)
  FROM public.accounts a
  WHERE a.deleted_at IS NULL
    AND (a.organization_id IS NULL
         OR a.organization_id IN (SELECT unnest(public.my_org_ids())));
$fn$;

REVOKE ALL ON FUNCTION public.list_cashbook_visibility_v2() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_cashbook_visibility_v2() TO authenticated;

-- Smoke: hàm chạy không lỗi dưới định danh service (auth.uid() NULL → flags
-- false / danh sách theo org-boundary; chỉ cần KHÔNG exception).
DO $smoke$
DECLARE v_cnt int;
BEGIN
  SELECT count(*) INTO v_cnt FROM public.list_cashbook_visibility_v2();
  RAISE NOTICE 'cashbook visibility smoke: % rows (service ctx)', v_cnt;
END
$smoke$;

COMMIT;

NOTIFY pgrst, 'reload schema';
