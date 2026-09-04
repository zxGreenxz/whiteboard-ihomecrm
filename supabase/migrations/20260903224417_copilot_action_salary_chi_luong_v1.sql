-- G5-C3 (8/9, nhom C - tai chinh con lai) - Action L5 `salary.chi_luong` theo
-- khuon direct_l5_v1 (xem 20260903190255 cho khuon day du + F1 helper).
--
-- BOC RPC GOC: `salary_payout_v1(p_staff_id, p_period_month, p_take_home,
-- p_account_id, p_voucher_date, p_note, p_idempotency_key, p_rent_invoice_id,
-- p_rent_amount)` (SECURITY DEFINER, doc production 03/09/2026). Org SUBJECT-
-- DERIVED tu nhan vien (manager_salary_config -> fallback
-- organization_memberships) — KHONG nhan p_organization_id, wrapper tu doi
-- chieu org suy ra tu staff_id khop voi p_organization_id cua canonical (fail-
-- closed neu lech). Gac quyen THAT: `authorize_tenant_action_v3(actor, org,
-- 'salary.distribute', toa_ao, account_id).allowed` — permission_key=
-- 'salary.distribute'.
--
-- FIX ROUND 1 (review, F1 HIGH): DA GO HAN CAN TRU TIEN PHONG (rent-offset)
-- KHOI ACTION NAY. Nhanh do trong RPC goc (p_rent_invoice_id/p_rent_amount)
-- tu goi `record_invoice_payment_v3` de tao MOT phieu THU da APPROVED + cap
-- nhat hoa don — mot tac dung phu TIEN THAT ma preview truoc do KHONG he noi
-- toi (chi hien 'so_tien'=take_home). Mot AI truyen hai tham so nay se am
-- tham lam thay doi so du hoa don + ghi mot phieu thu APPROVED ma nguoi duyet
-- ke hoach khong duoc canh bao. Wrapper v1 GIU LAI hai tham so trong chu ky
-- RPC goc (khong doi API) nhung LUON truyen NULL/NULL — het duong kich hoat
-- nhanh do qua Copilot. Muon can tru tien phong thi lam tren giao dien
-- thuong (khong qua Copilot).
--
-- WRITER LA "NOP HO SO", KHONG PHAI GHI THANG: RPC goc tao phieu chi UNAPPROVED
-- roi goi `submit_financial_request_v1` — tra ve
-- {salary_voucher_id, approval_request_id, state:'PENDING_APPROVAL', rent_offset?}.
-- Day CHUA PHAI tien ra khoi ket, chi la nop vao hang cho duyet (nguoi duyet
-- KHAC nguoi chay action nay theo luat 4-mat cua workflow chuan).
--
-- GATE `evaluate_feature_route('salary.payout.v1', org)` — DA XAC MINH tren
-- production 03/09/2026: `server_feature_flags.mode='ON'` (khong phai canary)
-- nen tra ve 'CANONICAL' cho MOI to chuc, khong can canary_org. Writer da bat
-- that su, khong phai gia dinh.
--
-- READBACK — verify_kind `approval_request_pending`: TAI SU DUNG nhanh CASE
-- co san trong engine (them tu G3 cho income_expense.nop_ho_so — kiem
-- state='PENDING_APPROVAL' VA maker_user_id=actor). entity_table=
-- 'approval_requests', entity_id=approval_request_id — dung schema `public`,
-- khong vuong van de nhu cashbook.chot_so.
--
-- IDEMPOTENCY KEY CUA RPC GOC — dan xuat tu payload_hash cua lop ngoai (cung
-- khuon voi income_expense.duyet_vao_so): `'copilot_action_' ||
-- substr(encode(hash,'hex'),1,40)`, khop regex RPC goc doi
-- (`^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$`).
--
-- HOAN TAC — `cancel_income_expense_flex_v1(uuid,text,bigint,bigint)` (da kiem
-- ton tai) goi voi salary_voucher_id (KHONG phai approval_request_id). Chi ghi
-- ten lam tai lieu, khong tu dong goi.
--
-- DUONG LUI CUA MIGRATION — DROP hai ham wrapper; DELETE hang registry
-- `salary.chi_luong` va hang co tuong ung.

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
-- HELPER RIENG — suy ra to chuc tu nhan vien, GIONG HET logic RPC goc (khong
-- co RPC nao lo ra logic nay de goi lai, nen wrapper tu lam de doi chieu SOM).
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
CREATE OR REPLACE FUNCTION public.copilot_preview_salary_chi_luong_v1(
  p_organization_id uuid,
  p_payload         jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, extensions
AS $xem_truoc_salary_chi_luong$
DECLARE
  v_actor        uuid := auth.uid();
  v_snapshot     jsonb;
  v_staff_id     uuid;
  v_period       date;
  v_take_home    numeric;
  v_account      uuid;
  v_voucher_date date;
  v_note         text;
  v_derived_org  uuid;
  v_scope        record;
  v_staff_email  text;
  v_acc          public.accounts%ROWTYPE;
  v_canonical    jsonb;
  v_nonce        bytea;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization_required' USING ERRCODE = '22023';
  END IF;

  v_snapshot := app_private.copilot_action_gate_v1('salary.chi_luong', p_organization_id);

  BEGIN
    v_staff_id     := (p_payload ->> 'staff_id')::uuid;
    v_period       := (p_payload ->> 'period_month')::date;
    v_take_home    := (p_payload ->> 'take_home')::numeric;
    v_account      := NULLIF(p_payload ->> 'account_id', '')::uuid;
    v_voucher_date := COALESCE((p_payload ->> 'voucher_date')::date, CURRENT_DATE);
    v_note         := NULLIF(btrim(COALESCE(p_payload ->> 'note', '')), '');
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'payload_invalid' USING ERRCODE = '22023';
  END;
  IF v_staff_id IS NULL OR v_period IS NULL OR v_take_home IS NULL
     OR v_take_home <= 0 OR round(v_take_home, 2) <> v_take_home
     OR v_account IS NULL THEN
    RAISE EXCEPTION 'payload_invalid' USING ERRCODE = '22023';
  END IF;

  v_derived_org := app_private.copilot_salary_org_of_staff_v1(v_staff_id);
  IF v_derived_org IS NULL OR v_derived_org IS DISTINCT FROM p_organization_id THEN
    RAISE EXCEPTION 'entity_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- salary_payout_v1 KHONG tu kiem account_id thuoc dung to chuc (chi INSERT
  -- thang) — wrapper chan SOM o day, chat hon RPC goc (an toan, khong noi rong).
  SELECT * INTO v_acc
    FROM public.accounts
   WHERE id = v_account AND organization_id = p_organization_id AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'entity_not_found' USING ERRCODE = 'P0002';
  END IF;

  SELECT s.org_wide, s.building_ids
    INTO v_scope
    FROM app_private.authorized_scope_v3('salary.distribute', p_organization_id) s;
  IF NOT COALESCE(v_scope.org_wide, false) AND COALESCE(cardinality(v_scope.building_ids), 0) = 0 THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;

  SELECT u.email INTO v_staff_email
    FROM auth.users u WHERE u.id = v_staff_id;

  v_canonical := jsonb_build_object(
    'organization_id',  p_organization_id,
    'staff_id',          v_staff_id,
    'period_month',      v_period,
    'take_home',         v_take_home,
    'account_id',        v_account,
    'voucher_date',      v_voucher_date,
    'note',              v_note
  );
  v_nonce := extensions.gen_random_bytes(32);

  INSERT INTO app_private.copilot_write_confirmations
    (nonce_digest, user_id, organization_id, tool, payload_hash,
     permission_key, expires_at)
  VALUES
    (extensions.digest(v_nonce, 'sha256'), v_actor, p_organization_id,
     'salary.chi_luong', app_private.copilot_payload_hash_v1(v_canonical),
     'salary.distribute', clock_timestamp() + interval '5 minutes');

  RETURN jsonb_build_object(
    'confirmation_nonce', encode(v_nonce, 'hex'),
    'canonical',          v_canonical,
    'preview', jsonb_build_object(
      'ten_khach_hang', v_staff_email,
      'so_tien',        v_take_home,
      'ky_hoa_don',      to_char(v_period, 'MM/YYYY'),
      'so_quy',          v_acc.name,
      'hau_qua',         'Se tao phieu chi luong UNAPPROVED va NOP vao hang cho duyet (khong tu duyet, khong tu chi tien). KHONG ho tro can tru tien phong qua Copilot — lam tren giao dien thuong neu can.'
    )
  );
END
$xem_truoc_salary_chi_luong$;

COMMENT ON FUNCTION public.copilot_preview_salary_chi_luong_v1(uuid, jsonb) IS
  'direct_l5_v1 — xem truoc chi luong (boc salary_payout_v1). Doi chieu org suy ra tu staff_id khop payload; RPC goc tu NOP HO SO qua submit_financial_request_v1, khong tu duyet.';

REVOKE ALL ON FUNCTION public.copilot_preview_salary_chi_luong_v1(uuid, jsonb)
  FROM PUBLIC;
DO $quyen_xem_truoc_salary_chi_luong$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_preview_salary_chi_luong_v1(uuid, jsonb) FROM anon;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_preview_salary_chi_luong_v1(uuid, jsonb) FROM service_role;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_preview_salary_chi_luong_v1(uuid, jsonb) FROM authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_preview_salary_chi_luong_v1(uuid, jsonb) TO authenticated;
  END IF;
END
$quyen_xem_truoc_salary_chi_luong$;

-- ---------------------------------------------------------------------------
-- 2. THUC THI
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.copilot_execute_salary_chi_luong_v1(
  p_confirmation_nonce text,
  p_payload            jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, extensions
AS $thuc_thi_salary_chi_luong$
DECLARE
  v_actor        uuid := auth.uid();
  v_hash         bytea;
  v_row          app_private.copilot_write_confirmations%ROWTYPE;
  v_snapshot     jsonb;
  v_org          uuid;
  v_staff_id     uuid;
  v_period       date;
  v_take_home    numeric;
  v_account      uuid;
  v_voucher_date date;
  v_note         text;
  v_key          text;
  v_key_goc      text;
  v_prev         public.ai_write_audit%ROWTYPE;
  v_before       jsonb;
  v_after        jsonb;
  v_derived_org  uuid;
  v_existing_sm  jsonb;
  v_ket          jsonb;
  v_voucher      uuid;
  v_req_id       uuid;
  v_req          public.approval_requests%ROWTYPE;
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
  IF v_row.tool IS DISTINCT FROM 'salary.chi_luong'
     OR v_row.permission_key IS DISTINCT FROM 'salary.distribute' THEN
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
    v_staff_id     := (p_payload ->> 'staff_id')::uuid;
    v_period       := (p_payload ->> 'period_month')::date;
    v_take_home    := (p_payload ->> 'take_home')::numeric;
    v_account      := (p_payload ->> 'account_id')::uuid;
    v_voucher_date := (p_payload ->> 'voucher_date')::date;
    v_note         := NULLIF(p_payload ->> 'note', '');
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'payload_changed' USING ERRCODE = '42501';
  END;
  IF v_org IS NULL OR v_staff_id IS NULL OR v_period IS NULL OR v_take_home IS NULL
     OR v_account IS NULL OR v_voucher_date IS NULL
     OR v_org IS DISTINCT FROM v_row.organization_id THEN
    RAISE EXCEPTION 'organization_mismatch' USING ERRCODE = '42501';
  END IF;

  -- F1 (review G5-C dot 1, fix round 1): guard L5 DATABASE THAT.
  IF NOT app_private.copilot_l5_plan_context_ok_v1('salary.chi_luong', v_org) THEN
    RAISE EXCEPTION 'l5_requires_plan' USING ERRCODE = '42501';
  END IF;

  v_derived_org := app_private.copilot_salary_org_of_staff_v1(v_staff_id);
  IF v_derived_org IS DISTINCT FROM v_org THEN
    RAISE EXCEPTION 'entity_changed_since_preview' USING ERRCODE = '55000';
  END IF;

  v_snapshot := app_private.copilot_action_gate_v1('salary.chi_luong', v_org);

  v_key := 'copilot_action:salary.chi_luong:' || v_actor::text || ':'
        || v_org::text || ':' || encode(v_hash, 'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended(v_key, 0));

  SELECT * INTO v_prev
    FROM public.ai_write_audit a
   WHERE a.idempotency_key = v_key;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'status',       'da_thuc_hien_truoc_do',
      'entity_table', 'approval_requests',
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

  SELECT to_jsonb(sm) INTO v_existing_sm
    FROM public.salary_monthly sm
   WHERE sm.staff_id = v_staff_id AND sm.period_month = v_period;
  v_before := jsonb_build_object(
    'staff_id', v_staff_id, 'period_month', v_period,
    'existing_salary_monthly', v_existing_sm
  );

  -- Khoa dan xuat tu CUNG payload_hash cua lop ngoai (cung khuon voi
  -- income_expense.duyet_vao_so).
  v_key_goc := 'copilot_action_' || substr(encode(v_hash, 'hex'), 1, 40);

  v_ket := public.salary_payout_v1(
    v_staff_id, v_period, v_take_home, v_account, v_voucher_date, v_note,
    v_key_goc, NULL::uuid, NULL::numeric);  -- F1 (review, HIGH): rent-offset da go, LUON NULL
  v_voucher := NULLIF(v_ket ->> 'salary_voucher_id', '')::uuid;
  v_req_id  := NULLIF(v_ket ->> 'approval_request_id', '')::uuid;
  IF v_voucher IS NULL OR v_req_id IS NULL THEN
    RAISE EXCEPTION 'copilot_write_readback_mismatch' USING ERRCODE = 'P0001';
  END IF;

  -- READBACK RIENG cua wrapper (bo sung nhanh 'approval_request_pending' co
  -- san cua engine — nhanh do chi kiem state+maker_user_id tren
  -- approval_requests, chua kiem phieu goc).
  SELECT * INTO v_ie FROM public.income_expenses WHERE id = v_voucher;
  IF NOT FOUND
     OR v_ie.organization_id IS DISTINCT FROM v_org
     OR v_ie.salary_staff_id IS DISTINCT FROM v_staff_id
     -- F1 (review, HIGH): so tien phieu PHAI dung bang take_home da chot o
     -- canonical — khong con nhanh can tru tien phong nen chi con DUY NHAT
     -- dong "Tien thuc nhan" (quantity 1, unit_price=take_home), total_amount
     -- (cot tinh tu items) phai khop chinh xac.
     OR v_ie.total_amount IS DISTINCT FROM v_take_home THEN
    RAISE EXCEPTION 'copilot_write_readback_mismatch' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_req FROM public.approval_requests WHERE id = v_req_id;
  IF NOT FOUND
     OR v_req.organization_id IS DISTINCT FROM v_org
     OR v_req.subject_id IS DISTINCT FROM v_voucher THEN
    RAISE EXCEPTION 'copilot_write_readback_mismatch' USING ERRCODE = 'P0001';
  END IF;
  v_after := to_jsonb(v_req) || jsonb_build_object('salary_voucher_id', v_voucher);

  INSERT INTO public.ai_write_audit
    (user_id, tool, idempotency_key, entity_table, entity_id, payload, organization_id)
  VALUES
    (v_actor, 'salary.chi_luong', v_key, 'approval_requests',
     v_req_id, p_payload, v_org)
  RETURNING id INTO v_audit_id;

  v_ledger_id := app_private.copilot_ledger_append_v1(jsonb_build_object(
    'event',               'action_executed',
    'organization_id',     v_org,
    'action_id',           'salary.chi_luong',
    'permission_key',      'salary.distribute',
    'permission_snapshot', v_snapshot,
    'consent_kind',        'click',
    'consent_id',          v_row.id,
    'payload_digest',      encode(v_hash, 'hex'),
    'before_digest',       encode(extensions.digest(
                             convert_to(v_before::text, 'UTF8'), 'sha256'), 'hex'),
    'after_digest',        encode(extensions.digest(
                             convert_to(v_after::text, 'UTF8'), 'sha256'), 'hex'),
    'entity_table',        'approval_requests',
    'entity_id',            v_req_id,
    'audit_id',             v_audit_id,
    'amount',               v_take_home,
    'outcome',              jsonb_build_object('status', 'da_thuc_hien', 'salary_voucher_id', v_voucher)
  ));

  RETURN jsonb_build_object(
    'status',       'da_thuc_hien',
    'entity_table', 'approval_requests',
    'entity_id',    v_req_id,
    'audit_id',     v_audit_id,
    'ledger_id',    v_ledger_id
  );
END
$thuc_thi_salary_chi_luong$;

COMMENT ON FUNCTION public.copilot_execute_salary_chi_luong_v1(text, jsonb) IS
  'direct_l5_v1 — tieu nonce, tu choi neu khong chay trong ke hoach, goi lai salary_payout_v1, doi chieu org suy ra tu staff_id, readback ca income_expenses lan approval_requests, ghi ai_write_audit + so hanh dong (kem amount=take_home).';

REVOKE ALL ON FUNCTION public.copilot_execute_salary_chi_luong_v1(text, jsonb)
  FROM PUBLIC;
DO $quyen_thuc_thi_salary_chi_luong$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_execute_salary_chi_luong_v1(text, jsonb) FROM anon;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_execute_salary_chi_luong_v1(text, jsonb) FROM service_role;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_execute_salary_chi_luong_v1(text, jsonb) FROM authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_execute_salary_chi_luong_v1(text, jsonb) TO authenticated;
  END IF;
END
$quyen_thuc_thi_salary_chi_luong$;

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
  'salary.chi_luong',
  1,
  'Nộp hồ sơ chi lương chờ duyệt',
  'salary.distribute',
  'L5',
  'direct_l5_v1',
  'step_up',
  'copilot_preview_salary_chi_luong_v1',
  'copilot_execute_salary_chi_luong_v1',
  'approval_request_pending',
  'approval_requests',
  NULL,
  'cancel_income_expense_flex_v1',
  'Goi lai cancel_income_expense_flex_v1(uuid,text,bigint,bigint) voi salary_voucher_id (KHONG phai approval_request_id — doc tu outcome.salary_voucher_id cua dong so hanh dong). Khong tu dong goi.',
  'salary.chi_luong',
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
  'action', 'salary.chi_luong', 'disabled',
  'seed kill switch cho action L5 chi luong (G5-C3 nhom C) — policy con L4 nen action nay khong the chay ke ca bat co',
  'migration:20260903224417_copilot_action_salary_chi_luong_v1',
  'migration:20260903224417_copilot_action_salary_chi_luong_v1'
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
    'public.copilot_preview_salary_chi_luong_v1(uuid, jsonb)',
    'public.copilot_execute_salary_chi_luong_v1(text, jsonb)',
    'app_private.copilot_salary_org_of_staff_v1(uuid)'
  ]
  LOOP
    IF to_regprocedure(v_ten) IS NULL THEN
      v_thieu := v_thieu || v_ten;
    END IF;
  END LOOP;
  IF cardinality(v_thieu) > 0 THEN
    RAISE EXCEPTION 'thieu ham G5-C3 salary_chi_luong: %', array_to_string(v_thieu, ', ');
  END IF;
  IF to_regprocedure('app_private.copilot_l5_plan_context_ok_v1(text, uuid)') IS NULL THEN
    RAISE EXCEPTION 'copilot_l5_plan_context_ok_v1 missing — 20260903190255 phai chay truoc';
  END IF;
  IF to_regprocedure('public.salary_payout_v1(uuid, date, numeric, uuid, date, text, text, uuid, numeric)') IS NULL THEN
    RAISE EXCEPTION 'salary_payout_v1 missing — baseline phai co truoc';
  END IF;
  IF to_regprocedure('public.cancel_income_expense_flex_v1(uuid, text, bigint, bigint)') IS NULL THEN
    RAISE EXCEPTION 'cancel_income_expense_flex_v1 missing — rollback_rpc phai ton tai that';
  END IF;

  IF to_regrole('anon') IS NOT NULL THEN
    FOREACH v_ten IN ARRAY ARRAY[
      'public.copilot_preview_salary_chi_luong_v1(uuid, jsonb)',
      'public.copilot_execute_salary_chi_luong_v1(text, jsonb)',
      'app_private.copilot_salary_org_of_staff_v1(uuid)'
    ]
    LOOP
      IF has_function_privilege('anon', to_regprocedure(v_ten)::oid, 'EXECUTE') THEN
        v_ho := v_ho || v_ten;
      END IF;
    END LOOP;
    IF cardinality(v_ho) > 0 THEN
      RAISE EXCEPTION 'anon goi duoc ham G5-C3 salary_chi_luong: %', array_to_string(v_ho, ', ');
    END IF;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM app_private.copilot_action_registry
     WHERE action_id = 'salary.chi_luong'
       AND risk = 'L5' AND executor_kind = 'direct_l5_v1' AND consent_required = 'step_up'
       AND permission_key = 'salary.distribute'
       AND grantable = false
       AND rollback_rpc = 'cancel_income_expense_flex_v1'
  ) THEN
    RAISE EXCEPTION 'seed registry salary.chi_luong sai hinh hoac thieu';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.copilot_feature_flags f
     WHERE f.scope = 'action' AND f.contract_id = 'salary.chi_luong'
  ) THEN
    RAISE EXCEPTION 'copilot_rollout_seed_thieu_action_contract: salary.chi_luong';
  END IF;
END
$nghiem_thu$;

COMMIT;

NOTIFY pgrst, 'reload schema';
