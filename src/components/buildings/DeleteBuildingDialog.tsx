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
import { useDeleteBuilding } from '@/hooks/useBuildings';
import { toast } from 'sonner';
import type { BuildingWithRelations } from '@/types/building';

interface DeleteBuildingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  building: BuildingWithRelations;
}

export function DeleteBuildingDialog({
  open,
  onOpenChange,
  building,
}: DeleteBuildingDialogProps) {
  const deleteBuilding = useDeleteBuilding();
  const roomsCount = building.rooms_count || 0;
  const hasRooms = roomsCount > 0;

  const handleDelete = async () => {
    if (hasRooms) return;
    try {
      await deleteBuilding.mutateAsync(building.id);
      toast.success('Dữ liệu đã được XOÁ thành công');
      onOpenChange(false);
    } catch {
      // Error handled by mutation hook
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Xác nhận xoá toà nhà</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3">
              {hasRooms ? (
                <div className="bg-destructive/10 border border-destructive/20 rounded-md p-3 text-sm text-destructive">
                  <p className="font-semibold">⚠️ Không thể xóa tòa nhà đang có {roomsCount} căn hộ</p>
                  <p className="mt-1">
                    Vui lòng xoá hoặc chuyển tất cả căn hộ trước khi xoá toà nhà.
                  </p>
                </div>
              ) : (
                <>
                  <p>
                    Bạn có chắc chắn muốn xoá toà nhà{' '}
                    <span className="font-semibold">{building.name}</span>?
                  </p>
                  <p className="text-sm text-muted-foreground">
                    Hành động này không thể hoàn tác.
                  </p>
                </>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Huỷ</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleDelete}
            disabled={hasRooms || deleteBuilding.isPending}
            className="bg-destructive hover:bg-destructive/90"
          >
            {deleteBuilding.isPending ? 'Đang xoá...' : 'Xoá'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
