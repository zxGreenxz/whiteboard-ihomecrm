-- G5-C (8/8, dot 1) — Action L5 `customer.xoa_mem` theo khuon direct_l5_v1.
--
-- BOC RPC GOC CO SAN: `soft_delete_customer(p_customer_id uuid)` (SECURITY
-- DEFINER, doc production 03/09/2026 — `search_path = 'public'` CHUA, khong
-- co `app_private`/`extensions`). Quyen KHONG di qua
-- `authorize_tenant_action_v3`/`can_do_on_building` nhu moi RPC khac trong dot
-- nay — no chi kiem `(customers.user_id = auth.uid() OR is_super_admin())`
-- ngay tren hang UPDATE. Wrapper goi NGUYEN VEN, cung phien `auth.uid()`.
--
-- ⚠ CANH BAO BAO MAT DA VA — `anon` dang CO the goi RPC nay tren production
-- (kiem bang `has_function_privilege('anon', ..., 'EXECUTE')` = true, doc
-- 03/09/2026). Doc `pg_proc.proacl` cho thay HAI DUONG: mot hang PUBLIC
-- (`=X/postgres`) VA mot hang rieng cho anon (`anon=X/postgres`) — chi revoke
-- tu anon la KHONG DU, van con lo qua duong PUBLIC (moi role deu la thanh
-- vien ngam cua PUBLIC). Muc 0 duoi day REVOKE EXECUTE cua CA HAI (anon +
-- PUBLIC) tren chinh `soft_delete_customer(uuid)` — khong lien quan gi toi
-- wrapper Copilot, day la mot lo tren RPC GOC da co san.
-- `authenticated`/`service_role` GIU nguyen (chung giu grant TRUC TIEP cua
-- rieng minh, khong di qua PUBLIC — revoke PUBLIC khong dung toi chung).
--
-- QUYET DINH LECH BRIEF, CO GHI LAI — RPC goc KHONG dung `authorized_scope_v3`
-- nen khong co khai niem "pham vi toa" cho hanh dong nay (`customers` khong
-- co cot `building_id`). Wrapper VAN dat `permission_key='customers.delete'`
-- lam bo loc SOM o `copilot_action_gate_v1` — day la dieu kien THEM, CHAT HON
-- RPC goc (an toan, khong noi rong): mot nguoi khong co scope 'customers.
-- delete' nao trong to chuc se bi wrapper chan truoc ca khi cham RPC goc,
-- ke ca khi ho la `user_id` cua khach hang do (RPC goc se cho qua). Nguoc
-- lai, quyen THAT SU (chu khach hoac super admin) van do CHINH RPC goc quyet
-- dinh — wrapper khong noi rong no.
--
-- Dong co ke hoach da mang nhanh `direct_l5_v1` tu migration `20260903190255`.
--
-- READBACK — `verify_kind='readback'` trong registry. Ben trong wrapper cua
-- CHINH minh van tu kiem `deleted_at IS NOT NULL` sau khi goi (doc lai KHONG
-- loc deleted_at, cung khuon voi `invoice.xoa_mem`).
--
-- HOAN TAC — KHONG co RPC lui trong baseline hien tai. Muon khoi phuc phai
-- sua thang `deleted_at = NULL` qua console/RPC restore neu sau nay co, hoac
-- lien he quan tri he thong.
--
-- DUONG LUI CUA MIGRATION — DROP hai ham wrapper; DELETE hang registry
-- `customer.xoa_mem` va hang co tuong ung. (KHONG hoan lai GRANT anon tren
-- `soft_delete_customer` — do la vá bảo mật, không phải một phần logic đảo
-- được của action nay.)

BEGIN;
SET LOCAL lock_timeout = '15s';

-- ---------------------------------------------------------------------------
-- 0. VA BAO MAT — REVOKE anon tren RPC GOC (khong lien quan wrapper)
-- ---------------------------------------------------------------------------
DO $va_anon_soft_delete_customer$
BEGIN
  -- Ham nay ke thua ACL "cu": ca hang PUBLIC (`=X/postgres`) LAN mot hang rieng
  -- cho anon (`anon=X/postgres`) cung ton tai tren proacl (kiem bang pg_proc
  -- 03/09/2026). Chi REVOKE tu anon la KHONG DU — anon van goi duoc qua duong
  -- PUBLIC. Phai revoke CA HAI. Revoke PUBLIC khong dung cham toi grant rieng
  -- cua authenticated/service_role (chung giu grant truc tiep cua chinh minh).
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.soft_delete_customer(uuid) FROM anon;
  END IF;
  REVOKE ALL ON FUNCTION public.soft_delete_customer(uuid) FROM PUBLIC;
END
$va_anon_soft_delete_customer$;

-- ---------------------------------------------------------------------------
-- 0b. HELPER DUNG CHUNG — kiem ngu canh ke hoach THAT (F1, review G5-C dot 1)
-- ---------------------------------------------------------------------------
-- Dinh nghia o MIGRATION DAU TIEN cua dot (nay); bay migration con lai CREATE
-- OR REPLACE lai GIONG HET (idempotent) de moi file van tu chay duoc rieng le
-- khi cong cu idempotent-check do TUNG FILE tren production HIEN TAI (khong
-- cong don cac file dry-run khac trong cung phien — xem chu thich cung khuon
-- o cac migration sau).
--
-- Truoc fix nay, execute cua tam action chi kiem "marker co mat hay khong"
-- (current_setting(...) khac rong) — mot actor CO THE tu dat
-- set_config('app.copilot_plan_context', '<uuid bat ky>:1', true) roi goi
-- thang execute_rpc ma khong can mot ke hoach APPROVED nao THAT SU ton tai.
-- Helper nay doi mot HANG THAT trong app_private.copilot_plans/
-- copilot_plan_steps khop CA NAM dieu kien: dung plan, dung buoc, dung nguoi,
-- dung to chuc, dung action_id.
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
-- 1. XEM TRUOC
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.copilot_preview_customer_xoa_mem_v1(
  p_organization_id uuid,
  p_payload         jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, extensions
AS $xem_truoc_customer_xoa_mem$
DECLARE
  v_actor      uuid := auth.uid();
  v_snapshot   jsonb;
  v_cust_id    uuid;
  v_cust       public.customers%ROWTYPE;
  v_so_hd_song integer;
  v_nonce      bytea;
  v_canonical  jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization_required' USING ERRCODE = '22023';
  END IF;

  v_snapshot := app_private.copilot_action_gate_v1('customer.xoa_mem', p_organization_id);

  BEGIN
    v_cust_id := (p_payload ->> 'customer_id')::uuid;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'payload_invalid' USING ERRCODE = '22023';
  END;
  IF v_cust_id IS NULL THEN
    RAISE EXCEPTION 'payload_invalid' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_cust
    FROM public.customers
   WHERE id = v_cust_id
     AND deleted_at IS NULL
     AND organization_id = p_organization_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'entity_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- Cung dieu kien RPC goc doi, nhung doc SOM: chan mot yeu cau chac chan hong
  -- truoc khi dot nonce.
  SELECT count(*) INTO v_so_hd_song
    FROM public.contract_customers cc
    JOIN public.contracts c ON c.id = cc.contract_id
   WHERE cc.customer_id = v_cust_id
     AND c.status = 'ACTIVE'
     AND c.deleted_at IS NULL;
  IF v_so_hd_song > 0 THEN
    RAISE EXCEPTION 'customer_has_active_contract' USING ERRCODE = '55000';
  END IF;

  -- RPC goc chi cho phep CHU khach hang (`user_id`) hoac super admin — khong
  -- di qua authorized_scope_v3. Kiem SOM o day de xem-truoc khong dua ra mot
  -- nonce cho mot yeu cau chac chan bi RPC goc tu choi.
  IF v_cust.user_id IS DISTINCT FROM v_actor AND NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;

  v_canonical := jsonb_build_object(
    'organization_id', p_organization_id,
    'customer_id',     v_cust_id
  );
  v_nonce := extensions.gen_random_bytes(32);

  INSERT INTO app_private.copilot_write_confirmations
    (nonce_digest, user_id, organization_id, tool, payload_hash,
     permission_key, expires_at)
  VALUES
    (extensions.digest(v_nonce, 'sha256'), v_actor, p_organization_id,
     'customer.xoa_mem', app_private.copilot_payload_hash_v1(v_canonical),
     'customers.delete', clock_timestamp() + interval '5 minutes');

  RETURN jsonb_build_object(
    'confirmation_nonce', encode(v_nonce, 'hex'),
    'canonical',          v_canonical,
    'preview', jsonb_build_object(
      'ten_khach_hang', v_cust.full_name,
      'so_dien_thoai',  v_cust.phone,
      'trang_thai_hien_tai', v_cust.status,
      'hau_qua',        'Se XOA MEM khach hang — khong the khoi phuc qua Copilot, chi qua quan tri he thong'
    )
  );
END
$xem_truoc_customer_xoa_mem$;

COMMENT ON FUNCTION public.copilot_preview_customer_xoa_mem_v1(uuid, jsonb) IS
  'direct_l5_v1 — xem truoc xoa mem khach hang (boc soft_delete_customer). Chan som khach con hop dong ACTIVE hoac nguoi goi khong phai chu/super admin.';

REVOKE ALL ON FUNCTION public.copilot_preview_customer_xoa_mem_v1(uuid, jsonb)
  FROM PUBLIC;
DO $quyen_xem_truoc_customer_xoa_mem$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_preview_customer_xoa_mem_v1(uuid, jsonb) FROM anon;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_preview_customer_xoa_mem_v1(uuid, jsonb) FROM service_role;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_preview_customer_xoa_mem_v1(uuid, jsonb) FROM authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_preview_customer_xoa_mem_v1(uuid, jsonb) TO authenticated;
  END IF;
END
$quyen_xem_truoc_customer_xoa_mem$;

-- ---------------------------------------------------------------------------
-- 2. THUC THI
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.copilot_execute_customer_xoa_mem_v1(
  p_confirmation_nonce text,
  p_payload            jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, extensions
AS $thuc_thi_customer_xoa_mem$
DECLARE
  v_actor     uuid := auth.uid();
  v_hash      bytea;
  v_row       app_private.copilot_write_confirmations%ROWTYPE;
  v_snapshot  jsonb;
  v_org       uuid;
  v_cust_id   uuid;
  v_key       text;
  v_prev      public.ai_write_audit%ROWTYPE;
  v_before    jsonb;
  v_after     jsonb;
  v_cust      public.customers%ROWTYPE;
  v_audit_id  uuid;
  v_ledger_id uuid;
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
  IF v_row.tool IS DISTINCT FROM 'customer.xoa_mem'
     OR v_row.permission_key IS DISTINCT FROM 'customers.delete' THEN
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
    v_cust_id := (p_payload ->> 'customer_id')::uuid;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'payload_changed' USING ERRCODE = '42501';
  END;
  IF v_org IS NULL OR v_cust_id IS NULL
     OR v_org IS DISTINCT FROM v_row.organization_id THEN
    RAISE EXCEPTION 'organization_mismatch' USING ERRCODE = '42501';
  END IF;

  -- F1 (review G5-C dot 1, fix round 1): guard L5 KHONG con la kiem
  -- "marker co mat hay khong" don thuan -- no la mot cau hoi DATABASE THAT:
  -- dung co dang co mot ke hoach APPROVED, dung buoc PENDING, dung nguoi, dung
  -- to chuc, dung action_id hay khong. Ca hai chu ky (parse + tra bang) nam
  -- trong MOT helper dung chung (app_private.copilot_l5_plan_context_ok_v1),
  -- dinh nghia o migration dau tien cua dot va CREATE OR REPLACE lai giong het
  -- o day (idempotent -- xem chu thich canh dinh nghia helper phia duoi).
  IF NOT app_private.copilot_l5_plan_context_ok_v1('customer.xoa_mem', v_org) THEN
    RAISE EXCEPTION 'l5_requires_plan' USING ERRCODE = '42501';
  END IF;

  v_snapshot := app_private.copilot_action_gate_v1('customer.xoa_mem', v_org);

  v_key := 'copilot_action:customer.xoa_mem:' || v_actor::text || ':'
        || v_org::text || ':' || encode(v_hash, 'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended(v_key, 0));

  SELECT * INTO v_prev
    FROM public.ai_write_audit a
   WHERE a.idempotency_key = v_key;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'status',       'da_thuc_hien_truoc_do',
      'entity_table', 'customers',
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

  SELECT * INTO v_cust
    FROM public.customers
   WHERE id = v_cust_id
     AND deleted_at IS NULL
     AND organization_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'entity_not_found' USING ERRCODE = 'P0002';
  END IF;
  v_before := to_jsonb(v_cust);

  BEGIN
    PERFORM public.soft_delete_customer(v_cust_id);
  EXCEPTION WHEN others THEN
    -- F2 (review G5-C dot 1, fix round 1): KHONG ghi 'action_failed' o day.
    -- Nhanh nay LUON bi cuon nguoc: goi truc tiep (ngoai ke hoach) da bi chan
    -- tu F1 phia tren, va goi qua ke hoach thi than ham nay chay BEN TRONG
    -- mot BEGIN/EXCEPTION khac cua chinh engine (TANG (3) cua
    -- copilot_plan_execute_step_v1) -- savepoint ngam cua khoi do cuon lai MOI
    -- thu ben trong no khi RAISE, ke ca mot INSERT vao so vua chay o day. Dong
    -- 'step_failed'/'step_blocked' SONG DUY NHAT do CHINH engine ghi o giao
    -- dich NGOAI, sau khi da rollback ve savepoint do. RAISE lai de engine bat
    -- duoc va ghi dung dong do.
    RAISE;
  END;

  -- READBACK — doc lai KHONG loc deleted_at: hang vua xoa mem CHINH la ket
  -- qua mong doi.
  SELECT * INTO v_cust
    FROM public.customers
   WHERE id = v_cust_id;
  IF NOT FOUND
     OR v_cust.organization_id IS DISTINCT FROM v_org THEN
    RAISE EXCEPTION 'copilot_write_readback_mismatch' USING ERRCODE = 'P0001';
  END IF;
  IF v_cust.deleted_at IS NULL THEN
    RAISE EXCEPTION 'copilot_draft_invariant_violation' USING ERRCODE = 'P0001';
  END IF;
  v_after := to_jsonb(v_cust);

  INSERT INTO public.ai_write_audit
    (user_id, tool, idempotency_key, entity_table, entity_id, payload, organization_id)
  VALUES
    (v_actor, 'customer.xoa_mem', v_key, 'customers',
     v_cust.id, p_payload, v_org)
  RETURNING id INTO v_audit_id;

  v_ledger_id := app_private.copilot_ledger_append_v1(jsonb_build_object(
    'event',               'action_executed',
    'organization_id',     v_org,
    'action_id',           'customer.xoa_mem',
    'permission_key',      'customers.delete',
    'permission_snapshot', v_snapshot,
    'consent_kind',        'click',
    'consent_id',          v_row.id,
    'payload_digest',      encode(v_hash, 'hex'),
    'before_digest',       encode(extensions.digest(
                             convert_to(v_before::text, 'UTF8'), 'sha256'), 'hex'),
    'after_digest',        encode(extensions.digest(
                             convert_to(v_after::text, 'UTF8'), 'sha256'), 'hex'),
    'entity_table',        'customers',
    'entity_id',            v_cust.id,
    'audit_id',             v_audit_id,
    'outcome',              jsonb_build_object('status', 'da_thuc_hien')
  ));

  RETURN jsonb_build_object(
    'status',       'da_thuc_hien',
    'entity_table', 'customers',
    'entity_id',    v_cust.id,
    'audit_id',     v_audit_id,
    'ledger_id',    v_ledger_id
  );
END
$thuc_thi_customer_xoa_mem$;

COMMENT ON FUNCTION public.copilot_execute_customer_xoa_mem_v1(text, jsonb) IS
  'direct_l5_v1 — tieu nonce, tu choi neu khong chay trong mot ke hoach, goi lai soft_delete_customer, doc lai (khong loc deleted_at) de ep deleted_at IS NOT NULL, ghi ai_write_audit + so hanh dong.';

REVOKE ALL ON FUNCTION public.copilot_execute_customer_xoa_mem_v1(text, jsonb)
  FROM PUBLIC;
DO $quyen_thuc_thi_customer_xoa_mem$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_execute_customer_xoa_mem_v1(text, jsonb) FROM anon;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_execute_customer_xoa_mem_v1(text, jsonb) FROM service_role;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_execute_customer_xoa_mem_v1(text, jsonb) FROM authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_execute_customer_xoa_mem_v1(text, jsonb) TO authenticated;
  END IF;
END
$quyen_thuc_thi_customer_xoa_mem$;

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
  'customer.xoa_mem',
  1,
  'Xoá mềm khách hàng',
  'customers.delete',
  'L5',
  'direct_l5_v1',
  'step_up',
  'copilot_preview_customer_xoa_mem_v1',
  'copilot_execute_customer_xoa_mem_v1',
  'readback',
  'customers',
  'customers',
  NULL,
  'Khong co RPC lui trong baseline hien tai. Khoi phuc phai sua thang deleted_at=NULL qua console/RPC restore neu sau nay co, hoac lien he quan tri he thong.',
  'customer.xoa_mem',
  true,
  false
)
ON CONFLICT (action_id) DO NOTHING;

SELECT set_config('app.copilot_feature_flag_transition', 'v2', true);

INSERT INTO public.copilot_feature_flags (
  scope, contract_id, state, reason, evidence_link, rollback_reference
)
VALUES (
  'action', 'customer.xoa_mem', 'disabled',
  'seed kill switch cho action L5 xoa mem khach hang (G5-C dot 1) — policy con L4 nen action nay khong the chay ke ca bat co',
  'migration:20260903192942_copilot_action_customer_xoa_mem_v1',
  'migration:20260903192942_copilot_action_customer_xoa_mem_v1'
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
    'public.copilot_preview_customer_xoa_mem_v1(uuid, jsonb)',
    'public.copilot_execute_customer_xoa_mem_v1(text, jsonb)'
  ]
  LOOP
    IF to_regprocedure(v_ten) IS NULL THEN
      v_thieu := v_thieu || v_ten;
    END IF;
  END LOOP;
  IF cardinality(v_thieu) > 0 THEN
    RAISE EXCEPTION 'thieu ham G5-C customer_xoa_mem: %', array_to_string(v_thieu, ', ');
  END IF;
  IF to_regprocedure('app_private.copilot_l5_plan_context_ok_v1(text, uuid)') IS NULL THEN
    RAISE EXCEPTION 'copilot_l5_plan_context_ok_v1 missing — muc 0b cua migration nay chua chay dung';
  END IF;

  IF to_regprocedure('public.soft_delete_customer(uuid)') IS NULL THEN
    RAISE EXCEPTION 'soft_delete_customer missing — baseline phai co truoc';
  END IF;

  -- Vá bảo mật muc 0: anon KHONG con goi duoc RPC GOC nua.
  IF to_regrole('anon') IS NOT NULL
     AND has_function_privilege('anon', 'public.soft_delete_customer(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon van goi duoc public.soft_delete_customer — va bao mat muc 0 chua chay dung';
  END IF;

  IF to_regrole('anon') IS NOT NULL THEN
    FOREACH v_ten IN ARRAY ARRAY[
      'public.copilot_preview_customer_xoa_mem_v1(uuid, jsonb)',
      'public.copilot_execute_customer_xoa_mem_v1(text, jsonb)'
    ]
    LOOP
      IF has_function_privilege('anon', to_regprocedure(v_ten)::oid, 'EXECUTE') THEN
        v_ho := v_ho || v_ten;
      END IF;
    END LOOP;
    IF cardinality(v_ho) > 0 THEN
      RAISE EXCEPTION 'anon goi duoc ham G5-C customer_xoa_mem: %', array_to_string(v_ho, ', ');
    END IF;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM app_private.copilot_action_registry
     WHERE action_id = 'customer.xoa_mem'
       AND risk = 'L5' AND executor_kind = 'direct_l5_v1' AND consent_required = 'step_up'
       AND permission_key = 'customers.delete'
       AND grantable = false
       AND rollback_rpc IS NULL
       AND btrim(COALESCE(rollback_note, '')) <> ''
  ) THEN
    RAISE EXCEPTION 'seed registry customer.xoa_mem sai hinh hoac thieu';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.copilot_feature_flags f
     WHERE f.scope = 'action' AND f.contract_id = 'customer.xoa_mem'
  ) THEN
    RAISE EXCEPTION 'copilot_rollout_seed_thieu_action_contract: customer.xoa_mem';
  END IF;
END
$nghiem_thu$;

COMMIT;

NOTIFY pgrst, 'reload schema';
