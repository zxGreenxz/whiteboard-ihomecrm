// E12 (salary_profit_inputs_v1) cho MỘT nhân viên + kỳ — dùng ở hộp "Xác nhận phần lương" (E16):
// phần bù tạm ứng còn trừ được của tháng (D_m − ΣD), phần đầu tư còn lại (Y_cap − ΣY), dòng phiếu
// lương cần xem lại (tiền phiếu, số máy gợi ý). Gọi qua API lương có sẵn của bước 1
// (fetchSalaryProfitInputs) — không thêm lời gọi RPC mới.
//
// Khoá gốc 'manager-salary': cùng nhóm làm mới với bảng lương — chốt / mở chốt / trả lương và mọi
// lệnh ghi sổ tổng (invalidateProfitLedgerQueries) đều làm mới gốc này; realtime income_expenses cũng vậy.

import { useQuery } from '@tanstack/react-query';
import { classifyDbError, isRetryable } from '@/lib/contracts/errors';
import { fetchSalaryProfitInputs } from '@/lib/profitLedger/salaryProfitApi';
import type { SalaryProfitStaff } from '@/lib/profitLedger/salaryReaders';

export function useSalaryProfitStaffInputs(input: {
  periodMonth: string | null | undefined;
  staffId: string | null | undefined;
  enabled?: boolean;
}) {
  return useQuery({
    queryKey: ['manager-salary', 'profit-inputs', input.periodMonth ?? null, input.staffId ?? null],
    enabled: !!input.periodMonth && !!input.staffId && (input.enabled ?? true),
    staleTime: 0,
    // Chỉ thử lại khi máy chủ bận ở tầng khoá; quyền / đầu vào sai thử lại cũng sai y vậy.
    retry: (failureCount: number, error: unknown) => failureCount < 1 && isRetryable(classifyDbError(error)),
    meta: { label: 'phần lợi nhuận trong lương', errorDisplay: 'inline' },
    queryFn: async (): Promise<SalaryProfitStaff | null> => {
      const staffId = input.staffId as string;
      const result = await fetchSalaryProfitInputs(input.periodMonth as string, [staffId]);
      return result.staff.find((row) => row.staff_id === staffId) ?? null;
    },
  });
}
