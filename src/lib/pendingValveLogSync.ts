// Đẩy hàng đợi nhật ký tự gỡ khoá «chờ đối chiếu» lên máy chủ (đợt 1b, migration 20261124131052).
//
// Van (`pendingValve.ts`) ghi một dòng vào hàng đợi trong trình duyệt TRƯỚC mỗi lần người dùng tự gỡ dấu. Tệp này
// đưa các dòng đó lên `pending_valve_release_log_append_v1`, ngay sau mỗi lần gỡ và khi mở ứng dụng nếu hàng đợi
// còn dòng (`pendingValveLogQueue.ts` nạp lười tệp này).
//
// LUẬT GIỮ DÒNG
//   * Dòng chỉ rời hàng đợi khi máy chủ trả kết quả rõ cho ĐÚNG dòng đó: đã ghi (inserted), đã có từ lần gửi trước
//     (duplicate), hoặc bị từ chối vì lý do không thể ghi lại được (invalid, not_member, conflict). Máy chủ chống
//     trùng theo (người gỡ, mã dòng), nên gửi lại sau khi mất phản hồi không tạo dòng thứ hai.
//   * Từ chối có thể hết sau (no_org: chưa biết công ty; not_self: phiên vừa đổi người), lỗi mạng, lỗi máy chủ, phản
//     hồi lạ dạng: dòng ở lại, đẩy lại lần sau. Một dòng bị từ chối không chặn các dòng khác.
//   * Không bao giờ ném ra ngoài: đẩy hỏng không được chặn việc gỡ dấu hay thao tác của người dùng.
//   * Chỉ đẩy hàng đợi của đúng người đang đăng nhập.
import { z } from 'zod';
import { getSessionUserId } from './authSession';
import { pendingValve, type PendingValve, type PendingValveLogEntry } from './pendingValve';
import { supabase } from '@/integrations/supabase/client';

/** Số dòng tối đa mỗi lần gọi; khớp giới hạn của máy chủ. */
export const PENDING_VALVE_LOG_BATCH = 50;
/** Lý do từ chối mà gửi lại cũng không bao giờ ghi được: dòng rời hàng đợi để không chặn mãi. */
const PERMANENT_REJECTIONS = new Set(['invalid', 'not_member', 'conflict']);

/** Một dòng gửi lên máy chủ: đúng các ô của dòng hàng đợi, đã cắt theo giới hạn độ dài của bảng. */
export interface PendingValveLogPayload {
  id: string;
  userId: string;
  organizationId: string;
  contextOrganizationId: string | null;
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
}

const resultSchema = z.object({
  results: z.array(z.object({
    id: z.string().nullable(),
    status: z.enum(['inserted', 'duplicate', 'rejected']),
    reason: z.string().nullish(),
  })),
});

const cut = (value: string, max: number) => value.slice(0, max);

export function toPendingValveLogPayload(entry: PendingValveLogEntry): PendingValveLogPayload {
  return {
    id: entry.id,
    userId: entry.userId,
    organizationId: cut(entry.organizationId, 100),
    contextOrganizationId: entry.contextOrganizationId ?? null,
    namespace: cut(entry.namespace, 100),
    businessKey: cut(entry.businessKey, 1000),
    operation: entry.operation === null ? null : cut(entry.operation, 200) || null,
    attemptId: cut(entry.attemptId, 200),
    recordIds: entry.recordIds.slice(0, 100).map((value) => cut(value, 200)).filter(Boolean),
    recordCount: entry.recordIds.length,
    stuckAt: entry.stuckAt,
    releasedAt: entry.releasedAt,
  };
}

export function createPendingValveLogSync(deps: PendingValveLogSyncDeps) {
  const running = new Map<string, Promise<PendingValveLogFlush>>();
  const again = new Set<string>();

  async function once(userId: string): Promise<PendingValveLogFlush> {
    const outcome: PendingValveLogFlush = { sent: 0, acknowledged: 0, kept: 0, error: null };
    let rows: PendingValveLogEntry[];
    try { rows = deps.log.readLog(userId); }
    catch (error) { return { ...outcome, error, skipped: 'unreadable' }; }
    if (rows.length === 0) return outcome;

    let session: string | null;
    try { session = await deps.sessionUserId(); }
    catch (error) { return { ...outcome, error, kept: rows.length, skipped: 'no-session' }; }
    if (!session) return { ...outcome, kept: rows.length, skipped: 'no-session' };
    if (session !== userId) return { ...outcome, kept: rows.length, skipped: 'other-user' };

    let device: string | null = null;
    try { device = deps.device?.() ?? null; } catch { device = null; }

    for (let start = 0; start < rows.length; start += PENDING_VALVE_LOG_BATCH) {
      const batch = rows.slice(start, start + PENDING_VALVE_LOG_BATCH).map(toPendingValveLogPayload);
      outcome.sent += batch.length;
      let data: unknown;
      try { data = await deps.append(batch, device); }
      catch (error) {
        // Lỗi cả lần gọi: giữ lô này và mọi lô sau, thử lại ở lần đẩy kế tiếp.
        outcome.error = error;
        outcome.kept += rows.length - start;
        return outcome;
      }
      const parsed = resultSchema.safeParse(data);
      const sentIds = new Set(batch.map((row) => row.id));
      const done = new Set<string>();
      if (parsed.success) {
        for (const result of parsed.data.results) {
          if (!result.id || !sentIds.has(result.id)) continue;
          if (result.status === 'inserted' || result.status === 'duplicate'
            || (result.status === 'rejected' && PERMANENT_REJECTIONS.has(result.reason ?? ''))) done.add(result.id);
        }
      } else {
        outcome.error = parsed.error;
      }
      if (done.size > 0) {
        try { deps.log.acknowledgeLog(userId, [...done]); }
        catch (error) {
          // Máy chủ đã ghi nhưng không bỏ được khỏi hàng đợi: lần sau gửi lại sẽ nhận duplicate.
          outcome.error = error;
          outcome.kept += rows.length - start;
          return outcome;
        }
      }
      outcome.acknowledged += done.size;
      outcome.kept += batch.length - done.size;
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
  device: () => (typeof navigator === 'undefined' ? null : navigator.userAgent.slice(0, 300) || null),
});

/** Đẩy hàng đợi nhật ký tự gỡ của người dùng này lên máy chủ. Không bao giờ ném. */
export const flushPendingValveLog = (userId: string): Promise<PendingValveLogFlush> => defaultSync.flush(userId);
