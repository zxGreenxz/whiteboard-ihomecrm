-- G5-C3 (7/9, nhom C - tai chinh con lai) - Action L5 `cashbook.chot_so` theo
-- khuon direct_l5_v1 (xem 20260903190255 cho khuon day du + F1 helper).
--
-- BOC RPC GOC: `confirm_cashbook_closing_v1(p_request, p_counted_balance)`
-- (SECURITY DEFINER, doc production 03/09/2026). Gac quyen THAT:
-- `is_super_admin() OR authorize_tenant_action_v3(actor, org,
-- 'cashbooks.close_confirm', NULL, cashbook_id).allowed` — permission_key=
-- 'cashbooks.close_confirm'. Nguoi de nghi KHONG tu xac nhan duoc; chi nguoi
-- duoc chi dinh (confirmer_user_id) hoac super admin moi ky duoc — RPC goc tu
-- kiem dieu nay, wrapper KHONG lam long.
--
-- CHENH LECH SCHEMA — DIEM PHUC TAP DUY NHAT CUA DOT NAY: entity THAT su
-- (bien ban chot so) nam o `app_private.cashbook_closures`, nhung READBACK
-- CHUNG cua engine (`copilot_plan_execute_step_v1`, nhanh direct_l5_v1) hard-
-- code `SELECT to_jsonb(t) FROM public.%I t WHERE t.id = $1` — CHI doc duoc
-- bang trong schema `public`. Chon entity THAY THE trong `public`:
-- `public.accounts` (chinh so quy), entity_id = cashbook_id — dong nay CO
-- THAT bi RPC goc doi (`lock_date` tien len `closed_through`), nen readback
-- chung cua engine (ton tai + dung to chuc) van co y nghia that, chi khong
-- phai la BIEN BAN. Bat bien THAT (bien ban co ton tai, dung so, dung trang
-- thai CONFIRMED) duoc wrapper tu kiem RIENG truoc khi tra ve, khong dua vao
-- engine.
--
-- READBACK — verify_kind tuy chinh `cashbook_closed` (ELSE cua CASE engine,
-- khong bat bien them O TANG DO — dung nhu 'external_effect'/'readback').
--
-- HOAN TAC — KHONG tim thay `reopen_cashbook_closing_v1` tren production (kiem
-- to_regprocedure, 03/09/2026) — NULL + rollback_note.
--
-- DUONG LUI CUA MIGRATION — DROP hai ham wrapper; DELETE hang registry
-- `cashbook.chot_so` va hang co tuong ung.

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
CREATE OR REPLACE FUNCTION public.copilot_preview_cashbook_chot_so_v1(
  p_organization_id uuid,
  p_payload         jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, extensions
AS $xem_truoc_cashbook_chot_so$
DECLARE
  v_actor         uuid := auth.uid();
  v_snapshot      jsonb;
  v_request_id    uuid;
  v_counted       numeric;
  v_r             app_private.cashbook_closure_requests%ROWTYPE;
  v_acc           public.accounts%ROWTYPE;
  v_scope         record;
  v_so_du_he_thong numeric;
  v_chenh_lech     numeric;
  v_canonical     jsonb;
  v_nonce         bytea;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization_required' USING ERRCODE = '22023';
  END IF;

  v_snapshot := app_private.copilot_action_gate_v1('cashbook.chot_so', p_organization_id);

  BEGIN
    v_request_id := (p_payload ->> 'request_id')::uuid;
    v_counted     := (p_payload ->> 'counted_balance')::numeric;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'payload_invalid' USING ERRCODE = '22023';
  END;
  IF v_request_id IS NULL OR v_counted IS NULL THEN
    RAISE EXCEPTION 'payload_invalid' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_r
    FROM app_private.cashbook_closure_requests
   WHERE id = v_request_id
     AND organization_id = p_organization_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'entity_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_r.status <> 'PENDING' THEN
    RAISE EXCEPTION 'cashbook_request_not_pending' USING ERRCODE = '55000';
  END IF;
  IF v_actor = v_r.proposed_by THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;
  IF v_actor <> v_r.confirmer_user_id AND NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;
  IF round(v_counted, 2) <> v_r.counted_balance THEN
    RAISE EXCEPTION 'counted_balance_mismatch' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_acc
    FROM public.accounts
   WHERE id = v_r.cashbook_id
     AND organization_id = p_organization_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'entity_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- F5 (review, LOW): kiem SO QUY NAY co trong pham vi that (cashbook_ids
  -- hoac toa mac dinh cua no trong building_ids) — khong chi kiem "co pham vi
  -- gi do" chung chung nhu truoc, cung tinh than voi invoice.duyet_hang_loat
  -- (20260903224410) doi voi hoa don.
  SELECT s.org_wide, s.building_ids, s.cashbook_ids
    INTO v_scope
    FROM app_private.authorized_scope_v3('cashbooks.close_confirm', p_organization_id) s;
  IF NOT COALESCE(v_scope.org_wide, false)
     AND NOT (v_r.cashbook_id = ANY(COALESCE(v_scope.cashbook_ids, ARRAY[]::uuid[])))
     AND (v_acc.quick_default_building_id IS NULL
          OR NOT (v_acc.quick_default_building_id = ANY(COALESCE(v_scope.building_ids, ARRAY[]::uuid[])))) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;

  -- F4 (review, MED): chenh lech server-side — the truoc do KHONG hien tien
  -- trong khi RPC goc co the tu dong lap MOT phieu thu/chi APPROVED cho phan
  -- chenh lech (dem duoc vs so sach). Nguoi duyet phai thay con so nay TRUOC
  -- khi bam duyet.
  v_so_du_he_thong := v_r.system_balance;
  v_chenh_lech     := round(v_counted - v_r.system_balance, 2);

  v_canonical := jsonb_build_object(
    'organization_id',  p_organization_id,
    'request_id',        v_request_id,
    'counted_balance',    v_counted,
    'expected_cashbook_id', v_r.cashbook_id
  );
  v_nonce := extensions.gen_random_bytes(32);

  INSERT INTO app_private.copilot_write_confirmations
    (nonce_digest, user_id, organization_id, tool, payload_hash,
     permission_key, expires_at)
  VALUES
    (extensions.digest(v_nonce, 'sha256'), v_actor, p_organization_id,
     'cashbook.chot_so', app_private.copilot_payload_hash_v1(v_canonical),
     'cashbooks.close_confirm', clock_timestamp() + interval '5 minutes');

  RETURN jsonb_build_object(
    'confirmation_nonce', encode(v_nonce, 'hex'),
    'canonical',          v_canonical,
    'preview', jsonb_build_object(
      'so_quy',          v_acc.name,
      'so_tien',         v_counted,
      'so_du_he_thong',  v_so_du_he_thong,
      'chenh_lech',      v_chenh_lech,
      'ngay_vao_so',     v_r.closed_through,
      'hau_qua',  format(
        'Se xac nhan ban giao quy tinh den %s, khoa so quy toi ngay do.%s',
        v_r.closed_through,
        CASE WHEN v_chenh_lech <> 0
             THEN format(' Se tu dong lap MOT phieu %s da DUYET (APPROVED) so tien %s d cho phan chenh lech dem-duoc-vs-so-sach.',
                          CASE WHEN v_chenh_lech > 0 THEN 'THU (thua quy)' ELSE 'CHI (thieu quy)' END,
                          abs(v_chenh_lech))
             ELSE ' Dem khop so sach, khong lap phieu chenh lech nao.' END
      )
    )
  );
END
$xem_truoc_cashbook_chot_so$;

COMMENT ON FUNCTION public.copilot_preview_cashbook_chot_so_v1(uuid, jsonb) IS
  'direct_l5_v1 — xem truoc xac nhan chot so & ban giao quy (boc confirm_cashbook_closing_v1). Chan som nguoi de nghi tu xac nhan hoac sai nguoi duoc chi dinh, va so dem lech so nguoi giao khai.';

REVOKE ALL ON FUNCTION public.copilot_preview_cashbook_chot_so_v1(uuid, jsonb)
  FROM PUBLIC;
DO $quyen_xem_truoc_cashbook_chot_so$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_preview_cashbook_chot_so_v1(uuid, jsonb) FROM anon;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_preview_cashbook_chot_so_v1(uuid, jsonb) FROM service_role;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_preview_cashbook_chot_so_v1(uuid, jsonb) FROM authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_preview_cashbook_chot_so_v1(uuid, jsonb) TO authenticated;
  END IF;
END
$quyen_xem_truoc_cashbook_chot_so$;

-- ---------------------------------------------------------------------------
-- 2. THUC THI
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.copilot_execute_cashbook_chot_so_v1(
  p_confirmation_nonce text,
  p_payload            jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, extensions
AS $thuc_thi_cashbook_chot_so$
DECLARE
  v_actor         uuid := auth.uid();
  v_hash          bytea;
  v_row           app_private.copilot_write_confirmations%ROWTYPE;
  v_snapshot      jsonb;
  v_org           uuid;
  v_request_id    uuid;
  v_counted       numeric;
  v_exp_cashbook  uuid;
  v_key           text;
  v_prev          public.ai_write_audit%ROWTYPE;
  v_before        jsonb;
  v_after         jsonb;
  v_r             app_private.cashbook_closure_requests%ROWTYPE;
  v_ket           jsonb;
  v_closure_id    bigint;
  v_cashbook_id   uuid;
  v_closed_through date;
  v_acc           public.accounts%ROWTYPE;
  v_req_status    text;
  v_closure_ok    boolean;
  -- F4 (review, MED) - doc soat phieu chenh lech RPC goc tu lap (neu co).
  v_diff_voucher  uuid;
  v_diff_amount   numeric;
  v_diff_ok       boolean;
  v_audit_id      uuid;
  v_ledger_id     uuid;
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
  IF v_row.tool IS DISTINCT FROM 'cashbook.chot_so'
     OR v_row.permission_key IS DISTINCT FROM 'cashbooks.close_confirm' THEN
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
    v_request_id   := (p_payload ->> 'request_id')::uuid;
    v_counted      := (p_payload ->> 'counted_balance')::numeric;
    v_exp_cashbook := NULLIF(p_payload ->> 'expected_cashbook_id', '')::uuid;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'payload_changed' USING ERRCODE = '42501';
  END;
  IF v_org IS NULL OR v_request_id IS NULL OR v_counted IS NULL
     OR v_org IS DISTINCT FROM v_row.organization_id THEN
    RAISE EXCEPTION 'organization_mismatch' USING ERRCODE = '42501';
  END IF;

  -- F1 (review G5-C dot 1, fix round 1): guard L5 DATABASE THAT.
  IF NOT app_private.copilot_l5_plan_context_ok_v1('cashbook.chot_so', v_org) THEN
    RAISE EXCEPTION 'l5_requires_plan' USING ERRCODE = '42501';
  END IF;

  v_snapshot := app_private.copilot_action_gate_v1('cashbook.chot_so', v_org);

  v_key := 'copilot_action:cashbook.chot_so:' || v_actor::text || ':'
        || v_org::text || ':' || encode(v_hash, 'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended(v_key, 0));

  SELECT * INTO v_prev
    FROM public.ai_write_audit a
   WHERE a.idempotency_key = v_key;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'status',       'da_thuc_hien_truoc_do',
      'entity_table', 'accounts',
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

  SELECT * INTO v_r
    FROM app_private.cashbook_closure_requests
   WHERE id = v_request_id
     AND organization_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'entity_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_exp_cashbook IS NOT NULL AND v_r.cashbook_id IS DISTINCT FROM v_exp_cashbook THEN
    RAISE EXCEPTION 'entity_changed_since_preview' USING ERRCODE = '55000';
  END IF;

  SELECT * INTO v_acc
    FROM public.accounts
   WHERE id = v_r.cashbook_id
     AND organization_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'entity_not_found' USING ERRCODE = 'P0002';
  END IF;
  v_before := jsonb_build_object('request', to_jsonb(v_r), 'account', to_jsonb(v_acc));

  v_ket := public.confirm_cashbook_closing_v1(v_request_id, v_counted);
  v_closure_id     := NULLIF(v_ket ->> 'closure_id', '')::bigint;
  v_cashbook_id    := NULLIF(v_ket ->> 'cashbook_id', '')::uuid;
  v_closed_through := NULLIF(v_ket ->> 'closed_through', '')::date;
  v_diff_voucher   := NULLIF(v_ket ->> 'difference_voucher_id', '')::uuid;
  v_diff_amount    := COALESCE(NULLIF(v_ket ->> 'difference', '')::numeric, 0);
  IF v_closure_id IS NULL OR v_cashbook_id IS DISTINCT FROM v_r.cashbook_id THEN
    RAISE EXCEPTION 'copilot_write_readback_mismatch' USING ERRCODE = 'P0001';
  END IF;

  -- READBACK — doc lai TU BANG ca hai phia: yeu cau chuyen CONFIRMED, VA bien
  -- ban chot so (app_private.cashbook_closures — ngoai tam voi cua engine, tu
  -- kiem o day) that su ton tai dung so.
  SELECT status INTO v_req_status
    FROM app_private.cashbook_closure_requests
   WHERE id = v_request_id;
  IF v_req_status IS DISTINCT FROM 'CONFIRMED' THEN
    RAISE EXCEPTION 'copilot_write_readback_mismatch' USING ERRCODE = 'P0001';
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM app_private.cashbook_closures c
     WHERE c.id = v_closure_id
       AND c.organization_id = v_org
       AND c.cashbook_id = v_r.cashbook_id
       AND c.counted_balance = v_counted
  ) INTO v_closure_ok;
  IF NOT v_closure_ok THEN
    RAISE EXCEPTION 'copilot_write_readback_mismatch' USING ERRCODE = 'P0001';
  END IF;

  -- F4 (review, MED): chenh lech khac 0 THI PHAI co phieu chenh lech that su
  -- ton tai, dung to chuc, da APPROVED, dung so tien |chenh lech| — khong tin
  -- suong "difference_voucher_id" ma RPC goc tra ve.
  IF v_diff_amount <> 0 THEN
    IF v_diff_voucher IS NULL THEN
      RAISE EXCEPTION 'copilot_write_readback_mismatch' USING ERRCODE = 'P0001';
    END IF;
    SELECT EXISTS (
      SELECT 1 FROM public.income_expenses ie
       WHERE ie.id = v_diff_voucher
         AND ie.organization_id = v_org
         AND ie.approval_status = 'APPROVED'
         AND ie.total_amount = abs(v_diff_amount)
    ) INTO v_diff_ok;
    IF NOT v_diff_ok THEN
      RAISE EXCEPTION 'copilot_write_readback_mismatch' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- entity_table cho ENGINE phai la public.<bang> — dung accounts (so quy),
  -- entity_id = cashbook_id (xem chu thich dau file ve chenh lech schema).
  SELECT * INTO v_acc
    FROM public.accounts
   WHERE id = v_r.cashbook_id;
  IF NOT FOUND
     OR v_acc.organization_id IS DISTINCT FROM v_org
     OR v_acc.lock_date IS NULL
     OR v_acc.lock_date < v_closed_through THEN
    RAISE EXCEPTION 'copilot_write_readback_mismatch' USING ERRCODE = 'P0001';
  END IF;
  v_after := to_jsonb(v_acc);

  INSERT INTO public.ai_write_audit
    (user_id, tool, idempotency_key, entity_table, entity_id, payload, organization_id)
  VALUES
    (v_actor, 'cashbook.chot_so', v_key, 'accounts',
     v_r.cashbook_id, p_payload, v_org)
  RETURNING id INTO v_audit_id;

  v_ledger_id := app_private.copilot_ledger_append_v1(jsonb_build_object(
    'event',               'action_executed',
    'organization_id',     v_org,
    'action_id',           'cashbook.chot_so',
    'permission_key',      'cashbooks.close_confirm',
    'permission_snapshot', v_snapshot,
    'consent_kind',        'click',
    'consent_id',          v_row.id,
    'payload_digest',      encode(v_hash, 'hex'),
    'before_digest',       encode(extensions.digest(
                             convert_to(v_before::text, 'UTF8'), 'sha256'), 'hex'),
    'after_digest',        encode(extensions.digest(
                             convert_to(v_after::text, 'UTF8'), 'sha256'), 'hex'),
    'entity_table',        'accounts',
    'entity_id',            v_r.cashbook_id,
    'audit_id',             v_audit_id,
    -- F4 (review, MED): amount = |chenh lech| (tien THAT phat sinh boi phieu
    -- chenh lech), khong phai so du da dem (khong phai mot khoan tien moi).
    'amount',               abs(v_diff_amount),
    'outcome',              jsonb_build_object('status', 'da_thuc_hien', 'closure_id', v_closure_id, 'difference', v_diff_amount, 'difference_voucher_id', v_diff_voucher)
  ));

  RETURN jsonb_build_object(
    'status',       'da_thuc_hien',
    'entity_table', 'accounts',
    'entity_id',    v_r.cashbook_id,
    'audit_id',     v_audit_id,
    'ledger_id',    v_ledger_id
  );
END
$thuc_thi_cashbook_chot_so$;

COMMENT ON FUNCTION public.copilot_execute_cashbook_chot_so_v1(text, jsonb) IS
  'direct_l5_v1 — tieu nonce, tu choi neu khong chay trong ke hoach, goi lai confirm_cashbook_closing_v1, doc lai ca yeu cau CONFIRMED lan bien ban app_private.cashbook_closures, ghi ai_write_audit + so hanh dong (entity_table=accounts vi engine chi doc duoc public.*).';

REVOKE ALL ON FUNCTION public.copilot_execute_cashbook_chot_so_v1(text, jsonb)
  FROM PUBLIC;
DO $quyen_thuc_thi_cashbook_chot_so$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_execute_cashbook_chot_so_v1(text, jsonb) FROM anon;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_execute_cashbook_chot_so_v1(text, jsonb) FROM service_role;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_execute_cashbook_chot_so_v1(text, jsonb) FROM authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_execute_cashbook_chot_so_v1(text, jsonb) TO authenticated;
  END IF;
END
$quyen_thuc_thi_cashbook_chot_so$;

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
  'cashbook.chot_so',
  1,
  'Xác nhận chốt sổ quỹ & bàn giao',
  'cashbooks.close_confirm',
  'L5',
  'direct_l5_v1',
  'step_up',
  'copilot_preview_cashbook_chot_so_v1',
  'copilot_execute_cashbook_chot_so_v1',
  'cashbook_closed',
  'accounts',
  NULL,
  NULL,
  'Khong tim thay reopen_cashbook_closing_v1 tren production (03/09/2026). Bien ban chot so nam trong app_private.cashbook_closures — muon mo lai phai can thiep DB tay hoac cho tinh nang reopen tuong lai.',
  'cashbook.chot_so',
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
  'action', 'cashbook.chot_so', 'disabled',
  'seed kill switch cho action L5 xac nhan chot so quy (G5-C3 nhom C) — policy con L4 nen action nay khong the chay ke ca bat co',
  'migration:20260903224416_copilot_action_cashbook_chot_so_v1',
  'migration:20260903224416_copilot_action_cashbook_chot_so_v1'
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
    'public.copilot_preview_cashbook_chot_so_v1(uuid, jsonb)',
    'public.copilot_execute_cashbook_chot_so_v1(text, jsonb)'
  ]
  LOOP
    IF to_regprocedure(v_ten) IS NULL THEN
      v_thieu := v_thieu || v_ten;
    END IF;
  END LOOP;
  IF cardinality(v_thieu) > 0 THEN
    RAISE EXCEPTION 'thieu ham G5-C3 cashbook_chot_so: %', array_to_string(v_thieu, ', ');
  END IF;
  IF to_regprocedure('app_private.copilot_l5_plan_context_ok_v1(text, uuid)') IS NULL THEN
    RAISE EXCEPTION 'copilot_l5_plan_context_ok_v1 missing — 20260903190255 phai chay truoc';
  END IF;
  IF to_regprocedure('public.confirm_cashbook_closing_v1(uuid, numeric)') IS NULL THEN
    RAISE EXCEPTION 'confirm_cashbook_closing_v1 missing — baseline phai co truoc';
  END IF;

  IF to_regrole('anon') IS NOT NULL THEN
    FOREACH v_ten IN ARRAY ARRAY[
      'public.copilot_preview_cashbook_chot_so_v1(uuid, jsonb)',
      'public.copilot_execute_cashbook_chot_so_v1(text, jsonb)'
    ]
    LOOP
      IF has_function_privilege('anon', to_regprocedure(v_ten)::oid, 'EXECUTE') THEN
        v_ho := v_ho || v_ten;
      END IF;
    END LOOP;
    IF cardinality(v_ho) > 0 THEN
      RAISE EXCEPTION 'anon goi duoc ham G5-C3 cashbook_chot_so: %', array_to_string(v_ho, ', ');
    END IF;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM app_private.copilot_action_registry
     WHERE action_id = 'cashbook.chot_so'
       AND risk = 'L5' AND executor_kind = 'direct_l5_v1' AND consent_required = 'step_up'
       AND permission_key = 'cashbooks.close_confirm'
       AND grantable = false
       AND rollback_rpc IS NULL
  ) THEN
    RAISE EXCEPTION 'seed registry cashbook.chot_so sai hinh hoac thieu';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.copilot_feature_flags f
     WHERE f.scope = 'action' AND f.contract_id = 'cashbook.chot_so'
  ) THEN
    RAISE EXCEPTION 'copilot_rollout_seed_thieu_action_contract: cashbook.chot_so';
  END IF;
END
$nghiem_thu$;

COMMIT;

NOTIFY pgrst, 'reload schema';
