-- G5-C2 (4/7, nhom A - phan quyen) - Action L5 `member.set_status` theo khuon
-- direct_l5_v1 (xem 20260903190255 cho khuon day du, 20260903212600 cho cot
-- pin_always).
--
-- BOC RPC GOC: `set_membership_status_v1(p_user_id uuid, p_status text,
-- p_reason text)` (SECURITY DEFINER, doc production 03/09/2026 - KHONG dung
-- `require_perm_v1`/`authorized_scope_v3`: quyen la is_super_admin() HOAC actor
-- giu role_binding "Chủ sở hữu tổ chức" con hieu luc tren TO CHUC CUA MUC TIEU
-- (org duoc RPC tu suy tu membership cua p_user_id, khong nhan tham so org).
--
-- LECH BRIEF CO CHU DICH - permission_key. RPC goc khong doc permission_key
-- nao ca (giong `soft_delete_customer` cua G5-C dot 1). Wrapper van dat
-- permission_key='users.edit' lam bo loc SOM o copilot_action_gate_v1 - MOT
-- DIEU KIEN THEM, CHAT HON RPC goc (an toan, khong noi rong): mot actor
-- khong co scope users.edit nao trong to chuc bi chan o cong truoc ca khi
-- cham RPC goc, ke ca khi ho la chu so huu that.
--
-- RANG BUOC TO CHUC - RPC goc TU SUY org tu quan he actor/target, khong nhan
-- p_organization_id. Preview + execute deu tu FAIL-CLOSED xac nhan target da
-- la thanh vien CUA DUNG to chuc dang gan voi ke hoach (p_organization_id),
-- va execute doi chieu lai organization_id RPC tra ve phai khop.
--
-- MUC 0 - dam bao pin_always da co (idempotent).
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
-- MUC 1 - XEM TRUOC member.set_status
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.copilot_preview_member_trang_thai_v1(
  p_organization_id uuid,
  p_payload         jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, extensions
AS $xem_truoc_member_trang_thai$
DECLARE
  v_actor      uuid := auth.uid();
  v_snapshot   jsonb;
  v_user_id    uuid;
  v_status     text;
  v_reason     text;
  v_membership public.organization_memberships%ROWTYPE;
  v_email      text;
  v_canonical  jsonb;
  v_nonce      bytea;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization_required' USING ERRCODE = '22023';
  END IF;

  v_snapshot := app_private.copilot_action_gate_v1('member.set_status', p_organization_id);

  BEGIN
    v_user_id := (p_payload ->> 'user_id')::uuid;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'payload_invalid' USING ERRCODE = '22023';
  END;
  v_status := upper(btrim(COALESCE(p_payload ->> 'status', '')));
  v_reason := NULLIF(btrim(COALESCE(p_payload ->> 'reason', '')), '');

  IF v_user_id IS NULL OR v_status NOT IN ('ACTIVE','SUSPENDED','REVOKED') THEN
    RAISE EXCEPTION 'payload_invalid' USING ERRCODE = '22023';
  END IF;
  IF v_user_id = v_actor THEN
    RAISE EXCEPTION 'cannot_edit_self' USING ERRCODE = '42501';
  END IF;

  -- Fail-closed theo TO CHUC: RPC goc tu suy org, wrapper thi doi target phai
  -- da la thanh vien CUA DUNG to chuc dang gan voi ke hoach nay.
  SELECT * INTO v_membership
    FROM public.organization_memberships m
   WHERE m.user_id = v_user_id AND m.organization_id = p_organization_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'entity_not_found' USING ERRCODE = 'P0002';
  END IF;
  SELECT email INTO v_email FROM auth.users WHERE id = v_user_id;

  v_canonical := jsonb_build_object(
    'organization_id', p_organization_id,
    'user_id',          v_user_id,
    'status',           v_status,
    'reason',           v_reason
  );
  v_nonce := extensions.gen_random_bytes(32);

  INSERT INTO app_private.copilot_write_confirmations
    (nonce_digest, user_id, organization_id, tool, payload_hash,
     permission_key, expires_at)
  VALUES
    (extensions.digest(v_nonce, 'sha256'), v_actor, p_organization_id,
     'member.set_status', app_private.copilot_payload_hash_v1(v_canonical),
     'users.edit', clock_timestamp() + interval '5 minutes');

  RETURN jsonb_build_object(
    'confirmation_nonce', encode(v_nonce, 'hex'),
    'canonical',          v_canonical,
    'preview', jsonb_build_object(
      'so_dien_thoai',       v_email,
      'trang_thai_hien_tai', v_membership.status,
      'hau_qua',             format('Se doi trang thai thanh vien thanh %s', v_status),
      'canh_bao',             CASE WHEN v_status = 'REVOKED'
                                    THEN 'Thu hoi se go het staff_assignments cua nguoi nay'
                                    ELSE NULL END
    )
  );
END
$xem_truoc_member_trang_thai$;

COMMENT ON FUNCTION public.copilot_preview_member_trang_thai_v1(uuid, jsonb) IS
  'direct_l5_v1 - xem truoc doi trang thai thanh vien (boc set_membership_status_v1). Nhom A - grantable=false + pin_always=true.';

REVOKE ALL ON FUNCTION public.copilot_preview_member_trang_thai_v1(uuid, jsonb)
  FROM PUBLIC;
DO $quyen_xem_truoc_member_trang_thai$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_preview_member_trang_thai_v1(uuid, jsonb) FROM anon;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_preview_member_trang_thai_v1(uuid, jsonb) FROM service_role;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_preview_member_trang_thai_v1(uuid, jsonb) FROM authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_preview_member_trang_thai_v1(uuid, jsonb) TO authenticated;
  END IF;
END
$quyen_xem_truoc_member_trang_thai$;

-- ---------------------------------------------------------------------------
-- MUC 2 - THUC THI member.set_status
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.copilot_execute_member_trang_thai_v1(
  p_confirmation_nonce text,
  p_payload            jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, extensions
AS $thuc_thi_member_trang_thai$
DECLARE
  v_actor      uuid := auth.uid();
  v_hash       bytea;
  v_row        app_private.copilot_write_confirmations%ROWTYPE;
  v_snapshot   jsonb;
  v_org        uuid;
  v_user_id    uuid;
  v_status     text;
  v_reason     text;
  v_key        text;
  v_prev       public.ai_write_audit%ROWTYPE;
  v_before     jsonb;
  v_membership_id uuid;
  v_result     jsonb;
  v_after      jsonb;
  v_audit_id   uuid;
  v_ledger_id  uuid;
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
  IF v_row.tool IS DISTINCT FROM 'member.set_status'
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
    v_org     := (p_payload ->> 'organization_id')::uuid;
    v_user_id := (p_payload ->> 'user_id')::uuid;
    v_status  := p_payload ->> 'status';
    v_reason  := p_payload ->> 'reason';
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'payload_changed' USING ERRCODE = '42501';
  END;
  IF v_org IS NULL OR v_user_id IS NULL
     OR v_org IS DISTINCT FROM v_row.organization_id THEN
    RAISE EXCEPTION 'organization_mismatch' USING ERRCODE = '42501';
  END IF;

  IF NOT app_private.copilot_l5_plan_context_ok_v1('member.set_status', v_org) THEN
    RAISE EXCEPTION 'l5_requires_plan' USING ERRCODE = '42501';
  END IF;

  v_snapshot := app_private.copilot_action_gate_v1('member.set_status', v_org);

  v_key := 'copilot_action:member.set_status:' || v_actor::text || ':'
        || v_org::text || ':' || encode(v_hash, 'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended(v_key, 0));

  SELECT * INTO v_prev
    FROM public.ai_write_audit a
   WHERE a.idempotency_key = v_key;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'status',       'da_thuc_hien_truoc_do',
      'entity_table', 'organization_memberships',
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

  -- BEFORE - phai da la thanh vien CUA DUNG to chuc gan voi ke hoach.
  SELECT to_jsonb(m), m.id INTO v_before, v_membership_id
    FROM public.organization_memberships m
   WHERE m.user_id = v_user_id AND m.organization_id = v_org;
  IF v_before IS NULL THEN
    RAISE EXCEPTION 'entity_not_found' USING ERRCODE = 'P0002';
  END IF;

  v_result := public.set_membership_status_v1(v_user_id, v_status, v_reason);
  -- Doi chieu ORG RPC tra ve phai khop y het org da chot o buoc xem truoc lai
  -- - RPC tu suy org tu quan he actor/target nen day la hang rao chong "actor
  -- la chu so huu O TO CHUC KHAC, target lai khop mot to chuc thu ba".
  IF NULLIF(v_result ->> 'organization_id', '')::uuid IS DISTINCT FROM v_org THEN
    RAISE EXCEPTION 'copilot_write_readback_mismatch' USING ERRCODE = 'P0001';
  END IF;

  SELECT to_jsonb(m) INTO v_after
    FROM public.organization_memberships m
   WHERE m.id = v_membership_id;
  IF v_after IS NULL
     OR NULLIF(v_after ->> 'organization_id', '')::uuid IS DISTINCT FROM v_org
     OR v_after ->> 'status' IS DISTINCT FROM v_status THEN
    RAISE EXCEPTION 'copilot_write_readback_mismatch' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.ai_write_audit
    (user_id, tool, idempotency_key, entity_table, entity_id, payload, organization_id)
  VALUES
    (v_actor, 'member.set_status', v_key, 'organization_memberships',
     v_membership_id, p_payload, v_org)
  RETURNING id INTO v_audit_id;

  v_ledger_id := app_private.copilot_ledger_append_v1(jsonb_build_object(
    'event',               'action_executed',
    'organization_id',     v_org,
    'action_id',           'member.set_status',
    'permission_key',      'users.edit',
    'permission_snapshot', v_snapshot,
    'consent_kind',        'click',
    'consent_id',          v_row.id,
    'payload_digest',      encode(v_hash, 'hex'),
    'before_digest',       encode(extensions.digest(
                             convert_to(v_before::text, 'UTF8'), 'sha256'), 'hex'),
    'after_digest',        encode(extensions.digest(
                             convert_to(v_after::text, 'UTF8'), 'sha256'), 'hex'),
    'entity_table',        'organization_memberships',
    'entity_id',            v_membership_id,
    'audit_id',             v_audit_id,
    'outcome',              jsonb_build_object('status', 'da_thuc_hien', 'result', v_result)
  ));

  RETURN jsonb_build_object(
    'status',       'da_thuc_hien',
    'entity_table', 'organization_memberships',
    'entity_id',    v_membership_id,
    'audit_id',     v_audit_id,
    'ledger_id',    v_ledger_id
  );
END
$thuc_thi_member_trang_thai$;

COMMENT ON FUNCTION public.copilot_execute_member_trang_thai_v1(text, jsonb) IS
  'direct_l5_v1 - tieu nonce, tu choi neu khong chay trong ke hoach (l5_requires_plan), goi lai set_membership_status_v1, doi chieu organization_id RPC tra ve, doc lai ep status moi, ghi ai_write_audit + so hanh dong.';

REVOKE ALL ON FUNCTION public.copilot_execute_member_trang_thai_v1(text, jsonb)
  FROM PUBLIC;
DO $quyen_thuc_thi_member_trang_thai$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_execute_member_trang_thai_v1(text, jsonb) FROM anon;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_execute_member_trang_thai_v1(text, jsonb) FROM service_role;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_execute_member_trang_thai_v1(text, jsonb) FROM authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_execute_member_trang_thai_v1(text, jsonb) TO authenticated;
  END IF;
END
$quyen_thuc_thi_member_trang_thai$;

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
  'member.set_status',
  1,
  'Đổi trạng thái thành viên',
  'users.edit',
  'L5',
  'direct_l5_v1',
  'step_up',
  'copilot_preview_member_trang_thai_v1',
  'copilot_execute_member_trang_thai_v1',
  'readback',
  'organization_memberships',
  NULL,
  'set_membership_status_v1',
  'Goi lai set_membership_status_v1 voi status CU doc tu before_digest cua dong so hanh dong. Khong tu dong goi.',
  'member.set_status',
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
  'action', 'member.set_status', 'disabled',
  'seed kill switch cho action L5 doi trang thai thanh vien (G5-C2 nhom A) - policy con L4 nen action nay khong the chay ke ca bat co',
  'migration:20260903212607_copilot_action_member_trang_thai_v1',
  'migration:20260903212607_copilot_action_member_trang_thai_v1'
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
    'public.copilot_preview_member_trang_thai_v1(uuid, jsonb)',
    'public.copilot_execute_member_trang_thai_v1(text, jsonb)'
  ]
  LOOP
    IF to_regprocedure(v_ten) IS NULL THEN
      v_thieu := v_thieu || v_ten;
    END IF;
  END LOOP;
  IF cardinality(v_thieu) > 0 THEN
    RAISE EXCEPTION 'thieu ham G5-C2 member_trang_thai: %', array_to_string(v_thieu, ', ');
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
  IF to_regprocedure('public.set_membership_status_v1(uuid, text, text)') IS NULL THEN
    RAISE EXCEPTION 'set_membership_status_v1 missing - baseline phai co truoc';
  END IF;

  IF to_regrole('anon') IS NOT NULL THEN
    FOREACH v_ten IN ARRAY ARRAY[
      'public.copilot_preview_member_trang_thai_v1(uuid, jsonb)',
      'public.copilot_execute_member_trang_thai_v1(text, jsonb)'
    ]
    LOOP
      IF has_function_privilege('anon', to_regprocedure(v_ten)::oid, 'EXECUTE') THEN
        v_ho := v_ho || v_ten;
      END IF;
    END LOOP;
    IF cardinality(v_ho) > 0 THEN
      RAISE EXCEPTION 'anon goi duoc ham G5-C2 member_trang_thai: %', array_to_string(v_ho, ', ');
    END IF;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM app_private.copilot_action_registry
     WHERE action_id = 'member.set_status'
       AND risk = 'L5' AND executor_kind = 'direct_l5_v1' AND consent_required = 'step_up'
       AND permission_key = 'users.edit'
       AND grantable = false
       AND pin_always = true
       AND rollback_rpc = 'set_membership_status_v1'
  ) THEN
    RAISE EXCEPTION 'seed registry member.set_status sai hinh hoac thieu';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.copilot_feature_flags f
     WHERE f.scope = 'action' AND f.contract_id = 'member.set_status'
  ) THEN
    RAISE EXCEPTION 'copilot_rollout_seed_thieu_action_contract: member.set_status';
  END IF;
END
$nghiem_thu$;

COMMIT;

NOTIFY pgrst, 'reload schema';
