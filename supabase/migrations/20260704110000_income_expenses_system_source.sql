-- =============================================================================
-- M2 — Chương trình "Thống nhất tài chính toàn web" (plan 04/07)
--
-- Cột `system_source` chuẩn hoá NGUỒN SINH PHIẾU máy-tạo — thay cho 6 kiểu
-- marker text lẫn lộn trong notes ([CHUYỂN KHOẢN], [CẤN CỌC BỎ CỌC], [BÀN GIAO],
-- [BACKFILL_INITIAL_DEPOSIT], [HOÀN KHÁCH THANH LÝ], [Hoàn trả thanh lý]).
-- Quy ước `nguồn.hành_động`; NULL = phiếu nhập tay.
--
-- Backfill ƯU TIÊN LINK CỘT (bằng chứng chắc, user không sửa được) rồi mới tới
-- marker/name (fallback). CHỈ GÁN NHÃN — không đổi bất kỳ số nào.
-- =============================================================================

ALTER TABLE public.income_expenses ADD COLUMN IF NOT EXISTS system_source text;

COMMENT ON COLUMN public.income_expenses.system_source IS
  'Nguồn sinh phiếu tự động (quy ước nguồn.hành_động: invoice.payment, contract.deposit, termination.offset/revenue/forfeit_offset/forfeit_revenue/refund/extra_receipt, handover.transfer, backfill.initial_deposit, profit.distribution, salary.staff/manager, utility.bill, adjustment.*). NULL = phiếu nhập tay.';

CREATE INDEX IF NOT EXISTS idx_income_expenses_system_source
  ON public.income_expenses (system_source) WHERE system_source IS NOT NULL;

-- ── Backfill theo LINK CỘT (ưu tiên cao → thấp, chỉ ghi khi còn NULL) ─────────
UPDATE public.income_expenses SET system_source = 'handover.transfer'
 WHERE system_source IS NULL AND handover_transfer_id IS NOT NULL;

UPDATE public.income_expenses SET system_source = 'profit.distribution'
 WHERE system_source IS NULL AND shareholder_id IS NOT NULL;

UPDATE public.income_expenses SET system_source = 'salary.staff'
 WHERE system_source IS NULL AND salary_staff_id IS NOT NULL;

UPDATE public.income_expenses SET system_source = 'salary.manager'
 WHERE system_source IS NULL AND profit_manager_id IS NOT NULL;

UPDATE public.income_expenses SET system_source = 'invoice.payment'
 WHERE system_source IS NULL AND payment_id IS NOT NULL;

-- ── Backfill theo MARKER notes / name (fallback) ─────────────────────────────
-- Bàn giao thế hệ cũ (trước khi có cột handover_transfer_id)
UPDATE public.income_expenses SET system_source = 'handover.transfer'
 WHERE system_source IS NULL AND notes LIKE '[BÀN GIAO]%';

-- Cặp cấn cọc BỎ CỌC (deferred)
UPDATE public.income_expenses SET system_source =
       CASE WHEN type = 'EXPENSE' THEN 'termination.forfeit_offset'
            ELSE 'termination.forfeit_revenue' END
 WHERE system_source IS NULL AND notes LIKE '[CẤN CỌC BỎ CỌC%';

-- Cặp cấn cọc RỜI PHÒNG ([CHUYỂN KHOẢN] chỉ do RPC thanh lý ghi)
UPDATE public.income_expenses SET system_source =
       CASE WHEN type = 'EXPENSE' THEN 'termination.offset'
            ELSE 'termination.revenue' END
 WHERE system_source IS NULL AND notes LIKE '[CHUYỂN KHOẢN]%';

-- Cấn cọc thế hệ đầu ([ĐỐI TRỪ] — mô hình cũ trước 2026-06)
UPDATE public.income_expenses SET system_source =
       CASE WHEN type = 'EXPENSE' THEN 'termination.offset' ELSE 'termination.revenue' END
 WHERE system_source IS NULL AND notes LIKE '[ĐỐI TRỪ]%';

-- Hoàn khách thanh lý (cả 2 thế hệ marker + phiếu thế hệ cũ không marker)
UPDATE public.income_expenses SET system_source = 'termination.refund'
 WHERE system_source IS NULL
   AND (notes LIKE '[HOÀN KHÁCH THANH LÝ]%'
     OR notes LIKE '[Hoàn trả thanh lý]%'
     OR name  LIKE 'Trả khách thanh lý%'
     OR name  LIKE 'Hoàn trả khách thanh lý%'
     OR name  LIKE 'Hoàn tiền thừa khi thanh lý%');

UPDATE public.income_expenses SET system_source = 'termination.extra_receipt'
 WHERE system_source IS NULL AND name LIKE 'Khách trả thêm khi thanh lý%';

UPDATE public.income_expenses SET system_source = 'backfill.initial_deposit'
 WHERE system_source IS NULL AND notes LIKE '[BACKFILL_INITIAL_DEPOSIT]%';

UPDATE public.income_expenses SET system_source = 'utility.bill'
 WHERE system_source IS NULL
   AND (name LIKE 'Đóng tiền điện%' OR name LIKE 'Đóng tiền nước%');

UPDATE public.income_expenses SET system_source = 'contract.commission'
 WHERE system_source IS NULL
   AND (name LIKE 'Hoa hồng môi giới%' OR name LIKE 'Thưởng nóng Sale%');

-- Phiếu thu CỌC: có item hạng-mục-cọc (is_deposit). Gắn HĐ → contract.deposit;
-- chưa gắn HĐ (giữ chỗ) → deposit.reservation.
UPDATE public.income_expenses ie SET system_source =
       CASE WHEN ie.contract_id IS NOT NULL THEN 'contract.deposit'
            ELSE 'deposit.reservation' END
 WHERE ie.system_source IS NULL
   AND ie.type = 'INCOME'
   AND EXISTS (
     SELECT 1 FROM income_expense_items it
     JOIN income_expense_types t ON t.id = it.income_expense_type_id
     WHERE it.income_expense_id = ie.id AND t.is_deposit = TRUE
   );

-- Thu tiền theo hoá đơn thế hệ cũ (mirror phiếu không có payment_id)
UPDATE public.income_expenses SET system_source = 'invoice.payment'
 WHERE system_source IS NULL AND invoice_id IS NOT NULL AND type = 'INCOME'
   AND (name LIKE 'Thu tiền theo HĐ%' OR name LIKE 'Thu cọc theo HĐ%' OR name LIKE 'HĐ %');
