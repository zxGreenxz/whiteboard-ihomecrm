import { useRef, useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useDeleteCustomer } from '@/hooks/useCustomers';
import { recordWriteMessage } from '@/lib/recordWriteOutcome';

interface DeleteCustomerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  customerId: string;
  customerName: string;
  onSuccess?: () => void;
}

/**
 * DeleteCustomerDialog
 * Confirm dialog with warning if customer has active contracts
 * Soft-delete via useDeleteCustomer
 * Toast "Dữ liệu đã được XOÁ thành công"
 * Requirements: 5.3, 5.4, 5.5
 */
export default function DeleteCustomerDialog({
  open,
  onOpenChange,
  customerId,
  customerName,
  onSuccess,
}: DeleteCustomerDialogProps) {
  const deleteMutation = useDeleteCustomer();
  const [failure, setFailure] = useState('');
  const busy = useRef(false);
  useEffect(() => { setFailure(''); }, [customerId]);
  // Đợt 8 (luật 5): xoá mềm theo mã lặp lại được (đã xoá thì máy chủ báo thành công), nên lỗi nào cũng chỉ báo, không khoá nút.
  const handleDelete = async () => {
    if (busy.current || deleteMutation.isPending) return;
    busy.current = true;
    try {
      await deleteMutation.mutateAsync(customerId);
      onOpenChange(false);
      onSuccess?.();
    } catch (error) {
      setFailure(recordWriteMessage(error, 'xoá khách hàng'));
    } finally { busy.current = false; }
  };

  return (
    <AlertDialog open={open} onOpenChange={next => { if (!deleteMutation.isPending && !busy.current) onOpenChange(next); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Xác nhận xoá khách hàng</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3">
              <p>
                Bạn có chắc chắn muốn xoá khách hàng <span className="font-medium text-foreground">{customerName}</span>?
              </p>
              {failure && <p role="alert" className="text-destructive">{failure}</p>}
              <p className="text-sm text-muted-foreground">
                Thao tác này không thể hoàn tác.
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={deleteMutation.isPending}>
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
