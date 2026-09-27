-- LIVE production catalog, read-only snapshot 2026-09-27T12:35:40.599Z
-- public.trg_contract_link_orphan_deposits() md5(prosrc)=4107c6c70b3dd254832f6f9ec582e641
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
       AND NOT app_private.reservation_deposit_is_settled_v1(voucher.id)
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
$function$

