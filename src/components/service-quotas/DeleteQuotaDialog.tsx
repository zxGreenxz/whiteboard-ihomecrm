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
import { useDeleteServiceQuota } from "@/hooks/useServices";
import type { ServiceQuotaWithTiers } from "@/hooks/useServices";

interface DeleteQuotaDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  quota: ServiceQuotaWithTiers;
}

export function DeleteQuotaDialog({
  open,
  onOpenChange,
  quota,
}: DeleteQuotaDialogProps) {
  const deleteMutation = useDeleteServiceQuota();

  const handleDelete = async () => {
    try {
      await deleteMutation.mutateAsync(quota.id);
      onOpenChange(false);
    } catch {
      // handled by mutation
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Xác nhận xóa định mức</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <p>
                Bạn có chắc chắn muốn xóa định mức{" "}
                <span className="font-semibold">{quota.name}</span>?
              </p>
              <div className="bg-muted rounded-md p-3 text-sm space-y-1">
                <p>
                  <span className="font-medium">Tên:</span> {quota.name}
                </p>
                <p>
                  <span className="font-medium">Số bậc:</span>{" "}
                  {quota.service_quota_tiers?.length || 0}
                </p>
                {quota.description && (
                  <p>
                    <span className="font-medium">Mô tả:</span>{" "}
                    {quota.description}
                  </p>
                )}
              </div>
              <p className="text-sm text-muted-foreground mt-2">
                Hành động này không thể hoàn tác.
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Hủy</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleDelete}
            disabled={deleteMutation.isPending}
            className="bg-destructive hover:bg-destructive/90"
          >
            {deleteMutation.isPending ? "Đang xóa..." : "Xóa"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
