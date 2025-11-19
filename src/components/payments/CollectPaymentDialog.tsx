import { useState, useEffect } from 'react';
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
import { useInvoices } from '@/hooks/useInvoices';
import { useCreatePayment } from '@/hooks/usePayments';
import { DollarSign, Wallet, CreditCard, Smartphone, AlertCircle } from 'lucide-react';
import { format } from 'date-fns';
import { vi } from 'date-fns/locale';

interface CollectPaymentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const paymentSchema = z.object({
  invoice_id: z.string().min(1, 'Vui lòng chọn hóa đơn'),
  amount: z.number().min(1, 'Số tiền phải lớn hơn 0'),
  payment_method: z.enum(['CASH', 'BANK_TRANSFER', 'CARD', 'MOMO', 'ZALO_PAY', 'VNPAY']),
  payment_date: z.string().min(1, 'Vui lòng chọn ngày thanh toán'),
  notes: z.string().optional(),
});

type PaymentFormData = z.infer<typeof paymentSchema>;

const CollectPaymentDialog = ({ open, onOpenChange }: CollectPaymentDialogProps) => {
  const [searchTerm, setSearchTerm] = useState('');
  const createMutation = useCreatePayment();

  // Fetch unpaid/partially paid invoices
  const { data: allInvoices } = useInvoices();
  const unpaidInvoices = allInvoices?.filter(
    (inv) => inv.status === 'APPROVED' || inv.status === 'PARTIAL_PAID' || inv.status === 'OVERDUE'
  );

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

  const watchedInvoiceId = watch('invoice_id');
  const watchedAmount = watch('amount');
  const watchedPaymentMethod = watch('payment_method');

  const selectedInvoice = unpaidInvoices?.find((inv) => inv.id === watchedInvoiceId);
  const outstandingAmount = selectedInvoice
    ? (selectedInvoice.total_amount || 0) - (selectedInvoice.paid_amount || 0)
    : 0;

  // Auto-fill amount when invoice is selected
  useEffect(() => {
    if (selectedInvoice && outstandingAmount > 0) {
      setValue('amount', outstandingAmount);
    }
  }, [selectedInvoice, outstandingAmount, setValue]);

  const handleClose = () => {
    reset();
    setSearchTerm('');
    onOpenChange(false);
  };

  const onSubmit = (data: PaymentFormData) => {
    if (data.amount > outstandingAmount) {
      alert(`Số tiền thanh toán không được vượt quá số tiền còn lại (${formatCurrency(outstandingAmount)})`);
      return;
    }

    createMutation.mutate(data, {
      onSuccess: () => {
        handleClose();
      },
    });
  };

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('vi-VN', {
      style: 'currency',
      currency: 'VND',
    }).format(amount);
  };

  const getPaymentMethodIcon = (method: string) => {
    switch (method) {
      case 'CASH':
        return <Wallet className="h-4 w-4" />;
      case 'BANK_TRANSFER':
        return <CreditCard className="h-4 w-4" />;
      case 'CARD':
        return <CreditCard className="h-4 w-4" />;
      case 'MOMO':
      case 'ZALO_PAY':
      case 'VNPAY':
        return <Smartphone className="h-4 w-4" />;
      default:
        return <DollarSign className="h-4 w-4" />;
    }
  };

  // Filter invoices by search term
  const filteredInvoices = unpaidInvoices?.filter((invoice) => {
    const search = searchTerm.toLowerCase();
    return (
      invoice.title?.toLowerCase().includes(search) ||
      invoice.contract?.contract_number?.toLowerCase().includes(search) ||
      invoice.contract?.tenant?.full_name.toLowerCase().includes(search) ||
      invoice.contract?.tenant?.phone.includes(searchTerm)
    );
  });

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <DollarSign className="h-5 w-5" />
            Ghi nhận thanh toán
          </DialogTitle>
          <DialogDescription>
            Thu tiền từ khách hàng và cập nhật trạng thái hóa đơn
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          {/* Invoice Selection */}
          <div className="space-y-2">
            <Label>Chọn hóa đơn *</Label>
            <Input
              placeholder="Tìm theo tên khách, số hóa đơn..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="mb-2"
            />
            <Select
              value={watchedInvoiceId}
              onValueChange={(value) => setValue('invoice_id', value)}
            >
              <SelectTrigger>
                <SelectValue placeholder="Chọn hóa đơn cần thu tiền..." />
              </SelectTrigger>
              <SelectContent className="max-h-[300px]">
                {filteredInvoices && filteredInvoices.length > 0 ? (
                  filteredInvoices.map((invoice) => {
                    const outstanding = (invoice.total_amount || 0) - (invoice.paid_amount || 0);
                    return (
                      <SelectItem key={invoice.id} value={invoice.id}>
                        <div className="flex items-center justify-between w-full gap-4">
                          <div className="flex-1">
                            <div className="font-medium">{invoice.title}</div>
                            <div className="text-xs text-gray-500">
                              {invoice.contract?.tenant?.full_name} - {invoice.contract?.tenant?.phone}
                            </div>
                          </div>
                          <div className="text-right">
                            <div className="font-bold text-orange-600">
                              {formatCurrency(outstanding)}
                            </div>
                            <div className="text-xs text-gray-500">còn lại</div>
                          </div>
                        </div>
                      </SelectItem>
                    );
                  })
                ) : (
                  <div className="p-4 text-center text-gray-500 text-sm">
                    Không có hóa đơn nào cần thu tiền
                  </div>
                )}
              </SelectContent>
            </Select>
            {errors.invoice_id && (
              <p className="text-sm text-red-500">{errors.invoice_id.message}</p>
            )}
          </div>

          {/* Invoice Info */}
          {selectedInvoice && (
            <div className="bg-blue-50 border border-blue-200 p-4 rounded-md space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-600">Khách hàng:</span>
                <span className="font-medium">
                  {selectedInvoice.contract?.tenant?.full_name}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600">Phòng:</span>
                <span className="font-medium">
                  {selectedInvoice.contract?.room?.name || selectedInvoice.contract?.bed?.name}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600">Tổng hóa đơn:</span>
                <span className="font-medium">
                  {formatCurrency(selectedInvoice.total_amount || 0)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600">Đã thanh toán:</span>
                <span className="font-medium text-green-600">
                  {formatCurrency(selectedInvoice.paid_amount || 0)}
                </span>
              </div>
              <div className="flex justify-between border-t border-blue-300 pt-2">
                <span className="text-gray-900 font-semibold">Còn lại:</span>
                <span className="font-bold text-orange-600 text-lg">
                  {formatCurrency(outstandingAmount)}
                </span>
              </div>
            </div>
          )}

          {/* Amount */}
          <div className="space-y-2">
            <Label htmlFor="amount">Số tiền thu *</Label>
            <Input
              id="amount"
              type="number"
              step="1000"
              {...register('amount', { valueAsNumber: true })}
              placeholder="Nhập số tiền..."
            />
            {errors.amount && (
              <p className="text-sm text-red-500">{errors.amount.message}</p>
            )}
            {watchedAmount && selectedInvoice && watchedAmount > outstandingAmount && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>
                  Số tiền vượt quá số tiền còn lại ({formatCurrency(outstandingAmount)})
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
                    <Wallet className="h-4 w-4" />
                    Tiền mặt
                  </div>
                </SelectItem>
                <SelectItem value="BANK_TRANSFER">
                  <div className="flex items-center gap-2">
                    <CreditCard className="h-4 w-4" />
                    Chuyển khoản ngân hàng
                  </div>
                </SelectItem>
                <SelectItem value="CARD">
                  <div className="flex items-center gap-2">
                    <CreditCard className="h-4 w-4" />
                    Thẻ ATM/Credit
                  </div>
                </SelectItem>
                <SelectItem value="MOMO">
                  <div className="flex items-center gap-2">
                    <Smartphone className="h-4 w-4" />
                    Ví MoMo
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
              </SelectContent>
            </Select>
            {errors.payment_method && (
              <p className="text-sm text-red-500">{errors.payment_method.message}</p>
            )}
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

          {/* Notes */}
          <div className="space-y-2">
            <Label htmlFor="notes">Ghi chú</Label>
            <Textarea
              id="notes"
              {...register('notes')}
              placeholder="Ghi chú về thanh toán..."
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
              disabled={createMutation.isPending || !selectedInvoice}
            >
              {createMutation.isPending ? 'Đang xử lý...' : 'Ghi nhận thanh toán'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

export default CollectPaymentDialog;
