-- =====================================================================
-- Đợt 6 (phụ) — XÁC NHẬN BÀN GIAO TIỀN MẶT KHÔNG ĐƯỢC KẸT VÌ KỲ ĐÃ CHỐT
--
-- `confirm_cash_handover` chèn HAI phiếu mới (chân CHI ở sổ giao, chân THU ở
-- sổ nhận) với `voucher_date = CURRENT_DATE` và KHÔNG hỏi ngày khoá sổ.
-- Trigger khoá của Đợt 3 chặn theo `voucher_date <= closed_through`, nên hễ
-- một trong hai sổ vừa chốt tới hôm nay là phiên PENDING không xác nhận được —
-- tiền đã trao tay ngoài đời mà sổ không ghi được.
--
-- Vá: đẩy ngày sang ngày MỞ đầu tiên.
--
-- ⚠ MỘT NGÀY CHUNG CHO CẢ HAI CHÂN, không phải mỗi chân một ngày. Nếu sổ giao
--   chốt tới 31/07 còn sổ nhận chốt tới 05/08 thì chân CHI rơi 01/08 và chân
--   THU rơi 06/08 ⇒ 5 ngày tiền "trên đường", tổng tiền mặt toàn tổ chức hụt
--   đúng NET trong khoảng đó. Đo trên prod: 24/24 phiếu chuyển lịch sử đều
--   cùng ngày theo từng cặp — giữ đúng bất biến đó.
--
-- ⚠ CÓ TRẦN. `accounts.lock_date` là cột tự do và `accounts_closed_book_guard`
--   chỉ chặn LÙI/GỠ ngày khoá, không chặn đặt ngày tương lai. Không kẹp trần
--   thì một lock_date năm 2027 sẽ đẻ ra phiếu thu/chi ngày 2027, lọt vào mọi
--   báo cáo dòng tiền. Quá 31 ngày thì DỪNG và bắt người dùng xử lý tay.
--
-- ⚠ Hàm gốc `SET search_path TO 'public'` nên KHÔNG thấy schema app_private;
--   phải gọi full-qualified. Chạy được vì nó là SECURITY DEFINER owner postgres
--   (cashbook_closed_through_v1 đã REVOKE khỏi authenticated).
--
-- Vá TẠI CHỖ theo neo thay vì CREATE OR REPLACE nguyên khối: thân hàm này đã
-- tiến hoá qua nhiều đợt (net sweep, batch, cancel flow) và không có bản nào
-- trong repo khớp prod.
-- =====================================================================

BEGIN;

DO $patch$
DECLARE
  v_def text;
  v_anchor_decl text := '  v_item_desc text;' || chr(10) || 'BEGIN';
  -- Neo cho phần TÍNH phải là dòng comment ĐỨNG TRƯỚC câu INSERT. Neo vào
  -- chính dòng `..., CURRENT_DATE,` là chèn một câu lệnh gán vào GIỮA danh sách
  -- VALUES(...) — lỗi cú pháp, và chỉ lộ ra lúc EXECUTE.
  v_anchor_calc text := '  -- ── 1 phiếu CHI tổng (sổ người giao) = NET ──';
  v_anchor_out  text := '     v_bld_giver, v_h.from_account_id, CURRENT_DATE,';
  v_anchor_in   text := '     v_bld_recv, v_to, CURRENT_DATE,';
  v_calc text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'confirm_cash_handover';

  IF v_def IS NULL THEN
    RAISE NOTICE 'Không có public.confirm_cash_handover — bỏ qua';
    RETURN;
  END IF;
  IF position('v_handover_date' IN v_def) > 0 THEN
    RAISE NOTICE 'confirm_cash_handover đã vá — bỏ qua';
    RETURN;
  END IF;

  IF position(v_anchor_decl IN v_def) = 0
     OR position(v_anchor_calc IN v_def) = 0
     OR position(v_anchor_out IN v_def) = 0
     OR position(v_anchor_in IN v_def) = 0 THEN
    RAISE EXCEPTION 'Không khớp mẫu neo trong confirm_cash_handover — DỪNG, không vá mù';
  END IF;

  -- 1) khai biến
  v_def := replace(v_def, v_anchor_decl,
    '  v_item_desc text;' || chr(10) ||
    '  v_handover_date date;   -- Đợt 6: ngày MỞ đầu tiên chung cho cả hai chân' || chr(10) ||
    'BEGIN');

  -- 2) tính ngày, chèn TRƯỚC câu INSERT chân CHI.
  --    GREATEST bỏ qua NULL nên sổ chưa chốt vẫn ra CURRENT_DATE.
  v_calc :=
    '  -- Đợt 6: kỳ đã chốt thì cặp phiếu bàn giao rơi vào ngày MỞ đầu tiên.' || chr(10) ||
    '  -- MỘT ngày chung cho cả hai chân, nếu không sẽ có cửa sổ "tiền trên đường".' || chr(10) ||
    '  v_handover_date := GREATEST(' || chr(10) ||
    '    CURRENT_DATE,' || chr(10) ||
    '    app_private.cashbook_closed_through_v1(v_h.from_account_id) + 1,' || chr(10) ||
    '    app_private.cashbook_closed_through_v1(v_to) + 1);' || chr(10) ||
    '  IF v_handover_date > CURRENT_DATE + 31 THEN' || chr(10) ||
    '    RAISE EXCEPTION ''[CASHBOOK_CLOSED] Sổ quỹ đã chốt tới % — phiên bàn giao này phải xử lý tay, hệ thống không lập phiếu ở ngày quá xa.'',' || chr(10) ||
    '      v_handover_date - 1 USING ERRCODE = ''P0001'';' || chr(10) ||
    '  END IF;' || chr(10) || chr(10) ||
    v_anchor_calc;

  v_def := replace(v_def, v_anchor_calc, v_calc);

  -- 3) hai chân dùng CÙNG một ngày
  v_def := replace(v_def, v_anchor_out,
    '     v_bld_giver, v_h.from_account_id, v_handover_date,');
  v_def := replace(v_def, v_anchor_in,
    '     v_bld_recv, v_to, v_handover_date,');

  IF position('v_handover_date := GREATEST(' IN v_def) = 0
     OR position('v_h.from_account_id, v_handover_date,' IN v_def) = 0
     OR position('v_to, v_handover_date,' IN v_def) = 0 THEN
    RAISE EXCEPTION 'Vá confirm_cash_handover thất bại';
  END IF;

  EXECUTE v_def;
  RAISE NOTICE 'Đã vá confirm_cash_handover: hai chân dùng ngày mở đầu tiên';
END
$patch$;

COMMIT;

NOTIFY pgrst, 'reload schema';
