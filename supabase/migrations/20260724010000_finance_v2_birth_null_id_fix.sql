-- Finance V2 — Hotfix 7m: a86 birth bridge vỡ khi INSERT nêu id NULL tường minh.
--
-- E2E spec finance-v2 bắt được: ie_compat_insert_v2 (INSERT ... (id, ...) VALUES
-- (NULL, ...)) ⇒ DEFAULT gen_random_uuid() KHÔNG áp ⇒ trong BEFORE-trigger a86
-- NEW.id còn NULL ⇒ register_birth(subject NULL) ⇒ canonical_write_operations
-- 23502 subject_scope NULL ⇒ MỌI phiếu tạo qua compat lỗi 400 (regression từ
-- 20260723230000 — form tạo phiếu của user thường vỡ).
--
-- Fix: a86 tự cấp id khi NULL trước khi khai sinh (id vẫn do server sinh).

BEGIN;

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
    -- Writer nêu id NULL tường minh (compat) → DEFAULT không áp: server tự sinh.
    IF NEW.id IS NULL THEN
      NEW.id := gen_random_uuid();
    END IF;
    SELECT b.birth_txid, b.payload_hash INTO v_txid, v_hash
    FROM app_private.finance_v2_register_birth_v1(
      NEW.organization_id, NEW.id, COALESCE(auth.uid(), NEW.user_id), 'BIRTH_BRIDGE') b;
    NEW.birth_operation_id := NEW.id;
    NEW.birth_txid := v_txid;
    NEW.source_payload_hash := v_hash;
  END IF;
  RETURN NEW;
END
$fn$;

-- Smoke in-transaction: INSERT nêu id NULL tường minh phải sống và có khai sinh.
DO $smoke$
DECLARE
  v_id uuid;
  v_building uuid;
BEGIN
  SELECT id INTO v_building FROM public.buildings
  WHERE organization_id='dddd0000-0000-4000-8000-000000000001'
    AND name ILIKE '%DEMO A%' AND deleted_at IS NULL LIMIT 1;
  INSERT INTO public.income_expenses
    (id, organization_id, user_id, code, type, name, building_id, voucher_date, total_amount, approval_status)
  VALUES
    (NULL, 'dddd0000-0000-4000-8000-000000000001',
     '90450d5f-29b6-4897-bdef-cdb5fb53f339',
     'SMOKE-NULLID-'||floor(extract(epoch from clock_timestamp()))::text,
     'EXPENSE', '[SMOKE] null-id birth', v_building, CURRENT_DATE, 1000, 'UNAPPROVED')
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'smoke: id vẫn NULL sau trigger';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.income_expenses
                 WHERE id=v_id AND birth_operation_id IS NOT NULL) THEN
    RAISE EXCEPTION 'smoke: thiếu khai sinh cho phiếu null-id';
  END IF;
  -- Dọn smoke row (phiếu vừa tạo trong cùng txn, guard cho phép huỷ pending).
  UPDATE public.income_expenses SET approval_status='CANCELLED', deleted_at=now()
  WHERE id=v_id;
  RAISE NOTICE 'null-id birth smoke OK (%)', v_id;
END
$smoke$;

COMMIT;

NOTIFY pgrst, 'reload schema';
