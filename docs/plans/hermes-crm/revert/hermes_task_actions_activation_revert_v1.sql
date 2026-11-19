-- REVERT of 20261027234537_hermes_task_actions_activation_v1.sql — prepared 28/10/2026 next to the forward file; NOT a migration
-- (docs/plans/hermes-crm/revert/). Returns Công việc to its state BEFORE the activation, not to "page off":
--  (1) tasks.delete OFF again (as 20261021162612) ⇒ task.cancel and task.recurring_delete disappear; crm_task_cancel stays retired
--      because task.cancel is still live in the SQL catalog (no un-previewed cancel comes back);
--  (2) the four task.recurring_* policy rows are deleted ⇒ the four recurring actions leave the live catalog (guard refuses them).
-- tasks.create / tasks.edit stay ON: task.create, task.create_batch, task.update were live on production before the activation
-- (B1, 23/10), and task follow / progress tools also depend on them. Turning the whole page off is a separate decision (runbook
-- docs/plans/hermes-crm/BAT-KHOA-GHI-4-TRANG.md mục 6.3).
-- Recurrence rules already created keep generating tasks (cron job-recurrence-daily); the web has no recurrence screen yet, so pause /
-- delete the rules you want stopped BEFORE applying this file (through Hermes while it is still on, or a reviewed data migration).
-- Legacy fence (NEN-CHUNG-THAO-TAC-GHI.md mục 8.3, pattern 20261021162612): refuses while an ACTIVE legacy_allowlist connection still
-- holds tasks.delete (its token renewal is checked against the registry and would start failing).
-- TO APPLY: copy into supabase/migrations under the name `node scripts/tao-ten-migration.mjs hermes_task_actions_activation_revert_v1`
-- gives; add its provenance entry and doc counts like the forward file; TEST lane, then production. Re-enable later with a NEW forward
-- migration (copy of the activation file under a new name). Idempotent: UPDATE … AND enabled; DELETE of the four named rows.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

DO $revert_task$
DECLARE
  recurring constant text[]:=ARRAY['task.recurring_create','task.recurring_delete','task.recurring_pause','task.recurring_update'];
  legacy int;
BEGIN
  IF to_regclass('app_private.hermes_capabilities') IS NULL OR to_regclass('app_private.hermes_connections') IS NULL
    OR to_regclass('app_private.hermes_action_policies') IS NULL THEN
    RAISE EXCEPTION 'hermes_task_revert_dependencies_missing';
  END IF;
  PERFORM 1 FROM app_private.hermes_capabilities WHERE capability='tasks.delete' FOR UPDATE;
  IF NOT EXISTS(SELECT 1 FROM app_private.hermes_capabilities WHERE capability='tasks.delete' AND mode='action') THEN
    RAISE EXCEPTION 'hermes_task_revert_registry_invalid';
  END IF;
  SELECT count(*) INTO legacy FROM app_private.hermes_connections h
   WHERE h.state='ACTIVE' AND h.permission_mode='legacy_allowlist' AND 'tasks.delete'=ANY(h.action_capabilities);
  IF legacy>0 THEN
    RAISE EXCEPTION 'hermes_task_revert_blocked: % kết nối legacy_allowlist ACTIVE còn giữ tasks.delete',legacy
      USING HINT='Thu hẹp, chuyển inherit_crm hoặc thu hồi các kết nối đó trước; tắt registry sẽ làm gia hạn token của chúng thất bại.';
  END IF;

  DELETE FROM app_private.hermes_action_policies WHERE action=ANY(recurring);
  UPDATE app_private.hermes_capabilities SET enabled=false
    WHERE capability='tasks.delete' AND mode='action' AND enabled;

  IF EXISTS(SELECT 1 FROM app_private.hermes_capabilities WHERE capability='tasks.delete' AND mode='action' AND enabled)
    OR EXISTS(SELECT 1 FROM app_private.hermes_action_policies WHERE action=ANY(recurring)) THEN
    RAISE EXCEPTION 'hermes_task_revert_incomplete';
  END IF;
END
$revert_task$;
COMMIT;
NOTIFY pgrst,'reload schema';
