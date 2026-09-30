import {CurrencyInput} from '@/components/ui/currency-input';
import {FinancialWorkflowError,workflowErrorMessage} from '@/lib/financialWorkflow';
import { focusFirstError } from '@/lib/formErrors';
import { invoiceFailureMessage } from '@/lib/invoiceFeedback';
import { voucherOutcomeUnknown } from '@/lib/voucherFeedback';
import { useEffect, useMemo, useState, useRef } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { DateInput } from '@/components/ui/date-input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useRecordRefundRPC } from '@/hooks/useInvoicePayments';
import { useAccounts } from '@/hooks/useAccounts';
import type { InvoiceWithRelations } from '@/types/invoice';
import { ArrowDownCircle, Loader2 } from 'lucide-react';
import { todayISO } from '@/lib/collect';

interface RecordRefundDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  invoice: InvoiceWithRelations | null;
}

const formSchema = z.object({
  amount: z.number().min(1, 'Số tiền phải > 0'),
  payment_date: z.string().min(1, 'Vui lòng chọn ngày'),
  account_id: z.string().min(1, 'Vui lòng chọn sổ quỹ chi'),
  notes: z.string().optional(),
});
type FormData = z.infer<typeof formSchema>;

const formatCurrency = (n: number) =>
  new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(n);

const RecordRefundDialog = ({ open, onOpenChange, invoice }: RecordRefundDialogProps) => {
  const refund = useRecordRefundRPC();
  const formRef=useRef<HTMLFormElement>(null);
  const [submitError,setSubmitError]=useState<string|null>(null);
  const [reconcileRequired,setReconcileRequired]=useState(false);
  const [receipts,setReceipts]=useState<readonly {id:string;label:string}[]>([]);
  useEffect(()=>{setSubmitError(null);setReconcileRequired(false);setReceipts([]);},[invoice?.id]);
  const { data: accounts = [] } = useAccounts();

  // Outstanding for negative-total invoice = abs(total - paid).
  // total = -700, paid = 0 → outstanding = 700 (chủ phải hoàn 700).
  const outstanding = invoice
    ? Math.max(0, (invoice.paid_amount || 0) - (invoice.total_amount || 0))
    : 0;

  const defaultAccountId = useMemo(() => {
    if (!invoice || !accounts.length) return '';
    const buildingName = invoice.building?.name?.trim();
    if (!buildingName) return '';
    return (accounts as any[]).find((a) => a.name?.trim() === buildingName)?.id ?? '';
  }, [invoice, accounts]);

  const {
    handleSubmit,
    register,
    setValue,
    watch,
    reset,
    formState: { errors },
  } = useForm<FormData>({
    resolver: zodResolver(formSchema),
    shouldFocusError:false,
    defaultValues: {
      amount: 0,
      payment_date: todayISO(),
      account_id: '',
      notes: '',
    },
  });

  useEffect(() => {
    if (open && invoice && outstanding > 0) {
      setValue('amount', outstanding);
    }
  }, [open, invoice, outstanding, setValue]);

  useEffect(() => {
    if (defaultAccountId) setValue('account_id', defaultAccountId);
  }, [defaultAccountId, setValue]);

  const handleClose = () => {
    reset();
    onOpenChange(false);
  };

  const onSubmit = async (data: FormData) => {
    if (!invoice || reconcileRequired) return;
    setSubmitError(null);
    try {
    await refund.mutateAsync({
      invoice_id: invoice.id,
      amount: data.amount,
      payment_date: data.payment_date,
      account_id: data.account_id,
      notes: data.notes,
    });
    handleClose();
    } catch(error) {
      setSubmitError(error instanceof FinancialWorkflowError?workflowErrorMessage(error,'lập phiếu hoàn trả'):invoiceFailureMessage(error,"lập phiếu hoàn trả"));
      if(error instanceof FinancialWorkflowError){setReceipts(error.completed);if(error.outcome!=='failure')setReconcileRequired(true);}
      else if(voucherOutcomeUnknown(error))setReconcileRequired(true);
    }
  };

  if (!invoice) return null;

  const watchedAmount = watch('amount');

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowDownCircle className="h-5 w-5 text-orange-600" />
            Hoàn trả khách
          </DialogTitle>
          <DialogDescription>Hoá đơn: {invoice.invoice_number}</DialogDescription>
        </DialogHeader>

        <form ref={formRef} noValidate onSubmit={handleSubmit(onSubmit,errors=>{void focusFirstError(errors,{root:formRef.current});})} className="space-y-4">
          <div className="bg-orange-50 border border-orange-200 p-4 rounded-md space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-600">Tổng hoá đơn:</span>
              <span className="font-medium text-red-600">
                {formatCurrency(invoice.total_amount || 0)}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-600">Đã hoàn trả:</span>
              <span className="font-medium">
                {formatCurrency(Math.max(0, -(invoice.paid_amount || 0)))}
              </span>
            </div>
            <div className="flex justify-between border-t pt-2">
              <span className="font-medium">Còn phải hoàn:</span>
              <span className="font-bold text-orange-700">
                {formatCurrency(outstanding)}
              </span>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="refund-amount">Số tiền hoàn trả *</Label>
            <CurrencyInput
              id="refund-amount" name="amount" aria-invalid={!!errors.amount}
              value={watchedAmount}
              onChange={value=>setValue('amount',value,{shouldValidate:true,shouldDirty:true})}
              placeholder="0"
            />
            {errors.amount && (
              <p className="text-sm text-red-500">{errors.amount.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="payment_date">Ngày hoàn trả *</Label>
            <DateInput
              id="payment_date" name="payment_date" aria-invalid={!!errors.payment_date}
              value={watch('payment_date') || ''}
              onChange={(v) => setValue('payment_date', v, { shouldValidate: true, shouldDirty: true })}
            />
            {errors.payment_date && (
              <p className="text-sm text-red-500">{errors.payment_date.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label>Sổ quỹ chi *</Label>
            <Select
              value={watch('account_id')}
              onValueChange={(v) => setValue('account_id', v, { shouldValidate: true })}
            >
              <SelectTrigger name="account_id" aria-invalid={!!errors.account_id}>
                <SelectValue placeholder="Chọn sổ quỹ chi" />
              </SelectTrigger>
              <SelectContent>
                {(accounts as any[]).map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name}
                    {a.bank_name ? ` — ${a.bank_name}` : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {errors.account_id && (
              <p className="text-sm text-red-500">{errors.account_id.message}</p>
            )}
            <p className="text-xs text-muted-foreground">
              Đây là bước lập yêu cầu hoàn tiền. Chưa thực hiện chi; kiểm tra sổ quỹ khi duyệt và chi phiếu.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="notes">Ghi chú</Label>
            <Textarea id="notes" rows={2} {...register('notes')} />
          </div>

          {submitError && <p role="alert" className="text-sm text-destructive">{submitError}</p>}
          {receipts.map(receipt=><a key={receipt.id} className="block text-sm underline" href={`/income-expenses?id=${encodeURIComponent(receipt.id)}`}>Mở phiếu {receipt.id}</a>)}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={handleClose}>
              Hủy
            </Button>
            <Button
              type="submit"
              className="bg-orange-600 hover:bg-orange-700"
              disabled={refund.isPending || reconcileRequired}
            >
              {refund.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Lập phiếu chi
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

export default RecordRefundDialog;
