// Ba lệnh phần LƯƠNG của sổ tổng cho bảng lương (bước 2 nối vào useManagerSalary / chốt / trả lương):
//   E12 salary_profit_inputs_v1            — đọc phần lợi nhuận của bảng lương (thay đọc thẳng bảng)
//   E13 salary_profit_settlement_freeze_v1 — NGAY TRƯỚC lock_salary_month_v2, từng nhân viên là cổ đông
//   E15 salary_profit_payout_quote_v1      — NGAY TRƯỚC salary_payout_v1, cùng người gọi, < 30 phút
// Hàm ném NGUYÊN lỗi PostgREST (để lớp gọi rẽ theo mã bằng profitLedgerErrorMessage) hoặc
// ProfitLedgerPayloadError khi biên nhận lệch hợp đồng.

import { supabase } from '@/integrations/supabase/client';
import { rpcNullable } from '@/lib/rpcNullable';
import { withBusyRetry } from './busyRetry';
import {
  readSalaryFreezeResult, readSalaryProfitInputs, readSalaryQuoteResult,
  type SalaryFreezeResult, type SalaryProfitInputs, type SalaryProfitStaff, type SalaryQuoteResult,
} from './salaryReaders';

/** Máy chủ nhận tối đa 200 nhân viên mỗi lời gọi. */
export const SALARY_PROFIT_INPUT_BATCH = 200;

/**
 * E12. Một lời gọi cho mọi nhân viên (có thể thuộc nhiều công ty — máy chủ tự xác định công ty của
 * từng người). Một nhân viên không đủ quyền ⇒ 42501 cho CẢ lệnh. Danh sách rỗng ⇒ không gọi.
 */
export async function fetchSalaryProfitInputs(periodMonth: string, staffIds: readonly string[]): Promise<SalaryProfitInputs> {
  const unique = [...new Set(staffIds)];
  const staff: SalaryProfitStaff[] = [];
  for (let start = 0; start < unique.length; start += SALARY_PROFIT_INPUT_BATCH) {
    const chunk = unique.slice(start, start + SALARY_PROFIT_INPUT_BATCH);
    const { data, error } = await supabase.rpc('salary_profit_inputs_v1', {
      p_period_month: periodMonth,
      p_staff_ids: chunk,
    });
    if (error) throw error;
    staff.push(...readSalaryProfitInputs(data, periodMonth, chunk).staff);
  }
  return { period_month: periodMonth, staff };
}

/** Khoá E13 theo lượt chốt: `requestKey` của lượt chốt lương + nhân viên (ổn định khi thử lại lượt đó). */
export function salaryFreezeKey(requestKey: string, staffId: string): string {
  return `${requestKey}:fz:${staffId}`;
}

/**
 * Khoá E15: MỚI cho mỗi lần báo giá (báo giá sống 30 phút; thử lại trả lương sau đó phải báo giá
 * lại với khoá mới), trong khi `payoutKey` — khoá của salary_payout_v1 — GIỮ NGUYÊN qua các lần thử.
 */
export function salaryQuoteKey(payoutKey: string): string {
  return `${payoutKey}:q:${crypto.randomUUID().slice(0, 8)}`;
}

export interface SalaryFreezeInput {
  staffId: string;
  periodMonth: string;
  /** Y_m đang hiện trên bảng lương (luật nháp). */
  expectedInvestment: number;
  /** Phần trừ tạm ứng định trừ (phải ≥ phần đã trừ); null = để máy chủ dùng D_m. */
  maxOffset: number | null;
  /** Thực nhận sẽ gửi lock_salary_month_v2 — BẮT BUỘC. */
  expectedTakeHome: number;
  idempotencyKey: string;
}

/** E13. PT409 SALARY_PROFIT_QUOTE_CHANGED ⇒ số vừa đổi: KHÔNG chốt, tải lại bảng lương. */
export async function freezeSalaryProfitSettlement(input: SalaryFreezeInput): Promise<SalaryFreezeResult> {
  const { data, error } = await withBusyRetry(() => supabase.rpc('salary_profit_settlement_freeze_v1', {
    p_staff_id: input.staffId,
    p_period_month: input.periodMonth,
    p_expected_investment: input.expectedInvestment,
    // `p_max_offset` không có DEFAULT nhưng nhận NULL (= không kẹp thêm).
    p_max_offset: rpcNullable(input.maxOffset),
    p_expected_take_home: input.expectedTakeHome,
    p_idempotency_key: input.idempotencyKey,
  }));
  if (error) throw error;
  return readSalaryFreezeResult(data, { staffId: input.staffId, periodMonth: input.periodMonth });
}

export interface SalaryQuoteInput {
  staffId: string;
  periodMonth: string;
  /** LUỸ KẾ phần đầu tư của tháng tính tới hết phiếu sắp lập. */
  investmentSelected: number;
  /** LUỸ KẾ phần trừ tạm ứng của tháng tính tới hết phiếu sắp lập. */
  offsetSelected: number;
  /** TỔNG phiếu lương sẽ lập (= thực nhận + tiền phòng khấu trừ thật). */
  expectedVoucherAmount: number;
  /** ĐÚNG `p_idempotency_key` sẽ gửi salary_payout_v1. */
  payoutKey: string;
  /** Khoá của chính lần báo giá (salaryQuoteKey). */
  idempotencyKey: string;
}

/**
 * E15. Lỗi PT409 / 22023 ⇒ dừng, KHÔNG lập phiếu lương. `needs_review_reason` khác null ⇒ nên dừng và
 * hiện lý do (lập tiếp thì dòng lợi nhuận "cần chủ xem lại", lương không mất).
 */
export async function quoteSalaryProfitPayout(input: SalaryQuoteInput): Promise<SalaryQuoteResult> {
  const { data, error } = await withBusyRetry(() => supabase.rpc('salary_profit_payout_quote_v1', {
    p_staff_id: input.staffId,
    p_period_month: input.periodMonth,
    p_investment_selected: input.investmentSelected,
    p_offset_selected: input.offsetSelected,
    p_expected_voucher_amount: input.expectedVoucherAmount,
    p_payout_idempotency_key: input.payoutKey,
    p_idempotency_key: input.idempotencyKey,
  }));
  if (error) throw error;
  return readSalaryQuoteResult(data, { staffId: input.staffId, periodMonth: input.periodMonth, payoutKey: input.payoutKey });
}
