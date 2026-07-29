-- PR-3 / file 1 — thêm 2 giá trị vào enum public.notification_type cho hệ thông báo mới.
--
-- ĐẶC TẢ: §B.0 (khối "Enum mới — file migration RIÊNG, 2 câu").
--   ACTION_REQUIRED  — việc đang chờ CHÍNH TÔI làm (E1 phiếu chờ tôi duyệt, E4 việc được giao,
--                      E5 bàn giao tiền mặt chờ tôi xác nhận).
--   APPROVAL_RESULT  — kết quả phiếu CỦA TÔI (E2 được duyệt/bị từ chối, E3 bị huỷ khi đang chờ).
--
-- TRẠNG THÁI TRƯỚC KHI APPLY (đo thật qua pg_enum ngày 29/07/2026, khớp §3.7):
--   enum có ĐÚNG 9 giá trị — NEW_INVOICE, PAYMENT_REMINDER, OVERDUE_INVOICE, CONTRACT_EXPIRING,
--   ISSUE_RESOLVED, GENERAL_ANNOUNCEMENT, CUSTOM, DEPOSIT_SHORTFALL, SALARY_BONUS.
--   Sau file này: 11 giá trị.
--
-- VÌ SAO ĐỨNG RIÊNG MỘT FILE (§3.3): scripts/apply-migration.mjs POST NGUYÊN FILE làm MỘT query
--   ⇒ cả file là MỘT transaction. PostgreSQL 17.6 (đã kiểm bằng select version()) cho phép
--   ALTER TYPE ... ADD VALUE trong transaction block, NHƯNG cấm DÙNG giá trị mới trong cùng
--   transaction đó. Vì vậy file này KHÔNG được chứa bất kỳ câu lệnh nào tham chiếu
--   'ACTION_REQUIRED'/'APPROVAL_RESULT' — trigger/hàm sinh thông báo nằm ở file migration SAU.
--   Án lệ: supabase/migrations/20260603000002_notification_type_deposit_shortfall.sql
--
-- IDEMPOTENT: ADD VALUE IF NOT EXISTS — chạy lại lần hai là no-op, không lỗi.

begin;

alter type public.notification_type add value if not exists 'ACTION_REQUIRED';
alter type public.notification_type add value if not exists 'APPROVAL_RESULT';

commit;
