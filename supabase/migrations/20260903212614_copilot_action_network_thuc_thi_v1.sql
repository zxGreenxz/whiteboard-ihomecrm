-- G5-C2 (7/7, nhom B - hieu ung ngoai) - Action L5 `network.execute_action`
-- theo khuon direct_l5_v1/external_effect (xem 20260903212610 cho co che
-- UNKNOWN_EFFECT + copilot_plan_reconcile_step_v1 - file nay chi dung chung,
-- khong CREATE OR REPLACE lai).
--
-- BOC RPC GOC: `network_center_execute_action_v1(p_device_id uuid,
-- p_action_type text, p_reason text, p_parameters jsonb, p_confirmation
-- text, p_request_id uuid)` (SECURITY DEFINER, doc production 03/09/2026 -
-- quyen qua `app_private.network_center_require_execute_v1(building_id)`,
-- permission_key 'network_center.execute' theo dung chuoi RPC tu ghi vao
-- audit noi bo). RPC CHI XEP HANG lenh vao `network_commands` (status
-- QUEUED) - worker MikroTik ngoai tien trinh DB moi thuc thi that.
--
-- DOI SOAT - `copilot_plan_reconcile_step_v1` doc lai `network_commands` theo
-- commandId: SUCCEEDED -> DONE; FAILED/CANCELLED_BY_KILL_SWITCH -> FAILED;
-- con lai (QUEUED/LEASED/RUNNING/RETRY_WAIT/UNCERTAIN/RECONCILING) -> van
-- UNKNOWN_EFFECT.
--
-- REQUEST_ID - RPC goc doi p_request_id (dung cho co che chong-lap rieng cua
-- Network Center, qua `network_center_request_replay_v1`). Wrapper TU SINH
-- mot uuid ngau nhien NGAY TRUOC khi goi RPC (khong dua vao canonical/payload
-- - day la mot chi tiet thuc thi noi bo, giong het cach cac wrapper khac tu
-- sinh nonce). Lop chong-lap CUA CHINH wrapper nay (khoa advisory + tra ve
-- 'da_thuc_hien_truoc_do' qua ai_write_audit) da du de dam bao RPC goc chi
-- duoc goi DUNG MOT LAN cho mot payload da duyet.
--
-- BEFORE_DIGEST NULL - day la XEP HANG mot lenh MOI, giong nhanh TAO cua
-- role.upsert/member.invite - khong co "truoc" tren mot lenh chua ton tai.
BEGIN;
SET LOCAL lock_timeout = '15s';

-- ---------------------------------------------------------------------------
-- MUC 1 - XEM TRUOC network.execute_action
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.copilot_preview_network_thuc_thi_v1(
  p_organization_id uuid,
  p_payload         jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, extensions
AS $xem_truoc_network_thuc_thi$
DECLARE
  v_actor       uuid := auth.uid();
  v_snapshot    jsonb;
  v_device_id   uuid;
  v_action_type text;
  v_reason      text;
  v_parameters  jsonb;
  v_confirmation text;
  v_device      public.network_devices%ROWTYPE;
  v_org         uuid;
  v_canonical   jsonb;
  v_nonce       bytea;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization_required' USING ERRCODE = '22023';
  END IF;

  v_snapshot := app_private.copilot_action_gate_v1('network.execute_action', p_organization_id);

  BEGIN
    v_device_id := (p_payload ->> 'device_id')::uuid;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'payload_invalid' USING ERRCODE = '22023';
  END;
  v_action_type := upper(btrim(COALESCE(p_payload ->> 'action_type', '')));
  v_reason := btrim(COALESCE(p_payload ->> 'reason', ''));
  v_parameters := COALESCE(p_payload -> 'parameters', '{}'::jsonb);
  v_confirmation := p_payload ->> 'confirmation';

  IF v_device_id IS NULL
     OR v_action_type NOT IN ('FLUSH_DNS_CACHE','RENEW_DHCP_LEASE','CYCLE_ACCESS_PORT','REBOOT_ROUTER')
     OR char_length(v_reason) NOT BETWEEN 8 AND 1000
     OR jsonb_typeof(v_parameters) <> 'object' THEN
    RAISE EXCEPTION 'payload_invalid' USING ERRCODE = '22023';
  END IF;

  SELECT d.* INTO v_device FROM public.network_devices d WHERE d.id = v_device_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'entity_not_found' USING ERRCODE = 'P0002';
  END IF;
  SELECT b.organization_id INTO v_org
    FROM public.buildings b WHERE b.id = v_device.building_id;
  IF v_org IS NULL OR v_org IS DISTINCT FROM p_organization_id THEN
    RAISE EXCEPTION 'entity_not_found' USING ERRCODE = 'P0002';
  END IF;

  v_canonical := jsonb_build_object(
    'organization_id', p_organization_id,
    'device_id',        v_device_id,
    'action_type',      v_action_type,
    'reason',           v_reason,
    'parameters',       v_parameters,
    'confirmation',     v_confirmation
  );
  v_nonce := extensions.gen_random_bytes(32);

  INSERT INTO app_private.copilot_write_confirmations
    (nonce_digest, user_id, organization_id, tool, payload_hash,
     permission_key, expires_at)
  VALUES
    (extensions.digest(v_nonce, 'sha256'), v_actor, p_organization_id,
     'network.execute_action', app_private.copilot_payload_hash_v1(v_canonical),
     'network_center.execute', clock_timestamp() + interval '5 minutes');

  RETURN jsonb_build_object(
    'confirmation_nonce', encode(v_nonce, 'hex'),
    'canonical',          v_canonical,
    'preview', jsonb_build_object(
      'toa_nha',              NULL,
      'trang_thai_hien_tai',  COALESCE(v_device.lifecycle_status, '?'),
      'hau_qua',              format('Se xep hang lenh %s cho router - hieu ung ngoai, doi soat sau khi thuc thi', v_action_type),
      'canh_bao',              CASE WHEN v_action_type IN ('CYCLE_ACCESS_PORT','REBOOT_ROUTER')
                                    THEN 'Can go dung ten dinh danh router hien tai de xac nhan'
                                    ELSE NULL END
    )
  );
END
$xem_truoc_network_thuc_thi$;

COMMENT ON FUNCTION public.copilot_preview_network_thuc_thi_v1(uuid, jsonb) IS
  'direct_l5_v1/external_effect - xem truoc thuc thi lenh Network Center (boc network_center_execute_action_v1).';

REVOKE ALL ON FUNCTION public.copilot_preview_network_thuc_thi_v1(uuid, jsonb)
  FROM PUBLIC;
DO $quyen_xem_truoc_network_thuc_thi$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_preview_network_thuc_thi_v1(uuid, jsonb) FROM anon;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_preview_network_thuc_thi_v1(uuid, jsonb) FROM service_role;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_preview_network_thuc_thi_v1(uuid, jsonb) FROM authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_preview_network_thuc_thi_v1(uuid, jsonb) TO authenticated;
  END IF;
END
$quyen_xem_truoc_network_thuc_thi$;

-- ---------------------------------------------------------------------------
-- MUC 2 - THUC THI network.execute_action
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.copilot_execute_network_thuc_thi_v1(
  p_confirmation_nonce text,
  p_payload            jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, extensions
AS $thuc_thi_network_thuc_thi$
DECLARE
  v_actor       uuid := auth.uid();
  v_hash        bytea;
  v_row         app_private.copilot_write_confirmations%ROWTYPE;
  v_snapshot    jsonb;
  v_org         uuid;
  v_device_id   uuid;
  v_action_type text;
  v_reason      text;
  v_parameters  jsonb;
  v_confirmation text;
  v_key         text;
  v_prev        public.ai_write_audit%ROWTYPE;
  v_request_id  uuid;
  v_result      jsonb;
  v_command_id  uuid;
  v_after       jsonb;
  v_audit_id    uuid;
  v_ledger_id   uuid;
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
  IF v_row.tool IS DISTINCT FROM 'network.execute_action'
     OR v_row.permission_key IS DISTINCT FROM 'network_center.execute' THEN
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
    v_org          := (p_payload ->> 'organization_id')::uuid;
    v_device_id    := (p_payload ->> 'device_id')::uuid;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'payload_changed' USING ERRCODE = '42501';
  END;
  v_action_type  := p_payload ->> 'action_type';
  v_reason       := p_payload ->> 'reason';
  v_parameters   := COALESCE(p_payload -> 'parameters', '{}'::jsonb);
  v_confirmation := p_payload ->> 'confirmation';
  IF v_org IS NULL OR v_device_id IS NULL
     OR v_org IS DISTINCT FROM v_row.organization_id THEN
    RAISE EXCEPTION 'organization_mismatch' USING ERRCODE = '42501';
  END IF;

  IF NOT app_private.copilot_l5_plan_context_ok_v1('network.execute_action', v_org) THEN
    RAISE EXCEPTION 'l5_requires_plan' USING ERRCODE = '42501';
  END IF;

  v_snapshot := app_private.copilot_action_gate_v1('network.execute_action', v_org);

  v_key := 'copilot_action:network.execute_action:' || v_actor::text || ':'
        || v_org::text || ':' || encode(v_hash, 'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended(v_key, 0));

  SELECT * INTO v_prev
    FROM public.ai_write_audit a
   WHERE a.idempotency_key = v_key;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'status',       'da_thuc_hien_truoc_do',
      'entity_table', 'network_commands',
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

  -- before_digest NULL - xep hang mot LENH MOI, khong co "truoc". request_id
  -- tu sinh ngay truoc khi goi - xem chu thich dau file.
  v_request_id := extensions.gen_random_uuid();
  v_result := public.network_center_execute_action_v1(
    v_device_id, v_action_type, v_reason, v_parameters, v_confirmation, v_request_id);
  v_command_id := NULLIF(v_result ->> 'commandId', '')::uuid;
  IF v_command_id IS NULL THEN
    RAISE EXCEPTION 'copilot_write_readback_mismatch' USING ERRCODE = 'P0001';
  END IF;

  SELECT to_jsonb(t) INTO v_after
    FROM public.network_commands t
   WHERE t.id = v_command_id;
  IF v_after IS NULL
     OR NULLIF(v_after ->> 'organization_id', '')::uuid IS DISTINCT FROM v_org THEN
    RAISE EXCEPTION 'copilot_write_readback_mismatch' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.ai_write_audit
    (user_id, tool, idempotency_key, entity_table, entity_id, payload, organization_id)
  VALUES
    (v_actor, 'network.execute_action', v_key, 'network_commands',
     v_command_id, p_payload, v_org)
  RETURNING id INTO v_audit_id;

  v_ledger_id := app_private.copilot_ledger_append_v1(jsonb_build_object(
    'event',               'action_executed',
    'organization_id',     v_org,
    'action_id',           'network.execute_action',
    'permission_key',      'network_center.execute',
    'permission_snapshot', v_snapshot,
    'consent_kind',        'click',
    'consent_id',          v_row.id,
    'payload_digest',      encode(v_hash, 'hex'),
    'before_digest',       NULL,
    'after_digest',        encode(extensions.digest(
                             convert_to(v_after::text, 'UTF8'), 'sha256'), 'hex'),
    'entity_table',        'network_commands',
    'entity_id',            v_command_id,
    'audit_id',             v_audit_id,
    'outcome',              jsonb_build_object('status', 'da_gui', 'command_status', v_after ->> 'status')
  ));

  RETURN jsonb_build_object(
    'status',       'da_gui',
    'entity_table', 'network_commands',
    'entity_id',    v_command_id,
    'audit_id',     v_audit_id,
    'ledger_id',    v_ledger_id
  );
END
$thuc_thi_network_thuc_thi$;

COMMENT ON FUNCTION public.copilot_execute_network_thuc_thi_v1(text, jsonb) IS
  'direct_l5_v1/external_effect - tieu nonce, tu choi neu khong chay trong ke hoach, tu sinh request_id, goi lai network_center_execute_action_v1, doc lai network_commands theo commandId. Buoc dung o UNKNOWN_EFFECT.';

REVOKE ALL ON FUNCTION public.copilot_execute_network_thuc_thi_v1(text, jsonb)
  FROM PUBLIC;
DO $quyen_thuc_thi_network_thuc_thi$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_execute_network_thuc_thi_v1(text, jsonb) FROM anon;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_execute_network_thuc_thi_v1(text, jsonb) FROM service_role;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_execute_network_thuc_thi_v1(text, jsonb) FROM authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_execute_network_thuc_thi_v1(text, jsonb) TO authenticated;
  END IF;
END
$quyen_thuc_thi_network_thuc_thi$;

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
  'network.execute_action',
  1,
  'Thực thi lệnh Network Center',
  'network_center.execute',
  'L5',
  'direct_l5_v1',
  'step_up',
  'copilot_preview_network_thuc_thi_v1',
  'copilot_execute_network_thuc_thi_v1',
  'external_effect',
  'network_commands',
  NULL,
  'network_center_retire_uncertain_command_v1',
  'Chi huy duoc lenh CON o trang thai chua chot (QUEUED/LEASED/RUNNING/RETRY_WAIT/UNCERTAIN/RECONCILING) qua network_center_retire_uncertain_command_v1(building_id, command_id, reason, request_id). Lenh da SUCCEEDED/FAILED khong hoan tac duoc.',
  'network.execute_action',
  true,
  false
)
ON CONFLICT (action_id) DO NOTHING;

SELECT set_config('app.copilot_feature_flag_transition', 'v2', true);

INSERT INTO public.copilot_feature_flags (
  scope, contract_id, state, reason, evidence_link, rollback_reference
)
VALUES (
  'action', 'network.execute_action', 'disabled',
  'seed kill switch cho action L5 thuc thi lenh Network Center (G5-C2 nhom B) - policy con L4 nen action nay khong the chay ke ca bat co',
  'migration:20260903212614_copilot_action_network_thuc_thi_v1',
  'migration:20260903212614_copilot_action_network_thuc_thi_v1'
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
    'public.copilot_preview_network_thuc_thi_v1(uuid, jsonb)',
    'public.copilot_execute_network_thuc_thi_v1(text, jsonb)'
  ]
  LOOP
    IF to_regprocedure(v_ten) IS NULL THEN
      v_thieu := v_thieu || v_ten;
    END IF;
  END LOOP;
  IF cardinality(v_thieu) > 0 THEN
    RAISE EXCEPTION 'thieu ham G5-C2 network_thuc_thi: %', array_to_string(v_thieu, ', ');
  END IF;

  IF to_regprocedure('app_private.copilot_l5_plan_context_ok_v1(text, uuid)') IS NULL THEN
    RAISE EXCEPTION 'copilot_l5_plan_context_ok_v1 missing - 20260903190255 phai chay truoc';
  END IF;
  IF to_regprocedure('public.network_center_execute_action_v1(uuid, text, text, jsonb, text, uuid)') IS NULL THEN
    RAISE EXCEPTION 'network_center_execute_action_v1 missing - baseline phai co truoc';
  END IF;
  IF to_regprocedure('public.network_center_retire_uncertain_command_v1(uuid, uuid, text, uuid)') IS NULL THEN
    RAISE EXCEPTION 'network_center_retire_uncertain_command_v1 missing - rollback_rpc phai ton tai that';
  END IF;

  IF to_regrole('anon') IS NOT NULL THEN
    FOREACH v_ten IN ARRAY ARRAY[
      'public.copilot_preview_network_thuc_thi_v1(uuid, jsonb)',
      'public.copilot_execute_network_thuc_thi_v1(text, jsonb)'
    ]
    LOOP
      IF has_function_privilege('anon', to_regprocedure(v_ten)::oid, 'EXECUTE') THEN
        v_ho := v_ho || v_ten;
      END IF;
    END LOOP;
    IF cardinality(v_ho) > 0 THEN
      RAISE EXCEPTION 'anon goi duoc ham G5-C2 network_thuc_thi: %', array_to_string(v_ho, ', ');
    END IF;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM app_private.copilot_action_registry
     WHERE action_id = 'network.execute_action'
       AND risk = 'L5' AND executor_kind = 'direct_l5_v1' AND consent_required = 'step_up'
       AND permission_key = 'network_center.execute'
       AND verify_kind = 'external_effect'
       AND grantable = false
       AND rollback_rpc = 'network_center_retire_uncertain_command_v1'
  ) THEN
    RAISE EXCEPTION 'seed registry network.execute_action sai hinh hoac thieu';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.copilot_feature_flags f
     WHERE f.scope = 'action' AND f.contract_id = 'network.execute_action'
  ) THEN
    RAISE EXCEPTION 'copilot_rollout_seed_thieu_action_contract: network.execute_action';
  END IF;
END
$nghiem_thu$;

COMMIT;

NOTIFY pgrst, 'reload schema';
