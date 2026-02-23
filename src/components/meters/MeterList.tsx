import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import EmptyState from '@/components/ui/EmptyState';
import { Gauge } from 'lucide-react';
import {
  useMetersGroupedByRoom,
  type MeterWithRoom,
} from '@/hooks/useMeters';

const METER_TYPE_LABELS: Record<string, string> = {
  ELECTRICITY: 'Điện',
  WATER: 'Nước',
  GAS: 'Gas',
  OTHER: 'Khác',
};

interface MeterListProps {
  buildingId?: string;
  meterType?: string;
  onEdit: (meter: MeterWithRoom) => void;
  onDelete: (meterId: string) => void;
}

const MeterList = ({ buildingId, meterType, onEdit, onDelete }: MeterListProps) => {
  const { data: grouped, isLoading } = useMetersGroupedByRoom(buildingId, meterType);

  if (isLoading) {
    return (
      <div className="space-y-4">
        {[1, 2, 3].map((i) => (
          <div key={i} className="border rounded-md p-4 space-y-2">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ))}
      </div>
    );
  }

  const roomKeys = Object.keys(grouped || {});

  if (roomKeys.length === 0) {
    return (
      <EmptyState
        icon={Gauge}
        title="Chưa có công tơ nào"
        description="Hãy thêm công tơ đầu tiên để bắt đầu quản lý"
      />
    );
  }

  return (
    <div className="space-y-6">
      {roomKeys.map((roomKey) => {
        const group = grouped![roomKey];
        const roomName = group.room?.name || 'Không có phòng';
        const buildingName = group.building?.name || '';

        return (
          <div key={roomKey} className="border rounded-md">
            <div className="bg-muted/50 px-4 py-3 border-b">
              <h3 className="font-semibold text-sm">
                {roomName}
                {buildingName && (
                  <span className="text-muted-foreground font-normal"> — {buildingName}</span>
                )}
              </h3>
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Mã</TableHead>
                  <TableHead>Tên</TableHead>
                  <TableHead>Loại</TableHead>
                  <TableHead>Trạng thái</TableHead>
                  <TableHead>Chỉ số gần nhất</TableHead>
                  <TableHead className="text-right">Thao tác</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {group.meters.map((meter) => (
                  <TableRow key={meter.id}>
                    <TableCell className="font-medium">{meter.code}</TableCell>
                    <TableCell>{meter.name || '—'}</TableCell>
                    <TableCell>
                      <Badge variant="secondary">
                        {METER_TYPE_LABELS[meter.meter_type] || meter.meter_type}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={meter.status === 'ACTIVE' ? 'default' : 'outline'}
                      >
                        {meter.status === 'ACTIVE' ? 'Hoạt động' : meter.status}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {meter.current_reading != null
                        ? meter.current_reading.toFixed(2)
                        : '—'}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => onEdit(meter)}
                        >
                          Sửa
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => onDelete(meter.id)}
                          className="text-destructive hover:text-destructive"
                        >
                          Xoá
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        );
      })}
    </div>
  );
};

export default MeterList;
