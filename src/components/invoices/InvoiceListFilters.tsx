import { useBuildings } from '@/hooks/useBuildings';
import { useRooms } from '@/hooks/useRooms';
import { useBeds } from '@/hooks/useBeds';
import { useContracts } from '@/hooks/useContracts';
import { Input } from '@/components/ui/input';
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

const InvoiceListFilters = ({ filters, onFiltersChange }: InvoiceListFiltersProps) => {
  const { data: buildings = [] } = useBuildings();
  const { data: rooms = [] } = useRooms(filters.building_id);
  const { data: beds = [] } = useBeds(filters.room_id);
  const { data: contractsData } = useContracts(
    filters.room_id ? { room_id: filters.room_id } : undefined,
  );
  const contracts = contractsData?.data ?? [];

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

  const handleMonthChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const month = e.target.value; // YYYY-MM format
    update({ billing_month: month || undefined });
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

      {/* Chọn tháng */}
      <Input
        type="month"
        className="h-9 text-sm w-[160px]"
        value={filters.billing_month ?? ''}
        onChange={handleMonthChange}
        placeholder="Chọn tháng"
      />
    </div>
  );
};

export default InvoiceListFilters;
