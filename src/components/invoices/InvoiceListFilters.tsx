import { useState } from 'react';
import { useBuildings } from '@/hooks/useBuildings';
import { useRooms } from '@/hooks/useRooms';
import { useBeds } from '@/hooks/useBeds';
import { useContracts } from '@/hooks/useContracts';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { Calendar, ChevronLeft, ChevronRight } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { InvoiceFilters } from '@/types/invoice';

interface InvoiceListFiltersProps {
  filters: InvoiceFilters;
  onFiltersChange: (filters: InvoiceFilters) => void;
}

const ALL_VALUE = '__all__';

const MONTHS = ['Th1', 'Th2', 'Th3', 'Th4', 'Th5', 'Th6', 'Th7', 'Th8', 'Th9', 'Th10', 'Th11', 'Th12'];

const InvoiceListFilters = ({ filters, onFiltersChange }: InvoiceListFiltersProps) => {
  const { data: buildings = [] } = useBuildings();
  const { data: rooms = [] } = useRooms(filters.building_id);
  const { data: beds = [] } = useBeds(filters.room_id);
  const { data: contractsData } = useContracts(
    filters.room_id ? { room_id: filters.room_id } : undefined,
  );
  const contracts = contractsData?.data ?? [];

  // Month Picker state
  const [monthPickerOpen, setMonthPickerOpen] = useState(false);
  const [pickerYear, setPickerYear] = useState(() => {
    if (filters.billing_month) return parseInt(filters.billing_month.split('-')[0]);
    return new Date().getFullYear();
  });

  const selectedMonth = filters.billing_month
    ? parseInt(filters.billing_month.split('-')[1])
    : null;
  const selectedYear = filters.billing_month
    ? parseInt(filters.billing_month.split('-')[0])
    : null;

  const update = (patch: Partial<InvoiceFilters>) => {
    onFiltersChange({ ...filters, ...patch });
  };

  const handleBuildingChange = (value: string) => {
    const buildingId = value === ALL_VALUE ? undefined : value;
    update({ building_id: buildingId, room_id: undefined, bed_id: undefined, contract_id: undefined });
  };

  const handleRoomChange = (value: string) => {
    const roomId = value === ALL_VALUE ? undefined : value;
    update({ room_id: roomId, bed_id: undefined });
  };

  const handleBedChange = (value: string) => {
    update({ bed_id: value === ALL_VALUE ? undefined : value });
  };

  const handleContractChange = (value: string) => {
    update({ contract_id: value === ALL_VALUE ? undefined : value });
  };

  const handleMonthSelect = (month: number) => {
    const monthStr = `${pickerYear}-${String(month).padStart(2, '0')}`;
    update({ billing_month: monthStr });
    setMonthPickerOpen(false);
  };

  return (
    <div className="flex flex-wrap items-center gap-2 mb-4">
      {/* Chọn khu vực - TODO: not implemented yet */}
      <Select disabled>
        <SelectTrigger className="h-9 text-sm w-[150px]">
          <SelectValue placeholder="Chọn khu vực" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__placeholder__">Chọn khu vực</SelectItem>
        </SelectContent>
      </Select>

      {/* Chọn toà nhà */}
      <Select value={filters.building_id ?? ALL_VALUE} onValueChange={handleBuildingChange}>
        <SelectTrigger className="h-9 text-sm w-[150px]">
          <SelectValue placeholder="Chọn toà nhà" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_VALUE}>Tất cả toà nhà</SelectItem>
          {buildings.map((b: any) => (
            <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Chọn phòng */}
      <Select value={filters.room_id ?? ALL_VALUE} onValueChange={handleRoomChange}>
        <SelectTrigger className="h-9 text-sm w-[140px]">
          <SelectValue placeholder="Chọn phòng" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_VALUE}>Tất cả phòng</SelectItem>
          {rooms.map((r: any) => (
            <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Chọn giường */}
      <Select value={filters.bed_id ?? ALL_VALUE} onValueChange={handleBedChange}>
        <SelectTrigger className="h-9 text-sm w-[140px]">
          <SelectValue placeholder="Chọn giường" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_VALUE}>Tất cả giường</SelectItem>
          {beds.map((b: any) => (
            <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Hợp đồng */}
      <Select value={filters.contract_id ?? ALL_VALUE} onValueChange={handleContractChange}>
        <SelectTrigger className="h-9 text-sm w-[150px]">
          <SelectValue placeholder="Hợp đồng" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_VALUE}>Tất cả HĐ</SelectItem>
          {contracts.map((c: any) => (
            <SelectItem key={c.id} value={c.id}>
              {c.contract_number ?? c.tenant?.full_name ?? c.id.slice(0, 8)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Chọn tháng - Custom Month Picker */}
      <Popover open={monthPickerOpen} onOpenChange={setMonthPickerOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" className="h-9 text-sm w-[160px] justify-start font-normal">
            <Calendar className="h-4 w-4 mr-2 text-muted-foreground" />
            {filters.billing_month
              ? `Th${selectedMonth}/${selectedYear}`
              : 'Chọn tháng'}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[280px] p-3" align="start">
          <div className="flex items-center justify-between mb-3">
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8"
              onClick={() => setPickerYear((y) => y - 1)}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="text-sm font-semibold">{pickerYear}</span>
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8"
              onClick={() => setPickerYear((y) => y + 1)}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
          <div className="grid grid-cols-4 gap-2">
            {MONTHS.map((label, idx) => {
              const monthNum = idx + 1;
              const isSelected = selectedYear === pickerYear && selectedMonth === monthNum;
              return (
                <Button
                  key={label}
                  variant={isSelected ? 'default' : 'ghost'}
                  size="sm"
                  className={`text-sm ${isSelected ? 'bg-green-600 hover:bg-green-700 text-white' : ''}`}
                  onClick={() => handleMonthSelect(monthNum)}
                >
                  {label}
                </Button>
              );
            })}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
};

export default InvoiceListFilters;
