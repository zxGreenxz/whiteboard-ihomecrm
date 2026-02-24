import { useState } from 'react';
import { Button } from '@/components/ui/button';
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
import { CheckCircle, Trash2, X } from 'lucide-react';
import {
  useBulkApproveMeterReadings,
  useBulkDeleteMeterReadings,
} from '@/hooks/useMeterReadings';

interface MeterReadingActionsProps {
  selectedIds: string[];
  onClearSelection: () => void;
}

const MeterReadingActions = ({
  selectedIds,
  onClearSelection,
}: MeterReadingActionsProps) => {
  const [isBulkDeleteOpen, setIsBulkDeleteOpen] = useState(false);

  const bulkApproveMutation = useBulkApproveMeterReadings();
  const bulkDeleteMutation = useBulkDeleteMeterReadings();

  if (selectedIds.length === 0) return null;

  const handleBulkApprove = () => {
    bulkApproveMutation.mutate(selectedIds, {
      onSuccess: () => onClearSelection(),
    });
  };

  const handleBulkDeleteConfirm = () => {
    bulkDeleteMutation.mutate(selectedIds, {
      onSuccess: () => {
        onClearSelection();
        setIsBulkDeleteOpen(false);
      },
    });
  };

  return (
    <>
      <div className="flex items-center gap-2 rounded-lg border bg-muted/50 px-4 py-2">
        <span className="text-sm text-muted-foreground mr-2">
          Đã chọn {selectedIds.length} mục
        </span>

        <Button
          size="sm"
          variant="outline"
          onClick={handleBulkApprove}
          disabled={bulkApproveMutation.isPending}
        >
          <CheckCircle className="h-4 w-4 mr-1 text-green-600" />
          Duyệt hàng loạt
        </Button>

        <Button
          size="sm"
          variant="outline"
          onClick={() => setIsBulkDeleteOpen(true)}
          disabled={bulkDeleteMutation.isPending}
          className="text-red-600 hover:text-red-700"
        >
          <Trash2 className="h-4 w-4 mr-1" />
          Xoá hàng loạt
        </Button>

        <Button size="sm" variant="ghost" onClick={onClearSelection}>
          <X className="h-4 w-4 mr-1" />
          Bỏ chọn
        </Button>
      </div>

      <AlertDialog open={isBulkDeleteOpen} onOpenChange={setIsBulkDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Xác nhận xoá hàng loạt</AlertDialogTitle>
            <AlertDialogDescription>
              Bạn có chắc chắn muốn xoá {selectedIds.length} chỉ số đã chọn
              không? Chỉ các chỉ số chưa duyệt (UNAPPROVED) mới bị xoá, các
              chỉ số đã duyệt sẽ được bỏ qua.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Hủy</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleBulkDeleteConfirm}
              className="bg-red-600 hover:bg-red-700"
            >
              Xoá
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};

export default MeterReadingActions;
