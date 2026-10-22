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
  // lifecycle_reminder_deliveries.push_status: người nhận tắt "Đẩy về máy" cho họ đó.
  DISABLED: { label: 'Người nhận đã tắt đẩy về máy', tone: 'muted' },
  // push_log_7d gom outcome NULL thành 'UNKNOWN' (get_notification_delivery_health_v1).
  UNKNOWN: { label: 'Chưa rõ kết quả', tone: 'muted' },
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

/* ─────────────── Thẻ "Sức khoẻ giao thông báo": nhãn + đánh giá hàng chờ ─────────────── */

/**
 * Họ nguồn của lane nhắc việc máy chủ (`lifecycle_reminder_runs.no_recipient_families`,
 * `source_family`) — xuất hiện ở no_recipient_7d với lý do NO_RECIPIENT_IN_SCOPE.
 */
export const LIFECYCLE_SOURCE_FAMILY_LABELS: Record<string, string> = {
  NOTICE: 'Báo trả phòng đến hẹn',
  TURNOVER: 'Phòng cần dọn/sửa',
  EXIT: 'Hồ sơ trả phòng chờ hoàn tất',
  INVOICE_DUE: 'Hoá đơn sắp đến hạn',
  INVOICE_OVERDUE: 'Hoá đơn quá hạn',
  CONTRACT_EXPIRING: 'Hợp đồng sắp hết hạn',
  DEPOSIT_SHORTFALL: 'Hợp đồng còn thiếu cọc',
};

/** Lý do "không có người nhận" (CHECK notification_no_recipient_log + lane nhắc việc). */
export const NO_RECIPIENT_REASON_LABELS: Record<string, string> = {
  NO_APPROVER_IN_SCOPE: 'Không có người duyệt trong phạm vi',
  ORG_UNRESOLVED: 'Không xác định được công ty',
  ENGINE_OWNED: 'Phiếu do luồng duyệt nhiều bước xử lý',
  NO_RECIPIENT_IN_SCOPE: 'Không có ai đủ quyền trong phạm vi toà',
};

/**
 * Nhãn tiếng Việt cho một dòng no_recipient_7d. `eventTitles` = nhãn họ E1–E6 (truyền
 * NOTIFICATION_EVENT_LABELS từ hook — file này thuần, không nạp tầng dữ liệu). Mã lạ
 * giữ nguyên mã thô để không bịa nghĩa.
 */
export function noRecipientLabel(
  row: { event: string; reason: string },
  eventTitles: Readonly<Record<string, { title: string }>>,
): { event: string; reason: string } {
  return {
    event: eventTitles[row.event]?.title ?? LIFECYCLE_SOURCE_FAMILY_LABELS[row.event] ?? row.event,
    reason: NO_RECIPIENT_REASON_LABELS[row.reason] ?? row.reason,
  };
}

/** Lượt drain chạy mỗi 15 phút (plan B12): thành công gần nhất cũ hơn mốc này ⇒ đáng ngờ. */
export const DRAIN_STALE_MINUTES = 30;
/** Dòng ĐỦ ĐIỀU KIỆN gửi mà chờ quá mốc này ⇒ đáng xem (hai nhịp drain đã lỡ). */
export const STUCK_QUEUE_MINUTES = 30;

export interface DeliveryQueueInput {
  generatedAt: string;
  queue: { queued: number; oldestQueuedAt: string | null; oldestEligibleQueuedAt?: string | null; deferredQuiet?: number };
  lastDrainAt: string | null;
  lastDrainOkAt?: string | null;
  lastDrainError?: string | null;
}

export type DrainProblem =
  | { kind: 'error'; message: string }
  | { kind: 'stale'; minutes: number; since: string }
  | { kind: 'never-ok' };

export type QueueNote =
  /** Có dòng ĐỦ ĐIỀU KIỆN gửi chờ lâu (máy chủ đã loại dòng giờ yên). */
  | { kind: 'stuck-eligible'; minutes: number; since: string }
  /** Máy chủ chưa tách dòng giờ yên: chỉ biết có dòng chờ lâu — trung tính. */
  | { kind: 'old-maybe-quiet'; minutes: number; since: string };

export interface DeliveryQueueAssessment {
  /** Khác null ⇒ được nói "lượt gửi định kỳ có thể đang lỗi". */
  drainProblem: DrainProblem | null;
  queueNote: QueueNote | null;
  /** Số thông báo đang hoãn hợp lệ vì giờ yên (trung tính); 0 khi máy chủ chưa trả. */
  deferredQuiet: number;
  /** Lượt drain gần nhất là lượt lỗi (biết được khi máy chủ trả last_drain_ok_at). */
  latestDrainFailed: boolean;
}

const phutGiua = (from: string, to: string): number => Math.floor((Date.parse(to) - Date.parse(from)) / 60_000);

/**
 * Đánh giá hàng chờ push cho thẻ Sức khoẻ (SETTINGS-3). Trước đây thẻ báo đỏ "lượt gửi
 * định kỳ có thể đang lỗi" chỉ vì oldest_queued_at ≥ 30 phút — mà oldest_queued_at tính
 * cả dòng đang được HOÃN HỢP LỆ vì giờ yên (mặc định 21h→7h) ⇒ báo oan mỗi đêm.
 * Nay chỉ nói "có thể đang lỗi" khi CHÍNH lượt drain có dấu hiệu hỏng:
 *   - last_drain_error khác null (máy chủ chỉ trả cho super admin), hoặc
 *   - lượt thành công gần nhất cũ hơn DRAIN_STALE_MINUTES (mỗi lượt đều ghi sổ, kể cả
 *     khi không có gì để gửi), hoặc đã có lượt chạy mà chưa lượt nào thành công.
 * Hàng chờ cũ thì dùng oldest_eligible_queued_at (đã loại giờ yên) nếu máy chủ trả; còn
 * không thì chỉ ghi chú trung tính "có thể đang hoãn vì giờ yên".
 */
export function assessDeliveryQueue(h: DeliveryQueueInput): DeliveryQueueAssessment {
  const okAt = h.lastDrainOkAt;
  let drainProblem: DrainProblem | null = null;
  if (typeof h.lastDrainError === 'string' && h.lastDrainError.trim()) {
    drainProblem = { kind: 'error', message: h.lastDrainError.trim() };
  } else if (typeof okAt === 'string') {
    const minutes = phutGiua(okAt, h.generatedAt);
    if (minutes >= DRAIN_STALE_MINUTES) drainProblem = { kind: 'stale', minutes, since: okAt };
  } else if (okAt === null && h.lastDrainAt !== null) {
    drainProblem = { kind: 'never-ok' };
  }

  const coTruongDuDieuKien = h.queue.oldestEligibleQueuedAt !== undefined;
  const moc = coTruongDuDieuKien ? h.queue.oldestEligibleQueuedAt ?? null : h.queue.oldestQueuedAt;
  const minutes = moc ? phutGiua(moc, h.generatedAt) : 0;
  let queueNote: QueueNote | null = null;
  if (moc && minutes >= STUCK_QUEUE_MINUTES) {
    queueNote = coTruongDuDieuKien
      ? { kind: 'stuck-eligible', minutes, since: moc }
      : { kind: 'old-maybe-quiet', minutes, since: moc };
  }

  // Máy chủ chưa từng chạy lượt nào và có dòng đủ điều kiện chờ lâu ⇒ lượt gửi chưa chạy.
  if (!drainProblem && h.lastDrainAt === null && queueNote?.kind === 'stuck-eligible') drainProblem = { kind: 'never-ok' };

  const latestDrainFailed = okAt !== undefined && h.lastDrainAt !== null
    && (okAt === null || Date.parse(okAt) < Date.parse(h.lastDrainAt));

  return { drainProblem, queueNote, deferredQuiet: h.queue.deferredQuiet ?? 0, latestDrainFailed };
}

/** Đọc `outcome` nếu `sendTestPush()` đã trả (C8); bản cũ chưa có thì suy từ số đếm. */
export function readTestPushOutcome(r: { sent: number; failed: number; total: number; outcome?: unknown }): string {
  if (typeof r.outcome === 'string' && r.outcome) return r.outcome;
  if (r.total === 0) return 'NO_DEVICE';
  if (r.sent > 0) return r.failed > 0 ? 'PARTIAL' : 'SENT';
  return 'ALL_FAILED';
}
