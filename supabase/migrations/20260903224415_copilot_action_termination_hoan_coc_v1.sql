-- G5-C3 (6/9, nhom C - tai chinh con lai) - Action L5 `termination.hoan_coc`
-- theo khuon direct_l5_v1 (xem 20260903190255 cho khuon day du + F1 helper).
--
-- BOC RPC GOC: `create_termination_refund_voucher_v1(p_obligation_id, p_account_id,
-- p_force, p_force_reason)` (SECURITY DEFINER, doc production 03/09/2026). RPC
-- goc TU idempotent tren NGHIA VU (obligation): neu hoi so da co phieu SONG (bat
-- ky phien ban nao) thi TRA VE phieu do voi 'alreadyCreated':true, khong tao
-- phieu thu hai. Neu obligation_status <> 'OK', RPC doi p_force=true VA nguoi
-- goi la chu to chuc/super admin VA p_force_reason >= 8 ky tu — wrapper CHUYEN
-- THANG p_force/p_force_reason tu payload, KHONG lam long RPC goc quyet dinh ai
-- duoc ep (chi canh bao SOM trong preview de UX ro, khong thay the).
--
-- permission_key='income_expenses.create' — DUNG khoa ma nop_ho_so
-- (20260903102931) da xac dinh cho hanh dong TAO phieu thu/chi.
--
-- READBACK — verify_kind tuy chinh `termination_refund_created` (KHONG dung lai
-- 'ie_draft' co san trong engine): nhanh 'ie_draft' cua engine doi
-- `user_id = actor`, nhung phieu hoan coc gan VOI NGHIA VU (mot tai nguyen toan
-- to chuc), khong gan voi nguoi tao — hai lan goi (hai actor khac nhau) tren
-- CUNG mot nghia vu deu hop le tra ve CUNG mot phieu qua nhanh alreadyCreated,
-- va lan thu hai co the KHONG phai chinh actor da tao phieu do. Dung nhanh
-- 'ie_draft' se lam sai lan doi soat thu hai. Bat bien THAT nam trong wrapper:
-- phieu ton tai, dung to chuc, approval_status='UNAPPROVED', posting_status=
-- 'UNPOSTED' (dung "note" cua RPC goc: "Phieu o trang thai CHO DUYET").
--
-- HOAN TAC — `cancel_income_expense_flex_v1(uuid,text,bigint,bigint)` (da kiem
-- ton tai). Chi ghi ten lam tai lieu, khong tu dong goi.
--
-- DUONG LUI CUA MIGRATION — DROP hai ham wrapper; DELETE hang registry
-- `termination.hoan_coc` va hang co tuong ung.

BEGIN;
SET LOCAL lock_timeout = '15s';

-- ---------------------------------------------------------------------------
-- 0b. HELPER DUNG CHUNG — kiem ngu canh ke hoach THAT (F1, xem 20260903190255).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_private.copilot_l5_plan_context_ok_v1(
  p_action_id text,
  p_org       uuid
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, extensions
AS $l5_plan_context_ok$
DECLARE
  v_marker  text := current_setting('app.copilot_plan_context', true);
  v_sep     int;
  v_plan_id uuid;
  v_step_no int;
  v_ok      boolean;
BEGIN
  IF v_marker IS NULL OR v_marker = '' THEN
    RETURN false;
  END IF;

  v_sep := position(':' in v_marker);
  IF v_sep = 0 THEN
    RETURN false;
  END IF;

  BEGIN
    v_plan_id := substr(v_marker, 1, v_sep - 1)::uuid;
    v_step_no := substr(v_marker, v_sep + 1)::int;
  EXCEPTION WHEN others THEN
    RETURN false;
  END;
  IF v_plan_id IS NULL OR v_step_no IS NULL THEN
    RETURN false;
  END IF;

  SELECT EXISTS (
    SELECT 1
      FROM app_private.copilot_plans p
      JOIN app_private.copilot_plan_steps s ON s.plan_id = p.id
     WHERE p.id = v_plan_id
       AND s.step_no = v_step_no
       AND p.user_id = auth.uid()
       AND p.status = 'APPROVED'
       AND s.status = 'PENDING'
       AND s.action_id = p_action_id
       AND p.organization_id = p_org
  ) INTO v_ok;

  RETURN COALESCE(v_ok, false);
END
$l5_plan_context_ok$;

COMMENT ON FUNCTION app_private.copilot_l5_plan_context_ok_v1(text, uuid) IS
  'F1 (review G5-C dot 1) — kiem THAT su co mot copilot_plans/copilot_plan_steps APPROVED/PENDING khop actor+org+action_id, khong chi kiem marker co mat. Chi goi noi bo tu cac ham copilot_execute_*_v1 cua direct_l5_v1.';

REVOKE ALL ON FUNCTION app_private.copilot_l5_plan_context_ok_v1(text, uuid)
  FROM PUBLIC;
DO $quyen_l5_plan_context_ok$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION app_private.copilot_l5_plan_context_ok_v1(text, uuid) FROM anon;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION app_private.copilot_l5_plan_context_ok_v1(text, uuid) FROM service_role;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION app_private.copilot_l5_plan_context_ok_v1(text, uuid) FROM authenticated;
  END IF;
END
$quyen_l5_plan_context_ok$;

-- ---------------------------------------------------------------------------
-- 0c. COT pin_always — idempotent them neu chua co (xem chu thich o cac
-- migration nhom C khac cua dot nay).
-- ---------------------------------------------------------------------------
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
-- 1. XEM TRUOC
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.copilot_preview_termination_hoan_coc_v1(
  p_organization_id uuid,
  p_payload         jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, extensions
AS $xem_truoc_termination_hoan_coc$
DECLARE
  v_actor        uuid := auth.uid();
  v_snapshot     jsonb;
  v_obligation   uuid;
  v_account      uuid;
  v_force        boolean;
  v_force_reason text;
  v_o            public.termination_refund_obligations%ROWTYPE;
  v_tstatus      text;
  v_c            public.contracts%ROWTYPE;
  v_bld          uuid;
  v_toa          text;
  v_scope        record;
  v_existing_ie  uuid;
  v_canh_bao     text;
  v_canonical    jsonb;
  v_nonce        bytea;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization_required' USING ERRCODE = '22023';
  END IF;

  v_snapshot := app_private.copilot_action_gate_v1('termination.hoan_coc', p_organization_id);

  BEGIN
    v_obligation   := (p_payload ->> 'obligation_id')::uuid;
    v_account      := NULLIF(p_payload ->> 'account_id', '')::uuid;
    v_force        := COALESCE((p_payload ->> 'force')::boolean, false);
    v_force_reason := NULLIF(btrim(COALESCE(p_payload ->> 'force_reason', '')), '');
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'payload_invalid' USING ERRCODE = '22023';
  END;
  IF v_obligation IS NULL THEN
    RAISE EXCEPTION 'payload_invalid' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_o
    FROM public.termination_refund_obligations
   WHERE id = v_obligation
     AND organization_id = p_organization_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'entity_not_found' USING ERRCODE = 'P0002';
  END IF;

  SELECT status INTO v_tstatus
    FROM public.contract_terminations
   WHERE id = v_o.termination_id;
  IF v_tstatus IS NULL OR v_tstatus NOT IN ('APPROVED', 'COMPLETED') THEN
    RAISE EXCEPTION 'termination_not_approved' USING ERRCODE = '55000';
  END IF;
  IF v_o.requested_amount <= 0 THEN
    RAISE EXCEPTION 'payload_invalid' USING ERRCODE = '22023';
  END IF;

  IF v_o.obligation_status <> 'OK' AND NOT v_force THEN
    RAISE EXCEPTION 'obligation_needs_force' USING ERRCODE = '55000';
  END IF;
  IF v_o.obligation_status <> 'OK' AND v_force
     AND (v_force_reason IS NULL OR length(v_force_reason) < 8) THEN
    RAISE EXCEPTION 'payload_invalid' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_c FROM public.contracts WHERE id = v_o.contract_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'entity_not_found' USING ERRCODE = 'P0002';
  END IF;
  v_bld := (SELECT r.building_id FROM public.rooms r WHERE r.id = v_c.room_id);

  SELECT s.org_wide, s.building_ids
    INTO v_scope
    FROM app_private.authorized_scope_v3('income_expenses.create', p_organization_id) s;
  IF NOT COALESCE(v_scope.org_wide, false)
     AND (v_bld IS NULL OR NOT (v_bld = ANY(COALESCE(v_scope.building_ids, ARRAY[]::uuid[])))) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;

  IF v_bld IS NOT NULL THEN
    SELECT b.name INTO v_toa FROM public.buildings b WHERE b.id = v_bld;
  END IF;

  -- Canh bao SOM neu hoi so da co phieu song (RPC goc se tra ve alreadyCreated,
  -- khong tao phieu moi) — chi de nguoi duyet ke hoach biet truoc, khong chan.
  SELECT o.voucher_id INTO v_existing_ie
    FROM public.termination_refund_obligations o
    JOIN public.income_expenses ie ON ie.id = o.voucher_id
   WHERE o.organization_id = v_o.organization_id
     AND o.termination_id  = v_o.termination_id
     AND o.voucher_id IS NOT NULL
     AND (ie.approval_status IS DISTINCT FROM 'CANCELLED' AND ie.deleted_at IS NULL)
   ORDER BY o.version DESC
   LIMIT 1;
  v_canh_bao := CASE
    WHEN v_existing_ie IS NOT NULL THEN 'Nghia vu nay da co phieu hoan — se tra ve phieu cu, khong tao phieu moi'
    WHEN v_o.obligation_status <> 'OK' THEN format('Nghia vu dang canh bao [%s] — se EP sinh phieu voi ly do da nhap', v_o.obligation_status)
    ELSE NULL
  END;

  v_canonical := jsonb_build_object(
    'organization_id', p_organization_id,
    'obligation_id',    v_obligation,
    'account_id',       v_account,
    'force',            v_force,
    'force_reason',     v_force_reason
  );
  v_nonce := extensions.gen_random_bytes(32);

  INSERT INTO app_private.copilot_write_confirmations
    (nonce_digest, user_id, organization_id, tool, payload_hash,
     permission_key, expires_at)
  VALUES
    (extensions.digest(v_nonce, 'sha256'), v_actor, p_organization_id,
     'termination.hoan_coc', app_private.copilot_payload_hash_v1(v_canonical),
     'income_expenses.create', clock_timestamp() + interval '5 minutes');

  RETURN jsonb_build_object(
    'confirmation_nonce', encode(v_nonce, 'hex'),
    'canonical',          v_canonical,
    'preview', jsonb_build_object(
      'toa_nha',              v_toa,
      'so_hop_dong',          COALESCE(v_c.contract_number, left(v_c.id::text, 8)),
      'so_tien_hoan_thu',     v_o.requested_amount,
      'trang_thai_hien_tai',  v_o.obligation_status,
      'canh_bao',             v_canh_bao,
      'hau_qua',              'Se sinh phieu chi hoan coc o trang thai CHO DUYET — tien chi ra khoi ket khi co nguoi duyet'
    )
  );
END
$xem_truoc_termination_hoan_coc$;

COMMENT ON FUNCTION public.copilot_preview_termination_hoan_coc_v1(uuid, jsonb) IS
  'direct_l5_v1 — xem truoc sinh phieu hoan coc thanh ly (boc create_termination_refund_voucher_v1). Canh bao som neu hoi so da co phieu hoac dang canh bao (obligation_status<>OK).';

REVOKE ALL ON FUNCTION public.copilot_preview_termination_hoan_coc_v1(uuid, jsonb)
  FROM PUBLIC;
DO $quyen_xem_truoc_termination_hoan_coc$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_preview_termination_hoan_coc_v1(uuid, jsonb) FROM anon;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_preview_termination_hoan_coc_v1(uuid, jsonb) FROM service_role;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_preview_termination_hoan_coc_v1(uuid, jsonb) FROM authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_preview_termination_hoan_coc_v1(uuid, jsonb) TO authenticated;
  END IF;
END
$quyen_xem_truoc_termination_hoan_coc$;

-- ---------------------------------------------------------------------------
-- 2. THUC THI
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.copilot_execute_termination_hoan_coc_v1(
  p_confirmation_nonce text,
  p_payload            jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, extensions
AS $thuc_thi_termination_hoan_coc$
DECLARE
  v_actor        uuid := auth.uid();
  v_hash         bytea;
  v_row          app_private.copilot_write_confirmations%ROWTYPE;
  v_snapshot     jsonb;
  v_org          uuid;
  v_obligation   uuid;
  v_account      uuid;
  v_force        boolean;
  v_force_reason text;
  v_key          text;
  v_prev         public.ai_write_audit%ROWTYPE;
  v_before       jsonb;
  v_after        jsonb;
  v_o            public.termination_refund_obligations%ROWTYPE;
  v_t_status     text;
  v_ket          jsonb;
  v_voucher      uuid;
  v_ie           public.income_expenses%ROWTYPE;
  v_audit_id     uuid;
  v_ledger_id    uuid;
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
  IF v_row.tool IS DISTINCT FROM 'termination.hoan_coc'
     OR v_row.permission_key IS DISTINCT FROM 'income_expenses.create' THEN
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
    v_obligation   := (p_payload ->> 'obligation_id')::uuid;
    v_account      := NULLIF(p_payload ->> 'account_id', '')::uuid;
    v_force        := COALESCE((p_payload ->> 'force')::boolean, false);
    v_force_reason := NULLIF(p_payload ->> 'force_reason', '');
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'payload_changed' USING ERRCODE = '42501';
  END;
  IF v_org IS NULL OR v_obligation IS NULL
     OR v_org IS DISTINCT FROM v_row.organization_id THEN
    RAISE EXCEPTION 'organization_mismatch' USING ERRCODE = '42501';
  END IF;

  -- F1 (review G5-C dot 1, fix round 1): guard L5 DATABASE THAT.
  IF NOT app_private.copilot_l5_plan_context_ok_v1('termination.hoan_coc', v_org) THEN
    RAISE EXCEPTION 'l5_requires_plan' USING ERRCODE = '42501';
  END IF;

  v_snapshot := app_private.copilot_action_gate_v1('termination.hoan_coc', v_org);

  v_key := 'copilot_action:termination.hoan_coc:' || v_actor::text || ':'
        || v_org::text || ':' || encode(v_hash, 'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended(v_key, 0));

  SELECT * INTO v_prev
    FROM public.ai_write_audit a
   WHERE a.idempotency_key = v_key;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'status',       'da_thuc_hien_truoc_do',
      'entity_table', 'income_expenses',
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

  SELECT * INTO v_o
    FROM public.termination_refund_obligations
   WHERE id = v_obligation
     AND organization_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'entity_not_found' USING ERRCODE = 'P0002';
  END IF;
  SELECT status INTO v_t_status
    FROM public.contract_terminations
   WHERE id = v_o.termination_id;
  v_before := jsonb_build_object(
    'obligation', to_jsonb(v_o),
    'termination_status', v_t_status
  );

  v_ket := public.create_termination_refund_voucher_v1(v_obligation, v_account, v_force, v_force_reason);
  v_voucher := NULLIF(v_ket ->> 'voucherId', '')::uuid;
  IF v_voucher IS NULL THEN
    RAISE EXCEPTION 'copilot_write_readback_mismatch' USING ERRCODE = 'P0001';
  END IF;

  -- READBACK — doc lai tu BANG, khong tin jsonb RPC goc tra ve. Khong dung
  -- nhanh 'ie_draft' cua engine (doi user_id=actor — sai voi tai nguyen dung
  -- chung nghia vu, xem chu thich dau file); tu kiem bat bien o day.
  SELECT * INTO v_ie
    FROM public.income_expenses
   WHERE id = v_voucher;
  IF NOT FOUND
     OR v_ie.organization_id IS DISTINCT FROM v_org
     OR v_ie.approval_status IS DISTINCT FROM 'UNAPPROVED'
     OR v_ie.posting_status IS DISTINCT FROM 'UNPOSTED' THEN
    RAISE EXCEPTION 'copilot_write_readback_mismatch' USING ERRCODE = 'P0001';
  END IF;
  v_after := to_jsonb(v_ie);

  INSERT INTO public.ai_write_audit
    (user_id, tool, idempotency_key, entity_table, entity_id, payload, organization_id)
  VALUES
    (v_actor, 'termination.hoan_coc', v_key, 'income_expenses',
     v_voucher, p_payload, v_org)
  RETURNING id INTO v_audit_id;

  v_ledger_id := app_private.copilot_ledger_append_v1(jsonb_build_object(
    'event',               'action_executed',
    'organization_id',     v_org,
    'action_id',           'termination.hoan_coc',
    'permission_key',      'income_expenses.create',
    'permission_snapshot', v_snapshot,
    'consent_kind',        'click',
    'consent_id',          v_row.id,
    'payload_digest',      encode(v_hash, 'hex'),
    'before_digest',       encode(extensions.digest(
                             convert_to(v_before::text, 'UTF8'), 'sha256'), 'hex'),
    'after_digest',        encode(extensions.digest(
                             convert_to(v_after::text, 'UTF8'), 'sha256'), 'hex'),
    'entity_table',        'income_expenses',
    'entity_id',            v_voucher,
    'audit_id',             v_audit_id,
    'amount',               v_ie.total_amount,
    'outcome',              jsonb_build_object('status', 'da_thuc_hien', 'already_created', COALESCE((v_ket ->> 'alreadyCreated')::boolean, false))
  ));

  RETURN jsonb_build_object(
    'status',       'da_thuc_hien',
    'entity_table', 'income_expenses',
    'entity_id',    v_voucher,
    'audit_id',     v_audit_id,
    'ledger_id',    v_ledger_id
  );
END
$thuc_thi_termination_hoan_coc$;

COMMENT ON FUNCTION public.copilot_execute_termination_hoan_coc_v1(text, jsonb) IS
  'direct_l5_v1 — tieu nonce, tu choi neu khong chay trong ke hoach, goi lai create_termination_refund_voucher_v1, doc lai ep UNAPPROVED+UNPOSTED, ghi ai_write_audit + so hanh dong (kem amount).';

REVOKE ALL ON FUNCTION public.copilot_execute_termination_hoan_coc_v1(text, jsonb)
  FROM PUBLIC;
DO $quyen_thuc_thi_termination_hoan_coc$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_execute_termination_hoan_coc_v1(text, jsonb) FROM anon;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_execute_termination_hoan_coc_v1(text, jsonb) FROM service_role;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_execute_termination_hoan_coc_v1(text, jsonb) FROM authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_execute_termination_hoan_coc_v1(text, jsonb) TO authenticated;
  END IF;
END
$quyen_thuc_thi_termination_hoan_coc$;

-- ---------------------------------------------------------------------------
-- 3. SO DANG KY + CO
-- ---------------------------------------------------------------------------
INSERT INTO app_private.copilot_action_registry (
  action_id, version, label_vi, permission_key, risk, executor_kind,
  consent_required, preview_rpc, execute_rpc, verify_kind,
  produces_entity_table, consumes_ref_table, rollback_rpc, rollback_note,
  flag_contract_id, enabled, grantable, pin_always
)
VALUES (
  'termination.hoan_coc',
  1,
  'Sinh phiếu hoàn cọc thanh lý',
  'income_expenses.create',
  'L5',
  'direct_l5_v1',
  'step_up',
  'copilot_preview_termination_hoan_coc_v1',
  'copilot_execute_termination_hoan_coc_v1',
  'termination_refund_created',
  'income_expenses',
  NULL,
  'cancel_income_expense_flex_v1',
  'Goi lai cancel_income_expense_flex_v1(uuid,text,bigint,bigint) tren giao dien Thu chi voi phieu vua sinh (entity_id cua dong so hanh dong). Khong tu dong goi.',
  'termination.hoan_coc',
  true,
  false,
  false
)
ON CONFLICT (action_id) DO NOTHING;

SELECT set_config('app.copilot_feature_flag_transition', 'v2', true);

INSERT INTO public.copilot_feature_flags (
  scope, contract_id, state, reason, evidence_link, rollback_reference
)
VALUES (
  'action', 'termination.hoan_coc', 'disabled',
  'seed kill switch cho action L5 sinh phieu hoan coc thanh ly (G5-C3 nhom C) — policy con L4 nen action nay khong the chay ke ca bat co',
  'migration:20260903224415_copilot_action_termination_hoan_coc_v1',
  'migration:20260903224415_copilot_action_termination_hoan_coc_v1'
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
    'public.copilot_preview_termination_hoan_coc_v1(uuid, jsonb)',
    'public.copilot_execute_termination_hoan_coc_v1(text, jsonb)'
  ]
  LOOP
    IF to_regprocedure(v_ten) IS NULL THEN
      v_thieu := v_thieu || v_ten;
    END IF;
  END LOOP;
  IF cardinality(v_thieu) > 0 THEN
    RAISE EXCEPTION 'thieu ham G5-C3 termination_hoan_coc: %', array_to_string(v_thieu, ', ');
  END IF;
  IF to_regprocedure('app_private.copilot_l5_plan_context_ok_v1(text, uuid)') IS NULL THEN
    RAISE EXCEPTION 'copilot_l5_plan_context_ok_v1 missing — 20260903190255 phai chay truoc';
  END IF;
  IF to_regprocedure('public.create_termination_refund_voucher_v1(uuid, uuid, boolean, text)') IS NULL THEN
    RAISE EXCEPTION 'create_termination_refund_voucher_v1 missing — baseline phai co truoc';
  END IF;
  IF to_regprocedure('public.cancel_income_expense_flex_v1(uuid, text, bigint, bigint)') IS NULL THEN
    RAISE EXCEPTION 'cancel_income_expense_flex_v1 missing — rollback_rpc phai ton tai that';
  END IF;

  IF to_regrole('anon') IS NOT NULL THEN
    FOREACH v_ten IN ARRAY ARRAY[
      'public.copilot_preview_termination_hoan_coc_v1(uuid, jsonb)',
      'public.copilot_execute_termination_hoan_coc_v1(text, jsonb)'
    ]
    LOOP
      IF has_function_privilege('anon', to_regprocedure(v_ten)::oid, 'EXECUTE') THEN
        v_ho := v_ho || v_ten;
      END IF;
    END LOOP;
    IF cardinality(v_ho) > 0 THEN
      RAISE EXCEPTION 'anon goi duoc ham G5-C3 termination_hoan_coc: %', array_to_string(v_ho, ', ');
    END IF;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM app_private.copilot_action_registry
     WHERE action_id = 'termination.hoan_coc'
       AND risk = 'L5' AND executor_kind = 'direct_l5_v1' AND consent_required = 'step_up'
       AND permission_key = 'income_expenses.create'
       AND grantable = false
       AND rollback_rpc = 'cancel_income_expense_flex_v1'
  ) THEN
    RAISE EXCEPTION 'seed registry termination.hoan_coc sai hinh hoac thieu';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.copilot_feature_flags f
     WHERE f.scope = 'action' AND f.contract_id = 'termination.hoan_coc'
  ) THEN
    RAISE EXCEPTION 'copilot_rollout_seed_thieu_action_contract: termination.hoan_coc';
  END IF;
END
$nghiem_thu$;

COMMIT;

NOTIFY pgrst, 'reload schema';
