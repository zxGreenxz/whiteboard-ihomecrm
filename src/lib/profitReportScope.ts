// Phạm vi toà của Báo cáo Lợi Nhuận theo CÔNG TY đang chọn.
//
// RLS cho siêu quản trị thấy toà của MỌI công ty (gồm công ty DEMO), nên "không lọc toà" mà để trống
// bộ lọc là cộng lẫn số của công ty khác vào tổng (engine fa_* thì không). Trang luôn gửi danh sách toà
// cụ thể: toà người dùng chọn ∩ công ty đang chọn, hoặc mọi toà của công ty khi không chọn toà nào.

/** Mã giả không khớp toà nào: công ty chưa có toà ⇒ báo cáo rỗng, KHÔNG rơi về "mọi toà". */
export const NO_BUILDING_ID = '00000000-0000-0000-0000-000000000000';

interface ScopedBuilding { id: string; organization_id?: string | null }

/** Toà thuộc công ty đang chọn (chưa chốt công ty ⇒ rỗng: bên gọi phải chờ, không đoán). */
export function orgBuildingsOf<T extends ScopedBuilding>(buildings: readonly T[], selectedOrganizationId: string | null): T[] {
  if (!selectedOrganizationId) return [];
  return buildings.filter((b) => b.organization_id === selectedOrganizationId);
}

/**
 * Danh sách toà gửi xuống truy vấn: toà đã chọn còn thuộc công ty (bỏ toà của công ty khác còn lưu từ lần
 * trước), không chọn ⇒ mọi toà của công ty; không có toà nào ⇒ [NO_BUILDING_ID].
 */
export function profitScopeIds(orgBuildings: readonly ScopedBuilding[], picked: readonly string[]): string[] {
  const inOrg = new Set(orgBuildings.map((b) => b.id));
  const chosen = picked.filter((id) => inOrg.has(id));
  const ids = chosen.length > 0 ? chosen : [...inOrg];
  return ids.length > 0 ? ids : [NO_BUILDING_ID];
}
