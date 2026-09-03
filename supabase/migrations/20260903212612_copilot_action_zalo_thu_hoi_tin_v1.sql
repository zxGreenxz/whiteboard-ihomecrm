-- G5-C2 (6/7, nhom B - hieu ung ngoai) - Action L5 `zalo.recall_message` theo
-- khuon direct_l5_v1/external_effect (xem 20260903212610 cho co che
-- UNKNOWN_EFFECT + copilot_plan_reconcile_step_v1 - file nay KHONG dung lai
-- dong co ke hoach hay ham doi soat, chi dung chung).
--
-- BOC RPC GOC: `zalo_recall_message(p_message_id uuid)` (SECURITY DEFINER,
-- doc production 03/09/2026 - RETURNS void, quyen `zalo_can('send', org)`).
-- Wrapper goi NGUYEN VEN.
--
-- HAI TANG HIEU UNG - RPC goc lam HAI viec: (1) UPDATE dong bo NGAY
-- zalo_messages.body thanh "(Tin đã được thu hồi)" (da xong trong chinh giao
-- dich nay), VA (2) INSERT mot hang zalo_send_queue (action=recall) de WORKER
-- ngoai tien trinh DB thuc su bao Zalo thu hoi. Tang (1) la DB noi bo, luon
-- DONE ngay; tang (2) moi la HIEU UNG NGOAI that - do la ly do buoc nay van
-- can UNKNOWN_EFFECT/doi soat, du ban than DB da doi xong tu truoc khi tra ve.
--
-- BEFORE_DIGEST khac NULL - day la SUA mot tin nhan DA TON TAI, khong phai
-- TAO.
--
-- F1 (review G5-C2 fix round 1) - RACE O DUONG DOC LAI. Ban dau doc "hang
-- zalo_send_queue MOI NHAT cua hoi thoai" sau khi goi RPC goc - mot lan
-- gui/thu hoi SONG SONG khac vao CUNG hoi thoai co the chen mot hang MOI HON,
-- lam entity_id tro SAI. zalo_send_queue cua nhanh thu hoi KHONG duoc gan
-- message_id (chi nhanh broadcast moi gan - xem 20260903212610), nen sua
-- bang LIEN KET qua noi dung payload ma chinh RPC goc dong goi:
-- `target_msg_id`/`target_cli_msg_id` = zalo_msg_id/cli_msg_id CUA DUNG tin
-- nhan dang thu hoi (doc TRUOC khi goi RPC, tu v_before), cong voi cua so
-- thoi gian `created_at >= v_moc` (chup NGAY TRUOC khi goi) lam tieu chi phu.
-- Khong tim thay -> RAISE `external_effect_entity_not_found` TRUOC bat ky ghi
-- audit/ledger nao.
BEGIN;
SET LOCAL lock_timeout = '15s';

-- ---------------------------------------------------------------------------
-- MUC 1 - XEM TRUOC zalo.recall_message
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.copilot_preview_zalo_thu_hoi_tin_v1(
  p_organization_id uuid,
  p_payload         jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, extensions
AS $xem_truoc_zalo_thu_hoi_tin$
DECLARE
  v_actor      uuid := auth.uid();
  v_snapshot   jsonb;
  v_msg_id     uuid;
  v_msg        public.zalo_messages%ROWTYPE;
  v_canonical  jsonb;
  v_nonce      bytea;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization_required' USING ERRCODE = '22023';
  END IF;

  v_snapshot := app_private.copilot_action_gate_v1('zalo.recall_message', p_organization_id);

  BEGIN
    v_msg_id := (p_payload ->> 'message_id')::uuid;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'payload_invalid' USING ERRCODE = '22023';
  END;
  IF v_msg_id IS NULL THEN
    RAISE EXCEPTION 'payload_invalid' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_msg
    FROM public.zalo_messages m
   WHERE m.id = v_msg_id AND m.organization_id = p_organization_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'entity_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_msg.direction <> 'out' THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;
  IF NOT public.zalo_can('send', p_organization_id) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;

  v_canonical := jsonb_build_object(
    'organization_id', p_organization_id,
    'message_id',       v_msg_id
  );
  v_nonce := extensions.gen_random_bytes(32);

  INSERT INTO app_private.copilot_write_confirmations
    (nonce_digest, user_id, organization_id, tool, payload_hash,
     permission_key, expires_at)
  VALUES
    (extensions.digest(v_nonce, 'sha256'), v_actor, p_organization_id,
     'zalo.recall_message', app_private.copilot_payload_hash_v1(v_canonical),
     'chat_zalo.send', clock_timestamp() + interval '5 minutes');

  RETURN jsonb_build_object(
    'confirmation_nonce', encode(v_nonce, 'hex'),
    'canonical',          v_canonical,
    'preview', jsonb_build_object(
      'trang_thai_hien_tai', left(COALESCE(v_msg.body, ''), 200),
      'hau_qua',             'Se thu hoi tin nhan - noi dung cu KHONG the phuc hoi qua RPC',
      'canh_bao',            'Buoc se dung o "hieu ung ngoai - dang doi soat" cho toi khi worker bao Zalo thu hoi xong'
    )
  );
END
$xem_truoc_zalo_thu_hoi_tin$;

COMMENT ON FUNCTION public.copilot_preview_zalo_thu_hoi_tin_v1(uuid, jsonb) IS
  'direct_l5_v1/external_effect - xem truoc thu hoi tin Zalo (boc zalo_recall_message).';

REVOKE ALL ON FUNCTION public.copilot_preview_zalo_thu_hoi_tin_v1(uuid, jsonb)
  FROM PUBLIC;
DO $quyen_xem_truoc_zalo_thu_hoi_tin$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_preview_zalo_thu_hoi_tin_v1(uuid, jsonb) FROM anon;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_preview_zalo_thu_hoi_tin_v1(uuid, jsonb) FROM service_role;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_preview_zalo_thu_hoi_tin_v1(uuid, jsonb) FROM authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_preview_zalo_thu_hoi_tin_v1(uuid, jsonb) TO authenticated;
  END IF;
END
$quyen_xem_truoc_zalo_thu_hoi_tin$;

-- ---------------------------------------------------------------------------
-- MUC 2 - THUC THI zalo.recall_message
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.copilot_execute_zalo_thu_hoi_tin_v1(
  p_confirmation_nonce text,
  p_payload            jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, extensions
AS $thuc_thi_zalo_thu_hoi_tin$
DECLARE
  v_actor      uuid := auth.uid();
  v_hash       bytea;
  v_row        app_private.copilot_write_confirmations%ROWTYPE;
  v_snapshot   jsonb;
  v_org        uuid;
  v_msg_id     uuid;
  v_key        text;
  v_prev       public.ai_write_audit%ROWTYPE;
  v_before     jsonb;
  v_conv_id    uuid;
  v_queue_id   uuid;
  v_after      jsonb;
  v_audit_id   uuid;
  v_ledger_id  uuid;
  v_moc        timestamptz;
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
  IF v_row.tool IS DISTINCT FROM 'zalo.recall_message'
     OR v_row.permission_key IS DISTINCT FROM 'chat_zalo.send' THEN
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
    v_msg_id := (p_payload ->> 'message_id')::uuid;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'payload_changed' USING ERRCODE = '42501';
  END;
  IF v_org IS NULL OR v_msg_id IS NULL
     OR v_org IS DISTINCT FROM v_row.organization_id THEN
    RAISE EXCEPTION 'organization_mismatch' USING ERRCODE = '42501';
  END IF;

  IF NOT app_private.copilot_l5_plan_context_ok_v1('zalo.recall_message', v_org) THEN
    RAISE EXCEPTION 'l5_requires_plan' USING ERRCODE = '42501';
  END IF;

  v_snapshot := app_private.copilot_action_gate_v1('zalo.recall_message', v_org);

  v_key := 'copilot_action:zalo.recall_message:' || v_actor::text || ':'
        || v_org::text || ':' || encode(v_hash, 'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended(v_key, 0));

  SELECT * INTO v_prev
    FROM public.ai_write_audit a
   WHERE a.idempotency_key = v_key;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'status',       'da_thuc_hien_truoc_do',
      'entity_table', 'zalo_send_queue',
      'entity_id',    v_prev.entity_id,
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

  SELECT to_jsonb(m), m.conversation_id INTO v_before, v_conv_id
    FROM public.zalo_messages m
   WHERE m.id = v_msg_id AND m.organization_id = v_org;
  IF v_before IS NULL THEN
    RAISE EXCEPTION 'entity_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_before ->> 'direction' <> 'out' THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;

  v_moc := clock_timestamp();
  PERFORM public.zalo_recall_message(v_msg_id);

  -- READBACK tang (1): body phai da doi ngay trong DB.
  IF NOT EXISTS (
    SELECT 1 FROM public.zalo_messages m
     WHERE m.id = v_msg_id AND m.organization_id = v_org
       AND m.msg_type = 'sys'
  ) THEN
    RAISE EXCEPTION 'copilot_write_readback_mismatch' USING ERRCODE = 'P0001';
  END IF;

  -- entity cho DOI SOAT la hang outbox tang (2) - LIEN KET THAT qua
  -- target_msg_id/target_cli_msg_id (F1, review G5-C2 fix round 1), khong
  -- doan "moi nhat theo hoi thoai". Hai ve IS NOT DISTINCT FROM (khong phai
  -- =) vi zalo_msg_id/cli_msg_id co the con NULL (tin chua tung dong bo len
  -- Zalo) o ca hai phia - '=' voi NULL luon la NULL (khong bao gio khop),
  -- se lam mot tin hop le nhung chua co zalo_msg_id khong bao gio doi soat
  -- duoc. created_at >= v_moc la tieu chi phu chong trung khi ca hai id deu
  -- NULL cung luc (nhieu lan thu hoi cung mot tin chua dong bo).
  SELECT id, to_jsonb(t) INTO v_queue_id, v_after
    FROM public.zalo_send_queue t
   WHERE t.conversation_id = v_conv_id
     AND t.organization_id = v_org
     AND t.created_at >= v_moc
     AND (t.payload ->> 'target_msg_id') IS NOT DISTINCT FROM (v_before ->> 'zalo_msg_id')
     AND (t.payload ->> 'target_cli_msg_id') IS NOT DISTINCT FROM (v_before ->> 'cli_msg_id')
   ORDER BY t.created_at ASC
   LIMIT 1;
  IF v_queue_id IS NULL
     OR NULLIF(v_after ->> 'organization_id', '')::uuid IS DISTINCT FROM v_org THEN
    RAISE EXCEPTION 'external_effect_entity_not_found' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.ai_write_audit
    (user_id, tool, idempotency_key, entity_table, entity_id, payload, organization_id)
  VALUES
    (v_actor, 'zalo.recall_message', v_key, 'zalo_send_queue',
     v_queue_id, p_payload, v_org)
  RETURNING id INTO v_audit_id;

  v_ledger_id := app_private.copilot_ledger_append_v1(jsonb_build_object(
    'event',               'action_executed',
    'organization_id',     v_org,
    'action_id',           'zalo.recall_message',
    'permission_key',      'chat_zalo.send',
    'permission_snapshot', v_snapshot,
    'consent_kind',        'click',
    'consent_id',          v_row.id,
    'payload_digest',      encode(v_hash, 'hex'),
    'before_digest',       encode(extensions.digest(
                             convert_to(v_before::text, 'UTF8'), 'sha256'), 'hex'),
    'after_digest',        encode(extensions.digest(
                             convert_to(v_after::text, 'UTF8'), 'sha256'), 'hex'),
    'entity_table',        'zalo_send_queue',
    'entity_id',            v_queue_id,
    'audit_id',             v_audit_id,
    'outcome',              jsonb_build_object('status', 'da_gui')
  ));

  RETURN jsonb_build_object(
    'status',       'da_gui',
    'entity_table', 'zalo_send_queue',
    'entity_id',    v_queue_id,
    'audit_id',     v_audit_id,
    'ledger_id',    v_ledger_id
  );
END
$thuc_thi_zalo_thu_hoi_tin$;

COMMENT ON FUNCTION public.copilot_execute_zalo_thu_hoi_tin_v1(text, jsonb) IS
  'direct_l5_v1/external_effect - tieu nonce, tu choi neu khong chay trong ke hoach, goi lai zalo_recall_message, doc lai zalo_messages.msg_type=sys, roi doc hang zalo_send_queue LIEN KET qua target_msg_id/target_cli_msg_id (khong doan moi nhat - F1 fix round 1) lam entity_id. Buoc dung o UNKNOWN_EFFECT.';

REVOKE ALL ON FUNCTION public.copilot_execute_zalo_thu_hoi_tin_v1(text, jsonb)
  FROM PUBLIC;
DO $quyen_thuc_thi_zalo_thu_hoi_tin$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_execute_zalo_thu_hoi_tin_v1(text, jsonb) FROM anon;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_execute_zalo_thu_hoi_tin_v1(text, jsonb) FROM service_role;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_execute_zalo_thu_hoi_tin_v1(text, jsonb) FROM authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_execute_zalo_thu_hoi_tin_v1(text, jsonb) TO authenticated;
  END IF;
END
$quyen_thuc_thi_zalo_thu_hoi_tin$;

-- ---------------------------------------------------------------------------
-- MUC 3 - SO DANG KY + CO
-- ---------------------------------------------------------------------------
INSERT INTO app_private.copilot_action_registry (
  action_id, version, label_vi, permission_key, risk, executor_kind,
  consent_required, preview_rpc, execute_rpc, verify_kind,
  produces_entity_table, consumes_ref_table, rollback_rpc, rollback_note,
  flag_contract_id, enabled, grantable
)
VALUES (
  'zalo.recall_message',
  1,
  'Thu hồi tin Zalo',
  'chat_zalo.send',
  'L5',
  'direct_l5_v1',
  'step_up',
  'copilot_preview_zalo_thu_hoi_tin_v1',
  'copilot_execute_zalo_thu_hoi_tin_v1',
  'external_effect',
  'zalo_send_queue',
  NULL,
  NULL,
  'Khong co RPC hoan tac - body cu bi RPC goc GHI DE ngay ("(Tin đã được thu hồi)"), khong the phuc hoi qua RPC. Muon lay lai noi dung cu phai doc before_digest cua dong so hanh dong roi gui lai tay bang mot tin moi.',
  'zalo.recall_message',
  true,
  false
)
ON CONFLICT (action_id) DO NOTHING;

SELECT set_config('app.copilot_feature_flag_transition', 'v2', true);

INSERT INTO public.copilot_feature_flags (
  scope, contract_id, state, reason, evidence_link, rollback_reference
)
VALUES (
  'action', 'zalo.recall_message', 'disabled',
  'seed kill switch cho action L5 thu hoi tin Zalo (G5-C2 nhom B) - policy con L4 nen action nay khong the chay ke ca bat co',
  'migration:20260903212612_copilot_action_zalo_thu_hoi_tin_v1',
  'migration:20260903212612_copilot_action_zalo_thu_hoi_tin_v1'
)
ON CONFLICT (scope, contract_id) DO NOTHING;

SELECT set_config('app.copilot_feature_flag_transition', '', true);

-- ---------------------------------------------------------------------------
-- NGHIEM THU
-- ---------------------------------------------------------------------------
DO $nghiem_thu$
DECLARE
  v_ten   text;
  v_thieu text[] := '{}'::text[];
  v_ho    text[] := '{}'::text[];
BEGIN
  FOREACH v_ten IN ARRAY ARRAY[
    'public.copilot_preview_zalo_thu_hoi_tin_v1(uuid, jsonb)',
    'public.copilot_execute_zalo_thu_hoi_tin_v1(text, jsonb)'
  ]
  LOOP
    IF to_regprocedure(v_ten) IS NULL THEN
      v_thieu := v_thieu || v_ten;
    END IF;
  END LOOP;
  IF cardinality(v_thieu) > 0 THEN
    RAISE EXCEPTION 'thieu ham G5-C2 zalo_thu_hoi_tin: %', array_to_string(v_thieu, ', ');
  END IF;

  IF to_regprocedure('app_private.copilot_l5_plan_context_ok_v1(text, uuid)') IS NULL THEN
    RAISE EXCEPTION 'copilot_l5_plan_context_ok_v1 missing - 20260903190255 phai chay truoc';
  END IF;
  IF to_regprocedure('public.zalo_recall_message(uuid)') IS NULL THEN
    RAISE EXCEPTION 'zalo_recall_message missing - baseline phai co truoc';
  END IF;

  IF to_regrole('anon') IS NOT NULL THEN
    FOREACH v_ten IN ARRAY ARRAY[
      'public.copilot_preview_zalo_thu_hoi_tin_v1(uuid, jsonb)',
      'public.copilot_execute_zalo_thu_hoi_tin_v1(text, jsonb)'
    ]
    LOOP
      IF has_function_privilege('anon', to_regprocedure(v_ten)::oid, 'EXECUTE') THEN
        v_ho := v_ho || v_ten;
      END IF;
    END LOOP;
    IF cardinality(v_ho) > 0 THEN
      RAISE EXCEPTION 'anon goi duoc ham G5-C2 zalo_thu_hoi_tin: %', array_to_string(v_ho, ', ');
    END IF;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM app_private.copilot_action_registry
     WHERE action_id = 'zalo.recall_message'
       AND risk = 'L5' AND executor_kind = 'direct_l5_v1' AND consent_required = 'step_up'
       AND permission_key = 'chat_zalo.send'
       AND verify_kind = 'external_effect'
       AND grantable = false
  ) THEN
    RAISE EXCEPTION 'seed registry zalo.recall_message sai hinh hoac thieu';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.copilot_feature_flags f
     WHERE f.scope = 'action' AND f.contract_id = 'zalo.recall_message'
  ) THEN
    RAISE EXCEPTION 'copilot_rollout_seed_thieu_action_contract: zalo.recall_message';
  END IF;
END
$nghiem_thu$;

COMMIT;

NOTIFY pgrst, 'reload schema';
