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

// =============================================================================
// PHÂN LOẠI MỘT PHIẾU — resolver thuần (plan §3.6)
//
// VÌ SAO CẦN: `settlementTypeMatches` chỉ trả lời cho MỘT hạng mục. Một PHIẾU
// có thể mang nhiều dấu cùng lúc (`commission_kind`, `system_source`, và các
// hạng mục của từng dòng item) và chúng có thể chỏi nhau. Bản trước gộp việc
// này vào `useContractSettlement.kindOf` và kết thúc bằng `return 'refund'`
// trần — nên hai phiếu THẬT PC2606169 / PC2608091 (hạng mục HHMG, không có
// `commission_kind`, không có dấu nguồn) rơi vào Hoàn khách và không bao giờ
// được tra căn cứ hoa hồng.
//
// BA ĐIỀU RÀNG BUỘC
//   1. Thứ tự ưu tiên CỐ ĐỊNH: `commission_kind` → `system_source` → hạng mục.
//      Không đọc tên/mã phiếu để đoán.
//   2. Có kết quả CHƯA XÁC ĐỊNH (`kind: null`). Không bao giờ mặc định 'refund'
//      — mặc định sai loại là mời người duyệt đối chiếu nhầm căn cứ.
//   3. Kết quả suy ra KHÔNG được ghi ngược vào DB. Hàm này thuần, không I/O.
// =============================================================================

/** Dấu hiệu đã quyết định loại. 'none' = chưa xác định được. */
export type SettlementKindSignal =
  | 'commission_kind' | 'system_source' | 'accounting_item' | 'none';

export interface SettlementKindResolution {
  /** Loại đã xác định, hoặc `null` khi CHƯA XÁC ĐỊNH. */
  kind: SettlementKind | null;
  /** Dấu hiệu nào quyết định `kind`. */
  signal: SettlementKindSignal;
  /**
   * Cần người đối chiếu phân loại: các dấu hiệu chỉ về nhiều loại khác nhau
   * (metadata chỏi hạng mục, hai dấu metadata chỏi nhau, hoặc nhiều hạng mục
   * khác loại trên cùng một phiếu).
   */
  conflict: boolean;
  /** Các loại HẠNG MỤC thuộc khu này, đã khử trùng và sắp thứ tự ổn định. */
  itemKinds: SettlementKind[];
}

export interface SettlementKindInput {
  /** `income_expenses.commission_kind` — THÔ, giữ nguyên như DB. */
  commissionKind: string | null | undefined;
  /** `income_expenses.system_source` — THÔ, giữ nguyên như DB. */
  systemSource: string | null | undefined;
  /**
   * Loại của từng hạng mục trên phiếu, đã map qua `settlementTypeMatches`.
   * Phần tử `null`/`undefined` = hạng mục NGOÀI khu này ⇒ bị bỏ qua, không đổi
   * loại của phiếu.
   */
  itemKinds: readonly (SettlementKind | null | undefined)[] | null | undefined;
}

/** Thứ tự in ra cho ổn định giữa các lần chạy (test so được bằng toEqual). */
const THU_TU: readonly SettlementKind[] = ['refund', 'commission', 'bonus'];

export function resolveSettlementKind(input: SettlementKindInput): SettlementKindResolution {
  const itemKinds = [...new Set((input.itemKinds ?? []).filter(
    (k): k is SettlementKind => k === 'refund' || k === 'commission' || k === 'bonus',
  ))].sort((a, b) => THU_TU.indexOf(a) - THU_TU.indexOf(b));

  const ck = (input.commissionKind ?? '').trim();
  const ss = (input.systemSource ?? '').trim();

  // Dấu metadata rõ. Giá trị lạ (vd 'staff') KHÔNG được coi là dấu rõ — nó
  // không thuộc ba loại của khu này nên không nói lên điều gì.
  const tuCommissionKind: SettlementKind | null =
    ck === 'broker' ? 'commission' : ck === 'sale' ? 'bonus' : null;
  const tuSystemSource: SettlementKind | null =
    ss.startsWith('termination.refund') || ss.startsWith('reservation.refund') ? 'refund' : null;

  let kind: SettlementKind | null = null;
  let signal: SettlementKindSignal = 'none';
  if (tuCommissionKind) {
    kind = tuCommissionKind; signal = 'commission_kind';
  } else if (tuSystemSource) {
    kind = tuSystemSource; signal = 'system_source';
  } else if (itemKinds.length === 1) {
    // Chỉ nhận khi hạng mục chỉ về ĐÚNG MỘT loại. Nhiều loại mà không có dấu
    // metadata thì KHÔNG tự chọn item đầu tiên — để chưa xác định và báo.
    kind = itemKinds[0]; signal = 'accounting_item';
  }

  // Xung đột đo trên TOÀN BỘ dấu hiệu, không chỉ metadata-vs-hạng-mục: hai dấu
  // metadata chỏi nhau cũng là thứ người ta phải nhìn lại. Nhãn này chỉ là
  // CẢNH BÁO — xem isBlocker trong contractSettlement.ts.
  const moiDauHieu = new Set<SettlementKind>(itemKinds);
  if (tuCommissionKind) moiDauHieu.add(tuCommissionKind);
  if (tuSystemSource) moiDauHieu.add(tuSystemSource);

  return { kind, signal, conflict: moiDauHieu.size > 1, itemKinds };
}
