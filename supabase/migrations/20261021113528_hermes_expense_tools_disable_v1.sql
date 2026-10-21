-- Tắt tạm họ công cụ ghi phiếu chi cũ của Hermes (crm_expense_input_options,
-- crm_expense_create, crm_expense_status) — chủ dự án đồng ý 21/10/2026 ("hai việc
-- chờ chủ làm đi", câu 4 của plan thao tác Hermes). Lý do: 0 lần dùng từ khi có,
-- chưa thử với writer thật, chưa có bước xem trước/xác nhận ở máy chủ, và phiếu do
-- chủ lập vào sổ quỹ ngay. Bản mới (bộ tool ghi dùng chung có xác nhận hai lượt)
-- sẽ thay. Registry chỉ là trần toàn hệ: tắt `income_expenses.create` thì connector
-- không quảng bá và không cho gọi ba tool này với mọi kết nối (mayUseExpenseAction
-- đọc quyền hiệu lực); ý định trong overlay của từng kết nối giữ nguyên.
-- `income_expenses.approve` chỉ là overlay của chính tool tạo phiếu, không tool nào
-- khác dùng, nên để nguyên. Thiếu dòng thì RAISE, không tạo dòng mới.
-- Bật lại: UPDATE … SET enabled=true bằng một forward migration khác.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
DO $disable$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app_private.hermes_capabilities c
                  WHERE c.capability='income_expenses.create' AND c.mode='action') THEN
    RAISE EXCEPTION 'hermes_capabilities_disable_missing: income_expenses.create';
  END IF;
  UPDATE app_private.hermes_capabilities c SET enabled=false
    WHERE c.capability='income_expenses.create' AND c.mode='action' AND c.enabled;
END
$disable$;
COMMIT;
NOTIFY pgrst,'reload schema';
