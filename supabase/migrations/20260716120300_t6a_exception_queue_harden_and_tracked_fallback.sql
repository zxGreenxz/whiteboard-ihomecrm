-- T6a (phase 1) — Harden exception queue + loại "silent PROD default" khỏi autofill.
-- Theo docs/authorization/T6A-ORG-INTEGRITY-RLS-V2-SHADOW.md §4 (đã reconcile 2026-07-16):
--   1. Queue nhận diện được bảng khoá ghép (row_key jsonb) + idempotent (partial unique).
--   2. _autofill_org: membership chỉ dùng khi ĐÚNG 1 org candidate (bỏ LIMIT 1 ngẫu nhiên);
--      khi không resolve được vẫn gán PROD (giữ nguyên hành vi ghi để không phá insert
--      hiện hữu — RESTRICTIVE boundary NULL-tolerant vẫn cần org non-null) NHƯNG ghi
--      exception row 'PROD_DEFAULT_FALLBACK' để mọi lần đoán đều bị theo dõi, hết "im lặng".
--      (Fail-closed hoàn toàn — trả NULL + deny — thuộc T6a phase 2 sau khi backfill sạch
--       và RLS v2 shadow chứng minh mismatch = 0; đổi ngay bây giờ sẽ chặn insert live.)
-- Additive + thay trigger function in-place; không đổi schema bảng nghiệp vụ.
BEGIN;

-- ===== 1. Harden exception queue =====
ALTER TABLE public.authorization_migration_exceptions
  ADD COLUMN IF NOT EXISTS row_key jsonb;

-- Idempotent theo (table_name, row_id) khi chưa resolved (row_id NULL cho phép nhiều
-- row khác nhau nên cần cả hai index partial riêng biệt).
CREATE UNIQUE INDEX IF NOT EXISTS authorization_migration_exceptions_open_rowid_uq
  ON public.authorization_migration_exceptions (table_name, row_id)
  WHERE resolved = false AND row_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS authorization_migration_exceptions_open_rowkey_uq
  ON public.authorization_migration_exceptions (table_name, row_key)
  WHERE resolved = false AND row_key IS NOT NULL;

-- ===== 2. _autofill_org: đúng-1-membership + tracked fallback =====
CREATE OR REPLACE FUNCTION public._autofill_org()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  j jsonb := to_jsonb(NEW);
  v uuid;
  n_orgs int;
  PROD constant uuid := 'aaaa0000-0000-4000-8000-000000000001';
BEGIN
  IF NEW.organization_id IS NOT NULL THEN RETURN NEW; END IF;
  IF (j->>'building_id') IS NOT NULL THEN SELECT organization_id INTO v FROM public.buildings WHERE id=(j->>'building_id')::uuid; END IF;
  IF v IS NULL AND (j->>'room_id') IS NOT NULL THEN SELECT organization_id INTO v FROM public.rooms WHERE id=(j->>'room_id')::uuid; END IF;
  IF v IS NULL AND (j->>'contract_id') IS NOT NULL THEN SELECT organization_id INTO v FROM public.contracts WHERE id=(j->>'contract_id')::uuid; END IF;
  IF v IS NULL AND (j->>'invoice_id') IS NOT NULL THEN SELECT organization_id INTO v FROM public.invoices WHERE id=(j->>'invoice_id')::uuid; END IF;
  IF v IS NULL AND (j->>'income_expense_id') IS NOT NULL THEN SELECT organization_id INTO v FROM public.income_expenses WHERE id=(j->>'income_expense_id')::uuid; END IF;
  IF v IS NULL AND (j->>'account_id') IS NOT NULL THEN SELECT organization_id INTO v FROM public.accounts WHERE id=(j->>'account_id')::uuid; END IF;
  IF v IS NULL AND (j->>'customer_id') IS NOT NULL THEN SELECT organization_id INTO v FROM public.customers WHERE id=(j->>'customer_id')::uuid; END IF;
  -- Membership: CHỈ khi user thuộc đúng MỘT org ACTIVE (nhiều org = mơ hồ, không đoán).
  IF v IS NULL AND (j->>'user_id') IS NOT NULL THEN
    SELECT min(organization_id), count(DISTINCT organization_id)
      INTO v, n_orgs
      FROM public.organization_memberships
     WHERE user_id=(j->>'user_id')::uuid AND status='ACTIVE';
    IF n_orgs IS DISTINCT FROM 1 THEN v := NULL; END IF;
  END IF;

  IF v IS NULL THEN
    -- Giữ hành vi ghi (PROD) để không phá insert live, nhưng KHÔNG còn im lặng:
    -- mọi lần fallback đều vào exception queue để backfill/phân loại.
    BEGIN
      INSERT INTO public.authorization_migration_exceptions(table_name, reason, details)
      VALUES (TG_TABLE_NAME, 'PROD_DEFAULT_FALLBACK at insert',
              jsonb_build_object('source', '_autofill_org', 'at', now(),
                                 'new_row_keys', (SELECT jsonb_object_agg(k, j->k)
                                                  FROM unnest(ARRAY['id','user_id','building_id','room_id','contract_id','invoice_id','account_id','customer_id']) AS k
                                                  WHERE j ? k)));
    EXCEPTION WHEN OTHERS THEN
      NULL; -- không bao giờ chặn insert nghiệp vụ vì lỗi ghi log
    END;
    v := PROD;
  END IF;

  NEW.organization_id := v;
  RETURN NEW;
END;
$function$;

COMMIT;
