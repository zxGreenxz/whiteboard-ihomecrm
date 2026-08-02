-- =====================================================================
-- Đợt 0 — Vá LỖ A + LỖ B (thu chi linh hoạt, plan 29/07/2026)
--
-- LỖ A — `ie_compat_update_pending_v2`
--   `notes` và `attachments` nằm ở nhánh META, mà chốt trạng thái +
--   chặn phiếu hệ-thống-sở-hữu lại nằm TRONG `IF (v_touch_money OR
--   p_items IS NOT NULL)`. Nên một patch chỉ-meta ghi thẳng vào MỌI
--   phiếu, kể cả ĐÃ DUYỆT + ĐÃ GHI SỔ. Quyền duy nhất là
--   `ie_compat_actor_v2` = "có membership ACTIVE".
--
--   `notes` KHÔNG phải chữ trang trí — nó là LOGIC TIỀN THẬT:
--     * public.recompute_invoice_for_id TRỪ tiền hoá đơn theo
--       `notes LIKE '[Hoàn trả thanh lý]%'`
--       (20260728160000_b1_carried_debt_derived.sql)
--     * public.trg_forfeit_settle_on_approve rẽ nhánh theo
--       `notes NOT LIKE '[CẤN CỌC BỎ CỌC %'` và XOÁ CỨNG một dòng
--       `payments` khi APPROVED→CANCELLED
--       (20260619000001_payment_method_cantru.sql)
--   ⇒ Trước bản vá này, MỘT thành viên bất kỳ sửa một dòng chữ là
--     hạ `paid_amount` của hoá đơn và đòi lại tiền khách.
--
-- LỖ B — `update_income_expense_quick`
--   Đổi được `account_id` của phiếu ĐÃ GHI SỔ với điều kiện duy nhất
--   `user_id = auth.uid()`. `account_id` nằm trong danh sách `UPDATE OF`
--   của cầu a85 ⇒ cầu đảo posting ở sổ cũ và ghi posting ở sổ mới:
--   tiền rời két đồng nghiệp mà không ai cho phép.
--
-- NGUYÊN TẮC BẢN VÁ NÀY:
--   * CHỈ SIẾT, KHÔNG NỚI. Tập người gọi hợp lệ không rộng ra một ai.
--   * KHÔNG phá đường dùng thật: `useUploadPaymentReceipt` gửi patch
--     chỉ-`attachments` (p_items = NULL) lên phiếu đã ghi sổ để dán ảnh
--     chứng từ. Vì vậy ảnh chuyển sang CHỈ-NỐI-THÊM thay vì bị khoá.
--   * Hai hàm dưới đây được viết lại từ ĐỊNH NGHĨA ĐANG CHẠY TRÊN
--     PRODUCTION (`pg_get_functiondef`), không phải từ file migration cũ.
--     md5 gốc: ie_compat_update_pending_v2 = 9751b3acfe480727c5455842f2aec2e2
--              update_income_expense_quick  = b452b65dd2196ccc241dfd28acdbcf17
-- =====================================================================

BEGIN;

-- ── 1. Dấu hiệu TIỀN nằm trong `notes` ──────────────────────────────
-- Trả về tập dấu hiệu tiền mà chuỗi notes đang mang. Thay đổi tập này
-- = thay đổi cách hệ thống tính tiền ⇒ hai RPC bên dưới cấm tuyệt đối.
CREATE OR REPLACE FUNCTION app_private.ie_notes_money_markers_v1(p_notes text)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT COALESCE(
    array_remove(ARRAY[
      CASE WHEN COALESCE(p_notes, '') LIKE '[Hoàn trả thanh lý]%'
           THEN 'SETTLEMENT_REFUND' END,
      CASE WHEN COALESCE(p_notes, '') LIKE '[CẤN CỌC BỎ CỌC %'
           THEN 'FORFEIT_OFFSET' END
    ], NULL),
    ARRAY[]::text[]
  );
$fn$;

COMMENT ON FUNCTION app_private.ie_notes_money_markers_v1(text) IS
  'Dấu hiệu TIỀN nhúng trong income_expenses.notes. recompute_invoice_for_id và trg_forfeit_settle_on_approve đọc chúng để tính tiền — RPC client không được thêm/bớt.';

CREATE OR REPLACE FUNCTION app_private.assert_notes_markers_unchanged_v1(
  p_old text,
  p_new text
)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
AS $fn$
BEGIN
  IF app_private.ie_notes_money_markers_v1(p_old)
     IS DISTINCT FROM app_private.ie_notes_money_markers_v1(p_new) THEN
    RAISE EXCEPTION
      'Ghi chú chứa dấu hiệu hạch toán ([Hoàn trả thanh lý] / [CẤN CỌC BỎ CỌC]) — không được thêm hoặc gỡ qua sửa phiếu. Dùng đúng luồng nghiệp vụ.'
      USING ERRCODE = '55000';
  END IF;
END
$fn$;

-- ── 2. Ảnh chứng từ: hợp nhất (chỉ nối thêm) ────────────────────────
-- Giữ nguyên thứ tự cũ, nối phần tử mới chưa có. Dùng cho phiếu đã
-- duyệt/ghi sổ: dán thêm được, gỡ bằng chứng thì không.
CREATE OR REPLACE FUNCTION app_private.ie_attachments_union_v1(
  p_old jsonb,
  p_new jsonb
)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT COALESCE(p_old, '[]'::jsonb) || COALESCE((
    SELECT jsonb_agg(DISTINCT e.value)
    FROM jsonb_array_elements(COALESCE(p_new, '[]'::jsonb)) AS e
    WHERE NOT COALESCE(p_old, '[]'::jsonb) @> jsonb_build_array(e.value)
  ), '[]'::jsonb);
$fn$;

-- ── 3. Cổng quyền dùng chung cho hai RPC ────────────────────────────
-- SIẾT: trước đây chỉ cần membership ACTIVE (compat) hoặc là người tạo
-- (quick). Nay trục tiền đòi quyền thật; trục metadata giữ nguyên tập
-- người gọi cũ để không gãy luồng dán ảnh chứng từ.
CREATE OR REPLACE FUNCTION app_private.ie_can_edit_money_axis_v1(
  p_organization_id uuid,
  p_building_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_allowed boolean;
BEGIN
  IF public.is_super_admin() THEN
    RETURN true;
  END IF;

  SELECT allowed INTO v_allowed
  FROM app_private.authorize_tenant_action_v3(
    auth.uid(), p_organization_id, 'income_expenses.edit', p_building_id, NULL
  );

  RETURN COALESCE(v_allowed, false);
END
$fn$;

REVOKE ALL ON FUNCTION app_private.ie_can_edit_money_axis_v1(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION app_private.ie_has_cashbook_possession_v1(
  p_organization_id uuid,
  p_cashbook_id uuid,
  p_membership_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
  SELECT EXISTS (
    SELECT 1
    FROM public.cashbook_possession_bindings b
    WHERE b.organization_id = p_organization_id
      AND b.cashbook_id     = p_cashbook_id
      AND b.membership_id   = p_membership_id
      AND b.possession_kind IN ('CUSTODIAN', 'KNOWER')
      AND b.valid_from <= now()
      AND (b.valid_to IS NULL OR b.valid_to > now())
  );
$fn$;

REVOKE ALL ON FUNCTION app_private.ie_has_cashbook_possession_v1(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- ── 4. ie_compat_update_pending_v2 — bản đã siết ────────────────────
CREATE OR REPLACE FUNCTION public.ie_compat_update_pending_v2(
  p_id uuid,
  p_patch jsonb,
  p_items jsonb DEFAULT NULL::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
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

  IF (v_touch_money OR p_items IS NOT NULL) THEN
    IF v_row.approval_status <> 'UNAPPROVED' OR COALESCE(v_row.posting_status,'UNPOSTED') = 'POSTED' THEN
      RAISE EXCEPTION 'Trục tiền chỉ sửa được khi phiếu Chờ duyệt (V2 §12.8); phiếu đã duyệt/ghi sổ dùng reversal'
        USING ERRCODE='55000';
    END IF;
    IF app_private.ie_flow_system_owned_v2(p_id) THEN
      RAISE EXCEPTION 'Phiếu thuộc writer hệ thống — sửa qua luồng nguồn' USING ERRCODE='42501';
    END IF;

    -- SIẾT MỚI: trục tiền đòi quyền sửa thật trên TOÀ, không phải chỉ
    -- "có chân trong tổ chức".
    IF NOT app_private.ie_can_edit_money_axis_v1(v_row.organization_id, v_row.building_id) THEN
      RAISE EXCEPTION 'Không có quyền sửa trục tiền của phiếu trên toà nhà này' USING ERRCODE='42501';
    END IF;

    -- SIẾT MỚI: đổi sổ quỹ đòi GIỮ SỔ cả bên đi lẫn bên đến.
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
    -- Nhánh CHỈ-METADATA: giữ nguyên tập người gọi cũ (người tạo phiếu
    -- vẫn dán được ảnh chứng từ) nhưng không còn là cửa hậu sửa tiền,
    -- vì `notes` bị canh dấu và `attachments` chỉ nối thêm.
    IF NOT (
         v_row.user_id = auth.uid()
      OR app_private.ie_can_edit_money_axis_v1(v_row.organization_id, v_row.building_id)
      OR app_private.ie_has_cashbook_possession_v1(
           v_row.organization_id, v_row.account_id, v_actor.membership_id)
    ) THEN
      RAISE EXCEPTION 'Không có quyền sửa thông tin phiếu này' USING ERRCODE='42501';
    END IF;
  END IF;

  -- SIẾT MỚI: cấm thêm/gỡ dấu hiệu tiền trong ghi chú, ở MỌI trạng thái.
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
$fn$;

-- ── 5. update_income_expense_quick — bản đã siết ────────────────────
-- Giữ nguyên chữ ký + kiểu trả về (FE chỉ đọc `error`, PostgREST đã
-- cache schema) và giữ nguyên tập người gọi cũ. Chỉ thêm rào.
CREATE OR REPLACE FUNCTION public.update_income_expense_quick(
  p_id uuid,
  p_account_id uuid,
  p_attachments jsonb,
  p_notes text
)
RETURNS public.income_expenses
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_row public.income_expenses;
  v_before public.income_expenses%ROWTYPE;
  v_actor record;
  v_posted boolean;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_before
  FROM public.income_expenses
  WHERE id = p_id AND deleted_at IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Không tìm thấy phiếu hoặc bạn không có quyền sửa'
      USING ERRCODE = '42501';
  END IF;

  -- Tập người gọi GIỮ NGUYÊN như trước bản vá (chỉ siết thêm bên dưới).
  IF NOT (v_before.user_id = auth.uid() OR public.is_super_admin()) THEN
    RAISE EXCEPTION 'Không tìm thấy phiếu hoặc bạn không có quyền sửa'
      USING ERRCODE = '42501';
  END IF;

  IF v_before.approval_status = 'CANCELLED' THEN
    RAISE EXCEPTION 'Phiếu đã hủy — không sửa' USING ERRCODE = '55000';
  END IF;

  SELECT * INTO v_actor FROM app_private.ie_compat_actor_v2(v_before.organization_id);
  v_posted := COALESCE(v_before.posting_status, 'UNPOSTED') = 'POSTED';

  -- SIẾT MỚI (LỖ B): `account_id` nằm trong `UPDATE OF` của cầu a85.
  -- Đổi sổ trên phiếu ĐÃ GHI SỔ khiến cầu đảo posting ở sổ cũ và ghi
  -- posting ở sổ mới — tiền rời két người khác. Cấm thẳng.
  IF p_account_id IS DISTINCT FROM v_before.account_id THEN
    IF v_posted THEN
      RAISE EXCEPTION 'Phiếu đã ghi sổ — không đổi sổ quỹ ở đây. Hoàn tác rồi lập lại phiếu.'
        USING ERRCODE = '55000';
    END IF;
    IF v_actor.membership_id IS NULL THEN
      RAISE EXCEPTION 'Không có membership active trong organization phiếu' USING ERRCODE='42501';
    END IF;
    IF v_before.account_id IS NOT NULL THEN
      PERFORM app_private.assert_cashbook_access_v2(
        v_before.organization_id, v_before.account_id, 'CUSTODIAN', v_actor.membership_id);
    END IF;
    IF p_account_id IS NOT NULL THEN
      PERFORM app_private.assert_cashbook_access_v2(
        v_before.organization_id, p_account_id, 'CUSTODIAN', v_actor.membership_id);
    END IF;
  END IF;

  -- SIẾT MỚI: dấu hiệu tiền trong ghi chú (xem LỖ A).
  PERFORM app_private.assert_notes_markers_unchanged_v1(v_before.notes, p_notes);

  UPDATE public.income_expenses
  SET
    account_id  = p_account_id,
    -- Phiếu đã ghi sổ: ảnh chỉ nối thêm, không gỡ bằng chứng.
    attachments = CASE
                    WHEN v_posted
                      THEN app_private.ie_attachments_union_v1(attachments, p_attachments)
                    ELSE COALESCE(p_attachments, '[]'::jsonb)
                  END,
    notes       = p_notes
  WHERE id = p_id
    AND deleted_at IS NULL
  RETURNING * INTO v_row;

  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'Không tìm thấy phiếu hoặc bạn không có quyền sửa'
      USING ERRCODE = '42501';
  END IF;

  -- SIẾT MỚI: thao tác này trước đây KHÔNG để lại dấu vết nào.
  PERFORM app_private.append_income_expense_event_v1(
    v_row.organization_id,
    p_id,
    'MANUAL_LOG',
    auth.uid(),
    NULL,
    v_before.approval_status,
    v_row.approval_status,
    'Sửa nhanh: sổ quỹ/ảnh/ghi chú'
  );

  RETURN v_row;
END
$fn$;

COMMIT;
