-- ============================================================
-- Danh mục chi chuẩn — BÁO CÁO CỘNG GỘP (chủ duyệt 03/10/2026).
-- Chạy SAU …_danh_muc_chi_cau_truc.sql (cột merged_into_id).
--
-- Phiếu cũ giữ nguyên hạng mục cũ (không chuyển dòng). Để báo cáo theo hạng mục
-- vẫn đúng danh mục mới, ba hàm đọc dưới đây nối dòng phiếu tới hạng mục GỐC:
-- COALESCE(merged_into_id, id) — gộp chỉ một bậc (trigger
-- a02_ie_type_merge_one_level) nên một bước là đủ.
--   - fa_type_breakdown          (Phân tích tài chính, theo ngày phiếu)
--   - fa_accrual_allocations     (bản phân kỳ; business_performance_category_
--                                 breakdown_v1 và fa_type_breakdown_accrual đọc
--                                 qua hàm này nên tự cộng gộp theo)
--   - copilot_report_expense_ratio_v1 (Copilot: tỉ lệ chi theo nhóm)
-- Thân hàm lấy NGUYÊN từ production 03/10/2026 (pg_get_functiondef), chỉ thay
-- phép nối hạng mục; quyền EXECUTE giữ nguyên vì CREATE OR REPLACE.
-- Hạng mục chưa gộp: COALESCE trả về chính nó ⇒ số liệu không đổi.
-- ============================================================

CREATE OR REPLACE FUNCTION public.fa_type_breakdown(p_start_date date, p_end_date date, p_building_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS TABLE(month date, side text, type_id uuid, type_name text, category text, total_amount numeric, voucher_count bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH allowed AS (
    SELECT b.id
    FROM public.buildings b
    WHERE b.deleted_at IS NULL
      AND (p_building_ids IS NULL OR b.id = ANY(p_building_ids))
      AND public.can_access_building(b.id)
  ),
  base AS (
    SELECT voucher.id, voucher.type, voucher.total_amount,
           voucher.business_result_accounting AS override,
           date_trunc('month', voucher.voucher_date)::date AS m
    FROM public.income_expenses voucher
    JOIN allowed a ON a.id = voucher.building_id
    WHERE voucher.deleted_at IS NULL
      AND voucher.approval_status = 'APPROVED'
      AND voucher.business_result_accounting IS DISTINCT FROM false
      AND voucher.voucher_date BETWEEN p_start_date AND p_end_date
  )
  SELECT base.m, base.type::text, type_row.id, type_row.name, type_row.category,
         SUM(COALESCE(item.amount, item.unit_price * item.quantity))::numeric,
         COUNT(DISTINCT base.id)
  FROM base
  JOIN public.income_expense_items item ON item.income_expense_id = base.id
  JOIN public.income_expense_types type_src ON type_src.id = item.income_expense_type_id
  JOIN public.income_expense_types type_row ON type_row.id = COALESCE(type_src.merged_into_id, type_src.id)
  WHERE base.override IS TRUE OR item.accounting_class = 'PNL'
  GROUP BY base.m, base.type, type_row.id, type_row.name, type_row.category
  UNION ALL
  SELECT base.m, base.type::text, NULL::uuid, 'Không có hạng mục'::text, NULL::text,
         SUM(base.total_amount)::numeric, COUNT(*)
  FROM base
  WHERE NOT EXISTS (
    SELECT 1 FROM public.income_expense_items item WHERE item.income_expense_id = base.id
  )
  GROUP BY base.m, base.type
  ORDER BY 1, 2, 6 DESC;
$function$;

CREATE OR REPLACE FUNCTION public.fa_accrual_allocations(p_start_date date, p_end_date date, p_building_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS TABLE(month date, voucher_id uuid, building_id uuid, building_name text, is_virtual boolean, side text, type_id uuid, type_name text, category text, amount numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH allowed AS (
    SELECT b.id, b.name, b.is_virtual
    FROM public.buildings b
    WHERE b.deleted_at IS NULL
      AND (p_building_ids IS NULL OR b.id = ANY(p_building_ids))
      AND public.can_access_building(b.id)
  ),
  win AS (
    SELECT date_trunc('month', p_start_date)::date AS w_start,
           date_trunc('month', p_end_date)::date AS w_end
  ),
  vouchers AS (
    SELECT voucher.id, voucher.type::text AS side, voucher.voucher_date,
           allowed.id AS bid, allowed.name AS bname, allowed.is_virtual,
           voucher.total_amount, voucher.business_result_accounting AS override,
           CASE
             WHEN voucher.invoice_id IS NOT NULL AND invoice.billing_month ~ '^\d{4}-\d{2}$'
             THEN to_date(invoice.billing_month, 'YYYY-MM')
           END AS inv_month
    FROM allowed
    JOIN public.income_expenses voucher ON voucher.building_id = allowed.id
    LEFT JOIN public.invoices invoice
      ON invoice.id = voucher.invoice_id AND invoice.deleted_at IS NULL
    WHERE voucher.deleted_at IS NULL
      AND voucher.approval_status = 'APPROVED'
      AND voucher.business_result_accounting IS DISTINCT FROM false
  ),
  invoice_items AS (
    SELECT vouchers.inv_month AS m, vouchers.id, vouchers.bid, vouchers.bname,
           vouchers.is_virtual, vouchers.side, type_row.id AS tid,
           type_row.name AS tname, type_row.category,
           COALESCE(item.amount, item.unit_price * item.quantity)::numeric AS amt
    FROM vouchers
    JOIN public.income_expense_items item ON item.income_expense_id = vouchers.id
    JOIN public.income_expense_types type_src ON type_src.id = item.income_expense_type_id
    JOIN public.income_expense_types type_row ON type_row.id = COALESCE(type_src.merged_into_id, type_src.id)
    WHERE vouchers.inv_month IS NOT NULL
      AND (vouchers.override IS TRUE OR item.accounting_class = 'PNL')
  ),
  invoice_no_item AS (
    SELECT vouchers.inv_month AS m, vouchers.id, vouchers.bid, vouchers.bname,
           vouchers.is_virtual, vouchers.side, NULL::uuid AS tid,
           'Không có hạng mục'::text AS tname, NULL::text AS category,
           vouchers.total_amount AS amt
    FROM vouchers
    WHERE vouchers.inv_month IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.income_expense_items item WHERE item.income_expense_id = vouchers.id
      )
  ),
  period_items AS (
    SELECT (date_trunc('month', item.start_date) + (series.i || ' month')::interval)::date AS m,
           vouchers.id, vouchers.bid, vouchers.bname, vouchers.is_virtual, vouchers.side,
           type_row.id AS tid, type_row.name AS tname, type_row.category,
           (round(COALESCE(item.amount, item.unit_price * item.quantity) * (series.i + 1) / count_months.n)
            - round(COALESCE(item.amount, item.unit_price * item.quantity) * series.i / count_months.n))::numeric AS amt
    FROM vouchers
    JOIN public.income_expense_items item ON item.income_expense_id = vouchers.id
    JOIN public.income_expense_types type_src ON type_src.id = item.income_expense_type_id
    JOIN public.income_expense_types type_row ON type_row.id = COALESCE(type_src.merged_into_id, type_src.id)
    CROSS JOIN LATERAL (
      SELECT GREATEST(
        extract(year FROM item.end_date)::int * 12 + extract(month FROM item.end_date)::int
        - extract(year FROM item.start_date)::int * 12 - extract(month FROM item.start_date)::int + 1,
        1
      ) AS n
    ) count_months
    CROSS JOIN LATERAL generate_series(0, count_months.n - 1) AS series(i)
    WHERE vouchers.inv_month IS NULL
      AND (vouchers.override IS TRUE OR item.accounting_class = 'PNL')
      AND item.start_date IS NOT NULL
      AND item.end_date IS NOT NULL
      AND item.end_date >= item.start_date
  ),
  invalid_period_items AS (
    SELECT date_trunc('month', item.start_date)::date AS m,
           vouchers.id, vouchers.bid, vouchers.bname, vouchers.is_virtual, vouchers.side,
           type_row.id AS tid, type_row.name AS tname, type_row.category,
           COALESCE(item.amount, item.unit_price * item.quantity)::numeric AS amt
    FROM vouchers
    JOIN public.income_expense_items item ON item.income_expense_id = vouchers.id
    JOIN public.income_expense_types type_src ON type_src.id = item.income_expense_type_id
    JOIN public.income_expense_types type_row ON type_row.id = COALESCE(type_src.merged_into_id, type_src.id)
    WHERE vouchers.inv_month IS NULL
      AND (vouchers.override IS TRUE OR item.accounting_class = 'PNL')
      AND item.start_date IS NOT NULL
      AND item.end_date IS NOT NULL
      AND item.end_date < item.start_date
  ),
  no_period_items AS (
    SELECT date_trunc('month', vouchers.voucher_date)::date AS m,
           vouchers.id, vouchers.bid, vouchers.bname, vouchers.is_virtual, vouchers.side,
           type_row.id AS tid, type_row.name AS tname, type_row.category,
           COALESCE(item.amount, item.unit_price * item.quantity)::numeric AS amt
    FROM vouchers
    JOIN public.income_expense_items item ON item.income_expense_id = vouchers.id
    JOIN public.income_expense_types type_src ON type_src.id = item.income_expense_type_id
    JOIN public.income_expense_types type_row ON type_row.id = COALESCE(type_src.merged_into_id, type_src.id)
    WHERE vouchers.inv_month IS NULL
      AND (vouchers.override IS TRUE OR item.accounting_class = 'PNL')
      AND (item.start_date IS NULL OR item.end_date IS NULL)
  ),
  no_item AS (
    SELECT date_trunc('month', vouchers.voucher_date)::date AS m,
           vouchers.id, vouchers.bid, vouchers.bname, vouchers.is_virtual, vouchers.side,
           NULL::uuid AS tid, 'Không có hạng mục'::text AS tname,
           NULL::text AS category, vouchers.total_amount AS amt
    FROM vouchers
    WHERE vouchers.inv_month IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.income_expense_items item WHERE item.income_expense_id = vouchers.id
      )
  ),
  unioned AS (
    SELECT * FROM invoice_items
    UNION ALL SELECT * FROM invoice_no_item
    UNION ALL SELECT * FROM period_items
    UNION ALL SELECT * FROM invalid_period_items
    UNION ALL SELECT * FROM no_period_items
    UNION ALL SELECT * FROM no_item
  )
  SELECT unioned.m, unioned.id, unioned.bid, unioned.bname, unioned.is_virtual,
         unioned.side, unioned.tid, unioned.tname, unioned.category, unioned.amt
  FROM unioned, win
  WHERE unioned.m BETWEEN win.w_start AND win.w_end;
$function$;

CREATE OR REPLACE FUNCTION public.copilot_report_expense_ratio_v1(p_organization_id uuid, p_tu date DEFAULT NULL::date, p_den date DEFAULT NULL::date, p_building_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 20)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_buildings uuid[];
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_today date;
  v_den date;
  v_tu date;
  v_thay_han_che boolean;
  v_han_che bigint := 0;
  v_tong_hop jsonb;
  v_thang jsonb;
  v_rows jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;
  IF p_tu IS NOT NULL AND p_den IS NOT NULL AND p_tu > p_den THEN
    RAISE EXCEPTION 'invalid_date_window' USING ERRCODE = '22023';
  END IF;

  v_buildings := public.copilot_org_scope_buildings_v1('reports_real_estate.expense_ratio', p_organization_id);
  v_today := public.org_today_v1(p_organization_id);
  v_den := COALESCE(p_den, v_today);
  v_tu := COALESCE(p_tu, (date_trunc('month', v_den) - interval '5 months')::date);
  -- A6: a window wider than three years is refused instead of being answered.
  -- 1096 days = 3 calendar years plus one leap day.
  IF (v_den - v_tu) > 1096 THEN
    RAISE EXCEPTION 'invalid_date_window' USING ERRCODE = '22023';
  END IF;
  IF p_building_id IS NOT NULL AND NOT (p_building_id = ANY(v_buildings)) THEN
    v_buildings := ARRAY[]::uuid[];
  END IF;
  -- Restricted categories need their own permission on top of this report.
  v_thay_han_che := public.can_view_restricted_ie();

  SELECT count(*)
    INTO v_han_che
  FROM public.income_expenses ie
  JOIN public.buildings b
    ON b.id = ie.building_id
   AND b.organization_id = p_organization_id
   AND b.deleted_at IS NULL
   AND b.id = ANY(v_buildings)
  WHERE ie.organization_id = p_organization_id
    AND ie.deleted_at IS NULL
    AND ie.approval_status = 'APPROVED'
    AND ie.voucher_date BETWEEN v_tu AND v_den
    AND (p_building_id IS NULL OR ie.building_id = p_building_id)
    AND COALESCE(ie.has_restricted_item, false)
    AND NOT v_thay_han_che;

  WITH phieu AS (
    SELECT
      ie.id,
      ie.type AS voucher_type,
      ie.total_amount,
      to_char(ie.voucher_date, 'YYYY-MM') AS ky
    FROM public.income_expenses ie
    JOIN public.buildings b
      ON b.id = ie.building_id
     AND b.organization_id = p_organization_id
     AND b.deleted_at IS NULL
     AND b.id = ANY(v_buildings)
    WHERE ie.organization_id = p_organization_id
      AND ie.deleted_at IS NULL
      AND ie.approval_status = 'APPROVED'
      AND ie.voucher_date BETWEEN v_tu AND v_den
      AND (p_building_id IS NULL OR ie.building_id = p_building_id)
      AND (v_thay_han_che OR NOT COALESCE(ie.has_restricted_item, false))
  ),
  thu AS (
    SELECT p.ky, COALESCE(sum(p.total_amount), 0) AS tien
    FROM phieu p
    WHERE p.voucher_type = 'INCOME'
    GROUP BY p.ky
  ),
  chi_muc AS (
    SELECT
      p.ky,
      COALESCE(NULLIF(btrim(COALESCE(t.category, '')), ''), '(chua phan nhom)') AS hang_muc,
      COALESCE(it.amount, 0) AS tien
    FROM phieu p
    JOIN public.income_expense_items it
      ON it.income_expense_id = p.id
     AND it.organization_id = p_organization_id
    JOIN public.income_expense_types t_src
      ON t_src.id = it.income_expense_type_id
    JOIN public.income_expense_types t
      ON t.id = COALESCE(t_src.merged_into_id, t_src.id)
     AND t.organization_id = p_organization_id
     AND t.type = 'expense'
    WHERE p.voucher_type = 'EXPENSE'
  ),
  chi AS (
    SELECT c.ky, sum(c.tien) AS tien
    FROM chi_muc c
    GROUP BY c.ky
  ),
  ky_gop AS (
    SELECT
      COALESCE(thu.ky, chi.ky) AS ky,
      COALESCE(thu.tien, 0) AS thu,
      COALESCE(chi.tien, 0) AS chi
    FROM thu
    FULL OUTER JOIN chi ON chi.ky = thu.ky
  )
  SELECT
    jsonb_build_object(
      'tong_thu', COALESCE(sum(g.thu), 0),
      'tong_chi', COALESCE(sum(g.chi), 0),
      'ty_le_phan_tram', CASE WHEN COALESCE(sum(g.thu), 0) > 0
                              THEN round((COALESCE(sum(g.chi), 0) * 100) / sum(g.thu), 1)
                              ELSE NULL END,
      'phieu_han_che_bi_loai', v_han_che
    ),
    COALESCE((
      SELECT jsonb_agg(
               jsonb_build_object(
                 'ky', g2.ky,
                 'thu', g2.thu,
                 'chi', g2.chi,
                 'ty_le_phan_tram', CASE WHEN g2.thu > 0 THEN round((g2.chi * 100) / g2.thu, 1) ELSE NULL END
               ) ORDER BY g2.ky
             )
      -- DESC inside the cap, ascending for display: cutting at `ORDER BY ky`
      -- would hand back the OLDEST months and drop the ones just asked about.
      FROM (SELECT * FROM ky_gop ORDER BY ky DESC LIMIT v_limit) g2
    ), '[]'::jsonb),
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object('hang_muc', h.hang_muc, 'chi', h.tien) ORDER BY h.tien DESC, h.hang_muc)
      FROM (
        SELECT c.hang_muc, sum(c.tien) AS tien
        FROM chi_muc c
        GROUP BY c.hang_muc
        ORDER BY sum(c.tien) DESC, c.hang_muc
        LIMIT v_limit
      ) h
    ), '[]'::jsonb)
  INTO v_tong_hop, v_thang, v_rows
  FROM ky_gop g;

  RETURN jsonb_build_object(
    'gioi_han', v_limit,
    'so_luong', jsonb_array_length(v_rows),
    'tu', v_tu,
    'den', v_den,
    'tong_hop', COALESCE(v_tong_hop, jsonb_build_object('tong_thu', 0, 'tong_chi', 0, 'ty_le_phan_tram', NULL, 'phieu_han_che_bi_loai', v_han_che)),
    'theo_thang', COALESCE(v_thang, '[]'::jsonb),
    'hang_muc', v_rows
  );
END
$function$;

-- ---------- Kiểm (chỉ đọc catalog) ----------
DO $$
BEGIN
  IF position('merged_into_id' in pg_get_functiondef('public.fa_type_breakdown(date,date,uuid[])'::regprocedure)) = 0
     OR position('merged_into_id' in pg_get_functiondef('public.fa_accrual_allocations(date,date,uuid[])'::regprocedure)) = 0
     OR position('merged_into_id' in pg_get_functiondef('public.copilot_report_expense_ratio_v1(uuid,date,date,uuid,integer)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'danh_muc_chi_bao_cao_cong_gop: hàm báo cáo chưa cộng gộp theo merged_into_id';
  END IF;
END $$;
