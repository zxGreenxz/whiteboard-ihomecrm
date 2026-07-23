-- Finance V2 — Stage 7b: drain-compat gateway RPCs (plan §8 caller drain, §9.3).
--
-- Cổng chuyển tiếp SECURITY DEFINER để các caller FE cuối cùng (edit phiếu, import/batch,
-- copilot, refund, đổi phương thức/biên nhận) rời raw DML TRƯỚC khi Stage-7 revoke
-- INSERT/UPDATE/DELETE của client trên income_expenses/_items. Mọi cổng:
--   - actor từ auth.uid() + membership ACTIVE đúng org (bỏ qua org/user client gửi);
--   - birth LUÔN UNAPPROVED/PENDING (import/batch hết default-APPROVED — §8);
--   - trục tiền (sổ/số tiền/loại/ngày) CHỈ sửa khi phiếu còn UNAPPROVED và chưa POSTED;
--     metadata (ghi chú/ảnh/phương thức) sửa được khi chưa hủy;
--   - flow-owned subject bị từ chối (adapter của owner xử lý);
--   - không fallback, lỗi = lỗi thật.
-- Không đổi feature mode, không enroll org.

BEGIN;

-- ---------------------------------------------------------------------------
-- Helper: resolve actor membership trong org, RAISE 42501 nếu không có.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_private.ie_compat_actor_v2(p_org uuid)
RETURNS TABLE (user_id uuid, membership_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $fn$
  SELECT m.user_id, m.id
  FROM public.organization_memberships m
  WHERE m.user_id = auth.uid() AND m.organization_id = p_org AND m.status = 'ACTIVE'
  LIMIT 1;
$fn$;
REVOKE ALL ON FUNCTION app_private.ie_compat_actor_v2(uuid) FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 1) ie_compat_insert_v2: tạo phiếu + items server-side, birth pending bắt buộc.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ie_compat_insert_v2(p_row jsonb, p_items jsonb DEFAULT '[]'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $fn$
DECLARE
  v_org uuid;
  v_actor record;
  v_id uuid;
  v_clean jsonb;
  v_item jsonb;
BEGIN
  v_org := COALESCE(
    (SELECT a.organization_id FROM public.accounts a WHERE a.id = (p_row->>'account_id')::uuid),
    (SELECT b.organization_id FROM public.buildings b WHERE b.id = (p_row->>'building_id')::uuid),
    (p_row->>'organization_id')::uuid);
  IF v_org IS NULL THEN
    SELECT m.organization_id INTO v_org FROM public.organization_memberships m
    WHERE m.user_id = auth.uid() AND m.status='ACTIVE' LIMIT 1;
  END IF;
  SELECT * INTO v_actor FROM app_private.ie_compat_actor_v2(v_org);
  IF v_actor.membership_id IS NULL THEN
    RAISE EXCEPTION 'Không có membership active trong organization phiếu' USING ERRCODE='42501';
  END IF;

  -- Blacklist: client không được set trạng thái duyệt/posting/actor server-owned (§9.3).
  v_clean := (p_row - 'approval_status' - 'approved_by' - 'approved_at' - 'posting_id'
              - 'posted_at_v2' - 'posting_mode' - 'posting_status' - 'active_posting_id_v2'
              - 'reversed_by_posting_id' - 'deleted_at' - 'maker_user_id' - 'maker_membership_id'
              - 'birth_operation_id' - 'birth_txid' - 'review_state' - 'organization_id' - 'user_id')
             || jsonb_build_object(
                  'organization_id', v_org,
                  'user_id', COALESCE((p_row->>'user_id')::uuid, auth.uid()),
                  'approval_status', 'UNAPPROVED',
                  'review_state', 'PENDING',
                  'posting_mode', 'CASHBOOK',
                  'posting_status', 'UNPOSTED',
                  'maker_user_id', auth.uid(),
                  'maker_membership_id', v_actor.membership_id);
  IF p_row ? 'id' THEN v_clean := v_clean || jsonb_build_object('id', (p_row->>'id')::uuid); END IF;

  INSERT INTO public.income_expenses
  SELECT * FROM jsonb_populate_record(NULL::public.income_expenses, v_clean)
  RETURNING id INTO v_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb)) LOOP
    INSERT INTO public.income_expense_items
    SELECT * FROM jsonb_populate_record(NULL::public.income_expense_items,
      (v_item - 'income_expense_id') || jsonb_build_object('income_expense_id', v_id));
  END LOOP;

  INSERT INTO app_private.finance_v2_semantic_event_log (organization_id, event_kind, source_table, source_id, source_kind, actor, txid)
  VALUES (v_org, 'COMPAT_INSERT', 'income_expenses', v_id, 'V2_WRITE', auth.uid(), pg_current_xact_id());
  RETURN jsonb_build_object('id', v_id, 'approval_status', 'UNAPPROVED');
END
$fn$;

-- ---------------------------------------------------------------------------
-- 2) ie_compat_update_pending_v2: sửa phiếu — trục tiền chỉ khi pending.
-- ---------------------------------------------------------------------------
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
    'category_id','shareholder_id','contract_id','invoice_id'];
  v_meta_keys text[] := ARRAY['name','notes','payment_method','receipt_image_url','attachments',
    'repeat_frequency','repeat_day'];
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
    END IF; -- key lạ: bỏ qua im lặng (server-owned/không whitelist)
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
      name                = COALESCE(v_clean->>'name', ie.name),
      notes               = CASE WHEN v_clean ? 'notes' THEN v_clean->>'notes' ELSE ie.notes END,
      payment_method      = CASE WHEN v_clean ? 'payment_method' THEN v_clean->>'payment_method' ELSE ie.payment_method END,
      receipt_image_url   = CASE WHEN v_clean ? 'receipt_image_url' THEN v_clean->>'receipt_image_url' ELSE ie.receipt_image_url END,
      attachments         = CASE WHEN v_clean ? 'attachments' THEN ARRAY(SELECT jsonb_array_elements_text(v_clean->'attachments')) ELSE ie.attachments END
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

-- ---------------------------------------------------------------------------
-- 3) ie_compat_cancel_v2: hủy hàng loạt — CHỈ phiếu chưa ghi sổ.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ie_compat_cancel_v2(p_ids uuid[], p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $fn$
DECLARE
  v_id uuid;
  v_row public.income_expenses%ROWTYPE;
  v_actor record;
  v_done integer := 0;
BEGIN
  FOREACH v_id IN ARRAY p_ids LOOP
    SELECT * INTO v_row FROM public.income_expenses WHERE id = v_id AND deleted_at IS NULL FOR UPDATE;
    CONTINUE WHEN NOT FOUND;
    SELECT * INTO v_actor FROM app_private.ie_compat_actor_v2(v_row.organization_id);
    IF v_actor.membership_id IS NULL THEN
      RAISE EXCEPTION 'Không có membership active trong organization phiếu' USING ERRCODE='42501';
    END IF;
    IF COALESCE(v_row.posting_status,'UNPOSTED') = 'POSTED' THEN
      RAISE EXCEPTION 'Phiếu % đã ghi sổ — dùng reversal, không hủy trực tiếp', v_id USING ERRCODE='55000';
    END IF;
    IF app_private.is_income_expense_flow_owned(v_id) THEN
      RAISE EXCEPTION 'Phiếu % thuộc writer hệ thống', v_id USING ERRCODE='42501';
    END IF;
    UPDATE public.income_expenses SET
      approval_status='CANCELLED', review_state='RESOLVED',
      cancellation_kind=COALESCE(cancellation_kind,'COMPAT_BATCH_CANCEL'),
      notes = CASE WHEN p_reason IS NULL THEN notes ELSE COALESCE(notes,'') || E'\n[Hủy] ' || p_reason END
    WHERE id = v_id;
    v_done := v_done + 1;
  END LOOP;
  RETURN jsonb_build_object('cancelled', v_done);
END
$fn$;

-- ---------------------------------------------------------------------------
-- 4) create_invoice_refund_obligation_v2: wrapper public cho adapter refund §8.1.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_invoice_refund_obligation_v2(
  p_invoice_id uuid, p_amount numeric, p_reason text DEFAULT NULL,
  p_refund_class text DEFAULT 'REFUND_CONTRA_REVENUE', p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $fn$
DECLARE
  v_org uuid; v_building uuid; v_actor record; v_result jsonb;
BEGIN
  SELECT i.organization_id, i.building_id INTO v_org, v_building
  FROM public.invoices i WHERE i.id = p_invoice_id;
  IF v_org IS NULL THEN RAISE EXCEPTION 'Invoice không tồn tại' USING ERRCODE='P0002'; END IF;
  SELECT * INTO v_actor FROM app_private.ie_compat_actor_v2(v_org);
  IF v_actor.membership_id IS NULL THEN
    RAISE EXCEPTION 'Không có membership active trong organization invoice' USING ERRCODE='42501';
  END IF;
  v_result := app_private.reserve_invoice_refund_obligation_v2(
    v_org, p_invoice_id, v_building, p_amount, p_refund_class, 'invoice.refund',
    v_actor.user_id, v_actor.membership_id,
    COALESCE(p_idempotency_key, 'refund:' || p_invoice_id::text || ':' || md5(p_amount::text || COALESCE(p_reason,''))));
  IF p_reason IS NOT NULL AND (v_result ? 'voucher_id') THEN
    UPDATE public.income_expenses SET notes = COALESCE(notes,'') || E'\n[Lý do hoàn] ' || p_reason
    WHERE id = (v_result->>'voucher_id')::uuid;
  END IF;
  RETURN v_result;
END
$fn$;

-- ACL
DO $acl$
DECLARE v_fn text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public.ie_compat_insert_v2(jsonb,jsonb)',
    'public.ie_compat_update_pending_v2(uuid,jsonb,jsonb)',
    'public.ie_compat_cancel_v2(uuid[],text)',
    'public.create_invoice_refund_obligation_v2(uuid,numeric,text,text,text)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', v_fn);
    IF to_regrole('anon') IS NOT NULL THEN EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', v_fn); END IF;
    IF to_regrole('service_role') IS NOT NULL THEN EXECUTE format('REVOKE ALL ON FUNCTION %s FROM service_role', v_fn); END IF;
    IF to_regrole('authenticated') IS NOT NULL THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', v_fn); END IF;
  END LOOP;
END
$acl$;

COMMIT;

NOTIFY pgrst, 'reload schema';
