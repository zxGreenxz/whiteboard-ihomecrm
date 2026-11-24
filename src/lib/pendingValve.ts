// Van an toàn cho dấu «chờ đối chiếu»: khi một lần ghi bị chặn bởi dấu của lần gửi trước mà máy không tự kết
// luận được, người dùng được báo rõ việc nào đang kẹt và, sau ngưỡng `PENDING_SETTLE_MS`, tự xác nhận để làm
// tiếp. Trước 24/11/2026 dấu như vậy chặn VĨNH VIỄN: tải lại trang hay đăng xuất đều không gỡ.
//
// Ba việc của tệp này:
//   1. Dựng câu báo gọi đúng thao tác ĐANG KẸT và giờ kẹt (đọc từ dấu), không phải thao tác đang bấm.
//   2. Giữ hàng chờ các lần bị chặn để `PendingValveDialog` (gắn một lần ở gốc ứng dụng) hiển thị.
//   3. Gỡ ĐÚNG dấu người dùng đã xác nhận (theo `attemptId`) và ghi một dòng nhật ký TRƯỚC khi gỡ. Nhật ký
//      nằm tạm trong localStorage theo dạng hàng đợi, chờ đợt 1b đẩy lên máy chủ; không ghi được nhật ký thì
//      không gỡ.
import {
  FinancialPendingStorageError, formatPendingTime, pendingHasSettled,
  type FinancialPendingRecord, type FinancialPendingScope, type FinancialPendingStore,
} from './financialPending';
import { pendingStrategyOf } from './pendingStrategies';

/**
 * Kho mà van đọc lại và gỡ dấu. Kho dấu riêng (thu tiền, sửa hợp đồng…) dùng được hộp cảnh báo chung bằng
 * cách tự viết hai hàm này trên kho của mình và trình dấu dưới dạng `FinancialPendingRecord`.
 */
export type PendingValveStore = Pick<FinancialPendingStore, 'read' | 'clearConfirmed'>;
type StoragePort = Pick<Storage, 'getItem' | 'setItem'>;

export interface PendingValveNotice {
  /** `waiting`: dấu chưa quá ngưỡng hoặc lượt ghi còn chạy trong tab, chỉ báo chờ. `stale`: đã quá ngưỡng, người dùng được tự gỡ. */
  kind: 'waiting' | 'stale';
  pending: FinancialPendingRecord;
  /** Thao tác người dùng vừa bấm và bị chặn. Khác thao tác đang kẹt khi nhiều thao tác chung một dấu. */
  blockedOperation: string | null;
  /** Kho đã đọc ra dấu này; lần gỡ phải dùng đúng kho đó. */
  store: PendingValveStore;
}

/** Một dòng nhật ký tự gỡ. Đủ để đợt 1b ghi lên máy chủ; `id` để lần đẩy lặp lại không sinh hai dòng. */
export interface PendingValveLogEntry {
  id: string;
  userId: string;
  organizationId: string;
  namespace: string;
  businessKey: string;
  operation: string | null;
  attemptId: string;
  recordIds: string[];
  /** Giờ gửi của lần ghi bị kẹt. */
  stuckAt: string;
  releasedAt: string;
}

export type PendingValveRefusal = 'gone' | 'waiting';
export class PendingValveError extends Error {
  override readonly name = 'PendingValveError';
  constructor(readonly reason: PendingValveRefusal) {
    super(reason === 'waiting'
      ? 'Lần gửi trước có thể vẫn đang được xử lý: chưa đầy 2 phút kể từ hoạt động cuối, hoặc còn đang chạy trong tab này. Thử lại sau ít phút; nếu chờ lâu vẫn vậy, tải lại trang rồi thử lại.'
      : 'Dấu chờ đối chiếu này đã được xử lý ở nơi khác. Bấm lại thao tác để kiểm tra.');
  }
}

const LOG_PREFIX = 'ihome:pending-valve-log:v1:';
const logKey = (userId: string) => LOG_PREFIX + encodeURIComponent(userId);
const scopeOf = (pending: FinancialPendingRecord): FinancialPendingScope => ({
  namespace: pending.namespace, userId: pending.userId, organizationId: pending.organizationId, businessKey: pending.businessKey,
});
const sameScope = (a: FinancialPendingRecord, b: FinancialPendingRecord) =>
  a.namespace === b.namespace && a.userId === b.userId && a.organizationId === b.organizationId && a.businessKey === b.businessKey;

/** Tên việc đang kẹt: tên thao tác lưu trong dấu; dấu cũ không có thì lấy nhãn của namespace trong sổ chiến lược. */
export function pendingOperationName(pending: Pick<FinancialPendingRecord, 'operation' | 'namespace'>): string | null {
  return pending.operation ?? pendingStrategyOf(pending.namespace)?.label ?? null;
}

/** Câu báo khi một lần ghi bị chặn bởi dấu của lần gửi trước. */
export function pendingBlockMessage(pending: FinancialPendingRecord, settled: boolean): string {
  const name = pendingOperationName(pending);
  const head = `${name ? `Yêu cầu ${name}` : 'Một yêu cầu trước đó'} gửi lúc ${formatPendingTime(pending.startedAt)}`;
  // Namespace `silent` không mở hộp cảnh báo, nên câu báo của nó không nhắc tới hộp.
  const valveHint = pendingStrategyOf(pending.namespace)?.silent ? '' : ' hộp cảnh báo cho phép làm tiếp sau khi đã kiểm tra.';
  return settled
    ? `${head} chưa xác nhận xong. Kiểm tra bản ghi liên quan để đối chiếu trước khi thực hiện tiếp${valveHint ? ';' + valveHint : '.'} Tải lại trang không hủy yêu cầu đã gửi.`
    : `${head} đang chờ kết quả nên chưa đối chiếu được. Thử lại sau ít phút.`;
}

function isLogEntry(value: unknown): value is PendingValveLogEntry {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return ['id', 'userId', 'organizationId', 'namespace', 'businessKey', 'attemptId', 'stuckAt', 'releasedAt'].every(field => typeof row[field] === 'string' && row[field])
    && (row.operation === null || typeof row.operation === 'string')
    && Array.isArray(row.recordIds) && row.recordIds.every(id => typeof id === 'string');
}

export function createPendingValve(options: { storage?: StoragePort; now?: () => Date } = {}) {
  const storage = () => options.storage ?? globalThis.localStorage;
  const now = () => options.now?.() ?? new Date();
  let queue: readonly PendingValveNotice[] = [];
  const listeners = new Set<() => void>();
  const publish = (next: readonly PendingValveNotice[]) => { queue = next; listeners.forEach(listener => listener()); };

  function readLog(userId: string): PendingValveLogEntry[] {
    try {
      const raw = storage().getItem(logKey(userId));
      if (raw === null) return [];
      const rows: unknown = JSON.parse(raw);
      if (!Array.isArray(rows) || !rows.every(isLogEntry)) throw new TypeError('Invalid pending valve log');
      return rows;
    } catch { throw new FinancialPendingStorageError(); }
  }
  function writeLog(userId: string, rows: readonly PendingValveLogEntry[]) {
    try { storage().setItem(logKey(userId), JSON.stringify(rows)); }
    catch { throw new FinancialPendingStorageError(); }
  }

  return {
    subscribe(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; },
    /** Lần bị chặn đang chờ người dùng xem; cùng một tham chiếu cho tới khi hàng chờ đổi. */
    current: (): PendingValveNotice | null => queue[0] ?? null,
    waitingCount: (): number => queue.length,

    /** Lõi gọi khi một lần ghi bị chặn bởi dấu của lần gửi trước mà chưa kết luận được. */
    report(input: { pending: FinancialPendingRecord; blockedOperation?: string | null; store: PendingValveStore }): void {
      if (pendingStrategyOf(input.pending.namespace)?.silent) return;
      const notice: PendingValveNotice = {
        kind: pendingHasSettled(input.pending, now()) ? 'stale' : 'waiting',
        pending: input.pending, blockedOperation: input.blockedOperation ?? null, store: input.store,
      };
      const at = queue.findIndex(item => sameScope(item.pending, input.pending));
      publish(at < 0 ? [...queue, notice] : queue.map((item, index) => index === at ? notice : item));
    },

    /** Đóng hộp cảnh báo mà không gỡ: dấu giữ nguyên, lần bấm sau lại được báo. */
    dismiss(notice: PendingValveNotice): void { publish(queue.filter(item => item !== notice)); },

    /** «Kiểm tra lại»: đọc lại dấu. Dấu đã được gỡ ở nơi khác thì thôi báo; chưa thì cập nhật đã quá ngưỡng hay chưa. */
    recheck(notice: PendingValveNotice): 'resolved' | 'waiting' | 'stale' {
      const live = notice.store.read(scopeOf(notice.pending));
      if (!live || live.attemptId !== notice.pending.attemptId) { publish(queue.filter(item => item !== notice)); return 'resolved'; }
      const kind = pendingHasSettled(live, now()) ? 'stale' : 'waiting';
      publish(queue.map(item => item === notice ? { ...notice, kind, pending: live } : item));
      return kind;
    },

    /**
     * «Đã kiểm tra, cho làm tiếp»: gỡ ĐÚNG dấu trong lời báo. Từ chối khi dấu đã đổi (lần gửi khác) hoặc chưa quá
     * ngưỡng. Nhật ký ghi trước; không ghi được thì ném lỗi và dấu giữ nguyên.
     */
    release(notice: PendingValveNotice): PendingValveLogEntry {
      const scope = scopeOf(notice.pending);
      const live = notice.store.read(scope);
      if (!live || live.attemptId !== notice.pending.attemptId) { publish(queue.filter(item => item !== notice)); throw new PendingValveError('gone'); }
      const releasedAt = now();
      if (!pendingHasSettled(live, releasedAt)) throw new PendingValveError('waiting');
      const entry: PendingValveLogEntry = {
        id: crypto.randomUUID(), userId: live.userId, organizationId: live.organizationId, namespace: live.namespace,
        businessKey: live.businessKey, operation: pendingOperationName(live), attemptId: live.attemptId,
        recordIds: [...live.completedIds], stuckAt: live.startedAt, releasedAt: releasedAt.toISOString(),
      };
      const before = readLog(live.userId);
      writeLog(live.userId, [...before, entry]);
      let cleared = false;
      try { cleared = notice.store.clearConfirmed(scope, live.attemptId); }
      finally { if (!cleared) writeLog(live.userId, before); }
      publish(queue.filter(item => item !== notice));
      if (!cleared) throw new PendingValveError('gone');
      return entry;
    },

    /** Hàng đợi nhật ký của một người dùng, cũ trước. */
    readLog,
    /** Đợt 1b gọi sau khi máy chủ đã nhận: bỏ các dòng đã đẩy khỏi hàng đợi. */
    acknowledgeLog(userId: string, ids: readonly string[]): void {
      const drop = new Set(ids);
      writeLog(userId, readLog(userId).filter(entry => !drop.has(entry.id)));
    },
  };
}
export type PendingValve = ReturnType<typeof createPendingValve>;
export const pendingValve = createPendingValve();
