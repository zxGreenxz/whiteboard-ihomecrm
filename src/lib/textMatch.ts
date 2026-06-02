// Helper so khớp text dùng chung cho các parser "nhập nhanh" (công việc, thu chi).
// Tách ra đây để jobQuickInput.ts và incomeExpenseQuickInput.ts dùng chung,
// tránh lặp logic chuẩn hoá tiếng Việt.

export type BuildingRef = {
  id: string;
  name: string | null;
  code: string | null;
};

export type RoomRef = {
  id: string;
  name: string | null;
  code: string | null;
  building_id: string | null;
};

// Token ở vị trí "phòng" báo hiệu việc/phiếu cho cả tòa nhà (không phòng cụ thể).
export const BUILDING_WIDE_TOKENS = ["tn", "tòa", "toa", "toanha", "toànhà"];

/** So khớp không phân biệt hoa/thường (giữ nguyên dấu). */
export function eqInsensitive(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (!a || !b) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Chuẩn hoá lỏng: bỏ dấu tiếng Việt + đ→d + lowercase. */
export function normalizeLoose(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d");
}

/** So khớp lỏng: bỏ qua dấu + hoa/thường. */
export function eqLoose(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (!a || !b) return false;
  return normalizeLoose(a) === normalizeLoose(b);
}

/** Tách mã có nhiều alias ngăn cách bởi dấu phẩy. */
export function splitAliases(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
