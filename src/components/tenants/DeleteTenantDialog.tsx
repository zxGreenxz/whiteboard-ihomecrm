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
import { useDeleteTenant } from "@/hooks/useTenants";
import type { Database } from "@/integrations/supabase/types";

type Tenant = Database["public"]["Tables"]["tenants"]["Row"];

interface DeleteTenantDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenant: Tenant;
}

export function DeleteTenantDialog({
  open,
  onOpenChange,
  tenant,
}: DeleteTenantDialogProps) {
  const deleteTenant = useDeleteTenant();

  const handleDelete = async () => {
    try {
      await deleteTenant.mutateAsync(tenant.id);
      onOpenChange(false);
    } catch (error) {
      // Error is handled by the mutation
    }
  };

  const getStatusLabel = (status: string) => {
    const labels: Record<string, string> = {
      PROSPECT: "Tiềm năng",
      DEPOSITED: "Đã đặt cọc",
      ACTIVE: "Đang thuê",
      MOVED_OUT: "Đã chuyển đi",
      BLACKLISTED: "Danh sách đen",
    };
    return labels[status] || status;
  };

  const formatDate = (dateString: string | null) => {
    if (!dateString) return "-";
    return new Date(dateString).toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" });
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Xác nhận xóa khách hàng</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <p>
                Bạn có chắc chắn muốn xóa khách hàng{" "}
                <span className="font-semibold">{tenant.full_name}</span>?
              </p>
              <div className="bg-muted rounded-md p-3 text-sm space-y-1">
                {tenant.phone && (
                  <p>
                    <span className="font-medium">SĐT:</span> {tenant.phone}
                  </p>
                )}
                {tenant.email && (
                  <p>
                    <span className="font-medium">Email:</span> {tenant.email}
                  </p>
                )}
                {tenant.id_number && (
                  <p>
                    <span className="font-medium">CCCD/CMND:</span> {tenant.id_number}
                  </p>
                )}
                {tenant.date_of_birth && (
                  <p>
                    <span className="font-medium">Ngày sinh:</span> {formatDate(tenant.date_of_birth)}
                  </p>
                )}
                <p>
                  <span className="font-medium">Trạng thái:</span> {getStatusLabel(tenant.status)}
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
            disabled={deleteTenant.isPending}
            className="bg-destructive hover:bg-destructive/90"
          >
            {deleteTenant.isPending ? "Đang xóa..." : "Xóa"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
