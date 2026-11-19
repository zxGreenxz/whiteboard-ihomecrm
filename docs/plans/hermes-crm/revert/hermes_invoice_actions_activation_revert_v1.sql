-- REVERT of 20261027234454_hermes_invoice_actions_activation_v1.sql — prepared 28/10/2026 next to the forward file; NOT a migration
-- (docs/plans/hermes-crm/revert/). Turns the five Hoá đơn registry keys back OFF: thu_tien.collect_transfer, meter_readings.create,
-- invoices.edit, invoices.approve, invoices.cancel ⇒ invoice.collect / meter_record / adjust / adjustment_check / cancel / restore
-- disappear from crm_action_list for every connection (inherit_crm projection drops the keys; no epoch change). Collections, readings
-- and adjustments already written stay as they are (web flows unchanged); a preview not yet confirmed is refused at confirmation.
-- Legacy fence (NEN-CHUNG-THAO-TAC-GHI.md mục 8.3, pattern 20261021162612): refuses while an ACTIVE legacy_allowlist connection still
-- holds one of the keys (its token renewal is checked against the registry and would start failing).
-- TO APPLY: copy into supabase/migrations under the name `node scripts/tao-ten-migration.mjs hermes_invoice_actions_activation_revert_v1`
-- gives; add its provenance entry and doc counts like the forward file; TEST lane, then production. Re-enable later with a NEW forward
-- migration (copy of the activation file under a new name). Idempotent: only UPDATE … AND enabled.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

DO $revert_invoice$
DECLARE
  page_keys constant text[]:=ARRAY['invoices.approve','invoices.cancel','invoices.edit','meter_readings.create','thu_tien.collect_transfer'];
  legacy int;
BEGIN
  IF to_regclass('app_private.hermes_capabilities') IS NULL OR to_regclass('app_private.hermes_connections') IS NULL THEN
    RAISE EXCEPTION 'hermes_invoice_revert_dependencies_missing';
  END IF;
  PERFORM 1 FROM app_private.hermes_capabilities WHERE capability=ANY(page_keys) ORDER BY capability FOR UPDATE;
  IF (SELECT count(*) FROM app_private.hermes_capabilities WHERE capability=ANY(page_keys) AND mode='action')<>5 THEN
    RAISE EXCEPTION 'hermes_invoice_revert_registry_invalid';
  END IF;
  SELECT count(*) INTO legacy FROM app_private.hermes_connections h
   WHERE h.state='ACTIVE' AND h.permission_mode='legacy_allowlist' AND h.action_capabilities && page_keys;
  IF legacy>0 THEN
    RAISE EXCEPTION 'hermes_invoice_revert_blocked: % kết nối legacy_allowlist ACTIVE còn giữ khoá Hoá đơn',legacy
      USING HINT='Thu hẹp, chuyển inherit_crm hoặc thu hồi các kết nối đó trước; tắt registry sẽ làm gia hạn token của chúng thất bại.';
  END IF;

  UPDATE app_private.hermes_capabilities SET enabled=false
    WHERE capability=ANY(page_keys) AND mode='action' AND enabled;

  IF EXISTS(SELECT 1 FROM app_private.hermes_capabilities WHERE capability=ANY(page_keys) AND mode='action' AND enabled) THEN
    RAISE EXCEPTION 'hermes_invoice_revert_incomplete';
  END IF;
END
$revert_invoice$;
COMMIT;
NOTIFY pgrst,'reload schema';
