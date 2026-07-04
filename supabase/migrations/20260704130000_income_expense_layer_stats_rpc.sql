-- =====================================================================
-- B4 (thống nhất tài chính 04/07): RPC thống kê trang Thu chi 3 lớp.
--
-- LÝ DO PHẢI CÓ RPC: FE cũ SELECT toàn bộ phiếu rồi cộng client-side —
-- PostgREST cap 1000 hàng/response nên tenant thật (~1.356 phiếu active)
-- bị CỘNG THIẾU ÂM THẦM (đối chiếu 04/07: thẻ Chi hụt ~1,5 tỷ so với SQL).
-- Bug này tồn tại từ trước B4; aggregate server-side diệt hẳn.
--
-- SECURITY INVOKER: RLS áp per-user y như query FE cũ (income_expenses,
-- accounts, income_expense_items đều qua policy của người gọi).
-- Phân lớp phải khớp voucherLayer() ở src/lib/voucherSources.ts:
--   PENDING  = UNAPPROVED hoặc chưa chọn sổ (account_id NULL)
--   INTERNAL = sổ ảo (accounts.is_virtual) hoặc nguồn nội-bộ-theo-bản-chất
--              (danh sách truyền từ FE — voucherSources.ts là nguồn sự thật)
--   CASH     = còn lại (tiền thật đã vào sổ)
-- p_kqkd_only = TRUE giữ nguyên hành vi P&L cũ (Σ kqkd_amount theo type,
-- không phân lớp) — ProfitDistribution cash/P&L mode dùng chung RPC để
-- cũng thoát cap 1000.
-- =====================================================================

DROP FUNCTION IF EXISTS public.get_income_expense_layer_stats(
  uuid[], uuid[], uuid, text, date, date, text, uuid, numeric, numeric,
  text, uuid[], uuid[], text[], boolean, text[], boolean);

CREATE OR REPLACE FUNCTION public.get_income_expense_layer_stats(
  p_building_ids    uuid[]  DEFAULT NULL,
  p_room_ids        uuid[]  DEFAULT NULL,
  p_account_id      uuid    DEFAULT NULL,
  p_type            text    DEFAULT NULL,
  p_start_date      date    DEFAULT NULL,
  p_end_date        date    DEFAULT NULL,
  p_approval        text    DEFAULT 'ALL_ACTIVE',
  p_creator_id      uuid    DEFAULT NULL,
  p_amount          numeric DEFAULT NULL,
  p_amount_tol      numeric DEFAULT 5000,
  p_verified        text    DEFAULT NULL,
  p_item_type_ids   uuid[]  DEFAULT NULL,
  p_voucher_ids     uuid[]  DEFAULT NULL,
  p_sources         text[]  DEFAULT NULL,
  p_source_manual   boolean DEFAULT FALSE,
  p_internal_sources text[] DEFAULT NULL,
  p_kqkd_only       boolean DEFAULT FALSE
)
RETURNS TABLE (
  cash_income      numeric,
  cash_expense     numeric,
  internal_count   integer,
  internal_income  numeric,
  internal_expense numeric,
  pending_count    integer,
  pending_total    numeric
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
WITH base AS (
  SELECT ie.type, ie.total_amount, ie.kqkd_amount, ie.approval_status,
         ie.account_id, ie.system_source,
         COALESCE(a.is_virtual, FALSE) AS acc_virtual
  FROM public.income_expenses ie
  LEFT JOIN public.accounts a ON a.id = ie.account_id
  WHERE ie.deleted_at IS NULL
    AND (CASE
           WHEN p_approval IS NULL OR p_approval = 'ALL_ACTIVE'
             THEN ie.approval_status IN ('APPROVED', 'UNAPPROVED')
           ELSE ie.approval_status = p_approval
         END)
    AND (p_building_ids IS NULL OR ie.building_id = ANY (p_building_ids))
    AND (p_room_ids     IS NULL OR ie.room_id     = ANY (p_room_ids))
    AND (p_account_id   IS NULL
         OR ie.account_id = p_account_id
         OR ie.change_account_id = p_account_id)
    AND (p_type       IS NULL OR ie.type = p_type)
    AND (p_start_date IS NULL OR ie.voucher_date >= p_start_date)
    AND (p_end_date   IS NULL OR ie.voucher_date <= p_end_date)
    AND (p_creator_id IS NULL OR ie.user_id = p_creator_id)
    AND (p_amount     IS NULL
         OR ie.total_amount BETWEEN p_amount - p_amount_tol
                                AND p_amount + p_amount_tol)
    AND (p_verified IS NULL
         OR (p_verified = 'VERIFIED'   AND ie.verified_at IS NOT NULL)
         OR (p_verified = 'UNVERIFIED' AND ie.verified_at IS NULL))
    AND (p_voucher_ids IS NULL OR ie.id = ANY (p_voucher_ids))
    AND (p_item_type_ids IS NULL OR EXISTS (
           SELECT 1 FROM public.income_expense_items iti
           WHERE iti.income_expense_id = ie.id
             AND iti.income_expense_type_id = ANY (p_item_type_ids)))
    AND (NOT p_source_manual OR ie.system_source IS NULL)
    AND (p_sources IS NULL OR ie.system_source = ANY (p_sources))
    AND (NOT p_kqkd_only OR ie.kqkd_amount > 0)
),
cls AS (
  SELECT *,
    CASE
      WHEN approval_status = 'UNAPPROVED' OR account_id IS NULL THEN 'PENDING'
      WHEN acc_virtual
           OR (p_internal_sources IS NOT NULL
               AND system_source = ANY (p_internal_sources)) THEN 'INTERNAL'
      ELSE 'CASH'
    END AS layer
  FROM base
  -- Mode thường bỏ phiếu huỷ khỏi MỌI nhóm (khớp vòng for FE cũ);
  -- mode kqkd giữ nguyên theo filter approval như hành vi P&L cũ.
  WHERE p_kqkd_only OR approval_status <> 'CANCELLED'
)
SELECT
  COALESCE(SUM(CASE WHEN p_kqkd_only AND type = 'INCOME' THEN kqkd_amount
                    WHEN NOT p_kqkd_only AND layer = 'CASH' AND type = 'INCOME' THEN total_amount
               END), 0)::numeric AS cash_income,
  COALESCE(SUM(CASE WHEN p_kqkd_only AND type = 'EXPENSE' THEN kqkd_amount
                    WHEN NOT p_kqkd_only AND layer = 'CASH' AND type = 'EXPENSE' THEN total_amount
               END), 0)::numeric AS cash_expense,
  COALESCE(COUNT(*) FILTER (WHERE NOT p_kqkd_only AND layer = 'INTERNAL'), 0)::integer AS internal_count,
  COALESCE(SUM(total_amount) FILTER (WHERE NOT p_kqkd_only AND layer = 'INTERNAL' AND type = 'INCOME'), 0)::numeric AS internal_income,
  COALESCE(SUM(total_amount) FILTER (WHERE NOT p_kqkd_only AND layer = 'INTERNAL' AND type = 'EXPENSE'), 0)::numeric AS internal_expense,
  COALESCE(COUNT(*) FILTER (WHERE NOT p_kqkd_only AND layer = 'PENDING'), 0)::integer AS pending_count,
  COALESCE(SUM(total_amount) FILTER (WHERE NOT p_kqkd_only AND layer = 'PENDING'), 0)::numeric AS pending_total
FROM cls;
$$;

REVOKE ALL ON FUNCTION public.get_income_expense_layer_stats(
  uuid[], uuid[], uuid, text, date, date, text, uuid, numeric, numeric,
  text, uuid[], uuid[], text[], boolean, text[], boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_income_expense_layer_stats(
  uuid[], uuid[], uuid, text, date, date, text, uuid, numeric, numeric,
  text, uuid[], uuid[], text[], boolean, text[], boolean)
  TO authenticated, service_role;
