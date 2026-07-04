-- =====================================================================
-- B5: get_income_expense_layer_stats v2 — tách pending theo THU/CHI.
--
-- Lý do: trang Phân bổ lợi nhuận (chế độ "gồm cả khoản ngoài KQKD") cần
-- TỔNG MỌI PHIẾU = cash + internal + pending theo từng chiều thu/chi;
-- bản v1 chỉ có pending_total gộp nên không cộng ngược được. Đổi output
-- (RETURNS TABLE) nên phải DROP trước CREATE. Logic filter/phân lớp giữ
-- NGUYÊN từng chữ so 20260704130000.
-- =====================================================================

DROP FUNCTION IF EXISTS public.get_income_expense_layer_stats(
  uuid[], uuid[], uuid, text, date, date, text, uuid, numeric, numeric,
  text, uuid[], uuid[], text[], boolean, text[], boolean);

CREATE FUNCTION public.get_income_expense_layer_stats(
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
  pending_total    numeric,
  pending_income   numeric,
  pending_expense  numeric
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
  COALESCE(SUM(total_amount) FILTER (WHERE NOT p_kqkd_only AND layer = 'PENDING'), 0)::numeric AS pending_total,
  COALESCE(SUM(total_amount) FILTER (WHERE NOT p_kqkd_only AND layer = 'PENDING' AND type = 'INCOME'), 0)::numeric AS pending_income,
  COALESCE(SUM(total_amount) FILTER (WHERE NOT p_kqkd_only AND layer = 'PENDING' AND type = 'EXPENSE'), 0)::numeric AS pending_expense
FROM cls;
$$;

REVOKE ALL ON FUNCTION public.get_income_expense_layer_stats(
  uuid[], uuid[], uuid, text, date, date, text, uuid, numeric, numeric,
  text, uuid[], uuid[], text[], boolean, text[], boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_income_expense_layer_stats(
  uuid[], uuid[], uuid, text, date, date, text, uuid, numeric, numeric,
  text, uuid[], uuid[], text[], boolean, text[], boolean)
  TO authenticated, service_role;
