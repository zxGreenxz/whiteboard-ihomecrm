-- =============================================================================
-- H3.1 (lát 2) — `create_income_expense_v2`: THÔI CẮT PHẦN LẺ CỦA SỐ LƯỢNG
--
-- VÌ SAO — lát 1 chưa với tới chỗ này
--   20260915144251 đã nới `income_expense_items.quantity` sang numeric(15,4).
--   Nới cột vá trọn hai đường ghi để CHÍNH KIỂU CỘT quyết định phép ép
--   (`ie_compat_insert_v2` dùng `::numeric`, `ie_compat_update_pending_v2` dùng
--   `jsonb_populate_record`). Nhưng writer này ÉP KIỂU NGAY TRONG THÂN HÀM:
--
--       COALESCE((v_item->>'quantity')::integer, 1)     (baseline:58217)
--
--   `::integer` cắt phần lẻ TRƯỚC khi giá trị chạm tới cột, nên cột có rộng ra
--   cũng không cứu được: 12,5 kWh vào đây vẫn thành 12, và trigger
--   `auto_calc_item_amount` nhân tiếp bằng 12. Hụt tiền, im lặng, không lỗi.
--
-- ĐÂY LÀ ĐƯỜNG NÀO
--   `create_income_expense_v2` là writer finance-v2. Hiện KHÔNG có lời gọi nào
--   từ `src/**` (đã quét: chỉ còn trong chú thích), nên lát này là VÁ TRƯỚC cho
--   đường sẽ dùng, không phải vá một lỗi đang chảy tiền hằng ngày.
--
-- CÒN HỞ — CÓ CHỦ Ý, KHÔNG SỬA Ở ĐÂY (đã đo, xem báo cáo H3)
--   `create_income_expense_v1` — đường ghi CHÍNH mà giao diện đang dùng
--   (mutations.ts:73) — KHÔNG làm tròn lặng lẽ. Nó TỪ CHỐI tường minh:
--       baseline:56140  OR v_quantity <> trunc(v_quantity) THEN
--       baseline:56141  RAISE EXCEPTION 'Số lượng hạng mục % phải là số nguyên hợp lệ >= 1'
--   Tức "số lượng là số nguyên ≥ 1" ở đó là một LUẬT NGHIỆP VỤ được cưỡng chế,
--   lại còn được chuẩn hoá bằng `trunc` TRƯỚC KHI đưa vào khoá idempotency
--   (baseline:56156, 56425). Cho phép số lẻ ở v1 vì thế không phải sửa một phép
--   ép kiểu — nó đổi luật nhập liệu VÀ đổi hình dạng khoá chống trùng. Việc đó
--   phải do chủ quyết, không phải việc kèm theo của một lát vá kiểu.
--
-- CÁCH LÀM: thân hàm TRÍCH BẰNG MÁY từ `supabase/baseline/schema.sql:58073-58242`
--   (md5 thân gốc: 4030ba583150ec932104d46615d901a7), đổi ĐÚNG MỘT chuỗi
--   `::integer` → `::numeric`, rồi assert không còn `::integer` nào. Không chép tay.
--   Baseline LÀ định nghĩa đang chạy: không migration nào sau 20260806 định nghĩa
--   lại hàm này (bản gần nhất là 20260723050000_finance_v2_writers.sql).
--
-- IDEMPOTENT: CREATE OR REPLACE, giữ nguyên chữ ký `(payload jsonb)` nên không
-- đẻ overload và ACL không rơi. Vẫn khẳng định lại ACL ở cuối cho khỏi phụ
-- thuộc trạng thái trước.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.create_income_expense_v2(payload jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'app_private'
    AS $$
DECLARE
  v_uid uuid;
  v_mid uuid;
  v_org uuid;
  v_building uuid := (payload->>'buildingId')::uuid;
  v_type text := payload->>'type';
  v_name text := payload->>'name';
  v_vdate date := (payload->>'voucherDate')::date;
  v_total numeric(18,2) := COALESCE((payload->>'totalAmount')::numeric, 0);
  v_notes text := payload->>'notes';
  v_payer text := payload->>'payerName';
  v_mode text := COALESCE(payload->>'postingMode', 'CASHBOOK');
  v_cashbook uuid := (payload->>'cashbookId')::uuid;
  v_idem text := payload->>'idempotencyKey';
  v_hash text := md5(payload::text);
  v_posting_status text;
  v_is_custodian boolean;
  v_is_knower boolean;
  v_keys text[] := ARRAY['cashbooks.post','income_expenses.create',
                         'income_expenses.reverse','income_expenses.cancel'];
  v_voucher_id uuid := gen_random_uuid();
  v_birth_op uuid := gen_random_uuid();
  v_counts boolean;
  v_kqkd numeric;
  v_recog date;
  v_op app_private.canonical_write_operations;
  v_item jsonb;
  v_class text;
  v_resp jsonb;
BEGIN
  IF v_building IS NULL THEN
    RAISE EXCEPTION 'create_income_expense_v2: buildingId is required' USING ERRCODE = '22023';
  END IF;
  IF v_type NOT IN ('INCOME','EXPENSE') THEN
    RAISE EXCEPTION 'create_income_expense_v2: type must be INCOME or EXPENSE' USING ERRCODE = '22023';
  END IF;
  IF v_name IS NULL OR length(btrim(v_name)) = 0 THEN
    RAISE EXCEPTION 'create_income_expense_v2: name is required' USING ERRCODE = '22023';
  END IF;
  IF v_vdate IS NULL THEN
    RAISE EXCEPTION 'create_income_expense_v2: voucherDate is required' USING ERRCODE = '22023';
  END IF;
  IF v_total <= 0 THEN
    RAISE EXCEPTION 'create_income_expense_v2: totalAmount must be positive' USING ERRCODE = '22023';
  END IF;
  IF v_mode NOT IN ('CASHBOOK','NON_CASH') THEN
    RAISE EXCEPTION 'create_income_expense_v2: postingMode must be CASHBOOK or NON_CASH' USING ERRCODE = '22023';
  END IF;
  IF v_idem IS NULL OR length(v_idem) = 0 THEN
    RAISE EXCEPTION 'create_income_expense_v2: idempotencyKey is required' USING ERRCODE = '22023';
  END IF;

  -- Resolve tenant from the building, then the actor's active membership.
  SELECT b.organization_id INTO v_org
  FROM public.buildings b WHERE b.id = v_building;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'create_income_expense_v2: building % not found', v_building USING ERRCODE = '42501';
  END IF;
  SELECT r.user_id, r.membership_id INTO v_uid, v_mid
  FROM app_private.resolve_finance_actor_v2(v_org) r;

  -- Idempotency reservation (subject_scope = building; subject_id filled on completion).
  v_op := app_private.finance_v2_begin_canonical_op(
    v_org, 'income_expense.create.v2', v_building::text, v_uid, v_mid, v_idem, v_hash, NULL);
  IF v_op.completed_at IS NOT NULL THEN
    RETURN COALESCE(v_op.response_payload, '{}'::jsonb);
  END IF;

  v_posting_status := CASE WHEN v_mode = 'CASHBOOK' THEN 'UNPOSTED' ELSE 'NOT_APPLICABLE' END;

  -- Possession-derived create permission (CASHBOOK mode only).
  IF v_mode = 'CASHBOOK' THEN
    IF v_cashbook IS NULL THEN
      RAISE EXCEPTION 'create_income_expense_v2: cashbookId is required for a CASHBOOK voucher' USING ERRCODE = '22023';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.accounts a
                   WHERE a.id = v_cashbook AND a.organization_id = v_org AND a.deleted_at IS NULL) THEN
      RAISE EXCEPTION 'create_income_expense_v2: cashbook % not found', v_cashbook USING ERRCODE = '42501';
    END IF;
    IF app_private.finance_v2_has_covering_deny(v_org, v_mid, v_cashbook, v_keys) THEN
      RAISE EXCEPTION 'create_income_expense_v2: create denied by covering DENY on cashbook %', v_cashbook USING ERRCODE = '42501';
    END IF;
    v_is_custodian := EXISTS (
      SELECT 1 FROM public.cashbook_possession_bindings b
      WHERE b.organization_id = v_org AND b.cashbook_id = v_cashbook AND b.membership_id = v_mid
        AND b.possession_kind = 'CUSTODIAN' AND b.valid_from <= now()
        AND (b.valid_to IS NULL OR b.valid_to > now()));
    v_is_knower := EXISTS (
      SELECT 1 FROM public.cashbook_possession_bindings b
      WHERE b.organization_id = v_org AND b.cashbook_id = v_cashbook AND b.membership_id = v_mid
        AND b.possession_kind = 'KNOWER' AND b.valid_from <= now()
        AND (b.valid_to IS NULL OR b.valid_to > now()));
    IF v_type = 'EXPENSE' AND NOT v_is_custodian THEN
      RAISE EXCEPTION 'create_income_expense_v2: only a CUSTODIAN may create an EXPENSE on cashbook %', v_cashbook USING ERRCODE = '42501';
    END IF;
    IF v_type = 'INCOME' AND NOT (v_is_custodian OR v_is_knower) THEN
      RAISE EXCEPTION 'create_income_expense_v2: CUSTODIAN or KNOWER possession required to create INCOME on cashbook %', v_cashbook USING ERRCODE = '42501';
    END IF;
  ELSE
    -- NON_CASH manual obligation requires the plain create capability at the building.
    IF NOT (SELECT allowed FROM app_private.authorize_tenant_action_v3(v_uid, v_org, 'income_expenses.create', v_building, NULL)) THEN
      RAISE EXCEPTION 'create_income_expense_v2: income_expenses.create required for a NON_CASH voucher' USING ERRCODE = '42501';
    END IF;
  END IF;

  -- Birth the header UNAPPROVED / PENDING, server-owned provenance. Never accept
  -- approved_*/posting/payment fields from the client payload.
  INSERT INTO public.income_expenses (
    id, user_id, type, name, building_id, room_id, tenant_id, voucher_date,
    total_amount, approval_status, notes, payer_name, account_id, organization_id,
    posting_mode, posting_status, review_state, review_version, approval_version,
    posting_version, maker_user_id, maker_membership_id, birth_operation_id,
    birth_txid, source_payload_hash, counts_in_business_result, kqkd_amount,
    recognition_date, recognition_source_mode
  ) VALUES (
    v_voucher_id, v_uid, v_type, v_name, v_building,
    (payload->>'roomId')::uuid, (payload->>'tenantId')::uuid, v_vdate,
    v_total, 'UNAPPROVED', v_notes, v_payer,
    CASE WHEN v_mode = 'CASHBOOK' THEN v_cashbook ELSE NULL END, v_org,
    v_mode, v_posting_status, 'PENDING', 1, 1,
    1, v_uid, v_mid, v_birth_op,
    pg_current_xact_id(), v_hash, true, 0,
    v_vdate, 'BASE'
  );

  -- Items (server classifies accounting_class; default PNL).
  IF jsonb_typeof(payload->'items') = 'array' THEN
    FOR v_item IN SELECT * FROM jsonb_array_elements(payload->'items') LOOP
      v_class := COALESCE(v_item->>'accountingClass', 'PNL');
      IF v_class NOT IN ('PNL','INTERNAL','CUSTOMER_CREDIT','DEPOSIT') THEN
        RAISE EXCEPTION 'create_income_expense_v2: invalid accountingClass %', v_class USING ERRCODE = '22023';
      END IF;
      IF (v_item->>'typeId') IS NULL THEN
        RAISE EXCEPTION 'create_income_expense_v2: each item requires typeId' USING ERRCODE = '22023';
      END IF;
      INSERT INTO public.income_expense_items (
        id, income_expense_id, income_expense_type_id, description, quantity,
        unit_price, amount, notes, start_date, end_date, organization_id, accounting_class
      ) VALUES (
        gen_random_uuid(), v_voucher_id, (v_item->>'typeId')::uuid, v_item->>'description',
        COALESCE((v_item->>'quantity')::numeric, 1), COALESCE((v_item->>'unitPrice')::numeric, 0),
        COALESCE((v_item->>'amount')::numeric, 0), v_item->>'notes',
        (v_item->>'startDate')::date, (v_item->>'endDate')::date, v_org, v_class
      );
    END LOOP;
  END IF;

  -- Server-owned business result (refresh header from resolver).
  SELECT br.counts, br.kqkd, br.recognition_date INTO v_counts, v_kqkd, v_recog
  FROM app_private.resolve_business_result_v2(v_voucher_id) br;
  UPDATE public.income_expenses
     SET counts_in_business_result = v_counts, kqkd_amount = v_kqkd, recognition_date = v_recog
   WHERE id = v_voucher_id;

  v_resp := jsonb_build_object(
    'voucherId', v_voucher_id, 'approvalStatus', 'UNAPPROVED',
    'reviewState', 'PENDING', 'postingMode', v_mode, 'postingStatus', v_posting_status,
    'reviewVersion', 1, 'approvalVersion', 1, 'postingVersion', 1);

  PERFORM app_private.finance_v2_finish_canonical_op(
    v_org, 'income_expense.create.v2', v_building::text, v_uid, v_idem, v_voucher_id,
    v_resp, 'CREATED', 1, 1, 1);
  PERFORM app_private.finance_v2_log_event(v_org, 'income_expense.create.v2', v_voucher_id, v_uid, v_idem);
  RETURN v_resp;
END
$$;


-- CREATE OR REPLACE giữ nguyên ACL; khẳng định lại đúng bộ của
-- 20260725060000_authz_wave1_hardening.sql cho khỏi phụ thuộc trạng thái trước.
REVOKE ALL ON FUNCTION public.create_income_expense_v2(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_income_expense_v2(jsonb) TO authenticated;

COMMENT ON FUNCTION public.create_income_expense_v2(jsonb) IS
  'Writer finance-v2 cho phiếu thu/chi. 15/09/2026: số lượng hạng mục nhận số '
  'lẻ (ép ::numeric thay ::integer) sau khi income_expense_items.quantity nới '
  'sang numeric(15,4). Writer v1 vẫn cưỡng chế số nguyên — xem báo cáo H3.';
