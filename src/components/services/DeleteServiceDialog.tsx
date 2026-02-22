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
import { useDeleteService } from "@/hooks/useServices";
import type { Database } from "@/integrations/supabase/types";

type Service = Database["public"]["Tables"]["services"]["Row"];

interface DeleteServiceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  service: Service;
}

export function DeleteServiceDialog({
  open,
  onOpenChange,
  service,
}: DeleteServiceDialogProps) {
  const deleteService = useDeleteService();

  const handleDelete = async () => {
    try {
      await deleteService.mutateAsync(service.id);
      onOpenChange(false);
    } catch (error) {
      // Error is handled by the mutation
    }
  };

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat("vi-VN", {
      style: "currency",
      currency: "VND",
    }).format(amount);
  };

  const getServiceTypeLabel = (type: string) => {
    const labels: Record<string, string> = {
      FIXED: "Cố định",
      PER_PERSON: "Theo người",
      PER_ROOM: "Theo căn hộ",
      METER_READING: "Theo chỉ số",
    };
    return labels[type] || type;
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Xác nhận xóa dịch vụ</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <p>
                Bạn có chắc chắn muốn xóa dịch vụ{" "}
                <span className="font-semibold">{service.name}</span>?
              </p>
              <div className="bg-muted rounded-md p-3 text-sm space-y-1">
                {service.code && (
                  <p>
                    <span className="font-medium">Mã dịch vụ:</span> {service.code}
                  </p>
                )}
                <p>
                  <span className="font-medium">Loại:</span> {getServiceTypeLabel(service.type)}
                </p>
                <p>
                  <span className="font-medium">Đơn giá:</span> {formatCurrency(service.unit_price)}
                  {service.unit && ` / ${service.unit}`}
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
            disabled={deleteService.isPending}
            className="bg-destructive hover:bg-destructive/90"
          >
            {deleteService.isPending ? "Đang xóa..." : "Xóa"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
