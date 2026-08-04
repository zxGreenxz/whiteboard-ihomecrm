-- =====================================================================
-- SỬA HAI LỖI CỦA CHÍNH 20260801011000 — do review đối kháng bắt được
-- sau khi file đó đã lên production. Cả hai đều đã tái hiện tận tay trên prod.
--
-- ─────────────────────────────────────────────────────────────────────
-- LỖI 1 (NẶNG) — LÀM CÂM CHỐT CHỐNG TRÙNG CỦA MÁY SINH HÀNG LOẠT
--
-- Bản vá trước cho phiếu LỆCH GIÁ nằm lại ở CHỜ DUYỆT. Đó là hành vi đúng.
-- Nhưng `preview_special_fees_v1` — thứ quyết định ô nào "SẼ_SINH" — chỉ đếm
-- phiếu ĐÃ DUYỆT (`ie.approval_status='APPROVED'`). Hệ quả đã đo trên prod:
--
--   1. Đóng 1.000.000đ cho ô có giá công bố 500.000đ ⇒ phiếu PC…61 CHỜ DUYỆT.
--   2. Máy sinh hàng loạt nhìn ô đó: "SẼ_SINH" (không thấy phiếu chờ duyệt)
--      ⇒ đẻ tiếp PC…62 500.000đ, đúng giá nên TỰ DUYỆT + VÀO SỔ ngay.
--   3. Chủ vào /thu-chi bấm Duyệt PC…61 ⇒ cầu a85 đúc thêm một bút toán nữa.
--   ⇒ 2 phiếu, 2 bút toán, tiền ra két 1.500.000đ cho một tháng giá 500.000đ.
--
-- Đây là HỒI QUY do chính bản vá trước gây ra, không phải nợ cũ: đo trên mã
-- prod TRƯỚC bản vá, bước 2 trả `{"warning":"duplicate"}` và không tạo gì.
-- (`pay_period_fee` đã được sửa cùng lúc phát hiện; file này sửa nốt máy sinh.)
--
-- ─────────────────────────────────────────────────────────────────────
-- LỖI 2 — VỎ TƯƠNG THÍCH LÀ THỦ PHẠM, KHÔNG PHẢI THUỐC
--
-- Bản vá trước giữ lại chữ ký 3 tham số làm "vỏ chuyển tiếp" để tab đang mở
-- không gãy. Đo thật qua PostgREST trên prod: nó gây ĐÚNG cái nó định tránh.
--
--   payload 4 khoá (giao diện hiện tại)  → HTTP 401 (phân giải hàm THÀNH CÔNG)
--   payload 3 khoá (tab cũ)              → HTTP 300 **PGRST203**
--        "Could not choose the best candidate function between:
--         generate_special_fees_v1(p_period, p_building_ids, p_idempotency_key)
--         …(…, p_account_id)"
--
-- Nguyên nhân: PostgREST TÔN TRỌNG tham số có DEFAULT, nên payload 3 khoá khớp
-- CẢ HAI chữ ký ⇒ nhập nhằng. Bỏ vỏ đi thì lời gọi 3 khoá tự rơi vào bản 4
-- tham số qua `DEFAULT NULL` — đúng hành vi cũ, miễn phí. Vỏ mang lại 0%
-- tương thích ngược và 100% lỗi.
--
-- Không đụng tiền: lỗi xảy ra ở bước phân giải hàm, TRƯỚC khi thân hàm chạy.
-- =====================================================================

BEGIN;

DO $preflight$
BEGIN
  IF to_regprocedure('public.generate_special_fees_v1(text,uuid[],text,uuid)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu bản 4 tham số của generate_special_fees_v1 — chạy 20260801011000 trước. DỪNG.';
  END IF;
  IF to_regprocedure('public.preview_special_fees_v1(text,uuid[])') IS NULL THEN
    RAISE EXCEPTION 'Thiếu preview_special_fees_v1. DỪNG.';
  END IF;
END
$preflight$;

-- ─────────────────────────────────────────────────────────────────────
-- 1. Máy xem trước phải THẤY phiếu chờ duyệt
--
-- Vá theo neo. Ô đã có phiếu CHỜ DUYỆT nay cũng là "ĐÃ_CÓ_PHIẾU" — vì đứng ở
-- góc chống trùng thì "đã có người tạo phiếu cho ô này" mới là điều đáng biết,
-- chứ không phải "đã có ai duyệt chưa".
-- ─────────────────────────────────────────────────────────────────────
DO $patch_preview$
DECLARE
  v_def  text;
  v_new  text;
  v_mark text := 'SPECIAL_FEE_DUP_SEES_PENDING';
  v_anchor text := '                               AND ie.approval_status=''APPROVED'' AND ie.deleted_at IS NULL';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'preview_special_fees_v1';

  IF position(v_mark IN v_def) > 0 THEN
    RAISE NOTICE 'preview_special_fees_v1 đã thấy phiếu chờ duyệt — bỏ qua';
    RETURN;
  END IF;
  IF position(v_anchor IN v_def) = 0 THEN
    RAISE EXCEPTION 'preview_special_fees_v1: không khớp neo lọc trạng thái — DỪNG, không vá mù';
  END IF;

  v_new := replace(v_def, v_anchor,
    '                               -- ' || v_mark || ': đếm CẢ phiếu chờ duyệt.' || chr(10) ||
    '                               -- Phiếu lệch giá nằm lại ở chờ duyệt; nếu ô này' || chr(10) ||
    '                               -- vẫn báo SẼ_SINH thì máy đẻ thêm phiếu thứ hai' || chr(10) ||
    '                               -- rồi tự duyệt nó — đo được 1.500.000đ ra két' || chr(10) ||
    '                               -- cho một tháng giá công bố 500.000đ.' || chr(10) ||
    '                               AND ie.approval_status <> ''CANCELLED'' AND ie.deleted_at IS NULL');

  EXECUTE v_new;
  RAISE NOTICE 'ĐÃ VÁ preview_special_fees_v1 (thấy cả phiếu chờ duyệt)';
END
$patch_preview$;

-- ─────────────────────────────────────────────────────────────────────
-- 2. Gỡ vỏ 3 tham số — chính nó gây PGRST203
-- ─────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.generate_special_fees_v1(text, uuid[], text);

-- ─────────────────────────────────────────────────────────────────────
-- TỰ KIỂM
-- ─────────────────────────────────────────────────────────────────────
DO $verify$
DECLARE v_n int; v_prev text;
BEGIN
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'generate_special_fees_v1';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'Còn % bản generate_special_fees_v1 — PostgREST vẫn nhập nhằng (PGRST203). DỪNG.', v_n;
  END IF;

  -- Bản còn lại phải là bản 4 tham số, và p_account_id phải CÓ DEFAULT, không
  -- thì lời gọi 3 khoá của tab cũ sẽ chết bằng PGRST202 thay vì chạy được.
  IF to_regprocedure('public.generate_special_fees_v1(text,uuid[],text,uuid)') IS NULL THEN
    RAISE EXCEPTION 'Bản 4 tham số biến mất. DỪNG.';
  END IF;
  IF (SELECT pronargdefaults FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'generate_special_fees_v1') < 1 THEN
    RAISE EXCEPTION 'p_account_id KHÔNG có DEFAULT — tab cũ gọi 3 tham số sẽ gãy. DỪNG.';
  END IF;

  SELECT p.prosrc INTO v_prev FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'preview_special_fees_v1';
  IF position('SPECIAL_FEE_DUP_SEES_PENDING' IN v_prev) = 0 THEN
    RAISE EXCEPTION 'preview_special_fees_v1 vẫn không thấy phiếu chờ duyệt. DỪNG.';
  END IF;
  IF position('approval_status=''APPROVED''' IN v_prev) > 0 THEN
    RAISE EXCEPTION 'preview_special_fees_v1 vẫn còn mệnh đề chỉ-đếm-ĐÃ-DUYỆT. DỪNG.';
  END IF;
END
$verify$;

COMMIT;
