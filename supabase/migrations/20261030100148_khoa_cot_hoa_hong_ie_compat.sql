-- =============================================================================
-- khoa_cot_hoa_hong_ie_compat — bịt lối lập phiếu hoa hồng thứ hai qua
-- ie_compat_insert_v2 (soát "1 hợp đồng chỉ 1 phiếu hoa hồng", 30/10/2026).
-- =============================================================================
-- LỖI
--   ie_compat_insert_v2 là hàm ghi phiếu chung, vai authenticated gọi được. Hàm lột
--   các cột máy chủ sở hữu khỏi p_row nhưng chưa lột commission_kind,
--   commission_legacy_dup và system_source. Người gọi gửi p_items = [] (không có
--   dòng hạng mục nên chốt hạng mục chỉ-hệ-thống không xét), tự khai
--   commission_kind = 'broker' + commission_legacy_dup = true + số tiền đúng mức
--   bậc ⇒ ra phiếu môi giới SỐNG thứ hai của cùng hợp đồng. Unique index
--   uq_ie_commission_per_contract bỏ qua dòng mang cờ legacy, còn trigger suy loại
--   hoa hồng chỉ chạy khi có dòng hạng mục. Đã tái hiện trên TEST (ROLLBACK) bằng
--   vai STAFF và PARTNER ngày 30/10.
--
-- SỬA
--   1. ie_compat_insert_v2: thêm commission_kind, commission_legacy_dup,
--      system_source vào danh sách cột lột. Phần còn lại của thân giữ nguyên
--      từng byte so với 20261003151606 (md5 e545b776…, khớp production đọc 30/10).
--      - commission_kind: chỉ trigger hạng mục (ie_recompute_commission_kind) suy ra.
--      - commission_legacy_dup: về mặc định false (vòng điền mặc định cột NOT NULL).
--      - system_source: dấu của luồng nghiệp vụ ('contract.commission',
--        'termination.refund', 'reservation.*'…), màn hình dùng để phân loại phiếu.
--      Không người gọi hợp lệ nào gửi ba cột này (đã rà: form Thu chi, nhập Excel,
--      phiếu đợt, cọc giữ chỗ, mọi hàm SQL gọi compat).
--   2. Trigger z97_commission_legacy_dup_guard (BEFORE INSERT OR UPDATE, WHEN dòng mang
--      cờ; áp cho mọi đường ghi, kể cả hàm SECURITY DEFINER): phiếu mới không được mang cờ
--      commission_legacy_dup; phiếu đang false không được bật lên true. Gỡ cờ
--      (true → false) vẫn được: phiếu khi đó trở lại unique index.
--      Cờ này chỉ do đợt backfill 20260709110000 đặt (3 phiếu trên production,
--      0 phiếu gắn cờ sau 09/07, đọc 30/10); không hàm nào khác ghi true.
--   3. ACL của ie_compat_insert_v2 khai lại tường minh (baseline không mang
--      GRANT/REVOKE): chỉ authenticated được EXECUTE, như production hiện tại.
--
-- KHÔNG ĐỤNG
--   Không sửa dữ liệu (3 phiếu legacy giữ nguyên cờ). Không đổi chữ ký hàm.
--   Các writer hoa hồng (create_commission_voucher, thưởng Sale từ phiếu cọc, chi
--   hỗ trợ tiền nhà) không đặt cờ legacy nên trigger mới không chặn chúng.
--
-- ĐƯỜNG LÙI
--   CREATE OR REPLACE lại ie_compat_insert_v2 từ 20261003151606;
--   DROP TRIGGER z97_commission_legacy_dup_guard ON public.income_expenses;
--   DROP FUNCTION app_private.ie_commission_legacy_dup_guard_v1().
--
-- Chạy được hai lượt liên tiếp và trên DB rỗng của Restore Drill (kiểm bằng catalog,
-- không cần dữ liệu).
-- =============================================================================

BEGIN;

SET LOCAL lock_timeout = '15s';

DO $requires$
BEGIN
  IF to_regprocedure('public.ie_compat_insert_v2(jsonb,jsonb)') IS NULL
     OR to_regprocedure('app_private.ie_compat_actor_v2(uuid)') IS NULL
     OR to_regclass('public.uq_ie_commission_per_contract') IS NULL
     OR (SELECT count(*) FROM pg_catalog.pg_attribute a
          WHERE a.attrelid = 'public.income_expenses'::regclass
            AND NOT a.attisdropped
            AND a.attname IN ('commission_kind', 'commission_legacy_dup', 'system_source')) <> 3 THEN
    RAISE EXCEPTION 'khoa_cot_hoa_hong_ie_compat_dependency_invalid';
  END IF;
  -- Thân đang chạy (= 20261003151606, production đọc 30/10) hoặc thân của chính
  -- file này (chạy lại). md5 bỏ CR.
  IF COALESCE((SELECT md5(replace(p.prosrc, chr(13), ''))
                 FROM pg_catalog.pg_proc p
                WHERE p.oid = to_regprocedure('public.ie_compat_insert_v2(jsonb,jsonb)')), '')
     NOT IN ('e545b77602646520215f1c2c84ee7930', '7c73daff8de8848a8802bb548a6c7e87') THEN
    RAISE EXCEPTION 'khoa_cot_hoa_hong_ie_compat_body_drift: public.ie_compat_insert_v2(jsonb,jsonb)';
  END IF;
END $requires$;

-- ---------- 1. ie_compat_insert_v2: lột cột hoa hồng và dấu nguồn hệ thống ----------
CREATE OR REPLACE FUNCTION public.ie_compat_insert_v2(p_row jsonb, p_items jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $function$
DECLARE
  v_org              uuid;
  v_colrec           record;
  v_defj             jsonb;
  v_actor            record;
  v_id               uuid;
  v_clean            jsonb;
  v_item             jsonb;
  v_items            jsonb := coalesce(p_items, '[]'::jsonb);
  v_draft_marker     text := nullif(btrim(coalesce(p_row ->> 'copilot_draft_marker', '')), '');
  v_copilot_draft    boolean := false;
  v_input_item       jsonb;
  v_item_type_id     uuid;
  v_item_quantity    numeric;
  v_item_unit_price  numeric;
  v_item_amount      numeric;
BEGIN
  -- A browser can send a marker-shaped field, but only the execute RPC can
  -- create a matching private row in this transaction.  Delete the row here
  -- so the capability is single-use even if the writer is called twice.
  IF v_draft_marker IS NOT NULL THEN
    DELETE FROM app_private.copilot_ie_writer_context_v1 c
     WHERE c.transaction_id = pg_current_xact_id()::text
       AND c.actor_id = auth.uid()
       AND c.context_name = 'copilot_execute_income_expense_v1'
       AND c.marker_digest = extensions.digest(
             convert_to(v_draft_marker, 'UTF8'), 'sha256')
       AND c.created_at > clock_timestamp() - interval '10 minutes'
       AND EXISTS (
         SELECT 1
           FROM app_private.copilot_ie_writer_capabilities_v1 cap
          WHERE cap.capability_key = 'income_expense_draft_v1'
            AND cap.enabled
       )
    RETURNING c.organization_id INTO v_org;
    v_copilot_draft := FOUND;
  END IF;

  IF v_copilot_draft THEN
    -- The private context owns organization identity.  A mismatching payload
    -- is an invariant failure, not a chance to fall back to another org.
    BEGIN
      IF (p_row ->> 'organization_id') IS NOT NULL
         AND (p_row ->> 'organization_id')::uuid IS DISTINCT FROM v_org THEN
        RAISE EXCEPTION 'copilot organization mismatch' USING ERRCODE = '42501';
      END IF;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'copilot organization mismatch' USING ERRCODE = '42501';
    END;
  ELSE
    -- Preserve the established resolution behavior for ordinary callers.
    v_org := COALESCE(
      (SELECT a.organization_id
         FROM public.accounts a
        WHERE a.id = (p_row ->> 'account_id')::uuid),
      (SELECT b.organization_id
         FROM public.buildings b
        WHERE b.id = (p_row ->> 'building_id')::uuid),
      (p_row ->> 'organization_id')::uuid);
    IF v_org IS NULL THEN
      SELECT m.organization_id INTO v_org
        FROM public.organization_memberships m
       WHERE m.user_id = auth.uid()
         AND m.status = 'ACTIVE'
       LIMIT 1;
    END IF;
  END IF;

  SELECT * INTO v_actor FROM app_private.ie_compat_actor_v2(v_org);
  IF v_actor.membership_id IS NULL THEN
    RAISE EXCEPTION 'active organization membership required' USING ERRCODE = '42501';
  END IF;

  -- Preserve the existing possession guard for callers that select a book.
  -- The Copilot path always strips account_id before the insert.
  IF (p_row ->> 'account_id') IS NOT NULL AND NOT v_copilot_draft THEN
    IF NOT EXISTS (
      SELECT 1
        FROM public.cashbook_possession_bindings b
       WHERE b.organization_id = v_org
         AND b.cashbook_id = (p_row ->> 'account_id')::uuid
         AND b.membership_id = v_actor.membership_id
         AND b.valid_to IS NULL
         AND (b.possession_kind = 'CUSTODIAN'
              OR (b.possession_kind = 'KNOWER'
                  AND COALESCE(p_row ->> 'type', '') = 'INCOME'))
    ) THEN
      RAISE EXCEPTION 'cashbook possession is not permitted' USING ERRCODE = '42501';
    END IF;
  END IF;

  IF v_copilot_draft THEN
    -- Re-resolve the building and item type inside the writer.  The execute
    -- RPC checks these too, but this is the final server-side boundary before
    -- a shared writer and its triggers observe any values.
    IF upper(coalesce(p_row ->> 'type', '')) NOT IN ('INCOME', 'EXPENSE') THEN
      RAISE EXCEPTION 'copilot type is invalid' USING ERRCODE = '22023';
    END IF;
    BEGIN
      IF NOT EXISTS (
        SELECT 1
          FROM public.buildings b
         WHERE b.id = (p_row ->> 'building_id')::uuid
           AND b.organization_id = v_org
           AND b.deleted_at IS NULL
      ) THEN
        RAISE EXCEPTION 'copilot building is not in organization' USING ERRCODE = '42501';
      END IF;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'copilot building is invalid' USING ERRCODE = '22023';
    END;

    IF jsonb_typeof(v_items) <> 'array' OR jsonb_array_length(v_items) <> 1 THEN
      RAISE EXCEPTION 'copilot requires exactly one item' USING ERRCODE = '22023';
    END IF;
    v_input_item := v_items -> 0;
    IF jsonb_typeof(v_input_item) <> 'object' THEN
      RAISE EXCEPTION 'copilot item must be an object' USING ERRCODE = '22023';
    END IF;

    BEGIN
      v_item_type_id := NULLIF(v_input_item ->> 'income_expense_type_id', '')::uuid;
      v_item_quantity := COALESCE(NULLIF(v_input_item ->> 'quantity', '')::numeric, 1);
      v_item_unit_price := NULLIF(v_input_item ->> 'unit_price', '')::numeric;
      v_item_amount := NULLIF(v_input_item ->> 'amount', '')::numeric;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'copilot item amount or type is invalid' USING ERRCODE = '22023';
    END;
    IF v_item_type_id IS NULL OR v_item_quantity IS NULL
       OR v_item_quantity <> 1 THEN
      RAISE EXCEPTION 'copilot item quantity or type is invalid' USING ERRCODE = '22023';
    END IF;
    IF v_item_unit_price IS NULL THEN
      v_item_unit_price := v_item_amount;
    END IF;
    IF v_item_amount IS NULL THEN
      v_item_amount := v_item_quantity * v_item_unit_price;
    END IF;
    IF v_item_unit_price IS NULL OR v_item_amount IS NULL
       OR v_item_unit_price::text IN ('NaN', 'Infinity', '-Infinity')
       OR v_item_amount::text IN ('NaN', 'Infinity', '-Infinity')
       OR v_item_unit_price <= 0
       OR v_item_amount <= 0
       OR v_item_amount IS DISTINCT FROM v_item_quantity * v_item_unit_price THEN
      RAISE EXCEPTION 'copilot item amount is invalid' USING ERRCODE = '22023';
    END IF;

    PERFORM 1
      FROM public.income_expense_types t
     WHERE t.id = v_item_type_id
       AND t.organization_id = v_org
       AND lower(t.type) = lower(p_row ->> 'type')
       AND NOT coalesce(t.system_only, false)
       AND (
         NOT coalesce(t.is_restricted, false)
         OR public.can_create_restricted_ie()
       )
     FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'copilot income/expense type is not permitted' USING ERRCODE = '42501';
    END IF;

    -- Rebuild the line from the allowlist.  Client-supplied organization,
    -- accounting class, lifecycle, and arbitrary columns never reach INSERT.
    v_items := jsonb_build_array(
      jsonb_build_object(
        'income_expense_type_id', v_item_type_id,
        'organization_id',        v_org,
        'description',            COALESCE(
          NULLIF(btrim(v_input_item ->> 'description'), ''),
          p_row ->> 'name'),
        'quantity',               1,
        'unit_price',             v_item_unit_price,
        'amount',                 v_item_amount
      )
    );
  END IF;

  -- Strip server-owned fields before applying the mode-specific values.
  -- 30/10/2026: lột cả cột hoa hồng và dấu nguồn hệ thống. commission_kind chỉ do
  -- trigger hạng mục suy ra; commission_legacy_dup về mặc định false (cờ chỉ dành
  -- cho phiếu trùng có trước 09/07/2026, xem trigger z97_commission_legacy_dup_guard);
  -- system_source là dấu của luồng nghiệp vụ, màn hình dùng để phân loại phiếu.
  -- Trước đây người gọi tự khai commission_kind + cờ legacy với p_items rỗng là lập
  -- được phiếu hoa hồng sống thứ hai cho cùng hợp đồng.
  v_clean := p_row - ARRAY[
    'approval_status', 'approved_by', 'approved_at', 'posting_id',
    'posted_at_v2', 'posting_mode', 'posting_status', 'active_posting_id_v2',
    'reversed_by_posting_id', 'deleted_at', 'maker_user_id',
    'maker_membership_id', 'birth_operation_id', 'birth_txid', 'review_state',
    'commission_kind', 'commission_legacy_dup', 'system_source',
    'organization_id', 'user_id', 'copilot_draft_marker', 'copilot_draft_only'
  ]::text[];

  v_clean := v_clean || jsonb_build_object(
    'organization_id', v_org,
    'user_id', auth.uid(),
    'approval_status', CASE
      WHEN v_copilot_draft THEN 'UNAPPROVED'
      WHEN COALESCE(p_row ->> 'type', '') = 'INCOME'
           AND COALESCE(p_row ->> 'repeat_cycle', 'NONE') = 'NONE'
        THEN 'APPROVED'
      ELSE 'UNAPPROVED'
    END,
    'review_state', CASE
      WHEN v_copilot_draft THEN 'PENDING'
      WHEN COALESCE(p_row ->> 'type', '') = 'INCOME'
           AND COALESCE(p_row ->> 'repeat_cycle', 'NONE') = 'NONE'
        THEN 'RESOLVED'
      ELSE 'PENDING'
    END,
    'approved_by', CASE
      WHEN v_copilot_draft THEN NULL::uuid
      WHEN COALESCE(p_row ->> 'type', '') = 'INCOME'
           AND COALESCE(p_row ->> 'repeat_cycle', 'NONE') = 'NONE'
        THEN auth.uid()
      ELSE NULL::uuid
    END,
    'approved_at', CASE
      WHEN v_copilot_draft THEN NULL::timestamptz
      WHEN COALESCE(p_row ->> 'type', '') = 'INCOME'
           AND COALESCE(p_row ->> 'repeat_cycle', 'NONE') = 'NONE'
        THEN now()
      ELSE NULL::timestamptz
    END,
    'posting_mode', 'CASHBOOK',
    'posting_status', 'UNPOSTED',
    'maker_user_id', auth.uid(),
    'maker_membership_id', v_actor.membership_id
  );

  -- Ordinary callers retain the established user override; the Copilot
  -- branch above always keeps the authenticated actor as the owner.
  IF NOT v_copilot_draft THEN
    v_clean := v_clean || jsonb_build_object(
      'user_id', COALESCE((p_row ->> 'user_id')::uuid, auth.uid())
    );
  END IF;

  IF p_row ? 'id' AND NOT v_copilot_draft THEN
    v_clean := v_clean || jsonb_build_object('id', (p_row ->> 'id')::uuid);
  END IF;

  IF v_copilot_draft THEN
    -- Draft mode has no cashbook, posting, approval, recurrence, or source
    -- linkage.  Derived accounting fields are left to their server triggers.
    v_clean := (v_clean - ARRAY[
      'id', 'code', 'account_id', 'contract_id', 'invoice_id', 'payment_id',
      'payment_collection_id', 'handover_id', 'handover_transfer_id',
      'room_id', 'bed_id', 'tenant_id', 'shareholder_id', 'utility_account_id',
      'approval_request_id', 'approval_version', 'posting_version',
      'review_version', 'review_reason', 'review_deadline',
      'review_owner_membership_id', 'verified_at', 'verified_by',
      'verified_by_name', 'verified_note', 'cancellation_kind',
      'source_payload_hash', 'recognition_source_mode', 'recognition_date',
      'system_source', 'idempotency_key', 'business_result_accounting',
      'counts_in_business_result', 'has_restricted_item', 'kqkd_amount',
      'repeat_cycle', 'repeat_infinity', 'repeat_count', 'repeat_auto_approve',
      'repeat_next_date', 'repeat_parent_id', 'repeat_remaining',
      'active_posting_id_v2', 'posting_id', 'posted_at_v2',
      'reversed_by_posting_id', 'approved_by', 'approved_at', 'review_state',
      'posting_mode', 'posting_status', 'total_amount'
    ]::text[]) || jsonb_build_object(
      'account_id', NULL::uuid,
      'contract_id', NULL::uuid,
      'invoice_id', NULL::uuid,
      'payment_id', NULL::uuid,
      'room_id', NULL::uuid,
      'bed_id', NULL::uuid,
      'tenant_id', NULL::uuid,
      'approval_status', 'UNAPPROVED',
      'review_state', 'PENDING',
      'approved_by', NULL::uuid,
      'approved_at', NULL::timestamptz,
      'posting_mode', 'CASHBOOK',
      'posting_status', 'UNPOSTED',
      'repeat_cycle', 'NONE',
      'repeat_infinity', false,
      'repeat_count', 0,
      'repeat_auto_approve', false,
      'repeat_next_date', NULL::date,
      'repeat_parent_id', NULL::uuid,
      'repeat_remaining', 0,
      'total_amount', v_item_amount
    );
  END IF;

  -- jsonb_populate_record makes absent columns explicit NULLs, so preserve
  -- the established generic default-fill behavior for NOT NULL columns.
  IF (v_clean ->> 'total_amount') IS NULL THEN
    v_clean := v_clean || jsonb_build_object('total_amount', COALESCE((
      SELECT SUM(COALESCE((i ->> 'amount')::numeric,
                          COALESCE((i ->> 'quantity')::numeric, 1)
                          * COALESCE((i ->> 'unit_price')::numeric, 0)))
        FROM jsonb_array_elements(v_items) i), 0));
  END IF;

  FOR v_colrec IN
    SELECT c.column_name, c.column_default
      FROM information_schema.columns c
     WHERE c.table_schema = 'public'
       AND c.table_name = 'income_expenses'
       AND c.is_nullable = 'NO'
       AND c.column_default IS NOT NULL
  LOOP
    IF (v_clean ->> v_colrec.column_name) IS NULL THEN
      EXECUTE format('SELECT to_jsonb(%s)', v_colrec.column_default) INTO v_defj;
      v_clean := v_clean || jsonb_build_object(v_colrec.column_name, v_defj);
    END IF;
  END LOOP;

  -- Danh mục chi chuẩn (03/10/2026): hạng mục CHI chỉ-hệ-thống (hoa hồng môi
  -- giới, thưởng nóng sale, các mục cọc/thanh lý) chỉ sinh từ luồng nghiệp vụ của
  -- chúng — các luồng đó ghi thẳng, không đi qua hàm này. Trang Thu chi bị
  -- create_income_expense_v1 từ chối (0A000) rồi tự rơi sang đây và lập tay được.
  -- Chặn trước mọi lệnh ghi. Nhánh Copilot đã kiểm riêng ở trên.
  IF NOT v_copilot_draft AND EXISTS (
    SELECT 1
      FROM jsonb_array_elements(v_items) e
      JOIN public.income_expense_types t
        ON t.id = nullif(e ->> 'income_expense_type_id', '')::uuid
     WHERE coalesce(t.system_only, false)
       AND lower(btrim(t.type)) = 'expense'
  ) THEN
    RAISE EXCEPTION 'Hạng mục này chỉ được tạo từ luồng nghiệp vụ (hợp đồng, phiếu cọc, thanh lý), không lập tay ở Thu chi'
      USING ERRCODE = '42501', HINT = 'ie_system_only_manual_blocked';
  END IF;

  INSERT INTO public.income_expenses
  SELECT * FROM jsonb_populate_record(NULL::public.income_expenses, v_clean)
  RETURNING id INTO v_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items) LOOP
    v_item := (v_item - 'income_expense_id')
              || jsonb_build_object('income_expense_id', v_id);
    FOR v_colrec IN
      SELECT c.column_name, c.column_default
        FROM information_schema.columns c
       WHERE c.table_schema = 'public'
         AND c.table_name = 'income_expense_items'
         AND c.is_nullable = 'NO'
         AND c.column_default IS NOT NULL
    LOOP
      IF (v_item ->> v_colrec.column_name) IS NULL THEN
        EXECUTE format('SELECT to_jsonb(%s)', v_colrec.column_default) INTO v_defj;
        v_item := v_item || jsonb_build_object(v_colrec.column_name, v_defj);
      END IF;
    END LOOP;
    INSERT INTO public.income_expense_items
    SELECT * FROM jsonb_populate_record(NULL::public.income_expense_items, v_item);
  END LOOP;

  INSERT INTO app_private.finance_v2_semantic_event_log
    (organization_id, event_kind, source_table, source_id, source_kind, actor, txid)
  VALUES
    (v_org, 'COMPAT_INSERT', 'income_expenses', v_id, 'V2_WRITE', auth.uid(), pg_current_xact_id());

  RETURN jsonb_build_object(
    'id', v_id,
    'approval_status', (SELECT approval_status
                          FROM public.income_expenses
                         WHERE id = v_id)
  );
END
$function$;

REVOKE ALL ON FUNCTION public.ie_compat_insert_v2(jsonb, jsonb) FROM PUBLIC;
DO $acl$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.ie_compat_insert_v2(jsonb, jsonb) FROM anon;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.ie_compat_insert_v2(jsonb, jsonb) FROM service_role;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.ie_compat_insert_v2(jsonb, jsonb) TO authenticated;
  END IF;
END $acl$;

-- ---------- 2. Cấm cờ "phiếu hoa hồng trùng cũ" cho phiếu mới ----------
CREATE OR REPLACE FUNCTION app_private.ie_commission_legacy_dup_guard_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_bat_co boolean;
BEGIN
  -- Cờ chỉ dành cho phiếu trùng có trước 20260709110000, để chúng nằm ngoài unique
  -- index uq_ie_commission_per_contract. Đặt cờ cho phiếu mới, hoặc bật lại trên
  -- phiếu đang nằm trong index, là tạo thêm phiếu hoa hồng sống cho cùng hợp đồng.
  IF TG_OP = 'INSERT' THEN
    v_bat_co := NEW.commission_legacy_dup IS TRUE;
  ELSE
    v_bat_co := NEW.commission_legacy_dup IS TRUE
                AND OLD.commission_legacy_dup IS NOT TRUE;
  END IF;
  IF v_bat_co THEN
    RAISE EXCEPTION 'Cờ "phiếu hoa hồng trùng cũ" chỉ dành cho phiếu có trước 09/07/2026, không đặt cho phiếu mới hay bật lại cho phiếu đang có (phiếu %)', NEW.id
      USING ERRCODE = '23514', HINT = 'ie_commission_legacy_dup_blocked';
  END IF;
  RETURN NEW;
END
$function$;
REVOKE ALL ON FUNCTION app_private.ie_commission_legacy_dup_guard_v1() FROM PUBLIC;
DO $acl$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION app_private.ie_commission_legacy_dup_guard_v1() FROM anon;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION app_private.ie_commission_legacy_dup_guard_v1() FROM authenticated;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION app_private.ie_commission_legacy_dup_guard_v1() FROM service_role;
  END IF;
END $acl$;

-- WHEN: hàm chỉ chạy cho dòng đang mang cờ (3 phiếu legacy hoặc lần đặt cờ bị chặn),
-- không tốn một lần gọi plpgsql cho mọi lần ghi phiếu khác.
DROP TRIGGER IF EXISTS z97_commission_legacy_dup_guard ON public.income_expenses;
CREATE TRIGGER z97_commission_legacy_dup_guard
  BEFORE INSERT OR UPDATE ON public.income_expenses
  FOR EACH ROW
  WHEN (NEW.commission_legacy_dup)
  EXECUTE FUNCTION app_private.ie_commission_legacy_dup_guard_v1();

-- ---------- 3. Kiểm bằng catalog ----------
DO $assert$
DECLARE
  p pg_catalog.pg_proc;
BEGIN
  SELECT * INTO p FROM pg_catalog.pg_proc
   WHERE oid = 'public.ie_compat_insert_v2(jsonb,jsonb)'::regprocedure;
  IF md5(replace(p.prosrc, chr(13), '')) <> '7c73daff8de8848a8802bb548a6c7e87'
     OR NOT p.prosecdef
     OR position('''commission_kind'', ''commission_legacy_dup'', ''system_source''' IN p.prosrc) = 0
     OR position('ie_system_only_manual_blocked' IN p.prosrc) = 0
     OR (to_regrole('authenticated') IS NOT NULL
         AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE'))
     OR (to_regrole('anon') IS NOT NULL
         AND has_function_privilege('anon', p.oid, 'EXECUTE')) THEN
    RAISE EXCEPTION 'khoa_cot_hoa_hong_ie_compat_contract_violated: public.ie_compat_insert_v2(jsonb,jsonb)';
  END IF;
  -- tgtype: ROW(1) | BEFORE(2) | INSERT(4) | UPDATE(16) = 23.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger t
     WHERE t.tgrelid = 'public.income_expenses'::regclass
       AND t.tgname = 'z97_commission_legacy_dup_guard'
       AND t.tgfoid = 'app_private.ie_commission_legacy_dup_guard_v1()'::regprocedure
       AND t.tgenabled = 'O'
       AND t.tgtype = 23
       AND t.tgqual IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'khoa_cot_hoa_hong_ie_compat_contract_violated: z97_commission_legacy_dup_guard';
  END IF;
END $assert$;

COMMIT;

NOTIFY pgrst, 'reload schema';
