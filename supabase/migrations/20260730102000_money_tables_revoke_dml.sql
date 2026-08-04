-- =====================================================================
-- Đợt 0 — Vá LỖ D: quyền DML thừa trên các bảng TIỀN
--
-- Đo được trên production (information_schema.role_table_grants):
--   accounts                 → authenticated: INSERT, UPDATE, DELETE, TRUNCATE
--   cash_handovers           → anon VÀ authenticated: INSERT, UPDATE, DELETE, TRUNCATE
--   cash_handover_items      → anon VÀ authenticated: INSERT, UPDATE, DELETE, TRUNCATE
--   cashbook_reconciliations → authenticated: INSERT, UPDATE, DELETE, TRUNCATE
--   income_expenses / _items → authenticated: TRUNCATE (DML đã REVOKE từ 20260723070000)
--
-- Vì sao phải vá dù RLS đang che:
--   1. `accounts` KHÔNG được RLS che — policy `accounts_update` là
--      `auth.uid() = user_id` và KHÔNG có trigger nào canh. Người phụ
--      trách sổ chạy một PATCH PostgREST là xoá `lock_date`, hoặc sửa
--      `initial_amount` — vốn là SỐ HẠNG TRỰC TIẾP của
--      `accounts_with_balance.current_amount` ⇒ đổi số dư mà không có
--      một dòng phiếu, một posting, hay một dòng nhật ký nào.
--      Đây là thứ khiến "chốt sổ khoá vĩnh viễn" (Đợt 6) KHÔNG THỂ
--      thành sự thật nếu không đóng trước.
--   2. Ba bảng còn lại hiện chỉ sống nhờ VẮNG MẶT policy ghi. Nhưng
--      TRUNCATE KHÔNG chịu RLS — một bản ghi chốt sổ vĩnh viễn không
--      được phép dựa vào "may mà chưa ai viết policy".
--
-- An toàn: mọi đường ghi hợp lệ đã đi qua RPC SECURITY DEFINER
--   accounts   → create_cashbook_v1 / update_cashbook_metadata_v1 /
--                archive_cashbook_v1 / lock_cashbook_period_v1
--                (đã kiểm: cả 4 tồn tại và GRANT cho authenticated)
--   handover   → create_cash_handover / confirm_cash_handover /
--                request_cancel_handover / confirm_cancel_handover /
--                reject_cancel_handover
--   reconcile  → propose_reconciliation / confirm_reconciliation /
--                cancel_reconciliation
-- Các nhánh `.from("accounts").update(...)` còn lại trong FE là fallback
-- CHẾT: `isCanonicalFallbackSignal` chỉ nhận PGRST202 hoặc 55000+"chưa
-- bật", mà cả 4 cờ cashbook.* đang ON.
--
-- GIỮ NGUYÊN quyền SELECT trên cả 5 bảng.
-- =====================================================================

BEGIN;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.accounts
  FROM authenticated, anon;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.cash_handovers
  FROM authenticated, anon;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.cash_handover_items
  FROM authenticated, anon;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.cashbook_reconciliations
  FROM authenticated, anon;

-- income_expenses/_items đã mất INSERT/UPDATE/DELETE ở 20260723070000
-- nhưng TRUNCATE thì chưa — và TRUNCATE bỏ qua cả RLS lẫn trigger BEFORE
-- ROW (guard a00_ie_truncate_freeze là trigger STATEMENT, chỉ raise khi
-- CÓ dòng flow-ownership, tức phụ thuộc dữ liệu).
REVOKE TRUNCATE ON public.income_expenses      FROM authenticated, anon;
REVOKE TRUNCATE ON public.income_expense_items FROM authenticated, anon;
REVOKE TRUNCATE ON public.income_expense_postings      FROM authenticated, anon;
REVOKE TRUNCATE ON public.income_expense_posting_lines FROM authenticated, anon;

COMMIT;
