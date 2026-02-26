import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Search } from 'lucide-react';
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
    <div className="flex flex-col gap-3">
      {/* Search bar */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Tìm theo mã HĐ, tên khách, SĐT, tên phòng..."
          value={searchTerm}
          onChange={(e) => onSearchChange(e.target.value)}
          className="pl-9"
        />
      </div>

      {/* Filter dropdowns */}
      <div className="flex flex-col sm:flex-row gap-3 flex-wrap">
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
          <SelectTrigger className="w-full sm:w-[180px]">
            <SelectValue placeholder="Khu vực" />
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
          <SelectTrigger className="w-full sm:w-[180px]">
            <SelectValue placeholder="Toà nhà" />
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
          <SelectTrigger className="w-full sm:w-[180px]">
            <SelectValue placeholder="Phòng" />
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
          <SelectTrigger className="w-full sm:w-[180px]">
            <SelectValue placeholder="Giường" />
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
          <SelectTrigger className="w-full sm:w-[180px]">
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
          className="w-full sm:w-[180px]"
          placeholder="Chọn tháng"
        />
      </div>
    </div>
  );
}
