// =============================================================================
// settlementTypes.ts — LUẬT NHẬN PHIẾU của khu "Hợp đồng & quyết toán".
//
// VÌ SAO CẦN FILE NÀY
// Nhận phiếu chỉ bằng dấu nguồn (`system_source`, `commission_kind`) là KHÔNG
// ĐỦ. Đo org THẬT ngày 21/09/2026: 13 phiếu (3 đang chờ duyệt) thuộc đúng ba
// loại khoản của khu này nhưng KHÔNG mang dấu nào — chúng do người dùng tạo tay
// bên Thu chi, và chỉ nhận ra được qua HẠNG MỤC KẾ TOÁN của dòng hạng mục:
//
//   category (NULL)   · name "Hoàn cọc thanh lý"                 · 5 phiếu
//   category XỬ LÝ HĐ · name "Bổ sung hoàn cọc"                  · 4 phiếu
//   category HOA HỒNG · name "HHMG"                              · 2 phiếu
//   category XỬ LÝ HĐ · name "Hoàn cọc / tiền thừa khi thanh lý" · 2 phiếu
//
// Bỏ sót chúng là hỏng tiền đề của cả khu: chủ đã chốt "phiếu chi được tạo từ
// Thu chi, trang này chỉ rà soát/duyệt/chi".
//
// KHUÔN MẪU
// Viết theo đúng khuôn `feeTypeMatches` trong feeCategories.ts: khớp CATEGORY đã
// chuẩn hoá trước, có fallback theo TÊN. Fallback là bắt buộc chứ không phải cho
// chắc — `category` là TEXT tự do và có loại để NULL (đo thật ở trên).
//
// ⚠ Đây là LUẬT PRODUCTION, không phải tìm chuỗi tuỳ tiện. Mỗi nhánh phải có
// test ghim bằng tên loại THẬT đã đo, và phải loại trừ tường minh những tên dễ
// nuốt nhầm. Thêm nhánh mới thì thêm test trước.
// =============================================================================

import { nrm } from '@/lib/fixedExpenseCategories';

/** Ba loại khoản chi phát sinh từ hợp đồng mà khu này quản. */
export type SettlementKind = 'refund' | 'commission' | 'bonus';

/**
 * Khớp MỘT `income_expense_type` với ba loại khoản của khu này.
 *
 * @param category `income_expense_types.category` — TEXT tự do, có thể NULL
 * @param name     `income_expense_types.name`
 * @returns loại khoản, hoặc `null` nếu không thuộc khu này
 */
export function settlementTypeMatches(
  category: string | null | undefined,
  name: string | null | undefined,
): SettlementKind | null {
  const c = nrm(category);
  const n = nrm(name);

  // ── 1. HOÀN KHÁCH ────────────────────────────────────────────────────────
  // "hoàn cọc", "hoàn tiền cọc", "tiền thừa khi thanh lý".
  //
  // Loại trừ "thu cọc" / "nhận cọc": đó là phiếu THU tiền của khách, ngược
  // chiều hẳn với khoản chi hoàn lại. Bộ lọc gọi hàm này đã chặn `type` phải là
  // EXPENSE, nhưng giữ vế loại trừ ở đây để hàm đúng khi đứng một mình.
  if (
    (c.includes('hoan coc') || n.includes('hoan coc') ||
      n.includes('hoan tien coc') || n.includes('tien thua khi thanh ly')) &&
    !n.includes('thu coc') && !n.includes('nhan coc')
  ) {
    return 'refund';
  }

  // ── 2. THƯỞNG SALE ───────────────────────────────────────────────────────
  // PHẢI xét TRƯỚC hoa hồng. Loại "Thưởng nóng Sale" mang category "Hoa hồng"
  // (xem canonicalCategory của `thuong_sale` trong feeCategories.ts); xét hoa
  // hồng trước là nuốt mất nó, và nuốt rồi thì màn hình đi tìm căn cứ bậc hoa
  // hồng cho một khoản thưởng cố định — báo lệch giả.
  if (n.includes('thuong nong') || n.includes('thuong sale')) {
    return 'bonus';
  }

  // ── 3. HOA HỒNG MÔI GIỚI ─────────────────────────────────────────────────
  // "HHMG" là viết tắt đang dùng thật trên production, không phải suy đoán.
  //
  // Loại trừ "nhân viên": hoa hồng nhân viên thuộc mảng lương thưởng, không
  // phải khoản chi theo hợp đồng thuê.
  if (
    (c === 'hoa hong' || n.includes('hoa hong') || n === 'hhmg') &&
    !n.includes('nhan vien')
  ) {
    return 'commission';
  }

  return null;
}
