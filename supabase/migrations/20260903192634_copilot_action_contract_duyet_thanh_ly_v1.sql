-- G5-C (7/8, dot 1) — Action L5 `contract.duyet_thanh_ly` theo khuon direct_l5_v1.
--
-- BOC RPC GOC CO SAN: `approve_contract_termination_v1(p_termination_id uuid,
-- p_note text DEFAULT NULL)` (SECURITY DEFINER, doc production 03/09/2026 —
-- dung `auth.uid()` truc tiep, quyen qua `is_super_admin() OR
-- can_do_on_building('contracts','edit', building_of_contract(contract_id))`).
-- Wrapper goi NGUYEN VEN, khong noi rong quyen.
--
-- Dong co ke hoach da mang nhanh `direct_l5_v1` tu migration `20260903190255`.
--
-- NHIEU HIEU UNG TRONG MOT LAN GOI — day la RPC nang nhat trong dot 1: chuyen
-- `contract_terminations.status` sang COMPLETED, chuyen `contracts.status`
-- sang TERMINATED, CO THE tao mot phieu thu/chi NHAP (UNAPPROVED, `refund_
-- amount <> 0`), va tra phong ve AVAILABLE. Wrapper KHONG chep lai logic do —
-- goi nguyen ham va chi doc lai bang chung THUC THE CHINH
-- (`contract_terminations`) lam readback.
--
-- READBACK — `verify_kind='readback'` trong registry. Ben trong wrapper cua
-- CHINH minh van tu kiem `status = 'COMPLETED'`.
--
-- HOAN TAC — KHONG co. Mot lan goi tao ra BA hieu ung (hop dong, phieu, phong)
-- khong co RPC nghich dao atomic nao trong baseline. Muon dao phai xu tay tung
-- hieu ung: huy phieu thu/chi qua `cancel_income_expense_flex_v1` neu co tao
-- phieu, doi lai trang thai phong, va KHONG co duong dua hop dong ve khac
-- TERMINATED qua RPC — ghi ro trong `rollback_note`.
--
-- DUONG LUI CUA MIGRATION — DROP hai ham wrapper; DELETE hang registry
-- `contract.duyet_thanh_ly` va hang co tuong ung.

BEGIN;
SET LOCAL lock_timeout = '15s';

-- ---------------------------------------------------------------------------
-- 1. XEM TRUOC
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.copilot_preview_contract_duyet_thanh_ly_v1(
  p_organization_id uuid,
  p_payload         jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, extensions
AS $xem_truoc_contract_duyet_thanh_ly$
DECLARE
  v_actor      uuid := auth.uid();
  v_snapshot   jsonb;
  v_term_id    uuid;
  v_note       text;
  v_term       public.contract_terminations%ROWTYPE;
  v_contract   public.contracts%ROWTYPE;
  v_building   uuid;
  v_toa        text;
  v_phong      text;
  v_scope      record;
  v_nonce      bytea;
  v_canonical  jsonb;
  v_canh_bao   text := NULL;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization_required' USING ERRCODE = '22023';
  END IF;

  v_snapshot := app_private.copilot_action_gate_v1('contract.duyet_thanh_ly', p_organization_id);

  BEGIN
    v_term_id := (p_payload ->> 'termination_id')::uuid;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'payload_invalid' USING ERRCODE = '22023';
  END;
  IF v_term_id IS NULL THEN
    RAISE EXCEPTION 'payload_invalid' USING ERRCODE = '22023';
  END IF;
  v_note := NULLIF(btrim(COALESCE(p_payload ->> 'note', '')), '');
  IF v_note IS NOT NULL AND length(v_note) > 2000 THEN
    RAISE EXCEPTION 'payload_invalid' USING ERRCODE = '22023';
  END IF;

  -- Fail-closed theo TO CHUC: yeu cau thanh ly cua cong ty khac tra ve DUNG
  -- cau nhu khong ton tai. `contract_terminations` khong co cot deleted_at.
  SELECT * INTO v_term
    FROM public.contract_terminations
   WHERE id = v_term_id
     AND organization_id = p_organization_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'entity_not_found' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_contract
    FROM public.contracts
   WHERE id = v_term.contract_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'entity_not_found' USING ERRCODE = 'P0002';
  END IF;

  v_building := public.building_of_contract(v_contract.id);
  SELECT s.org_wide, s.building_ids
    INTO v_scope
    FROM app_private.authorized_scope_v3('contracts.edit', p_organization_id) s;
  IF NOT COALESCE(v_scope.org_wide, false)
     AND (v_building IS NULL
          OR NOT (v_building = ANY(COALESCE(v_scope.building_ids, ARRAY[]::uuid[])))) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;

  IF v_building IS NOT NULL THEN
    SELECT b.name INTO v_toa FROM public.buildings b WHERE b.id = v_building;
  END IF;
  IF v_contract.room_id IS NOT NULL THEN
    SELECT COALESCE(r.code, r.name) INTO v_phong FROM public.rooms r WHERE r.id = v_contract.room_id;
  END IF;

  IF v_term.status = 'COMPLETED' THEN
    v_canh_bao := 'Yeu cau thanh ly DA hoan tat tu truoc — thao tac nay se khong doi gi (idempotent).';
  END IF;

  v_canonical := jsonb_build_object(
    'organization_id', p_organization_id,
    'termination_id',  v_term_id,
    'note',            v_note
  );
  v_nonce := extensions.gen_random_bytes(32);

  INSERT INTO app_private.copilot_write_confirmations
    (nonce_digest, user_id, organization_id, tool, payload_hash,
     permission_key, expires_at)
  VALUES
    (extensions.digest(v_nonce, 'sha256'), v_actor, p_organization_id,
     'contract.duyet_thanh_ly', app_private.copilot_payload_hash_v1(v_canonical),
     'contracts.edit', clock_timestamp() + interval '5 minutes');

  RETURN jsonb_build_object(
    'confirmation_nonce', encode(v_nonce, 'hex'),
    'canonical',          v_canonical,
    'preview', jsonb_build_object(
      'toa_nha',             v_toa,
      'phong',               v_phong,
      'so_hop_dong',         v_contract.contract_number,
      'so_tien_hoan_thu',    v_term.refund_amount,
      'trang_thai_hien_tai', v_term.status,
      'hau_qua',             'Se duyet thanh ly — hop dong chuyen TERMINATED, co the tao mot phieu thu/chi NHAP neu so_tien_hoan_thu khac 0, va tra phong ve AVAILABLE',
      'canh_bao',            v_canh_bao
    )
  );
END
$xem_truoc_contract_duyet_thanh_ly$;

COMMENT ON FUNCTION public.copilot_preview_contract_duyet_thanh_ly_v1(uuid, jsonb) IS
  'direct_l5_v1 — xem truoc duyet thanh ly hop dong (boc approve_contract_termination_v1). Canh bao hanh dong co nhieu hieu ung (hop dong + phieu + phong).';

REVOKE ALL ON FUNCTION public.copilot_preview_contract_duyet_thanh_ly_v1(uuid, jsonb)
  FROM PUBLIC;
DO $quyen_xem_truoc_contract_duyet_thanh_ly$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_preview_contract_duyet_thanh_ly_v1(uuid, jsonb) FROM anon;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_preview_contract_duyet_thanh_ly_v1(uuid, jsonb) FROM service_role;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_preview_contract_duyet_thanh_ly_v1(uuid, jsonb) FROM authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_preview_contract_duyet_thanh_ly_v1(uuid, jsonb) TO authenticated;
  END IF;
END
$quyen_xem_truoc_contract_duyet_thanh_ly$;

-- ---------------------------------------------------------------------------
-- 2. THUC THI
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.copilot_execute_contract_duyet_thanh_ly_v1(
  p_confirmation_nonce text,
  p_payload            jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, extensions
AS $thuc_thi_contract_duyet_thanh_ly$
DECLARE
  v_actor     uuid := auth.uid();
  v_hash      bytea;
  v_row       app_private.copilot_write_confirmations%ROWTYPE;
  v_snapshot  jsonb;
  v_org       uuid;
  v_term_id   uuid;
  v_note      text;
  v_key       text;
  v_prev      public.ai_write_audit%ROWTYPE;
  v_before    jsonb;
  v_after     jsonb;
  v_term      public.contract_terminations%ROWTYPE;
  v_ket       jsonb;
  v_audit_id  uuid;
  v_ledger_id uuid;
  v_sqlstate  text;
  v_message   text;
BEGIN
  IF current_setting('app.copilot_plan_context', true) IS NULL
     OR current_setting('app.copilot_plan_context', true) = '' THEN
    RAISE EXCEPTION 'l5_requires_plan' USING ERRCODE = '42501';
  END IF;

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
  IF v_row.tool IS DISTINCT FROM 'contract.duyet_thanh_ly'
     OR v_row.permission_key IS DISTINCT FROM 'contracts.edit' THEN
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
    v_term_id := (p_payload ->> 'termination_id')::uuid;
    v_note    := NULLIF(p_payload ->> 'note', '');
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'payload_changed' USING ERRCODE = '42501';
  END;
  IF v_org IS NULL OR v_term_id IS NULL
     OR v_org IS DISTINCT FROM v_row.organization_id THEN
    RAISE EXCEPTION 'organization_mismatch' USING ERRCODE = '42501';
  END IF;

  v_snapshot := app_private.copilot_action_gate_v1('contract.duyet_thanh_ly', v_org);

  v_key := 'copilot_action:contract.duyet_thanh_ly:' || v_actor::text || ':'
        || v_org::text || ':' || encode(v_hash, 'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended(v_key, 0));

  SELECT * INTO v_prev
    FROM public.ai_write_audit a
   WHERE a.idempotency_key = v_key;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'status',       'da_thuc_hien_truoc_do',
      'entity_table', 'contract_terminations',
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

  SELECT * INTO v_term
    FROM public.contract_terminations
   WHERE id = v_term_id
     AND organization_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'entity_not_found' USING ERRCODE = 'P0002';
  END IF;
  v_before := to_jsonb(v_term);

  BEGIN
    v_ket := public.approve_contract_termination_v1(v_term_id, v_note);
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_message = MESSAGE_TEXT;
    PERFORM app_private.copilot_ledger_append_v1(jsonb_build_object(
      'event',               'action_failed',
      'organization_id',     v_org,
      'action_id',           'contract.duyet_thanh_ly',
      'permission_key',      'contracts.edit',
      'permission_snapshot', v_snapshot,
      'consent_kind',        'click',
      'consent_id',          v_row.id,
      'payload_digest',      encode(v_hash, 'hex'),
      'before_digest',       encode(extensions.digest(
                               convert_to(v_before::text, 'UTF8'), 'sha256'), 'hex'),
      'entity_table',        'contract_terminations',
      'entity_id',            v_term_id,
      'error_code',           v_message,
      'sqlstate',             v_sqlstate
    ));
    RAISE;
  END;

  -- READBACK — doc lai THUC THE CHINH (contract_terminations). Cac hieu ung
  -- phu (hop dong, phieu, phong) khong duoc so lai o day — do la viec cua
  -- RPC goc, khong phai viec cua wrapper.
  SELECT * INTO v_term
    FROM public.contract_terminations
   WHERE id = v_term_id;
  IF NOT FOUND
     OR v_term.organization_id IS DISTINCT FROM v_org THEN
    RAISE EXCEPTION 'copilot_write_readback_mismatch' USING ERRCODE = 'P0001';
  END IF;
  IF v_term.status IS DISTINCT FROM 'COMPLETED' THEN
    RAISE EXCEPTION 'copilot_draft_invariant_violation' USING ERRCODE = 'P0001';
  END IF;
  v_after := to_jsonb(v_term);

  INSERT INTO public.ai_write_audit
    (user_id, tool, idempotency_key, entity_table, entity_id, payload, organization_id)
  VALUES
    (v_actor, 'contract.duyet_thanh_ly', v_key, 'contract_terminations',
     v_term.id, p_payload, v_org)
  RETURNING id INTO v_audit_id;

  v_ledger_id := app_private.copilot_ledger_append_v1(jsonb_build_object(
    'event',               'action_executed',
    'organization_id',     v_org,
    'action_id',           'contract.duyet_thanh_ly',
    'permission_key',      'contracts.edit',
    'permission_snapshot', v_snapshot,
    'consent_kind',        'click',
    'consent_id',          v_row.id,
    'payload_digest',      encode(v_hash, 'hex'),
    'before_digest',       encode(extensions.digest(
                             convert_to(v_before::text, 'UTF8'), 'sha256'), 'hex'),
    'after_digest',        encode(extensions.digest(
                             convert_to(v_after::text, 'UTF8'), 'sha256'), 'hex'),
    'entity_table',        'contract_terminations',
    'entity_id',            v_term.id,
    'audit_id',             v_audit_id,
    'outcome',              jsonb_build_object(
                               'status',     'da_thuc_hien',
                               'voucher_id', v_ket ->> 'voucher_id',
                               'room_id',    v_ket ->> 'room_id')
  ));

  RETURN jsonb_build_object(
    'status',       'da_thuc_hien',
    'entity_table', 'contract_terminations',
    'entity_id',    v_term.id,
    'audit_id',     v_audit_id,
    'ledger_id',    v_ledger_id
  );
END
$thuc_thi_contract_duyet_thanh_ly$;

COMMENT ON FUNCTION public.copilot_execute_contract_duyet_thanh_ly_v1(text, jsonb) IS
  'direct_l5_v1 — tieu nonce, tu choi neu khong chay trong mot ke hoach, goi lai approve_contract_termination_v1, doc lai de ep status=COMPLETED, ghi ai_write_audit + so hanh dong (kem voucher_id/room_id trong outcome neu co).';

REVOKE ALL ON FUNCTION public.copilot_execute_contract_duyet_thanh_ly_v1(text, jsonb)
  FROM PUBLIC;
DO $quyen_thuc_thi_contract_duyet_thanh_ly$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_execute_contract_duyet_thanh_ly_v1(text, jsonb) FROM anon;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_execute_contract_duyet_thanh_ly_v1(text, jsonb) FROM service_role;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_execute_contract_duyet_thanh_ly_v1(text, jsonb) FROM authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_execute_contract_duyet_thanh_ly_v1(text, jsonb) TO authenticated;
  END IF;
END
$quyen_thuc_thi_contract_duyet_thanh_ly$;

-- ---------------------------------------------------------------------------
-- 3. SO DANG KY + CONG TAC
-- ---------------------------------------------------------------------------
INSERT INTO app_private.copilot_action_registry (
  action_id, version, label_vi, permission_key, risk, executor_kind,
  consent_required, preview_rpc, execute_rpc, verify_kind,
  produces_entity_table, consumes_ref_table, rollback_rpc, rollback_note,
  flag_contract_id, enabled, grantable
)
VALUES (
  'contract.duyet_thanh_ly',
  1,
  'Duyệt thanh lý hợp đồng',
  'contracts.edit',
  'L5',
  'direct_l5_v1',
  'step_up',
  'copilot_preview_contract_duyet_thanh_ly_v1',
  'copilot_execute_contract_duyet_thanh_ly_v1',
  'readback',
  'contract_terminations',
  'contracts',
  NULL,
  'Khong co RPC lui atomic — mot lan duyet tao toi ba hieu ung (hop dong TERMINATED, phieu thu/chi NHAP neu co, phong AVAILABLE). Muon dao phai xu tay tung hieu ung: huy phieu qua cancel_income_expense_flex_v1 neu co tao phieu, doi lai trang thai phong qua giao dien, va KHONG co duong dua hop dong ve khac TERMINATED qua RPC.',
  'contract.duyet_thanh_ly',
  true,
  false
)
ON CONFLICT (action_id) DO NOTHING;

SELECT set_config('app.copilot_feature_flag_transition', 'v2', true);

INSERT INTO public.copilot_feature_flags (
  scope, contract_id, state, reason, evidence_link, rollback_reference
)
VALUES (
  'action', 'contract.duyet_thanh_ly', 'disabled',
  'seed kill switch cho action L5 duyet thanh ly hop dong (G5-C dot 1) — policy con L4 nen action nay khong the chay ke ca bat co',
  'migration:20260903192634_copilot_action_contract_duyet_thanh_ly_v1',
  'migration:20260903192634_copilot_action_contract_duyet_thanh_ly_v1'
)
ON CONFLICT (scope, contract_id) DO NOTHING;

SELECT set_config('app.copilot_feature_flag_transition', '', true);

-- ---------------------------------------------------------------------------
-- NGHIEM THU — chi soi catalog, chay duoc tren database rong.
-- ---------------------------------------------------------------------------
DO $nghiem_thu$
DECLARE
  v_ten   text;
  v_thieu text[] := '{}'::text[];
  v_ho    text[] := '{}'::text[];
BEGIN
  FOREACH v_ten IN ARRAY ARRAY[
    'public.copilot_preview_contract_duyet_thanh_ly_v1(uuid, jsonb)',
    'public.copilot_execute_contract_duyet_thanh_ly_v1(text, jsonb)'
  ]
  LOOP
    IF to_regprocedure(v_ten) IS NULL THEN
      v_thieu := v_thieu || v_ten;
    END IF;
  END LOOP;
  IF cardinality(v_thieu) > 0 THEN
    RAISE EXCEPTION 'thieu ham G5-C contract_duyet_thanh_ly: %', array_to_string(v_thieu, ', ');
  END IF;

  IF to_regprocedure('public.approve_contract_termination_v1(uuid, text)') IS NULL THEN
    RAISE EXCEPTION 'approve_contract_termination_v1 missing — baseline phai co truoc';
  END IF;
  IF to_regprocedure('public.building_of_contract(uuid)') IS NULL THEN
    RAISE EXCEPTION 'building_of_contract missing — baseline phai co truoc';
  END IF;

  IF to_regrole('anon') IS NOT NULL THEN
    FOREACH v_ten IN ARRAY ARRAY[
      'public.copilot_preview_contract_duyet_thanh_ly_v1(uuid, jsonb)',
      'public.copilot_execute_contract_duyet_thanh_ly_v1(text, jsonb)'
    ]
    LOOP
      IF has_function_privilege('anon', to_regprocedure(v_ten)::oid, 'EXECUTE') THEN
        v_ho := v_ho || v_ten;
      END IF;
    END LOOP;
    IF cardinality(v_ho) > 0 THEN
      RAISE EXCEPTION 'anon goi duoc ham G5-C contract_duyet_thanh_ly: %', array_to_string(v_ho, ', ');
    END IF;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM app_private.copilot_action_registry
     WHERE action_id = 'contract.duyet_thanh_ly'
       AND risk = 'L5' AND executor_kind = 'direct_l5_v1' AND consent_required = 'step_up'
       AND permission_key = 'contracts.edit'
       AND grantable = false
       AND rollback_rpc IS NULL
       AND btrim(COALESCE(rollback_note, '')) <> ''
  ) THEN
    RAISE EXCEPTION 'seed registry contract.duyet_thanh_ly sai hinh hoac thieu';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.copilot_feature_flags f
     WHERE f.scope = 'action' AND f.contract_id = 'contract.duyet_thanh_ly'
  ) THEN
    RAISE EXCEPTION 'copilot_rollout_seed_thieu_action_contract: contract.duyet_thanh_ly';
  END IF;
END
$nghiem_thu$;

COMMIT;

NOTIFY pgrst, 'reload schema';
