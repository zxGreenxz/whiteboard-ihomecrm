// =============================================
// Thu trùng — nhận ra một khoản thu có vẻ LẶP LẠI trước khi ghi (đợt 1 sửa
// phiếu, chủ chốt 25/09/2026: "cảnh báo khi thu lặp cùng số tiền trong 30 phút").
//
// Đo 24/09/2026: 6/17 lần "huỷ rồi thu lại" là thu trùng — cùng hoá đơn, cùng
// số tiền, cách nhau vài phút (hai người cùng thu một phòng, hoặc bấm lại khi
// mạng chậm). Đây là CẢNH BÁO để người thu tự quyết, không phải hàng rào: người
// thu xác nhận "vẫn thu" thì khoản thứ hai vẫn được ghi.
//
// Thuần: không fetch, không đọc đồng hồ ngầm (nhận `now` từ ngoài) → test được.
// =============================================

/** Cửa sổ coi là "vừa thu": 30 phút. */
export const DUPLICATE_COLLECTION_WINDOW_MS = 30 * 60 * 1000;

/** Một lần thu của hoá đơn (dòng `invoice_payment_collections`), đủ để so trùng. */
export interface CollectionForDuplicateCheck {
  id: string;
  /** Chỉ `ACTIVE` là còn hiệu lực; `REVERSED` (đã hoàn tác) không tính. */
  status: string;
  /** Tổng tiền khách đưa của lần thu (cộng mọi dòng TM/TK/TT). */
  gross_amount: number;
  /** Thời điểm ghi (timestamptz dạng ISO). */
  created_at: string;
  /** Tên người đã thu, nếu đọc được. */
  collector_name?: string | null;
}

const soNguyen = (n: number): number => Math.round(Number(n) || 0);

const thoiDiem = (iso: string): number | null => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};

/**
 * Lần thu CÒN HIỆU LỰC gần nhất có CÙNG tổng tiền với lần sắp thu và nằm trong
 * cửa sổ 30 phút quanh `now`. `null` nếu không có.
 *
 * - So theo đồng (làm tròn), vì tiền trong hệ thống là số nguyên đồng.
 * - Lệch đồng hồ giữa máy người dùng và máy chủ được tính cả hai chiều: một lần
 *   thu "ở tương lai" vài phút vẫn là lần thu vừa xảy ra.
 * - Số tiền ≤ 0 thì không có gì để so.
 */
export function findRecentDuplicateCollection<T extends CollectionForDuplicateCheck>(
  collections: readonly T[],
  amount: number,
  now: Date | number = Date.now(),
  windowMs: number = DUPLICATE_COLLECTION_WINDOW_MS,
): T | null {
  const target = soNguyen(amount);
  if (target <= 0) return null;
  const nowMs = typeof now === 'number' ? now : now.getTime();

  let best: T | null = null;
  let bestAt = -Infinity;
  for (const c of collections) {
    if (c.status !== 'ACTIVE') continue;
    if (soNguyen(c.gross_amount) !== target) continue;
    const at = thoiDiem(c.created_at);
    if (at === null || Math.abs(nowMs - at) > windowMs) continue;
    if (at > bestAt) {
      best = c;
      bestAt = at;
    }
  }
  return best;
}

const haiSo = (n: number) => String(n).padStart(2, '0');

/** "HH:mm" theo giờ máy người dùng. */
export function collectionClock(iso: string): string {
  const t = thoiDiem(iso);
  if (t === null) return '—';
  const d = new Date(t);
  return `${haiSo(d.getHours())}:${haiSo(d.getMinutes())}`;
}

/** Câu hỏi xác nhận: "Hoá đơn này vừa được thu X đ lúc HH:mm bởi Y. Vẫn thu tiếp?" */
export function duplicateCollectionQuestion(dup: CollectionForDuplicateCheck): string {
  const tien = soNguyen(dup.gross_amount).toLocaleString('vi-VN');
  const ai = dup.collector_name?.trim() || 'một người khác';
  return `Hoá đơn này vừa được thu ${tien} đ lúc ${collectionClock(dup.created_at)} bởi ${ai}. Vẫn thu tiếp?`;
}
