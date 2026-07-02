// =============================================
// Nhãn trạng thái hạch toán KQKD của 1 phiếu thu/chi — theo HẠNG MỤC
// (item-level, cột income_expenses.kqkd_amount do DB maintain):
//   • kqkd = 0      → "Không hạch toán" (phiếu thuần cọc / override FALSE)
//   • kqkd = total  → "Có hạch toán"
//   • 0 < kqkd < total → "Một phần" (phiếu TRỘN: thu HĐ gộp cọc — chỉ phần
//     doanh thu vào KQKD, phần item cọc bị loại)
// =============================================

export function kqkdStatusLabel(v: {
  total_amount: number;
  kqkd_amount?: number | null;
  counts_in_business_result?: boolean | null;
  business_result_accounting?: boolean | null;
}): string {
  const total = Number(v.total_amount) || 0;
  // Fallback dữ liệu chưa có kqkd_amount (cache cũ): suy từ cờ cả-phiếu.
  const kqkd = Number(
    v.kqkd_amount ?? (v.counts_in_business_result === false ? 0 : total),
  ) || 0;
  const mode = v.business_result_accounting == null ? " (tự động)" : " (override)";
  if (kqkd <= 0) return "Không hạch toán" + mode;
  if (kqkd >= total) return "Có hạch toán" + mode;
  return (
    `Một phần: ${kqkd.toLocaleString("vi-VN")}đ / ${total.toLocaleString("vi-VN")}đ (loại phần cọc)` +
    mode
  );
}
