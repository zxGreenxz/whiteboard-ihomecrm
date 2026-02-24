import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useDeleteVehicle } from '@/hooks/useVehicles';

interface DeleteVehicleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  vehicleId: string;
  vehicleName: string;
  onSuccess?: () => void;
}

/**
 * DeleteVehicleDialog
 * Confirm dialog + soft-delete via useDeleteVehicle
 * Toast "Dữ liệu đã được XOÁ thành công" (handled by hook)
 * Requirements: 12.1, 12.2, 12.3
 */
export default function DeleteVehicleDialog({
  open,
  onOpenChange,
  vehicleId,
  vehicleName,
  onSuccess,
}: DeleteVehicleDialogProps) {
  const deleteMutation = useDeleteVehicle();

  const handleDelete = () => {
    deleteMutation.mutate(vehicleId, {
      onSuccess: () => {
        onOpenChange(false);
        onSuccess?.();
      },
    });
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Xác nhận xoá phương tiện</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3">
              <p>
                Bạn có chắc chắn muốn xoá phương tiện{' '}
                <span className="font-medium text-foreground">{vehicleName}</span>?
              </p>
              <p className="text-sm text-muted-foreground">
                Thao tác này không thể hoàn tác.
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={deleteMutation.isPending}
          >
            Huỷ
          </Button>
          <Button
            variant="destructive"
            onClick={handleDelete}
            disabled={deleteMutation.isPending}
          >
            {deleteMutation.isPending ? 'Đang xoá...' : 'Xoá'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
