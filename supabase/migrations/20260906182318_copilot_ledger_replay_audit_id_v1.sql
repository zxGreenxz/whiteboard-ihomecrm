-- Future-only correction for income-expense idempotent replay evidence.
--
-- The legacy producer already validates the original audit, voucher and item
-- before returning `da_tao_truoc_do`.  Preserve that exact audit identity in
-- the result so the existing plan executor can write an exact ledger link.
-- This migration does not create a replay audit, action_executed event or
-- business row, and it does not alter historical ledger entries.

BEGIN;

SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '60s';

DO $fix_replay_audit_id$
DECLARE
  v_signature     regprocedure :=
    to_regprocedure('public.copilot_execute_income_expense_legacy_v1(text, jsonb)');
  v_definition    text;
  v_body          text;
  v_body_sha      text;
  v_owner         oid;
  v_acl           aclitem[];
  v_volatility    "char";
  v_security      boolean;
  v_config        text[];
  v_after_owner   oid;
  v_after_acl     aclitem[];
  v_after_vol     "char";
  v_after_security boolean;
  v_after_config  text[];
  v_old_fragment  constant text := $old$
      'status', 'da_tao_truoc_do',
      'entity_id', v_prev.entity_id,
      'created_at', v_prev.created_at
$old$;
  v_new_fragment  constant text := $new$
      'status', 'da_tao_truoc_do',
      'entity_id', v_prev.entity_id,
      'audit_id', v_prev.id,
      'created_at', v_prev.created_at
$new$;
  v_old_sha       constant text :=
    'e55854b4c041ce1191b10d8ebd755d97e513d9459d174857c137e3ae9de79ca4';
  v_new_sha       constant text :=
    '039be505581e0d968ed8d41160beb6264e515dcffa301a9383678c8e85f4e48e';
  v_old_count     integer;
  v_new_count     integer;
BEGIN
  IF v_signature IS NULL THEN
    RAISE EXCEPTION
      'copilot_execute_income_expense_legacy_v1 missing — stop before replay fix';
  END IF;
  IF to_regprocedure('extensions.digest(bytea, text)') IS NULL THEN
    RAISE EXCEPTION 'extensions.digest(bytea,text) missing — cannot attest source';
  END IF;

  SELECT p.prosrc,
         pg_get_functiondef(p.oid),
         p.proowner,
         p.proacl,
         p.provolatile,
         p.prosecdef,
         p.proconfig
    INTO v_body,
         v_definition,
         v_owner,
         v_acl,
         v_volatility,
         v_security,
         v_config
    FROM pg_proc p
   WHERE p.oid = v_signature;

  v_body_sha := encode(
    extensions.digest(convert_to(v_body, 'UTF8'), 'sha256'), 'hex');
  v_old_count :=
    (length(v_body) - length(replace(v_body, v_old_fragment, '')))
    / length(v_old_fragment);
  v_new_count :=
    (length(v_body) - length(replace(v_body, v_new_fragment, '')))
    / length(v_new_fragment);

  IF v_volatility IS DISTINCT FROM 'v'::"char"
     OR NOT v_security
     OR v_config IS DISTINCT FROM
       ARRAY['search_path=pg_catalog, public, app_private, extensions']::text[] THEN
    RAISE EXCEPTION
      'unexpected legacy replay security metadata — stop before replacement';
  END IF;

  IF v_body_sha = v_new_sha THEN
    IF v_old_count <> 0 OR v_new_count <> 1 THEN
      RAISE EXCEPTION
        'fixed legacy replay source has unexpected return shape — stop';
    END IF;
    RETURN;
  END IF;

  IF v_body_sha IS DISTINCT FROM v_old_sha THEN
    RAISE EXCEPTION
      'unexpected legacy replay source sha256 % — expected % or %',
      v_body_sha, v_old_sha, v_new_sha;
  END IF;
  IF v_old_count <> 1 OR v_new_count <> 0 THEN
    RAISE EXCEPTION
      'unexpected legacy replay return shape (old %, new %) — stop',
      v_old_count, v_new_count;
  END IF;

  v_definition := replace(v_definition, v_old_fragment, v_new_fragment);
  EXECUTE v_definition;

  SELECT p.prosrc,
         p.proowner,
         p.proacl,
         p.provolatile,
         p.prosecdef,
         p.proconfig
    INTO v_body,
         v_after_owner,
         v_after_acl,
         v_after_vol,
         v_after_security,
         v_after_config
    FROM pg_proc p
   WHERE p.oid =
     'public.copilot_execute_income_expense_legacy_v1(text, jsonb)'::regprocedure;

  v_body_sha := encode(
    extensions.digest(convert_to(v_body, 'UTF8'), 'sha256'), 'hex');
  v_new_count :=
    (length(v_body) - length(replace(v_body, v_new_fragment, '')))
    / length(v_new_fragment);

  IF v_body_sha IS DISTINCT FROM v_new_sha OR v_new_count <> 1 THEN
    RAISE EXCEPTION
      'legacy replay audit_id replacement failed attestation (sha %, count %)',
      v_body_sha, v_new_count;
  END IF;
  IF v_after_owner IS DISTINCT FROM v_owner
     OR v_after_acl IS DISTINCT FROM v_acl
     OR v_after_vol IS DISTINCT FROM v_volatility
     OR v_after_security IS DISTINCT FROM v_security
     OR v_after_config IS DISTINCT FROM v_config THEN
    RAISE EXCEPTION
      'legacy replay function metadata changed during body replacement';
  END IF;
END
$fix_replay_audit_id$;

COMMIT;
