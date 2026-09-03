-- G2-D (3/3) — Action L3 `zalo.set_conversation_flags` theo Nonce ABI v1.
--
-- BA CỜ HIỂN THỊ CỦA MỘT HỘI THOẠI ZALO: ghim, tắt tiếng, đánh dấu chưa đọc.
-- Không gửi tin, không đổi nội dung, không đụng khách hàng hay hợp đồng — đặt
-- lại cờ cũ là hoàn tác đầy đủ. L3.
--
-- VÌ SAO KHOÁ QUYỀN LÀ `chat_zalo.view` CHỨ KHÔNG PHẢI MỘT KHOÁ "EDIT"
--   `zalo_set_conversation_flags` (baseline `20260813120000`) tự gác bằng
--   `zalo_can('view', org)`, và `zalo_can` giải ra `authorized_scope_v3('chat_zalo.view', org)`
--   với điều kiện `org_wide`. Không có khoá `chat_zalo.edit` nào trong
--   `permission_definitions` (đo trên production 03/09/2026: module `chat_zalo`
--   chỉ có `view`, `send`, `manage_automation`, `manage_templates`). Khai một
--   khoá không tồn tại trong registry sẽ làm `copilot_action_gate_v1` hỏi
--   `authorized_scope_v3` về một quyền không ai có — tức action chết vĩnh viễn
--   với thông điệp `not_permitted` sai sự thật. Khoá ở đây phải là ĐÚNG khoá mà
--   RPC gốc đo, không phải khoá nghe hợp lý hơn.
--
-- ĐƯỜNG LÙI
--   DROP hai hàm; DELETE hàng registry `zalo.set_conversation_flags` và hàng cờ
--   `('action','zalo.set_conversation_flags')`.

BEGIN;
SET LOCAL lock_timeout = '15s';

-- ---------------------------------------------------------------------------
-- 1. XEM TRƯỚC
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.copilot_preview_zalo_conversation_flags_v1(
  p_organization_id uuid,
  p_payload         jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, extensions
AS $xem_truoc_co_zalo$
DECLARE
  v_actor     uuid := auth.uid();
  v_snapshot  jsonb;
  v_conv_id   uuid;
  v_pinned    boolean;
  v_muted     boolean;
  v_unread    boolean;
  v_conv      public.zalo_conversations%ROWTYPE;
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
    'zalo.set_conversation_flags', p_organization_id);

  -- NULL nghĩa là "giữ nguyên cờ này" — đúng ngữ nghĩa `COALESCE` của RPC gốc.
  BEGIN
    v_conv_id := (p_payload ->> 'conversation_id')::uuid;
    v_pinned  := NULLIF(p_payload ->> 'pinned', '')::boolean;
    v_muted   := NULLIF(p_payload ->> 'muted', '')::boolean;
    v_unread  := NULLIF(p_payload ->> 'marked_unread', '')::boolean;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'payload_invalid' USING ERRCODE = '22023';
  END;
  IF v_conv_id IS NULL THEN
    RAISE EXCEPTION 'payload_invalid' USING ERRCODE = '22023';
  END IF;
  IF v_pinned IS NULL AND v_muted IS NULL AND v_unread IS NULL THEN
    RAISE EXCEPTION 'khong_co_co_nao_doi' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_conv
    FROM public.zalo_conversations
   WHERE id = v_conv_id
     AND organization_id = p_organization_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'entity_not_found' USING ERRCODE = 'P0002';
  END IF;

  v_canonical := jsonb_build_object(
    'organization_id', p_organization_id,
    'conversation_id', v_conv_id,
    'pinned',          v_pinned,
    'muted',           v_muted,
    'marked_unread',   v_unread
  );
  v_nonce := extensions.gen_random_bytes(32);

  INSERT INTO app_private.copilot_write_confirmations
    (nonce_digest, user_id, organization_id, tool, payload_hash,
     permission_key, expires_at)
  VALUES
    (extensions.digest(v_nonce, 'sha256'), v_actor, p_organization_id,
     'zalo.set_conversation_flags', app_private.copilot_payload_hash_v1(v_canonical),
     'chat_zalo.view', clock_timestamp() + interval '5 minutes');

  RETURN jsonb_build_object(
    'confirmation_nonce', encode(v_nonce, 'hex'),
    'canonical',          v_canonical,
    -- `ten_hoi_thoai` là tên hiển thị của đối phương. Không trả số điện thoại,
    -- không trả nội dung tin nhắn: khối này đi vào ngữ cảnh mô hình.
    'preview', jsonb_build_object(
      'ten_hoi_thoai', v_conv.peer_name,
      'ghim_cu',       v_conv.is_pinned,
      'ghim_moi',      COALESCE(v_pinned, v_conv.is_pinned),
      'tat_tieng_cu',  v_conv.is_muted,
      'tat_tieng_moi', COALESCE(v_muted, v_conv.is_muted),
      'chua_doc_cu',   v_conv.marked_unread,
      'chua_doc_moi',  COALESCE(v_unread, v_conv.marked_unread)
    )
  );
END
$xem_truoc_co_zalo$;

COMMENT ON FUNCTION public.copilot_preview_zalo_conversation_flags_v1(uuid, jsonb) IS
  'Nonce ABI v1 — xem truoc doi ba co hien thi cua hoi thoai Zalo. Goi copilot_action_gate_v1 truoc khi phat nonce.';

REVOKE ALL ON FUNCTION public.copilot_preview_zalo_conversation_flags_v1(uuid, jsonb)
  FROM PUBLIC;
DO $quyen_xem_truoc_co_zalo$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_preview_zalo_conversation_flags_v1(uuid, jsonb) FROM anon;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_preview_zalo_conversation_flags_v1(uuid, jsonb) FROM service_role;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_preview_zalo_conversation_flags_v1(uuid, jsonb) FROM authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_preview_zalo_conversation_flags_v1(uuid, jsonb) TO authenticated;
  END IF;
END
$quyen_xem_truoc_co_zalo$;

-- ---------------------------------------------------------------------------
-- 2. THỰC THI
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.copilot_execute_zalo_conversation_flags_v1(
  p_confirmation_nonce text,
  p_payload            jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, extensions
AS $thuc_thi_co_zalo$
DECLARE
  v_actor     uuid := auth.uid();
  v_hash      bytea;
  v_row       app_private.copilot_write_confirmations%ROWTYPE;
  v_snapshot  jsonb;
  v_org       uuid;
  v_conv_id   uuid;
  v_pinned    boolean;
  v_muted     boolean;
  v_unread    boolean;
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
  IF v_row.tool IS DISTINCT FROM 'zalo.set_conversation_flags'
     OR v_row.permission_key IS DISTINCT FROM 'chat_zalo.view' THEN
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
    v_conv_id := (p_payload ->> 'conversation_id')::uuid;
    v_pinned  := NULLIF(p_payload ->> 'pinned', '')::boolean;
    v_muted   := NULLIF(p_payload ->> 'muted', '')::boolean;
    v_unread  := NULLIF(p_payload ->> 'marked_unread', '')::boolean;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'payload_changed' USING ERRCODE = '42501';
  END;
  IF v_org IS NULL OR v_conv_id IS NULL
     OR v_org IS DISTINCT FROM v_row.organization_id THEN
    RAISE EXCEPTION 'organization_mismatch' USING ERRCODE = '42501';
  END IF;

  v_snapshot := app_private.copilot_action_gate_v1('zalo.set_conversation_flags', v_org);

  v_key := 'copilot_action:zalo.set_conversation_flags:' || v_actor::text || ':'
        || v_org::text || ':' || encode(v_hash, 'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended(v_key, 0));

  SELECT * INTO v_prev
    FROM public.ai_write_audit a
   WHERE a.idempotency_key = v_key;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'status',       'da_thuc_hien_truoc_do',
      'entity_table', 'zalo_conversations',
      'entity_id',    v_conv_id,
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

  SELECT to_jsonb(c) INTO v_before
    FROM public.zalo_conversations c
   WHERE c.id = v_conv_id
     AND c.organization_id = v_org;
  IF v_before IS NULL THEN
    RAISE EXCEPTION 'entity_not_found' USING ERRCODE = 'P0002';
  END IF;

  BEGIN
    PERFORM public.zalo_set_conversation_flags(v_conv_id, v_pinned, v_muted, v_unread);
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_message = MESSAGE_TEXT;
    PERFORM app_private.copilot_ledger_append_v1(jsonb_build_object(
      'event',               'action_failed',
      'organization_id',     v_org,
      'action_id',           'zalo.set_conversation_flags',
      'permission_key',      'chat_zalo.view',
      'permission_snapshot', v_snapshot,
      'consent_kind',        'click',
      'consent_id',          v_row.id,
      'payload_digest',      encode(v_hash, 'hex'),
      'before_digest',       encode(extensions.digest(convert_to(v_before::text, 'UTF8'), 'sha256'), 'hex'),
      'entity_table',        'zalo_conversations',
      'entity_id',           v_conv_id,
      'error_code',          v_message,
      'sqlstate',            v_sqlstate
    ));
    RAISE;
  END;

  SELECT to_jsonb(c) INTO v_after
    FROM public.zalo_conversations c
   WHERE c.id = v_conv_id;
  IF v_after IS NULL THEN
    RAISE EXCEPTION 'entity_not_found' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public.ai_write_audit
    (user_id, tool, idempotency_key, entity_table, entity_id, payload, organization_id)
  VALUES
    (v_actor, 'zalo.set_conversation_flags', v_key, 'zalo_conversations',
     v_conv_id, p_payload, v_org)
  RETURNING id INTO v_audit_id;

  v_ledger_id := app_private.copilot_ledger_append_v1(jsonb_build_object(
    'event',               'action_executed',
    'organization_id',     v_org,
    'action_id',           'zalo.set_conversation_flags',
    'permission_key',      'chat_zalo.view',
    'permission_snapshot', v_snapshot,
    'consent_kind',        'click',
    'consent_id',          v_row.id,
    'payload_digest',      encode(v_hash, 'hex'),
    'before_digest',       encode(extensions.digest(convert_to(v_before::text, 'UTF8'), 'sha256'), 'hex'),
    'after_digest',        encode(extensions.digest(convert_to(v_after::text, 'UTF8'), 'sha256'), 'hex'),
    'entity_table',        'zalo_conversations',
    'entity_id',           v_conv_id,
    'audit_id',            v_audit_id,
    'outcome',             jsonb_build_object('status', 'da_thuc_hien')
  ));

  RETURN jsonb_build_object(
    'status',       'da_thuc_hien',
    'entity_table', 'zalo_conversations',
    'entity_id',    v_conv_id,
    'audit_id',     v_audit_id,
    'ledger_id',    v_ledger_id
  );
END
$thuc_thi_co_zalo$;

COMMENT ON FUNCTION public.copilot_execute_zalo_conversation_flags_v1(text, jsonb) IS
  'Nonce ABI v1 — tieu nonce, goi lai cong hanh dong, dat ba co hien thi qua zalo_set_conversation_flags, ghi ai_write_audit + so hanh dong.';

REVOKE ALL ON FUNCTION public.copilot_execute_zalo_conversation_flags_v1(text, jsonb)
  FROM PUBLIC;
DO $quyen_thuc_thi_co_zalo$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_execute_zalo_conversation_flags_v1(text, jsonb) FROM anon;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_execute_zalo_conversation_flags_v1(text, jsonb) FROM service_role;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_execute_zalo_conversation_flags_v1(text, jsonb) FROM authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_execute_zalo_conversation_flags_v1(text, jsonb) TO authenticated;
  END IF;
END
$quyen_thuc_thi_co_zalo$;

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
  'zalo.set_conversation_flags',
  1,
  'Đặt cờ hội thoại Zalo (ghim / tắt tiếng / chưa đọc)',
  'chat_zalo.view',
  'L3',
  'nonce_abi_v1',
  'click',
  'copilot_preview_zalo_conversation_flags_v1',
  'copilot_execute_zalo_conversation_flags_v1',
  'readback',
  'zalo_conversations',
  NULL,
  'zalo_set_conversation_flags',
  'Goi lai zalo_set_conversation_flags voi bo co cu (ba truong *_cu trong preview, va before_digest cua so hanh dong)',
  'zalo.set_conversation_flags',
  true
)
ON CONFLICT (action_id) DO NOTHING;

SELECT set_config('app.copilot_feature_flag_transition', 'v2', true);

INSERT INTO public.copilot_feature_flags (
  scope, contract_id, state, reason, evidence_link, rollback_reference
)
VALUES (
  'action', 'zalo.set_conversation_flags', 'disabled',
  'seed kill switch cho action L3 dat co hoi thoai Zalo (G2-D)',
  'migration:20260903073048_copilot_action_zalo_conversation_flags_v1',
  'migration:20260903073048_copilot_action_zalo_conversation_flags_v1'
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
    'public.copilot_preview_zalo_conversation_flags_v1(uuid, jsonb)',
    'public.copilot_execute_zalo_conversation_flags_v1(text, jsonb)'
  ]
  LOOP
    IF to_regprocedure(v_ten) IS NULL THEN
      v_thieu := v_thieu || v_ten;
    END IF;
  END LOOP;
  IF cardinality(v_thieu) > 0 THEN
    RAISE EXCEPTION 'thieu ham G2-D zalo flags: %', array_to_string(v_thieu, ', ');
  END IF;

  IF to_regprocedure('app_private.copilot_action_gate_v1(text, uuid)') IS NULL THEN
    RAISE EXCEPTION 'copilot_action_gate_v1 missing — 20260903043956 phai chay truoc';
  END IF;
  IF to_regprocedure('app_private.copilot_ledger_append_v1(jsonb)') IS NULL THEN
    RAISE EXCEPTION 'copilot_ledger_append_v1 missing — 20260903043956 phai chay truoc';
  END IF;
  IF to_regprocedure('public.zalo_set_conversation_flags(uuid, boolean, boolean, boolean)') IS NULL THEN
    RAISE EXCEPTION 'zalo_set_conversation_flags missing — 20260813120000 phai chay truoc';
  END IF;
  IF to_regclass('public.zalo_conversations') IS NULL THEN
    RAISE EXCEPTION 'zalo_conversations missing — baseline phai co truoc';
  END IF;

  IF to_regrole('anon') IS NOT NULL THEN
    FOREACH v_ten IN ARRAY ARRAY[
      'public.copilot_preview_zalo_conversation_flags_v1(uuid, jsonb)',
      'public.copilot_execute_zalo_conversation_flags_v1(text, jsonb)'
    ]
    LOOP
      IF has_function_privilege('anon', to_regprocedure(v_ten)::oid, 'EXECUTE') THEN
        v_ho := v_ho || v_ten;
      END IF;
    END LOOP;
    IF cardinality(v_ho) > 0 THEN
      RAISE EXCEPTION 'anon goi duoc ham G2-D zalo flags: %', array_to_string(v_ho, ', ');
    END IF;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM app_private.copilot_action_registry
     WHERE action_id = 'zalo.set_conversation_flags'
       AND risk = 'L3' AND executor_kind = 'nonce_abi_v1' AND consent_required = 'click'
       AND permission_key = 'chat_zalo.view'
  ) THEN
    RAISE EXCEPTION 'seed registry zalo.set_conversation_flags sai hinh hoac thieu';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.copilot_feature_flags f
     WHERE f.scope = 'action' AND f.contract_id = 'zalo.set_conversation_flags'
  ) THEN
    RAISE EXCEPTION 'copilot_rollout_seed_thieu_action_contract: zalo.set_conversation_flags';
  END IF;
END
$nghiem_thu$;

COMMIT;

NOTIFY pgrst, 'reload schema';
