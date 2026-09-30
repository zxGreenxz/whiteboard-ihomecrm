import { useState } from "react";

/**
 * Tấm phiếu chỉ trượt lên MỘT lần mỗi lần mở. Khung chờ và nội dung là hai cây
 * DOM khác nhau, để mặc định thì tấm thứ hai trượt lại từ đáy — đo WebKit khung
 * iPhone 30/09/2026: khung chờ trượt 302→75 px, nội dung về thì bật xuống 666 px
 * rồi trượt lên lần nữa. Tấm đầu tiên giữ hiệu ứng; mọi lần đổi sau (kể cả tải
 * lại khi realtime báo phiếu đổi) trả `true` để gắn lớp `sheet-still`.
 *
 * @param phase trạng thái đang vẽ, vd "state" (chờ/lỗi) hoặc "content".
 */
export function useSheetStill(phase: string): boolean {
  const [firstPhase] = useState(phase);
  const [swapped, setSwapped] = useState(false);
  const changed = phase !== firstPhase;
  // Cập nhật trong lúc render (mẫu "state suy từ render trước" của React): tấm
  // mới được vẽ ngay với lớp đứng yên, không có khung hình nào trượt từ đáy.
  if (changed && !swapped) setSwapped(true);
  return swapped || changed;
}

/**
 * Câu báo khi đọc chi tiết hỏng: quá hạn (DetailReadTimeoutError) thì nói rõ là
 * mạng chậm; lỗi khác dùng câu mặc định của màn. So theo `name` để màn hình không
 * phải import module đọc dữ liệu (test mock cả module đó).
 */
export function detailReadErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.name === "DetailReadTimeoutError" ? error.message : fallback;
}
