// Format tiền VND cho các component chi tiết HĐ (desktop) — tách từ
// ContractDetailView (Phase 10D), GIỮ NGUYÊN Intl.NumberFormat như bản gốc
// (KHÔNG đổi sang formatCurrency của @/lib/utils để bảo toàn hành vi).
export const formatCurrency = (amount: number) => {
  return new Intl.NumberFormat('vi-VN', {
    style: 'currency',
    currency: 'VND',
  }).format(amount);
};

/**
 * Số tiền TRẦN, không ký hiệu ₫ — "3.900.000".
 *
 * Dùng cho màn chi tiết hợp đồng bản desktop mới: ở đó mọi cột đều là tiền, nên
 * lặp lại ₫ trên từng ô chỉ làm loãng con số. Chủ chốt yêu cầu bỏ ₫ trên TOÀN
 * màn hình đó, kể cả header và dòng tổng (12/09/2026).
 *
 * `formatCurrency` bên trên giữ nguyên cho bản mobile và các màn khác đang dùng.
 */
export const formatAmount = (amount: number) => {
  return new Intl.NumberFormat('vi-VN').format(amount);
};
