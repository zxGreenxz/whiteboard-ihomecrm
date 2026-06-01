import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useUpdateDeposit, type DepositWithRelations } from "@/hooks/useDeposits";
import { useNavigate } from "react-router-dom";
import { formatCurrency, formatDate } from "@/lib/utils";

interface ConvertToContractDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  deposit: DepositWithRelations;
}

export function ConvertToContractDialog({
  open,
  onOpenChange,
  deposit,
}: ConvertToContractDialogProps) {
  const updateDeposit = useUpdateDeposit();
  const navigate = useNavigate();

  const handleConvert = async () => {
    try {
      // Update deposit status to CONVERTED
      await updateDeposit.mutateAsync({
        id: deposit.id,
        status: "CONVERTED",
      });

      // Navigate to create contract page with deposit info as state
      navigate("/contracts/create", {
        state: {
          depositId: deposit.id,
          tenantId: deposit.tenant_id,
          roomId: deposit.room_id,
          depositAmount: deposit.amount,
        },
      });

      onOpenChange(false);
    } catch (error) {
      console.error("Failed to convert deposit:", error);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Chuyển sang Hợp đồng</DialogTitle>
          <DialogDescription>
            Xác nhận chuyển đổi phiếu đặt cọc thành hợp đồng thuê
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <h4 className="font-medium">Thông tin đặt cọc:</h4>
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div className="text-muted-foreground">Khách hàng:</div>
              <div className="font-medium">{deposit.tenant?.full_name}</div>

              <div className="text-muted-foreground">Số điện thoại:</div>
              <div>{deposit.tenant?.phone}</div>

              <div className="text-muted-foreground">Căn hộ:</div>
              <div>{deposit.room?.name}</div>

              <div className="text-muted-foreground">Số tiền cọc:</div>
              <div className="font-medium text-green-600">
                {formatCurrency(deposit.amount)}
              </div>

              <div className="text-muted-foreground">Ngày đặt cọc:</div>
              <div>{deposit.deposit_date ? formatDate(deposit.deposit_date) : "-"}</div>
            </div>
          </div>

          <div className="border-t pt-4">
            <p className="text-sm text-muted-foreground">
              Sau khi xác nhận, phiếu đặt cọc sẽ được chuyển sang trạng thái{" "}
              <span className="font-medium">Đã chuyển HĐ</span> và bạn sẽ được chuyển đến
              trang tạo hợp đồng với thông tin đã điền sẵn.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Hủy
          </Button>
          <Button onClick={handleConvert} disabled={updateDeposit.isPending}>
            {updateDeposit.isPending ? "Đang xử lý..." : "Tạo hợp đồng"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
