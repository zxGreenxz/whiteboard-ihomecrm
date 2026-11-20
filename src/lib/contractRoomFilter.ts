export type PhongCoTheChuyen = {
  id: string;
  status: string;
  building_id: string;
};

/** Phòng đích của hợp đồng phải là một phòng trống khác trong cùng tòa. */
export function locPhongChuyenDuoc<T extends PhongCoTheChuyen>(
  tatCaPhong: readonly T[],
  toaHienTai: string | null | undefined,
  phongHienTai?: string | null,
): T[] {
  if (!toaHienTai) return [];
  return tatCaPhong.filter(
    (p) => p.building_id === toaHienTai && p.id !== phongHienTai && p.status === "AVAILABLE",
  );
}
