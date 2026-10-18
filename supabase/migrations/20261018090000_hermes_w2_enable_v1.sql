-- Hermes đọc đầy đủ — ĐỢT 2, Gói Z (tích hợp, 18/10/2026): CÔNG TẮC bật khoá đọc đợt 2 trong registry.
-- Áp SAU mọi file nền (2026101800xxxx), gói A–D (2026101801xxxx … 2026101804xxxx) và bản sửa tích hợp
-- (2026101808xxxx_hermes_w2z_*). Registry chỉ là TRẦN toàn hệ: mỗi công ty vẫn phải chọn khoá trong chính sách,
-- mỗi kết nối tự chọn Đọc + phạm vi toà, quyền CRM thật của người hỏi và RLS vẫn quyết định; chủ phải tạo lại kết nối
-- (và liên kết lại Zalo) để kết nối nhận khoá mới.
-- Bật 32 khoá = khoá đợt 2 là khoá của ít nhất một báo cáo đã đăng ký (infra/hermes-broker/wave2-registry.mjs,
-- W2_ENABLED_KEYS), cộng khoá phụ income_expenses.restricted_view (scopeKeys của top khoản chi, hạng mục thu/chi, Hiệu quả
-- kinh doanh). GIỮ TẮT (seed ở 20261018000000, chưa có báo cáo nào dùng): reports_finance.deposits_report,
-- reports_finance.handover_report, reports_finance.collection_cycle.
-- Thiếu dòng nào thì RAISE (không tạo dòng mới); chưa có bản sửa tích hợp thì RAISE (không bật trên hàm chưa sửa).
-- Tắt lại: UPDATE … SET enabled=false bằng một forward khác. Không DROP, không đổi hàm, không ghi dữ liệu nghiệp vụ.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

DO $requires$
BEGIN
  IF to_regprocedure('app_private.hermes_w2_gate_v1(jsonb,text,jsonb)') IS NULL
    OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid=to_regprocedure('app_private.hermes_w2a_read_v1(text,jsonb,jsonb)')
      AND strpos(p.prosrc,'v_inv_text')>0)
    OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid=to_regprocedure('app_private.hermes_w2b_read_v1(text,jsonb,jsonb)')
      AND strpos(p.prosrc,'v_ok:=COALESCE(')>0)
    OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid=to_regprocedure('public.notifications_inbox_v1(uuid,boolean,text,integer)')
      AND strpos(p.prosrc,'n.organization_id IS NULL')=0)
    OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid=to_regprocedure('app_private.hermes_w2d_read_v1(text,jsonb,jsonb)')
      AND strpos(p.prosrc,'nv.ok')>0) THEN
    RAISE EXCEPTION 'hermes_w2_enable_requires_w2z_fixes';
  END IF;
END $requires$;

DO $enable$
DECLARE wanted constant text[] := ARRAY[
  'reports_finance.payment_schedule','reports_finance.overpayment','thu_tien.view','reports_finance.daily_cashbook',
  'reports_finance.cash_flow','cashbooks.view','income_expenses.restricted_view',
  'reports_finance.profit_distribution','shareholder_profit.view','personal_finance.view',
  'assistant.bank_events.read','vehicles.view','materials.view','warehouses.view','salary.view',
  'assistant.salary.self','notifications.view','network_center.view','buildings.view','meters.view','suppliers.view',
  'hotline.view','task_types.view','service_quotas.view','categories.view','reports_real_estate.vacant_rooms',
  'reports_real_estate.expiring','reports_real_estate.renewals_transfers','reports_real_estate.promotions',
  'reports_real_estate.new_leases','reports_real_estate.terminations','reports_real_estate.expense_ratio'];
  missing int;
BEGIN
  SELECT count(*) INTO missing FROM unnest(wanted) k
    WHERE NOT EXISTS(SELECT 1 FROM app_private.hermes_capabilities c WHERE c.capability=k AND c.mode='read');
  IF missing<>0 THEN
    RAISE EXCEPTION 'hermes_w2_enable_missing: % khoá', missing;
  END IF;
  UPDATE app_private.hermes_capabilities c SET enabled=true
    WHERE c.capability=ANY(wanted) AND c.mode='read' AND NOT c.enabled;
END
$enable$;
COMMIT;
NOTIFY pgrst,'reload schema';
