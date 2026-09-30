import { useRef, useState } from 'react';
import { recordWriteBlocked, recordWriteMessage } from '@/lib/recordWriteOutcome';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Trash2, X } from 'lucide-react';
import { useBulkDeleteMeterReadings } from '@/hooks/useMeterReadings';

interface MeterReadingActionsProps {
  selectedIds: string[];
  onClearSelection: () => void;
}

const MeterReadingActions = ({
  selectedIds,
  onClearSelection,
}: MeterReadingActionsProps) => {
  const [isBulkDeleteOpen, setIsBulkDeleteOpen] = useState(false);
  const [failure, setFailure] = useState('');
  const [blocked, setBlocked] = useState(false);
  const busy = useRef(false);

  const bulkDeleteMutation = useBulkDeleteMeterReadings();

  if (selectedIds.length === 0) return null;

  const handleBulkDeleteConfirm = () => {
    if (busy.current || blocked || bulkDeleteMutation.isPending) return;
    busy.current = true;
    setFailure('');
    bulkDeleteMutation.mutate(selectedIds, {
      onSuccess: () => {
        onClearSelection();
        setIsBulkDeleteOpen(false);
        busy.current = false;
      },
      onError: (error) => {
        setFailure(recordWriteMessage(error, 'xoá chỉ số hàng loạt'));
        setBlocked(recordWriteBlocked(error));
        busy.current = false;
      },
      onSettled: () => { busy.current = false; },
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

      <AlertDialog open={isBulkDeleteOpen} onOpenChange={(open) => {
        if (!busy.current && !bulkDeleteMutation.isPending) setIsBulkDeleteOpen(open);
      }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Xác nhận xoá hàng loạt</AlertDialogTitle>
            <AlertDialogDescription>
              Bạn có chắc chắn muốn xoá {selectedIds.length} chỉ số đã chọn không?
            </AlertDialogDescription>
          </AlertDialogHeader>
          {failure && <p role="alert" className="text-sm text-destructive">{failure}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel>Hủy</AlertDialogCancel>
            <Button
              type="button"
              onClick={handleBulkDeleteConfirm}
              disabled={bulkDeleteMutation.isPending || blocked}
              className="bg-red-600 hover:bg-red-700"
            >
              Xoá
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};

export default MeterReadingActions;
