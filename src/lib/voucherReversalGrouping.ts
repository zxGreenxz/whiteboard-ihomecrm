// =============================================================
// Gộp ẩn PHIẾU ĐỐI ỨNG vào dòng phiếu GỐC (chỉ ở tầng HIỂN THỊ).
//
// BỐI CẢNH (plan Đợt 5): trước Đợt 5, hoàn tác một khoản thu hoá đơn sinh ra
// một phiếu CHI đối ứng riêng — lịch sử vì thế có HAI dòng rời rạc cho cùng
// một nghiệp vụ. Từ Đợt 5, chế độ linh hoạt huỷ TẠI CHỖ nên không sinh phiếu
// đối ứng nữa; số phiếu đã có là DI SẢN và KHÔNG xoá được (phiếu flow-owned,
// bảng sở hữu bất biến tuyệt đối). Việc duy nhất làm được là gộp chúng lại khi
// vẽ danh sách.
//
// Đo trên prod 30/07/2026: 8 phiếu đối ứng còn sống (3 phiếu mang
// system_source 'invoice.collection.reverse.v5', 5 phiếu di sản cũ hơn chỉ có
// FK). CẢ 8 đều có reversal_of_income_expense_id ⇒ NEO THEO FK, không neo theo
// system_source (neo theo source sẽ bỏ sót 5/8).
//
// ⚠ BẤT BIẾN SỐ TIỀN: hàm này KHÔNG cộng/trừ/loại bỏ phiếu nào. Trải phẳng kết
// quả luôn là một HOÁN VỊ của mảng đầu vào (mỗi phiếu xuất hiện đúng 1 lần,
// hoặc làm dòng chính, hoặc nằm trong reversals của đúng 1 dòng chính).
// Ba thẻ tổng Thu/Chi/Chênh lệch của màn Thu chi vốn đã lấy từ RPC server
// get_income_expense_layer_stats — KHÔNG cộng từ các dòng đang vẽ — nên gộp
// hiển thị không thể làm suy suyển tổng. Test property-based canh cả hai điều.
// =============================================================

/** system_source của phiếu đối ứng sinh bởi luồng V5 (3/8 phiếu trên prod). */
export const REVERSAL_SYSTEM_SOURCE_V5 = "invoice.collection.reverse.v5";

/**
 * Hình dạng TỐI THIỂU cần để gộp. Cố ý lỏng: `IncomeExpenseWithRelations`
 * chưa khai reversal_of_income_expense_id (cột có thật trong DB, list đã
 * `select("*")` nên vẫn về tới client) — đọc qua getReversalOf() để không phải
 * đụng vào type dùng chung.
 */
export interface ReversalLinkableVoucher {
  id: string;
  type: "INCOME" | "EXPENSE";
  total_amount: number;
  approval_status: "UNAPPROVED" | "APPROVED" | "CANCELLED";
}

/** Đọc FK phiếu-gốc, chịu được cả object chưa khai field trong type. */
export function getReversalOf(voucher: unknown): string | null {
  const raw = (voucher as { reversal_of_income_expense_id?: unknown } | null)
    ?.reversal_of_income_expense_id;
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

/** Phiếu này có PHẢI là phiếu đối ứng (bất kể gốc có trong trang hay không)? */
export function isReversalVoucher(voucher: unknown): boolean {
  if (getReversalOf(voucher) !== null) return true;
  const src = (voucher as { system_source?: unknown } | null)?.system_source;
  return src === REVERSAL_SYSTEM_SOURCE_V5;
}

/** Tiền có dấu theo hướng phiếu: THU dương, CHI âm. */
export function signedAmount(voucher: ReversalLinkableVoucher): number {
  const amount = Number(voucher.total_amount) || 0;
  return voucher.type === "INCOME" ? amount : -amount;
}

export interface VoucherRowGroup<T> {
  /** Phiếu đứng tên dòng — là phiếu GỐC khi ghép được, không thì chính nó. */
  anchor: T;
  /** Phiếu đối ứng đã gộp ẩn vào dòng này. Rỗng = dòng thu chi bình thường. */
  reversals: T[];
}

/** Tiền RÒNG của cả cụm sau khi bù trừ đối ứng (gốc + các phiếu đối ứng). */
export function groupNetAmount<T extends ReversalLinkableVoucher>(
  group: VoucherRowGroup<T>,
): number {
  return (
    signedAmount(group.anchor) +
    group.reversals.reduce((sum, r) => sum + signedAmount(r), 0)
  );
}

/**
 * Gộp phiếu đối ứng vào dòng phiếu gốc.
 *
 * LUẬT GỘP — cố ý dè dặt, thà hiện hai dòng còn hơn nuốt mất một dòng:
 *  1. Chỉ gộp khi CẢ HAI phiếu cùng có mặt trong mảng đang vẽ. Danh sách phân
 *     trang/lọc theo ngày ở server, mà đo prod cho thấy phiếu đối ứng thường
 *     LỆCH THÁNG so với gốc (PC2607106 ngày 29/07 hoàn tác PT2606212 ngày
 *     30/06) ⇒ rất hay chỉ có một nửa trong trang. Nửa lẻ đó ĐỨNG NGUYÊN thành
 *     dòng riêng, không bị giấu.
 *  2. Phiếu đối ứng ĐÃ HUỶ thì KHÔNG gộp — nó không hoàn tác được gì, gộp vào
 *     sẽ nói dối rằng phiếu gốc đã bị hoàn tác.
 *  3. Không gộp bắc cầu: nếu chính phiếu gốc cũng là một phiếu đối ứng đang
 *     gộp được thì để yên cả chuỗi. Nhờ vậy không phiếu nào vừa làm dòng chính
 *     vừa nằm trong reversals của dòng khác.
 *  4. Dòng gộp GIỮ ĐÚNG VỊ TRÍ CỦA PHIẾU GỐC. Mảng vào đã sắp theo ngày giảm
 *     dần; neo vào gốc nên danh sách vẫn đơn điệu theo ngày, không có dòng nào
 *     nhảy chỗ trông như lỗi sắp xếp.
 */
export function groupReversalVouchers<T extends ReversalLinkableVoucher>(
  rows: readonly T[],
): VoucherRowGroup<T>[] {
  if (rows.length === 0) return [];

  const byId = new Map<string, T>();
  for (const row of rows) byId.set(row.id, row);

  // Luật 1 + 2: ứng viên gộp = phiếu đối ứng còn hiệu lực, có gốc trong mảng.
  const targetOf = new Map<string, string>();
  for (const row of rows) {
    if (row.approval_status === "CANCELLED") continue;
    const targetId = getReversalOf(row);
    if (!targetId || targetId === row.id) continue;
    if (!byId.has(targetId)) continue;
    targetOf.set(row.id, targetId);
  }

  // Luật 3: bỏ ứng viên nào trỏ vào một ứng viên khác (chuỗi hoàn tác).
  for (const [id, targetId] of Array.from(targetOf)) {
    if (targetOf.has(targetId)) targetOf.delete(id);
  }

  const mergedInto = new Map<string, T[]>();
  for (const row of rows) {
    const targetId = targetOf.get(row.id);
    if (!targetId) continue;
    const bucket = mergedInto.get(targetId);
    if (bucket) bucket.push(row);
    else mergedInto.set(targetId, [row]);
  }

  const groups: VoucherRowGroup<T>[] = [];
  for (const row of rows) {
    if (targetOf.has(row.id)) continue; // đã gộp vào dòng khác
    groups.push({ anchor: row, reversals: mergedInto.get(row.id) ?? [] });
  }
  return groups;
}

/** Trải phẳng lại đúng thứ tự vẽ — dùng cho test bất biến & đếm dòng thật. */
export function flattenVoucherGroups<T>(
  groups: readonly VoucherRowGroup<T>[],
): T[] {
  return groups.flatMap((group) => [group.anchor, ...group.reversals]);
}
