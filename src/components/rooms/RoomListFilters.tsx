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

interface Floor {
  id: string;
  building_id: string;
  floor_number: number;
  name: string | null;
}

interface RoomListFiltersProps {
  searchTerm: string;
  onSearchChange: (value: string) => void;
  buildingFilter: string;
  onBuildingChange: (value: string) => void;
  floorFilter: string;
  onFloorChange: (value: string) => void;
  statusFilter: string;
  onStatusChange: (value: string) => void;
  buildings: BuildingWithRelations[];
  floors: Floor[];
}

export default function RoomListFilters({
  searchTerm,
  onSearchChange,
  buildingFilter,
  onBuildingChange,
  floorFilter,
  onFloorChange,
  statusFilter,
  onStatusChange,
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
      <Select value={buildingFilter} onValueChange={(val) => { onBuildingChange(val); onFloorChange('all'); }}>
        <SelectTrigger className="w-full sm:w-[200px]">
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
      <Select value={floorFilter} onValueChange={onFloorChange}>
        <SelectTrigger className="w-full sm:w-[180px]">
          <SelectValue placeholder="Tầng" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">Tất cả tầng</SelectItem>
          {floors.map((floor) => (
            <SelectItem key={floor.id} value={floor.floor_number.toString()}>
              Tầng {floor.floor_number}{floor.name ? ` - ${floor.name}` : ''}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={statusFilter} onValueChange={onStatusChange}>
        <SelectTrigger className="w-full sm:w-[200px]">
          <SelectValue placeholder="Trạng thái hoạt động" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">Tất cả</SelectItem>
          <SelectItem value="ACTIVE">Đang hoạt động</SelectItem>
          <SelectItem value="INACTIVE">Ngừng hoạt động</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}
