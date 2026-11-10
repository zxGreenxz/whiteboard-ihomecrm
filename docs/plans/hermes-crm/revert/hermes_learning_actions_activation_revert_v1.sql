-- REVERT of 20261105030528_hermes_learning_actions_activation_v1.sql — prepared 04/11/2026 next to the forward file; NOT a migration
-- (docs/plans/hermes-crm/revert/). Returns the learning page (đợt 3 học có kiểm duyệt, docs/plans/hermes-crm/HOC-CO-KIEM-DUYET.md
-- mục 4) to its state BEFORE the activation:
--  (1) assistant.learning_review OFF again (as seeded by 20261105025453) ⇒ inherit_crm connections lose the key (projection trigger);
--  (2) the two learning.* policy rows are deleted ⇒ both actions leave the live SQL catalog (the shared guard refuses them).
-- Not touched: the announced_at column, the page RPC / step and the immutability guard of 20261105025453 (harmless without policy rows),
-- decisions already recorded through Zalo (history stays immutable), receipts and audit rows. Remove the Hermes cron job 21:00 of the
-- owner profile and "learning" from the host actionPages BEFORE applying this file (otherwise the evening job only gets action_disabled).
-- Legacy fence (NEN-CHUNG-THAO-TAC-GHI.md mục 8.3, pattern 20261021162612): refuses while an ACTIVE legacy_allowlist connection still holds
-- assistant.learning_review (its token renewal is checked against the registry and would start failing).
-- TO APPLY: copy into supabase/migrations under the name `node scripts/tao-ten-migration.mjs hermes_learning_actions_activation_revert_v1`
-- gives; add its provenance entry and doc counts like the forward file; TEST lane, then production. Re-enable later with a NEW forward
-- migration (copy of the activation file under a new name). Idempotent: UPDATE … AND enabled; DELETE of the two named rows.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

DO $revert_learning$
DECLARE
  required_keys constant text[]:=ARRAY['assistant.learning_review'];
  learning_actions constant text[]:=ARRAY['learning.decide','learning.digest'];
  legacy int;
BEGIN
  IF to_regclass('app_private.hermes_capabilities') IS NULL OR to_regclass('app_private.hermes_connections') IS NULL
    OR to_regclass('app_private.hermes_action_policies') IS NULL THEN
    RAISE EXCEPTION 'hermes_learning_revert_dependencies_missing';
  END IF;
  PERFORM 1 FROM app_private.hermes_capabilities WHERE capability=ANY(required_keys) ORDER BY capability FOR UPDATE;
  IF (SELECT count(*) FROM app_private.hermes_capabilities WHERE capability=ANY(required_keys) AND mode='action')<>1 THEN
    RAISE EXCEPTION 'hermes_learning_revert_registry_invalid';
  END IF;
  SELECT count(*) INTO legacy FROM app_private.hermes_connections h
   WHERE h.state='ACTIVE' AND h.permission_mode='legacy_allowlist' AND h.action_capabilities && required_keys;
  IF legacy>0 THEN
    RAISE EXCEPTION 'hermes_learning_revert_blocked: % kết nối legacy_allowlist ACTIVE còn giữ assistant.learning_review',legacy
      USING HINT='Thu hẹp, chuyển inherit_crm hoặc thu hồi các kết nối đó trước; tắt registry sẽ làm gia hạn token của chúng thất bại.';
  END IF;

  DELETE FROM app_private.hermes_action_policies WHERE action=ANY(learning_actions);
  UPDATE app_private.hermes_capabilities SET enabled=false
    WHERE capability=ANY(required_keys) AND mode='action' AND enabled;

  IF EXISTS(SELECT 1 FROM app_private.hermes_capabilities WHERE capability=ANY(required_keys) AND mode='action' AND enabled)
    OR EXISTS(SELECT 1 FROM app_private.hermes_action_policies WHERE action=ANY(learning_actions)) THEN
    RAISE EXCEPTION 'hermes_learning_revert_incomplete';
  END IF;
END
$revert_learning$;
COMMIT;
NOTIFY pgrst,'reload schema';
