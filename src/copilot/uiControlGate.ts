// Lý do chặn chế độ "Điều khiển trang", dưới dạng câu người dùng làm được gì.
//
// Khối guard trong `ChatPanel.runUiControl` gộp 5 điều kiện rồi `return` trần:
// câu hỏi đã hiện trong khung chat, chỉ báo "đang điều khiển trang" nhấp nháy
// rồi tắt, không trả lời và không lỗi. Năm điều kiện đó có năm cách sửa khác
// nhau nên phải nói ra cái nào đang chặn.
import { THONG_BAO_QUYEN_CHUA_TUOI, TUOI_TOI_DA_DE_GUI_MS } from './availabilityGate';
import {
  copilotAvailabilitySnapshotIsFresh,
  type CopilotAvailabilitySnapshot,
} from './featureFlags';

export interface NguCanhUiControl {
  /** Lượt này còn thuộc đúng tổ chức + thế hệ lúc bấm gửi (`isCurrentChatScope`). */
  cungPhamVi: boolean;
  /** Entitlement `ui_control_enabled` + quyền `ai_copilot.ui_control`. */
  coQuyenDieuKhien: boolean;
  organizationId: string | null;
  snapshot: CopilotAvailabilitySnapshot | null;
  now?: number;
}

/**
 * Hàm THUẦN: trả câu tiếng Việt nếu bị chặn, `null` nếu chạy được.
 *
 * Thứ tự kiểm đi từ NGOÀI vào TRONG. Đổi tổ chức giữa chừng thì mọi thứ phía
 * sau đều lệch theo, nên báo về snapshot lúc đó là chỉ vào triệu chứng chứ
 * không phải nguyên nhân.
 */
export function lyDoChanUiControl(nguCanh: NguCanhUiControl): string | null {
  const now = nguCanh.now ?? Date.now();
  if (!nguCanh.cungPhamVi) return 'Tổ chức đã đổi giữa chừng, mở lại cuộc trò chuyện rồi thử lại.';
  if (!nguCanh.coQuyenDieuKhien) return 'Tài khoản chưa được cấp quyền điều khiển trang.';
  if (!nguCanh.organizationId) return 'Hãy chọn tổ chức trước khi dùng chế độ điều khiển trang.';
  if (!copilotAvailabilitySnapshotIsFresh(nguCanh.snapshot, TUOI_TOI_DA_DE_GUI_MS, now)) {
    return THONG_BAO_QUYEN_CHUA_TUOI;
  }
  if (nguCanh.snapshot.organizationId !== nguCanh.organizationId) {
    return 'Quyền công cụ đang thuộc tổ chức khác, chờ làm mới rồi thử lại.';
  }
  return null;
}
