/**
 * Logic thuần cho bộ chọn nhiều toà nhà nhóm theo Khu vực.
 *
 * Khu vực (areas) trong hệ thống chỉ là NHÃN NHÓM toà nhà — không tham gia
 * RLS theo khu (RLS theo building_id; scope nhân viên có thể gán theo khu
 * nhưng được DB bung LIVE thành building_id). Quan hệ là N-N: MỘT TOÀ CÓ THỂ
 * THUỘC NHIỀU KHU (vd "Nhà cũ" và "Thang bộ" cùng chứa toà A) — nên một toà
 * có thể xuất hiện trong nhiều nhóm của dropdown. Mọi nơi cần "nhiều toà"
 * (ô lọc, scope) vẫn thao tác trên danh sách building_id; khu vực là phím
 * tắt chọn nhanh cả nhóm trong UI.
 *
 * Tách thuần để test bằng fast-check: src/lib/__tests__/buildingGroups.property.test.ts
 */

export interface BuildingLite {
  id: string;
  name: string;
  /** Các khu chứa toà này (N-N). Rỗng/undefined = "Chưa phân khu". */
  area_ids?: readonly string[] | null;
}

export interface AreaLite {
  id: string;
  name: string;
}

export interface BuildingGroup {
  /** null = nhóm "Chưa phân khu" */
  areaId: string | null;
  areaName: string;
  buildings: BuildingLite[];
}

export const UNGROUPED_LABEL = "Chưa phân khu";

/**
 * Gom toà nhà theo khu vực. Thứ tự nhóm theo thứ tự mảng `areas`;
 * toà thuộc nhiều khu xuất hiện trong MỖI nhóm tương ứng; toà không thuộc
 * khu sống nào (kể cả chỉ trỏ tới khu đã xoá) dồn vào nhóm "Chưa phân khu"
 * ở cuối. Khu không có toà nào bị bỏ qua.
 *
 * Bất biến: mỗi toà xuất hiện ≥1 lần; trong MỘT nhóm không trùng id;
 * union các nhóm = toàn bộ toà.
 */
export function groupBuildingsByArea(
  buildings: BuildingLite[],
  areas: AreaLite[],
): BuildingGroup[] {
  const byArea = new Map<string, BuildingLite[]>();
  const ungrouped: BuildingLite[] = [];
  const areaIds = new Set(areas.map((a) => a.id));

  for (const b of buildings) {
    const valid = (b.area_ids ?? []).filter((id) => areaIds.has(id));
    if (valid.length === 0) {
      ungrouped.push(b);
      continue;
    }
    for (const id of valid) {
      const list = byArea.get(id);
      if (list) list.push(b);
      else byArea.set(id, [b]);
    }
  }

  const groups: BuildingGroup[] = [];
  for (const area of areas) {
    const list = byArea.get(area.id);
    if (list && list.length > 0) {
      groups.push({ areaId: area.id, areaName: area.name, buildings: list });
    }
  }
  if (ungrouped.length > 0) {
    groups.push({ areaId: null, areaName: UNGROUPED_LABEL, buildings: ungrouped });
  }
  return groups;
}

export type GroupSelectionState = "none" | "some" | "all";

/** Trạng thái chọn của một nhóm so với selection hiện tại. */
export function groupSelectionState(
  selection: readonly string[],
  groupBuildingIds: readonly string[],
): GroupSelectionState {
  if (groupBuildingIds.length === 0) return "none";
  const sel = new Set(selection);
  let count = 0;
  for (const id of groupBuildingIds) {
    if (sel.has(id)) count++;
  }
  if (count === 0) return "none";
  return count === groupBuildingIds.length ? "all" : "some";
}

/**
 * Click tên khu = toggle cả nhóm: đang chọn đủ → bỏ cả nhóm;
 * thiếu/chưa chọn → chọn đủ cả nhóm (union). Không đụng toà ngoài nhóm.
 *
 * Với nhóm chồng lấn (toà thuộc nhiều khu): bỏ chọn Khu A sẽ bỏ cả toà
 * chung với Khu B → Khu B chuyển "some". Đây là chủ ý — selection cuối
 * cùng vẫn chỉ là danh sách building_id.
 */
export function toggleGroupSelection(
  selection: readonly string[],
  groupBuildingIds: readonly string[],
): string[] {
  const group = new Set(groupBuildingIds);
  const state = groupSelectionState(selection, groupBuildingIds);
  if (state === "all") {
    return selection.filter((id) => !group.has(id));
  }
  const current = new Set(selection);
  const next = [...selection];
  for (const id of groupBuildingIds) {
    if (!current.has(id)) next.push(id);
  }
  return next;
}

/** Toggle một toà đơn lẻ. */
export function toggleBuildingSelection(
  selection: readonly string[],
  buildingId: string,
): string[] {
  return selection.includes(buildingId)
    ? selection.filter((id) => id !== buildingId)
    : [...selection, buildingId];
}

/**
 * Nhãn tóm tắt trên trigger:
 * - rỗng (caller hiện placeholder "Tất cả toà nhà") khi không chọn gì
 * - tên toà khi chọn đúng 1 toà
 * - "Khu A (3 toà)" khi chọn đúng trọn 1+ khu — nối "Khu A (3) + Khu B (2)"
 * - "... + N toà khác" khi lẫn toà lẻ ngoài các khu trọn vẹn
 * - "N toà" khi không khớp khu trọn nào
 *
 * Nhóm chồng lấn: nhận diện khu trọn theo kiểu GREEDY theo thứ tự nhóm —
 * một khu chỉ được tính "trọn" nếu đóng góp ≥1 toà chưa được các khu trọn
 * trước đó cover (tránh nhãn liệt kê trùng lặp các khu con/khu chồng nhau).
 */
export function summarizeSelection(
  selection: readonly string[],
  groups: BuildingGroup[],
): string {
  if (selection.length === 0) return "";

  if (selection.length === 1) {
    for (const g of groups) {
      const b = g.buildings.find((x) => x.id === selection[0]);
      if (b) return b.name;
    }
    return "1 toà";
  }

  const sel = new Set(selection);
  const coveredByFull = new Set<string>();
  const fullGroups: BuildingGroup[] = [];
  for (const g of groups) {
    if (g.buildings.length === 0) continue;
    if (!g.buildings.every((b) => sel.has(b.id))) continue;
    if (g.buildings.every((b) => coveredByFull.has(b.id))) continue; // đã cover trọn — bỏ qua
    fullGroups.push(g);
    for (const b of g.buildings) coveredByFull.add(b.id);
  }
  const leftover = selection.filter((id) => !coveredByFull.has(id));

  if (fullGroups.length === 0) return `${selection.length} toà`;

  const parts = fullGroups.map(
    (g) => `${g.areaName} (${g.buildings.length} toà)`,
  );
  const head = parts.join(" + ");
  return leftover.length > 0 ? `${head} + ${leftover.length} toà khác` : head;
}

/**
 * Lọc selection chỉ giữ các id còn tồn tại trong danh sách toà (toà bị xoá /
 * ngoài scope RLS thì khỏi giữ trong filter — tránh filter "ma" không nhìn thấy).
 */
export function pruneSelection(
  selection: readonly string[],
  buildings: readonly BuildingLite[],
): string[] {
  const valid = new Set(buildings.map((b) => b.id));
  const pruned = selection.filter((id) => valid.has(id));
  return pruned.length === selection.length ? [...selection] : pruned;
}
