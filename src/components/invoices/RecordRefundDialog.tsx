import { useEffect, useMemo, useState } from 'react';
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
import { Input } from '@/components/ui/input';
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

const formatVN = (n: number) => (n > 0 ? n.toLocaleString('vi-VN') : '');
const parseVN = (s: string): number => {
  const digits = s.replace(/\D/g, '');
  return digits ? parseInt(digits, 10) : 0;
};

const formatCurrency = (n: number) =>
  new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(n);

const RecordRefundDialog = ({ open, onOpenChange, invoice }: RecordRefundDialogProps) => {
  const refund = useRecordRefundRPC();
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
    if (!invoice) return;
    await refund.mutateAsync({
      invoice_id: invoice.id,
      amount: data.amount,
      payment_date: data.payment_date,
      account_id: data.account_id,
      notes: data.notes,
    });
    handleClose();
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

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
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
            <Label>Số tiền hoàn trả *</Label>
            <Input
              type="text"
              inputMode="numeric"
              value={formatVN(watchedAmount || 0)}
              onChange={(e) =>
                setValue('amount', parseVN(e.target.value), { shouldValidate: true })
              }
              placeholder="0"
            />
            {errors.amount && (
              <p className="text-sm text-red-500">{errors.amount.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="payment_date">Ngày hoàn trả *</Label>
            <DateInput
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
              <SelectTrigger>
                <SelectValue placeholder="Chọn sổ quỹ trừ tiền" />
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
              Sẽ tạo phiếu chi (PC) trong Thu chi của sổ quỹ này.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="notes">Ghi chú</Label>
            <Textarea id="notes" rows={2} {...register('notes')} />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={handleClose}>
              Hủy
            </Button>
            <Button
              type="submit"
              className="bg-orange-600 hover:bg-orange-700"
              disabled={refund.isPending}
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
