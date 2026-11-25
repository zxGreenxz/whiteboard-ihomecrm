// Lối ra cho dấu «chờ đối chiếu» KHOÁ CHUNG do bản trước đợt 4 để lại (plan sửa khoá vĩnh viễn, 25/11/2026).
//
// Trước đợt 4, tạo khách, nhập khách Excel, tạo khách hẹn và tạo loại thu chi giữ một dấu với MỘT khoá cho mọi bản
// ghi mới cùng loại (`create`, `batch`). Bản này không ghi dấu nào ở các khoá đó nữa (xem `clientRecordCreate.ts`),
// nhưng dấu cũ vẫn có thể nằm trong trình duyệt nhân viên. Dấu đó không còn chặn gì; nó chỉ được đọc MỘT LẦN ở lần
// tạo kế tiếp để đối chiếu gần đúng (nơi gọi tự tra bản ghi quanh giờ kẹt và so với thứ đang tạo), rồi gỡ.
import { getSessionUser } from './authSession';
import { financialPending, pendingHasSettled, type FinancialPendingRecord, type FinancialPendingScope, type FinancialPendingStore } from './financialPending';

export interface LegacyPendingSite {
  /** Namespace của bản trước, khai trong sổ `pendingStrategies.ts`. */
  namespace: string;
  /** Khoá chung của bản trước. */
  businessKey: string;
}

export interface LegacyPendingOptions { store?: FinancialPendingStore; now?: () => Date }

export interface LegacyPendingContext { userId: string; organizationId: string }

/**
 * Có dấu khoá chung cũ ở `site` thì gọi `decide` (đọc máy chủ, trả điều nơi gọi cần biết), gỡ đúng dấu đó, rồi trả
 * `{pending, verdict}`. Trả `null` và để nguyên dấu khi: không có dấu; dấu chưa «kết thúc» (chưa đủ 2 phút, lượt cũ có
 * thể còn chạy ở một tab mở bản trước); hoặc `decide` hỏng. Trong cả ba trường hợp nơi gọi làm tiếp như không có dấu,
 * vì dấu này không còn là khoá của bản ghi nào.
 */
export async function settleLegacyPending<T>(
  site: LegacyPendingSite,
  decide: (pending: FinancialPendingRecord, context: LegacyPendingContext) => Promise<T>,
  options: LegacyPendingOptions = {},
): Promise<{ pending: FinancialPendingRecord; verdict: T } | null> {
  const store = options.store ?? financialPending;
  // Mỗi bước hỏng đều dẫn tới cùng một kết luận «không có gì để đối chiếu lúc này»: dấu cũ để nguyên (nó không chặn
  // gì) và lần tạo sau đối chiếu lại. Không bước nào được làm hỏng lần tạo đang chạy.
  let scope: FinancialPendingScope | undefined;
  try {
    const organizationId = globalThis.localStorage.getItem('ihomecrm.selectedOrganizationId');
    const user = await getSessionUser();
    if (user && organizationId) scope = { namespace: site.namespace, businessKey: site.businessKey, userId: user.id, organizationId };
  } catch { /* Không đọc được phiên hoặc công ty đang chọn. */ }
  if (!scope) return null;
  let pending: FinancialPendingRecord | null = null;
  try { pending = store.read(scope); } catch { /* Dấu hỏng dạng hoặc kho không đọc được. */ }
  if (!pending || !pendingHasSettled(pending, options.now?.() ?? new Date())) return null;
  let decided: { verdict: T } | undefined;
  try { decided = { verdict: await decide(pending, { userId: scope.userId, organizationId: scope.organizationId }) }; } catch { /* Tra máy chủ hỏng. */ }
  if (!decided) return null;
  let cleared = false;
  try { cleared = store.clearConfirmed(scope, pending.attemptId); } catch { /* Không gỡ được dấu trong kho. */ }
  return cleared ? { pending, verdict: decided.verdict } : null;
}

/** Cửa sổ thời gian quanh giờ kẹt để tra bản ghi lần kẹt có thể đã tạo (giờ máy và giờ máy chủ có thể lệch). */
export function legacyWindow(pending: FinancialPendingRecord, marginMs = 60 * 60_000): { from: string; to: string } {
  const started = Date.parse(pending.startedAt);
  const active = Date.parse(pending.activeAt ?? pending.startedAt);
  return { from: new Date(started - marginMs).toISOString(), to: new Date(Math.max(started, active) + marginMs).toISOString() };
}
