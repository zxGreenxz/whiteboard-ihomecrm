-- G5-C3 (9/9, nhom C - tai chinh con lai) - Action L5 `salary.khoa_thang` theo
-- khuon direct_l5_v1 (xem 20260903190255 cho khuon day du + F1 helper).
--
-- BOC RPC GOC: `lock_salary_month_v1(p_period_month, p_managers, p_idempotency_key)`
-- (SECURITY DEFINER, doc production 03/09/2026). Org SUBJECT-DERIVED tu nhan
-- vien DAU TIEN trong p_managers (cung ham dung chung
-- app_private.copilot_salary_org_of_staff_v1 nhu salary.chi_luong); RPC goc TU
-- kiem moi nhan vien con lai cung org. p_managers la mang JSON lon, MOI phan tu
-- mang mot bang ke cong viec long nhau (salary_work_ledger_snapshot) — wrapper
-- KHONG rut gon payload, chuyen NGUYEN VEN qua canonical (Nonce ABI v1 khong
-- gioi han kich thuoc jsonb).
--
-- Ham goc TU CO hai lop guard nghiep vu (chot loi nhuan thang truoc, phieu hoa
-- hong thieu so quy) va tu duyet phieu hoa hong qua approve_income_expense_v1/
-- approve_voucher — wrapper KHONG lam long, chi goi nguyen ven roi doi soat
-- KET QUA.
--
-- GATE `evaluate_feature_route('salary.lock.v1', org)` — DA XAC MINH tren
-- production 03/09/2026: `server_feature_flags.mode='ON'` nen tra ve
-- 'CANONICAL' cho MOI to chuc. Writer da bat that su.
--
-- CAP KICH THUOC — toi da 50 quan ly/lan (an toan "bulk", cung tinh than voi
-- invoice.duyet_hang_loat/meter_reading.xoa_hang_loat du day khong phai mang
-- id don gian).
--
-- READBACK — verify_kind tuy chinh `salary_locked` (ELSE cua CASE engine): bat
-- bien THAT nam trong wrapper — MOI staff_id trong p_managers phai co dong
-- salary_monthly voi status='LOCKED' VA dung to chuc SAU khi goi RPC.
--
-- entity_table/entity_id cho ENGINE: 'salary_monthly', id cua dong ung voi
-- nhan vien DAU TIEN (managers[0].staff_id) — cung tinh than "bulk lay phan tu
-- dau" nhu cac action bulk khac cua dot nay.
--
-- HOAN TAC — KHONG tim thay `unlock_salary_month_v1` tren production (kiem
-- to_regprocedure, 03/09/2026) — NULL + rollback_note.
--
-- DUONG LUI CUA MIGRATION — DROP hai ham wrapper; DELETE hang registry
-- `salary.khoa_thang` va hang co tuong ung. KHONG DROP
-- `copilot_salary_org_of_staff_v1` (dung chung voi salary.chi_luong, migration
-- 20260903224417 — xoa o migration do neu can).

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
-- 0d. HELPER DUNG CHUNG voi salary.chi_luong (20260903224417) — CREATE OR
-- REPLACE lai GIONG HET vi idempotent-check do TUNG FILE rieng le, khong chac
-- migration 224417 da apply truoc.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_private.copilot_salary_org_of_staff_v1(p_staff_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, extensions
AS $salary_org_of_staff$
  SELECT COALESCE(
    (SELECT organization_id FROM public.manager_salary_config
      WHERE staff_id = p_staff_id AND organization_id IS NOT NULL
      ORDER BY is_active DESC, created_at DESC LIMIT 1),
    (SELECT organization_id FROM public.organization_memberships
      WHERE user_id = p_staff_id AND status = 'ACTIVE' LIMIT 1)
  );
$salary_org_of_staff$;

REVOKE ALL ON FUNCTION app_private.copilot_salary_org_of_staff_v1(uuid) FROM PUBLIC;
DO $quyen_salary_org_of_staff$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION app_private.copilot_salary_org_of_staff_v1(uuid) FROM anon;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION app_private.copilot_salary_org_of_staff_v1(uuid) FROM service_role;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION app_private.copilot_salary_org_of_staff_v1(uuid) FROM authenticated;
  END IF;
END
$quyen_salary_org_of_staff$;

-- ---------------------------------------------------------------------------
-- 1. XEM TRUOC
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.copilot_preview_salary_khoa_thang_v1(
  p_organization_id uuid,
  p_payload         jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, extensions
AS $xem_truoc_salary_khoa_thang$
DECLARE
  v_actor        uuid := auth.uid();
  v_snapshot     jsonb;
  v_period       date;
  v_managers     jsonb;
  v_n            int;
  v_first_staff  uuid;
  v_derived_org  uuid;
  v_mg           jsonb;
  v_staff        uuid;
  v_scope        record;
  v_canonical    jsonb;
  v_nonce        bytea;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization_required' USING ERRCODE = '22023';
  END IF;

  v_snapshot := app_private.copilot_action_gate_v1('salary.khoa_thang', p_organization_id);

  BEGIN
    v_period   := (p_payload ->> 'period_month')::date;
    v_managers := p_payload -> 'managers';
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'payload_invalid' USING ERRCODE = '22023';
  END;
  IF v_period IS NULL OR jsonb_typeof(COALESCE(v_managers, 'null'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'payload_invalid' USING ERRCODE = '22023';
  END IF;
  v_n := jsonb_array_length(v_managers);
  IF v_n < 1 THEN
    RAISE EXCEPTION 'payload_invalid' USING ERRCODE = '22023';
  END IF;
  -- CAP KICH THUOC — an toan bulk, cung tinh than voi cac action bulk khac.
  IF v_n > 50 THEN
    RAISE EXCEPTION 'bulk_too_large: % quan ly, toi da 50', v_n USING ERRCODE = '22023';
  END IF;

  BEGIN
    v_first_staff := NULLIF(v_managers -> 0 ->> 'staff_id', '')::uuid;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'payload_invalid' USING ERRCODE = '22023';
  END;
  IF v_first_staff IS NULL THEN
    RAISE EXCEPTION 'payload_invalid' USING ERRCODE = '22023';
  END IF;

  v_derived_org := app_private.copilot_salary_org_of_staff_v1(v_first_staff);
  IF v_derived_org IS NULL OR v_derived_org IS DISTINCT FROM p_organization_id THEN
    RAISE EXCEPTION 'entity_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- Doi chieu SOM: moi quan ly con lai phai co staff_id VA cung to chuc suy ra
  -- tu nhan vien dau tien (RPC goc se tu choi neu lech, nhung chan som cho UX
  -- ro rang hon "Danh sach nhan vien chua nguoi khac to chuc").
  FOR v_mg IN SELECT value FROM jsonb_array_elements(v_managers) LOOP
    BEGIN
      v_staff := NULLIF(v_mg ->> 'staff_id', '')::uuid;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'payload_invalid' USING ERRCODE = '22023';
    END;
    IF v_staff IS NULL THEN
      RAISE EXCEPTION 'payload_invalid' USING ERRCODE = '22023';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.organization_memberships m
       WHERE m.user_id = v_staff AND m.organization_id = p_organization_id AND m.status = 'ACTIVE'
    ) THEN
      RAISE EXCEPTION 'entity_not_found' USING ERRCODE = 'P0002';
    END IF;
  END LOOP;

  SELECT s.org_wide, s.building_ids
    INTO v_scope
    FROM app_private.authorized_scope_v3('salary.lock', p_organization_id) s;
  IF NOT COALESCE(v_scope.org_wide, false) AND COALESCE(cardinality(v_scope.building_ids), 0) = 0 THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;

  v_canonical := jsonb_build_object(
    'organization_id', p_organization_id,
    'period_month',     v_period,
    'managers',         v_managers,
    'expected_count',   v_n
  );
  v_nonce := extensions.gen_random_bytes(32);

  INSERT INTO app_private.copilot_write_confirmations
    (nonce_digest, user_id, organization_id, tool, payload_hash,
     permission_key, expires_at)
  VALUES
    (extensions.digest(v_nonce, 'sha256'), v_actor, p_organization_id,
     'salary.khoa_thang', app_private.copilot_payload_hash_v1(v_canonical),
     'salary.lock', clock_timestamp() + interval '5 minutes');

  RETURN jsonb_build_object(
    'confirmation_nonce', encode(v_nonce, 'hex'),
    'canonical',          v_canonical,
    'preview', jsonb_build_object(
      'ky_hoa_don', to_char(v_period, 'MM/YYYY'),
      'canh_bao',   format('Se khoa bang luong cua %s quan ly cho ky nay — khong the sua sau khi khoa', v_n),
      'hau_qua',    format('Se chot LOCKED bang luong cua %s quan ly, duyet kem cac phieu hoa hong dinh kem', v_n)
    )
  );
END
$xem_truoc_salary_khoa_thang$;

COMMENT ON FUNCTION public.copilot_preview_salary_khoa_thang_v1(uuid, jsonb) IS
  'direct_l5_v1 — xem truoc chot khoa bang luong thang (boc lock_salary_month_v1). Doi chieu org suy ra tu nhan vien dau tien + moi nhan vien con lai cung to chuc, cap 50 quan ly/lan.';

REVOKE ALL ON FUNCTION public.copilot_preview_salary_khoa_thang_v1(uuid, jsonb)
  FROM PUBLIC;
DO $quyen_xem_truoc_salary_khoa_thang$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_preview_salary_khoa_thang_v1(uuid, jsonb) FROM anon;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_preview_salary_khoa_thang_v1(uuid, jsonb) FROM service_role;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_preview_salary_khoa_thang_v1(uuid, jsonb) FROM authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_preview_salary_khoa_thang_v1(uuid, jsonb) TO authenticated;
  END IF;
END
$quyen_xem_truoc_salary_khoa_thang$;

-- ---------------------------------------------------------------------------
-- 2. THUC THI
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.copilot_execute_salary_khoa_thang_v1(
  p_confirmation_nonce text,
  p_payload            jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, extensions
AS $thuc_thi_salary_khoa_thang$
DECLARE
  v_actor        uuid := auth.uid();
  v_hash         bytea;
  v_row          app_private.copilot_write_confirmations%ROWTYPE;
  v_snapshot     jsonb;
  v_org          uuid;
  v_period       date;
  v_managers     jsonb;
  v_expected     int;
  v_key          text;
  v_key_goc      text;
  v_prev         public.ai_write_audit%ROWTYPE;
  v_before       jsonb;
  v_after        jsonb;
  v_first_staff  uuid;
  v_derived_org  uuid;
  v_staff_ids    uuid[] := ARRAY[]::uuid[];
  v_mg           jsonb;
  v_staff        uuid;
  v_ket          jsonb;
  v_locked_count int;
  v_check_status text;
  v_check_org    uuid;
  v_first_sm_id  uuid;
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
  IF v_row.tool IS DISTINCT FROM 'salary.khoa_thang'
     OR v_row.permission_key IS DISTINCT FROM 'salary.lock' THEN
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
    v_org      := (p_payload ->> 'organization_id')::uuid;
    v_period   := (p_payload ->> 'period_month')::date;
    v_managers := p_payload -> 'managers';
    v_expected := (p_payload ->> 'expected_count')::int;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'payload_changed' USING ERRCODE = '42501';
  END;
  IF v_org IS NULL OR v_period IS NULL
     OR jsonb_typeof(COALESCE(v_managers, 'null'::jsonb)) <> 'array'
     OR v_expected IS NULL OR jsonb_array_length(v_managers) <> v_expected
     OR v_org IS DISTINCT FROM v_row.organization_id THEN
    RAISE EXCEPTION 'organization_mismatch' USING ERRCODE = '42501';
  END IF;
  IF jsonb_array_length(v_managers) > 50 THEN
    RAISE EXCEPTION 'bulk_too_large: % quan ly, toi da 50', jsonb_array_length(v_managers) USING ERRCODE = '22023';
  END IF;

  -- F1 (review G5-C dot 1, fix round 1): guard L5 DATABASE THAT.
  IF NOT app_private.copilot_l5_plan_context_ok_v1('salary.khoa_thang', v_org) THEN
    RAISE EXCEPTION 'l5_requires_plan' USING ERRCODE = '42501';
  END IF;

  BEGIN
    v_first_staff := NULLIF(v_managers -> 0 ->> 'staff_id', '')::uuid;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'payload_changed' USING ERRCODE = '42501';
  END;
  IF v_first_staff IS NULL THEN
    RAISE EXCEPTION 'payload_changed' USING ERRCODE = '42501';
  END IF;
  v_derived_org := app_private.copilot_salary_org_of_staff_v1(v_first_staff);
  IF v_derived_org IS DISTINCT FROM v_org THEN
    RAISE EXCEPTION 'entity_changed_since_preview' USING ERRCODE = '55000';
  END IF;

  FOR v_mg IN SELECT value FROM jsonb_array_elements(v_managers) LOOP
    v_staff := NULLIF(v_mg ->> 'staff_id', '')::uuid;
    IF v_staff IS NULL THEN
      RAISE EXCEPTION 'payload_changed' USING ERRCODE = '42501';
    END IF;
    v_staff_ids := v_staff_ids || v_staff;
  END LOOP;

  v_snapshot := app_private.copilot_action_gate_v1('salary.khoa_thang', v_org);

  v_key := 'copilot_action:salary.khoa_thang:' || v_actor::text || ':'
        || v_org::text || ':' || encode(v_hash, 'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended(v_key, 0));

  SELECT * INTO v_prev
    FROM public.ai_write_audit a
   WHERE a.idempotency_key = v_key;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'status',       'da_thuc_hien_truoc_do',
      'entity_table', 'salary_monthly',
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

  -- before_digest — anh chup cac dong salary_monthly TRUOC khi khoa (mang co
  -- the rong tung phan tu neu chua ton tai, nhung goi jsonb NGOAI luon khac
  -- NULL).
  SELECT jsonb_agg(to_jsonb(sm) ORDER BY sm.staff_id) INTO v_before
    FROM public.salary_monthly sm
   WHERE sm.staff_id = ANY(v_staff_ids) AND sm.period_month = v_period;
  v_before := jsonb_build_object(
    'period_month', v_period, 'staff_ids', to_jsonb(v_staff_ids),
    'existing_rows', COALESCE(v_before, '[]'::jsonb)
  );

  v_key_goc := 'copilot_action_' || substr(encode(v_hash, 'hex'), 1, 40);

  v_ket := public.lock_salary_month_v1(v_period, v_managers, v_key_goc);
  v_locked_count := NULLIF(v_ket ->> 'locked_count', '')::int;
  IF v_locked_count IS NULL THEN
    RAISE EXCEPTION 'copilot_write_readback_mismatch' USING ERRCODE = 'P0001';
  END IF;

  -- READBACK — moi staff_id trong danh sach PHAI co dong salary_monthly
  -- status='LOCKED' dung to chuc (fail-closed, khong tin locked_count suong).
  FOREACH v_staff IN ARRAY v_staff_ids LOOP
    SELECT status, organization_id INTO v_check_status, v_check_org
      FROM public.salary_monthly
     WHERE staff_id = v_staff AND period_month = v_period;
    IF v_check_status IS DISTINCT FROM 'LOCKED'
       OR v_check_org IS DISTINCT FROM v_org THEN
      RAISE EXCEPTION 'copilot_write_readback_mismatch' USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  SELECT id INTO v_first_sm_id
    FROM public.salary_monthly
   WHERE staff_id = v_first_staff AND period_month = v_period;
  IF v_first_sm_id IS NULL THEN
    RAISE EXCEPTION 'copilot_write_readback_mismatch' USING ERRCODE = 'P0001';
  END IF;

  SELECT jsonb_agg(to_jsonb(sm) ORDER BY sm.staff_id) INTO v_after
    FROM public.salary_monthly sm
   WHERE sm.staff_id = ANY(v_staff_ids) AND sm.period_month = v_period;

  INSERT INTO public.ai_write_audit
    (user_id, tool, idempotency_key, entity_table, entity_id, payload, organization_id)
  VALUES
    (v_actor, 'salary.khoa_thang', v_key, 'salary_monthly',
     v_first_sm_id, p_payload, v_org)
  RETURNING id INTO v_audit_id;

  v_ledger_id := app_private.copilot_ledger_append_v1(jsonb_build_object(
    'event',               'action_executed',
    'organization_id',     v_org,
    'action_id',           'salary.khoa_thang',
    'permission_key',      'salary.lock',
    'permission_snapshot', v_snapshot,
    'consent_kind',        'click',
    'consent_id',          v_row.id,
    'payload_digest',      encode(v_hash, 'hex'),
    'before_digest',       encode(extensions.digest(
                             convert_to(v_before::text, 'UTF8'), 'sha256'), 'hex'),
    'after_digest',        encode(extensions.digest(
                             convert_to(v_after::text, 'UTF8'), 'sha256'), 'hex'),
    'entity_table',        'salary_monthly',
    'entity_id',            v_first_sm_id,
    'audit_id',             v_audit_id,
    'outcome',              jsonb_build_object('status', 'da_thuc_hien', 'locked_count', v_locked_count, 'commission_approved', v_ket ->> 'commission_approved')
  ));

  RETURN jsonb_build_object(
    'status',       'da_thuc_hien',
    'entity_table', 'salary_monthly',
    'entity_id',    v_first_sm_id,
    'audit_id',     v_audit_id,
    'ledger_id',    v_ledger_id
  );
END
$thuc_thi_salary_khoa_thang$;

COMMENT ON FUNCTION public.copilot_execute_salary_khoa_thang_v1(text, jsonb) IS
  'direct_l5_v1 — tieu nonce, tu choi neu khong chay trong ke hoach, goi lai lock_salary_month_v1, doi MOI staff_id that su LOCKED dung to chuc (fail-closed), ghi ai_write_audit + so hanh dong.';

REVOKE ALL ON FUNCTION public.copilot_execute_salary_khoa_thang_v1(text, jsonb)
  FROM PUBLIC;
DO $quyen_thuc_thi_salary_khoa_thang$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_execute_salary_khoa_thang_v1(text, jsonb) FROM anon;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_execute_salary_khoa_thang_v1(text, jsonb) FROM service_role;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_execute_salary_khoa_thang_v1(text, jsonb) FROM authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_execute_salary_khoa_thang_v1(text, jsonb) TO authenticated;
  END IF;
END
$quyen_thuc_thi_salary_khoa_thang$;

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
  'salary.khoa_thang',
  1,
  'Chốt khoá bảng lương tháng',
  'salary.lock',
  'L5',
  'direct_l5_v1',
  'step_up',
  'copilot_preview_salary_khoa_thang_v1',
  'copilot_execute_salary_khoa_thang_v1',
  'salary_locked',
  'salary_monthly',
  NULL,
  NULL,
  'Khong tim thay unlock_salary_month_v1 tren production (03/09/2026). Muon mo khoa thi can thiep DB tay hoac cho tinh nang unlock tuong lai — doc danh sach staff_id/period_month tu before_digest cua dong so hanh dong.',
  'salary.khoa_thang',
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
  'action', 'salary.khoa_thang', 'disabled',
  'seed kill switch cho action L5 chot khoa bang luong (G5-C3 nhom C) — policy con L4 nen action nay khong the chay ke ca bat co',
  'migration:20260903224418_copilot_action_salary_khoa_thang_v1',
  'migration:20260903224418_copilot_action_salary_khoa_thang_v1'
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
    'public.copilot_preview_salary_khoa_thang_v1(uuid, jsonb)',
    'public.copilot_execute_salary_khoa_thang_v1(text, jsonb)',
    'app_private.copilot_salary_org_of_staff_v1(uuid)'
  ]
  LOOP
    IF to_regprocedure(v_ten) IS NULL THEN
      v_thieu := v_thieu || v_ten;
    END IF;
  END LOOP;
  IF cardinality(v_thieu) > 0 THEN
    RAISE EXCEPTION 'thieu ham G5-C3 salary_khoa_thang: %', array_to_string(v_thieu, ', ');
  END IF;
  IF to_regprocedure('app_private.copilot_l5_plan_context_ok_v1(text, uuid)') IS NULL THEN
    RAISE EXCEPTION 'copilot_l5_plan_context_ok_v1 missing — 20260903190255 phai chay truoc';
  END IF;
  IF to_regprocedure('public.lock_salary_month_v1(date, jsonb, text)') IS NULL THEN
    RAISE EXCEPTION 'lock_salary_month_v1 missing — baseline phai co truoc';
  END IF;

  IF to_regrole('anon') IS NOT NULL THEN
    FOREACH v_ten IN ARRAY ARRAY[
      'public.copilot_preview_salary_khoa_thang_v1(uuid, jsonb)',
      'public.copilot_execute_salary_khoa_thang_v1(text, jsonb)',
      'app_private.copilot_salary_org_of_staff_v1(uuid)'
    ]
    LOOP
      IF has_function_privilege('anon', to_regprocedure(v_ten)::oid, 'EXECUTE') THEN
        v_ho := v_ho || v_ten;
      END IF;
    END LOOP;
    IF cardinality(v_ho) > 0 THEN
      RAISE EXCEPTION 'anon goi duoc ham G5-C3 salary_khoa_thang: %', array_to_string(v_ho, ', ');
    END IF;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM app_private.copilot_action_registry
     WHERE action_id = 'salary.khoa_thang'
       AND risk = 'L5' AND executor_kind = 'direct_l5_v1' AND consent_required = 'step_up'
       AND permission_key = 'salary.lock'
       AND grantable = false
       AND rollback_rpc IS NULL
  ) THEN
    RAISE EXCEPTION 'seed registry salary.khoa_thang sai hinh hoac thieu';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.copilot_feature_flags f
     WHERE f.scope = 'action' AND f.contract_id = 'salary.khoa_thang'
  ) THEN
    RAISE EXCEPTION 'copilot_rollout_seed_thieu_action_contract: salary.khoa_thang';
  END IF;
END
$nghiem_thu$;

COMMIT;

NOTIFY pgrst, 'reload schema';
