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
import { useDeleteBed } from "@/hooks/useBeds";
import type { Database } from "@/integrations/supabase/types";

type Bed = Database["public"]["Tables"]["beds"]["Row"];

interface DeleteBedDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bed: Bed;
}

export function DeleteBedDialog({
  open,
  onOpenChange,
  bed,
}: DeleteBedDialogProps) {
  const deleteBed = useDeleteBed();

  const handleDelete = async () => {
    try {
      await deleteBed.mutateAsync(bed.id);
      onOpenChange(false);
    } catch (error) {
      // Error is handled by the mutation
      // Don't close dialog if there's an error
    }
  };

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat("vi-VN", {
      style: "currency",
      currency: "VND",
    }).format(amount);
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Xác nhận xóa giường</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <p>
                Bạn có chắc chắn muốn xóa giường{" "}
                <span className="font-semibold">{bed.name}</span>?
              </p>
              <div className="bg-muted rounded-md p-3 text-sm space-y-1">
                {bed.code && (
                  <p>
                    <span className="font-medium">Mã giường:</span> {bed.code}
                  </p>
                )}
                <p>
                  <span className="font-medium">Giá thuê:</span>{" "}
                  {formatCurrency(bed.rent_price)}/tháng
                </p>
                <p>
                  <span className="font-medium">Tiền cọc:</span>{" "}
                  {formatCurrency(bed.deposit_amount)}
                </p>
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
            disabled={deleteBed.isPending}
            className="bg-destructive hover:bg-destructive/90"
          >
            {deleteBed.isPending ? "Đang xóa..." : "Xóa"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
