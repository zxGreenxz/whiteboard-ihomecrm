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
  /**
   * Cho chọn cả TOÀ ẢO (is_virtual) — bucket tài chính gom thu/chi không thuộc
   * toà vật lý, hiện là "Kho Văn Phòng Chung". Chỉ bật ở ô lọc thu chi & báo
   * cáo tài chính; các màn quản lý toà nhà giữ mặc định ẩn.
   * Bỏ qua khi truyền sẵn `buildings`.
   */
  includeVirtual?: boolean;
  /**
   * Mặc định bỏ khỏi `value` các toà không có trong danh sách đã về (xem
   * withoutUnknownBuildings). Tắt cho trang tự chuẩn hoá lựa chọn và báo riêng khi
   * toà đã chọn không còn quyền xem — trang đó cố ý KHÔNG tự nới ra mọi toà.
   */
  pruneUnknown?: boolean;
  /** Chữ (hoặc vạch xám khi danh sách toà chưa về) hiện khi chưa chọn / giá trị chưa khớp. */
  placeholder?: React.ReactNode;
  className?: string;
  /** Class cho dropdown (vd nới rộng hơn trigger để không xén tên toà). */
  contentClassName?: string;
  disabled?: boolean;
  align?: "start" | "center" | "end";
  id?: string;
  "aria-label"?: string;
}

/**
 * Toà đang lọc mà danh sách đã về lại không có (mất quyền toà, đổi công ty, giá trị
 * khôi phục từ phiên cũ) thì ô không hiện được tên: trang lọc theo toà vô hình, số
 * liệu về 0 trong khi ô ghi "Tất cả toà nhà" (báo lỗi 06/10/2026). Trả danh sách đã
 * bỏ các toà đó, hoặc null khi không cần sửa. Danh sách rỗng coi như chưa về —
 * không bỏ gì, kẻo mất lựa chọn đang khôi phục lúc trang còn tải.
 */
export function withoutUnknownBuildings(
  value: readonly string[],
  buildingIds: ReadonlySet<string>,
): string[] | null {
  if (value.length === 0 || buildingIds.size === 0) return null;
  const known = value.filter((id) => buildingIds.has(id));
  return known.length === value.length ? null : known;
}

/**
 * Ô lọc toà nhà ĐƠN-chọn, danh sách PHẲNG (không nhóm theo khu vực): mọi toà
 * user thấy được (theo RLS) xếp A→Z so khớp tự nhiên, cộng mục "Tất cả toà
 * nhà". Thay BuildingMultiSelect ở các ô LỌC toàn app — multi-select + nhóm
 * khu chỉ còn dùng cho scope/cấu hình (phân quyền, ProfitManagerForm,
 * ManageAreasDialog).
 */
export function BuildingFilterSelect({
  value,
  onChange,
  buildings: buildingsProp,
  includeVirtual = false,
  pruneUnknown = true,
  placeholder = "Tất cả toà nhà",
  className,
  contentClassName,
  disabled,
  align = "start",
  id,
  "aria-label": ariaLabel,
}: BuildingFilterSelectProps) {
  const { data: fetchedBuildings = [] } = useBuildings({
    enabled: buildingsProp === undefined,
    includeVirtual,
  });
  const source = buildingsProp ?? fetchedBuildings;

  const buildingIds = React.useMemo(() => new Set(source.map((b) => b.id)), [source]);
  // Sửa một lần cho mỗi cặp (giá trị, danh sách): trang nào không nhận giá trị đã sửa
  // thì cũng không lặp gọi onChange.
  const lastCorrection = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!pruneUnknown) return;
    const known = withoutUnknownBuildings(value, buildingIds);
    if (known === null) return;
    const signature = `${value.join(",")}|${[...buildingIds].join(",")}`;
    if (lastCorrection.current === signature) return;
    lastCorrection.current = signature;
    onChange(known);
  }, [pruneUnknown, value, buildingIds, onChange]);

  const options = React.useMemo(() => {
    const list = source
      .map((b) => ({ id: b.id, name: b.name ?? "" }))
      .sort((a, b) =>
        a.name.localeCompare(b.name, "vi", { numeric: true, sensitivity: "base" }),
      );
    return [
      { value: ALL, label: "Tất cả toà nhà", keywords: ["tất cả", "tat ca"] },
      ...list.map((b) => ({ value: b.id, label: b.name })),
    ];
  }, [source]);

  // Legacy/default có thể nhét >1 toà vào state (vd default theo khu) — UI đơn
  // chọn không hiện checkbox được nên trigger ghi "N toà nhà"; chọn lại sẽ thay
  // bằng đúng 1 toà.
  const multi = value.length > 1;

  return (
    <SearchableSelect
      value={multi ? undefined : (value[0] ?? ALL)}
      onValueChange={(v) => onChange(v === ALL ? [] : [v])}
      options={options}
      placeholder={multi ? `${value.length} toà nhà` : placeholder}
      searchPlaceholder="Tìm toà nhà..."
      className={className}
      contentClassName={contentClassName}
      disabled={disabled}
      align={align}
      id={id}
      aria-label={ariaLabel ?? "Chọn toà nhà"}
    />
  );
}

export default BuildingFilterSelect;
