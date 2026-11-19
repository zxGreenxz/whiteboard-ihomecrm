-- =============================================================================
-- Người GIỮ TIỀN của sổ thấy mọi phiếu trong sổ đó, kể cả phiếu có hạng mục hạn chế (31/10/2026).
--
-- LỖI
--   Lớp chặn hạng mục hạn chế (20260613000000; RESTRICTIVE income_expenses_restricted_select, bọc
--   InitPlan ở 20261018044046) chỉ chừa super admin, người có income_expenses.restricted_view và người
--   lập phiếu. Lớp này đè lên mọi cửa PERMISSIVE, kể cả cửa sổ quỹ (income_expenses_select_fund_member).
--   Trong khi đó sổ cái (finance_v2_can_read_posting_v1, view accounts_with_balance) cho CUSTODIAN đọc
--   hết. Kết quả: người giữ tiền thấy số dư sổ đã trừ phiếu lương, còn màn Thu chi (danh sách đọc thẳng
--   bảng + get_income_expense_layer_stats SECURITY INVOKER) không có phiếu đó và 3 số tổng thiếu đúng
--   số tiền ấy — không đối soát được sổ mình giữ. Đo prod 31/10/2026 (chỉ đọc): một quản lý giữ hai sổ,
--   mỗi sổ một phiếu lương bị ẩn, có phiếu là lương của chính người đó.
--
-- CHỦ CHỐT 31/10/2026: chỉ mở cho người giữ tiền (possession CUSTODIAN còn hiệu lực) của sổ. Người chỉ
--   được xem sổ (KNOWER), OPERATOR, chủ sổ không giữ tiền và người nhận lương KHÔNG được thêm gì.
--
-- THAY ĐỔI
--   1. app_private.my_custodian_cashbook_ids_v1(): tập sổ người gọi đang giữ tiền. Cùng điều kiện hiệu
--      lực với app_private.my_possessed_cashbook_ids_v1() (membership ACTIVE, valid_from <= now(),
--      valid_to NULL hoặc sau now()), thêm possession_kind = 'CUSTODIAN'.
--   2. app_private.ie_in_my_custodian_cashbook_v1(uuid): phiếu có sổ chính, sổ thối hoặc sổ làm tròn
--      thuộc tập (1) — ba cột tiền của phiếu, cùng ba cột cửa sổ quỹ đang dùng.
--   3. income_expenses_restricted_select: thêm nhánh ba cột thuộc tập (1).
--   4. income_expense_items_restricted_select: thêm nhánh (2) theo phiếu cha, để chi tiết phiếu đủ dòng.
--
-- KHÔNG ĐỔI
--   · Policy UPDATE/DELETE hạn chế của income_expenses và income_expense_items, và
--     public.ie_item_restricted_visible(uuid) mà chúng dùng: migration chỉ đổi policy SELECT.
--   · Các RPC ghi phiếu (SECURITY DEFINER, owner postgres, BYPASSRLS) không đọc qua RLS nên luật của
--     chúng không đổi. Nhưng khi đã THẤY phiếu, người giữ tiền bấm được các thao tác mà RPC không xét cờ
--     hạn chế, theo đúng quyền sẵn có (chủ chốt 31/10/2026 giữ nguyên, không khoá thêm): Đã kiểm
--     (verify_income_expense_v1), Chi phiếu đã duyệt (post_approved_income_expense_v2, cần giữ tiền đúng
--     sổ), Đảo phiếu (reverse_posted_income_expense_v2, cần income_expenses.reverse ở toà và giữ tiền
--     đúng sổ), Duyệt (cần income_expenses.approve ở toà). Huỷ, Sửa, Chú thích, Bổ sung chứng từ và
--     Dừng lặp vẫn chặn phiếu hạn chế.
--   · income_expense_types: tên hạng mục ở chi tiết phiếu đọc qua app_private.ie_detail_metadata_v1
--     (SECURITY DEFINER), không qua RLS của bảng hạng mục.
--   · read_income_expense_details_v1 (owner ie_detail_reader, thành viên authenticated,
--     row_security on) tự đi theo policy mới; role ie_canonical_writer không thuộc authenticated nên
--     không chịu các policy hạn chế này.
-- =============================================================================

DO $chot$
DECLARE
  v_policy record;
  v_qual   text;
BEGIN
  IF to_regclass('public.cashbook_possession_bindings') IS NULL
     OR to_regclass('public.organization_memberships') IS NULL
     OR to_regclass('public.income_expenses') IS NULL
     OR to_regclass('public.income_expense_items') IS NULL THEN
    RAISE EXCEPTION 'chot: thieu bang possession/membership/phieu/dong phieu';
  END IF;
  IF (SELECT count(*) FROM pg_attribute
       WHERE attrelid = 'public.cashbook_possession_bindings'::regclass AND NOT attisdropped
         AND attname IN ('cashbook_id', 'membership_id', 'possession_kind', 'valid_from', 'valid_to')) <> 5
     OR (SELECT count(*) FROM pg_attribute
          WHERE attrelid = 'public.income_expenses'::regclass AND NOT attisdropped
            AND attname IN ('account_id', 'change_account_id', 'rounding_account_id', 'has_restricted_item', 'user_id')) <> 5 THEN
    RAISE EXCEPTION 'chot: thieu cot possession hoac cot so cua phieu';
  END IF;
  IF to_regprocedure('public.ie_item_restricted_visible(uuid)') IS NULL
     OR to_regprocedure('public.can_view_restricted_ie()') IS NULL THEN
    RAISE EXCEPTION 'chot: thieu ham ie_item_restricted_visible/can_view_restricted_ie';
  END IF;

  SELECT p.polcmd, p.polpermissive, pg_get_expr(p.polqual, p.polrelid) AS qual
    INTO v_policy
    FROM pg_policy p
   WHERE p.polrelid = 'public.income_expenses'::regclass
     AND p.polname = 'income_expenses_restricted_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'chot: thieu policy income_expenses_restricted_select';
  END IF;
  IF v_policy.polcmd <> 'r' OR v_policy.polpermissive THEN
    RAISE EXCEPTION 'chot: income_expenses_restricted_select khong con la RESTRICTIVE FOR SELECT';
  END IF;
  -- Bỏ tiền tố public. (deparse phụ thuộc search_path) và gộp khoảng trắng; nhận bản đã review hoặc
  -- bản sau migration này (chạy lại).
  v_qual := replace(regexp_replace(v_policy.qual, '\s+', ' ', 'g'), 'public.', '');
  IF v_qual NOT IN (
       '((has_restricted_item = false) OR (user_id = ( SELECT auth.uid() AS uid)) OR ( SELECT can_view_restricted_ie() AS can_view_restricted_ie))',
       '((has_restricted_item = false) OR (user_id = ( SELECT auth.uid() AS uid)) OR ( SELECT can_view_restricted_ie() AS can_view_restricted_ie) OR (account_id IN ( SELECT app_private.my_custodian_cashbook_ids_v1() AS my_custodian_cashbook_ids_v1)) OR (change_account_id IN ( SELECT app_private.my_custodian_cashbook_ids_v1() AS my_custodian_cashbook_ids_v1)) OR (rounding_account_id IN ( SELECT app_private.my_custodian_cashbook_ids_v1() AS my_custodian_cashbook_ids_v1)))'
     ) THEN
    RAISE EXCEPTION 'chot: income_expenses_restricted_select lech ban da review: %', v_policy.qual;
  END IF;

  SELECT p.polcmd, p.polpermissive, pg_get_expr(p.polqual, p.polrelid) AS qual
    INTO v_policy
    FROM pg_policy p
   WHERE p.polrelid = 'public.income_expense_items'::regclass
     AND p.polname = 'income_expense_items_restricted_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'chot: thieu policy income_expense_items_restricted_select';
  END IF;
  IF v_policy.polcmd <> 'r' OR v_policy.polpermissive THEN
    RAISE EXCEPTION 'chot: income_expense_items_restricted_select khong con la RESTRICTIVE FOR SELECT';
  END IF;
  v_qual := replace(regexp_replace(v_policy.qual, '\s+', ' ', 'g'), 'public.', '');
  IF v_qual NOT IN (
       'ie_item_restricted_visible(income_expense_id)',
       '(ie_item_restricted_visible(income_expense_id) OR app_private.ie_in_my_custodian_cashbook_v1(income_expense_id))'
     ) THEN
    RAISE EXCEPTION 'chot: income_expense_items_restricted_select lech ban da review: %', v_policy.qual;
  END IF;
END
$chot$;

-- ── 1. Tập sổ người gọi đang giữ tiền ─────────────────────────────────────────

CREATE OR REPLACE FUNCTION app_private.my_custodian_cashbook_ids_v1()
RETURNS SETOF uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
BEGIN
  RETURN QUERY
    SELECT b.cashbook_id
      FROM public.cashbook_possession_bindings b
      JOIN public.organization_memberships m ON m.id = b.membership_id
     WHERE m.user_id = auth.uid()
       AND m.status = 'ACTIVE'
       AND b.possession_kind = 'CUSTODIAN'
       AND b.valid_from <= now()
       AND (b.valid_to IS NULL OR b.valid_to > now());
END
$fn$;

COMMENT ON FUNCTION app_private.my_custodian_cashbook_ids_v1() IS
  'Sổ người gọi đang giữ tiền (possession CUSTODIAN còn hiệu lực, membership ACTIVE). Dùng trong policy '
  'SELECT hạn chế của income_expenses và income_expense_items: người giữ tiền thấy mọi phiếu trong sổ mình.';

ALTER FUNCTION app_private.my_custodian_cashbook_ids_v1() OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.my_custodian_cashbook_ids_v1() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app_private.my_custodian_cashbook_ids_v1() TO authenticated;

-- ── 2. Phiếu thuộc sổ người gọi đang giữ tiền (cho dòng phiếu) ─────────────────

CREATE OR REPLACE FUNCTION app_private.ie_in_my_custodian_cashbook_v1(p_ie_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
BEGIN
  -- Chỉ của chính người gọi: không có danh tính thì không thấy gì; tập sổ lấy theo auth.uid() trong
  -- my_custodian_cashbook_ids_v1 (một nguồn cho luật người giữ tiền).
  RETURN auth.uid() IS NOT NULL AND EXISTS (
    SELECT 1
      FROM public.income_expenses ie
     WHERE ie.id = p_ie_id
       AND (ie.account_id IN (SELECT app_private.my_custodian_cashbook_ids_v1())
            OR ie.change_account_id IN (SELECT app_private.my_custodian_cashbook_ids_v1())
            OR ie.rounding_account_id IN (SELECT app_private.my_custodian_cashbook_ids_v1()))
  );
END
$fn$;

COMMENT ON FUNCTION app_private.ie_in_my_custodian_cashbook_v1(uuid) IS
  'Phiếu có sổ chính, sổ thối hoặc sổ làm tròn thuộc my_custodian_cashbook_ids_v1(). Nhánh mở của policy '
  'income_expense_items_restricted_select, cùng luật nhánh người giữ tiền của income_expenses_restricted_select.';

ALTER FUNCTION app_private.ie_in_my_custodian_cashbook_v1(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.ie_in_my_custodian_cashbook_v1(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app_private.ie_in_my_custodian_cashbook_v1(uuid) TO authenticated;

-- ── 3–4. Policy SELECT hạn chế: thêm nhánh người giữ tiền ─────────────────────

ALTER POLICY income_expenses_restricted_select ON public.income_expenses
  USING (
    has_restricted_item = false
    OR user_id = (SELECT auth.uid())
    OR (SELECT public.can_view_restricted_ie())
    OR account_id IN (SELECT app_private.my_custodian_cashbook_ids_v1())
    OR change_account_id IN (SELECT app_private.my_custodian_cashbook_ids_v1())
    OR rounding_account_id IN (SELECT app_private.my_custodian_cashbook_ids_v1())
  );

ALTER POLICY income_expense_items_restricted_select ON public.income_expense_items
  USING (
    public.ie_item_restricted_visible(income_expense_id)
    OR app_private.ie_in_my_custodian_cashbook_v1(income_expense_id)
  );

-- ── Nghiệm thu ────────────────────────────────────────────────────────────────

DO $nghiem_thu$
DECLARE
  v_sai text;
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM pg_policy p
        WHERE p.polrelid = 'public.income_expenses'::regclass
          AND p.polname = 'income_expenses_restricted_select'
          AND p.polcmd = 'r' AND NOT p.polpermissive
          AND p.polroles = ARRAY['authenticated'::regrole]::oid[]
          AND replace(regexp_replace(pg_get_expr(p.polqual, p.polrelid), '\s+', ' ', 'g'), 'public.', '')
              = '((has_restricted_item = false) OR (user_id = ( SELECT auth.uid() AS uid)) OR ( SELECT can_view_restricted_ie() AS can_view_restricted_ie) OR (account_id IN ( SELECT app_private.my_custodian_cashbook_ids_v1() AS my_custodian_cashbook_ids_v1)) OR (change_account_id IN ( SELECT app_private.my_custodian_cashbook_ids_v1() AS my_custodian_cashbook_ids_v1)) OR (rounding_account_id IN ( SELECT app_private.my_custodian_cashbook_ids_v1() AS my_custodian_cashbook_ids_v1)))'
     ) THEN
    RAISE EXCEPTION 'nghiem_thu: income_expenses_restricted_select chua co nhanh nguoi giu tien';
  END IF;

  IF NOT EXISTS (
       SELECT 1 FROM pg_policy p
        WHERE p.polrelid = 'public.income_expense_items'::regclass
          AND p.polname = 'income_expense_items_restricted_select'
          AND p.polcmd = 'r' AND NOT p.polpermissive
          AND p.polroles = ARRAY['authenticated'::regrole]::oid[]
          AND replace(regexp_replace(pg_get_expr(p.polqual, p.polrelid), '\s+', ' ', 'g'), 'public.', '')
              = '(ie_item_restricted_visible(income_expense_id) OR app_private.ie_in_my_custodian_cashbook_v1(income_expense_id))'
     ) THEN
    RAISE EXCEPTION 'nghiem_thu: income_expense_items_restricted_select chua co nhanh nguoi giu tien';
  END IF;

  -- Migration chỉ đổi policy SELECT: bốn policy ghi hạn chế phải còn nguyên bản cũ, đủ từng thuộc tính.
  SELECT string_agg(x.ten, ', ' ORDER BY x.ten)
    INTO v_sai
    FROM (VALUES
      ('public.income_expenses'::regclass, 'income_expenses_restricted_update', 'w',
       '((has_restricted_item = false) OR (user_id = auth.uid()) OR can_view_restricted_ie())'),
      ('public.income_expenses'::regclass, 'income_expenses_restricted_delete', 'd',
       '((has_restricted_item = false) OR (user_id = auth.uid()) OR can_view_restricted_ie())'),
      ('public.income_expense_items'::regclass, 'income_expense_items_restricted_update', 'w',
       'ie_item_restricted_visible(income_expense_id)'),
      ('public.income_expense_items'::regclass, 'income_expense_items_restricted_delete', 'd',
       'ie_item_restricted_visible(income_expense_id)')
    ) AS x(bang, ten, lenh, dieu_kien)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_policy p
      WHERE p.polrelid = x.bang
        AND p.polname = x.ten
        AND p.polcmd::text = x.lenh
        AND NOT p.polpermissive
        AND p.polroles = ARRAY['authenticated'::regrole]::oid[]
        AND p.polwithcheck IS NULL
        AND replace(regexp_replace(pg_get_expr(p.polqual, p.polrelid), '\s+', ' ', 'g'), 'public.', '')
            IS NOT DISTINCT FROM x.dieu_kien);
  IF v_sai IS NOT NULL THEN
    RAISE EXCEPTION 'nghiem_thu: policy ghi han che bi doi: %', v_sai;
  END IF;

  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text)
    INTO v_sai
    FROM pg_proc p
   WHERE p.oid = ANY (ARRAY[
           'app_private.my_custodian_cashbook_ids_v1()',
           'app_private.ie_in_my_custodian_cashbook_v1(uuid)'
         ]::regprocedure[]::oid[])
     AND NOT (p.prolang = (SELECT l.oid FROM pg_language l WHERE l.lanname = 'plpgsql')
              AND p.provolatile = 's'
              AND p.prosecdef
              AND pg_get_userbyid(p.proowner) = 'postgres'
              AND array_to_string(p.proconfig, ',') = 'search_path=pg_catalog, app_private, public'
              AND p.proacl::text = '{postgres=X/postgres,authenticated=X/postgres}');
  IF v_sai IS NOT NULL THEN
    RAISE EXCEPTION 'nghiem_thu: ham nguoi giu tien sai thuoc tinh/ACL: %', v_sai;
  END IF;
END
$nghiem_thu$;
