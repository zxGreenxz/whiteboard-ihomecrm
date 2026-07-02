import { Input } from '@/components/ui/input';
import { SearchableSelect } from '@/components/ui/searchable-select';
import BuildingFilterSelect from '@/components/buildings/BuildingFilterSelect';
import { Search } from 'lucide-react';
import type { BuildingWithRelations } from '@/types/building';

interface Floor {
  id: string;
  building_id: string;
  floor_number: number;
  name: string | null;
}

interface Area {
  id: string;
  name: string;
}

interface RoomListFiltersProps {
  searchTerm: string;
  onSearchChange: (value: string) => void;
  /** Danh sách building_id đang lọc. [] = tất cả toà nhà. */
  buildingIds: string[];
  onBuildingIdsChange: (ids: string[]) => void;
  floorFilter: string;
  onFloorChange: (value: string) => void;
  statusFilter: string;
  onStatusChange: (value: string) => void;
  areas: Area[];
  buildings: BuildingWithRelations[];
  floors: Floor[];
}

export default function RoomListFilters({
  searchTerm,
  onSearchChange,
  buildingIds,
  onBuildingIdsChange,
  floorFilter,
  onFloorChange,
  statusFilter,
  onStatusChange,
  buildings,
  floors,
}: RoomListFiltersProps) {
  // Tầng chỉ lọc được khi đang chọn ĐÚNG 1 toà (tầng thuộc toà cụ thể)
  const floorEnabled = buildingIds.length === 1;

  return (
    <div className="flex flex-col sm:flex-row gap-3">
      <div className="relative flex-1">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Tìm kiếm theo tên phòng, mã..."
          value={searchTerm}
          onChange={(e) => onSearchChange(e.target.value)}
          className="pl-9"
        />
      </div>
      {/* Toà nhà — 1 toà hoặc tất cả, danh sách phẳng A→Z */}
      <BuildingFilterSelect
        value={buildingIds}
        onChange={onBuildingIdsChange}
        buildings={buildings}
        className="w-full sm:w-[260px]"
      />
      <SearchableSelect
        value={floorEnabled ? floorFilter : undefined}
        onValueChange={onFloorChange}
        disabled={!floorEnabled}
        className="w-full sm:w-[180px]"
        placeholder={floorEnabled ? 'Tầng' : 'Tầng (chọn 1 toà)'}
        options={[
          { value: 'all', label: 'Tất cả tầng' },
          ...floors.map((floor) => ({
            value: floor.floor_number.toString(),
            label: `Tầng ${floor.floor_number}${floor.name ? ` - ${floor.name}` : ''}`,
          })),
        ]}
      />
      <SearchableSelect
        value={statusFilter}
        onValueChange={onStatusChange}
        className="w-full sm:w-[200px]"
        placeholder="Trạng thái hoạt động"
        options={[
          { value: 'all', label: 'Tất cả' },
          { value: 'ACTIVE', label: 'Đang hoạt động' },
          { value: 'RESERVED', label: 'Đã đặt cọc' },
          { value: 'INACTIVE', label: 'Ngừng hoạt động' },
        ]}
      />
    </div>
  );
}
