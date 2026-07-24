-- Finance V2 — Hotfix 7w: phiếu điện/nước vượt ngưỡng vỡ 23502 org NULL (PROD).
--
-- pay_utility_bill INSERT income_expenses KHÔNG gán organization_id (dù đã
-- SELECT v_org để đọc ngưỡng!) ⇒ phiếu ≥ ngưỡng sinh UNAPPROVED ⇒ a86 khai sinh
-- gọi register_birth(p_org = NULL) ⇒ canonical_write_operations.organization_id
-- 23502 ⇒ màn Điện & Nước bấm THU chết.
--
-- Fix 2 lớp:
-- (1) a86 tự bù organization_id từ buildings/accounts khi writer cũ quên —
--     chuẩn cho MỌI writer legacy, không chỉ utility; nếu vẫn không suy được
--     thì lỗi tiếng Việt rõ nghĩa thay vì 23502 khó hiểu.
-- (2) pay_utility_bill gán organization_id = v_org ngay lúc INSERT (dữ liệu
--     phiếu đúng ngay từ nguồn).

BEGIN;

-- (1) a86 re-emit (giữ nguyên 7m null-id + 7s preserve-hash).
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
    -- 7w: writer cũ quên organization_id → suy từ toà/sổ.
    IF NEW.organization_id IS NULL AND NEW.building_id IS NOT NULL THEN
      SELECT b.organization_id INTO NEW.organization_id
      FROM public.buildings b WHERE b.id = NEW.building_id;
    END IF;
    IF NEW.organization_id IS NULL AND NEW.account_id IS NOT NULL THEN
      SELECT a.organization_id INTO NEW.organization_id
      FROM public.accounts a WHERE a.id = NEW.account_id;
    END IF;
    IF NEW.organization_id IS NULL THEN
      RAISE EXCEPTION 'Phiếu chờ duyệt thiếu organization (toà/sổ không xác định) — liên hệ quản trị'
        USING ERRCODE = '23502';
    END IF;
    SELECT b.birth_txid, b.payload_hash INTO v_txid, v_hash
    FROM app_private.finance_v2_register_birth_v1(
      NEW.organization_id, NEW.id, COALESCE(auth.uid(), NEW.user_id),
      'BIRTH_BRIDGE', NEW.source_payload_hash) b;
    NEW.birth_operation_id := NEW.id;
    NEW.birth_txid := v_txid;
    NEW.source_payload_hash := COALESCE(NEW.source_payload_hash, v_hash);
  END IF;
  RETURN NEW;
END
$fn$;

-- (2) pay_utility_bill: gán org ngay lúc INSERT.
DO $patch$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p WHERE p.proname='pay_utility_bill'
    AND p.pronamespace='public'::regnamespace;
  IF v_def NOT LIKE '%(user_id, organization_id, type, name%' THEN
    v_def := replace(v_def,
      '(user_id, type, name, building_id, account_id, voucher_date,',
      '(user_id, organization_id, type, name, building_id, account_id, voucher_date,');
    v_def := replace(v_def,
      '(auth.uid(), ''EXPENSE'',',
      '(auth.uid(), v_org, ''EXPENSE'',');
    IF v_def NOT LIKE '%(user_id, organization_id, type, name%'
       OR v_def NOT LIKE '%(auth.uid(), v_org, ''EXPENSE'',%' THEN
      RAISE EXCEPTION 'pay_utility_bill org patch: pattern không khớp — kiểm tra thủ công';
    END IF;
    EXECUTE v_def;
  END IF;
END
$patch$;

-- Smoke: INSERT kiểu utility (KHÔNG org, UNAPPROVED, toà DEMO) → org tự bù +
-- khai sinh đủ; rồi dọn.
DO $smoke$
DECLARE
  v_building uuid;
  v_id uuid;
  v_row record;
BEGIN
  SELECT id INTO v_building FROM public.buildings
  WHERE organization_id='dddd0000-0000-4000-8000-000000000001'
    AND name ILIKE '%DEMO A%' AND deleted_at IS NULL LIMIT 1;
  INSERT INTO public.income_expenses
    (user_id, type, name, building_id, voucher_date, total_amount,
     approval_status, code)
  VALUES
    ('90450d5f-29b6-4897-bdef-cdb5fb53f339', 'EXPENSE',
     '[SMOKE 7w] utility no-org', v_building, CURRENT_DATE, 1000,
     'UNAPPROVED', 'SMK7W-'||floor(extract(epoch from clock_timestamp()))::text)
  RETURNING id INTO v_id;
  SELECT organization_id, birth_operation_id INTO v_row
  FROM public.income_expenses WHERE id = v_id;
  IF v_row.organization_id IS DISTINCT FROM 'dddd0000-0000-4000-8000-000000000001'
     OR v_row.birth_operation_id IS NULL THEN
    RAISE EXCEPTION 'smoke 7w: org/birth không được bù (org=%, birth=%)',
      v_row.organization_id, v_row.birth_operation_id;
  END IF;
  UPDATE public.income_expenses SET approval_status='CANCELLED', deleted_at=now()
  WHERE id = v_id;
  RAISE NOTICE 'birth org fallback smoke OK';
END
$smoke$;

COMMIT;

NOTIFY pgrst, 'reload schema';
