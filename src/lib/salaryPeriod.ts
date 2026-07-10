// Helper kỳ lương CANONICAL (Phase 10E) — gom các bản copy-paste
// currentPeriodMonth/shiftMonth từng lặp ở MySalaryPage, ManagerSalaryPage,
// useManagerSalary về 1 chỗ, xây trên ymOf/shiftYm sẵn có của managerSalary.ts.
//
// 2 định dạng đang dùng trong repo:
//   - "YYYY-MM"     (ym)           — ymOf/shiftYm (managerSalary.ts)
//   - "YYYY-MM-01"  (period_month) — cột salary_*/period_month trong DB
// File này cung cấp bộ cho period_month; ym re-export từ managerSalary.
export { ymOf, shiftYm } from "@/lib/managerSalary";
import { ymOf, shiftYm } from "@/lib/managerSalary";

/** Kỳ lương hiện tại theo giờ máy: "YYYY-MM-01". */
export function currentPeriodMonth(): string {
  return ymOf(new Date()) + "-01";
}

/**
 * Lùi/tiến kỳ lương "YYYY-MM-01" đi delta tháng (an toàn rollover 12→1).
 * Tương đương từng ký tự output với các bản local cũ (Date.UTC(y, m-1+delta, 1)).
 */
export function shiftPeriodMonth(periodMonth: string, delta: number): string {
  return shiftYm(periodMonth.slice(0, 7), delta) + "-01";
}
