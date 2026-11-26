import { useEffect, useRef, useState } from 'react';
import { recordWriteMessage } from '@/lib/recordWriteOutcome';
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
  const [failure,setFailure]=useState<unknown>(null);
  const busy=useRef(false);
  useEffect(()=>{setFailure(null);},[vehicleId]);

  // Đợt 8 (luật 5): xoá mềm xe lặp lại được — kết quả chưa rõ chỉ báo (kèm mã), nút Xoá không khoá, bấm lại gửi lần nữa.
  const handleDelete = () => {
    if (busy.current || deleteMutation.isPending) return;
    busy.current=true;setFailure(null);
    deleteMutation.mutate(vehicleId, {
      onSuccess: () => {
        busy.current=false;onOpenChange(false);
        onSuccess?.();
      },
      onError: (error) => {busy.current=false;setFailure(error);},
      onSettled: () => {busy.current=false;},
    });
  };

  return (
    <AlertDialog open={open} onOpenChange={value=>{if(!busy.current&&!deleteMutation.isPending)onOpenChange(value);}}>
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
        {Boolean(failure) && <p role="alert" className="text-sm text-destructive">{recordWriteMessage(failure,'xoá phương tiện')}</p>}
        <AlertDialogFooter>
          <Button
            variant="outline"
            onClick={() => {if(!busy.current)onOpenChange(false);}}
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
