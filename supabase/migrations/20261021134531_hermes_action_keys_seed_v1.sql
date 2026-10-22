-- Đợt 1 nền chung thao tác ghi Hermes — M2 (21/10/2026; docs/plans/hermes-crm/NEN-CHUNG-THAO-TAC-GHI.md mục 8.3, D5 = O1).
-- Đăng ký sẵn mọi khoá ghi dự kiến của ba trang ở trạng thái TẮT trong registry, để mỗi trang chỉ cần migration bật khoá
-- (kết nối inherit_crm nhận khoá khi khoá được bật — 6/6 kết nối ACTIVE production là inherit_crm, đọc 21/10).
-- Không seed thu_tien.collect: chủ chọn không thu tiền mặt và không hoàn tác lần thu qua bot (câu 13, 14).
-- Khoá TẮT không hiện ở màn tạo kết nối và không vào phép chiếu quyền của kết nối nào, nên migration này không đổi quyền
-- của ai. Trước khi BẬT khoá nào: connector và web phải có khoá đó trong infra/hermes-broker/capability-contract.mjs + nhãn
-- (bài học 19/10), và phải làm O2 hoặc loại trừ khoá tiền trước khi cấp Hermes cho Quản Lý Tòa (câu 7).
-- Tên khoá chốt theo plan từng trang; khoá trùng tên quyền CRM ánh xạ thẳng, khoá riêng Hermes (approve_vouchers) ánh xạ
-- trong hàm của trang. Idempotent: ON CONFLICT DO NOTHING + khối kiểm (không lặng lẽ đổi mode của dòng có sẵn).
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $requires$
BEGIN
  IF to_regclass('app_private.hermes_capabilities') IS NULL THEN RAISE EXCEPTION 'hermes_action_keys_dependency_invalid'; END IF;
  -- Một khoá trùng tên đã có ở mode khác thì dừng: không biến khoá Đọc thành khoá Thao tác.
  IF EXISTS(SELECT 1 FROM app_private.hermes_capabilities WHERE capability IN ('income_expenses.edit','income_expenses.cancel',
      'income_expenses.approve_vouchers','meter_readings.create','invoices.edit','invoices.cancel','invoices.approve','contracts.terminate',
      'contracts.renew','contracts.edit','sale_phong.lock_room','contracts.create','contracts.transfer') AND mode<>'action') THEN
    RAISE EXCEPTION 'hermes_action_keys_mode_conflict'; END IF;
END $requires$;

INSERT INTO app_private.hermes_capabilities(capability,mode,enabled) VALUES
  -- Thu chi
  ('income_expenses.edit','action',false),('income_expenses.cancel','action',false),('income_expenses.approve_vouchers','action',false),
  -- Hoá đơn (không có thu_tien.collect)
  ('meter_readings.create','action',false),('invoices.edit','action',false),('invoices.cancel','action',false),('invoices.approve','action',false),
  -- Hợp đồng
  ('contracts.terminate','action',false),('contracts.renew','action',false),('contracts.edit','action',false),('sale_phong.lock_room','action',false),
  ('contracts.create','action',false),('contracts.transfer','action',false)
  ON CONFLICT(capability) DO NOTHING;

DO $check$
BEGIN
  IF (SELECT count(*) FROM app_private.hermes_capabilities WHERE mode='action' AND capability IN ('income_expenses.edit','income_expenses.cancel',
      'income_expenses.approve_vouchers','meter_readings.create','invoices.edit','invoices.cancel','invoices.approve','contracts.terminate',
      'contracts.renew','contracts.edit','sale_phong.lock_room','contracts.create','contracts.transfer'))<>13
    OR EXISTS(SELECT 1 FROM app_private.hermes_capabilities WHERE capability='thu_tien.collect') THEN
    RAISE EXCEPTION 'hermes_action_keys_seed_invalid'; END IF;
END $check$;
COMMIT;
