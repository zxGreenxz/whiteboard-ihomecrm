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

import type { SettlementKind, SettlementKindSignal } from '@/lib/settlementTypes';

export type { SettlementKind, SettlementKindSignal };

/**
 * Loại của MỘT DÒNG trên bảng. Khác `SettlementKind` đúng một giá trị:
 * 'unknown' = resolver chưa xác định được loại (xem `resolveSettlementKind`).
 *
 * ⚠ Bản trước không có giá trị này nên read model phải mặc định 'refund' —
 * đó chính là lỗi xếp nhầm nhóm của phiếu HHMG thủ công. Đoán loại còn tệ hơn
 * nói "chưa xác định": người duyệt sẽ đi đối chiếu nhầm căn cứ.
 */
export type SettlementRowKind = SettlementKind | 'unknown';

/** Dấu nhận diện trong ghi chú bổ sung. Đặt ở ĐẦU nội dung, không đặt giữa. */
export const DAU_CAN_BO_SUNG = '[CẦN BỔ SUNG]';
export const DAU_DA_BO_SUNG = '[ĐÃ BỔ SUNG]';

/**
 * 'pending'   — UNAPPROVED (chờ duyệt). Chỉ trạng thái này mới có làn.
 * 'approved'  — APPROVED + chưa ghi sổ (chờ chi).
 * 'reversed'  — APPROVED + REVERSED: đã ghi sổ rồi bút toán bị ĐẢO.
 *               ⚠ Bản trước gộp vào 'approved', và hệ quả nhìn thấy được là
 *               modal hiện nút "Ghi nhận chi" cho một phiếu đã từng chi — tức
 *               MỜI CHI LẦN HAI chỉ vì mapping hiển thị xếp nhầm chỗ. Hoàn tác
 *               không phải "chưa từng chi", cũng không phải "còn phải chi";
 *               muốn chi lại thì làm bên Thu chi, không phải ở lớp mặt này.
 * 'noncash'   — APPROVED + NOT_APPLICABLE: đã duyệt nhưng KHÔNG ghi quỹ (sổ ảo).
 *               KHÔNG phải "đã chi tiền cho khách". Đo thật: 3 phiếu, 9.515.634đ
 *               trên sổ ảo "CỌC (giữ hộ khách)", không có dòng posting nào.
 * 'paid'      — APPROVED + POSTED
 * 'cancelled' — đã huỷ
 * 'unknown'   — tổ hợp lạ. KHÔNG được coi là pending thao tác được.
 */
export type SettlementStatus =
  | 'pending' | 'approved' | 'reversed' | 'noncash' | 'paid' | 'cancelled' | 'unknown';

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
  // Cảnh báo: các dấu phân loại chỏi nhau, hoặc không dấu nào xác định được
  // loại. CỐ Ý KHÔNG phải blocker: phân loại là việc HIỂN THỊ của khu này, còn
  // phiếu thì vẫn là phiếu hợp lệ bên Thu chi. Biến nó thành blocker là dựng
  // lại đúng vòng kẹt mô tả ở đầu file — người duyệt không có cách nào "sửa
  // phân loại" ngoài việc sửa hạng mục bên Thu chi.
  | 'CLASSIFICATION_REVIEW'
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
/**
 * Lý do căn cứ của phiếu HOÀN ở mức DANH SÁCH.
 *
 * `preview_termination_refund_v1` đắt nên danh sách HOÃN việc tra tới lúc mở
 * phiếu — ở đó câu này đúng và còn giữ được lời hứa.
 *
 * ⚠ Có TÊN vì MODAL phải nhận ra đúng câu này để KHÔNG in lại một lời hứa mà
 * chính nó đang thực hiện dở: trong hộp thoại đã mở, "tra khi mở phiếu" là câu
 * không bao giờ thành sự thật. So bằng hằng số chứ đừng dò chuỗi — đổi lý do ở
 * `basisOf` thì câu mới phải hiện nguyên văn, không bị nuốt.
 * Xem `SettlementVoucherDetails`.
 */
export const CAN_CU_HOAN_TRA_KHI_MO_PHIEU = 'Căn cứ hoàn khách tra khi mở phiếu';

export type BasisState =
  | { kind: 'matched'; amount: number }
  | { kind: 'mismatch'; amount: number }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'not-found'; reason: string }
  | { kind: 'not-applicable' };

export interface SettlementRow {
  /** Ổn định qua refetch: `${kind}:${voucherId}`. Mọi dòng đều có phiếu. */
  key: string;
  kind: SettlementRowKind;
  /**
   * Dấu hiệu nào đã quyết định `kind` — để modal giải thích được vì sao phiếu
   * nằm ở nhóm này. Chỉ để HIỂN THỊ, không bao giờ ghi ngược vào phiếu thật.
   */
  kindSource: SettlementKindSignal;
  /** Các dấu phân loại chỏi nhau ⇒ cần người đối chiếu. Không chặn duyệt. */
  kindConflict: boolean;
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
  /**
   * `income_expenses.notes` — GHI CHÚ GỐC người tạo phiếu đã gõ, NGUYÊN VĂN
   * (giữ xuống dòng). Đây là thứ modal phải hiện dưới nhãn "Ghi chú gốc của
   * phiếu"; KHÔNG được thay bằng lịch sử bổ sung, cũng không được phân tích
   * chuỗi này để bịa ra khoản tiền — số liệu đã có nguồn cấu trúc riêng.
   */
  notes: string | null;
  /**
   * Hai dấu nguồn THÔ, giữ nguyên như DB. Có mặt ở đây vì các renderer dùng
   * chung của Thu chi (`VoucherNote` → `TerminationRefundNote` /
   * `CommissionVoucherNote`) nhận diện phiếu bằng đúng hai cột này.
   *
   * ⚠ `kind`/`kindSource` là kết quả SUY RA và KHÔNG thay thế được chúng: phiếu
   * HHMG tạo tay có `kind === 'commission'` nhưng `commissionKind === null`, và
   * điền một giá trị broker/sale vào đây để ép RPC ghi chú tự sinh chạy chính là
   * điều plan §3.2 cấm. Hai trường này chỉ chép, không bao giờ đoán.
   */
  systemSource: string | null;
  commissionKind: string | null;
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
  /**
   * NGÀY CHI NGHIỆP VỤ = `posted_on` của bút toán hiệu lực
   * (`income_expenses.active_posting_id_v2` → `income_expense_postings`).
   *
   * ⚠ KHÔNG PHẢI `posted_at_v2`. Cột đó là dấu thời gian HỆ THỐNG GHI, và trên
   * dữ liệu thật nó không thay thế được: đo 22/09/2026 trên 1000 phiếu chi đã
   * ghi sổ có bút toán hiệu lực, 856 phiếu `posted_at_v2` NULL, và 20 trong 144
   * phiếu còn lại LỆCH với `posted_on` — một phiếu lệch tới hai tháng.
   *
   * `null` = CHƯA XÁC MINH ĐƯỢC, không phải "chưa chi". Đa số người dùng không
   * đọc nổi bảng bút toán (policy đòi binding CUSTODIAN đúng sổ): đo thật, tài
   * khoản chủ công ty thấy 1139 phiếu đã ghi sổ và 0 dòng posting. Gặp null thì
   * ghi "ngày chi chưa xác minh" và để stat liên quan báo "Chưa đủ dữ liệu" —
   * KHÔNG hạ phiếu xuống chờ chi, KHÔNG báo 0, KHÔNG đi tìm đường quyền cao hơn.
   */
  postedOn: string | null;
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
  new Set(['paid', 'cancelled', 'noncash', 'reversed', 'unknown']);

export function settlementStatusOf(
  approval: string | null | undefined,
  posting: string | null | undefined,
): SettlementStatus {
  if (approval === 'CANCELLED') return 'cancelled';
  if (approval === 'UNAPPROVED') return 'pending';
  if (approval === 'APPROVED') {
    if (posting === 'POSTED') return 'paid';
    if (posting === 'NOT_APPLICABLE') return 'noncash';
    // Bút toán bị ĐẢO có trạng thái riêng — xem chú thích của 'reversed'.
    if (posting === 'REVERSED') return 'reversed';
    // UNPOSTED và null là "đã duyệt, chưa ghi sổ".
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
    case 'CLASSIFICATION_REVIEW':
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

  // ĐẶT TRƯỚC căn cứ: bảng chỉ hiện `issues[0]`, mà khi chưa biết loại thì
  // "Chưa có căn cứ" là hệ quả chứ không phải nguyên nhân — nói nguyên nhân
  // trước thì người xem biết phải làm gì (mở phiếu bên Thu chi xem hạng mục).
  if (row.kindConflict || row.kind === 'unknown') out.push('CLASSIFICATION_REVIEW');

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
  | 'review' | 'pending' | 'approved' | 'reversed'
  | 'noncash' | 'paid' | 'cancelled' | 'unknown';

/** Bộ lọc trạng thái trên thanh công cụ. 'pendpay' chỉ dùng khi bật gộp. */
export type StatusFilter =
  | 'open' | 'all' | 'review' | 'pending' | 'approved' | 'pendpay'
  | 'noncash' | 'paid' | 'cancelled' | 'reversed' | 'unknown';

export const STATUS_STYLE: Record<ViewStatus, { nhan: string; bg: string; fg: string }> = {
  review: { nhan: 'Cần rà soát', bg: '#fcebe9', fg: '#d6453f' },
  pending: { nhan: 'Chờ duyệt', bg: '#fbf1da', fg: '#c97a10' },
  approved: { nhan: 'Đã duyệt · chờ chi', bg: '#e8f3ec', fg: '#1f7a52' },
  // Đã ghi sổ rồi bị đảo. KHÔNG phải "chưa từng chi" — xem 'reversed' ở trên.
  reversed: { nhan: 'Đã hoàn tác', bg: '#f3ecf7', fg: '#6b4a86' },
  // KHÔNG gọi là "Đã chi": đây là phiếu duyệt xong nhưng ghi vào sổ ảo, tiền
  // chưa hề rời két. Đo thật 21/09: 3 phiếu / 9.515.634đ trên sổ "CỌC (giữ hộ)".
  noncash: { nhan: 'Không ghi quỹ', bg: '#eef2f7', fg: '#41607a' },
  paid: { nhan: 'Đã chi', bg: '#e6f5ec', fg: '#1f9d57' },
  cancelled: { nhan: 'Đã từ chối', bg: '#f0ede6', fg: '#8d8678' },
  unknown: { nhan: 'Không xác định', bg: '#f0ede6', fg: '#8d8678' },
};

export const KIND_LABEL: Record<SettlementRowKind, string> = {
  refund: 'Hoàn khách',
  commission: 'Hoa hồng',
  bonus: 'Thưởng sale',
  // KHÔNG được thay bằng một trong ba nhãn trên. Đây là lời thú nhận "chưa
  // biết", và nó phải nhìn thấy được thì người ta mới đi xem lại hạng mục.
  unknown: 'Chưa xác định loại',
};

/** Chữ trên nút cuối dòng, đổi theo trạng thái. */
export const ACTION_LABEL: Record<ViewStatus, string> = {
  review: 'Rà soát',
  pending: 'Duyệt và Chi',
  approved: 'Chi tiền',
  // ⚠ KHÔNG phải 'Chi tiền'. Phiếu hoàn tác đã từng ghi sổ; mời chi tiếp ở đây
  // là dựng lại đúng cái bẫy mà bản trước tạo ra khi gộp REVERSED vào 'approved'.
  reversed: 'Xem phiếu',
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
 * Ba làn CÒN VIỆC PHẢI LÀM. Mọi thứ ngoài tập này là lịch sử: đã chi, không ghi
 * quỹ, hủy, hoàn tác, không xác định. Dùng chung cho bộ lọc "Cần xử lý", cho
 * định nghĩa Tồn Cũ và cho nhãn tồn — ba chỗ đó lệch nhau là bảng nói một đằng,
 * thẻ nói một nẻo.
 */
export const VIEC_CHUA_XONG: ReadonlySet<ViewStatus> =
  new Set<ViewStatus>(['review', 'pending', 'approved']);

/**
 * Phiếu có khớp bộ lọc trạng thái không.
 *
 * ⚠ 'noncash' KHÔNG nằm trong 'paid'. Bản trước cho nó lọt vào đây trong khi
 * THẺ SỐ chỉ cộng 'paid' — nên thẻ hiện 0đ/0 phiếu ngay trên một cái bảng đang
 * có ba dòng. Không ghi quỹ là bộ lọc RIÊNG và stat RIÊNG; gộp vào là nói dối
 * về số tiền đã rời két.
 */
export function matchStatus(view: ViewStatus, f: StatusFilter): boolean {
  switch (f) {
    case 'all': return true;
    case 'open': return VIEC_CHUA_XONG.has(view);
    case 'pendpay': return view === 'pending' || view === 'approved';
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
  reversed: 'Đã hoàn tác',
  // Có mặt để KHÔNG GIẤU phiếu nào: tổ hợp trạng thái lạ vẫn phải soi được.
  unknown: 'Không xác định',
};

// ═══════════════════════════════════════════════════════════════════════════
// BA PHẠM VI KỲ — plan §3.4, chủ chốt ngày 22/09/2026
//
// Phạm vi là ENUM, KHÔNG có bản sao chuỗi tháng nào trong state. Kỳ tham chiếu
// duy nhất là `period` của trang. Nhờ vậy đổi kỳ chung hay bấm "Bỏ lọc" không
// thể để lại một tháng cũ nằm khuất đâu đó rồi sinh ra bảng rỗng khó hiểu.
//
// ⚠ `Kỳ hiện tại + Tồn Cũ ≠ Tất Cả`. Tất Cả còn chứa lịch sử ĐÃ HOÀN THÀNH
// (đã chi, không ghi quỹ, hủy, hoàn tác) mà hai phạm vi kia cố ý không chứa.
// Đừng hiện thực Tất Cả bằng cách hợp hai tập kia.
// ═══════════════════════════════════════════════════════════════════════════

export type PeriodScope = 'current' | 'prior' | 'all';

export interface PeriodFilterState {
  scope: PeriodScope;
  status: StatusFilter;
}

/** Bộ lọc trạng thái này có phải "việc chưa xong" không. */
const LOC_VIEC_CHUA_XONG: ReadonlySet<StatusFilter> =
  new Set<StatusFilter>(['open', 'review', 'pending', 'approved', 'pendpay']);

/**
 * Phạm vi kỳ được phép chọn cho một bộ lọc trạng thái.
 *
 * Việc chưa xong có đủ ba. Trạng thái LỊCH SỬ (đã chi, không ghi quỹ, hủy, hoàn
 * tác, không xác định) chỉ có hai — "Tồn Cũ" theo định nghĩa là việc còn phải
 * làm, nên ghép nó với một trạng thái đã xong luôn ra bảng rỗng.
 *
 * 'all' (Tất cả trạng thái) vẫn mở Tồn Cũ; chọn xong thì `normalisePeriodFilter`
 * kéo trạng thái về "Cần xử lý" cho đúng nghĩa.
 */
export function periodScopeOptions(f: StatusFilter): PeriodScope[] {
  return f === 'all' || LOC_VIEC_CHUA_XONG.has(f)
    ? ['current', 'prior', 'all']
    : ['current', 'all'];
}

/** "Kỳ hiện tại (09/2026)" · "Tồn Cũ" · "Tất Cả". */
export function periodScopeLabel(scope: PeriodScope, period: string): string {
  if (scope === 'prior') return 'Tồn Cũ';
  if (scope === 'all') return 'Tất Cả';
  const [y, m] = period.split('-');
  return `Kỳ hiện tại (${m}/${y})`;
}

/**
 * MỘT normalizer duy nhất cho thẻ số, dropdown trạng thái, dropdown kỳ và chip.
 *
 * Nếu mỗi chỗ tự chữa theo cách riêng thì sẽ có chỗ quên, và chỗ quên đó để lại
 * `scope: 'prior'` nằm ẩn sau một trạng thái lịch sử — người dùng thấy bảng rỗng
 * mà không có gì trên màn hình giải thích tại sao. Thuần và BẤT ĐỘNG (chạy hai
 * lần bằng chạy một lần).
 */
export function normalisePeriodFilter(s: PeriodFilterState): PeriodFilterState {
  if (s.scope !== 'prior') return s;
  // Tồn Cũ + "Tất cả trạng thái" ⇒ về Cần xử lý, giữ phạm vi.
  if (s.status === 'all') return { scope: 'prior', status: 'open' };
  // Tồn Cũ + một trạng thái đã xong ⇒ về Kỳ hiện tại, giữ trạng thái.
  if (!LOC_VIEC_CHUA_XONG.has(s.status)) return { scope: 'current', status: s.status };
  return s;
}

/** Trục ngày dùng để xét kỳ. Chỉ "Đã chi" đi theo ngày ghi sổ. */
export type PeriodAxis = 'voucher' | 'posted';

export function periodAxisOf(view: ViewStatus): PeriodAxis {
  return view === 'paid' ? 'posted' : 'voucher';
}

/**
 * Ngày quyết định kỳ của một dòng. `null` = chưa xác định được.
 *
 * ⚠ Không ghi quỹ / hủy / hoàn tác / không xác định đi theo NGÀY PHIẾU và không
 * mang nhãn ngày chi — kể cả khi tình cờ có `postedOn`.
 */
export function periodDateOf(
  row: Pick<SettlementRow, 'eventDate' | 'postedOn'>,
  view: ViewStatus,
): string | null {
  return periodAxisOf(view) === 'posted' ? row.postedOn : row.eventDate;
}

/**
 * 'in'           — thuộc phạm vi đang xem.
 * 'out'          — chắc chắn không thuộc.
 * 'undetermined' — THIẾU NGUỒN để xếp kỳ (ngày null, hoặc đã chi mà không đọc
 *                  được bút toán). Tách hẳn khỏi 'out': dòng này không được
 *                  âm thầm biến mất, phải đếm được để báo lên giao diện.
 */
export type ScopeMatch = 'in' | 'out' | 'undetermined';

export function matchScope(
  row: Pick<SettlementRow, 'eventDate' | 'postedOn' | 'status' | 'issues'>,
  scope: PeriodScope,
  period: string,
): ScopeMatch {
  // Tất Cả: không giới hạn ngày và KHÔNG loại ngầm trạng thái nào.
  if (scope === 'all') return 'in';

  const view = viewStatusOf(row);

  if (scope === 'prior') {
    // Tồn Cũ = việc CÒN PHẢI LÀM của kỳ trước. Phiếu đã xong không phải tồn.
    if (!VIEC_CHUA_XONG.has(view)) return 'out';
    const d = row.eventDate;
    if (!d) return 'undetermined';
    return d.slice(0, 7) < period ? 'in' : 'out';
  }

  const d = periodDateOf(row, view);
  // Ngày null / không đủ nguồn KHÔNG được suy thành kỳ cũ hay ngoài kỳ.
  if (!d) return 'undetermined';
  return d.slice(0, 7) === period ? 'in' : 'out';
}

/**
 * Có đáng gắn nhãn "Tồn kỳ trước" không. Chỉ việc CHƯA XONG mới được gắn —
 * dán nhãn tồn lên một phiếu đã chi là biến lịch sử thành việc phải làm.
 */
export function isOldPeriodWork(
  row: Pick<SettlementRow, 'eventDate' | 'postedOn' | 'status' | 'issues'>,
  period: string,
): boolean {
  return matchScope(row, 'prior', period) === 'in';
}

export interface GroupTotal { count: number; total: number }

/** Đếm và cộng đúng tập dòng của MỘT nhóm trạng thái hiển thị. */
export function groupTotal(rows: SettlementRow[], views: ViewStatus[]): GroupTotal {
  const chon = new Set(views);
  let count = 0;
  let total = 0;
  for (const r of rows) {
    if (!chon.has(viewStatusOf(r))) continue;
    count += 1;
    total += r.amount;
  }
  return { count, total };
}

/**
 * Giá trị của MỘT thẻ số.
 *
 * 'number'      — số thật, đối chiếu được.
 * 'unverified'  — số đếm/tổng đúng nhưng CHƯA ĐỐI CHIẾU được bút toán.
 * 'insufficient'— không tính nổi vì thiếu ngày ghi sổ ⇒ "Chưa đủ dữ liệu".
 * 'na'          — thẻ lịch sử trên phạm vi Tồn Cũ ⇒ "Không áp dụng cho tồn cũ".
 *
 * ⚠ KHÔNG BAO GIỜ trả 0đ thay cho ba ca dưới. Số 0 đọc như "không có đồng nào",
 * còn sự thật là "không biết" — hai câu khác hẳn nhau khi nói về tiền.
 */
export type StatValue =
  | { kind: 'number'; count: number; total: number }
  /**
   * `count`/`total` chỉ tính phần CHỨNG MINH ĐƯỢC. `unverifiedCount` là SỐ ĐẾM
   * phiếu chưa chứng minh được — **không kèm tiền, và không bao giờ được cộng
   * vào `total`**.
   *
   * ⚠ Bản trước gộp cả hai rồi treo một chữ "(chưa xác minh)" lên tổng. Hai hệ
   * quả, cái nào cũng tệ:
   *   A. Tài khoản chủ công ty (đo thật: 1139 phiếu POSTED, 0 dòng bút toán)
   *      thấy mệnh giá của cả 1139 phiếu hiện dưới nhãn tiền đã rời két, trong
   *      khi không một đồng nào chứng minh được.
   *   B. 499/500 phiếu đọc được ngày, một phiếu không ⇒ cả 500 sập vào một con
   *      số dưới một cái nhãn, mất luôn 499 phiếu lẽ ra đối chiếu được.
   */
  | { kind: 'unverified'; count: number; total: number; unverifiedCount: number }
  | { kind: 'insufficient' }
  | { kind: 'na' };

/**
 * Trạng thái đọc bảng bút toán — CÙNG TỪ VỰNG BA NGẢ với `ReadState` của T2
 * (`src/lib/contractLifecycle.ts`): `true` đủ, `'partial'` đọc được nhưng THIẾU
 * dòng, `false` lỗi. Đừng đẻ thêm từ vựng thứ hai cho cùng một khái niệm.
 *
 * Khai ở lớp thuần này (không ở hook) vì giao diện phải GIẢI THÍCH được trạng
 * thái đó bằng chữ, và chữ thì thuộc về hàm thuần kiểm được.
 */
export type PostingReadState = true | 'partial' | false;

/**
 * Vì sao một phiếu đã chi lại không có ngày chi — ba nguyên nhân KHÁC HẲN nhau,
 * và người dùng làm việc khác nhau với từng cái:
 *
 *  `false`     lỗi tải     → thử lại là có thể ra.
 *  `'partial'` RLS giấu    → thử lại bao nhiêu cũng vậy; phải có binding
 *                            CUSTODIAN trên đúng sổ quỹ mới đọc nổi.
 *  `true`      đọc đủ rồi  → phiếu THẬT SỰ không có bút toán hiệu lực (dải dữ
 *                            liệu legacy). Đây là thiếu bằng chứng, KHÔNG phải
 *                            yêu cầu backfill posting.
 *
 * Gộp ba câu này làm một là lấy mất của người dùng cách duy nhất để biết nên
 * bấm thử lại, đi xin quyền, hay thôi không chờ nữa.
 */
export function lyDoChuaXacMinhNgayChi(read: PostingReadState): string {
  if (read === false) return 'lỗi tải bút toán';
  if (read === 'partial') return 'cần quyền giữ sổ quỹ để đọc bút toán';
  return 'phiếu không có bút toán hiệu lực';
}

export function statValue(args: {
  /**
   * Tập nền sau quyền/org/tòa/tìm kiếm/nguồn/loại, **CHƯA cắt theo kỳ và CHƯA
   * cắt theo trạng thái**.
   *
   * ⚠ Hàm này TỰ cắt kỳ, và đó là điều kiện để nó trung thực: một phiếu đã chi
   * mà không đọc được ngày ghi sổ sẽ bị phép cắt kỳ loại ra, nên nếu caller cắt
   * trước rồi mới đưa vào thì ở đây chỉ còn một tập "sạch" và thẻ lại in ra 0đ —
   * đúng cái nói dối đang phải sửa.
   */
  rows: SettlementRow[];
  views: ViewStatus[];
  scope: PeriodScope;
  period: string;
  /** Thẻ này có cần `posted_on` mới nói được điều nó định nói không. */
  needsPosting: boolean;
}): StatValue {
  const { rows, views, scope, period, needsPosting } = args;
  const lichSu = views.every((v) => !VIEC_CHUA_XONG.has(v));
  if (scope === 'prior' && lichSu) return { kind: 'na' };

  const chon = new Set(views);
  const cua = rows.filter((r) => chon.has(viewStatusOf(r)));
  const trongKy = cua.filter((r) => matchScope(r, scope, period) === 'in');

  if (needsPosting && cua.some((r) => r.postedOn === null)) {
    // Tất Cả: kỳ không còn quan trọng, nên phần ĐỌC ĐƯỢC ngày ghi sổ là một con
    // số thật và phải được giữ nguyên giá trị của nó. Phần còn lại KHÔNG được
    // cộng vào tiền — nó đi ra ngoài dưới dạng SỐ ĐẾM.
    if (scope === 'all') {
      const chungMinhDuoc = cua.filter((r) => r.postedOn !== null);
      return {
        kind: 'unverified',
        count: chungMinhDuoc.length,
        total: chungMinhDuoc.reduce((s, r) => s + r.amount, 0),
        unverifiedCount: cua.length - chungMinhDuoc.length,
      };
    }
    // Lọc kỳ: không có ngày thì không biết phiếu có thuộc kỳ này không ⇒ con số
    // sẽ THIẾU, mà số thiếu về tiền thì không được phép in ra.
    return { kind: 'insufficient' };
  }
  return {
    kind: 'number',
    count: trongKy.length,
    total: trongKy.reduce((s, r) => s + r.amount, 0),
  };
}

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
