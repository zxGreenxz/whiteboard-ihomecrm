-- G2-D (2/3) — Action L3 `reservation.set_hold_terms` theo Nonce ABI v1.
--
-- ĐẶT KỲ HẠN GIỮ CHỖ CHO MỘT PHIẾU THU CỌC: hạn làm hợp đồng, hạn bổ sung cọc,
-- số cọc cần đủ. Ba mốc này KHÔNG động vào tiền: chúng nằm ở bảng
-- `reservation_hold_deadlines`, một bảng phụ khoá 1-1 theo phiếu, và đặt lại
-- giá trị cũ là hoàn tác đầy đủ. Đó là lý do nó là L3 chứ không phải L4.
--
-- RPC GỐC GỌI NGUYÊN VẸN
--   `set_reservation_hold_terms_v1` tự kiểm phiếu là THU, chưa gắn hợp đồng,
--   chưa xoá, và quyền trên toà; nó cũng tự chặn các mốc mâu thuẫn (bổ sung sau
--   hạn giữ, mốc trước ngày lập phiếu). Không việc nào trong số đó được chép lại
--   ở đây — chép là dựng bản thứ hai của luật rồi để hai bản lệch nhau.
--
-- HOÀN TÁC
--   Cùng RPC với bộ giá trị cũ. Bộ cũ nằm trong `preview` (ba trường `*_cu`) và
--   trong `before_digest` của sổ hành động. Bỏ cả ba về NULL là XOÁ dòng kỳ hạn
--   — hành vi hợp lệ của RPC gốc, và cũng là cách lùi khi trước đó chưa có dòng.
--
-- ĐƯỜNG LÙI
--   DROP hai hàm; DELETE hàng registry `reservation.set_hold_terms` và hàng cờ
--   `('action','reservation.set_hold_terms')`.

BEGIN;
SET LOCAL lock_timeout = '15s';

-- ---------------------------------------------------------------------------
-- 1. XEM TRƯỚC
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.copilot_preview_reservation_hold_terms_v1(
  p_organization_id uuid,
  p_payload         jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, extensions
AS $xem_truoc_giu_cho$
DECLARE
  v_actor     uuid := auth.uid();
  v_snapshot  jsonb;
  v_ie_id     uuid;
  v_hold      date;
  v_topup     date;
  v_target    numeric;
  v_ie        public.income_expenses%ROWTYPE;
  v_cu        public.reservation_hold_deadlines%ROWTYPE;
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

  v_snapshot := app_private.copilot_action_gate_v1(
    'reservation.set_hold_terms', p_organization_id);

  -- Ba mốc đều được phép NULL: NULL nghĩa là "bỏ mốc này". Cả ba cùng NULL là
  -- lệnh xoá dòng kỳ hạn, và RPC gốc coi đó là hợp lệ.
  BEGIN
    v_ie_id  := (p_payload ->> 'income_expense_id')::uuid;
    v_hold   := NULLIF(p_payload ->> 'hold_until', '')::date;
    v_topup  := NULLIF(p_payload ->> 'topup_due_date', '')::date;
    v_target := NULLIF(p_payload ->> 'deposit_target', '')::numeric;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'payload_invalid' USING ERRCODE = '22023';
  END;
  IF v_ie_id IS NULL THEN
    RAISE EXCEPTION 'payload_invalid' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_ie
    FROM public.income_expenses
   WHERE id = v_ie_id
     AND deleted_at IS NULL
     AND organization_id = p_organization_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'entity_not_found' USING ERRCODE = 'P0002';
  END IF;

  SELECT s.org_wide, s.building_ids
    INTO v_scope
    FROM app_private.authorized_scope_v3('deposits.edit', p_organization_id) s;
  -- Phiếu KHÔNG gắn toà (`building_id IS NULL`) là phiếu mức TỔ CHỨC, và nó đòi
  -- quyền mức tổ chức — `org_wide`. Bản đầu để nó lọt: điều kiện cũ chỉ chặn khi
  -- `building_id IS NOT NULL`, nên một người chỉ có quyền ở toà A vẫn sửa được
  -- phiếu toàn công ty. Không có toà để so KHÔNG phải "không có gì để kiểm", mà
  -- là "không có phạm vi nào bao được nó" — fail-closed.
  IF NOT COALESCE(v_scope.org_wide, false)
     AND (v_ie.building_id IS NULL
          OR NOT (v_ie.building_id = ANY(COALESCE(v_scope.building_ids, ARRAY[]::uuid[])))) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_cu
    FROM public.reservation_hold_deadlines
   WHERE income_expense_id = v_ie_id;

  v_canonical := jsonb_build_object(
    'organization_id',   p_organization_id,
    'income_expense_id', v_ie_id,
    'hold_until',        v_hold,
    'topup_due_date',    v_topup,
    'deposit_target',    v_target
  );
  v_nonce := extensions.gen_random_bytes(32);

  INSERT INTO app_private.copilot_write_confirmations
    (nonce_digest, user_id, organization_id, tool, payload_hash,
     permission_key, expires_at)
  VALUES
    (extensions.digest(v_nonce, 'sha256'), v_actor, p_organization_id,
     'reservation.set_hold_terms', app_private.copilot_payload_hash_v1(v_canonical),
     'deposits.edit', clock_timestamp() + interval '5 minutes');

  RETURN jsonb_build_object(
    'confirmation_nonce', encode(v_nonce, 'hex'),
    'canonical',          v_canonical,
    'preview', jsonb_build_object(
      'ma_phieu',              v_ie.code,
      'ten_phieu',             v_ie.name,
      'han_lam_hop_dong_cu',   v_cu.hold_until,
      'han_lam_hop_dong_moi',  v_hold,
      'han_bo_sung_coc_cu',    v_cu.topup_due_date,
      'han_bo_sung_coc_moi',   v_topup,
      'coc_can_du_cu',         v_cu.deposit_target,
      'coc_can_du_moi',        v_target
    )
  );
END
$xem_truoc_giu_cho$;

COMMENT ON FUNCTION public.copilot_preview_reservation_hold_terms_v1(uuid, jsonb) IS
  'Nonce ABI v1 — xem truoc dat ky han giu cho cho phieu thu coc. Goi copilot_action_gate_v1 truoc khi phat nonce.';

REVOKE ALL ON FUNCTION public.copilot_preview_reservation_hold_terms_v1(uuid, jsonb)
  FROM PUBLIC;
DO $quyen_xem_truoc_giu_cho$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_preview_reservation_hold_terms_v1(uuid, jsonb) FROM anon;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_preview_reservation_hold_terms_v1(uuid, jsonb) FROM service_role;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_preview_reservation_hold_terms_v1(uuid, jsonb) FROM authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_preview_reservation_hold_terms_v1(uuid, jsonb) TO authenticated;
  END IF;
END
$quyen_xem_truoc_giu_cho$;

-- ---------------------------------------------------------------------------
-- 2. THỰC THI
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.copilot_execute_reservation_hold_terms_v1(
  p_confirmation_nonce text,
  p_payload            jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, extensions
AS $thuc_thi_giu_cho$
DECLARE
  v_actor     uuid := auth.uid();
  v_hash      bytea;
  v_row       app_private.copilot_write_confirmations%ROWTYPE;
  v_snapshot  jsonb;
  v_org       uuid;
  v_ie_id     uuid;
  v_hold      date;
  v_topup     date;
  v_target    numeric;
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
  IF v_row.tool IS DISTINCT FROM 'reservation.set_hold_terms'
     OR v_row.permission_key IS DISTINCT FROM 'deposits.edit' THEN
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
    v_org    := (p_payload ->> 'organization_id')::uuid;
    v_ie_id  := (p_payload ->> 'income_expense_id')::uuid;
    v_hold   := NULLIF(p_payload ->> 'hold_until', '')::date;
    v_topup  := NULLIF(p_payload ->> 'topup_due_date', '')::date;
    v_target := NULLIF(p_payload ->> 'deposit_target', '')::numeric;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'payload_changed' USING ERRCODE = '42501';
  END;
  IF v_org IS NULL OR v_ie_id IS NULL
     OR v_org IS DISTINCT FROM v_row.organization_id THEN
    RAISE EXCEPTION 'organization_mismatch' USING ERRCODE = '42501';
  END IF;

  v_snapshot := app_private.copilot_action_gate_v1('reservation.set_hold_terms', v_org);

  v_key := 'copilot_action:reservation.set_hold_terms:' || v_actor::text || ':'
        || v_org::text || ':' || encode(v_hash, 'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended(v_key, 0));

  SELECT * INTO v_prev
    FROM public.ai_write_audit a
   WHERE a.idempotency_key = v_key;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'status',       'da_thuc_hien_truoc_do',
      'entity_table', 'reservation_hold_deadlines',
      'entity_id',    v_ie_id,
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

  -- Phiếu phải còn sống và thuộc đúng công ty. Kiểm lại ở đây chứ không tin
  -- bước xem trước: giữa hai bước có 5 phút.
  IF NOT EXISTS (
    SELECT 1 FROM public.income_expenses ie
     WHERE ie.id = v_ie_id
       AND ie.deleted_at IS NULL
       AND ie.organization_id = v_org
  ) THEN
    RAISE EXCEPTION 'entity_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- `before_digest` NULL khi phiếu chưa có dòng kỳ hạn nào. Đó là một trạng
  -- thái thật, không phải lỗi đọc — và nó chính là thứ nói cho người lùi biết
  -- rằng hoàn tác nghĩa là XOÁ dòng, không phải đặt lại giá trị.
  SELECT to_jsonb(d) INTO v_before
    FROM public.reservation_hold_deadlines d
   WHERE d.income_expense_id = v_ie_id;

  BEGIN
    PERFORM public.set_reservation_hold_terms_v1(v_ie_id, v_hold, v_topup, v_target);
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_message = MESSAGE_TEXT;
    PERFORM app_private.copilot_ledger_append_v1(jsonb_build_object(
      'event',               'action_failed',
      'organization_id',     v_org,
      'action_id',           'reservation.set_hold_terms',
      'permission_key',      'deposits.edit',
      'permission_snapshot', v_snapshot,
      'consent_kind',        'click',
      'consent_id',          v_row.id,
      'payload_digest',      encode(v_hash, 'hex'),
      'before_digest',       CASE WHEN v_before IS NULL THEN NULL
                                  ELSE encode(extensions.digest(
                                         convert_to(v_before::text, 'UTF8'), 'sha256'), 'hex') END,
      'entity_table',        'reservation_hold_deadlines',
      'entity_id',           v_ie_id,
      'error_code',          v_message,
      'sqlstate',            v_sqlstate
    ));
    RAISE;
  END;

  SELECT to_jsonb(d) INTO v_after
    FROM public.reservation_hold_deadlines d
   WHERE d.income_expense_id = v_ie_id;

  INSERT INTO public.ai_write_audit
    (user_id, tool, idempotency_key, entity_table, entity_id, payload, organization_id)
  VALUES
    (v_actor, 'reservation.set_hold_terms', v_key, 'reservation_hold_deadlines',
     v_ie_id, p_payload, v_org)
  RETURNING id INTO v_audit_id;

  v_ledger_id := app_private.copilot_ledger_append_v1(jsonb_build_object(
    'event',               'action_executed',
    'organization_id',     v_org,
    'action_id',           'reservation.set_hold_terms',
    'permission_key',      'deposits.edit',
    'permission_snapshot', v_snapshot,
    'consent_kind',        'click',
    'consent_id',          v_row.id,
    'payload_digest',      encode(v_hash, 'hex'),
    'before_digest',       CASE WHEN v_before IS NULL THEN NULL
                                ELSE encode(extensions.digest(
                                       convert_to(v_before::text, 'UTF8'), 'sha256'), 'hex') END,
    'after_digest',        CASE WHEN v_after IS NULL THEN NULL
                                ELSE encode(extensions.digest(
                                       convert_to(v_after::text, 'UTF8'), 'sha256'), 'hex') END,
    'entity_table',        'reservation_hold_deadlines',
    'entity_id',           v_ie_id,
    'audit_id',            v_audit_id,
    'outcome',             jsonb_build_object('status', 'da_thuc_hien')
  ));

  RETURN jsonb_build_object(
    'status',       'da_thuc_hien',
    'entity_table', 'reservation_hold_deadlines',
    'entity_id',    v_ie_id,
    'audit_id',     v_audit_id,
    'ledger_id',    v_ledger_id
  );
END
$thuc_thi_giu_cho$;

COMMENT ON FUNCTION public.copilot_execute_reservation_hold_terms_v1(text, jsonb) IS
  'Nonce ABI v1 — tieu nonce, goi lai cong hanh dong, dat ky han giu cho qua set_reservation_hold_terms_v1, ghi ai_write_audit + so hanh dong.';

REVOKE ALL ON FUNCTION public.copilot_execute_reservation_hold_terms_v1(text, jsonb)
  FROM PUBLIC;
DO $quyen_thuc_thi_giu_cho$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_execute_reservation_hold_terms_v1(text, jsonb) FROM anon;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_execute_reservation_hold_terms_v1(text, jsonb) FROM service_role;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_execute_reservation_hold_terms_v1(text, jsonb) FROM authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_execute_reservation_hold_terms_v1(text, jsonb) TO authenticated;
  END IF;
END
$quyen_thuc_thi_giu_cho$;

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
  'reservation.set_hold_terms',
  1,
  'Đặt kỳ hạn giữ chỗ cho phiếu cọc',
  'deposits.edit',
  'L3',
  'nonce_abi_v1',
  'click',
  'copilot_preview_reservation_hold_terms_v1',
  'copilot_execute_reservation_hold_terms_v1',
  'readback',
  'reservation_hold_deadlines',
  'income_expenses',
  'set_reservation_hold_terms_v1',
  'Goi lai set_reservation_hold_terms_v1 voi bo gia tri cu (ba truong *_cu trong preview, va before_digest cua so). Truoc do khong co dong ky han thi lui = truyen ca ba NULL de xoa dong',
  'reservation.set_hold_terms',
  true
)
ON CONFLICT (action_id) DO NOTHING;

SELECT set_config('app.copilot_feature_flag_transition', 'v2', true);

INSERT INTO public.copilot_feature_flags (
  scope, contract_id, state, reason, evidence_link, rollback_reference
)
VALUES (
  'action', 'reservation.set_hold_terms', 'disabled',
  'seed kill switch cho action L3 dat ky han giu cho (G2-D)',
  'migration:20260903072912_copilot_action_reservation_hold_terms_v1',
  'migration:20260903072912_copilot_action_reservation_hold_terms_v1'
)
ON CONFLICT (scope, contract_id) DO NOTHING;

SELECT set_config('app.copilot_feature_flag_transition', '', true);

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
    'public.copilot_preview_reservation_hold_terms_v1(uuid, jsonb)',
    'public.copilot_execute_reservation_hold_terms_v1(text, jsonb)'
  ]
  LOOP
    IF to_regprocedure(v_ten) IS NULL THEN
      v_thieu := v_thieu || v_ten;
    END IF;
  END LOOP;
  IF cardinality(v_thieu) > 0 THEN
    RAISE EXCEPTION 'thieu ham G2-D hold terms: %', array_to_string(v_thieu, ', ');
  END IF;

  IF to_regprocedure('app_private.copilot_action_gate_v1(text, uuid)') IS NULL THEN
    RAISE EXCEPTION 'copilot_action_gate_v1 missing — 20260903043956 phai chay truoc';
  END IF;
  IF to_regprocedure('app_private.copilot_ledger_append_v1(jsonb)') IS NULL THEN
    RAISE EXCEPTION 'copilot_ledger_append_v1 missing — 20260903043956 phai chay truoc';
  END IF;
  IF to_regprocedure('public.set_reservation_hold_terms_v1(uuid, date, date, numeric)') IS NULL THEN
    RAISE EXCEPTION 'set_reservation_hold_terms_v1 missing — 20260822120000 phai chay truoc';
  END IF;
  IF to_regclass('public.reservation_hold_deadlines') IS NULL THEN
    RAISE EXCEPTION 'reservation_hold_deadlines missing — baseline phai co truoc';
  END IF;

  IF to_regrole('anon') IS NOT NULL THEN
    FOREACH v_ten IN ARRAY ARRAY[
      'public.copilot_preview_reservation_hold_terms_v1(uuid, jsonb)',
      'public.copilot_execute_reservation_hold_terms_v1(text, jsonb)'
    ]
    LOOP
      IF has_function_privilege('anon', to_regprocedure(v_ten)::oid, 'EXECUTE') THEN
        v_ho := v_ho || v_ten;
      END IF;
    END LOOP;
    IF cardinality(v_ho) > 0 THEN
      RAISE EXCEPTION 'anon goi duoc ham G2-D hold terms: %', array_to_string(v_ho, ', ');
    END IF;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM app_private.copilot_action_registry
     WHERE action_id = 'reservation.set_hold_terms'
       AND risk = 'L3' AND executor_kind = 'nonce_abi_v1' AND consent_required = 'click'
       AND permission_key = 'deposits.edit'
  ) THEN
    RAISE EXCEPTION 'seed registry reservation.set_hold_terms sai hinh hoac thieu';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.copilot_feature_flags f
     WHERE f.scope = 'action' AND f.contract_id = 'reservation.set_hold_terms'
  ) THEN
    RAISE EXCEPTION 'copilot_rollout_seed_thieu_action_contract: reservation.set_hold_terms';
  END IF;
END
$nghiem_thu$;

COMMIT;

NOTIFY pgrst, 'reload schema';
