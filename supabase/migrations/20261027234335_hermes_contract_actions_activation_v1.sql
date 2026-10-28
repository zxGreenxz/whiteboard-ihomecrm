-- Hermes: bật thao tác ghi trang HỢP ĐỒNG trên production (runbook docs/plans/hermes-crm/BAT-KHOA-GHI-4-TRANG.md mục 4–5).
-- Thứ tự phát hành: SQL của trang đã áp (022951 → 160001), connector có danh mục Hợp đồng + mượn khoá Sale (#300, có từ 3bd1313b)
-- chạy với cấu hình host `"actionPages": ["contract"]`, RỒI mới áp file này; sau đó SOUL owner và canary có chủ duyệt.
-- Bật đúng bốn khoá registry của trang: contracts.create (contract.draft), contracts.edit (occupant_add / occupant_remove),
-- contracts.renew (renew / renew_batch), contracts.terminate (notice_set / notice_cancel / return).
-- KHÔNG đụng sale_phong.lock_room: contract.room_lock / room_unlock MƯỢN khoá của lớp Sale (bật ở 20261022121254); file lùi của
-- trang cũng không tắt nó. KHÔNG bật contracts.transfer (không thao tác nào dùng). Không đổi quyền CRM, chính sách công ty, loại
-- trừ hay phạm vi của kết nối: RPC trang vẫn giao registry ∩ trần công ty ∩ khoá kết nối ∩ quyền CRM thật mỗi lượt.
-- Trigger hermes_registry_projection_v2 chiếu lại khoá cho kết nối inherit_crm (không đổi danh tính, epoch, credential, loại trừ);
-- kết nối legacy_allowlist giữ nguyên. Chính sách 10 thao tác contract.* đã có; file này chỉ kiểm, không chèn hay sửa.
-- Idempotent (chạy lại không đổi gì), không DROP, không ghi bảng nghiệp vụ. Lùi: docs/plans/hermes-crm/revert/
-- hermes_contract_actions_activation_revert_v1.sql (rào legacy_allowlist).
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $activate_contract$
DECLARE
  required_keys constant text[]:=ARRAY['contracts.create','contracts.edit','contracts.renew','contracts.terminate'];
  signature text;
  missing text;
BEGIN
  IF to_regclass('app_private.hermes_capabilities') IS NULL
    OR to_regclass('app_private.hermes_connections') IS NULL
    OR to_regclass('app_private.hermes_action_policies') IS NULL
    OR to_regclass('app_private.hermes_action_receipts') IS NULL THEN
    RAISE EXCEPTION 'hermes_contract_activation_dependencies_missing';
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
    -- RPC trang và các tầng vỏ gắn (Mốc 2–6).
    'public.hermes_contract_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text)',
    'public.hermes_contract_action_lookup_v1(uuid,uuid)',
    'public.hermes_contract_party_lookup_v1(uuid,uuid,uuid[],text,jsonb)',
    'public.hermes_contract_batch_lookup_v1(uuid,uuid[],uuid,date)',
    'app_private.hermes_contract_action_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb,jsonb)',
    'app_private.hermes_contract_batch_step_v1(jsonb,text,uuid,jsonb,jsonb,text,jsonb,jsonb)',
    'app_private.hermes_contract_reason_v1(text,text,text)',
    'app_private.hermes_contract_date_label_v1(date,date)',
    -- Hàm ghi web mà bước ghi gọi đúng như form web.
    'public.set_contract_move_out_notice_v1(uuid,uuid,timestamp with time zone,date,text)',
    'public.renew_contract_with_notice_v1(uuid,uuid,timestamp with time zone,date,text,uuid,numeric,numeric,text,text)',
    'public.contract_renewal_end_date_v1(date,integer)',
    'public.confirm_contract_return_v1(uuid,uuid,timestamp with time zone,text,date,text,text,jsonb,jsonb,text)',
    'public.reconcile_contract_customers_v1(uuid,uuid,jsonb,jsonb)',
    'public.save_contract_draft(uuid,uuid,uuid,jsonb,uuid,uuid,integer,uuid)',
    'public.lock_room_for_sale_v1(uuid,uuid,integer,text)',
    'public.release_room_sale_lock_v1(uuid,uuid)',
    -- Chiếu lại khoá cho kết nối inherit_crm.
    'app_private.hermes_refresh_registry_projection_v2()',
    'app_private.hermes_project_connection_limits_v2()'
  ] LOOP
    IF to_regprocedure(signature) IS NULL THEN
      RAISE EXCEPTION 'hermes_contract_activation_function_missing: %',signature;
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
    RAISE EXCEPTION 'hermes_contract_activation_projection_missing';
  END IF;

  -- Mười thao tác của trang phải có dòng chính sách đúng khoá + quyền CRM giao vào (022951 → 030305): bật khoá mở đúng các
  -- thao tác này. confirm / private_only là núm chính sách (chỉ siết được), không ghim ở đây.
  SELECT string_agg(e.action,', ' ORDER BY e.action) INTO missing
    FROM (VALUES
      ('contract.draft','contracts.create','contracts.create'),
      ('contract.notice_cancel','contracts.terminate','contracts.terminate'),
      ('contract.notice_set','contracts.terminate','contracts.terminate'),
      ('contract.occupant_add','contracts.edit','contracts.edit'),
      ('contract.occupant_remove','contracts.edit','contracts.edit'),
      ('contract.renew','contracts.renew','contracts.renew'),
      ('contract.renew_batch','contracts.renew','contracts.renew'),
      ('contract.return','contracts.terminate','contracts.terminate'),
      ('contract.room_lock','sale_phong.lock_room','sale_phong.lock_room'),
      ('contract.room_unlock','sale_phong.lock_room','sale_phong.lock_room')) e(action,capability,crm_permission)
    LEFT JOIN app_private.hermes_action_policies p
      ON p.action=e.action AND p.capability=e.capability AND p.crm_permission=e.crm_permission
    WHERE p.action IS NULL;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'hermes_contract_activation_policy_missing: %',missing;
  END IF;

  PERFORM 1 FROM app_private.hermes_capabilities
    WHERE capability=ANY(required_keys) ORDER BY capability FOR UPDATE;
  IF (SELECT count(*) FROM app_private.hermes_capabilities
      WHERE capability=ANY(required_keys) AND mode='action')<>4 THEN
    RAISE EXCEPTION 'hermes_contract_activation_registry_invalid';
  END IF;

  UPDATE app_private.hermes_capabilities SET enabled=true
    WHERE capability=ANY(required_keys) AND mode='action' AND NOT enabled;

  IF (SELECT count(*) FROM app_private.hermes_capabilities
      WHERE capability=ANY(required_keys) AND mode='action' AND enabled)<>4 THEN
    RAISE EXCEPTION 'hermes_contract_activation_incomplete';
  END IF;

  -- Khoá mượn: chỉ báo, không đổi. Tắt ⇒ contract.room_lock / room_unlock ẩn, tám thao tác kia vẫn chạy.
  IF NOT EXISTS(SELECT 1 FROM app_private.hermes_capabilities
      WHERE capability='sale_phong.lock_room' AND mode='action' AND enabled) THEN
    RAISE NOTICE 'hermes_contract_activation: sale_phong.lock_room đang tắt (lớp Sale) — khoá tạm / gỡ khoá tạm của Hợp đồng sẽ ẩn';
  END IF;
END
$activate_contract$;
COMMIT;
NOTIFY pgrst,'reload schema';
