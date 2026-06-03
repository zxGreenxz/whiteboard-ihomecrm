import { useEffect, useState } from "react";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { CurrencyInput } from "@/components/ui/currency-input";
import { DateInput } from "@/components/ui/date-input";
import { cn } from "@/lib/utils";
import { format } from "date-fns";
import {
  useCreatePersonalTransaction,
  useUpdatePersonalTransaction,
  type PersonalTransaction,
} from "@/hooks/usePersonalTransactions";

const CATEGORIES = ["Ăn uống", "Nhà cửa", "Cá nhân", "Ứng công ty", "Khác"];

interface Props {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  txn: PersonalTransaction | null;
}

export default function PersonalTxnDialog({ open, onOpenChange, txn }: Props) {
  const isEdit = !!txn;
  const createMut = useCreatePersonalTransaction();
  const updateMut = useUpdatePersonalTransaction();

  const [type, setType] = useState<"INCOME" | "EXPENSE">("EXPENSE");
  const [amount, setAmount] = useState(0);
  const [txnDate, setTxnDate] = useState(format(new Date(), "yyyy-MM-dd"));
  const [category, setCategory] = useState("");
  const [description, setDescription] = useState("");

  useEffect(() => {
    if (open) {
      setType(txn?.type ?? "EXPENSE");
      setAmount(txn?.amount ?? 0);
      setTxnDate(txn?.txn_date ?? format(new Date(), "yyyy-MM-dd"));
      setCategory(txn?.category ?? "");
      setDescription(txn?.description ?? "");
    }
  }, [open, txn]);

  const canSubmit = amount > 0 && !!txnDate && !createMut.isPending && !updateMut.isPending;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    const values = {
      type, amount, txn_date: txnDate,
      category: category.trim() || null,
      description: description.trim() || null,
    };
    if (isEdit && txn) await updateMut.mutateAsync({ id: txn.id, values });
    else await createMut.mutateAsync(values);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Sửa khoản" : "Thêm khoản"}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setType("INCOME")}
              className={cn("rounded-lg border py-2 text-sm font-medium", type === "INCOME" ? "border-emerald-500 bg-emerald-50 text-emerald-700" : "text-muted-foreground")}
            >
              Thu
            </button>
            <button
              type="button"
              onClick={() => setType("EXPENSE")}
              className={cn("rounded-lg border py-2 text-sm font-medium", type === "EXPENSE" ? "border-red-500 bg-red-50 text-red-700" : "text-muted-foreground")}
            >
              Chi
            </button>
          </div>

          <div className="space-y-2">
            <Label>Số tiền <span className="text-red-500">*</span></Label>
            <CurrencyInput value={amount} onChange={setAmount} />
          </div>

          <div className="space-y-2">
            <Label>Ngày <span className="text-red-500">*</span></Label>
            <DateInput value={txnDate} onChange={setTxnDate} />
          </div>

          <div className="space-y-2">
            <Label>Danh mục</Label>
            <Input
              list="personal-categories"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder="VD: Ăn uống, Nhà cửa..."
            />
            <datalist id="personal-categories">
              {CATEGORIES.map((c) => <option key={c} value={c} />)}
            </datalist>
          </div>

          <div className="space-y-2">
            <Label>Mô tả</Label>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Huỷ</Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {createMut.isPending || updateMut.isPending ? "Đang lưu..." : "Lưu"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
