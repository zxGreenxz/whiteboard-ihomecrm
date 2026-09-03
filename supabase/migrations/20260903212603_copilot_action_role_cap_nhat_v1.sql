-- G5-C2 (2/7, nhom A - phan quyen) - Action L5 `role.upsert` theo khuon
-- direct_l5_v1 (xem 20260903190255 cho khuon day du, 20260903212600 cho cot
-- pin_always + patch copilot_plan_create_v1).
--
-- BOC RPC GOC: `upsert_organization_role_v1(p_role_id uuid, p_name text,
-- p_permissions jsonb, p_expected_version bigint, p_reason text)` (SECURITY
-- DEFINER, doc production 03/09/2026 - CA TAO LAN SUA cung mot ham, phan biet
-- boi p_role_id IS NULL. Quyen `require_perm_v1(org,'users.edit',...)`.
-- Wrapper goi NGUYEN VEN.
--
-- BEFORE_DIGEST - action nay LUONG TINH: nhanh SUA (role_id khac NULL) co
-- "truoc" that (hang da ton tai) nen before_digest khac NULL nhu moi action
-- khac cua G5-C; nhanh TAO (role_id la NULL) khong co gi de chup truoc khi
-- ghi, giong het ngoai le da ghi trong bao cao G5-C dot 1 cho
-- `reservation_deposit.create` - before_digest la NULL CHI o nhanh nay, co
-- kiem tra rieng trong test.
--
-- MUC 0 - dam bao pin_always da co (idempotent, phong khi file nay duoc kiem
-- doc lap tren production chua co migration 20260903212600).
BEGIN;
SET LOCAL lock_timeout = '15s';

DO $them_cot_pin_always$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'app_private' AND table_name = 'copilot_action_registry'
       AND column_name = 'pin_always'
  ) THEN
    ALTER TABLE app_private.copilot_action_registry
      ADD COLUMN pin_always boolean NOT NULL DEFAULT false;
  END IF;
END
$them_cot_pin_always$;

-- ---------------------------------------------------------------------------
-- MUC 1 - XEM TRUOC role.upsert
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.copilot_preview_role_cap_nhat_v1(
  p_organization_id uuid,
  p_payload         jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, extensions
AS $xem_truoc_role_cap_nhat$
DECLARE
  v_actor      uuid := auth.uid();
  v_snapshot   jsonb;
  v_role_id    uuid;
  v_name       text;
  v_permissions jsonb;
  v_expected   bigint;
  v_reason     text;
  v_row        public.organization_roles%ROWTYPE;
  v_n_perm     int;
  v_canonical  jsonb;
  v_nonce      bytea;
  v_hau_qua    text;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization_required' USING ERRCODE = '22023';
  END IF;

  v_snapshot := app_private.copilot_action_gate_v1('role.upsert', p_organization_id);

  BEGIN
    v_role_id  := NULLIF(p_payload ->> 'role_id', '')::uuid;
    v_expected := NULLIF(p_payload ->> 'expected_version', '')::bigint;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'payload_invalid' USING ERRCODE = '22023';
  END;
  v_name        := NULLIF(btrim(COALESCE(p_payload ->> 'name', '')), '');
  v_permissions := p_payload -> 'permissions';
  v_reason      := NULLIF(btrim(COALESCE(p_payload ->> 'reason', '')), '');

  IF v_role_id IS NULL THEN
    -- NHANH TAO. RPC goc doi ten + permissions bat buoc cho hang moi.
    IF v_name IS NULL OR v_permissions IS NULL THEN
      RAISE EXCEPTION 'payload_invalid' USING ERRCODE = '22023';
    END IF;
    v_hau_qua := 'Se TAO vai tro moi trong to chuc';
  ELSE
    SELECT * INTO v_row
      FROM public.organization_roles
     WHERE id = v_role_id;
    IF NOT FOUND OR v_row.organization_id IS DISTINCT FROM p_organization_id THEN
      RAISE EXCEPTION 'entity_not_found' USING ERRCODE = 'P0002';
    END IF;
    IF v_row.is_system THEN
      RAISE EXCEPTION 'system_role_readonly' USING ERRCODE = '42501';
    END IF;
    IF v_expected IS NULL THEN
      RAISE EXCEPTION 'payload_invalid' USING ERRCODE = '22023';
    END IF;
    v_hau_qua := 'Se SUA vai tro "' || v_row.name || '"';
  END IF;

  IF v_permissions IS NOT NULL THEN
    SELECT count(*) INTO v_n_perm FROM jsonb_array_elements(v_permissions);
  END IF;

  v_canonical := jsonb_build_object(
    'organization_id',  p_organization_id,
    'role_id',           v_role_id,
    'name',              v_name,
    'permissions',       v_permissions,
    'expected_version',  v_expected,
    'reason',            v_reason
  );
  v_nonce := extensions.gen_random_bytes(32);

  INSERT INTO app_private.copilot_write_confirmations
    (nonce_digest, user_id, organization_id, tool, payload_hash,
     permission_key, expires_at)
  VALUES
    (extensions.digest(v_nonce, 'sha256'), v_actor, p_organization_id,
     'role.upsert', app_private.copilot_payload_hash_v1(v_canonical),
     'users.edit', clock_timestamp() + interval '5 minutes');

  RETURN jsonb_build_object(
    'confirmation_nonce', encode(v_nonce, 'hex'),
    'canonical',          v_canonical,
    'preview', jsonb_build_object(
      'ten_phieu',           COALESCE(v_name, v_row.name),
      'trang_thai_hien_tai', CASE WHEN v_role_id IS NULL THEN 'Chua ton tai' ELSE v_row.name END,
      'hau_qua',              v_hau_qua,
      'canh_bao',             CASE WHEN v_permissions IS NOT NULL
                                    THEN format('%s quyen se duoc ghi', v_n_perm)
                                    ELSE NULL END
    )
  );
END
$xem_truoc_role_cap_nhat$;

COMMENT ON FUNCTION public.copilot_preview_role_cap_nhat_v1(uuid, jsonb) IS
  'direct_l5_v1 - xem truoc tao/sua vai tro (boc upsert_organization_role_v1). Nhom A - grantable=false + pin_always=true.';

REVOKE ALL ON FUNCTION public.copilot_preview_role_cap_nhat_v1(uuid, jsonb)
  FROM PUBLIC;
DO $quyen_xem_truoc_role_cap_nhat$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_preview_role_cap_nhat_v1(uuid, jsonb) FROM anon;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_preview_role_cap_nhat_v1(uuid, jsonb) FROM service_role;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_preview_role_cap_nhat_v1(uuid, jsonb) FROM authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_preview_role_cap_nhat_v1(uuid, jsonb) TO authenticated;
  END IF;
END
$quyen_xem_truoc_role_cap_nhat$;

-- ---------------------------------------------------------------------------
-- MUC 2 - THUC THI role.upsert
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.copilot_execute_role_cap_nhat_v1(
  p_confirmation_nonce text,
  p_payload            jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, extensions
AS $thuc_thi_role_cap_nhat$
DECLARE
  v_actor      uuid := auth.uid();
  v_hash       bytea;
  v_row        app_private.copilot_write_confirmations%ROWTYPE;
  v_snapshot   jsonb;
  v_org        uuid;
  v_role_id    uuid;
  v_name       text;
  v_permissions jsonb;
  v_expected   bigint;
  v_reason     text;
  v_key        text;
  v_prev       public.ai_write_audit%ROWTYPE;
  v_before     jsonb := NULL;
  v_after      jsonb;
  v_result     jsonb;
  v_new_role_id uuid;
  v_audit_id   uuid;
  v_ledger_id  uuid;
  v_before_hex text := NULL;
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
  IF v_row.tool IS DISTINCT FROM 'role.upsert'
     OR v_row.permission_key IS DISTINCT FROM 'users.edit' THEN
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
    v_org         := (p_payload ->> 'organization_id')::uuid;
    v_role_id     := NULLIF(p_payload ->> 'role_id', '')::uuid;
    v_expected    := NULLIF(p_payload ->> 'expected_version', '')::bigint;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'payload_changed' USING ERRCODE = '42501';
  END;
  v_name        := p_payload ->> 'name';
  v_permissions := p_payload -> 'permissions';
  v_reason      := p_payload ->> 'reason';
  IF v_org IS NULL OR v_org IS DISTINCT FROM v_row.organization_id THEN
    RAISE EXCEPTION 'organization_mismatch' USING ERRCODE = '42501';
  END IF;

  IF NOT app_private.copilot_l5_plan_context_ok_v1('role.upsert', v_org) THEN
    RAISE EXCEPTION 'l5_requires_plan' USING ERRCODE = '42501';
  END IF;

  v_snapshot := app_private.copilot_action_gate_v1('role.upsert', v_org);

  v_key := 'copilot_action:role.upsert:' || v_actor::text || ':'
        || v_org::text || ':' || encode(v_hash, 'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended(v_key, 0));

  SELECT * INTO v_prev
    FROM public.ai_write_audit a
   WHERE a.idempotency_key = v_key;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'status',       'da_thuc_hien_truoc_do',
      'entity_table', 'organization_roles',
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

  -- BEFORE - chi ton tai o nhanh SUA (role_id khac NULL). Nhanh TAO khong co
  -- gi de chup truoc khi ghi, giong `reservation_deposit.create`.
  IF v_role_id IS NOT NULL THEN
    SELECT to_jsonb(r) INTO v_before
      FROM public.organization_roles r
     WHERE r.id = v_role_id AND r.organization_id = v_org;
    IF v_before IS NULL THEN
      RAISE EXCEPTION 'entity_not_found' USING ERRCODE = 'P0002';
    END IF;
    v_before_hex := encode(extensions.digest(
      convert_to(v_before::text, 'UTF8'), 'sha256'), 'hex');
  END IF;

  v_result := public.upsert_organization_role_v1(
    v_role_id, v_name, v_permissions, v_expected, v_reason);
  v_new_role_id := NULLIF(v_result ->> 'roleId', '')::uuid;
  IF v_new_role_id IS NULL THEN
    RAISE EXCEPTION 'copilot_write_readback_mismatch' USING ERRCODE = 'P0001';
  END IF;

  SELECT to_jsonb(r) INTO v_after
    FROM public.organization_roles r
   WHERE r.id = v_new_role_id;
  IF v_after IS NULL
     OR NULLIF(v_after ->> 'organization_id', '')::uuid IS DISTINCT FROM v_org THEN
    RAISE EXCEPTION 'copilot_write_readback_mismatch' USING ERRCODE = 'P0001';
  END IF;
  IF v_role_id IS NOT NULL
     AND (v_after ->> 'version')::bigint <= (v_before ->> 'version')::bigint THEN
    RAISE EXCEPTION 'copilot_write_readback_mismatch' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.ai_write_audit
    (user_id, tool, idempotency_key, entity_table, entity_id, payload, organization_id)
  VALUES
    (v_actor, 'role.upsert', v_key, 'organization_roles',
     v_new_role_id, p_payload, v_org)
  RETURNING id INTO v_audit_id;

  v_ledger_id := app_private.copilot_ledger_append_v1(jsonb_build_object(
    'event',               'action_executed',
    'organization_id',     v_org,
    'action_id',           'role.upsert',
    'permission_key',      'users.edit',
    'permission_snapshot', v_snapshot,
    'consent_kind',        'click',
    'consent_id',          v_row.id,
    'payload_digest',      encode(v_hash, 'hex'),
    'before_digest',       v_before_hex,
    'after_digest',        encode(extensions.digest(
                             convert_to(v_after::text, 'UTF8'), 'sha256'), 'hex'),
    'entity_table',        'organization_roles',
    'entity_id',           v_new_role_id,
    'audit_id',            v_audit_id,
    'outcome',             jsonb_build_object('status', 'da_thuc_hien', 'result', v_result)
  ));

  RETURN jsonb_build_object(
    'status',       'da_thuc_hien',
    'entity_table', 'organization_roles',
    'entity_id',    v_new_role_id,
    'audit_id',     v_audit_id,
    'ledger_id',    v_ledger_id
  );
END
$thuc_thi_role_cap_nhat$;

COMMENT ON FUNCTION public.copilot_execute_role_cap_nhat_v1(text, jsonb) IS
  'direct_l5_v1 - tieu nonce, tu choi neu khong chay trong ke hoach (l5_requires_plan), goi lai upsert_organization_role_v1, doc lai theo roleId tra ve, ghi ai_write_audit + so hanh dong. before_digest NULL o nhanh TAO.';

REVOKE ALL ON FUNCTION public.copilot_execute_role_cap_nhat_v1(text, jsonb)
  FROM PUBLIC;
DO $quyen_thuc_thi_role_cap_nhat$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_execute_role_cap_nhat_v1(text, jsonb) FROM anon;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_execute_role_cap_nhat_v1(text, jsonb) FROM service_role;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_execute_role_cap_nhat_v1(text, jsonb) FROM authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_execute_role_cap_nhat_v1(text, jsonb) TO authenticated;
  END IF;
END
$quyen_thuc_thi_role_cap_nhat$;

-- ---------------------------------------------------------------------------
-- MUC 3 - SO DANG KY + CO
-- ---------------------------------------------------------------------------
INSERT INTO app_private.copilot_action_registry (
  action_id, version, label_vi, permission_key, risk, executor_kind,
  consent_required, preview_rpc, execute_rpc, verify_kind,
  produces_entity_table, consumes_ref_table, rollback_rpc, rollback_note,
  flag_contract_id, enabled, grantable, pin_always
)
VALUES (
  'role.upsert',
  1,
  'Tạo/sửa vai trò',
  'users.edit',
  'L5',
  'direct_l5_v1',
  'step_up',
  'copilot_preview_role_cap_nhat_v1',
  'copilot_execute_role_cap_nhat_v1',
  'readback',
  'organization_roles',
  NULL,
  NULL,
  'Khong co RPC hoan tac chung cho CA tao lan sua. Sua: goi lai upsert_organization_role_v1 voi permissions CU doc tu before_digest. Tao: chua co RPC xoa vai tro tuy chinh - phai thao tac tay tren man hinh Vai tro.',
  'role.upsert',
  true,
  false,
  true
)
ON CONFLICT (action_id) DO NOTHING;

SELECT set_config('app.copilot_feature_flag_transition', 'v2', true);

INSERT INTO public.copilot_feature_flags (
  scope, contract_id, state, reason, evidence_link, rollback_reference
)
VALUES (
  'action', 'role.upsert', 'disabled',
  'seed kill switch cho action L5 tao/sua vai tro (G5-C2 nhom A) - policy con L4 nen action nay khong the chay ke ca bat co',
  'migration:20260903212603_copilot_action_role_cap_nhat_v1',
  'migration:20260903212603_copilot_action_role_cap_nhat_v1'
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
    'public.copilot_preview_role_cap_nhat_v1(uuid, jsonb)',
    'public.copilot_execute_role_cap_nhat_v1(text, jsonb)'
  ]
  LOOP
    IF to_regprocedure(v_ten) IS NULL THEN
      v_thieu := v_thieu || v_ten;
    END IF;
  END LOOP;
  IF cardinality(v_thieu) > 0 THEN
    RAISE EXCEPTION 'thieu ham G5-C2 role_cap_nhat: %', array_to_string(v_thieu, ', ');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'app_private' AND table_name = 'copilot_action_registry'
       AND column_name = 'pin_always'
  ) THEN
    RAISE EXCEPTION 'cot pin_always chua duoc them';
  END IF;
  IF to_regprocedure('app_private.copilot_l5_plan_context_ok_v1(text, uuid)') IS NULL THEN
    RAISE EXCEPTION 'copilot_l5_plan_context_ok_v1 missing - 20260903190255 phai chay truoc';
  END IF;
  IF to_regprocedure('public.upsert_organization_role_v1(uuid, text, jsonb, bigint, text)') IS NULL THEN
    RAISE EXCEPTION 'upsert_organization_role_v1 missing - baseline phai co truoc';
  END IF;

  IF to_regrole('anon') IS NOT NULL THEN
    FOREACH v_ten IN ARRAY ARRAY[
      'public.copilot_preview_role_cap_nhat_v1(uuid, jsonb)',
      'public.copilot_execute_role_cap_nhat_v1(text, jsonb)'
    ]
    LOOP
      IF has_function_privilege('anon', to_regprocedure(v_ten)::oid, 'EXECUTE') THEN
        v_ho := v_ho || v_ten;
      END IF;
    END LOOP;
    IF cardinality(v_ho) > 0 THEN
      RAISE EXCEPTION 'anon goi duoc ham G5-C2 role_cap_nhat: %', array_to_string(v_ho, ', ');
    END IF;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM app_private.copilot_action_registry
     WHERE action_id = 'role.upsert'
       AND risk = 'L5' AND executor_kind = 'direct_l5_v1' AND consent_required = 'step_up'
       AND permission_key = 'users.edit'
       AND grantable = false
       AND pin_always = true
       AND rollback_rpc IS NULL
  ) THEN
    RAISE EXCEPTION 'seed registry role.upsert sai hinh hoac thieu';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.copilot_feature_flags f
     WHERE f.scope = 'action' AND f.contract_id = 'role.upsert'
  ) THEN
    RAISE EXCEPTION 'copilot_rollout_seed_thieu_action_contract: role.upsert';
  END IF;
END
$nghiem_thu$;

COMMIT;

NOTIFY pgrst, 'reload schema';
