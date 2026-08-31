// =============================================================================
// Chia tiền một phiếu chi điện/nước theo TỪNG DÒNG hạng mục (P1-01, audit 31/08).
//
// Vì sao tồn tại: reader cũ nhìn phiếu bằng `items.some(isElec)` rồi gán CẢ
// phiếu thành "điện" với số tiền `total_amount`. Phiếu gộp điện+nước có thật
// trên prod (5916661a…: tổng 6.384.000 = điện 5.758.000 + nước 626.000,
// system_source 'utility.bill') nên:
//   - danh sách: đồng hồ nước trông như chưa đóng, dòng "điện" phồng lên;
//   - biểu đồ: vòng lặp theo item cộng NGUYÊN total_amount cho mỗi item —
//     phiếu gộp bị đếm ĐÔI (cả nhánh điện lẫn nhánh nước).
//
// Toán tách ra đây để test được không cần React/Supabase (án lệ "design chỉ là
// hình ảnh, logic phải tự kiểm"). Hook chỉ còn gọi hai hàm này.
// =============================================================================

export interface UtilityVoucherItem {
  income_expense_type_id: string;
  /** amount của dòng — DB numeric có thể về string qua PostgREST. */
  amount: number | string | null;
}

/** Tổng phần điện / phần nước của một phiếu, tính theo TỪNG dòng hạng mục. */
export const splitUtilityAmounts = (
  items: UtilityVoucherItem[],
  elecIds: ReadonlySet<string>,
  waterIds: ReadonlySet<string>,
): { elec: number; water: number } => {
  let elec = 0;
  let water = 0;
  for (const it of items) {
    const amt = Number(it.amount) || 0;
    if (elecIds.has(it.income_expense_type_id)) elec += amt;
    else if (waterIds.has(it.income_expense_type_id)) water += amt;
  }
  return { elec, water };
};

export interface UtilityRowPart {
  type: 'electric' | 'water';
  /** Phần tiền THUỘC loại này (không phải tổng phiếu). */
  amount: number;
  /** true = phiếu gộp cả điện lẫn nước — UI có thể gắn nhãn. */
  mixedVoucher: boolean;
}

/**
 * Một phiếu → 1 hoặc 2 dòng hiển thị theo loại.
 *
 * - Gộp điện+nước → HAI dòng, mỗi dòng mang đúng phần tiền của loại đó.
 * - Một loại → MỘT dòng với phần tiền của loại (phiếu có kèm hạng mục ngoài
 *   điện/nước thì phần ngoài KHÔNG được tính — reader cũ lấy total_amount nên
 *   phồng cả ca này).
 * - Suy biến (item không mang amount — dữ liệu cổ trước trigger auto_calc):
 *   rơi về hành vi cũ `some(isElec)` + total_amount để không GIẤU phiếu; vẫn
 *   một dòng, không đếm đôi.
 */
export const utilityRowParts = (
  items: UtilityVoucherItem[],
  elecIds: ReadonlySet<string>,
  waterIds: ReadonlySet<string>,
  totalAmount: number,
): UtilityRowPart[] => {
  const { elec, water } = splitUtilityAmounts(items, elecIds, waterIds);
  if (elec > 0 && water > 0) {
    return [
      { type: 'electric', amount: elec, mixedVoucher: true },
      { type: 'water', amount: water, mixedVoucher: true },
    ];
  }
  if (elec > 0) return [{ type: 'electric', amount: elec, mixedVoucher: false }];
  if (water > 0) return [{ type: 'water', amount: water, mixedVoucher: false }];
  // Suy biến: không dòng nào mang tiền — giữ hành vi cũ để phiếu không biến mất.
  const isElec = items.some((it) => elecIds.has(it.income_expense_type_id));
  return [{ type: isElec ? 'electric' : 'water', amount: Number(totalAmount) || 0, mixedVoucher: false }];
};
