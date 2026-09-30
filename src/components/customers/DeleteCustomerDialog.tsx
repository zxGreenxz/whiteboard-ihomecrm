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
import { recordWriteBlocked, recordWriteMessage } from '@/lib/recordWriteOutcome';

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
  const [blocked, setBlocked] = useState(false);
  const busy = useRef(false);
  useEffect(() => { setFailure(''); setBlocked(false); }, [customerId]);
  const handleDelete = async () => {
    if (busy.current || blocked || deleteMutation.isPending) return;
    busy.current = true;
    try {
      await deleteMutation.mutateAsync(customerId);
      onOpenChange(false);
      onSuccess?.();
    } catch (error) {
      setFailure(recordWriteMessage(error, 'xoá khách hàng'));
      setBlocked(recordWriteBlocked(error));
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
            disabled={deleteMutation.isPending || blocked}
          >
            {deleteMutation.isPending ? 'Đang xoá...' : 'Xoá'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
