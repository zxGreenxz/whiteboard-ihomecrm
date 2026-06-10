import { useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { DepositWithRelations } from "@/hooks/useDeposits";
import {
  ContractFormDialog,
  type ContractPrefill,
} from "@/components/contracts/ContractFormDialog";
import { formatCurrency, formatDate } from "@/lib/utils";

interface ConvertToContractDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  deposit: DepositWithRelations;
}

/**
 * Chuyển phiếu giữ chỗ → Hợp đồng: mở thẳng ContractFormDialog với thông tin
 * prefill (toà/phòng/tiền cọc). Phiếu giữ chỗ CHỈ chuyển CONVERTED sau khi HĐ
 * tạo thành công (ContractFormDialog tự flip qua prefill.depositId) — trước
 * đây flip TRƯỚC rồi navigate tới route /contracts/create không tồn tại:
 * trang lỗi + phòng mất cờ RESERVED và lộ ra trang Phòng trống công khai.
 */
export function ConvertToContractDialog({
  open,
  onOpenChange,
  deposit,
}: ConvertToContractDialogProps) {
  const [contractFormOpen, setContractFormOpen] = useState(false);

  // Prefill PHẢI stable (ContractFormDialog reset form theo identity của nó).
  const prefill = useMemo<ContractPrefill>(
    () => ({
      buildingId: deposit.room?.building?.id,
      roomId: deposit.room_id ?? undefined,
      depositId: deposit.id,
      depositAmount: deposit.amount,
    }),
    [deposit.id, deposit.room_id, deposit.room?.building?.id, deposit.amount],
  );

  const handleConfirm = () => {
    onOpenChange(false);
    setContractFormOpen(true);
  };

  return (
    <>
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
                <div>
                  {deposit.deposit_date ? formatDate(deposit.deposit_date) : "-"}
                </div>
              </div>
            </div>

            <div className="border-t pt-4">
              <p className="text-sm text-muted-foreground">
                Form tạo hợp đồng sẽ mở với toà/phòng/tiền cọc điền sẵn. Phiếu
                đặt cọc chỉ chuyển sang trạng thái{" "}
                <span className="font-medium">Đã chuyển HĐ</span>{" "}
                <span className="font-medium">sau khi</span> hợp đồng được tạo
                thành công.
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Hủy
            </Button>
            <Button onClick={handleConfirm}>Tạo hợp đồng</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ContractFormDialog
        open={contractFormOpen}
        onOpenChange={setContractFormOpen}
        prefill={prefill}
      />
    </>
  );
}
