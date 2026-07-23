-- Finance V2 — Hotfix 7h: RE-EMIT SẠCH ie_compat_update_pending_v2 (báo lỗi 42804).
--
-- Lỗi: attachments là JSONB nhưng THEN-branch cũ trả text[] → "CASE types jsonb and
-- text[] cannot be matched". Đã audit KIỂU của toàn bộ 25 cột tham chiếu (chỉ
-- attachments lệch). Bản này:
--   1) Re-emit đầy đủ (không vá regex chồng): giữ fix flow-owner (ie_flow_system_owned_v2,
--      160000) + whitelist cột đã verify tồn tại (180000) + attachments đúng JSONB.
--   2) NULLIF('') cho mọi cast uuid/date/numeric/int — FE gửi chuỗi rỗng không nổ 22P02.
--   3) Smoke cuối transaction: chạy CHÍNH câu UPDATE với v_clean mẫu chứa ĐỦ MỌI KEY
--      (WHERE id không tồn tại) → planner bắt buộc unify mọi nhánh CASE; lớp lỗi
--      42804/42703/22P02-cast sẽ nổ NGAY LÚC APPLY thay vì lúc người dùng bấm Lưu.

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
    'shareholder_id','contract_id','invoice_id','room_id','tenant_id','business_result_accounting'];
  v_meta_keys text[] := ARRAY['name','notes','attachments','payer_name',
    'receive_bank_name','receive_bank_account',
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
    IF app_private.ie_flow_system_owned_v2(p_id) THEN
      RAISE EXCEPTION 'Phiếu thuộc writer hệ thống — sửa qua luồng nguồn' USING ERRCODE='42501';
    END IF;
  END IF;

  IF v_clean <> '{}'::jsonb THEN
    UPDATE public.income_expenses ie SET
      account_id          = CASE WHEN v_clean ? 'account_id' THEN NULLIF(v_clean->>'account_id','')::uuid ELSE ie.account_id END,
      change_account_id   = CASE WHEN v_clean ? 'change_account_id' THEN NULLIF(v_clean->>'change_account_id','')::uuid ELSE ie.change_account_id END,
      rounding_account_id = CASE WHEN v_clean ? 'rounding_account_id' THEN NULLIF(v_clean->>'rounding_account_id','')::uuid ELSE ie.rounding_account_id END,
      total_amount        = CASE WHEN v_clean ? 'total_amount' THEN NULLIF(v_clean->>'total_amount','')::numeric ELSE ie.total_amount END,
      change_amount       = CASE WHEN v_clean ? 'change_amount' THEN NULLIF(v_clean->>'change_amount','')::numeric ELSE ie.change_amount END,
      rounding_amount     = CASE WHEN v_clean ? 'rounding_amount' THEN NULLIF(v_clean->>'rounding_amount','')::numeric ELSE ie.rounding_amount END,
      type                = CASE WHEN v_clean ? 'type' THEN COALESCE(NULLIF(v_clean->>'type',''), ie.type) ELSE ie.type END,
      voucher_date        = CASE WHEN v_clean ? 'voucher_date' THEN COALESCE(NULLIF(v_clean->>'voucher_date','')::date, ie.voucher_date) ELSE ie.voucher_date END,
      building_id         = CASE WHEN v_clean ? 'building_id' THEN NULLIF(v_clean->>'building_id','')::uuid ELSE ie.building_id END,
      shareholder_id      = CASE WHEN v_clean ? 'shareholder_id' THEN NULLIF(v_clean->>'shareholder_id','')::uuid ELSE ie.shareholder_id END,
      contract_id         = CASE WHEN v_clean ? 'contract_id' THEN NULLIF(v_clean->>'contract_id','')::uuid ELSE ie.contract_id END,
      invoice_id          = CASE WHEN v_clean ? 'invoice_id' THEN NULLIF(v_clean->>'invoice_id','')::uuid ELSE ie.invoice_id END,
      room_id             = CASE WHEN v_clean ? 'room_id' THEN NULLIF(v_clean->>'room_id','')::uuid ELSE ie.room_id END,
      tenant_id           = CASE WHEN v_clean ? 'tenant_id' THEN NULLIF(v_clean->>'tenant_id','')::uuid ELSE ie.tenant_id END,
      business_result_accounting = CASE WHEN v_clean ? 'business_result_accounting' THEN COALESCE((v_clean->>'business_result_accounting')::boolean, ie.business_result_accounting) ELSE ie.business_result_accounting END,
      name                = CASE WHEN v_clean ? 'name' THEN COALESCE(NULLIF(v_clean->>'name',''), ie.name) ELSE ie.name END,
      notes               = CASE WHEN v_clean ? 'notes' THEN v_clean->>'notes' ELSE ie.notes END,
      -- attachments là JSONB: giữ nguyên jsonb, không đổi sang text[] (fix 42804)
      attachments         = CASE WHEN v_clean ? 'attachments' THEN COALESCE(v_clean->'attachments', '[]'::jsonb) ELSE ie.attachments END,
      payer_name          = CASE WHEN v_clean ? 'payer_name' THEN v_clean->>'payer_name' ELSE ie.payer_name END,
      receive_bank_name   = CASE WHEN v_clean ? 'receive_bank_name' THEN v_clean->>'receive_bank_name' ELSE ie.receive_bank_name END,
      receive_bank_account= CASE WHEN v_clean ? 'receive_bank_account' THEN v_clean->>'receive_bank_account' ELSE ie.receive_bank_account END,
      repeat_cycle        = CASE WHEN v_clean ? 'repeat_cycle' THEN v_clean->>'repeat_cycle' ELSE ie.repeat_cycle END,
      repeat_count        = CASE WHEN v_clean ? 'repeat_count' THEN NULLIF(v_clean->>'repeat_count','')::integer ELSE ie.repeat_count END,
      repeat_infinity     = CASE WHEN v_clean ? 'repeat_infinity' THEN COALESCE((v_clean->>'repeat_infinity')::boolean, ie.repeat_infinity) ELSE ie.repeat_infinity END,
      repeat_auto_approve = CASE WHEN v_clean ? 'repeat_auto_approve' THEN COALESCE((v_clean->>'repeat_auto_approve')::boolean, ie.repeat_auto_approve) ELSE ie.repeat_auto_approve END
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

-- SMOKE SÂU: chạy CHÍNH câu UPDATE với payload mẫu đủ MỌI key (WHERE id không tồn tại)
-- → planner unify mọi nhánh CASE + validate mọi cast. Lỗi lớp 42804/42703 nổ tại đây.
DO $smoke$
DECLARE
  v_clean jsonb := jsonb_build_object(
    'account_id','00000000-0000-0000-0000-000000000001',
    'change_account_id','', 'rounding_account_id',NULL,
    'total_amount','123.45', 'change_amount','0', 'rounding_amount','',
    'type','EXPENSE', 'voucher_date','2026-07-23', 'building_id','',
    'shareholder_id',NULL, 'contract_id','', 'invoice_id',NULL,
    'room_id','', 'tenant_id',NULL, 'business_result_accounting',true,
    'name','smoke', 'notes','smoke', 'attachments',jsonb_build_array('https://x/y.jpg'),
    'payer_name','x', 'receive_bank_name','x', 'receive_bank_account','x',
    'repeat_cycle','NONE', 'repeat_count','2', 'repeat_infinity',false,
    'repeat_auto_approve',true);
BEGIN
  UPDATE public.income_expenses ie SET
    account_id          = CASE WHEN v_clean ? 'account_id' THEN NULLIF(v_clean->>'account_id','')::uuid ELSE ie.account_id END,
    change_account_id   = CASE WHEN v_clean ? 'change_account_id' THEN NULLIF(v_clean->>'change_account_id','')::uuid ELSE ie.change_account_id END,
    rounding_account_id = CASE WHEN v_clean ? 'rounding_account_id' THEN NULLIF(v_clean->>'rounding_account_id','')::uuid ELSE ie.rounding_account_id END,
    total_amount        = CASE WHEN v_clean ? 'total_amount' THEN NULLIF(v_clean->>'total_amount','')::numeric ELSE ie.total_amount END,
    change_amount       = CASE WHEN v_clean ? 'change_amount' THEN NULLIF(v_clean->>'change_amount','')::numeric ELSE ie.change_amount END,
    rounding_amount     = CASE WHEN v_clean ? 'rounding_amount' THEN NULLIF(v_clean->>'rounding_amount','')::numeric ELSE ie.rounding_amount END,
    type                = CASE WHEN v_clean ? 'type' THEN COALESCE(NULLIF(v_clean->>'type',''), ie.type) ELSE ie.type END,
    voucher_date        = CASE WHEN v_clean ? 'voucher_date' THEN COALESCE(NULLIF(v_clean->>'voucher_date','')::date, ie.voucher_date) ELSE ie.voucher_date END,
    building_id         = CASE WHEN v_clean ? 'building_id' THEN NULLIF(v_clean->>'building_id','')::uuid ELSE ie.building_id END,
    shareholder_id      = CASE WHEN v_clean ? 'shareholder_id' THEN NULLIF(v_clean->>'shareholder_id','')::uuid ELSE ie.shareholder_id END,
    contract_id         = CASE WHEN v_clean ? 'contract_id' THEN NULLIF(v_clean->>'contract_id','')::uuid ELSE ie.contract_id END,
    invoice_id          = CASE WHEN v_clean ? 'invoice_id' THEN NULLIF(v_clean->>'invoice_id','')::uuid ELSE ie.invoice_id END,
    room_id             = CASE WHEN v_clean ? 'room_id' THEN NULLIF(v_clean->>'room_id','')::uuid ELSE ie.room_id END,
    tenant_id           = CASE WHEN v_clean ? 'tenant_id' THEN NULLIF(v_clean->>'tenant_id','')::uuid ELSE ie.tenant_id END,
    business_result_accounting = CASE WHEN v_clean ? 'business_result_accounting' THEN COALESCE((v_clean->>'business_result_accounting')::boolean, ie.business_result_accounting) ELSE ie.business_result_accounting END,
    name                = CASE WHEN v_clean ? 'name' THEN COALESCE(NULLIF(v_clean->>'name',''), ie.name) ELSE ie.name END,
    notes               = CASE WHEN v_clean ? 'notes' THEN v_clean->>'notes' ELSE ie.notes END,
    attachments         = CASE WHEN v_clean ? 'attachments' THEN COALESCE(v_clean->'attachments', '[]'::jsonb) ELSE ie.attachments END,
    payer_name          = CASE WHEN v_clean ? 'payer_name' THEN v_clean->>'payer_name' ELSE ie.payer_name END,
    receive_bank_name   = CASE WHEN v_clean ? 'receive_bank_name' THEN v_clean->>'receive_bank_name' ELSE ie.receive_bank_name END,
    receive_bank_account= CASE WHEN v_clean ? 'receive_bank_account' THEN v_clean->>'receive_bank_account' ELSE ie.receive_bank_account END,
    repeat_cycle        = CASE WHEN v_clean ? 'repeat_cycle' THEN v_clean->>'repeat_cycle' ELSE ie.repeat_cycle END,
    repeat_count        = CASE WHEN v_clean ? 'repeat_count' THEN NULLIF(v_clean->>'repeat_count','')::integer ELSE ie.repeat_count END,
    repeat_infinity     = CASE WHEN v_clean ? 'repeat_infinity' THEN COALESCE((v_clean->>'repeat_infinity')::boolean, ie.repeat_infinity) ELSE ie.repeat_infinity END,
    repeat_auto_approve = CASE WHEN v_clean ? 'repeat_auto_approve' THEN COALESCE((v_clean->>'repeat_auto_approve')::boolean, ie.repeat_auto_approve) ELSE ie.repeat_auto_approve END
  WHERE ie.id = '00000000-0000-0000-0000-000000000000'::uuid;
  RAISE NOTICE 'deep smoke OK: mọi nhánh CASE + cast hợp lệ';
END
$smoke$;

COMMIT;

NOTIFY pgrst, 'reload schema';
