-- Bật registry cho các năng lực Hermes đã có code và đã apply production
-- (chủ dự án 16/10/2026: "làm cho xong và đưa lên production"). Registry chỉ là
-- trần toàn hệ: mỗi kết nối vẫn phải tự chọn Đọc/Thao tác trong overlay, quyền CRM
-- hiện tại của user, chính sách công ty và phạm vi toà vẫn áp dụng; mọi action
-- giữ idempotency/biên nhận và điều kiện nghiệp vụ của writer CRM (phiếu chi qua
-- create_income_expense_v1, không tự duyệt ngoài thang duyệt hiện có).
-- sale_phong.manage_pass_listings do 20261015163023 bật riêng. Thiếu dòng nào thì
-- RAISE, không tạo dòng mới. Tắt lại: UPDATE … SET enabled=false bằng forward khác.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
DO $enable$
DECLARE wanted constant text[][] := ARRAY[
  ARRAY['assistant.memory.read','read'], ARRAY['assistant.memory.write','action'],
  ARRAY['assistant.memory.supervise','read'],
  ARRAY['customers.view','read'], ARRAY['leads.view','read'], ARRAY['contracts.view','read'],
  ARRAY['invoices.view','read'], ARRAY['assets.view','read'], ARRAY['services.view','read'],
  ARRAY['tasks.view','read'], ARRAY['reports_real_estate.occupancy','read'],
  ARRAY['income_expenses.view','read'], ARRAY['meter_readings.view','read'],
  ARRAY['deposits.view','read'], ARRAY['reports_finance.analysis','read'],
  ARRAY['tasks.create','action'], ARRAY['tasks.edit','action'], ARRAY['tasks.delete','action'],
  ARRAY['customers.create','action'], ARRAY['leads.create','action'],
  ARRAY['income_expenses.create','action'], ARRAY['income_expenses.approve','action'],
  ARRAY['chat_zalo.manage_automation','action']];
  missing int;
BEGIN
  SELECT count(*) INTO missing FROM generate_subscripts(wanted,1) i
    WHERE NOT EXISTS(SELECT 1 FROM app_private.hermes_capabilities c
      WHERE c.capability=wanted[i][1] AND c.mode=wanted[i][2]);
  IF missing<>0 THEN
    RAISE EXCEPTION 'hermes_capabilities_enable_missing: % dòng', missing;
  END IF;
  UPDATE app_private.hermes_capabilities c SET enabled=true
    FROM generate_subscripts(wanted,1) i
    WHERE c.capability=wanted[i][1] AND c.mode=wanted[i][2] AND NOT c.enabled;
END
$enable$;
COMMIT;
NOTIFY pgrst,'reload schema';
