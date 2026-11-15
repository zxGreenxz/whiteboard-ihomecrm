-- =============================================================================
-- Sổ tổng lợi nhuận cổ đông — PHẦN LƯƠNG (M3 của "Chi chia lợi nhuận theo sổ tổng").
--
-- VÌ SAO
--   Hai quản lý hưởng lương đồng thời là cổ đông: dòng "Lợi nhuận đầu tư" trong lương
--   trả phần lợi nhuận của tháng. Sổ tổng (M1) phải trừ đúng phần đã trả qua TỪNG phiếu
--   lương; khi cổ đông đang tạm ứng thì lương trừ khoản đó, nhưng chỉ trong phạm vi phần
--   lợi nhuận của tháng (phần chưa trừ hết để tháng sau). Máy chủ không tự tính lương,
--   nên mọi con số client gửi đều được đối chiếu và KẸP LẠI ở máy chủ.
--
-- LÀM GÌ
--   1. Hàm nội bộ (app_private, không cấp quyền cho vai nào):
--      - salary_investment_profit_v1: dòng đầu tư của lương tháng (bản máy chủ của
--        applySalaryExtras/investmentByBuilding ở src/lib/salaryOverrides.ts);
--      - salary_profit_month_caps_v1: MỘT công thức trừ tạm ứng cho cả tháng
--        D_m = greatest(least(adv_m, greatest(least(Y_m, A_m), 0)), ΣD đã trừ), adv_m = greatest(0, A_m − L*);
--        cờ offset_conflict khi bảng đã chốt không gồm phần đã trừ;
--      - profit_ledger_luong_*: trợ giúp (cổ đông của nhân viên, kẹp cùng dấu, khoá idempotency)
--        và profit_ledger_luong_backfill_v1 (ghi bù phiếu lương cũ — dùng ở Đợt 3).
--   2. RPC: E12 salary_profit_inputs_v1 (đọc), E13 salary_profit_settlement_freeze_v1
--      (đóng băng ngay trước khi chốt lương), E14 profit_unlock_salary_impact_v1 (báo trước
--      khi mở khoá tháng lợi nhuận), E15 salary_profit_payout_quote_v1 (báo giá ngay trước
--      salary_payout_v1, cùng khoá), E16 profit_ledger_salary_resolve_v1 (chủ xác nhận dòng
--      "cần xem lại").
--   3. F3: hai trigger AFTER trên public.salary_monthly gắn phiếu lương vừa đóng dấu vào
--      sổ. Khớp báo giá ⇒ LINKED đúng số báo giá (quá hạn, lệch tiền, trộn dấu, kẹp lại làm
--      đổi số ⇒ NEEDS_REVIEW); không khớp ⇒ dự phòng (LINKED theo quy ước hoặc NEEDS_REVIEW);
--      kỳ không phải ngày 1 / bảng chốt không gồm phần đã trừ ⇒ NEEDS_REVIEW. KHÔNG raise trên
--      đường thường: đường trả lương của nhân viên không phải cổ đông chạy y như cũ.
--
-- KHÔNG LÀM: không đổi tên / bọc salary_payout_v1, lock_salary_month_v2; không sửa M1;
--   không đụng phiếu chi lợi nhuận (M2); không ghi dữ liệu nào.
--
-- AN TOÀN CHẠY LẠI: chỉ CREATE OR REPLACE FUNCTION, DROP TRIGGER IF EXISTS + CREATE TRIGGER,
--   REVOKE/GRANT, COMMENT và hai khối kiểm.
-- LÙI (RB3): DROP TRIGGER IF EXISTS z50_profit_ledger_salary_link_ins, z50_profit_ledger_salary_link_upd
--   ON public.salary_monthly ⇒ đường trả lương trở lại đúng như trước; các RPC mới chưa
--   có ai gọi cho tới Đợt 2. Dòng sổ đã ghi giữ nguyên (sổ chỉ ghi thêm).
-- =============================================================================

BEGIN;

-- 0. Tiền kiểm: nền M1 và các hàm/cột mà phần lương dựa vào. Thiếu ⇒ dừng 55000.
DO $truoc$
DECLARE
  v_thieu text;
BEGIN
  SELECT string_agg(f, ', ' ORDER BY f) INTO v_thieu
    FROM unnest(ARRAY[
      'app_private.profit_ledger_balance_v1(uuid,text,uuid,uuid,date)',
      'app_private.profit_ledger_active_marker_v1(uuid,text,uuid)',
      'app_private.profit_ledger_voucher_live_v1(uuid)',
      'app_private.profit_ledger_lock_v1(uuid,text,uuid)',
      'app_private.profit_viewer_can_v1(uuid,text)',
      'app_private.salary_staff_org_v1(uuid)',
      'public.salary_is_admin_v1(uuid)',
      'app_private.lock_org_for_decision_v1(uuid)',
      'app_private.authorize_tenant_action_v3(uuid,uuid,text,uuid,uuid)',
      'app_private.evaluate_feature_route(text,uuid)',
      'app_private.claim_feature_operation_v1(text,uuid,text,uuid,text,numeric)']) AS f
   WHERE to_regprocedure(f) IS NULL;
  IF v_thieu IS NOT NULL THEN
    RAISE EXCEPTION 'Thiếu hàm nền (M1 phải áp trước): %', v_thieu USING ERRCODE = '55000';
  END IF;

  SELECT string_agg(x.rel || '.' || c.col, ', ' ORDER BY x.rel, c.col) INTO v_thieu
    FROM (VALUES
      ('public.salary_monthly', ARRAY['id', 'staff_id', 'period_month', 'status', 'investment_profit',
         'advances_total', 'take_home', 'payout_voucher_id', 'locked_at', 'organization_id']),
      ('app_private.salary_line_overrides', ARRAY['organization_id', 'staff_id', 'period_month', 'line_key',
         'amount', 'seq', 'created_at']),
      ('public.income_expenses', ARRAY['id', 'organization_id', 'type', 'deleted_at', 'total_amount',
         'salary_staff_id', 'salary_role', 'source_payload_hash', 'code', 'approval_status', 'posting_status',
         'created_at']),
      ('public.buildings', ARRAY['id', 'code', 'name']),
      ('public.profit_monthly', ARRAY['id', 'organization_id', 'building_id', 'period_month', 'status',
         'locked_at', 'is_stale']),
      ('public.profit_allocations', ARRAY['id', 'profit_monthly_id', 'shareholder_id', 'amount']),
      ('public.shareholders', ARRAY['id', 'organization_id', 'auth_user_id', 'deleted_at', 'name']),
      ('app_private.canonical_write_operations', ARRAY['organization_id', 'operation', 'subject_scope',
         'actor_id', 'idempotency_key', 'payload_hash', 'subject_id', 'response_payload', 'created_at',
         'completed_at']),
      ('app_private.profit_ledger_salary_settlements', ARRAY['id', 'state', 'advance_offset_month',
         'applied_offset_at_freeze', 'expected_take_home', 'salary_monthly_id']),
      ('app_private.profit_ledger_salary_settlement_vouchers', ARRAY['id', 'state', 'salary_voucher_id',
         'payout_request_key', 'expected_voucher_amount', 'settlement_id']),
      ('app_private.profit_ledger_events', ARRAY['event_kind', 'line_id', 'settlement_id'])
    ) AS x(rel, cols)
    CROSS JOIN LATERAL unnest(x.cols) AS c(col)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_catalog.pg_attribute a
      WHERE a.attrelid = to_regclass(x.rel) AND a.attname = c.col AND a.attnum > 0 AND NOT a.attisdropped);
  IF v_thieu IS NOT NULL THEN
    RAISE EXCEPTION 'Thiếu bảng/cột nền: %', v_thieu USING ERRCODE = '55000';
  END IF;

  -- Một nhân viên chỉ ứng với nhiều nhất MỘT cổ đông: cả phần lương dựa vào điều này.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_index i
     WHERE i.indrelid = 'public.shareholders'::regclass
       AND i.indisunique AND i.indisvalid AND i.indpred IS NULL AND i.indnatts = 1
       AND i.indkey[0] = (SELECT a.attnum FROM pg_catalog.pg_attribute a
                           WHERE a.attrelid = 'public.shareholders'::regclass AND a.attname = 'auth_user_id')) THEN
    RAISE EXCEPTION 'Thiếu unique (auth_user_id) trên public.shareholders' USING ERRCODE = '55000';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM app_private.server_feature_flags f
                  WHERE f.feature_key = 'shareholder_profit.ledger_payout.v1') THEN
    RAISE EXCEPTION 'Thiếu công tắc shareholder_profit.ledger_payout.v1 (M1)' USING ERRCODE = '55000';
  END IF;
END
$truoc$;

-- ── 1. Trợ giúp nhỏ ──────────────────────────────────────────────────────────

-- Cổ đông (chưa xoá) của một nhân viên trong một công ty; NULL nếu nhân viên không là cổ đông.
-- shareholders.auth_user_id là unique (tiền kiểm) nên nhiều nhất một dòng.
CREATE OR REPLACE FUNCTION app_private.profit_ledger_luong_co_dong_v1(p_org uuid, p_staff uuid)
RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
  SELECT s.id
    FROM public.shareholders s
   WHERE s.organization_id = p_org
     AND s.auth_user_id = p_staff
     AND s.deleted_at IS NULL
   ORDER BY s.id
   LIMIT 1
$fn$;

-- Kẹp p_value vào đoạn giữa 0 và p_limit, CÙNG DẤU với p_limit (tháng lỗ thì âm).
CREATE OR REPLACE FUNCTION app_private.profit_ledger_luong_kep_v1(p_value numeric, p_limit numeric)
RETURNS numeric
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog'
AS $fn$
  SELECT CASE
           WHEN p_value IS NULL OR p_limit IS NULL THEN NULL
           WHEN p_limit >= 0 THEN least(greatest(p_value, 0), p_limit)
           ELSE greatest(least(p_value, 0), p_limit)
         END
$fn$;

-- Khoá idempotency đã chuẩn hoá (btrim) — cùng luật với salary_payout_v1, nên khoá báo giá
-- lưu ra khớp đúng khoá mà lệnh trả lương ghi vào canonical_write_operations.
CREATE OR REPLACE FUNCTION app_private.profit_ledger_luong_khoa_v1(p_key text, p_ten text)
RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'pg_catalog'
AS $fn$
DECLARE
  v text := btrim(COALESCE(p_key, ''));
BEGIN
  IF v !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' THEN
    RAISE EXCEPTION 'SALARY_PROFIT_BAD_KEY: % phải dài 8–200 ký tự ASCII an toàn (chữ, số, . _ : -)', COALESCE(p_ten, 'khoá')
      USING ERRCODE = '22023';
  END IF;
  RETURN v;
END
$fn$;

-- Số hữu hạn (không NULL, không NaN / vô cực).
CREATE OR REPLACE FUNCTION app_private.profit_ledger_luong_so_v1(p numeric)
RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog'
AS $fn$
  SELECT p IS NOT NULL AND p::text NOT IN ('NaN', 'Infinity', '-Infinity')
$fn$;

-- ── 2. Dòng "Lợi nhuận đầu tư" của lương tháng ───────────────────────────────
-- Bảng lương LOCKED: số đã đóng băng salary_monthly.investment_profit.
-- DRAFT / chưa có bảng (NONE): phân bổ của các toà ĐÃ CHỐT trong kỳ (kể cả âm, kể cả stale),
--   gộp theo nhãn toà COALESCE(NULLIF(code,''), NULLIF(name,''), '—') như client, rồi áp ghi đè
--   MỚI NHẤT theo seq của khoá 'dh:'||nhãn (dòng mới nhất có amount NULL = đã gỡ ghi đè); ghi đè
--   chỉ áp cho nhãn có phân bổ trong kỳ. p_locked_before: chỉ tính toà chốt trước mốc giờ đó.
-- Luôn trả cả bản sống (investment_live) và tổng phân bổ TRƯỚC ghi đè (allocated_total = A_m).
CREATE OR REPLACE FUNCTION app_private.salary_investment_profit_v1(
  p_org uuid,
  p_staff uuid,
  p_period date,
  p_locked_before timestamptz DEFAULT NULL
) RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_shareholder  uuid;
  v_sm_id        uuid;
  v_sm_status    text;
  v_sm_invest    numeric;
  v_sm_locked_at timestamptz;
  v_status       text := 'NONE';
  v_by           jsonb := '[]'::jsonb;
  v_alloc_total  numeric := 0;
  v_live         numeric := 0;
BEGIN
  IF p_org IS NULL OR p_staff IS NULL OR p_period IS NULL OR EXTRACT(DAY FROM p_period) <> 1 THEN
    RAISE EXCEPTION 'SALARY_PROFIT_BAD_INPUT: thiếu công ty / nhân viên / kỳ lương, hoặc kỳ không phải ngày đầu tháng'
      USING ERRCODE = '22023';
  END IF;
  v_shareholder := app_private.profit_ledger_luong_co_dong_v1(p_org, p_staff);

  SELECT sm.id, sm.status, sm.investment_profit, sm.locked_at
    INTO v_sm_id, v_sm_status, v_sm_invest, v_sm_locked_at
    FROM public.salary_monthly sm
   WHERE sm.staff_id = p_staff
     AND sm.period_month = p_period
     AND (sm.organization_id IS NULL OR sm.organization_id = p_org);
  IF v_sm_id IS NOT NULL THEN
    v_status := CASE WHEN v_sm_status = 'LOCKED' THEN 'LOCKED' ELSE 'DRAFT' END;
  END IF;

  IF v_shareholder IS NOT NULL THEN
    WITH phan_bo AS (
      SELECT COALESCE(NULLIF(b.code, ''), NULLIF(b.name, ''), '—') AS nhan, pm.building_id, a.amount
        FROM public.profit_allocations a
        JOIN public.profit_monthly pm ON pm.id = a.profit_monthly_id
        LEFT JOIN public.buildings b ON b.id = pm.building_id
       WHERE a.shareholder_id = v_shareholder
         AND pm.organization_id = p_org
         AND pm.period_month = p_period
         AND pm.status = 'LOCKED'
         AND (p_locked_before IS NULL OR COALESCE(pm.locked_at, '-infinity'::timestamptz) <= p_locked_before)
    ), nhom AS (
      SELECT x.nhan, array_agg(DISTINCT x.building_id) AS building_ids, sum(x.amount) AS allocated
        FROM phan_bo x
       GROUP BY x.nhan
    ), ghi_de AS (
      -- Như salary_line_override_list_v1: dòng mới nhất theo seq; kỳ đã chốt chỉ xét dòng tạo trước giờ chốt.
      SELECT DISTINCT ON (o.line_key) o.line_key, o.amount
        FROM app_private.salary_line_overrides o
       WHERE o.organization_id = p_org
         AND o.staff_id = p_staff
         AND o.period_month = p_period
         AND (v_status <> 'LOCKED' OR v_sm_locked_at IS NULL OR o.created_at <= v_sm_locked_at)
       ORDER BY o.line_key, o.seq DESC
    )
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'label', n.nhan,
             'building_ids', to_jsonb(n.building_ids),
             'allocated', n.allocated,
             'override_amount', g.amount,
             'amount', COALESCE(g.amount, n.allocated)) ORDER BY n.nhan), '[]'::jsonb),
           COALESCE(sum(n.allocated), 0),
           COALESCE(sum(COALESCE(g.amount, n.allocated)), 0)
      INTO v_by, v_alloc_total, v_live
      FROM nhom n
      LEFT JOIN ghi_de g ON g.line_key = 'dh:' || n.nhan;
  END IF;

  RETURN jsonb_build_object(
    'shareholder_id', v_shareholder,
    'sheet_status', v_status,
    'salary_monthly_id', v_sm_id,
    'by_building', v_by,
    'allocated_total', v_alloc_total,
    'investment_live', v_live,
    'investment', CASE WHEN v_status = 'LOCKED' THEN COALESCE(v_sm_invest, 0) ELSE v_live END);
END
$fn$;

-- ── 3. Trần của tháng: MỘT công thức D ──────────────────────────────────────
--   A_m   = phân bổ đã chốt của cổ đông trong kỳ (TRƯỚC ghi đè, kể cả âm và stale)
--   Y_m   = dòng đầu tư của lương kỳ (xem salary_investment_profit_v1)
--   L*    = số dư sổ tổng loại hẳn phần lương của kỳ (profit_ledger_balance_v1 … p_exclude_salary_period)
--   adv_m = greatest(0, A_m − L*)  — tạm ứng còn treo trước lương kỳ này (dùng A_m: ghi đè tăng
--           không bị trừ ngược)
--   D_m   = greatest(least(adv_m, greatest(least(Y_m, A_m), 0)), ΣD đã trừ)  (bảng nháp / chưa có bảng)
--           — chỉ trừ trong phần lợi nhuận của tháng (A_m; phần ghi đè tăng trả bằng tiền), và không
--           bao giờ nhỏ hơn phần các phiếu lương LINKED còn sống đã trừ (client phải giữ khoản đã trừ).
-- Bảng LOCKED: Y_m = số đóng băng; D_m lấy từ bản đóng băng C3 CHỈ KHI bản đó khớp bảng đã chốt
--   (cùng Y, advances_total ≥ greatest(D, ΣD đã trừ), cùng thực nhận nếu có khai, cùng dòng bảng lương);
--   không có hoặc không khớp ⇒ D_m = 0 (bảng chốt bằng đường cũ không hề trừ khoản này).
-- Kỳ ≤ mốc "đã trả đủ": phần trả qua lương = 0 (investment_cap = 0) và D_m = 0.
-- paid_* = Σ dòng phiếu lương LINKED còn sống của cổ đông trong kỳ.
-- offset_conflict: ΣD đã trừ > D_m ngoài kỳ ≤ mốc (chỉ xảy ra ở bảng LOCKED không khớp: bảng chốt
--   không gồm khoản đã trừ) ⇒ phiếu lương sau cần chủ xem lại; sửa bằng mở chốt lương, E13, chốt lại.
CREATE OR REPLACE FUNCTION app_private.salary_profit_month_caps_v1(
  p_org uuid,
  p_shareholder uuid,
  p_staff uuid,
  p_period date
) RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_inv          jsonb;
  v_status       text;
  v_marker       date;
  v_settled      boolean;
  v_a            numeric;
  v_lstar        numeric;
  v_adv          numeric;
  v_y            numeric;
  v_d            numeric := 0;
  v_cap_y        numeric;
  v_paid_y       numeric := 0;
  v_paid_d       numeric := 0;
  v_settlement   uuid;
  v_sm_id        uuid;
  v_sm_invest    numeric;
  v_sm_adv_total numeric;
  v_sm_take_home numeric;
  v_c3_id        uuid;
  v_c3_y         numeric;
  v_c3_d         numeric;
  v_c3_take_home numeric;
  v_c3_sm        uuid;
  v_conflict     boolean;
BEGIN
  v_inv := app_private.salary_investment_profit_v1(p_org, p_staff, p_period);
  IF p_shareholder IS NULL OR p_shareholder IS DISTINCT FROM (v_inv->>'shareholder_id')::uuid THEN
    RAISE EXCEPTION 'SALARY_PROFIT_BAD_SUBJECT: cổ đông không khớp nhân viên hưởng lương của công ty này'
      USING ERRCODE = '22023';
  END IF;
  v_status := v_inv->>'sheet_status';
  v_a := (v_inv->>'allocated_total')::numeric;

  SELECT mk.settled_through_month INTO v_marker
    FROM app_private.profit_ledger_active_marker_v1(p_org, 'SHAREHOLDER', p_shareholder) mk;
  v_settled := v_marker IS NOT NULL AND p_period <= v_marker;

  SELECT COALESCE(sum(l.investment_amount), 0), COALESCE(sum(l.advance_offset_amount), 0)
    INTO v_paid_y, v_paid_d
    FROM app_private.profit_ledger_salary_settlement_vouchers l
   WHERE l.organization_id = p_org
     AND l.shareholder_id = p_shareholder
     AND l.period_month = p_period
     AND l.state = 'LINKED'
     AND app_private.profit_ledger_voucher_live_v1(l.salary_voucher_id);

  v_lstar := (app_private.profit_ledger_balance_v1(p_org, 'SHAREHOLDER', p_shareholder, NULL, p_period)->>'balance')::numeric;
  v_adv := greatest(0, v_a - v_lstar);

  IF v_status = 'LOCKED' THEN
    SELECT sm.id, sm.investment_profit, sm.advances_total, sm.take_home
      INTO v_sm_id, v_sm_invest, v_sm_adv_total, v_sm_take_home
      FROM public.salary_monthly sm
     WHERE sm.staff_id = p_staff
       AND sm.period_month = p_period
       AND (sm.organization_id IS NULL OR sm.organization_id = p_org);
    v_y := COALESCE(v_sm_invest, 0);
    SELECT c.id, c.investment_month, c.advance_offset_month, c.expected_take_home, c.salary_monthly_id
      INTO v_c3_id, v_c3_y, v_c3_d, v_c3_take_home, v_c3_sm
      FROM app_private.profit_ledger_salary_settlements c
     WHERE c.organization_id = p_org
       AND c.shareholder_id = p_shareholder
       AND c.period_month = p_period
       AND c.state = 'FROZEN';
    IF v_c3_id IS NOT NULL
       AND v_c3_y = v_y
       AND COALESCE(v_sm_adv_total, 0) >= greatest(v_c3_d, v_paid_d)
       AND (v_c3_take_home IS NULL OR v_c3_take_home = v_sm_take_home)
       AND (v_c3_sm IS NULL OR v_c3_sm = v_sm_id) THEN
      v_settlement := v_c3_id;
      v_d := v_c3_d;
    END IF;
  ELSE
    v_y := (v_inv->>'investment')::numeric;
    v_d := greatest(least(v_adv, greatest(least(v_y, v_a), 0)), v_paid_d);
  END IF;
  IF v_settled THEN
    v_d := 0;
  END IF;
  v_cap_y := CASE WHEN v_settled THEN 0 ELSE v_y END;
  v_conflict := NOT v_settled AND v_paid_d > v_d;

  RETURN jsonb_build_object(
    'shareholder_id', p_shareholder,
    'staff_id', p_staff,
    'period_month', p_period,
    'sheet_status', v_status,
    'salary_monthly_id', v_inv->'salary_monthly_id',
    'investment_month', v_y,
    'investment_cap', v_cap_y,
    'advance_offset_month', v_d,
    'paid_investment', v_paid_y,
    'paid_offset', v_paid_d,
    'remaining_investment', v_cap_y - v_paid_y,
    'remaining_offset', greatest(v_d - v_paid_d, 0),
    'offset_conflict', v_conflict,
    'settled_by_marker', v_settled,
    'marker_through', v_marker,
    'allocated_total', v_a,
    'ledger_balance_excluding_period', v_lstar,
    'advance_open', v_adv,
    'settlement_id', v_settlement,
    'investment_live', v_inv->'investment_live',
    'by_building', v_inv->'by_building');
END
$fn$;

-- ── 4. F3: gắn phiếu lương vừa đóng dấu vào sổ ──────────────────────────────
-- Chạy khi salary_monthly.payout_voucher_id được đặt (chèn mới hoặc đổi sang phiếu khác).
-- Bỏ qua: phiếu không phải phiếu lương của chính nhân viên đó, phiếu ứng lương, phiếu đã xoá,
--   nhân viên không là cổ đông, phiếu đã có dòng sổ.
-- Kỳ: lệnh salary.payout.v1 ĐANG CHẠY trong giao dịch này (cùng người, cùng nhân viên, cùng dấu
--   nội dung với phiếu) → lệnh đã xong có subject_id = phiếu → kỳ của dòng bảng lương.
-- NEEDS_REVIEW bắt buộc (không LINKED, không bỏ qua im lặng) khi: kỳ không phải ngày 1 (dòng ghi ở
--   tháng chứa ngày đó, PERIOD_NOT_FIRST_DAY); phần trừ tạm ứng đã ghi vượt D_m của bảng đã chốt
--   (OFFSET_CONFLICT — bảng chốt không gồm khoản đã trừ).
-- Khớp báo giá (QUOTED cùng nhân viên, kỳ, người gọi, khoá trả lương): quá 30 phút, tổng tiền phiếu ≠
--   số báo giá cam kết, số chọn luỹ kế trái dấu phần còn lại (MIXED_SIGN_SELECTION), hoặc bước kẹp lại
--   theo các dòng LINKED hiện có (đã giữ khoá sổ) làm đổi Y_i/D_i (QUOTE_RECLAMPED) ⇒ huỷ báo giá +
--   NEEDS_REVIEW kèm số báo giá và số kẹp; còn lại LINKED đúng số báo giá.
-- Dự phòng: kỳ ≤ mốc ⇒ LINKED 0/0; bảng LOCKED ⇒ LINKED Y_i = phần còn lại (kẹp theo tiền phiếu +
--   D_i), D_i = phần D_m còn lại (0 nếu không có bản đóng băng khớp); DRAFT/NONE ⇒ NEEDS_REVIEW,
--   chỉ gợi ý số (không trừ sổ).
-- Không raise trên đường thường; chỉ raise khi phiếu đã gắn cho cổ đông khác (vi phạm toàn vẹn).
CREATE OR REPLACE FUNCTION app_private.profit_ledger_salary_link_v1()
RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_voucher       uuid := NEW.payout_voucher_id;
  v_actor         uuid := auth.uid();
  v_ie_org        uuid;
  v_ie_staff      uuid;
  v_ie_role       text;
  v_ie_type       text;
  v_ie_deleted    timestamptz;
  v_ie_total      numeric;
  v_ie_hash       text;
  v_ie_created    timestamptz;
  v_sh            uuid;
  v_op_key        text;
  v_op_scope      text;
  v_period        date;
  v_period_src    text;
  v_scope         text;
  v_ky            text;
  v_exist_sh      uuid;
  v_caps          jsonb;
  v_settled       boolean;
  v_status        text;
  v_cap_y         numeric;
  v_paid_y        numeric;
  v_paid_d        numeric;
  v_dm            numeric;
  v_settlement    uuid;
  v_q_id          uuid;
  v_q_y           numeric;
  v_q_d           numeric;
  v_q_amount      numeric;
  v_q_created     timestamptz;
  v_q_settlement  uuid;
  v_q_selected    numeric;
  v_q_key         text;
  v_reason        text;
  v_state         text;
  v_y             numeric := 0;
  v_d             numeric := 0;
  v_suggest       numeric;
  v_line          uuid;
  v_before        numeric;
  v_after         numeric;
  v_period_raw    date;
  v_force         text;
  v_r             numeric;
  v_x             numeric;
BEGIN
  IF v_voucher IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT ie.organization_id, ie.salary_staff_id, ie.salary_role, ie.type, ie.deleted_at, ie.total_amount,
         ie.source_payload_hash, ie.created_at
    INTO v_ie_org, v_ie_staff, v_ie_role, v_ie_type, v_ie_deleted, v_ie_total, v_ie_hash, v_ie_created
    FROM public.income_expenses ie
   WHERE ie.id = v_voucher;
  IF NOT FOUND
     OR v_ie_staff IS DISTINCT FROM NEW.staff_id
     OR v_ie_role IS NOT DISTINCT FROM 'ADVANCE'
     OR v_ie_type IS DISTINCT FROM 'EXPENSE'
     OR v_ie_deleted IS NOT NULL THEN
    RETURN NEW;
  END IF;
  v_sh := app_private.profit_ledger_luong_co_dong_v1(v_ie_org, NEW.staff_id);
  IF v_sh IS NULL THEN
    RETURN NEW;
  END IF;

  -- Kỳ lương của phiếu.
  SELECT o.idempotency_key, o.subject_scope INTO v_op_key, v_op_scope
    FROM app_private.canonical_write_operations o
   WHERE o.organization_id = v_ie_org
     AND o.operation = 'salary.payout.v1'
     AND o.completed_at IS NULL
     AND o.actor_id = v_actor
     AND split_part(o.subject_scope, '|', 1) = NEW.staff_id::text
     AND o.payload_hash = v_ie_hash
   ORDER BY o.created_at DESC
   LIMIT 1;
  v_ky := split_part(v_op_scope, '|', 2);
  IF v_op_scope IS NOT NULL AND v_ky ~ '^\d{4}-\d{2}-\d{2}$' THEN
    v_period := to_date(v_ky, 'YYYY-MM-DD');
    v_period_src := 'RUNNING_OPERATION';
  ELSE
    v_op_key := NULL;
    SELECT o.subject_scope INTO v_scope
      FROM app_private.canonical_write_operations o
     WHERE o.organization_id = v_ie_org
       AND o.operation = 'salary.payout.v1'
       AND o.subject_id = v_voucher
       AND split_part(o.subject_scope, '|', 1) = NEW.staff_id::text
     ORDER BY o.completed_at DESC NULLS LAST
     LIMIT 1;
    v_ky := split_part(v_scope, '|', 2);
    IF v_scope IS NOT NULL AND v_ky ~ '^\d{4}-\d{2}-\d{2}$' THEN
      v_period := to_date(v_ky, 'YYYY-MM-DD');
      v_period_src := 'COMPLETED_OPERATION';
    ELSE
      v_period := NEW.period_month;
      v_period_src := 'SALARY_SHEET';
    END IF;
  END IF;
  IF v_period IS NULL THEN
    RETURN NEW;
  END IF;
  -- Kỳ lương không phải ngày 1 (salary_payout_v1 nhận mọi ngày): không bỏ qua im lặng — ghi dòng cần xem lại
  -- ở tháng chứa ngày đó.
  IF EXTRACT(DAY FROM v_period) <> 1 THEN
    v_period_raw := v_period;
    v_period := date_trunc('month', v_period)::date;
    v_force := 'PERIOD_NOT_FIRST_DAY';
  END IF;

  -- Đường lương đã giữ khoá tổ chức (salary_payout_v1); ở đây chỉ lấy khoá sổ.
  PERFORM app_private.profit_ledger_lock_v1(v_ie_org, 'SHAREHOLDER', v_sh);

  SELECT l.shareholder_id INTO v_exist_sh
    FROM app_private.profit_ledger_salary_settlement_vouchers l
   WHERE l.salary_voucher_id = v_voucher;
  IF FOUND THEN
    IF v_exist_sh IS DISTINCT FROM v_sh THEN
      RAISE EXCEPTION 'PROFIT_LEDGER_SALARY_VOUCHER_CONFLICT: phiếu lương đã gắn vào sổ của cổ đông khác'
        USING ERRCODE = '55000', DETAIL = jsonb_build_object('salary_voucher_id', v_voucher)::text;
    END IF;
    RETURN NEW;
  END IF;

  v_caps := app_private.salary_profit_month_caps_v1(v_ie_org, v_sh, NEW.staff_id, v_period);
  v_settled := (v_caps->>'settled_by_marker')::boolean;
  v_status := v_caps->>'sheet_status';
  v_cap_y := (v_caps->>'investment_cap')::numeric;
  v_paid_y := (v_caps->>'paid_investment')::numeric;
  v_paid_d := (v_caps->>'paid_offset')::numeric;
  v_dm := (v_caps->>'advance_offset_month')::numeric;
  v_settlement := (v_caps->>'settlement_id')::uuid;
  v_r := v_cap_y - v_paid_y;
  v_before := (app_private.profit_ledger_balance_v1(v_ie_org, 'SHAREHOLDER', v_sh)->>'balance')::numeric;
  -- Bảng đã chốt không gồm khoản tạm ứng đã trừ ở phiếu trước ⇒ không tự ghi thêm, chủ xem lại.
  IF v_force IS NULL AND COALESCE((v_caps->>'offset_conflict')::boolean, false) THEN
    v_force := 'OFFSET_CONFLICT';
  END IF;

  IF v_op_key IS NOT NULL THEN
    SELECT q.id, q.investment_amount, q.advance_offset_amount, q.expected_voucher_amount, q.created_at,
           q.settlement_id, q.investment_selected, q.payout_request_key
      INTO v_q_id, v_q_y, v_q_d, v_q_amount, v_q_created, v_q_settlement, v_q_selected, v_q_key
      FROM app_private.profit_ledger_salary_settlement_vouchers q
     WHERE q.organization_id = v_ie_org
       AND q.shareholder_id = v_sh
       AND q.staff_id = NEW.staff_id
       AND q.period_month = v_period
       AND q.state = 'QUOTED'
       AND q.payout_request_key = v_op_key
       AND q.created_by IS NOT DISTINCT FROM v_actor
     FOR UPDATE;
  END IF;

  IF v_q_id IS NOT NULL THEN
    -- Kẹp lại theo các dòng LINKED hiện có (hai báo giá song song không đếm đôi); kẹp làm đổi số thì
    -- không LINKED với số nhỏ hơn mà để chủ xem lại.
    v_y := app_private.profit_ledger_luong_kep_v1(v_q_y, v_r);
    v_d := least(v_q_d, greatest(v_dm - v_paid_d, 0));
    IF v_y > 0 AND v_y - v_d > v_ie_total THEN
      v_y := v_d + v_ie_total;
    END IF;
    v_x := v_q_selected - v_paid_y;
    v_reason := COALESCE(v_force,
      CASE WHEN v_q_created < clock_timestamp() - interval '30 minutes' THEN 'QUOTE_EXPIRED'
           WHEN v_ie_total IS DISTINCT FROM v_q_amount THEN 'VOUCHER_AMOUNT_MISMATCH'
           WHEN NOT v_settled AND v_x <> 0 AND sign(v_x) <> sign(v_r) THEN 'MIXED_SIGN_SELECTION'
           WHEN v_y IS DISTINCT FROM v_q_y OR v_d IS DISTINCT FROM v_q_d THEN 'QUOTE_RECLAMPED'
      END);

    IF v_reason IS NULL THEN
      UPDATE app_private.profit_ledger_salary_settlement_vouchers
         SET state = 'LINKED',
             salary_voucher_id = v_voucher,
             settlement_id = COALESCE(v_q_settlement, v_settlement),
             investment_amount = v_y,
             advance_offset_amount = v_d,
             linked_at = clock_timestamp()
       WHERE id = v_q_id;
      v_line := v_q_id;
      v_state := 'LINKED';
    ELSE
      UPDATE app_private.profit_ledger_salary_settlement_vouchers
         SET state = 'VOID',
             voided_at = clock_timestamp(),
             void_reason = 'Báo giá không còn khớp phiếu lương vừa lập (' || v_reason || ')'
       WHERE id = v_q_id;
      INSERT INTO app_private.profit_ledger_events (organization_id, event_kind, subject_kind, shareholder_id,
        voucher_id, line_id, amount, actor_id, reason, payload)
      VALUES (v_ie_org, 'SALARY_VOIDED', 'SHAREHOLDER', v_sh, v_voucher, v_q_id, v_q_y, v_actor, v_reason,
        jsonb_build_object('period_month', v_period, 'expected_voucher_amount', v_q_amount,
                           'voucher_amount', v_ie_total, 'quote_created_at', v_q_created,
                           'quoted_investment', v_q_y, 'quoted_offset', v_q_d,
                           'clamped_investment', v_y, 'clamped_offset', v_d, 'investment_selected', v_q_selected));
      v_state := 'NEEDS_REVIEW';
      v_suggest := v_y;
    END IF;
  ELSIF v_force IS NOT NULL THEN
    v_state := 'NEEDS_REVIEW';
    v_reason := v_force;
    v_suggest := CASE WHEN v_status = 'LOCKED' THEN v_r
                      ELSE (app_private.salary_investment_profit_v1(v_ie_org, NEW.staff_id, v_period, v_ie_created)->>'investment')::numeric
                           - v_paid_y END;
    IF v_suggest > v_ie_total THEN
      v_suggest := v_ie_total;
    END IF;
  ELSIF v_settled THEN
    v_state := 'LINKED';
    v_reason := 'SETTLED_BY_MARKER';
  ELSIF v_status = 'LOCKED' THEN
    v_d := greatest(v_dm - v_paid_d, 0);
    v_y := v_cap_y - v_paid_y;
    IF v_y > 0 AND v_y - v_d > v_ie_total THEN
      v_y := v_d + v_ie_total;
    END IF;
    v_state := 'LINKED';
    v_reason := CASE WHEN v_settlement IS NULL THEN 'LOCKED_WITHOUT_SETTLEMENT' ELSE 'LOCKED_WITH_SETTLEMENT' END;
  ELSE
    v_state := 'NEEDS_REVIEW';
    v_reason := 'NO_QUOTE_DRAFT_SHEET';
    v_suggest := (app_private.salary_investment_profit_v1(v_ie_org, NEW.staff_id, v_period, v_ie_created)->>'investment')::numeric
                 - v_paid_y;
    IF v_suggest > v_ie_total THEN
      v_suggest := v_ie_total;
    END IF;
  END IF;

  IF v_line IS NULL THEN
    INSERT INTO app_private.profit_ledger_salary_settlement_vouchers (
      organization_id, shareholder_id, staff_id, period_month, settlement_id, salary_voucher_id,
      payout_request_key, investment_selected, investment_amount, advance_offset_amount, suggested_investment,
      expected_voucher_amount, sheet_status_at_quote, source, state, created_by, linked_at)
    VALUES (
      v_ie_org, v_sh, NEW.staff_id, v_period,
      CASE WHEN v_state = 'LINKED' THEN v_settlement END,
      v_voucher, COALESCE(v_q_key, v_op_key), v_q_selected,
      CASE WHEN v_state = 'LINKED' THEN v_y ELSE 0 END,
      CASE WHEN v_state = 'LINKED' THEN v_d ELSE 0 END,
      v_suggest, v_q_amount, v_status, 'PAYOUT_FALLBACK', v_state, v_actor,
      CASE WHEN v_state = 'LINKED' THEN clock_timestamp() END)
    ON CONFLICT (salary_voucher_id) WHERE salary_voucher_id IS NOT NULL DO NOTHING
    RETURNING id INTO v_line;
    IF v_line IS NULL THEN
      RETURN NEW;
    END IF;
  END IF;

  v_after := (app_private.profit_ledger_balance_v1(v_ie_org, 'SHAREHOLDER', v_sh)->>'balance')::numeric;
  INSERT INTO app_private.profit_ledger_events (organization_id, event_kind, subject_kind, shareholder_id,
    voucher_id, settlement_id, line_id, amount, balance_before, balance_after, actor_id, reason, payload)
  VALUES (v_ie_org,
    CASE WHEN v_state = 'LINKED' THEN 'SALARY_LINKED' ELSE 'SALARY_NEEDS_REVIEW' END,
    'SHAREHOLDER', v_sh, v_voucher,
    CASE WHEN v_state = 'LINKED' THEN COALESCE(v_q_settlement, v_settlement) END,
    v_line,
    CASE WHEN v_state = 'LINKED' THEN v_y ELSE v_suggest END,
    v_before, v_after, v_actor, v_reason,
    jsonb_build_object(
      'source', CASE WHEN v_state = 'LINKED' AND v_reason IS NULL THEN 'UI_QUOTE' ELSE 'PAYOUT_FALLBACK' END,
      'period_month', v_period,
      'period_source', v_period_src,
      'sheet_status', v_status,
      'investment_amount', CASE WHEN v_state = 'LINKED' THEN v_y ELSE 0 END,
      'advance_offset_amount', CASE WHEN v_state = 'LINKED' THEN v_d ELSE 0 END,
      'suggested_investment', v_suggest,
      'voucher_amount', v_ie_total,
      'settled_by_marker', v_settled,
      'period_raw', v_period_raw,
      'offset_conflict', (v_caps->>'offset_conflict')::boolean,
      'paid_offset', v_paid_d,
      'advance_offset_month', v_dm,
      'quoted_investment', v_q_y,
      'quoted_offset', v_q_d,
      'clamped_investment', CASE WHEN v_q_id IS NOT NULL THEN v_y END,
      'clamped_offset', CASE WHEN v_q_id IS NOT NULL THEN v_d END));
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS z50_profit_ledger_salary_link_ins ON public.salary_monthly;
CREATE TRIGGER z50_profit_ledger_salary_link_ins
  AFTER INSERT ON public.salary_monthly
  FOR EACH ROW
  WHEN (NEW.payout_voucher_id IS NOT NULL)
  EXECUTE FUNCTION app_private.profit_ledger_salary_link_v1();
-- WHEN chặn lần đặt lại cùng phiếu (trigger duyệt a70_salary_paid_accrual ghi
-- payout_voucher_id = coalesce(payout_voucher_id, …) mỗi lần duyệt).
DROP TRIGGER IF EXISTS z50_profit_ledger_salary_link_upd ON public.salary_monthly;
CREATE TRIGGER z50_profit_ledger_salary_link_upd
  AFTER UPDATE OF payout_voucher_id ON public.salary_monthly
  FOR EACH ROW
  WHEN (NEW.payout_voucher_id IS NOT NULL AND OLD.payout_voucher_id IS DISTINCT FROM NEW.payout_voucher_id)
  EXECUTE FUNCTION app_private.profit_ledger_salary_link_v1();

-- ── 5. E12 — đọc dữ kiện phần lợi nhuận trong lương (không khoá dòng) ───────
-- Mỗi nhân viên: công ty theo cấu hình lương; được xem khi là chính mình hoặc là quản trị lương
-- của công ty đó; MỘT nhân viên không đạt ⇒ 42501 cho cả lệnh (không lặng lẽ bỏ).
CREATE OR REPLACE FUNCTION public.salary_profit_inputs_v1(p_period_month date, p_staff_ids uuid[])
RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_uid      uuid := auth.uid();
  v_staff    uuid;
  v_org      uuid;
  v_sh       uuid;
  v_caps     jsonb;
  v_draft    boolean;
  v_sheet    text;
  v_allocs   jsonb;
  v_lines    jsonb;
  v_c3       jsonb;
  v_nr       jsonb;
  v_out      jsonb := '[]'::jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'SALARY_PROFIT_DENIED: chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF p_period_month IS NULL OR EXTRACT(DAY FROM p_period_month) <> 1
     OR p_staff_ids IS NULL OR cardinality(p_staff_ids) > 200
     OR array_position(p_staff_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'SALARY_PROFIT_BAD_INPUT: kỳ lương phải là ngày đầu tháng; danh sách nhân viên không có giá trị rỗng, tối đa 200'
      USING ERRCODE = '22023';
  END IF;

  FOR v_staff IN
    SELECT u.s FROM unnest(p_staff_ids) WITH ORDINALITY AS u(s, n) GROUP BY u.s ORDER BY min(u.n)
  LOOP
    v_org := app_private.salary_staff_org_v1(v_staff);
    IF NOT (v_staff = v_uid OR (v_org IS NOT NULL AND public.salary_is_admin_v1(v_org))) THEN
      RAISE EXCEPTION 'SALARY_PROFIT_DENIED: không có quyền xem phần lợi nhuận trong lương của một nhân viên trong danh sách'
        USING ERRCODE = '42501', DETAIL = jsonb_build_object('staff_id', v_staff)::text;
    END IF;

    v_draft := v_org IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.profit_monthly pm
       WHERE pm.organization_id = v_org AND pm.period_month = p_period_month AND pm.status = 'DRAFT');
    v_sh := CASE WHEN v_org IS NULL THEN NULL ELSE app_private.profit_ledger_luong_co_dong_v1(v_org, v_staff) END;

    IF v_sh IS NULL THEN
      SELECT CASE sm.status WHEN 'LOCKED' THEN 'LOCKED' ELSE 'DRAFT' END INTO v_sheet
        FROM public.salary_monthly sm
       WHERE sm.staff_id = v_staff AND sm.period_month = p_period_month
         AND (v_org IS NULL OR sm.organization_id IS NULL OR sm.organization_id = v_org);
      v_out := v_out || jsonb_build_array(jsonb_build_object(
        'staff_id', v_staff, 'organization_id', v_org, 'shareholder_id', NULL,
        'sheet_status', COALESCE(v_sheet, 'NONE'), 'profit_draft', v_draft,
        'allocations', '[]'::jsonb, 'by_building', '[]'::jsonb, 'allocated_total', 0,
        'investment_month', 0, 'investment_cap', 0, 'marker_through', NULL, 'settled_by_marker', false,
        'settlement', NULL, 'paid_lines', '[]'::jsonb, 'paid_investment', 0, 'paid_offset', 0,
        'advance_open', 0, 'advance_offset_month', 0, 'suggested_advance_offset', 0, 'remaining_offset', 0,
        'offset_conflict', false,
        'needs_review', jsonb_build_object('count', 0, 'suggested', 0)));
      v_sheet := NULL;
      CONTINUE;
    END IF;

    v_caps := app_private.salary_profit_month_caps_v1(v_org, v_sh, v_staff, p_period_month);

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'building_id', pm.building_id,
             'building_label', COALESCE(NULLIF(b.code, ''), NULLIF(b.name, ''), '—'),
             'amount', a.amount,
             'status', pm.status,
             'is_stale', pm.is_stale)
             ORDER BY COALESCE(NULLIF(b.code, ''), NULLIF(b.name, ''), '—'), pm.building_id, a.id), '[]'::jsonb)
      INTO v_allocs
      FROM public.profit_allocations a
      JOIN public.profit_monthly pm ON pm.id = a.profit_monthly_id
      LEFT JOIN public.buildings b ON b.id = pm.building_id
     WHERE a.shareholder_id = v_sh
       AND pm.organization_id = v_org
       AND pm.period_month = p_period_month;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'line_id', l.id,
             'salary_voucher_id', l.salary_voucher_id,
             'voucher_code', ie.code,
             'voucher_amount', ie.total_amount,
             'voucher_live', app_private.profit_ledger_voucher_live_v1(l.salary_voucher_id),
             'investment', l.investment_amount,
             'advance_offset', l.advance_offset_amount,
             'suggested_investment', l.suggested_investment,
             'state', l.state,
             'source', l.source,
             'created_at', l.created_at,
             'linked_at', l.linked_at) ORDER BY l.created_at, l.id), '[]'::jsonb)
      INTO v_lines
      FROM app_private.profit_ledger_salary_settlement_vouchers l
      LEFT JOIN public.income_expenses ie ON ie.id = l.salary_voucher_id
     WHERE l.organization_id = v_org
       AND l.shareholder_id = v_sh
       AND l.period_month = p_period_month
       AND l.state IN ('LINKED', 'NEEDS_REVIEW');

    SELECT jsonb_build_object(
             'id', c.id,
             'investment_month', c.investment_month,
             'advance_offset_month', c.advance_offset_month,
             'applied_offset_at_freeze', c.applied_offset_at_freeze,
             'expected_take_home', c.expected_take_home,
             'created_at', c.created_at,
             'matches_sheet', COALESCE(c.id = (v_caps->>'settlement_id')::uuid, false))
      INTO v_c3
      FROM app_private.profit_ledger_salary_settlements c
     WHERE c.organization_id = v_org
       AND c.shareholder_id = v_sh
       AND c.period_month = p_period_month
       AND c.state = 'FROZEN';

    v_nr := app_private.profit_ledger_balance_v1(v_org, 'SHAREHOLDER', v_sh)->'needs_review';

    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'staff_id', v_staff,
      'organization_id', v_org,
      'shareholder_id', v_sh,
      'sheet_status', v_caps->'sheet_status',
      'profit_draft', v_draft,
      'allocations', v_allocs,
      'by_building', v_caps->'by_building',
      'allocated_total', v_caps->'allocated_total',
      'investment_month', v_caps->'investment_month',
      'investment_cap', v_caps->'investment_cap',
      'marker_through', v_caps->'marker_through',
      'settled_by_marker', v_caps->'settled_by_marker',
      'settlement', v_c3,
      'paid_lines', v_lines,
      'paid_investment', v_caps->'paid_investment',
      'paid_offset', v_caps->'paid_offset',
      'advance_open', v_caps->'advance_open',
      'advance_offset_month', v_caps->'advance_offset_month',
      'suggested_advance_offset', v_caps->'advance_offset_month',
      'remaining_offset', v_caps->'remaining_offset',
      'offset_conflict', v_caps->'offset_conflict',
      'needs_review', v_nr));
    v_c3 := NULL;
  END LOOP;

  RETURN jsonb_build_object('period_month', p_period_month, 'staff', v_out);
END
$fn$;

-- ── 6. E13 — đóng băng phần lợi nhuận của lương tháng, gọi NGAY TRƯỚC lock_salary_month_v2 ──
-- Không bao giờ chặn chốt vì bản đóng băng / dòng phiếu lương cũ: luôn huỷ bản cũ rồi tạo lại;
-- D_m không nhỏ hơn phần đã trừ trong các phiếu lương LINKED còn sống, kể cả khi p_max_offset nhỏ hơn
-- (trừ kỳ ≤ mốc: D_m = 0). Thực nhận dự kiến bắt buộc.
-- Bảng lương đã LOCKED: không ghi gì, trả số hiện hành với already_locked = true.
CREATE OR REPLACE FUNCTION public.salary_profit_settlement_freeze_v1(
  p_staff_id uuid,
  p_period_month date,
  p_expected_investment numeric,
  p_max_offset numeric,
  p_expected_take_home numeric,
  p_idempotency_key text
) RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  c_op        constant text := 'shareholder_profit.salary_freeze.v1';
  v_actor     uuid := auth.uid();
  v_key       text;
  v_org       uuid;
  v_sh        uuid;
  v_sm_id     uuid;
  v_sm_status text;
  v_scope     text;
  v_hash      text;
  v_op_hash   text;
  v_op_done   timestamptz;
  v_op_resp   jsonb;
  v_inv       jsonb;
  v_y         numeric;
  v_caps      jsonb;
  v_settled   boolean;
  v_applied   numeric;
  v_paid_y    numeric;
  v_d         numeric;
  v_old       uuid;
  v_new       uuid;
  v_bal       numeric;
  v_snap_a    jsonb;
  v_snap_o    jsonb;
  v_resp      jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'SALARY_PROFIT_DENIED: chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  v_key := app_private.profit_ledger_luong_khoa_v1(p_idempotency_key, 'Khoá idempotency');
  -- Thực nhận dự kiến là BẮT BUỘC: không có nó thì bản đóng băng không đối chiếu được với bảng đã chốt.
  IF p_staff_id IS NULL OR p_period_month IS NULL OR EXTRACT(DAY FROM p_period_month) <> 1
     OR NOT app_private.profit_ledger_luong_so_v1(p_expected_investment)
     OR (p_max_offset IS NOT NULL AND (NOT app_private.profit_ledger_luong_so_v1(p_max_offset) OR p_max_offset < 0))
     OR NOT app_private.profit_ledger_luong_so_v1(p_expected_take_home) THEN
    RAISE EXCEPTION 'SALARY_PROFIT_BAD_INPUT: thiếu nhân viên / kỳ (ngày đầu tháng) / số đầu tư dự kiến / thực nhận dự kiến, hoặc trần trừ tạm ứng âm'
      USING ERRCODE = '22023';
  END IF;

  v_org := app_private.salary_staff_org_v1(p_staff_id);
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'SALARY_PROFIT_DENIED: không xác định được công ty của nhân viên' USING ERRCODE = '42501';
  END IF;
  -- Kiểm quyền (không khoá) TRƯỚC khi giữ khoá tổ chức: người ngoài không giữ được khoá của công ty khác.
  IF NOT public.salary_is_admin_v1(v_org) THEN
    RAISE EXCEPTION 'SALARY_PROFIT_DENIED: không có quyền chốt lương của công ty này' USING ERRCODE = '42501';
  END IF;
  IF app_private.lock_org_for_decision_v1(v_org) IS NULL THEN
    RAISE EXCEPTION 'SALARY_PROFIT_DENIED: công ty không còn hoạt động' USING ERRCODE = '42501';
  END IF;
  -- Quyết định dưới khoá tổ chức: kiểm lại sau khi đã giữ khoá.
  IF NOT public.salary_is_admin_v1(v_org) THEN
    RAISE EXCEPTION 'SALARY_PROFIT_DENIED: không có quyền chốt lương của công ty này' USING ERRCODE = '42501';
  END IF;

  v_sh := app_private.profit_ledger_luong_co_dong_v1(v_org, p_staff_id);
  IF v_sh IS NULL THEN
    RETURN jsonb_build_object('shareholder_id', NULL, 'staff_id', p_staff_id, 'period_month', p_period_month,
                              'organization_id', v_org, 'settlement_id', NULL);
  END IF;

  SELECT sm.id, sm.status INTO v_sm_id, v_sm_status
    FROM public.salary_monthly sm
   WHERE sm.staff_id = p_staff_id
     AND sm.period_month = p_period_month
     AND (sm.organization_id IS NULL OR sm.organization_id = v_org)
   FOR UPDATE;

  v_scope := p_staff_id::text || '|' || p_period_month::text;
  v_hash := md5(jsonb_build_object(
    'staff', p_staff_id, 'period', p_period_month, 'org', v_org,
    'expected_investment', round(p_expected_investment, 2),
    'max_offset', round(p_max_offset, 2),
    'expected_take_home', round(p_expected_take_home, 2))::text);
  SELECT o.payload_hash, o.completed_at, o.response_payload INTO v_op_hash, v_op_done, v_op_resp
    FROM app_private.canonical_write_operations o
   WHERE o.organization_id = v_org AND o.operation = c_op AND o.subject_scope = v_scope
     AND o.actor_id = v_actor AND o.idempotency_key = v_key
   FOR UPDATE;
  IF FOUND THEN
    IF v_op_hash IS DISTINCT FROM v_hash THEN
      RAISE EXCEPTION 'SALARY_PROFIT_IDEMPOTENCY_CONFLICT: khoá idempotency đã dùng với nội dung khác'
        USING ERRCODE = '23505';
    END IF;
    IF v_op_done IS NOT NULL THEN
      RETURN v_op_resp;
    END IF;
    RAISE EXCEPTION 'SALARY_PROFIT_OPERATION_PENDING: lệnh cùng khoá đang dở' USING ERRCODE = '55000';
  END IF;

  PERFORM app_private.profit_ledger_lock_v1(v_org, 'SHAREHOLDER', v_sh);
  v_caps := app_private.salary_profit_month_caps_v1(v_org, v_sh, p_staff_id, p_period_month);

  IF v_sm_status = 'LOCKED' THEN
    RETURN jsonb_build_object(
      'already_locked', true,
      'settlement_id', v_caps->'settlement_id',
      'shareholder_id', v_sh,
      'staff_id', p_staff_id,
      'period_month', p_period_month,
      'organization_id', v_org,
      'investment_month', v_caps->'investment_month',
      'advance_offset_month', v_caps->'advance_offset_month',
      'paid_investment', v_caps->'paid_investment',
      'paid_offset', v_caps->'paid_offset',
      'unpaid_investment', v_caps->'remaining_investment',
      'offset_conflict', v_caps->'offset_conflict',
      'settled_by_marker', v_caps->'settled_by_marker');
  END IF;

  v_inv := app_private.salary_investment_profit_v1(v_org, p_staff_id, p_period_month);
  v_y := (v_inv->>'investment_live')::numeric;
  IF round(p_expected_investment, 2) IS DISTINCT FROM round(v_y, 2) THEN
    RAISE EXCEPTION 'SALARY_PROFIT_QUOTE_CHANGED: phần lợi nhuận đầu tư trong lương đã đổi, tải lại bảng lương rồi chốt lại'
      USING ERRCODE = 'PT409',
            DETAIL = jsonb_build_object('server_investment', v_y,
                                        'expected_investment', round(p_expected_investment, 2))::text;
  END IF;

  INSERT INTO app_private.canonical_write_operations
    (organization_id, operation, subject_scope, actor_id, idempotency_key, payload_hash)
  VALUES (v_org, c_op, v_scope, v_actor, v_key, v_hash);

  v_settled := (v_caps->>'settled_by_marker')::boolean;
  v_applied := (v_caps->>'paid_offset')::numeric;
  v_paid_y := (v_caps->>'paid_investment')::numeric;
  IF v_settled THEN
    v_d := 0;
  ELSE
    v_d := least((v_caps->>'advance_offset_month')::numeric,
                 COALESCE(round(p_max_offset, 2), (v_caps->>'advance_offset_month')::numeric));
    v_d := greatest(v_d, v_applied);
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'allocation_id', a.id,
           'profit_monthly_id', pm.id,
           'building_id', pm.building_id,
           'label', COALESCE(NULLIF(b.code, ''), NULLIF(b.name, ''), '—'),
           'amount', a.amount,
           'is_stale', pm.is_stale,
           'locked_at', pm.locked_at) ORDER BY pm.building_id, a.id), '[]'::jsonb)
    INTO v_snap_a
    FROM public.profit_allocations a
    JOIN public.profit_monthly pm ON pm.id = a.profit_monthly_id
    LEFT JOIN public.buildings b ON b.id = pm.building_id
   WHERE a.shareholder_id = v_sh
     AND pm.organization_id = v_org
     AND pm.period_month = p_period_month
     AND pm.status = 'LOCKED';
  SELECT COALESCE(jsonb_agg(e.value), '[]'::jsonb) INTO v_snap_o
    FROM jsonb_array_elements(v_inv->'by_building') e
   WHERE e.value->'override_amount' <> 'null'::jsonb;

  UPDATE app_private.profit_ledger_salary_settlements
     SET state = 'VOID', voided_at = clock_timestamp(), void_reason = 'Đóng băng lại trước khi chốt lương'
   WHERE organization_id = v_org AND shareholder_id = v_sh AND period_month = p_period_month AND state = 'FROZEN'
  RETURNING id INTO v_old;

  v_bal := (app_private.profit_ledger_balance_v1(v_org, 'SHAREHOLDER', v_sh)->>'balance')::numeric;
  INSERT INTO app_private.profit_ledger_salary_settlements (organization_id, shareholder_id, staff_id, period_month,
    salary_monthly_id, investment_month, advance_offset_month, expected_take_home, allocation_snapshot,
    override_snapshot, ledger_balance_at_freeze, created_by)
  VALUES (v_org, v_sh, p_staff_id, p_period_month, v_sm_id, round(v_y, 2), v_d, round(p_expected_take_home, 2),
    v_snap_a, v_snap_o, v_bal, v_actor)
  RETURNING id INTO v_new;

  INSERT INTO app_private.profit_ledger_events (organization_id, event_kind, subject_kind, shareholder_id,
    settlement_id, amount, balance_before, balance_after, actor_id, payload)
  VALUES (v_org, 'SALARY_FROZEN', 'SHAREHOLDER', v_sh, v_new, round(v_y, 2), v_bal, v_bal, v_actor,
    jsonb_build_object('period_month', p_period_month, 'staff_id', p_staff_id,
                       'advance_offset_month', v_d, 'applied_offset', v_applied,
                       'max_offset', round(p_max_offset, 2), 'expected_take_home', round(p_expected_take_home, 2),
                       'voided_settlement_id', v_old, 'settled_by_marker', v_settled));

  v_resp := jsonb_build_object(
    'already_locked', false,
    'settlement_id', v_new,
    'shareholder_id', v_sh,
    'staff_id', p_staff_id,
    'period_month', p_period_month,
    'organization_id', v_org,
    'investment_month', round(v_y, 2),
    'advance_offset_month', v_d,
    'paid_investment', v_paid_y,
    'paid_offset', v_applied,
    'unpaid_investment', (v_caps->>'investment_cap')::numeric - v_paid_y,
    'settled_by_marker', v_settled,
    'voided_settlement_id', v_old);
  UPDATE app_private.canonical_write_operations
     SET subject_id = v_new, response_payload = v_resp, completed_at = now()
   WHERE organization_id = v_org AND operation = c_op AND subject_scope = v_scope
     AND actor_id = v_actor AND idempotency_key = v_key;
  RETURN v_resp;
END
$fn$;

-- ── 7. E14 — mở khoá tháng lợi nhuận sẽ ảnh hưởng gì (không khoá dòng) ───────
-- ledger_effects: cổ đông có phân bổ đã chốt trong đúng kỳ / toà bị mở khoá.
--   balance_now = số dư sổ tổng hiện tại (lõi M1); allocations_removed = Σ phân bổ đó, CHỈ khi kỳ
--   > mốc hiệu lực (kỳ ≤ mốc thì mở khoá không làm số dư đổi ⇒ 0); balance_after = balance_now −
--   allocations_removed. Đây là phép trừ trên kết quả của lõi, không phải công thức thứ hai.
-- paid_via_salary: phần đã trả qua lương (dòng LINKED còn sống) của các cổ đông đó trong kỳ, kèm cờ
--   offset_conflict (phần trừ tạm ứng đã ghi vượt D_m của bảng lương kỳ đó — xem salary_profit_month_caps_v1).
CREATE OR REPLACE FUNCTION public.profit_unlock_salary_impact_v1(
  p_organization_id uuid,
  p_period_month date,
  p_building_ids uuid[] DEFAULT NULL
) RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_uid     uuid := auth.uid();
  v_r       record;
  v_bal     jsonb;
  v_now     numeric;
  v_marker  date;
  v_removed numeric;
  v_effects jsonb := '[]'::jsonb;
  v_paid    jsonb := '[]'::jsonb;
  v_lines   jsonb;
  v_caps    jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'SALARY_PROFIT_DENIED: chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF p_organization_id IS NULL OR p_period_month IS NULL OR EXTRACT(DAY FROM p_period_month) <> 1
     OR array_position(p_building_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'SALARY_PROFIT_BAD_INPUT: thiếu công ty / kỳ (ngày đầu tháng), hoặc danh sách toà có giá trị rỗng'
      USING ERRCODE = '22023';
  END IF;
  IF NOT (app_private.profit_viewer_can_v1(p_organization_id, 'shareholder_profit.lock')
          OR app_private.profit_viewer_can_v1(p_organization_id, 'shareholder_profit.unlock')) THEN
    RAISE EXCEPTION 'SALARY_PROFIT_DENIED: không có quyền chốt / mở chốt lợi nhuận của công ty này' USING ERRCODE = '42501';
  END IF;

  FOR v_r IN
    SELECT s.id AS shareholder_id, s.name, s.auth_user_id, s.deleted_at, sum(a.amount) AS allocated
      FROM public.profit_allocations a
      JOIN public.profit_monthly pm ON pm.id = a.profit_monthly_id
      JOIN public.shareholders s ON s.id = a.shareholder_id AND s.organization_id = p_organization_id
     WHERE pm.organization_id = p_organization_id
       AND pm.period_month = p_period_month
       AND pm.status = 'LOCKED'
       AND (p_building_ids IS NULL OR pm.building_id = ANY (p_building_ids))
     GROUP BY s.id, s.name, s.auth_user_id, s.deleted_at
     ORDER BY s.name, s.id
  LOOP
    v_bal := app_private.profit_ledger_balance_v1(p_organization_id, 'SHAREHOLDER', v_r.shareholder_id);
    v_now := (v_bal->>'balance')::numeric;
    v_marker := (v_bal->'marker'->>'settled_through_month')::date;
    v_removed := CASE WHEN v_marker IS NOT NULL AND p_period_month <= v_marker THEN 0 ELSE v_r.allocated END;
    v_effects := v_effects || jsonb_build_array(jsonb_build_object(
      'shareholder_id', v_r.shareholder_id,
      'name', v_r.name,
      'staff_id', v_r.auth_user_id,
      'balance_now', v_now,
      'allocations_in_scope', v_r.allocated,
      'allocations_removed', v_removed,
      'balance_after', v_now - v_removed,
      'becomes_advance', v_now >= 0 AND v_now - v_removed < 0,
      'advance_after', v_now - v_removed < 0,
      'settled_by_marker', v_marker IS NOT NULL AND p_period_month <= v_marker));

    SELECT jsonb_build_object(
             'shareholder_id', v_r.shareholder_id,
             'name', v_r.name,
             'staff_id', v_r.auth_user_id,
             'investment', COALESCE(sum(l.investment_amount), 0),
             'advance_offset', COALESCE(sum(l.advance_offset_amount), 0),
             'salary_voucher_ids', COALESCE(jsonb_agg(l.salary_voucher_id ORDER BY l.created_at, l.id), '[]'::jsonb),
             'salary_voucher_codes', COALESCE(jsonb_agg(ie.code ORDER BY l.created_at, l.id), '[]'::jsonb),
             'voucher_states', COALESCE(jsonb_agg(jsonb_build_object(
                                'salary_voucher_id', l.salary_voucher_id,
                                'approval_status', ie.approval_status,
                                'posting_status', ie.posting_status) ORDER BY l.created_at, l.id), '[]'::jsonb),
             'needs_review_count', (
               SELECT count(*) FROM app_private.profit_ledger_salary_settlement_vouchers n
                WHERE n.organization_id = p_organization_id AND n.shareholder_id = v_r.shareholder_id
                  AND n.period_month = p_period_month AND n.state = 'NEEDS_REVIEW'
                  AND app_private.profit_ledger_voucher_live_v1(n.salary_voucher_id)),
             'line_count', count(l.id))
      INTO v_lines
      FROM app_private.profit_ledger_salary_settlement_vouchers l
      JOIN public.income_expenses ie ON ie.id = l.salary_voucher_id
     WHERE l.organization_id = p_organization_id
       AND l.shareholder_id = v_r.shareholder_id
       AND l.period_month = p_period_month
       AND l.state = 'LINKED'
       AND app_private.profit_ledger_voucher_live_v1(l.salary_voucher_id);
    IF (v_lines->>'line_count')::int > 0 OR (v_lines->>'needs_review_count')::int > 0 THEN
      -- Trần của tháng chỉ tính được cho cổ đông còn hiệu lực có đăng nhập (= nhân viên hưởng lương).
      v_caps := CASE WHEN v_r.deleted_at IS NULL AND v_r.auth_user_id IS NOT NULL
                     THEN app_private.salary_profit_month_caps_v1(p_organization_id, v_r.shareholder_id, v_r.auth_user_id, p_period_month)
                END;
      v_paid := v_paid || jsonb_build_array((v_lines - 'line_count') || jsonb_build_object(
        'offset_conflict', v_caps->'offset_conflict',
        'paid_offset', v_caps->'paid_offset',
        'advance_offset_month', v_caps->'advance_offset_month',
        'sheet_status', v_caps->'sheet_status'));
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'organization_id', p_organization_id,
    'period_month', p_period_month,
    'building_ids', to_jsonb(p_building_ids),
    'paid_via_salary', v_paid,
    'ledger_effects', v_effects);
END
$fn$;

-- ── 8. E15 — báo giá phần lợi nhuận trong phiếu lương sắp lập ────────────────
-- Gọi NGAY TRƯỚC salary_payout_v1 với đúng p_payout_idempotency_key sẽ gửi cho salary_payout_v1.
-- p_investment_selected / p_offset_selected là số LUỸ KẾ của tháng tính tới hết phiếu này (giống cách
-- bảng lương trừ "đã trả"): Y_i = kẹp(selected − ΣY_i trước, Y_cap − ΣY_i trước) cùng dấu,
-- D_i = kẹp(offset − ΣD_i trước, D_m − ΣD_i trước); Y_i − D_i không vượt số tiền phiếu cam kết.
-- Huỷ mọi báo giá QUOTED cũ của cùng nhân viên/kỳ (của MỌI người gọi) rồi tạo báo giá mới.
-- needs_review_reason (OFFSET_CONFLICT / MIXED_SIGN_SELECTION) báo trước phiếu sẽ thành NEEDS_REVIEW.
CREATE OR REPLACE FUNCTION public.salary_profit_payout_quote_v1(
  p_staff_id uuid,
  p_period_month date,
  p_investment_selected numeric,
  p_offset_selected numeric,
  p_expected_voucher_amount numeric,
  p_payout_idempotency_key text,
  p_idempotency_key text
) RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  c_op         constant text := 'shareholder_profit.salary_quote.v1';
  v_actor      uuid := auth.uid();
  v_key        text;
  v_payout_key text;
  v_org        uuid;
  v_sh         uuid;
  v_sm_id      uuid;
  v_scope      text;
  v_hash       text;
  v_op_hash    text;
  v_op_done    timestamptz;
  v_op_resp    jsonb;
  v_caps       jsonb;
  v_settled    boolean;
  v_sel        numeric := round(p_investment_selected, 2);
  v_off        numeric := round(p_offset_selected, 2);
  v_amount     numeric := round(p_expected_voucher_amount, 2);
  v_ym         numeric;
  v_dm         numeric;
  v_paid_y     numeric;
  v_paid_d     numeric;
  v_y          numeric;
  v_d          numeric;
  v_voided     jsonb;
  v_quote      uuid;
  v_created    timestamptz;
  v_resp       jsonb;
  v_r          numeric;
  v_review     text;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'SALARY_PROFIT_DENIED: chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  v_key := app_private.profit_ledger_luong_khoa_v1(p_idempotency_key, 'Khoá idempotency');
  v_payout_key := app_private.profit_ledger_luong_khoa_v1(p_payout_idempotency_key, 'Khoá của lệnh trả lương');
  IF p_staff_id IS NULL OR p_period_month IS NULL OR EXTRACT(DAY FROM p_period_month) <> 1
     OR NOT app_private.profit_ledger_luong_so_v1(p_investment_selected)
     OR NOT app_private.profit_ledger_luong_so_v1(p_offset_selected) OR p_offset_selected < 0
     OR NOT app_private.profit_ledger_luong_so_v1(p_expected_voucher_amount) OR v_amount <= 0 THEN
    RAISE EXCEPTION 'SALARY_PROFIT_BAD_INPUT: thiếu nhân viên / kỳ (ngày đầu tháng) / số đầu tư chọn, trừ tạm ứng âm, hoặc số tiền phiếu không dương'
      USING ERRCODE = '22023';
  END IF;

  v_org := app_private.salary_staff_org_v1(p_staff_id);
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'SALARY_PROFIT_DENIED: không xác định được công ty của nhân viên' USING ERRCODE = '42501';
  END IF;
  -- Kiểm quyền (không khoá) TRƯỚC khi giữ khoá tổ chức: người ngoài không giữ được khoá của công ty khác.
  IF NOT public.salary_is_admin_v1(v_org) THEN
    RAISE EXCEPTION 'SALARY_PROFIT_DENIED: không có quyền trả lương của công ty này' USING ERRCODE = '42501';
  END IF;
  IF app_private.lock_org_for_decision_v1(v_org) IS NULL THEN
    RAISE EXCEPTION 'SALARY_PROFIT_DENIED: công ty không còn hoạt động' USING ERRCODE = '42501';
  END IF;
  -- Quyết định dưới khoá tổ chức: kiểm lại sau khi đã giữ khoá.
  IF NOT public.salary_is_admin_v1(v_org) THEN
    RAISE EXCEPTION 'SALARY_PROFIT_DENIED: không có quyền trả lương của công ty này' USING ERRCODE = '42501';
  END IF;

  v_sh := app_private.profit_ledger_luong_co_dong_v1(v_org, p_staff_id);
  IF v_sh IS NULL THEN
    RETURN jsonb_build_object('quote_id', NULL, 'shareholder_id', NULL, 'staff_id', p_staff_id,
                              'period_month', p_period_month, 'organization_id', v_org);
  END IF;

  SELECT sm.id INTO v_sm_id
    FROM public.salary_monthly sm
   WHERE sm.staff_id = p_staff_id
     AND sm.period_month = p_period_month
     AND (sm.organization_id IS NULL OR sm.organization_id = v_org)
   FOR UPDATE;

  v_scope := p_staff_id::text || '|' || p_period_month::text;
  v_hash := md5(jsonb_build_object(
    'staff', p_staff_id, 'period', p_period_month, 'org', v_org,
    'investment_selected', v_sel, 'offset_selected', v_off,
    'expected_voucher_amount', v_amount, 'payout_key', v_payout_key)::text);
  SELECT o.payload_hash, o.completed_at, o.response_payload INTO v_op_hash, v_op_done, v_op_resp
    FROM app_private.canonical_write_operations o
   WHERE o.organization_id = v_org AND o.operation = c_op AND o.subject_scope = v_scope
     AND o.actor_id = v_actor AND o.idempotency_key = v_key
   FOR UPDATE;
  IF FOUND THEN
    IF v_op_hash IS DISTINCT FROM v_hash THEN
      RAISE EXCEPTION 'SALARY_PROFIT_IDEMPOTENCY_CONFLICT: khoá idempotency đã dùng với nội dung khác'
        USING ERRCODE = '23505';
    END IF;
    IF v_op_done IS NOT NULL THEN
      RETURN v_op_resp;
    END IF;
    RAISE EXCEPTION 'SALARY_PROFIT_OPERATION_PENDING: lệnh cùng khoá đang dở' USING ERRCODE = '55000';
  END IF;
  INSERT INTO app_private.canonical_write_operations
    (organization_id, operation, subject_scope, actor_id, idempotency_key, payload_hash)
  VALUES (v_org, c_op, v_scope, v_actor, v_key, v_hash);

  PERFORM app_private.profit_ledger_lock_v1(v_org, 'SHAREHOLDER', v_sh);
  v_caps := app_private.salary_profit_month_caps_v1(v_org, v_sh, p_staff_id, p_period_month);
  v_settled := (v_caps->>'settled_by_marker')::boolean;
  v_ym := (v_caps->>'investment_month')::numeric;
  v_dm := (v_caps->>'advance_offset_month')::numeric;
  v_paid_y := (v_caps->>'paid_investment')::numeric;
  v_paid_d := (v_caps->>'paid_offset')::numeric;

  IF v_settled AND v_sel > 0 THEN
    RAISE EXCEPTION 'SALARY_PROFIT_SETTLED_BY_MARKER: kỳ lương nằm trong mốc "đã trả đủ", không trả lại phần đầu tư qua lương'
      USING ERRCODE = '22023', DETAIL = jsonb_build_object('marker_through', v_caps->'marker_through')::text;
  END IF;
  IF v_sel > v_ym OR v_off > v_dm THEN
    RAISE EXCEPTION 'SALARY_PROFIT_QUOTE_CHANGED: phần lợi nhuận / trừ tạm ứng của tháng đã đổi, tải lại bảng lương'
      USING ERRCODE = 'PT409',
            DETAIL = jsonb_build_object('investment_month', v_ym, 'advance_offset_month', v_dm,
                                        'investment_selected', v_sel, 'offset_selected', v_off,
                                        'paid_offset', v_paid_d, 'offset_conflict', v_caps->'offset_conflict')::text;
  END IF;

  v_r := (v_caps->>'investment_cap')::numeric - v_paid_y;
  v_y := app_private.profit_ledger_luong_kep_v1(v_sel - v_paid_y, v_r);
  v_d := least(greatest(v_off - v_paid_d, 0), greatest(v_dm - v_paid_d, 0));
  IF v_y > 0 AND v_y - v_d > v_amount THEN
    v_y := v_d + v_amount;
  END IF;
  -- Báo trước cho client: phiếu này sẽ thành "cần xem lại" lúc lập (F3 quyết định lại với số lúc đó).
  v_review := CASE
    WHEN COALESCE((v_caps->>'offset_conflict')::boolean, false) THEN 'OFFSET_CONFLICT'
    WHEN NOT v_settled AND v_sel - v_paid_y <> 0 AND sign(v_sel - v_paid_y) <> sign(v_r) THEN 'MIXED_SIGN_SELECTION'
  END;

  WITH huy AS (
    UPDATE app_private.profit_ledger_salary_settlement_vouchers
       SET state = 'VOID', voided_at = clock_timestamp(), void_reason = 'Bị báo giá mới thay'
     WHERE organization_id = v_org AND staff_id = p_staff_id AND period_month = p_period_month AND state = 'QUOTED'
    RETURNING id, shareholder_id, investment_amount
  ), ghi AS (
    INSERT INTO app_private.profit_ledger_events (organization_id, event_kind, subject_kind, shareholder_id, line_id,
      amount, actor_id, reason, payload)
    SELECT v_org, 'SALARY_VOIDED', 'SHAREHOLDER', h.shareholder_id, h.id, h.investment_amount, v_actor,
           'Bị báo giá mới thay', jsonb_build_object('period_month', p_period_month)
      FROM huy h
    RETURNING line_id
  )
  SELECT COALESCE(jsonb_agg(g.line_id), '[]'::jsonb) INTO v_voided FROM ghi g;

  INSERT INTO app_private.profit_ledger_salary_settlement_vouchers (organization_id, shareholder_id, staff_id,
    period_month, settlement_id, payout_request_key, investment_selected, investment_amount, advance_offset_amount,
    expected_voucher_amount, sheet_status_at_quote, source, state, created_by)
  VALUES (v_org, v_sh, p_staff_id, p_period_month, (v_caps->>'settlement_id')::uuid, v_payout_key, v_sel, v_y, v_d,
    v_amount, v_caps->>'sheet_status', 'UI_QUOTE', 'QUOTED', v_actor)
  RETURNING id, created_at INTO v_quote, v_created;

  INSERT INTO app_private.profit_ledger_events (organization_id, event_kind, subject_kind, shareholder_id,
    settlement_id, line_id, amount, actor_id, payload)
  VALUES (v_org, 'SALARY_QUOTED', 'SHAREHOLDER', v_sh, (v_caps->>'settlement_id')::uuid, v_quote, v_y, v_actor,
    jsonb_build_object('period_month', p_period_month, 'staff_id', p_staff_id,
                       'investment_selected', v_sel, 'offset_selected', v_off,
                       'advance_offset_amount', v_d, 'expected_voucher_amount', v_amount,
                       'payout_request_key', v_payout_key, 'voided_quote_ids', v_voided,
                       'sheet_status', v_caps->>'sheet_status'));

  v_resp := jsonb_build_object(
    'quote_id', v_quote,
    'shareholder_id', v_sh,
    'staff_id', p_staff_id,
    'period_month', p_period_month,
    'organization_id', v_org,
    'investment_amount', v_y,
    'advance_offset_amount', v_d,
    'investment_month', v_ym,
    'advance_offset_month', v_dm,
    'paid_investment', v_paid_y,
    'paid_offset', v_paid_d,
    'settled_by_marker', v_settled,
    'sheet_status', v_caps->>'sheet_status',
    'expected_voucher_amount', v_amount,
    'payout_request_key', v_payout_key,
    'expires_at', v_created + interval '30 minutes',
    'voided_quote_ids', v_voided,
    'offset_conflict', v_caps->'offset_conflict',
    'needs_review_reason', v_review);
  UPDATE app_private.canonical_write_operations
     SET subject_id = v_quote, response_payload = v_resp, completed_at = now()
   WHERE organization_id = v_org AND operation = c_op AND subject_scope = v_scope
     AND actor_id = v_actor AND idempotency_key = v_key;
  RETURN v_resp;
END
$fn$;

-- ── 9. E16 — chủ xác nhận dòng phiếu lương "cần xem lại" ─────────────────────
-- Quyền shareholder_profit.distribute; người nhận lương / cổ đông của dòng không tự xác nhận;
-- công tắc sổ tổng ở SHADOW hoặc CANONICAL.
-- Y trong đoạn giữa 0 và (Y_cap − ΣY_i khác) cùng dấu; 0 ≤ D ≤ (D_m − ΣD_i khác); Y − D ≤ tiền phiếu.
CREATE OR REPLACE FUNCTION public.profit_ledger_salary_resolve_v1(
  p_line_id uuid,
  p_investment_amount numeric,
  p_advance_offset_amount numeric,
  p_reason text,
  p_idempotency_key text
) RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  c_op       constant text := 'shareholder_profit.salary_resolve.v1';
  c_flag     constant text := 'shareholder_profit.ledger_payout.v1';
  v_actor    uuid := auth.uid();
  v_key      text;
  v_reason   text := btrim(COALESCE(p_reason, ''));
  v_y        numeric := round(p_investment_amount, 2);
  v_d        numeric := round(p_advance_offset_amount, 2);
  v_org      uuid;
  v_sh       uuid;
  v_staff    uuid;
  v_period   date;
  v_voucher  uuid;
  v_state    text;
  v_l_settle uuid;
  v_allowed  boolean;
  v_route    text;
  v_scope    text;
  v_hash     text;
  v_op_hash  text;
  v_op_done  timestamptz;
  v_op_resp  jsonb;
  v_total    numeric;
  v_caps     jsonb;
  v_r        numeric;
  v_dmax     numeric;
  v_before   numeric;
  v_after    numeric;
  v_resp     jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'SALARY_PROFIT_DENIED: chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  v_key := app_private.profit_ledger_luong_khoa_v1(p_idempotency_key, 'Khoá idempotency');
  IF p_line_id IS NULL
     OR NOT app_private.profit_ledger_luong_so_v1(p_investment_amount)
     OR NOT app_private.profit_ledger_luong_so_v1(p_advance_offset_amount) THEN
    RAISE EXCEPTION 'SALARY_PROFIT_BAD_INPUT: thiếu dòng phiếu lương hoặc số tiền' USING ERRCODE = '22023';
  END IF;
  IF char_length(v_reason) NOT BETWEEN 8 AND 1000 THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_REASON: lý do phải dài 8–1000 ký tự' USING ERRCODE = '22023';
  END IF;

  SELECT l.organization_id, l.staff_id INTO v_org, v_staff
    FROM app_private.profit_ledger_salary_settlement_vouchers l
   WHERE l.id = p_line_id;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_SALARY_LINE_NOT_FOUND: không tìm thấy dòng phiếu lương' USING ERRCODE = 'P0002';
  END IF;
  -- Người nhận lương / cổ đông của dòng không tự xác nhận số của chính mình.
  IF v_actor = v_staff OR EXISTS (
       SELECT 1 FROM public.shareholders s
        JOIN app_private.profit_ledger_salary_settlement_vouchers l ON l.shareholder_id = s.id
       WHERE l.id = p_line_id AND s.auth_user_id = v_actor) THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_SALARY_SELF_RESOLVE: không tự xác nhận dòng lương của chính mình' USING ERRCODE = '42501';
  END IF;
  -- Người ngoài công ty bị chặn (đọc không khoá) TRƯỚC khi giữ khoá tổ chức.
  IF NOT COALESCE(v_org = ANY (public.my_org_ids()), false) THEN
    RAISE EXCEPTION 'SALARY_PROFIT_DENIED: không phải thành viên công ty của dòng phiếu lương' USING ERRCODE = '42501';
  END IF;
  IF app_private.lock_org_for_decision_v1(v_org) IS NULL THEN
    RAISE EXCEPTION 'SALARY_PROFIT_DENIED: công ty không còn hoạt động' USING ERRCODE = '42501';
  END IF;
  SELECT a.allowed INTO v_allowed
    FROM app_private.authorize_tenant_action_v3(v_actor, v_org, 'shareholder_profit.distribute', NULL, NULL) a;
  IF NOT COALESCE(v_allowed, false) THEN
    RAISE EXCEPTION 'SALARY_PROFIT_DENIED: không có quyền chia lợi nhuận cổ đông (shareholder_profit.distribute)'
      USING ERRCODE = '42501';
  END IF;
  v_route := app_private.evaluate_feature_route(c_flag, v_org);
  IF v_route = 'FROZEN' THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_FROZEN: sổ tổng lợi nhuận đang đóng băng' USING ERRCODE = '55000';
  ELSIF v_route IS DISTINCT FROM 'SHADOW' AND v_route IS DISTINCT FROM 'CANONICAL' THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_ROUTE_OFF: sổ tổng lợi nhuận chưa bật cho công ty này' USING ERRCODE = '55000';
  END IF;

  v_scope := 'LINE:' || p_line_id::text;
  v_hash := md5(jsonb_build_object('line', p_line_id, 'investment', v_y, 'offset', v_d, 'reason', v_reason)::text);
  SELECT o.payload_hash, o.completed_at, o.response_payload INTO v_op_hash, v_op_done, v_op_resp
    FROM app_private.canonical_write_operations o
   WHERE o.organization_id = v_org AND o.operation = c_op AND o.subject_scope = v_scope
     AND o.actor_id = v_actor AND o.idempotency_key = v_key
   FOR UPDATE;
  IF FOUND THEN
    IF v_op_hash IS DISTINCT FROM v_hash THEN
      RAISE EXCEPTION 'SALARY_PROFIT_IDEMPOTENCY_CONFLICT: khoá idempotency đã dùng với nội dung khác'
        USING ERRCODE = '23505';
    END IF;
    IF v_op_done IS NOT NULL THEN
      RETURN v_op_resp;
    END IF;
    RAISE EXCEPTION 'SALARY_PROFIT_OPERATION_PENDING: lệnh cùng khoá đang dở' USING ERRCODE = '55000';
  END IF;
  INSERT INTO app_private.canonical_write_operations
    (organization_id, operation, subject_scope, actor_id, idempotency_key, payload_hash)
  VALUES (v_org, c_op, v_scope, v_actor, v_key, v_hash);
  IF v_route = 'CANONICAL' THEN
    PERFORM app_private.claim_feature_operation_v1(c_flag, v_org, v_scope, v_actor, v_key, 0);
  END IF;

  SELECT l.shareholder_id INTO v_sh
    FROM app_private.profit_ledger_salary_settlement_vouchers l
   WHERE l.id = p_line_id;
  PERFORM app_private.profit_ledger_lock_v1(v_org, 'SHAREHOLDER', v_sh);
  SELECT l.staff_id, l.period_month, l.salary_voucher_id, l.state, l.settlement_id
    INTO v_staff, v_period, v_voucher, v_state, v_l_settle
    FROM app_private.profit_ledger_salary_settlement_vouchers l
   WHERE l.id = p_line_id
   FOR UPDATE;
  IF v_state IS DISTINCT FROM 'NEEDS_REVIEW' THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_SALARY_LINE_STATE: dòng phiếu lương không ở trạng thái cần xem lại'
      USING ERRCODE = '55000', DETAIL = jsonb_build_object('state', v_state)::text;
  END IF;
  IF NOT app_private.profit_ledger_voucher_live_v1(v_voucher) THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_SALARY_VOUCHER_DEAD: phiếu lương đã huỷ / bị từ chối' USING ERRCODE = '55000';
  END IF;
  SELECT ie.total_amount INTO v_total FROM public.income_expenses ie WHERE ie.id = v_voucher;

  v_caps := app_private.salary_profit_month_caps_v1(v_org, v_sh, v_staff, v_period);
  v_r := (v_caps->>'investment_cap')::numeric - (v_caps->>'paid_investment')::numeric;
  v_dmax := greatest((v_caps->>'advance_offset_month')::numeric - (v_caps->>'paid_offset')::numeric, 0);
  IF NOT (CASE WHEN v_r >= 0 THEN v_y BETWEEN 0 AND v_r ELSE v_y BETWEEN v_r AND 0 END)
     OR v_d < 0 OR v_d > v_dmax OR v_y - v_d > v_total THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_SALARY_RESOLVE_RANGE: số xác nhận nằm ngoài phần còn lại của tháng hoặc vượt tiền phiếu'
      USING ERRCODE = '22023',
            DETAIL = jsonb_build_object('min_investment', least(v_r, 0), 'max_investment', greatest(v_r, 0),
                                        'max_offset', v_dmax, 'voucher_amount', v_total)::text;
  END IF;

  v_before := (app_private.profit_ledger_balance_v1(v_org, 'SHAREHOLDER', v_sh)->>'balance')::numeric;
  UPDATE app_private.profit_ledger_salary_settlement_vouchers
     SET state = 'LINKED',
         source = 'OWNER_RESOLVE',
         settlement_id = COALESCE(v_l_settle, (v_caps->>'settlement_id')::uuid),
         investment_amount = v_y,
         advance_offset_amount = v_d,
         linked_at = clock_timestamp(),
         resolved_by = v_actor,
         resolved_at = clock_timestamp(),
         resolve_reason = v_reason
   WHERE id = p_line_id;
  v_after := (app_private.profit_ledger_balance_v1(v_org, 'SHAREHOLDER', v_sh)->>'balance')::numeric;

  INSERT INTO app_private.profit_ledger_events (organization_id, event_kind, subject_kind, shareholder_id,
    voucher_id, settlement_id, line_id, amount, balance_before, balance_after, actor_id, reason, payload)
  VALUES (v_org, 'SALARY_RESOLVED', 'SHAREHOLDER', v_sh, v_voucher,
    COALESCE(v_l_settle, (v_caps->>'settlement_id')::uuid), p_line_id, v_y, v_before, v_after, v_actor, v_reason,
    jsonb_build_object('period_month', v_period, 'advance_offset_amount', v_d, 'route', v_route));

  v_resp := jsonb_build_object(
    'line_id', p_line_id,
    'shareholder_id', v_sh,
    'salary_voucher_id', v_voucher,
    'period_month', v_period,
    'investment_amount', v_y,
    'advance_offset_amount', v_d,
    'balance_before', v_before,
    'balance_after', v_after);
  UPDATE app_private.canonical_write_operations
     SET subject_id = p_line_id, response_payload = v_resp, completed_at = now()
   WHERE organization_id = v_org AND operation = c_op AND subject_scope = v_scope
     AND actor_id = v_actor AND idempotency_key = v_key;
  RETURN v_resp;
END
$fn$;

-- ── 10. Ghi bù phiếu lương cũ (Đợt 3 gọi trong migration; không cấp quyền cho vai nào) ──
-- Phiếu phải là phiếu lương còn sống của nhân viên là cổ đông; kỳ lấy từ lệnh trả lương đã xong
-- (subject_id = phiếu), dòng bảng lương mang dấu phiếu, hoặc p_period_month — các nguồn có mặt phải
-- trùng nhau. Bảng LOCKED: số theo bảng đóng băng và tạo / thay bản đóng băng C3 khớp bảng. Số là
-- SỰ THẬT lịch sử nên không ép 0 cho kỳ ≤ mốc (sổ đã tự loại kỳ đó). Chạy lại cùng tham số ⇒ không
-- ghi gì, trả dòng đã có (lane dán file hai lượt).
CREATE OR REPLACE FUNCTION app_private.profit_ledger_luong_backfill_v1(
  p_salary_voucher_id uuid,
  p_investment numeric,
  p_advance_offset numeric,
  p_reason text,
  p_actor uuid,
  p_period_month date DEFAULT NULL
) RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_y          numeric := round(p_investment, 2);
  v_d          numeric := round(p_advance_offset, 2);
  v_reason     text := btrim(COALESCE(p_reason, ''));
  v_org        uuid;
  v_staff      uuid;
  v_role       text;
  v_type       text;
  v_total      numeric;
  v_sh         uuid;
  v_scope      text;
  v_ky         text;
  v_from_op    date;
  v_from_sheet date;
  v_period     date;
  v_n          integer;
  v_ex_id      uuid;
  v_ex_state   text;
  v_ex_source  text;
  v_ex_y       numeric;
  v_ex_d       numeric;
  v_ex_period  date;
  v_ex_settle  uuid;
  v_caps       jsonb;
  v_status     text;
  v_paid_y     numeric;
  v_paid_d     numeric;
  v_sm_id      uuid;
  v_sm_invest  numeric;
  v_sm_adv     numeric;
  v_sm_take    numeric;
  v_r          numeric;
  v_dmax       numeric;
  v_c3_id      uuid;
  v_c3_y       numeric;
  v_c3_d       numeric;
  v_c3_sm      uuid;
  v_settlement uuid;
  v_line       uuid;
  v_before     numeric;
  v_after      numeric;
BEGIN
  IF p_salary_voucher_id IS NULL OR p_actor IS NULL
     OR NOT app_private.profit_ledger_luong_so_v1(p_investment)
     OR NOT app_private.profit_ledger_luong_so_v1(p_advance_offset) OR v_d < 0
     OR (p_period_month IS NOT NULL AND EXTRACT(DAY FROM p_period_month) <> 1) THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_BACKFILL_INPUT: thiếu phiếu / người ghi / số tiền, trừ tạm ứng âm, hoặc kỳ không phải ngày đầu tháng'
      USING ERRCODE = '22023';
  END IF;
  IF char_length(v_reason) NOT BETWEEN 8 AND 1000 THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_REASON: lý do phải dài 8–1000 ký tự' USING ERRCODE = '22023';
  END IF;

  SELECT ie.organization_id, ie.salary_staff_id, ie.salary_role, ie.type, ie.total_amount
    INTO v_org, v_staff, v_role, v_type, v_total
    FROM public.income_expenses ie
   WHERE ie.id = p_salary_voucher_id;
  IF v_org IS NULL OR v_staff IS NULL OR v_role IS NOT DISTINCT FROM 'ADVANCE' OR v_type IS DISTINCT FROM 'EXPENSE'
     OR NOT app_private.profit_ledger_voucher_live_v1(p_salary_voucher_id) THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_BACKFILL_NOT_SALARY_VOUCHER: không phải phiếu lương còn sống'
      USING ERRCODE = '22023', DETAIL = jsonb_build_object('salary_voucher_id', p_salary_voucher_id)::text;
  END IF;
  v_sh := app_private.profit_ledger_luong_co_dong_v1(v_org, v_staff);
  IF v_sh IS NULL THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_BACKFILL_NOT_SHAREHOLDER: nhân viên nhận lương không là cổ đông của công ty'
      USING ERRCODE = '22023', DETAIL = jsonb_build_object('salary_voucher_id', p_salary_voucher_id)::text;
  END IF;

  SELECT o.subject_scope INTO v_scope
    FROM app_private.canonical_write_operations o
   WHERE o.organization_id = v_org AND o.operation = 'salary.payout.v1' AND o.subject_id = p_salary_voucher_id
     AND split_part(o.subject_scope, '|', 1) = v_staff::text
   ORDER BY o.completed_at DESC NULLS LAST
   LIMIT 1;
  v_ky := split_part(v_scope, '|', 2);
  IF v_scope IS NOT NULL AND v_ky ~ '^\d{4}-\d{2}-01$' THEN
    v_from_op := to_date(v_ky, 'YYYY-MM-DD');
  END IF;
  SELECT count(*), min(sm.period_month) INTO v_n, v_from_sheet
    FROM public.salary_monthly sm
   WHERE sm.payout_voucher_id = p_salary_voucher_id AND sm.staff_id = v_staff;
  IF v_n > 1 THEN
    v_from_sheet := NULL;
  END IF;
  IF (v_from_op IS NOT NULL AND v_from_sheet IS NOT NULL AND v_from_op <> v_from_sheet)
     OR (p_period_month IS NOT NULL AND COALESCE(v_from_op, v_from_sheet, p_period_month) <> p_period_month) THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_BACKFILL_PERIOD_CONFLICT: các nguồn kỳ lương của phiếu không trùng nhau'
      USING ERRCODE = '22023',
            DETAIL = jsonb_build_object('from_operation', v_from_op, 'from_sheet', v_from_sheet,
                                        'given', p_period_month)::text;
  END IF;
  v_period := COALESCE(v_from_op, v_from_sheet, p_period_month);
  IF v_period IS NULL THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_BACKFILL_PERIOD_UNKNOWN: không suy được kỳ lương của phiếu, truyền p_period_month'
      USING ERRCODE = '22023';
  END IF;

  IF app_private.lock_org_for_decision_v1(v_org) IS NULL THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_BACKFILL_ORG: công ty không còn hoạt động' USING ERRCODE = '55000';
  END IF;
  PERFORM app_private.profit_ledger_lock_v1(v_org, 'SHAREHOLDER', v_sh);

  SELECT l.id, l.state, l.source, l.investment_amount, l.advance_offset_amount, l.period_month, l.settlement_id
    INTO v_ex_id, v_ex_state, v_ex_source, v_ex_y, v_ex_d, v_ex_period, v_ex_settle
    FROM app_private.profit_ledger_salary_settlement_vouchers l
   WHERE l.salary_voucher_id = p_salary_voucher_id;
  IF v_ex_id IS NOT NULL THEN
    IF v_ex_source = 'BACKFILL' AND v_ex_state = 'LINKED' AND v_ex_y = v_y AND v_ex_d = v_d
       AND v_ex_period = v_period THEN
      RETURN jsonb_build_object('line_id', v_ex_id, 'settlement_id', v_ex_settle, 'shareholder_id', v_sh,
        'staff_id', v_staff, 'period_month', v_period, 'investment_amount', v_y, 'advance_offset_amount', v_d,
        'already', true);
    END IF;
    RAISE EXCEPTION 'PROFIT_LEDGER_BACKFILL_CONFLICT: phiếu lương đã có dòng sổ khác'
      USING ERRCODE = '55000',
            DETAIL = jsonb_build_object('line_id', v_ex_id, 'state', v_ex_state, 'source', v_ex_source)::text;
  END IF;

  v_caps := app_private.salary_profit_month_caps_v1(v_org, v_sh, v_staff, v_period);
  v_status := v_caps->>'sheet_status';
  v_paid_y := (v_caps->>'paid_investment')::numeric;
  v_paid_d := (v_caps->>'paid_offset')::numeric;
  IF v_status = 'LOCKED' THEN
    SELECT sm.id, sm.investment_profit, sm.advances_total, sm.take_home
      INTO v_sm_id, v_sm_invest, v_sm_adv, v_sm_take
      FROM public.salary_monthly sm
     WHERE sm.staff_id = v_staff AND sm.period_month = v_period
       AND (sm.organization_id IS NULL OR sm.organization_id = v_org);
    v_r := COALESCE(v_sm_invest, 0) - v_paid_y;
    v_dmax := greatest(least(COALESCE(v_sm_adv, 0), greatest(COALESCE(v_sm_invest, 0), 0)) - v_paid_d, 0);
  ELSE
    v_r := (v_caps->>'investment_month')::numeric - v_paid_y;
    v_dmax := greatest((v_caps->>'advance_offset_month')::numeric - v_paid_d, 0);
  END IF;
  IF NOT (CASE WHEN v_r >= 0 THEN v_y BETWEEN 0 AND v_r ELSE v_y BETWEEN v_r AND 0 END)
     OR v_d > v_dmax OR v_y - v_d > v_total THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_BACKFILL_RANGE: số ghi bù nằm ngoài phần còn lại của tháng hoặc vượt tiền phiếu'
      USING ERRCODE = '22023',
            DETAIL = jsonb_build_object('min_investment', least(v_r, 0), 'max_investment', greatest(v_r, 0),
                                        'max_offset', v_dmax, 'voucher_amount', v_total,
                                        'sheet_status', v_status)::text;
  END IF;

  v_before := (app_private.profit_ledger_balance_v1(v_org, 'SHAREHOLDER', v_sh)->>'balance')::numeric;
  IF v_status = 'LOCKED' THEN
    SELECT c.id, c.investment_month, c.advance_offset_month, c.salary_monthly_id
      INTO v_c3_id, v_c3_y, v_c3_d, v_c3_sm
      FROM app_private.profit_ledger_salary_settlements c
     WHERE c.organization_id = v_org AND c.shareholder_id = v_sh AND c.period_month = v_period AND c.state = 'FROZEN';
    IF v_c3_id IS NOT NULL AND v_c3_y = COALESCE(v_sm_invest, 0) AND v_c3_d = v_paid_d + v_d
       AND (v_c3_sm IS NULL OR v_c3_sm = v_sm_id) THEN
      v_settlement := v_c3_id;
    ELSE
      UPDATE app_private.profit_ledger_salary_settlements
         SET state = 'VOID', voided_at = clock_timestamp(), void_reason = 'Ghi bù phiếu lương: đóng băng lại theo bảng đã chốt'
       WHERE id = v_c3_id;
      INSERT INTO app_private.profit_ledger_salary_settlements (organization_id, shareholder_id, staff_id,
        period_month, salary_monthly_id, investment_month, advance_offset_month, expected_take_home,
        ledger_balance_at_freeze, created_by)
      VALUES (v_org, v_sh, v_staff, v_period, v_sm_id, COALESCE(v_sm_invest, 0), v_paid_d + v_d, v_sm_take,
        v_before, p_actor)
      RETURNING id INTO v_settlement;
      INSERT INTO app_private.profit_ledger_events (organization_id, event_kind, subject_kind, shareholder_id,
        settlement_id, amount, balance_before, balance_after, actor_id, reason, payload)
      VALUES (v_org, 'SALARY_FROZEN', 'SHAREHOLDER', v_sh, v_settlement, COALESCE(v_sm_invest, 0), v_before, v_before,
        p_actor, v_reason, jsonb_build_object('source', 'BACKFILL', 'period_month', v_period,
                                              'advance_offset_month', v_paid_d + v_d, 'voided_settlement_id', v_c3_id));
    END IF;
  END IF;

  INSERT INTO app_private.profit_ledger_salary_settlement_vouchers (organization_id, shareholder_id, staff_id,
    period_month, settlement_id, salary_voucher_id, investment_amount, advance_offset_amount,
    sheet_status_at_quote, source, state, created_by, linked_at)
  VALUES (v_org, v_sh, v_staff, v_period, v_settlement, p_salary_voucher_id, v_y, v_d, v_status, 'BACKFILL',
    'LINKED', p_actor, clock_timestamp())
  RETURNING id INTO v_line;
  v_after := (app_private.profit_ledger_balance_v1(v_org, 'SHAREHOLDER', v_sh)->>'balance')::numeric;
  INSERT INTO app_private.profit_ledger_events (organization_id, event_kind, subject_kind, shareholder_id,
    voucher_id, settlement_id, line_id, amount, balance_before, balance_after, actor_id, reason, payload)
  VALUES (v_org, 'SALARY_LINKED', 'SHAREHOLDER', v_sh, p_salary_voucher_id, v_settlement, v_line, v_y,
    v_before, v_after, p_actor, v_reason,
    jsonb_build_object('source', 'BACKFILL', 'period_month', v_period, 'advance_offset_amount', v_d,
                       'sheet_status', v_status));

  RETURN jsonb_build_object('line_id', v_line, 'settlement_id', v_settlement, 'shareholder_id', v_sh,
    'staff_id', v_staff, 'period_month', v_period, 'investment_amount', v_y, 'advance_offset_amount', v_d,
    'balance_before', v_before, 'balance_after', v_after, 'already', false);
END
$fn$;

-- ── 11. ACL ──────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION app_private.profit_ledger_luong_co_dong_v1(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.profit_ledger_luong_kep_v1(numeric, numeric) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.profit_ledger_luong_khoa_v1(text, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.profit_ledger_luong_so_v1(numeric) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.salary_investment_profit_v1(uuid, uuid, date, timestamptz) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.salary_profit_month_caps_v1(uuid, uuid, uuid, date) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.profit_ledger_salary_link_v1() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.profit_ledger_luong_backfill_v1(uuid, numeric, numeric, text, uuid, date) FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.salary_profit_inputs_v1(date, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.salary_profit_inputs_v1(date, uuid[]) TO authenticated;
REVOKE ALL ON FUNCTION public.salary_profit_settlement_freeze_v1(uuid, date, numeric, numeric, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.salary_profit_settlement_freeze_v1(uuid, date, numeric, numeric, numeric, text) TO authenticated;
REVOKE ALL ON FUNCTION public.profit_unlock_salary_impact_v1(uuid, date, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.profit_unlock_salary_impact_v1(uuid, date, uuid[]) TO authenticated;
REVOKE ALL ON FUNCTION public.salary_profit_payout_quote_v1(uuid, date, numeric, numeric, numeric, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.salary_profit_payout_quote_v1(uuid, date, numeric, numeric, numeric, text, text) TO authenticated;
REVOKE ALL ON FUNCTION public.profit_ledger_salary_resolve_v1(uuid, numeric, numeric, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.profit_ledger_salary_resolve_v1(uuid, numeric, numeric, text, text) TO authenticated;

COMMENT ON FUNCTION app_private.salary_investment_profit_v1(uuid, uuid, date, timestamptz) IS
  'Dòng "Lợi nhuận đầu tư" của lương tháng: bảng LOCKED = investment_profit đóng băng; DRAFT/NONE = phân bổ toà đã chốt gộp theo nhãn toà + ghi đè dh:<nhãn> mới nhất theo seq (amount NULL = gỡ). Trả cả investment_live và allocated_total (trước ghi đè). Không khoá dòng.';
COMMENT ON FUNCTION app_private.salary_profit_month_caps_v1(uuid, uuid, uuid, date) IS
  'Trần phần lợi nhuận trong lương của một tháng: Y_m, D_m = least(greatest(0, A_m − L*), greatest(Y_m, 0)), phần đã trả qua các phiếu lương LINKED còn sống. Bảng LOCKED chỉ lấy D_m từ bản đóng băng khớp bảng, không có ⇒ 0. Kỳ ≤ mốc ⇒ investment_cap = 0, D_m = 0. Không khoá dòng.';
COMMENT ON FUNCTION app_private.profit_ledger_salary_link_v1() IS
  'F3: gắn phiếu lương vừa đóng dấu (salary_monthly.payout_voucher_id) vào sổ tổng — khớp báo giá thì LINKED đã kẹp lại, không thì dự phòng (LINKED theo quy ước hoặc NEEDS_REVIEW). Không raise trên đường thường.';
COMMENT ON FUNCTION app_private.profit_ledger_luong_backfill_v1(uuid, numeric, numeric, text, uuid, date) IS
  'Ghi bù dòng sổ LINKED nguồn BACKFILL cho một phiếu lương đã có (Đợt 3). Không cấp quyền cho vai nào. Chạy lại cùng tham số không ghi gì.';
COMMENT ON FUNCTION public.salary_profit_inputs_v1(date, uuid[]) IS
  'E12: dữ kiện phần lợi nhuận trong lương của từng nhân viên (cổ đông) cho một kỳ — phân bổ, Y_m, D_m gợi ý, các dòng phiếu lương đã gắn. Chính mình hoặc quản trị lương của công ty nhân viên; một nhân viên không đạt ⇒ 42501.';
COMMENT ON FUNCTION public.salary_profit_settlement_freeze_v1(uuid, date, numeric, numeric, numeric, text) IS
  'E13: đóng băng phần lợi nhuận của lương tháng (Y_m, D_m) ngay trước lock_salary_month_v2. Lệch số đầu tư ⇒ PT409. Không bao giờ chặn chốt vì bản cũ.';
COMMENT ON FUNCTION public.profit_unlock_salary_impact_v1(uuid, date, uuid[]) IS
  'E14: mở khoá tháng lợi nhuận sẽ làm số dư sổ tổng của từng cổ đông đổi thế nào, và phần đã trả qua lương của tháng đó. Không khoá dòng.';
COMMENT ON FUNCTION public.salary_profit_payout_quote_v1(uuid, date, numeric, numeric, numeric, text, text) IS
  'E15: báo giá phần lợi nhuận / trừ tạm ứng trong phiếu lương sắp lập; gọi ngay trước salary_payout_v1 với cùng khoá trả lương.';
COMMENT ON FUNCTION public.profit_ledger_salary_resolve_v1(uuid, numeric, numeric, text, text) IS
  'E16: chủ xác nhận số cho dòng phiếu lương NEEDS_REVIEW ⇒ LINKED (OWNER_RESOLVE).';

-- Z. Hậu kiểm. Đúng ở cả lượt một lẫn lượt chạy lại.
DO $assert$
DECLARE
  v_xau text;
  c_noi_bo constant text[] := ARRAY[
    'app_private.profit_ledger_luong_co_dong_v1(uuid,uuid)',
    'app_private.profit_ledger_luong_kep_v1(numeric,numeric)',
    'app_private.profit_ledger_luong_khoa_v1(text,text)',
    'app_private.profit_ledger_luong_so_v1(numeric)',
    'app_private.salary_investment_profit_v1(uuid,uuid,date,timestamptz)',
    'app_private.salary_profit_month_caps_v1(uuid,uuid,uuid,date)',
    'app_private.profit_ledger_salary_link_v1()',
    'app_private.profit_ledger_luong_backfill_v1(uuid,numeric,numeric,text,uuid,date)'];
  c_rpc constant text[] := ARRAY[
    'public.salary_profit_inputs_v1(date,uuid[])',
    'public.salary_profit_settlement_freeze_v1(uuid,date,numeric,numeric,numeric,text)',
    'public.profit_unlock_salary_impact_v1(uuid,date,uuid[])',
    'public.salary_profit_payout_quote_v1(uuid,date,numeric,numeric,numeric,text,text)',
    'public.profit_ledger_salary_resolve_v1(uuid,numeric,numeric,text,text)'];
BEGIN
  -- 1. Đủ hàm, ghim search_path; hàm nội bộ không ai ngoài chủ hàm có EXECUTE.
  SELECT string_agg(f.ten, ', ') INTO v_xau
    FROM unnest(c_noi_bo || c_rpc) AS f(ten)
    LEFT JOIN pg_catalog.pg_proc p ON p.oid = to_regprocedure(f.ten)
   WHERE p.oid IS NULL
      OR NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) cfg WHERE cfg LIKE 'search_path=%')
      OR (f.ten = ANY (c_noi_bo)
          AND (p.proacl IS NULL OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee <> p.proowner)));
  IF v_xau IS NOT NULL THEN
    RAISE EXCEPTION 'Hậu kiểm: hàm thiếu, chưa ghim search_path hoặc hàm nội bộ còn EXECUTE cho vai khác: %', v_xau
      USING ERRCODE = '55000';
  END IF;

  -- 2. RPC: authenticated gọi được; anon và PUBLIC thì không; đều SECURITY DEFINER.
  SELECT string_agg(f.ten, ', ') INTO v_xau
    FROM unnest(c_rpc) AS f(ten)
    JOIN pg_catalog.pg_proc p ON p.oid = to_regprocedure(f.ten)
   WHERE NOT p.prosecdef
      OR NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
      OR has_function_privilege('anon', p.oid, 'EXECUTE')
      OR p.proacl IS NULL
      OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0);
  IF v_xau IS NOT NULL THEN
    RAISE EXCEPTION 'Hậu kiểm: ACL / DEFINER của RPC lương không đúng: %', v_xau USING ERRCODE = '55000';
  END IF;

  -- 3. Hàm đọc STABLE (PostgREST gọi trong giao dịch chỉ đọc), hàm ghi VOLATILE.
  IF (SELECT count(*) FROM pg_catalog.pg_proc p
       WHERE p.oid IN (to_regprocedure('public.salary_profit_inputs_v1(date,uuid[])'),
                       to_regprocedure('public.profit_unlock_salary_impact_v1(uuid,date,uuid[])'),
                       to_regprocedure('app_private.salary_investment_profit_v1(uuid,uuid,date,timestamptz)'),
                       to_regprocedure('app_private.salary_profit_month_caps_v1(uuid,uuid,uuid,date)'),
                       to_regprocedure('app_private.profit_ledger_luong_co_dong_v1(uuid,uuid)'))
         AND p.provolatile = 's' AND p.prosecdef) <> 5
     OR (SELECT count(*) FROM pg_catalog.pg_proc p
          WHERE p.oid IN (to_regprocedure('public.salary_profit_settlement_freeze_v1(uuid,date,numeric,numeric,numeric,text)'),
                          to_regprocedure('public.salary_profit_payout_quote_v1(uuid,date,numeric,numeric,numeric,text,text)'),
                          to_regprocedure('public.profit_ledger_salary_resolve_v1(uuid,numeric,numeric,text,text)'),
                          to_regprocedure('app_private.profit_ledger_salary_link_v1()'),
                          to_regprocedure('app_private.profit_ledger_luong_backfill_v1(uuid,numeric,numeric,text,uuid,date)'))
            AND p.provolatile = 'v' AND p.prosecdef) <> 5 THEN
    RAISE EXCEPTION 'Hậu kiểm: volatility / SECURITY DEFINER của hàm lương không đúng' USING ERRCODE = '55000';
  END IF;

  -- 4. Hàm đọc không chứa mẫu khoá dòng mà gate stable-fn-locks soi (bỏ chú thích trước khi dò).
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_xau
    FROM pg_catalog.pg_proc p
   WHERE p.oid IN (to_regprocedure('public.salary_profit_inputs_v1(date,uuid[])'),
                   to_regprocedure('public.profit_unlock_salary_impact_v1(uuid,date,uuid[])'),
                   to_regprocedure('app_private.salary_investment_profit_v1(uuid,uuid,date,timestamptz)'),
                   to_regprocedure('app_private.salary_profit_month_caps_v1(uuid,uuid,uuid,date)'),
                   to_regprocedure('app_private.profit_ledger_luong_co_dong_v1(uuid,uuid)'))
     AND (regexp_replace(p.prosrc, '--[^' || chr(10) || ']*', ' ', 'g') ~* '\mfor\s+(share|update|no key update|key share)\M'
          OR regexp_replace(p.prosrc, '--[^' || chr(10) || ']*', ' ', 'g') ~* '\mlock\s+(table\s+)?[a-z_.]');
  IF v_xau IS NOT NULL THEN
    RAISE EXCEPTION 'Hậu kiểm: hàm đọc có mẫu khoá dòng: %', v_xau USING ERRCODE = '55000';
  END IF;

  -- 5. Hai trigger F3 đúng chỗ: AFTER, theo dòng, đúng sự kiện, có WHEN, đang bật, đúng hàm.
  IF (SELECT count(*) FROM pg_catalog.pg_trigger t
       WHERE t.tgrelid = 'public.salary_monthly'::regclass
         AND NOT t.tgisinternal
         AND t.tgfoid = 'app_private.profit_ledger_salary_link_v1()'::regprocedure
         AND t.tgenabled = 'O'
         AND t.tgqual IS NOT NULL
         AND (t.tgtype & 1) = 1      -- ROW
         AND (t.tgtype & 2) = 0      -- AFTER
         AND ((t.tgname = 'z50_profit_ledger_salary_link_ins' AND (t.tgtype & 28) = 4)
              OR (t.tgname = 'z50_profit_ledger_salary_link_upd' AND (t.tgtype & 28) = 16
                  AND t.tgattr::text = (SELECT a.attnum::text FROM pg_catalog.pg_attribute a
                                         WHERE a.attrelid = 'public.salary_monthly'::regclass
                                           AND a.attname = 'payout_voucher_id')))) <> 2 THEN
    RAISE EXCEPTION 'Hậu kiểm: thiếu hoặc sai trigger z50_profit_ledger_salary_link_ins/_upd' USING ERRCODE = '55000';
  END IF;
END
$assert$;

COMMIT;

NOTIFY pgrst, 'reload schema';
