-- =============================================================================
-- get_period_maintenance — phiếu bảo trì máy lạnh/máy giặt ĐÃ CÓ trong kỳ (definer).
-- Trả FLAT rows; FE gom theo batch_id (phiếu tổng) — phiếu lẻ (không batch) đứng
-- riêng. Nhận diện qua type name nrm ~ 'bao tri may lanh' | 'bao tri may giat'.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.get_period_maintenance(
  p_period_month text,
  p_building_ids uuid[] DEFAULT NULL
) RETURNS TABLE(
  batch_id      uuid,
  payer_name    text,
  voucher_id    uuid,
  building_id   uuid,
  building_name text,
  subtype       text,
  amount        numeric,
  account_name  text,
  has_receipt   boolean,
  voucher_date  date,
  is_standalone boolean
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
    SELECT b.id, b.name
      FROM buildings b
     WHERE (p_building_ids IS NULL OR b.id = ANY(p_building_ids))
       AND b.deleted_at IS NULL
       AND (public.can_access_building(b.id)
            OR public.ie_all_buildings_scope(b.id)
            OR b.user_id = auth.uid()
            OR public.is_admin() OR public.is_super_admin())
  ),
  v AS (
    SELECT DISTINCT ON (ie.id)
           ie.id AS voucher_id, ie.building_id, ie.account_id, ie.voucher_date, ie.attachments,
           CASE WHEN public.nrm_vn(tp.name) LIKE '%may giat%' THEN 'mg' ELSE 'ml' END AS subtype,
           ie.total_amount
      FROM income_expenses ie
      JOIN bld ON bld.id = ie.building_id
      JOIN income_expense_items it ON it.income_expense_id = ie.id
      JOIN income_expense_types tp ON tp.id = it.income_expense_type_id
     WHERE ie.type = 'EXPENSE' AND ie.approval_status = 'APPROVED' AND ie.deleted_at IS NULL
       AND (public.nrm_vn(tp.name) LIKE '%bao tri may lanh%'
            OR public.nrm_vn(tp.name) LIKE '%bao tri may giat%'
            OR public.nrm_vn(tp.name) LIKE '%may lanh%'
            OR public.nrm_vn(tp.name) LIKE '%may giat%')
       AND it.start_date <= v_end AND it.end_date >= v_start
     ORDER BY ie.id
  )
  SELECT
    bi.batch_id,
    bt.payer_name,
    v.voucher_id, v.building_id, bld.name,
    v.subtype, v.total_amount,
    a.name,
    (jsonb_typeof(v.attachments) = 'array' AND jsonb_array_length(v.attachments) > 0),
    v.voucher_date::date,
    (bi.batch_id IS NULL)
  FROM v
  JOIN bld ON bld.id = v.building_id
  LEFT JOIN accounts a ON a.id = v.account_id
  LEFT JOIN income_expense_batch_items bi ON bi.income_expense_id = v.voucher_id
  LEFT JOIN income_expense_batches bt ON bt.id = bi.batch_id
  ORDER BY bi.batch_id NULLS LAST, bld.name;
END;
$$;

REVOKE ALL ON FUNCTION public.get_period_maintenance(text,uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_period_maintenance(text,uuid[]) TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
