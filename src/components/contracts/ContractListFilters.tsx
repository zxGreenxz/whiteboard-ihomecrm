import { Input } from '@/components/ui/input';
import { SearchableSelect } from '@/components/ui/searchable-select';
import type { BuildingWithRelations } from '@/types/building';
import type { RoomWithRelations } from '@/types/room';
import type { ContractLifecycleFilter } from '@/types/contract';

interface Area {
  id: string;
  name: string;
  code: string | null;
  status: string;
}

interface ContractListFiltersProps {
  searchTerm: string;
  onSearchChange: (value: string) => void;
  areaFilter: string;
  onAreaChange: (value: string) => void;
  buildingFilter: string;
  onBuildingChange: (value: string) => void;
  roomFilter: string;
  onRoomChange: (value: string) => void;
  lifecycleFilter: ContractLifecycleFilter;
  onLifecycleChange: (value: ContractLifecycleFilter) => void;
  monthFilter: string;
  onMonthChange: (value: string) => void;
  areas: Area[];
  buildings: BuildingWithRelations[];
  rooms: RoomWithRelations[];
}

export default function ContractListFilters({
  areaFilter,
  onAreaChange,
  buildingFilter,
  onBuildingChange,
  roomFilter,
  onRoomChange,
  lifecycleFilter,
  onLifecycleChange,
  monthFilter,
  onMonthChange,
  areas,
  buildings,
  rooms,
}: ContractListFiltersProps) {
  return (
    <div className="grid grid-cols-2 md:flex md:flex-wrap md:items-center gap-3">
      {/* Trạng thái hợp đồng */}
      <SearchableSelect
        value={lifecycleFilter}
        onValueChange={(val) => onLifecycleChange(val as ContractLifecycleFilter)}
        className="md:w-[160px]"
        placeholder="Trạng thái"
        options={[
          { value: 'ALL', label: 'Tất cả trạng thái' },
          { value: 'ACTIVE', label: 'Đang ở' },
          { value: 'TERMINATED', label: 'Thanh lý' },
        ]}
      />

      {/* Khu vực — desktop only */}
      <div className="hidden md:block">
        <SearchableSelect
          value={areaFilter}
          onValueChange={(val) => {
            onAreaChange(val);
            onBuildingChange('all');
            onRoomChange('all');
          }}
          className="md:w-[160px]"
          placeholder="Chọn khu vực"
          options={[
            { value: 'all', label: 'Tất cả khu vực' },
            ...areas.map((area) => ({ value: area.id, label: area.name })),
          ]}
        />
      </div>

      {/* Toà nhà */}
      <SearchableSelect
        value={buildingFilter}
        onValueChange={(val) => {
          onBuildingChange(val);
          onRoomChange('all');
        }}
        className="md:w-[160px]"
        placeholder="Chọn toà nhà"
        options={[
          { value: 'all', label: 'Tất cả toà nhà' },
          ...buildings.map((building) => ({ value: building.id, label: building.name })),
        ]}
      />

      {/* Phòng */}
      <SearchableSelect
        value={roomFilter}
        onValueChange={onRoomChange}
        className="md:w-[160px]"
        placeholder="Chọn phòng"
        options={[
          { value: 'all', label: 'Tất cả phòng' },
          ...rooms.map((room) => ({ value: room.id, label: room.name })),
        ]}
      />

      {/* Chọn tháng — desktop only */}
      <Input
        type="month"
        value={monthFilter}
        onChange={(e) => onMonthChange(e.target.value)}
        className="hidden md:flex md:w-[160px]"
        placeholder="Chọn tháng"
      />
    </div>
  );
}
