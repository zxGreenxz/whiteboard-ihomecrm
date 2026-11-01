-- Hermes: bật thao tác ghi trang CÔNG VIỆC trên production (runbook docs/plans/hermes-crm/BAT-KHOA-GHI-4-TRANG.md mục 4–5;
-- docs/plans/hermes-crm/CONG-VIEC-THAO-TAC-GHI.md mục 19 và 22).
-- Thứ tự phát hành: SQL của trang đã áp (031548 → 014500), connector có danh mục Công việc Mốc 3 + Mốc 5 (danh mục production, có từ
-- 3bd1313b, KHÔNG cần actionPages) chạy trên MỌI host dùng database này, RỒI mới áp file này; sau đó SOUL owner và canary.
-- Lý do của thứ tự: connector cũ hơn Mốc 3 còn quảng bá crm_task_cancel (huỷ không xem trước — lớp sự cố 21/10); bản hiện hành cho
-- crm_task_cancel nghỉ hưu khi task.cancel sống phía SQL.
-- Trang dùng ba khoá registry: tasks.create, tasks.edit (đã bật từ trước — task.create / task.create_batch / task.update đang sống)
-- và tasks.delete (TẮT từ 20261021162612). File này:
--  (1) bảo đảm cả ba khoá bật — thực tế chỉ đổi tasks.delete ⇒ task.cancel (luôn xem trước) và task.recurring_delete;
--  (2) chèn bốn dòng chính sách việc định kỳ đúng như mục 22 (reversible, always, chỉ chat riêng); thiếu dòng thì thao tác không có
--      trong danh mục sống. task.recurring_create / _update / _pause sống ngay khi chèn (khoá đã bật).
-- Không đổi quyền CRM, chính sách công ty, loại trừ hay phạm vi kết nối: RPC trang vẫn giao registry ∩ trần công ty ∩ khoá kết nối ∩
-- quyền CRM thật mỗi lượt. Trigger hermes_registry_projection_v2 chiếu lại khoá cho kết nối inherit_crm (không đổi danh tính, epoch,
-- credential, loại trừ); kết nối legacy_allowlist giữ nguyên.
-- Idempotent (UPDATE … AND NOT enabled; INSERT … ON CONFLICT DO NOTHING), không DROP, không ghi bảng nghiệp vụ. Lùi:
-- docs/plans/hermes-crm/revert/hermes_task_actions_activation_revert_v1.sql (tắt tasks.delete + xoá bốn dòng định kỳ; rào legacy_allowlist).
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $activate_task$
DECLARE
  required_keys constant text[]:=ARRAY['tasks.create','tasks.delete','tasks.edit'];
  signature text;
  missing text;
BEGIN
  IF to_regclass('app_private.hermes_capabilities') IS NULL
    OR to_regclass('app_private.hermes_connections') IS NULL
    OR to_regclass('app_private.hermes_action_policies') IS NULL
    OR to_regclass('app_private.hermes_action_receipts') IS NULL
    OR to_regclass('public.job_recurrence_rules') IS NULL
    OR to_regclass('public.job_recurrence_occurrences') IS NULL THEN
    RAISE EXCEPTION 'hermes_task_activation_dependencies_missing';
  END IF;

  FOREACH signature IN ARRAY ARRAY[
    -- Khung thao tác chung (M1): danh mục, tra trạng thái, guard, sổ biên nhận, lý do, giải tên ghi.
    'public.hermes_action_capabilities_v1(uuid)',
    'public.hermes_action_status_v1(jsonb,uuid)',
    'app_private.hermes_action_guard_v1(jsonb,text)',
    'app_private.hermes_action_receipt_begin_v1(jsonb,text,uuid,jsonb)',
    'app_private.hermes_action_receipt_finish_v1(jsonb,text,uuid,jsonb,text,text)',
    'app_private.hermes_action_reason_v1(text,text,text)',
    'public.hermes_write_name_resolve_v1(uuid,uuid[],jsonb)',
    -- RPC trang và các tầng vỏ gắn: tạo (Mốc 2), sửa / huỷ (Mốc 3), lô (Mốc 4), định kỳ (Mốc 5).
    'public.hermes_task_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text)',
    'app_private.hermes_task_resolve_core_v1(jsonb,text,jsonb)',
    'app_private.hermes_task_action_prepare_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb,jsonb)',
    'app_private.hermes_task_action_write_v1(jsonb)',
    'app_private.hermes_task_action_finish_v1(jsonb,text,jsonb)',
    'app_private.hermes_task_building_managers_v1(uuid,uuid)',
    'app_private.hermes_task_edit_prepare_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb)',
    'app_private.hermes_task_edit_finish_v1(jsonb,text,jsonb)',
    'app_private.hermes_task_batch_prepare_v1(jsonb,text,uuid,jsonb,jsonb,text,jsonb)',
    'app_private.hermes_task_batch_finish_v1(jsonb,jsonb)',
    'app_private.hermes_task_recurring_prepare_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb,jsonb)',
    'app_private.hermes_task_recurring_finish_v1(jsonb,text,jsonb)',
    -- Việc định kỳ phía CRM (20261023042424) và bộ sinh (20261023042431) mà bốn thao tác định kỳ ghi qua / dựa vào.
    'public.job_recurrence_create_v1(uuid,uuid,uuid,uuid,text,text,uuid,text,text,integer,integer[],integer,date,date,integer)',
    'public.job_recurrence_update_v1(uuid,integer,jsonb)',
    'public.job_recurrence_set_paused_v1(uuid,integer,boolean)',
    'public.job_recurrence_delete_v1(uuid,integer)',
    'public.job_recurrence_dates_v1(text,integer,smallint[],integer,date,date,date,date)',
    'public.job_recurrence_schedule_text_v1(text,integer,smallint[],integer)',
    'app_private.hermes_task_recurrence_generate_v1(date)',
    -- Chiếu lại khoá cho kết nối inherit_crm.
    'app_private.hermes_refresh_registry_projection_v2()',
    'app_private.hermes_project_connection_limits_v2()'
  ] LOOP
    IF to_regprocedure(signature) IS NULL THEN
      RAISE EXCEPTION 'hermes_task_activation_function_missing: %',signature;
    END IF;
  END LOOP;

  IF NOT EXISTS(SELECT 1 FROM pg_trigger
    WHERE tgrelid='app_private.hermes_capabilities'::regclass
      AND tgname='hermes_registry_projection_v2' AND NOT tgisinternal AND tgenabled='O'
      AND tgfoid='app_private.hermes_refresh_registry_projection_v2()'::regprocedure)
    OR NOT EXISTS(SELECT 1 FROM pg_trigger
    WHERE tgrelid='app_private.hermes_connections'::regclass
      AND tgname='hermes_connection_limits_projection_v2' AND NOT tgisinternal AND tgenabled='O'
      AND tgfoid='app_private.hermes_project_connection_limits_v2()'::regprocedure) THEN
    RAISE EXCEPTION 'hermes_task_activation_projection_missing';
  END IF;

  -- Bốn thao tác đã có dòng chính sách (031548 → 164201) phải đúng khoá + quyền CRM giao vào.
  SELECT string_agg(e.action,', ' ORDER BY e.action) INTO missing
    FROM (VALUES
      ('task.cancel','tasks.delete','tasks.delete'),
      ('task.create','tasks.create','tasks.create'),
      ('task.create_batch','tasks.create','tasks.create'),
      ('task.update','tasks.edit','tasks.edit')) e(action,capability,crm_permission)
    LEFT JOIN app_private.hermes_action_policies p
      ON p.action=e.action AND p.capability=e.capability AND p.crm_permission=e.crm_permission
    WHERE p.action IS NULL;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'hermes_task_activation_policy_missing: %',missing;
  END IF;

  PERFORM 1 FROM app_private.hermes_capabilities
    WHERE capability=ANY(required_keys) ORDER BY capability FOR UPDATE;
  IF (SELECT count(*) FROM app_private.hermes_capabilities
      WHERE capability=ANY(required_keys) AND mode='action')<>3 THEN
    RAISE EXCEPTION 'hermes_task_activation_registry_invalid';
  END IF;

  UPDATE app_private.hermes_capabilities SET enabled=true
    WHERE capability=ANY(required_keys) AND mode='action' AND NOT enabled;

  -- Mục 22: bốn dòng chính sách việc định kỳ (reversible; máy chủ luôn xem trước kèm lịch chữ + ba lần tới).
  INSERT INTO app_private.hermes_action_policies(action,capability,crm_permission,action_class,confirm,private_only) VALUES
    ('task.recurring_create','tasks.create','tasks.create','reversible','always',true),
    ('task.recurring_update','tasks.edit','tasks.edit','reversible','always',true),
    ('task.recurring_pause','tasks.edit','tasks.edit','reversible','always',true),
    ('task.recurring_delete','tasks.delete','tasks.delete','reversible','always',true)
    ON CONFLICT(action) DO NOTHING;

  IF (SELECT count(*) FROM app_private.hermes_capabilities
      WHERE capability=ANY(required_keys) AND mode='action' AND enabled)<>3 THEN
    RAISE EXCEPTION 'hermes_task_activation_incomplete';
  END IF;
  -- Dòng có sẵn khác bản đã duyệt (ON CONFLICT giữ dòng cũ) ⇒ dừng, không nhận im lặng.
  IF (SELECT count(*) FROM app_private.hermes_action_policies
      WHERE (action,capability,crm_permission,action_class,confirm,private_only) IN (
        ('task.recurring_create','tasks.create','tasks.create','reversible','always',true),
        ('task.recurring_update','tasks.edit','tasks.edit','reversible','always',true),
        ('task.recurring_pause','tasks.edit','tasks.edit','reversible','always',true),
        ('task.recurring_delete','tasks.delete','tasks.delete','reversible','always',true)))<>4 THEN
    RAISE EXCEPTION 'hermes_task_activation_recurring_policy_invalid';
  END IF;
  -- Kiểm cuối: không thao tác nào của tám thao tác đã duyệt (danh mục connector TASK_ACTIONS) trỏ khoá đang tắt.
  SELECT string_agg(p.action,', ' ORDER BY p.action) INTO missing
    FROM app_private.hermes_action_policies p
    LEFT JOIN app_private.hermes_capabilities c ON c.capability=p.capability AND c.mode='action' AND c.enabled
    WHERE p.action IN ('task.cancel','task.create','task.create_batch','task.update',
      'task.recurring_create','task.recurring_delete','task.recurring_pause','task.recurring_update')
      AND c.capability IS NULL;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'hermes_task_activation_action_key_off: %',missing;
  END IF;
END
$activate_task$;
COMMIT;
NOTIFY pgrst,'reload schema';
