// Dịch lỗi kỹ thuật của một lượt chat sang câu người dùng làm được gì với nó.
//
// Trước đây panel chỉ nhận ra một nhóm (not_entitled/not_permitted/403); mọi mã
// khác hiện nguyên văn dưới dạng `Lỗi: organization_required`. Đó không phải
// thông báo — đó là đổ lỗi lên người đọc.
import { formatCopilotRolloutError } from './featureFlags';

const HET_QUYEN_HOAC_HAN_MUC =
  'Tài khoản chưa được cấp quyền dùng AI Copilot hoặc đã hết hạn mức hôm nay.';

/**
 * Mã CHỈ thuộc màn hình quản trị rollout.
 *
 * `formatCopilotRolloutError` cũng nhận `not_permitted`, nhưng câu nó trả về là
 * "Bạn không có quyền thay đổi rollout Copilot" — vô nghĩa với người đang chat,
 * vì ở đường chat `not_permitted` nghĩa là hết hạn mức / chưa được cấp quyền
 * dùng Copilot. Nên chỉ nhường cho nó ba mã dưới đây, không nhường cả hàm.
 */
const MA_ROLLOUT_QUAN_TRI = [
  'copilot_rollout_stale_revision',
  'rollout_evidence_required',
  'invalid_rollout_transition',
] as const;

/** Mã lỗi → câu tiếng Việt kèm hành động sửa được. Khớp theo chuỗi CON vì lỗi
 *  thật thường có đuôi mô tả (`rollout_unavailable: công cụ "..." đã bị tắt`). */
const THEO_MA: readonly [string, string][] = [
  ['organization_required', 'Hãy chọn tổ chức trước khi hỏi Copilot.'],
  ['organization_mismatch', 'Tổ chức đã đổi, mở lại cuộc trò chuyện.'],
  ['rollout_unavailable', 'Trang/công cụ này chưa được bật cho tổ chức.'],
];

/** Hàm THUẦN — không chạm state, để test được mọi nhánh mà không cần DOM. */
export function dienGiaiLoiChat(msg: string): string {
  if (MA_ROLLOUT_QUAN_TRI.some((ma) => msg.includes(ma))) return formatCopilotRolloutError(msg);
  if (/not_entitled|not_permitted|403/.test(msg)) return HET_QUYEN_HOAC_HAN_MUC;
  for (const [ma, cau] of THEO_MA) {
    if (msg.includes(ma)) return cau;
  }
  // Lỗi lạ hiện nguyên văn: giấu đi thì không ai gỡ được, và người dùng không
  // có gì để chụp màn hình gửi đi.
  return `Lỗi: ${msg}`;
}
