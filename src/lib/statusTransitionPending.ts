// Đối chiếu một lần CHUYỂN TRẠNG THÁI chưa rõ kết quả (đợt 5: duyệt, huỷ, khôi phục phiếu; bàn giao; hoá đơn; chốt
// sổ). Cách C của plan sửa khoá vĩnh viễn: trước khi ghi dấu, nơi gọi đọc trạng thái bản ghi và lưu chữ ký của nó vào
// `meta.before` của dấu; lần bấm sau đọc lại rồi so:
//   - đã ở trạng thái đích        ⇒ báo «đã ở trạng thái …», gỡ dấu, không gửi lần hai (có thể do người khác làm);
//   - vẫn đúng như trước khi bấm  ⇒ lần trước chưa ghi: gửi lại (lõi chỉ nhận khi dấu đã quá 2 phút, trừ khi máy
//                                    chủ khoá dòng rồi mới xét trạng thái nên gửi lại sớm cũng không ghi hai lần);
//   - khác hẳn                    ⇒ có ai đó đã làm việc khác: báo trạng thái hiện tại, gỡ dấu, không gửi.
// Không đọc thấy bản ghi (quyền, đã xoá) thì chưa kết luận được: giữ dấu.
import { pendingHasSettled, type FinancialPendingMeta, type FinancialPendingRecord, type PendingReconciliation } from './financialPending';

/**
 * Lần gửi của dấu đang được đối chiếu đã chắc chắn kết thúc chưa, xét TỪ TRONG hàm đối chiếu. Lõi chỉ gọi hàm đối chiếu
 * khi lượt của dấu không còn chạy trong tab, rồi đánh dấu dấu đó «đang chạy» trong lúc đối chiếu; vì vậy ở đây chỉ còn
 * xét ngưỡng 2 phút kể từ hoạt động cuối (`pendingHasSettled` trên chính dấu sẽ luôn trả «chưa»).
 */
export const priorAttemptSettled = (pending: FinancialPendingRecord, now: Date = new Date()): boolean =>
  pendingHasSettled({ startedAt: pending.startedAt, activeAt: pending.activeAt }, now);

/** Khoá trong `meta` của dấu giữ chữ ký trạng thái trước khi bấm. */
export const BEFORE_STATE = 'before';

/** `meta` của dấu cho một lần chuyển trạng thái: chữ ký trạng thái đọc được ngay trước khi ghi dấu. */
export const beforeStateMeta = (signature: string, extra: FinancialPendingMeta = {}): FinancialPendingMeta => ({ ...extra, [BEFORE_STATE]: signature });

export interface TransitionCheck<T> {
  pending: FinancialPendingRecord;
  /** Chữ ký trạng thái hiện tại; `null` khi không đọc thấy bản ghi. */
  current: string | null;
  /** Bản ghi đã ở trạng thái đích của thao tác. */
  reached: boolean;
  /** Kết luận khi đã ở đích: thường là `already-written`, hoặc `{result}` khi dựng được kết quả «không thay đổi». */
  onReached: () => PendingReconciliation<T>;
  /**
   * Dấu không mang chữ ký trạng thái trước (dấu ghi trước đợt 5): trạng thái hiện tại còn đúng điều kiện của thao tác
   * không. Không khai thì dấu như vậy chỉ được kết luận khi đã ở đích.
   */
  ready?: boolean;
  /** Máy chủ khoá dòng TRƯỚC khi xét trạng thái (đã đọc thân hàm production): gửi lại sớm không ghi hai lần. */
  serverLocksFirst?: boolean;
  /** Câu báo khi trạng thái đã khác hẳn (không phải đích, không phải như trước khi bấm). */
  otherMessage: string;
  recordIds: readonly string[];
}

export function transitionVerdict<T>(check: TransitionCheck<T>): PendingReconciliation<T> {
  if (check.current === null) return null;
  if (check.reached) return check.onReached();
  const before = check.pending.meta?.[BEFORE_STATE];
  const unchanged = typeof before === 'string' ? before === check.current : check.ready === true;
  if (unchanged) return check.serverLocksFirst ? { outcome: 'not-written', serverDedupesRequestKey: true } : { outcome: 'not-written' };
  if (typeof before !== 'string' && check.ready === undefined) return null;
  return { outcome: 'already-written', message: check.otherMessage, recordIds: check.recordIds };
}

/**
 * Dấu vân tay ngắn của nội dung gửi đi (không chứa nội dung đó), để lần bấm sau biết nội dung có đổi không. Khoá của
 * object được sắp xếp; thứ tự phần tử mảng giữ nguyên (máy chủ băm cả thứ tự).
 */
export function payloadFingerprint(value: unknown): string {
  const stable = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(stable);
    if (input && typeof input === 'object') {
      return Object.fromEntries(Object.keys(input as Record<string, unknown>).sort()
        .filter(key => (input as Record<string, unknown>)[key] !== undefined)
        .map(key => [key, stable((input as Record<string, unknown>)[key])]));
    }
    return input;
  };
  const text = JSON.stringify(stable(value)) ?? 'undefined';
  // FNV-1a 32 bit hai vòng (hai hạt giống khác nhau) cộng độ dài: đủ để phân biệt «cùng nội dung» với «đã đổi».
  const fnv = (seed: number) => {
    let hash = seed >>> 0;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(36);
  };
  return `${text.length.toString(36)}.${fnv(0x811c9dc5)}.${fnv(0x01000193)}`;
}
