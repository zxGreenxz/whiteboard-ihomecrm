-- =============================================================================
-- Dập nốt bom cùng loại: trg_contract_link_orphan_deposits UPDATE trần cọc canonical
-- =============================================================================
-- Cùng án với 20260731130000_create_contract_link_deposit_flex: trigger này chạy
-- khi INSERT public.contracts KHÔNG qua create_contract_v2 (create_contract_v1
-- legacy, create_new_contract_extension, hay INSERT trực tiếp) và tự gắn phiếu
-- cọc mồ côi của phòng vào HĐ mới bằng UPDATE trần contract_id.
--
-- Từ 27/07/2026 phiếu cọc sinh qua create_income_expense_v1 là flow-owned ⇒
-- UPDATE trần bị guard đóng băng 55000 ⇒ INSERT hợp đồng theo các đường trên
-- chết theo. Đo 31/07: prod có 25 phiếu cọc mồ côi flow-owned đang chờ nổ.
--
-- VÁ: mở cửa hẹp LINK_CONTRACT (đã dựng ở 20260731130000) quanh từng phiếu.
-- Hành vi chọn phiếu giữ NGUYÊN — chỉ đổi cách ghi từ UPDATE gộp sang loop
-- từng phiếu để mở/đóng năng lực đúng phạm vi.
--
-- BASE: pg_get_functiondef bản đang chạy 31/07/2026 (thân hàm ngắn, chép nguyên
-- điều kiện WHERE, không có nhánh nào khác).
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.trg_contract_link_orphan_deposits()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_voucher uuid;
BEGIN
  IF current_setting('app.contract_create_v2', true) = 'on' OR NEW.room_id IS NULL THEN
    RETURN NEW;
  END IF;

  FOR v_voucher IN
    SELECT voucher.id
      FROM public.income_expenses voucher
     WHERE voucher.contract_id IS NULL
       AND voucher.organization_id = NEW.organization_id
       AND voucher.deleted_at IS NULL
       AND voucher.approval_status = 'APPROVED'
       AND voucher.type = 'INCOME'
       AND voucher.room_id = NEW.room_id
       AND voucher.voucher_date BETWEEN NEW.start_date - interval '30 days'
                                    AND NEW.start_date + interval '7 days'
       AND EXISTS (
         SELECT 1
         FROM public.income_expense_items item
         WHERE item.income_expense_id = voucher.id
           AND item.accounting_class = 'DEPOSIT'
       )
  LOOP
    -- Cửa hẹp LINK_CONTRACT: guard chỉ cho contract_id đi NULL → NOT NULL,
    -- mọi cột khác bất biến. Phiếu legacy (không flow-owned) không cần cửa
    -- nhưng mở cũng vô hại — giữ một đường ghi duy nhất.
    PERFORM app_private.begin_ie_flex_write_v1(v_voucher, 'LINK_CONTRACT');
    UPDATE public.income_expenses
       SET contract_id = NEW.id,
           updated_at = now()
     WHERE id = v_voucher
       AND contract_id IS NULL;
    PERFORM app_private.end_ie_flex_write_v1(v_voucher);
  END LOOP;

  PERFORM public.recompute_contract_deposit_paid(NEW.id);
  RETURN NEW;
END;
$function$;

COMMIT;
