-- Assert-only forward guard for the invoice collection V5 money surface.
--
-- This migration changes NO feature-flag mode and creates/replaces NONE of the
-- money writers. It only re-asserts the live security + accounting invariant
-- contract and fails closed (RAISE 55000) if any assertion is violated, so it is
-- a safe, idempotent guard that can be re-applied without side effects.
--
-- ROLLBACK: none required. If an assertion fails the transaction rolls back and
-- nothing changed; fix the underlying contract violation with a forward
-- migration rather than editing this file.

BEGIN;

DO $hardening$
DECLARE
  v_signature text;
  v_oid oid;
  v_secdef boolean;
  v_config text[];
  v_owner text;
  v_has_pinned boolean;
  v_bad_collection uuid;
  v_signatures text[] := ARRAY[
    'public.record_invoice_collection_v5(uuid, date, jsonb, text, boolean, text, text, numeric, text)',
    'public.reverse_invoice_collection_v5(uuid, date, text, text)',
    'public.undo_invoice_payment_compat_v1(uuid, text, text)'
  ];
BEGIN
  -- 1. Per-writer security posture: SECURITY DEFINER, pinned search_path,
  --    permitted owner, and no EXECUTE leak to anon/service_role/PUBLIC.
  FOREACH v_signature IN ARRAY v_signatures LOOP
    v_oid := to_regprocedure(v_signature);
    IF v_oid IS NULL THEN
      RAISE EXCEPTION 'V5 hardening: money writer % is missing', v_signature
        USING ERRCODE = '55000';
    END IF;

    SELECT p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner)
      INTO v_secdef, v_config, v_owner
    FROM pg_catalog.pg_proc p
    WHERE p.oid = v_oid;

    IF NOT v_secdef THEN
      RAISE EXCEPTION 'V5 hardening: % must be SECURITY DEFINER (prosecdef)', v_signature
        USING ERRCODE = '55000';
    END IF;

    v_has_pinned := EXISTS (
      SELECT 1
      FROM unnest(COALESCE(v_config, ARRAY[]::text[])) AS cfg
      WHERE cfg ~ '^search_path=pg_catalog(,|$| )'
    );
    IF NOT v_has_pinned THEN
      RAISE EXCEPTION
        'V5 hardening: % lacks a pinned search_path starting pg_catalog', v_signature
        USING ERRCODE = '55000';
    END IF;

    IF v_owner NOT IN ('postgres', 'supabase_admin') THEN
      RAISE EXCEPTION 'V5 hardening: % has non-permitted owner %', v_signature, v_owner
        USING ERRCODE = '55000';
    END IF;

    -- anon and service_role must never hold EXECUTE (directly or via PUBLIC).
    IF has_function_privilege('anon', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'V5 hardening: % grants EXECUTE to anon', v_signature
        USING ERRCODE = '55000';
    END IF;
    IF has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'V5 hardening: % grants EXECUTE to service_role', v_signature
        USING ERRCODE = '55000';
    END IF;
    -- authenticated is the only tenant-facing role permitted to execute.
    IF NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'V5 hardening: % must grant EXECUTE to authenticated', v_signature
        USING ERRCODE = '55000';
    END IF;
  END LOOP;

  -- 2. Canonical-link guard triggers must remain installed on the money tables.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger tg
    JOIN pg_catalog.pg_class c ON c.oid = tg.tgrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE NOT tg.tgisinternal
      AND tg.tgname = 'a00_payment_canonical_link_guard'
      AND n.nspname = 'public'
      AND c.relname = 'payments'
  ) THEN
    RAISE EXCEPTION 'V5 hardening: trigger a00_payment_canonical_link_guard is missing'
      USING ERRCODE = '55000';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger tg
    JOIN pg_catalog.pg_class c ON c.oid = tg.tgrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE NOT tg.tgisinternal
      AND tg.tgname = 'a00_income_expense_accounting_links_guard'
      AND n.nspname = 'public'
      AND c.relname = 'income_expenses'
  ) THEN
    RAISE EXCEPTION
      'V5 hardening: trigger a00_income_expense_accounting_links_guard is missing'
      USING ERRCODE = '55000';
  END IF;

  -- 3. Both in-scope routes must exist and be classified MONEY.
  IF (
    SELECT count(*)
    FROM app_private.server_feature_flags
    WHERE feature_key IN (
      'invoice.collection.v5',
      'invoice.collection.reverse.v5'
    )
      AND risk_class = 'MONEY'
  ) <> 2 THEN
    RAISE EXCEPTION
      'V5 hardening: both V5 routes must exist with risk_class = MONEY'
      USING ERRCODE = '55000';
  END IF;

  -- 4. Balance invariant: every ACTIVE collection must satisfy
  --    gross = applied + change + credit (within 0.01) and its tender gross must
  --    sum back to the collection gross. Any orphan/mismatch fails closed.
  SELECT c.id
    INTO v_bad_collection
  FROM public.invoice_payment_collections c
  LEFT JOIN public.invoice_payment_tenders t
    ON t.collection_id = c.id
  WHERE c.status = 'ACTIVE'
  GROUP BY c.id, c.gross_amount, c.applied_amount, c.change_amount, c.credit_amount
  HAVING abs(
           c.gross_amount
           - (c.applied_amount + c.change_amount + c.credit_amount)
         ) >= 0.01
      OR abs(COALESCE(sum(t.gross_amount), 0) - c.gross_amount) >= 0.01
  LIMIT 1;

  IF v_bad_collection IS NOT NULL THEN
    RAISE EXCEPTION
      'V5 hardening: ACTIVE collection % violates the gross/applied/change/credit balance invariant',
      v_bad_collection
      USING ERRCODE = '55000';
  END IF;
END
$hardening$;

COMMIT;

-- Assert-only guard installs no new schema, but keep PostgREST cache consistent.
NOTIFY pgrst, 'reload schema';
