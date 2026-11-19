-- =============================================================================
-- Sổ tổng lợi nhuận cổ đông — LỆNH ĐỌC (M2-đọc của "Chi chia lợi nhuận theo sổ tổng").
--
-- VÌ SAO
--   M1 (20261115063149) dựng bảng sổ và MỘT công thức số dư
--   (app_private.profit_ledger_balance_v1). Màn hình cần đọc sổ mà không chép
--   lại công thức và không mở bảng app_private cho người dùng: chủ xem mọi cổ
--   đông / người nhận lương điều hành, xem từng dòng cộng trừ với số dư chạy,
--   xem một phiếu chi trước khi duyệt; cổ đông xem tiền của chính mình.
--
-- LÀM GÌ (chỉ thêm hàm đọc; không ghi, không khoá dòng, không đổi hàm cũ)
--   E1  public.shareholder_profit_ledger_v1(org)                — chủ xem mọi cổ đông.
--   E2  public.shareholder_profit_ledger_entries_v1(org, cổ đông) — sổ chi tiết, số dư chạy.
--   E3  public.shareholder_profit_my_ledger_v1(org)             — cổ đông tự xem tiền của mình.
--   E7  public.profit_ledger_payout_detail_v1(phiếu)            — chi tiết phiếu chi để duyệt.
--   E10 public.profit_manager_ledger_v1(org)                    — sổ lương điều hành.
--   Hàm phụ app_private.profit_ledger_doc_* (không cấp cho vai nào).
--
-- LUẬT
--   - Mọi con số số dư lấy từ app_private.profit_ledger_balance_v1. Sổ chi tiết
--     (E2, và E3 dựng từ cùng nguồn) liệt kê lại từng dòng; hàm phụ đối chiếu
--     tổng các dòng với balance_v1 và DỪNG (XX000 PROFIT_LEDGER_ENTRIES_DRIFT) nếu
--     lệch, thay vì hiện một sổ không cộng ra số dư.
--   - STABLE, SECURITY DEFINER, search_path ghim; quyền kiểm bằng
--     app_private.profit_viewer_can_v1 (không khoá dòng; tôn trọng ngoại lệ đã thu hồi).
--   - "Không có" và "không được xem" trả CÙNG một lỗi 42501 (không lộ cổ đông /
--     phiếu của công ty khác).
--   - E3 không bao giờ trả khoá percent / computed_profit / adjusted_profit /
--     source_* / management_salary / shareholder_percent_total, trừ trong hai mảng
--     percent_rows (cần shareholder_profit.view_percent) và building_totals (cần
--     shareholder_profit.view_building_totals).
--   - Mọi route của cờ shareholder_profit.ledger_payout.v1 đều trả dữ liệu; E3 có
--     ready = (route <> 'LEGACY') để giao diện tự ẩn.
--
-- AN TOÀN CHẠY LẠI: chỉ CREATE OR REPLACE hàm mới + REVOKE/GRANT + khối kiểm.
-- LÙI: các hàm chưa có nơi nào gọi; muốn gỡ thì migration forward mới DROP FUNCTION
--   chín hàm này (không đụng dữ liệu).
-- =============================================================================

BEGIN;

-- 0. Tiền kiểm: nền của M1 và gói 1A phải có, đúng chữ ký. Thiếu ⇒ dừng 55000.
DO $truoc$
DECLARE
  v_thieu text;
BEGIN
  SELECT string_agg(x.sig, ', ' ORDER BY x.sig) INTO v_thieu
    FROM (VALUES
      ('app_private.profit_viewer_can_v1(uuid,text)', 'boolean'),
      ('app_private.evaluate_feature_route(text,uuid)', 'text'),
      ('app_private.profit_ledger_balance_v1(uuid,text,uuid,uuid,date)', 'jsonb'),
      ('app_private.profit_ledger_voucher_live_v1(uuid)', 'boolean'),
      ('app_private.profit_ledger_active_marker_v1(uuid,text,uuid)', 'record'),
      ('public.is_super_admin()', 'boolean')
    ) AS x(sig, ret)
   WHERE to_regprocedure(x.sig) IS NULL
      OR (SELECT p.prorettype FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(x.sig)) <> x.ret::regtype;
  IF v_thieu IS NOT NULL THEN
    RAISE EXCEPTION 'Thiếu hàm nền của sổ tổng (M1 20261115063149 / gói 1A 20261115024231): %', v_thieu
      USING ERRCODE = '55000';
  END IF;

  SELECT string_agg(x.rel || '.' || c.col, ', ' ORDER BY x.rel, c.col) INTO v_thieu
    FROM (VALUES
      ('public.organizations', ARRAY['id']),
      ('public.shareholders', ARRAY['id', 'organization_id', 'name', 'is_active', 'deleted_at', 'auth_user_id']),
      ('public.profit_managers', ARRAY['id', 'organization_id', 'name', 'is_active', 'deleted_at', 'auth_user_id']),
      ('public.buildings', ARRAY['id', 'organization_id', 'name', 'deleted_at']),
      ('public.accounts', ARRAY['id', 'name']),
      ('public.building_shareholders', ARRAY['building_id', 'shareholder_id', 'percent', 'organization_id']),
      ('public.profit_monthly', ARRAY['id', 'organization_id', 'building_id', 'period_month', 'status', 'locked_at',
         'source_revenue', 'source_expense', 'adjusted_profit']),
      ('public.profit_allocations', ARRAY['id', 'profit_monthly_id', 'shareholder_id', 'amount', 'created_at']),
      ('public.income_expenses', ARRAY['id', 'organization_id', 'shareholder_id', 'profit_manager_id', 'code',
         'voucher_date', 'building_id', 'account_id', 'total_amount', 'approval_status', 'posting_status',
         'system_source', 'created_at']),
      ('app_private.profit_ledger_payouts', ARRAY['voucher_id', 'ledger_seq', 'created_at', 'maker_user_id',
         'advance_amount', 'within_amount', 'balance_before', 'warnings', 'maker_kind', 'payee_is_maker']),
      ('app_private.profit_ledger_salary_settlement_vouchers', ARRAY['id', 'organization_id', 'shareholder_id',
         'period_month', 'salary_voucher_id', 'investment_amount', 'advance_offset_amount', 'suggested_investment',
         'state', 'linked_at', 'created_at'])
    ) AS x(rel, cols)
    CROSS JOIN LATERAL unnest(x.cols) AS c(col)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_catalog.pg_attribute a
      WHERE a.attrelid = to_regclass(x.rel) AND a.attname = c.col AND a.attnum > 0 AND NOT a.attisdropped);
  IF v_thieu IS NOT NULL THEN
    RAISE EXCEPTION 'Thiếu bảng/cột nền: %', v_thieu USING ERRCODE = '55000';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM app_private.server_feature_flags f
                  WHERE f.feature_key = 'shareholder_profit.ledger_payout.v1') THEN
    RAISE EXCEPTION 'Thiếu công tắc shareholder_profit.ledger_payout.v1 (M1)' USING ERRCODE = '55000';
  END IF;
END
$truoc$;

-- ── 1. Hàm phụ (app_private, không cấp cho vai nào) ─────────────────────────

-- Người gọi có ÍT NHẤT MỘT trong các khoá, trên toàn công ty. Không khoá dòng.
CREATE OR REPLACE FUNCTION app_private.profit_ledger_doc_can_v1(p_org uuid, p_keys text[])
RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
  SELECT p_org IS NOT NULL
     AND EXISTS (SELECT 1 FROM unnest(p_keys) AS k(key)
                  WHERE app_private.profit_viewer_can_v1(p_org, k.key))
$fn$;

-- Trạng thái theo số dư: dương = công ty còn nợ, âm = đang tạm ứng.
CREATE OR REPLACE FUNCTION app_private.profit_ledger_doc_status_v1(p_balance numeric)
RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog'
AS $fn$
  SELECT CASE WHEN p_balance IS NULL THEN NULL
              WHEN p_balance > 0 THEN 'OWED'
              WHEN p_balance < 0 THEN 'ADVANCE'
              ELSE 'SETTLED' END
$fn$;

-- Mốc hiệu lực cho giao diện của chủ: {id, settled_through_month, ledger_seq} (id để so khi đặt mốc mới).
-- Dòng gỡ mốc vẫn trả (tháng null); chưa từng có mốc ⇒ NULL.
CREATE OR REPLACE FUNCTION app_private.profit_ledger_doc_marker_v1(p_marker jsonb)
RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog'
AS $fn$
  SELECT CASE WHEN jsonb_typeof(p_marker) = 'object' THEN
           jsonb_build_object('id', p_marker -> 'id',
                              'settled_through_month', p_marker -> 'settled_through_month',
                              'ledger_seq', p_marker -> 'ledger_seq')
         END
$fn$;

-- Sổ chi tiết của MỘT cổ đông: {"balance": <balance_v1>, "entries": [...]}.
-- Dòng: ALLOCATION (+phân bổ tháng đã chốt), PAYOUT (−phiếu chi còn sống), SALARY (−phần lợi nhuận trong
-- phiếu lương LINKED còn sống), SALARY_OFFSET (+phần trừ tạm ứng của dòng đó, chỉ khi khác 0), SALARY_REVIEW
-- (0, phiếu lương NEEDS_REVIEW còn sống). excluded_by_marker = dòng nằm trước mốc (không vào số dư).
-- Thứ tự: thời điểm vào sổ, rồi loại, kỳ, toà, id. running_balance = cộng dồn các dòng KHÔNG bị mốc loại.
-- Đối chiếu: mọi tổng theo loại phải bằng đúng balance_v1, lệch ⇒ dừng XX000 (không trả sổ sai).
CREATE OR REPLACE FUNCTION app_private.profit_ledger_doc_shareholder_v1(p_org uuid, p_shareholder uuid)
RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_uid        uuid := auth.uid();
  v_bal        jsonb;
  v_mk         record;
  v_has_marker boolean := false;
  v_mk_month   date;
  v_mk_seq     bigint;
  v_mk_at      timestamptz;
  v_t          record;
BEGIN
  -- Số dư theo công thức duy nhất của sổ (chủ thể không thuộc công ty ⇒ hàm lõi ném P0002).
  v_bal := app_private.profit_ledger_balance_v1(p_org, 'SHAREHOLDER', p_shareholder);

  SELECT mk.settled_through_month, mk.ledger_seq, mk.created_at INTO v_mk
    FROM app_private.profit_ledger_active_marker_v1(p_org, 'SHAREHOLDER', p_shareholder) mk;
  IF FOUND AND v_mk.settled_through_month IS NOT NULL THEN
    v_has_marker := true;
    v_mk_month := v_mk.settled_through_month;
    v_mk_seq := v_mk.ledger_seq;
    v_mk_at := v_mk.created_at;
  END IF;

  WITH e AS (
    SELECT 'ALLOCATION'::text AS kind, 1 AS kind_order, a.id AS line_id, pm.period_month,
           pm.building_id, b.name AS building_name, a.amount::numeric AS amount, NULL::numeric AS suggested,
           NULL::uuid AS voucher_id, NULL::text AS voucher_code, NULL::date AS voucher_date,
           NULL::text AS voucher_status, NULL::text AS posting_status, NULL::text AS account_name,
           NULL::uuid AS maker_user_id, false AS is_advance,
           COALESCE(pm.locked_at, a.created_at) AS at,
           (v_has_marker AND pm.period_month <= v_mk_month) AS excluded,
           a.id AS ord_id
      FROM public.profit_allocations a
      JOIN public.profit_monthly pm ON pm.id = a.profit_monthly_id
      LEFT JOIN public.buildings b ON b.id = pm.building_id
     WHERE a.shareholder_id = p_shareholder
       AND pm.organization_id = p_org
       AND pm.status = 'LOCKED'
    UNION ALL
    SELECT 'PAYOUT', 2, NULL, NULL,
           ie.building_id, b.name, -ie.total_amount, NULL,
           ie.id, ie.code, ie.voucher_date,
           ie.approval_status, ie.posting_status, acc.name,
           c2.maker_user_id, COALESCE(c2.advance_amount > 0, false),
           COALESCE(c2.created_at, ie.created_at),
           (v_has_marker AND NOT ((c2.voucher_id IS NOT NULL AND c2.ledger_seq > v_mk_seq)
                                  OR (c2.voucher_id IS NULL AND ie.created_at >= v_mk_at))),
           ie.id
      FROM public.income_expenses ie
      LEFT JOIN app_private.profit_ledger_payouts c2 ON c2.voucher_id = ie.id
      LEFT JOIN public.buildings b ON b.id = ie.building_id
      LEFT JOIN public.accounts acc ON acc.id = ie.account_id
     WHERE ie.organization_id = p_org
       AND ie.shareholder_id = p_shareholder
       AND app_private.profit_ledger_voucher_live_v1(ie.id)
    UNION ALL
    SELECT 'SALARY', 3, l.id, l.period_month,
           NULL, NULL, -l.investment_amount, NULL,
           l.salary_voucher_id, sv.code, sv.voucher_date,
           sv.approval_status, NULL, NULL,
           NULL, false,
           COALESCE(l.linked_at, l.created_at),
           (v_has_marker AND l.period_month <= v_mk_month),
           l.id
      FROM app_private.profit_ledger_salary_settlement_vouchers l
      LEFT JOIN public.income_expenses sv ON sv.id = l.salary_voucher_id
     WHERE l.organization_id = p_org
       AND l.shareholder_id = p_shareholder
       AND l.state = 'LINKED'
       AND app_private.profit_ledger_voucher_live_v1(l.salary_voucher_id)
    UNION ALL
    SELECT 'SALARY_OFFSET', 4, l.id, l.period_month,
           NULL, NULL, l.advance_offset_amount, NULL,
           l.salary_voucher_id, sv.code, sv.voucher_date,
           sv.approval_status, NULL, NULL,
           NULL, false,
           COALESCE(l.linked_at, l.created_at),
           (v_has_marker AND l.period_month <= v_mk_month),
           l.id
      FROM app_private.profit_ledger_salary_settlement_vouchers l
      LEFT JOIN public.income_expenses sv ON sv.id = l.salary_voucher_id
     WHERE l.organization_id = p_org
       AND l.shareholder_id = p_shareholder
       AND l.state = 'LINKED'
       AND l.advance_offset_amount <> 0
       AND app_private.profit_ledger_voucher_live_v1(l.salary_voucher_id)
    UNION ALL
    -- Phiếu lương máy chưa đủ dữ kiện: không vào số dư (0), mọi kỳ, không xét mốc — như needs_review của số dư.
    SELECT 'SALARY_REVIEW', 5, l.id, l.period_month,
           NULL, NULL, 0::numeric, l.suggested_investment,
           l.salary_voucher_id, sv.code, sv.voucher_date,
           sv.approval_status, NULL, NULL,
           NULL, false,
           l.created_at,
           false,
           l.id
      FROM app_private.profit_ledger_salary_settlement_vouchers l
      LEFT JOIN public.income_expenses sv ON sv.id = l.salary_voucher_id
     WHERE l.organization_id = p_org
       AND l.shareholder_id = p_shareholder
       AND l.state = 'NEEDS_REVIEW'
       AND app_private.profit_ledger_voucher_live_v1(l.salary_voucher_id)
  ), x AS (
    SELECT e.*,
           sum(CASE WHEN e.excluded THEN 0 ELSE e.amount END)
             OVER (ORDER BY e.at, e.kind_order, e.period_month, e.building_name, e.ord_id
                   ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running_balance
      FROM e
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'kind', x.kind,
           'line_id', x.line_id,
           'period_month', x.period_month,
           'building_id', x.building_id,
           'building_name', x.building_name,
           'amount', x.amount,
           'suggested', x.suggested,
           'voucher_id', x.voucher_id,
           'voucher_code', x.voucher_code,
           'voucher_date', x.voucher_date,
           'voucher_status', x.voucher_status,
           'posting_status', x.posting_status,
           'account_name', x.account_name,
           'maker_user_id', x.maker_user_id,
           'is_mine', COALESCE(x.maker_user_id = v_uid, false),
           'is_advance', x.is_advance,
           'created_at', x.at,
           'excluded_by_marker', x.excluded,
           'running_balance', x.running_balance)
           ORDER BY x.at, x.kind_order, x.period_month, x.building_name, x.ord_id), '[]'::jsonb) AS entries,
         COALESCE(sum(x.amount) FILTER (WHERE x.kind = 'ALLOCATION' AND NOT x.excluded), 0) AS alloc_in,
         COALESCE(sum(x.amount) FILTER (WHERE x.kind = 'ALLOCATION' AND x.excluded), 0) AS alloc_ex,
         COALESCE(sum(-x.amount) FILTER (WHERE x.kind = 'PAYOUT' AND NOT x.excluded AND x.voucher_status = 'APPROVED'), 0) AS pay_ok,
         COALESCE(sum(-x.amount) FILTER (WHERE x.kind = 'PAYOUT' AND NOT x.excluded AND x.voucher_status IS DISTINCT FROM 'APPROVED'), 0) AS pay_pend,
         COALESCE(sum(-x.amount) FILTER (WHERE x.kind = 'PAYOUT' AND x.excluded), 0) AS pay_ex,
         COALESCE(sum(-x.amount) FILTER (WHERE x.kind = 'SALARY' AND NOT x.excluded), 0) AS sal_inv,
         COALESCE(sum(x.amount) FILTER (WHERE x.kind = 'SALARY_OFFSET' AND NOT x.excluded), 0) AS sal_off,
         COALESCE(sum(-x.amount) FILTER (WHERE x.kind IN ('SALARY', 'SALARY_OFFSET') AND x.excluded), 0) AS sal_ex,
         count(*) FILTER (WHERE x.kind = 'SALARY_REVIEW') AS nr_count,
         COALESCE(sum(x.suggested) FILTER (WHERE x.kind = 'SALARY_REVIEW'), 0) AS nr_sugg,
         COALESCE(sum(x.amount) FILTER (WHERE NOT x.excluded), 0) AS total_in
    INTO v_t
    FROM x;

  IF v_t.alloc_in IS DISTINCT FROM (v_bal ->> 'allocated')::numeric
     OR v_t.alloc_ex IS DISTINCT FROM (v_bal -> 'excluded_before_marker' ->> 'allocated')::numeric
     OR v_t.pay_ok IS DISTINCT FROM (v_bal ->> 'payouts_approved')::numeric
     OR v_t.pay_pend IS DISTINCT FROM (v_bal ->> 'payouts_pending')::numeric
     OR v_t.pay_ex IS DISTINCT FROM (v_bal -> 'excluded_before_marker' ->> 'payouts')::numeric
     OR v_t.sal_inv IS DISTINCT FROM (v_bal ->> 'salary_investment')::numeric
     OR v_t.sal_off IS DISTINCT FROM (v_bal ->> 'salary_advance_offset')::numeric
     OR v_t.sal_ex IS DISTINCT FROM (v_bal -> 'excluded_before_marker' ->> 'salary')::numeric
     OR v_t.nr_count IS DISTINCT FROM (v_bal -> 'needs_review' ->> 'count')::bigint
     OR v_t.nr_sugg IS DISTINCT FROM (v_bal -> 'needs_review' ->> 'suggested')::numeric
     OR v_t.total_in IS DISTINCT FROM (v_bal ->> 'balance')::numeric THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_ENTRIES_DRIFT: các dòng sổ chi tiết không cộng ra đúng số dư sổ tổng — báo bộ phận kỹ thuật'
      USING ERRCODE = 'XX000',
            DETAIL = jsonb_build_object(
              'balance', v_bal - 'marker',
              'entries', jsonb_build_object(
                'allocated', v_t.alloc_in, 'excluded_allocated', v_t.alloc_ex,
                'payouts_approved', v_t.pay_ok, 'payouts_pending', v_t.pay_pend, 'excluded_payouts', v_t.pay_ex,
                'salary_investment', v_t.sal_inv, 'salary_advance_offset', v_t.sal_off, 'excluded_salary', v_t.sal_ex,
                'needs_review_count', v_t.nr_count, 'needs_review_suggested', v_t.nr_sugg,
                'balance', v_t.total_in))::text;
  END IF;

  RETURN jsonb_build_object('balance', v_bal, 'entries', v_t.entries);
END
$fn$;

-- ── 2. RPC đọc (public; REVOKE mọi vai rồi chỉ GRANT authenticated) ─────────

-- E1. Chủ xem sổ tổng của mọi cổ đông: cổ đông chưa xoá + cổ đông đã xoá còn số
--     (số dư ≠ 0, còn phiếu chờ duyệt, hoặc còn phiếu lương chờ chủ xem lại).
CREATE OR REPLACE FUNCTION public.shareholder_profit_ledger_v1(p_organization_id uuid)
RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_rows jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_FORBIDDEN: bạn không có quyền xem sổ tổng lợi nhuận của công ty này'
      USING ERRCODE = '42501';
  END IF;
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_BAD_INPUT: thiếu mã công ty' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = p_organization_id)
     OR NOT app_private.profit_ledger_doc_can_v1(p_organization_id, ARRAY[
          'shareholder_profit.distribute', 'shareholder_profit.lock',
          'shareholder_profit.unlock', 'shareholder_profit.manage_shareholders']) THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_FORBIDDEN: bạn không có quyền xem sổ tổng lợi nhuận của công ty này'
      USING ERRCODE = '42501';
  END IF;

  WITH x AS MATERIALIZED (
    SELECT s.id, s.name, s.is_active,
           (s.deleted_at IS NOT NULL) AS is_deleted,
           (s.auth_user_id IS NOT NULL) AS has_login,
           app_private.profit_ledger_balance_v1(p_organization_id, 'SHAREHOLDER', s.id) AS bal
      FROM public.shareholders s
     WHERE s.organization_id = p_organization_id
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'shareholder_id', x.id,
           'name', x.name,
           'is_active', x.is_active,
           'is_deleted', x.is_deleted,
           'has_login', x.has_login,
           'marker', app_private.profit_ledger_doc_marker_v1(x.bal -> 'marker'),
           'allocated', x.bal -> 'allocated',
           'payouts_approved', x.bal -> 'payouts_approved',
           'payouts_pending', x.bal -> 'payouts_pending',
           'salary_investment', x.bal -> 'salary_investment',
           'salary_advance_offset', x.bal -> 'salary_advance_offset',
           'balance', x.bal -> 'balance',
           'status', app_private.profit_ledger_doc_status_v1((x.bal ->> 'balance')::numeric),
           'open_advance', greatest(-((x.bal ->> 'balance')::numeric), 0),
           'needs_review_count', x.bal -> 'needs_review' -> 'count')
           ORDER BY x.is_deleted, x.name, x.id), '[]'::jsonb)
    INTO v_rows
    FROM x
   WHERE NOT x.is_deleted
      OR (x.bal ->> 'balance')::numeric <> 0
      OR (x.bal ->> 'payouts_pending')::numeric <> 0
      OR (x.bal -> 'needs_review' ->> 'count')::bigint > 0;

  RETURN jsonb_build_object(
    'organization_id', p_organization_id,
    'route', app_private.evaluate_feature_route('shareholder_profit.ledger_payout.v1', p_organization_id),
    'as_of', now(),
    'shareholders', v_rows);
END
$fn$;

-- E2. Sổ chi tiết của một cổ đông (kể cả cổ đông đã xoá) với số dư chạy.
CREATE OR REPLACE FUNCTION public.shareholder_profit_ledger_entries_v1(p_organization_id uuid, p_shareholder_id uuid)
RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_sh  record;
  v_doc jsonb;
  v_bal jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_FORBIDDEN: bạn không có quyền xem sổ của cổ đông này, hoặc cổ đông không thuộc công ty này'
      USING ERRCODE = '42501';
  END IF;
  IF p_organization_id IS NULL OR p_shareholder_id IS NULL THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_BAD_INPUT: thiếu mã công ty hoặc mã cổ đông' USING ERRCODE = '22023';
  END IF;
  -- Kiểm quyền trên công ty TRƯỚC khi đọc cổ đông theo id truyền vào.
  IF NOT app_private.profit_ledger_doc_can_v1(p_organization_id, ARRAY[
       'shareholder_profit.distribute', 'shareholder_profit.lock',
       'shareholder_profit.unlock', 'shareholder_profit.manage_shareholders']) THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_FORBIDDEN: bạn không có quyền xem sổ của cổ đông này, hoặc cổ đông không thuộc công ty này'
      USING ERRCODE = '42501';
  END IF;
  SELECT s.id, s.name, s.is_active, (s.deleted_at IS NOT NULL) AS is_deleted, (s.auth_user_id IS NOT NULL) AS has_login
    INTO v_sh
    FROM public.shareholders s
   WHERE s.id = p_shareholder_id AND s.organization_id = p_organization_id;
  IF NOT FOUND THEN
    -- Cùng lỗi với "không có quyền": không lộ cổ đông của công ty khác.
    RAISE EXCEPTION 'PROFIT_LEDGER_FORBIDDEN: bạn không có quyền xem sổ của cổ đông này, hoặc cổ đông không thuộc công ty này'
      USING ERRCODE = '42501';
  END IF;

  v_doc := app_private.profit_ledger_doc_shareholder_v1(p_organization_id, p_shareholder_id);
  v_bal := v_doc -> 'balance';

  RETURN jsonb_build_object(
    'organization_id', p_organization_id,
    'shareholder', jsonb_build_object(
      'shareholder_id', v_sh.id,
      'name', v_sh.name,
      'is_active', v_sh.is_active,
      'is_deleted', v_sh.is_deleted,
      'has_login', v_sh.has_login),
    'marker', app_private.profit_ledger_doc_marker_v1(v_bal -> 'marker'),
    'totals', jsonb_build_object(
      'allocated', v_bal -> 'allocated',
      'payouts_approved', v_bal -> 'payouts_approved',
      'payouts_pending', v_bal -> 'payouts_pending',
      'salary_investment', v_bal -> 'salary_investment',
      'salary_advance_offset', v_bal -> 'salary_advance_offset',
      'balance', v_bal -> 'balance',
      'status', app_private.profit_ledger_doc_status_v1((v_bal ->> 'balance')::numeric),
      'excluded_before_marker', v_bal -> 'excluded_before_marker',
      'needs_review', v_bal -> 'needs_review'),
    'entries', v_doc -> 'entries');
END
$fn$;

-- E3. Cổ đông tự xem tiền của mình. Không bao giờ có tỷ lệ / số liệu toà ngoài percent_rows /
--     building_totals (mỗi mảng cần quyền riêng; thiếu quyền thì KHÔNG có khoá đó).
CREATE OR REPLACE FUNCTION public.shareholder_profit_my_ledger_v1(p_organization_id uuid)
RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_uid     uuid := auth.uid();
  v_n       integer;
  v_sh      record;
  v_route   text;
  v_doc     jsonb;
  v_bal     jsonb;
  v_months  jsonb;
  v_payouts jsonb;
  v_salary  jsonb;
  v_out     jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_FORBIDDEN: bạn chưa xem được lợi nhuận của mình ở công ty này (cần là cổ đông của công ty và có quyền xem phân chia lợi nhuận hoặc quyền tạm ứng lợi nhuận)'
      USING ERRCODE = '42501';
  END IF;
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_BAD_INPUT: thiếu mã công ty' USING ERRCODE = '22023';
  END IF;
  IF NOT app_private.profit_ledger_doc_can_v1(p_organization_id, ARRAY[
       'reports_finance.profit_distribution', 'shareholder_profit.advance_own_cashbook']) THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_FORBIDDEN: bạn chưa xem được lợi nhuận của mình ở công ty này (cần là cổ đông của công ty và có quyền xem phân chia lợi nhuận hoặc quyền tạm ứng lợi nhuận)'
      USING ERRCODE = '42501';
  END IF;

  -- Chỉ CHÍNH người gọi: cổ đông chưa xoá của công ty có auth_user_id = người gọi.
  SELECT count(*) INTO v_n
    FROM public.shareholders s
   WHERE s.organization_id = p_organization_id AND s.auth_user_id = v_uid AND s.deleted_at IS NULL;
  IF v_n = 0 THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_FORBIDDEN: bạn chưa xem được lợi nhuận của mình ở công ty này (cần là cổ đông của công ty và có quyền xem phân chia lợi nhuận hoặc quyền tạm ứng lợi nhuận)'
      USING ERRCODE = '42501';
  END IF;
  IF v_n > 1 THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_SHAREHOLDER_AMBIGUOUS: tài khoản của bạn đang gắn với nhiều cổ đông trong công ty này — nhờ chủ công ty gộp lại trước khi xem'
      USING ERRCODE = '55000';
  END IF;
  SELECT s.id, s.name INTO v_sh
    FROM public.shareholders s
   WHERE s.organization_id = p_organization_id AND s.auth_user_id = v_uid AND s.deleted_at IS NULL;

  v_route := app_private.evaluate_feature_route('shareholder_profit.ledger_payout.v1', p_organization_id);
  v_doc := app_private.profit_ledger_doc_shareholder_v1(p_organization_id, v_sh.id);
  v_bal := v_doc -> 'balance';

  -- Phân bổ theo tháng, tách theo toà (chỉ phần của chính mình).
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'period_month', m.period_month,
           'amount', m.amount,
           'excluded_by_marker', m.excluded,
           'buildings', m.buildings) ORDER BY m.period_month), '[]'::jsonb)
    INTO v_months
    FROM (
      SELECT t.period_month, sum(t.amount) AS amount, bool_and(t.excluded) AS excluded,
             jsonb_agg(jsonb_build_object('building_id', t.building_id, 'building_name', t.building_name, 'amount', t.amount)
                       ORDER BY t.building_name, t.building_id) AS buildings
        FROM (
          SELECT (el ->> 'period_month')::date AS period_month,
                 (el ->> 'building_id')::uuid AS building_id,
                 el ->> 'building_name' AS building_name,
                 sum((el ->> 'amount')::numeric) AS amount,
                 bool_and((el ->> 'excluded_by_marker')::boolean) AS excluded
            FROM jsonb_array_elements(v_doc -> 'entries') AS el
           WHERE el ->> 'kind' = 'ALLOCATION'
           GROUP BY 1, 2, 3
        ) t
       GROUP BY t.period_month
    ) m;

  -- Phiếu chi của chính mình (số dương), theo thứ tự vào sổ.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'voucher_id', el -> 'voucher_id',
           'voucher_code', el -> 'voucher_code',
           'voucher_date', el -> 'voucher_date',
           'amount', -((el ->> 'amount')::numeric),
           'status', el -> 'voucher_status',
           'posting_status', el -> 'posting_status',
           'is_advance', el -> 'is_advance',
           'is_mine', el -> 'is_mine',
           'is_mine_pending', ((el ->> 'is_mine')::boolean AND el ->> 'voucher_status' = 'UNAPPROVED'),
           'excluded_by_marker', el -> 'excluded_by_marker') ORDER BY t.ord), '[]'::jsonb)
    INTO v_payouts
    FROM jsonb_array_elements(v_doc -> 'entries') WITH ORDINALITY AS t(el, ord)
   WHERE el ->> 'kind' = 'PAYOUT';

  -- Phần lợi nhuận đã trả qua lương, theo kỳ lương.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'period_month', s.period_month,
           'investment', s.investment,
           'advance_offset', s.advance_offset,
           'excluded_by_marker', s.excluded) ORDER BY s.period_month), '[]'::jsonb)
    INTO v_salary
    FROM (
      SELECT (el ->> 'period_month')::date AS period_month,
             COALESCE(sum(-((el ->> 'amount')::numeric)) FILTER (WHERE el ->> 'kind' = 'SALARY'), 0) AS investment,
             COALESCE(sum((el ->> 'amount')::numeric) FILTER (WHERE el ->> 'kind' = 'SALARY_OFFSET'), 0) AS advance_offset,
             bool_and((el ->> 'excluded_by_marker')::boolean) AS excluded
        FROM jsonb_array_elements(v_doc -> 'entries') AS el
       WHERE el ->> 'kind' IN ('SALARY', 'SALARY_OFFSET')
       GROUP BY 1
    ) s;

  v_out := jsonb_build_object(
    'organization_id', p_organization_id,
    'route', v_route,
    'ready', COALESCE(v_route <> 'LEGACY', false),
    'shareholder', jsonb_build_object('id', v_sh.id, 'name', v_sh.name),
    'balance', v_bal -> 'balance',
    'status', app_private.profit_ledger_doc_status_v1((v_bal ->> 'balance')::numeric),
    'allocated', v_bal -> 'allocated',
    'paid', v_bal -> 'payouts_approved',
    'paid_pending', v_bal -> 'payouts_pending',
    'paid_via_salary', v_bal -> 'salary_investment',
    'advance_recovered', v_bal -> 'salary_advance_offset',
    'marker', CASE WHEN v_bal -> 'marker' ->> 'settled_through_month' IS NOT NULL
                   THEN jsonb_build_object('settled_through_month', v_bal -> 'marker' -> 'settled_through_month') END,
    'months', v_months,
    'payouts', v_payouts,
    'salary', v_salary);

  IF app_private.profit_viewer_can_v1(p_organization_id, 'shareholder_profit.view_percent') THEN
    v_out := v_out || jsonb_build_object('percent_rows', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'building_id', bs.building_id,
               'building_name', b.name,
               'percent', bs.percent) ORDER BY b.name, bs.building_id), '[]'::jsonb)
        FROM public.building_shareholders bs
        JOIN public.buildings b ON b.id = bs.building_id AND b.deleted_at IS NULL
       WHERE bs.shareholder_id = v_sh.id
         AND COALESCE(bs.organization_id, b.organization_id) = p_organization_id));
  END IF;

  IF app_private.profit_viewer_can_v1(p_organization_id, 'shareholder_profit.view_building_totals') THEN
    v_out := v_out || jsonb_build_object('building_totals', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'period_month', pm.period_month,
               'building_id', pm.building_id,
               'building_name', b.name,
               'revenue', pm.source_revenue,
               'expense', pm.source_expense,
               'profit', pm.adjusted_profit) ORDER BY pm.period_month, b.name, pm.building_id), '[]'::jsonb)
        FROM public.profit_monthly pm
        LEFT JOIN public.buildings b ON b.id = pm.building_id
       WHERE pm.organization_id = p_organization_id
         AND pm.status = 'LOCKED'
         AND EXISTS (SELECT 1 FROM public.profit_allocations a
                      WHERE a.profit_monthly_id = pm.id AND a.shareholder_id = v_sh.id)));
  END IF;

  RETURN v_out;
END
$fn$;

-- E7. Chi tiết một phiếu chi lợi nhuận cổ đông / lương điều hành (để duyệt): lúc lập (dòng sổ) và bây giờ.
CREATE OR REPLACE FUNCTION public.profit_ledger_payout_detail_v1(p_voucher_id uuid)
RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_ie      record;
  v_kind    text;
  v_subject uuid;
  v_keys    text[];
  v_c2      record;
  v_has_c2  boolean;
  v_subj    jsonb;
  v_bal     jsonb;
  v_excl    numeric;
  v_within  numeric;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_FORBIDDEN: không xem được phiếu này (không có, không phải phiếu chi lợi nhuận / lương điều hành, hoặc bạn không có quyền)'
      USING ERRCODE = '42501';
  END IF;
  IF p_voucher_id IS NULL THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_BAD_INPUT: thiếu mã phiếu' USING ERRCODE = '22023';
  END IF;

  -- Đọc phiếu (không khoá) chỉ để biết công ty và chủ thể; chưa trả gì trước khi kiểm quyền.
  SELECT ie.id, ie.organization_id, ie.shareholder_id, ie.profit_manager_id, ie.code, ie.voucher_date,
         ie.total_amount, ie.approval_status, ie.posting_status, ie.system_source, ie.account_id, ie.created_at
    INTO v_ie
    FROM public.income_expenses ie
   WHERE ie.id = p_voucher_id;
  IF NOT FOUND OR (v_ie.shareholder_id IS NULL AND v_ie.profit_manager_id IS NULL) THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_FORBIDDEN: không xem được phiếu này (không có, không phải phiếu chi lợi nhuận / lương điều hành, hoặc bạn không có quyền)'
      USING ERRCODE = '42501';
  END IF;
  v_kind := CASE WHEN v_ie.shareholder_id IS NOT NULL THEN 'SHAREHOLDER' ELSE 'MANAGER' END;
  v_subject := COALESCE(v_ie.shareholder_id, v_ie.profit_manager_id);
  v_keys := ARRAY['shareholder_profit.distribute', 'shareholder_profit.lock',
                  'shareholder_profit.unlock', 'shareholder_profit.manage_shareholders'];
  IF v_kind = 'MANAGER' THEN
    v_keys := v_keys || 'shareholder_profit.pay_manager'::text;
  END IF;
  IF NOT app_private.profit_ledger_doc_can_v1(v_ie.organization_id, v_keys) THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_FORBIDDEN: không xem được phiếu này (không có, không phải phiếu chi lợi nhuận / lương điều hành, hoặc bạn không có quyền)'
      USING ERRCODE = '42501';
  END IF;

  SELECT c2.balance_before, c2.within_amount, c2.advance_amount, c2.warnings, c2.maker_kind, c2.payee_is_maker
    INTO v_c2
    FROM app_private.profit_ledger_payouts c2
   WHERE c2.voucher_id = p_voucher_id;
  v_has_c2 := FOUND;

  IF v_kind = 'SHAREHOLDER' THEN
    SELECT jsonb_build_object('kind', 'SHAREHOLDER', 'id', s.id, 'name', s.name,
                              'is_deleted', s.deleted_at IS NOT NULL, 'has_login', s.auth_user_id IS NOT NULL)
      INTO v_subj FROM public.shareholders s WHERE s.id = v_subject;
  ELSE
    SELECT jsonb_build_object('kind', 'MANAGER', 'id', m.id, 'name', m.name,
                              'is_deleted', m.deleted_at IS NOT NULL, 'has_login', m.auth_user_id IS NOT NULL)
      INTO v_subj FROM public.profit_managers m WHERE m.id = v_subject;
  END IF;

  -- "Bây giờ": số dư nếu bỏ chính phiếu này ra, và phiếu sẽ nằm trong số dư / thành tạm ứng bao nhiêu.
  v_bal := app_private.profit_ledger_balance_v1(v_ie.organization_id, v_kind, v_subject, p_voucher_id);
  v_excl := (v_bal ->> 'balance')::numeric;
  v_within := least(v_ie.total_amount, greatest(v_excl, 0));

  RETURN jsonb_build_object(
    'organization_id', v_ie.organization_id,
    'route', app_private.evaluate_feature_route('shareholder_profit.ledger_payout.v1', v_ie.organization_id),
    'voucher', jsonb_build_object(
      'id', v_ie.id,
      'code', v_ie.code,
      'voucher_date', v_ie.voucher_date,
      'amount', v_ie.total_amount,
      'approval_status', v_ie.approval_status,
      'posting_status', v_ie.posting_status,
      'system_source', v_ie.system_source,
      'account_id', v_ie.account_id,
      'account_name', (SELECT a.name FROM public.accounts a WHERE a.id = v_ie.account_id),
      'is_live', app_private.profit_ledger_voucher_live_v1(p_voucher_id),
      'created_at', v_ie.created_at),
    'subject', v_subj,
    'at_create', CASE WHEN v_has_c2 THEN jsonb_build_object(
      'balance_before', v_c2.balance_before,
      'within', v_c2.within_amount,
      'advance', v_c2.advance_amount,
      'warnings', v_c2.warnings,
      'maker_kind', v_c2.maker_kind,
      'payee_is_maker', v_c2.payee_is_maker) END,
    'now', jsonb_build_object(
      'balance_excluding_this', v_excl,
      'within', v_within,
      'advance', v_ie.total_amount - v_within));
END
$fn$;

-- E10. Sổ lương điều hành: được nhận − đã trả (đã duyệt + chờ duyệt) = còn lại.
--      Người nhận chưa xoá + người đã xoá còn số (số dư ≠ 0 hoặc còn phiếu chờ duyệt).
CREATE OR REPLACE FUNCTION public.profit_manager_ledger_v1(p_organization_id uuid)
RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_rows jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_FORBIDDEN: bạn không có quyền xem sổ lương điều hành của công ty này'
      USING ERRCODE = '42501';
  END IF;
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_BAD_INPUT: thiếu mã công ty' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = p_organization_id)
     OR NOT app_private.profit_ledger_doc_can_v1(p_organization_id, ARRAY[
          'shareholder_profit.pay_manager', 'shareholder_profit.distribute',
          'shareholder_profit.lock', 'shareholder_profit.manage_shareholders']) THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_FORBIDDEN: bạn không có quyền xem sổ lương điều hành của công ty này'
      USING ERRCODE = '42501';
  END IF;

  WITH x AS MATERIALIZED (
    SELECT m.id, m.name, m.is_active,
           (m.deleted_at IS NOT NULL) AS is_deleted,
           (m.auth_user_id IS NOT NULL) AS has_login,
           app_private.profit_ledger_balance_v1(p_organization_id, 'MANAGER', m.id) AS bal
      FROM public.profit_managers m
     WHERE m.organization_id = p_organization_id
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'manager_id', x.id,
           'name', x.name,
           'is_active', x.is_active,
           'is_deleted', x.is_deleted,
           'has_login', x.has_login,
           'marker', app_private.profit_ledger_doc_marker_v1(x.bal -> 'marker'),
           'allocated', x.bal -> 'allocated',
           'payouts_approved', x.bal -> 'payouts_approved',
           'payouts_pending', x.bal -> 'payouts_pending',
           'balance', x.bal -> 'balance',
           'status', app_private.profit_ledger_doc_status_v1((x.bal ->> 'balance')::numeric))
           ORDER BY x.is_deleted, x.name, x.id), '[]'::jsonb)
    INTO v_rows
    FROM x
   WHERE NOT x.is_deleted
      OR (x.bal ->> 'balance')::numeric <> 0
      OR (x.bal ->> 'payouts_pending')::numeric <> 0;

  RETURN jsonb_build_object(
    'organization_id', p_organization_id,
    'route', app_private.evaluate_feature_route('shareholder_profit.ledger_payout.v1', p_organization_id),
    'as_of', now(),
    'managers', v_rows);
END
$fn$;

-- ── 3. Quyền gọi ─────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION app_private.profit_ledger_doc_can_v1(uuid, text[]) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.profit_ledger_doc_status_v1(numeric) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.profit_ledger_doc_marker_v1(jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.profit_ledger_doc_shareholder_v1(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.shareholder_profit_ledger_v1(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.shareholder_profit_ledger_entries_v1(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.shareholder_profit_my_ledger_v1(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.profit_ledger_payout_detail_v1(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.profit_manager_ledger_v1(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.shareholder_profit_ledger_v1(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.shareholder_profit_ledger_entries_v1(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.shareholder_profit_my_ledger_v1(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.profit_ledger_payout_detail_v1(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.profit_manager_ledger_v1(uuid) TO authenticated;

COMMENT ON FUNCTION app_private.profit_ledger_doc_can_v1(uuid, text[]) IS
  'Người gọi có ít nhất một trong các khoá quyền trên toàn công ty (qua profit_viewer_can_v1). Không khoá dòng.';
COMMENT ON FUNCTION app_private.profit_ledger_doc_status_v1(numeric) IS
  'Trạng thái sổ theo số dư: OWED (> 0), SETTLED (= 0), ADVANCE (< 0).';
COMMENT ON FUNCTION app_private.profit_ledger_doc_marker_v1(jsonb) IS
  'Rút trường marker của profit_ledger_balance_v1 về {id, settled_through_month, ledger_seq}; không có dòng mốc ⇒ NULL.';
COMMENT ON FUNCTION app_private.profit_ledger_doc_shareholder_v1(uuid, uuid) IS
  'Sổ chi tiết của một cổ đông: {balance: profit_ledger_balance_v1, entries: [...] với running_balance}. Tổng các dòng phải bằng balance_v1, lệch ⇒ XX000 PROFIT_LEDGER_ENTRIES_DRIFT. Không khoá dòng.';
COMMENT ON FUNCTION public.shareholder_profit_ledger_v1(uuid) IS
  'Sổ tổng lợi nhuận: mọi cổ đông của công ty (chưa xoá + đã xoá còn số) với số dư theo profit_ledger_balance_v1. Quyền: shareholder_profit.distribute|lock|unlock|manage_shareholders. Chỉ đọc.';
COMMENT ON FUNCTION public.shareholder_profit_ledger_entries_v1(uuid, uuid) IS
  'Sổ chi tiết một cổ đông: từng dòng phân bổ / phiếu chi / phần lương với số dư chạy (dòng cuối = số dư sổ tổng). Quyền như shareholder_profit_ledger_v1. Chỉ đọc.';
COMMENT ON FUNCTION public.shareholder_profit_my_ledger_v1(uuid) IS
  'Cổ đông tự xem tiền của mình (cổ đông chưa xoá + reports_finance.profit_distribution hoặc shareholder_profit.advance_own_cashbook). Tỷ lệ % và số liệu toà chỉ có trong percent_rows / building_totals khi có quyền xem riêng. ready = route khác LEGACY. Chỉ đọc.';
COMMENT ON FUNCTION public.profit_ledger_payout_detail_v1(uuid) IS
  'Chi tiết một phiếu chi lợi nhuận cổ đông / lương điều hành để duyệt: lúc lập (dòng sổ) và bây giờ (số dư nếu bỏ phiếu này). Quyền như shareholder_profit_ledger_v1; phiếu lương điều hành thêm shareholder_profit.pay_manager. Chỉ đọc.';
COMMENT ON FUNCTION public.profit_manager_ledger_v1(uuid) IS
  'Sổ lương điều hành: người nhận (chưa xoá + đã xoá còn số) với số dư theo profit_ledger_balance_v1. Quyền: shareholder_profit.pay_manager|distribute|lock|manage_shareholders. Chỉ đọc.';

-- Z. Hậu kiểm. Đúng ở cả lượt một lẫn lượt chạy lại.
DO $sau$
DECLARE
  v_xau text;
  c_rpc constant text[] := ARRAY[
    'public.shareholder_profit_ledger_v1(uuid)',
    'public.shareholder_profit_ledger_entries_v1(uuid,uuid)',
    'public.shareholder_profit_my_ledger_v1(uuid)',
    'public.profit_ledger_payout_detail_v1(uuid)',
    'public.profit_manager_ledger_v1(uuid)'];
  c_phu constant text[] := ARRAY[
    'app_private.profit_ledger_doc_can_v1(uuid,text[])',
    'app_private.profit_ledger_doc_status_v1(numeric)',
    'app_private.profit_ledger_doc_marker_v1(jsonb)',
    'app_private.profit_ledger_doc_shareholder_v1(uuid,uuid)'];
BEGIN
  -- RPC: đủ, STABLE + DEFINER (gọi được trong giao dịch chỉ đọc), ghim search_path, trả jsonb;
  -- chỉ authenticated gọi được (không PUBLIC, anon, service_role).
  SELECT string_agg(f.ten, ', ') INTO v_xau
    FROM unnest(c_rpc) AS f(ten)
    LEFT JOIN pg_catalog.pg_proc p ON p.oid = to_regprocedure(f.ten)
   WHERE p.oid IS NULL
      OR p.provolatile <> 's'
      OR NOT p.prosecdef
      OR p.prorettype <> 'jsonb'::regtype
      OR NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) cfg WHERE cfg LIKE 'search_path=%')
      OR p.proacl IS NULL
      OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0)
      OR NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
      OR has_function_privilege('anon', p.oid, 'EXECUTE')
      OR has_function_privilege('service_role', p.oid, 'EXECUTE');
  IF v_xau IS NOT NULL THEN
    RAISE EXCEPTION 'Hậu kiểm: RPC đọc sổ tổng thiếu, sai volatility/DEFINER/search_path hoặc sai quyền gọi: %', v_xau
      USING ERRCODE = '55000';
  END IF;

  -- Hàm phụ: đủ, ghim search_path, không ai ngoài chủ hàm có EXECUTE; hàm đọc không VOLATILE.
  SELECT string_agg(f.ten, ', ') INTO v_xau
    FROM unnest(c_phu) AS f(ten)
    LEFT JOIN pg_catalog.pg_proc p ON p.oid = to_regprocedure(f.ten)
   WHERE p.oid IS NULL
      OR p.provolatile = 'v'
      OR p.proacl IS NULL
      OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee <> p.proowner)
      OR NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) cfg WHERE cfg LIKE 'search_path=%');
  IF v_xau IS NOT NULL THEN
    RAISE EXCEPTION 'Hậu kiểm: hàm phụ đọc sổ tổng thiếu, VOLATILE, chưa ghim search_path hoặc còn EXECUTE cho vai khác: %', v_xau
      USING ERRCODE = '55000';
  END IF;
END
$sau$;

NOTIFY pgrst, 'reload schema';

COMMIT;
