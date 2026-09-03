-- G5-C (5/8, dot 1) — Action L5 `invoice.xoa_mem` theo khuon direct_l5_v1.
--
-- BOC RPC GOC CO SAN: `soft_delete_invoice_v1(p_invoice_id uuid)` (SECURITY
-- DEFINER, doc production 03/09/2026 — dung `auth.uid()` truc tiep, quyen qua
-- `app_private.can_edit_invoice_building_v1(building_id)` — cung ham quyen voi
-- `approve_invoice_v1`). Wrapper goi NGUYEN VEN, khong noi rong quyen.
--
-- Dong co ke hoach da mang nhanh `direct_l5_v1` tu migration `20260903190255`.
--
-- HAI DIEU KIEN CHAN SOM (khop dung RPC goc, tranh dot nonce cho yeu cau chac
-- chan hong): (a) hoa don dang gan mot `customer_credit_applications` — RPC
-- goc doi ham khac (`soft_delete_invoice_with_credit_v1`, KHONG boc o day);
-- (b) trang thai khong phai DRAFT/APPROVED hoac da co tien da thu
-- (`paid_amount <> 0`).
--
-- READBACK — verify_kind `invoice_deleted`: doc lai `invoices` (KHONG loc
-- `deleted_at IS NULL` — hang vua bi xoa mem chinh la ket qua mong doi), doi
-- `deleted_at IS NOT NULL`.
--
-- HOAN TAC — KHONG co RPC lui rieng cho xoa mem hoa don trong baseline hien
-- tai (chi co `soft_delete_invoice_with_credit_v1` cho nhanh khac). Muon khoi
-- phuc phai sua thang `deleted_at = NULL` qua console/RPC restore neu sau nay
-- co, hoac lien he quan tri he thong — ghi ro trong `rollback_note`.
--
-- DUONG LUI CUA MIGRATION — DROP hai ham wrapper; DELETE hang registry
-- `invoice.xoa_mem` va hang co tuong ung.

BEGIN;
SET LOCAL lock_timeout = '15s';

-- ---------------------------------------------------------------------------
-- 1. XEM TRUOC
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.copilot_preview_invoice_xoa_mem_v1(
  p_organization_id uuid,
  p_payload         jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, extensions
AS $xem_truoc_invoice_xoa_mem$
DECLARE
  v_actor     uuid := auth.uid();
  v_snapshot  jsonb;
  v_inv_id    uuid;
  v_inv       public.invoices%ROWTYPE;
  v_toa       text;
  v_scope     record;
  v_co_credit boolean;
  v_nonce     bytea;
  v_canonical jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization_required' USING ERRCODE = '22023';
  END IF;

  v_snapshot := app_private.copilot_action_gate_v1('invoice.xoa_mem', p_organization_id);

  BEGIN
    v_inv_id := (p_payload ->> 'invoice_id')::uuid;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'payload_invalid' USING ERRCODE = '22023';
  END;
  IF v_inv_id IS NULL THEN
    RAISE EXCEPTION 'payload_invalid' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_inv
    FROM public.invoices
   WHERE id = v_inv_id
     AND deleted_at IS NULL
     AND organization_id = p_organization_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'entity_not_found' USING ERRCODE = 'P0002';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.customer_credit_applications a WHERE a.invoice_id = v_inv_id
  ) INTO v_co_credit;
  IF v_co_credit THEN
    RAISE EXCEPTION 'invoice_has_credit_application' USING ERRCODE = '55000';
  END IF;

  IF v_inv.status NOT IN ('DRAFT', 'APPROVED') OR COALESCE(v_inv.paid_amount, 0) <> 0 THEN
    RAISE EXCEPTION 'invoice_not_deletable' USING ERRCODE = '55000';
  END IF;

  SELECT s.org_wide, s.building_ids
    INTO v_scope
    FROM app_private.authorized_scope_v3('invoices.edit', p_organization_id) s;
  IF NOT COALESCE(v_scope.org_wide, false)
     AND (v_inv.building_id IS NULL
          OR NOT (v_inv.building_id = ANY(COALESCE(v_scope.building_ids, ARRAY[]::uuid[])))) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;

  IF v_inv.building_id IS NOT NULL THEN
    SELECT b.name INTO v_toa FROM public.buildings b WHERE b.id = v_inv.building_id;
  END IF;

  v_canonical := jsonb_build_object(
    'organization_id', p_organization_id,
    'invoice_id',      v_inv_id
  );
  v_nonce := extensions.gen_random_bytes(32);

  INSERT INTO app_private.copilot_write_confirmations
    (nonce_digest, user_id, organization_id, tool, payload_hash,
     permission_key, expires_at)
  VALUES
    (extensions.digest(v_nonce, 'sha256'), v_actor, p_organization_id,
     'invoice.xoa_mem', app_private.copilot_payload_hash_v1(v_canonical),
     'invoices.edit', clock_timestamp() + interval '5 minutes');

  RETURN jsonb_build_object(
    'confirmation_nonce', encode(v_nonce, 'hex'),
    'canonical',          v_canonical,
    'preview', jsonb_build_object(
      'toa_nha',    v_toa,
      'so_hoa_don', v_inv.invoice_number,
      'ky_hoa_don', v_inv.billing_month,
      'so_tien',    v_inv.total_amount,
      'trang_thai_hien_tai', v_inv.status,
      'hau_qua',    'Se XOA MEM hoa don — khong the khoi phuc qua Copilot, chi qua quan tri he thong'
    )
  );
END
$xem_truoc_invoice_xoa_mem$;

COMMENT ON FUNCTION public.copilot_preview_invoice_xoa_mem_v1(uuid, jsonb) IS
  'direct_l5_v1 — xem truoc xoa mem hoa don (boc soft_delete_invoice_v1). Chan som hoa don gan credit application hoac khong o trang thai xoa duoc.';

REVOKE ALL ON FUNCTION public.copilot_preview_invoice_xoa_mem_v1(uuid, jsonb)
  FROM PUBLIC;
DO $quyen_xem_truoc_invoice_xoa_mem$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_preview_invoice_xoa_mem_v1(uuid, jsonb) FROM anon;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_preview_invoice_xoa_mem_v1(uuid, jsonb) FROM service_role;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_preview_invoice_xoa_mem_v1(uuid, jsonb) FROM authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_preview_invoice_xoa_mem_v1(uuid, jsonb) TO authenticated;
  END IF;
END
$quyen_xem_truoc_invoice_xoa_mem$;

-- ---------------------------------------------------------------------------
-- 2. THUC THI
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.copilot_execute_invoice_xoa_mem_v1(
  p_confirmation_nonce text,
  p_payload            jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, extensions
AS $thuc_thi_invoice_xoa_mem$
DECLARE
  v_actor     uuid := auth.uid();
  v_hash      bytea;
  v_row       app_private.copilot_write_confirmations%ROWTYPE;
  v_snapshot  jsonb;
  v_org       uuid;
  v_inv_id    uuid;
  v_key       text;
  v_prev      public.ai_write_audit%ROWTYPE;
  v_before    jsonb;
  v_after     jsonb;
  v_inv       public.invoices%ROWTYPE;
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
  IF v_row.tool IS DISTINCT FROM 'invoice.xoa_mem'
     OR v_row.permission_key IS DISTINCT FROM 'invoices.edit' THEN
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
    v_inv_id := (p_payload ->> 'invoice_id')::uuid;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'payload_changed' USING ERRCODE = '42501';
  END;
  IF v_org IS NULL OR v_inv_id IS NULL
     OR v_org IS DISTINCT FROM v_row.organization_id THEN
    RAISE EXCEPTION 'organization_mismatch' USING ERRCODE = '42501';
  END IF;

  v_snapshot := app_private.copilot_action_gate_v1('invoice.xoa_mem', v_org);

  v_key := 'copilot_action:invoice.xoa_mem:' || v_actor::text || ':'
        || v_org::text || ':' || encode(v_hash, 'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended(v_key, 0));

  SELECT * INTO v_prev
    FROM public.ai_write_audit a
   WHERE a.idempotency_key = v_key;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'status',       'da_thuc_hien_truoc_do',
      'entity_table', 'invoices',
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

  -- Truoc khi xoa: hoa don PHAI con song va dung to chuc.
  SELECT * INTO v_inv
    FROM public.invoices
   WHERE id = v_inv_id
     AND deleted_at IS NULL
     AND organization_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'entity_not_found' USING ERRCODE = 'P0002';
  END IF;
  v_before := to_jsonb(v_inv);

  BEGIN
    PERFORM public.soft_delete_invoice_v1(v_inv_id);
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_message = MESSAGE_TEXT;
    PERFORM app_private.copilot_ledger_append_v1(jsonb_build_object(
      'event',               'action_failed',
      'organization_id',     v_org,
      'action_id',           'invoice.xoa_mem',
      'permission_key',      'invoices.edit',
      'permission_snapshot', v_snapshot,
      'consent_kind',        'click',
      'consent_id',          v_row.id,
      'payload_digest',      encode(v_hash, 'hex'),
      'before_digest',       encode(extensions.digest(
                               convert_to(v_before::text, 'UTF8'), 'sha256'), 'hex'),
      'entity_table',        'invoices',
      'entity_id',            v_inv_id,
      'error_code',           v_message,
      'sqlstate',             v_sqlstate
    ));
    RAISE;
  END;

  -- READBACK — doc lai KHONG loc deleted_at: hang vua xoa mem CHINH la ket
  -- qua mong doi.
  SELECT * INTO v_inv
    FROM public.invoices
   WHERE id = v_inv_id;
  IF NOT FOUND
     OR v_inv.organization_id IS DISTINCT FROM v_org THEN
    RAISE EXCEPTION 'copilot_write_readback_mismatch' USING ERRCODE = 'P0001';
  END IF;
  IF v_inv.deleted_at IS NULL THEN
    RAISE EXCEPTION 'copilot_draft_invariant_violation' USING ERRCODE = 'P0001';
  END IF;
  v_after := to_jsonb(v_inv);

  INSERT INTO public.ai_write_audit
    (user_id, tool, idempotency_key, entity_table, entity_id, payload, organization_id)
  VALUES
    (v_actor, 'invoice.xoa_mem', v_key, 'invoices',
     v_inv.id, p_payload, v_org)
  RETURNING id INTO v_audit_id;

  v_ledger_id := app_private.copilot_ledger_append_v1(jsonb_build_object(
    'event',               'action_executed',
    'organization_id',     v_org,
    'action_id',           'invoice.xoa_mem',
    'permission_key',      'invoices.edit',
    'permission_snapshot', v_snapshot,
    'consent_kind',        'click',
    'consent_id',          v_row.id,
    'payload_digest',      encode(v_hash, 'hex'),
    'before_digest',       encode(extensions.digest(
                             convert_to(v_before::text, 'UTF8'), 'sha256'), 'hex'),
    'after_digest',        encode(extensions.digest(
                             convert_to(v_after::text, 'UTF8'), 'sha256'), 'hex'),
    'entity_table',        'invoices',
    'entity_id',            v_inv.id,
    'audit_id',             v_audit_id,
    'outcome',              jsonb_build_object('status', 'da_thuc_hien')
  ));

  RETURN jsonb_build_object(
    'status',       'da_thuc_hien',
    'entity_table', 'invoices',
    'entity_id',    v_inv.id,
    'audit_id',     v_audit_id,
    'ledger_id',    v_ledger_id
  );
END
$thuc_thi_invoice_xoa_mem$;

COMMENT ON FUNCTION public.copilot_execute_invoice_xoa_mem_v1(text, jsonb) IS
  'direct_l5_v1 — tieu nonce, tu choi neu khong chay trong mot ke hoach, goi lai soft_delete_invoice_v1, doc lai (khong loc deleted_at) de ep deleted_at IS NOT NULL, ghi ai_write_audit + so hanh dong.';

REVOKE ALL ON FUNCTION public.copilot_execute_invoice_xoa_mem_v1(text, jsonb)
  FROM PUBLIC;
DO $quyen_thuc_thi_invoice_xoa_mem$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_execute_invoice_xoa_mem_v1(text, jsonb) FROM anon;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_execute_invoice_xoa_mem_v1(text, jsonb) FROM service_role;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_execute_invoice_xoa_mem_v1(text, jsonb) FROM authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_execute_invoice_xoa_mem_v1(text, jsonb) TO authenticated;
  END IF;
END
$quyen_thuc_thi_invoice_xoa_mem$;

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
  'invoice.xoa_mem',
  1,
  'Xoá mềm hoá đơn',
  'invoices.edit',
  'L5',
  'direct_l5_v1',
  'step_up',
  'copilot_preview_invoice_xoa_mem_v1',
  'copilot_execute_invoice_xoa_mem_v1',
  'invoice_deleted',
  'invoices',
  'invoices',
  NULL,
  'Khong co RPC lui trong baseline hien tai (soft_delete_invoice_v1 khong co doi tac unxoa). Khoi phuc phai sua thang deleted_at=NULL qua console/RPC restore neu sau nay co, hoac lien he quan tri he thong.',
  'invoice.xoa_mem',
  true,
  false
)
ON CONFLICT (action_id) DO NOTHING;

SELECT set_config('app.copilot_feature_flag_transition', 'v2', true);

INSERT INTO public.copilot_feature_flags (
  scope, contract_id, state, reason, evidence_link, rollback_reference
)
VALUES (
  'action', 'invoice.xoa_mem', 'disabled',
  'seed kill switch cho action L5 xoa mem hoa don (G5-C dot 1) — policy con L4 nen action nay khong the chay ke ca bat co',
  'migration:20260903192041_copilot_action_invoice_xoa_mem_v1',
  'migration:20260903192041_copilot_action_invoice_xoa_mem_v1'
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
    'public.copilot_preview_invoice_xoa_mem_v1(uuid, jsonb)',
    'public.copilot_execute_invoice_xoa_mem_v1(text, jsonb)'
  ]
  LOOP
    IF to_regprocedure(v_ten) IS NULL THEN
      v_thieu := v_thieu || v_ten;
    END IF;
  END LOOP;
  IF cardinality(v_thieu) > 0 THEN
    RAISE EXCEPTION 'thieu ham G5-C invoice_xoa_mem: %', array_to_string(v_thieu, ', ');
  END IF;

  IF to_regprocedure('public.soft_delete_invoice_v1(uuid)') IS NULL THEN
    RAISE EXCEPTION 'soft_delete_invoice_v1 missing — baseline phai co truoc';
  END IF;

  IF to_regrole('anon') IS NOT NULL THEN
    FOREACH v_ten IN ARRAY ARRAY[
      'public.copilot_preview_invoice_xoa_mem_v1(uuid, jsonb)',
      'public.copilot_execute_invoice_xoa_mem_v1(text, jsonb)'
    ]
    LOOP
      IF has_function_privilege('anon', to_regprocedure(v_ten)::oid, 'EXECUTE') THEN
        v_ho := v_ho || v_ten;
      END IF;
    END LOOP;
    IF cardinality(v_ho) > 0 THEN
      RAISE EXCEPTION 'anon goi duoc ham G5-C invoice_xoa_mem: %', array_to_string(v_ho, ', ');
    END IF;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM app_private.copilot_action_registry
     WHERE action_id = 'invoice.xoa_mem'
       AND risk = 'L5' AND executor_kind = 'direct_l5_v1' AND consent_required = 'step_up'
       AND permission_key = 'invoices.edit'
       AND grantable = false
       AND rollback_rpc IS NULL
       AND btrim(COALESCE(rollback_note, '')) <> ''
  ) THEN
    RAISE EXCEPTION 'seed registry invoice.xoa_mem sai hinh hoac thieu';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.copilot_feature_flags f
     WHERE f.scope = 'action' AND f.contract_id = 'invoice.xoa_mem'
  ) THEN
    RAISE EXCEPTION 'copilot_rollout_seed_thieu_action_contract: invoice.xoa_mem';
  END IF;
END
$nghiem_thu$;

COMMIT;

NOTIFY pgrst, 'reload schema';
