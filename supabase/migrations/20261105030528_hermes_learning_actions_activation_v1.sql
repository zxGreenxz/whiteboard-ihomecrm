-- Hermes: bật trang BÀI HỌC — đợt 3 học có kiểm duyệt (docs/plans/hermes-crm/HOC-CO-KIEM-DUYET.md mục 4.4, 4.9 bước 5).
-- Thứ tự phát hành: 20261105025453_hermes_learning_action_v1 đã áp (vỏ + bước + khoá seed TẮT, cột announced_at), web có nhãn khoá đã
-- promote, connector có trang learning chạy với cấu hình host `"actionPages": [..., "learning"]` (+ `publicWebOrigin`), RỒI mới áp file
-- này; sau đó skill chuẩn ihome-crm-bai-hoc, SOUL owner và job cron 21:00 (điều phối viên).
-- File này:
--  (1) chèn ĐÚNG hai dòng chính sách đã duyệt (mục 4.4): learning.digest reversible + never (chỉ ghi sổ "đã báo", không đổi dữ liệu
--      nghiệp vụ), learning.decide reversible + always (bản ghi quyết định một lần; SQL của trang còn có sàn luôn xem trước). Dòng có sẵn
--      khác bản đã duyệt (ON CONFLICT giữ dòng cũ) hoặc thao tác khác dùng khoá này ⇒ dừng, không nhận im lặng;
--  (2) bật khoá assistant.learning_review.
-- Không đổi quyền CRM (users.edit), chính sách công ty, loại trừ hay phạm vi kết nối: RPC trang vẫn giao registry ∩ trần công ty ∩ khoá
-- kết nối ∩ quyền CRM thật + cổng users.edit của trang web mỗi lượt. Trigger hermes_registry_projection_v2 chiếu lại khoá cho kết nối
-- inherit_crm (không đổi danh tính, epoch, credential, loại trừ); kết nối legacy_allowlist giữ nguyên.
-- Idempotent (INSERT … ON CONFLICT DO NOTHING; UPDATE … AND NOT enabled), không DROP, không ghi bảng nghiệp vụ. Lùi:
-- docs/plans/hermes-crm/revert/hermes_learning_actions_activation_revert_v1.sql (tắt khoá + xoá hai dòng; rào legacy_allowlist).
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $activate_learning$
DECLARE
  required_keys constant text[]:=ARRAY['assistant.learning_review'];
  signature text;
BEGIN
  IF to_regclass('app_private.hermes_capabilities') IS NULL
    OR to_regclass('app_private.hermes_connections') IS NULL
    OR to_regclass('app_private.hermes_action_policies') IS NULL
    OR to_regclass('app_private.hermes_action_receipts') IS NULL
    OR to_regclass('app_private.hermes_learning_proposals') IS NULL
    OR NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('app_private.hermes_learning_proposals') AND attname='announced_at'
      AND NOT attisdropped) THEN
    RAISE EXCEPTION 'hermes_learning_activation_dependencies_missing';
  END IF;

  FOREACH signature IN ARRAY ARRAY[
    -- Khung thao tác chung (M1): danh mục, tra trạng thái, guard, sổ biên nhận, lý do.
    'public.hermes_action_capabilities_v1(uuid)',
    'public.hermes_action_status_v1(jsonb,uuid)',
    'app_private.hermes_action_guard_v1(jsonb,text)',
    'app_private.hermes_action_receipt_begin_v1(jsonb,text,uuid,jsonb)',
    'app_private.hermes_action_receipt_finish_v1(jsonb,text,uuid,jsonb,text,text)',
    'app_private.hermes_action_reason_v1(text,text,text)',
    -- RPC trang (20261105025453) và tầng DEFINER nó gắn OID.
    'public.hermes_learning_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text)',
    'app_private.hermes_learning_action_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text)',
    -- Kho đề xuất (20261031041523): cổng người của web, lõi quyết định dùng chung, guard bất biến (dựng lại ở 20261105025453).
    'app_private.hermes_learning_admin_v1(uuid)',
    'app_private.hermes_learning_apply_v1(uuid,uuid,uuid[],text,text,uuid,text)',
    'app_private.hermes_learning_guard_v1()',
    -- Chiếu lại khoá cho kết nối inherit_crm.
    'app_private.hermes_refresh_registry_projection_v2()',
    'app_private.hermes_project_connection_limits_v2()'
  ] LOOP
    IF to_regprocedure(signature) IS NULL THEN
      RAISE EXCEPTION 'hermes_learning_activation_function_missing: %',signature;
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
    RAISE EXCEPTION 'hermes_learning_activation_projection_missing';
  END IF;

  PERFORM 1 FROM app_private.hermes_capabilities
    WHERE capability=ANY(required_keys) ORDER BY capability FOR UPDATE;
  IF (SELECT count(*) FROM app_private.hermes_capabilities
      WHERE capability=ANY(required_keys) AND mode='action')<>1 THEN
    RAISE EXCEPTION 'hermes_learning_activation_registry_invalid';
  END IF;

  INSERT INTO app_private.hermes_action_policies(action,capability,crm_permission,action_class,confirm,private_only) VALUES
    ('learning.digest','assistant.learning_review','users.edit','reversible','never',true),
    ('learning.decide','assistant.learning_review','users.edit','reversible','always',true)
    ON CONFLICT(action) DO NOTHING;
  -- Dòng có sẵn khác bản đã duyệt (ON CONFLICT giữ dòng cũ), hay thao tác khác dùng khoá này ⇒ dừng, không nhận im lặng.
  IF (SELECT count(*) FROM app_private.hermes_action_policies
      WHERE (action,capability,crm_permission,action_class,confirm,private_only) IN (
        ('learning.digest','assistant.learning_review','users.edit','reversible','never',true),
        ('learning.decide','assistant.learning_review','users.edit','reversible','always',true)))<>2
    OR EXISTS(SELECT 1 FROM app_private.hermes_action_policies
      WHERE capability=ANY(required_keys) AND action NOT IN ('learning.digest','learning.decide')) THEN
    RAISE EXCEPTION 'hermes_learning_activation_policy_invalid';
  END IF;

  UPDATE app_private.hermes_capabilities SET enabled=true
    WHERE capability=ANY(required_keys) AND mode='action' AND NOT enabled;

  IF (SELECT count(*) FROM app_private.hermes_capabilities
      WHERE capability=ANY(required_keys) AND mode='action' AND enabled)<>1 THEN
    RAISE EXCEPTION 'hermes_learning_activation_incomplete';
  END IF;
END
$activate_learning$;
COMMIT;
NOTIFY pgrst,'reload schema';
