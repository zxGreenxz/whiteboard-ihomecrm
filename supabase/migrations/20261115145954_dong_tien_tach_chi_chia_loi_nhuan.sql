-- =============================================================================
-- Dòng tiền: tách "Trong đó: chi chia lợi nhuận" (cổ đông + lương điều hành)
-- mà KHÔNG đổi một con số nào của báo cáo dòng tiền đang có (M5, việc D2.12 của
-- "Chi chia lợi nhuận theo sổ tổng").
--
-- VÌ SAO
--   Báo cáo dòng tiền trên web và Hermes cùng gọi public.cashbook_cash_flow_v1
--   (INVOKER), hàm này đọc public.cash_flow_external_rows_v1 (DEFINER). Hàm
--   dòng chỉ trả (ngày, toà, số tiền có dấu) nên không biết dòng nào là chi
--   chia lợi nhuận. Chủ cần cột "Trong đó: chi chia lợi nhuận" theo 12 tháng +
--   4 quý; khoản đó vẫn nằm trong "Chi ra" (tiền thật rời sổ), và Hermes phải
--   nhận đúng từng con số như trước.
--
-- LÀM GÌ
--   A. app_private.cash_flow_external_voucher_rows_v1: thân CHÉP NGUYÊN VĂN
--      public.cash_flow_external_rows_v1 của 20261023150607 (mọi dòng kiểm
--      org, quyền, toà, demo, sandbox, sổ ảo, bàn giao, hoàn tác, phiếu trộn
--      giữ y chữ). CHỈ THÊM: mã phiếu, cờ hạng mục chia_loi_nhuan /
--      luong_dieu_hanh (kể cả hạng mục đã gộp qua merged_into_id) và profit_kind:
--        SHAREHOLDER  system_source thuộc {profit.ledger_payout,
--                     profit.distribution}, hoặc phiếu có shareholder_id, hoặc
--                     có hạng mục chia_loi_nhuan;
--        MANAGER      (khi không phải trên) system_source thuộc
--                     {profit.manager_salary, salary.manager}, hoặc có
--                     profit_manager_id, hoặc có hạng mục luong_dieu_hanh;
--        NULL         còn lại, kể cả posting không có phiếu.
--      KHÔNG cấp cho vai nào: người chỉ có quyền xem dòng tiền không được biết
--      phiếu nào là chi chia lợi nhuận. Chỉ hai hàm DEFINER dưới đây gọi nó.
--   B. public.cash_flow_external_rows_v1 thành vỏ mỏng trả ba cột đầu của A.
--      Giữ chữ ký, kiểu trả, DEFINER, STABLE, search_path, owner, ACL, comment.
--   C. public.cashbook_cash_flow_profit_payout_v1(org, năm, toà): 12 tháng + 4
--      quý, cùng cách chia toà, cấu trúc và thứ tự dòng với cashbook_cash_flow_v1.
--      shareholder_payout / manager_payout = tổng các dòng ÂM theo từng loại, nên
--      luôn là tập con của "Chi ra" cùng kỳ. Rào theo đúng thứ tự của
--      cashbook_cash_flow_v1 (đăng nhập + thuộc công ty, năm 2000..2100, quyền
--      reports_finance.cash_flow) rồi thêm quyền TOÀN CÔNG TY
--      shareholder_profit.distribute | lock | view_building_totals. Mọi từ chối
--      quyền là 42501 (web ẩn cột khi gặp 42501).
--      DEFINER chứ không INVOKER như plan: vai authenticated KHÔNG có USAGE trên
--      schema app_private (đo production và TEST 15/11/2026), nên một hàm INVOKER
--      không gọi được A (cố ý không cấp) lẫn app_private.profit_viewer_can_v1.
--      Mọi dòng trả về vẫn do A tự kiểm org/quyền/toà như hàm dòng cũ.
--
-- KHÔNG LÀM: không định nghĩa lại public.cashbook_cash_flow_v1 (thân và ACL giữ
--   nguyên, chỉ ghim md5 vì nó gọi vỏ B); không đổi công thức thu/chi; không
--   ghi dữ liệu.
--
-- GIỚI HẠN ĐÃ BIẾT
--   - Cờ tính theo PHIẾU (posting không nối từng hạng mục): phiếu chi có cả hạng
--     mục chia_loi_nhuan lẫn hạng mục thường thì toàn bộ phần chi ra ngoài của
--     phiếu vào cột lợi nhuận. Đo production 15/11/2026: 3 phiếu khớp luật, cả
--     ba chỉ qua hạng mục chia_loi_nhuan; chưa phiếu nào khớp nhánh lương điều hành.
--   - Phiếu THU có shareholder_id hoặc hạng mục lợi nhuận không vào cột (chỉ
--     dòng âm được cộng).
--
-- AN TOÀN CHẠY LẠI: khối ghim md5 chỉ nhận thân production đã rà hoặc thân do
--   chính migration này ghi (lượt hai); cashbook_cash_flow_v1 phải đúng thân
--   20261023150607. Lệch ⇒ dừng 55000, không ghi đè.
-- LÙI: migration forward MỚI thay lại thân public.cash_flow_external_rows_v1
--   bằng thân của 20261023150607 (chỉ hàm đó, KHÔNG chạy lại nguyên file vì nó
--   còn thay cashbook_cash_flow_v1), rồi DROP hai hàm mới sau khi web đã bỏ cột.
--   Không đụng dữ liệu.
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- 0. Nền + ghim md5 (của prosrc đã bỏ CR) các thân sắp thay hoặc được gọi.
DO $truoc$
DECLARE
  v_thieu text;
  v_md5 text;
  r record;
BEGIN
  SELECT string_agg(x.sig, ', ' ORDER BY x.sig) INTO v_thieu
    FROM (VALUES
      ('app_private.profit_viewer_can_v1(uuid,text)'),
      ('app_private.ie_visible_cashbook_ids_v1()'),
      ('public.finance_my_scope_v1(uuid,text)'),
      ('public.my_org_ids()'),
      ('public.can_access_building(uuid)'),
      ('public.can_view_restricted_ie()'),
      ('public.demo_user_ids()'),
      ('public.sandbox_org_ids()'),
      ('public.nrm_vn(text)')
    ) AS x(sig)
   WHERE to_regprocedure(x.sig) IS NULL;
  IF v_thieu IS NOT NULL THEN
    RAISE EXCEPTION 'Thiếu hàm nền của dòng tiền: %', v_thieu USING ERRCODE = '55000';
  END IF;

  SELECT string_agg(x.rel || '.' || c.col, ', ' ORDER BY x.rel, c.col) INTO v_thieu
    FROM (VALUES
      ('public.income_expenses', ARRAY['id', 'system_source', 'shareholder_id', 'profit_manager_id']),
      ('public.income_expense_types', ARRAY['id', 'rule_key', 'merged_into_id'])
    ) AS x(rel, cols)
    CROSS JOIN LATERAL unnest(x.cols) AS c(col)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_catalog.pg_attribute a
      WHERE a.attrelid = to_regclass(x.rel) AND a.attname = c.col AND a.attnum > 0 AND NOT a.attisdropped);
  IF v_thieu IS NOT NULL THEN
    RAISE EXCEPTION 'Thiếu cột nền: %', v_thieu USING ERRCODE = '55000';
  END IF;

  -- bat_buoc: hàm phải có sẵn. md5: [thân production đã rà, thân do chính migration
  -- này ghi (lượt hai)]; hàm mới của migration này chỉ được mang thân của nó.
  FOR r IN
    SELECT * FROM (VALUES
      ('public.cash_flow_external_rows_v1(uuid,date,date,uuid[])', true,
        ARRAY['860a051fb7e17c9b5028bfa1bb246dfe', '08efae111ce6ace9ac799fe9d3f79166']),
      ('public.cashbook_cash_flow_v1(uuid,integer,uuid[])', true,
        ARRAY['63aad97a56cb0c0f6b20af0ce7667040']),
      ('app_private.cash_flow_external_voucher_rows_v1(uuid,date,date,uuid[])', false,
        ARRAY['64e5adf3dc088a797695ead6edff179b']),
      ('public.cashbook_cash_flow_profit_payout_v1(uuid,integer,uuid[])', false,
        ARRAY['3ca28a6b41582e1b5dacd834c0ece87c'])
    ) AS x(sig, bat_buoc, md5s)
  LOOP
    SELECT md5(replace(p.prosrc, chr(13), '')) INTO v_md5
      FROM pg_catalog.pg_proc p
     WHERE p.oid = to_regprocedure(r.sig);
    IF v_md5 IS NULL AND r.bat_buoc THEN
      RAISE EXCEPTION 'Thiếu %', r.sig USING ERRCODE = '55000';
    END IF;
    IF v_md5 IS NOT NULL AND v_md5 <> ALL (r.md5s) THEN
      RAISE EXCEPTION '% đã đổi so với bản đã rà (md5 %) — chụp lại prosrc rồi rà lại', r.sig, v_md5
        USING ERRCODE = '55000';
    END IF;
  END LOOP;
END
$truoc$;

-- A. Dòng tiền ra/vào kèm phiếu và loại chi lợi nhuận. Thân = hàm dòng cũ
--    (20261023150607) + ie.id, hai cờ hạng mục trong LATERAL items, profit_kind.
CREATE OR REPLACE FUNCTION app_private.cash_flow_external_voucher_rows_v1(
  p_organization_id uuid,
  p_start date,
  p_end date,
  p_building_ids uuid[] DEFAULT NULL
)
RETURNS TABLE(day date, building_id uuid, signed_amount numeric, income_expense_id uuid, profit_kind text)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
DECLARE
  v_scope jsonb;
  v_can_restricted boolean;
  v_demo_users uuid[];
  r record;
BEGIN
  IF auth.uid() IS NULL OR p_organization_id IS NULL
    OR NOT COALESCE(p_organization_id = ANY(public.my_org_ids()), false) THEN
    RAISE EXCEPTION 'cash_flow_denied' USING ERRCODE = '42501';
  END IF;
  IF p_start IS NULL OR p_end IS NULL OR p_start > p_end OR p_end - p_start > 1096 THEN
    RAISE EXCEPTION 'cash_flow_invalid' USING ERRCODE = '22023';
  END IF;
  v_scope := public.finance_my_scope_v1(p_organization_id, 'reports_finance.cash_flow');
  IF v_scope->'allowed' IS DISTINCT FROM 'true'::jsonb THEN
    RAISE EXCEPTION 'cash_flow_denied' USING ERRCODE = '42501';
  END IF;
  v_can_restricted := COALESCE(public.can_view_restricted_ie(), false);
  v_demo_users := public.demo_user_ids();

  FOR r IN
    SELECT p.posted_on, ie.building_id, pl.signed_amount, pl.line_kind,
      p.voucher_amount_snapshot, items.internal_amount, items.external_amount,
      (SELECT count(*) FROM public.income_expense_posting_lines all_lines
       WHERE all_lines.posting_id = p.id AND all_lines.organization_id = p_organization_id) AS line_count,
      ie.id AS ie_id,
      CASE
        WHEN ie.system_source IN ('profit.ledger_payout', 'profit.distribution')
          OR ie.shareholder_id IS NOT NULL OR items.shareholder_item THEN 'SHAREHOLDER'
        WHEN ie.system_source IN ('profit.manager_salary', 'salary.manager')
          OR ie.profit_manager_id IS NOT NULL OR items.manager_item THEN 'MANAGER'
      END AS ie_profit_kind
    FROM public.income_expense_postings p
    JOIN public.organizations org ON org.id = p.organization_id AND NOT org.is_demo
    JOIN public.income_expense_posting_lines pl
      ON pl.posting_id = p.id AND pl.organization_id = p.organization_id
    JOIN public.accounts a ON a.id = pl.account_id AND a.organization_id = p.organization_id
      AND a.deleted_at IS NULL AND NOT COALESCE(a.is_virtual, false)
      AND NOT COALESCE(a.user_id = ANY(v_demo_users), false)
    LEFT JOIN public.income_expenses ie
      ON ie.id = p.voucher_id AND ie.organization_id = p.organization_id
    LEFT JOIN public.buildings b ON b.id = ie.building_id AND b.organization_id = p.organization_id
    LEFT JOIN LATERAL (
      SELECT COALESCE(sum(item.amount) FILTER (WHERE item.is_transfer), 0) AS internal_amount,
        COALESCE(sum(item.amount) FILTER (WHERE NOT item.is_transfer), 0) AS external_amount,
        COALESCE(bool_or(item.is_shareholder_profit), false) AS shareholder_item,
        COALESCE(bool_or(item.is_manager_salary), false) AS manager_item
      FROM (
        SELECT COALESCE(i.amount, i.quantity * i.unit_price, 0) AS amount,
          COALESCE(t.rule_key = 'noi_bo' OR canonical.rule_key = 'noi_bo', false)
          OR public.nrm_vn(t.name) IN ('ban giao tien mat', 'nhan ban giao tien mat', 'chuyen tien noi bo', 'nhan tien noi bo')
          OR public.nrm_vn(canonical.name) IN ('ban giao tien mat', 'nhan ban giao tien mat', 'chuyen tien noi bo', 'nhan tien noi bo') AS is_transfer,
          COALESCE(t.rule_key = 'chia_loi_nhuan' OR canonical.rule_key = 'chia_loi_nhuan', false) AS is_shareholder_profit,
          COALESCE(t.rule_key = 'luong_dieu_hanh' OR canonical.rule_key = 'luong_dieu_hanh', false) AS is_manager_salary
        FROM public.income_expense_items i
        JOIN public.income_expense_types t ON t.id = i.income_expense_type_id
          AND t.organization_id = p.organization_id
        LEFT JOIN public.income_expense_types canonical ON canonical.id = t.merged_into_id
          AND canonical.organization_id = p.organization_id
        WHERE i.income_expense_id = ie.id
          AND (i.organization_id = p.organization_id OR i.organization_id IS NULL)
      ) item
    ) items ON true
    WHERE p.organization_id = p_organization_id
      -- Dấu hiệu demo/sandbox chính thức, kể cả dữ liệu thử trong org thật.
      -- DEFINER phải giữ các restriction này của accounts/buildings/income_expenses.
      AND NOT COALESCE(p.organization_id = ANY(public.sandbox_org_ids()), false)
      AND NOT COALESCE(ie.user_id = ANY(v_demo_users), false)
      AND NOT COALESCE(b.user_id = ANY(v_demo_users), false)
      AND p.event_kind = 'POSTING'
      AND p.posted_on BETWEEN p_start AND p_end
      AND (p.voucher_id IS NULL OR ie.id IS NOT NULL)
      AND pl.account_id IN (SELECT visible.cashbook_id FROM app_private.ie_visible_cashbook_ids_v1() visible)
      AND (b.id IS NOT NULL AND public.can_access_building(b.id)
          AND (v_scope->'orgWide' = 'true'::jsonb OR v_scope->'buildingIds' ? b.id::text)
        OR ie.building_id IS NULL AND v_scope->'orgWide' = 'true'::jsonb)
      AND (p_building_ids IS NULL OR ie.building_id = ANY(p_building_ids))
      AND (NOT COALESCE(ie.has_restricted_item, false) OR ie.user_id = auth.uid() OR v_can_restricted)
      -- handover_id nằm trên phiếu thu gốc: phải GIỮ phiếu đó. Chỉ loại phiếu chuyển.
      AND ie.handover_transfer_id IS NULL
      AND COALESCE(ie.system_source, '') <> 'handover.transfer'
      -- Không giới hạn ngày/sổ/toà của dòng đảo: đổi kỳ hoặc che dòng đối ứng
      -- không được làm sống lại khoản đã huỷ. Không ghép bằng số tiền/ngày/tên.
      AND NOT EXISTS (
        SELECT 1 FROM public.income_expense_postings reversal
        WHERE reversal.organization_id = p.organization_id
          AND reversal.reversal_of_id = p.id AND reversal.event_kind = 'REVERSAL'
      )
      -- Chế độ cũ tạo phiếu chi đối ứng thay vì chỉ một event REVERSAL.
      -- Phiếu hoàn cọc/hoàn tiền thật không có liên kết này, vẫn được giữ.
      AND ie.reversal_of_income_expense_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.income_expenses counter
        JOIN public.income_expense_postings counter_posting
          ON counter_posting.voucher_id = counter.id AND counter_posting.organization_id = counter.organization_id
          AND counter_posting.event_kind = 'POSTING'
        WHERE counter.organization_id = p.organization_id AND counter.reversal_of_income_expense_id = ie.id
          AND NOT EXISTS (
            SELECT 1 FROM public.income_expense_postings counter_reversal
            WHERE counter_reversal.organization_id = counter_posting.organization_id
              AND counter_reversal.reversal_of_id = counter_posting.id AND counter_reversal.event_kind = 'REVERSAL'
          )
      )
  LOOP
    IF r.internal_amount > 0 THEN
      IF r.external_amount = 0 THEN CONTINUE; END IF;
      -- Dòng posting không nối từng item. Chỉ tách phiếu trộn khi phép khớp
      -- là chính xác: một MAIN, không thối/làm tròn, tổng item khớp snapshot.
      -- Không suy tỷ lệ hay loại luôn cả phần thu/chi thật của phiếu trộn.
      IF r.line_count <> 1 OR r.line_kind IS DISTINCT FROM 'MAIN'
        OR abs(r.signed_amount) <> r.internal_amount + r.external_amount
        OR r.voucher_amount_snapshot IS DISTINCT FROM r.internal_amount + r.external_amount THEN
        RAISE EXCEPTION 'cash_flow_mixed_transfer_items: Cần tách hạng mục chuyển tiền nội bộ khỏi phiếu thu/chi có nhiều dòng tiền.'
          USING ERRCODE = '22023';
      END IF;
      signed_amount := sign(r.signed_amount) * r.external_amount;
    ELSE
      signed_amount := r.signed_amount;
    END IF;
    day := r.posted_on;
    building_id := r.building_id;
    income_expense_id := r.ie_id;
    profit_kind := r.ie_profit_kind;
    RETURN NEXT;
  END LOOP;
END
$fn$;

ALTER FUNCTION app_private.cash_flow_external_voucher_rows_v1(uuid,date,date,uuid[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.cash_flow_external_voucher_rows_v1(uuid,date,date,uuid[]) FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION app_private.cash_flow_external_voucher_rows_v1(uuid,date,date,uuid[]) IS
  'Internal: rows of cash_flow_external_rows_v1 plus voucher id and profit payout kind (SHAREHOLDER, MANAGER or NULL). Same organization, permission, building and cashbook checks. Granted to no role; only DEFINER cash flow readers call it.';

-- B. Vỏ mỏng: cùng chữ ký và đầu ra như trước, đọc ba cột đầu của A.
CREATE OR REPLACE FUNCTION public.cash_flow_external_rows_v1(
  p_organization_id uuid,
  p_start date,
  p_end date,
  p_building_ids uuid[] DEFAULT NULL
)
RETURNS TABLE(day date, building_id uuid, signed_amount numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
BEGIN
  RETURN QUERY SELECT r.day, r.building_id, r.signed_amount
    FROM app_private.cash_flow_external_voucher_rows_v1(p_organization_id, p_start, p_end, p_building_ids) r;
END
$fn$;

ALTER FUNCTION public.cash_flow_external_rows_v1(uuid,date,date,uuid[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.cash_flow_external_rows_v1(uuid,date,date,uuid[]) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.cash_flow_external_rows_v1(uuid,date,date,uuid[]) TO authenticated;
COMMENT ON FUNCTION public.cash_flow_external_rows_v1(uuid,date,date,uuid[]) IS
  'Current corrected external cash movement, selected real organization, real visible cashbooks and report building scope. Reversed posting/counter-voucher pairs and internal handovers excluded. Does not alter cashbook balance readers.';

-- C. "Trong đó: chi chia lợi nhuận" theo 12 tháng + 4 quý, cùng phạm vi/thứ tự
--    với cashbook_cash_flow_v1. Chỉ dòng âm ⇒ luôn nằm trong "Chi ra" cùng kỳ.
CREATE OR REPLACE FUNCTION public.cashbook_cash_flow_profit_payout_v1(
  p_organization_id uuid, p_year integer, p_building_ids uuid[] DEFAULT NULL
)
RETURNS TABLE(organization_id uuid, building_id uuid, period text, shareholder_payout numeric, manager_payout numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
#variable_conflict use_column
DECLARE v_scope jsonb; v_buildings uuid[];
BEGIN
  IF auth.uid() IS NULL OR p_organization_id IS NULL
    OR NOT COALESCE(p_organization_id = ANY(public.my_org_ids()), false) THEN
    RAISE EXCEPTION 'cash_flow_denied' USING ERRCODE = '42501';
  END IF;
  IF p_year IS NULL OR p_year NOT BETWEEN 2000 AND 2100 THEN
    RAISE EXCEPTION 'cash_flow_invalid' USING ERRCODE = '22023';
  END IF;
  v_scope := public.finance_my_scope_v1(p_organization_id, 'reports_finance.cash_flow');
  IF v_scope->'allowed' IS DISTINCT FROM 'true'::jsonb THEN
    RAISE EXCEPTION 'cash_flow_denied' USING ERRCODE = '42501';
  END IF;
  IF NOT (app_private.profit_viewer_can_v1(p_organization_id, 'shareholder_profit.distribute')
      OR app_private.profit_viewer_can_v1(p_organization_id, 'shareholder_profit.lock')
      OR app_private.profit_viewer_can_v1(p_organization_id, 'shareholder_profit.view_building_totals')) THEN
    RAISE EXCEPTION 'cash_flow_profit_denied' USING ERRCODE = '42501';
  END IF;
  IF p_building_ids IS NULL AND v_scope->'orgWide' = 'true'::jsonb THEN
    v_buildings := ARRAY[NULL::uuid];
  ELSE
    SELECT COALESCE(array_agg(DISTINCT x ORDER BY x), '{}'::uuid[]) INTO v_buildings
    FROM unnest(COALESCE(p_building_ids, ARRAY(SELECT jsonb_array_elements_text(v_scope->'buildingIds')::uuid))) x
    WHERE v_scope->'buildingIds' ? x::text;
  END IF;
  RETURN QUERY
  WITH bl AS (
    SELECT b.id AS bid FROM unnest(v_buildings) b(id)
  ), external_rows AS MATERIALIZED (
    SELECT * FROM app_private.cash_flow_external_voucher_rows_v1(
      p_organization_id, make_date(p_year, 1, 1), make_date(p_year, 12, 31), p_building_ids)
  ), months AS (
    SELECT bl.bid, m.n,
      COALESCE(sum(-f.signed_amount) FILTER (WHERE f.signed_amount < 0 AND f.profit_kind = 'SHAREHOLDER'), 0) AS sh,
      COALESCE(sum(-f.signed_amount) FILTER (WHERE f.signed_amount < 0 AND f.profit_kind = 'MANAGER'), 0) AS mg
    FROM bl CROSS JOIN generate_series(1, 12) m(n)
    LEFT JOIN external_rows f ON (bl.bid IS NULL OR f.building_id = bl.bid) AND extract(month FROM f.day) = m.n
    GROUP BY bl.bid, m.n
  ), periods AS (
    SELECT months.bid, months.n AS ord, to_char(make_date(p_year, months.n, 1), 'YYYY-MM') AS p, months.sh, months.mg FROM months
    UNION ALL
    SELECT months.bid, 12 + q.n, p_year::text || '-Q' || q.n, sum(months.sh), sum(months.mg)
    FROM generate_series(1, 4) q(n) JOIN months ON (months.n - 1) / 3 + 1 = q.n GROUP BY months.bid, q.n
  )
  SELECT p_organization_id, periods.bid, periods.p, periods.sh, periods.mg
  FROM periods ORDER BY periods.bid NULLS FIRST, periods.ord;
END
$fn$;

ALTER FUNCTION public.cashbook_cash_flow_profit_payout_v1(uuid,integer,uuid[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.cashbook_cash_flow_profit_payout_v1(uuid,integer,uuid[]) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.cashbook_cash_flow_profit_payout_v1(uuid,integer,uuid[]) TO authenticated;
COMMENT ON FUNCTION public.cashbook_cash_flow_profit_payout_v1(uuid,integer,uuid[]) IS
  'Monthly/quarterly profit payouts (shareholder, manager salary) already counted in cashbook_cash_flow_v1 expense; same periods and building scope. Requires reports_finance.cash_flow plus organization-wide shareholder_profit.distribute, lock or view_building_totals.';

-- Z. Hậu kiểm: đúng thân vỏ, đúng kiểu hàm, đúng ACL.
DO $sau$
DECLARE
  r record;
BEGIN
  IF (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_catalog.pg_proc p
       WHERE p.oid = to_regprocedure('public.cash_flow_external_rows_v1(uuid,date,date,uuid[])'))
     IS DISTINCT FROM '08efae111ce6ace9ac799fe9d3f79166' THEN
    RAISE EXCEPTION 'Hậu kiểm: public.cash_flow_external_rows_v1 không mang thân vỏ của migration này'
      USING ERRCODE = '55000';
  END IF;

  FOR r IN
    SELECT x.sig, x.cho_authenticated, p.oid, p.prosecdef, p.provolatile, p.proconfig
      FROM (VALUES
        ('app_private.cash_flow_external_voucher_rows_v1(uuid,date,date,uuid[])', false),
        ('public.cash_flow_external_rows_v1(uuid,date,date,uuid[])', true),
        ('public.cashbook_cash_flow_profit_payout_v1(uuid,integer,uuid[])', true)
      ) AS x(sig, cho_authenticated)
      LEFT JOIN pg_catalog.pg_proc p ON p.oid = to_regprocedure(x.sig)
  LOOP
    IF r.oid IS NULL OR NOT r.prosecdef OR r.provolatile <> 's'
       OR r.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, app_private']::text[] THEN
      RAISE EXCEPTION 'Hậu kiểm: % phải tồn tại, SECURITY DEFINER, STABLE, search_path ghim', r.sig
        USING ERRCODE = '55000';
    END IF;
    IF has_function_privilege('anon', r.oid, 'EXECUTE')
       OR has_function_privilege('service_role', r.oid, 'EXECUTE')
       OR (has_function_privilege('authenticated', r.oid, 'EXECUTE') IS DISTINCT FROM r.cho_authenticated) THEN
      RAISE EXCEPTION 'Hậu kiểm: ACL của % không đúng kỳ vọng (anon/service_role không; authenticated %)',
        r.sig, CASE WHEN r.cho_authenticated THEN 'có' ELSE 'không' END
        USING ERRCODE = '55000';
    END IF;
  END LOOP;
END
$sau$;

COMMIT;
