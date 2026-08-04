-- =====================================================================
-- BỎ DUYỆT PHẢI ĐẶT LẠI review_state — nếu không phiếu KẸT VĨNH VIỄN
--
-- Sự việc: phiếu PC2607005 ("Hoa hồng môi giới HĐ HD-2026-00025", 2.730.000đ,
-- toà 102LVT) được duyệt 25/07 ⇒ review_state='RESOLVED'. Sáng 30/07 chủ bấm
-- "Huỷ duyệt (chuyển về Chờ duyệt)" ⇒ approval_status về 'UNAPPROVED' nhưng
-- review_state VẪN 'RESOLVED'. Cổng duyệt V2 đòi:
--     approval_status = 'UNAPPROVED' AND review_state IN ('PENDING','CHANGES_REQUESTED')
-- nên phiếu rơi vào cặp bất khả: CHƯA DUYỆT mà ĐÃ KẾT LUẬN — bấm Duyệt là
-- 55000 mãi mãi (log Postgres đếm được 18 lần bấm trong một buổi).
--
-- Đây là LỖI CÓ SẴN, không phải do các migration 30/07: không file 2026073*.sql
-- nào đụng approve_income_expense_v2 hay unapprove_voucher; cổng review_state
-- lên prod từ 20260723050000 (23/07) còn unapprove_voucher chốt từ 03/07.
--
-- Trong toàn DB có ĐÚNG BA writer đặt được approval_status='UNAPPROVED', và cả
-- ba đều quên review_state. Vá thiếu một cái là bệnh quay lại theo đường khác:
--   1. unapprove_voucher(uuid)                  — nút "Huỷ duyệt" trên UI
--   2. set_termination_forfeit_status_v1        — đường thanh lý/tịch thu cọc
--   3. trg_forfeit_settle_on_approve            — trigger lan trạng thái sang
--                                                 CHÂN ĐỐI ỨNG của cặp thanh lý
--                                                 (writer DUY NHẤT đưa
--                                                 offset_voucher_id về UNAPPROVED)
--
-- ⚠ Vùng phơi nhiễm đo được: 2.013 phiếu APPROVED không flow-owned đang cách
--   trạng thái kẹt đúng MỘT cú bấm "Huỷ duyệt".
--
-- ĐÃ KIỂM TAY TRƯỚC KHI VIẾT (đừng tin lại, nhưng cũng đừng phải đo lại):
--   • guard_income_expense_owned_payload có review_state / review_version /
--     review_reason TRONG DANH SÁCH TRẮNG (cả hai mảng) ⇒ vá này qua được guard.
--     Ngược lại change_field_mask / review_deadline / review_owner_membership_id
--     KHÔNG có trong danh sách trắng — TUYỆT ĐỐI đừng đặt chúng ở đây.
--   • review_version PHẢI tăng: approve_income_expense_v2 chỉ tăng
--     approval_version, không chạm review_version. Không tăng ở đường bỏ duyệt
--     là để hở lỗ ABA (client giữ ảnh chụp review_version từ TRƯỚC lần duyệt
--     vẫn "hợp lệ" sau khi bỏ duyệt).
--   • approval_version KHÔNG tăng: hàm hiện tại không tăng, nên
--     expectedApprovalVersion phía FE còn khớp và nút Duyệt bấm được NGAY sau
--     khi Huỷ duyệt. Tăng nó sẽ phá CAS của cú bấm kế tiếp nếu FE chưa refetch.
--   • Thân hàm trên prod LỆCH file migration (unapprove_voucher có
--     assert_no_engine_request_v1 và comment t5_26 không tồn tại trong repo).
--     Vì vậy vá bằng pg_get_functiondef + replace + neo, KHÔNG chép từ file.
-- =====================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────
-- 1. unapprove_voucher — nút "Huỷ duyệt" trên UI
-- ─────────────────────────────────────────────────────────────────────
DO $patch$
DECLARE
  v_def text;
  v_anchor text :=
    '    approval_status = ''UNAPPROVED'',' || chr(10) ||
    '    approved_by = NULL,' || chr(10) ||
    '    approved_at = NULL' || chr(10) ||
    '  WHERE ie.id = voucher_id';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'unapprove_voucher';
  IF v_def IS NULL THEN RAISE EXCEPTION 'Không có unapprove_voucher'; END IF;

  IF position('review_state' IN v_def) > 0 THEN
    RAISE NOTICE 'unapprove_voucher đã đặt lại review_state — bỏ qua'; RETURN;
  END IF;
  IF position(v_anchor IN v_def) = 0 THEN
    RAISE EXCEPTION 'Không khớp mẫu neo trong unapprove_voucher — DỪNG, không vá mù';
  END IF;

  v_def := replace(v_def, v_anchor,
    '    approval_status = ''UNAPPROVED'',' || chr(10) ||
    '    approved_by = NULL,' || chr(10) ||
    '    approved_at = NULL,' || chr(10) ||
    '    -- Trả phiếu về ĐÚNG đầu quy trình duyệt. Thiếu ba dòng này thì phiếu' || chr(10) ||
    '    -- kẹt ở (UNAPPROVED, RESOLVED) và approve_income_expense_v2 từ chối' || chr(10) ||
    '    -- vĩnh viễn — không đường nào cứu được từ giao diện.' || chr(10) ||
    '    review_state = ''PENDING'',' || chr(10) ||
    '    review_version = ie.review_version + 1,' || chr(10) ||
    '    review_reason = NULL,' || chr(10) ||
    '    updated_at = now()' || chr(10) ||
    '  WHERE ie.id = voucher_id');

  IF position('review_state = ''PENDING''' IN v_def) = 0 THEN
    RAISE EXCEPTION 'Vá unapprove_voucher thất bại';
  END IF;
  EXECUTE v_def;
  RAISE NOTICE 'unapprove_voucher: đã đặt lại review_state=PENDING';
END
$patch$;

-- ─────────────────────────────────────────────────────────────────────
-- 2. set_termination_forfeit_status_v1 — đường thanh lý / tịch thu cọc
--    Hàm này tự chèn token nên đi qua guard sẵn.
-- ─────────────────────────────────────────────────────────────────────
DO $patch$
DECLARE
  v_def text;
  v_anchor text :=
    '           approved_at = CASE' || chr(10) ||
    '             WHEN upper(p_status) = ''APPROVED'' THEN now()' || chr(10) ||
    '             ELSE NULL' || chr(10) ||
    '           END,' || chr(10) ||
    '           updated_at = now()';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'set_termination_forfeit_status_v1';
  IF v_def IS NULL THEN RAISE EXCEPTION 'Không có set_termination_forfeit_status_v1'; END IF;

  IF position('review_state' IN v_def) > 0 THEN
    RAISE NOTICE 'set_termination_forfeit_status_v1 đã đặt review_state — bỏ qua'; RETURN;
  END IF;
  IF position(v_anchor IN v_def) = 0 THEN
    RAISE EXCEPTION 'Không khớp mẫu neo trong set_termination_forfeit_status_v1 — DỪNG';
  END IF;

  v_def := replace(v_def, v_anchor,
    '           approved_at = CASE' || chr(10) ||
    '             WHEN upper(p_status) = ''APPROVED'' THEN now()' || chr(10) ||
    '             ELSE NULL' || chr(10) ||
    '           END,' || chr(10) ||
    '           -- Cùng luật với nút Huỷ duyệt: hạ về UNAPPROVED thì phải mở lại' || chr(10) ||
    '           -- vòng duyệt, không thì phiếu thanh lý kẹt y hệt PC2607005.' || chr(10) ||
    '           review_state = CASE' || chr(10) ||
    '             WHEN upper(p_status) = ''UNAPPROVED'' THEN ''PENDING''' || chr(10) ||
    '             ELSE ''RESOLVED''' || chr(10) ||
    '           END,' || chr(10) ||
    '           review_version = voucher.review_version + 1,' || chr(10) ||
    '           updated_at = now()');

  IF position('review_state = CASE' IN v_def) = 0 THEN
    RAISE EXCEPTION 'Vá set_termination_forfeit_status_v1 thất bại';
  END IF;
  EXECUTE v_def;
  RAISE NOTICE 'set_termination_forfeit_status_v1: đã đặt review_state theo trạng thái';
END
$patch$;

-- ─────────────────────────────────────────────────────────────────────
-- 3. trg_forfeit_settle_on_approve — lan trạng thái sang CHÂN ĐỐI ỨNG
--    Writer DUY NHẤT đưa offset_voucher_id về UNAPPROVED. Bỏ qua nó là vá
--    thiếu: chân kia vẫn kẹt.
-- ─────────────────────────────────────────────────────────────────────
DO $patch$
DECLARE
  v_def text;
  v_anchor text :=
    '         SET approval_status = NEW.approval_status,' || chr(10) ||
    '             approved_by = NULL,' || chr(10) ||
    '             approved_at = NULL,' || chr(10) ||
    '             updated_at = now()';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'trg_forfeit_settle_on_approve';
  IF v_def IS NULL THEN RAISE EXCEPTION 'Không có trg_forfeit_settle_on_approve'; END IF;

  IF position('review_state' IN v_def) > 0 THEN
    RAISE NOTICE 'trg_forfeit_settle_on_approve đã đặt review_state — bỏ qua'; RETURN;
  END IF;
  IF position(v_anchor IN v_def) = 0 THEN
    RAISE EXCEPTION 'Không khớp mẫu neo trong trg_forfeit_settle_on_approve — DỪNG';
  END IF;

  v_def := replace(v_def, v_anchor,
    '         SET approval_status = NEW.approval_status,' || chr(10) ||
    '             approved_by = NULL,' || chr(10) ||
    '             approved_at = NULL,' || chr(10) ||
    '             -- Chân đối ứng phải theo cùng luật, nếu không nó kẹt một mình.' || chr(10) ||
    '             review_state = CASE' || chr(10) ||
    '               WHEN NEW.approval_status = ''UNAPPROVED'' THEN ''PENDING''' || chr(10) ||
    '               ELSE ''RESOLVED''' || chr(10) ||
    '             END,' || chr(10) ||
    '             review_version = income_expenses.review_version + 1,' || chr(10) ||
    '             updated_at = now()');

  IF position('review_state = CASE' IN v_def) = 0 THEN
    RAISE EXCEPTION 'Vá trg_forfeit_settle_on_approve thất bại';
  END IF;
  EXECUTE v_def;
  RAISE NOTICE 'trg_forfeit_settle_on_approve: chân đối ứng cũng mở lại vòng duyệt';
END
$patch$;

-- ─────────────────────────────────────────────────────────────────────
-- 4. GIẢI KẸT các phiếu đã lỡ rơi vào trạng thái bất khả
--
-- Đo được 5 phiếu còn sống:
--   • PC2607005 (org THẬT)  — RESOLVED, KHÔNG flow-owned ⇒ UPDATE trần chạy được
--   • 4 phiếu DEMO          — review_state NULL, flow-owned ⇒ guard đóng băng
--     chặn cả vai postgres (đã đo: 55000 "is frozen"), phải chèn token cho
--     chính transaction này. Bốn phiếu này là lỗ backfill cũ từ 19/07, KHÁC
--     nguyên nhân với PC2607005, nhưng cùng hậu quả nên dọn luôn.
--
-- Dùng purpose FINANCE_V2_LIFECYCLE để cầu a85 tự tắt — bản vá này chỉ đụng
-- trạng thái duyệt, không đụng đồng nào, không được để cầu sinh bút toán.
-- KHÔNG xoá phiếu: chúng là dữ liệu thật của org DEMO, sửa trạng thái là đủ.
-- ─────────────────────────────────────────────────────────────────────
DO $fix$
DECLARE
  v_id uuid;
  v_n int := 0;
BEGIN
  FOR v_id IN
    SELECT ie.id FROM public.income_expenses ie
    WHERE ie.deleted_at IS NULL
      AND ie.approval_status = 'UNAPPROVED'
      AND COALESCE(ie.review_state, '') NOT IN ('PENDING', 'CHANGES_REQUESTED')
  LOOP
    INSERT INTO app_private.ie_transition_authorization (income_expense_id, xid, purpose)
    VALUES (v_id, pg_current_xact_id(), 'FINANCE_V2_LIFECYCLE')
    ON CONFLICT DO NOTHING;

    UPDATE public.income_expenses
       SET review_state = 'PENDING',
           review_version = review_version + 1,
           updated_at = now()
     WHERE id = v_id;
    v_n := v_n + 1;
  END LOOP;
  RAISE NOTICE 'Đã giải kẹt % phiếu', v_n;

  DELETE FROM app_private.ie_transition_authorization
   WHERE xid = pg_current_xact_id() AND purpose = 'FINANCE_V2_LIFECYCLE';
END
$fix$;

-- ─────────────────────────────────────────────────────────────────────
-- 5. BẤT BIẾN để bệnh không tái phát bằng đường khác
--
-- Hiện review_state là text nullable tự do: không enum, không domain, không
-- default, 0 CHECK. Bất biến duy nhất đang có là trigger a001 chạy
-- BEFORE INSERT và CHỈ khi review_state IS NULL ⇒ vô hiệu hoàn toàn với UPDATE.
-- Đúng vì thế mà cả NULL lẫn RESOLVED lọt được vào phiếu UNAPPROVED.
--
-- Đặt SAU mục 1–3, nếu không hai writer thanh lý sẽ bung lỗi ngay khi ghi.
-- Phiếu đã xoá mềm được miễn (PC2607012 mất birth provenance, không cứu được).
-- ─────────────────────────────────────────────────────────────────────
ALTER TABLE public.income_expenses
  DROP CONSTRAINT IF EXISTS ie_unapproved_review_state_ck;

ALTER TABLE public.income_expenses
  ADD CONSTRAINT ie_unapproved_review_state_ck
  CHECK (
    deleted_at IS NOT NULL
    OR approval_status IS DISTINCT FROM 'UNAPPROVED'
    OR review_state IN ('PENDING', 'CHANGES_REQUESTED', 'DISPUTED')
  ) NOT VALID;

ALTER TABLE public.income_expenses
  VALIDATE CONSTRAINT ie_unapproved_review_state_ck;

-- Tự kiểm: không còn phiếu sống nào kẹt.
DO $verify$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM public.income_expenses ie
  WHERE ie.deleted_at IS NULL AND ie.approval_status = 'UNAPPROVED'
    AND COALESCE(ie.review_state, '') NOT IN ('PENDING', 'CHANGES_REQUESTED');
  IF v_n > 0 THEN
    RAISE EXCEPTION 'Còn % phiếu kẹt sau khi vá', v_n;
  END IF;
  RAISE NOTICE 'Xanh: 0 phiếu kẹt, ràng buộc đã VALIDATE';
END
$verify$;

COMMIT;

NOTIFY pgrst, 'reload schema';
