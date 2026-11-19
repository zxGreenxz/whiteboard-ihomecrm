-- REVERT of 20261027234335_hermes_contract_actions_activation_v1.sql — prepared 28/10/2026 next to the forward file; NOT a migration
-- (docs/plans/hermes-crm/revert/). Turns the four Hợp đồng registry keys back OFF: contracts.create, contracts.edit, contracts.renew,
-- contracts.terminate ⇒ contract.draft / occupant_add / occupant_remove / renew / renew_batch / notice_set / notice_cancel / return
-- disappear from crm_action_list for every connection (inherit_crm projection drops the keys; no epoch change).
-- Does NOT touch sale_phong.lock_room (owned by the Sale layer, 20261022121254): contract.room_lock / room_unlock stay live while the
-- host config keeps "actionPages": ["contract"]. To hide those two as well, remove "contract" from actionPages and restart the
-- connector (runbook docs/plans/hermes-crm/BAT-KHOA-GHI-4-TRANG.md mục 6) — never turn the Sale key off for this.
-- Legacy fence (NEN-CHUNG-THAO-TAC-GHI.md mục 8.3, pattern 20261021162612): refuses while an ACTIVE legacy_allowlist connection still
-- holds one of the keys (its token renewal is checked against the registry and would start failing).
-- TO APPLY: copy into supabase/migrations under the name `node scripts/tao-ten-migration.mjs hermes_contract_actions_activation_revert_v1`
-- gives; add its provenance entry and doc counts like the forward file; TEST lane, then production. Re-enable later with a NEW forward
-- migration (copy of the activation file under a new name). Idempotent: only UPDATE … AND enabled.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

DO $revert_contract$
DECLARE
  page_keys constant text[]:=ARRAY['contracts.create','contracts.edit','contracts.renew','contracts.terminate'];
  legacy int;
BEGIN
  IF to_regclass('app_private.hermes_capabilities') IS NULL OR to_regclass('app_private.hermes_connections') IS NULL THEN
    RAISE EXCEPTION 'hermes_contract_revert_dependencies_missing';
  END IF;
  PERFORM 1 FROM app_private.hermes_capabilities WHERE capability=ANY(page_keys) ORDER BY capability FOR UPDATE;
  IF (SELECT count(*) FROM app_private.hermes_capabilities WHERE capability=ANY(page_keys) AND mode='action')<>4 THEN
    RAISE EXCEPTION 'hermes_contract_revert_registry_invalid';
  END IF;
  SELECT count(*) INTO legacy FROM app_private.hermes_connections h
   WHERE h.state='ACTIVE' AND h.permission_mode='legacy_allowlist' AND h.action_capabilities && page_keys;
  IF legacy>0 THEN
    RAISE EXCEPTION 'hermes_contract_revert_blocked: % kết nối legacy_allowlist ACTIVE còn giữ khoá Hợp đồng',legacy
      USING HINT='Thu hẹp, chuyển inherit_crm hoặc thu hồi các kết nối đó trước; tắt registry sẽ làm gia hạn token của chúng thất bại.';
  END IF;

  UPDATE app_private.hermes_capabilities SET enabled=false
    WHERE capability=ANY(page_keys) AND mode='action' AND enabled;

  IF EXISTS(SELECT 1 FROM app_private.hermes_capabilities WHERE capability=ANY(page_keys) AND mode='action' AND enabled) THEN
    RAISE EXCEPTION 'hermes_contract_revert_incomplete';
  END IF;
END
$revert_contract$;
COMMIT;
NOTIFY pgrst,'reload schema';
