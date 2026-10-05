// Mã lỗi của hàm máy chủ `quick-entry` (supabase/functions/quick-entry) ⇒ trạng thái giao diện.
// Nguyên tắc: AI hỏng KHÔNG bao giờ chặn việc ghi chi — mọi trạng thái đều cho nhập tay.

export type AiErrorKind =
  | "disabled"
  | "not_permitted"
  | "organization_required"
  | "daily_cap"
  | "rate_limited"
  | "all_failed"
  | "too_large"
  | "network"
  | "unknown";

export interface AiErrorView {
  kind: AiErrorKind;
  message: string;
  /** Bấm "Thử lại" có ý nghĩa (lỗi tạm thời). */
  retryable: boolean;
  allowManual: true;
}

const MESSAGES: Record<AiErrorKind, string> = {
  disabled: "AI đọc chi tiêu đang tắt. Bạn vẫn nhập tay được.",
  not_permitted: "Tài khoản chưa được dùng AI ở trang này. Bạn vẫn nhập tay được.",
  organization_required: "Chọn công ty để dùng AI. Khoản cá nhân vẫn lưu vào ví cá nhân.",
  daily_cap: "Hôm nay bạn đã dùng hết lượt AI. Bạn vẫn nhập tay được.",
  rate_limited: "AI đang bận vì gọi dồn dập. Đợi vài giây rồi thử lại, hoặc nhập tay.",
  all_failed: "Các mô hình AI đều đang lỗi. Thử lại sau ít phút, hoặc nhập tay.",
  too_large: "Ảnh quá lớn để gửi AI. Chụp gần hơn hoặc nhập tay.",
  network: "Mất kết nối khi gọi AI. Kiểm tra mạng rồi thử lại, hoặc nhập tay.",
  unknown: "AI chưa đọc được lần này. Thử lại hoặc nhập tay.",
};

const RETRYABLE: Record<AiErrorKind, boolean> = {
  disabled: false,
  not_permitted: false,
  organization_required: true,
  daily_cap: false,
  rate_limited: true,
  all_failed: true,
  too_large: false,
  network: true,
  unknown: true,
};

function kindOf(status: number, code: string | null): AiErrorKind {
  switch (code) {
    case "quick_entry_disabled":
    case "quick_entry_unconfigured":
      return "disabled";
    case "not_permitted":
    case "not_entitled":
    case "organization_forbidden":
      return "not_permitted";
    case "organization_required":
      return "organization_required";
    case "quick_entry_daily_cap":
    case "daily_quota":
    case "daily_token_quota":
      return "daily_cap";
    case "rate_limited":
    case "quick_entry_attempts_exhausted":
      return "rate_limited";
    case "quick_entry_all_failed":
      return "all_failed";
    case "payload_too_large":
    case "too_many_images":
      return "too_large";
    default:
      break;
  }
  if (status === 0) return "network";
  if (status === 413) return "too_large";
  if (status === 429) return "rate_limited";
  return "unknown";
}

export function classifyAiError(e: { status: number; code: string | null }): AiErrorView {
  const kind = kindOf(e.status, e.code);
  return { kind, message: MESSAGES[kind], retryable: RETRYABLE[kind], allowManual: true };
}
