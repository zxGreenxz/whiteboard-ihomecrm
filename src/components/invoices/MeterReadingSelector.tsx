/**
 * MeterReadingSelector - Component for selecting approved meter readings
 * when adding electricity/water service items to an invoice.
 *
 * Requirements: 9.1, 9.2, 9.3
 * - Only APPROVED meter readings are selectable
 * - Auto-calculates amount = consumption × unit_price
 * - Shows "Chốt công tơ" button if no approved readings exist for room/month
 */
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Zap, Droplet, Gauge } from 'lucide-react';
import { useMeterReadingsList } from '@/hooks/useMeterReadings';
import type { MeterReadingDetailed } from '@/hooks/useMeterReadings';
import {
  getApprovedReadingsForInvoice,
  calculateInvoiceAmount,
} from '@/hooks/useMeterReadingsHelpers';
import type { MeterReadingForInvoice } from '@/hooks/useMeterReadingsHelpers';

/** Extended type for display in the selector dropdown */
interface ReadingForSelector extends MeterReadingForInvoice {
  meter_type: 'ELECTRICITY' | 'WATER' | 'GAS' | 'OTHER';
  consumption: number;
  current_reading: number;
  previous_reading: number;
  meter_name: string;
  meter_code: string;
  reading_code: string;
}

export interface MeterReadingSelectorProps {
  /** The room ID to filter readings for */
  roomId: string;
  /** The settlement month in YYYY-MM format */
  month: string;
  /** The meter type: ELECTRICITY or WATER */
  meterType: 'ELECTRICITY' | 'WATER';
  /** The unit price for the service */
  unitPrice: number;
  /** Currently selected reading ID */
  selectedReadingId?: string;
  /** Callback when a reading is selected */
  onSelect: (reading: {
    readingId: string;
    consumption: number;
    amount: number;
    description: string;
  }) => void;
}

const METER_TYPE_ICONS = {
  ELECTRICITY: Zap,
  WATER: Droplet,
};

const METER_TYPE_LABELS = {
  ELECTRICITY: 'Điện',
  WATER: 'Nước',
};

const METER_TYPE_UNITS = {
  ELECTRICITY: 'kWh',
  WATER: 'm³',
};

export default function MeterReadingSelector({
  roomId,
  month,
  meterType,
  unitPrice,
  selectedReadingId,
  onSelect,
}: MeterReadingSelectorProps) {
  const navigate = useNavigate();
  const Icon = METER_TYPE_ICONS[meterType];
  const label = METER_TYPE_LABELS[meterType];
  const unit = METER_TYPE_UNITS[meterType];

  // Query approved readings for this room and month
  const { data: readingsData, isLoading } = useMeterReadingsList(
    {
      room_id: roomId,
      month: month,
      status: 'APPROVED',
      meter_type: meterType,
    },
    { page: 1, pageSize: 100 }
  );

  const approvedReadings = useMemo(() => {
    if (!readingsData?.data) return [];
    // Use the pure helper to filter (double-check client-side)
    const asForInvoice: ReadingForSelector[] = readingsData.data.map((r) => ({
      id: r.id,
      status: r.status,
      room_id: r.room_id,
      settlement_month: r.settlement_month,
      meter_type: r.meter_type,
      consumption: r.consumption,
      current_reading: r.current_reading,
      previous_reading: r.previous_reading,
      meter_name: r.meter_name,
      meter_code: r.meter_code,
      reading_code: r.reading_code,
    }));
    return getApprovedReadingsForInvoice(asForInvoice, roomId, month);
  }, [readingsData?.data, roomId, month]);

  const handleSelect = (readingId: string) => {
    const reading = approvedReadings.find((r) => r.id === readingId);
    if (!reading) return;

    const amount = calculateInvoiceAmount(reading.consumption, unitPrice);
    onSelect({
      readingId: reading.id,
      consumption: reading.consumption,
      amount,
      description: `${label} (${reading.previous_reading} → ${reading.current_reading}): ${reading.consumption} ${unit}`,
    });
  };

  const handleNavigateToMeterReadings = () => {
    navigate('/meter-readings');
  };

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Icon className="h-4 w-4 animate-pulse" />
        Đang tải chỉ số {label.toLowerCase()}...
      </div>
    );
  }

  // No approved readings: show "Chốt công tơ" button (Requirement 9.3)
  if (approvedReadings.length === 0) {
    return (
      <div className="flex items-center gap-3 p-3 bg-amber-50 border border-amber-200 rounded-md">
        <Icon className="h-4 w-4 text-amber-600" />
        <span className="text-sm text-amber-800 flex-1">
          Chưa có chỉ số {label.toLowerCase()} đã duyệt cho tháng {month}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleNavigateToMeterReadings}
          className="border-amber-300 text-amber-700 hover:bg-amber-100"
        >
          <Gauge className="h-4 w-4 mr-1" />
          Chốt công tơ
        </Button>
      </div>
    );
  }

  // Has approved readings: show selector (Requirement 9.1)
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">Chọn chỉ số {label.toLowerCase()} đã duyệt</span>
        <Badge variant="secondary" className="text-xs">
          {approvedReadings.length} chỉ số
        </Badge>
      </div>
      <Select value={selectedReadingId} onValueChange={handleSelect}>
        <SelectTrigger>
          <SelectValue placeholder={`Chọn chỉ số ${label.toLowerCase()}...`} />
        </SelectTrigger>
        <SelectContent>
          {approvedReadings.map((reading) => {
            const amount = calculateInvoiceAmount(reading.consumption, unitPrice);
            return (
              <SelectItem key={reading.id} value={reading.id}>
                <div className="flex items-center gap-2">
                  <span className="font-medium">
                    {reading.reading_code}
                  </span>
                  <span className="text-muted-foreground">
                    ({reading.previous_reading} → {reading.current_reading})
                  </span>
                  <span className="font-medium">
                    {reading.consumption} {unit}
                  </span>
                  {unitPrice > 0 && (
                    <span className="text-muted-foreground">
                      = {new Intl.NumberFormat('vi-VN').format(amount)}đ
                    </span>
                  )}
                </div>
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
    </div>
  );
}
