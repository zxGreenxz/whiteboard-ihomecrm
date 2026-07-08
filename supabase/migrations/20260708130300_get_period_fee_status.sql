-- =============================================================================
-- get_period_fee_status — trạng thái "đã/chưa đóng" cho lưới GRID của MỌI tòa trong
-- 1 lần gọi (definer, đa-owner, tôn trọng RLS hạn chế).
--
-- Nhận diện phiếu qua khoảng kỳ GIAO NHAU: it.start_date ≤ cuối kỳ AND
-- it.end_date ≥ đầu kỳ (khớp query utility hiện tại → phí trả trước phủ mọi kỳ).
-- Type resolve theo OWNER (matcher fee_type_matches, KHÔNG tạo mới ở đây).
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.get_period_fee_status(
  p_period_start  text,
  p_period_end    text,
  p_building_ids  uuid[],
  p_category_keys text[]
) RETURNS TABLE(
  building_id      uuid,
  category_key     text,
  paid_amount      numeric,
  covered_start    date,
  covered_end      date,
  voucher_ids      uuid[],
  has_receipt      boolean,
  account_name     text,
  account_is_empty boolean,
  expected_amount  numeric
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_start         date;
  v_end           date;
  v_can_restricted boolean;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF p_period_start !~ '^\d{4}-\d{2}$' OR p_period_end !~ '^\d{4}-\d{2}$' THEN
    RAISE EXCEPTION 'Kỳ không hợp lệ (cần YYYY-MM)';
  END IF;
  v_start := to_date(p_period_start || '-01', 'YYYY-MM-DD');
  v_end   := (date_trunc('month', to_date(p_period_end || '-01', 'YYYY-MM-DD')) + interval '1 month - 1 day')::date;
  v_can_restricted := public.can_view_restricted_ie();

  RETURN QUERY
  WITH bld AS (
    SELECT b.id, b.user_id AS owner
      FROM buildings b
     WHERE b.id = ANY(p_building_ids) AND b.deleted_at IS NULL
       AND (public.can_access_building(b.id)
            OR public.ie_all_buildings_scope(b.id)
            OR b.user_id = auth.uid()
            OR public.is_admin() OR public.is_super_admin())
  ),
  cat AS (
    SELECT k FROM unnest(p_category_keys) AS k
     WHERE k IN ('tien_nha','dien','nuoc','internet','quan_ly','ve_sinh','cong_an','rac','thang_may')
  ),
  pairs AS (
    SELECT bld.id AS building_id, bld.owner, cat.k AS category_key
      FROM bld CROSS JOIN cat
  ),
  typed AS (
    SELECT p.building_id, p.category_key, t.id AS type_id, t.is_restricted
      FROM pairs p
      JOIN income_expense_types t
        ON t.user_id = p.owner AND t.type = 'expense'
       AND public.fee_type_matches(p.category_key, t.category, t.name)
  ),
  vperv AS (
    SELECT p.building_id, p.category_key,
           ie.id                       AS voucher_id,
           max(ie.total_amount)        AS amount,
           bool_or(ie.account_id IS NULL) AS acc_empty,
           (max(a.name))               AS account_name,
           bool_or(jsonb_typeof(ie.attachments) = 'array'
                   AND jsonb_array_length(ie.attachments) > 0) AS has_rc,
           min(it.start_date)          AS cstart,
           max(it.end_date)            AS cend
      FROM pairs p
      JOIN typed ty ON ty.building_id = p.building_id AND ty.category_key = p.category_key
                   AND (NOT ty.is_restricted OR v_can_restricted)
      JOIN income_expense_items it ON it.income_expense_type_id = ty.type_id
      JOIN income_expenses ie ON ie.id = it.income_expense_id
                             AND ie.building_id = p.building_id
                             AND ie.type = 'EXPENSE'
                             AND ie.approval_status = 'APPROVED'
                             AND ie.deleted_at IS NULL
      LEFT JOIN accounts a ON a.id = ie.account_id
     WHERE it.start_date <= v_end AND it.end_date >= v_start
     GROUP BY p.building_id, p.category_key, ie.id
  )
  SELECT
    p.building_id,
    p.category_key,
    COALESCE(SUM(v.amount), 0)                                           AS paid_amount,
    MIN(v.cstart)                                                        AS covered_start,
    MAX(v.cend)                                                          AS covered_end,
    COALESCE(array_agg(v.voucher_id) FILTER (WHERE v.voucher_id IS NOT NULL), '{}'::uuid[]) AS voucher_ids,
    COALESCE(bool_or(v.has_rc), false)                                   AS has_receipt,
    (array_agg(v.account_name ORDER BY v.cend DESC NULLS LAST)
       FILTER (WHERE v.account_name IS NOT NULL))[1]                     AS account_name,
    COALESCE(bool_or(v.voucher_id IS NOT NULL AND v.acc_empty), false)   AS account_is_empty,
    MAX(fa.default_amount)                                              AS expected_amount
  FROM pairs p
  LEFT JOIN vperv v ON v.building_id = p.building_id AND v.category_key = p.category_key
  LEFT JOIN building_fee_accounts fa ON fa.building_id = p.building_id
                                    AND fa.fee_category = p.category_key
                                    AND fa.deleted_at IS NULL
  GROUP BY p.building_id, p.category_key;
END;
$$;

REVOKE ALL ON FUNCTION public.get_period_fee_status(text,text,uuid[],text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_period_fee_status(text,text,uuid[],text[]) TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
