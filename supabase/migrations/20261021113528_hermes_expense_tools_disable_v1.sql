-- Tắt tạm họ công cụ ghi phiếu chi cũ của Hermes (crm_expense_input_options,
-- crm_expense_create, crm_expense_status) — chủ dự án đồng ý 21/10/2026 ("hai việc
-- chờ chủ làm đi", câu 4 của plan thao tác Hermes). Lý do: 0 lần dùng từ khi có,
-- chưa thử với writer thật, chưa có bước xem trước/xác nhận ở máy chủ, và phiếu do
-- chủ lập vào sổ quỹ ngay. Bản mới (bộ tool ghi dùng chung có xác nhận hai lượt)
-- sẽ thay. Registry chỉ là trần toàn hệ: tắt `income_expenses.create` thì connector
-- không quảng bá và không cho gọi ba tool này với mọi kết nối (mayUseExpenseAction
-- đọc quyền hiệu lực); ý định trong overlay của từng kết nối giữ nguyên.
-- `income_expenses.approve` chỉ là overlay của chính tool tạo phiếu, không tool nào
-- khác dùng, nên để nguyên (tắt nó còn làm hỏng thêm kết nối legacy theo cùng cơ chế
-- dưới đây). Thiếu dòng thì RAISE, không tạo dòng mới.
-- CHẶN TRƯỚC (review độc lập PR #254): gia hạn token gọi hermes_validate_limits_v1 trên
-- action_capabilities đã lưu của kết nối; với kết nối `legacy_allowlist` còn giữ khoá
-- này, registry tắt làm gia hạn RAISE hermes_limits_invalid ⇒ token chết ≤ 15 phút.
-- Kết nối `inherit_crm` được trigger chiếu lại nên không bị. Vì vậy migration từ chối
-- khi còn kết nối legacy ACTIVE giữ khoá; xử lý trước: thu hẹp, chuyển inherit_crm,
-- hoặc thu hồi. Production 21/10: 0 kết nối như vậy (6 kết nối ACTIVE đều inherit_crm).
-- Bật lại: UPDATE … SET enabled=true bằng một forward migration khác.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
DO $disable$
DECLARE legacy int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app_private.hermes_capabilities c
                  WHERE c.capability='income_expenses.create' AND c.mode='action') THEN
    RAISE EXCEPTION 'hermes_capabilities_disable_missing: income_expenses.create';
  END IF;
  SELECT count(*) INTO legacy FROM app_private.hermes_connections h
   WHERE h.state='ACTIVE' AND h.permission_mode='legacy_allowlist'
     AND 'income_expenses.create'=ANY(h.action_capabilities);
  IF legacy>0 THEN
    RAISE EXCEPTION 'hermes_expense_disable_blocked: % kết nối legacy_allowlist ACTIVE còn giữ income_expenses.create', legacy
      USING HINT='Thu hẹp, chuyển inherit_crm hoặc thu hồi các kết nối đó trước; tắt registry sẽ làm gia hạn token của chúng thất bại.';
  END IF;
  UPDATE app_private.hermes_capabilities c SET enabled=false
    WHERE c.capability='income_expenses.create' AND c.mode='action' AND c.enabled;
END
$disable$;
COMMIT;
NOTIFY pgrst,'reload schema';
