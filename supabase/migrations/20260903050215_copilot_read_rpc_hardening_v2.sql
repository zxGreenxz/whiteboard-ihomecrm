-- Copilot read RPC hardening v2 — the single fix wave after the whole-branch
-- review of stage G1.
--
-- All sixteen functions below are ALREADY LIVE on production, applied by
-- 20260902193151, 20260902203258, 20260902213111 and 20260902224859. Their
-- signatures do not change and none of them is overloaded, so every one is a
-- CREATE OR REPLACE of the same signature: the old migrations are history and
-- are not edited. The bodies are copied VERBATIM from those files; only the
-- lines each item below names are different.
--
-- WHAT IS FIXED, AND WHY IT WAS WRONG
--
-- A1 (Critical) — "PERFORM the scope helper" was never a permission check.
--   public.copilot_org_scope_buildings_v1 raises for a missing organization, a
--   NULL actor and a revoked membership. It does NOT raise for "you hold no
--   grant for this key" — it returns an empty array, on purpose, because every
--   caller that KEEPS the array constrains its rows with it. Three functions
--   PERFORMed it and dropped the array, so for them the empty array was not a
--   boundary, it was nothing at all:
--     copilot_material_stock_v1   — every ACTIVE member, including one under an
--                                   emergency DENY, read the whole company stock
--                                   with quantities and valuation (Critical);
--     copilot_pending_requests_v1 — income_expenses.view was never checked;
--     copilot_salary_summary_v1   — salary.view was never checked.
--   Each now reads app_private.authorized_scope_v3 and raises not_permitted
--   (42501) when the caller holds no grant at all in this organization.
--   The two remaining `PERFORM` calls are kept ON PURPOSE and ONLY as the
--   organization/membership assertion, immediately followed by the real gate.
--
-- A2 (Important) — copilot_vehicle_search_v1 returned vehicles with no building
--   to any org-wide caller. RLS vehicles_select_rbac requires, for exactly those
--   rows, that the owner be one of current_visible_owner_ids(). The predicate is
--   copied from the policy.
--
-- A3 (Important) — copilot_meter_readings_v1 did the same for readings with no
--   building; meter_readings_select_rbac gives those to is_admin() /
--   is_super_admin() only.
--
-- A4 (Important) — copilot_salary_summary_v1 used salary.view org-wide as the
--   "whole company" switch. That key is the NAV-surface permission; the payroll
--   screen switches on salary.lock / salary.manage_salary / salary.distribute
--   and RLS backs it with sm_owner_all vs sm_self_select. An employee holding
--   only salary.view therefore received every colleague TAKE-HOME through
--   Copilot while their own screen showed one row. The three management keys are
--   the switch now, and the answer still names the branch it came from in
--   `pham_vi`.
--
-- A5 (Important) — the three copilot.sensitive.* rollout flags were enforced in
--   TypeScript only. Calling the RPC straight through PostgREST answered with
--   the switch off. app_private.copilot_page_flag_allows_v1 reads the SAME row
--   the admin screen writes (public.copilot_feature_flags, seeded disabled by
--   20260902224859) and the three functions raise copilot_feature_disabled
--   (42501) when it says no. Deny-by-default: no row, an expired row or a canary
--   pinned to another organization all mean no.
--
-- A6 (Minor, batched here) — LIKE/ILIKE needles were interpolated raw, so a
--   resident searching for "50%" matched everything and a trailing backslash
--   raised 22025. app_private.copilot_like_escape_v1 escapes the three LIKE
--   metacharacters and every pattern now carries ESCAPE '\'. Three report
--   windows are clamped to three years. service_role is revoked explicitly from
--   all twenty-four functions of 20260902203258 and 20260902213111 — the other
--   two migrations already did that for their own.
--
-- ACCEPTANCE IS CATALOG-ONLY, so this migration also runs on an empty database
-- (Restore Drill replays the forward lane onto a schema-only baseline).
BEGIN;
SET LOCAL lock_timeout = '15s';

-- Prerequisites, named out loud. This migration only REPLACES bodies; if the
-- lane ever runs out of order the failure should say which file is missing
-- rather than surface as a mysterious "function does not exist".
DO $tien_de$
BEGIN
  IF to_regprocedure('app_private.copilot_fold_text_v1(text)') IS NULL THEN
    RAISE EXCEPTION 'copilot_fold_text_v1 missing — 20260902193151 must run first';
  END IF;
  IF to_regprocedure('public.copilot_org_scope_buildings_v1(text, uuid)') IS NULL THEN
    RAISE EXCEPTION 'copilot_org_scope_buildings_v1 missing — 20260829090000 must run first';
  END IF;
  IF to_regprocedure('app_private.authorized_scope_v3(text, uuid)') IS NULL THEN
    RAISE EXCEPTION 'authorized_scope_v3 missing — the authorization lane must run first';
  END IF;
  IF to_regclass('public.copilot_feature_flags') IS NULL THEN
    RAISE EXCEPTION 'copilot_feature_flags missing — 20260828170000 must run first';
  END IF;
END
$tien_de$;

-- ============================================================================
-- Helper 1 — LIKE metacharacter escaping (A6)
-- ============================================================================
--
-- Order matters and is not a style choice: the backslash is replaced FIRST,
-- because replacing it after % and _ would double the backslashes this function
-- itself just inserted and the pattern would search for literal backslashes.
--
-- IMMUTABLE and not SECURITY DEFINER: it reads no table, no setting and no
-- session state, so there is nothing for a definer to elevate. It is still
-- revoked down to owner-only, exactly like copilot_fold_text_v1, because it is
-- an implementation detail of the search functions and not a callable surface.
CREATE OR REPLACE FUNCTION app_private.copilot_like_escape_v1(p_text text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $fn$
  SELECT replace(replace(replace(coalesce($1, ''), '\', '\\'), '%', '\%'), '_', '\_');
$fn$;

COMMENT ON FUNCTION app_private.copilot_like_escape_v1(text) IS
  'Escapes the three LIKE metacharacters (backslash, percent, underscore) so a Copilot search needle matches literally; pair it with ESCAPE.';

-- ============================================================================
-- Helper 2 — the rollout flag, read on the SERVER (A5)
-- ============================================================================
--
-- Deny-by-default in every direction that can go wrong:
--   no row for this contract            -> false (a contract nobody seeded is off)
--   state 'disabled'                    -> false
--   canary_org set to another company   -> false
--   expires_at in the past              -> false
--
-- 'shadow' counts as allowed because that is what shadow MEANS in this rollout:
-- the surface runs and is measured, it just is not advertised. The TypeScript
-- side has always treated it that way; a server that disagreed would make the
-- shadow phase untestable.
--
-- SECURITY DEFINER because public.copilot_feature_flags is admin-only under RLS,
-- and a read RPC must be able to consult the switch that governs it without
-- handing the caller the flag table. It returns a BOOLEAN and nothing else, so
-- it leaks no row content.
CREATE OR REPLACE FUNCTION app_private.copilot_page_flag_allows_v1(
  p_contract_id text,
  p_organization_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
  SELECT EXISTS (
    SELECT 1
      FROM public.copilot_feature_flags f
     WHERE f.scope = 'page'
       AND f.contract_id = p_contract_id
       AND f.state IN ('shadow', 'enabled')
       AND (f.canary_org IS NULL OR f.canary_org = p_organization_id)
       AND (f.expires_at IS NULL OR f.expires_at > now())
  );
$fn$;

COMMENT ON FUNCTION app_private.copilot_page_flag_allows_v1(text, uuid) IS
  'Server-side rollout gate for one Copilot page contract; deny-by-default (missing row, disabled, expired or foreign canary all answer false).';

REVOKE ALL ON FUNCTION app_private.copilot_like_escape_v1(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.copilot_page_flag_allows_v1(text, uuid) FROM PUBLIC;

DO $acl_helper$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION app_private.copilot_like_escape_v1(text) FROM anon;
    REVOKE ALL ON FUNCTION app_private.copilot_page_flag_allows_v1(text, uuid) FROM anon;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION app_private.copilot_like_escape_v1(text) FROM authenticated;
    REVOKE ALL ON FUNCTION app_private.copilot_page_flag_allows_v1(text, uuid) FROM authenticated;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION app_private.copilot_like_escape_v1(text) FROM service_role;
    REVOKE ALL ON FUNCTION app_private.copilot_page_flag_allows_v1(text, uuid) FROM service_role;
  END IF;
END
$acl_helper$;

-- ============================================================================
-- The sixteen bodies. Same signatures, copied from the migrations named above.
-- ============================================================================

-- copilot_contract_search_v1(uuid, text, text, integer) ---------------------
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
  -- A6: the needle is folded FIRST (the column side folds too) and only then
  -- escaped, so a resident typing "50%" or "a_b" searches for those characters
  -- instead of turning them into LIKE wildcards. A trailing backslash used to
  -- reach LIKE unescaped and raise 22025.
  v_needle := CASE
                WHEN v_query IS NULL THEN NULL
                ELSE '%' || app_private.copilot_like_escape_v1(app_private.copilot_fold_text_v1(v_query)) || '%'
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
          OR app_private.copilot_fold_text_v1(COALESCE(ct.contract_number, '')) LIKE v_needle ESCAPE '\'
          OR app_private.copilot_fold_text_v1(COALESCE(ct.public_code, '')) LIKE v_needle ESCAPE '\'
          OR app_private.copilot_fold_text_v1(COALESCE(rm.name, '')) LIKE v_needle ESCAPE '\'
          OR app_private.copilot_fold_text_v1(COALESCE(b.name, '')) LIKE v_needle ESCAPE '\'
          OR EXISTS (
            SELECT 1
            FROM public.contract_customers cc2
            JOIN public.customers cst2
              ON cst2.id = cc2.customer_id
             AND cst2.organization_id = p_organization_id
             AND cst2.deleted_at IS NULL
            WHERE cc2.contract_id = ct.id
              AND cc2.organization_id = p_organization_id
              AND app_private.copilot_fold_text_v1(COALESCE(cst2.full_name, '')) LIKE v_needle ESCAPE '\'
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

-- copilot_income_expense_search_v1(uuid, text, date, date, text, text, integer) ---
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
  -- A6: the needle is folded FIRST (the column side folds too) and only then
  -- escaped, so a resident typing "50%" or "a_b" searches for those characters
  -- instead of turning them into LIKE wildcards. A trailing backslash used to
  -- reach LIKE unescaped and raise 22025.
  v_needle := CASE
                WHEN v_query IS NULL THEN NULL
                ELSE '%' || app_private.copilot_like_escape_v1(app_private.copilot_fold_text_v1(v_query)) || '%'
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
          OR app_private.copilot_fold_text_v1(COALESCE(ie.code, '')) LIKE v_needle ESCAPE '\'
          OR app_private.copilot_fold_text_v1(COALESCE(ie.name, '')) LIKE v_needle ESCAPE '\'
          OR app_private.copilot_fold_text_v1(COALESCE(ie.payer_name, '')) LIKE v_needle ESCAPE '\'
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

-- copilot_pending_requests_v1(uuid, integer) --------------------------------
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
  v_org_wide boolean := false;
  v_buildings uuid[] := '{}'::uuid[];
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_rows jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;

  -- A1. The previous body PERFORMed the scope helper and threw the result away.
  -- The helper raises on a missing organization and on a revoked membership, but
  -- it returns an EMPTY ARRAY — never an error — when the caller simply holds no
  -- grant for the key. So "PERFORM helper" asserted membership and nothing more:
  -- an emergency DENY on income_expenses.view was invisible here.
  --
  -- The gate is the scope itself now. No grant anywhere in this organization
  -- (neither org-wide nor on one building) is a permission error, not an inbox.
  -- The helper is still called FIRST so a bad organization keeps answering
  -- 'organization_required' (22023) instead of 'not_permitted' (42501).
  PERFORM public.copilot_org_scope_buildings_v1('income_expenses.view', p_organization_id);
  SELECT COALESCE(s.org_wide, false), COALESCE(s.building_ids, '{}'::uuid[])
    INTO v_org_wide, v_buildings
    FROM app_private.authorized_scope_v3('income_expenses.view', p_organization_id) s;
  IF NOT v_org_wide AND COALESCE(cardinality(v_buildings), 0) = 0 THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;

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

-- copilot_lead_search_v1(uuid, text, text, integer) -------------------------
CREATE OR REPLACE FUNCTION public.copilot_lead_search_v1(
  p_organization_id uuid,
  p_query text DEFAULT NULL,
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
  v_query text := NULLIF(btrim(coalesce(p_query, '')), '');
  v_needle text;
  v_trang_thai text := NULLIF(btrim(upper(coalesce(p_trang_thai, ''))), '');
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_rows jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;
  IF v_trang_thai IS NOT NULL
     AND v_trang_thai NOT IN ('B1_LEAD', 'B2_APPOINTMENT', 'B3_CONSULTATION', 'CONVERTED', 'FAILED') THEN
    RAISE EXCEPTION 'invalid_lead_status' USING ERRCODE = '22023';
  END IF;

  -- Validates organization, membership, permission and denies. Never trusted input.
  v_buildings := public.copilot_org_scope_buildings_v1('leads.view', p_organization_id);
  SELECT COALESCE(s.org_wide, false) INTO v_org_wide
  FROM app_private.authorized_scope_v3('leads.view', p_organization_id) s;
  -- A6: the needle is folded FIRST (the column side folds too) and only then
  -- escaped, so a resident typing "50%" or "a_b" searches for those characters
  -- instead of turning them into LIKE wildcards. A trailing backslash used to
  -- reach LIKE unescaped and raise 22025.
  v_needle := CASE
                WHEN v_query IS NULL THEN NULL
                ELSE '%' || app_private.copilot_like_escape_v1(app_private.copilot_fold_text_v1(v_query)) || '%'
              END;

  SELECT COALESCE(jsonb_agg(
           jsonb_build_object(
             'khach_hen_id', s.id,
             'khach_hang', s.customer_name,
             'dien_thoai', s.phone,
             'trang_thai', s.lead_state,
             'nguon', s.lead_source,
             'toa_nha', s.building_name,
             'phong', s.room_name,
             'ngay_hen', s.appointment_date,
             'lien_he_cuoi', s.last_contact_date,
             'hen_lien_he_toi', s.next_follow_up_date,
             'ngan_sach_tu', s.budget_min,
             'ngan_sach_den', s.budget_max,
             'ngay_tao', s.created_at
           ) ORDER BY s.rn
         ), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT
        l.id,
        l.customer_name,
        l.phone,
        l.status::text AS lead_state,
        l.source::text AS lead_source,
        b.name AS building_name,
        rm.name AS room_name,
        l.appointment_date,
        l.last_contact_date,
        l.next_follow_up_date,
        l.budget_min,
        l.budget_max,
        l.created_at,
        row_number() OVER (
          ORDER BY COALESCE(l.next_follow_up_date, l.appointment_date) NULLS LAST,
                   l.created_at DESC,
                   l.id
        ) AS rn
      FROM public.leads l
      LEFT JOIN public.buildings b
        ON b.id = l.building_id
       AND b.organization_id = p_organization_id
       AND b.deleted_at IS NULL
       AND b.id = ANY(v_buildings)
      LEFT JOIN public.rooms rm
        ON rm.id = l.room_id
       AND rm.organization_id = p_organization_id
       AND rm.deleted_at IS NULL
      WHERE l.organization_id = p_organization_id
        AND l.deleted_at IS NULL
        AND (b.id IS NOT NULL OR (l.building_id IS NULL AND v_org_wide))
        AND (v_trang_thai IS NULL OR l.status::text = v_trang_thai)
        AND (
          v_needle IS NULL
          OR app_private.copilot_fold_text_v1(COALESCE(l.customer_name, '')) LIKE v_needle ESCAPE '\'
          OR app_private.copilot_fold_text_v1(COALESCE(l.phone, '')) LIKE v_needle ESCAPE '\'
        )
      ORDER BY COALESCE(l.next_follow_up_date, l.appointment_date) NULLS LAST,
               l.created_at DESC,
               l.id
      LIMIT v_limit
    ) s;

  RETURN jsonb_build_object(
    'gioi_han', v_limit,
    'so_luong', jsonb_array_length(v_rows),
    'khach_hen', v_rows
  );
END
$fn$;

-- copilot_meter_readings_v1(uuid, text, uuid, integer) ----------------------
CREATE OR REPLACE FUNCTION public.copilot_meter_readings_v1(
  p_organization_id uuid,
  p_ky text,
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
  v_org_wide boolean := false;
  v_ky text := NULLIF(btrim(coalesce(p_ky, '')), '');
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_rows jsonb;
  v_tong_hop jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;
  IF v_ky IS NULL OR v_ky !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' THEN
    RAISE EXCEPTION 'invalid_settlement_month' USING ERRCODE = '22023';
  END IF;

  v_buildings := public.copilot_org_scope_buildings_v1('meter_readings.view', p_organization_id);
  SELECT COALESCE(s.org_wide, false) INTO v_org_wide
  FROM app_private.authorized_scope_v3('meter_readings.view', p_organization_id) s;

  IF p_building_id IS NOT NULL AND NOT (p_building_id = ANY(v_buildings)) THEN
    -- Asking about a building outside the caller scope answers like an empty
    -- period, not like a permission error: saying "that building exists but is
    -- not yours" is itself a cross-tenant disclosure.
    RETURN jsonb_build_object(
      'ky', v_ky, 'gioi_han', v_limit, 'so_luong', 0,
      'tong_hop', '[]'::jsonb, 'chi_so', '[]'::jsonb
    );
  END IF;

  -- Totals are computed over the WHOLE period, not over the capped list, so the
  -- consumption figure stays right no matter how short the list is.
  SELECT COALESCE(jsonb_agg(
           jsonb_build_object(
             'loai', g.meter_kind,
             'so_dong', g.row_count,
             'tong_tieu_thu', g.total_consumption
           ) ORDER BY g.meter_kind
         ), '[]'::jsonb)
    INTO v_tong_hop
    FROM (
      SELECT
        mr.meter_type::text AS meter_kind,
        count(*) AS row_count,
        COALESCE(sum(mr.consumption), 0) AS total_consumption
      FROM public.meter_readings mr
      LEFT JOIN public.buildings b
        ON b.id = mr.building_id
       AND b.organization_id = p_organization_id
       AND b.deleted_at IS NULL
       AND b.id = ANY(v_buildings)
      WHERE mr.organization_id = p_organization_id
        AND mr.deleted_at IS NULL
        AND mr.settlement_month = v_ky
        -- A3: RLS `meter_readings_select_rbac` hands a reading with NO building
        -- to is_super_admin() OR is_admin() and to nobody else. Org-wide alone
        -- was wider than the screen. (`is_admin()` delegates to is_super_admin()
        -- today; both are written so the predicate keeps mirroring the policy if
        -- that ever changes back.)
        AND (b.id IS NOT NULL OR (mr.building_id IS NULL AND v_org_wide AND (public.is_admin() OR public.is_super_admin())))
        AND (p_building_id IS NULL OR mr.building_id = p_building_id)
      GROUP BY mr.meter_type::text
    ) g;

  SELECT COALESCE(jsonb_agg(
           jsonb_build_object(
             'chi_so_id', s.id,
             'ma_phieu', s.reading_code,
             'toa_nha', s.building_name,
             'phong', s.room_name,
             'loai', s.meter_kind,
             'chi_so_dau', s.previous_reading,
             'chi_so_cuoi', s.current_reading,
             'tieu_thu', s.consumption,
             'ngay_ghi', s.reading_date,
             'trang_thai', s.check_state
           ) ORDER BY s.rn
         ), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT
        mr.id,
        mr.reading_code,
        b.name AS building_name,
        rm.name AS room_name,
        mr.meter_type::text AS meter_kind,
        mr.previous_reading,
        mr.current_reading,
        mr.consumption,
        mr.reading_date,
        mr.status AS check_state,
        row_number() OVER (
          ORDER BY b.name NULLS LAST, rm.name NULLS LAST, mr.meter_type::text, mr.id
        ) AS rn
      FROM public.meter_readings mr
      LEFT JOIN public.buildings b
        ON b.id = mr.building_id
       AND b.organization_id = p_organization_id
       AND b.deleted_at IS NULL
       AND b.id = ANY(v_buildings)
      LEFT JOIN public.rooms rm
        ON rm.id = mr.room_id
       AND rm.organization_id = p_organization_id
       AND rm.deleted_at IS NULL
      WHERE mr.organization_id = p_organization_id
        AND mr.deleted_at IS NULL
        AND mr.settlement_month = v_ky
        -- A3: RLS `meter_readings_select_rbac` hands a reading with NO building
        -- to is_super_admin() OR is_admin() and to nobody else. Org-wide alone
        -- was wider than the screen. (`is_admin()` delegates to is_super_admin()
        -- today; both are written so the predicate keeps mirroring the policy if
        -- that ever changes back.)
        AND (b.id IS NOT NULL OR (mr.building_id IS NULL AND v_org_wide AND (public.is_admin() OR public.is_super_admin())))
        AND (p_building_id IS NULL OR mr.building_id = p_building_id)
      ORDER BY b.name NULLS LAST, rm.name NULLS LAST, mr.meter_type::text, mr.id
      LIMIT v_limit
    ) s;

  RETURN jsonb_build_object(
    'ky', v_ky,
    'gioi_han', v_limit,
    'so_luong', jsonb_array_length(v_rows),
    'tong_hop', v_tong_hop,
    'chi_so', v_rows
  );
END
$fn$;

-- copilot_vehicle_search_v1(uuid, text, integer) ----------------------------
CREATE OR REPLACE FUNCTION public.copilot_vehicle_search_v1(
  p_organization_id uuid,
  p_query text DEFAULT NULL,
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
  v_query text := NULLIF(btrim(coalesce(p_query, '')), '');
  v_needle text;
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_rows jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;

  v_buildings := public.copilot_org_scope_buildings_v1('vehicles.view', p_organization_id);
  SELECT COALESCE(s.org_wide, false) INTO v_org_wide
  FROM app_private.authorized_scope_v3('vehicles.view', p_organization_id) s;
  -- A6: the needle is folded FIRST (the column side folds too) and only then
  -- escaped, so a resident typing "50%" or "a_b" searches for those characters
  -- instead of turning them into LIKE wildcards. A trailing backslash used to
  -- reach LIKE unescaped and raise 22025.
  v_needle := CASE
                WHEN v_query IS NULL THEN NULL
                ELSE '%' || app_private.copilot_like_escape_v1(app_private.copilot_fold_text_v1(v_query)) || '%'
              END;

  SELECT COALESCE(jsonb_agg(
           jsonb_build_object(
             'xe_id', s.id,
             'bien_so', s.license_plate,
             'loai_xe', s.vehicle_kind,
             'mo_ta', s.description,
             'chu_xe', s.owner_label,
             'phong', s.room_name,
             'toa_nha', s.building_name,
             'phi_gui', s.parking_fee,
             'ma_the', s.ticket_number
           ) ORDER BY s.rn
         ), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT
        v.id,
        v.license_plate,
        v.vehicle_type::text AS vehicle_kind,
        NULLIF(btrim(concat_ws(' ', NULLIF(v.brand, ''), NULLIF(v.model, ''), NULLIF(v.color, ''))), '') AS description,
        COALESCE(NULLIF(btrim(coalesce(v.owner_name, '')), ''), cst.full_name, NULLIF(v.vehicle_name, '')) AS owner_label,
        rm.name AS room_name,
        b.name AS building_name,
        v.parking_fee,
        v.ticket_number,
        row_number() OVER (
          ORDER BY b.name NULLS LAST, rm.name NULLS LAST, v.license_plate NULLS LAST, v.id
        ) AS rn
      FROM public.vehicles v
      LEFT JOIN public.buildings b
        ON b.id = v.building_id
       AND b.organization_id = p_organization_id
       AND b.deleted_at IS NULL
       AND b.id = ANY(v_buildings)
      LEFT JOIN public.rooms rm
        ON rm.id = v.room_id
       AND rm.organization_id = p_organization_id
       AND rm.deleted_at IS NULL
      LEFT JOIN public.customers cst
        ON cst.id = v.customer_id
       AND cst.organization_id = p_organization_id
       AND cst.deleted_at IS NULL
      WHERE v.organization_id = p_organization_id
        AND v.deleted_at IS NULL
        -- A2: RLS `vehicles_select_rbac` admits a vehicle with NO building only
        -- when the caller can access the vehicles entity AND the row owner is one
        -- of `current_visible_owner_ids()`. Org-wide alone let a manager read
        -- building-less vehicle rows the screen would never show them.
        AND (
          b.id IS NOT NULL
          OR (
            v.building_id IS NULL
            AND v_org_wide
            AND v.user_id = ANY(public.current_visible_owner_ids())
          )
        )
        AND (
          v_needle IS NULL
          OR app_private.copilot_fold_text_v1(COALESCE(v.license_plate, '')) LIKE v_needle ESCAPE '\'
          OR app_private.copilot_fold_text_v1(COALESCE(v.owner_name, '')) LIKE v_needle ESCAPE '\'
          OR app_private.copilot_fold_text_v1(COALESCE(v.ticket_number, '')) LIKE v_needle ESCAPE '\'
          OR app_private.copilot_fold_text_v1(COALESCE(rm.name, '')) LIKE v_needle ESCAPE '\'
          OR app_private.copilot_fold_text_v1(COALESCE(cst.full_name, '')) LIKE v_needle ESCAPE '\'
        )
      ORDER BY b.name NULLS LAST, rm.name NULLS LAST, v.license_plate NULLS LAST, v.id
      LIMIT v_limit
    ) s;

  RETURN jsonb_build_object(
    'gioi_han', v_limit,
    'so_luong', jsonb_array_length(v_rows),
    'xe', v_rows
  );
END
$fn$;

-- copilot_material_stock_v1(uuid, text, integer) ----------------------------
CREATE OR REPLACE FUNCTION public.copilot_material_stock_v1(
  p_organization_id uuid,
  p_query text DEFAULT NULL,
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
  v_org_wide boolean := false;
  v_buildings uuid[] := '{}'::uuid[];
  v_query text := NULLIF(btrim(coalesce(p_query, '')), '');
  v_needle text;
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_rows jsonb;
  v_tong_hop jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;

  -- A1 (Critical). The previous body PERFORMed the scope helper and discarded
  -- the result, and the comment above the old function claimed the helper
  -- "denies". It does not: copilot_org_scope_buildings_v1 raises only for a
  -- missing organization, a NULL actor or a revoked membership. A member with
  -- NO materials.view grant at all — or one under an emergency DENY — got back
  -- an empty array, the array was then discarded, and the query below returned
  -- the WHOLE company stock, quantities and valuation included.
  --
  -- The permission is read directly now, and it is the gate. public.materials
  -- has no building column (its RLS boundary is can_access_org_entity, i.e. the
  -- company), so there is no building predicate to bind: holding ANY materials
  -- grant in this organization is what the screen requires and what is checked.
  -- The helper is still called FIRST so a bad organization keeps answering
  -- 'organization_required' (22023) instead of 'not_permitted' (42501).
  PERFORM public.copilot_org_scope_buildings_v1('materials.view', p_organization_id);
  SELECT COALESCE(s.org_wide, false), COALESCE(s.building_ids, '{}'::uuid[])
    INTO v_org_wide, v_buildings
    FROM app_private.authorized_scope_v3('materials.view', p_organization_id) s;
  IF NOT v_org_wide AND COALESCE(cardinality(v_buildings), 0) = 0 THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;
  -- A6: the needle is folded FIRST (the column side folds too) and only then
  -- escaped, so a resident typing "50%" or "a_b" searches for those characters
  -- instead of turning them into LIKE wildcards. A trailing backslash used to
  -- reach LIKE unescaped and raise 22025.
  v_needle := CASE
                WHEN v_query IS NULL THEN NULL
                ELSE '%' || app_private.copilot_like_escape_v1(app_private.copilot_fold_text_v1(v_query)) || '%'
              END;

  -- Aggregated over the WHOLE match set, so "how many are running out" stays a
  -- true number even when the list below is capped at `v_limit`.
  SELECT jsonb_build_object(
           'so_mat_hang', count(*),
           'so_mat_hang_thieu', count(*) FILTER (WHERE m.on_hand < m.reorder_level),
           'gia_tri_ton', COALESCE(sum(m.on_hand * m.avg_unit_cost), 0)
         )
    INTO v_tong_hop
    FROM public.materials m
    WHERE m.organization_id = p_organization_id
      AND m.deleted_at IS NULL
      AND (
        v_needle IS NULL
        OR app_private.copilot_fold_text_v1(COALESCE(m.name, '')) LIKE v_needle ESCAPE '\'
        OR app_private.copilot_fold_text_v1(COALESCE(m.code, '')) LIKE v_needle ESCAPE '\'
      );

  SELECT COALESCE(jsonb_agg(
           jsonb_build_object(
             'vat_tu_id', s.id,
             'ma', s.code,
             'ten', s.name,
             'nhom', s.category_name,
             'don_vi', s.unit,
             'ton_kho', s.on_hand,
             'muc_dat_lai', s.reorder_level,
             'duoi_muc', s.below_reorder,
             'gia_binh_quan', s.avg_unit_cost,
             'gia_tri_ton', s.stock_value
           ) ORDER BY s.rn
         ), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT
        m.id,
        m.code,
        m.name,
        mc.name AS category_name,
        m.unit,
        m.on_hand,
        m.reorder_level,
        (m.on_hand < m.reorder_level) AS below_reorder,
        m.avg_unit_cost,
        (m.on_hand * m.avg_unit_cost) AS stock_value,
        row_number() OVER (
          ORDER BY (m.on_hand < m.reorder_level) DESC, m.name, m.id
        ) AS rn
      FROM public.materials m
      LEFT JOIN public.material_categories mc
        ON mc.id = m.category_id
       AND mc.organization_id = p_organization_id
      WHERE m.organization_id = p_organization_id
        AND m.deleted_at IS NULL
        AND (
          v_needle IS NULL
          OR app_private.copilot_fold_text_v1(COALESCE(m.name, '')) LIKE v_needle ESCAPE '\'
          OR app_private.copilot_fold_text_v1(COALESCE(m.code, '')) LIKE v_needle ESCAPE '\'
        )
      ORDER BY (m.on_hand < m.reorder_level) DESC, m.name, m.id
      LIMIT v_limit
    ) s;

  RETURN jsonb_build_object(
    'gioi_han', v_limit,
    'so_luong', jsonb_array_length(v_rows),
    'tong_hop', COALESCE(v_tong_hop, jsonb_build_object('so_mat_hang', 0, 'so_mat_hang_thieu', 0, 'gia_tri_ton', 0)),
    'vat_tu', v_rows
  );
END
$fn$;

-- copilot_invoice_search_v1(uuid, text, text, text) -------------------------
CREATE OR REPLACE FUNCTION public.copilot_invoice_search_v1(p_organization_id uuid, p_billing_month text DEFAULT NULL, p_payment_status text DEFAULT NULL, p_search text DEFAULT NULL)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',s.id,'invoice_number',s.invoice_number,'billing_month',s.billing_month,'total_amount',s.total_amount,'status',s.status,'building_id',s.building_id,'building_name',s.building_name,'room_id',s.room_id,'room_name',s.room_name) ORDER BY s.billing_month DESC, s.created_at DESC), '[]'::jsonb)
  FROM (
    SELECT i.id, i.invoice_number, i.billing_month, i.total_amount, i.status, i.building_id, b.name AS building_name, i.room_id, r.name AS room_name, i.created_at
    FROM public.invoices i
    JOIN public.rooms r ON r.id = i.room_id
    JOIN public.buildings b ON b.id = r.building_id
    WHERE i.organization_id = p_organization_id AND i.deleted_at IS NULL
      AND r.building_id = ANY(public.copilot_org_scope_buildings_v1('invoices.view', p_organization_id))
      AND (p_billing_month IS NULL OR i.billing_month = p_billing_month)
      AND (p_payment_status IS NULL OR (p_payment_status = 'paid' AND i.status = 'PAID') OR (p_payment_status = 'partial' AND i.status = 'PARTIAL_PAID') OR (p_payment_status = 'unpaid' AND i.status NOT IN ('PAID','PARTIAL_PAID')))
      -- A6 + operations review: the needle is escaped, and the customer join now
      -- carries the organization and soft-delete filters it never had.
      AND (p_search IS NULL OR i.invoice_number ILIKE '%' || app_private.copilot_like_escape_v1(p_search) || '%' ESCAPE '\'
        OR EXISTS (SELECT 1 FROM public.contract_customers cc JOIN public.customers c ON c.id = cc.customer_id AND c.organization_id = p_organization_id AND c.deleted_at IS NULL WHERE cc.organization_id = p_organization_id AND cc.contract_id = i.contract_id AND c.full_name ILIKE '%' || app_private.copilot_like_escape_v1(p_search) || '%' ESCAPE '\'))
    ORDER BY i.billing_month DESC, i.created_at DESC
    LIMIT 2000
  ) s;
$$;

-- copilot_customer_search_v1(uuid, text) ------------------------------------
CREATE OR REPLACE FUNCTION public.copilot_customer_search_v1(
  p_organization_id uuid,
  p_search text
)
RETURNS TABLE(
  customer_id uuid,
  customer_name text,
  phone text,
  contract_id uuid,
  contract_number text,
  contract_status text,
  room_id uuid,
  room_name text,
  building_id uuid,
  building_name text,
  is_representative boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_buildings uuid[];
  v_query text := NULLIF(btrim(p_search), '');
BEGIN
  IF p_organization_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.organizations o
    WHERE o.id = p_organization_id AND o.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'organization_required' USING ERRCODE = '22023';
  END IF;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;

  -- This validates the selected org, active membership, permission and denies.
  v_buildings := public.copilot_org_scope_buildings_v1('customers.view', p_organization_id);

  RETURN QUERY
  WITH candidates AS (
    SELECT
      cst.id AS customer_id,
      cst.full_name AS customer_name,
      cst.phone,
      ct.id AS contract_id,
      ct.contract_number,
      ct.status::text AS contract_status,
      rm.id AS room_id,
      rm.name AS room_name,
      b.id AS building_id,
      b.name AS building_name,
      cc.is_representative,
      row_number() OVER (
        PARTITION BY cst.id
        ORDER BY
          CASE WHEN ct.status IN ('ACTIVE', 'EXTENDED') THEN 0 ELSE 1 END,
          COALESCE(ct.actual_end_date, ct.end_date) DESC NULLS LAST,
          ct.updated_at DESC
      ) AS row_rank
    FROM public.customers cst
    JOIN public.contract_customers cc
      ON cc.customer_id = cst.id
     AND cc.organization_id = p_organization_id
    JOIN public.contracts ct
      ON ct.id = cc.contract_id
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
    WHERE cst.organization_id = p_organization_id
      AND cst.deleted_at IS NULL
      AND (
        v_query IS NULL
        OR cst.full_name ILIKE '%' || app_private.copilot_like_escape_v1(v_query) || '%' ESCAPE '\'
        OR cst.phone ILIKE '%' || app_private.copilot_like_escape_v1(v_query) || '%' ESCAPE '\'
      )
  )
  SELECT
    c.customer_id,
    c.customer_name,
    c.phone,
    c.contract_id,
    c.contract_number,
    c.contract_status,
    c.room_id,
    c.room_name,
    c.building_id,
    c.building_name,
    c.is_representative
  FROM candidates c
  WHERE c.row_rank = 1
  ORDER BY c.customer_name, c.customer_id
  LIMIT 10;
END
$fn$;

-- copilot_report_expense_ratio_v1(uuid, date, date, uuid, integer) ----------
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

-- copilot_report_daily_cashbook_v1(uuid, date, date, uuid, integer) ---------
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
  -- A6: a window wider than three years is refused instead of being answered.
  -- 1096 days = 3 calendar years plus one leap day.
  IF p_tu IS NULL OR p_den IS NULL OR p_tu > p_den OR (p_den - p_tu) > 1096 THEN
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

-- copilot_report_cash_flow_v1(uuid, date, date, uuid, integer) --------------
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
  -- A6: a window wider than three years is refused instead of being answered.
  -- 1096 days = 3 calendar years plus one leap day.
  IF p_tu IS NULL OR p_den IS NULL OR p_tu > p_den OR (p_den - p_tu) > 1096 THEN
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

-- copilot_salary_summary_v1(uuid, text, integer) ----------------------------
CREATE OR REPLACE FUNCTION public.copilot_salary_summary_v1(
  p_organization_id uuid,
  p_ky text DEFAULT NULL,
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
  v_org_wide boolean;
  v_xem_duoc boolean := false;
  v_buildings uuid[] := '{}'::uuid[];
  v_today date;
  v_ky date;
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_tong_hop jsonb;
  v_rows jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;
  IF p_ky IS NOT NULL AND p_ky !~ '^[0-9]{4}-[0-9]{2}$' THEN
    RAISE EXCEPTION 'invalid_period' USING ERRCODE = '22023';
  END IF;
  -- A5. Until this migration the three copilot.sensitive.* rollout flags were
  -- checked in TypeScript only, so calling the RPC straight through PostgREST
  -- returned the payroll with the switch still off. The switch now lives on
  -- the server as well; the client keeps its own check so the tool is never
  -- even offered, and the two agree by reading the SAME row.
  IF NOT app_private.copilot_page_flag_allows_v1('copilot.sensitive.salary', p_organization_id) THEN
    RAISE EXCEPTION 'copilot_feature_disabled' USING ERRCODE = '42501';
  END IF;

  -- Validates organization, membership and denies. Never trusted input. The
  -- RETURN VALUE is deliberately not kept: `salary_monthly` has no `building_id`
  -- column at all (20260628000001), so there is no building predicate for it to
  -- bind to, and holding a building array that nothing reads would look like a
  -- boundary that does not exist.
  PERFORM public.copilot_org_scope_buildings_v1('salary.view', p_organization_id);

  -- A1: salary.view is still required to ask the question at all. The helper
  -- above does NOT enforce that (it returns an empty array for a caller with no
  -- grant), so the key is read here and an absent grant is a permission error.
  SELECT COALESCE(s.org_wide, false), COALESCE(s.building_ids, '{}'::uuid[])
    INTO v_xem_duoc, v_buildings
    FROM app_private.authorized_scope_v3('salary.view', p_organization_id) s;
  IF NOT v_xem_duoc AND COALESCE(cardinality(v_buildings), 0) = 0 THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;

  -- A4: salary.view IS NOT the admin switch. /finance/salary decides admin vs
  -- self with salary.lock OR salary.manage_salary OR salary.distribute
  -- (ManagerSalaryPage.tsx), and RLS backs that with sm_owner_all / sm_self_select.
  -- salary.view is the NAV-surface permission: plenty of staff hold it. Using it
  -- as the org-wide switch meant an employee asking Copilot received the TAKE-HOME
  -- PAY of every colleague — data their own screen never shows them.
  --
  -- Any ONE of the three management keys, org-wide, opens the whole company; a
  -- building-scoped grant does not, because payroll has no building axis to
  -- narrow by and "some buildings" would silently mean "everybody".
  SELECT bool_or(COALESCE(s.org_wide, false)) INTO v_org_wide
    FROM unnest(ARRAY[
           'salary.lock',
           'salary.manage_salary',
           'salary.distribute'
         ]) AS k(khoa)
   CROSS JOIN LATERAL app_private.authorized_scope_v3(k.khoa, p_organization_id) s;
  v_org_wide := COALESCE(v_org_wide, false) OR public.is_super_admin();
  v_today := public.org_today_v1(p_organization_id);

  -- Default period: the newest payroll month that actually exists inside the
  -- scope, else this month. Defaulting blindly to "this month" answers "no data"
  -- to a question that has an answer, because a payroll row is created when the
  -- month is computed, not when the month starts.
  IF p_ky IS NOT NULL THEN
    v_ky := to_date(p_ky || '-01', 'YYYY-MM-DD');
  ELSE
    SELECT max(sm.period_month) INTO v_ky
      FROM public.salary_monthly sm
     WHERE sm.organization_id = p_organization_id
       AND (v_org_wide OR sm.staff_id = v_actor);
    v_ky := COALESCE(v_ky, date_trunc('month', v_today)::date);
  END IF;

  WITH luong AS (
    SELECT
      sm.id,
      sm.staff_id,
      sm.status,
      sm.base_salary,
      sm.work_bonus,
      sm.contract_bonus,
      sm.commission_total,
      sm.investment_profit,
      sm.adjustments_total,
      sm.advances_total,
      sm.room_rent,
      sm.gross_total,
      sm.take_home,
      sm.paid,
      sm.locked_at,
      -- Name lookup on a PRIMARY KEY, so it can neither add nor remove a row.
      -- It carries NO `pr.organization_id = p_organization_id` filter on purpose:
      -- `profiles.organization_id` is the person's HOME company and a manager may
      -- be a member of several, so filtering it would blank the name of exactly
      -- the people this answer is about.
      pr.full_name AS staff_name
    FROM public.salary_monthly sm
    LEFT JOIN public.profiles pr ON pr.id = sm.staff_id
    WHERE sm.organization_id = p_organization_id
      AND sm.period_month = v_ky
      -- Without an organization-wide grant this returns the caller's OWN row and
      -- nothing else. `staff_id`, not `user_id` — see the header.
      AND (v_org_wide OR sm.staff_id = v_actor)
  )
  SELECT
    jsonb_build_object(
      'so_nhan_vien', count(*),
      'tong_gross', COALESCE(sum(l.gross_total), 0),
      'tong_thuc_nhan', COALESCE(sum(l.take_home), 0),
      'tong_thuong', COALESCE(sum(l.work_bonus + l.contract_bonus + l.commission_total), 0),
      'tong_khau_tru', COALESCE(sum(l.advances_total + l.room_rent), 0),
      'tong_da_tra', COALESCE(sum(l.paid), 0),
      'so_ky_da_chot', count(*) FILTER (WHERE l.status = 'LOCKED')
    ),
    COALESCE((
      SELECT jsonb_agg(
               jsonb_build_object(
                 'nhan_vien_id', s.staff_id,
                 'nhan_vien', s.staff_name,
                 'trang_thai', s.status,
                 'luong_co_ban', s.base_salary,
                 'thuong_viec', s.work_bonus,
                 'thuong_hop_dong', s.contract_bonus,
                 'hoa_hong', s.commission_total,
                 'loi_nhuan_dau_tu', s.investment_profit,
                 'dieu_chinh', s.adjustments_total,
                 'ung_luong', s.advances_total,
                 'tien_phong', s.room_rent,
                 'tong_gross', s.gross_total,
                 'thuc_nhan', s.take_home,
                 'da_tra', s.paid,
                 'chot_luc', s.locked_at
               ) ORDER BY s.rn
             )
      FROM (
        SELECT
          l2.*,
          row_number() OVER (ORDER BY l2.take_home DESC, l2.staff_name NULLS LAST, l2.id) AS rn
        FROM luong l2
        ORDER BY l2.take_home DESC, l2.staff_name NULLS LAST, l2.id
        LIMIT v_limit
      ) s
    ), '[]'::jsonb)
  INTO v_tong_hop, v_rows
  FROM luong l;

  RETURN jsonb_build_object(
    'ky', to_char(v_ky, 'YYYY-MM'),
    -- The answer says which of the two branches produced it, so a reply built
    -- from it can never present one person's row as the whole payroll.
    'pham_vi', CASE WHEN v_org_wide THEN 'toan_cong_ty' ELSE 'chi_minh_toi' END,
    'gioi_han', v_limit,
    'so_luong', jsonb_array_length(v_rows),
    'tong_hop', COALESCE(v_tong_hop, jsonb_build_object(
      'so_nhan_vien', 0, 'tong_gross', 0, 'tong_thuc_nhan', 0, 'tong_thuong', 0,
      'tong_khau_tru', 0, 'tong_da_tra', 0, 'so_ky_da_chot', 0)),
    'bang_luong', v_rows
  );
END
$fn$;

-- copilot_shareholder_profit_v1(uuid, text, integer) ------------------------
CREATE OR REPLACE FUNCTION public.copilot_shareholder_profit_v1(
  p_organization_id uuid,
  p_ky text DEFAULT NULL,
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
  v_org_wide boolean;
  v_quan_ly boolean;
  v_co_dong_id uuid;
  v_quan_ly_ln_id uuid;
  v_today date;
  v_ky date;
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_tong_hop jsonb;
  v_rows jsonb;
  v_co_dong jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;
  IF p_ky IS NOT NULL AND p_ky !~ '^[0-9]{4}-[0-9]{2}$' THEN
    RAISE EXCEPTION 'invalid_period' USING ERRCODE = '22023';
  END IF;
  -- A5. Until this migration the three copilot.sensitive.* rollout flags were
  -- checked in TypeScript only, so calling the RPC straight through PostgREST
  -- returned shareholder payouts with the switch still off. The switch now lives on
  -- the server as well; the client keeps its own check so the tool is never
  -- even offered, and the two agree by reading the SAME row.
  IF NOT app_private.copilot_page_flag_allows_v1('copilot.sensitive.shareholder-profit', p_organization_id) THEN
    RAISE EXCEPTION 'copilot_feature_disabled' USING ERRCODE = '42501';
  END IF;

  -- Validates organization, membership, permission and denies. Never trusted input.
  v_buildings := public.copilot_org_scope_buildings_v1('shareholder_profit.view', p_organization_id);
  SELECT s.org_wide INTO v_org_wide
    FROM app_private.authorized_scope_v3('shareholder_profit.view', p_organization_id) s;
  v_org_wide := COALESCE(v_org_wide, false);

  -- shareholder_profit.view ALONE DOES NOT MEAN "MAY SEE EVERYONE'S SHARE".
  --
  -- 20260713110400 (ledger-applied) inserts a member_permission_overrides row
  -- granting exactly shareholder_profit.view ALLOW to every ACTIVE membership
  -- whose user is a shareholders.auth_user_id or a profit_managers.auth_user_id
  -- — four such memberships exist on production as of 02/09/2026. The key is
  -- ORGANIZATION-only, so authorized_scope_v3 resolves org_wide = true for those
  -- people and v_buildings becomes every building of the company.
  --
  -- On the SCREEN that grant is harmless, because RLS narrows it again:
  --   profit_alloc_self_select     shareholder_id = current_shareholder_id()
  --   profit_monthly_self_select   EXISTS(an allocation of mine on this month)
  --   profit_monthly_self_manager  EXISTS(a manager allocation of mine)
  --   pma_self_select              manager_id = current_profit_manager_id()
  -- A shareholder therefore sees their OWN payout and nothing else.
  --
  -- This function is SECURITY DEFINER, so none of those policies run. Without
  -- the branch below, a shareholder asking Copilot would receive every
  -- co-shareholder NAME and AMOUNT — strictly wider than their own screen, and
  -- produced by the very permission that screen gives them.
  --
  -- The discriminator is a management key of the SAME page that the override
  -- does NOT confer: shareholder_profit.lock (close the month) and
  -- .manage_shareholders (own the shareholder register). Both are active in
  -- permission_definitions, both are ORGANIZATION-only, and no migration grants
  -- either of them to a shareholder.
  SELECT COALESCE(l.org_wide, false) OR COALESCE(m.org_wide, false)
    INTO v_quan_ly
    FROM app_private.authorized_scope_v3('shareholder_profit.lock', p_organization_id) l
    CROSS JOIN app_private.authorized_scope_v3('shareholder_profit.manage_shareholders', p_organization_id) m;
  v_quan_ly := COALESCE(v_quan_ly, false);

  IF NOT v_quan_ly THEN
    -- The same two helpers the RLS policies use, so "mine" means the same thing
    -- in both places. Either may be NULL (a plain member is neither), and NULL
    -- never equals a row, so the restriction below fails closed.
    v_co_dong_id := public.current_shareholder_id();
    v_quan_ly_ln_id := public.current_profit_manager_id();
  END IF;

  v_today := public.org_today_v1(p_organization_id);

  -- Same default rule as the payroll: the newest month that exists in scope. A
  -- profit month only exists once the close run has produced it.
  IF p_ky IS NOT NULL THEN
    v_ky := to_date(p_ky || '-01', 'YYYY-MM-DD');
  ELSE
    SELECT max(pm.period_month) INTO v_ky
      FROM public.profit_monthly pm
      JOIN public.buildings b
        ON b.id = pm.building_id
       AND b.organization_id = p_organization_id
       AND b.deleted_at IS NULL
       AND b.id = ANY(v_buildings)
     WHERE pm.organization_id = p_organization_id
       -- The DEFAULT period is chosen by a real query against this table, so it
       -- carries the same restriction as the answer. Without it, the newest
       -- month of SOMEBODY ELSE decides which month a shareholder is shown.
       AND (
         v_quan_ly
         OR EXISTS (
           SELECT 1
           FROM public.profit_allocations pa0
           WHERE pa0.profit_monthly_id = pm.id
             AND pa0.organization_id = p_organization_id
             AND pa0.shareholder_id = v_co_dong_id
         )
         OR EXISTS (
           SELECT 1
           FROM public.profit_manager_allocations pma0
           WHERE pma0.profit_monthly_id = pm.id
             AND pma0.organization_id = p_organization_id
             AND pma0.manager_id = v_quan_ly_ln_id
         )
       );
    v_ky := COALESCE(v_ky, date_trunc('month', v_today)::date);
  END IF;

  WITH ky AS (
    SELECT
      pm.id,
      pm.building_id,
      b.name AS building_name,
      pm.status,
      pm.computed_profit,
      pm.adjusted_profit,
      pm.management_salary,
      pm.shareholder_percent_total,
      pm.shareholder_allocated_amount,
      pm.unallocated_profit,
      pm.unallocated_disposition,
      pm.is_stale,
      pm.locked_at
    FROM public.profit_monthly pm
    JOIN public.buildings b
      ON b.id = pm.building_id
     AND b.organization_id = p_organization_id
     AND b.deleted_at IS NULL
     AND b.id = ANY(v_buildings)
    WHERE pm.organization_id = p_organization_id
      AND pm.period_month = v_ky
      -- Mirrors profit_monthly_self_select + profit_monthly_self_manager.
      AND (
        v_quan_ly
        OR EXISTS (
          SELECT 1
          FROM public.profit_allocations pa1
          WHERE pa1.profit_monthly_id = pm.id
            AND pa1.organization_id = p_organization_id
            AND pa1.shareholder_id = v_co_dong_id
        )
        OR EXISTS (
          SELECT 1
          FROM public.profit_manager_allocations pma1
          WHERE pma1.profit_monthly_id = pm.id
            AND pma1.organization_id = p_organization_id
            AND pma1.manager_id = v_quan_ly_ln_id
        )
      )
  )
  SELECT
    jsonb_build_object(
      'so_toa', count(*),
      'loi_nhuan_tinh', COALESCE(sum(k.computed_profit), 0),
      'loi_nhuan_sau_dieu_chinh', COALESCE(sum(k.adjusted_profit), 0),
      'luong_quan_ly', COALESCE(sum(k.management_salary), 0),
      'da_chia_co_dong', COALESCE(sum(k.shareholder_allocated_amount), 0),
      'chua_chia', COALESCE(sum(k.unallocated_profit), 0),
      'so_toa_da_chot', count(*) FILTER (WHERE k.status = 'LOCKED'),
      'so_toa_can_tinh_lai', count(*) FILTER (WHERE k.is_stale)
    ),
    COALESCE((
      SELECT jsonb_agg(
               jsonb_build_object(
                 'toa_nha_id', s.building_id,
                 'toa_nha', s.building_name,
                 'trang_thai', s.status,
                 'loi_nhuan_tinh', s.computed_profit,
                 'loi_nhuan_sau_dieu_chinh', s.adjusted_profit,
                 'luong_quan_ly', s.management_salary,
                 'ty_le_co_dong', s.shareholder_percent_total,
                 'da_chia_co_dong', s.shareholder_allocated_amount,
                 'chua_chia', s.unallocated_profit,
                 'xu_ly_phan_chua_chia', s.unallocated_disposition,
                 'can_tinh_lai', s.is_stale,
                 'chot_luc', s.locked_at
               ) ORDER BY s.rn
             )
      FROM (
        SELECT
          k2.*,
          row_number() OVER (ORDER BY k2.adjusted_profit DESC, k2.building_name, k2.id) AS rn
        FROM ky k2
        ORDER BY k2.adjusted_profit DESC, k2.building_name, k2.id
        LIMIT v_limit
      ) s
    ), '[]'::jsonb)
  INTO v_tong_hop, v_rows
  FROM ky k;

  -- Per-shareholder rollup over the SAME scoped month set. The allocation rows
  -- reach the tenant boundary only through `ky`, which is already bound to the
  -- company and to the building scope; the company column is asserted on both the
  -- allocation and the shareholder anyway, because "it is implied by the join" is
  -- how a boundary quietly stops being one.
  WITH ky AS (
    SELECT pm.id
    FROM public.profit_monthly pm
    JOIN public.buildings b
      ON b.id = pm.building_id
     AND b.organization_id = p_organization_id
     AND b.deleted_at IS NULL
     AND b.id = ANY(v_buildings)
    WHERE pm.organization_id = p_organization_id
      AND pm.period_month = v_ky
      -- Same restriction as the CTE above; the two must not drift apart.
      AND (
        v_quan_ly
        OR EXISTS (
          SELECT 1
          FROM public.profit_allocations pa1
          WHERE pa1.profit_monthly_id = pm.id
            AND pa1.organization_id = p_organization_id
            AND pa1.shareholder_id = v_co_dong_id
        )
        OR EXISTS (
          SELECT 1
          FROM public.profit_manager_allocations pma1
          WHERE pma1.profit_monthly_id = pm.id
            AND pma1.organization_id = p_organization_id
            AND pma1.manager_id = v_quan_ly_ln_id
        )
      )
  ), chia AS (
    SELECT
      sh.id AS shareholder_id,
      sh.name AS shareholder_name,
      sum(pa.amount) AS amount,
      sum(pa.percent) AS percent_sum,
      count(*) AS so_toa
    FROM public.profit_allocations pa
    JOIN ky ON ky.id = pa.profit_monthly_id
    JOIN public.shareholders sh
      ON sh.id = pa.shareholder_id
     AND sh.organization_id = p_organization_id
     AND sh.deleted_at IS NULL
    WHERE pa.organization_id = p_organization_id
      -- Mirrors profit_alloc_self_select. THIS is the line that decides whether
      -- a shareholder sees their co-shareholders' payouts.
      AND (v_quan_ly OR pa.shareholder_id = v_co_dong_id)
    GROUP BY sh.id, sh.name
  )
  SELECT COALESCE((
    SELECT jsonb_agg(
             jsonb_build_object(
               'co_dong_id', s.shareholder_id,
               'co_dong', s.shareholder_name,
               'so_tien', s.amount,
               'tong_ty_le', s.percent_sum,
               'so_toa', s.so_toa
             ) ORDER BY s.rn
           )
    FROM (
      SELECT c2.*, row_number() OVER (ORDER BY c2.amount DESC, c2.shareholder_name) AS rn
      FROM chia c2
      ORDER BY c2.amount DESC, c2.shareholder_name
      LIMIT v_limit
    ) s
  ), '[]'::jsonb)
  INTO v_co_dong;

  RETURN jsonb_build_object(
    'ky', to_char(v_ky, 'YYYY-MM'),
    -- Same contract as the payroll: the answer states which branch produced it,
    -- so a reply built from it can never present one shareholder's own payout as
    -- the whole distribution.
    'pham_vi', CASE WHEN v_quan_ly THEN 'toan_cong_ty' ELSE 'chi_minh_toi' END,
    'gioi_han', v_limit,
    'so_luong', jsonb_array_length(v_rows),
    'tong_hop', COALESCE(v_tong_hop, jsonb_build_object(
      'so_toa', 0, 'loi_nhuan_tinh', 0, 'loi_nhuan_sau_dieu_chinh', 0,
      'luong_quan_ly', 0, 'da_chia_co_dong', 0, 'chua_chia', 0,
      'so_toa_da_chot', 0, 'so_toa_can_tinh_lai', 0)),
    'theo_toa', v_rows,
    'theo_co_dong', v_co_dong
  );
END
$fn$;

-- copilot_zalo_conversations_v1(uuid, text, integer) ------------------------
CREATE OR REPLACE FUNCTION public.copilot_zalo_conversations_v1(
  p_organization_id uuid,
  p_query text DEFAULT NULL,
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
  v_org_wide boolean;
  v_query text := NULLIF(btrim(coalesce(p_query, '')), '');
  v_needle text;
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_tong_hop jsonb;
  v_rows jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;

  -- Validates organization, membership, permission and denies. Never trusted input.
  v_buildings := public.copilot_org_scope_buildings_v1('chat_zalo.view', p_organization_id);
  SELECT s.org_wide INTO v_org_wide
    FROM app_private.authorized_scope_v3('chat_zalo.view', p_organization_id) s;
  v_org_wide := COALESCE(v_org_wide, false);
  -- A6: the needle is folded FIRST (the column side folds too) and only then
  -- escaped, so a resident typing "50%" or "a_b" searches for those characters
  -- instead of turning them into LIKE wildcards. A trailing backslash used to
  -- reach LIKE unescaped and raise 22025.
  v_needle := CASE
                WHEN v_query IS NULL THEN NULL
                ELSE '%' || app_private.copilot_like_escape_v1(app_private.copilot_fold_text_v1(v_query)) || '%'
              END;

  -- The search covers WHO the conversation is with, never WHAT was said. A needle
  -- matched against `last_message_text` would turn a conversation list into a
  -- full-text search over private chat, which is a different product with a
  -- different consent story.
  WITH hoi_thoai AS (
    SELECT
      c.id,
      c.peer_name,
      c.peer_phone,
      c.thread_type,
      c.kind,
      c.unread_count,
      c.marked_unread,
      c.is_pinned,
      c.last_message_at,
      c.last_message_dir,
      c.last_message_text,
      c.sub_label,
      rm.name AS room_name,
      b.name AS building_name
    FROM public.zalo_conversations c
    LEFT JOIN public.rooms rm
      ON rm.id = c.room_id
     AND rm.organization_id = p_organization_id
     AND rm.deleted_at IS NULL
    LEFT JOIN public.buildings b
      ON b.id = rm.building_id
     AND b.organization_id = p_organization_id
     AND b.deleted_at IS NULL
     AND b.id = ANY(v_buildings)
    WHERE c.organization_id = p_organization_id
      -- Source column, not the join result: a conversation attached to a room
      -- OUTSIDE the scope also yields `b.id IS NULL`, and must not be mistaken for
      -- one attached to no room at all.
      AND (b.id IS NOT NULL OR (c.room_id IS NULL AND v_org_wide))
      AND (
        v_needle IS NULL
        OR app_private.copilot_fold_text_v1(COALESCE(c.peer_name, '')) LIKE v_needle ESCAPE '\'
        OR app_private.copilot_fold_text_v1(COALESCE(c.peer_phone, '')) LIKE v_needle ESCAPE '\'
        OR app_private.copilot_fold_text_v1(COALESCE(c.sub_label, '')) LIKE v_needle ESCAPE '\'
      )
  )
  SELECT
    jsonb_build_object(
      'so_hoi_thoai', count(*),
      'so_chua_doc', count(*) FILTER (WHERE h.unread_count > 0 OR h.marked_unread),
      'tong_tin_chua_doc', COALESCE(sum(h.unread_count), 0),
      'so_ghim', count(*) FILTER (WHERE h.is_pinned)
    ),
    COALESCE((
      SELECT jsonb_agg(
               jsonb_build_object(
                 'hoi_thoai_id', s.id,
                 'nguoi_nhan', s.peer_name,
                 'dien_thoai', s.peer_phone,
                 'loai', s.thread_type,
                 'nhom', s.kind,
                 'chua_doc', s.unread_count,
                 'danh_dau_chua_doc', s.marked_unread,
                 'ghim', s.is_pinned,
                 'phong', s.room_name,
                 'toa_nha', s.building_name,
                 'nhan', s.sub_label,
                 'tin_cuoi_luc', s.last_message_at,
                 'tin_cuoi_chieu', s.last_message_dir,
                 -- Truncated at the server: a conversation list needs a preview,
                 -- not a transcript, and a cap here is one less thing for the
                 -- client to forget.
                 'tin_cuoi', left(COALESCE(s.last_message_text, ''), 160)
               ) ORDER BY s.rn
             )
      FROM (
        SELECT
          h2.*,
          row_number() OVER (ORDER BY h2.last_message_at DESC NULLS LAST, h2.id) AS rn
        FROM hoi_thoai h2
        ORDER BY h2.last_message_at DESC NULLS LAST, h2.id
        LIMIT v_limit
      ) s
    ), '[]'::jsonb)
  INTO v_tong_hop, v_rows
  FROM hoi_thoai h;

  RETURN jsonb_build_object(
    'gioi_han', v_limit,
    'so_luong', jsonb_array_length(v_rows),
    'tong_hop', COALESCE(v_tong_hop, jsonb_build_object(
      'so_hoi_thoai', 0, 'so_chua_doc', 0, 'tong_tin_chua_doc', 0, 'so_ghim', 0)),
    'hoi_thoai', v_rows
  );
END
$fn$;

-- copilot_network_status_v1(uuid, uuid, integer) ----------------------------
CREATE OR REPLACE FUNCTION public.copilot_network_status_v1(
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
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_tong_hop jsonb;
  v_rows jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;
  -- A5. Until this migration the three copilot.sensitive.* rollout flags were
  -- checked in TypeScript only, so calling the RPC straight through PostgREST
  -- returned router health with the switch still off. The switch now lives on
  -- the server as well; the client keeps its own check so the tool is never
  -- even offered, and the two agree by reading the SAME row.
  IF NOT app_private.copilot_page_flag_allows_v1('copilot.sensitive.network', p_organization_id) THEN
    RAISE EXCEPTION 'copilot_feature_disabled' USING ERRCODE = '42501';
  END IF;

  -- Validates organization, membership, permission and denies. Never trusted
  -- input. For THIS key the building array is the whole boundary: `org_wide` is
  -- always false for a permission declaring `required_dimensions = {BUILDING}`.
  v_buildings := public.copilot_org_scope_buildings_v1('network_center.view', p_organization_id);
  -- A building outside the caller scope answers like an empty report, never like
  -- "exists but not yours".
  IF p_building_id IS NOT NULL AND NOT (p_building_id = ANY(v_buildings)) THEN
    v_buildings := ARRAY[]::uuid[];
  END IF;

  WITH mang AS (
    SELECT
      b.id AS building_id,
      b.name AS building_name,
      rt.id AS router_id,
      rt.display_name AS router_name,
      rt.model AS router_model,
      rt.lifecycle_status,
      cur.reachable,
      cur.health_status,
      cur.last_seen_at,
      cur.routeros_version,
      cur.cpu_pct,
      cur.pppoe_state,
      cur.connection_count,
      (SELECT count(*)
         FROM public.network_incidents ni
        WHERE ni.organization_id = p_organization_id
          AND ni.building_id = b.id
          AND ni.status <> 'RESOLVED') AS open_incidents,
      (SELECT count(*)
         FROM public.network_client_current nc
        WHERE nc.organization_id = p_organization_id
          AND nc.building_id = b.id
          AND nc.expires_at > statement_timestamp()) AS active_clients,
      (SELECT jsonb_build_object(
                'tieu_de', ni2.title,
                'muc_do', ni2.severity,
                'trang_thai', ni2.status,
                'mo_luc', ni2.opened_at)
         FROM public.network_incidents ni2
        WHERE ni2.organization_id = p_organization_id
          AND ni2.building_id = b.id
        ORDER BY ni2.opened_at DESC, ni2.id
        LIMIT 1) AS last_incident
    FROM public.buildings b
    LEFT JOIN public.network_devices rt
      ON rt.organization_id = p_organization_id
     AND rt.building_id = b.id
     AND rt.device_kind = 'MIKROTIK'
     AND rt.is_active
    LEFT JOIN public.network_device_current cur
      ON cur.device_id = rt.id
     AND cur.organization_id = p_organization_id
    WHERE b.organization_id = p_organization_id
      AND b.deleted_at IS NULL
      AND b.is_virtual = false
      AND b.id = ANY(v_buildings)
      AND (p_building_id IS NULL OR b.id = p_building_id)
  )
  SELECT
    jsonb_build_object(
      'so_toa', count(*),
      'so_toa_co_router', count(*) FILTER (WHERE m.router_id IS NOT NULL),
      'so_toa_online', count(*) FILTER (WHERE COALESCE(m.reachable, false)),
      'so_toa_offline', count(*) FILTER (WHERE m.router_id IS NOT NULL AND NOT COALESCE(m.reachable, false)),
      'tong_su_co_mo', COALESCE(sum(m.open_incidents), 0),
      'tong_thiet_bi_ket_noi', COALESCE(sum(m.active_clients), 0)
    ),
    COALESCE((
      SELECT jsonb_agg(
               jsonb_build_object(
                 'toa_nha_id', s.building_id,
                 'toa_nha', s.building_name,
                 'router', s.router_name,
                 'model', s.router_model,
                 'vong_doi', s.lifecycle_status,
                 'ket_noi_duoc', COALESCE(s.reachable, false),
                 'suc_khoe', COALESCE(s.health_status, 'UNKNOWN'),
                 'thay_lan_cuoi', s.last_seen_at,
                 'phien_ban', s.routeros_version,
                 'cpu_phan_tram', s.cpu_pct,
                 'pppoe', s.pppoe_state,
                 'so_ket_noi', s.connection_count,
                 'su_co_dang_mo', s.open_incidents,
                 'thiet_bi_dang_ket_noi', s.active_clients,
                 'su_co_gan_nhat', s.last_incident
               ) ORDER BY s.rn
             )
      FROM (
        SELECT
          m2.*,
          row_number() OVER (
            ORDER BY m2.open_incidents DESC, COALESCE(m2.reachable, false), m2.building_name
          ) AS rn
        FROM mang m2
        ORDER BY m2.open_incidents DESC, COALESCE(m2.reachable, false), m2.building_name
        LIMIT v_limit
      ) s
    ), '[]'::jsonb)
  INTO v_tong_hop, v_rows
  FROM mang m;

  RETURN jsonb_build_object(
    'gioi_han', v_limit,
    'so_luong', jsonb_array_length(v_rows),
    'tong_hop', COALESCE(v_tong_hop, jsonb_build_object(
      'so_toa', 0, 'so_toa_co_router', 0, 'so_toa_online', 0, 'so_toa_offline', 0,
      'tong_su_co_mo', 0, 'tong_thiet_bi_ket_noi', 0)),
    'toa_nha', v_rows
  );
END
$fn$;

-- ============================================================================
-- ACL. CREATE OR REPLACE keeps the grants a function already had, so this block
-- re-states them rather than assuming; and it adds the service_role revoke the
-- two operations/report migrations never wrote (A6).
--
-- REVOKE FROM PUBLIC does NOT cut `anon` on Supabase: anon, authenticated and
-- service_role hold their own grants, so every role is named. The to_regrole
-- guards keep the block runnable on a bare cluster where the roles do not exist.
-- ============================================================================
REVOKE ALL ON FUNCTION public.copilot_contract_search_v1(uuid, text, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.copilot_income_expense_search_v1(uuid, text, date, date, text, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.copilot_pending_requests_v1(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.copilot_lead_search_v1(uuid, text, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.copilot_meter_readings_v1(uuid, text, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.copilot_vehicle_search_v1(uuid, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.copilot_material_stock_v1(uuid, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.copilot_invoice_search_v1(uuid, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.copilot_customer_search_v1(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.copilot_report_expense_ratio_v1(uuid, date, date, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.copilot_report_daily_cashbook_v1(uuid, date, date, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.copilot_report_cash_flow_v1(uuid, date, date, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.copilot_salary_summary_v1(uuid, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.copilot_shareholder_profit_v1(uuid, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.copilot_zalo_conversations_v1(uuid, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.copilot_network_status_v1(uuid, uuid, integer) FROM PUBLIC;

DO $acl$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_contract_search_v1(uuid, text, text, integer) FROM anon;
    REVOKE ALL ON FUNCTION public.copilot_income_expense_search_v1(uuid, text, date, date, text, text, integer) FROM anon;
    REVOKE ALL ON FUNCTION public.copilot_pending_requests_v1(uuid, integer) FROM anon;
    REVOKE ALL ON FUNCTION public.copilot_lead_search_v1(uuid, text, text, integer) FROM anon;
    REVOKE ALL ON FUNCTION public.copilot_meter_readings_v1(uuid, text, uuid, integer) FROM anon;
    REVOKE ALL ON FUNCTION public.copilot_vehicle_search_v1(uuid, text, integer) FROM anon;
    REVOKE ALL ON FUNCTION public.copilot_material_stock_v1(uuid, text, integer) FROM anon;
    REVOKE ALL ON FUNCTION public.copilot_invoice_search_v1(uuid, text, text, text) FROM anon;
    REVOKE ALL ON FUNCTION public.copilot_customer_search_v1(uuid, text) FROM anon;
    REVOKE ALL ON FUNCTION public.copilot_report_expense_ratio_v1(uuid, date, date, uuid, integer) FROM anon;
    REVOKE ALL ON FUNCTION public.copilot_report_daily_cashbook_v1(uuid, date, date, uuid, integer) FROM anon;
    REVOKE ALL ON FUNCTION public.copilot_report_cash_flow_v1(uuid, date, date, uuid, integer) FROM anon;
    REVOKE ALL ON FUNCTION public.copilot_salary_summary_v1(uuid, text, integer) FROM anon;
    REVOKE ALL ON FUNCTION public.copilot_shareholder_profit_v1(uuid, text, integer) FROM anon;
    REVOKE ALL ON FUNCTION public.copilot_zalo_conversations_v1(uuid, text, integer) FROM anon;
    REVOKE ALL ON FUNCTION public.copilot_network_status_v1(uuid, uuid, integer) FROM anon;
  END IF;

  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_contract_search_v1(uuid, text, text, integer) FROM authenticated;
    REVOKE ALL ON FUNCTION public.copilot_income_expense_search_v1(uuid, text, date, date, text, text, integer) FROM authenticated;
    REVOKE ALL ON FUNCTION public.copilot_pending_requests_v1(uuid, integer) FROM authenticated;
    REVOKE ALL ON FUNCTION public.copilot_lead_search_v1(uuid, text, text, integer) FROM authenticated;
    REVOKE ALL ON FUNCTION public.copilot_meter_readings_v1(uuid, text, uuid, integer) FROM authenticated;
    REVOKE ALL ON FUNCTION public.copilot_vehicle_search_v1(uuid, text, integer) FROM authenticated;
    REVOKE ALL ON FUNCTION public.copilot_material_stock_v1(uuid, text, integer) FROM authenticated;
    REVOKE ALL ON FUNCTION public.copilot_invoice_search_v1(uuid, text, text, text) FROM authenticated;
    REVOKE ALL ON FUNCTION public.copilot_customer_search_v1(uuid, text) FROM authenticated;
    REVOKE ALL ON FUNCTION public.copilot_report_expense_ratio_v1(uuid, date, date, uuid, integer) FROM authenticated;
    REVOKE ALL ON FUNCTION public.copilot_report_daily_cashbook_v1(uuid, date, date, uuid, integer) FROM authenticated;
    REVOKE ALL ON FUNCTION public.copilot_report_cash_flow_v1(uuid, date, date, uuid, integer) FROM authenticated;
    REVOKE ALL ON FUNCTION public.copilot_salary_summary_v1(uuid, text, integer) FROM authenticated;
    REVOKE ALL ON FUNCTION public.copilot_shareholder_profit_v1(uuid, text, integer) FROM authenticated;
    REVOKE ALL ON FUNCTION public.copilot_zalo_conversations_v1(uuid, text, integer) FROM authenticated;
    REVOKE ALL ON FUNCTION public.copilot_network_status_v1(uuid, uuid, integer) FROM authenticated;

    GRANT EXECUTE ON FUNCTION public.copilot_contract_search_v1(uuid, text, text, integer) TO authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_income_expense_search_v1(uuid, text, date, date, text, text, integer) TO authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_pending_requests_v1(uuid, integer) TO authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_lead_search_v1(uuid, text, text, integer) TO authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_meter_readings_v1(uuid, text, uuid, integer) TO authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_vehicle_search_v1(uuid, text, integer) TO authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_material_stock_v1(uuid, text, integer) TO authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_invoice_search_v1(uuid, text, text, text) TO authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_customer_search_v1(uuid, text) TO authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_report_expense_ratio_v1(uuid, date, date, uuid, integer) TO authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_report_daily_cashbook_v1(uuid, date, date, uuid, integer) TO authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_report_cash_flow_v1(uuid, date, date, uuid, integer) TO authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_salary_summary_v1(uuid, text, integer) TO authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_shareholder_profit_v1(uuid, text, integer) TO authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_zalo_conversations_v1(uuid, text, integer) TO authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_network_status_v1(uuid, uuid, integer) TO authenticated;
  END IF;

  -- A6: no Copilot read RPC is ever called with the service key. The two
  -- migrations that shipped these twenty-four functions revoked PUBLIC, anon and
  -- authenticated but never named service_role, so a leaked service key could
  -- read every one of them with no organization boundary whatsoever.
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_lead_search_v1(uuid, text, text, integer) FROM service_role;
    REVOKE ALL ON FUNCTION public.copilot_meter_readings_v1(uuid, text, uuid, integer) FROM service_role;
    REVOKE ALL ON FUNCTION public.copilot_vehicle_search_v1(uuid, text, integer) FROM service_role;
    REVOKE ALL ON FUNCTION public.copilot_tasks_v1(uuid, text, integer) FROM service_role;
    REVOKE ALL ON FUNCTION public.copilot_material_stock_v1(uuid, text, integer) FROM service_role;
    REVOKE ALL ON FUNCTION public.copilot_available_rooms_v1(uuid) FROM service_role;
    REVOKE ALL ON FUNCTION public.copilot_invoice_search_v1(uuid, text, text, text) FROM service_role;
    REVOKE ALL ON FUNCTION public.copilot_financial_pnl_v1(uuid, date, date, boolean) FROM service_role;
    REVOKE ALL ON FUNCTION public.copilot_occupancy_v1(uuid, date, integer) FROM service_role;
    REVOKE ALL ON FUNCTION public.copilot_occupancy_upcoming_v1(uuid, date, integer) FROM service_role;
    REVOKE ALL ON FUNCTION public.copilot_invoice_stats_v1(uuid, text) FROM service_role;
    REVOKE ALL ON FUNCTION public.copilot_deposit_summary_v1(uuid) FROM service_role;
    REVOKE ALL ON FUNCTION public.copilot_customer_search_v1(uuid, text) FROM service_role;
    REVOKE ALL ON FUNCTION public.copilot_expiring_contracts_v1(uuid, date, integer) FROM service_role;
    REVOKE ALL ON FUNCTION public.copilot_report_vacant_rooms_v1(uuid, uuid, integer) FROM service_role;
    REVOKE ALL ON FUNCTION public.copilot_report_renewals_v1(uuid, date, date, integer) FROM service_role;
    REVOKE ALL ON FUNCTION public.copilot_report_terminations_v1(uuid, date, date, integer) FROM service_role;
    REVOKE ALL ON FUNCTION public.copilot_report_new_leases_v1(uuid, date, date, integer) FROM service_role;
    REVOKE ALL ON FUNCTION public.copilot_report_expense_ratio_v1(uuid, date, date, uuid, integer) FROM service_role;
    REVOKE ALL ON FUNCTION public.copilot_report_daily_cashbook_v1(uuid, date, date, uuid, integer) FROM service_role;
    REVOKE ALL ON FUNCTION public.copilot_report_cash_flow_v1(uuid, date, date, uuid, integer) FROM service_role;
    REVOKE ALL ON FUNCTION public.copilot_report_payment_schedule_v1(uuid, integer, integer) FROM service_role;
    REVOKE ALL ON FUNCTION public.copilot_report_overpayment_v1(uuid, integer) FROM service_role;
    REVOKE ALL ON FUNCTION public.copilot_report_deposits_v1(uuid, text, integer) FROM service_role;
    REVOKE ALL ON FUNCTION public.copilot_contract_search_v1(uuid, text, text, integer) FROM service_role;
    REVOKE ALL ON FUNCTION public.copilot_income_expense_search_v1(uuid, text, date, date, text, text, integer) FROM service_role;
    REVOKE ALL ON FUNCTION public.copilot_pending_requests_v1(uuid, integer) FROM service_role;
    REVOKE ALL ON FUNCTION public.copilot_salary_summary_v1(uuid, text, integer) FROM service_role;
    REVOKE ALL ON FUNCTION public.copilot_shareholder_profit_v1(uuid, text, integer) FROM service_role;
    REVOKE ALL ON FUNCTION public.copilot_zalo_conversations_v1(uuid, text, integer) FROM service_role;
    REVOKE ALL ON FUNCTION public.copilot_network_status_v1(uuid, uuid, integer) FROM service_role;
  END IF;
END
$acl$;

-- D2: the header of 20260902203258 says the scope helper "denies". It does not,
-- and that sentence is why copilot_material_stock_v1 shipped with no permission
-- check at all. The old file is history and is not edited; the comment that
-- production reads is the one attached to the function, so it is corrected here.
COMMENT ON FUNCTION public.copilot_material_stock_v1(uuid, text, integer) IS
  'Read-only material stock for Copilot. materials.view is checked against authorized_scope_v3 and a caller with no grant gets 42501: copilot_org_scope_buildings_v1 does NOT deny on a missing grant, it returns an empty array.';
COMMENT ON FUNCTION public.copilot_pending_requests_v1(uuid, integer) IS
  'Read-only pending-approval inbox for Copilot; income_expenses.view is checked against authorized_scope_v3, not merely PERFORMed.';
COMMENT ON FUNCTION public.copilot_salary_summary_v1(uuid, text, integer) IS
  'Read-only payroll summary for Copilot. Whole company only for salary.lock / salary.manage_salary / salary.distribute org-wide; salary.view alone answers the caller own row. Gated by the copilot.sensitive.salary rollout flag server-side.';
COMMENT ON FUNCTION public.copilot_shareholder_profit_v1(uuid, text, integer) IS
  'Read-only shareholder profit for Copilot; gated by the copilot.sensitive.shareholder-profit rollout flag server-side.';
COMMENT ON FUNCTION public.copilot_network_status_v1(uuid, uuid, integer) IS
  'Read-only network status for Copilot; gated by the copilot.sensitive.network rollout flag server-side.';

-- ============================================================================
-- Acceptance: catalog only
-- ============================================================================
DO $nghiem_thu$
DECLARE
  v_sig text;
  v_thieu text[] := '{}'::text[];
  v_ho text[] := '{}'::text[];
  v_service text[] := '{}'::text[];
BEGIN
  IF to_regprocedure('app_private.copilot_like_escape_v1(text)') IS NULL THEN
    RAISE EXCEPTION 'copilot_like_escape_v1 missing after apply';
  END IF;
  IF to_regprocedure('app_private.copilot_page_flag_allows_v1(text, uuid)') IS NULL THEN
    RAISE EXCEPTION 'copilot_page_flag_allows_v1 missing after apply';
  END IF;

  FOREACH v_sig IN ARRAY ARRAY[
    'public.copilot_lead_search_v1(uuid, text, text, integer)',
    'public.copilot_meter_readings_v1(uuid, text, uuid, integer)',
    'public.copilot_vehicle_search_v1(uuid, text, integer)',
    'public.copilot_tasks_v1(uuid, text, integer)',
    'public.copilot_material_stock_v1(uuid, text, integer)',
    'public.copilot_available_rooms_v1(uuid)',
    'public.copilot_invoice_search_v1(uuid, text, text, text)',
    'public.copilot_financial_pnl_v1(uuid, date, date, boolean)',
    'public.copilot_occupancy_v1(uuid, date, integer)',
    'public.copilot_occupancy_upcoming_v1(uuid, date, integer)',
    'public.copilot_invoice_stats_v1(uuid, text)',
    'public.copilot_deposit_summary_v1(uuid)',
    'public.copilot_customer_search_v1(uuid, text)',
    'public.copilot_expiring_contracts_v1(uuid, date, integer)',
    'public.copilot_report_vacant_rooms_v1(uuid, uuid, integer)',
    'public.copilot_report_renewals_v1(uuid, date, date, integer)',
    'public.copilot_report_terminations_v1(uuid, date, date, integer)',
    'public.copilot_report_new_leases_v1(uuid, date, date, integer)',
    'public.copilot_report_expense_ratio_v1(uuid, date, date, uuid, integer)',
    'public.copilot_report_daily_cashbook_v1(uuid, date, date, uuid, integer)',
    'public.copilot_report_cash_flow_v1(uuid, date, date, uuid, integer)',
    'public.copilot_report_payment_schedule_v1(uuid, integer, integer)',
    'public.copilot_report_overpayment_v1(uuid, integer)',
    'public.copilot_report_deposits_v1(uuid, text, integer)',
    'public.copilot_contract_search_v1(uuid, text, text, integer)',
    'public.copilot_income_expense_search_v1(uuid, text, date, date, text, text, integer)',
    'public.copilot_pending_requests_v1(uuid, integer)',
    'public.copilot_salary_summary_v1(uuid, text, integer)',
    'public.copilot_shareholder_profit_v1(uuid, text, integer)',
    'public.copilot_zalo_conversations_v1(uuid, text, integer)',
    'public.copilot_network_status_v1(uuid, uuid, integer)'
  ]
  LOOP
    IF to_regprocedure(v_sig) IS NULL THEN
      v_thieu := v_thieu || v_sig;
    ELSE
      IF to_regrole('anon') IS NOT NULL
        AND has_function_privilege('anon', to_regprocedure(v_sig)::oid, 'EXECUTE') THEN
        v_ho := v_ho || v_sig;
      END IF;
      IF to_regrole('service_role') IS NOT NULL
        AND has_function_privilege('service_role', to_regprocedure(v_sig)::oid, 'EXECUTE') THEN
        v_service := v_service || v_sig;
      END IF;
    END IF;
  END LOOP;

  IF cardinality(v_thieu) > 0 THEN
    RAISE EXCEPTION 'copilot read RPC missing after apply: %', array_to_string(v_thieu, ', ');
  END IF;
  IF cardinality(v_ho) > 0 THEN
    RAISE EXCEPTION 'copilot read RPC is anon-executable: %', array_to_string(v_ho, ', ');
  END IF;
  IF cardinality(v_service) > 0 THEN
    RAISE EXCEPTION 'copilot read RPC is service_role-executable: %', array_to_string(v_service, ', ');
  END IF;

  -- The two helpers must stay owner-only.
  IF to_regrole('authenticated') IS NOT NULL
    AND has_function_privilege('authenticated', to_regprocedure('app_private.copilot_page_flag_allows_v1(text, uuid)')::oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'copilot_page_flag_allows_v1 must not be callable by authenticated';
  END IF;
  IF to_regrole('authenticated') IS NOT NULL
    AND has_function_privilege('authenticated', to_regprocedure('app_private.copilot_like_escape_v1(text)')::oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'copilot_like_escape_v1 must not be callable by authenticated';
  END IF;
END
$nghiem_thu$;

COMMIT;

NOTIFY pgrst, 'reload schema';
