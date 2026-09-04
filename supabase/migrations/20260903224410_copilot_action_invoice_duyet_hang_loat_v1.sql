-- G5-C3 (1/9, nhom C - tai chinh con lai) - Action L5 `invoice.duyet_hang_loat` theo
-- khuon direct_l5_v1 (xem 20260903190255 cho khuon day du + F1 helper).
--
-- BOC RPC GOC: `bulk_approve_invoices_v1(p_invoice_ids uuid[])` (SECURITY
-- DEFINER, doc production 03/09/2026). Than that:
--   update invoices set status='APPROVED', approved_at=now(), approved_by=actor
--    where id = any(p_invoice_ids) and deleted_at is null and status='DRAFT'
--      and can_edit_invoice_building_v1(building_id)
--   return count(*)
-- Gac quyen THAT la `can_edit_invoice_building_v1` — DUNG khoa voi `invoice.duyet`
-- (G5-C dot 1, 20260903191755) da xac dinh: permission_key='invoices.edit', KHONG
-- phai 'invoices.approve' (khoa do co ton tai trong permission_definitions nhung
-- RPC khong doc no). Lap lai dung quyet dinh cu, khong doan lai.
--
-- RPC GOC LA "IM LANG": khong RAISE khi mot id sai/khac trang thai, chi bo qua
-- (UPDATE ... WHERE khong khop = 0 dong). Vi day la mot HANH DONG AI kich hoat,
-- wrapper CHON FAIL-CLOSED: preview CHOT truoc danh sach id se duyet duoc (dang
-- DRAFT, dung to chuc, dung pham vi toa), canonical mang CA SO LUONG mong doi;
-- execute goi RPC goc roi DOI so duyet duoc THAT (tra ve) phai dung bang so mong
-- doi — lech (ai do vua doi trang thai giua preview va execute) la loi cung,
-- KHONG duyet mot phan trong im lang.
--
-- CAP KICH THUOC — toi da 50 hoa don/lan (brief: "cap ≤50 ids; ≥51 -> 22023
-- bulk_too_large"), cung khuon voi cac action bulk khac cua dot nay.
--
-- READBACK — verify_kind tuy chinh `invoices_approved_count`: khong nam trong
-- CASE dac biet cua engine (chi 'ie_draft'/'approval_request_pending'/
-- 'hold_pending_approval'/'external_effect' moi co nhanh rieng) nen roi vao
-- ELSE (khong bat bien them O TANG ENGINE) — bat bien THAT nam NGAY TRONG wrapper
-- nay: sau khi goi RPC, doc lai TUNG hoa don trong danh sach, doi status='APPROVED'
-- VA approved_at khong NULL VA cung to chuc.
--
-- entity_table/entity_id cho ENGINE (bat buoc 1 hang public.<bang> co id+organization_id):
-- 'invoices', phan tu DAU TIEN cua mang (cung khuon "bulk khong tra entity_id
-- don" da ghi trong bao cao G5-C2).
--
-- HOAN TAC — `unapprove_invoice_v1(uuid)` (da kiem ton tai), nhung CHI NHAN MOT
-- id/lan — nguoi hoan tac phai goi lai TUNG hoa don trong danh sach da duyet
-- (doc tu before_digest/outcome cua dong so). Khong tu dong goi vong lap.
--
-- DUONG LUI CUA MIGRATION — DROP hai ham wrapper; DELETE hang registry
-- `invoice.duyet_hang_loat` va hang co tuong ung.

BEGIN;
SET LOCAL lock_timeout = '15s';

-- ---------------------------------------------------------------------------
-- 0b. HELPER DUNG CHUNG — kiem ngu canh ke hoach THAT (F1, xem 20260903190255).
-- CREATE OR REPLACE lai GIONG HET o day (idempotent-check do TUNG FILE rieng
-- le tren production hien tai, khong cong don cac file khac trong cung phien).
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
CREATE OR REPLACE FUNCTION public.copilot_preview_invoice_duyet_hang_loat_v1(
  p_organization_id uuid,
  p_payload         jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, extensions
AS $xem_truoc_invoice_duyet_hang_loat$
DECLARE
  v_actor      uuid := auth.uid();
  v_snapshot   jsonb;
  v_ids_raw    jsonb;
  v_ids        uuid[];
  v_n          int;
  v_id         uuid;
  v_inv        public.invoices%ROWTYPE;
  v_scope      record;
  v_ok_ids     uuid[] := ARRAY[]::uuid[];
  v_toa_ten    text[] := ARRAY[]::text[];
  v_tong       numeric := 0;
  v_canonical  jsonb;
  v_nonce      bytea;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization_required' USING ERRCODE = '22023';
  END IF;

  v_snapshot := app_private.copilot_action_gate_v1('invoice.duyet_hang_loat', p_organization_id);

  v_ids_raw := p_payload -> 'invoice_ids';
  IF jsonb_typeof(COALESCE(v_ids_raw, 'null'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'payload_invalid' USING ERRCODE = '22023';
  END IF;

  BEGIN
    SELECT array_agg(DISTINCT (e)::uuid) INTO v_ids
      FROM jsonb_array_elements_text(v_ids_raw) e;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'payload_invalid' USING ERRCODE = '22023';
  END;
  v_n := COALESCE(cardinality(v_ids), 0);
  IF v_n < 1 THEN
    RAISE EXCEPTION 'payload_invalid' USING ERRCODE = '22023';
  END IF;
  -- CAP KICH THUOC — bulk_too_large tren >50 id, cung khuon voi cac action
  -- bulk khac cua dot nay (meter_reading.xoa_hang_loat).
  IF v_n > 50 THEN
    RAISE EXCEPTION 'bulk_too_large: % id, toi da 50', v_n USING ERRCODE = '22023';
  END IF;

  SELECT s.org_wide, s.building_ids
    INTO v_scope
    FROM app_private.authorized_scope_v3('invoices.edit', p_organization_id) s;

  FOREACH v_id IN ARRAY v_ids LOOP
    SELECT * INTO v_inv
      FROM public.invoices
     WHERE id = v_id
       AND deleted_at IS NULL
       AND organization_id = p_organization_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'entity_not_found' USING ERRCODE = 'P0002';
    END IF;
    IF v_inv.status IS DISTINCT FROM 'DRAFT' THEN
      RAISE EXCEPTION 'invoice_not_approvable' USING ERRCODE = '55000';
    END IF;
    IF NOT COALESCE(v_scope.org_wide, false)
       AND (v_inv.building_id IS NULL
            OR NOT (v_inv.building_id = ANY(COALESCE(v_scope.building_ids, ARRAY[]::uuid[])))) THEN
      RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
    END IF;
    v_ok_ids := v_ok_ids || v_id;
    v_tong   := v_tong + COALESCE(v_inv.total_amount, 0);
  END LOOP;

  SELECT array_agg(DISTINCT b.name) INTO v_toa_ten
    FROM public.invoices i
    JOIN public.buildings b ON b.id = i.building_id
   WHERE i.id = ANY(v_ok_ids);

  v_canonical := jsonb_build_object(
    'organization_id', p_organization_id,
    'invoice_ids',     to_jsonb(v_ok_ids),
    'expected_count',  v_n
  );
  v_nonce := extensions.gen_random_bytes(32);

  INSERT INTO app_private.copilot_write_confirmations
    (nonce_digest, user_id, organization_id, tool, payload_hash,
     permission_key, expires_at)
  VALUES
    (extensions.digest(v_nonce, 'sha256'), v_actor, p_organization_id,
     'invoice.duyet_hang_loat', app_private.copilot_payload_hash_v1(v_canonical),
     'invoices.edit', clock_timestamp() + interval '5 minutes');

  RETURN jsonb_build_object(
    'confirmation_nonce', encode(v_nonce, 'hex'),
    'canonical',          v_canonical,
    'preview', jsonb_build_object(
      'toa_nha', array_to_string(COALESCE(v_toa_ten, ARRAY[]::text[]), ', '),
      'so_tien', v_tong,
      'hau_qua', format('Se duyet %s hoa don cung luc — status chuyen APPROVED', v_n)
    )
  );
END
$xem_truoc_invoice_duyet_hang_loat$;

COMMENT ON FUNCTION public.copilot_preview_invoice_duyet_hang_loat_v1(uuid, jsonb) IS
  'direct_l5_v1 — xem truoc duyet hang loat hoa don (boc bulk_approve_invoices_v1). Chot truoc danh sach id DRAFT + trong pham vi toa, cap 50 id/lan.';

REVOKE ALL ON FUNCTION public.copilot_preview_invoice_duyet_hang_loat_v1(uuid, jsonb)
  FROM PUBLIC;
DO $quyen_xem_truoc_invoice_duyet_hang_loat$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_preview_invoice_duyet_hang_loat_v1(uuid, jsonb) FROM anon;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_preview_invoice_duyet_hang_loat_v1(uuid, jsonb) FROM service_role;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_preview_invoice_duyet_hang_loat_v1(uuid, jsonb) FROM authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_preview_invoice_duyet_hang_loat_v1(uuid, jsonb) TO authenticated;
  END IF;
END
$quyen_xem_truoc_invoice_duyet_hang_loat$;

-- ---------------------------------------------------------------------------
-- 2. THUC THI
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.copilot_execute_invoice_duyet_hang_loat_v1(
  p_confirmation_nonce text,
  p_payload            jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, extensions
AS $thuc_thi_invoice_duyet_hang_loat$
DECLARE
  v_actor      uuid := auth.uid();
  v_hash       bytea;
  v_row        app_private.copilot_write_confirmations%ROWTYPE;
  v_snapshot   jsonb;
  v_org        uuid;
  v_ids_raw    jsonb;
  v_ids        uuid[];
  v_expected   int;
  v_key        text;
  v_prev       public.ai_write_audit%ROWTYPE;
  v_before     jsonb;
  v_after      jsonb;
  v_tong       numeric;
  v_count      int;
  v_id         uuid;
  v_check_after public.invoices%ROWTYPE;
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
  IF v_row.tool IS DISTINCT FROM 'invoice.duyet_hang_loat'
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
    v_org      := (p_payload ->> 'organization_id')::uuid;
    v_ids_raw  := p_payload -> 'invoice_ids';
    v_expected := (p_payload ->> 'expected_count')::int;
    SELECT array_agg((e)::uuid) INTO v_ids FROM jsonb_array_elements_text(v_ids_raw) e;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'payload_changed' USING ERRCODE = '42501';
  END;
  IF v_org IS NULL OR v_ids IS NULL OR cardinality(v_ids) < 1 OR v_expected IS NULL
     OR cardinality(v_ids) <> v_expected
     OR v_org IS DISTINCT FROM v_row.organization_id THEN
    RAISE EXCEPTION 'organization_mismatch' USING ERRCODE = '42501';
  END IF;
  IF cardinality(v_ids) > 50 THEN
    RAISE EXCEPTION 'bulk_too_large: % id, toi da 50', cardinality(v_ids) USING ERRCODE = '22023';
  END IF;

  -- F1 (review G5-C dot 1, fix round 1): guard L5 DATABASE THAT.
  IF NOT app_private.copilot_l5_plan_context_ok_v1('invoice.duyet_hang_loat', v_org) THEN
    RAISE EXCEPTION 'l5_requires_plan' USING ERRCODE = '42501';
  END IF;

  v_snapshot := app_private.copilot_action_gate_v1('invoice.duyet_hang_loat', v_org);

  v_key := 'copilot_action:invoice.duyet_hang_loat:' || v_actor::text || ':'
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

  -- before_digest — anh chup ca lo TRUOC khi duyet.
  SELECT jsonb_agg(to_jsonb(i) ORDER BY i.id) INTO v_before
    FROM public.invoices i
   WHERE i.id = ANY(v_ids);
  v_before := COALESCE(v_before, '[]'::jsonb);

  v_count := public.bulk_approve_invoices_v1(v_ids);

  -- READBACK — doc lai TUNG hoa don trong danh sach, khong tin so RPC goc tra ve
  -- suong: so RPC tra ve phai KHOP so id yeu cau (fail-closed, khong duyet mot
  -- phan trong im lang), VA tung dong phai that su APPROVED.
  IF v_count IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'bulk_partial_failure: duyet duoc % / % hoa don yeu cau', v_count, v_expected
      USING ERRCODE = '55000';
  END IF;
  FOREACH v_id IN ARRAY v_ids LOOP
    SELECT * INTO v_check_after
      FROM public.invoices
     WHERE id = v_id;
    IF NOT FOUND
       OR v_check_after.organization_id IS DISTINCT FROM v_org
       OR v_check_after.status IS DISTINCT FROM 'APPROVED'
       OR v_check_after.approved_at IS NULL THEN
      RAISE EXCEPTION 'copilot_write_readback_mismatch' USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  SELECT jsonb_agg(to_jsonb(i) ORDER BY i.id) INTO v_after
    FROM public.invoices i
   WHERE i.id = ANY(v_ids);
  -- F7 (review, LOW): tong tien cho so hanh dong - tinh tu v_after (danh sach
  -- THAT vua doc lai), khong can them truong canonical rieng.
  SELECT COALESCE(SUM((e ->> 'total_amount')::numeric), 0) INTO v_tong
    FROM jsonb_array_elements(v_after) e;

  INSERT INTO public.ai_write_audit
    (user_id, tool, idempotency_key, entity_table, entity_id, payload, organization_id)
  VALUES
    (v_actor, 'invoice.duyet_hang_loat', v_key, 'invoices',
     v_ids[1], p_payload, v_org)
  RETURNING id INTO v_audit_id;

  v_ledger_id := app_private.copilot_ledger_append_v1(jsonb_build_object(
    'event',               'action_executed',
    'organization_id',     v_org,
    'action_id',           'invoice.duyet_hang_loat',
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
    'entity_id',            v_ids[1],
    'audit_id',             v_audit_id,
    'amount',               v_tong,
    'outcome',              jsonb_build_object('status', 'da_thuc_hien', 'so_hoa_don_duyet', v_count)
  ));

  RETURN jsonb_build_object(
    'status',       'da_thuc_hien',
    'entity_table', 'invoices',
    'entity_id',    v_ids[1],
    'audit_id',     v_audit_id,
    'ledger_id',    v_ledger_id
  );
END
$thuc_thi_invoice_duyet_hang_loat$;

COMMENT ON FUNCTION public.copilot_execute_invoice_duyet_hang_loat_v1(text, jsonb) IS
  'direct_l5_v1 — tieu nonce, tu choi neu khong chay trong ke hoach, goi lai bulk_approve_invoices_v1, doi so duyet duoc khop expected_count VA tung hoa don that su APPROVED (fail-closed), ghi ai_write_audit + so hanh dong.';

REVOKE ALL ON FUNCTION public.copilot_execute_invoice_duyet_hang_loat_v1(text, jsonb)
  FROM PUBLIC;
DO $quyen_thuc_thi_invoice_duyet_hang_loat$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_execute_invoice_duyet_hang_loat_v1(text, jsonb) FROM anon;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_execute_invoice_duyet_hang_loat_v1(text, jsonb) FROM service_role;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_execute_invoice_duyet_hang_loat_v1(text, jsonb) FROM authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_execute_invoice_duyet_hang_loat_v1(text, jsonb) TO authenticated;
  END IF;
END
$quyen_thuc_thi_invoice_duyet_hang_loat$;

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
  'invoice.duyet_hang_loat',
  1,
  'Duyệt hàng loạt hoá đơn',
  'invoices.edit',
  'L5',
  'direct_l5_v1',
  'step_up',
  'copilot_preview_invoice_duyet_hang_loat_v1',
  'copilot_execute_invoice_duyet_hang_loat_v1',
  'invoices_approved_count',
  'invoices',
  NULL,
  'unapprove_invoice_v1',
  'Goi lai unapprove_invoice_v1(uuid) TUNG hoa don mot trong danh sach da duyet (doc tu entity_id/outcome cua dong so hanh dong). Khong tu dong goi vong lap.',
  'invoice.duyet_hang_loat',
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
  'action', 'invoice.duyet_hang_loat', 'disabled',
  'seed kill switch cho action L5 duyet hang loat hoa don (G5-C3 nhom C) — policy con L4 nen action nay khong the chay ke ca bat co',
  'migration:20260903224410_copilot_action_invoice_duyet_hang_loat_v1',
  'migration:20260903224410_copilot_action_invoice_duyet_hang_loat_v1'
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
    'public.copilot_preview_invoice_duyet_hang_loat_v1(uuid, jsonb)',
    'public.copilot_execute_invoice_duyet_hang_loat_v1(text, jsonb)'
  ]
  LOOP
    IF to_regprocedure(v_ten) IS NULL THEN
      v_thieu := v_thieu || v_ten;
    END IF;
  END LOOP;
  IF cardinality(v_thieu) > 0 THEN
    RAISE EXCEPTION 'thieu ham G5-C3 invoice_duyet_hang_loat: %', array_to_string(v_thieu, ', ');
  END IF;
  IF to_regprocedure('app_private.copilot_l5_plan_context_ok_v1(text, uuid)') IS NULL THEN
    RAISE EXCEPTION 'copilot_l5_plan_context_ok_v1 missing — 20260903190255 phai chay truoc';
  END IF;
  IF to_regprocedure('public.bulk_approve_invoices_v1(uuid[])') IS NULL THEN
    RAISE EXCEPTION 'bulk_approve_invoices_v1 missing — baseline phai co truoc';
  END IF;
  IF to_regprocedure('public.unapprove_invoice_v1(uuid)') IS NULL THEN
    RAISE EXCEPTION 'unapprove_invoice_v1 missing — rollback_rpc phai ton tai that';
  END IF;

  IF to_regrole('anon') IS NOT NULL THEN
    FOREACH v_ten IN ARRAY ARRAY[
      'public.copilot_preview_invoice_duyet_hang_loat_v1(uuid, jsonb)',
      'public.copilot_execute_invoice_duyet_hang_loat_v1(text, jsonb)'
    ]
    LOOP
      IF has_function_privilege('anon', to_regprocedure(v_ten)::oid, 'EXECUTE') THEN
        v_ho := v_ho || v_ten;
      END IF;
    END LOOP;
    IF cardinality(v_ho) > 0 THEN
      RAISE EXCEPTION 'anon goi duoc ham G5-C3 invoice_duyet_hang_loat: %', array_to_string(v_ho, ', ');
    END IF;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM app_private.copilot_action_registry
     WHERE action_id = 'invoice.duyet_hang_loat'
       AND risk = 'L5' AND executor_kind = 'direct_l5_v1' AND consent_required = 'step_up'
       AND permission_key = 'invoices.edit'
       AND grantable = false
       AND rollback_rpc = 'unapprove_invoice_v1'
  ) THEN
    RAISE EXCEPTION 'seed registry invoice.duyet_hang_loat sai hinh hoac thieu';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.copilot_feature_flags f
     WHERE f.scope = 'action' AND f.contract_id = 'invoice.duyet_hang_loat'
  ) THEN
    RAISE EXCEPTION 'copilot_rollout_seed_thieu_action_contract: invoice.duyet_hang_loat';
  END IF;
END
$nghiem_thu$;

COMMIT;

NOTIFY pgrst, 'reload schema';
