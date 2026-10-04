// Tra hạng mục thu chi theo danh mục chi chuẩn (chủ duyệt 03/10/2026) — phần logic thuần
// cho ô chọn, nhập Excel và công cụ phí bảo trì. Luật lọc ô chọn nằm ở ieTypeCatalog.ts;
// file này chỉ thêm tìm theo cụm từ, gom nhóm hiển thị và cách giải tên ⇒ hạng mục.
import { ieTypeGroupLabel, type IeTypeCatalogFields } from "@/lib/ieTypeCatalog";
import { normalizeLoose } from "@/lib/textMatch";

/** Ô tìm: khớp tên hoặc một cụm từ hay nói (keywords), bỏ dấu, không phân biệt hoa thường. */
export function ieTypeMatchesQuery(
  t: Pick<IeTypeCatalogFields, "name" | "keywords">,
  query: string,
): boolean {
  const q = normalizeLoose(query);
  if (!q) return true;
  if (normalizeLoose(t.name).includes(q)) return true;
  return (t.keywords ?? []).some((k) => normalizeLoose(k).includes(q));
}

export interface IeTypePickerGroup<T> {
  label: string;
  items: T[];
}

/**
 * Gom danh sách ĐÃ XẾP (sortIeTypesForPicker) thành nhóm theo ieTypeGroupLabel.
 * Nhóm hiện theo thứ tự mục đầu tiên của nhóm; trong nhóm giữ nguyên thứ tự đã xếp.
 * "Khác" (mục chưa có nhóm) luôn xuống cuối.
 */
export function groupIeTypesForPicker<T extends Pick<IeTypeCatalogFields, "category">>(
  rows: readonly T[],
): IeTypePickerGroup<T>[] {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const label = ieTypeGroupLabel(row);
    const items = groups.get(label);
    if (items) items.push(row);
    else groups.set(label, [row]);
  }
  const out = Array.from(groups, ([label, items]) => ({ label, items }));
  const other = out.findIndex((g) => g.label === "Khác");
  if (other >= 0 && other < out.length - 1) out.push(...out.splice(other, 1));
  return out;
}

type IeTypeWithDirection = IeTypeCatalogFields & { type: "income" | "expense" };

// Cả hai nhánh khai đủ hai khoá: tsconfig.app (strict: false) không thu hẹp union theo `ok`.
export type ImportIeTypeResolution<T> =
  | { ok: true; type: T; message?: undefined }
  | { ok: false; type?: undefined; message: string };

export const IMPORT_SYSTEM_ONLY_MESSAGE = "Hạng mục hệ thống không nhập từ Excel";

/**
 * Nhập Excel: giải tên hạng mục (so chữ thường như trước) ⇒ hạng mục dùng cho phiếu MỚI.
 * - Trùng tên giữa mục đang dùng và mục đã lưu trữ ⇒ lấy mục đang dùng.
 * - Mục đã lưu trữ có merged_into_id ⇒ dùng mục đích (tra trong cùng danh sách).
 * - Mục đã lưu trữ không có đích gộp dùng được ⇒ báo lỗi dòng, không tự đoán.
 * - Hạng mục CHI system_only (hoa hồng, thưởng sale, cọc, thanh lý) ⇒ lỗi dòng: máy chủ
 *   từ chối lập tay (ie_system_only_manual_blocked), báo sớm từng dòng thay vì hỏng cả lô.
 */
export function resolveImportIeType<T extends IeTypeWithDirection>(
  rows: readonly T[],
  itemName: string,
  matchType: "income" | "expense",
): ImportIeTypeResolution<T> {
  const key = itemName.trim().toLowerCase();
  const candidates = rows.filter(
    (t) => t.type === matchType && t.name.trim().toLowerCase() === key,
  );
  const hit = candidates.find((t) => !t.archived_at) ?? candidates[0];
  if (!hit) {
    return { ok: false, message: `Không tìm thấy hạng mục "${itemName}" (loại ${matchType})` };
  }
  let target: T = hit;
  if (hit.archived_at) {
    const merged = hit.merged_into_id
      ? rows.find((t) => t.id === hit.merged_into_id)
      : undefined;
    if (!merged || merged.archived_at || merged.type !== matchType) {
      return {
        ok: false,
        message: `Hạng mục "${hit.name}" đã lưu trữ — đổi sang hạng mục đang dùng`,
      };
    }
    target = merged;
  }
  if (target.system_only && target.type === "expense") {
    return { ok: false, message: `${IMPORT_SYSTEM_ONLY_MESSAGE} ("${target.name}")` };
  }
  return { ok: true, type: target };
}

/** Chuẩn hoá tên để so khớp bảo trì: bỏ dấu, chữ thường, gộp khoảng trắng. */
const maintenanceKey = (s: string | null | undefined): string =>
  normalizeLoose(s).replace(/\s+/g, " ");

export const MAINTENANCE_IE_TYPES = {
  ml: {
    label: "Bảo trì máy lạnh",
    exact: ["ve sinh may lanh", "bao tri may lanh"],
    match: "may lanh",
    expected: "Vệ sinh máy lạnh",
  },
  mg: {
    label: "Bảo trì máy giặt",
    exact: ["ve sinh may giat", "bao tri may giat"],
    match: "may giat",
    expected: "Vệ sinh máy giặt",
  },
} as const;

export type MaintenanceSubtype = keyof typeof MAINTENANCE_IE_TYPES;

/**
 * Công cụ phí bảo trì /thanh-toan: chọn hạng mục chi có sẵn, KHÔNG tạo mới.
 * Thứ tự: đúng tên "vệ sinh máy lạnh/giặt" (danh mục chuẩn giữ tên, chỉ ẩn khỏi ô chọn tay)
 * ⇒ đúng tên "bảo trì máy lạnh/giặt" (tên công cụ này từng tự tạo) ⇒ tên chứa "máy lạnh/giặt".
 * Mục đã lưu trữ không bao giờ được chọn (đã gộp vào mục khác hoặc thôi dùng).
 */
export function pickMaintenanceIeType<T extends Pick<IeTypeCatalogFields, "id" | "name" | "archived_at">>(
  rows: readonly T[],
  sub: MaintenanceSubtype,
): T | null {
  const meta = MAINTENANCE_IE_TYPES[sub];
  const active = rows.filter((t) => !t.archived_at);
  for (const name of meta.exact) {
    const hit = active.find((t) => maintenanceKey(t.name) === name);
    if (hit) return hit;
  }
  return active.find((t) => maintenanceKey(t.name).includes(meta.match)) ?? null;
}

export function maintenanceIeTypeMissingMessage(sub: MaintenanceSubtype): string {
  const meta = MAINTENANCE_IE_TYPES[sub];
  return `Chưa có hạng mục chi "${meta.expected}" đang dùng trong công ty của toà này. Báo chủ công ty tạo hoặc khôi phục hạng mục này ở Cài đặt › Loại thu chi rồi thử lại.`;
}
