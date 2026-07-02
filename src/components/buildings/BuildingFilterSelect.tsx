import * as React from "react";

import { SearchableSelect } from "@/components/ui/searchable-select";
import { useBuildings } from "@/hooks/useBuildings";

const ALL = "ALL";

export interface BuildingFilterSelectProps {
  /**
   * Danh sách building_id đang lọc. Giữ nguyên shape MẢNG của
   * BuildingMultiSelect cũ để các trang không phải đổi state/hook — nhưng
   * component chỉ emit [] (tất cả) hoặc [id] (đúng 1 toà).
   */
  value: string[];
  onChange: (ids: string[]) => void;
  /** Nguồn toà nhà. Mặc định tự useBuildings() — RLS đã cắt theo scope staff. */
  buildings?: { id: string; name: string }[];
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  align?: "start" | "center" | "end";
  id?: string;
  "aria-label"?: string;
}

/**
 * Ô lọc toà nhà ĐƠN-chọn, danh sách PHẲNG (không nhóm theo khu vực): mọi toà
 * user thấy được (theo RLS) xếp A→Z so khớp tự nhiên, cộng mục "Tất cả toà
 * nhà". Thay BuildingMultiSelect ở các ô LỌC toàn app — multi-select + nhóm
 * khu chỉ còn dùng cho scope/cấu hình (StaffPage, ProfitManagerForm,
 * ManageAreasDialog).
 */
export function BuildingFilterSelect({
  value,
  onChange,
  buildings: buildingsProp,
  placeholder = "Tất cả toà nhà",
  className,
  disabled,
  align = "start",
  id,
  "aria-label": ariaLabel,
}: BuildingFilterSelectProps) {
  const { data: fetchedBuildings = [] } = useBuildings();

  const options = React.useMemo(() => {
    const list = (buildingsProp ?? (fetchedBuildings as any[]))
      .map((b) => ({ id: b.id as string, name: (b.name ?? "") as string }))
      .sort((a, b) =>
        a.name.localeCompare(b.name, "vi", { numeric: true, sensitivity: "base" }),
      );
    return [
      { value: ALL, label: "Tất cả toà nhà", keywords: ["tất cả", "tat ca"] },
      ...list.map((b) => ({ value: b.id, label: b.name })),
    ];
  }, [buildingsProp, fetchedBuildings]);

  return (
    <SearchableSelect
      value={value[0] ?? ALL}
      onValueChange={(v) => onChange(v === ALL ? [] : [v])}
      options={options}
      placeholder={placeholder}
      searchPlaceholder="Tìm toà nhà..."
      className={className}
      disabled={disabled}
      align={align}
      id={id}
      aria-label={ariaLabel ?? "Chọn toà nhà"}
    />
  );
}

export default BuildingFilterSelect;
