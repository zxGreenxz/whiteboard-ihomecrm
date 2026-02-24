import { useBuildings } from '@/hooks/useBuildings';
import { useRooms } from '@/hooks/useRooms';
import { useBeds } from '@/hooks/useBeds';
import { useContracts } from '@/hooks/useContracts';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { InvoiceFilters, InvoiceStatus } from '@/types/invoice';

interface InvoiceListFiltersProps {
  filters: InvoiceFilters;
  onFiltersChange: (filters: InvoiceFilters) => void;
}

const STATUS_OPTIONS: { value: InvoiceStatus; label: string }[] = [
  { value: 'DRAFT', label: 'Nháp' },
  { value: 'APPROVED', label: 'Đã duyệt' },
  { value: 'PARTIAL_PAID', label: 'Trả 1 phần' },
  { value: 'PAID', label: 'Đã thanh toán' },
  { value: 'OVERDUE', label: 'Quá hạn' },
  { value: 'CANCELLED', label: 'Đã huỷ' },
];

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

  const handleStatusChange = (value: string) => {
    update({ status: value === ALL_VALUE ? undefined : (value as InvoiceStatus) });
  };

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 mb-4">
      {/* Toà nhà */}
      <div className="space-y-1">
        <Label className="text-xs">Toà nhà</Label>
        <Select value={filters.building_id ?? ALL_VALUE} onValueChange={handleBuildingChange}>
          <SelectTrigger className="h-9 text-sm">
            <SelectValue placeholder="Tất cả" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_VALUE}>Tất cả</SelectItem>
            {buildings.map((b: any) => (
              <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Phòng */}
      <div className="space-y-1">
        <Label className="text-xs">Phòng</Label>
        <Select value={filters.room_id ?? ALL_VALUE} onValueChange={handleRoomChange}>
          <SelectTrigger className="h-9 text-sm">
            <SelectValue placeholder="Tất cả" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_VALUE}>Tất cả</SelectItem>
            {rooms.map((r: any) => (
              <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Giường */}
      <div className="space-y-1">
        <Label className="text-xs">Giường</Label>
        <Select value={filters.bed_id ?? ALL_VALUE} onValueChange={handleBedChange}>
          <SelectTrigger className="h-9 text-sm">
            <SelectValue placeholder="Tất cả" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_VALUE}>Tất cả</SelectItem>
            {beds.map((b: any) => (
              <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Hợp đồng */}
      <div className="space-y-1">
        <Label className="text-xs">Hợp đồng</Label>
        <Select value={filters.contract_id ?? ALL_VALUE} onValueChange={handleContractChange}>
          <SelectTrigger className="h-9 text-sm">
            <SelectValue placeholder="Tất cả" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_VALUE}>Tất cả</SelectItem>
            {contracts.map((c: any) => (
              <SelectItem key={c.id} value={c.id}>
                {c.contract_number ?? c.tenant?.full_name ?? c.id.slice(0, 8)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Khoảng thời gian */}
      <div className="space-y-1">
        <Label className="text-xs">Khoảng thời gian</Label>
        <div className="flex gap-1">
          <Input
            type="date"
            className="h-9 text-xs"
            value={filters.date_range?.start ?? ''}
            onChange={(e) =>
              update({
                date_range: {
                  start: e.target.value,
                  end: filters.date_range?.end ?? '',
                },
              })
            }
          />
          <Input
            type="date"
            className="h-9 text-xs"
            value={filters.date_range?.end ?? ''}
            onChange={(e) =>
              update({
                date_range: {
                  start: filters.date_range?.start ?? '',
                  end: e.target.value,
                },
              })
            }
          />
        </div>
      </div>

      {/* Trạng thái */}
      <div className="space-y-1">
        <Label className="text-xs">Trạng thái</Label>
        <Select value={filters.status ?? ALL_VALUE} onValueChange={handleStatusChange}>
          <SelectTrigger className="h-9 text-sm">
            <SelectValue placeholder="Tất cả" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_VALUE}>Tất cả</SelectItem>
            {STATUS_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
};

export default InvoiceListFilters;
