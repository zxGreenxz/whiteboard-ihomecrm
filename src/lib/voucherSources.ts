// Bảng quyết định DUY NHẤT cho phiếu thu chi máy-sinh (income_expenses.system_source).
// Quy ước "nguồn.hành_động" — backfill & danh sách giá trị: migration 20260704110000.
//
// - label: nhãn hiển thị thay cho việc đọc/parse tên phiếu tự do.
// - group: nhóm dùng cho bộ lọc "Nhóm" trang Thu chi (thay income_expense_types.category
//   vốn đa số NULL).
// - internal: true = bút toán nội bộ THEO BẢN CHẤT (không có tiền thật di chuyển
//   ra/vào hệ thống) — cặp cấn cọc, backfill, điều chỉnh. Lưu ý lớp hiển thị
//   cuối cùng của một phiếu vẫn ưu tiên suy từ SỔ (mọi chân đều sổ ảo → Nội bộ);
//   cờ này là fallback khi phiếu lịch sử còn nằm trên sổ thực.
//   handover.transfer KHÔNG internal: tiền mặt thật di chuyển giữa hai két.

export interface VoucherSourceMeta {
  label: string;
  group:
    | "Hợp đồng"
    | "Hoá đơn"
    | "Cọc"
    | "Thanh lý"
    | "Bàn giao"
    | "Chia lợi nhuận"
    | "Lương"
    | "Vận hành"
    | "Điều chỉnh";
  internal?: boolean;
}

export const VOUCHER_SOURCES: Record<string, VoucherSourceMeta> = {
  "invoice.payment": { label: "Thu tiền hoá đơn", group: "Hoá đơn" },
  "contract.deposit": { label: "Thu cọc hợp đồng", group: "Cọc" },
  "deposit.reservation": { label: "Cọc giữ chỗ", group: "Cọc" },
  "contract.commission": { label: "Hoa hồng/thưởng sale", group: "Hợp đồng" },

  "termination.offset": { label: "Cấn cọc thanh lý (nội bộ)", group: "Thanh lý", internal: true },
  "termination.revenue": { label: "Doanh thu thanh lý (cấn cọc)", group: "Thanh lý", internal: true },
  "termination.forfeit_offset": { label: "Cấn cọc bỏ cọc (nội bộ)", group: "Thanh lý", internal: true },
  "termination.forfeit_revenue": { label: "Doanh thu bỏ cọc (cấn cọc)", group: "Thanh lý", internal: true },
  "termination.refund": { label: "Hoàn khách thanh lý (tiền thật)", group: "Thanh lý" },
  "termination.extra_receipt": { label: "Khách trả thêm khi thanh lý", group: "Thanh lý" },

  "handover.transfer": { label: "Bàn giao tiền mặt", group: "Bàn giao" },
  "backfill.initial_deposit": { label: "Ghi nhận cọc ban đầu (bút toán)", group: "Cọc", internal: true },

  "profit.distribution": { label: "Chia lợi nhuận cổ đông", group: "Chia lợi nhuận" },
  "salary.staff": { label: "Lương nhân viên", group: "Lương" },
  "salary.manager": { label: "Lương điều hành", group: "Lương" },
  "utility.bill": { label: "Đóng điện/nước NCC", group: "Vận hành" },

  "adjustment.opening_balance": { label: "Điều chỉnh số dư đầu kỳ", group: "Điều chỉnh", internal: true },
  "adjustment.close_coc": { label: "Khoá sổ CỌC ảo (bút toán)", group: "Điều chỉnh", internal: true },
};

/** Nhãn nguồn phiếu; null/không rõ → "Nhập tay". */
export const voucherSourceLabel = (src?: string | null): string =>
  (src && VOUCHER_SOURCES[src]?.label) || "Nhập tay";

/** Nhóm lọc của phiếu; null → "Nhập tay". */
export const voucherSourceGroup = (src?: string | null): string =>
  (src && VOUCHER_SOURCES[src]?.group) || "Nhập tay";

/** Danh sách nhóm cho dropdown lọc "Nhóm" (theo thứ tự nghiệp vụ). */
export const VOUCHER_GROUPS: string[] = [
  "Hoá đơn",
  "Cọc",
  "Hợp đồng",
  "Thanh lý",
  "Bàn giao",
  "Lương",
  "Chia lợi nhuận",
  "Vận hành",
  "Điều chỉnh",
  "Nhập tay",
];

/** Bút toán nội bộ theo bản chất nguồn (fallback khi chưa suy được từ sổ). */
export const isInternalSource = (src?: string | null): boolean =>
  !!(src && VOUCHER_SOURCES[src]?.internal);

/**
 * Phân lớp phiếu cho trang Thu chi (đúng mô hình đã chốt 04/07):
 * - PENDING : chờ xử lý (nháp/chưa duyệt hoặc CHƯA CHỌN SỔ) — không vào tổng.
 * - INTERNAL: bút toán nội bộ — mọi chân đều sổ ảo, HOẶC nguồn internal
 *             (phiếu lịch sử còn nằm sổ thực) — hiển thị trung tính, không vào
 *             tổng TIỀN THẬT.
 * - CASH    : tiền thật đã vào sổ.
 * - CANCELLED: đã huỷ.
 */
export type VoucherLayer = "CASH" | "INTERNAL" | "PENDING" | "CANCELLED";

export function voucherLayer(v: {
  approval_status?: string | null;
  account_id?: string | null;
  system_source?: string | null;
  account_is_virtual?: boolean | null;
  change_account_is_virtual?: boolean | null;
}): VoucherLayer {
  if (v.approval_status === "CANCELLED") return "CANCELLED";
  if (v.approval_status === "UNAPPROVED" || !v.account_id) return "PENDING";
  const legsVirtual =
    v.account_is_virtual === true &&
    (v.change_account_is_virtual == null || v.change_account_is_virtual === true);
  if (legsVirtual || isInternalSource(v.system_source)) return "INTERNAL";
  return "CASH";
}
