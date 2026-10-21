// =============================================================
// Phân trang keyset cho hộp thư /notifications — PHÉP TÍNH THUẦN.
// (21/10/2026, plan realtime + thông báo, mục C9.)
//
// VÌ SAO KHÔNG ĐỔI .limit(200) TRONG VÙNG PARITY
//   Truy vấn danh sách nằm trong vùng hermes-parity w2c-notifications: Hermes chép
//   nguyên bộ lọc đó (public.notifications_inbox_v1, trần 200). Đổi trần ở web là
//   phải đổi cả Hermes. Nên 200 dòng đầu vẫn lấy từ hook parity, còn phần "Xem
//   thêm" là hook RIÊNG ngoài vùng, tải tiếp theo keyset (created_at, id).
//
// VÌ SAO KEYSET MÀ KHÔNG PHẢI OFFSET
//   Hộp thư đổi liên tục (realtime chèn dòng mới lên đầu). Offset 200 sau một lần
//   chèn sẽ lặp lại dòng 200 cũ; keyset theo mốc thời gian thì không.
//
// VÌ SAO TRANG ĐẦU CỦA "XEM THÊM" LẤY `created_at <= mốc` (CÓ CẢ MỐC)
//   Hook parity chỉ sắp theo created_at; các dòng CÙNG created_at (một giao dịch
//   chèn nhiều dòng dùng chung now()) đứng theo thứ tự tuỳ ý. Lấy `< (mốc, id)`
//   sẽ bỏ sót dòng cùng mốc mà id lớn hơn dòng cuối. Lấy cả nhóm cùng mốc rồi
//   khử trùng theo id thì không sót; các trang sau mới dùng keyset chặt.
// =============================================================

/** Số dòng mỗi lượt "Xem thêm". */
export const SO_DONG_MOI_TRANG = 50;
/** Trần của hook parity (khớp `.limit(200)` trong vùng w2c-notifications). */
export const TRAN_DANH_SACH_PARITY = 200;

export interface InboxRowKey {
  id: string;
  created_at: string;
}

/**
 * Mốc tải tiếp. `id = null` ⇒ lấy mọi dòng có created_at <= mốc (trang đầu của
 * "Xem thêm"); có `id` ⇒ keyset chặt (created_at, id) < (mốc, id).
 */
export interface InboxCursor {
  created_at: string;
  id: string | null;
}

/** Giá trị trong cú pháp `or=` của PostgREST: bọc nháy kép vì timestamp có `:` `.` `+`. */
const giaTri = (value: string): string => `"${value.replace(/["\\]/g, "")}"`;

/** Điều kiện keyset cho PostgREST `or(...)`, hoặc null khi đọc từ đầu. */
export function dieuKienKeyset(cursor: InboxCursor | null): string | null {
  if (!cursor) return null;
  const moc = giaTri(cursor.created_at);
  if (cursor.id === null) return `created_at.lte.${moc}`;
  return `created_at.lt.${moc},and(created_at.eq.${moc},id.lt.${giaTri(cursor.id)})`;
}

/**
 * Gộp phạm vi hộp thư (`inboxScope`, là một danh sách OR) với keyset thành MỘT
 * biểu thức `or=` — tránh dựa vào việc PostgREST AND hai tham số `or` trùng tên.
 */
export function boLocHopThu(scope: string, cursor: InboxCursor | null): string {
  const keyset = dieuKienKeyset(cursor);
  return keyset ? `and(or(${scope}),or(${keyset}))` : scope;
}

/** Mốc tải tiếp sau trang vừa nhận; trang hụt ⇒ đã hết. */
export function mocTrangSau(page: readonly InboxRowKey[]): InboxCursor | undefined {
  if (page.length < SO_DONG_MOI_TRANG) return undefined;
  const cuoi = page.at(-1);
  return cuoi ? { created_at: cuoi.created_at, id: cuoi.id } : undefined;
}

/** So hai dòng theo thứ tự hộp thư (mới trước): âm ⇒ a đứng trước b. */
export function soThuTu(a: InboxRowKey, b: InboxRowKey): number {
  const ta = Date.parse(a.created_at);
  const tb = Date.parse(b.created_at);
  if (ta !== tb) return tb - ta;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** Ghép nhiều nguồn, khử trùng theo id (giữ bản xuất hiện trước), sắp mới trước. */
export function gopDongHopThu<T extends InboxRowKey>(...nguon: ReadonlyArray<readonly T[]>): T[] {
  const theoId = new Map<string, T>();
  for (const ds of nguon) for (const row of ds) if (!theoId.has(row.id)) theoId.set(row.id, row);
  return [...theoId.values()].sort(soThuTu);
}

/**
 * Dòng cuối của danh sách parity mới hơn mốc đã chốt ⇒ có dòng vừa rơi khỏi top
 * 200 (vì dòng mới chèn lên đầu) mà trang "Xem thêm" không phủ. Lúc đó phải dời
 * mốc về dòng cuối mới, nếu không sẽ hở một khoảng.
 */
export function canDoiMoc(moc: InboxCursor, duoiParity: InboxRowKey | undefined): boolean {
  if (!duoiParity) return false;
  return Date.parse(duoiParity.created_at) > Date.parse(moc.created_at);
}
