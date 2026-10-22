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
//   lặp tới khi claim trả rỗng (tối đa `maxBatches` vòng, trong ngân sách thời gian tính từ đầu request), rồi
//     rpc notify_drain_record_run_v1(...)       → ghi vết lượt chạy cho "Sức khoẻ giao thông báo".
// Lô đã claim mà không gửi (hết ngân sách / đã gặp CONFIG_ERROR) settle DEFERRED; SQL giữ HOLD cho DEFERRED
// và CONFIG_ERROR (về QUEUED, không tiêu lượt).
//
// Không import gì ngoài chuẩn web (fetch/AbortSignal/JSON) để test Deno chạy offline và
// hai edge function bundle chung một bản logic. Deploy: file này phải lên CÙNG hàm gọi nó —
// `npm run test-env:edge -- <slug>` (TEST) tự quét import tương đối; production dùng cùng quy ước
// đường dẫn tính từ gốc repo (scripts/test-env/edge.mjs `dungGoiDeploy`).

export type PushOutcome =
  | 'SENT' | 'PARTIAL' | 'NO_DEVICE' | 'ALL_FAILED' | 'DUPLICATE'
  | 'PROVIDER_ERROR' | 'CONFIG_ERROR' | 'BAD_REQUEST' | 'UNAUTHORIZED';

export const PUSH_OUTCOMES: readonly PushOutcome[] = [
  'SENT', 'PARTIAL', 'NO_DEVICE', 'ALL_FAILED', 'DUPLICATE',
  'PROVIDER_ERROR', 'CONFIG_ERROR', 'BAD_REQUEST', 'UNAUTHORIZED',
];

/**
 * Outcome drain gửi cho notify_settle_push_batch_v2 = outcome của send-push + DEFERRED.
 * DEFERRED chỉ do drain tự đặt (lô đã claim nhưng CHƯA gọi send-push vì hết ngân sách thời gian hoặc đã gặp
 * CONFIG_ERROR); send-push không bao giờ trả nó nên `PUSH_OUTCOMES` không chứa.
 * SQL coi DEFERRED và CONFIG_ERROR là HOLD: dòng về QUEUED, KHÔNG tiêu lượt thử.
 */
export type SettleOutcome = PushOutcome | 'DEFERRED';

/** Outcome coi như đã giao cho dịch vụ push (DUPLICATE: SQL settle v2 còn tra lại push_send_log). */
export const DELIVERED_OUTCOMES: ReadonlySet<PushOutcome> = new Set(['SENT', 'PARTIAL', 'DUPLICATE']);
/**
 * Outcome là lỗi giao vận cần người vận hành thấy. CONFIG_ERROR vắng ở đây vì TEST cố ý không có VAPID;
 * trên production drain tự đưa CONFIG_ERROR vào `failures` (xem `configErrorCountsAsFailure`).
 */
export const FAILURE_OUTCOMES: ReadonlySet<PushOutcome> = new Set(['PROVIDER_ERROR', 'ALL_FAILED', 'BAD_REQUEST', 'UNAUTHORIZED']);

export const SEND_PUSH_TIMEOUT_MS = 8000;
const MAX_IDEM_KEY = 128;

/** Ref project production (công khai: supabase/config.toml, api/salary-v5-cron.js). */
export const PRODUCTION_PROJECT_REF = 'tryymsxyyckgbrmmvozx';

/**
 * CONFIG_ERROR (thiếu/sai VAPID) có phải lỗi cần báo động không — quyết theo SUPABASE_URL, env edge LUÔN có.
 * Repo không có env riêng đánh dấu TEST cho edge function, nên chỉ MIỄN khi URL chứng minh được là MỘT project
 * Supabase KHÁC production (`https://<ref 20 ký tự>.supabase.co`, ref ≠ production) — tức project TEST, nơi
 * thiếu VAPID là thiết kế (scripts/test-env/edge.mjs chặn VAPID). URL production, URL lạ, custom domain hay
 * local ⇒ coi là lỗi (đóng an toàn: thà báo thừa còn hơn mất VAPID production mà không ai thấy).
 */
export function configErrorCountsAsFailure(supabaseUrl: string): boolean {
  let host: string;
  try {
    host = new URL(supabaseUrl).hostname.toLowerCase();
  } catch {
    return true;
  }
  const ref = /^([a-z0-9]{20})\.supabase\.co$/.exec(host)?.[1];
  return !ref || ref === PRODUCTION_PROJECT_REF;
}

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
    // dịch vụ push đã nhận ⇒ coi như lỗi tạm; settle v2 tra push_send_log của khoá này rồi mới quyết.
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
    // Mạng đứt / cold start quá 8 s: CHƯA biết có gửi hay không ⇒ PROVIDER_ERROR retryable. Chặn gửi trùng là
    // việc của notify_settle_push_batch_v2: nó tra push_send_log của ĐÚNG khoá lượt này TRƯỚC nhánh lỗi —
    // sổ SENT/PARTIAL có sent>0 ⇒ chốt SENT dù edge báo lỗi; sổ còn SENDING ⇒ giữ nguyên để bước thu hồi
    // lease xử lý. Claim v2 cấp khoá MỚI mỗi lượt, nên không có bước tra sổ đó thì lượt sau sẽ gửi lại.
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

/**
 * Body gửi send-push. send-push tự cắt data.notificationIds ≤20 và giữ trần 3,5 kB.
 *
 * `notificationIds` cấp trên lấy `data.notificationIds` của claim v2 (≤20 id MỚI NHẤT) khi có: send-push
 * (policy.ts pickNotificationIds) ưu tiên trường cấp trên, còn `notification_ids` của claim là TOÀN BỘ id
 * của nhóm xếp cũ→mới — gửi nó thì nhóm >20 dòng sẽ mang 20 id CŨ NHẤT trong khi tiêu đề/url lấy dòng mới
 * nhất. Thứ tự ưu tiên ở policy.ts giữ nguyên (lane lifecycle và đường JWT người dùng dựa vào nó).
 */
export function sendPushRequestFor(batch: DrainBatch): SendPushRequest {
  const data: Record<string, unknown> = { ...batch.data };
  if (batch.organizationId && data.organizationId === undefined) data.organizationId = batch.organizationId;
  const recent = data.notificationIds;
  const notificationIds = Array.isArray(recent) && recent.length > 0 && recent.every((id) => typeof id === 'string')
    ? recent as string[]
    : batch.notificationIds;
  return {
    userId: batch.userId,
    idempotencyKey: batch.idemKey,
    notificationIds,
    title: batch.title,
    body: batch.body,
    url: batch.url,
    tag: batch.tag,
    data,
  };
}

export interface SettleItem {
  idem_key: string;
  outcome: SettleOutcome;
  retryable: boolean;
  error: string | null;
  sent: number;
}

/** Ngân sách mặc định của một lượt drain lẻ (salary-v5-jobs job=push_drain), tính từ `startedAt`. */
export const DEFAULT_DRAIN_DEADLINE_MS = 45_000;

export interface DrainOptions {
  /** Số vòng claim tối đa mỗi lượt (plan: "lặp tới rỗng, tối đa 5 lô"). */
  maxBatches?: number;
  /** p_limit của claim — số DÒNG thông báo mỗi vòng. */
  limit?: number;
  /** Số lời gọi send-push chạy song song trong một vòng. */
  concurrency?: number;
  /**
   * Mốc bắt đầu của REQUEST (ms, cùng đồng hồ với `now`). Bên gọi truyền mốc đầu handler để ngân sách tính cả
   * các pha chạy trước drain; vắng thì lấy lúc drain bắt đầu.
   */
  startedAt?: number;
  /**
   * Ngân sách thời gian tính từ `startedAt`. Mọi lời gọi send-push phải KẾT THÚC trước hạn (mở lời gọi mới chỉ
   * khi now + timeoutMs ≤ hạn); vòng claim mới chỉ mở khi còn chỗ cho ít nhất một lời gọi. Lô đã claim mà chưa
   * gửi ⇒ settle DEFERRED (HOLD: về QUEUED, không tiêu lượt) thay vì nằm SENDING tới khi lease 15' hết.
   */
  deadlineMs?: number;
  timeoutMs?: number;
  now?: () => number;
  /**
   * CONFIG_ERROR có vào `failures` (⇒ 503 + dòng '[drain]') không. Vắng ⇒ `configErrorCountsAsFailure(supabaseUrl)`:
   * production (và mọi URL không chứng minh được là project khác) = có, project TEST = không.
   */
  configErrorIsFailure?: boolean;
}

export type DrainStop = 'empty' | 'max_batches' | 'retryable' | 'config_error' | 'deadline' | 'error';

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
 *   • CONFIG_ERROR (thiếu/sai VAPID — gửi lại ngay cũng hỏng y hệt; SQL giữ HOLD);
 *   • DEFERRED (hết ngân sách / dừng sau CONFIG_ERROR — claim tiếp chỉ để trả về ngay);
 *   • DUPLICATE (có thể còn một lượt khác đang gửi đúng khoá đó — để settle v2 tra push_send_log ở nhịp sau,
 *     tránh claim lại với khoá mới và gửi trùng trong cùng một phút).
 */
function needsLaterTick(item: SettleItem): boolean {
  if (item.outcome === 'DUPLICATE' || item.outcome === 'CONFIG_ERROR' || item.outcome === 'DEFERRED') return true;
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

type SendAttempt = { deferred: false; result: PushCallResult } | { deferred: 'deadline' | 'config_error' };

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
  const timeoutMs = options.timeoutMs ?? SEND_PUSH_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const startedAt = options.startedAt ?? now();
  const deadlineAt = startedAt + (options.deadlineMs ?? DEFAULT_DRAIN_DEADLINE_MS);
  const configErrorIsFailure = options.configErrorIsFailure ?? configErrorCountsAsFailure(supabaseUrl);
  // Mở một lời gọi send-push chỉ khi nó chắc chắn xong (kể cả hết timeout) trước hạn.
  const outOfTime = () => now() + timeoutMs > deadlineAt;

  const result: DrainResult = {
    job: 'push_drain', ok: false, rounds: 0, batches: 0, settled: 0, settledRows: 0,
    outcomes: {}, failures: [], stoppedBy: 'max_batches', error: null, recordError: null,
  };

  try {
    for (let round = 0; round < maxBatches; round++) {
      // Cả vòng đầu: các pha trước drain có thể đã tiêu hết ngân sách của request.
      if (outOfTime()) { result.stoppedBy = 'deadline'; break; }
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

      // Mỗi lời gọi tự bắt lỗi ⇒ một lô hỏng không làm rơi settle của các lô khác. Trước khi MỞ lời gọi mới:
      // hết ngân sách hoặc đã gặp CONFIG_ERROR (VAPID hỏng thì lô nào cũng hỏng y hệt) ⇒ không gọi, DEFERRED.
      let configErrorSeen = false;
      const attempts = await mapWithConcurrency(sendable, concurrency, async (batch): Promise<SendAttempt> => {
        if (configErrorSeen) return { deferred: 'config_error' };
        if (outOfTime()) return { deferred: 'deadline' };
        let pushed: PushCallResult;
        try {
          pushed = await callSendPush(fetcher, supabaseUrl, serviceKey, sendPushRequestFor(batch), timeoutMs);
        } catch (error) {
          pushed = { outcome: 'PROVIDER_ERROR', retryable: true, error: String(error).slice(0, 300), sent: 0, failed: 0, httpStatus: null };
        }
        if (pushed.outcome === 'CONFIG_ERROR') configErrorSeen = true;
        return { deferred: false, result: pushed };
      });
      let deferredByDeadline = false;
      sendable.forEach((batch, index) => {
        const attempt = attempts[index];
        if (attempt.deferred) {
          if (attempt.deferred === 'deadline') deferredByDeadline = true;
          items.push({
            idem_key: batch.idemKey, outcome: 'DEFERRED', retryable: true, sent: 0,
            error: attempt.deferred === 'deadline'
              ? 'Chưa gửi: hết ngân sách thời gian của lượt, trả về hàng đợi'
              : 'Chưa gửi: lô cùng vòng gặp CONFIG_ERROR, trả về hàng đợi',
          });
          return;
        }
        const r = attempt.result;
        items.push({ idem_key: batch.idemKey, outcome: r.outcome, retryable: r.retryable, error: r.error, sent: r.sent });
      });

      let retryLater = false;
      for (const item of items) {
        result.outcomes[item.outcome] = (result.outcomes[item.outcome] ?? 0) + 1;
        if (item.outcome !== 'DEFERRED' && FAILURE_OUTCOMES.has(item.outcome)) result.failures.push(`${item.idem_key}: ${item.outcome}`);
        if (item.outcome === 'CONFIG_ERROR' && configErrorIsFailure) {
          result.failures.push(`${item.idem_key}: CONFIG_ERROR${item.error ? ` ${item.error.slice(0, 120)}` : ''}`);
        }
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
      if (configErrorSeen) { result.stoppedBy = 'config_error'; break; }
      if (deferredByDeadline) { result.stoppedBy = 'deadline'; break; }
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
