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
  // Blocker. GỘP ba thứ làm một theo yêu cầu chủ 22/09/2026: thiếu tên người
  // nhận, thiếu ngân hàng hay thiếu số tài khoản đều là "thiếu thông tin thanh
  // toán", hiện chung một nhãn thay vì ba nhãn rời.
  //
  // ⚠ MIỄN khi phiếu ĐÃ CÓ ẢNH ĐÍNH KÈM: ảnh chuyển khoản là bằng chứng việc
  // trả tiền đã xử lý ngoài hệ thống, nên không bắt khai lại số tài khoản.
  | 'MISSING_PAYMENT_INFO'
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
  bankAccount: string | null;
  /** Ảnh/chứng từ đang đính trên phiếu (URL public cũ hoặc path Storage). */
  attachments: string[];
  /** Có ít nhất một ảnh đính kèm — miễn điều kiện thiếu thông tin thanh toán. */
  hasAttachment: boolean;
  bankName: string | null;
  eventDate: string | null;
  /** 'reservation' = phát sinh từ phiếu giữ chỗ; còn lại là hợp đồng. */
  origin: 'contract' | 'reservation';
  /** Nhãn biến động sinh ra khoản chi này: "Thanh lý", "Ký mới", … */
  eventLabel: string;
  /** Ngày ghi sổ thật. Chỉ có khi đã POSTED. */
  paidDate: string | null;
  /** Tên sổ quỹ đã ghi. Null khi chưa chi. */
  bookName: string | null;
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

/**
 * Vướng mắc này có đẩy phiếu sang làn rà soát không?
 *
 * Thuần theo loại vướng mắc — không còn xét thuộc tính nào của dòng, vì điều
 * kiện "thiếu thông tin thanh toán" đã tự cân nhắc ảnh đính kèm lúc phát hiện.
 */
export function isBlocker(issue: SettlementIssue): boolean {
  switch (issue) {
    case 'OLD_PERIOD':
    case 'BASIS_NOT_APPLICABLE':
    case 'BASIS_NOT_FOUND':
      return false;
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

  // Thiếu BẤT KỲ mảnh nào của bộ thông tin trả tiền ⇒ một nhãn chung.
  // Ảnh đính kèm miễn hẳn điều kiện này (xem chú thích ở SettlementIssue).
  const thieuThongTin =
    !(row.recipientName ?? '').trim()
    || !(row.bankName ?? '').trim()
    || !(row.bankAccount ?? '').trim();
  if (thieuThongTin && !row.hasAttachment) out.push('MISSING_PAYMENT_INFO');
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
  row: Pick<SettlementRow, 'status' | 'issues'>,
): SettlementLane | null {
  if (row.status !== 'pending') return null;
  return row.issues.some(isBlocker) ? 'can-ra-soat' : 'cho-duyet';
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

// =============================================================================
// TỪ VỰNG HIỂN THỊ — bám đúng bản thiết kế 03 (design/Thanh toan - Hop dong &
// quyet toan.dc.html). Đổi chữ ở đây là đổi giao diện, nên giữ nguyên văn.
// =============================================================================

/**
 * Trạng thái NHÌN THẤY trên bảng. Khác `SettlementStatus` đúng một điểm:
 * 'review' được TÁCH RA khỏi 'pending'.
 *
 * Với Thu chi, cả hai vẫn là UNAPPROVED — 'review' chỉ nghĩa là phiếu chờ duyệt
 * còn vướng blocker. Xem khối "BLOCKER ≠ CẢNH BÁO" ở đầu file.
 */
export type ViewStatus =
  | 'review' | 'pending' | 'approved' | 'noncash' | 'paid' | 'cancelled' | 'unknown';

/** Bộ lọc trạng thái trên thanh công cụ. 'pendpay' chỉ dùng khi bật gộp. */
export type StatusFilter =
  | 'open' | 'all' | 'review' | 'pending' | 'approved' | 'pendpay'
  | 'noncash' | 'paid' | 'cancelled';

export const STATUS_STYLE: Record<ViewStatus, { nhan: string; bg: string; fg: string }> = {
  review: { nhan: 'Cần rà soát', bg: '#fcebe9', fg: '#d6453f' },
  pending: { nhan: 'Chờ duyệt', bg: '#fbf1da', fg: '#c97a10' },
  approved: { nhan: 'Đã duyệt · chờ chi', bg: '#e8f3ec', fg: '#1f7a52' },
  // KHÔNG gọi là "Đã chi": đây là phiếu duyệt xong nhưng ghi vào sổ ảo, tiền
  // chưa hề rời két. Đo thật 21/09: 3 phiếu / 9.515.634đ trên sổ "CỌC (giữ hộ)".
  noncash: { nhan: 'Không ghi quỹ', bg: '#eef2f7', fg: '#41607a' },
  paid: { nhan: 'Đã chi', bg: '#e6f5ec', fg: '#1f9d57' },
  cancelled: { nhan: 'Đã từ chối', bg: '#f0ede6', fg: '#8d8678' },
  unknown: { nhan: 'Không xác định', bg: '#f0ede6', fg: '#8d8678' },
};

export const KIND_LABEL: Record<SettlementKind, string> = {
  refund: 'Hoàn khách',
  commission: 'Hoa hồng',
  bonus: 'Thưởng sale',
};

/** Chữ trên nút cuối dòng, đổi theo trạng thái. */
export const ACTION_LABEL: Record<ViewStatus, string> = {
  review: 'Rà soát',
  pending: 'Duyệt và Chi',
  approved: 'Chi tiền',
  noncash: 'Xem phiếu',
  paid: 'Xem phiếu',
  cancelled: 'Xem lý do',
  unknown: 'Xem phiếu',
};

/** Trạng thái để HIỂN THỊ: tách 'review' ra khỏi 'pending' bằng làn. */
export function viewStatusOf(
  row: Pick<SettlementRow, 'status' | 'issues'>,
): ViewStatus {
  if (row.status === 'pending') {
    return laneOf(row) === 'can-ra-soat' ? 'review' : 'pending';
  }
  return row.status;
}

/**
 * Phiếu có khớp bộ lọc trạng thái không.
 *
 * ⚠ 'noncash' nằm trong nhóm ĐÃ XONG chứ không phải "cần xử lý" — nó không còn
 * việc gì để làm. Nhưng tiền của nó KHÔNG được cộng vào thẻ "Đã chi"; chỗ cộng
 * tiền phải lọc riêng `paid`. Cộng gộp là nói dối về số tiền đã rời két.
 */
export function matchStatus(view: ViewStatus, f: StatusFilter): boolean {
  switch (f) {
    case 'all': return true;
    case 'open': return view === 'review' || view === 'pending' || view === 'approved';
    case 'pendpay': return view === 'pending' || view === 'approved';
    case 'paid': return view === 'paid' || view === 'noncash';
    default: return view === f;
  }
}

export const STATUS_FILTER_LABEL: Record<StatusFilter, string> = {
  open: 'Cần xử lý',
  all: 'Tất cả trạng thái',
  review: 'Cần rà soát',
  pending: 'Chờ duyệt',
  approved: 'Chờ chi',
  pendpay: 'Chờ duyệt và chi',
  noncash: 'Không ghi quỹ',
  paid: 'Đã chi',
  cancelled: 'Từ chối / hủy',
};

/** "13.472.000 đ" */
export const fmtMoney = (n: number) => `${new Intl.NumberFormat('vi-VN').format(Math.round(n))} đ`;

/** "13,47 tr" cho thẻ số lớn; dưới 1 triệu thì in đủ. */
export const fmtCompact = (n: number) =>
  Math.abs(n) >= 1e6
    ? `${new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 2 }).format(n / 1e6)} tr`
    : fmtMoney(n);

/** '2026-09-13' → '13/09/2026'. Chấp nhận cả chuỗi ISO có giờ. */
export const fmtNgay = (s: string | null | undefined) =>
  s ? s.slice(0, 10).split('-').reverse().join('/') : '—';

/** Bỏ dấu + thường hoá, để ô tìm kiếm gõ không dấu vẫn ra. */
export const boDau = (s: unknown) =>
  String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
