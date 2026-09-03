-- G5-C (2/8, dot 1) — Action L5 `income_expense.duyet_vao_so` theo khuon direct_l5_v1.
--
-- BOC RPC GOC CO SAN: `approve_and_post_income_expense_v2(input jsonb)` (SECURITY
-- DEFINER, doc production 03/09/2026). Khac voi `approve_income_expense_v1`, ham
-- nay TU giai actor qua `app_private.resolve_finance_actor_v2(org)` — ham do lai
-- dung `app_private.current_uid_v1()` (= phien hien tai), khong nhan tham so
-- impersonate nao — nen goi nguyen ven KHONG noi rong quyen, van cung mot phien.
-- Ham goc TU CO lop chong lap rieng (`finance_v2_begin_canonical_op`, khoa theo
-- `(org, 'income_expense.approve_and_post.v2', subjectId, idempotencyKey)`) —
-- wrapper KHONG chep lai luat do, chi dan mot `idempotencyKey` dan xuat tu CUNG
-- `payload_hash` cua lop ngoai (cung khuon voi `reservation_deposit.create`).
--
-- PAYLOAD VUOT TOI THIEU CO CHU DINH — hai truong `{organization_id,
-- income_expense_id}` KHONG du cho RPC goc (con doi `cashbookId`, `postedOn`).
-- Canonical vi vay mang them `cashbook_id`, `posted_on`, va HAI PHIEN BAN LAC
-- QUAN (`expected_approval_version`, `expected_posting_version`) CHUP TAI THOI
-- DIEM XEM TRUOC — day la dung y, khong phai lo hong: neu phieu doi giua luc
-- xem truoc va luc chay, RPC goc se tu choi voi "version mismatch" (55000) —
-- an toan hon la doc lai phien ban MOI o buoc thuc thi (vo hieu hoa chinh muc
-- dich cua optimistic concurrency). Canonical con mang `amount` (so tien hien
-- tai cua phieu) de dong so o CAP KE HOACH (`copilot_plan_execute_step_v1`,
-- doc `v_step.canonical ->> 'amount'`) bat duoc so tien — dung yeu cau brief.
--
-- READBACK — verify_kind `ie_posted`: doc lai `income_expenses`, doi
-- `posting_status = 'POSTED'` VA `approval_status = 'APPROVED'` VA co it nhat
-- mot dong `income_expense_posting_lines` cho `active_posting_id_v2`.
--
-- HOAN TAC — `reverse_posted_income_expense_v2(p_voucher, p_cashbook, p_posted_on,
-- p_reason, p_idempotency_key)` (da kiem chu ky ton tai). Chi ghi ten lam tai
-- lieu, khong tu dong goi.
--
-- DUONG LUI CUA MIGRATION — DROP hai ham wrapper; DELETE hang registry
-- `income_expense.duyet_vao_so` va hang co tuong ung.

BEGIN;
SET LOCAL lock_timeout = '15s';

-- ---------------------------------------------------------------------------
-- 1. XEM TRUOC
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.copilot_preview_ie_duyet_vao_so_v1(
  p_organization_id uuid,
  p_payload         jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, extensions
AS $xem_truoc_ie_duyet_vao_so$
DECLARE
  v_actor      uuid := auth.uid();
  v_snapshot   jsonb;
  v_ie_id      uuid;
  v_cashbook   uuid;
  v_posted_on  date;
  v_ie         public.income_expenses%ROWTYPE;
  v_acc        public.accounts%ROWTYPE;
  v_toa        text;
  v_scope      record;
  v_nonce      bytea;
  v_canonical  jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization_required' USING ERRCODE = '22023';
  END IF;

  v_snapshot := app_private.copilot_action_gate_v1('income_expense.duyet_vao_so', p_organization_id);

  BEGIN
    v_ie_id     := (p_payload ->> 'income_expense_id')::uuid;
    v_cashbook  := (p_payload ->> 'cashbook_id')::uuid;
    v_posted_on := (p_payload ->> 'posted_on')::date;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'payload_invalid' USING ERRCODE = '22023';
  END;
  IF v_ie_id IS NULL OR v_cashbook IS NULL OR v_posted_on IS NULL THEN
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

  -- Chan som dung tien de RPC goc doi: chua UNAPPROVED+UNPOSTED+CASHBOOK thi
  -- chac chan se bi tu choi — dung nonce cho mot yeu cau da biet truoc se hong.
  IF v_ie.approval_status IS DISTINCT FROM 'UNAPPROVED'
     OR COALESCE(v_ie.review_state, '') NOT IN ('PENDING', 'CHANGES_REQUESTED')
     OR v_ie.posting_status IS DISTINCT FROM 'UNPOSTED'
     OR v_ie.posting_mode IS DISTINCT FROM 'CASHBOOK' THEN
    RAISE EXCEPTION 'voucher_not_approvable' USING ERRCODE = '55000';
  END IF;

  SELECT * INTO v_acc
    FROM public.accounts
   WHERE id = v_cashbook
     AND deleted_at IS NULL
     AND organization_id = p_organization_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'entity_not_found' USING ERRCODE = 'P0002';
  END IF;

  SELECT s.org_wide, s.building_ids
    INTO v_scope
    FROM app_private.authorized_scope_v3('income_expenses.approve', p_organization_id) s;
  IF NOT COALESCE(v_scope.org_wide, false)
     AND (v_ie.building_id IS NULL
          OR NOT (v_ie.building_id = ANY(COALESCE(v_scope.building_ids, ARRAY[]::uuid[])))) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;

  IF v_ie.building_id IS NOT NULL THEN
    SELECT b.name INTO v_toa FROM public.buildings b WHERE b.id = v_ie.building_id;
  END IF;

  v_canonical := jsonb_build_object(
    'organization_id',           p_organization_id,
    'income_expense_id',         v_ie_id,
    'cashbook_id',                v_cashbook,
    'posted_on',                  v_posted_on,
    'expected_approval_version',  v_ie.approval_version,
    'expected_posting_version',   v_ie.posting_version,
    'amount',                     v_ie.total_amount
  );
  v_nonce := extensions.gen_random_bytes(32);

  INSERT INTO app_private.copilot_write_confirmations
    (nonce_digest, user_id, organization_id, tool, payload_hash,
     permission_key, expires_at)
  VALUES
    (extensions.digest(v_nonce, 'sha256'), v_actor, p_organization_id,
     'income_expense.duyet_vao_so', app_private.copilot_payload_hash_v1(v_canonical),
     'income_expenses.approve', clock_timestamp() + interval '5 minutes');

  RETURN jsonb_build_object(
    'confirmation_nonce', encode(v_nonce, 'hex'),
    'canonical',          v_canonical,
    'preview', jsonb_build_object(
      'toa_nha',    v_toa,
      'loai_phieu', v_ie.type,
      'ten_phieu',  v_ie.name,
      'so_tien',    v_ie.total_amount,
      'so_quy',     v_acc.name,
      'ngay_vao_so', v_posted_on,
      'hau_qua',    'Se duyet VA vao so — approval_status chuyen APPROVED, posting_status chuyen POSTED'
    )
  );
END
$xem_truoc_ie_duyet_vao_so$;

COMMENT ON FUNCTION public.copilot_preview_ie_duyet_vao_so_v1(uuid, jsonb) IS
  'direct_l5_v1 — xem truoc duyet-va-vao-so phieu thu/chi (boc approve_and_post_income_expense_v2). Chan som phieu chua o trang thai UNAPPROVED+UNPOSTED+CASHBOOK.';

REVOKE ALL ON FUNCTION public.copilot_preview_ie_duyet_vao_so_v1(uuid, jsonb)
  FROM PUBLIC;
DO $quyen_xem_truoc_ie_duyet_vao_so$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_preview_ie_duyet_vao_so_v1(uuid, jsonb) FROM anon;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_preview_ie_duyet_vao_so_v1(uuid, jsonb) FROM service_role;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_preview_ie_duyet_vao_so_v1(uuid, jsonb) FROM authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_preview_ie_duyet_vao_so_v1(uuid, jsonb) TO authenticated;
  END IF;
END
$quyen_xem_truoc_ie_duyet_vao_so$;

-- ---------------------------------------------------------------------------
-- 2. THUC THI
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.copilot_execute_ie_duyet_vao_so_v1(
  p_confirmation_nonce text,
  p_payload            jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, extensions
AS $thuc_thi_ie_duyet_vao_so$
DECLARE
  v_actor      uuid := auth.uid();
  v_hash       bytea;
  v_row        app_private.copilot_write_confirmations%ROWTYPE;
  v_snapshot   jsonb;
  v_org        uuid;
  v_ie_id      uuid;
  v_cashbook   uuid;
  v_posted_on  date;
  v_exp_appr   bigint;
  v_exp_post   bigint;
  v_amount     numeric;
  v_key        text;
  v_key_goc    text;
  v_prev       public.ai_write_audit%ROWTYPE;
  v_before     jsonb;
  v_after      jsonb;
  v_ie         public.income_expenses%ROWTYPE;
  v_input      jsonb;
  v_ket        jsonb;
  v_co_dong    boolean;
  v_audit_id   uuid;
  v_ledger_id  uuid;
  v_sqlstate   text;
  v_message    text;
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
  IF v_row.tool IS DISTINCT FROM 'income_expense.duyet_vao_so'
     OR v_row.permission_key IS DISTINCT FROM 'income_expenses.approve' THEN
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
    v_org       := (p_payload ->> 'organization_id')::uuid;
    v_ie_id     := (p_payload ->> 'income_expense_id')::uuid;
    v_cashbook  := (p_payload ->> 'cashbook_id')::uuid;
    v_posted_on := (p_payload ->> 'posted_on')::date;
    v_exp_appr  := (p_payload ->> 'expected_approval_version')::bigint;
    v_exp_post  := (p_payload ->> 'expected_posting_version')::bigint;
    v_amount    := NULLIF(p_payload ->> 'amount', '')::numeric;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'payload_changed' USING ERRCODE = '42501';
  END;
  IF v_org IS NULL OR v_ie_id IS NULL OR v_cashbook IS NULL OR v_posted_on IS NULL
     OR v_exp_appr IS NULL OR v_exp_post IS NULL
     OR v_org IS DISTINCT FROM v_row.organization_id THEN
    RAISE EXCEPTION 'organization_mismatch' USING ERRCODE = '42501';
  END IF;

  v_snapshot := app_private.copilot_action_gate_v1('income_expense.duyet_vao_so', v_org);

  v_key := 'copilot_action:income_expense.duyet_vao_so:' || v_actor::text || ':'
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

  SELECT * INTO v_ie
    FROM public.income_expenses
   WHERE id = v_ie_id
     AND deleted_at IS NULL
     AND organization_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'entity_not_found' USING ERRCODE = 'P0002';
  END IF;
  v_before := to_jsonb(v_ie);

  -- Khoa cho lop CWO cua RPC goc, dan xuat tu CUNG payload_hash cua lop ngoai.
  v_key_goc := 'copilot_action_' || substr(encode(v_hash, 'hex'), 1, 40);
  v_input := jsonb_build_object(
    'subjectId',               v_ie_id,
    'subjectKind',              'VOUCHER',
    'cashbookId',                v_cashbook,
    'postedOn',                  v_posted_on::text,
    'idempotencyKey',            v_key_goc,
    'expectedApprovalVersion',   v_exp_appr,
    'expectedPostingVersion',    v_exp_post
  );

  BEGIN
    v_ket := public.approve_and_post_income_expense_v2(v_input);
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_message = MESSAGE_TEXT;
    PERFORM app_private.copilot_ledger_append_v1(jsonb_build_object(
      'event',               'action_failed',
      'organization_id',     v_org,
      'action_id',           'income_expense.duyet_vao_so',
      'permission_key',      'income_expenses.approve',
      'permission_snapshot', v_snapshot,
      'consent_kind',        'click',
      'consent_id',          v_row.id,
      'payload_digest',      encode(v_hash, 'hex'),
      'before_digest',       encode(extensions.digest(
                               convert_to(v_before::text, 'UTF8'), 'sha256'), 'hex'),
      'entity_table',        'income_expenses',
      'entity_id',           v_ie_id,
      'amount',               v_amount,
      'error_code',          v_message,
      'sqlstate',            v_sqlstate
    ));
    RAISE;
  END;

  -- READBACK — doc lai tu BANG, khong tin jsonb ma RPC goc tra ve.
  SELECT * INTO v_ie
    FROM public.income_expenses
   WHERE id = v_ie_id;
  IF NOT FOUND
     OR v_ie.organization_id IS DISTINCT FROM v_org THEN
    RAISE EXCEPTION 'copilot_write_readback_mismatch' USING ERRCODE = 'P0001';
  END IF;
  IF v_ie.approval_status IS DISTINCT FROM 'APPROVED'
     OR v_ie.posting_status IS DISTINCT FROM 'POSTED'
     OR v_ie.active_posting_id_v2 IS NULL THEN
    RAISE EXCEPTION 'copilot_draft_invariant_violation' USING ERRCODE = 'P0001';
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM public.income_expense_posting_lines l
     WHERE l.posting_id = v_ie.active_posting_id_v2
  ) INTO v_co_dong;
  IF NOT v_co_dong THEN
    RAISE EXCEPTION 'copilot_draft_invariant_violation' USING ERRCODE = 'P0001';
  END IF;
  v_after := to_jsonb(v_ie);

  INSERT INTO public.ai_write_audit
    (user_id, tool, idempotency_key, entity_table, entity_id, payload, organization_id)
  VALUES
    (v_actor, 'income_expense.duyet_vao_so', v_key, 'income_expenses',
     v_ie.id, p_payload, v_org)
  RETURNING id INTO v_audit_id;

  v_ledger_id := app_private.copilot_ledger_append_v1(jsonb_build_object(
    'event',               'action_executed',
    'organization_id',     v_org,
    'action_id',           'income_expense.duyet_vao_so',
    'permission_key',      'income_expenses.approve',
    'permission_snapshot', v_snapshot,
    'consent_kind',        'click',
    'consent_id',          v_row.id,
    'payload_digest',      encode(v_hash, 'hex'),
    'before_digest',       encode(extensions.digest(
                             convert_to(v_before::text, 'UTF8'), 'sha256'), 'hex'),
    'after_digest',        encode(extensions.digest(
                             convert_to(v_after::text, 'UTF8'), 'sha256'), 'hex'),
    'entity_table',        'income_expenses',
    'entity_id',            v_ie.id,
    'audit_id',             v_audit_id,
    'amount',               v_ie.total_amount,
    'outcome',              jsonb_build_object('status', 'da_thuc_hien')
  ));

  RETURN jsonb_build_object(
    'status',       'da_thuc_hien',
    'entity_table', 'income_expenses',
    'entity_id',    v_ie.id,
    'audit_id',     v_audit_id,
    'ledger_id',    v_ledger_id
  );
END
$thuc_thi_ie_duyet_vao_so$;

COMMENT ON FUNCTION public.copilot_execute_ie_duyet_vao_so_v1(text, jsonb) IS
  'direct_l5_v1 — tieu nonce, tu choi neu khong chay trong mot ke hoach, goi lai approve_and_post_income_expense_v2 voi khoa CWO dan xuat tu payload_hash, doc lai de ep APPROVED+POSTED+co dong bui toan, ghi ai_write_audit + so hanh dong (kem amount).';

REVOKE ALL ON FUNCTION public.copilot_execute_ie_duyet_vao_so_v1(text, jsonb)
  FROM PUBLIC;
DO $quyen_thuc_thi_ie_duyet_vao_so$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_execute_ie_duyet_vao_so_v1(text, jsonb) FROM anon;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_execute_ie_duyet_vao_so_v1(text, jsonb) FROM service_role;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_execute_ie_duyet_vao_so_v1(text, jsonb) FROM authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_execute_ie_duyet_vao_so_v1(text, jsonb) TO authenticated;
  END IF;
END
$quyen_thuc_thi_ie_duyet_vao_so$;

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
  'income_expense.duyet_vao_so',
  1,
  'Duyệt và vào sổ phiếu thu/chi',
  'income_expenses.approve',
  'L5',
  'direct_l5_v1',
  'step_up',
  'copilot_preview_ie_duyet_vao_so_v1',
  'copilot_execute_ie_duyet_vao_so_v1',
  'ie_posted',
  'income_expenses',
  'income_expenses',
  'reverse_posted_income_expense_v2',
  'Dao but toan qua reverse_posted_income_expense_v2(p_voucher, p_cashbook, p_posted_on, p_reason, p_idempotency_key) tren giao dien Thu chi. Khong tu dong goi.',
  'income_expense.duyet_vao_so',
  true,
  false
)
ON CONFLICT (action_id) DO NOTHING;

SELECT set_config('app.copilot_feature_flag_transition', 'v2', true);

INSERT INTO public.copilot_feature_flags (
  scope, contract_id, state, reason, evidence_link, rollback_reference
)
VALUES (
  'action', 'income_expense.duyet_vao_so', 'disabled',
  'seed kill switch cho action L5 duyet-va-vao-so phieu thu/chi (G5-C dot 1) — policy con L4 nen action nay khong the chay ke ca bat co',
  'migration:20260903190840_copilot_action_ie_duyet_vao_so_v1',
  'migration:20260903190840_copilot_action_ie_duyet_vao_so_v1'
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
    'public.copilot_preview_ie_duyet_vao_so_v1(uuid, jsonb)',
    'public.copilot_execute_ie_duyet_vao_so_v1(text, jsonb)'
  ]
  LOOP
    IF to_regprocedure(v_ten) IS NULL THEN
      v_thieu := v_thieu || v_ten;
    END IF;
  END LOOP;
  IF cardinality(v_thieu) > 0 THEN
    RAISE EXCEPTION 'thieu ham G5-C ie_duyet_vao_so: %', array_to_string(v_thieu, ', ');
  END IF;

  IF to_regprocedure('public.approve_and_post_income_expense_v2(jsonb)') IS NULL THEN
    RAISE EXCEPTION 'approve_and_post_income_expense_v2 missing — baseline phai co truoc';
  END IF;
  IF to_regprocedure('public.reverse_posted_income_expense_v2(uuid, uuid, date, text, text)') IS NULL THEN
    RAISE EXCEPTION 'reverse_posted_income_expense_v2 missing — rollback_rpc phai ton tai that';
  END IF;
  -- LUU Y: KHONG kiem tra o day rang dong co ke hoach (copilot_plan_execute_step_v1)
  -- da mang nhanh direct_l5_v1 — check nay chi dung tren PRODUCTION DA APPLY that
  -- su migration 20260903190255 (dot dau tien lam viec do). Cong cu do idempotent
  -- chay tung file RIENG bang du lieu production HIEN TAI (khong cong don cac file
  -- dry-run chua apply trong cung phien), nen mot kiem tra nhu vay se do vo o day
  -- du dung thu tu file dam bao no da chay that khi APPLY THAT trong tuong lai.

  IF to_regrole('anon') IS NOT NULL THEN
    FOREACH v_ten IN ARRAY ARRAY[
      'public.copilot_preview_ie_duyet_vao_so_v1(uuid, jsonb)',
      'public.copilot_execute_ie_duyet_vao_so_v1(text, jsonb)'
    ]
    LOOP
      IF has_function_privilege('anon', to_regprocedure(v_ten)::oid, 'EXECUTE') THEN
        v_ho := v_ho || v_ten;
      END IF;
    END LOOP;
    IF cardinality(v_ho) > 0 THEN
      RAISE EXCEPTION 'anon goi duoc ham G5-C ie_duyet_vao_so: %', array_to_string(v_ho, ', ');
    END IF;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM app_private.copilot_action_registry
     WHERE action_id = 'income_expense.duyet_vao_so'
       AND risk = 'L5' AND executor_kind = 'direct_l5_v1' AND consent_required = 'step_up'
       AND permission_key = 'income_expenses.approve'
       AND grantable = false
       AND rollback_rpc = 'reverse_posted_income_expense_v2'
  ) THEN
    RAISE EXCEPTION 'seed registry income_expense.duyet_vao_so sai hinh hoac thieu';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.copilot_feature_flags f
     WHERE f.scope = 'action' AND f.contract_id = 'income_expense.duyet_vao_so'
  ) THEN
    RAISE EXCEPTION 'copilot_rollout_seed_thieu_action_contract: income_expense.duyet_vao_so';
  END IF;
END
$nghiem_thu$;

COMMIT;

NOTIFY pgrst, 'reload schema';
