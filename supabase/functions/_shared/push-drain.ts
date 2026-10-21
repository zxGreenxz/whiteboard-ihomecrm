// push-drain — vòng drain hàng đợi push E1–E6 DÙNG CHUNG (B12, plan 2026-10-21 §3).
//
// Hai nơi gọi:
//   • edge `lifecycle-reminders` pha (c), mỗi lượt pg_cron 15' — đường CHÍNH;
//   • edge `salary-v5-jobs` job=push_drain — nút "Chạy lại" của admin và lưới đỡ Vercel.
//
// Một lượt drain:
//     rpc notify_claim_push_batch_v2(p_limit)   → lease + gộp theo (user, công ty), bỏ dòng đã đọc,
//                                                 giờ yên công ty + cá nhân (logic ở SQL, gói B-SQL)
//     fetch send-push (service role)             → LUÔN đọc `outcome` trong body, KHÔNG suy từ HTTP status
//     rpc notify_settle_push_batch_v2(p_results) → đóng lô theo outcome; CHẠY kể cả khi một lô lỗi
//   lặp tới khi claim trả rỗng (tối đa `maxBatches` vòng), rồi
//     rpc notify_drain_record_run_v1(...)       → ghi vết lượt chạy cho "Sức khoẻ giao thông báo".
//
// Không import gì ngoài chuẩn web (fetch/AbortSignal/JSON) để test Deno chạy offline và
// hai edge function bundle chung một bản logic.

export type PushOutcome =
  | 'SENT' | 'PARTIAL' | 'NO_DEVICE' | 'ALL_FAILED' | 'DUPLICATE'
  | 'PROVIDER_ERROR' | 'CONFIG_ERROR' | 'BAD_REQUEST' | 'UNAUTHORIZED';

export const PUSH_OUTCOMES: readonly PushOutcome[] = [
  'SENT', 'PARTIAL', 'NO_DEVICE', 'ALL_FAILED', 'DUPLICATE',
  'PROVIDER_ERROR', 'CONFIG_ERROR', 'BAD_REQUEST', 'UNAUTHORIZED',
];

/** Outcome coi như đã giao cho dịch vụ push (DUPLICATE: SQL settle v2 còn tra lại push_send_log). */
export const DELIVERED_OUTCOMES: ReadonlySet<PushOutcome> = new Set(['SENT', 'PARTIAL', 'DUPLICATE']);
/** Outcome là lỗi giao vận cần người vận hành thấy. CONFIG_ERROR cố ý vắng: TEST không có VAPID. */
export const FAILURE_OUTCOMES: ReadonlySet<PushOutcome> = new Set(['PROVIDER_ERROR', 'ALL_FAILED', 'BAD_REQUEST', 'UNAUTHORIZED']);

export const SEND_PUSH_TIMEOUT_MS = 8000;
const MAX_IDEM_KEY = 128;

/** supabase-js `rpc()` trả builder thenable — chỉ cần PromiseLike. */
export type DrainRpc = (
  name: string,
  args?: Record<string, unknown>,
) => PromiseLike<{ data: unknown; error: unknown }>;
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

// ────────────────────────────────────────────────────────────────────────────────────────────
// Lỗi: PostgrestError là object trần ⇒ String(err) ra '[object Object]' (NOTIF-SERVER-3: 30/45
// lượt digest chỉ còn chữ đó trong cron_runs). Luôn ghi JSON {code,message,details,hint}.
// ────────────────────────────────────────────────────────────────────────────────────────────
export interface EdgeErrorFields {
  code: string | null;
  message: string;
  details: string | null;
  hint: string | null;
}

const textOrNull = (value: unknown, max: number): string | null =>
  typeof value === 'string' && value ? value.slice(0, max) : typeof value === 'number' ? String(value) : null;

export function edgeErrorFields(error: unknown): EdgeErrorFields {
  if (typeof error === 'string') return { code: null, message: error.slice(0, 1000), details: null, hint: null };
  if (error && typeof error === 'object') {
    const row = error as Record<string, unknown>;
    const message = textOrNull(row.message, 1000)
      ?? (error instanceof Error ? error.name : null)
      ?? 'Lỗi không có message';
    return {
      code: textOrNull(row.code, 64),
      message,
      details: textOrNull(row.details, 500),
      hint: textOrNull(row.hint, 300),
    };
  }
  return { code: null, message: String(error).slice(0, 1000), details: null, hint: null };
}

/** JSON một dòng, các trường đã cắt trước khi stringify nên chuỗi luôn là JSON hợp lệ (≤ ~2 kB). */
export function formatEdgeError(error: unknown): string {
  return JSON.stringify(edgeErrorFields(error));
}

/** Lỗi RPC giữ nguyên code/details/hint của PostgREST, message có tiền tố tên RPC. */
export class EdgeRpcError extends Error {
  readonly rpc: string;
  readonly code: string | null;
  readonly details: string | null;
  readonly hint: string | null;
  constructor(rpc: string, cause: unknown) {
    const fields = edgeErrorFields(cause);
    super(`${rpc}: ${fields.message}`);
    this.name = 'EdgeRpcError';
    this.rpc = rpc;
    this.code = fields.code;
    this.details = fields.details;
    this.hint = fields.hint;
  }
}

export async function rpcValue(rpc: DrainRpc, name: string, args?: Record<string, unknown>): Promise<unknown> {
  const result = await rpc(name, args);
  if (result.error) throw new EdgeRpcError(name, result.error);
  return result.data;
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// send-push — MỘT cửa, LUÔN trả outcome (contract §D.1a).
//
// 207 PARTIAL và 422 NO_DEVICE đều không `res.ok` nhưng 207 là đã gửi được; suy delivery từ
// HTTP status là điều §L.3 cấm. Chỉ đọc `outcome`; status chỉ dùng khi thân phản hồi là JSON
// KHÔNG có outcome (send-push bản cũ) và khi đó suy theo sent/failed/total.
// ────────────────────────────────────────────────────────────────────────────────────────────
export interface PushCallResult {
  outcome: PushOutcome;
  retryable: boolean;
  error: string | null;
  sent: number;
  failed: number;
  httpStatus: number | null;
}

export interface SendPushRequest {
  userId: string;
  idempotencyKey: string;
  notificationIds?: string[];
  title: string;
  body: string;
  url: string;
  tag?: string | null;
  data?: Record<string, unknown>;
}

const RETRYABLE_STATUS = (status: number) => status === 408 || status === 429 || status >= 500;
const isOutcome = (value: unknown): value is PushOutcome =>
  typeof value === 'string' && (PUSH_OUTCOMES as readonly string[]).includes(value);

/** Phân loại phản hồi send-push. Thuần — test được không cần mạng. */
export function classifySendPushResponse(status: number, text: string, idempotencyKey: string): PushCallResult {
  let body: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = text ? JSON.parse(text) : null;
    body = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    body = null; // 502/504 của cổng edge trả HTML — không được để JSON.parse ném ra ngoài
  }

  const errText = (() => {
    const e = body?.error ?? body?.message;
    if (typeof e === 'string' && e) return e.slice(0, 300);
    const devices = body?.devices;
    if (Array.isArray(devices)) {
      const bad = devices.find((d) => d && typeof d === 'object' && (d as Record<string, unknown>).status !== 'sent');
      if (bad) return JSON.stringify(bad).slice(0, 300);
    }
    const errors = body?.errors;
    if (Array.isArray(errors) && errors.length) return JSON.stringify(errors[0]).slice(0, 300);
    if (status < 200 || status >= 300) return `HTTP ${status} ${text.slice(0, 200)}`;
    return null;
  })();

  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : 0);
  const sent = num(body?.sent);
  const failed = num(body?.failed);

  // Đường chính: send-push bản §D.1a tự khai outcome + retryable.
  if (body && body.outcome !== undefined) {
    if (!isOutcome(body.outcome)) {
      return { outcome: 'PROVIDER_ERROR', retryable: true, error: `send-push trả outcome lạ: ${String(body.outcome).slice(0, 40)}`, sent: 0, failed, httpStatus: status };
    }
    const outcome = body.outcome;
    // Biên nhận phải khớp ĐÚNG lượt này: SENT/PARTIAL mà sent=0 hoặc khoá khác = không chứng minh
    // dịch vụ push đã nhận ⇒ coi như lỗi tạm, lượt sau tra push_send_log rồi mới quyết.
    if ((outcome === 'SENT' || outcome === 'PARTIAL') && (sent === 0 || body.idempotencyKey !== idempotencyKey)) {
      return { outcome: 'PROVIDER_ERROR', retryable: true, error: 'Biên nhận push không khớp lượt gửi này', sent: 0, failed, httpStatus: status };
    }
    const retryable = typeof body.retryable === 'boolean' ? body.retryable : RETRYABLE_STATUS(status);
    return { outcome, retryable, error: DELIVERED_OUTCOMES.has(outcome) ? null : errText, sent, failed, httpStatus: status };
  }

  // Đường lùi: send-push chưa có contract — suy từ sent/failed/total, KHÔNG từ res.ok.
  const total = num(body?.total);
  if (status < 200 || status >= 300 || !body) {
    return {
      outcome: status === 401 || status === 403 ? 'UNAUTHORIZED' : 'PROVIDER_ERROR',
      retryable: status === 401 || status === 403 ? false : (RETRYABLE_STATUS(status) || !body),
      error: errText ?? 'Phản hồi send-push không phải JSON', sent, failed, httpStatus: status,
    };
  }
  if (total === 0 && sent === 0 && failed === 0) {
    return { outcome: 'NO_DEVICE', retryable: false, error: errText, sent, failed, httpStatus: status };
  }
  if (sent > 0 && failed > 0) return { outcome: 'PARTIAL', retryable: false, error: errText, sent, failed, httpStatus: status };
  if (sent > 0) return { outcome: 'SENT', retryable: false, error: null, sent, failed, httpStatus: status };
  return { outcome: 'ALL_FAILED', retryable: true, error: errText, sent, failed, httpStatus: status };
}

export async function callSendPush(
  fetcher: FetchLike,
  supabaseUrl: string,
  serviceKey: string,
  request: SendPushRequest,
  timeoutMs = SEND_PUSH_TIMEOUT_MS,
): Promise<PushCallResult> {
  try {
    const response = await fetcher(`${supabaseUrl}/functions/v1/send-push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${serviceKey}`, apikey: serviceKey },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    return classifySendPushResponse(response.status, text, request.idempotencyKey);
  } catch (error) {
    // Mạng đứt / cold start quá 8 s: CHƯA biết có gửi hay không ⇒ retryable; khoá khử trùng
    // (push_send_log) bảo đảm lượt sau không gửi trùng nếu lượt này thật ra đã tới dịch vụ push.
    return { outcome: 'PROVIDER_ERROR', retryable: true, error: String(error).slice(0, 300), sent: 0, failed: 0, httpStatus: null };
  }
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// Dòng claim v2: {notification_ids uuid[], user_id, organization_id, idem_key, title, body, url,
// tag, data jsonb}. Dòng hỏng mà còn khoá ⇒ settle BAD_REQUEST (lỗi server, không gửi bừa);
// không có khoá thì không settle được ⇒ lease 15' tự trả về hàng đợi và lượt bị đánh lỗi.
// ────────────────────────────────────────────────────────────────────────────────────────────
export interface DrainBatch {
  notificationIds: string[];
  userId: string;
  organizationId: string | null;
  idemKey: string;
  title: string;
  body: string;
  url: string;
  tag: string | null;
  data: Record<string, unknown>;
}

export type ParsedClaim =
  | { ok: true; batch: DrainBatch }
  | { ok: false; idemKey: string | null; reason: string };

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

export function parseClaimBatch(value: unknown): ParsedClaim {
  if (!isPlainObject(value)) return { ok: false, idemKey: null, reason: 'Dòng claim không phải object' };
  const row = value;
  const idemKey = typeof row.idem_key === 'string' && row.idem_key.trim() && row.idem_key.length <= MAX_IDEM_KEY
    ? row.idem_key
    : null;
  if (!idemKey) return { ok: false, idemKey: null, reason: 'Dòng claim thiếu idem_key hợp lệ' };
  const fail = (field: string): ParsedClaim => ({ ok: false, idemKey, reason: `Dòng claim hỏng: ${field}` });
  if (typeof row.user_id !== 'string' || !row.user_id) return fail('user_id');
  if (!Array.isArray(row.notification_ids) || row.notification_ids.some((id) => typeof id !== 'string')) return fail('notification_ids');
  for (const field of ['title', 'body', 'url'] as const) {
    if (typeof row[field] !== 'string') return fail(field);
  }
  if (row.tag !== null && row.tag !== undefined && typeof row.tag !== 'string') return fail('tag');
  if (row.organization_id !== null && row.organization_id !== undefined && typeof row.organization_id !== 'string') {
    return fail('organization_id');
  }
  if (row.data !== null && row.data !== undefined && !isPlainObject(row.data)) return fail('data');
  return {
    ok: true,
    batch: {
      notificationIds: row.notification_ids as string[],
      userId: row.user_id,
      organizationId: typeof row.organization_id === 'string' && row.organization_id ? row.organization_id : null,
      idemKey,
      title: row.title as string,
      body: row.body as string,
      url: row.url as string,
      tag: typeof row.tag === 'string' ? row.tag : null,
      data: isPlainObject(row.data) ? row.data : {},
    },
  };
}

/** Body gửi send-push. send-push tự cắt data.notificationIds ≤20 và giữ trần 3,5 kB. */
export function sendPushRequestFor(batch: DrainBatch): SendPushRequest {
  const data: Record<string, unknown> = { ...batch.data };
  if (batch.organizationId && data.organizationId === undefined) data.organizationId = batch.organizationId;
  return {
    userId: batch.userId,
    idempotencyKey: batch.idemKey,
    notificationIds: batch.notificationIds,
    title: batch.title,
    body: batch.body,
    url: batch.url,
    tag: batch.tag,
    data,
  };
}

export interface SettleItem {
  idem_key: string;
  outcome: PushOutcome;
  retryable: boolean;
  error: string | null;
  sent: number;
}

export interface DrainOptions {
  /** Số vòng claim tối đa mỗi lượt (plan: "lặp tới rỗng, tối đa 5 lô"). */
  maxBatches?: number;
  /** p_limit của claim — số DÒNG thông báo mỗi vòng. */
  limit?: number;
  /** Số lời gọi send-push chạy song song trong một vòng. */
  concurrency?: number;
  /** Quá ngân sách này (tính từ lúc bắt đầu) thì không mở vòng claim mới. */
  deadlineMs?: number;
  timeoutMs?: number;
  now?: () => number;
}

export type DrainStop = 'empty' | 'max_batches' | 'retryable' | 'deadline' | 'error';

export interface DrainResult {
  job: 'push_drain';
  /** true khi chuỗi claim → settle → record_run chạy trọn. Lỗi giao vận từng lô nằm ở `failures`. */
  ok: boolean;
  rounds: number;
  /** Số nhóm gửi (lô user×công ty) đã claim. */
  batches: number;
  /** Số nhóm gửi đã được settle thành công (≤ batches) — UI "Chạy lại" so hai số này. */
  settled: number;
  /** Tổng số dòng notifications mà notify_settle_push_batch_v2 báo đã đóng. */
  settledRows: number;
  outcomes: Record<string, number>;
  failures: string[];
  stoppedBy: DrainStop;
  error: string | null;
  recordError: string | null;
}

/**
 * Lô chưa chốt ⇒ không mở vòng claim mới trong lượt này:
 *   • lỗi tạm (retryable: 5xx/429/mạng/ALL_FAILED có thiết bị lỗi tạm);
 *   • CONFIG_ERROR (thiếu/sai VAPID — gửi lại ngay cũng hỏng y hệt);
 *   • DUPLICATE (có thể còn một lượt khác đang gửi đúng khoá đó — để settle v2 tra push_send_log ở nhịp sau,
 *     tránh claim lại với khoá mới và gửi trùng trong cùng một phút).
 */
function needsLaterTick(item: SettleItem): boolean {
  if (item.outcome === 'DUPLICATE' || item.outcome === 'CONFIG_ERROR') return true;
  if (item.outcome === 'SENT' || item.outcome === 'PARTIAL' || item.outcome === 'NO_DEVICE') return false;
  return item.retryable;
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await worker(items[index]);
    }
  });
  await Promise.all(lanes);
  return out;
}

export async function runGenericPushDrain(
  rpc: DrainRpc,
  fetcher: FetchLike,
  supabaseUrl: string,
  serviceKey: string,
  options: DrainOptions = {},
): Promise<DrainResult> {
  const maxBatches = options.maxBatches ?? 5;
  const limit = options.limit ?? 100;
  const concurrency = options.concurrency ?? 4;
  const deadlineMs = options.deadlineMs ?? 45_000;
  const timeoutMs = options.timeoutMs ?? SEND_PUSH_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const startedAt = now();

  const result: DrainResult = {
    job: 'push_drain', ok: false, rounds: 0, batches: 0, settled: 0, settledRows: 0,
    outcomes: {}, failures: [], stoppedBy: 'max_batches', error: null, recordError: null,
  };

  try {
    for (let round = 0; round < maxBatches; round++) {
      if (round > 0 && now() - startedAt >= deadlineMs) { result.stoppedBy = 'deadline'; break; }
      const raw = await rpcValue(rpc, 'notify_claim_push_batch_v2', { p_limit: limit });
      if (raw === null || raw === undefined || (Array.isArray(raw) && raw.length === 0)) { result.stoppedBy = 'empty'; break; }
      if (!Array.isArray(raw)) throw new Error('notify_claim_push_batch_v2: phản hồi không phải mảng');
      result.rounds++;
      result.batches += raw.length;

      const parsed = raw.map(parseClaimBatch);
      const sendable = parsed.flatMap((p) => (p.ok ? [p.batch] : []));
      const unsettleable: string[] = [];
      const items: SettleItem[] = [];
      for (const p of parsed) {
        if (p.ok) continue;
        if (p.idemKey) items.push({ idem_key: p.idemKey, outcome: 'BAD_REQUEST', retryable: false, error: p.reason, sent: 0 });
        else unsettleable.push(p.reason);
      }

      // Mỗi lời gọi tự bắt lỗi ⇒ một lô hỏng không làm rơi settle của các lô khác.
      const pushed = await mapWithConcurrency(sendable, concurrency, async (batch) => {
        try {
          return await callSendPush(fetcher, supabaseUrl, serviceKey, sendPushRequestFor(batch), timeoutMs);
        } catch (error) {
          return { outcome: 'PROVIDER_ERROR', retryable: true, error: String(error).slice(0, 300), sent: 0, failed: 0, httpStatus: null } as PushCallResult;
        }
      });
      sendable.forEach((batch, index) => {
        const r = pushed[index];
        items.push({ idem_key: batch.idemKey, outcome: r.outcome, retryable: r.retryable, error: r.error, sent: r.sent });
      });

      let retryLater = false;
      for (const item of items) {
        result.outcomes[item.outcome] = (result.outcomes[item.outcome] ?? 0) + 1;
        if (FAILURE_OUTCOMES.has(item.outcome)) result.failures.push(`${item.idem_key}: ${item.outcome}`);
        if (needsLaterTick(item)) retryLater = true;
      }

      // Settle CHẠY DÙ CÓ LÔ LỖI: bỏ bước này thì cả vòng nằm SENDING tới khi lease 15' hết hạn.
      if (items.length) {
        const rows = await rpcValue(rpc, 'notify_settle_push_batch_v2', { p_results: items });
        result.settled += items.length;
        result.settledRows += typeof rows === 'number' && Number.isFinite(rows) ? Math.trunc(rows) : 0;
      }
      if (unsettleable.length) throw new Error(`notify_claim_push_batch_v2: ${unsettleable.length} dòng không settle được — ${unsettleable[0]}`);
      // Có lô chưa chốt: vòng sau sẽ claim lại đúng các dòng vừa trả về QUEUED và đốt thêm lượt
      // trong cùng một phút. Dừng, để nhịp cron 15' kế tiếp thử lại.
      if (retryLater) { result.stoppedBy = 'retryable'; break; }
    }
  } catch (error) {
    result.error = formatEdgeError(error);
    result.stoppedBy = 'error';
  }

  try {
    await rpcValue(rpc, 'notify_drain_record_run_v1', {
      p_batches: result.batches,
      p_settled: result.settledRows,
      p_outcomes: result.outcomes,
      p_error: result.error,
    });
  } catch (error) {
    result.recordError = formatEdgeError(error);
  }
  result.ok = result.error === null && result.recordError === null;
  // ⚠ outcome 'SENT' = dịch vụ push ĐÃ NHẬN. KHÔNG chứng minh máy đã hiện thông báo (§L.3).
  return result;
}
