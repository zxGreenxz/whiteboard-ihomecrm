-- Finance V2 — Hotfix 7s: a86 ĐÈ source_payload_hash làm vỡ claim của writer v1.
--
-- PROD (NATHAN tạo phiếu chi chờ-duyệt): create_income_expense_v1 reserve op
-- create_draft.v1 với payload_hash, INSERT phiếu (source_payload_hash = hash đó),
-- rồi claim đối chiếu row.source_payload_hash == op.payload_hash. Trigger a86
-- (20260723230000) chạy BEFORE INSERT thấy phiếu UNAPPROVED chưa birth và ĐÈ
-- source_payload_hash = md5('birth:'||id) ⇒ claim lệch hash ⇒ P0002
-- "no matching in-progress canonical operation" ⇒ user tạo phiếu CHỜ DUYỆT qua
-- đường canonical vỡ hoàn toàn (phiếu tự-duyệt-khi-sinh không dính vì a86 chỉ
-- đụng UNAPPROVED).
--
-- Fix: khai sinh TÔN TRỌNG hash có sẵn — op birth ghi CHÍNH hash của writer
-- (boundary V2 về sau so op.payload_hash == row.source_payload_hash vẫn khớp);
-- chỉ phiếu compat/legacy (chưa có hash) mới nhận hash 'birth:'.

BEGIN;

-- (1) register_birth nhận hash tuỳ chọn. Đổi signature ⇒ DROP bản cũ (chỉ a86
--     và backfill-một-lần của 230000 từng gọi).
DROP FUNCTION IF EXISTS app_private.finance_v2_register_birth_v1(uuid, uuid, uuid, text);
CREATE FUNCTION app_private.finance_v2_register_birth_v1(
  p_org uuid, p_voucher uuid, p_actor_user uuid, p_outcome text,
  p_hash text DEFAULT NULL
)
RETURNS TABLE (birth_txid xid8, payload_hash text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $fn$
DECLARE
  v_membership uuid;
  v_hash text := COALESCE(p_hash, md5('birth:' || p_voucher::text));
BEGIN
  SELECT m.id INTO v_membership FROM public.organization_memberships m
  WHERE m.user_id = p_actor_user AND m.organization_id = p_org LIMIT 1;

  INSERT INTO app_private.canonical_write_operations (
    organization_id, operation, subject_scope, actor_id, idempotency_key,
    payload_hash, subject_id, actor_membership_id, transaction_id,
    response_payload, completed_at, outcome_kind
  ) VALUES (
    p_org, 'income_expense.create.v2', p_voucher::text, p_actor_user,
    'birth:' || p_voucher::text, v_hash, p_voucher, v_membership,
    pg_current_xact_id(), jsonb_build_object('birth', true, 'kind', p_outcome),
    now(), p_outcome
  )
  ON CONFLICT (organization_id, operation, subject_scope, actor_id, idempotency_key)
  DO NOTHING;

  RETURN QUERY
  SELECT o.transaction_id, o.payload_hash
  FROM app_private.canonical_write_operations o
  WHERE o.organization_id = p_org AND o.operation = 'income_expense.create.v2'
    AND o.subject_id = p_voucher
  LIMIT 1;
END
$fn$;
REVOKE ALL ON FUNCTION app_private.finance_v2_register_birth_v1(uuid, uuid, uuid, text, text)
  FROM PUBLIC, anon, authenticated, service_role;

-- (2) a86: GIỮ hash writer nếu đã có; op birth ghi đúng hash đó.
CREATE OR REPLACE FUNCTION app_private.finance_v2_birth_provenance_bridge()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $fn$
DECLARE
  v_txid xid8;
  v_hash text;
BEGIN
  IF NEW.approval_status = 'UNAPPROVED' AND NEW.birth_operation_id IS NULL THEN
    IF NEW.id IS NULL THEN
      NEW.id := gen_random_uuid();
    END IF;
    SELECT b.birth_txid, b.payload_hash INTO v_txid, v_hash
    FROM app_private.finance_v2_register_birth_v1(
      NEW.organization_id, NEW.id, COALESCE(auth.uid(), NEW.user_id),
      'BIRTH_BRIDGE', NEW.source_payload_hash) b;
    NEW.birth_operation_id := NEW.id;
    NEW.birth_txid := v_txid;
    -- KHÔNG đè hash writer canonical (claim v1 đối chiếu nó với op reserve).
    NEW.source_payload_hash := COALESCE(NEW.source_payload_hash, v_hash);
  END IF;
  RETURN NEW;
END
$fn$;

-- (3) Smoke in-transaction: phiếu UNAPPROVED CÓ hash sẵn phải GIỮ NGUYÊN hash
--     và op birth mang đúng hash đó; phiếu không hash nhận hash 'birth:'.
DO $smoke$
DECLARE
  v_building uuid;
  v_id1 uuid; v_id2 uuid;
  v_h1 text := md5('writer-hash-smoke');
  v_row record;
BEGIN
  SELECT id INTO v_building FROM public.buildings
  WHERE organization_id='dddd0000-0000-4000-8000-000000000001'
    AND name ILIKE '%DEMO A%' AND deleted_at IS NULL LIMIT 1;

  INSERT INTO public.income_expenses
    (organization_id, user_id, code, type, name, building_id, voucher_date,
     total_amount, approval_status, source_payload_hash)
  VALUES
    ('dddd0000-0000-4000-8000-000000000001',
     '90450d5f-29b6-4897-bdef-cdb5fb53f339',
     'SMK7S1-'||floor(extract(epoch from clock_timestamp()))::text,
     'EXPENSE', '[SMOKE 7s] keep hash', v_building, CURRENT_DATE, 1000,
     'UNAPPROVED', v_h1)
  RETURNING id INTO v_id1;

  SELECT ie.source_payload_hash AS row_hash, o.payload_hash AS op_hash INTO v_row
  FROM public.income_expenses ie
  JOIN app_private.canonical_write_operations o
    ON o.subject_id = ie.id AND o.operation='income_expense.create.v2'
  WHERE ie.id = v_id1;
  IF v_row.row_hash IS DISTINCT FROM v_h1 OR v_row.op_hash IS DISTINCT FROM v_h1 THEN
    RAISE EXCEPTION 'smoke 7s: hash writer bị đè (row=%, op=%)', v_row.row_hash, v_row.op_hash;
  END IF;

  INSERT INTO public.income_expenses
    (organization_id, user_id, code, type, name, building_id, voucher_date,
     total_amount, approval_status)
  VALUES
    ('dddd0000-0000-4000-8000-000000000001',
     '90450d5f-29b6-4897-bdef-cdb5fb53f339',
     'SMK7S2-'||floor(extract(epoch from clock_timestamp()))::text,
     'EXPENSE', '[SMOKE 7s] birth hash', v_building, CURRENT_DATE, 1000,
     'UNAPPROVED')
  RETURNING id INTO v_id2;
  IF (SELECT source_payload_hash FROM public.income_expenses WHERE id=v_id2)
     IS DISTINCT FROM md5('birth:'||v_id2::text) THEN
    RAISE EXCEPTION 'smoke 7s: phiếu không hash phải nhận hash birth';
  END IF;

  UPDATE public.income_expenses SET approval_status='CANCELLED', deleted_at=now()
  WHERE id IN (v_id1, v_id2);
  RAISE NOTICE 'birth-preserve-hash smoke OK';
END
$smoke$;

COMMIT;

NOTIFY pgrst, 'reload schema';
