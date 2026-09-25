// Dịch lý do "kỳ đã đóng" từ server sang câu người dùng đọc hiểu (Đợt 3).
//
// Server ném lỗi có tiền tố ổn định thay vì mã Postgres trần, và RPC đọc
// `check_voucher_period_open_v1` chỉ trả về MÃ (không kèm tên sổ quỹ) để một
// hàm SECURITY DEFINER không thành cửa dò thông tin sổ của người khác.

export const CASHBOOK_CLOSED_PREFIX = "[CASHBOOK_CLOSED]";
export const HANDOVER_LOCKED_PREFIX = "[HANDOVER_LOCKED]";
export const PROFIT_LOCKED_PREFIX = "[PROFIT_LOCKED]";

export type PeriodBlockCode =
  | "CASHBOOK_CLOSED"
  | "HANDOVER_LOCKED"
  | "PROFIT_LOCKED"
  | "UNKNOWN";

/** Lý do ngắn gọn để hiện cạnh nút bị mờ. */
export const PERIOD_BLOCK_SHORT: Record<PeriodBlockCode, string> = {
  CASHBOOK_CLOSED: "Sổ quỹ đã chốt & bàn giao",
  HANDOVER_LOCKED: "Đang trong phiên bàn giao",
  PROFIT_LOCKED: "Tháng đã chốt lợi nhuận",
  UNKNOWN: "Kỳ đã đóng",
};

/** Giải thích đầy đủ cho hộp thoại. */
export const PERIOD_BLOCK_DETAIL: Record<PeriodBlockCode, string> = {
  CASHBOOK_CLOSED:
    "Sổ quỹ chứa phiếu này đã được chốt và bàn giao. Mọi phiếu có ngày phát sinh trong kỳ đã chốt được khoá vĩnh viễn — kể cả chủ tổ chức cũng không mở lại được. Muốn điều chỉnh, hãy lập một phiếu mới ở kỳ hiện tại.",
  HANDOVER_LOCKED:
    "Phiếu đang nằm trong một phiên bàn giao tiền mặt đã xác nhận. Muốn sửa hoặc huỷ, hai bên phải huỷ phiên bàn giao đó trước.",
  // Khoá tháng lợi nhuận là TUYỆT ĐỐI (chủ chốt 25/09/2026): mọi phiếu có ngày
  // trong tháng đã chốt, mọi loại, với mọi người kể cả chủ công ty.
  PROFIT_LOCKED:
    "Tháng của phiếu này đã chốt lợi nhuận — mọi phiếu có ngày trong tháng đó bị khoá với tất cả mọi người, kể cả chủ công ty. Muốn sửa, nhờ chủ công ty mở khoá tháng (phải ghi lý do). Chỉ cần thêm ảnh chứng từ hoặc ghi chú thì dùng nút “Bổ sung”.",
  UNKNOWN:
    "Kỳ kế toán của phiếu này đã đóng nên không thao tác được nữa. Hãy lập phiếu điều chỉnh ở kỳ hiện tại.",
};

/**
 * CHỈ dùng cho CASHBOOK_CLOSED (quyết định #8): trigger khoá sổ quỹ còn cho thêm
 * ảnh chứng từ / ghi chú ngay trên phiếu. KHÔNG hiện cho PROFIT_LOCKED — tháng đã
 * chốt lợi nhuận khoá tuyệt đối cả ảnh/ghi chú trên phiếu, chỉ còn nút “Bổ sung”
 * (lưu riêng). Đo 25/09/2026: chưa màn hình nào dùng hằng này.
 */
export const ANNOTATE_STILL_ALLOWED_NOTE =
  "Sổ quỹ đã chốt vẫn cho bổ sung ảnh chứng từ và ghi chú trên phiếu — số tiền và mọi thông tin khác bị khoá cứng.";

export function periodBlockCodeFromError(message: string | null | undefined): PeriodBlockCode | null {
  const msg = message ?? "";
  if (msg.includes(CASHBOOK_CLOSED_PREFIX)) return "CASHBOOK_CLOSED";
  if (msg.includes(HANDOVER_LOCKED_PREFIX)) return "HANDOVER_LOCKED";
  if (msg.includes(PROFIT_LOCKED_PREFIX)) return "PROFIT_LOCKED";
  return null;
}

/**
 * Câu hiển thị cho một lỗi bất kỳ từ writer thu chi. Trả về null khi lỗi không
 * phải chuyện kỳ đã đóng — để caller giữ nguyên thông báo gốc.
 */
export function periodBlockMessage(message: string | null | undefined): string | null {
  const code = periodBlockCodeFromError(message);
  if (!code) return null;
  // Thông báo gốc từ server đã có tên sổ + ngày chốt; giữ lại vì người dùng
  // này chứng minh được là có quyền (họ vừa thực hiện hành động).
  const raw = (message ?? "").replace(/^\[[A-Z_]+\]\s*/, "").trim();
  return raw || PERIOD_BLOCK_DETAIL[code];
}
