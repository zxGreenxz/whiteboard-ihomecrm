import { useState } from 'react';
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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import EmptyState from '@/components/ui/EmptyState';
import { Gauge, Pencil, Trash2 } from 'lucide-react';
import { useDeleteMeter } from '@/hooks/useMeters';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const METER_TYPE_LABELS: Record<string, string> = {
  ELECTRICITY: 'Điện',
  WATER: 'Nước',
  GAS: 'Gas',
};

const STATUS_LABELS: Record<string, string> = {
  ACTIVE: 'Hoạt động',
  INACTIVE: 'Ngừng',
  BROKEN: 'Hỏng',
  REMOVED: 'Đã gỡ',
};

const STATUS_VARIANTS: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  ACTIVE: 'default',
  INACTIVE: 'secondary',
  BROKEN: 'destructive',
  REMOVED: 'outline',
};

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface MeterListProps {
  meters: any[];
  onEdit: (meter: any) => void;
  isLoading?: boolean;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const MeterList = ({ meters, onEdit, isLoading }: MeterListProps) => {
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const deleteMeter = useDeleteMeter();

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteMeter.mutateAsync(deleteTarget);
    } finally {
      setDeleteTarget(null);
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-2">
        {[1, 2, 3, 4, 5].map((i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  }

  if (!meters || meters.length === 0) {
    return (
      <EmptyState
        icon={Gauge}
        title="Chưa có công tơ nào"
        description="Hãy thêm công tơ đầu tiên để bắt đầu quản lý"
      />
    );
  }

  return (
    <>
      <div className="bg-white rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Mã công tơ</TableHead>
              <TableHead>Tên công tơ</TableHead>
              <TableHead>Loại công tơ</TableHead>
              <TableHead>Phòng</TableHead>
              <TableHead>Tòa nhà</TableHead>
              <TableHead>Trạng thái</TableHead>
              <TableHead>Chỉ số gần nhất</TableHead>
              <TableHead className="text-right">Thao tác</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {meters.map((meter) => (
              <TableRow key={meter.id}>
                <TableCell className="font-medium">{meter.code}</TableCell>
                <TableCell>{meter.name || '—'}</TableCell>
                <TableCell>
                  <Badge variant="secondary">
                    {METER_TYPE_LABELS[meter.meter_type] || meter.meter_type}
                  </Badge>
                </TableCell>
                <TableCell>{meter.room_name || '—'}</TableCell>
                <TableCell>{meter.building_name || '—'}</TableCell>
                <TableCell>
                  <Badge variant={STATUS_VARIANTS[meter.status] || 'outline'}>
                    {STATUS_LABELS[meter.status] || meter.status}
                  </Badge>
                </TableCell>
                <TableCell>
                  {meter.latest_reading != null
                    ? Number(meter.latest_reading).toLocaleString('vi-VN')
                    : '—'}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => onEdit(meter)}
                      title="Sửa"
                    >
                      <Pencil className="h-4 w-4 text-purple-600" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setDeleteTarget(meter.id)}
                      title="Xoá"
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Delete Confirmation Dialog */}
      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Xác nhận xoá</AlertDialogTitle>
            <AlertDialogDescription>
              Bạn đang thực hiện thao tác xoá công tơ. Bạn có chắc chắn muốn xoá không?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Hủy</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              disabled={deleteMeter.isPending}
              className="bg-red-600 hover:bg-red-700"
            >
              {deleteMeter.isPending ? 'Đang xoá...' : 'Xoá'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};

export default MeterList;
