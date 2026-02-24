import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

interface ApproveConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  isLoading?: boolean;
  count?: number;
}

export function ApproveConfirmDialog({
  open,
  onOpenChange,
  onConfirm,
  isLoading,
  count,
}: ApproveConfirmDialogProps) {
  const isBulk = count !== undefined && count > 1;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Xác nhận duyệt hoá đơn</AlertDialogTitle>
          <AlertDialogDescription>
            {isBulk
              ? `Bạn đang thực hiện thao tác DUYỆT ${count} hoá đơn. Sau khi duyệt, hoá đơn sẽ không thể chỉnh sửa. Bạn có chắc chắn muốn tiếp tục?`
              : "Bạn đang thực hiện thao tác DUYỆT hoá đơn. Sau khi duyệt, hoá đơn sẽ không thể chỉnh sửa. Bạn có chắc chắn muốn tiếp tục?"}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isLoading}>Huỷ</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm} disabled={isLoading}>
            {isLoading ? "Đang duyệt..." : "Duyệt"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
