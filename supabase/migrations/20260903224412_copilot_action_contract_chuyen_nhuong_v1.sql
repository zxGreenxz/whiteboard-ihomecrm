-- G5-C3 (3/9, nhom C - tai chinh con lai) - Action L5 `contract.chuyen_nhuong`
-- theo khuon direct_l5_v1 (xem 20260903190255 cho khuon day du + F1 helper).
--
-- BOC RPC GOC: `transfer_contract(p_contract_id, p_new_customer_id,
-- p_new_rent_price, p_new_deposit, p_transfer_date, p_notes)` (SECURITY
-- DEFINER, doc production 03/09/2026). Gac quyen THAT: `is_super_admin() OR
-- can_do_on_building('contracts','edit', building_id)` — permission_key=
-- 'contracts.edit', giong het contract.gia_han. Goi thang `transfer_contract_impl`.
--
-- CUNG SUA LAI GHI CHU CUA BAO CAO DOT TRUOC (xem 20260903224411): doc than
-- `transfer_contract_impl` THAT xac nhan day la UPDATE TAI CHO (doi dai dien
-- trong contract_customers + gia/coc/ghi chu tren contracts) roi RETURN
-- p_contract_id — CUNG mot hop dong, khong tao hop dong moi.
--
-- READBACK — verify_kind `contract_transferred`: doc lai contracts (khong doi
-- id), VA contract_customers phai co dung mot dong is_representative=true voi
-- customer_id = khach hang moi.
--
-- HOAN TAC — KHONG tim thay `cancel_contract_transfer`/`undo_transfer_contract`
-- tren production (kiem to_regprocedure ca hai ten, 03/09/2026) — NULL +
-- rollback_note.
--
-- DUONG LUI CUA MIGRATION — DROP hai ham wrapper; DELETE hang registry
-- `contract.chuyen_nhuong` va hang co tuong ung.

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
-- 0c. COT pin_always — idempotent them neu chua co (G5-C2 da them tai
-- 20260903212600; lap lai o day vi idempotent-check do TUNG FILE rieng le
-- tren production HIEN TAI, chua chac migration 212600 da apply thuc su).
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
CREATE OR REPLACE FUNCTION public.copilot_preview_contract_chuyen_nhuong_v1(
  p_organization_id uuid,
  p_payload         jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, extensions
AS $xem_truoc_contract_chuyen_nhuong$
DECLARE
  v_actor       uuid := auth.uid();
  v_snapshot    jsonb;
  v_contract_id uuid;
  v_new_cust    uuid;
  v_new_rent    numeric;
  v_new_deposit numeric;
  v_xfer_date   date;
  v_notes       text;
  v_c           public.contracts%ROWTYPE;
  v_cust        public.customers%ROWTYPE;
  v_bld         uuid;
  v_toa         text;
  v_scope       record;
  v_current_rep uuid;
  v_canonical   jsonb;
  v_nonce       bytea;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization_required' USING ERRCODE = '22023';
  END IF;

  v_snapshot := app_private.copilot_action_gate_v1('contract.chuyen_nhuong', p_organization_id);

  BEGIN
    v_contract_id := (p_payload ->> 'contract_id')::uuid;
    v_new_cust    := (p_payload ->> 'new_customer_id')::uuid;
    v_new_rent    := NULLIF(p_payload ->> 'new_rent_price', '')::numeric;
    v_new_deposit := NULLIF(p_payload ->> 'new_deposit', '')::numeric;
    v_xfer_date   := COALESCE((p_payload ->> 'transfer_date')::date, CURRENT_DATE);
    v_notes       := NULLIF(btrim(COALESCE(p_payload ->> 'notes', '')), '');
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'payload_invalid' USING ERRCODE = '22023';
  END;
  IF v_contract_id IS NULL OR v_new_cust IS NULL THEN
    RAISE EXCEPTION 'payload_invalid' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_c
    FROM public.contracts
   WHERE id = v_contract_id
     AND deleted_at IS NULL
     AND organization_id = p_organization_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'entity_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_c.status NOT IN ('ACTIVE', 'EXTENDED') THEN
    RAISE EXCEPTION 'contract_not_transferable' USING ERRCODE = '55000';
  END IF;

  -- F3 (review, MED): chan gia/coc "ngon tay beo" — am hoac vuot 10x gia/coc
  -- hien tai deu tu choi (bo qua tran tren neu hien tai la 0).
  IF v_new_rent IS NOT NULL THEN
    IF v_new_rent < 0
       OR (v_c.rent_price > 0 AND v_new_rent > v_c.rent_price * 10) THEN
      RAISE EXCEPTION 'amount_out_of_range' USING ERRCODE = '22023';
    END IF;
  END IF;
  IF v_new_deposit IS NOT NULL THEN
    IF v_new_deposit < 0
       OR (v_c.total_deposit > 0 AND v_new_deposit > v_c.total_deposit * 10) THEN
      RAISE EXCEPTION 'amount_out_of_range' USING ERRCODE = '22023';
    END IF;
  END IF;

  SELECT * INTO v_cust
    FROM public.customers
   WHERE id = v_new_cust
     AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'entity_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_cust.organization_id IS DISTINCT FROM p_organization_id THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;

  -- F6 (review, LOW): dai dien hien tai — dung de doi soat luc thuc thi
  -- (entity_changed_since_preview neu ai do doi dai dien giua chung), VA de
  -- chan som truong hop khach hang moi DA la dai dien (khong lam gi ca).
  SELECT customer_id INTO v_current_rep
    FROM public.contract_customers
   WHERE contract_id = v_contract_id AND is_representative
   LIMIT 1;
  IF v_current_rep IS NOT NULL AND v_current_rep = v_new_cust THEN
    RAISE EXCEPTION 'no_op' USING ERRCODE = '22023';
  END IF;

  v_bld := (SELECT r.building_id FROM public.rooms r WHERE r.id = v_c.room_id);

  SELECT s.org_wide, s.building_ids
    INTO v_scope
    FROM app_private.authorized_scope_v3('contracts.edit', p_organization_id) s;
  IF NOT COALESCE(v_scope.org_wide, false)
     AND (v_bld IS NULL OR NOT (v_bld = ANY(COALESCE(v_scope.building_ids, ARRAY[]::uuid[])))) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;

  IF v_bld IS NOT NULL THEN
    SELECT b.name INTO v_toa FROM public.buildings b WHERE b.id = v_bld;
  END IF;

  v_canonical := jsonb_build_object(
    'organization_id',  p_organization_id,
    'contract_id',       v_contract_id,
    'new_customer_id',    v_new_cust,
    'new_rent_price',     v_new_rent,
    'new_deposit',        v_new_deposit,
    'transfer_date',      v_xfer_date,
    'notes',              v_notes,
    'expected_representative_cu', v_current_rep
  );
  v_nonce := extensions.gen_random_bytes(32);

  INSERT INTO app_private.copilot_write_confirmations
    (nonce_digest, user_id, organization_id, tool, payload_hash,
     permission_key, expires_at)
  VALUES
    (extensions.digest(v_nonce, 'sha256'), v_actor, p_organization_id,
     'contract.chuyen_nhuong', app_private.copilot_payload_hash_v1(v_canonical),
     'contracts.edit', clock_timestamp() + interval '5 minutes');

  RETURN jsonb_build_object(
    'confirmation_nonce', encode(v_nonce, 'hex'),
    'canonical',          v_canonical,
    'preview', jsonb_build_object(
      'toa_nha',        v_toa,
      'so_hop_dong',    COALESCE(v_c.contract_number, left(v_c.id::text, 8)),
      'ten_khach_hang', v_cust.full_name,
      'so_dien_thoai',  v_cust.phone,
      'so_tien',        COALESCE(v_new_rent, v_c.rent_price),
      -- F3 (review, MED): hien CA HAI gia tri (hien tai + de nghi).
      'gia_thue_hien_tai', v_c.rent_price,
      'gia_thue_moi',      COALESCE(v_new_rent, v_c.rent_price),
      'coc_hien_tai',      v_c.total_deposit,
      'coc_moi',           COALESCE(v_new_deposit, v_c.total_deposit),
      'hau_qua',        format(
        'Se nhuong hop dong sang khach hang moi lam dai dien (ha dai dien cu xuong). %s%s',
        CASE WHEN v_new_rent IS NOT NULL AND v_new_rent IS DISTINCT FROM v_c.rent_price
             THEN format('Gia thue GHI DE tu %s thanh %s. ', v_c.rent_price, v_new_rent) ELSE '' END,
        CASE WHEN v_new_deposit IS NOT NULL AND v_new_deposit IS DISTINCT FROM v_c.total_deposit
             THEN format('Coc GHI DE tu %s thanh %s.', v_c.total_deposit, v_new_deposit) ELSE '' END
      )
    )
  );
END
$xem_truoc_contract_chuyen_nhuong$;

COMMENT ON FUNCTION public.copilot_preview_contract_chuyen_nhuong_v1(uuid, jsonb) IS
  'direct_l5_v1 — xem truoc nhuong hop dong (boc transfer_contract). Chan som khach hang moi khac to chuc hoac hop dong khong ACTIVE/EXTENDED.';

REVOKE ALL ON FUNCTION public.copilot_preview_contract_chuyen_nhuong_v1(uuid, jsonb)
  FROM PUBLIC;
DO $quyen_xem_truoc_contract_chuyen_nhuong$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_preview_contract_chuyen_nhuong_v1(uuid, jsonb) FROM anon;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_preview_contract_chuyen_nhuong_v1(uuid, jsonb) FROM service_role;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_preview_contract_chuyen_nhuong_v1(uuid, jsonb) FROM authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_preview_contract_chuyen_nhuong_v1(uuid, jsonb) TO authenticated;
  END IF;
END
$quyen_xem_truoc_contract_chuyen_nhuong$;

-- ---------------------------------------------------------------------------
-- 2. THUC THI
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.copilot_execute_contract_chuyen_nhuong_v1(
  p_confirmation_nonce text,
  p_payload            jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, extensions
AS $thuc_thi_contract_chuyen_nhuong$
DECLARE
  v_actor       uuid := auth.uid();
  v_hash        bytea;
  v_row         app_private.copilot_write_confirmations%ROWTYPE;
  v_snapshot    jsonb;
  v_org         uuid;
  v_contract_id uuid;
  v_new_cust    uuid;
  v_new_rent    numeric;
  v_new_deposit numeric;
  v_xfer_date   date;
  v_notes       text;
  v_key         text;
  v_prev        public.ai_write_audit%ROWTYPE;
  v_before      jsonb;
  v_after       jsonb;
  v_c           public.contracts%ROWTYPE;
  v_ret         uuid;
  v_rep_ok      boolean;
  v_exp_rep_cu     uuid;
  v_rent_before    numeric;
  v_deposit_before numeric;
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
  IF v_row.tool IS DISTINCT FROM 'contract.chuyen_nhuong'
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
    v_org         := (p_payload ->> 'organization_id')::uuid;
    v_contract_id := (p_payload ->> 'contract_id')::uuid;
    v_new_cust    := (p_payload ->> 'new_customer_id')::uuid;
    v_new_rent    := NULLIF(p_payload ->> 'new_rent_price', '')::numeric;
    v_new_deposit := NULLIF(p_payload ->> 'new_deposit', '')::numeric;
    v_xfer_date   := (p_payload ->> 'transfer_date')::date;
    v_notes       := NULLIF(p_payload ->> 'notes', '');
    v_exp_rep_cu  := NULLIF(p_payload ->> 'expected_representative_cu', '')::uuid;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'payload_changed' USING ERRCODE = '42501';
  END;
  IF v_org IS NULL OR v_contract_id IS NULL OR v_new_cust IS NULL OR v_xfer_date IS NULL
     OR v_org IS DISTINCT FROM v_row.organization_id THEN
    RAISE EXCEPTION 'organization_mismatch' USING ERRCODE = '42501';
  END IF;

  -- F1 (review G5-C dot 1, fix round 1): guard L5 DATABASE THAT.
  IF NOT app_private.copilot_l5_plan_context_ok_v1('contract.chuyen_nhuong', v_org) THEN
    RAISE EXCEPTION 'l5_requires_plan' USING ERRCODE = '42501';
  END IF;

  v_snapshot := app_private.copilot_action_gate_v1('contract.chuyen_nhuong', v_org);

  v_key := 'copilot_action:contract.chuyen_nhuong:' || v_actor::text || ':'
        || v_org::text || ':' || encode(v_hash, 'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended(v_key, 0));

  SELECT * INTO v_prev
    FROM public.ai_write_audit a
   WHERE a.idempotency_key = v_key;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'status',       'da_thuc_hien_truoc_do',
      'entity_table', 'contracts',
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

  SELECT * INTO v_c
    FROM public.contracts
   WHERE id = v_contract_id
     AND deleted_at IS NULL
     AND organization_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'entity_not_found' USING ERRCODE = 'P0002';
  END IF;
  -- F6 (review, LOW): dai dien hien tai da doi kể tu luc xem truoc (nguoi khac
  -- vua nhuong hop dong nay) — tu choi thay vi nhuong tren mot gia dinh cu.
  DECLARE
    v_rep_now uuid;
  BEGIN
    SELECT customer_id INTO v_rep_now
      FROM public.contract_customers
     WHERE contract_id = v_contract_id AND is_representative
     LIMIT 1;
    IF v_rep_now IS DISTINCT FROM v_exp_rep_cu THEN
      RAISE EXCEPTION 'entity_changed_since_preview' USING ERRCODE = '55000';
    END IF;
  END;
  v_before := to_jsonb(v_c);
  -- F3 (review, MED): chup gia/coc TRUOC khi goi RPC goc de doi soat readback.
  v_rent_before    := v_c.rent_price;
  v_deposit_before := v_c.total_deposit;

  v_ret := public.transfer_contract(v_contract_id, v_new_cust, v_new_rent, v_new_deposit, v_xfer_date, v_notes);

  -- READBACK — doc lai tu bang, khong tin gia tri tra ve suong.
  SELECT * INTO v_c
    FROM public.contracts
   WHERE id = v_contract_id;
  IF NOT FOUND
     OR v_ret IS DISTINCT FROM v_contract_id
     OR v_c.organization_id IS DISTINCT FROM v_org
     -- F3 (review, MED): rent_price/total_deposit PHAI dung bang canonical.
     OR v_c.rent_price IS DISTINCT FROM COALESCE(v_new_rent, v_rent_before)
     OR v_c.total_deposit IS DISTINCT FROM COALESCE(v_new_deposit, v_deposit_before) THEN
    RAISE EXCEPTION 'copilot_write_readback_mismatch' USING ERRCODE = 'P0001';
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM public.contract_customers cc
     WHERE cc.contract_id = v_contract_id
       AND cc.customer_id = v_new_cust
       AND cc.is_representative
  ) INTO v_rep_ok;
  IF NOT v_rep_ok THEN
    RAISE EXCEPTION 'copilot_write_readback_mismatch' USING ERRCODE = 'P0001';
  END IF;
  v_after := to_jsonb(v_c);

  INSERT INTO public.ai_write_audit
    (user_id, tool, idempotency_key, entity_table, entity_id, payload, organization_id)
  VALUES
    (v_actor, 'contract.chuyen_nhuong', v_key, 'contracts',
     v_contract_id, p_payload, v_org)
  RETURNING id INTO v_audit_id;

  v_ledger_id := app_private.copilot_ledger_append_v1(jsonb_build_object(
    'event',               'action_executed',
    'organization_id',     v_org,
    'action_id',           'contract.chuyen_nhuong',
    'permission_key',      'contracts.edit',
    'permission_snapshot', v_snapshot,
    'consent_kind',        'click',
    'consent_id',          v_row.id,
    'payload_digest',      encode(v_hash, 'hex'),
    'before_digest',       encode(extensions.digest(
                             convert_to(v_before::text, 'UTF8'), 'sha256'), 'hex'),
    'after_digest',        encode(extensions.digest(
                             convert_to(v_after::text, 'UTF8'), 'sha256'), 'hex'),
    'entity_table',        'contracts',
    'entity_id',            v_contract_id,
    'audit_id',             v_audit_id,
    'amount',               v_c.rent_price,
    'outcome',              jsonb_build_object('status', 'da_thuc_hien')
  ));

  RETURN jsonb_build_object(
    'status',       'da_thuc_hien',
    'entity_table', 'contracts',
    'entity_id',    v_contract_id,
    'audit_id',     v_audit_id,
    'ledger_id',    v_ledger_id
  );
END
$thuc_thi_contract_chuyen_nhuong$;

COMMENT ON FUNCTION public.copilot_execute_contract_chuyen_nhuong_v1(text, jsonb) IS
  'direct_l5_v1 — tieu nonce, tu choi neu khong chay trong ke hoach, goi lai transfer_contract, doc lai ep dai dien moi trong contract_customers, ghi ai_write_audit + so hanh dong.';

REVOKE ALL ON FUNCTION public.copilot_execute_contract_chuyen_nhuong_v1(text, jsonb)
  FROM PUBLIC;
DO $quyen_thuc_thi_contract_chuyen_nhuong$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_execute_contract_chuyen_nhuong_v1(text, jsonb) FROM anon;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_execute_contract_chuyen_nhuong_v1(text, jsonb) FROM service_role;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_execute_contract_chuyen_nhuong_v1(text, jsonb) FROM authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_execute_contract_chuyen_nhuong_v1(text, jsonb) TO authenticated;
  END IF;
END
$quyen_thuc_thi_contract_chuyen_nhuong$;

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
  'contract.chuyen_nhuong',
  1,
  'Nhượng hợp đồng cho khách hàng khác',
  'contracts.edit',
  'L5',
  'direct_l5_v1',
  'step_up',
  'copilot_preview_contract_chuyen_nhuong_v1',
  'copilot_execute_contract_chuyen_nhuong_v1',
  'contract_transferred',
  'contracts',
  NULL,
  NULL,
  'Khong tim thay cancel_contract_transfer/undo_transfer_contract tren production (03/09/2026). Muon dao nhuong thi sua tay dai dien trong contract_customers tren giao dien Hop dong theo before_digest cua dong so hanh dong.',
  'contract.chuyen_nhuong',
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
  'action', 'contract.chuyen_nhuong', 'disabled',
  'seed kill switch cho action L5 nhuong hop dong (G5-C3 nhom C) — policy con L4 nen action nay khong the chay ke ca bat co',
  'migration:20260903224412_copilot_action_contract_chuyen_nhuong_v1',
  'migration:20260903224412_copilot_action_contract_chuyen_nhuong_v1'
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
    'public.copilot_preview_contract_chuyen_nhuong_v1(uuid, jsonb)',
    'public.copilot_execute_contract_chuyen_nhuong_v1(text, jsonb)'
  ]
  LOOP
    IF to_regprocedure(v_ten) IS NULL THEN
      v_thieu := v_thieu || v_ten;
    END IF;
  END LOOP;
  IF cardinality(v_thieu) > 0 THEN
    RAISE EXCEPTION 'thieu ham G5-C3 contract_chuyen_nhuong: %', array_to_string(v_thieu, ', ');
  END IF;
  IF to_regprocedure('app_private.copilot_l5_plan_context_ok_v1(text, uuid)') IS NULL THEN
    RAISE EXCEPTION 'copilot_l5_plan_context_ok_v1 missing — 20260903190255 phai chay truoc';
  END IF;
  IF to_regprocedure('public.transfer_contract(uuid, uuid, numeric, numeric, date, text)') IS NULL THEN
    RAISE EXCEPTION 'transfer_contract missing — baseline phai co truoc';
  END IF;

  IF to_regrole('anon') IS NOT NULL THEN
    FOREACH v_ten IN ARRAY ARRAY[
      'public.copilot_preview_contract_chuyen_nhuong_v1(uuid, jsonb)',
      'public.copilot_execute_contract_chuyen_nhuong_v1(text, jsonb)'
    ]
    LOOP
      IF has_function_privilege('anon', to_regprocedure(v_ten)::oid, 'EXECUTE') THEN
        v_ho := v_ho || v_ten;
      END IF;
    END LOOP;
    IF cardinality(v_ho) > 0 THEN
      RAISE EXCEPTION 'anon goi duoc ham G5-C3 contract_chuyen_nhuong: %', array_to_string(v_ho, ', ');
    END IF;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM app_private.copilot_action_registry
     WHERE action_id = 'contract.chuyen_nhuong'
       AND risk = 'L5' AND executor_kind = 'direct_l5_v1' AND consent_required = 'step_up'
       AND permission_key = 'contracts.edit'
       AND grantable = false
       AND rollback_rpc IS NULL
  ) THEN
    RAISE EXCEPTION 'seed registry contract.chuyen_nhuong sai hinh hoac thieu';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.copilot_feature_flags f
     WHERE f.scope = 'action' AND f.contract_id = 'contract.chuyen_nhuong'
  ) THEN
    RAISE EXCEPTION 'copilot_rollout_seed_thieu_action_contract: contract.chuyen_nhuong';
  END IF;
END
$nghiem_thu$;

COMMIT;

NOTIFY pgrst, 'reload schema';
