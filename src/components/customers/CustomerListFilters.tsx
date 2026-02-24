import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useBuildings } from '@/hooks/useBuildings';
import { useRooms } from '@/hooks/useRooms';
import { useBeds } from '@/hooks/useBeds';
import type { CustomerFilters } from '@/types/customer';

interface CustomerListFiltersProps {
  filters: CustomerFilters;
  onFiltersChange: (filters: CustomerFilters) => void;
}

export default function CustomerListFilters({
  filters,
  onFiltersChange,
}: CustomerListFiltersProps) {
  const { data: buildings = [] } = useBuildings();
  const { data: rooms = [] } = useRooms(filters.building_id);
  const { data: beds = [] } = useBeds(filters.room_id);

  // Extract unique areas from buildings
  const areas = Array.from(
    new Map(
      buildings
        .filter((b: any) => b.area)
        .map((b: any) => [b.area.id, { id: b.area.id, name: b.area.name }])
    ).values()
  );

  // Filter buildings by selected area
  const filteredBuildings = filters.area_id
    ? buildings.filter((b: any) => b.area?.id === filters.area_id)
    : buildings;

  const handleAreaChange = (value: string) => {
    onFiltersChange({
      ...filters,
      area_id: value || undefined,
      building_id: undefined,
      room_id: undefined,
      bed_id: undefined,
    });
  };

  const handleBuildingChange = (value: string) => {
    onFiltersChange({
      ...filters,
      building_id: value || undefined,
      room_id: undefined,
      bed_id: undefined,
    });
  };

  const handleRoomChange = (value: string) => {
    onFiltersChange({
      ...filters,
      room_id: value || undefined,
      bed_id: undefined,
    });
  };

  const handleBedChange = (value: string) => {
    onFiltersChange({
      ...filters,
      bed_id: value || undefined,
    });
  };

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
      {/* Area */}
      <Select value={filters.area_id || ''} onValueChange={handleAreaChange}>
        <SelectTrigger>
          <SelectValue placeholder="Chọn khu vực" />
        </SelectTrigger>
        <SelectContent>
          {areas.map((a: any) => (
            <SelectItem key={a.id} value={a.id}>
              {a.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Building */}
      <Select value={filters.building_id || ''} onValueChange={handleBuildingChange}>
        <SelectTrigger>
          <SelectValue placeholder="Chọn toà nhà" />
        </SelectTrigger>
        <SelectContent>
          {filteredBuildings.map((b: any) => (
            <SelectItem key={b.id} value={b.id}>
              {b.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Room */}
      <Select
        value={filters.room_id || ''}
        onValueChange={handleRoomChange}
        disabled={!filters.building_id}
      >
        <SelectTrigger>
          <SelectValue placeholder="Chọn phòng" />
        </SelectTrigger>
        <SelectContent>
          {rooms.map((r: any) => (
            <SelectItem key={r.id} value={r.id}>
              {r.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Bed */}
      <Select
        value={filters.bed_id || ''}
        onValueChange={handleBedChange}
        disabled={!filters.room_id}
      >
        <SelectTrigger>
          <SelectValue placeholder="Chọn giường" />
        </SelectTrigger>
        <SelectContent>
          {beds.map((bed: any) => (
            <SelectItem key={bed.id} value={bed.id}>
              {bed.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
