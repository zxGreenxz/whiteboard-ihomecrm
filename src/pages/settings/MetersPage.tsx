import { useState } from 'react';
import MainLayout from '@/components/layout/MainLayout';
import MeterList from '@/components/meters/MeterList';
import MeterForm from '@/components/meters/MeterForm';
import { useDeleteMeter, type MeterWithRoom } from '@/hooks/useMeters';
import { useBuildings } from '@/hooks/useBuildings';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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
import { Plus } from 'lucide-react';

const METER_TYPE_OPTIONS = [
  { value: 'ELECTRICITY', label: 'Điện' },
  { value: 'WATER', label: 'Nước' },
  { value: 'GAS', label: 'Gas' },
] as const;

export default function MetersPage() {
  const [buildingFilter, setBuildingFilter] = useState<string | null>(null);
  const [meterTypeFilter, setMeterTypeFilter] = useState<string | null>(null);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingMeter, setEditingMeter] = useState<MeterWithRoom | null>(null);
  const [deletingMeterId, setDeletingMeterId] = useState<string | null>(null);

  const { data: buildings } = useBuildings();
  const deleteMeter = useDeleteMeter();

  const handleEdit = (meter: MeterWithRoom) => {
    setEditingMeter(meter);
    setIsFormOpen(true);
  };

  const handleDelete = (meterId: string) => {
    setDeletingMeterId(meterId);
  };

  const confirmDelete = async () => {
    if (!deletingMeterId) return;
    try {
      await deleteMeter.mutateAsync(deletingMeterId);
    } finally {
      setDeletingMeterId(null);
    }
  };

  const handleFormClose = (open: boolean) => {
    setIsFormOpen(open);
    if (!open) setEditingMeter(null);
  };

  return (
    <MainLayout>
      <div className="space-y-4">
        {/* Breadcrumb */}
        <div className="text-sm text-muted-foreground">
          Cài đặt hệ thống &gt; Danh mục khác &gt; Tài chính &gt;{' '}
          <span className="text-foreground font-medium">Đồng hồ Công tơ</span>
        </div>

        {/* Toolbar */}
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => { setEditingMeter(null); setIsFormOpen(true); }}>
            <Plus className="h-4 w-4 mr-1" />
            Thêm
          </Button>
        </div>

        {/* Filters */}
        <div className="flex items-center gap-3">
          <Select
            value={buildingFilter ?? 'ALL'}
            onValueChange={(v) => setBuildingFilter(v === 'ALL' ? null : v)}
          >
            <SelectTrigger className="w-[200px]">
              <SelectValue placeholder="Chọn tòa nhà" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">Tất cả tòa nhà</SelectItem>
              {(buildings || []).map((b) => (
                <SelectItem key={b.id} value={b.id}>
                  {b.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select
            value={meterTypeFilter ?? 'ALL'}
            onValueChange={(v) => setMeterTypeFilter(v === 'ALL' ? null : v)}
          >
            <SelectTrigger className="w-[200px]">
              <SelectValue placeholder="Loại công tơ" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">Tất cả loại</SelectItem>
              {METER_TYPE_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Meter List */}
        <MeterList
          buildingId={buildingFilter ?? undefined}
          meterType={meterTypeFilter ?? undefined}
          onEdit={handleEdit}
          onDelete={handleDelete}
        />

        {/* Meter Form Dialog */}
        <MeterForm
          open={isFormOpen}
          onOpenChange={handleFormClose}
          meter={editingMeter}
        />

        {/* Delete Confirmation Dialog */}
        <AlertDialog
          open={!!deletingMeterId}
          onOpenChange={(open) => { if (!open) setDeletingMeterId(null); }}
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
      </div>
    </MainLayout>
  );
}
