-- Finance V2 — Stage 7c: mở rộng whitelist ie_compat_update_pending_v2.
-- Agent drain phát hiện form sửa phiếu dùng thêm các cột: room_id/tenant_id/
-- business_result_accounting (trục tiền/KQKD — pending-only) và payer_name/
-- receive_bank_*/repeat_* (metadata). Thiếu whitelist làm field rơi im lặng.
-- Re-emit function với danh sách đủ; hành vi guard giữ nguyên.

BEGIN;

CREATE OR REPLACE FUNCTION public.ie_compat_update_pending_v2(p_id uuid, p_patch jsonb, p_items jsonb DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $fn$
DECLARE
  v_row public.income_expenses%ROWTYPE;
  v_actor record;
  v_money_keys text[] := ARRAY['account_id','change_account_id','rounding_account_id',
    'total_amount','change_amount','rounding_amount','type','voucher_date','building_id',
    'category_id','shareholder_id','contract_id','invoice_id',
    'room_id','tenant_id','business_result_accounting'];
  v_meta_keys text[] := ARRAY['name','notes','payment_method','receipt_image_url','attachments',
    'payer_name','receive_bank_name','receive_bank_account',
    'repeat_cycle','repeat_count','repeat_infinity','repeat_auto_approve'];
  v_key text;
  v_touch_money boolean := false;
  v_clean jsonb := '{}'::jsonb;
  v_item jsonb;
BEGIN
  SELECT * INTO v_row FROM public.income_expenses WHERE id = p_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Phiếu không tồn tại' USING ERRCODE='P0002'; END IF;
  SELECT * INTO v_actor FROM app_private.ie_compat_actor_v2(v_row.organization_id);
  IF v_actor.membership_id IS NULL THEN
    RAISE EXCEPTION 'Không có membership active trong organization phiếu' USING ERRCODE='42501';
  END IF;
  IF v_row.approval_status = 'CANCELLED' THEN
    RAISE EXCEPTION 'Phiếu đã hủy — không sửa' USING ERRCODE='55000';
  END IF;

  FOR v_key IN SELECT jsonb_object_keys(p_patch) LOOP
    IF v_key = ANY (v_money_keys) THEN
      v_touch_money := true;
      v_clean := v_clean || jsonb_build_object(v_key, p_patch->v_key);
    ELSIF v_key = ANY (v_meta_keys) THEN
      v_clean := v_clean || jsonb_build_object(v_key, p_patch->v_key);
    END IF;
  END LOOP;

  IF (v_touch_money OR p_items IS NOT NULL) THEN
    IF v_row.approval_status <> 'UNAPPROVED' OR COALESCE(v_row.posting_status,'UNPOSTED') = 'POSTED' THEN
      RAISE EXCEPTION 'Trục tiền chỉ sửa được khi phiếu Chờ duyệt (V2 §12.8); phiếu đã duyệt/ghi sổ dùng reversal'
        USING ERRCODE='55000';
    END IF;
    IF app_private.is_income_expense_flow_owned(p_id) THEN
      RAISE EXCEPTION 'Phiếu thuộc writer hệ thống — sửa qua luồng nguồn' USING ERRCODE='42501';
    END IF;
  END IF;

  IF v_clean <> '{}'::jsonb THEN
    UPDATE public.income_expenses ie SET
      account_id          = COALESCE((v_clean->>'account_id')::uuid, ie.account_id),
      change_account_id   = CASE WHEN v_clean ? 'change_account_id' THEN (v_clean->>'change_account_id')::uuid ELSE ie.change_account_id END,
      rounding_account_id = CASE WHEN v_clean ? 'rounding_account_id' THEN (v_clean->>'rounding_account_id')::uuid ELSE ie.rounding_account_id END,
      total_amount        = COALESCE((v_clean->>'total_amount')::numeric, ie.total_amount),
      change_amount       = CASE WHEN v_clean ? 'change_amount' THEN (v_clean->>'change_amount')::numeric ELSE ie.change_amount END,
      rounding_amount     = CASE WHEN v_clean ? 'rounding_amount' THEN (v_clean->>'rounding_amount')::numeric ELSE ie.rounding_amount END,
      type                = COALESCE(v_clean->>'type', ie.type),
      voucher_date        = COALESCE((v_clean->>'voucher_date')::date, ie.voucher_date),
      building_id         = CASE WHEN v_clean ? 'building_id' THEN (v_clean->>'building_id')::uuid ELSE ie.building_id END,
      category_id         = CASE WHEN v_clean ? 'category_id' THEN (v_clean->>'category_id')::uuid ELSE ie.category_id END,
      shareholder_id      = CASE WHEN v_clean ? 'shareholder_id' THEN (v_clean->>'shareholder_id')::uuid ELSE ie.shareholder_id END,
      contract_id         = CASE WHEN v_clean ? 'contract_id' THEN (v_clean->>'contract_id')::uuid ELSE ie.contract_id END,
      invoice_id          = CASE WHEN v_clean ? 'invoice_id' THEN (v_clean->>'invoice_id')::uuid ELSE ie.invoice_id END,
      room_id             = CASE WHEN v_clean ? 'room_id' THEN (v_clean->>'room_id')::uuid ELSE ie.room_id END,
      tenant_id           = CASE WHEN v_clean ? 'tenant_id' THEN (v_clean->>'tenant_id')::uuid ELSE ie.tenant_id END,
      business_result_accounting = CASE WHEN v_clean ? 'business_result_accounting' THEN (v_clean->>'business_result_accounting')::boolean ELSE ie.business_result_accounting END,
      name                = COALESCE(v_clean->>'name', ie.name),
      notes               = CASE WHEN v_clean ? 'notes' THEN v_clean->>'notes' ELSE ie.notes END,
      payment_method      = CASE WHEN v_clean ? 'payment_method' THEN v_clean->>'payment_method' ELSE ie.payment_method END,
      receipt_image_url   = CASE WHEN v_clean ? 'receipt_image_url' THEN v_clean->>'receipt_image_url' ELSE ie.receipt_image_url END,
      attachments         = CASE WHEN v_clean ? 'attachments' THEN ARRAY(SELECT jsonb_array_elements_text(v_clean->'attachments')) ELSE ie.attachments END,
      payer_name          = CASE WHEN v_clean ? 'payer_name' THEN v_clean->>'payer_name' ELSE ie.payer_name END,
      receive_bank_name   = CASE WHEN v_clean ? 'receive_bank_name' THEN v_clean->>'receive_bank_name' ELSE ie.receive_bank_name END,
      receive_bank_account= CASE WHEN v_clean ? 'receive_bank_account' THEN v_clean->>'receive_bank_account' ELSE ie.receive_bank_account END,
      repeat_cycle        = CASE WHEN v_clean ? 'repeat_cycle' THEN v_clean->>'repeat_cycle' ELSE ie.repeat_cycle END,
      repeat_count        = CASE WHEN v_clean ? 'repeat_count' THEN (v_clean->>'repeat_count')::integer ELSE ie.repeat_count END,
      repeat_infinity     = CASE WHEN v_clean ? 'repeat_infinity' THEN (v_clean->>'repeat_infinity')::boolean ELSE ie.repeat_infinity END,
      repeat_auto_approve = CASE WHEN v_clean ? 'repeat_auto_approve' THEN (v_clean->>'repeat_auto_approve')::boolean ELSE ie.repeat_auto_approve END
    WHERE ie.id = p_id;
  END IF;

  IF p_items IS NOT NULL THEN
    DELETE FROM public.income_expense_items WHERE income_expense_id = p_id;
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
      INSERT INTO public.income_expense_items
      SELECT * FROM jsonb_populate_record(NULL::public.income_expense_items,
        (v_item - 'income_expense_id') || jsonb_build_object('income_expense_id', p_id));
    END LOOP;
  END IF;

  INSERT INTO app_private.finance_v2_semantic_event_log (organization_id, event_kind, source_table, source_id, source_kind, actor, txid)
  VALUES (v_row.organization_id, 'COMPAT_UPDATE', 'income_expenses', p_id, 'V2_WRITE', auth.uid(), pg_current_xact_id());
  RETURN jsonb_build_object('id', p_id);
END
$fn$;

COMMIT;

NOTIFY pgrst, 'reload schema';
