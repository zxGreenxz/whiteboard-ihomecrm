import { useEffect, useState, useRef } from "react";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { CurrencyInput } from "@/components/ui/currency-input";
import { DateInput } from "@/components/ui/date-input";
import { cn } from "@/lib/utils";
import { format } from "date-fns";
import { focusFirstError } from "@/lib/formErrors";
import { recordWriteBlocked, recordWriteMessage } from '@/lib/recordWriteOutcome';
import { validateInputDrafts } from '@/lib/inputDraftValidation';
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
  const root=useRef<HTMLDivElement|null>(null);
  const draftKey=useRef<string|null>(null);
  const dirty=useRef(false);
  const submitting=useRef(false);
  const [saving,setSaving]=useState(false);
  const [blocked,setBlocked]=useState(false);
  const createMut = useCreatePersonalTransaction();
  const updateMut = useUpdatePersonalTransaction();

  const [type, setType] = useState<"INCOME" | "EXPENSE">("EXPENSE");
  const [amount, setAmount] = useState(0);
  const [txnDate, setTxnDate] = useState(format(new Date(), "yyyy-MM-dd"));
  const [category, setCategory] = useState("");
  const [description, setDescription] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      const key=txn?.id??'create';
      if(draftKey.current===key && (serverError || dirty.current || blocked))return;
      draftKey.current=key;dirty.current=false;setBlocked(false);
      setFieldErrors({});
      setServerError(null);
      setType(txn?.type ?? "EXPENSE");
      setAmount(txn?.amount ?? 0);
      setTxnDate(txn?.txn_date ?? format(new Date(), "yyyy-MM-dd"));
      setCategory(txn?.category ?? "");
      setDescription(txn?.description ?? "");
    }
  }, [open, txn]);

  const isPending = createMut.isPending || updateMut.isPending;

  const handleSubmit = async () => {
    if (isPending || submitting.current || blocked) return;
    if(!validateInputDrafts(root.current))return;
    const errors: Record<string, string> = {};
    if (!Number.isFinite(amount) || amount <= 0) errors.amount = 'Số tiền phải lớn hơn 0.';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(txnDate) || Number.isNaN(Date.parse(txnDate))) errors.txn_date = 'Chọn ngày giao dịch hợp lệ.';
    setFieldErrors(errors);
    if (Object.keys(errors).length) { void focusFirstError(errors); return; }
    setServerError(null);
    submitting.current=true;setSaving(true);
    const values = {
      type, amount, txn_date: txnDate,
      category: category.trim() || null,
      description: description.trim() || null,
    };
    try {
      if (isEdit && txn) await updateMut.mutateAsync({ id: txn.id, values });
      else await createMut.mutateAsync(values);
      draftKey.current=null;dirty.current=false;
      onOpenChange(false);
    } catch (error) {
      setBlocked(recordWriteBlocked(error));
      setServerError(recordWriteMessage(error,'lưu khoản trong ví cá nhân'));
    } finally {
      submitting.current=false;setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={value=>{if(!isPending&&!saving)onOpenChange(value);}}>
      <DialogContent ref={root} className="sm:max-w-[420px]" onChangeCapture={()=>{dirty.current=true;}}>
        <DialogHeader>
          <DialogTitle>{isEdit ? "Sửa khoản" : "Thêm khoản"}</DialogTitle>
          <DialogDescription className="sr-only">Lưu khoản thu hoặc chi trong ví cá nhân của bạn.</DialogDescription>
        </DialogHeader>

        <fieldset disabled={blocked || isPending || saving} className="space-y-4 py-2">
          {serverError && <p role="alert" className="text-sm text-destructive">{serverError}</p>}
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

          <div className="space-y-2" data-field-name="amount">
            <Label>Số tiền <span className="text-red-500">*</span></Label>
            <CurrencyInput value={amount} onChange={setAmount} />
            {fieldErrors.amount && <p role="alert" className="text-sm text-destructive">{fieldErrors.amount}</p>}
          </div>

          <div className="space-y-2" data-field-name="txn_date">
            <Label>Ngày <span className="text-red-500">*</span></Label>
            <DateInput value={txnDate} onChange={setTxnDate} />
            {fieldErrors.txn_date && <p role="alert" className="text-sm text-destructive">{fieldErrors.txn_date}</p>}
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
        </fieldset>

        <DialogFooter>
          <Button disabled={isPending || saving} variant="outline" onClick={() => onOpenChange(false)}>Huỷ</Button>
          <Button onClick={() => { void handleSubmit(); }} disabled={blocked || isPending || saving}>
            {createMut.isPending || updateMut.isPending ? "Đang lưu..." : "Lưu"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
