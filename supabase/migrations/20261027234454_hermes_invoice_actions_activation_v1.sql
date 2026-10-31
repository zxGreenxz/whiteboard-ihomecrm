-- Hermes: bật thao tác ghi trang HOÁ ĐƠN trên production (runbook docs/plans/hermes-crm/BAT-KHOA-GHI-4-TRANG.md mục 4–5).
-- Thứ tự phát hành: SQL của trang đã áp (075230 → 093517), connector có danh mục Hoá đơn (danh mục production, có từ 3bd1313b, KHÔNG
-- cần actionPages), RỒI mới áp file này; sau đó SOUL owner và canary có chủ duyệt.
-- Bật đúng năm khoá registry của trang: thu_tien.collect_transfer (invoice.collect: thu chuyển khoản / thanh toán, KHÔNG tiền mặt — Q13),
-- meter_readings.create (invoice.meter_record), invoices.edit (invoice.adjust), invoices.approve (invoice.adjustment_check),
-- invoices.cancel (invoice.cancel + invoice.restore). Không seed / bật thu_tien.collect (M2 20261021134531 đòi khoá đó vắng).
-- Không đổi quyền CRM, chính sách công ty, loại trừ hay phạm vi kết nối: RPC trang vẫn giao registry ∩ trần công ty ∩ khoá kết nối ∩
-- quyền CRM thật mỗi lượt; mọi thao tác của trang là tiền / không lùi được ⇒ luôn xem trước (sàn trong mã + hermes_action_policy_floor).
-- Trigger hermes_registry_projection_v2 chiếu lại khoá cho kết nối inherit_crm (không đổi danh tính, epoch, credential, loại trừ);
-- kết nối legacy_allowlist giữ nguyên. Chính sách sáu thao tác invoice.* đã có; file này chỉ kiểm, không chèn hay sửa.
-- Idempotent (chạy lại không đổi gì), không DROP, không ghi bảng nghiệp vụ. Lùi: docs/plans/hermes-crm/revert/
-- hermes_invoice_actions_activation_revert_v1.sql (rào legacy_allowlist).
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $activate_invoice$
DECLARE
  required_keys constant text[]:=ARRAY['invoices.approve','invoices.cancel','invoices.edit','meter_readings.create','thu_tien.collect_transfer'];
  signature text;
  missing text;
BEGIN
  IF to_regclass('app_private.hermes_capabilities') IS NULL
    OR to_regclass('app_private.hermes_connections') IS NULL
    OR to_regclass('app_private.hermes_action_policies') IS NULL
    OR to_regclass('app_private.hermes_action_receipts') IS NULL THEN
    RAISE EXCEPTION 'hermes_invoice_activation_dependencies_missing';
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
    -- RPC trang và bảy tầng vỏ gắn hiện hành (thu tiền v3, chỉ số, điều chỉnh / xác nhận / huỷ / khôi phục v2).
    'public.hermes_invoice_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text)',
    'app_private.hermes_invoice_lookup_core_v3(uuid,uuid[],text,jsonb)',
    'app_private.hermes_invoice_action_step_v3(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb)',
    'app_private.hermes_invoice_meter_lookup_v1(uuid,uuid[],text,jsonb)',
    'app_private.hermes_invoice_meter_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb)',
    'app_private.hermes_invoice_edit_lookup_v1(uuid,uuid[],text,jsonb)',
    'app_private.hermes_invoice_edit_step_v2(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb)',
    'app_private.hermes_invoice_reason_v1(text,text,text)',
    'app_private.hermes_invoice_edit_reason_v1(text,text,text)',
    -- Hàm ghi / hàm dùng chung của web mà bước ghi gọi đúng như form web.
    'public.record_invoice_collection_v5(uuid,date,jsonb,text,boolean,text,text,numeric,text)',
    'public.invoice_collection_plan_v1(uuid,jsonb,jsonb)',
    'public.get_receiving_cashbooks_v1(uuid,uuid,uuid)',
    'public.invoice_room_invoices_v1(uuid,uuid,text,uuid[],date)',
    'public.record_meter_readings_v2(uuid,date,jsonb,boolean,text)',
    'public.meter_readings_plan_v1(uuid,date,jsonb,boolean)',
    'public.adjust_invoice_v2(uuid,jsonb,numeric,text,text,text,bigint,numeric,timestamp with time zone,text)',
    'public.invoice_adjustment_build_v1(uuid,jsonb)',
    'public.review_invoice_adjustment_v2(uuid,bigint)',
    'public.cancel_invoice_with_credit_v1(uuid,text)',
    'public.restore_invoice_with_credit_v1(uuid,text)',
    -- Chiếu lại khoá cho kết nối inherit_crm.
    'app_private.hermes_refresh_registry_projection_v2()',
    'app_private.hermes_project_connection_limits_v2()'
  ] LOOP
    IF to_regprocedure(signature) IS NULL THEN
      RAISE EXCEPTION 'hermes_invoice_activation_function_missing: %',signature;
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
    RAISE EXCEPTION 'hermes_invoice_activation_projection_missing';
  END IF;

  -- Sáu thao tác của trang phải có dòng chính sách đúng khoá Hermes + quyền CRM giao vào (075230 → 042723). invoice.collect dùng khoá
  -- riêng của Hermes, quyền CRM giao vào là thu_tien.collect (đúng quyền record_invoice_collection_v5 kiểm; HDN1).
  SELECT string_agg(e.action,', ' ORDER BY e.action) INTO missing
    FROM (VALUES
      ('invoice.adjust','invoices.edit','invoices.edit'),
      ('invoice.adjustment_check','invoices.approve','invoices.approve'),
      ('invoice.cancel','invoices.cancel','invoices.cancel'),
      ('invoice.collect','thu_tien.collect_transfer','thu_tien.collect'),
      ('invoice.meter_record','meter_readings.create','meter_readings.create'),
      ('invoice.restore','invoices.cancel','invoices.cancel')) e(action,capability,crm_permission)
    LEFT JOIN app_private.hermes_action_policies p
      ON p.action=e.action AND p.capability=e.capability AND p.crm_permission=e.crm_permission
    WHERE p.action IS NULL;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'hermes_invoice_activation_policy_missing: %',missing;
  END IF;

  PERFORM 1 FROM app_private.hermes_capabilities
    WHERE capability=ANY(required_keys) ORDER BY capability FOR UPDATE;
  IF (SELECT count(*) FROM app_private.hermes_capabilities
      WHERE capability=ANY(required_keys) AND mode='action')<>5 THEN
    RAISE EXCEPTION 'hermes_invoice_activation_registry_invalid';
  END IF;

  UPDATE app_private.hermes_capabilities SET enabled=true
    WHERE capability=ANY(required_keys) AND mode='action' AND NOT enabled;

  IF (SELECT count(*) FROM app_private.hermes_capabilities
      WHERE capability=ANY(required_keys) AND mode='action' AND enabled)<>5 THEN
    RAISE EXCEPTION 'hermes_invoice_activation_incomplete';
  END IF;
END
$activate_invoice$;
COMMIT;
NOTIFY pgrst,'reload schema';
