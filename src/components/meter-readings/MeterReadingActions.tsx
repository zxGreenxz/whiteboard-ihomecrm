import { Button } from '@/components/ui/button';
import { CheckCircle, Trash2, X } from 'lucide-react';
import type { MeterReadingDetailed } from '@/hooks/useMeterReadings';

interface MeterReadingActionsProps {
  selectedIds: string[];
  selectedReadings: MeterReadingDetailed[];
  onBulkApprove: () => void;
  onBulkDelete: () => void;
  onClearSelection: () => void;
}

const MeterReadingActions = ({
  selectedIds,
  selectedReadings,
  onBulkApprove,
  onBulkDelete,
  onClearSelection,
}: MeterReadingActionsProps) => {
  if (selectedIds.length === 0) return null;

  const unapprovedCount = selectedReadings.filter(
    (r) => r.status === 'UNAPPROVED',
  ).length;

  return (
    <div className="flex items-center gap-2 rounded-lg border bg-muted/50 px-4 py-2">
      <span className="text-sm text-muted-foreground mr-2">
        Đã chọn {selectedIds.length} mục
      </span>

      <Button size="sm" variant="outline" onClick={onBulkApprove}>
        <CheckCircle className="h-4 w-4 mr-1 text-green-600" />
        Duyệt ({selectedIds.length})
      </Button>

      <Button
        size="sm"
        variant="outline"
        onClick={onBulkDelete}
        disabled={unapprovedCount === 0}
        className={unapprovedCount > 0 ? 'text-red-600 hover:text-red-700' : ''}
      >
        <Trash2 className="h-4 w-4 mr-1" />
        Xoá ({unapprovedCount})
      </Button>

      <Button size="sm" variant="ghost" onClick={onClearSelection}>
        <X className="h-4 w-4 mr-1" />
        Bỏ chọn
      </Button>
    </div>
  );
};

export default MeterReadingActions;
