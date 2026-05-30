import { useState, useMemo } from 'react';
import { useAreas } from '@/hooks/useAreas';
import { useBuildings } from '@/hooks/useBuildings';
import { useRooms } from '@/hooks/useRooms';
import { useMyContext } from '@/hooks/useMyContext';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { Calendar, ChevronLeft, ChevronRight } from 'lucide-react';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { uniqueRoomNames, roomIdsByName, roomNameFromIds } from '@/lib/roomSort';
import type { InvoiceFilters } from '@/types/invoice';

interface InvoiceListFiltersProps {
  filters: InvoiceFilters;
  onFiltersChange: (filters: InvoiceFilters) => void;
  /** Khi true: chỉ render Toà nhà / Phòng / Tháng (dùng cho mobile). */
  compact?: boolean;
}

const ALL_VALUE = '__all__';

const MONTHS = ['Th1', 'Th2', 'Th3', 'Th4', 'Th5', 'Th6', 'Th7', 'Th8', 'Th9', 'Th10', 'Th11', 'Th12'];

const InvoiceListFilters = ({ filters, onFiltersChange, compact = false }: InvoiceListFiltersProps) => {
  const { data: areas = [] } = useAreas();
  const { data: allBuildings = [] } = useBuildings();
  const { data: rooms = [] } = useRooms(filters.building_id);
  const { data: ctx } = useMyContext();
  // Staff không được chọn khu vực — scope đã được RPC/RLS giới hạn theo
  // building được gán. Ẩn ô lọc để tránh hiểu nhầm.
  const showAreaFilter = ctx?.isStaff !== true;

  // Cascade khu vực → toà nhà: chỉ list các toà thuộc khu vực đang chọn
  const buildings = useMemo(() => {
    if (!filters.area_id) return allBuildings;
    return (allBuildings as any[]).filter((b) => b.area_id === filters.area_id);
  }, [allBuildings, filters.area_id]);

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

  const handleAreaChange = (value: string) => {
    const areaId = value === ALL_VALUE ? undefined : value;
    update({ area_id: areaId, building_id: undefined, room_id: undefined, room_ids: undefined });
  };

  const handleBuildingChange = (value: string) => {
    const buildingId = value === ALL_VALUE ? undefined : value;
    update({ building_id: buildingId, room_id: undefined, room_ids: undefined });
  };

  // Lọc theo TÊN phòng (gộp phòng cùng tên ở mọi toà nhà → 1 lựa chọn).
  const handleRoomChange = (name: string) => {
    update({
      room_id: undefined,
      room_ids: name === ALL_VALUE ? undefined : roomIdsByName(rooms as any[], name),
    });
  };

  const roomValue =
    roomNameFromIds(rooms as any[], filters.room_ids) ??
    (filters.room_id
      ? (rooms as any[]).find((r) => r.id === filters.room_id)?.name
      : undefined) ??
    ALL_VALUE;

  const handlePaymentStatusChange = (value: string) => {
    update({
      payment_status:
        value === ALL_VALUE
          ? undefined
          : (value as 'paid' | 'unpaid' | 'partial'),
    });
  };

  // Mặc định = 'active' (loại CANCELLED) khi user chưa chọn.
  const viewStatusValue = filters.view_status ?? 'active';
  const handleViewStatusChange = (value: string) => {
    update({ view_status: value as 'active' | 'cancelled' | 'all' });
  };

  const handleMonthSelect = (month: number) => {
    const monthStr = `${pickerYear}-${String(month).padStart(2, '0')}`;
    update({ billing_month: monthStr });
    setMonthPickerOpen(false);
  };

  const triggerClass = compact ? 'h-9 text-sm flex-1 min-w-0' : 'h-9 text-sm w-[150px]';
  const roomTriggerClass = compact ? 'h-9 text-sm flex-1 min-w-0' : 'h-9 text-sm w-[140px]';
  const monthTriggerClass = compact
    ? 'h-9 text-sm flex-1 min-w-0 justify-start font-normal px-2'
    : 'h-9 text-sm w-[160px] justify-start font-normal';

  return (
    <div className={compact ? 'flex flex-nowrap items-center gap-2 px-3 pt-3' : 'flex flex-wrap items-center gap-2 mb-4'}>
      {/* Chọn khu vực — ẩn cho staff */}
      {!compact && showAreaFilter && (
        <SearchableSelect
          value={filters.area_id ?? ALL_VALUE}
          onValueChange={handleAreaChange}
          className="h-9 text-sm w-[150px]"
          placeholder="Chọn khu vực"
          options={[
            { value: ALL_VALUE, label: 'Tất cả khu vực' },
            ...(areas as any[]).map((a) => ({ value: a.id, label: a.name })),
          ]}
        />
      )}

      {/* Chọn toà nhà */}
      <SearchableSelect
        value={filters.building_id ?? ALL_VALUE}
        onValueChange={handleBuildingChange}
        className={triggerClass}
        placeholder="Chọn toà nhà"
        options={[
          { value: ALL_VALUE, label: compact ? 'Tất cả' : 'Tất cả toà nhà' },
          ...buildings.map((b: any) => ({ value: b.id, label: b.name })),
        ]}
      />

      {/* Chọn phòng — gộp theo tên (nhiều toà cùng "101" → 1 mục) */}
      <SearchableSelect
        value={roomValue}
        onValueChange={handleRoomChange}
        className={roomTriggerClass}
        placeholder="Chọn phòng"
        options={[
          { value: ALL_VALUE, label: compact ? 'Tất cả' : 'Tất cả phòng' },
          ...uniqueRoomNames(rooms as any[]).map((n) => ({ value: n, label: n })),
        ]}
      />

      {/* Trạng thái hoá đơn: Đã duyệt (mặc định, ẩn HĐ huỷ) / Đã huỷ / Tất cả */}
      {!compact && (
        <SearchableSelect
          value={viewStatusValue}
          onValueChange={handleViewStatusChange}
          className="h-9 text-sm w-[140px]"
          placeholder="Trạng thái"
          options={[
            { value: 'active', label: 'Đã duyệt' },
            { value: 'cancelled', label: 'Đã huỷ' },
            { value: 'all', label: 'Tất cả' },
          ]}
        />
      )}

      {/* Trạng thái thanh toán */}
      {!compact && (
        <SearchableSelect
          value={filters.payment_status ?? ALL_VALUE}
          onValueChange={handlePaymentStatusChange}
          className="h-9 text-sm w-[170px]"
          placeholder="Trạng thái TT"
          options={[
            { value: ALL_VALUE, label: 'Tất cả' },
            { value: 'paid', label: 'Đã thanh toán' },
            { value: 'partial', label: 'TT 1 phần' },
            { value: 'unpaid', label: 'Chưa thanh toán' },
          ]}
        />
      )}

      {/* Chọn tháng - Custom Month Picker */}
      <Popover open={monthPickerOpen} onOpenChange={setMonthPickerOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" className={monthTriggerClass}>
            {!compact && <Calendar className="h-4 w-4 mr-2 shrink-0 text-muted-foreground" />}
            <span className="truncate">
              {filters.billing_month
                ? `Th${selectedMonth}/${selectedYear}`
                : 'Chọn tháng'}
            </span>
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
