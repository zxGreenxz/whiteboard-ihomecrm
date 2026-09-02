-- Copilot read surface, part 3: contracts (search + detail), income/expense
-- vouchers (search), and the caller's OWN pending request inbox.
--
-- WHY THESE FOUR, AND WHY AS RPC
--   The browser tools may not reach `public.contracts` / `public.income_expenses`
--   directly: the tenant boundary of those tables is a join away (contracts carry
--   only `room_id`, vouchers carry `building_id`), and a PostgREST embed has to
--   guess the relation. The same class of failure was measured on 13/08/2026
--   (cases C02/C04/C14/C16). Every read below therefore resolves its own scope
--   server-side through `public.copilot_org_scope_buildings_v1`, which validates
--   the selected organization, an ACTIVE non-revoked membership and the permission
--   key before returning the building set every query is constrained by.
--
-- READ-ONLY BY CONSTRUCTION
--   All four are STABLE. None writes, approves, posts or cancels anything. The
--   inbox function only re-reads `public.list_my_pending_approvals_v1()`, which is
--   already filtered by `auth.uid()`; this wrapper adds the organization filter and
--   a hard row cap so a Copilot answer cannot become an unbounded data export.
--
-- LIMITS
--   `p_limit` is clamped to 1..50 inside the function. A caller cannot widen it,
--   and the clamped value is echoed back in the payload so the model can say
--   "showing N of possibly more" instead of implying completeness.
--
-- ACCEPTANCE IS CATALOG-ONLY
--   The closing block reads `pg_proc`/ACL only, so this migration also runs on an
--   empty database (Restore Drill replays it onto a schema-only baseline). No
--   fixture row is created and no data is touched.
BEGIN;
SET LOCAL lock_timeout = '15s';

CREATE SCHEMA IF NOT EXISTS app_private;

-- Text folding used by both search RPCs.
--
-- `unaccent` is NOT installed on this project today (checked against
-- supabase/baseline/schema.sql). Rather than hard-fail, or silently ship an
-- accent-sensitive search that looks broken to a Vietnamese user, the helper body
-- is chosen ONCE at migration time from the catalog: with the extension present it
-- folds accents, without it it only lowercases. Replaying this migration re-runs
-- the same decision, so both passes converge on the same body.
DO $chuan_hoa$
BEGIN
  IF to_regprocedure('extensions.unaccent(text)') IS NOT NULL THEN
    EXECUTE $ddl$
      CREATE OR REPLACE FUNCTION app_private.copilot_fold_text_v1(p_text text)
      RETURNS text
      LANGUAGE sql
      STABLE
      SET search_path = pg_catalog, extensions
      AS 'SELECT lower(extensions.unaccent(coalesce($1, '''')))'
    $ddl$;
  ELSE
    EXECUTE $ddl$
      CREATE OR REPLACE FUNCTION app_private.copilot_fold_text_v1(p_text text)
      RETURNS text
      LANGUAGE sql
      STABLE
      SET search_path = pg_catalog
      AS 'SELECT lower(coalesce($1, ''''))'
    $ddl$;
  END IF;
END
$chuan_hoa$;

-- 1. Contract search ---------------------------------------------------------
CREATE OR REPLACE FUNCTION public.copilot_contract_search_v1(
  p_organization_id uuid,
  p_query text DEFAULT NULL,
  p_status text DEFAULT NULL,
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
  v_query text := NULLIF(btrim(coalesce(p_query, '')), '');
  v_needle text;
  v_status text := NULLIF(btrim(upper(coalesce(p_status, ''))), '');
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_rows jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;
  IF v_status IS NOT NULL
     AND v_status NOT IN ('DRAFT', 'ACTIVE', 'EXTENDED', 'TRANSFERRED', 'TERMINATED', 'EXPIRED') THEN
    RAISE EXCEPTION 'invalid_contract_status' USING ERRCODE = '22023';
  END IF;

  -- Validates organization, membership, permission and denies. Never trusted input.
  v_buildings := public.copilot_org_scope_buildings_v1('contracts.view', p_organization_id);
  v_needle := CASE
                WHEN v_query IS NULL THEN NULL
                ELSE '%' || app_private.copilot_fold_text_v1(v_query) || '%'
              END;

  SELECT COALESCE(jsonb_agg(
           jsonb_build_object(
             'hop_dong_id', s.contract_id,
             'so_hop_dong', s.contract_number,
             'khach_hang', s.customer_name,
             'phong', s.room_name,
             'toa_nha', s.building_name,
             'ngay_bat_dau', s.start_date,
             'ngay_ket_thuc', s.effective_end_date,
             'trang_thai', s.contract_status,
             'tien_thue', s.rent_price,
             'tien_coc', s.total_deposit,
             'coc_da_thu', s.deposit_paid
           ) ORDER BY s.rn
         ), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT
        ct.id AS contract_id,
        ct.contract_number,
        rep.customer_name,
        rm.name AS room_name,
        b.name AS building_name,
        ct.start_date,
        COALESCE(ct.actual_end_date, ct.end_date) AS effective_end_date,
        ct.status::text AS contract_status,
        ct.rent_price,
        ct.total_deposit,
        COALESCE(ct.deposit_paid, 0) AS deposit_paid,
        row_number() OVER (
          ORDER BY COALESCE(ct.actual_end_date, ct.end_date) DESC NULLS LAST,
                   ct.contract_number NULLS LAST,
                   ct.id
        ) AS rn
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
        AND (v_status IS NULL OR ct.status::text = v_status)
        AND (
          v_needle IS NULL
          OR app_private.copilot_fold_text_v1(COALESCE(ct.contract_number, '')) LIKE v_needle
          OR app_private.copilot_fold_text_v1(COALESCE(ct.public_code, '')) LIKE v_needle
          OR app_private.copilot_fold_text_v1(COALESCE(rm.name, '')) LIKE v_needle
          OR app_private.copilot_fold_text_v1(COALESCE(b.name, '')) LIKE v_needle
          OR EXISTS (
            SELECT 1
            FROM public.contract_customers cc2
            JOIN public.customers cst2
              ON cst2.id = cc2.customer_id
             AND cst2.organization_id = p_organization_id
             AND cst2.deleted_at IS NULL
            WHERE cc2.contract_id = ct.id
              AND cc2.organization_id = p_organization_id
              AND app_private.copilot_fold_text_v1(COALESCE(cst2.full_name, '')) LIKE v_needle
          )
        )
      ORDER BY COALESCE(ct.actual_end_date, ct.end_date) DESC NULLS LAST,
               ct.contract_number NULLS LAST,
               ct.id
      LIMIT v_limit
    ) s;

  RETURN jsonb_build_object(
    'gioi_han', v_limit,
    'so_luong', jsonb_array_length(v_rows),
    'hop_dong', v_rows
  );
END
$fn$;

-- 2. Contract detail ---------------------------------------------------------
CREATE OR REPLACE FUNCTION public.copilot_contract_detail_v1(
  p_organization_id uuid,
  p_contract_id uuid
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
  v_contract jsonb;
  v_invoices jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;
  IF p_contract_id IS NULL THEN
    RAISE EXCEPTION 'contract_required' USING ERRCODE = '22023';
  END IF;

  v_buildings := public.copilot_org_scope_buildings_v1('contracts.view', p_organization_id);

  SELECT jsonb_build_object(
           'hop_dong_id', ct.id,
           'so_hop_dong', ct.contract_number,
           'khach_hang', rep.customer_name,
           'so_nguoi_o', rep.customer_count,
           'phong', rm.name,
           'toa_nha', b.name,
           'ngay_ky', ct.signed_date,
           'ngay_bat_dau', ct.start_date,
           'ngay_ket_thuc', ct.end_date,
           'ngay_ket_thuc_thuc_te', ct.actual_end_date,
           'ngay_du_kien_tra_phong', ct.expected_move_out_date,
           'trang_thai', ct.status::text,
           'chu_ky_thanh_toan', ct.payment_cycle::text,
           'tien_thue', ct.rent_price,
           'tien_coc', ct.total_deposit,
           'coc_da_thu', COALESCE(ct.deposit_paid, 0),
           'coc_con_thieu', COALESCE(ct.deposit_remaining, 0)
         )
    INTO v_contract
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
      SELECT
        (
          SELECT cst.full_name
          FROM public.contract_customers cc
          JOIN public.customers cst
            ON cst.id = cc.customer_id
           AND cst.organization_id = p_organization_id
           AND cst.deleted_at IS NULL
          WHERE cc.contract_id = ct.id
            AND cc.organization_id = p_organization_id
          ORDER BY cc.is_representative DESC, cc.created_at
          LIMIT 1
        ) AS customer_name,
        (
          SELECT count(*)
          FROM public.contract_customers cc
          WHERE cc.contract_id = ct.id
            AND cc.organization_id = p_organization_id
        ) AS customer_count
    ) rep ON true
    WHERE ct.id = p_contract_id
      AND ct.organization_id = p_organization_id
      AND ct.deleted_at IS NULL;

  IF v_contract IS NULL THEN
    -- "Not found" and "not yours" answer the SAME way on purpose: confirming that
    -- an id exists outside the caller scope is itself a cross-tenant disclosure.
    RETURN jsonb_build_object('tim_thay', false, 'hop_dong', NULL, 'hoa_don', '[]'::jsonb);
  END IF;

  SELECT COALESCE(jsonb_agg(
           jsonb_build_object(
             'hoa_don_id', x.id,
             'so_hoa_don', x.invoice_number,
             'ky', x.billing_month,
             'ngay_phat_hanh', x.issue_date,
             'han_thanh_toan', x.due_date,
             'tong_tien', x.total_amount,
             'da_tra', x.paid_amount,
             'con_lai', x.remaining_amount,
             'trang_thai', x.trang_thai
           ) ORDER BY x.rn
         ), '[]'::jsonb)
    INTO v_invoices
    FROM (
      SELECT
        i.id,
        i.invoice_number,
        i.billing_month,
        i.issue_date,
        i.due_date,
        i.total_amount,
        i.paid_amount,
        i.remaining_amount,
        i.status::text AS trang_thai,
        row_number() OVER (ORDER BY i.billing_month DESC, i.created_at DESC) AS rn
      FROM public.invoices i
      WHERE i.contract_id = p_contract_id
        AND i.organization_id = p_organization_id
        AND i.deleted_at IS NULL
      ORDER BY i.billing_month DESC, i.created_at DESC
      LIMIT 5
    ) x;

  RETURN jsonb_build_object('tim_thay', true, 'hop_dong', v_contract, 'hoa_don', v_invoices);
END
$fn$;

-- 3. Income / expense voucher search -----------------------------------------
CREATE OR REPLACE FUNCTION public.copilot_income_expense_search_v1(
  p_organization_id uuid,
  p_query text DEFAULT NULL,
  p_tu date DEFAULT NULL,
  p_den date DEFAULT NULL,
  p_loai text DEFAULT NULL,
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
  v_query text := NULLIF(btrim(coalesce(p_query, '')), '');
  v_needle text;
  v_loai text := NULLIF(btrim(upper(coalesce(p_loai, ''))), '');
  v_trang_thai text := NULLIF(btrim(upper(coalesce(p_trang_thai, ''))), '');
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_thay_han_che boolean;
  v_rows jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;
  IF v_loai IS NOT NULL AND v_loai NOT IN ('INCOME', 'EXPENSE') THEN
    RAISE EXCEPTION 'invalid_voucher_type' USING ERRCODE = '22023';
  END IF;
  IF v_trang_thai IS NOT NULL AND v_trang_thai NOT IN ('UNAPPROVED', 'APPROVED', 'CANCELLED') THEN
    RAISE EXCEPTION 'invalid_voucher_state' USING ERRCODE = '22023';
  END IF;
  IF p_tu IS NOT NULL AND p_den IS NOT NULL AND p_tu > p_den THEN
    RAISE EXCEPTION 'invalid_date_window' USING ERRCODE = '22023';
  END IF;

  v_buildings := public.copilot_org_scope_buildings_v1('income_expenses.view', p_organization_id);
  -- Restricted categories are a SECOND boundary on top of the building scope: a
  -- user allowed to read vouchers is not automatically allowed to read the
  -- restricted ones (income_expenses.restricted_view). Resolved once, outside the
  -- row scan, so the answer cannot vary row by row.
  v_thay_han_che := public.can_view_restricted_ie();
  v_needle := CASE
                WHEN v_query IS NULL THEN NULL
                ELSE '%' || app_private.copilot_fold_text_v1(v_query) || '%'
              END;

  SELECT COALESCE(jsonb_agg(
           jsonb_build_object(
             'phieu_id', s.id,
             'ma_phieu', s.ma_phieu,
             'loai', s.loai,
             'ten', s.ten,
             'so_tien', s.so_tien,
             'ngay', s.ngay,
             'hang_muc', s.hang_muc,
             'so_quy', s.so_quy,
             'trang_thai', s.trang_thai,
             'trang_thai_ghi_nhan', s.trang_thai_ghi_nhan,
             'nguoi_tao', s.nguoi_tao,
             'toa_nha', s.toa_nha
           ) ORDER BY s.rn
         ), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT
        ie.id,
        ie.code AS ma_phieu,
        ie.type AS loai,
        ie.name AS ten,
        ie.total_amount AS so_tien,
        ie.voucher_date AS ngay,
        hm.ten_hang_muc AS hang_muc,
        acc.name AS so_quy,
        ie.approval_status AS trang_thai,
        COALESCE(ie.posting_status, 'UNPOSTED') AS trang_thai_ghi_nhan,
        ie.creator_name AS nguoi_tao,
        b.name AS toa_nha,
        row_number() OVER (ORDER BY ie.voucher_date DESC, ie.created_at DESC, ie.id) AS rn
      FROM public.income_expenses ie
      JOIN public.buildings b
        ON b.id = ie.building_id
       AND b.organization_id = p_organization_id
       AND b.deleted_at IS NULL
       AND b.id = ANY(v_buildings)
      LEFT JOIN public.accounts acc
        ON acc.id = ie.account_id
       AND acc.organization_id = p_organization_id
      LEFT JOIN LATERAL (
        SELECT string_agg(DISTINCT t.name, ', ') AS ten_hang_muc
        FROM public.income_expense_items it
        JOIN public.income_expense_types t
          ON t.id = it.income_expense_type_id
         AND t.organization_id = p_organization_id
        WHERE it.income_expense_id = ie.id
      ) hm ON true
      WHERE ie.organization_id = p_organization_id
        AND ie.deleted_at IS NULL
        AND (v_loai IS NULL OR ie.type = v_loai)
        AND (v_trang_thai IS NULL OR ie.approval_status = v_trang_thai)
        AND (p_tu IS NULL OR ie.voucher_date >= p_tu)
        AND (p_den IS NULL OR ie.voucher_date <= p_den)
        AND (v_thay_han_che OR NOT COALESCE(ie.has_restricted_item, false))
        AND (
          v_needle IS NULL
          OR app_private.copilot_fold_text_v1(COALESCE(ie.code, '')) LIKE v_needle
          OR app_private.copilot_fold_text_v1(COALESCE(ie.name, '')) LIKE v_needle
          OR app_private.copilot_fold_text_v1(COALESCE(ie.payer_name, '')) LIKE v_needle
        )
      ORDER BY ie.voucher_date DESC, ie.created_at DESC, ie.id
      LIMIT v_limit
    ) s;

  RETURN jsonb_build_object(
    'gioi_han', v_limit,
    'so_luong', jsonb_array_length(v_rows),
    'phieu', v_rows
  );
END
$fn$;

-- 4. The caller's own pending request inbox ----------------------------------
--
-- A READ of the inbox and nothing else. It deliberately exposes no decision path:
-- Copilot can say what is waiting and where to go, and a human still decides on
-- /approvals.
CREATE OR REPLACE FUNCTION public.copilot_pending_requests_v1(
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
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_rows jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;

  -- Not used to filter rows (the inner reader is already actor-scoped) but to
  -- assert the SAME organization/membership/permission boundary as every other
  -- Copilot read before anything is returned.
  PERFORM public.copilot_org_scope_buildings_v1('income_expenses.view', p_organization_id);

  SELECT COALESCE(jsonb_agg(
           jsonb_build_object(
             'yeu_cau_id', s.request_id,
             'lan_gui', s.submission_no,
             'gui_luc', s.submitted_at,
             'so_tien', s.amount,
             'phieu_id', s.voucher_id,
             'ma_phieu', s.voucher_code,
             'ten_phieu', s.voucher_name,
             'loai', s.voucher_type,
             'nguoi_lap', s.maker_name,
             'buoc', s.step_no
           ) ORDER BY s.rn
         ), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT
        p.request_id,
        p.submission_no,
        p.submitted_at,
        p.amount,
        p.voucher_id,
        p.voucher_code,
        p.voucher_name,
        p.voucher_type,
        p.maker_name,
        p.step_no,
        row_number() OVER (ORDER BY p.submitted_at, p.request_id) AS rn
      FROM public.list_my_pending_approvals_v1() p
      WHERE p.organization_id = p_organization_id
      ORDER BY p.submitted_at, p.request_id
      LIMIT v_limit
    ) s;

  RETURN jsonb_build_object(
    'gioi_han', v_limit,
    'so_luong', jsonb_array_length(v_rows),
    'hop_cho', v_rows
  );
END
$fn$;

-- ACL ------------------------------------------------------------------------
--
-- REVOKE FROM PUBLIC does NOT cut `anon` on Supabase: `anon` and `authenticated`
-- hold their own grants, so every role is named explicitly. `to_regrole` guards
-- keep the block runnable on a bare cluster where those roles do not exist.
REVOKE ALL ON FUNCTION app_private.copilot_fold_text_v1(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.copilot_contract_search_v1(uuid, text, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.copilot_contract_detail_v1(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.copilot_income_expense_search_v1(uuid, text, date, date, text, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.copilot_pending_requests_v1(uuid, integer) FROM PUBLIC;

DO $acl$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION app_private.copilot_fold_text_v1(text) FROM anon;
    REVOKE ALL ON FUNCTION public.copilot_contract_search_v1(uuid, text, text, integer) FROM anon;
    REVOKE ALL ON FUNCTION public.copilot_contract_detail_v1(uuid, uuid) FROM anon;
    REVOKE ALL ON FUNCTION public.copilot_income_expense_search_v1(uuid, text, date, date, text, text, integer) FROM anon;
    REVOKE ALL ON FUNCTION public.copilot_pending_requests_v1(uuid, integer) FROM anon;
  END IF;

  IF to_regrole('authenticated') IS NOT NULL THEN
    -- The folding helper stays owner-only: it is an implementation detail of the
    -- two search functions, not a callable surface.
    REVOKE ALL ON FUNCTION app_private.copilot_fold_text_v1(text) FROM authenticated;
    REVOKE ALL ON FUNCTION public.copilot_contract_search_v1(uuid, text, text, integer) FROM authenticated;
    REVOKE ALL ON FUNCTION public.copilot_contract_detail_v1(uuid, uuid) FROM authenticated;
    REVOKE ALL ON FUNCTION public.copilot_income_expense_search_v1(uuid, text, date, date, text, text, integer) FROM authenticated;
    REVOKE ALL ON FUNCTION public.copilot_pending_requests_v1(uuid, integer) FROM authenticated;

    GRANT EXECUTE ON FUNCTION public.copilot_contract_search_v1(uuid, text, text, integer) TO authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_contract_detail_v1(uuid, uuid) TO authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_income_expense_search_v1(uuid, text, date, date, text, text, integer) TO authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_pending_requests_v1(uuid, integer) TO authenticated;
  END IF;

  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION app_private.copilot_fold_text_v1(text) FROM service_role;
  END IF;
END
$acl$;

COMMENT ON FUNCTION public.copilot_contract_search_v1(uuid, text, text, integer) IS
  'Read-only contract lookup for Copilot; server-derived organization/building scope, LIMIT clamped 1..50.';
COMMENT ON FUNCTION public.copilot_contract_detail_v1(uuid, uuid) IS
  'Read-only contract detail for Copilot: contract, 5 latest invoices, deposit held.';
COMMENT ON FUNCTION public.copilot_income_expense_search_v1(uuid, text, date, date, text, text, integer) IS
  'Read-only income/expense voucher lookup for Copilot; restricted categories need income_expenses.restricted_view.';
COMMENT ON FUNCTION public.copilot_pending_requests_v1(uuid, integer) IS
  'Read-only inbox of the calling actor own pending finance requests, organization-filtered and capped.';

-- Acceptance: catalog only ---------------------------------------------------
DO $nghiem_thu$
DECLARE
  v_sig text;
  v_thieu text[] := '{}'::text[];
  v_ho text[] := '{}'::text[];
BEGIN
  FOREACH v_sig IN ARRAY ARRAY[
    'public.copilot_contract_search_v1(uuid, text, text, integer)',
    'public.copilot_contract_detail_v1(uuid, uuid)',
    'public.copilot_income_expense_search_v1(uuid, text, date, date, text, text, integer)',
    'public.copilot_pending_requests_v1(uuid, integer)'
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
    RAISE EXCEPTION 'copilot read RPC missing after apply: %', array_to_string(v_thieu, ', ');
  END IF;
  IF cardinality(v_ho) > 0 THEN
    RAISE EXCEPTION 'copilot read RPC is anon-executable: %', array_to_string(v_ho, ', ');
  END IF;
  IF to_regprocedure('app_private.copilot_fold_text_v1(text)') IS NULL THEN
    RAISE EXCEPTION 'copilot text folding helper missing after apply';
  END IF;
  IF to_regrole('anon') IS NOT NULL
     AND has_function_privilege('anon', to_regprocedure('app_private.copilot_fold_text_v1(text)')::oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'copilot text folding helper is anon-executable';
  END IF;
END
$nghiem_thu$;

COMMIT;

NOTIFY pgrst, 'reload schema';
