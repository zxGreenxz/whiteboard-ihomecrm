import { SearchableSelect } from '@/components/ui/searchable-select';
import { useBuildings } from '@/hooks/useBuildings';
import { useRooms } from '@/hooks/useRooms';
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
      room_id: undefined,    });
  };

  const handleBuildingChange = (value: string) => {
    onFiltersChange({
      ...filters,
      building_id: value || undefined,
      room_id: undefined,    });
  };

  const handleRoomChange = (value: string) => {
    onFiltersChange({
      ...filters,
      room_id: value || undefined,    });
  };

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
      {/* Area — desktop only */}
      <div className="hidden md:block">
        <SearchableSelect
          value={filters.area_id || ''}
          onValueChange={handleAreaChange}
          placeholder="Chọn khu vực"
          options={areas.map((a: any) => ({ value: a.id, label: a.name }))}
        />
      </div>

      {/* Building */}
      <SearchableSelect
        value={filters.building_id || ''}
        onValueChange={handleBuildingChange}
        placeholder="Chọn toà nhà"
        options={filteredBuildings.map((b: any) => ({ value: b.id, label: b.name }))}
      />

      {/* Room */}
      <SearchableSelect
        value={filters.room_id || ''}
        onValueChange={handleRoomChange}
        disabled={!filters.building_id}
        placeholder="Chọn phòng"
        options={rooms.map((r: any) => ({ value: r.id, label: r.name }))}
      />
    </div>
  );
}
