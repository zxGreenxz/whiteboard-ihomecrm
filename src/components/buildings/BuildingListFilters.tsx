import { Input } from '@/components/ui/input';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { Search } from 'lucide-react';

interface Area {
  id: string;
  name: string;
  code: string | null;
}

interface BuildingListFiltersProps {
  searchTerm: string;
  onSearchChange: (value: string) => void;
  statusFilter: string;
  onStatusChange: (value: string) => void;
  areaFilter: string;
  onAreaChange: (value: string) => void;
  areas: Area[];
}

export default function BuildingListFilters({
  searchTerm,
  onSearchChange,
  statusFilter,
  onStatusChange,
  areaFilter,
  onAreaChange,
  areas,
}: BuildingListFiltersProps) {
  return (
    <div className="flex flex-col sm:flex-row gap-3">
      <div className="relative flex-1">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Tìm kiếm theo tên, mã, địa chỉ..."
          value={searchTerm}
          onChange={(e) => onSearchChange(e.target.value)}
          className="pl-9"
        />
      </div>
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
    </div>
  );
}
