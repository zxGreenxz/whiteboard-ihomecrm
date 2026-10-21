// Kiểm quyền runtime phía FE: `canUse` + kiểu phạm vi của `get_my_permissions_v2`.
//
// VÌ SAO TÁCH KHỎI src/lib/permissionPages.ts
//   Route guard `RequirePermission` nằm trong chunk entry và chỉ cần `canUse`. Trước đây nó import
//   từ catalog, nên toàn bộ catalog trang/feature (~18 KB) bị kéo vào chunk entry vốn sát ngưỡng
//   ratchet (tooling/bundle-baseline.json). Đây là phép DỜI NGUYÊN VĂN, không đổi hành vi:
//   permissionPages.ts re-export `canUse`, `PermissionScope`, `PermsLike` nên mọi import cũ giữ
//   nguyên. Mã nạp sớm (chunk entry) import thẳng từ file này.

import { canFeature, isSuperAdminPerms, type ActionKey, type PermissionsMap } from "@/lib/permissions";

/**
 * Phạm vi hiệu lực của MỘT (module, action) — hình dạng do
 * `get_my_permissions_v2(p_org)` trả về (migration 20260915143713).
 *
 * `org_wide` true = được ở mọi toà của công ty. Ngược lại chỉ được ở các toà
 * trong `building_ids`, và các sổ trong `cashbook_ids` với quyền đòi
 * đang-giữ-sổ (`cashbooks.post`, `cashbooks.manage_custody`). Cả ba vế
 * rỗng/false nghĩa là KHÔNG có quyền — máy chủ đã lọc những khoá như thế ra,
 * nhưng `canUse` vẫn phải fail-closed nếu gặp.
 */
export interface PermissionScope {
  org_wide: boolean;
  building_ids: string[];
  cashbook_ids?: string[];
}

/**
 * Kiểu permissions "lỏng" — chấp nhận cả PermissionsMap (lib/permissions), shape
 * BOOLEAN của `get_my_permissions()` lẫn shape CÓ PHẠM VI của
 * `get_my_permissions_v2()`, để gọi thẳng không cần cast.
 *
 * Hai hình dạng cùng sống một đợt: bản khách đang mở sẵn trong trình duyệt
 * người dùng lúc deploy vẫn gọi v1.
 */
export type PermsLike =
  | PermissionsMap
  | (Record<string, Record<string, boolean | PermissionScope>> & { __superadmin?: boolean })
  | null
  | undefined;

export const asPerms = (p: PermsLike): PermissionsMap | null =>
  (p ?? null) as PermissionsMap | null;

/** Mảng chuỗi hay không — dữ liệu méo phải đọc thành "rỗng", không được ném. */
const dsChuoi = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/**
 * Giá trị thô trong map đọc thành quyết định.
 *
 * - `true` / `false`: hình dạng v1 — KHÔNG biết phạm vi. `buildingId` bị bỏ
 *   qua có chủ ý: siết theo toà khi không có dữ liệu toà là tắt nút của người
 *   ĐANG CÓ quyền, hỏng nặng hơn lỗi đang vá.
 * - object: hình dạng v2 — trả lời đúng câu được hỏi.
 * - còn lại: fail-closed.
 */
function quyetDinhTheoPhamVi(raw: unknown, buildingId?: string | null): boolean {
  if (typeof raw === "boolean") return raw;
  if (raw === null || typeof raw !== "object") return false;

  const scope = raw as Partial<PermissionScope>;
  if (scope.org_wide === true) return true;

  const toa = dsChuoi(scope.building_ids);
  if (buildingId) return toa.includes(buildingId);

  // Không hỏi toà = hỏi "có quyền này ở đâu đó không". Bề mặt không gắn toà
  // (mục menu, route guard) phải mở, nếu không người dùng không vào nổi trang
  // để chọn toà.
  return toa.length > 0 || dsChuoi(scope.cashbook_ids).length > 0;
}

/**
 * Gate runtime chuẩn cho FE.
 *
 * `buildingId` là câu hỏi ĐẦY ĐỦ: "người này được làm việc đó TRÊN TOÀ NÀY
 * không". Bề mặt nào biết mình đang đứng ở toà nào thì phải truyền — đó là
 * cách duy nhất giao diện thôi hứa thay máy chủ (D1).
 *
 * Bỏ trống `buildingId` là hỏi câu yếu hơn: "có quyền này ở đâu đó không".
 * Đúng cho route guard và mục menu, KHÔNG đủ cho nút thao tác trên một toà.
 */
export function canUse(
  perms: PermsLike,
  module: string,
  action: ActionKey,
  buildingId?: string | null,
): boolean {
  const p = asPerms(perms);
  if (!p) return false;
  if (isSuperAdminPerms(p)) return true;

  const raw = (p as Record<string, Record<string, unknown> | undefined>)[module]?.[action];
  // Khoá vắng mặt: giữ nguyên đường cũ (canFeature) để không lệch ngữ nghĩa
  // "không suy diễn xuyên module" đã chốt ngày 26/07.
  if (raw === undefined) return canFeature(p, module, action);
  return quyetDinhTheoPhamVi(raw, buildingId);
}

/**
 * Có quyền ở MỌI toà của công ty (`org_wide`) — cho thao tác không gắn một toà nào (vd gắn máy cửa
 * mới). Khác `canUse` không truyền toà: câu đó trả lời "ở đâu đó", câu này đòi "ở mọi toà".
 * Hình dạng v1 (boolean) không biết phạm vi ⇒ theo đúng giá trị như `canUse`; máy chủ vẫn chặn thật.
 */
export function canUseOrgWide(perms: PermsLike, module: string, action: ActionKey): boolean {
  const p = asPerms(perms);
  if (!p) return false;
  if (isSuperAdminPerms(p)) return true;
  const raw = (p as Record<string, Record<string, unknown> | undefined>)[module]?.[action];
  if (typeof raw === "boolean") return raw;
  return raw !== null && typeof raw === "object" && (raw as Partial<PermissionScope>).org_wide === true;
}
