import { useEffect, useState, useRef } from 'react';
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
import { useRecordPaymentRPC } from '@/hooks/useInvoicePayments';
import { useAccounts } from '@/hooks/useAccounts';
import type { InvoiceWithRelations } from '@/types/invoice';
import { DollarSign, CheckCircle, Upload, X, Image, Loader2 } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';

interface RecordPaymentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  invoice: InvoiceWithRelations | null;
}

const paymentSchema = z.object({
  amount: z.number().min(1, 'Số tiền phải lớn hơn 0'),
  change_amount: z.number().min(0).default(0),
  payment_method: z.enum(['TM', 'TK', 'TT']),
  payment_date: z.string().min(1, 'Vui lòng chọn ngày thanh toán'),
  account_id: z.string().min(1, 'Vui lòng chọn sổ quỹ nhận'),
  change_account_id: z.string().optional(),
  notes: z.string().optional(),
}).refine(
  (data) => data.change_amount === 0 || !!data.change_account_id,
  { message: 'Vui lòng chọn sổ quỹ tiền thối', path: ['change_account_id'] },
);

type PaymentFormData = z.infer<typeof paymentSchema>;

const formatVN = (n: number) => (n > 0 ? n.toLocaleString('vi-VN') : '');
const parseVN = (s: string): number => {
  const digits = s.replace(/\D/g, '');
  return digits ? parseInt(digits, 10) : 0;
};

const JOEY_USER_ID = 'd45a7506-5250-4d99-ac94-9f73cbd4df17';
const NATHAN_USER_ID = 'df8d1df5-1c24-4723-9733-4640c43c382b';

const RecordPaymentDialog = ({ open, onOpenChange, invoice }: RecordPaymentDialogProps) => {
  const recordMutation = useRecordPaymentRPC();
  const { data: accounts = [] } = useAccounts();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [receiptImage, setReceiptImage] = useState<File | null>(null);
  const [receiptPreview, setReceiptPreview] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [changeUserEdited, setChangeUserEdited] = useState(false);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);

  const {
    handleSubmit,
    formState: { errors },
    setValue,
    watch,
    reset,
    register,
  } = useForm<PaymentFormData>({
    resolver: zodResolver(paymentSchema),
    defaultValues: {
      change_amount: 0,
      payment_method: 'TM',
      payment_date: new Date().toISOString().split('T')[0],
    },
  });

  const watchedAmount = watch('amount');
  const watchedChangeAmount = watch('change_amount');
  const watchedChangeAccountId = watch('change_account_id');
  const watchedPaymentMethod = watch('payment_method');

  const outstandingAmount = invoice ? (invoice.total_amount || 0) - (invoice.paid_amount || 0) : 0;

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setCurrentUserId(data.user?.id ?? null));
  }, []);

  // Auto-fill amount with outstanding amount when dialog opens
  useEffect(() => {
    if (invoice && outstandingAmount > 0) {
      setValue('amount', outstandingAmount);
    }
  }, [invoice, outstandingAmount, setValue]);

  // Auto-compute tiền thối = max(0, amount - outstanding) trừ khi user tự sửa
  useEffect(() => {
    if (!changeUserEdited) {
      const computed = Math.max(0, (watchedAmount || 0) - outstandingAmount);
      setValue('change_amount', computed);
    }
  }, [watchedAmount, outstandingAmount, changeUserEdited, setValue]);

  // Pre-select sổ quỹ thối theo current user (Joey -> Hiển Thối, Nathan -> Hiệp Thối)
  useEffect(() => {
    if (!watchedChangeAmount || watchedChangeAccountId || !accounts.length || !currentUserId) return;
    let target: any | undefined;
    if (currentUserId === JOEY_USER_ID) target = (accounts as any[]).find((a) => a.name === 'Hiển Thối');
    else if (currentUserId === NATHAN_USER_ID) target = (accounts as any[]).find((a) => a.name === 'Hiệp Thối');
    if (target) setValue('change_account_id', target.id);
  }, [watchedChangeAmount, watchedChangeAccountId, accounts, currentUserId, setValue]);

  const handleClose = () => {
    reset();
    setReceiptImage(null);
    setReceiptPreview(null);
    setChangeUserEdited(false);
    onOpenChange(false);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      // Validate file type
      if (!file.type.startsWith('image/')) {
        alert('Vui lòng chọn file ảnh (jpg, png, gif...)');
        return;
      }
      // Validate file size (max 5MB)
      if (file.size > 5 * 1024 * 1024) {
        alert('Kích thước file không được vượt quá 5MB');
        return;
      }
      setReceiptImage(file);
      // Create preview URL
      const previewUrl = URL.createObjectURL(file);
      setReceiptPreview(previewUrl);
    }
  };

  const handleRemoveImage = () => {
    setReceiptImage(null);
    if (receiptPreview) {
      URL.revokeObjectURL(receiptPreview);
      setReceiptPreview(null);
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const uploadReceiptImage = async (): Promise<string | null> => {
    if (!receiptImage) return null;

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error('Not authenticated');

    const fileExt = receiptImage.name.split('.').pop();
    const fileName = `${user.id}/${Date.now()}_receipt.${fileExt}`;

    const { data, error } = await supabase.storage
      .from('payment-receipts')
      .upload(fileName, receiptImage, {
        cacheControl: '3600',
        upsert: false,
      });

    if (error) {
      console.error('Upload error:', error);
      // If bucket doesn't exist, try documents bucket
      const { data: fallbackData, error: fallbackError } = await supabase.storage
        .from('documents')
        .upload(`receipts/${fileName}`, receiptImage, {
          cacheControl: '3600',
          upsert: false,
        });

      if (fallbackError) {
        console.error('Fallback upload error:', fallbackError);
        return null;
      }

      const { data: urlData } = supabase.storage
        .from('documents')
        .getPublicUrl(`receipts/${fileName}`);
      return urlData.publicUrl;
    }

    const { data: urlData } = supabase.storage
      .from('payment-receipts')
      .getPublicUrl(fileName);
    return urlData.publicUrl;
  };

  const onSubmit = async (data: PaymentFormData) => {
    if (!invoice) return;

    try {
      setIsUploading(true);

      // Upload image if exists
      let receiptImageUrl: string | undefined;
      if (receiptImage) {
        const uploadedUrl = await uploadReceiptImage();
        if (uploadedUrl) {
          receiptImageUrl = uploadedUrl;
        }
      }

      recordMutation.mutate(
        {
          invoice_id: invoice.id,
          amount: data.amount,
          payment_method: data.payment_method,
          payment_date: data.payment_date,
          notes: data.notes,
          receipt_image_url: receiptImageUrl,
          account_id: data.account_id,
          change_amount: data.change_amount,
          change_account_id: data.change_account_id,
        },
        {
          onSuccess: () => {
            handleClose();
          },
          onSettled: () => {
            setIsUploading(false);
          },
        }
      );
    } catch (error) {
      console.error('Payment error:', error);
      setIsUploading(false);
    }
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

  const isProcessing = recordMutation.isPending || isUploading;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <DollarSign className="h-5 w-5 text-green-600" />
            Ghi nhận thanh toán
          </DialogTitle>
          <DialogDescription>
            Hóa đơn: {invoice.invoice_number}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          {/* Invoice Info */}
          <div className="bg-gray-50 p-4 rounded-md space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-600">Khách hàng:</span>
              <span className="font-medium">{invoice.tenant?.full_name}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-600">Kỳ thanh toán:</span>
              <span className="font-medium">
                {invoice.billing_month && (
                  <>Tháng {invoice.billing_month.split('-')[1]}/{invoice.billing_month.split('-')[0]}</>
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

          {/* Số tiền thanh toán + Tiền thối — 2 cột */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="amount">Số tiền thanh toán *</Label>
              <Input
                id="amount"
                type="text"
                inputMode="numeric"
                value={formatVN(watchedAmount || 0)}
                onChange={(e) => setValue('amount', parseVN(e.target.value), { shouldValidate: true })}
                placeholder="0"
              />
              {errors.amount && (
                <p className="text-sm text-red-500">{errors.amount.message}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="change_amount">Tiền thối</Label>
              <Input
                id="change_amount"
                type="text"
                inputMode="numeric"
                value={formatVN(watchedChangeAmount || 0)}
                onChange={(e) => {
                  setChangeUserEdited(true);
                  setValue('change_amount', parseVN(e.target.value), { shouldValidate: true });
                }}
                placeholder="0"
              />
              {errors.change_amount && (
                <p className="text-sm text-red-500">{errors.change_amount.message}</p>
              )}
            </div>
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
                <SelectItem value="TM">TM</SelectItem>
                <SelectItem value="TK">TK</SelectItem>
                <SelectItem value="TT">TT</SelectItem>
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

          {/* Sổ quỹ — required so we can mirror the payment as a phiếu thu */}
          <div className="space-y-2">
            <Label>Sổ quỹ nhận *</Label>
            <Select
              onValueChange={(v) => setValue('account_id', v)}
              defaultValue=""
            >
              <SelectTrigger>
                <SelectValue placeholder="Chọn sổ quỹ nhận tiền" />
              </SelectTrigger>
              <SelectContent>
                {accounts.map((a: any) => (
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
              Hệ thống sẽ tự tạo phiếu thu trong mục Thu chi của sổ quỹ này.
            </p>
          </div>

          {/* Sổ quỹ tiền thối — bắt buộc nếu Tiền thối > 0 */}
          {(watchedChangeAmount ?? 0) > 0 && (
            <div className="space-y-2">
              <Label>Sổ quỹ tiền thối *</Label>
              <Select
                value={watchedChangeAccountId ?? ''}
                onValueChange={(v) => setValue('change_account_id', v, { shouldValidate: true })}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Chọn sổ quỹ chi tiền thối" />
                </SelectTrigger>
                <SelectContent>
                  {accounts.map((a: any) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name}
                      {a.bank_name ? ` — ${a.bank_name}` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {errors.change_account_id && (
                <p className="text-sm text-red-500">{errors.change_account_id.message}</p>
              )}
              <p className="text-xs text-muted-foreground">
                Hệ thống sẽ tạo phiếu chi hạng mục "Tiền thối" trong sổ quỹ này.
              </p>
            </div>
          )}

          {/* Receipt Image Upload */}
          <div className="space-y-2">
            <Label>Ảnh chứng từ thanh toán</Label>
            <p className="text-xs text-gray-500">
              Upload ảnh chuyển khoản, biên lai hoặc ảnh nhận tiền mặt (tùy chọn)
            </p>

            {!receiptPreview ? (
              <div
                className="border-2 border-dashed border-gray-300 rounded-lg p-6 text-center cursor-pointer hover:border-primary hover:bg-gray-50 transition-colors"
                onClick={() => fileInputRef.current?.click()}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={handleFileSelect}
                />
                <Upload className="h-8 w-8 mx-auto text-gray-400 mb-2" />
                <p className="text-sm text-gray-600">
                  Click để chọn ảnh hoặc kéo thả vào đây
                </p>
                <p className="text-xs text-gray-400 mt-1">
                  Hỗ trợ: JPG, PNG, GIF (tối đa 5MB)
                </p>
              </div>
            ) : (
              <div className="relative border rounded-lg overflow-hidden">
                <img
                  src={receiptPreview}
                  alt="Receipt preview"
                  className="w-full max-h-48 object-contain bg-gray-100"
                />
                <div className="absolute top-2 right-2 flex gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    className="h-8 w-8 p-0"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <Image className="h-4 w-4" />
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="destructive"
                    className="h-8 w-8 p-0"
                    onClick={handleRemoveImage}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={handleFileSelect}
                />
                <div className="p-2 bg-gray-50 border-t">
                  <p className="text-xs text-gray-600 truncate">
                    {receiptImage?.name}
                  </p>
                </div>
              </div>
            )}
          </div>

          {/* Payment Preview */}
          {watchedAmount > 0 && (
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
                {newOutstanding < 0 && (
                  <div className="flex justify-between">
                    <span className="text-gray-700">Tiền thừa:</span>
                    <span className="font-medium text-blue-600">{formatCurrency(Math.abs(newOutstanding))}</span>
                  </div>
                )}
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
                    {newOutstanding < 0
                      ? `Hóa đơn sẽ được thanh toán đầy đủ. Số tiền thừa ${formatCurrency(Math.abs(newOutstanding))} sẽ được ghi nhận cho khách thuê.`
                      : 'Hóa đơn sẽ được đánh dấu là đã thanh toán đầy đủ'}
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
              disabled={isProcessing}
            >
              Hủy
            </Button>
            <Button
              type="submit"
              disabled={isProcessing || !watchedAmount}
            >
              {isProcessing ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Đang xử lý...
                </>
              ) : (
                'Ghi nhận thanh toán'
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

export default RecordPaymentDialog;
