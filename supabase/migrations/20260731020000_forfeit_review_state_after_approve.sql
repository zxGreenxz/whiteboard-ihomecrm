-- =====================================================================
-- THANH LÝ BỎ CỌC HỎNG TOÀN BỘ: writer tự đặt (UNAPPROVED, RESOLVED)
--
-- Sự việc (30/07, tái hiện được 100%): bấm "Thanh lý — Khách bỏ cọc" trên
-- HĐ có cọc đã thu > 0 ⇒ POST /rpc/terminate_contract_forfeit trả 400
--     23514  new row for relation "income_expenses" violates check
--            constraint "ie_unapproved_review_state_ck"
-- Không phải lỗi phân quyền, không phải lỗi dữ liệu của HĐ nào cụ thể:
-- tái hiện trên HD-2026-00009 (org DEMO, cọc 4.000.000đ) cũng đúng lỗi này.
--
-- NGUYÊN NHÂN — hai bản vá đúng riêng lẻ, đụng nhau:
--   • 20260725010000 (25/07) cho cặp bút toán bỏ cọc TỰ DUYỆT. Vì registrar
--     a05 chỉ nhận hình dạng UNAPPROVED lúc INSERT, writer buộc phải đi 2
--     nhịp: INSERT UNAPPROVED → UPDATE lên APPROVED. Nhịp giữa nó "đóng dấu
--     bản chất" gồm luôn review_state='RESOLVED' — tức trong khoảnh khắc đó
--     cả 2 chân đang ở cặp (UNAPPROVED, RESOLVED).
--   • 20260730290000 (30/07) thêm ie_unapproved_review_state_ck để chặn ĐÚNG
--     cặp đó — vì (UNAPPROVED, RESOLVED) là trạng thái phiếu KẸT VĨNH VIỄN.
--     Migration đó rà 3 writer đặt approval_status='UNAPPROVED' nhưng bỏ sót
--     writer thanh lý: nó không "đặt UNAPPROVED", nó đặt RESOLVED ĐÈ LÊN một
--     phiếu đang UNAPPROVED. Cùng cặp bị cấm, khác đường đi.
--
-- Ràng buộc là ĐÚNG, phải giữ. Sửa writer: review_state đi CÙNG cú duyệt,
-- không đi trước. Sau vá, không thời điểm nào phiếu ở (UNAPPROVED, RESOLVED):
--   - INSERT: a001_ie_lifecycle_normalize tự đặt review_state='PENDING'
--             (vì approval_status='UNAPPROVED') → hợp lệ.
--   - Nhịp đóng dấu: chỉ posting_mode/posting_status → không đụng cặp.
--   - Nhịp duyệt: approval_status='APPROVED' + review_state='RESOLVED' trong
--     CÙNG một câu lệnh → hàng mới hợp lệ.
--   - Chân đối ứng: cascade trg_forfeit_settle_on_approve đưa lên APPROVED.
--
-- ⚠ ĐO ĐƯỢC KHI DRY-RUN (đừng tin lại lời hứa của 20260730290000): bản vá
-- review_state cho cascade chỉ nằm ở nhánh ĐẢO duyệt (nhánh đặt
-- approved_by = NULL). Nhánh DUYỆT không chạm review_state, nên chân đối ứng
-- kết thúc ở (APPROVED, PENDING) — không vi phạm ràng buộc nhưng lệch với
-- hành vi trước 30/07 (cả 2 chân đều RESOLVED) và để lại phiếu "đã duyệt mà
-- vòng review còn treo". Vá luôn nhánh duyệt của cascade ở mục 2.
--
-- ĐÃ KIỂM TRƯỚC KHI VIẾT:
--   • guard_income_expense_owned_payload có review_state + review_version
--     trong CẢ HAI mảng allowlist ⇒ qua được cửa đóng băng.
--   • Token ie_transition_authorization cho v_thu_id đã có sẵn ngay trên cú
--     duyệt (writer tự chèn từ 20260725010000) ⇒ không cần thêm token.
--   • review_version PHẢI tăng, cùng lý do ABA đã ghi ở 20260730290000.
--   • Thân hàm prod là nguồn sự thật (nhiều lớp CREATE OR REPLACE) nên vá
--     bằng pg_get_functiondef + replace + neo, KHÔNG chép từ file migration.
-- =====================================================================

BEGIN;

DO $patch$
DECLARE
  v_def text;
  v_anchor_stamp text :=
    '    UPDATE public.income_expenses' || chr(10) ||
    '       SET posting_mode   = ''NON_CASH'',' || chr(10) ||
    '           posting_status = ''NOT_APPLICABLE'',' || chr(10) ||
    '           review_state   = ''RESOLVED''' || chr(10) ||
    '     WHERE id IN (v_chi_id, v_thu_id);';
  v_anchor_approve text :=
    '    UPDATE public.income_expenses' || chr(10) ||
    '       SET approval_status = ''APPROVED'',' || chr(10) ||
    '           approved_by     = COALESCE(auth.uid(), v_contract.user_id),' || chr(10) ||
    '           approved_at     = now()' || chr(10) ||
    '     WHERE id = v_thu_id;';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'terminate_contract_forfeit_impl';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'Không có terminate_contract_forfeit_impl';
  END IF;

  IF position('7b1: review_state đi CÙNG cú duyệt' IN v_def) > 0 THEN
    RAISE NOTICE 'forfeit review_state: đã vá trước đó — bỏ qua';
    RETURN;
  END IF;
  IF position(v_anchor_stamp IN v_def) = 0 THEN
    RAISE EXCEPTION 'Không khớp neo "đóng dấu bản chất" — DỪNG, không vá mù';
  END IF;
  IF position(v_anchor_approve IN v_def) = 0 THEN
    RAISE EXCEPTION 'Không khớp neo "cú duyệt" — DỪNG, không vá mù';
  END IF;

  -- (1) Bỏ review_state khỏi nhịp đóng dấu: lúc này phiếu còn UNAPPROVED.
  v_def := replace(v_def, v_anchor_stamp,
    '    -- 7b1: review_state đi CÙNG cú duyệt, KHÔNG đi trước. Ở nhịp này cả 2' || chr(10) ||
    '    -- chân còn UNAPPROVED, mà ie_unapproved_review_state_ck cấm cặp' || chr(10) ||
    '    -- (UNAPPROVED, RESOLVED) — đặt ở đây là 23514, chặn cứng thanh lý.' || chr(10) ||
    '    UPDATE public.income_expenses' || chr(10) ||
    '       SET posting_mode   = ''NON_CASH'',' || chr(10) ||
    '           posting_status = ''NOT_APPLICABLE''' || chr(10) ||
    '     WHERE id IN (v_chi_id, v_thu_id);');

  -- (2) Kết luận vòng duyệt trong CÙNG câu lệnh đặt APPROVED. Chân đối ứng do
  --     cascade trg_forfeit_settle_on_approve đặt RESOLVED.
  v_def := replace(v_def, v_anchor_approve,
    '    UPDATE public.income_expenses' || chr(10) ||
    '       SET approval_status = ''APPROVED'',' || chr(10) ||
    '           approved_by     = COALESCE(auth.uid(), v_contract.user_id),' || chr(10) ||
    '           approved_at     = now(),' || chr(10) ||
    '           review_state    = ''RESOLVED'',' || chr(10) ||
    '           review_version  = income_expenses.review_version + 1' || chr(10) ||
    '     WHERE id = v_thu_id;');

  IF position('7b1: review_state đi CÙNG cú duyệt' IN v_def) = 0
     OR position('review_state    = ''RESOLVED''' IN v_def) = 0 THEN
    RAISE EXCEPTION 'Vá terminate_contract_forfeit_impl thất bại';
  END IF;

  EXECUTE v_def;
  RAISE NOTICE 'terminate_contract_forfeit_impl: review_state đã dời về cú duyệt';
END
$patch$;

-- ─────────────────────────────────────────────────────────────────────
-- 2. trg_forfeit_settle_on_approve — NHÁNH DUYỆT cũng phải kết luận review
--    của chân đối ứng. 20260730290000 chỉ vá nhánh ĐẢO duyệt.
-- ─────────────────────────────────────────────────────────────────────
DO $patch$
DECLARE
  v_def text;
  v_anchor text :=
    '      UPDATE public.income_expenses' || chr(10) ||
    '         SET approval_status = ''APPROVED'',' || chr(10) ||
    '             approved_by = NEW.approved_by,' || chr(10) ||
    '             approved_at = NEW.approved_at,' || chr(10) ||
    '             updated_at = now()';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'trg_forfeit_settle_on_approve';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'Không có trg_forfeit_settle_on_approve';
  END IF;

  IF position('7b1: nhánh duyệt cũng chốt review' IN v_def) > 0 THEN
    RAISE NOTICE 'cascade nhánh duyệt: đã vá trước đó — bỏ qua';
    RETURN;
  END IF;
  IF position(v_anchor IN v_def) = 0 THEN
    RAISE EXCEPTION 'Không khớp neo nhánh duyệt của cascade — DỪNG';
  END IF;

  v_def := replace(v_def, v_anchor,
    '      -- 7b1: nhánh duyệt cũng chốt review của chân đối ứng, nếu không nó' || chr(10) ||
    '      -- ở lại (APPROVED, PENDING) — đã duyệt mà vòng review còn treo.' || chr(10) ||
    '      UPDATE public.income_expenses' || chr(10) ||
    '         SET approval_status = ''APPROVED'',' || chr(10) ||
    '             approved_by = NEW.approved_by,' || chr(10) ||
    '             approved_at = NEW.approved_at,' || chr(10) ||
    '             review_state = ''RESOLVED'',' || chr(10) ||
    '             review_version = income_expenses.review_version + 1,' || chr(10) ||
    '             updated_at = now()');

  IF position('7b1: nhánh duyệt cũng chốt review' IN v_def) = 0 THEN
    RAISE EXCEPTION 'Vá nhánh duyệt của cascade thất bại';
  END IF;
  EXECUTE v_def;
  RAISE NOTICE 'trg_forfeit_settle_on_approve: nhánh duyệt đã chốt review_state';
END
$patch$;

-- Tự kiểm: không còn chỗ nào đặt RESOLVED trước khi duyệt.
DO $verify$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'terminate_contract_forfeit_impl';

  IF position('review_state   = ''RESOLVED''' IN v_def) > 0 THEN
    RAISE EXCEPTION 'Vẫn còn nhịp đóng dấu đặt review_state — chưa xanh';
  END IF;
  IF position('review_state    = ''RESOLVED''' IN v_def) = 0 THEN
    RAISE EXCEPTION 'Cú duyệt KHÔNG đặt review_state — chưa xanh';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'trg_forfeit_settle_on_approve';
  IF position('7b1: nhánh duyệt cũng chốt review' IN v_def) = 0 THEN
    RAISE EXCEPTION 'Cascade nhánh duyệt chưa vá — chưa xanh';
  END IF;
  RAISE NOTICE 'Xanh: writer thanh lý không còn tạo cặp (UNAPPROVED, RESOLVED)';
END
$verify$;

COMMIT;

NOTIFY pgrst, 'reload schema';
