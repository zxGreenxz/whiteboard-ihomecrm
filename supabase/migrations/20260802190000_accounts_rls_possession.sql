-- QUYỀN NHÌN SỔ QUỸ CHUYỂN SANG POSSESSION (mắt xích cuối của cutover 19/07)
--
-- Trước bản này, ai thấy sổ nào do bảng CŨ `account_shared_users` quyết định,
-- nên tick CUSTODIAN/KNOWER trong dialog "Cập nhật sổ quỹ" (ghi vào
-- `cashbook_possession_bindings` qua set_cashbook_access_v2) không hề có tác
-- dụng lên màn thu tiền. Sau bản này possession là NGUỒN SỰ THẬT DUY NHẤT.
--
-- Yêu cầu: chạy SAU 20260802180000 (backfill). Cửa chặn đã đo trên prod trước
-- khi viết: giả lập RLS 15/15 thành viên của cả 3 org — không ai mất sổ nào.
--
-- ⚠ KHÔNG bọc BEGIN/COMMIT khi áp qua Management API (án lệ "object biến mất
-- sau khi apply"). Luôn kiểm lại catalog sau khi apply.

-- ── 1. Set-based resolver ────────────────────────────────────────────────────
-- Set-based (trả setof) theo đúng tiền lệ accessible_account_ids(): policy gọi
-- MỘT lần rồi hash-join, thay vì gọi hàm trên từng dòng như
-- is_account_shared_with_me(id).
--
-- ⚠ TUYỆT ĐỐI KHÔNG dùng `SELECT … FOR SHARE` trong thân hàm này. Án lệ 25006
-- (CLAUDE.md, đã cắn 5 lần): PostgREST chạy hàm STABLE trong transaction READ
-- ONLY, nên khoá dòng ném 25006 — gọi bằng SQL thì XANH, gọi từ trình duyệt thì
-- HỎNG, loại lỗi sống rất lâu mà không ai thấy.
--
-- Lấy MỌI possession_kind: CUSTODIAN (giữ tiền), OPERATOR, và KNOWER ("được xem
-- sổ quỹ và số dư"). Đúng chữ trong dialog — KNOWER là quyền XEM, mà đây là
-- policy SELECT. Ranh giới được/không-được Thu-Chi do writer canh bằng
-- assert_cashbook_access_v2, không phải bằng cách giấu sổ khỏi danh sách.
CREATE OR REPLACE FUNCTION app_private.my_possessed_cashbook_ids_v1()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
  SELECT b.cashbook_id
  FROM public.cashbook_possession_bindings b
  JOIN public.organization_memberships m ON m.id = b.membership_id
  WHERE m.user_id = auth.uid()
    AND m.status = 'ACTIVE'
    AND b.valid_from <= now()
    AND (b.valid_to IS NULL OR b.valid_to > now());
$fn$;

REVOKE ALL ON FUNCTION app_private.my_possessed_cashbook_ids_v1() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.my_possessed_cashbook_ids_v1() TO authenticated;

-- ── 2. Thay policy đọc ───────────────────────────────────────────────────────
-- `accounts_select` (chủ sổ) GIỮ NGUYÊN — chủ sổ luôn thấy sổ của mình kể cả khi
-- binding chưa kịp cấp. Hai policy RESTRICTIVE ẩn demo/sandbox cũng giữ nguyên.
DROP POLICY IF EXISTS accounts_select_shared ON public.accounts;

CREATE POLICY accounts_select_possession ON public.accounts
  FOR SELECT
  USING (id IN (SELECT app_private.my_possessed_cashbook_ids_v1()));

-- ── 3. Quyền xem TỒN QUỸ cũng bỏ nhánh legacy ────────────────────────────────
-- Bản cũ (20260730101000) là hợp nhất hai hệ: super_admin ∪ chủ sổ ∪
-- is_account_shared_with_me ∪ CUSTODIAN. Bỏ nhánh legacy, và thêm KNOWER bên
-- cạnh CUSTODIAN — "Người biết sổ" theo đúng định nghĩa là được xem số dư.
CREATE OR REPLACE FUNCTION app_private.ie_visible_cashbook_ids_v1()
 RETURNS TABLE(cashbook_id uuid)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $function$
  SELECT a.id
  FROM public.accounts a
  WHERE a.deleted_at IS NULL
    AND a.organization_id = ANY (public.my_org_ids())
    AND (
      public.is_super_admin()
      OR a.user_id = auth.uid()
      OR a.id IN (SELECT app_private.my_possessed_cashbook_ids_v1())
    );
$function$;
