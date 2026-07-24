-- Finance V2 — 7ae: phiếu CHỜ DUYỆT bị backfill đóng nhần NON_CASH → không
-- Duyệt-và-Chi được ("only CASHBOOK vouchers can be posted", 55000).
--
-- Root cause (owner báo trên PROD, phiếu "Trả khách thanh lý — HĐ HĐT-046668"):
-- writer thanh lý tạo phiếu hoàn-khách TIỀN THẬT với account_id NULL (dặn user
-- "CHỌN SỔ QUỸ rồi mới duyệt"). Backfill Stage-4 (20260723040000 C4) chạy MỘT
-- LẦN 23/07: pending + account trống/ảo → posting_mode='NON_CASH' +
-- posting_status='NOT_APPLICABLE'. Sau đó user Sửa phiếu gán sổ THẬT (ATam)
-- nhưng không tầng nào nâng lại mode → approve_and_post chặn 55000.
--
-- Scope đo thật 24/07: đúng 8 phiếu UNAPPROVED + NON_CASH toàn hệ
--   org thật: 2 manual (trống sổ), 2 contract.commission (1 sổ thật/1 trống),
--             1 termination.refund (sổ thật — phiếu owner đang kẹt)
--   DEMO    : 3 manual (trống sổ)
-- Tất cả là nghĩa vụ tiền thật đang chờ duyệt → bản chất CASHBOOK (UNPOSTED);
-- NON_CASH chỉ đúng cho bút toán nội bộ chủ đích (offset/forfeit — không phiếu
-- nào trong nhóm UNAPPROVED này). Backfill là one-shot, writer hiện hành không
-- sinh NON_CASH cho pending → fix DATA một lần, KHÔNG thêm trigger mới.
--
-- GIỮ NGUYÊN (chủ đích, KHÔNG đụng): 3 phiếu termination.refund APPROVED +
-- NON_CASH gắn SỔ ẢO (mô hình cũ trước 04/07 — tiền có thể đã trả ngoài đời;
-- chuyển thành "chưa chi" sẽ mở đường CHI ĐÚP).
--
-- Điều kiện an toàn = đúng predicate backfill C4 (qua được các guard không cần
-- token): không flow-owned, không forfeit pair, không salary, không payout.

BEGIN;

DO $fix$
DECLARE v_cnt int;
BEGIN
  UPDATE public.income_expenses ie SET
    posting_mode   = 'CASHBOOK',
    posting_status = 'UNPOSTED'
  WHERE ie.approval_status = 'UNAPPROVED'
    AND ie.posting_mode = 'NON_CASH'
    AND ie.deleted_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM app_private.income_expense_flow_ownership o
                    WHERE o.income_expense_id = ie.id)
    AND COALESCE(ie.system_source, '') NOT IN
        ('termination.forfeit_revenue', 'termination.forfeit_offset')
    AND ie.salary_staff_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM public.profit_payout_reservations pr
                    WHERE pr.payout_voucher_id = ie.id);

  GET DIAGNOSTICS v_cnt = ROW_COUNT;
  RAISE NOTICE '7ae: nâng % phiếu pending NON_CASH → CASHBOOK/UNPOSTED', v_cnt;

  -- Smoke 1: không còn phiếu pending NON_CASH nào ngoài nhóm loại trừ chủ đích.
  SELECT count(*) INTO v_cnt
  FROM public.income_expenses ie
  WHERE ie.approval_status = 'UNAPPROVED' AND ie.posting_mode = 'NON_CASH'
    AND ie.deleted_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM app_private.income_expense_flow_ownership o
                    WHERE o.income_expense_id = ie.id)
    AND COALESCE(ie.system_source, '') NOT IN
        ('termination.forfeit_revenue', 'termination.forfeit_offset')
    AND ie.salary_staff_id IS NULL;
  IF v_cnt <> 0 THEN
    RAISE EXCEPTION '7ae smoke FAIL: còn % phiếu pending NON_CASH ngoài loại trừ', v_cnt;
  END IF;

  -- Smoke 2: phiếu owner đang kẹt phải thành CASHBOOK/UNPOSTED, PENDING nguyên vẹn.
  PERFORM 1 FROM public.income_expenses
  WHERE id = 'da42f5d6-9c7c-4063-b51c-d314ea4739e0'
    AND posting_mode = 'CASHBOOK' AND posting_status = 'UNPOSTED'
    AND approval_status = 'UNAPPROVED';
  IF NOT FOUND THEN
    RAISE EXCEPTION '7ae smoke FAIL: phiếu HĐT-046668 chưa về CASHBOOK/UNPOSTED';
  END IF;

  -- Smoke 3: 3 phiếu APPROVED NON_CASH sổ-ảo (mô hình cũ) phải CÒN NGUYÊN.
  SELECT count(*) INTO v_cnt
  FROM public.income_expenses
  WHERE system_source = 'termination.refund' AND approval_status = 'APPROVED'
    AND posting_mode = 'NON_CASH' AND deleted_at IS NULL;
  IF v_cnt <> 3 THEN
    RAISE EXCEPTION '7ae smoke FAIL: nhóm APPROVED sổ-ảo bị đụng (còn %, mong 3)', v_cnt;
  END IF;
END
$fix$;

COMMIT;

NOTIFY pgrst, 'reload schema';
