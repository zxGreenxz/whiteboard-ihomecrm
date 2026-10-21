// Hàm thuần cho trang Cài đặt thông báo: nhãn outcome push, độ dài khung giờ yên,
// mô tả thiết bị từ user agent, câu phản hồi gửi thử. Không gọi mạng — test đơn vị được.

export type OutcomeTone = 'ok' | 'warn' | 'error' | 'muted';

/**
 * Nhãn cho `outcome` của edge `send-push` (và `push_send_log`). `SENT` chỉ có nghĩa dịch vụ
 * push ĐÃ NHẬN, không chứng minh máy đã hiện thông báo (send-push/index.ts:20-21).
 */
export const PUSH_OUTCOME_LABELS: Record<string, { label: string; tone: OutcomeTone }> = {
  SENT: { label: 'Dịch vụ push đã nhận', tone: 'ok' },
  PARTIAL: { label: 'Chỉ một phần thiết bị nhận', tone: 'warn' },
  NO_DEVICE: { label: 'Chưa có thiết bị nào đang bật', tone: 'warn' },
  ALL_FAILED: { label: 'Không gửi được tới thiết bị nào', tone: 'error' },
  DUPLICATE: { label: 'Trùng lượt gửi trước, bỏ qua', tone: 'muted' },
  PROVIDER_ERROR: { label: 'Dịch vụ push báo lỗi', tone: 'error' },
  CONFIG_ERROR: { label: 'Máy chủ chưa cấu hình push', tone: 'error' },
  BAD_REQUEST: { label: 'Yêu cầu gửi không hợp lệ', tone: 'error' },
  UNAUTHORIZED: { label: 'Phiên đăng nhập không hợp lệ', tone: 'error' },
  SENDING: { label: 'Đang gửi', tone: 'muted' },
  SKIPPED: { label: 'Bỏ qua (đã đọc hoặc đã tắt)', tone: 'muted' },
  // Trạng thái hàng đợi (push_state / lifecycle push_status) dùng chung bảng nhãn này.
  QUEUED: { label: 'Đang chờ gửi', tone: 'muted' },
  PENDING: { label: 'Đang chờ gửi', tone: 'muted' },
  FAILED: { label: 'Lỗi gửi', tone: 'error' },
};

export function pushOutcomeLabel(outcome: string): { label: string; tone: OutcomeTone } {
  return PUSH_OUTCOME_LABELS[outcome] ?? { label: `Kết quả khác (${outcome})`, tone: 'muted' };
}

/**
 * Số giờ của khung yên `[start, end)` theo giờ công ty. `start === end` = KHÔNG có khung yên
 * (đúng như `notify_claim_push_batch_v1`: `when quiet_start = quiet_end then false`).
 */
export function quietHoursLength(start: number, end: number): number {
  return ((end - start) % 24 + 24) % 24;
}

/** Khung yên dài từ ngưỡng này trở lên thì cảnh báo: push bị hoãn gần như cả ngày. */
export const QUIET_HOURS_LONG_THRESHOLD = 12;

export const formatHour = (hour: number): string => `${String(hour).padStart(2, '0')}:00`;

/** "Chrome · Android", "Safari · iPhone"… — chỉ để người dùng nhận ra máy, không dùng để quyết định. */
export function describeUserAgent(ua: string | null | undefined): string {
  if (!ua) return 'Thiết bị không rõ';
  const os = /iPhone/.test(ua) ? 'iPhone'
    : /iPad/.test(ua) ? 'iPad'
    : /Android/.test(ua) ? 'Android'
    : /Windows/.test(ua) ? 'Windows'
    : /Mac OS X|Macintosh/.test(ua) ? 'macOS'
    : /CrOS/.test(ua) ? 'ChromeOS'
    : /Linux/.test(ua) ? 'Linux'
    : null;
  // Thứ tự quan trọng: Edge/Opera/Samsung đều mang chữ "Chrome", Chrome mang chữ "Safari".
  const browser = /Edg(e|A|iOS)?\//.test(ua) ? 'Edge'
    : /OPR\/|Opera/.test(ua) ? 'Opera'
    : /SamsungBrowser\//.test(ua) ? 'Samsung Internet'
    : /Firefox\/|FxiOS\//.test(ua) ? 'Firefox'
    : /Chrome\/|CriOS\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari'
    : null;
  return [browser, os].filter(Boolean).join(' · ') || 'Thiết bị không rõ';
}

export interface TestPushSummary { outcome: string; sent: number; failed: number; total: number; pruned: number }

/**
 * Câu phản hồi sau khi bấm "Gửi thông báo thử". Đọc `outcome` trước (hợp đồng C8), số đếm
 * chỉ để điền câu. Không bao giờ in host/body lỗi của nhà cung cấp ra giao diện.
 */
export function testPushFeedback(r: TestPushSummary): { tone: OutcomeTone; message: string } {
  const prunedNote = r.pruned > 0 ? ` ${r.pruned} thiết bị đã hết hạn đăng ký — bật lại trên máy đó.` : '';
  switch (r.outcome) {
    case 'SENT':
      return { tone: 'ok', message: `Dịch vụ push đã nhận cho ${r.sent}/${r.total} thiết bị. Việc hiện lên còn tuỳ quyền thông báo và chế độ Không làm phiền của máy.` };
    case 'PARTIAL':
      return { tone: 'warn', message: `Dịch vụ push đã nhận cho ${r.sent}/${r.total} thiết bị; ${r.failed} thiết bị chưa gửi được.${prunedNote}` };
    case 'NO_DEVICE':
      return { tone: 'warn', message: 'Chưa có thiết bị nào đang bật nhận thông báo cho tài khoản này. Bật ở mục "Thiết bị này" rồi gửi thử lại.' };
    case 'ALL_FAILED':
      return { tone: 'error', message: `Chưa gửi được tới ${r.failed}/${r.total} thiết bị.${prunedNote || ' Kiểm tra trạng thái đăng ký trên từng máy.'}` };
    case 'DUPLICATE':
      return { tone: 'muted', message: 'Lượt gửi thử trùng lượt trước nên được bỏ qua. Chờ một chút rồi thử lại.' };
    default:
      return { tone: 'error', message: `${pushOutcomeLabel(r.outcome).label}. Chưa xác nhận được thông báo thử đã tới thiết bị.` };
  }
}

/** Đọc `outcome` nếu `sendTestPush()` đã trả (C8); bản cũ chưa có thì suy từ số đếm. */
export function readTestPushOutcome(r: { sent: number; failed: number; total: number; outcome?: unknown }): string {
  if (typeof r.outcome === 'string' && r.outcome) return r.outcome;
  if (r.total === 0) return 'NO_DEVICE';
  if (r.sent > 0) return r.failed > 0 ? 'PARTIAL' : 'SENT';
  return 'ALL_FAILED';
}
