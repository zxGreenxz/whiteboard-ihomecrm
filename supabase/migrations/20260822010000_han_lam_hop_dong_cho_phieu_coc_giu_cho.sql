-- =============================================================================
-- HẠN PHẢI LÀM HỢP ĐỒNG cho phiếu cọc giữ chỗ
--
-- BÀI TOÁN: bản thiết kế "Quản lý Cọc — Phương án mới" (2a/2b) có nhóm việc
-- "QUÁ HẠN LÀM HỢP ĐỒNG": phiếu giữ chỗ quá ngày phải ký hợp đồng thì phòng bị
-- treo mà không ai biết. Muốn xếp được nhóm đó, hệ thống phải BIẾT mốc hạn.
--
-- HÔM NAY NÓ KHÔNG BIẾT. `CreateDepositDialog` nhét chuỗi "Giữ phòng đến
-- 28/08/2026" vào `income_expense_items.description`, chung ô với CTV và ghi
-- chú tự do. Đo trên prod 21/08/2026: **1/32** phiếu có chuỗi đó, và đúng cái
-- phiếu ấy đã CANCELLED. 23 phiếu giữ chỗ thật đang chạy không có mốc nào.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- VÌ SAO BẢNG PHỤ, KHÔNG PHẢI CỘT TRÊN `income_expenses`
--
-- Cột trên `income_expenses` là chỗ "đúng" về mặt mô hình, nhưng đường ghi vào
-- nó thì không: mọi phiếu thu/chi ra đời qua `create_income_expense_v1` —
-- 44.585 ký tự thân hàm, chữ ký 16 tham số. Thêm tham số vào đó buộc phải DROP
-- rồi dựng lại nguyên khối cái hàm mà TOÀN BỘ tiền của hệ thống đi qua (án lệ
-- overload 20260806090000: thêm tham số DEFAULT làm PostgREST gãy "function is
-- not unique", nên không có đường thêm mà không DROP).
--
-- Đổi một ô NGÀY — thứ không đụng đồng nào — mà đặt cược cả đường tạo phiếu là
-- sai tỉ lệ rủi ro. Bảng phụ khoá theo id phiếu cho đúng khả năng truy vấn ấy
-- (lọc/sắp xếp server-side, JOIN được) với bán kính ảnh hưởng bằng KHÔNG lên
-- writer phiếu.
--
-- Cái mất, nói thẳng: hạn nằm ngoài phiếu nên hai thứ có thể lệch pha nếu ai đó
-- ghi phiếu bằng đường khác. `ON DELETE CASCADE` + kiểm tư cách phiếu trong RPC
-- thu hẹp chuyện đó; nó không đóng hẳn được.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- VÌ SAO GHI QUA RPC, KHÔNG MỞ INSERT THẲNG
--
-- Bảng nằm ở `public` để FE ĐỌC được qua PostgREST dưới RLS. Nhưng mở luôn
-- INSERT/UPDATE cho `authenticated` thì bất kỳ ai trong tổ chức cũng đặt được
-- hạn cho phiếu của toà mình không có quyền — RLS chỉ biết `organization_id`
-- của DÒNG NÀY, nó không biết phiếu kia thuộc toà nào. Kiểm tư cách phiếu và
-- quyền toà phải làm ở nơi đọc được phiếu, tức trong hàm.
--
-- Vì vậy: policy chỉ mở SELECT; ghi đi `set_reservation_hold_deadline_v1`.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- KHÔNG BACKFILL, CÓ CHỦ Ý
--
-- Chỉ 1 dòng dữ liệu cũ có thể suy ra mốc, và nó thuộc phiếu đã huỷ. Viết một
-- bước backfill regex trên `description` để chuyển đúng một dòng rác là thêm
-- mã có thể sai mà không mua được gì. Phiếu cũ ở lại trạng thái "chưa đặt hạn",
-- và `buildDepositWorkQueue` xử lý trạng thái đó bằng cách KHÔNG kết luận gì —
-- không biết hạn thì không được phép nói là đã trễ.
--
-- LÙI ĐƯỢC: migration chỉ THÊM (một bảng, một hàm, các policy của chính bảng
-- đó). Không sửa, không xoá, không đụng bảng nào đang có. Lùi = DROP hai object
-- mới, dữ liệu hiện hữu không hề bị chạm.
-- =============================================================================

BEGIN;

DO $guard$
BEGIN
  IF to_regclass('public.income_expenses') IS NULL THEN
    RAISE EXCEPTION 'Thiếu public.income_expenses. DỪNG.';
  END IF;
  IF to_regclass('public.organizations') IS NULL THEN
    RAISE EXCEPTION 'Thiếu public.organizations. DỪNG.';
  END IF;
  -- Ba hàm rào biên giới phải có SẴN: policy dựng bên dưới tham chiếu chúng,
  -- thiếu một cái là bảng mới ra đời KHÔNG có biên giới tổ chức.
  IF to_regprocedure('public.my_org_ids()') IS NULL
     OR to_regprocedure('public.is_super_admin()') IS NULL
     OR to_regprocedure('public.sandbox_org_ids()') IS NULL THEN
    RAISE EXCEPTION 'Thiếu hàm rào biên giới org (my_org_ids / is_super_admin / sandbox_org_ids). DỪNG.';
  END IF;
  IF to_regprocedure('public.can_access_building(uuid)') IS NULL
     OR to_regprocedure('public.ie_all_buildings_scope(uuid)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu hàm kiểm quyền toà nhà. DỪNG.';
  END IF;
END
$guard$;

-- ---------------------------------------------------------------------------
-- 1. Bảng
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.reservation_hold_deadlines (
  -- Khoá chính LÀ id phiếu: một phiếu giữ chỗ có đúng một hạn, không hơn.
  income_expense_id uuid PRIMARY KEY
    REFERENCES public.income_expenses(id) ON DELETE CASCADE,
  organization_id   uuid        NOT NULL REFERENCES public.organizations(id),
  hold_until        date        NOT NULL,
  created_by        uuid        NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.reservation_hold_deadlines IS
  'Hạn PHẢI KÝ HỢP ĐỒNG của phiếu cọc giữ chỗ (income_expenses mồ côi). Một phiếu một hạn. Ghi qua set_reservation_hold_deadline_v1; RLS chỉ mở SELECT. Không có dòng ⇒ phiếu CHƯA đặt hạn, KHÔNG suy ra là quá hạn.';
COMMENT ON COLUMN public.reservation_hold_deadlines.hold_until IS
  'Ngày cuối cùng còn giữ phòng. Quá ngày này phiếu vào nhóm "quá hạn làm hợp đồng" trên /deposits.';
COMMENT ON COLUMN public.reservation_hold_deadlines.organization_id IS
  'Chép từ phiếu lúc ghi — để policy biên giới lọc được mà không phải JOIN sang income_expenses.';

-- Hàng đợi lọc theo hạn ⇒ index theo (org, hạn).
CREATE INDEX IF NOT EXISTS reservation_hold_deadlines_org_until_idx
  ON public.reservation_hold_deadlines (organization_id, hold_until);

-- ENABLE, KHÔNG FORCE — có chủ ý, và đã đo trước khi quyết:
--   `postgres` (vai chạy migration, tức chủ bảng và definer của writer) có
--   `rolbypassrls = true`. Với vai đó, ENABLE và FORCE cho ra hành vi GIỐNG
--   HỆT — BYPASSRLS thắng cả hai. Nên FORCE ở đây không thêm được lớp bảo vệ
--   nào; nó chỉ gợi ý một lớp bảo vệ KHÔNG tồn tại, và làm writer phụ thuộc
--   ngầm vào thuộc tính BYPASSRLS thay vì vào cơ chế chủ-bảng-vượt-RLS thông
--   thường. Mọi bảng `public` khác của CRM cũng ENABLE-không-FORCE; nhóm
--   openclaw dùng FORCE vì chúng có chủ riêng (`openclaw_function_owner`,
--   bypassrls = false) — ở đó FORCE mới có nghĩa.
ALTER TABLE public.reservation_hold_deadlines ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 2. RLS — biên giới tổ chức + che org sandbox khỏi super admin
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS reservation_hold_deadlines_org_boundary
  ON public.reservation_hold_deadlines;
CREATE POLICY reservation_hold_deadlines_org_boundary
  ON public.reservation_hold_deadlines
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_super_admin())
         OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK ((SELECT public.is_super_admin())
              OR organization_id IN (SELECT unnest(public.my_org_ids())));

-- Bắt buộc theo Contract §5 cho mọi bảng mới có organization_id: super admin
-- KHÔNG được nhìn thấy dữ liệu của org sandbox lẫn vào sổ thật.
DROP POLICY IF EXISTS reservation_hold_deadlines_hide_sandbox_admin
  ON public.reservation_hold_deadlines;
CREATE POLICY reservation_hold_deadlines_hide_sandbox_admin
  ON public.reservation_hold_deadlines
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (NOT ((SELECT public.is_super_admin())
              AND COALESCE(organization_id = ANY (public.sandbox_org_ids()), false)))
  WITH CHECK (NOT ((SELECT public.is_super_admin())
                   AND COALESCE(organization_id = ANY (public.sandbox_org_ids()), false)));

-- PERMISSIVE: chỉ ĐỌC. Không có policy ghi nào ⇒ INSERT/UPDATE/DELETE trực tiếp
-- bị RLS chặn kể cả khi ai đó lỡ GRANT quyền bảng. Đường ghi duy nhất là RPC
-- (SECURITY DEFINER, không đi qua RLS của caller).
DROP POLICY IF EXISTS reservation_hold_deadlines_select
  ON public.reservation_hold_deadlines;
CREATE POLICY reservation_hold_deadlines_select
  ON public.reservation_hold_deadlines
  FOR SELECT TO authenticated
  USING (true);

REVOKE ALL ON TABLE public.reservation_hold_deadlines FROM PUBLIC, anon;
GRANT SELECT ON TABLE public.reservation_hold_deadlines TO authenticated;
GRANT ALL    ON TABLE public.reservation_hold_deadlines TO service_role;

-- ---------------------------------------------------------------------------
-- 3. Writer
--    p_hold_until NULL ⇒ XOÁ hạn (người dùng bỏ mốc), không phải lỗi.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_reservation_hold_deadline_v1(
  p_income_expense_id uuid,
  p_hold_until        date DEFAULT NULL::date
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE                       -- lấy khoá dòng ⇒ KHÔNG được STABLE (Contract §5)
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_ie    public.income_expenses;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_ie FROM public.income_expenses
   WHERE id = p_income_expense_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Không tìm thấy phiếu cọc' USING ERRCODE = 'P0002';
  END IF;

  -- Tư cách phiếu: đúng loại phiếu mà hạn này có nghĩa. Phiếu đã gắn hợp đồng
  -- thì việc "phải làm hợp đồng" đã xong — đặt hạn cho nó là vô nghĩa.
  IF v_ie.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Phiếu đã xoá' USING ERRCODE = '55000';
  END IF;
  IF v_ie.type IS DISTINCT FROM 'INCOME' THEN
    RAISE EXCEPTION 'Chỉ đặt hạn cho phiếu THU cọc giữ chỗ' USING ERRCODE = '22023';
  END IF;
  IF v_ie.contract_id IS NOT NULL THEN
    RAISE EXCEPTION 'Phiếu đã gắn hợp đồng — không còn hạn làm hợp đồng'
      USING ERRCODE = '55000';
  END IF;

  -- Quyền toà — cùng luật với create_sale_bonus_from_deposit_v1.
  IF NOT (public.can_access_building(v_ie.building_id)
          OR public.ie_all_buildings_scope(v_ie.building_id)
          OR public.is_admin() OR public.is_super_admin()) THEN
    RAISE EXCEPTION 'Bạn không có quyền trên toà của phiếu này' USING ERRCODE = '42501';
  END IF;

  IF p_hold_until IS NULL THEN
    DELETE FROM public.reservation_hold_deadlines
     WHERE income_expense_id = p_income_expense_id;
    RETURN jsonb_build_object('incomeExpenseId', p_income_expense_id, 'holdUntil', NULL);
  END IF;

  -- Hạn trước ngày lập phiếu là ĐÃ TRỄ NGAY LÚC TẠO — gần như chắc chắn gõ
  -- nhầm, và nó sinh ra một thẻ đỏ giả trên bàn xử lý.
  IF p_hold_until < v_ie.voucher_date THEN
    RAISE EXCEPTION 'Hạn làm hợp đồng (%) không được trước ngày lập phiếu (%)',
      p_hold_until, v_ie.voucher_date USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.reservation_hold_deadlines
    (income_expense_id, organization_id, hold_until, created_by)
  VALUES (p_income_expense_id, v_ie.organization_id, p_hold_until, v_actor)
  ON CONFLICT (income_expense_id) DO UPDATE
    SET hold_until = EXCLUDED.hold_until,
        updated_at = now();

  RETURN jsonb_build_object(
    'incomeExpenseId', p_income_expense_id,
    'holdUntil', p_hold_until);
END;
$fn$;

REVOKE ALL ON FUNCTION public.set_reservation_hold_deadline_v1(uuid, date)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_reservation_hold_deadline_v1(uuid, date)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.set_reservation_hold_deadline_v1(uuid, date) IS
  'Đặt/đổi/xoá (NULL) hạn phải ký hợp đồng của một phiếu cọc giữ chỗ. Kiểm tư cách phiếu (THU, chưa gắn HĐ, chưa xoá) và quyền toà. Đường ghi DUY NHẤT vào reservation_hold_deadlines.';

-- ---------------------------------------------------------------------------
-- TỰ KIỂM
-- ---------------------------------------------------------------------------
DO $tk$
DECLARE v_n int;
BEGIN
  IF to_regclass('public.reservation_hold_deadlines') IS NULL THEN
    RAISE EXCEPTION 'Bảng không tồn tại. DỪNG.';
  END IF;
  IF to_regprocedure('public.set_reservation_hold_deadline_v1(uuid,date)') IS NULL THEN
    RAISE EXCEPTION 'Writer không tồn tại. DỪNG.';
  END IF;

  SELECT count(*) INTO v_n FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'reservation_hold_deadlines'
     AND c.relrowsecurity;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'RLS chưa bật trên bảng mới. DỪNG.';
  END IF;

  -- Writer phải vào được bảng: chủ bảng và definer của hàm phải là CÙNG một
  -- vai, nếu không thì đường ghi duy nhất bị chính RLS của bảng chặn — và
  -- chuyện đó chỉ lộ ra lúc người dùng thật bấm lưu, không lộ ở DDL.
  SELECT count(*) INTO v_n
    FROM pg_class c, pg_proc p
   WHERE c.oid = to_regclass('public.reservation_hold_deadlines')
     AND p.oid = to_regprocedure('public.set_reservation_hold_deadline_v1(uuid,date)')
     AND c.relowner = p.proowner;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'Chủ bảng khác definer của writer ⇒ RLS sẽ chặn đường ghi duy nhất. DỪNG.';
  END IF;

  SELECT count(*) INTO v_n FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'reservation_hold_deadlines'
     AND policyname = 'reservation_hold_deadlines_org_boundary' AND permissive = 'RESTRICTIVE';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'Thiếu policy biên giới tổ chức (RESTRICTIVE). DỪNG.';
  END IF;

  SELECT count(*) INTO v_n FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'reservation_hold_deadlines'
     AND policyname = 'reservation_hold_deadlines_hide_sandbox_admin';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'Thiếu policy che org sandbox (Contract §5). DỪNG.';
  END IF;

  -- Không được có policy ghi nào: đường ghi phải đi qua RPC.
  SELECT count(*) INTO v_n FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'reservation_hold_deadlines'
     AND permissive = 'PERMISSIVE' AND cmd <> 'SELECT';
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'Có policy ghi trực tiếp ⇒ bỏ qua kiểm quyền toà của RPC. DỪNG.';
  END IF;

  IF (SELECT provolatile FROM pg_proc
       WHERE oid = to_regprocedure('public.set_reservation_hold_deadline_v1(uuid,date)')) <> 'v' THEN
    RAISE EXCEPTION 'Writer lấy khoá dòng mà không VOLATILE ⇒ PostgREST ném 25006. DỪNG.';
  END IF;

  IF has_function_privilege('anon',
       'public.set_reservation_hold_deadline_v1(uuid,date)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon còn EXECUTE trên writer. DỪNG.';
  END IF;
  IF has_table_privilege('anon', 'public.reservation_hold_deadlines', 'SELECT') THEN
    RAISE EXCEPTION 'anon còn SELECT trên bảng. DỪNG.';
  END IF;
END
$tk$;

COMMIT;

NOTIFY pgrst, 'reload schema';
