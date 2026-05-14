import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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
    <div className="flex flex-wrap items-center gap-3">
      {/* Trạng thái hợp đồng */}
      <Select value={lifecycleFilter} onValueChange={(val) => onLifecycleChange(val as ContractLifecycleFilter)}>
        <SelectTrigger className="w-[160px]">
          <SelectValue placeholder="Trạng thái" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="ALL">Tất cả trạng thái</SelectItem>
          <SelectItem value="ACTIVE">Đang ở</SelectItem>
          <SelectItem value="TERMINATED">Thanh lý</SelectItem>
        </SelectContent>
      </Select>

      {/* Khu vực */}
      <Select
        value={areaFilter}
        onValueChange={(val) => {
          onAreaChange(val);
          onBuildingChange('all');
          onRoomChange('all');
        }}
      >
        <SelectTrigger className="w-[160px]">
          <SelectValue placeholder="Chọn khu vực" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">Tất cả khu vực</SelectItem>
          {areas.map((area) => (
            <SelectItem key={area.id} value={area.id}>
              {area.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Toà nhà */}
      <Select
        value={buildingFilter}
        onValueChange={(val) => {
          onBuildingChange(val);
          onRoomChange('all');
        }}
      >
        <SelectTrigger className="w-[160px]">
          <SelectValue placeholder="Chọn toà nhà" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">Tất cả toà nhà</SelectItem>
          {buildings.map((building) => (
            <SelectItem key={building.id} value={building.id}>
              {building.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Phòng */}
      <Select value={roomFilter} onValueChange={onRoomChange}>
        <SelectTrigger className="w-[160px]">
          <SelectValue placeholder="Chọn phòng" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">Tất cả phòng</SelectItem>
          {rooms.map((room) => (
            <SelectItem key={room.id} value={room.id}>
              {room.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Chọn tháng */}
      <Input
        type="month"
        value={monthFilter}
        onChange={(e) => onMonthChange(e.target.value)}
        className="w-[160px]"
        placeholder="Chọn tháng"
      />
    </div>
  );
}
