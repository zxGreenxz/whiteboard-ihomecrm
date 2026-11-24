// Đẩy hàng đợi nhật ký tự gỡ khoá «chờ đối chiếu» lên máy chủ (đợt 1b, migration 20261124131052).
//
// Van (`pendingValve.ts`) ghi một dòng vào hàng đợi trong trình duyệt TRƯỚC mỗi lần người dùng tự gỡ dấu. Tệp này
// đưa các dòng đó lên `pending_valve_release_log_append_v1`, ngay sau mỗi lần gỡ và khi mở ứng dụng nếu hàng đợi
// còn dòng (cả hai nơi đều nạp lười tệp này).
//
// LUẬT GIỮ DÒNG
//   * Dòng chỉ rời hàng đợi khi máy chủ trả kết quả rõ cho ĐÚNG dòng đó: đã ghi (inserted), đã có từ lần gửi trước
//     (duplicate), hoặc bị từ chối vì lý do gửi lại cũng không bao giờ ghi được (invalid, not_member, conflict).
//     Máy chủ chống trùng theo (người gỡ, mã dòng), nên gửi lại sau khi mất phản hồi không tạo dòng thứ hai.
//   * Từ chối có thể hết sau (no_org, not_self, rate_limited, hay lý do lạ), lỗi mạng, lỗi máy chủ, quá hạn chờ,
//     phản hồi lạ dạng: dòng ở lại, đẩy lại lần sau. Một dòng bị từ chối không chặn các dòng khác.
//   * Cả lần gọi bị máy chủ từ chối vì DỮ LIỆU (mã 22xxx, PGRST1xx — ví dụ một chuỗi không mã hoá được) thì gửi lại
//     từng dòng một, để một dòng hỏng không chặn cả hàng đợi mãi; dòng gửi riêng mà vẫn bị từ chối như vậy thì bỏ.
//   * Không bao giờ ném ra ngoài: đẩy hỏng không được chặn việc gỡ dấu hay thao tác của người dùng.
//   * Chỉ đẩy hàng đợi của đúng người đang đăng nhập.
import { z } from 'zod';
import { getSessionUserId } from './authSession';
import { pendingValve, type PendingValve, type PendingValveLogEntry } from './pendingValve';
import { supabase } from '@/integrations/supabase/client';

/** Số dòng tối đa mỗi lần gọi; khớp giới hạn của máy chủ. */
export const PENDING_VALVE_LOG_BATCH = 50;
/** Một lần gọi (hay đọc phiên) treo quá chừng này thì coi là hỏng tạm thời, để lượt chạy không kẹt mãi. */
export const PENDING_VALVE_LOG_TIMEOUT_MS = 30_000;
/** Lý do từ chối mà gửi lại cũng không bao giờ ghi được: dòng rời hàng đợi để không chặn mãi. */
const PERMANENT_REJECTIONS = new Set(['invalid', 'not_member', 'conflict']);

/** Một dòng gửi lên máy chủ: đúng các ô của dòng hàng đợi, đã cắt theo giới hạn độ dài của bảng. */
export interface PendingValveLogPayload {
  id: string;
  userId: string;
  organizationId: string;
  namespace: string;
  businessKey: string;
  operation: string | null;
  attemptId: string;
  recordIds: string[];
  recordCount: number;
  stuckAt: string;
  releasedAt: string;
}

export interface PendingValveLogFlush {
  /** Số dòng đã gửi đi (kể cả lô gửi hỏng; lô sau lô hỏng không được gửi). */
  sent: number;
  /** Số dòng đã rời hàng đợi. */
  acknowledged: number;
  /** Số dòng còn nằm lại trong hàng đợi sau lượt này (trong số đã đọc). */
  kept: number;
  /** Lỗi của lần gọi hỏng, nếu có. */
  error: unknown;
  skipped?: 'no-session' | 'other-user' | 'unreadable';
}

export interface PendingValveLogSyncDeps {
  log: Pick<PendingValve, 'readLog' | 'acknowledgeLog'>;
  /** Gọi máy chủ; ném khi lỗi mạng / lỗi máy chủ, trả dữ liệu thô khi thành công. */
  append: (entries: PendingValveLogPayload[], device: string | null) => Promise<unknown>;
  sessionUserId: () => Promise<string | null>;
  device?: () => string | null;
  timeoutMs?: number;
}

const resultSchema = z.object({
  results: z.array(z.object({
    id: z.string().nullable(),
    status: z.enum(['inserted', 'duplicate', 'rejected']),
    reason: z.string().nullish(),
  })),
});

/** Cắt theo KÝ TỰ (code point), không theo đơn vị UTF-16, để không chặt đôi một emoji thành chuỗi hỏng. */
const cut = (value: string, max: number) => {
  const chars = Array.from(value);
  return chars.length > max ? chars.slice(0, max).join('') : value;
};
/**
 * Khoá nghiệp vụ của link chia sẻ phòng chứa chính mã link (`token:<mã>`, `usePublicRoomTokens.ts`). Nhật ký không
 * xoá được, nên không lưu mã đầy đủ: chỉ giữ 4 ký tự cuối để chủ đối chiếu.
 */
const maskBusinessKey = (value: string) => value.replace(/^token:(.+)$/s, (_match, token: string) => `token:…${token.slice(-4)}`);

export function toPendingValveLogPayload(entry: PendingValveLogEntry): PendingValveLogPayload {
  return {
    id: entry.id,
    userId: entry.userId,
    organizationId: cut(entry.organizationId, 100),
    namespace: cut(entry.namespace, 100),
    businessKey: cut(maskBusinessKey(entry.businessKey), 1000),
    operation: entry.operation === null ? null : cut(entry.operation, 200) || null,
    attemptId: cut(entry.attemptId, 200),
    recordIds: entry.recordIds.slice(0, 100).map((value) => cut(value, 200)).filter(Boolean),
    recordCount: entry.recordIds.length,
    stuckAt: entry.stuckAt,
    releasedAt: entry.releasedAt,
  };
}

/** Lỗi do chính DỮ LIỆU gửi lên (không phải mạng, phiên, máy chủ quá tải): gửi lại y nguyên cũng hỏng y nguyên. */
function isDataRejection(error: unknown): boolean {
  const code = error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code : '';
  return /^22[0-9A-Z]{3}$/.test(code) || /^PGRST1\d\d$/.test(code);
}

class PendingValveLogTimeout extends Error {
  override readonly name = 'PendingValveLogTimeout';
}
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new PendingValveLogTimeout('Quá hạn chờ máy chủ nhật ký.')), ms); }),
  ]).finally(() => clearTimeout(timer));
}

export function createPendingValveLogSync(deps: PendingValveLogSyncDeps) {
  const running = new Map<string, Promise<PendingValveLogFlush>>();
  const again = new Set<string>();
  const timeoutMs = deps.timeoutMs ?? PENDING_VALVE_LOG_TIMEOUT_MS;

  /** Mã các dòng đã có kết quả rõ trong phản hồi; phản hồi lạ dạng thì không dòng nào. */
  function settledIds(data: unknown, sent: readonly PendingValveLogPayload[]): { done: Set<string>; malformed: unknown } {
    const done = new Set<string>();
    const parsed = resultSchema.safeParse(data);
    if (!parsed.success) return { done, malformed: parsed.error };
    const sentIds = new Set(sent.map((row) => row.id));
    for (const result of parsed.data.results) {
      if (!result.id || !sentIds.has(result.id)) continue;
      if (result.status === 'inserted' || result.status === 'duplicate'
        || (result.status === 'rejected' && PERMANENT_REJECTIONS.has(result.reason ?? ''))) done.add(result.id);
    }
    return { done, malformed: null };
  }

  /** Gửi một lô; lô bị từ chối vì dữ liệu thì gửi lại từng dòng. Ném lỗi tạm thời (mạng, phiên, máy chủ). */
  async function sendBatch(batch: PendingValveLogPayload[], device: string | null): Promise<{ done: Set<string>; malformed: unknown }> {
    try {
      return settledIds(await withTimeout(deps.append(batch, device), timeoutMs), batch);
    } catch (error) {
      if (!isDataRejection(error)) throw error;
      if (batch.length === 1) {
        // Một dòng riêng mà máy chủ vẫn từ chối vì dữ liệu: gửi lại cũng không bao giờ ghi được.
        return { done: new Set([batch[0]!.id]), malformed: error };
      }
      const done = new Set<string>();
      let malformed: unknown = error;
      for (const row of batch) {
        const one = await sendBatch([row], device);
        one.done.forEach((id) => done.add(id));
        if (one.malformed) malformed = one.malformed;
      }
      return { done, malformed };
    }
  }

  async function once(userId: string): Promise<PendingValveLogFlush> {
    const outcome: PendingValveLogFlush = { sent: 0, acknowledged: 0, kept: 0, error: null };
    let rows: PendingValveLogEntry[];
    try { rows = deps.log.readLog(userId); }
    catch (error) { return { ...outcome, error, skipped: 'unreadable' }; }
    if (rows.length === 0) return outcome;

    let session: string | null;
    try { session = await withTimeout(deps.sessionUserId(), timeoutMs); }
    catch (error) { return { ...outcome, error, kept: rows.length, skipped: 'no-session' }; }
    if (!session) return { ...outcome, kept: rows.length, skipped: 'no-session' };
    if (session !== userId) return { ...outcome, kept: rows.length, skipped: 'other-user' };

    let device: string | null = null;
    try { device = deps.device?.() ?? null; } catch { device = null; }

    for (let start = 0; start < rows.length; start += PENDING_VALVE_LOG_BATCH) {
      const batch = rows.slice(start, start + PENDING_VALVE_LOG_BATCH).map(toPendingValveLogPayload);
      outcome.sent += batch.length;
      let settled: { done: Set<string>; malformed: unknown };
      try { settled = await sendBatch(batch, device); }
      catch (error) {
        // Lỗi tạm thời của cả lần gọi: giữ lô này và mọi lô sau, thử lại ở lần đẩy kế tiếp.
        outcome.error = error;
        outcome.kept += rows.length - start;
        return outcome;
      }
      if (settled.malformed) outcome.error = settled.malformed;
      if (settled.done.size > 0) {
        try { deps.log.acknowledgeLog(userId, [...settled.done]); }
        catch (error) {
          // Máy chủ đã ghi nhưng không bỏ được khỏi hàng đợi: lần sau gửi lại sẽ nhận duplicate.
          outcome.error = error;
          outcome.kept += rows.length - start;
          return outcome;
        }
      }
      outcome.acknowledged += settled.done.size;
      outcome.kept += batch.length - settled.done.size;
    }
    return outcome;
  }

  /**
   * Đẩy hàng đợi của `userId`. Mỗi người chỉ một lượt chạy một lúc; gọi trong lúc đang chạy thì sau lượt đó chạy thêm
   * đúng một lượt (để dòng vừa gỡ trong lúc đẩy cũng lên được). Không bao giờ ném.
   */
  function flush(userId: string): Promise<PendingValveLogFlush> {
    const current = running.get(userId);
    if (current) { again.add(userId); return current; }
    const run = (async () => {
      let result: PendingValveLogFlush;
      try { result = await once(userId); }
      catch (error) { result = { sent: 0, acknowledged: 0, kept: 0, error }; }
      while (again.delete(userId)) {
        try { result = await once(userId); }
        catch (error) { result = { sent: 0, acknowledged: 0, kept: 0, error }; }
      }
      return result;
    })().finally(() => { running.delete(userId); });
    running.set(userId, run);
    return run;
  }

  return { flush };
}

type LogRpcArgs = {
  pending_valve_release_log_append_v1: { p_entries: PendingValveLogPayload[]; p_device: string | null };
};
// Hàm mới chưa có trong kiểu sinh từ production cho tới khi migration 20261124131052 được áp; chữ ký khai tay ở đây
// và phản hồi luôn được kiểm bằng zod ở trên.
type LogRpc = <N extends keyof LogRpcArgs>(name: N, args: LogRpcArgs[N]) => PromiseLike<{ data: unknown; error: unknown }>;

async function appendToServer(entries: PendingValveLogPayload[], device: string | null): Promise<unknown> {
  const { data, error } = await (supabase.rpc as unknown as LogRpc)('pending_valve_release_log_append_v1', { p_entries: entries, p_device: device });
  if (error) throw error;
  return data;
}

const defaultSync = createPendingValveLogSync({
  log: pendingValve,
  append: appendToServer,
  sessionUserId: getSessionUserId,
  device: () => (typeof navigator === 'undefined' ? null : cut(navigator.userAgent, 300) || null),
});

/** Đẩy hàng đợi nhật ký tự gỡ của người dùng này lên máy chủ. Không bao giờ ném. */
export const flushPendingValveLog = (userId: string): Promise<PendingValveLogFlush> => defaultSync.flush(userId);
