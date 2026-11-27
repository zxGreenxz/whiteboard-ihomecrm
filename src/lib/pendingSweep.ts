// Quét nền khi mở app (đợt 11 của plan sửa khoá vĩnh viễn sau rớt mạng, 27/11/2026).
//
// Sau khi đăng nhập / mở app, với các dấu «chờ đối chiếu» của ĐÚNG người đang đăng nhập (đúng phạm vi công ty), chạy sẵn
// hàm đối chiếu CHỈ ĐỌC của namespace đã đăng ký ở `PENDING_SWEEP_SOURCES`, để lần bấm sau không phải chờ một vòng đối
// chiếu và người dùng biết sớm lần gửi trước đã ghi hay chưa.
//
// LUẬT (8 ràng buộc của đề bài đợt 11; mô tả PR đối chiếu từng điểm):
//   1. Chỉ đọc: mỗi dấu đi qua `reconcilePendingOnly` của lõi — CÙNG luật kết luận với lần bấm, không nhận task, không gửi
//      lại. Hàm đối chiếu đăng ký là CHÍNH hàm lần bấm dùng (khai ở tệp hook của nơi ghi) và không có bước ghi nào.
//   2. Chỉ dấu đã lắng (≥ 2 phút kể từ hoạt động cuối, không chạy trong tab). Dấu chưa lắng: để nguyên, báo giờ xét lại.
//   3. Đã ghi ⇒ lõi gỡ dấu; ở đây làm mới dữ liệu liên quan và gộp mọi kết luận thành MỘT thông báo (thao tác + giờ + bản ghi).
//   4. Chưa ghi: lõi chỉ gỡ khi tra chắc chắn; kèm `serverDedupesRequestKey` thì KHÔNG gỡ (gỡ là mất mã cũ ⇒ ghi trùng).
//   5. Đọc hỏng / chưa kết luận ⇒ dấu để nguyên, im lặng; mỗi dấu (theo `attemptId`) chỉ được quét một lần mỗi phiên.
//   6. Không tranh với lần bấm: lõi đánh dấu dấu «đang chạy» trong lúc đối chiếu và bỏ qua dấu mà lần bấm đang chạy. Hai tab:
//      khoá Web Locks theo người dùng (một tab quét một lúc); không có khoá thì chạy trùng vẫn vô hại (chỉ đọc + gỡ đúng
//      `attemptId` đã có kết luận).
//   7. Chỉ dấu của người này, đúng phạm vi công ty mà nơi ghi dùng, đúng namespace đã đăng ký. Còn lại không đụng.
//   8. Tệp này chỉ được nạp động (`usePendingSweepOnOpen`, gắn trong gói nạp lười `serviceWorkerBridge.tsx`) sau khi app dựng
//      xong: không thêm byte nào vào gói entry.
import type { QueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { financialPending, formatPendingTime, isAttemptRunning, pendingHasSettled, PENDING_SETTLE_MS, type FinancialPendingRecord, type FinancialPendingScope, type FinancialPendingStore } from './financialPending';
import { reconcilePendingOnly, type PendingReadOnlyOutcome, type PendingSweepHandler } from './financialWorkflow';
import { forgetOrphanLeadConversionTraces, forgetDeadIntentKeys } from './leadConversionProgress';
import { pendingOperationName } from './pendingValve';

/** Một nhóm namespace đăng ký quét nền, cùng tệp hook khai bộ đối chiếu chỉ đọc của chúng. Tệp chỉ nạp khi có dấu. */
export interface PendingSweepSource {
  namespaces: readonly string[];
  load: () => Promise<Readonly<Record<string, PendingSweepHandler>>>;
}

/**
 * Nơi đăng ký. Chỉ namespace mà hàm đối chiếu của lần bấm (1) không có bước ghi nào và (2) dựng được chỉ từ dấu (khoá nghiệp
 * vụ, mã yêu cầu, `meta`) — không cần dữ liệu của lần bấm. Thêm namespace: khai `PendingSweepHandler` ở tệp hook (dựng từ
 * CHÍNH hàm lần bấm dùng) rồi thêm vào đây; `src/lib/__tests__/pendingSweep.test.ts` đòi mọi dòng khớp sổ chiến lược.
 */
export const PENDING_SWEEP_SOURCES: readonly PendingSweepSource[] = [
  { namespaces: ['voucher-unapprove', 'voucher-restore', 'voucher-verify'], load: async () => (await import('@/hooks/income-expenses/statusMutations')).VOUCHER_PENDING_SWEEP },
  { namespaces: ['handover-confirm', 'handover-cancel-request', 'handover-cancel-confirm', 'handover-cancel-reject'], load: async () => (await import('@/hooks/useCashHandovers')).HANDOVER_PENDING_SWEEP },
  { namespaces: ['invoice-restore', 'invoice-force-cancel'], load: async () => (await import('@/hooks/useInvoices')).INVOICE_PENDING_SWEEP },
];

/** Tiền tố khoá của kho dấu chung (`financialPending.ts`): `<tiền tố><namespace>:<người>:<công ty>:<khoá>`, mỗi phần encodeURIComponent. */
const MARK_PREFIX = 'ihome:financial-pending:v1:';
/** Trần số dấu đối chiếu mỗi lượt, để một máy có nhiều dấu cũ không bắn một loạt lệnh đọc lúc mở app. */
export const PENDING_SWEEP_LIMIT = 25;

type KeyedStorage = Pick<Storage, 'length' | 'key'>;

/** Phạm vi của mọi dấu thuộc kho dấu chung. Khoá hỏng dạng bỏ qua; kho bị chặn ⇒ không có dấu nào. Không ném. */
export function pendingMarkScopes(storage: KeyedStorage): FinancialPendingScope[] {
  const scopes: FinancialPendingScope[] = [];
  let total = 0;
  try { total = storage.length; } catch { total = 0; /* trình duyệt chặn bộ nhớ: không có dấu nào để quét */ }
  for (let index = 0; index < total; index += 1) {
    let key: string | null = null;
    try { key = storage.key(index); } catch { key = null; /* kho chặn giữa chừng: bỏ khoá này */ }
    if (!key || !key.startsWith(MARK_PREFIX)) continue;
    const parts = key.slice(MARK_PREFIX.length).split(':');
    if (parts.length !== 4) continue;
    let decoded: string[] = [];
    try { decoded = parts.map(part => decodeURIComponent(part)); } catch { decoded = []; /* khoá hỏng dạng: không phải dấu của lõi */ }
    if (decoded.length !== 4 || decoded.some(part => !part)) continue;
    const [namespace, userId, organizationId, businessKey] = decoded;
    scopes.push({ namespace, userId, organizationId, businessKey });
  }
  return scopes;
}

export interface PendingSweepOptions {
  userId: string;
  /** Công ty đang chọn. Dấu phạm vi `selected` chỉ được quét khi đúng công ty này. */
  organizationId: string | null;
  storage?: KeyedStorage;
  store?: Pick<FinancialPendingStore, 'read' | 'clearConfirmed'>;
  now?: () => Date;
  sources?: readonly PendingSweepSource[];
  /** `attemptId` đã đối chiếu trong phiên này: mỗi dấu chỉ được quét một lần (không thử lại dồn dập). */
  seen?: Set<string>;
}
export interface PendingSweepSettled {
  pending: FinancialPendingRecord;
  outcome: Extract<PendingReadOnlyOutcome, { kind: 'written' | 'not-written' }>;
  invalidate: readonly string[];
}
export interface PendingSweepReport {
  /** Dấu đã có kết luận và đã được lõi gỡ. */
  settled: PendingSweepSettled[];
  /** Dấu đã đối chiếu nhưng để nguyên (đọc hỏng, chưa kết luận, cần lần bấm gửi lại cùng mã…). */
  kept: { pending: FinancialPendingRecord; reason: Extract<PendingReadOnlyOutcome, { kind: 'kept' }>['reason'] }[];
  /** Giờ (ms) sớm nhất mà một dấu chưa lắng sẽ lắng; `null` nếu không có. */
  recheckAt: number | null;
}

/** Một lượt quét: đọc kho, lọc đúng người / phạm vi / namespace, đối chiếu chỉ đọc từng dấu đã lắng. Không ném. */
export async function sweepPendingMarks(options: PendingSweepOptions): Promise<PendingSweepReport> {
  const store = options.store ?? financialPending;
  const now = options.now ?? (() => new Date());
  const sources = options.sources ?? PENDING_SWEEP_SOURCES;
  const seen = options.seen ?? new Set<string>();
  const report: PendingSweepReport = { settled: [], kept: [], recheckAt: null };
  let storage: KeyedStorage | null = options.storage ?? null;
  if (!storage) {
    try { storage = globalThis.localStorage; } catch { storage = null; /* trình duyệt chặn bộ nhớ: không có dấu nào */ }
  }
  if (!storage) return report;

  const owner = new Map<string, PendingSweepSource>();
  for (const source of sources) for (const namespace of source.namespaces) owner.set(namespace, source);
  const loaded = new Map<PendingSweepSource, Promise<Readonly<Record<string, PendingSweepHandler>> | undefined>>();
  const handlersOf = (source: PendingSweepSource) => {
    let pending = loaded.get(source);
    if (!pending) {
      // Nạp hụt (mất mạng, chunk cũ): bỏ cả nhóm ở lượt này, dấu để nguyên.
      pending = source.load().then(handlers => handlers, () => undefined);
      loaded.set(source, pending);
    }
    return pending;
  };

  let examined = 0;
  for (const scope of pendingMarkScopes(storage)) {
    if (examined >= PENDING_SWEEP_LIMIT) break;
    // (7) Dấu của người khác, hoặc namespace chưa đăng ký (kể cả dấu bản cũ không có chiến lược): không đụng.
    if (scope.userId !== options.userId) continue;
    const source = owner.get(scope.namespace);
    if (!source) continue;
    const handler = (await handlersOf(source))?.[scope.namespace];
    if (!handler) continue;
    // (7) Đúng phạm vi công ty mà nơi ghi dùng: `actor` ⇒ 'actor-scope'; `selected` ⇒ chỉ công ty đang chọn.
    const expectedOrganization = handler.scope === 'actor' ? 'actor-scope' : options.organizationId;
    if (!expectedOrganization || scope.organizationId !== expectedOrganization) continue;
    let pending: FinancialPendingRecord | null = null;
    try { pending = store.read(scope); } catch { pending = null; /* dấu hỏng dạng: chỉ hộp cảnh báo của lần bấm xử lý được */ }
    if (!pending || seen.has(pending.attemptId)) continue;
    // (6) Lần bấm đang chạy đúng dấu này trong tab: lần bấm lo, không hẹn xét lại.
    if (isAttemptRunning(pending.attemptId)) continue;
    // (2) Dấu chưa lắng: để nguyên, báo giờ nó lắng để hẹn xét lại một lần.
    if (!pendingHasSettled(pending, now())) {
      const settleAt = Date.parse(pending.activeAt ?? pending.startedAt) + PENDING_SETTLE_MS;
      if (Number.isFinite(settleAt)) report.recheckAt = report.recheckAt === null ? settleAt : Math.min(report.recheckAt, settleAt);
      continue;
    }
    examined += 1;
    seen.add(pending.attemptId);
    const outcome = await reconcilePendingOnly(pending, handler.reconcile, { store, now });
    if (outcome.kind === 'kept') report.kept.push({ pending, reason: outcome.reason });
    else report.settled.push({ pending, outcome, invalidate: handler.invalidate });
  }
  return report;
}

/** MỘT câu báo cho cả lượt (không báo dồn dập). `null` khi không có dấu nào được gỡ. */
export function pendingSweepNotice(settled: readonly PendingSweepSettled[]): { title: string; description: string } | null {
  if (!settled.length) return null;
  const line = (item: PendingSweepSettled) => {
    const head = `«${pendingOperationName(item.pending) ?? 'Một yêu cầu'}» gửi lúc ${formatPendingTime(item.pending.startedAt)}`;
    if (item.outcome.kind === 'not-written') return `${head}: chưa được ghi; làm lại nếu vẫn cần.`;
    // Câu của hàm đối chiếu đã nêu trạng thái hiện tại và mã bản ghi (kể cả khi ai đó đã đổi bản ghi theo cách khác).
    if (item.outcome.message) return `${head}: ${item.outcome.message}`;
    const ids = item.outcome.recordIds.length ? ` (mã ${item.outcome.recordIds.join(', ')})` : '';
    return `${head}: đã được ghi${ids}.`;
  };
  const shown = settled.slice(0, 3).map(line);
  if (settled.length > 3) shown.push(`Và ${settled.length - 3} yêu cầu khác.`);
  return {
    title: settled.length === 1 ? 'Đã đối chiếu một yêu cầu gửi trước đó' : `Đã đối chiếu ${settled.length} yêu cầu gửi trước đó`,
    description: shown.join(' '),
  };
}

export interface PendingSweepOnOpenInput {
  userId: string;
  organizationId: string | null;
  queryClient: { invalidateQueries: QueryClient['invalidateQueries'] };
  seen: Set<string>;
  /** Mặc định: một toast. */
  notify?: (notice: { title: string; description: string }) => void;
  /** Mặc định: `navigator.locks` (nếu có). */
  locks?: Pick<LockManager, 'request'> | null;
  sweep?: (options: PendingSweepOptions) => Promise<PendingSweepReport>;
}

/**
 * Một lượt quét nền khi mở app: dọn hai họ khoá «ý định» đã chết (đợt 11), quét dấu (một tab một lúc), làm mới dữ liệu của
 * dấu đã gỡ, báo MỘT lần. Không bao giờ ném. Trả `null` khi tab khác đang quét.
 */
export async function runPendingSweepOnOpen(input: PendingSweepOnOpenInput): Promise<PendingSweepReport | null> {
  try { forgetDeadIntentKeys(); forgetOrphanLeadConversionTraces(); } catch { /* dọn khoá chết là việc phụ; hai hàm vốn không ném */ }
  const sweep = input.sweep ?? sweepPendingMarks;
  const notify = input.notify ?? (notice => { toast.info(notice.title, { description: notice.description, duration: 12_000 }); });
  const once = async (): Promise<PendingSweepReport> => {
    const report = await sweep({ userId: input.userId, organizationId: input.organizationId, seen: input.seen });
    const keys = new Set(report.settled.flatMap(item => item.invalidate));
    for (const key of keys) void input.queryClient.invalidateQueries({ queryKey: [key] });
    const notice = pendingSweepNotice(report.settled);
    if (notice) {
      try { notify(notice); } catch { /* thông báo là kênh phụ: dấu đã gỡ đúng, dữ liệu đã làm mới */ }
    }
    return report;
  };
  try {
    const locks = input.locks !== undefined ? input.locks : (typeof navigator !== 'undefined' ? navigator.locks ?? null : null);
    if (!locks) return await once();
    // Tab khác đang giữ khoá (đang quét): bỏ lượt này, không chờ.
    return await locks.request(`ihome:pending-sweep:${input.userId}`, { ifAvailable: true }, async lock => (lock ? once() : null));
  } catch {
    // Lỗi ngoài dự kiến (khoá trình duyệt hỏng, làm mới dữ liệu hỏng): dấu nào đã gỡ là đã có kết luận; còn lại để nguyên.
    return { settled: [], kept: [], recheckAt: null };
  }
}
