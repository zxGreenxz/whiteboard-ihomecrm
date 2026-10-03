// Danh mục chi chuẩn (chủ duyệt 03/10/2026) — luật dùng chung cho mọi ô chọn hạng mục.
//
// Cột mới trên income_expense_types (migration 20261003151606_danh_muc_chi_cau_truc):
//   archived_at        mục cũ đã gộp/thôi dùng ⇒ ẩn khỏi mọi ô chọn (phiếu cũ giữ nguyên);
//   merged_into_id     báo cáo cộng mục cũ vào mục này (gộp đúng một bậc);
//   manual_hidden      ẩn khỏi ô chọn lập tay (mục hệ thống tự lập, mục chỉ công cụ riêng dùng);
//   quick_entry_hidden ẩn riêng khỏi Báo chi nhanh;
//   keywords           cụm từ hay nói (lớp luật + gợi ý AI của Báo chi nhanh);
//   sort_order         thứ tự trong ô chọn;  rule_key  mã ổn định cho luật Báo chi nhanh;
//   internal_transfer  tiền nội bộ: dòng phiếu mới luôn INTERNAL (không tính KQKD).
// Trước khi migration áp lên một môi trường, các cột này vắng ⇒ hàm dưới coi như mặc định
// (không lưu trữ, không ẩn) để màn hình vẫn chạy như cũ.

export interface IeTypeCatalogFields {
  id: string;
  name: string;
  category?: string | null;
  system_only?: boolean | null;
  is_restricted?: boolean | null;
  archived_at?: string | null;
  merged_into_id?: string | null;
  manual_hidden?: boolean | null;
  quick_entry_hidden?: boolean | null;
  keywords?: string[] | null;
  sort_order?: number | null;
  rule_key?: string | null;
  internal_transfer?: boolean | null;
}

/** Hạng mục người dùng được chọn khi lập phiếu tay (Thu chi, phiếu tổng, tạo nhanh). */
export function isPickableIeType(t: IeTypeCatalogFields): boolean {
  return !t.archived_at && !t.system_only && !t.manual_hidden;
}

/**
 * Lọc ô chọn: chỉ mục chọn được, trừ mục hạn chế khi không có quyền tạo phiếu hạn chế.
 * `keepIds`: mục đang gắn sẵn trên phiếu (sửa phiếu cũ) vẫn hiện dù đã lưu trữ.
 */
export function pickableIeTypes<T extends IeTypeCatalogFields>(
  rows: readonly T[],
  opts: { canPickRestricted: boolean; keepIds?: Iterable<string> },
): T[] {
  const keep = new Set(opts.keepIds ?? []);
  return rows.filter(
    (t) => keep.has(t.id) || (isPickableIeType(t) && (opts.canPickRestricted || !t.is_restricted)),
  );
}

/** Thứ tự ô chọn: theo sort_order của danh mục, mục chưa xếp thứ tự xuống cuối theo tên. */
export function sortIeTypesForPicker<T extends IeTypeCatalogFields>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => {
    const sa = a.sort_order ?? Number.MAX_SAFE_INTEGER;
    const sb = b.sort_order ?? Number.MAX_SAFE_INTEGER;
    if (sa !== sb) return sa - sb;
    return a.name.localeCompare(b.name, "vi", { sensitivity: "base" });
  });
}

/** Hạng mục gốc mà báo cáo cộng vào (mirror public.ie_type_report_root_v1). */
export function ieTypeReportRootId(t: Pick<IeTypeCatalogFields, "id" | "merged_into_id">): string {
  return t.merged_into_id || t.id;
}

/** Nhóm hiển thị trong ô chọn; mục chưa có nhóm gom vào "Khác". */
export function ieTypeGroupLabel(t: Pick<IeTypeCatalogFields, "category">): string {
  const g = (t.category ?? "").trim();
  return g || "Khác";
}
