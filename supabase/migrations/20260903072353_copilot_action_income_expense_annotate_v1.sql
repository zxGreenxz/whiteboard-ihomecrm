-- G2-D (1/3) — Action L3 `income_expense.annotate` theo Nonce ABI v1, KÈM việc
-- nối cặp writer thu/chi đang chạy vào cổng hành động + sổ.
--
-- HAI VIỆC TRONG MỘT FILE, VÀ VÌ SAO CHÚNG THUỘC VỀ NHAU
--   Từ hôm nay có một khuôn DUY NHẤT cho mọi đường ghi của Copilot: xem trước
--   phát nonce, người dùng bấm, execute tiêu nonce. Khuôn đó chỉ có nghĩa khi
--   MỌI đường ghi đi qua nó — kể cả đường đã live. Cặp `copilot_*_income_expense_v1`
--   ra đời trước `copilot_action_registry`/`copilot_action_gate_v1` nên nó KHÔNG
--   đọc registry, KHÔNG đọc cờ kill switch và KHÔNG ghi sổ hành động. Nghĩa là
--   hôm qua, tắt cờ `action:income_expense.create_draft` chỉ giấu cái tên tool
--   khỏi mô hình; ai cầm sẵn một nonce vẫn ghi được. Kill switch mà chỉ tắt được
--   ở client thì nó là gợi ý, không phải công tắc.
--
-- ĐỌC ĐỊNH NGHĨA THẬT TRƯỚC KHI CHÉP (án lệ 02/09 — writer phải lấy từ prod)
--   `pg_get_functiondef` trên production cho thấy hai hàm public hiện là VỎ MỎNG
--   bọc `copilot_preview_income_expense_legacy_v1` / `copilot_execute_income_expense_legacy_v1`
--   — do `20260831110236_copilot_restricted_category_guard_v1` đổi tên thân cũ
--   rồi dựng vỏ kiểm hạng mục hạn chế. Chép thân từ `20260830171108` như bản kế
--   hoạch ghi sẽ XOÁ hàng rào hạng mục hạn chế đó. Ở đây chỉ CHÈN hai dòng cổng
--   và một lời gọi sổ vào đúng cái vỏ đang chạy; phần còn lại giữ nguyên từng
--   chữ so với prod.
--
-- ĐƯỜNG LÙI
--   Hai hàm mới: DROP. Hai vỏ IE: apply lại nguyên văn `20260831110236`.
--   Hàng registry + hàng cờ: DELETE theo `action_id` / `contract_id`.

BEGIN;
SET LOCAL lock_timeout = '15s';

-- ---------------------------------------------------------------------------
-- 1. XEM TRƯỚC — `income_expense.annotate`
-- ---------------------------------------------------------------------------
-- Chỉ ghi chú. `annotate_income_expense_v1` còn nhận đính kèm ảnh, nhưng ảnh là
-- bằng chứng chứng từ: thêm/gỡ nó không phải "đảo ngược được" theo nghĩa L3, và
-- một mô hình dựng URL ảnh là một đường đưa nội dung ngoài vào sổ. Hai tham số
-- đó luôn NULL ở đây, và điều đó được ghim bằng test regex.
CREATE OR REPLACE FUNCTION public.copilot_preview_income_expense_annotate_v1(
  p_organization_id uuid,
  p_payload         jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, extensions
AS $xem_truoc_ghi_chu$
DECLARE
  v_actor     uuid := auth.uid();
  v_snapshot  jsonb;
  v_voucher   uuid;
  v_notes     text;
  v_ie        public.income_expenses%ROWTYPE;
  v_scope     record;
  v_nonce     bytea;
  v_canonical jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization_required' USING ERRCODE = '22023';
  END IF;

  -- CỔNG trước mọi thứ khác: registry -> cờ -> cấm khẩn cấp -> phạm vi quyền.
  -- Đặt ở đây chứ không sau khi tra phiếu là có chủ ý — một action đang tắt
  -- không được phép trả lời "phiếu đó có tồn tại không".
  v_snapshot := app_private.copilot_action_gate_v1(
    'income_expense.annotate', p_organization_id);

  BEGIN
    v_voucher := (p_payload ->> 'voucher_id')::uuid;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'payload_invalid' USING ERRCODE = '22023';
  END;
  IF v_voucher IS NULL THEN
    RAISE EXCEPTION 'payload_invalid' USING ERRCODE = '22023';
  END IF;

  v_notes := p_payload ->> 'notes';
  IF v_notes IS NULL THEN
    RAISE EXCEPTION 'ghi_chu_bat_buoc' USING ERRCODE = '22023';
  END IF;
  IF length(v_notes) > 5000 THEN
    RAISE EXCEPTION 'ghi_chu_qua_dai' USING ERRCODE = '22023';
  END IF;

  -- FAIL-CLOSED theo tổ chức: phiếu của công ty khác trả về ĐÚNG câu như phiếu
  -- không tồn tại. Một thông báo phân biệt hai trường hợp là một kênh dò xem
  -- công ty bên cạnh có phiếu id nào.
  SELECT * INTO v_ie
    FROM public.income_expenses
   WHERE id = v_voucher
     AND deleted_at IS NULL
     AND organization_id = p_organization_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'entity_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- Phạm vi TOÀ. Cổng chỉ khẳng định "có quyền ở đâu đó trong công ty"; phiếu
  -- này nằm ở một toà cụ thể, và người chỉ có quyền toà A không được sửa ghi
  -- chú phiếu của toà B.
  SELECT s.org_wide, s.building_ids
    INTO v_scope
    FROM app_private.authorized_scope_v3('income_expenses.edit', p_organization_id) s;
  IF NOT COALESCE(v_scope.org_wide, false)
     AND v_ie.building_id IS NOT NULL
     AND NOT (v_ie.building_id = ANY(COALESCE(v_scope.building_ids, ARRAY[]::uuid[]))) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;

  v_canonical := jsonb_build_object(
    'organization_id', p_organization_id,
    'voucher_id',      v_voucher,
    'notes',           v_notes
  );
  v_nonce := extensions.gen_random_bytes(32);

  INSERT INTO app_private.copilot_write_confirmations
    (nonce_digest, user_id, organization_id, tool, payload_hash,
     permission_key, expires_at)
  VALUES
    (extensions.digest(v_nonce, 'sha256'), v_actor, p_organization_id,
     'income_expense.annotate', app_private.copilot_payload_hash_v1(v_canonical),
     'income_expenses.edit', clock_timestamp() + interval '5 minutes');

  RETURN jsonb_build_object(
    'confirmation_nonce', encode(v_nonce, 'hex'),
    'canonical',          v_canonical,
    -- Bản xem trước ĐÃ REDACT: chỉ nhãn tiếng Việt và đúng bốn trường người
    -- dùng cần để quyết định. Không có id, không có ảnh chụp quyền — chuỗi này
    -- đi vào ngữ cảnh mô hình.
    'preview', jsonb_build_object(
      'ma_phieu',    v_ie.code,
      'ten_phieu',   v_ie.name,
      'ghi_chu_cu',  COALESCE(v_ie.notes, ''),
      'ghi_chu_moi', v_notes
    )
  );
END
$xem_truoc_ghi_chu$;

COMMENT ON FUNCTION public.copilot_preview_income_expense_annotate_v1(uuid, jsonb) IS
  'Nonce ABI v1 — xem truoc doi ghi chu phieu thu/chi. Goi copilot_action_gate_v1 truoc khi phat nonce.';

REVOKE ALL ON FUNCTION public.copilot_preview_income_expense_annotate_v1(uuid, jsonb)
  FROM PUBLIC;
DO $quyen_xem_truoc_ghi_chu$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_preview_income_expense_annotate_v1(uuid, jsonb) FROM anon;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_preview_income_expense_annotate_v1(uuid, jsonb) FROM service_role;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_preview_income_expense_annotate_v1(uuid, jsonb) FROM authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_preview_income_expense_annotate_v1(uuid, jsonb) TO authenticated;
  END IF;
END
$quyen_xem_truoc_ghi_chu$;

-- ---------------------------------------------------------------------------
-- 2. THỰC THI — `income_expense.annotate`
-- ---------------------------------------------------------------------------
-- Thứ tự dưới đây là ABI, không phải sở thích. Mỗi bước đứng trước bước sau vì
-- một lý do đã trả giá ở cặp thu/chi:
--   regex nonce trước decode (decode chuỗi rác ném lỗi lạ, lộ hình dạng lưu trữ)
--   FOR UPDATE trước mọi phép so (hai tab bấm cùng lúc phải xếp hàng)
--   payload_hash trước cổng (payload đã đổi thì không cần hỏi quyền làm gì)
--   CỔNG LẠI ngay trước khi ghi (5 phút giữa xem trước và cú bấm là đủ dài để
--     một sự cố xảy ra và ai đó kéo cầu dao)
--   advisory lock trước khi tra sổ audit (nếu không, hai lượt cùng key cùng đọc
--     "chưa có" rồi cùng ghi)
--   CAS `consumed_at` trước khi gọi RPC gốc (tiêu nonce là việc rẻ, ghi là việc đắt)
CREATE OR REPLACE FUNCTION public.copilot_execute_income_expense_annotate_v1(
  p_confirmation_nonce text,
  p_payload            jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, extensions
AS $thuc_thi_ghi_chu$
DECLARE
  v_actor     uuid := auth.uid();
  v_hash      bytea;
  v_row       app_private.copilot_write_confirmations%ROWTYPE;
  v_snapshot  jsonb;
  v_org       uuid;
  v_voucher   uuid;
  v_notes     text;
  v_key       text;
  v_prev      public.ai_write_audit%ROWTYPE;
  v_before    jsonb;
  v_after     jsonb;
  v_audit_id  uuid;
  v_ledger_id uuid;
  v_sqlstate  text;
  v_message   text;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  IF p_confirmation_nonce IS NULL
     OR p_confirmation_nonce !~ '^[0-9a-fA-F]{64}$' THEN
    RAISE EXCEPTION 'confirmation_required' USING ERRCODE = '42501';
  END IF;

  v_hash := app_private.copilot_payload_hash_v1(p_payload);

  SELECT * INTO v_row
    FROM app_private.copilot_write_confirmations c
   WHERE c.nonce_digest = extensions.digest(
           decode(p_confirmation_nonce, 'hex'), 'sha256')
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'confirmation_not_found' USING ERRCODE = '42501';
  END IF;
  IF v_row.user_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'confirmation_not_found' USING ERRCODE = '42501';
  END IF;
  IF v_row.tool IS DISTINCT FROM 'income_expense.annotate'
     OR v_row.permission_key IS DISTINCT FROM 'income_expenses.edit' THEN
    RAISE EXCEPTION 'confirmation_contract_mismatch' USING ERRCODE = '42501';
  END IF;
  IF v_row.consumed_at IS NOT NULL THEN
    RAISE EXCEPTION 'confirmation_already_used' USING ERRCODE = '42501';
  END IF;
  IF v_row.expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'confirmation_expired' USING ERRCODE = '42501';
  END IF;
  IF v_row.payload_hash IS DISTINCT FROM v_hash THEN
    RAISE EXCEPTION 'payload_changed' USING ERRCODE = '42501';
  END IF;

  BEGIN
    v_org     := (p_payload ->> 'organization_id')::uuid;
    v_voucher := (p_payload ->> 'voucher_id')::uuid;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'payload_changed' USING ERRCODE = '42501';
  END;
  v_notes := p_payload ->> 'notes';
  IF v_org IS NULL OR v_voucher IS NULL OR v_notes IS NULL
     OR v_org IS DISTINCT FROM v_row.organization_id THEN
    RAISE EXCEPTION 'organization_mismatch' USING ERRCODE = '42501';
  END IF;

  v_snapshot := app_private.copilot_action_gate_v1('income_expense.annotate', v_org);

  v_key := 'copilot_action:income_expense.annotate:' || v_actor::text || ':'
        || v_org::text || ':' || encode(v_hash, 'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended(v_key, 0));

  -- Lượt lặp: sổ audit là nguồn sự thật, không phải trạng thái của phiếu. Phiếu
  -- có thể đã bị người khác sửa ghi chú sau đó — điều đó không biến lượt gọi này
  -- thành một lượt ghi mới.
  SELECT * INTO v_prev
    FROM public.ai_write_audit a
   WHERE a.idempotency_key = v_key;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'status',       'da_thuc_hien_truoc_do',
      'entity_table', 'income_expenses',
      'entity_id',    v_voucher,
      'audit_id',     v_prev.id,
      'ledger_id',    NULL
    );
  END IF;

  UPDATE app_private.copilot_write_confirmations
     SET consumed_at = clock_timestamp()
   WHERE id = v_row.id
     AND consumed_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'confirmation_already_used' USING ERRCODE = '42501';
  END IF;

  SELECT to_jsonb(ie) INTO v_before
    FROM public.income_expenses ie
   WHERE ie.id = v_voucher
     AND ie.deleted_at IS NULL
     AND ie.organization_id = v_org;
  IF v_before IS NULL THEN
    RAISE EXCEPTION 'entity_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- RPC GỐC, gọi nguyên vẹn. Hàm này là SECURITY DEFINER nhưng `auth.uid()` vẫn
  -- là người dùng thật, nên mọi cổng quyền bên trong nó vẫn đo đúng người bấm.
  --
  -- SỔ `action_failed` GHI RỒI CUỘN LẠI Ở V1 — nói thẳng thay vì để người đọc
  -- tự phát hiện. `RAISE` ở cuối handler huỷ cả giao dịch ngoài, kéo theo chính
  -- dòng sổ vừa ghi. Giữ khối này vì nó là chỗ nối sẵn: G3 chạy execute_step ở
  -- giao dịch NGOÀI và khi đó dòng `action_failed` sống sót mà không phải đổi
  -- một chữ nào trong thân hàm.
  BEGIN
    PERFORM public.annotate_income_expense_v1(
      v_voucher, NULL, NULL, v_notes, 'REPLACE', v_key);
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_message = MESSAGE_TEXT;
    PERFORM app_private.copilot_ledger_append_v1(jsonb_build_object(
      'event',               'action_failed',
      'organization_id',     v_org,
      'action_id',           'income_expense.annotate',
      'permission_key',      'income_expenses.edit',
      'permission_snapshot', v_snapshot,
      'consent_kind',        'click',
      'consent_id',          v_row.id,
      'payload_digest',      encode(v_hash, 'hex'),
      'before_digest',       encode(extensions.digest(convert_to(v_before::text, 'UTF8'), 'sha256'), 'hex'),
      'entity_table',        'income_expenses',
      'entity_id',           v_voucher,
      'error_code',          v_message,
      'sqlstate',            v_sqlstate
    ));
    RAISE;
  END;

  SELECT to_jsonb(ie) INTO v_after
    FROM public.income_expenses ie
   WHERE ie.id = v_voucher;
  IF v_after IS NULL THEN
    RAISE EXCEPTION 'entity_not_found' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public.ai_write_audit
    (user_id, tool, idempotency_key, entity_table, entity_id, payload, organization_id)
  VALUES
    (v_actor, 'income_expense.annotate', v_key, 'income_expenses', v_voucher,
     p_payload, v_org)
  RETURNING id INTO v_audit_id;

  v_ledger_id := app_private.copilot_ledger_append_v1(jsonb_build_object(
    'event',               'action_executed',
    'organization_id',     v_org,
    'action_id',           'income_expense.annotate',
    'permission_key',      'income_expenses.edit',
    'permission_snapshot', v_snapshot,
    'consent_kind',        'click',
    'consent_id',          v_row.id,
    'payload_digest',      encode(v_hash, 'hex'),
    'before_digest',       encode(extensions.digest(convert_to(v_before::text, 'UTF8'), 'sha256'), 'hex'),
    'after_digest',        encode(extensions.digest(convert_to(v_after::text, 'UTF8'), 'sha256'), 'hex'),
    'entity_table',        'income_expenses',
    'entity_id',           v_voucher,
    'audit_id',            v_audit_id,
    'outcome',             jsonb_build_object('status', 'da_thuc_hien')
  ));

  RETURN jsonb_build_object(
    'status',       'da_thuc_hien',
    'entity_table', 'income_expenses',
    'entity_id',    v_voucher,
    'audit_id',     v_audit_id,
    'ledger_id',    v_ledger_id
  );
END
$thuc_thi_ghi_chu$;

COMMENT ON FUNCTION public.copilot_execute_income_expense_annotate_v1(text, jsonb) IS
  'Nonce ABI v1 — tieu nonce, goi lai cong hanh dong, sua ghi chu phieu qua annotate_income_expense_v1, ghi ai_write_audit + so hanh dong.';

REVOKE ALL ON FUNCTION public.copilot_execute_income_expense_annotate_v1(text, jsonb)
  FROM PUBLIC;
DO $quyen_thuc_thi_ghi_chu$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_execute_income_expense_annotate_v1(text, jsonb) FROM anon;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_execute_income_expense_annotate_v1(text, jsonb) FROM service_role;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_execute_income_expense_annotate_v1(text, jsonb) FROM authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_execute_income_expense_annotate_v1(text, jsonb) TO authenticated;
  END IF;
END
$quyen_thuc_thi_ghi_chu$;

-- ---------------------------------------------------------------------------
-- 3. SỔ ĐĂNG KÝ + CÔNG TẮC
-- ---------------------------------------------------------------------------
INSERT INTO app_private.copilot_action_registry (
  action_id, version, label_vi, permission_key, risk, executor_kind,
  consent_required, preview_rpc, execute_rpc, verify_kind,
  produces_entity_table, consumes_ref_table, rollback_rpc, rollback_note,
  flag_contract_id, enabled
)
VALUES (
  'income_expense.annotate',
  1,
  'Sửa ghi chú phiếu thu/chi',
  'income_expenses.edit',
  'L3',
  'nonce_abi_v1',
  'click',
  'copilot_preview_income_expense_annotate_v1',
  'copilot_execute_income_expense_annotate_v1',
  'readback',
  'income_expenses',
  NULL,
  'annotate_income_expense_v1',
  'Goi lai annotate_income_expense_v1 voi ghi chu cu — ghi chu cu nam trong before_digest cua so hanh dong va trong khoi preview.ghi_chu_cu',
  'income_expense.annotate',
  true
)
ON CONFLICT (action_id) DO NOTHING;

SELECT set_config('app.copilot_feature_flag_transition', 'v2', true);

INSERT INTO public.copilot_feature_flags (
  scope, contract_id, state, reason, evidence_link, rollback_reference
)
VALUES (
  'action', 'income_expense.annotate', 'disabled',
  'seed kill switch cho action L3 sua ghi chu phieu thu/chi (G2-D)',
  'migration:20260903072353_copilot_action_income_expense_annotate_v1',
  'migration:20260903072353_copilot_action_income_expense_annotate_v1'
)
ON CONFLICT (scope, contract_id) DO NOTHING;

SELECT set_config('app.copilot_feature_flag_transition', '', true);

-- ---------------------------------------------------------------------------
-- 4. NỐI CẶP IE ĐANG CHẠY VÀO CỔNG + SỔ
-- ---------------------------------------------------------------------------
-- Thân dưới đây chép NGUYÊN VĂN từ `pg_get_functiondef` trên production
-- (03/09/2026), tức bản vỏ của `20260831110236`, và chỉ thêm:
--   preview : một lời gọi `copilot_action_gate_v1` sau khi chốt tổ chức
--   execute : một lời gọi `copilot_action_gate_v1` ngay trước khi uỷ quyền ghi,
--             cộng một dòng sổ `action_executed` sau khi ghi xong.
CREATE OR REPLACE FUNCTION public.copilot_preview_income_expense_v1(
  p_organization_id uuid,
  p_payload         jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, extensions
AS $vo_xem_truoc_ie$
DECLARE
  v_result  jsonb;
  v_canon   jsonb;
  v_org     uuid;
  v_type_id uuid;
  v_type    text;
BEGIN
  -- CỔNG trước khi phát nonce. Tổ chức đã có sẵn trong tham số nên không phải
  -- đợi `legacy` chốt gì cả; ngược lại, hỏi cổng TRƯỚC nghĩa là một action đang
  -- tắt không tiêu một nonce nào và không để lại hàng xác nhận rác.
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization_required' USING ERRCODE = '22023';
  END IF;
  PERFORM app_private.copilot_action_gate_v1(
    'income_expense.create_draft', p_organization_id);

  v_result := public.copilot_preview_income_expense_legacy_v1(
    p_organization_id, p_payload);
  v_canon := v_result -> 'canonical';

  BEGIN
    v_org := (v_canon ->> 'organization_id')::uuid;
    v_type_id := (v_canon ->> 'type_id')::uuid;
    v_type := v_canon ->> 'type';
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'copilot_category_invalid' USING ERRCODE = '42501';
  END;

  IF NOT app_private.copilot_ie_type_allowed_v1(v_org, v_type, v_type_id) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;
  RETURN v_result;
END
$vo_xem_truoc_ie$;

COMMENT ON FUNCTION public.copilot_preview_income_expense_v1(uuid, jsonb) IS
  'Copilot preview with a server-locked system-only/restricted category authorization boundary, gated by copilot_action_gate_v1.';

REVOKE EXECUTE ON FUNCTION public.copilot_preview_income_expense_v1(uuid, jsonb)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.copilot_preview_income_expense_v1(uuid, jsonb)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.copilot_execute_income_expense_v1(
  p_confirmation_nonce text,
  p_payload            jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, extensions
AS $vo_thuc_thi_ie$
DECLARE
  v_org        uuid;
  v_type_id    uuid;
  v_type       text;
  v_snapshot   jsonb;
  v_result     jsonb;
  v_confirm_id uuid;
  v_after      jsonb;
  v_entity_id  uuid;
BEGIN
  BEGIN
    v_org := (p_payload ->> 'organization_id')::uuid;
    v_type_id := (p_payload ->> 'type_id')::uuid;
    v_type := p_payload ->> 'type';
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'payload_changed' USING ERRCODE = '42501';
  END;

  -- This check runs again after preview and before the delegate can consume
  -- the nonce, so revocation and restricted-category changes take effect now.
  IF NOT app_private.copilot_ie_type_allowed_v1(v_org, v_type, v_type_id) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;

  -- CỔNG LẠI, ngay trước khi uỷ quyền ghi. Đây là chỗ duy nhất chặn được một
  -- nonce đã phát trước khi sự cố xảy ra.
  v_snapshot := app_private.copilot_action_gate_v1('income_expense.create_draft', v_org);

  -- Đọc id hàng xác nhận TRƯỚC khi `legacy` tiêu nó: sau lời gọi đó hàng vẫn
  -- còn (chỉ `consumed_at` được đặt), nhưng đọc trước thì không phụ thuộc vào
  -- chi tiết cài đặt của hàm bên dưới.
  IF p_confirmation_nonce ~ '^[0-9a-fA-F]{64}$' THEN
    SELECT c.id INTO v_confirm_id
      FROM app_private.copilot_write_confirmations c
     WHERE c.nonce_digest = extensions.digest(
             decode(p_confirmation_nonce, 'hex'), 'sha256');
  END IF;

  v_result := public.copilot_execute_income_expense_legacy_v1(
    p_confirmation_nonce, p_payload);

  v_entity_id := NULLIF(v_result ->> 'entity_id', '')::uuid;
  IF v_entity_id IS NOT NULL THEN
    SELECT to_jsonb(ie) INTO v_after
      FROM public.income_expenses ie
     WHERE ie.id = v_entity_id;
  END IF;

  PERFORM app_private.copilot_ledger_append_v1(jsonb_build_object(
    'event',               'action_executed',
    'organization_id',     v_org,
    'action_id',           'income_expense.create_draft',
    'permission_key',      'income_expenses.create',
    'permission_snapshot', v_snapshot,
    'consent_kind',        'click',
    'consent_id',          v_confirm_id,
    'payload_digest',      encode(app_private.copilot_payload_hash_v1(p_payload), 'hex'),
    'after_digest',        CASE WHEN v_after IS NULL THEN NULL
                                ELSE encode(extensions.digest(
                                       convert_to(v_after::text, 'UTF8'), 'sha256'), 'hex') END,
    'entity_table',        'income_expenses',
    'entity_id',           v_entity_id,
    'audit_id',            NULLIF(v_result ->> 'audit_id', '')::uuid,
    'outcome',             jsonb_build_object('status', v_result ->> 'status')
  ));

  RETURN v_result;
END
$vo_thuc_thi_ie$;

COMMENT ON FUNCTION public.copilot_execute_income_expense_v1(text, jsonb) IS
  'Copilot execute with a server-locked system-only/restricted category authorization boundary, gated by copilot_action_gate_v1 and recorded in copilot_action_ledger.';

REVOKE EXECUTE ON FUNCTION public.copilot_execute_income_expense_v1(text, jsonb)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.copilot_execute_income_expense_v1(text, jsonb)
  TO authenticated;

-- ---------------------------------------------------------------------------
-- NGHIỆM THU — chỉ soi catalog, chạy được trên database rỗng.
-- ---------------------------------------------------------------------------
DO $nghiem_thu$
DECLARE
  v_ten   text;
  v_thieu text[] := '{}'::text[];
  v_ho    text[] := '{}'::text[];
BEGIN
  FOREACH v_ten IN ARRAY ARRAY[
    'public.copilot_preview_income_expense_annotate_v1(uuid, jsonb)',
    'public.copilot_execute_income_expense_annotate_v1(text, jsonb)',
    'public.copilot_preview_income_expense_v1(uuid, jsonb)',
    'public.copilot_execute_income_expense_v1(text, jsonb)'
  ]
  LOOP
    IF to_regprocedure(v_ten) IS NULL THEN
      v_thieu := v_thieu || v_ten;
    END IF;
  END LOOP;
  IF cardinality(v_thieu) > 0 THEN
    RAISE EXCEPTION 'thieu ham G2-D annotate: %', array_to_string(v_thieu, ', ');
  END IF;

  -- Phụ thuộc: thiếu bất kỳ cái nào thì hai hàm trên là mã chết.
  IF to_regprocedure('app_private.copilot_action_gate_v1(text, uuid)') IS NULL THEN
    RAISE EXCEPTION 'copilot_action_gate_v1 missing — 20260903043956 phai chay truoc';
  END IF;
  IF to_regprocedure('app_private.copilot_ledger_append_v1(jsonb)') IS NULL THEN
    RAISE EXCEPTION 'copilot_ledger_append_v1 missing — 20260903043956 phai chay truoc';
  END IF;
  IF to_regprocedure('public.annotate_income_expense_v1(uuid, jsonb, jsonb, text, text, text)') IS NULL THEN
    RAISE EXCEPTION 'annotate_income_expense_v1 missing — baseline phai co truoc';
  END IF;
  IF to_regprocedure('public.copilot_preview_income_expense_legacy_v1(uuid, jsonb)') IS NULL
     OR to_regprocedure('public.copilot_execute_income_expense_legacy_v1(text, jsonb)') IS NULL THEN
    RAISE EXCEPTION 'cap legacy IE missing — 20260831110236 phai chay truoc';
  END IF;

  -- Không hàm nào của file này được anon gọi.
  IF to_regrole('anon') IS NOT NULL THEN
    FOREACH v_ten IN ARRAY ARRAY[
      'public.copilot_preview_income_expense_annotate_v1(uuid, jsonb)',
      'public.copilot_execute_income_expense_annotate_v1(text, jsonb)',
      'public.copilot_preview_income_expense_v1(uuid, jsonb)',
      'public.copilot_execute_income_expense_v1(text, jsonb)'
    ]
    LOOP
      IF has_function_privilege('anon', to_regprocedure(v_ten)::oid, 'EXECUTE') THEN
        v_ho := v_ho || v_ten;
      END IF;
    END LOOP;
    IF cardinality(v_ho) > 0 THEN
      RAISE EXCEPTION 'anon goi duoc ham G2-D annotate: %', array_to_string(v_ho, ', ');
    END IF;
  END IF;

  -- Hàng registry + hàng cờ.
  IF NOT EXISTS (
    SELECT 1 FROM app_private.copilot_action_registry
     WHERE action_id = 'income_expense.annotate'
       AND risk = 'L3' AND executor_kind = 'nonce_abi_v1' AND consent_required = 'click'
       AND permission_key = 'income_expenses.edit'
  ) THEN
    RAISE EXCEPTION 'seed registry income_expense.annotate sai hinh hoac thieu';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.copilot_feature_flags f
     WHERE f.scope = 'action' AND f.contract_id = 'income_expense.annotate'
  ) THEN
    RAISE EXCEPTION 'copilot_rollout_seed_thieu_action_contract: income_expense.annotate';
  END IF;
END
$nghiem_thu$;

COMMIT;

NOTIFY pgrst, 'reload schema';
