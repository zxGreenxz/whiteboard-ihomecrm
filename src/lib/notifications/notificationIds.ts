// Id thông báo đến từ payload push và từ URL (`?notif=`) — không tin hình dạng.
// (21/10/2026, plan realtime + thông báo, mục C4.)

/** Trần số id một lần đánh dấu: payload push mang tối đa 20 id (gói B12), chừa biên. */
export const TRAN_ID_DANH_DAU = 50;

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const laUuid = (value: unknown): value is string => typeof value === "string" && UUID_RE.test(value);

/** Lọc id hợp lệ, khử trùng (không phân biệt hoa thường), cắt trần. */
export function chuanHoaIdThongBao(ids: readonly unknown[]): string[] {
  const out = new Set<string>();
  for (const id of ids) {
    if (out.size >= TRAN_ID_DANH_DAU) break;
    if (laUuid(id)) out.add(id.toLowerCase());
  }
  return [...out];
}
