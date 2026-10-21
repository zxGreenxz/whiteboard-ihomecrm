// send-push/policy.ts — hàm THUẦN của send-push (không import, không I/O) để test Deno chạy offline.
//
//  1) buildPushData / buildPushPayload: payload gửi tới service worker theo hợp đồng plan 2026-10-21 §4
//       {title, body, url, tag, icon, badge, data:{...body.data, notificationIds?: string[], organizationId?: string}}
//     notificationIds ≤20 UUID hợp lệ (bấm push ⇒ app đánh dấu đúng các dòng đó là đã đọc),
//     organizationId là UUID hợp lệ (bấm push ⇒ app chuyển đúng công ty). Quá trần byte thì cắt
//     notificationIds TRƯỚC, rồi mới cắt nội dung.
//  2) decideExistingIdempotencyKey: khoá đã có trong push_send_log thì gửi lại hay trả DUPLICATE
//     (NOTIF-SERVER-5: thử lại sau lỗi retryable từng bị đánh SENT giả vì mọi khoá trùng đều là DUPLICATE).

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_DATA_NOTIFICATION_IDS = 20;
/** SENDING trẻ hơn mốc này = có lượt khác đang gửi thật ⇒ DUPLICATE. Bằng lease 15' của drain. */
export const SENDING_FRESH_MS = 15 * 60_000;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** Lấy tối đa 20 UUID hợp lệ, không trùng, từ nguồn ĐẦU TIÊN có ít nhất một UUID. */
export function pickNotificationIds(...sources: unknown[]): string[] {
  for (const source of sources) {
    if (!Array.isArray(source)) continue;
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const value of source) {
      if (typeof value !== 'string' || !UUID_RE.test(value)) continue;
      const key = value.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      ids.push(value);
      if (ids.length >= MAX_DATA_NOTIFICATION_IDS) break;
    }
    if (ids.length) return ids;
  }
  return [];
}

export interface PushDataInput {
  data?: unknown;
  notificationIds?: unknown;
  organizationId?: unknown;
}

/** Gộp body.data (object) + notificationIds + organizationId hợp lệ. Giá trị sai kiểu bị bỏ, không ném. */
export function buildPushData(input: PushDataInput): Record<string, unknown> {
  const source = isPlainObject(input.data) ? input.data : {};
  const { notificationIds: rawIds, organizationId: rawOrg, ...rest } = source;
  const data: Record<string, unknown> = { ...rest };
  const ids = pickNotificationIds(input.notificationIds, rawIds);
  if (ids.length) data.notificationIds = ids;
  const org = [input.organizationId, rawOrg].find((value) => typeof value === 'string' && UUID_RE.test(value));
  if (typeof org === 'string') data.organizationId = org;
  return data;
}

export interface PushPayloadInput {
  title: string;
  body: string;
  url: string;
  tag?: string;
  icon: string;
  badge: string;
  data: Record<string, unknown>;
}

export interface BuiltPushPayload {
  payload: string;
  bytes: number;
  truncatedBody: boolean;
  droppedNotificationIds: number;
}

export const utf8len = (s: string) => new TextEncoder().encode(s).length;

export function buildPushPayload(input: PushPayloadInput, maxBytes: number): BuiltPushPayload {
  const { notificationIds: rawIds, ...rest } = input.data;
  let ids = Array.isArray(rawIds) ? rawIds.filter((id): id is string => typeof id === 'string') : [];
  const originalIds = ids.length;
  const build = (text: string) =>
    JSON.stringify({
      title: input.title, body: text, url: input.url, tag: input.tag, icon: input.icon, badge: input.badge,
      data: ids.length ? { ...rest, notificationIds: ids } : rest,
    });

  let text = input.body;
  let payload = build(text);
  // Bước 1: bớt notificationIds trước — mất vài id chỉ làm bấm push không đánh dấu đọc hết các dòng,
  // còn nội dung là thứ người dùng thực sự đọc.
  while (utf8len(payload) > maxBytes && ids.length > 0) {
    ids = ids.slice(0, ids.length - 1);
    payload = build(text);
  }
  // Bước 2: cắt nội dung theo tỉ lệ (không theo byte) vì tiếng Việt là đa byte; vòng lặp hội tụ nhanh.
  let truncatedBody = false;
  while (utf8len(payload) > maxBytes && text.length > 0) {
    const keep = Math.max(0, Math.floor(text.length * 0.85) - 1);
    text = text.slice(0, keep);
    payload = build(text ? `${text}…` : '');
    truncatedBody = true;
  }
  return { payload, bytes: utf8len(payload), truncatedBody, droppedNotificationIds: originalIds - ids.length };
}

export interface ExistingSendLog {
  outcome: unknown;
  created_at: unknown;
  user_id: unknown;
}

/**
 * Khoá đã nằm trong push_send_log:
 *   'duplicate' — lượt trước SENT/PARTIAL (dịch vụ push đã nhận) hoặc đang SENDING trong 15 phút;
 *   'reclaim'   — lượt trước không tới được máy nào (ALL_FAILED/PROVIDER_ERROR/NO_DEVICE) hoặc SENDING
 *                 đã quá hạn (edge chết giữa chừng) ⇒ giành lại khoá bằng UPDATE có điều kiện rồi gửi lại;
 *   'conflict'  — khoá thuộc người khác: lỗi ở caller, không gửi và không tái dùng khoá.
 * PARTIAL là DUPLICATE: gửi lại sẽ làm các máy đã nhận nhận trùng.
 */
export function decideExistingIdempotencyKey(
  existing: ExistingSendLog,
  targetUserId: string,
  nowMs: number,
): 'duplicate' | 'reclaim' | 'conflict' {
  if (typeof existing.user_id !== 'string' || existing.user_id.toLowerCase() !== targetUserId.toLowerCase()) return 'conflict';
  const outcome = typeof existing.outcome === 'string' ? existing.outcome : null;
  if (outcome === 'SENT' || outcome === 'PARTIAL') return 'duplicate';
  if (outcome === 'SENDING') {
    const createdMs = typeof existing.created_at === 'string' ? Date.parse(existing.created_at) : Number.NaN;
    // Không đọc được mốc thì không chứng minh được là quá hạn ⇒ an toàn là không gửi.
    if (!Number.isFinite(createdMs)) return 'duplicate';
    return nowMs - createdMs < SENDING_FRESH_MS ? 'duplicate' : 'reclaim';
  }
  return 'reclaim';
}
