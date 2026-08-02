-- =====================================================================
-- BỊT NỐT PHẦN CÒN LẠI CỦA LỖ LẪN TỔ CHỨC
--
-- Sau `20260801060000` (5 hàm trang Thanh toán) và `20260801070000` (sửa gốc
-- phạm vi toà), đo lại đúng cách thì phần lớn đã sạch. Còn đúng bốn chỗ.
--
-- ─────────────────────────────────────────────────────────────────────
-- ĐÍNH CHÍNH MỘT PHÉP ĐO SAI CỦA CHÍNH TÔI — ghi lại để không ai lặp
--
-- Vòng đo đầu tôi kết luận "hợp đồng rò 340 dòng qua RLS" và "income_expense_items
-- rò 2935 dòng". SAI. Tôi có đặt `request.jwt.claims` nhưng QUÊN
-- `SET LOCAL ROLE authenticated`, nên truy vấn vẫn chạy dưới vai trò quản trị và
-- **bỏ qua RLS hoàn toàn**. Đặt JWT KHÔNG đủ để mô phỏng một phiên người dùng.
-- Đo lại đúng cách: hợp đồng 0 dòng, income_expense_items 1 dòng.
--
-- ─────────────────────────────────────────────────────────────────────
-- BỐN CHỖ CÒN LẠI
--
-- 1-3. Ba hàm báo cáo `SECURITY DEFINER` tự liệt kê toà từ `public.buildings`,
--      không đi qua `buildings_for_v3` nên bản sửa gốc không với tới:
--        • get_invoice_statistics_v2      — thẻ thống kê hoá đơn: 2106 thay vì 1053
--        • manager_collection_cycle_report — báo cáo bàn giao: 36 toà thay vì 17
--        • cashbook_settlement_report      — bảng quyết toán sổ quỹ
--      Cả ba đều nhân đôi vì org "iHome CRM (Test)" là bản sao 1:1 của org thật
--      (đo: hợp đồng 321/321, phiếu thu chi 2301/2301, hoá đơn 1101/1101).
--
-- 4.   `income_expense_items` và `contract_terminations` thiếu policy
--      `*_hide_demo_admin` — 218/284 bảng đã có, hai bảng này sót.
--
-- Org "Test" KHÔNG phải rác nên KHÔNG xoá: nó có 4 tài khoản test riêng
-- (test.nathan / test.joey / test.bosshuy / test.nguyentamca165), 66 phiếu tạo
-- mới sau khi lập, và đã được khai sẵn vào `sandbox_org_ids()` từ trước. Ai đó
-- lập nó có chủ đích — việc đúng là làm cho luật sandbox có hiệu lực, không phải
-- xoá dữ liệu của người khác.
-- =====================================================================

BEGIN;

DO $preflight$
BEGIN
  IF to_regprocedure('app_private.building_org_visible_v1(uuid)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu building_org_visible_v1 — chạy 20260801060000 trước. DỪNG.';
  END IF;
END
$preflight$;

-- ─────────────────────────────────────────────────────────────────────
-- 1. HAI POLICY CÒN SÓT — chép ĐÚNG khuôn của các bảng đã có
--
-- Khuôn gốc lấy từ `income_expenses_hide_demo_admin`:
--   NOT ((is_super_admin() OR is_admin()) AND user_id IN (SELECT unnest(demo_user_ids())))
-- `contract_terminations` KHÔNG có cột `user_id` nên nối qua hợp đồng.
-- ─────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS income_expense_items_hide_demo_admin ON public.income_expense_items;
CREATE POLICY income_expense_items_hide_demo_admin
  ON public.income_expense_items
  AS RESTRICTIVE FOR SELECT TO public
  USING (
    NOT (
      (public.is_super_admin() OR public.is_admin())
      AND EXISTS (
        SELECT 1 FROM public.income_expenses ie
         WHERE ie.id = income_expense_items.income_expense_id
           AND ie.user_id = ANY(public.demo_user_ids())
      )
    )
  );

DROP POLICY IF EXISTS contract_terminations_hide_demo_admin ON public.contract_terminations;
CREATE POLICY contract_terminations_hide_demo_admin
  ON public.contract_terminations
  AS RESTRICTIVE FOR SELECT TO public
  USING (
    NOT (
      (public.is_super_admin() OR public.is_admin())
      AND EXISTS (
        SELECT 1 FROM public.contracts c
          JOIN public.rooms r ON r.id = c.room_id
          JOIN public.buildings b ON b.id = r.building_id
         WHERE c.id = contract_terminations.contract_id
           AND b.user_id = ANY(public.demo_user_ids())
      )
    )
  );

-- ─────────────────────────────────────────────────────────────────────
-- 2. BA HÀM BÁO CÁO — chèn chốt tổ chức vào chỗ chúng liệt kê toà
--
-- Cả ba đều có mẫu `from public.buildings b` (hoặc bí danh khác) rồi lọc bằng
-- quyền. Chèn thêm một mệnh đề AND gọi `building_org_visible_v1`.
--
-- Vá theo NEO + đếm số chỗ thay; 0 chỗ = hàm đã đổi hình dạng ⇒ DỪNG, không vá mù.
-- ─────────────────────────────────────────────────────────────────────
DO $patch_reports$
DECLARE v_def text; v_new text;
BEGIN
  -- ══ 2a. get_invoice_statistics_v2 ══════════════════════════════════
  -- Hàm này ĐÃ có sẵn khối [DEMO-DOCS] hạ đặc quyền xuống "mọi toà TRỪ toà demo",
  -- nhưng danh sách đen `demo_building_ids()` chỉ phủ 1 toà và KHÔNG biết tới org
  -- sandbox. Thay danh sách đen bằng chốt hiển thị chuẩn — vừa sửa vừa gọn hơn.
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_invoice_statistics_v2';
  IF v_def IS NULL THEN RAISE EXCEPTION 'Không thấy get_invoice_statistics_v2. DỪNG.'; END IF;
  IF position('building_org_visible_v1' IN v_def) > 0 THEN
    RAISE NOTICE 'get_invoice_statistics_v2 đã vá — bỏ qua';
  ELSE
    IF position('WHERE NOT (id = ANY (public.demo_building_ids()))' IN v_def) = 0 THEN
      RAISE EXCEPTION 'get_invoice_statistics_v2: mất neo danh sách đen demo — DỪNG, không vá mù.';
    END IF;
    v_new := replace(v_def,
      'WHERE NOT (id = ANY (public.demo_building_ids()))',
      'WHERE app_private.building_org_visible_v1(id)');
    EXECUTE v_new;
    RAISE NOTICE 'ĐÃ VÁ get_invoice_statistics_v2';
  END IF;

  -- ══ 2b. manager_collection_cycle_report ════════════════════════════
  -- Có sẵn một bước "chỉ giữ toà THẬT còn tồn tại" lọc lại v_bids — chèn chốt
  -- vào đúng đó thì phủ được CẢ hai nhánh (đặc quyền và không đặc quyền).
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'manager_collection_cycle_report';
  IF v_def IS NULL THEN RAISE EXCEPTION 'Không thấy manager_collection_cycle_report. DỪNG.'; END IF;
  IF position('building_org_visible_v1' IN v_def) > 0 THEN
    RAISE NOTICE 'manager_collection_cycle_report đã vá — bỏ qua';
  ELSE
    IF position('AND NOT COALESCE(b.is_virtual, false));' IN v_def) = 0 THEN
      RAISE EXCEPTION 'manager_collection_cycle_report: mất neo lọc toà — DỪNG, không vá mù.';
    END IF;
    v_new := replace(v_def,
      'AND NOT COALESCE(b.is_virtual, false));',
      E'AND NOT COALESCE(b.is_virtual, false)
                     AND app_private.building_org_visible_v1(b.id));');
    EXECUTE v_new;
    RAISE NOTICE 'ĐÃ VÁ manager_collection_cycle_report';
  END IF;

  -- ══ 2c. cashbook_settlement_report ═════════════════════════════════
  -- Hàm này không đi qua bảng toà mà lọc SỔ QUỸ, nên chốt đặt trên accounts.
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'cashbook_settlement_report';
  IF v_def IS NULL THEN RAISE EXCEPTION 'Không thấy cashbook_settlement_report. DỪNG.'; END IF;
  IF position('ORG_ISOLATION_ACCOUNTS' IN v_def) > 0 THEN
    RAISE NOTICE 'cashbook_settlement_report đã vá — bỏ qua';
  ELSE
    IF position('AND (public.is_super_admin() OR a.user_id = auth.uid() OR public.same_team(a.user_id))' IN v_def) = 0 THEN
      RAISE EXCEPTION 'cashbook_settlement_report: mất neo quyền sổ quỹ — DỪNG, không vá mù.';
    END IF;
    v_new := replace(v_def,
      'AND (public.is_super_admin() OR a.user_id = auth.uid() OR public.same_team(a.user_id))',
      E'AND (public.is_super_admin() OR a.user_id = auth.uid() OR public.same_team(a.user_id))
      -- ORG_ISOLATION_ACCOUNTS: cùng hai luật RLS đang áp trên public.accounts.
      AND NOT (public.is_super_admin()
               AND a.organization_id = ANY(public.sandbox_org_ids()))
      AND NOT ((public.is_super_admin() OR public.is_admin())
               AND a.user_id = ANY(public.demo_user_ids()))');
    EXECUTE v_new;
    RAISE NOTICE 'ĐÃ VÁ cashbook_settlement_report';
  END IF;
END
$patch_reports$;

-- ─────────────────────────────────────────────────────────────────────
-- TỰ KIỂM
-- ─────────────────────────────────────────────────────────────────────
DO $verify$
DECLARE v_name text; v_src text;
BEGIN
  FOREACH v_name IN ARRAY ARRAY['get_invoice_statistics_v2','manager_collection_cycle_report','cashbook_settlement_report'] LOOP
    SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = v_name;
    IF v_src IS NULL THEN RAISE EXCEPTION 'Mất hàm % sau khi vá. DỪNG.', v_name; END IF;
    IF position('building_org_visible_v1' IN v_src) = 0
       AND position('ORG_ISOLATION_ACCOUNTS' IN v_src) = 0 THEN
      RAISE EXCEPTION '% chưa áp chốt tổ chức. DỪNG.', v_name;
    END IF;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
                  AND tablename='income_expense_items' AND policyname='income_expense_items_hide_demo_admin') THEN
    RAISE EXCEPTION 'Thiếu policy hide_demo cho income_expense_items. DỪNG.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
                  AND tablename='contract_terminations' AND policyname='contract_terminations_hide_demo_admin') THEN
    RAISE EXCEPTION 'Thiếu policy hide_demo cho contract_terminations. DỪNG.';
  END IF;
END
$verify$;

COMMIT;
