-- REVERT of 20261030065028_hermes_expense_actions_activation_v1.sql (renamed from 20261027234414 on 30/10/2026 so it runs after
-- 20261030050424_hermes_sale_deposit_receipt_key_v1) — prepared 28/10/2026 next to the forward file; NOT a migration
-- (docs/plans/hermes-crm/revert/). Turns the four Thu chi registry keys back OFF: income_expenses.create, income_expenses.edit,
-- income_expenses.cancel, income_expenses.approve_vouchers ⇒ expense.create / note / edit / cancel / approve disappear from
-- crm_action_list for every connection (inherit_crm projection drops the keys; no epoch change). Vouchers already written stay as
-- they are (web flows unchanged); a preview not yet confirmed is refused at confirmation (guard re-checks the registry).
-- Legacy fence (NEN-CHUNG-THAO-TAC-GHI.md mục 8.3, pattern 20261021162612 / 20261021113528): refuses while an ACTIVE legacy_allowlist
-- connection still holds one of the keys (its token renewal is checked against the registry and would start failing).
-- TO APPLY: copy into supabase/migrations under the name `node scripts/tao-ten-migration.mjs hermes_expense_actions_activation_revert_v1`
-- gives; add its provenance entry and doc counts like the forward file; TEST lane, then production. Re-enable later with a NEW forward
-- migration (copy of the activation file under a new name). Idempotent: only UPDATE … AND enabled.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

DO $revert_expense$
DECLARE
  page_keys constant text[]:=ARRAY['income_expenses.approve_vouchers','income_expenses.cancel','income_expenses.create','income_expenses.edit'];
  legacy int;
BEGIN
  IF to_regclass('app_private.hermes_capabilities') IS NULL OR to_regclass('app_private.hermes_connections') IS NULL THEN
    RAISE EXCEPTION 'hermes_expense_revert_dependencies_missing';
  END IF;
  PERFORM 1 FROM app_private.hermes_capabilities WHERE capability=ANY(page_keys) ORDER BY capability FOR UPDATE;
  IF (SELECT count(*) FROM app_private.hermes_capabilities WHERE capability=ANY(page_keys) AND mode='action')<>4 THEN
    RAISE EXCEPTION 'hermes_expense_revert_registry_invalid';
  END IF;
  SELECT count(*) INTO legacy FROM app_private.hermes_connections h
   WHERE h.state='ACTIVE' AND h.permission_mode='legacy_allowlist' AND h.action_capabilities && page_keys;
  IF legacy>0 THEN
    RAISE EXCEPTION 'hermes_expense_revert_blocked: % kết nối legacy_allowlist ACTIVE còn giữ khoá Thu chi',legacy
      USING HINT='Thu hẹp, chuyển inherit_crm hoặc thu hồi các kết nối đó trước; tắt registry sẽ làm gia hạn token của chúng thất bại.';
  END IF;

  UPDATE app_private.hermes_capabilities SET enabled=false
    WHERE capability=ANY(page_keys) AND mode='action' AND enabled;

  IF EXISTS(SELECT 1 FROM app_private.hermes_capabilities WHERE capability=ANY(page_keys) AND mode='action' AND enabled) THEN
    RAISE EXCEPTION 'hermes_expense_revert_incomplete';
  END IF;
END
$revert_expense$;
COMMIT;
NOTIFY pgrst,'reload schema';
