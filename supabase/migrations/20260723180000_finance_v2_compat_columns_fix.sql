-- Finance V2 — Hotfix 7g: bỏ 3 cột không tồn tại khỏi ie_compat_update_pending_v2
-- (báo lỗi NATHAN 2026-07-23: "column ie.category_id does not exist" khi SỬA phiếu).
--
-- Header income_expenses KHÔNG có: category_id (loại nằm ở income_expense_items),
-- payment_method + receipt_image_url (thuộc bảng payments — hook FE đã update payments
-- riêng). PL/pgSQL chỉ parse SQL lúc chạy nên migration trước không bắt được.
-- Patch trên định nghĩa LIVE để giữ nguyên fix flow-owner 160000.

BEGIN;

DO $patch$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'ie_compat_update_pending_v2';

  v_def := replace(v_def, $$'category_id','shareholder_id'$$, $$'shareholder_id'$$);
  v_def := replace(v_def, $$'name','notes','payment_method','receipt_image_url','attachments'$$,
                          $$'name','notes','attachments'$$);
  v_def := regexp_replace(v_def, '\s*category_id\s*=\s*CASE WHEN [^,]+ELSE ie\.category_id END,', '', 'g');
  v_def := regexp_replace(v_def, '\s*payment_method\s*=\s*CASE WHEN [^,]+ELSE ie\.payment_method END,', '', 'g');
  v_def := regexp_replace(v_def, '\s*receipt_image_url\s*=\s*CASE WHEN [^,]+ELSE ie\.receipt_image_url END,', '', 'g');

  IF v_def LIKE '%ie.category_id%' OR v_def LIKE '%ie.payment_method%' OR v_def LIKE '%ie.receipt_image_url%' THEN
    RAISE EXCEPTION 'Patch chưa sạch — còn tham chiếu cột không tồn tại';
  END IF;
  EXECUTE v_def;
END
$patch$;

-- Smoke: ép parser kiểm tra TOÀN BỘ cột trong SET (WHERE false — không đụng row/trigger).
-- (Không gọi RPC trực tiếp được: auth.uid() NULL dưới Management API → guard 42501 đúng.)
DO $smoke$
BEGIN
  EXECUTE 'UPDATE public.income_expenses ie SET
      account_id=ie.account_id, change_account_id=ie.change_account_id,
      rounding_account_id=ie.rounding_account_id, total_amount=ie.total_amount,
      change_amount=ie.change_amount, rounding_amount=ie.rounding_amount,
      type=ie.type, voucher_date=ie.voucher_date, building_id=ie.building_id,
      shareholder_id=ie.shareholder_id, contract_id=ie.contract_id,
      invoice_id=ie.invoice_id, room_id=ie.room_id, tenant_id=ie.tenant_id,
      business_result_accounting=ie.business_result_accounting,
      name=ie.name, notes=ie.notes, attachments=ie.attachments,
      payer_name=ie.payer_name, receive_bank_name=ie.receive_bank_name,
      receive_bank_account=ie.receive_bank_account, repeat_cycle=ie.repeat_cycle,
      repeat_count=ie.repeat_count, repeat_infinity=ie.repeat_infinity,
      repeat_auto_approve=ie.repeat_auto_approve
    WHERE false';
  RAISE NOTICE 'column smoke OK';
END
$smoke$;

COMMIT;

NOTIFY pgrst, 'reload schema';
