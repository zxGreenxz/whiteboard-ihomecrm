-- =============================================================================
-- PCOMPAT-C01 (P1) — re-anchor bảo mật 02/09/2026: ie_compat_update_pending_v2
-- authorize theo scope CŨ của phiếu (building_id đang có) nhưng GHI scope MỚI
-- từ patch (building/room/tenant/contract/invoice/shareholder/account) mà không
-- tái kiểm → người có quyền ở toà A đẩy phiếu sang toà B (hoặc gắn quan hệ thuộc
-- org khác) mà không ai duyệt.
--
-- Vá (CREATE OR REPLACE cùng chữ ký, không overload):
--   1. Pre-read org → lock_org_for_decision_v1 → đọc lại phiếu FOR UPDATE.
--   2. Tính scope CUỐI = COALESCE(patch, hiện tại) cho building/room/tenant/
--      contract/invoice/shareholder/account; mọi quan hệ non-null PHẢI cùng
--      organization_id với phiếu (42501 nếu lệch).
--   3. Trục tiền: authorize_tenant_action_v3('income_expenses.edit') HAI LẦN —
--      trên toà cũ và toà mới — trượt một là deny. Không còn dùng helper STABLE
--      ie_can_edit_money_axis_v1 làm quyết định.
--   4. Nhánh chỉ-metadata: cùng authorize_tenant_action_v3 thay helper STABLE
--      (tập người gọi hợp lệ giữ nguyên: người tạo, người có quyền edit ở toà,
--      người giữ sổ).
-- Phần còn lại giữ nguyên bản 20260730100000_ie_meta_write_hardening.
-- Ca hợp lệ (sửa phiếu trong cùng toà, người có quyền) không đổi hành vi.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.ie_compat_update_pending_v2(p_id uuid, p_patch jsonb, p_items jsonb DEFAULT NULL::jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app_private', 'public'
    AS $$
DECLARE
  v_row public.income_expenses%ROWTYPE;
  v_org uuid;
  v_actor record;
  v_money_keys text[] := ARRAY['account_id','change_account_id','rounding_account_id',
    'payer_name','receive_bank_name','receive_bank_account',
    'repeat_cycle','repeat_count','repeat_infinity','repeat_auto_approve',
    'total_amount','change_amount','rounding_amount','type','voucher_date','building_id',
    'shareholder_id','contract_id','invoice_id','room_id','tenant_id','business_result_accounting'];
  v_meta_keys text[] := ARRAY['name','notes','attachments'];
  -- Cột item client được phép đặt. CỐ Ý bỏ: id, organization_id, amount
  -- (cột dẫn xuất), created_at và ĐẶC BIỆT là accounting_class — trigger
  -- set_ie_item_accounting_class chỉ suy ra khi giá trị NULL, nên client
  -- gửi 'PNL' cho một hạng mục CỌC là đủ để rút contracts.deposit_paid
  -- và thổi KQKD. FE (accountingClass.ts) vốn tính đúng công thức
  -- `is_deposit ? DEPOSIT : PNL` của trigger, nên bỏ đi là BẤT BIẾN
  -- hành vi cho người gọi hợp lệ.
  v_item_keys text[] := ARRAY['income_expense_type_id','description',
    'quantity','unit_price','start_date','end_date'];
  v_key text;
  v_touch_money boolean := false;
  v_clean jsonb := '{}'::jsonb;
  v_item jsonb;
  v_item_clean jsonb;
  v_can_replace_attachments boolean;
  v_new_account uuid;
  -- Scope CUỐI sau patch (PCOMPAT-C01)
  v_t_building uuid; v_t_room uuid; v_t_tenant uuid; v_t_contract uuid;
  v_t_invoice uuid; v_t_shareholder uuid; v_t_account uuid;
  v_t_change_account uuid; v_t_rounding_account uuid;
  v_ok_old boolean; v_ok_new boolean; v_ok_meta boolean;
BEGIN
  -- 1) Pre-read org → khoá org → đọc lại FOR UPDATE.
  SELECT organization_id INTO v_org FROM public.income_expenses WHERE id = p_id AND deleted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Phiếu không tồn tại' USING ERRCODE='P0002'; END IF;
  PERFORM app_private.lock_org_for_decision_v1(v_org);
  SELECT * INTO v_row FROM public.income_expenses WHERE id = p_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Phiếu không tồn tại' USING ERRCODE='P0002'; END IF;

  SELECT * INTO v_actor FROM app_private.ie_compat_actor_v2(v_row.organization_id);
  IF v_actor.membership_id IS NULL THEN
    RAISE EXCEPTION 'Không có membership active trong organization phiếu' USING ERRCODE='42501';
  END IF;
  IF v_row.approval_status = 'CANCELLED' THEN
    RAISE EXCEPTION 'Phiếu đã hủy — không sửa' USING ERRCODE='55000';
  END IF;

  -- Hạng mục hạn chế: RPC là SECURITY DEFINER nên KHÔNG được hưởng
  -- policy RESTRICTIVE income_expenses_restricted_* — phải tự kiểm.
  IF COALESCE(v_row.has_restricted_item, false)
     AND v_row.user_id IS DISTINCT FROM auth.uid()
     AND NOT public.can_view_restricted_ie()
     AND NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Phiếu chứa hạng mục hạn chế — không có quyền sửa' USING ERRCODE='42501';
  END IF;

  FOR v_key IN SELECT jsonb_object_keys(p_patch) LOOP
    IF v_key = ANY (v_money_keys) THEN
      v_touch_money := true;
      v_clean := v_clean || jsonb_build_object(v_key, p_patch->v_key);
    ELSIF v_key = ANY (v_meta_keys) THEN
      v_clean := v_clean || jsonb_build_object(v_key, p_patch->v_key);
    END IF;
  END LOOP;

  -- 2) Scope CUỐI = COALESCE(patch, hiện tại). Khoá có mặt với giá trị rỗng nghĩa là gỡ (NULL).
  v_t_building         := CASE WHEN v_clean ? 'building_id'         THEN NULLIF(v_clean->>'building_id','')::uuid         ELSE v_row.building_id END;
  v_t_room             := CASE WHEN v_clean ? 'room_id'             THEN NULLIF(v_clean->>'room_id','')::uuid             ELSE v_row.room_id END;
  v_t_tenant           := CASE WHEN v_clean ? 'tenant_id'           THEN NULLIF(v_clean->>'tenant_id','')::uuid           ELSE v_row.tenant_id END;
  v_t_contract         := CASE WHEN v_clean ? 'contract_id'         THEN NULLIF(v_clean->>'contract_id','')::uuid         ELSE v_row.contract_id END;
  v_t_invoice          := CASE WHEN v_clean ? 'invoice_id'          THEN NULLIF(v_clean->>'invoice_id','')::uuid          ELSE v_row.invoice_id END;
  v_t_shareholder      := CASE WHEN v_clean ? 'shareholder_id'      THEN NULLIF(v_clean->>'shareholder_id','')::uuid      ELSE v_row.shareholder_id END;
  v_t_account          := CASE WHEN v_clean ? 'account_id'          THEN NULLIF(v_clean->>'account_id','')::uuid          ELSE v_row.account_id END;
  v_t_change_account   := CASE WHEN v_clean ? 'change_account_id'   THEN NULLIF(v_clean->>'change_account_id','')::uuid   ELSE v_row.change_account_id END;
  v_t_rounding_account := CASE WHEN v_clean ? 'rounding_account_id' THEN NULLIF(v_clean->>'rounding_account_id','')::uuid ELSE v_row.rounding_account_id END;

  -- Mọi quan hệ non-null PHẢI cùng tổ chức với phiếu — chặn gắn chéo org.
  IF v_t_building IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.buildings x WHERE x.id = v_t_building AND x.organization_id = v_row.organization_id) THEN
    RAISE EXCEPTION 'building_id không thuộc tổ chức của phiếu' USING ERRCODE='42501'; END IF;
  IF v_t_room IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.rooms x WHERE x.id = v_t_room AND x.organization_id = v_row.organization_id) THEN
    RAISE EXCEPTION 'room_id không thuộc tổ chức của phiếu' USING ERRCODE='42501'; END IF;
  IF v_t_tenant IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.tenants x WHERE x.id = v_t_tenant AND x.organization_id = v_row.organization_id) THEN
    RAISE EXCEPTION 'tenant_id không thuộc tổ chức của phiếu' USING ERRCODE='42501'; END IF;
  IF v_t_contract IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.contracts x WHERE x.id = v_t_contract AND x.organization_id = v_row.organization_id) THEN
    RAISE EXCEPTION 'contract_id không thuộc tổ chức của phiếu' USING ERRCODE='42501'; END IF;
  IF v_t_invoice IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.invoices x WHERE x.id = v_t_invoice AND x.organization_id = v_row.organization_id) THEN
    RAISE EXCEPTION 'invoice_id không thuộc tổ chức của phiếu' USING ERRCODE='42501'; END IF;
  IF v_t_shareholder IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.shareholders x WHERE x.id = v_t_shareholder AND x.organization_id = v_row.organization_id) THEN
    RAISE EXCEPTION 'shareholder_id không thuộc tổ chức của phiếu' USING ERRCODE='42501'; END IF;
  IF v_t_account IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.accounts x WHERE x.id = v_t_account AND x.organization_id = v_row.organization_id) THEN
    RAISE EXCEPTION 'account_id không thuộc tổ chức của phiếu' USING ERRCODE='42501'; END IF;
  IF v_t_change_account IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.accounts x WHERE x.id = v_t_change_account AND x.organization_id = v_row.organization_id) THEN
    RAISE EXCEPTION 'change_account_id không thuộc tổ chức của phiếu' USING ERRCODE='42501'; END IF;
  IF v_t_rounding_account IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.accounts x WHERE x.id = v_t_rounding_account AND x.organization_id = v_row.organization_id) THEN
    RAISE EXCEPTION 'rounding_account_id không thuộc tổ chức của phiếu' USING ERRCODE='42501'; END IF;

  IF (v_touch_money OR p_items IS NOT NULL) THEN
    IF v_row.approval_status <> 'UNAPPROVED' OR COALESCE(v_row.posting_status,'UNPOSTED') = 'POSTED' THEN
      RAISE EXCEPTION 'Trục tiền chỉ sửa được khi phiếu Chờ duyệt (V2 §12.8); phiếu đã duyệt/ghi sổ dùng reversal'
        USING ERRCODE='55000';
    END IF;
    IF app_private.ie_flow_system_owned_v2(p_id) THEN
      RAISE EXCEPTION 'Phiếu thuộc writer hệ thống — sửa qua luồng nguồn' USING ERRCODE='42501';
    END IF;

    -- 3) Trục tiền: quyền sửa thật trên TOÀ CŨ và TOÀ MỚI (trượt một là deny).
    IF NOT public.is_super_admin() THEN
      SELECT allowed INTO v_ok_old FROM app_private.authorize_tenant_action_v3(
        auth.uid(), v_row.organization_id, 'income_expenses.edit', v_row.building_id, NULL);
      SELECT allowed INTO v_ok_new FROM app_private.authorize_tenant_action_v3(
        auth.uid(), v_row.organization_id, 'income_expenses.edit', v_t_building, NULL);
      IF NOT (COALESCE(v_ok_old, false) AND COALESCE(v_ok_new, false)) THEN
        RAISE EXCEPTION 'Không có quyền sửa trục tiền của phiếu trên toà nhà này (cần quyền ở cả toà cũ lẫn toà mới)'
          USING ERRCODE='42501';
      END IF;
    END IF;

    -- Đổi sổ quỹ đòi GIỮ SỔ cả bên đi lẫn bên đến.
    IF v_clean ? 'account_id' THEN
      v_new_account := NULLIF(v_clean->>'account_id','')::uuid;
      IF v_new_account IS DISTINCT FROM v_row.account_id THEN
        IF v_row.account_id IS NOT NULL THEN
          PERFORM app_private.assert_cashbook_access_v2(
            v_row.organization_id, v_row.account_id, 'CUSTODIAN', v_actor.membership_id);
        END IF;
        IF v_new_account IS NOT NULL THEN
          PERFORM app_private.assert_cashbook_access_v2(
            v_row.organization_id, v_new_account, 'CUSTODIAN', v_actor.membership_id);
        END IF;
      END IF;
    END IF;
  ELSE
    -- 4) Nhánh CHỈ-METADATA: giữ nguyên tập người gọi cũ (người tạo phiếu
    -- vẫn dán được ảnh chứng từ) nhưng quyết định bằng authorize_tenant_action_v3
    -- thay helper STABLE.
    IF NOT public.is_super_admin() THEN
      SELECT allowed INTO v_ok_meta FROM app_private.authorize_tenant_action_v3(
        auth.uid(), v_row.organization_id, 'income_expenses.edit', v_row.building_id, NULL);
    ELSE
      v_ok_meta := true;
    END IF;
    IF NOT (
         v_row.user_id = auth.uid()
      OR COALESCE(v_ok_meta, false)
      OR app_private.ie_has_cashbook_possession_v1(
           v_row.organization_id, v_row.account_id, v_actor.membership_id)
    ) THEN
      RAISE EXCEPTION 'Không có quyền sửa thông tin phiếu này' USING ERRCODE='42501';
    END IF;
  END IF;

  -- Cấm thêm/gỡ dấu hiệu tiền trong ghi chú, ở MỌI trạng thái.
  IF v_clean ? 'notes' THEN
    PERFORM app_private.assert_notes_markers_unchanged_v1(v_row.notes, v_clean->>'notes');
  END IF;

  -- Ảnh: phiếu Chờ duyệt & chưa ghi sổ thì thay cả mảng (gỡ ảnh dán
  -- nhầm trên nháp). Phiếu đã duyệt/ghi sổ thì CHỈ NỐI THÊM — bằng
  -- chứng đã hạch toán không được biến mất trong im lặng.
  v_can_replace_attachments := (
    v_row.approval_status = 'UNAPPROVED'
    AND COALESCE(v_row.posting_status,'UNPOSTED') <> 'POSTED'
  );

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
      attachments         = CASE
                              WHEN NOT (v_clean ? 'attachments') THEN ie.attachments
                              WHEN v_can_replace_attachments
                                THEN COALESCE(v_clean->'attachments', '[]'::jsonb)
                              ELSE app_private.ie_attachments_union_v1(ie.attachments, v_clean->'attachments')
                            END,
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
      SELECT COALESCE(jsonb_object_agg(k, v_item->k), '{}'::jsonb)
        INTO v_item_clean
      FROM unnest(v_item_keys) AS k
      WHERE v_item ? k;

      INSERT INTO public.income_expense_items
      SELECT * FROM jsonb_populate_record(NULL::public.income_expense_items,
        v_item_clean || jsonb_build_object('income_expense_id', p_id));
    END LOOP;
  END IF;

  INSERT INTO app_private.finance_v2_semantic_event_log (organization_id, event_kind, source_table, source_id, source_kind, actor, txid)
  VALUES (v_row.organization_id, 'COMPAT_UPDATE', 'income_expenses', p_id, 'V2_WRITE', auth.uid(), pg_current_xact_id());
  RETURN jsonb_build_object('id', p_id);
END
$$;

-- Nghiệm thu: thân hàm đang cài phải khoá org, tính scope cuối, authorize hai
-- lần và KHÔNG còn dùng helper STABLE làm quyết định.
DO $$
DECLARE v_src text;
BEGIN
  SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'ie_compat_update_pending_v2';
  IF v_src IS NULL
     OR v_src NOT LIKE '%lock_org_for_decision_v1%'
     OR v_src NOT LIKE '%v_t_building%'
     OR v_src NOT LIKE '%v_ok_old%'
     OR v_src LIKE '%ie_can_edit_money_axis_v1%' THEN
    RAISE EXCEPTION 'ie_compat_update_pending_v2 chưa kiểm scope mới. DỪNG.';
  END IF;
END $$;
