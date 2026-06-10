import { BuildingMultiSelect } from '@/components/buildings/BuildingMultiSelect';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { useRooms } from '@/hooks/useRooms';
import type { CustomerFilters } from '@/types/customer';

interface CustomerListFiltersProps {
  filters: CustomerFilters;
  onFiltersChange: (filters: CustomerFilters) => void;
  /** Danh sách building_id đang lọc. [] = tất cả toà (không lọc). */
  buildingIds: string[];
  onBuildingIdsChange: (ids: string[]) => void;
}

export default function CustomerListFilters({
  filters,
  onFiltersChange,
  buildingIds,
  onBuildingIdsChange,
}: CustomerListFiltersProps) {
  // Phòng thuộc về 1 toà cụ thể → chỉ cho chọn phòng khi đã khoanh đúng 1 toà.
  const singleBuildingId = buildingIds.length === 1 ? buildingIds[0] : undefined;
  const { data: rooms = [] } = useRooms(singleBuildingId);

  const handleBuildingIdsChange = (ids: string[]) => {
    onBuildingIdsChange(ids);
    // Đổi phạm vi toà → phòng đã chọn không còn hợp lệ.
    if (filters.room_id) {
      onFiltersChange({ ...filters, room_id: undefined });
    }
  };

  const handleRoomChange = (value: string) => {
    onFiltersChange({
      ...filters,
      room_id: value || undefined,
    });
  };

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
      {/* Toà nhà (gom theo khu vực, chọn nhiều) — thay cặp Khu vực + Toà cũ */}
      <BuildingMultiSelect
        value={buildingIds}
        onChange={handleBuildingIdsChange}
        className="md:col-span-2"
        aria-label="Lọc theo toà nhà"
      />

      {/* Room — chỉ bật khi chọn đúng 1 toà */}
      <SearchableSelect
        value={filters.room_id || ''}
        onValueChange={handleRoomChange}
        disabled={!singleBuildingId}
        placeholder="Chọn phòng"
        options={rooms.map((r: any) => ({ value: r.id, label: r.name }))}
      />
    </div>
  );
}
