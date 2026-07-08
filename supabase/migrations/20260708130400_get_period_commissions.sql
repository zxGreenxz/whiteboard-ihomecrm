-- =============================================================================
-- get_period_commissions — HĐ ký trong kỳ + HH môi giới dự kiến + trạng thái đã/chưa chi
-- (definer, đa-owner). Không tạo bảng mới — dùng contracts + buildings.commission_tiers.
--
-- months = số tháng đầy đủ HĐ (mirror calcContractMonths = differenceInMonths).
-- tier: khớp min..max; vượt bậc cao nhất → lấy bậc cao nhất (mirror findMatchingTier).
-- expected = round(rent_price × rate_percent / 100)  (mirror CommissionVoucherModal).
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.get_period_commissions(
  p_period_month text,
  p_building_ids uuid[] DEFAULT NULL
) RETURNS TABLE(
  contract_id      uuid,
  contract_number  text,
  building_id      uuid,
  building_name    text,
  room_id          uuid,
  room_name        text,
  tenant_name      text,
  signed_date      date,
  months           int,
  tier_percent     numeric,
  expected_amount  numeric,
  voucher_id       uuid,
  account_is_empty boolean,
  status           text
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_start date;
  v_end   date;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF p_period_month !~ '^\d{4}-\d{2}$' THEN
    RAISE EXCEPTION 'Kỳ không hợp lệ (cần YYYY-MM)';
  END IF;
  v_start := to_date(p_period_month || '-01', 'YYYY-MM-DD');
  v_end   := (date_trunc('month', v_start) + interval '1 month - 1 day')::date;

  RETURN QUERY
  WITH bld AS (
    SELECT b.id, b.name, b.commission_tiers
      FROM buildings b
     WHERE (p_building_ids IS NULL OR b.id = ANY(p_building_ids))
       AND b.deleted_at IS NULL
       AND (public.can_access_building(b.id)
            OR public.ie_all_buildings_scope(b.id)
            OR b.user_id = auth.uid()
            OR public.is_admin() OR public.is_super_admin())
  ),
  ct AS (
    SELECT c.id, c.contract_number, c.signed_date, c.rent_price,
           r.id AS room_id, r.name AS room_name,
           bld.id AS building_id, bld.name AS building_name, bld.commission_tiers,
           GREATEST(
             (EXTRACT(YEAR FROM age(c.end_date, c.start_date)) * 12
              + EXTRACT(MONTH FROM age(c.end_date, c.start_date)))::int, 0) AS months
      FROM contracts c
      JOIN rooms r ON r.id = c.room_id
      JOIN bld ON bld.id = r.building_id
     WHERE c.deleted_at IS NULL
       AND c.signed_date >= v_start AND c.signed_date <= v_end
  )
  SELECT
    ct.id, ct.contract_number, ct.building_id, ct.building_name,
    ct.room_id, ct.room_name,
    COALESCE(rep.full_name, ''),
    ct.signed_date, ct.months,
    tier.rate,
    ROUND(ct.rent_price * COALESCE(tier.rate, 0) / 100.0)::numeric,
    v.voucher_id,
    COALESCE(v.acc_empty, false),
    CASE WHEN v.voucher_id IS NOT NULL THEN 'paid' ELSE 'unpaid' END
  FROM ct
  LEFT JOIN LATERAL (
    SELECT cust.full_name
      FROM contract_customers cc
      JOIN customers cust ON cust.id = cc.customer_id
     WHERE cc.contract_id = ct.id
     ORDER BY cc.is_representative DESC NULLS LAST
     LIMIT 1
  ) rep ON true
  LEFT JOIN LATERAL (
    SELECT COALESCE(
      (SELECT (t->>'rate_percent')::numeric
         FROM jsonb_array_elements(COALESCE(ct.commission_tiers, '[]'::jsonb)) t
        WHERE ct.months >= (t->>'min_months')::int AND ct.months <= (t->>'max_months')::int
        ORDER BY (t->>'min_months')::int LIMIT 1),
      (SELECT (t->>'rate_percent')::numeric
         FROM jsonb_array_elements(COALESCE(ct.commission_tiers, '[]'::jsonb)) t
        WHERE ct.months > (t->>'max_months')::int
        ORDER BY (t->>'max_months')::int DESC LIMIT 1)
    ) AS rate
  ) tier ON true
  LEFT JOIN LATERAL (
    SELECT ie.id AS voucher_id, (ie.account_id IS NULL) AS acc_empty
      FROM income_expenses ie
      JOIN income_expense_items it ON it.income_expense_id = ie.id
      JOIN income_expense_types tp ON tp.id = it.income_expense_type_id
     WHERE ie.contract_id = ct.id
       AND ie.type = 'EXPENSE' AND ie.deleted_at IS NULL
       AND (public.nrm_vn(tp.name) LIKE '%hoa hong%' OR public.nrm_vn(tp.name) LIKE '%thuong nong%')
     ORDER BY ie.created_at DESC LIMIT 1
  ) v ON true
  ORDER BY ct.signed_date DESC, ct.contract_number;
END;
$$;

REVOKE ALL ON FUNCTION public.get_period_commissions(text,uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_period_commissions(text,uuid[]) TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
