import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { CurrencyInput } from "@/components/ui/currency-input";
import { DateInput } from "@/components/ui/date-input";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { useAccounts } from "@/hooks/useAccounts";
import { useCreateManagerSalaryPayout } from "@/hooks/useIncomeExpenses";
import type { ProfitManager } from "@/hooks/useProfitManagers";
import { format } from "date-fns";

interface Props {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  managers: ProfitManager[];
  defaultManagerId?: string | null;
}

export default function ManagerSalaryPayoutDialog({
  open,
  onOpenChange,
  managers,
  defaultManagerId,
}: Props) {
  const { data: accounts = [] } = useAccounts();
  const createMut = useCreateManagerSalaryPayout();

  const [managerId, setManagerId] = useState("");
  const [amount, setAmount] = useState(0);
  const [accountId, setAccountId] = useState("");
  const [voucherDate, setVoucherDate] = useState(format(new Date(), "yyyy-MM-dd"));
  const [note, setNote] = useState("");

  useEffect(() => {
    if (open) {
      setManagerId(defaultManagerId ?? "");
      setAmount(0);
      setAccountId("");
      setVoucherDate(format(new Date(), "yyyy-MM-dd"));
      setNote("");
    }
  }, [open, defaultManagerId]);

  const canSubmit =
    !!managerId && amount > 0 && !!accountId && !!voucherDate && !createMut.isPending;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    const m = managers.find((x) => x.id === managerId);
    await createMut.mutateAsync({
      manager_id: managerId,
      manager_name: m?.name,
      amount,
      account_id: accountId,
      voucher_date: voucherDate,
      note: note.trim() || null,
    });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>Chi lương điều hành</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label>Quản lý <span className="text-red-500">*</span></Label>
            <SearchableSelect
              value={managerId}
              onValueChange={setManagerId}
              placeholder="Chọn quản lý"
              options={managers.map((m) => ({ value: m.id, label: m.name }))}
            />
          </div>
          <div className="space-y-2">
            <Label>Số tiền <span className="text-red-500">*</span></Label>
            <CurrencyInput value={amount} onChange={setAmount} />
          </div>
          <div className="space-y-2">
            <Label>Chi từ sổ quỹ <span className="text-red-500">*</span></Label>
            <SearchableSelect
              value={accountId}
              onValueChange={setAccountId}
              placeholder="Chọn sổ quỹ nguồn"
              options={accounts.map((a) => ({ value: a.id, label: a.name, keywords: a.code }))}
            />
          </div>
          <div className="space-y-2">
            <Label>Ngày <span className="text-red-500">*</span></Label>
            <DateInput value={voucherDate} onChange={setVoucherDate} />
          </div>
          <div className="space-y-2">
            <Label>Ghi chú</Label>
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Huỷ</Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {createMut.isPending ? "Đang ghi..." : "Ghi phiếu chi"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
