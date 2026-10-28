-- Hermes: bật thao tác ghi trang THU CHI trên production (runbook docs/plans/hermes-crm/BAT-KHOA-GHI-4-TRANG.md mục 4–5).
-- Thứ tự phát hành: SQL của trang đã áp (024834 → 140949), connector có danh mục Thu chi (danh mục production, có từ 3bd1313b, KHÔNG
-- cần actionPages; họ crm_expense_* cũ đã gỡ — TC1), RỒI mới áp file này; sau đó SOUL owner và canary có chủ duyệt.
-- Bật đúng bốn khoá registry của trang: income_expenses.create (expense.create + expense.note), income_expenses.edit (expense.edit),
-- income_expenses.cancel (expense.cancel), income_expenses.approve_vouchers (expense.approve: duyệt / duyệt + chi).
-- income_expenses.create tắt từ 20261021113528 (Q4) để nghỉ hưu ba tool phiếu chi cũ; connector hiện hành không còn họ đó, nên bật lại
-- chỉ mở họ crm_action_*. Không đổi quyền CRM, chính sách công ty, loại trừ hay phạm vi kết nối: RPC trang vẫn giao registry ∩ trần
-- công ty ∩ khoá kết nối ∩ quyền CRM thật mỗi lượt; thao tác tiền / không lùi được luôn xem trước (sàn trong mã + hermes_action_policy_floor).
-- Trigger hermes_registry_projection_v2 chiếu lại khoá cho kết nối inherit_crm (không đổi danh tính, epoch, credential, loại trừ);
-- kết nối legacy_allowlist giữ nguyên. Chính sách năm thao tác expense.* đã có; file này chỉ kiểm, không chèn hay sửa.
-- Idempotent (chạy lại không đổi gì), không DROP, không ghi bảng nghiệp vụ. Lùi: docs/plans/hermes-crm/revert/
-- hermes_expense_actions_activation_revert_v1.sql (rào legacy_allowlist).
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $activate_expense$
DECLARE
  required_keys constant text[]:=ARRAY['income_expenses.approve_vouchers','income_expenses.cancel','income_expenses.create','income_expenses.edit'];
  signature text;
  missing text;
BEGIN
  IF to_regclass('app_private.hermes_capabilities') IS NULL
    OR to_regclass('app_private.hermes_connections') IS NULL
    OR to_regclass('app_private.hermes_action_policies') IS NULL
    OR to_regclass('app_private.hermes_action_receipts') IS NULL THEN
    RAISE EXCEPTION 'hermes_expense_activation_dependencies_missing';
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
    -- RPC trang và các tầng vỏ gắn (Mốc 2–5, lượt nghiệm thu).
    'public.hermes_expense_write_v1(jsonb,text,text,uuid,jsonb,jsonb,text)',
    'app_private.hermes_expense_write_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb)',
    'app_private.hermes_expense_resolve_core_v1(uuid,uuid[],text,jsonb)',
    'app_private.hermes_expense_scope_v1(jsonb,text)',
    'app_private.hermes_expense_create_run_v1(uuid,jsonb,jsonb,text)',
    'app_private.hermes_expense_manual_v1(uuid)',
    'app_private.hermes_expense_reason_v1(text,text,text)',
    'public.hermes_expense_category_pick_v1(uuid,text,text)',
    'public.hermes_expense_system_flow_v1(text,text)',
    -- Hàm ghi / hàm dùng chung của web mà bước ghi gọi đúng như form web.
    'public.create_income_expense_v1(text,text,uuid,uuid,uuid,uuid,text,text,text,uuid,jsonb,boolean,text,date,jsonb,text)',
    'public.append_income_expense_supplement_v1(uuid,text,jsonb,text)',
    'public.revise_pending_income_expense_v1(uuid,bigint,jsonb,jsonb,text,text)',
    'public.cancel_income_expense_flex_v1(uuid,text,bigint,bigint)',
    'public.approve_income_expense_v2(uuid,bigint,text)',
    'public.approve_and_post_income_expense_v2(jsonb)',
    'public.ie_category_suggest_v1(uuid,jsonb,text,boolean)',
    'public.ie_default_cashbook_v1(uuid,uuid,uuid)',
    -- Chiếu lại khoá cho kết nối inherit_crm.
    'app_private.hermes_refresh_registry_projection_v2()',
    'app_private.hermes_project_connection_limits_v2()'
  ] LOOP
    IF to_regprocedure(signature) IS NULL THEN
      RAISE EXCEPTION 'hermes_expense_activation_function_missing: %',signature;
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
    RAISE EXCEPTION 'hermes_expense_activation_projection_missing';
  END IF;

  -- Năm thao tác của trang phải có dòng chính sách đúng khoá Hermes + quyền CRM giao vào (024834 → 013109). expense.approve dùng khoá
  -- riêng của Hermes, quyền CRM giao vào là income_expenses.approve (Q25); sửa / huỷ giao vào income_expenses.create như hàm ghi web.
  SELECT string_agg(e.action,', ' ORDER BY e.action) INTO missing
    FROM (VALUES
      ('expense.approve','income_expenses.approve_vouchers','income_expenses.approve'),
      ('expense.cancel','income_expenses.cancel','income_expenses.create'),
      ('expense.create','income_expenses.create','income_expenses.create'),
      ('expense.edit','income_expenses.edit','income_expenses.create'),
      ('expense.note','income_expenses.create','income_expenses.create')) e(action,capability,crm_permission)
    LEFT JOIN app_private.hermes_action_policies p
      ON p.action=e.action AND p.capability=e.capability AND p.crm_permission=e.crm_permission
    WHERE p.action IS NULL;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'hermes_expense_activation_policy_missing: %',missing;
  END IF;

  PERFORM 1 FROM app_private.hermes_capabilities
    WHERE capability=ANY(required_keys) ORDER BY capability FOR UPDATE;
  IF (SELECT count(*) FROM app_private.hermes_capabilities
      WHERE capability=ANY(required_keys) AND mode='action')<>4 THEN
    RAISE EXCEPTION 'hermes_expense_activation_registry_invalid';
  END IF;

  UPDATE app_private.hermes_capabilities SET enabled=true
    WHERE capability=ANY(required_keys) AND mode='action' AND NOT enabled;

  IF (SELECT count(*) FROM app_private.hermes_capabilities
      WHERE capability=ANY(required_keys) AND mode='action' AND enabled)<>4 THEN
    RAISE EXCEPTION 'hermes_expense_activation_incomplete';
  END IF;
END
$activate_expense$;
COMMIT;
NOTIFY pgrst,'reload schema';
