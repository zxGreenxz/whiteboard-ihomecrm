import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DateInput } from "@/components/ui/date-input";
import { Button } from "@/components/ui/button";
import { useLockAccount, type AccountWithBalance } from "@/hooks/useAccounts";

interface CashbookLockDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  account: AccountWithBalance | null;
}

const todayISO = () => new Date().toISOString().slice(0, 10);

const CashbookLockDialog = ({
  open,
  onOpenChange,
  account,
}: CashbookLockDialogProps) => {
  const [lockDate, setLockDate] = useState<string>(todayISO());
  const lockMut = useLockAccount();

  useEffect(() => {
    if (open) setLockDate(account?.lock_date?.slice(0, 10) ?? todayISO());
  }, [open, account]);

  const handleSubmit = async () => {
    if (!account) return;
    await lockMut.mutateAsync({ id: account.id, lock_date: lockDate });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Khoá sổ quỹ</DialogTitle>
          <DialogDescription>
            Sau khi khoá, mọi phiếu thu/chi của sổ quỹ{" "}
            <span className="font-medium">
              {account?.name} ({account?.code})
            </span>{" "}
            có ngày phát sinh ≤ ngày khoá sổ sẽ <b>không thể</b> sửa, xoá
            hoặc lập mới.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <label className="text-sm font-medium">Ngày khoá sổ</label>
          <DateInput value={lockDate} onChange={setLockDate} />
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={lockMut.isPending}
          >
            Huỷ bỏ
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={lockMut.isPending || !lockDate}
          >
            {lockMut.isPending ? "Đang lưu..." : "Lưu"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default CashbookLockDialog;
