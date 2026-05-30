/**
 * Sắp xếp phòng theo tên phòng với thứ tự nhóm:
 *   MB* (mặt bằng) → G* (gác/trệt) → L* (lửng) → còn lại (phòng đánh số 1, 2, 3, 4...).
 * Dùng cho bảng Hợp đồng thuê và trang Căn hộ.
 */

/** Thứ hạng nhóm theo tiền tố tên phòng. Số nhỏ hơn = đứng trước. */
export function roomNameGroupRank(name: string): number {
  const n = (name ?? "").trim().toUpperCase();
  if (n.startsWith("MB")) return 0;
  if (n.startsWith("G")) return 1;
  if (n.startsWith("L")) return 2;
  return 3;
}

/**
 * So sánh hai tên phòng theo thứ tự MB* → G* → L* → 1,2,3,4...
 * Trong cùng một nhóm: so khớp tự nhiên (số được so theo giá trị, không phải
 * theo ký tự) — vd L3 < L10, 205 < 305 < 403.
 */
export function compareRoomNames(a: string, b: string): number {
  const ra = roomNameGroupRank(a);
  const rb = roomNameGroupRank(b);
  if (ra !== rb) return ra - rb;
  return (a ?? "").localeCompare(b ?? "", "vi", {
    numeric: true,
    sensitivity: "base",
  });
}

/**
 * So sánh theo toà nhà (A→Z, so khớp tự nhiên) rồi mới đến tên phòng — để các
 * phòng cùng toà nhà luôn nằm cạnh nhau, trong mỗi toà sắp theo `compareRoomNames`.
 */
export function compareBuildingThenRoom(
  aBuilding: string,
  aRoom: string,
  bBuilding: string,
  bRoom: string,
): number {
  const bc = (aBuilding ?? "").localeCompare(bBuilding ?? "", "vi", {
    numeric: true,
    sensitivity: "base",
  });
  if (bc !== 0) return bc;
  return compareRoomNames(aRoom, bRoom);
}
