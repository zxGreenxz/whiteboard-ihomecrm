import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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
      <Select value={areaFilter} onValueChange={onAreaChange}>
        <SelectTrigger className="w-full sm:w-[200px]">
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
    </div>
  );
}
