-- =====================================================================
-- P2-06 (audit /thanh-toan 31/08): pay_draft_fee_voucher — GATE TRƯỚC, ĐỌC SAU.
--
-- Bản đang chạy (baseline :82664) tiết lộ trạng thái phiếu TRƯỚC mọi kiểm tra
-- org/toà: "Không tìm thấy phiếu" / "Phiếu đã bị hủy" / "Phiếu không ở trạng
-- thái nháp (hiện: X)" — user đăng nhập ở CÔNG TY KHÁC có UUID phiếu (log rò,
-- export, nhân sự cũ) dùng hàm này làm MÁY DÒ trạng thái. Nó còn UPDATE
-- account_id/attachments TRƯỚC khi hỏi quyền duyệt (approve_voucher RAISE thì
-- rollback nên không ghi bẩn được — nhưng "ghi trước, hỏi quyền sau" là ngược
-- nguyên tắc defense-in-depth).
--
-- ĐÍNH CHÍNH NGUỒN: audit gốc ghi "đã biết từ audit 13/08" — kiểm lại thì
-- AUDIT-TIEN-HOA-DON-...-2026-08-13.md KHÔNG có finding này (grep 0 kết quả).
--
-- SỬA: chèn đúng cổng quyền toà của pay_period_fee (baseline :82768-82773)
-- ngay sau khi lock dòng; MỌI ca không-tồn-tại / khác-org / không-quyền trả
-- CÙNG một câu 'Không tìm thấy phiếu' (P0002) — không còn oracle. Người có
-- quyền thật thấy y nguyên các thông báo cũ, KHÔNG đổi hành vi hợp lệ nào.
--
-- Chữ ký GIỮ NGUYÊN ⇒ CREATE OR REPLACE, không đẻ overload, ACL giữ nguyên
-- (vẫn REVOKE + selfcheck tường minh theo khuôn 20260731030000).
-- =====================================================================
BEGIN;

DO $preflight$
BEGIN
  IF to_regprocedure('public.pay_draft_fee_voucher(uuid,uuid,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'pay_draft_fee_voucher(uuid,uuid,jsonb) chưa tồn tại — sai nền. DỪNG.';
  END IF;
  IF to_regprocedure('public.approve_voucher(uuid)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu public.approve_voucher(uuid). DỪNG.';
  END IF;
  IF to_regprocedure('public.can_access_building(uuid)') IS NULL
     OR to_regprocedure('public.ie_all_buildings_scope(uuid)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu helper quyền toà (can_access_building / ie_all_buildings_scope). DỪNG.';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public.pay_draft_fee_voucher(p_voucher_id uuid, p_account_id uuid, p_attachments jsonb DEFAULT NULL::jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_st    text;
  v_del   timestamptz;
  v_bld   uuid;
  v_owner uuid;
  v_acc   uuid;
  v_code  text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF p_account_id IS NULL THEN
    RAISE EXCEPTION 'Chọn sổ quỹ ghi chi trước khi thanh toán';
  END IF;

  SELECT ie.approval_status, ie.deleted_at, ie.building_id INTO v_st, v_del, v_bld
    FROM income_expenses ie WHERE ie.id = p_voucher_id
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Không tìm thấy phiếu' USING ERRCODE = 'P0002'; END IF;

  -- ── GATE QUYỀN TOÀ — TRƯỚC mọi tiết lộ trạng thái (P2-06, 31/08) ──
  -- Cùng vị ngữ với pay_period_fee. Không-quyền và không-tồn-tại trả CÙNG một
  -- câu: caller ngoài org không phân biệt được "không có phiếu" với "có mà
  -- không được xem" ⇒ hết đường dò.
  SELECT b.user_id INTO v_owner
    FROM buildings b WHERE b.id = v_bld AND b.deleted_at IS NULL;
  IF v_bld IS NULL OR v_owner IS NULL
     OR NOT (public.can_access_building(v_bld)
             OR public.ie_all_buildings_scope(v_bld)
             OR v_owner = auth.uid()
             OR public.is_admin() OR public.is_super_admin()) THEN
    RAISE EXCEPTION 'Không tìm thấy phiếu' USING ERRCODE = 'P0002';
  END IF;

  IF v_del IS NOT NULL THEN RAISE EXCEPTION 'Phiếu đã bị hủy'; END IF;
  IF v_st <> 'UNAPPROVED' THEN
    RAISE EXCEPTION 'Phiếu không ở trạng thái nháp (hiện: %)', v_st;
  END IF;

  SELECT id INTO v_acc FROM accounts
   WHERE id = p_account_id AND deleted_at IS NULL
     AND (user_id = auth.uid() OR public.is_admin() OR public.is_super_admin());
  IF v_acc IS NULL THEN
    RAISE EXCEPTION 'Sổ quỹ không hợp lệ hoặc bạn không có quyền ghi chi vào sổ này' USING ERRCODE = '42501';
  END IF;

  UPDATE income_expenses
     SET account_id  = v_acc,
         attachments = COALESCE(p_attachments, attachments)
   WHERE id = p_voucher_id;

  -- Duyệt qua approve_voucher: giữ nguyên gate quyền duyệt + audit; RAISE → rollback cả sổ/ảnh.
  PERFORM public.approve_voucher(p_voucher_id);

  SELECT code INTO v_code FROM income_expenses WHERE id = p_voucher_id;
  RETURN jsonb_build_object('ok', true, 'voucher_id', p_voucher_id, 'code', v_code);
END;
$$;

REVOKE ALL ON FUNCTION public.pay_draft_fee_voucher(uuid,uuid,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pay_draft_fee_voucher(uuid,uuid,jsonb) TO authenticated, service_role;

COMMENT ON FUNCTION public.pay_draft_fee_voucher(uuid,uuid,jsonb) IS
  'Thanh toán & duyệt phiếu phí NHÁP (recurring draft-mode). 31/08: gate quyền '
  'toà đặt TRƯỚC mọi tiết lộ trạng thái — không-quyền và không-tồn-tại cùng trả '
  '"Không tìm thấy phiếu" (P0002) để hàm không thành máy dò trạng thái xuyên org; '
  'duyệt vẫn đi qua approve_voucher (RAISE → rollback cả sổ/ảnh).';

DO $selfcheck$
DECLARE v_cnt int;
BEGIN
  SELECT count(*) INTO v_cnt FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'pay_draft_fee_voucher';
  IF v_cnt <> 1 THEN
    RAISE EXCEPTION 'pay_draft_fee_voucher có % chữ ký (kỳ vọng 1) — overload mồ côi. DỪNG.', v_cnt;
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.pay_draft_fee_voucher(uuid,uuid,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated không chạy được pay_draft_fee_voucher. DỪNG.';
  END IF;
  IF has_function_privilege('anon', 'public.pay_draft_fee_voucher(uuid,uuid,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon chạy được pay_draft_fee_voucher — REVOKE hỏng. DỪNG.';
  END IF;
END
$selfcheck$;

COMMIT;
