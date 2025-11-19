import { useEffect } from 'react';
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
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useRecordPayment, type InvoiceWithRelations } from '@/hooks/useInvoices';
import { DollarSign, CreditCard, Banknote, Smartphone, CheckCircle } from 'lucide-react';
import { format } from 'date-fns';
import { vi } from 'date-fns/locale';

interface RecordPaymentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  invoice: InvoiceWithRelations | null;
}

const paymentSchema = z.object({
  amount: z.number().min(1, 'Số tiền phải lớn hơn 0'),
  payment_method: z.enum(['CASH', 'BANK_TRANSFER', 'MOMO', 'ZALO_PAY', 'VNPAY', 'OTHER']),
  payment_date: z.string().min(1, 'Vui lòng chọn ngày thanh toán'),
  notes: z.string().optional(),
});

type PaymentFormData = z.infer<typeof paymentSchema>;

const RecordPaymentDialog = ({ open, onOpenChange, invoice }: RecordPaymentDialogProps) => {
  const recordMutation = useRecordPayment();

  const {
    register,
    handleSubmit,
    formState: { errors },
    setValue,
    watch,
    reset,
  } = useForm<PaymentFormData>({
    resolver: zodResolver(paymentSchema),
    defaultValues: {
      payment_method: 'CASH',
      payment_date: new Date().toISOString().split('T')[0],
    },
  });

  const watchedAmount = watch('amount');
  const watchedPaymentMethod = watch('payment_method');

  const outstandingAmount = invoice ? (invoice.total_amount || 0) - (invoice.paid_amount || 0) : 0;

  // Auto-fill amount with outstanding amount when dialog opens
  useEffect(() => {
    if (invoice && outstandingAmount > 0) {
      setValue('amount', outstandingAmount);
    }
  }, [invoice, outstandingAmount, setValue]);

  const handleClose = () => {
    reset();
    onOpenChange(false);
  };

  const onSubmit = (data: PaymentFormData) => {
    if (!invoice) return;

    if (data.amount > outstandingAmount) {
      alert(`Số tiền thanh toán không được vượt quá số tiền còn lại (${formatCurrency(outstandingAmount)})`);
      return;
    }

    recordMutation.mutate(
      {
        invoice_id: invoice.id,
        ...data,
      },
      {
        onSuccess: () => {
          handleClose();
        },
      }
    );
  };

  if (!invoice) return null;

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('vi-VN', {
      style: 'currency',
      currency: 'VND',
    }).format(amount);
  };

  const newPaidAmount = (invoice.paid_amount || 0) + (watchedAmount || 0);
  const newOutstanding = (invoice.total_amount || 0) - newPaidAmount;
  const willBePaid = newOutstanding <= 0;
  const willBePartialPaid = newPaidAmount > 0 && newOutstanding > 0;

  const getPaymentMethodIcon = (method: string) => {
    switch (method) {
      case 'CASH':
        return <Banknote className="h-4 w-4" />;
      case 'BANK_TRANSFER':
        return <CreditCard className="h-4 w-4" />;
      case 'MOMO':
      case 'ZALO_PAY':
      case 'VNPAY':
        return <Smartphone className="h-4 w-4" />;
      default:
        return <DollarSign className="h-4 w-4" />;
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <DollarSign className="h-5 w-5 text-green-600" />
            Ghi nhận thanh toán
          </DialogTitle>
          <DialogDescription>
            Hóa đơn: {invoice.title}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          {/* Invoice Info */}
          <div className="bg-gray-50 p-4 rounded-md space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-600">Khách thuê:</span>
              <span className="font-medium">{invoice.contract?.tenant?.full_name}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-600">Kỳ thanh toán:</span>
              <span className="font-medium">
                {invoice.billing_period_start && invoice.billing_period_end && (
                  <>
                    {format(new Date(invoice.billing_period_start), 'dd/MM', { locale: vi })}
                    {' - '}
                    {format(new Date(invoice.billing_period_end), 'dd/MM/yyyy', { locale: vi })}
                  </>
                )}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-600">Tổng tiền:</span>
              <span className="font-medium">{formatCurrency(invoice.total_amount || 0)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-600">Đã thanh toán:</span>
              <span className="font-medium text-green-600">{formatCurrency(invoice.paid_amount || 0)}</span>
            </div>
            <div className="flex justify-between border-t pt-2">
              <span className="text-gray-900 font-medium">Còn lại:</span>
              <span className="font-bold text-orange-600">{formatCurrency(outstandingAmount)}</span>
            </div>
          </div>

          {/* Payment Amount */}
          <div className="space-y-2">
            <Label htmlFor="amount">Số tiền thanh toán *</Label>
            <Input
              id="amount"
              type="number"
              {...register('amount', { valueAsNumber: true })}
              placeholder="0"
            />
            {errors.amount && (
              <p className="text-sm text-red-500">{errors.amount.message}</p>
            )}
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setValue('amount', outstandingAmount)}
              >
                Toàn bộ
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setValue('amount', outstandingAmount / 2)}
              >
                1/2
              </Button>
            </div>
            {watchedAmount > outstandingAmount && (
              <Alert className="bg-red-50 border-red-200">
                <AlertDescription className="text-red-800 text-sm">
                  ⚠️ Số tiền thanh toán vượt quá số tiền còn lại!
                </AlertDescription>
              </Alert>
            )}
          </div>

          {/* Payment Method */}
          <div className="space-y-2">
            <Label>Phương thức thanh toán *</Label>
            <Select
              value={watchedPaymentMethod}
              onValueChange={(value) => setValue('payment_method', value as any)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="CASH">
                  <div className="flex items-center gap-2">
                    <Banknote className="h-4 w-4" />
                    Tiền mặt
                  </div>
                </SelectItem>
                <SelectItem value="BANK_TRANSFER">
                  <div className="flex items-center gap-2">
                    <CreditCard className="h-4 w-4" />
                    Chuyển khoản
                  </div>
                </SelectItem>
                <SelectItem value="MOMO">
                  <div className="flex items-center gap-2">
                    <Smartphone className="h-4 w-4" />
                    MoMo
                  </div>
                </SelectItem>
                <SelectItem value="ZALO_PAY">
                  <div className="flex items-center gap-2">
                    <Smartphone className="h-4 w-4" />
                    ZaloPay
                  </div>
                </SelectItem>
                <SelectItem value="VNPAY">
                  <div className="flex items-center gap-2">
                    <Smartphone className="h-4 w-4" />
                    VNPay
                  </div>
                </SelectItem>
                <SelectItem value="OTHER">Khác</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Payment Date */}
          <div className="space-y-2">
            <Label htmlFor="payment_date">Ngày thanh toán *</Label>
            <Input
              id="payment_date"
              type="date"
              {...register('payment_date')}
            />
            {errors.payment_date && (
              <p className="text-sm text-red-500">{errors.payment_date.message}</p>
            )}
          </div>

          {/* Payment Preview */}
          {watchedAmount > 0 && watchedAmount <= outstandingAmount && (
            <div className="bg-blue-50 border-2 border-blue-200 p-4 rounded-md space-y-3">
              <h4 className="font-bold text-blue-900">Sau khi thanh toán:</h4>

              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-700">Đã thanh toán:</span>
                  <span className="font-medium text-green-600">{formatCurrency(newPaidAmount)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-700">Còn lại:</span>
                  <span className={`font-medium ${newOutstanding > 0 ? 'text-orange-600' : 'text-gray-500'}`}>
                    {formatCurrency(Math.max(0, newOutstanding))}
                  </span>
                </div>
                <div className="flex justify-between border-t pt-2">
                  <span className="text-gray-700">Trạng thái mới:</span>
                  <span className="font-bold text-blue-900">
                    {willBePaid && (
                      <span className="flex items-center gap-1 text-green-600">
                        <CheckCircle className="h-4 w-4" />
                        Đã thanh toán
                      </span>
                    )}
                    {willBePartialPaid && 'Trả 1 phần'}
                  </span>
                </div>
              </div>

              {willBePaid && (
                <Alert className="bg-green-50 border-green-200">
                  <CheckCircle className="h-4 w-4 text-green-600" />
                  <AlertDescription className="text-green-800 text-sm">
                    Hóa đơn sẽ được đánh dấu là đã thanh toán đầy đủ
                  </AlertDescription>
                </Alert>
              )}
            </div>
          )}

          {/* Notes */}
          <div className="space-y-2">
            <Label htmlFor="notes">Ghi chú</Label>
            <Textarea
              id="notes"
              {...register('notes')}
              placeholder="Ghi chú về khoản thanh toán..."
              rows={3}
            />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={handleClose}
            >
              Hủy
            </Button>
            <Button
              type="submit"
              disabled={recordMutation.isPending || !watchedAmount || watchedAmount > outstandingAmount}
            >
              {recordMutation.isPending ? 'Đang ghi nhận...' : 'Ghi nhận thanh toán'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

export default RecordPaymentDialog;
