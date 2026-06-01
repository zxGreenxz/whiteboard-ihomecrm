import { Input } from '@/components/ui/input';
import { SearchableSelect } from '@/components/ui/searchable-select';
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
  areaFilter: string;
  onAreaChange: (value: string) => void;
  buildingFilter: string;
  onBuildingChange: (value: string) => void;
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
  areaFilter,
  onAreaChange,
  buildingFilter,
  onBuildingChange,
  floorFilter,
  onFloorChange,
  statusFilter,
  onStatusChange,
  areas,
  buildings,
  floors,
}: RoomListFiltersProps) {
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
      <SearchableSelect
        value={areaFilter}
        onValueChange={onAreaChange}
        className="w-full sm:w-[200px]"
        placeholder="Khu vực"
        options={[
          { value: 'all', label: 'Tất cả khu vực' },
          ...areas.map((area) => ({ value: area.id, label: area.name })),
        ]}
      />
      <SearchableSelect
        value={buildingFilter}
        onValueChange={(val) => { onBuildingChange(val); onFloorChange('all'); }}
        className="w-full sm:w-[200px]"
        placeholder="Toà nhà"
        options={[
          { value: 'all', label: 'Tất cả toà nhà' },
          ...buildings.map((building) => ({ value: building.id, label: building.name })),
        ]}
      />
      <SearchableSelect
        value={floorFilter}
        onValueChange={onFloorChange}
        className="w-full sm:w-[180px]"
        placeholder="Tầng"
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
          { value: 'INACTIVE', label: 'Ngừng hoạt động' },
        ]}
      />
    </div>
  );
}
