-- Copilot read surface, part 5: the REPORT pages — five real-estate reports
-- (vacant rooms, renewals/transfers, terminations, new leases, expense ratio) and
-- five finance reports (daily cashbook, cash flow, payment schedule, overpayment,
-- booking deposits).
--
-- WHY A WRAPPER RPC AND NOT THE PAGE'S OWN QUERY
--   The brief for this task allowed reusing whatever the report page already
--   calls. Ten of the eleven pages call NOTHING reusable: they read
--   `rooms`/`contracts`/`invoices`/`deposits`/`income_expenses` straight through
--   PostgREST from the browser and finish the report in JavaScript (see
--   src/hooks/reports/realEstateReports.ts and .../financeReports.ts). A Copilot
--   tool cannot copy that shape — the tenant boundary of every one of those
--   tables is a JOIN away, and a browser embed has to guess the relation, which
--   is the exact failure measured on 13/08/2026.
--
--   The one page that DOES call RPCs — daily cashbook and cash flow, through
--   `cashflow_by_day_v2` / `cashbook_period_totals_v2` — could not be reused as
--   they stand, for exactly one reason: they resolve their scope from
--   `my_org_ids()`, EVERY company the caller belongs to, not the company the
--   Copilot session has selected. On the screen that is correct, because the
--   screen is already inside one company. Called from a tool whose whole contract
--   is "answer for the organization the user picked", it would silently add
--   another company's cash to the total.
--
--   That is the ONLY thing changed about them here. Everything else those two
--   functions do is reproduced line for line, because it is all load-bearing:
--
--     POSTING TRUTH, NOT VOUCHER TRUTH. The cash rollups read
--     `income_expense_posting_lines` joined to `income_expense_postings` with
--     `event_kind IN ('POSTING','REVERSAL')`, keyed on `posted_on`, and sum
--     `signed_amount` (positives = money in, negatives = money out). The first
--     version of this migration summed `income_expenses.total_amount` filtered
--     `approval_status = 'APPROVED'` on `voucher_date` instead — a SECOND source
--     of truth for the same screen, and a wrong one: a voucher posted and then
--     reversed nets to zero in posting truth and counted in FULL in that version,
--     and a voucher cancelled after posting counted too. `src/hooks/useCashBook.ts`
--     documents that exact two-sources-of-truth bug being deleted from this very
--     screen; re-introducing it behind Copilot would have undone that.
--
--     THE CASHBOOK BOUNDARY. `20260730101000` ("Vá LỖ C: ba RPC tổng hợp sổ quỹ
--     đang rò tồn quỹ") closed a hole where any member could read the exact
--     balance of a cashbook the UI deliberately shows as "—", by ending every
--     aggregate with `pl.account_id IN (SELECT cashbook_id FROM
--     app_private.ie_visible_cashbook_ids_v1())`. A rollup without that predicate
--     re-opens the hole through a new door. Both functions below carry it, AND
--     intersect it with `app_private.copilot_scope_cashbooks_v1('cashbooks.view',
--     p_organization_id)` — the same RBAC cashbook scope `copilot_cashbook_
--     settlement_v2` (tool `so_quy`) already uses, and the piece that binds the
--     answer to the SELECTED organization. The two sets answer different
--     questions (may you read this cashbook's money · is this cashbook inside the
--     scope you were granted in THIS company), so both are applied.
--
-- RESTRICTED CATEGORIES ARE A THIRD BOUNDARY
--   `income_expenses.has_restricted_item` marks vouchers whose categories need
--   `income_expenses.restricted_view` on top of the report permission. The three
--   money rollups below exclude them for a caller without that permission — and
--   then REPORT how many were excluded (`phieu_han_che_bi_loai`), so the answer
--   can say the total is partial instead of presenting a short number as the
--   whole truth. Dropping them silently was the easy choice and the wrong one.
--
-- TODAY IS THE ORGANIZATION'S TODAY
--   No bare `CURRENT_DATE` anywhere below. The server runs UTC and the data lives
--   at UTC+7, so between 00:00 and 07:00 Vietnam time `CURRENT_DATE` is still
--   YESTERDAY — which would move an invoice in and out of "overdue" depending on
--   the hour the question is asked. `20260731070000` converted 78 call sites to
--   `public.org_today_v1(<org>)` for that reason; these functions use the same
--   form, resolved once per call after the permission check.
--
-- LIMITS
--   Every function clamps `p_limit` to 1..50 and echoes the clamped value, and
--   every total is aggregated over the WHOLE match set in a separate pass, never
--   over the list that was just truncated.
--
-- READ-ONLY BY CONSTRUCTION
--   All ten are STABLE. None writes, approves, posts or cancels anything.
--
-- ACCEPTANCE IS CATALOG-ONLY
--   The closing block reads `pg_proc`/ACL only, so this migration also runs on an
--   empty database (Restore Drill replays it onto a schema-only baseline).
BEGIN;
SET LOCAL lock_timeout = '15s';

-- The accent-folding helper is NOT redefined here: 20260902193151 chose it once,
-- from the catalog, and two places deciding the same thing eventually disagree.

-- 1. Vacant rooms (bao cao phong trong) --------------------------------------
CREATE OR REPLACE FUNCTION public.copilot_report_vacant_rooms_v1(
  p_organization_id uuid,
  p_building_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 20
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_buildings uuid[];
  v_today date;
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_tong_hop jsonb;
  v_rows jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;

  -- Validates organization, membership, permission and denies. Never trusted input.
  v_buildings := public.copilot_org_scope_buildings_v1('reports_real_estate.vacant_rooms', p_organization_id);
  v_today := public.org_today_v1(p_organization_id);
  -- A building outside the caller scope answers like an empty report, never like
  -- "exists but not yours".
  IF p_building_id IS NOT NULL AND NOT (p_building_id = ANY(v_buildings)) THEN
    v_buildings := ARRAY[]::uuid[];
  END IF;

  WITH trong AS (
    SELECT
      rm.id,
      rm.name AS room_name,
      rm.floor,
      rm.area,
      rm.rent_price,
      rm.status::text AS room_status,
      b.name AS building_name,
      ket.effective_end
    FROM public.rooms rm
    JOIN public.buildings b
      ON b.id = rm.building_id
     AND b.organization_id = p_organization_id
     AND b.deleted_at IS NULL
     AND b.id = ANY(v_buildings)
    LEFT JOIN LATERAL (
      SELECT max(COALESCE(ct.actual_end_date, ct.end_date)) AS effective_end
      FROM public.contracts ct
      WHERE ct.room_id = rm.id
        AND ct.organization_id = p_organization_id
        AND ct.deleted_at IS NULL
        AND ct.status IN ('TERMINATED', 'EXPIRED')
    ) ket ON true
    WHERE rm.organization_id = p_organization_id
      AND rm.deleted_at IS NULL
      AND rm.status::text <> 'RESERVED'
      AND (p_building_id IS NULL OR rm.building_id = p_building_id)
      AND NOT EXISTS (
        SELECT 1
        FROM public.contracts ct2
        WHERE ct2.room_id = rm.id
          AND ct2.organization_id = p_organization_id
          AND ct2.deleted_at IS NULL
          AND ct2.status = 'ACTIVE'
      )
  )
  SELECT
    jsonb_build_object(
      'so_phong_trong', count(*),
      'tien_thue_bo_lo', COALESCE(sum(t.rent_price), 0),
      'so_toa', count(DISTINCT t.building_name)
    ),
    COALESCE((
      SELECT jsonb_agg(
               jsonb_build_object(
                 'phong_id', s.id,
                 'phong', s.room_name,
                 'toa_nha', s.building_name,
                 'tang', s.floor,
                 'dien_tich', s.area,
                 'gia_thue', s.rent_price,
                 'tinh_trang', s.room_status,
                 'trong_tu', s.effective_end,
                 'so_ngay_trong', CASE
                                    WHEN s.effective_end IS NULL THEN NULL
                                    ELSE (v_today - s.effective_end)
                                  END
               ) ORDER BY s.rn
             )
      FROM (
        SELECT
          t2.*,
          row_number() OVER (
            ORDER BY t2.effective_end NULLS LAST, t2.building_name, t2.room_name
          ) AS rn
        FROM trong t2
        ORDER BY t2.effective_end NULLS LAST, t2.building_name, t2.room_name
        LIMIT v_limit
      ) s
    ), '[]'::jsonb)
  INTO v_tong_hop, v_rows
  FROM trong t;

  RETURN jsonb_build_object(
    'gioi_han', v_limit,
    'so_luong', jsonb_array_length(v_rows),
    'tong_hop', COALESCE(v_tong_hop, jsonb_build_object('so_phong_trong', 0, 'tien_thue_bo_lo', 0, 'so_toa', 0)),
    'phong', v_rows
  );
END
$fn$;

-- 2. Renewals and transfers (gia han · chuyen nhuong) ------------------------
CREATE OR REPLACE FUNCTION public.copilot_report_renewals_v1(
  p_organization_id uuid,
  p_tu date DEFAULT NULL,
  p_den date DEFAULT NULL,
  p_limit integer DEFAULT 20
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_buildings uuid[];
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_tong_hop jsonb;
  v_rows jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;
  IF p_tu IS NOT NULL AND p_den IS NOT NULL AND p_tu > p_den THEN
    RAISE EXCEPTION 'invalid_date_window' USING ERRCODE = '22023';
  END IF;

  v_buildings := public.copilot_org_scope_buildings_v1('reports_real_estate.renewals_transfers', p_organization_id);

  WITH su_kien AS (
    SELECT
      'RENEWAL'::text AS loai,
      ct.contract_number,
      rep.customer_name,
      rm.name AS room_name,
      b.name AS building_name,
      ex.extension_date AS ngay,
      COALESCE(ex.new_rent_price, ct.rent_price) AS rent_price,
      ex.new_end_date AS ngay_ket_thuc_moi
    FROM public.contract_extensions ex
    JOIN public.contracts ct
      ON ct.id = ex.contract_id
     AND ct.organization_id = p_organization_id
     AND ct.deleted_at IS NULL
    JOIN public.rooms rm
      ON rm.id = ct.room_id
     AND rm.organization_id = p_organization_id
     AND rm.deleted_at IS NULL
    JOIN public.buildings b
      ON b.id = rm.building_id
     AND b.organization_id = p_organization_id
     AND b.deleted_at IS NULL
     AND b.id = ANY(v_buildings)
    LEFT JOIN LATERAL (
      SELECT cst.full_name AS customer_name
      FROM public.contract_customers cc
      JOIN public.customers cst
        ON cst.id = cc.customer_id
       AND cst.organization_id = p_organization_id
       AND cst.deleted_at IS NULL
      WHERE cc.contract_id = ct.id
        AND cc.organization_id = p_organization_id
      ORDER BY cc.is_representative DESC, cc.created_at
      LIMIT 1
    ) rep ON true
    WHERE ex.organization_id = p_organization_id
      AND ex.status::text IN ('APPROVED', 'COMPLETED')
      AND (p_tu IS NULL OR ex.extension_date >= p_tu)
      AND (p_den IS NULL OR ex.extension_date <= p_den)

    UNION ALL

    SELECT
      'TRANSFER'::text AS loai,
      ct.contract_number,
      rep.customer_name,
      rm.name AS room_name,
      b.name AS building_name,
      ct.start_date AS ngay,
      ct.rent_price,
      ct.end_date AS ngay_ket_thuc_moi
    FROM public.contracts ct
    JOIN public.rooms rm
      ON rm.id = ct.room_id
     AND rm.organization_id = p_organization_id
     AND rm.deleted_at IS NULL
    JOIN public.buildings b
      ON b.id = rm.building_id
     AND b.organization_id = p_organization_id
     AND b.deleted_at IS NULL
     AND b.id = ANY(v_buildings)
    LEFT JOIN LATERAL (
      SELECT cst.full_name AS customer_name
      FROM public.contract_customers cc
      JOIN public.customers cst
        ON cst.id = cc.customer_id
       AND cst.organization_id = p_organization_id
       AND cst.deleted_at IS NULL
      WHERE cc.contract_id = ct.id
        AND cc.organization_id = p_organization_id
      ORDER BY cc.is_representative DESC, cc.created_at
      LIMIT 1
    ) rep ON true
    WHERE ct.organization_id = p_organization_id
      AND ct.deleted_at IS NULL
      AND ct.status = 'TRANSFERRED'
      AND (p_tu IS NULL OR ct.start_date >= p_tu)
      AND (p_den IS NULL OR ct.start_date <= p_den)
  )
  SELECT
    jsonb_build_object(
      'so_su_kien', count(*),
      'so_gia_han', count(*) FILTER (WHERE k.loai = 'RENEWAL'),
      'so_chuyen_nhuong', count(*) FILTER (WHERE k.loai = 'TRANSFER'),
      'tong_tien_thue', COALESCE(sum(k.rent_price), 0)
    ),
    COALESCE((
      SELECT jsonb_agg(
               jsonb_build_object(
                 'loai', s.loai,
                 'so_hop_dong', s.contract_number,
                 'khach_hang', s.customer_name,
                 'phong', s.room_name,
                 'toa_nha', s.building_name,
                 'ngay', s.ngay,
                 'tien_thue', s.rent_price,
                 'ngay_ket_thuc_moi', s.ngay_ket_thuc_moi
               ) ORDER BY s.rn
             )
      FROM (
        SELECT k2.*, row_number() OVER (ORDER BY k2.ngay DESC NULLS LAST, k2.contract_number NULLS LAST) AS rn
        FROM su_kien k2
        ORDER BY k2.ngay DESC NULLS LAST, k2.contract_number NULLS LAST
        LIMIT v_limit
      ) s
    ), '[]'::jsonb)
  INTO v_tong_hop, v_rows
  FROM su_kien k;

  RETURN jsonb_build_object(
    'gioi_han', v_limit,
    'so_luong', jsonb_array_length(v_rows),
    'tong_hop', COALESCE(v_tong_hop, jsonb_build_object('so_su_kien', 0, 'so_gia_han', 0, 'so_chuyen_nhuong', 0, 'tong_tien_thue', 0)),
    'su_kien', v_rows
  );
END
$fn$;

-- 3. Terminations (thanh ly · het han) ---------------------------------------
CREATE OR REPLACE FUNCTION public.copilot_report_terminations_v1(
  p_organization_id uuid,
  p_tu date DEFAULT NULL,
  p_den date DEFAULT NULL,
  p_limit integer DEFAULT 20
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_buildings uuid[];
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_mau_so bigint := 0;
  v_tong_hop jsonb;
  v_rows jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;
  IF p_tu IS NOT NULL AND p_den IS NOT NULL AND p_tu > p_den THEN
    RAISE EXCEPTION 'invalid_date_window' USING ERRCODE = '22023';
  END IF;

  v_buildings := public.copilot_org_scope_buildings_v1('reports_real_estate.terminations', p_organization_id);

  -- Denominator of the termination rate: contracts that ever went live, inside
  -- the SAME building scope as the numerator. Counting every contract of the
  -- company against a building-scoped numerator would understate the rate for
  -- every building-scoped reader.
  SELECT count(*)
    INTO v_mau_so
  FROM public.contracts ct
  JOIN public.rooms rm
    ON rm.id = ct.room_id
   AND rm.organization_id = p_organization_id
   AND rm.deleted_at IS NULL
  JOIN public.buildings b
    ON b.id = rm.building_id
   AND b.organization_id = p_organization_id
   AND b.deleted_at IS NULL
   AND b.id = ANY(v_buildings)
  WHERE ct.organization_id = p_organization_id
    AND ct.deleted_at IS NULL
    AND ct.status <> 'DRAFT';

  WITH ket_thuc AS (
    SELECT
      ct.id,
      ct.contract_number,
      rep.customer_name,
      rm.name AS room_name,
      b.name AS building_name,
      ct.start_date,
      COALESCE(ct.actual_end_date, ct.end_date) AS effective_end,
      ct.status::text AS contract_status,
      ct.rent_price,
      ct.total_deposit,
      tm.termination_type,
      tm.refund_amount
    FROM public.contracts ct
    JOIN public.rooms rm
      ON rm.id = ct.room_id
     AND rm.organization_id = p_organization_id
     AND rm.deleted_at IS NULL
    JOIN public.buildings b
      ON b.id = rm.building_id
     AND b.organization_id = p_organization_id
     AND b.deleted_at IS NULL
     AND b.id = ANY(v_buildings)
    LEFT JOIN LATERAL (
      SELECT t.termination_type, t.refund_amount
      FROM public.contract_terminations t
      WHERE t.contract_id = ct.id
        AND t.organization_id = p_organization_id
      ORDER BY t.termination_date DESC NULLS LAST, t.created_at DESC
      LIMIT 1
    ) tm ON true
    LEFT JOIN LATERAL (
      SELECT cst.full_name AS customer_name
      FROM public.contract_customers cc
      JOIN public.customers cst
        ON cst.id = cc.customer_id
       AND cst.organization_id = p_organization_id
       AND cst.deleted_at IS NULL
      WHERE cc.contract_id = ct.id
        AND cc.organization_id = p_organization_id
      ORDER BY cc.is_representative DESC, cc.created_at
      LIMIT 1
    ) rep ON true
    WHERE ct.organization_id = p_organization_id
      AND ct.deleted_at IS NULL
      AND ct.status IN ('TERMINATED', 'EXPIRED')
      AND COALESCE(ct.actual_end_date, ct.end_date) IS NOT NULL
      AND (p_tu IS NULL OR COALESCE(ct.actual_end_date, ct.end_date) >= p_tu)
      AND (p_den IS NULL OR COALESCE(ct.actual_end_date, ct.end_date) <= p_den)
  )
  SELECT
    jsonb_build_object(
      'so_ca', count(*),
      'so_thanh_ly', count(*) FILTER (WHERE k.contract_status = 'TERMINATED'),
      'so_het_han', count(*) FILTER (WHERE k.contract_status = 'EXPIRED'),
      'tong_hoan_coc', COALESCE(sum(k.refund_amount), 0),
      'mau_so_hop_dong', v_mau_so,
      'ty_le_phan_tram', CASE WHEN v_mau_so > 0 THEN round((count(*)::numeric * 100) / v_mau_so, 1) ELSE 0 END
    ),
    COALESCE((
      SELECT jsonb_agg(
               jsonb_build_object(
                 'hop_dong_id', s.id,
                 'so_hop_dong', s.contract_number,
                 'khach_hang', s.customer_name,
                 'phong', s.room_name,
                 'toa_nha', s.building_name,
                 'ngay_ket_thuc', s.effective_end,
                 'trang_thai', s.contract_status,
                 'kieu_ket_thuc', s.termination_type,
                 'tien_thue', s.rent_price,
                 'hoan_coc', s.refund_amount,
                 'so_ngay_o', CASE
                                WHEN s.start_date IS NULL THEN NULL
                                ELSE (s.effective_end - s.start_date)
                              END
               ) ORDER BY s.rn
             )
      FROM (
        SELECT k2.*, row_number() OVER (ORDER BY k2.effective_end DESC, k2.contract_number NULLS LAST) AS rn
        FROM ket_thuc k2
        ORDER BY k2.effective_end DESC, k2.contract_number NULLS LAST
        LIMIT v_limit
      ) s
    ), '[]'::jsonb)
  INTO v_tong_hop, v_rows
  FROM ket_thuc k;

  RETURN jsonb_build_object(
    'gioi_han', v_limit,
    'so_luong', jsonb_array_length(v_rows),
    'tong_hop', COALESCE(v_tong_hop, jsonb_build_object('so_ca', 0, 'so_thanh_ly', 0, 'so_het_han', 0, 'tong_hoan_coc', 0, 'mau_so_hop_dong', v_mau_so, 'ty_le_phan_tram', 0)),
    'ca', v_rows
  );
END
$fn$;

-- 4. New leases (hop dong moi ky) --------------------------------------------
CREATE OR REPLACE FUNCTION public.copilot_report_new_leases_v1(
  p_organization_id uuid,
  p_tu date DEFAULT NULL,
  p_den date DEFAULT NULL,
  p_limit integer DEFAULT 20
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_buildings uuid[];
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_tong_hop jsonb;
  v_rows jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;
  IF p_tu IS NOT NULL AND p_den IS NOT NULL AND p_tu > p_den THEN
    RAISE EXCEPTION 'invalid_date_window' USING ERRCODE = '22023';
  END IF;

  v_buildings := public.copilot_org_scope_buildings_v1('reports_real_estate.new_leases', p_organization_id);

  WITH moi AS (
    SELECT
      ct.id,
      ct.contract_number,
      rep.customer_name,
      rm.name AS room_name,
      b.name AS building_name,
      ct.signed_date,
      ct.start_date,
      ct.end_date,
      ct.status::text AS contract_status,
      ct.rent_price,
      ct.total_deposit,
      ct.payment_cycle::text AS payment_cycle,
      GREATEST(1, round((ct.end_date - ct.start_date)::numeric / 30)) AS so_thang
    FROM public.contracts ct
    JOIN public.rooms rm
      ON rm.id = ct.room_id
     AND rm.organization_id = p_organization_id
     AND rm.deleted_at IS NULL
    JOIN public.buildings b
      ON b.id = rm.building_id
     AND b.organization_id = p_organization_id
     AND b.deleted_at IS NULL
     AND b.id = ANY(v_buildings)
    LEFT JOIN LATERAL (
      SELECT cst.full_name AS customer_name
      FROM public.contract_customers cc
      JOIN public.customers cst
        ON cst.id = cc.customer_id
       AND cst.organization_id = p_organization_id
       AND cst.deleted_at IS NULL
      WHERE cc.contract_id = ct.id
        AND cc.organization_id = p_organization_id
      ORDER BY cc.is_representative DESC, cc.created_at
      LIMIT 1
    ) rep ON true
    WHERE ct.organization_id = p_organization_id
      AND ct.deleted_at IS NULL
      AND ct.signed_date IS NOT NULL
      AND (p_tu IS NULL OR ct.signed_date >= p_tu)
      AND (p_den IS NULL OR ct.signed_date <= p_den)
  )
  SELECT
    jsonb_build_object(
      'so_hop_dong', count(*),
      'tong_tien_thue_thang', COALESCE(sum(m.rent_price), 0),
      'tong_coc', COALESCE(sum(m.total_deposit), 0),
      'tong_gia_tri', COALESCE(sum(m.rent_price * m.so_thang), 0)
    ),
    COALESCE((
      SELECT jsonb_agg(
               jsonb_build_object(
                 'hop_dong_id', s.id,
                 'so_hop_dong', s.contract_number,
                 'khach_hang', s.customer_name,
                 'phong', s.room_name,
                 'toa_nha', s.building_name,
                 'ngay_ky', s.signed_date,
                 'ngay_bat_dau', s.start_date,
                 'ngay_ket_thuc', s.end_date,
                 'trang_thai', s.contract_status,
                 'tien_thue', s.rent_price,
                 'tien_coc', s.total_deposit,
                 'chu_ky_thanh_toan', s.payment_cycle,
                 'so_thang', s.so_thang
               ) ORDER BY s.rn
             )
      FROM (
        SELECT m2.*, row_number() OVER (ORDER BY m2.signed_date DESC, m2.contract_number NULLS LAST) AS rn
        FROM moi m2
        ORDER BY m2.signed_date DESC, m2.contract_number NULLS LAST
        LIMIT v_limit
      ) s
    ), '[]'::jsonb)
  INTO v_tong_hop, v_rows
  FROM moi m;

  RETURN jsonb_build_object(
    'gioi_han', v_limit,
    'so_luong', jsonb_array_length(v_rows),
    'tong_hop', COALESCE(v_tong_hop, jsonb_build_object('so_hop_dong', 0, 'tong_tien_thue_thang', 0, 'tong_coc', 0, 'tong_gia_tri', 0)),
    'hop_dong', v_rows
  );
END
$fn$;

-- 5. Expense ratio over revenue (ty le chi phi) ------------------------------
CREATE OR REPLACE FUNCTION public.copilot_report_expense_ratio_v1(
  p_organization_id uuid,
  p_tu date DEFAULT NULL,
  p_den date DEFAULT NULL,
  p_building_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 20
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
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
    JOIN public.income_expense_types t
      ON t.id = it.income_expense_type_id
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
$fn$;

-- 6. Daily cashbook (so quy theo ngay) ---------------------------------------
--
-- Source, signs, event kinds and the cashbook predicate all follow
-- `public.cashflow_by_day_v2` (20260730101000) exactly; see the header for why
-- none of that was re-invented. What changes is the tenant bound: the selected
-- organization instead of `my_org_ids()`.
CREATE OR REPLACE FUNCTION public.copilot_report_daily_cashbook_v1(
  p_organization_id uuid,
  p_tu date,
  p_den date,
  p_building_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 20
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_buildings uuid[];
  v_cashbooks uuid[];
  v_org_wide boolean := false;
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_thay_han_che boolean;
  v_han_che bigint := 0;
  v_tong_hop jsonb;
  v_rows jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;
  IF p_tu IS NULL OR p_den IS NULL OR p_tu > p_den THEN
    RAISE EXCEPTION 'invalid_date_window' USING ERRCODE = '22023';
  END IF;

  v_buildings := public.copilot_org_scope_buildings_v1('reports_finance.daily_cashbook', p_organization_id);
  IF p_building_id IS NOT NULL AND NOT (p_building_id = ANY(v_buildings)) THEN
    v_buildings := ARRAY[]::uuid[];
  END IF;
  SELECT COALESCE(s.org_wide, false) INTO v_org_wide
  FROM app_private.authorized_scope_v3('reports_finance.daily_cashbook', p_organization_id) s;
  -- Cashbook boundary, both halves. See the header.
  v_cashbooks := app_private.copilot_scope_cashbooks_v1('cashbooks.view', p_organization_id);
  v_thay_han_che := public.can_view_restricted_ie();

  WITH dong AS (
    SELECT
      p.posted_on AS ngay,
      pl.signed_amount,
      p.voucher_id,
      COALESCE(ie.has_restricted_item, false) AS han_che
    FROM public.income_expense_posting_lines pl
    JOIN public.income_expense_postings p
      ON p.id = pl.posting_id
     AND p.organization_id = pl.organization_id
    LEFT JOIN public.income_expenses ie
      ON ie.id = p.voucher_id
     AND ie.organization_id = p_organization_id
    LEFT JOIN public.buildings b
      ON b.id = ie.building_id
     AND b.organization_id = p_organization_id
     AND b.deleted_at IS NULL
     AND b.id = ANY(v_buildings)
    WHERE pl.organization_id = p_organization_id
      AND p.event_kind IN ('POSTING', 'REVERSAL')
      AND p.posted_on BETWEEN p_tu AND p_den
      AND pl.account_id = ANY(v_cashbooks)
      AND pl.account_id IN (SELECT v.cashbook_id FROM app_private.ie_visible_cashbook_ids_v1() v)
      AND (p_building_id IS NULL OR ie.building_id = p_building_id)
      AND (b.id IS NOT NULL OR (ie.building_id IS NULL AND v_org_wide))
  ),
  theo_ngay AS (
    SELECT
      d.ngay,
      COALESCE(sum(d.signed_amount) FILTER (WHERE d.signed_amount > 0), 0) AS thu,
      COALESCE(sum(-d.signed_amount) FILTER (WHERE d.signed_amount < 0), 0) AS chi
    FROM dong d
    WHERE (v_thay_han_che OR NOT d.han_che)
    GROUP BY d.ngay
  ),
  han_che AS (
    SELECT count(DISTINCT d.voucher_id) AS n
    FROM dong d
    WHERE d.han_che AND NOT v_thay_han_che
  )
  SELECT
    jsonb_build_object(
      'so_ngay_co_phat_sinh', count(*),
      'tong_thu', COALESCE(sum(t.thu), 0),
      'tong_chi', COALESCE(sum(t.chi), 0),
      'rong', COALESCE(sum(t.thu), 0) - COALESCE(sum(t.chi), 0),
      'phieu_han_che_bi_loai', (SELECT hc.n FROM han_che hc)
    ),
    COALESCE((
      SELECT jsonb_agg(
               jsonb_build_object('ngay', d2.ngay, 'thu', d2.thu, 'chi', d2.chi, 'rong', d2.thu - d2.chi)
               ORDER BY d2.ngay DESC
             )
      FROM (SELECT * FROM theo_ngay ORDER BY ngay DESC LIMIT v_limit) d2
    ), '[]'::jsonb),
    (SELECT hc.n FROM han_che hc)
  INTO v_tong_hop, v_rows, v_han_che
  FROM theo_ngay t;

  RETURN jsonb_build_object(
    'gioi_han', v_limit,
    'so_luong', jsonb_array_length(v_rows),
    'tu', p_tu,
    'den', p_den,
    'tong_hop', COALESCE(v_tong_hop, jsonb_build_object('so_ngay_co_phat_sinh', 0, 'tong_thu', 0, 'tong_chi', 0, 'rong', 0, 'phieu_han_che_bi_loai', COALESCE(v_han_che, 0))),
    'theo_ngay', v_rows
  );
END
$fn$;

-- 7. Cash flow rolled up by month (dong tien theo ky) ------------------------
--
-- Same source and same boundaries as 6; only the grouping key differs.
CREATE OR REPLACE FUNCTION public.copilot_report_cash_flow_v1(
  p_organization_id uuid,
  p_tu date,
  p_den date,
  p_building_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 20
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_buildings uuid[];
  v_cashbooks uuid[];
  v_org_wide boolean := false;
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_thay_han_che boolean;
  v_han_che bigint := 0;
  v_tong_hop jsonb;
  v_rows jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;
  IF p_tu IS NULL OR p_den IS NULL OR p_tu > p_den THEN
    RAISE EXCEPTION 'invalid_date_window' USING ERRCODE = '22023';
  END IF;

  v_buildings := public.copilot_org_scope_buildings_v1('reports_finance.cash_flow', p_organization_id);
  IF p_building_id IS NOT NULL AND NOT (p_building_id = ANY(v_buildings)) THEN
    v_buildings := ARRAY[]::uuid[];
  END IF;
  SELECT COALESCE(s.org_wide, false) INTO v_org_wide
  FROM app_private.authorized_scope_v3('reports_finance.cash_flow', p_organization_id) s;
  v_cashbooks := app_private.copilot_scope_cashbooks_v1('cashbooks.view', p_organization_id);
  v_thay_han_che := public.can_view_restricted_ie();

  WITH dong AS (
    SELECT
      to_char(p.posted_on, 'YYYY-MM') AS ky,
      pl.signed_amount,
      p.voucher_id,
      COALESCE(ie.has_restricted_item, false) AS han_che
    FROM public.income_expense_posting_lines pl
    JOIN public.income_expense_postings p
      ON p.id = pl.posting_id
     AND p.organization_id = pl.organization_id
    LEFT JOIN public.income_expenses ie
      ON ie.id = p.voucher_id
     AND ie.organization_id = p_organization_id
    LEFT JOIN public.buildings b
      ON b.id = ie.building_id
     AND b.organization_id = p_organization_id
     AND b.deleted_at IS NULL
     AND b.id = ANY(v_buildings)
    WHERE pl.organization_id = p_organization_id
      AND p.event_kind IN ('POSTING', 'REVERSAL')
      AND p.posted_on BETWEEN p_tu AND p_den
      AND pl.account_id = ANY(v_cashbooks)
      AND pl.account_id IN (SELECT v.cashbook_id FROM app_private.ie_visible_cashbook_ids_v1() v)
      AND (p_building_id IS NULL OR ie.building_id = p_building_id)
      AND (b.id IS NOT NULL OR (ie.building_id IS NULL AND v_org_wide))
  ),
  theo_thang AS (
    SELECT
      d.ky,
      COALESCE(sum(d.signed_amount) FILTER (WHERE d.signed_amount > 0), 0) AS thu,
      COALESCE(sum(-d.signed_amount) FILTER (WHERE d.signed_amount < 0), 0) AS chi
    FROM dong d
    WHERE (v_thay_han_che OR NOT d.han_che)
    GROUP BY d.ky
  ),
  han_che AS (
    SELECT count(DISTINCT d.voucher_id) AS n
    FROM dong d
    WHERE d.han_che AND NOT v_thay_han_che
  )
  SELECT
    jsonb_build_object(
      'so_ky', count(*),
      'tong_thu', COALESCE(sum(m.thu), 0),
      'tong_chi', COALESCE(sum(m.chi), 0),
      'rong', COALESCE(sum(m.thu), 0) - COALESCE(sum(m.chi), 0),
      'phieu_han_che_bi_loai', (SELECT hc.n FROM han_che hc)
    ),
    COALESCE((
      SELECT jsonb_agg(
               jsonb_build_object('ky', m2.ky, 'thu', m2.thu, 'chi', m2.chi, 'rong', m2.thu - m2.chi)
               ORDER BY m2.ky
             )
      -- DESC inside the cap, ascending for display. Cutting at `ORDER BY ky`
      -- returned the OLDEST months of a twelve-month window and dropped the ones
      -- the question was about.
      FROM (SELECT * FROM theo_thang ORDER BY ky DESC LIMIT v_limit) m2
    ), '[]'::jsonb),
    (SELECT hc.n FROM han_che hc)
  INTO v_tong_hop, v_rows, v_han_che
  FROM theo_thang m;

  RETURN jsonb_build_object(
    'gioi_han', v_limit,
    'so_luong', jsonb_array_length(v_rows),
    'tu', p_tu,
    'den', p_den,
    'tong_hop', COALESCE(v_tong_hop, jsonb_build_object('so_ky', 0, 'tong_thu', 0, 'tong_chi', 0, 'rong', 0, 'phieu_han_che_bi_loai', COALESCE(v_han_che, 0))),
    'theo_thang', v_rows
  );
END
$fn$;

-- 8. Payment schedule (lich thu tien) ----------------------------------------
CREATE OR REPLACE FUNCTION public.copilot_report_payment_schedule_v1(
  p_organization_id uuid,
  p_so_ngay integer DEFAULT 30,
  p_limit integer DEFAULT 20
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_buildings uuid[];
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_so_ngay integer := least(greatest(coalesce(p_so_ngay, 30), 1), 365);
  v_today date;
  v_den date;
  v_tong_hop jsonb;
  v_rows jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;

  v_buildings := public.copilot_org_scope_buildings_v1('reports_finance.payment_schedule', p_organization_id);
  v_today := public.org_today_v1(p_organization_id);
  v_den := v_today + v_so_ngay;

  WITH lich AS (
    SELECT
      i.id,
      i.invoice_number,
      i.billing_month,
      i.due_date,
      i.total_amount,
      i.paid_amount,
      COALESCE(i.remaining_amount, i.total_amount - COALESCE(i.paid_amount, 0)) AS con_lai,
      i.status::text AS invoice_status,
      rm.name AS room_name,
      b.name AS building_name,
      rep.customer_name
    FROM public.invoices i
    JOIN public.buildings b
      ON b.id = i.building_id
     AND b.organization_id = p_organization_id
     AND b.deleted_at IS NULL
     AND b.id = ANY(v_buildings)
    LEFT JOIN public.rooms rm
      ON rm.id = i.room_id
     AND rm.organization_id = p_organization_id
     AND rm.deleted_at IS NULL
    LEFT JOIN LATERAL (
      SELECT cst.full_name AS customer_name
      FROM public.contract_customers cc
      JOIN public.customers cst
        ON cst.id = cc.customer_id
       AND cst.organization_id = p_organization_id
       AND cst.deleted_at IS NULL
      WHERE cc.contract_id = i.contract_id
        AND cc.organization_id = p_organization_id
      ORDER BY cc.is_representative DESC, cc.created_at
      LIMIT 1
    ) rep ON true
    WHERE i.organization_id = p_organization_id
      AND i.deleted_at IS NULL
      AND i.status::text <> 'CANCELLED'
      AND i.due_date IS NOT NULL
      AND i.due_date <= v_den
      AND COALESCE(i.remaining_amount, i.total_amount - COALESCE(i.paid_amount, 0)) > 0
  )
  SELECT
    jsonb_build_object(
      'so_hoa_don', count(*),
      'tong_phai_thu', COALESCE(sum(l.total_amount), 0),
      'tong_con_lai', COALESCE(sum(l.con_lai), 0),
      'so_qua_han', count(*) FILTER (WHERE l.due_date < v_today),
      'con_lai_qua_han', COALESCE(sum(l.con_lai) FILTER (WHERE l.due_date < v_today), 0)
    ),
    COALESCE((
      SELECT jsonb_agg(
               jsonb_build_object(
                 'hoa_don_id', s.id,
                 'so_hoa_don', s.invoice_number,
                 'ky', s.billing_month,
                 'han_thanh_toan', s.due_date,
                 'so_ngay_con_lai', (s.due_date - v_today),
                 'tong_tien', s.total_amount,
                 'da_tra', s.paid_amount,
                 'con_lai', s.con_lai,
                 'trang_thai', s.invoice_status,
                 'phong', s.room_name,
                 'toa_nha', s.building_name,
                 'khach_hang', s.customer_name
               ) ORDER BY s.rn
             )
      FROM (
        SELECT l2.*, row_number() OVER (ORDER BY l2.due_date, l2.invoice_number NULLS LAST) AS rn
        FROM lich l2
        ORDER BY l2.due_date, l2.invoice_number NULLS LAST
        LIMIT v_limit
      ) s
    ), '[]'::jsonb)
  INTO v_tong_hop, v_rows
  FROM lich l;

  RETURN jsonb_build_object(
    'gioi_han', v_limit,
    'so_ngay', v_so_ngay,
    'so_luong', jsonb_array_length(v_rows),
    'tong_hop', COALESCE(v_tong_hop, jsonb_build_object('so_hoa_don', 0, 'tong_phai_thu', 0, 'tong_con_lai', 0, 'so_qua_han', 0, 'con_lai_qua_han', 0)),
    'hoa_don', v_rows
  );
END
$fn$;

-- 9. Overpayment (tien khach tra thua) ---------------------------------------
CREATE OR REPLACE FUNCTION public.copilot_report_overpayment_v1(
  p_organization_id uuid,
  p_limit integer DEFAULT 20
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_buildings uuid[];
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_tong_hop jsonb;
  v_rows jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;

  v_buildings := public.copilot_org_scope_buildings_v1('reports_finance.overpayment', p_organization_id);

  WITH thua AS (
    SELECT
      i.id,
      i.invoice_number,
      i.billing_month,
      i.total_amount,
      i.paid_amount,
      (COALESCE(i.paid_amount, 0) - i.total_amount) AS thu_thua,
      rm.name AS room_name,
      b.name AS building_name,
      rep.customer_name
    FROM public.invoices i
    JOIN public.buildings b
      ON b.id = i.building_id
     AND b.organization_id = p_organization_id
     AND b.deleted_at IS NULL
     AND b.id = ANY(v_buildings)
    LEFT JOIN public.rooms rm
      ON rm.id = i.room_id
     AND rm.organization_id = p_organization_id
     AND rm.deleted_at IS NULL
    LEFT JOIN LATERAL (
      SELECT cst.full_name AS customer_name
      FROM public.contract_customers cc
      JOIN public.customers cst
        ON cst.id = cc.customer_id
       AND cst.organization_id = p_organization_id
       AND cst.deleted_at IS NULL
      WHERE cc.contract_id = i.contract_id
        AND cc.organization_id = p_organization_id
      ORDER BY cc.is_representative DESC, cc.created_at
      LIMIT 1
    ) rep ON true
    WHERE i.organization_id = p_organization_id
      AND i.deleted_at IS NULL
      AND COALESCE(i.paid_amount, 0) > i.total_amount
  )
  SELECT
    jsonb_build_object(
      'so_hoa_don', count(*),
      'tong_thu_thua', COALESCE(sum(t.thu_thua), 0)
    ),
    COALESCE((
      SELECT jsonb_agg(
               jsonb_build_object(
                 'hoa_don_id', s.id,
                 'so_hoa_don', s.invoice_number,
                 'ky', s.billing_month,
                 'tong_tien', s.total_amount,
                 'da_tra', s.paid_amount,
                 'thu_thua', s.thu_thua,
                 'phong', s.room_name,
                 'toa_nha', s.building_name,
                 'khach_hang', s.customer_name
               ) ORDER BY s.rn
             )
      FROM (
        SELECT t2.*, row_number() OVER (ORDER BY t2.thu_thua DESC, t2.invoice_number NULLS LAST) AS rn
        FROM thua t2
        ORDER BY t2.thu_thua DESC, t2.invoice_number NULLS LAST
        LIMIT v_limit
      ) s
    ), '[]'::jsonb)
  INTO v_tong_hop, v_rows
  FROM thua t;

  RETURN jsonb_build_object(
    'gioi_han', v_limit,
    'so_luong', jsonb_array_length(v_rows),
    'tong_hop', COALESCE(v_tong_hop, jsonb_build_object('so_hoa_don', 0, 'tong_thu_thua', 0)),
    'hoa_don', v_rows
  );
END
$fn$;

-- 10. Booking deposits (dat coc giu cho) -------------------------------------
--
-- `public.deposits` is the BOOKING deposit taken before a contract exists — a
-- different thing from `contracts.deposit_paid`, which `coc_dang_giu` already
-- reports. Its row carries no building, only a NULLABLE `room_id`, so the same
-- rule as the G1-C2 tables applies: a row with a room needs that room building
-- in scope, a row without one is only visible to an organization-wide reader.
CREATE OR REPLACE FUNCTION public.copilot_report_deposits_v1(
  p_organization_id uuid,
  p_trang_thai text DEFAULT NULL,
  p_limit integer DEFAULT 20
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_buildings uuid[];
  v_org_wide boolean := false;
  v_trang_thai text := NULLIF(btrim(upper(coalesce(p_trang_thai, ''))), '');
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_today date;
  v_tong_hop jsonb;
  v_rows jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;
  IF v_trang_thai IS NOT NULL
     AND v_trang_thai NOT IN ('PENDING', 'CONFIRMED', 'CONVERTED', 'REFUNDED', 'FORFEITED') THEN
    RAISE EXCEPTION 'invalid_deposit_status' USING ERRCODE = '22023';
  END IF;

  v_buildings := public.copilot_org_scope_buildings_v1('reports_finance.deposits_report', p_organization_id);
  SELECT COALESCE(s.org_wide, false) INTO v_org_wide
  FROM app_private.authorized_scope_v3('reports_finance.deposits_report', p_organization_id) s;
  v_today := public.org_today_v1(p_organization_id);

  WITH coc AS (
    SELECT
      d.id,
      d.code,
      d.amount,
      d.deposit_date,
      d.hold_until,
      d.status::text AS deposit_state,
      rm.name AS room_name,
      b.name AS building_name,
      tn.full_name AS tenant_name
    FROM public.deposits d
    LEFT JOIN public.rooms rm
      ON rm.id = d.room_id
     AND rm.organization_id = p_organization_id
     AND rm.deleted_at IS NULL
    LEFT JOIN public.buildings b
      ON b.id = rm.building_id
     AND b.organization_id = p_organization_id
     AND b.deleted_at IS NULL
     AND b.id = ANY(v_buildings)
    LEFT JOIN public.tenants tn
      ON tn.id = d.tenant_id
     AND tn.organization_id = p_organization_id
     AND tn.deleted_at IS NULL
    WHERE d.organization_id = p_organization_id
      AND d.deleted_at IS NULL
      AND (b.id IS NOT NULL OR (d.room_id IS NULL AND v_org_wide))
      AND (v_trang_thai IS NULL OR d.status::text = v_trang_thai)
  )
  SELECT
    jsonb_build_object(
      'so_phieu', count(*),
      'tong_tien', COALESCE(sum(c.amount), 0),
      'dang_giu', COALESCE(sum(c.amount) FILTER (WHERE c.deposit_state IN ('PENDING', 'CONFIRMED')), 0),
      'da_vao_hop_dong', COALESCE(sum(c.amount) FILTER (WHERE c.deposit_state = 'CONVERTED'), 0)
    ),
    COALESCE((
      SELECT jsonb_agg(
               jsonb_build_object(
                 'coc_id', s.id,
                 'ma', s.code,
                 'khach_hang', s.tenant_name,
                 'phong', s.room_name,
                 'toa_nha', s.building_name,
                 'so_tien', s.amount,
                 'ngay_coc', s.deposit_date,
                 'giu_den', s.hold_until,
                 'trang_thai', s.deposit_state,
                 'so_ngay_giu', CASE
                                  WHEN s.deposit_date IS NULL THEN NULL
                                  ELSE (v_today - s.deposit_date)
                                END
               ) ORDER BY s.rn
             )
      FROM (
        SELECT c2.*, row_number() OVER (ORDER BY c2.deposit_date DESC, c2.id) AS rn
        FROM coc c2
        ORDER BY c2.deposit_date DESC, c2.id
        LIMIT v_limit
      ) s
    ), '[]'::jsonb)
  INTO v_tong_hop, v_rows
  FROM coc c;

  RETURN jsonb_build_object(
    'gioi_han', v_limit,
    'so_luong', jsonb_array_length(v_rows),
    'tong_hop', COALESCE(v_tong_hop, jsonb_build_object('so_phieu', 0, 'tong_tien', 0, 'dang_giu', 0, 'da_vao_hop_dong', 0)),
    'coc', v_rows
  );
END
$fn$;

-- ACL ------------------------------------------------------------------------
--
-- REVOKE FROM PUBLIC does NOT cut `anon` on Supabase: `anon` and `authenticated`
-- hold their own grants, so every role is named explicitly. `to_regrole` guards
-- keep the block runnable on a bare cluster where those roles do not exist.
REVOKE ALL ON FUNCTION public.copilot_report_vacant_rooms_v1(uuid, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.copilot_report_renewals_v1(uuid, date, date, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.copilot_report_terminations_v1(uuid, date, date, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.copilot_report_new_leases_v1(uuid, date, date, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.copilot_report_expense_ratio_v1(uuid, date, date, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.copilot_report_daily_cashbook_v1(uuid, date, date, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.copilot_report_cash_flow_v1(uuid, date, date, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.copilot_report_payment_schedule_v1(uuid, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.copilot_report_overpayment_v1(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.copilot_report_deposits_v1(uuid, text, integer) FROM PUBLIC;

DO $acl$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_report_vacant_rooms_v1(uuid, uuid, integer) FROM anon;
    REVOKE ALL ON FUNCTION public.copilot_report_renewals_v1(uuid, date, date, integer) FROM anon;
    REVOKE ALL ON FUNCTION public.copilot_report_terminations_v1(uuid, date, date, integer) FROM anon;
    REVOKE ALL ON FUNCTION public.copilot_report_new_leases_v1(uuid, date, date, integer) FROM anon;
    REVOKE ALL ON FUNCTION public.copilot_report_expense_ratio_v1(uuid, date, date, uuid, integer) FROM anon;
    REVOKE ALL ON FUNCTION public.copilot_report_daily_cashbook_v1(uuid, date, date, uuid, integer) FROM anon;
    REVOKE ALL ON FUNCTION public.copilot_report_cash_flow_v1(uuid, date, date, uuid, integer) FROM anon;
    REVOKE ALL ON FUNCTION public.copilot_report_payment_schedule_v1(uuid, integer, integer) FROM anon;
    REVOKE ALL ON FUNCTION public.copilot_report_overpayment_v1(uuid, integer) FROM anon;
    REVOKE ALL ON FUNCTION public.copilot_report_deposits_v1(uuid, text, integer) FROM anon;
  END IF;

  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_report_vacant_rooms_v1(uuid, uuid, integer) FROM authenticated;
    REVOKE ALL ON FUNCTION public.copilot_report_renewals_v1(uuid, date, date, integer) FROM authenticated;
    REVOKE ALL ON FUNCTION public.copilot_report_terminations_v1(uuid, date, date, integer) FROM authenticated;
    REVOKE ALL ON FUNCTION public.copilot_report_new_leases_v1(uuid, date, date, integer) FROM authenticated;
    REVOKE ALL ON FUNCTION public.copilot_report_expense_ratio_v1(uuid, date, date, uuid, integer) FROM authenticated;
    REVOKE ALL ON FUNCTION public.copilot_report_daily_cashbook_v1(uuid, date, date, uuid, integer) FROM authenticated;
    REVOKE ALL ON FUNCTION public.copilot_report_cash_flow_v1(uuid, date, date, uuid, integer) FROM authenticated;
    REVOKE ALL ON FUNCTION public.copilot_report_payment_schedule_v1(uuid, integer, integer) FROM authenticated;
    REVOKE ALL ON FUNCTION public.copilot_report_overpayment_v1(uuid, integer) FROM authenticated;
    REVOKE ALL ON FUNCTION public.copilot_report_deposits_v1(uuid, text, integer) FROM authenticated;

    GRANT EXECUTE ON FUNCTION public.copilot_report_vacant_rooms_v1(uuid, uuid, integer) TO authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_report_renewals_v1(uuid, date, date, integer) TO authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_report_terminations_v1(uuid, date, date, integer) TO authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_report_new_leases_v1(uuid, date, date, integer) TO authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_report_expense_ratio_v1(uuid, date, date, uuid, integer) TO authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_report_daily_cashbook_v1(uuid, date, date, uuid, integer) TO authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_report_cash_flow_v1(uuid, date, date, uuid, integer) TO authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_report_payment_schedule_v1(uuid, integer, integer) TO authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_report_overpayment_v1(uuid, integer) TO authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_report_deposits_v1(uuid, text, integer) TO authenticated;
  END IF;
END
$acl$;

COMMENT ON FUNCTION public.copilot_report_vacant_rooms_v1(uuid, uuid, integer) IS
  'Read-only vacant-room report for Copilot; server-derived scope, days-vacant from the last ended contract.';
COMMENT ON FUNCTION public.copilot_report_renewals_v1(uuid, date, date, integer) IS
  'Read-only renewal/transfer report for Copilot over one date window.';
COMMENT ON FUNCTION public.copilot_report_terminations_v1(uuid, date, date, integer) IS
  'Read-only termination report for Copilot; the rate denominator is scoped to the same buildings as the numerator.';
COMMENT ON FUNCTION public.copilot_report_new_leases_v1(uuid, date, date, integer) IS
  'Read-only new-lease report for Copilot over one signing window.';
COMMENT ON FUNCTION public.copilot_report_expense_ratio_v1(uuid, date, date, uuid, integer) IS
  'Read-only expense-over-revenue ratio for Copilot; restricted vouchers are excluded and counted, never dropped in silence.';
COMMENT ON FUNCTION public.copilot_report_daily_cashbook_v1(uuid, date, date, uuid, integer) IS
  'Read-only daily cash movement for Copilot: posting truth (cashflow_by_day_v2 shape), visible-cashbook bound, SELECTED organization instead of my_org_ids().';
COMMENT ON FUNCTION public.copilot_report_cash_flow_v1(uuid, date, date, uuid, integer) IS
  'Read-only monthly cash-flow rollup for Copilot: posting truth, visible-cashbook bound, SELECTED organization instead of my_org_ids().';
COMMENT ON FUNCTION public.copilot_report_payment_schedule_v1(uuid, integer, integer) IS
  'Read-only payment schedule for Copilot: unpaid invoices due within N days, overdue ones counted separately.';
COMMENT ON FUNCTION public.copilot_report_overpayment_v1(uuid, integer) IS
  'Read-only overpaid-invoice report for Copilot.';
COMMENT ON FUNCTION public.copilot_report_deposits_v1(uuid, text, integer) IS
  'Read-only booking-deposit report for Copilot; a deposit with no room needs organization-wide permission.';

-- Acceptance: catalog only ---------------------------------------------------
DO $nghiem_thu$
DECLARE
  v_sig text;
  v_thieu text[] := '{}'::text[];
  v_ho text[] := '{}'::text[];
BEGIN
  FOREACH v_sig IN ARRAY ARRAY[
    'public.copilot_report_vacant_rooms_v1(uuid, uuid, integer)',
    'public.copilot_report_renewals_v1(uuid, date, date, integer)',
    'public.copilot_report_terminations_v1(uuid, date, date, integer)',
    'public.copilot_report_new_leases_v1(uuid, date, date, integer)',
    'public.copilot_report_expense_ratio_v1(uuid, date, date, uuid, integer)',
    'public.copilot_report_daily_cashbook_v1(uuid, date, date, uuid, integer)',
    'public.copilot_report_cash_flow_v1(uuid, date, date, uuid, integer)',
    'public.copilot_report_payment_schedule_v1(uuid, integer, integer)',
    'public.copilot_report_overpayment_v1(uuid, integer)',
    'public.copilot_report_deposits_v1(uuid, text, integer)'
  ]
  LOOP
    IF to_regprocedure(v_sig) IS NULL THEN
      v_thieu := v_thieu || v_sig;
    ELSIF to_regrole('anon') IS NOT NULL
      AND has_function_privilege('anon', to_regprocedure(v_sig)::oid, 'EXECUTE') THEN
      v_ho := v_ho || v_sig;
    END IF;
  END LOOP;

  IF cardinality(v_thieu) > 0 THEN
    RAISE EXCEPTION 'copilot report RPC missing after apply: %', array_to_string(v_thieu, ', ');
  END IF;
  IF cardinality(v_ho) > 0 THEN
    RAISE EXCEPTION 'copilot report RPC is anon-executable: %', array_to_string(v_ho, ', ');
  END IF;
  IF to_regprocedure('public.copilot_org_scope_buildings_v1(text, uuid)') IS NULL
     OR to_regprocedure('app_private.copilot_scope_cashbooks_v1(text, uuid)') IS NULL THEN
    RAISE EXCEPTION 'copilot scope helpers missing — 20260829090000 must run first';
  END IF;
  IF to_regprocedure('app_private.ie_visible_cashbook_ids_v1()') IS NULL THEN
    RAISE EXCEPTION 'cashbook visibility helper missing — 20260730101000 must run first';
  END IF;
  IF to_regprocedure('public.org_today_v1(uuid)') IS NULL THEN
    RAISE EXCEPTION 'org_today_v1 missing — 20260731070000 must run first';
  END IF;
END
$nghiem_thu$;

COMMIT;

NOTIFY pgrst, 'reload schema';
