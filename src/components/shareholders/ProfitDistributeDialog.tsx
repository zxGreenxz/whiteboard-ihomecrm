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
import { useCreateProfitDistribution } from "@/hooks/useIncomeExpenses";
import type { Shareholder } from "@/hooks/useShareholders";
import { format } from "date-fns";

interface Props {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  shareholders: Shareholder[];
  defaultShareholderId?: string | null;
}

export default function ProfitDistributeDialog({
  open,
  onOpenChange,
  shareholders,
  defaultShareholderId,
}: Props) {
  const { data: accounts = [] } = useAccounts();
  const createMut = useCreateProfitDistribution();
  const payoutAccounts = accounts.filter((account) => !account.is_virtual);

  const [shareholderId, setShareholderId] = useState("");
  const [amount, setAmount] = useState(0);
  const [accountId, setAccountId] = useState("");
  const [voucherDate, setVoucherDate] = useState(format(new Date(), "yyyy-MM-dd"));
  const [note, setNote] = useState("");

  useEffect(() => {
    if (open) {
      setShareholderId(defaultShareholderId ?? "");
      setAmount(0);
      setAccountId("");
      setVoucherDate(format(new Date(), "yyyy-MM-dd"));
      setNote("");
    }
  }, [open, defaultShareholderId]);

  const canSubmit =
    !!shareholderId &&
    amount > 0 &&
    payoutAccounts.some((account) => account.id === accountId) &&
    !!voucherDate &&
    !createMut.isPending;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    const sh = shareholders.find((s) => s.id === shareholderId);
    await createMut.mutateAsync({
      shareholder_id: shareholderId,
      shareholder_name: sh?.name,
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
          <DialogTitle>Chi lợi nhuận cổ đông</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label>Cổ đông <span className="text-red-500">*</span></Label>
            <SearchableSelect
              value={shareholderId}
              onValueChange={setShareholderId}
              placeholder="Chọn cổ đông"
              options={shareholders.map((s) => ({ value: s.id, label: s.name }))}
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
              options={payoutAccounts.map((a) => ({
                value: a.id,
                label: a.name,
                keywords: a.code,
              }))}
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
