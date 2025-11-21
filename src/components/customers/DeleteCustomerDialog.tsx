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
import { useDeleteCustomer } from "@/hooks/useCustomers";
import type { Database } from "@/integrations/supabase/types";

type Customer = Database["public"]["Tables"]["customers"]["Row"];

interface DeleteCustomerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  customer: Customer;
}

export function DeleteCustomerDialog({
  open,
  onOpenChange,
  customer,
}: DeleteCustomerDialogProps) {
  const deleteCustomer = useDeleteCustomer();

  const handleDelete = async () => {
    try {
      await deleteCustomer.mutateAsync(customer.id);
      onOpenChange(false);
    } catch (error) {
      // Error is handled by the mutation
    }
  };

  const getStatusLabel = (status: string) => {
    const labels: Record<string, string> = {
      PROSPECT: "Tiềm năng",
      ACTIVE: "Đang hoạt động",
      INACTIVE: "Không hoạt động",
      BLACKLIST: "Danh sách đen",
    };
    return labels[status] || status;
  };

  const formatDate = (dateString: string | null) => {
    if (!dateString) return "-";
    return new Date(dateString).toLocaleDateString("vi-VN");
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
                <span className="font-semibold">{customer.full_name}</span>?
              </p>
              <div className="bg-muted rounded-md p-3 text-sm space-y-1">
                {customer.phone && (
                  <p>
                    <span className="font-medium">SĐT:</span> {customer.phone}
                  </p>
                )}
                {customer.email && (
                  <p>
                    <span className="font-medium">Email:</span> {customer.email}
                  </p>
                )}
                {customer.id_number && (
                  <p>
                    <span className="font-medium">CCCD/CMND:</span> {customer.id_number}
                  </p>
                )}
                {customer.date_of_birth && (
                  <p>
                    <span className="font-medium">Ngày sinh:</span> {formatDate(customer.date_of_birth)}
                  </p>
                )}
                {customer.customer_type && (
                  <p>
                    <span className="font-medium">Loại:</span>{" "}
                    {customer.customer_type === "INDIVIDUAL" ? "Cá nhân" : "Tổ chức"}
                  </p>
                )}
                <p>
                  <span className="font-medium">Trạng thái:</span> {getStatusLabel(customer.status || "PROSPECT")}
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
            disabled={deleteCustomer.isPending}
            className="bg-destructive hover:bg-destructive/90"
          >
            {deleteCustomer.isPending ? "Đang xóa..." : "Xóa"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
