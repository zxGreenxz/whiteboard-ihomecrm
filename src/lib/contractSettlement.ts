// =============================================================================
// contractSettlement.ts — LOGIC THUẦN của khu "Hợp đồng & quyết toán".
//
// KHÔNG I/O, KHÔNG đọc Date.now(). Mọi thứ ở đây phải kiểm được bằng unit test.
//
// ── HAI LÀN LÀ HIỂN THỊ, KHÔNG PHẢI TRẠNG THÁI ──────────────────────────────
// Phiếu nằm ở "Cần rà soát" hay "Chờ duyệt" thì với trang Thu chi nó vẫn chỉ là
// một phiếu UNAPPROVED. Khu này KHÔNG sở hữu trạng thái nào, không ghi cột nào
// để đánh dấu làn. Làn suy ra tại chỗ từ dữ liệu sẵn có.
//
// ── BLOCKER ≠ CẢNH BÁO: ĐÂY LÀ CHỖ BẢN v1 SAI NẶNG NHẤT ─────────────────────
// v1 gộp mọi vướng mắc thành một loại, nên phiếu tồn kỳ cũ bị đẩy vào "Cần rà
// soát" rồi ẩn mất nút Duyệt — mà cách duy nhất để hết vướng lại chính là duyệt.
// Vòng kẹt. Đo thật 21/09/2026: 50/95 phiếu chờ duyệt thuộc kỳ trước, tức hơn
// nửa danh sách sẽ kẹt.
//
// Từ đây: chỉ BLOCKER mới đẩy phiếu sang làn rà soát. Cảnh báo chỉ hiện nhãn.
// =============================================================================

import type { SettlementKind } from '@/lib/settlementTypes';

export type { SettlementKind };

/** Dấu nhận diện trong ghi chú bổ sung. Đặt ở ĐẦU nội dung, không đặt giữa. */
export const DAU_CAN_BO_SUNG = '[CẦN BỔ SUNG]';
export const DAU_DA_BO_SUNG = '[ĐÃ BỔ SUNG]';

/**
 * 'pending'   — UNAPPROVED (chờ duyệt). Chỉ trạng thái này mới có làn.
 * 'approved'  — APPROVED + chưa ghi sổ (chờ chi). REVERSED cũng về đây.
 * 'noncash'   — APPROVED + NOT_APPLICABLE: đã duyệt nhưng KHÔNG ghi quỹ (sổ ảo).
 *               KHÔNG phải "đã chi tiền cho khách". Đo thật: 3 phiếu, 9.515.634đ
 *               trên sổ ảo "CỌC (giữ hộ khách)", không có dòng posting nào.
 * 'paid'      — APPROVED + POSTED
 * 'cancelled' — đã huỷ
 * 'unknown'   — tổ hợp lạ. KHÔNG được coi là pending thao tác được.
 */
export type SettlementStatus =
  | 'pending' | 'approved' | 'noncash' | 'paid' | 'cancelled' | 'unknown';

export type SettlementLane = 'can-ra-soat' | 'cho-duyet';

export type SettlementIssue =
  | 'MISSING_RECIPIENT'      // blocker: thiếu tên người nhận
  | 'MISSING_BANK'           // blocker CÓ ĐIỀU KIỆN: chỉ khi chi chuyển khoản
  | 'AMOUNT_MISMATCH'        // blocker: số phiếu ≠ số căn cứ
  | 'BASIS_UNAVAILABLE'      // blocker: tra căn cứ mà LỖI / không đủ quyền
  | 'SUPPLEMENT_PENDING'     // blocker: có yêu cầu bổ sung chưa xử lý
  | 'BASIS_NOT_FOUND'        // cảnh báo: chưa tra được căn cứ ở mức danh sách
  | 'BASIS_NOT_APPLICABLE'   // ghi chú: loại này không có công thức căn cứ
  | 'OLD_PERIOD';            // cảnh báo: phiếu thuộc kỳ trước

/**
 * Tình trạng căn cứ đối chiếu. Tách năm ca vì bản v1 gộp "đọc lỗi" với "không
 * áp dụng" thành cùng một `null` — làm LỖI TẢI DỮ LIỆU bị hiểu thành phiếu sạch.
 *
 * `not-found` KHÁC `unavailable`:
 *   not-found   = chưa tra (vd hoàn thanh lý chỉ tra bằng preview khi mở modal,
 *                 vì RPC đó đắt) ⇒ chỉ cảnh báo, không chặn cả danh sách.
 *   unavailable = đã tra và HỎNG ⇒ chặn, vì không biết số đúng là bao nhiêu.
 */
export type BasisState =
  | { kind: 'matched'; amount: number }
  | { kind: 'mismatch'; amount: number }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'not-found'; reason: string }
  | { kind: 'not-applicable' };

export interface SettlementRow {
  /** Ổn định qua refetch: `${kind}:${voucherId}`. Mọi dòng đều có phiếu. */
  key: string;
  kind: SettlementKind;
  voucherId: string;
  voucherCode: string | null;
  contractId: string | null;
  contractNumber: string | null;
  terminationId: string | null;
  roomId: string | null;
  buildingName: string;
  roomName: string | null;
  customerName: string;
  recipientName: string | null;
  /** LUÔN là số trên phiếu. Không bao giờ là số căn cứ. */
  amount: number;
  basis: BasisState;
  status: SettlementStatus;
  /** Hai cột THÔ, giữ nguyên như DB — writer và bảng nút phải đọc chúng, không
   *  suy ngược từ `status` (REVERSED và UNPOSTED cùng ra 'approved'). */
  approvalStatus: string | null;
  postingStatus: string | null;
  postingMode: string | null;
  /**
   * Phiếu này có bắt buộc số tài khoản không (chi chuyển khoản), hay chi tiền
   * mặt nên không cần. Reader suy từ `posting_mode` / loại sổ.
   * Không chắc ⇒ để `false`, tức chỉ cảnh báo — thà nhắc nhẹ còn hơn khoá nhầm
   * một phiếu tiền mặt hợp lệ.
   */
  bankRequired: boolean;
  bankAccount: string | null;
  eventDate: string | null;
  issues: SettlementIssue[];
  supplementPending: boolean;
  reviewState: string | null;
  reviewVersion: number;
  approvalVersion: number;
  postingVersion: number;
  organizationId: string;
  buildingId: string | null;
}

/** Trạng thái không còn việc để nhắc. */
const DA_DONG: ReadonlySet<SettlementStatus> =
  new Set(['paid', 'cancelled', 'noncash', 'unknown']);

export function settlementStatusOf(
  approval: string | null | undefined,
  posting: string | null | undefined,
): SettlementStatus {
  if (approval === 'CANCELLED') return 'cancelled';
  if (approval === 'UNAPPROVED') return 'pending';
  if (approval === 'APPROVED') {
    if (posting === 'POSTED') return 'paid';
    if (posting === 'NOT_APPLICABLE') return 'noncash';
    // UNPOSTED, REVERSED, null đều là "đã duyệt, chưa ghi sổ".
    return 'approved';
  }
  // Giá trị lạ hoặc thiếu: KHÔNG đoán là pending. Đoán sai theo hướng đó là mời
  // người dùng bấm duyệt một thứ mình không hiểu.
  return 'unknown';
}

/** Vướng mắc này có đẩy phiếu sang làn rà soát không? */
export function isBlocker(
  issue: SettlementIssue,
  row: Pick<SettlementRow, 'bankRequired'>,
): boolean {
  switch (issue) {
    case 'OLD_PERIOD':
    case 'BASIS_NOT_APPLICABLE':
    case 'BASIS_NOT_FOUND':
      return false;
    case 'MISSING_BANK':
      return row.bankRequired;
    default:
      return true;
  }
}

export function detectIssues(
  row: Omit<SettlementRow, 'issues'>,
  period: string,
): SettlementIssue[] {
  if (row.status === 'cancelled') return [];
  const out: SettlementIssue[] = [];

  // Căn cứ: xét cả khi phiếu đã đóng, vì lệch căn cứ vẫn là thông tin đáng biết
  // khi soi lại lịch sử.
  switch (row.basis.kind) {
    case 'mismatch': out.push('AMOUNT_MISMATCH'); break;
    case 'unavailable': out.push('BASIS_UNAVAILABLE'); break;
    case 'not-found': out.push('BASIS_NOT_FOUND'); break;
    case 'not-applicable': out.push('BASIS_NOT_APPLICABLE'); break;
    case 'matched': break;
  }

  if (row.supplementPending) out.push('SUPPLEMENT_PENDING');

  // Còn lại chỉ nhắc khi phiếu vẫn còn việc phải làm.
  if (DA_DONG.has(row.status)) return out;

  if (!(row.recipientName ?? '').trim()) out.push('MISSING_RECIPIENT');
  if (!(row.bankAccount ?? '').trim()) out.push('MISSING_BANK');
  if (row.eventDate && row.eventDate.slice(0, 7) < period) out.push('OLD_PERIOD');

  return out;
}

/**
 * Làn hiển thị. Chỉ phiếu CHỜ DUYỆT mới có làn — phiếu đã duyệt, đã chi, không
 * ghi quỹ, đã huỷ nằm ở các khối riêng của bảng và vẫn phải thao tác được.
 *
 * ⚠ Nút Chi phải dùng được với phiếu ĐÃ DUYỆT, mà phiếu đó trả `null` ở đây.
 * Đừng dùng hàm này làm điều kiện hiện nút Chi.
 */
export function laneOf(
  row: Pick<SettlementRow, 'status' | 'issues' | 'bankRequired'>,
): SettlementLane | null {
  if (row.status !== 'pending') return null;
  return row.issues.some((i) => isBlocker(i, row)) ? 'can-ra-soat' : 'cho-duyet';
}

/**
 * Đọc dấu từ ghi chú bổ sung của MỘT phiếu.
 * Luật: dấu của dòng MANG DẤU mới nhất thắng. Ghi chú không mang dấu nào thì bỏ
 * qua — người ta vẫn ghi chú bình thường mà không định chuyển làn.
 *
 * `notes` phải sắp theo `created_at` TĂNG DẦN — đúng thứ tự
 * `hydrateIncomeExpenseSupplements` trả về.
 *
 * ⚠ GIỚI HẠN ĐÃ BIẾT: RPC ghi chú không có tham số "đang hoàn tất yêu cầu nào",
 * nên một dòng "đã bổ sung" gỡ mọi yêu cầu đang treo, kể cả yêu cầu người khác
 * vừa thêm. Giao diện phải tải lại và hiện yêu cầu đang xử lý trước khi xác nhận.
 */
export function supplementPending(notes: { note: string | null }[]): boolean {
  for (let i = notes.length - 1; i >= 0; i--) {
    const t = (notes[i]?.note ?? '').trimStart();
    if (t.startsWith(DAU_DA_BO_SUNG)) return false;
    if (t.startsWith(DAU_CAN_BO_SUNG)) return true;
  }
  return false;
}

/** Tổng số tiền TRÊN PHIẾU của các dòng đang xem. Không cộng số căn cứ. */
export function sumOnVoucher(rows: Pick<SettlementRow, 'amount' | 'status'>[]): number {
  return rows.reduce((s, r) => (r.status === 'cancelled' ? s : s + r.amount), 0);
}
