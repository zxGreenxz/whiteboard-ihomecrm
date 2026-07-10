// Format tiền VND cho các component chi tiết HĐ (desktop) — tách từ
// ContractDetailView (Phase 10D), GIỮ NGUYÊN Intl.NumberFormat như bản gốc
// (KHÔNG đổi sang formatCurrency của @/lib/utils để bảo toàn hành vi).
export const formatCurrency = (amount: number) => {
  return new Intl.NumberFormat('vi-VN', {
    style: 'currency',
    currency: 'VND',
  }).format(amount);
};
