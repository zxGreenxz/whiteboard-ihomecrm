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

interface Area {
  id: string;
  name: string;
  code: string | null;
  status: string;
}

interface Bed {
  id: string;
  name: string;
  room_id: string;
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
  bedFilter: string;
  onBedChange: (value: string) => void;
  rentalTypeFilter: string;
  onRentalTypeChange: (value: string) => void;
  monthFilter: string;
  onMonthChange: (value: string) => void;
  areas: Area[];
  buildings: BuildingWithRelations[];
  rooms: RoomWithRelations[];
  beds: Bed[];
}

const RENTAL_TYPE_OPTIONS = [
  'Chung cư mini',
  'Nhà trọ',
  'Căn hộ dịch vụ',
  'Ký túc xá',
  'Homestay',
];

export default function ContractListFilters({
  searchTerm,
  onSearchChange,
  areaFilter,
  onAreaChange,
  buildingFilter,
  onBuildingChange,
  roomFilter,
  onRoomChange,
  bedFilter,
  onBedChange,
  rentalTypeFilter,
  onRentalTypeChange,
  monthFilter,
  onMonthChange,
  areas,
  buildings,
  rooms,
  beds,
}: ContractListFiltersProps) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      {/* Khu vực */}
      <Select
        value={areaFilter}
        onValueChange={(val) => {
          onAreaChange(val);
          onBuildingChange('all');
          onRoomChange('all');
          onBedChange('all');
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
          onBedChange('all');
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
      <Select
        value={roomFilter}
        onValueChange={(val) => {
          onRoomChange(val);
          onBedChange('all');
        }}
      >
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

      {/* Giường */}
      <Select value={bedFilter} onValueChange={onBedChange}>
        <SelectTrigger className="w-[160px]">
          <SelectValue placeholder="Chọn giường" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">Tất cả giường</SelectItem>
          {beds.map((bed) => (
            <SelectItem key={bed.id} value={bed.id}>
              {bed.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Dạng thuê */}
      <Select value={rentalTypeFilter} onValueChange={onRentalTypeChange}>
        <SelectTrigger className="w-[160px]">
          <SelectValue placeholder="Dạng thuê" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">Tất cả dạng thuê</SelectItem>
          {RENTAL_TYPE_OPTIONS.map((type) => (
            <SelectItem key={type} value={type}>
              {type}
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
