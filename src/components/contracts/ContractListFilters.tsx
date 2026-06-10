import { Input } from '@/components/ui/input';
import { SearchableSelect } from '@/components/ui/searchable-select';
import BuildingMultiSelect from '@/components/buildings/BuildingMultiSelect';
import { uniqueRoomNames } from '@/lib/roomSort';
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
  /** Danh sách building_id đang lọc. [] = tất cả toà nhà. */
  buildingIds: string[];
  onBuildingIdsChange: (ids: string[]) => void;
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
  buildingIds,
  onBuildingIdsChange,
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

      {/* Khu vực + Toà nhà — chọn nhiều toà, nhóm theo khu */}
      <BuildingMultiSelect
        value={buildingIds}
        onChange={onBuildingIdsChange}
        buildings={buildings}
        areas={areas}
        className="md:w-[260px]"
      />

      {/* Phòng — gộp theo tên (vd nhiều toà cùng có "101" → 1 mục "101") */}
      <SearchableSelect
        value={roomFilter}
        onValueChange={onRoomChange}
        className="md:w-[160px]"
        placeholder="Chọn phòng"
        options={[
          { value: 'all', label: 'Tất cả phòng' },
          ...uniqueRoomNames(rooms).map((name) => ({ value: name, label: name })),
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
