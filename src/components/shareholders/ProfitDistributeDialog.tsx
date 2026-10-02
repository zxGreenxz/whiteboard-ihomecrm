import { validateInputDrafts } from "@/lib/inputDraftValidation";
import { QueryRegion } from "@/components/errors/QueryRegion";
import { focusFirstError } from "@/lib/formErrors";
import { voucherFailureMessage, voucherOutcomeUnknown } from "@/lib/voucherFeedback";
import { useEffect, useRef, useState } from "react";
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
  const accountsQuery = useAccounts();
  const {data:accounts=[]} = accountsQuery;
  const createMut = useCreateProfitDistribution();
  const payoutAccounts = accounts.filter((account) => !account.is_virtual);

  const [shareholderId, setShareholderId] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);
  const [errors,setErrors] = useState<Record<string,string>>({});
  const [serverError,setServerError] = useState('');
  const [saveBlocked,setSaveBlocked] = useState(false);
  const [amount, setAmount] = useState(0);
  const [accountId, setAccountId] = useState("");
  const [voucherDate, setVoucherDate] = useState(format(new Date(), "yyyy-MM-dd"));
  const [note, setNote] = useState("");

  useEffect(() => {
    if (open && !saveBlocked) {
      setErrors({}); setServerError('');
      setShareholderId(defaultShareholderId ?? "");
      setAmount(0);
      setAccountId("");
      setVoucherDate(format(new Date(), "yyyy-MM-dd"));
      setNote("");
    }
  }, [open, defaultShareholderId, saveBlocked]);


  const handleSubmit = async () => {
    if (createMut.isPending || saveBlocked) return;
    const next:Record<string,string>={};
    if(!shareholderId) next.shareholderId='Chọn cổ đông nhận khoản chi.';
    if(!Number.isFinite(amount)||amount<=0) next.amount='Nhập số tiền lớn hơn 0.';
    if(!payoutAccounts.some(a=>a.id===accountId&&a.organization_id)) next.accountId='Chọn sổ quỹ chi hợp lệ.';
    if(!voucherDate) next.voucherDate='Chọn ngày chi.';
    setErrors(next);setServerError('');
    if(Object.keys(next).length){await focusFirstError(next,{root:dialogRef.current});return;}
    if (!validateInputDrafts(dialogRef.current)) return;
    try {
    const sh = shareholders.find((s) => s.id === shareholderId);
    await createMut.mutateAsync({
      shareholder_id: shareholderId,
      shareholder_name: sh?.name,
      amount,
      account_id: accountId,
      organizationId: accounts.find(account=>account.id===accountId)!.organization_id!,
      voucher_date: voucherDate,
      note: note.trim() || null,
    });
    onOpenChange(false);
    } catch(error) {
      setServerError(voucherFailureMessage(error,'lập phiếu chi lợi nhuận'));
      if(voucherOutcomeUnknown(error)) setSaveBlocked(true);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent ref={dialogRef} className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>Chi lợi nhuận cổ đông</DialogTitle>
        </DialogHeader>

        <QueryRegion label="sổ quỹ chi" queries={[accountsQuery]} skeleton="detail" rows={5}>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label>Cổ đông <span className="text-red-500">*</span></Label>
            <SearchableSelect
              name="shareholderId" aria-invalid={!!errors.shareholderId} aria-describedby="error-shareholderId"
              value={shareholderId}
              onValueChange={setShareholderId}
              placeholder="Chọn cổ đông"
              options={shareholders.map((s) => ({ value: s.id, label: s.name }))}
            />
          </div>
          <div className="space-y-2">
            <Label>Số tiền <span className="text-red-500">*</span></Label>
            <CurrencyInput name="amount" aria-invalid={!!errors.amount} aria-describedby="error-amount" value={amount} onChange={setAmount} />
          </div>
          <div className="space-y-2">
            <Label>Chi từ sổ quỹ <span className="text-red-500">*</span></Label>
            <SearchableSelect
              name="accountId" aria-invalid={!!errors.accountId} aria-describedby="error-accountId"
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
            <DateInput name="voucherDate" aria-invalid={!!errors.voucherDate} aria-describedby="error-voucherDate" value={voucherDate} onChange={setVoucherDate} />
          </div>
          <div className="space-y-2">
            <Label>Ghi chú</Label>
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
          </div>
        </div>
        {Object.entries(errors).map(([key,message])=><p id={`error-${key}`} key={key} className="text-sm text-destructive">{message}</p>)}
        {serverError && <p role="alert" className="rounded border border-destructive p-3 text-sm text-destructive">{serverError}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Huỷ</Button>
          <Button onClick={handleSubmit} disabled={createMut.isPending || saveBlocked}>
            {createMut.isPending ? "Đang ghi..." : "Ghi phiếu chi"}
          </Button>
        </DialogFooter>
        </QueryRegion>
      </DialogContent>
    </Dialog>
  );
}
