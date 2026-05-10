import { useEffect, useState, useRef, useMemo } from 'react';
import { useForm, useFieldArray } from 'react-hook-form';
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
import { useAuth } from '@/hooks/useAuth';
import type { InvoiceWithRelations } from '@/types/invoice';
import { DollarSign, CheckCircle, Upload, X, Image, Loader2, Plus, Minus } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';

interface RecordPaymentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  invoice: InvoiceWithRelations | null;
}

const paymentLineSchema = z.object({
  amount: z.number().min(1, 'Số tiền phải > 0'),
  payment_method: z.enum(['TM', 'TK', 'TT']),
  account_id: z.string().min(1, 'Vui lòng chọn sổ quỹ nhận'),
});

const paymentSchema = z.object({
  payment_lines: z.array(paymentLineSchema).min(1, 'Phải có ít nhất 1 dòng thanh toán'),
  change_amount: z.number().min(0).default(0),
  payment_date: z.string().min(1, 'Vui lòng chọn ngày thanh toán'),
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
  const { data: authUser } = useAuth();
  const currentUserId = authUser?.id ?? null;

  const {
    handleSubmit,
    formState: { errors },
    setValue,
    watch,
    reset,
    register,
    control,
  } = useForm<PaymentFormData>({
    resolver: zodResolver(paymentSchema),
    defaultValues: {
      payment_lines: [{ amount: 0, payment_method: 'TM', account_id: '' }],
      change_amount: 0,
      payment_date: new Date().toISOString().split('T')[0],
    },
  });

  const { fields, append, remove } = useFieldArray({ control, name: 'payment_lines' });

  const watchedLines = watch('payment_lines');
  const watchedChangeAmount = watch('change_amount');
  const watchedChangeAccountId = watch('change_account_id');

  const totalPaid = (watchedLines ?? []).reduce(
    (s, l) => s + (Number((l as any)?.amount) || 0),
    0,
  );

  const outstandingAmount = invoice ? (invoice.total_amount || 0) - (invoice.paid_amount || 0) : 0;

  // ID sổ quỹ trùng tên tòa nhà của hoá đơn — dùng làm default cho mọi dòng mới.
  const defaultAccountId = useMemo(() => {
    if (!invoice || !accounts.length) return '';
    const buildingName = invoice.building?.name?.trim();
    if (!buildingName) return '';
    return (accounts as any[]).find((a) => a.name?.trim() === buildingName)?.id ?? '';
  }, [invoice, accounts]);

  // Auto-fill số tiền của dòng đầu = outstanding khi mở dialog
  useEffect(() => {
    if (invoice && outstandingAmount > 0) {
      setValue('payment_lines.0.amount', outstandingAmount);
    }
  }, [invoice, outstandingAmount, setValue]);

  // Auto-default sổ quỹ nhận của DÒNG ĐẦU theo tên tòa nhà (account.name === building.name)
  useEffect(() => {
    if (!defaultAccountId) return;
    setValue('payment_lines.0.account_id', defaultAccountId);
  }, [defaultAccountId, setValue]);

  // Auto-compute tiền thối = max(0, totalPaid - outstanding), trừ khi user tự sửa
  useEffect(() => {
    if (!changeUserEdited) {
      const computed = Math.max(0, totalPaid - outstandingAmount);
      setValue('change_amount', computed);
    }
  }, [totalPaid, outstandingAmount, changeUserEdited, setValue]);

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

      // Lặp qua từng dòng thanh toán; tiền thối chỉ kèm ở dòng cuối
      // (sau khi tất cả payments đã ghi nhận, mirror change voucher 1 lần).
      for (let i = 0; i < data.payment_lines.length; i++) {
        const line = data.payment_lines[i];
        const isLast = i === data.payment_lines.length - 1;
        await recordMutation.mutateAsync({
          invoice_id: invoice.id,
          amount: line.amount,
          payment_method: line.payment_method,
          payment_date: data.payment_date,
          notes: data.notes,
          receipt_image_url: i === 0 ? receiptImageUrl : undefined,
          account_id: line.account_id,
          change_amount: isLast ? data.change_amount : 0,
          change_account_id: isLast ? data.change_account_id : null,
        });
      }
      handleClose();
    } catch (error) {
      console.error('Payment error:', error);
    } finally {
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

  const newPaidAmount = (invoice.paid_amount || 0) + totalPaid;
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

          {fields.length === 1 ? (
            <>
              {/* Số tiền thanh toán + Tiền thối + nút "+" — 1 dòng */}
              <div className="flex gap-4 items-start">
                <div className="flex-1 space-y-2">
                  <Label htmlFor="amount">Số tiền thanh toán *</Label>
                  <Input
                    id="amount"
                    type="text"
                    inputMode="numeric"
                    value={formatVN(watchedLines?.[0]?.amount || 0)}
                    onChange={(e) =>
                      setValue('payment_lines.0.amount', parseVN(e.target.value), {
                        shouldValidate: true,
                      })
                    }
                    placeholder="0"
                  />
                  {errors.payment_lines?.[0]?.amount && (
                    <p className="text-sm text-red-500">
                      {errors.payment_lines[0]?.amount?.message}
                    </p>
                  )}
                </div>
                <div className="flex-1 space-y-2">
                  <Label htmlFor="change_amount">Tiền thối</Label>
                  <Input
                    id="change_amount"
                    type="text"
                    inputMode="numeric"
                    value={formatVN(watchedChangeAmount || 0)}
                    onChange={(e) => {
                      setChangeUserEdited(true);
                      setValue('change_amount', parseVN(e.target.value), {
                        shouldValidate: true,
                      });
                    }}
                    placeholder="0"
                  />
                </div>
                <div className="pt-7">
                  <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    title="Thêm dòng thanh toán"
                    onClick={() =>
                      append({ amount: 0, payment_method: 'TM', account_id: defaultAccountId })
                    }
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              {/* Phương thức thanh toán */}
              <div className="space-y-2">
                <Label>Phương thức thanh toán *</Label>
                <Select
                  value={watchedLines?.[0]?.payment_method ?? 'TM'}
                  onValueChange={(value) =>
                    setValue('payment_lines.0.payment_method', value as any, {
                      shouldValidate: true,
                    })
                  }
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

              {/* Ngày thanh toán */}
              <div className="space-y-2">
                <Label htmlFor="payment_date">Ngày thanh toán *</Label>
                <Input id="payment_date" type="date" {...register('payment_date')} />
                {errors.payment_date && (
                  <p className="text-sm text-red-500">{errors.payment_date.message}</p>
                )}
              </div>

              {/* Sổ quỹ nhận */}
              <div className="space-y-2">
                <Label>Sổ quỹ nhận *</Label>
                <Select
                  value={watchedLines?.[0]?.account_id ?? ''}
                  onValueChange={(v) =>
                    setValue('payment_lines.0.account_id', v, { shouldValidate: true })
                  }
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
                {errors.payment_lines?.[0]?.account_id && (
                  <p className="text-sm text-red-500">
                    {errors.payment_lines[0]?.account_id?.message}
                  </p>
                )}
                <p className="text-xs text-muted-foreground">
                  Hệ thống sẽ tự tạo phiếu thu trong mục Thu chi của sổ quỹ này.
                </p>
              </div>
            </>
          ) : (
            <>
              {/* Multi-line mode: stack từng dòng (Số tiền · PT · Sổ quỹ · −) */}
              {fields.map((field, idx) => (
                <div
                  key={field.id}
                  className="border border-zinc-200 rounded-lg p-3 space-y-3 bg-zinc-50/50"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-zinc-700">
                      Thanh toán #{idx + 1}
                    </span>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      title="Xoá dòng"
                      onClick={() => remove(idx)}
                    >
                      <Minus className="h-4 w-4" />
                    </Button>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <Label>Số tiền *</Label>
                      <Input
                        type="text"
                        inputMode="numeric"
                        value={formatVN(watchedLines?.[idx]?.amount || 0)}
                        onChange={(e) =>
                          setValue(
                            `payment_lines.${idx}.amount` as const,
                            parseVN(e.target.value),
                            { shouldValidate: true },
                          )
                        }
                        placeholder="0"
                      />
                      {errors.payment_lines?.[idx]?.amount && (
                        <p className="text-sm text-red-500">
                          {errors.payment_lines[idx]?.amount?.message}
                        </p>
                      )}
                    </div>
                    <div className="space-y-2">
                      <Label>Phương thức *</Label>
                      <Select
                        value={watchedLines?.[idx]?.payment_method ?? 'TM'}
                        onValueChange={(v) =>
                          setValue(
                            `payment_lines.${idx}.payment_method` as const,
                            v as any,
                            { shouldValidate: true },
                          )
                        }
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
                  </div>
                  <div className="space-y-2">
                    <Label>Sổ quỹ nhận *</Label>
                    <Select
                      value={watchedLines?.[idx]?.account_id ?? ''}
                      onValueChange={(v) =>
                        setValue(
                          `payment_lines.${idx}.account_id` as const,
                          v,
                          { shouldValidate: true },
                        )
                      }
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
                    {errors.payment_lines?.[idx]?.account_id && (
                      <p className="text-sm text-red-500">
                        {errors.payment_lines[idx]?.account_id?.message}
                      </p>
                    )}
                  </div>
                </div>
              ))}

              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-full"
                onClick={() =>
                  append({ amount: 0, payment_method: 'TM', account_id: defaultAccountId })
                }
              >
                <Plus className="h-4 w-4 mr-2" />
                Thêm dòng thanh toán
              </Button>

              {/* Ngày thanh toán */}
              <div className="space-y-2">
                <Label htmlFor="payment_date">Ngày thanh toán *</Label>
                <Input id="payment_date" type="date" {...register('payment_date')} />
                {errors.payment_date && (
                  <p className="text-sm text-red-500">{errors.payment_date.message}</p>
                )}
              </div>

              {/* Tiền thối — DƯỚI cùng cụm payment lines */}
              <div className="space-y-2">
                <Label htmlFor="change_amount_multi">Tiền thối</Label>
                <Input
                  id="change_amount_multi"
                  type="text"
                  inputMode="numeric"
                  value={formatVN(watchedChangeAmount || 0)}
                  onChange={(e) => {
                    setChangeUserEdited(true);
                    setValue('change_amount', parseVN(e.target.value), {
                      shouldValidate: true,
                    });
                  }}
                  placeholder="0"
                />
                <p className="text-xs text-muted-foreground">
                  Tổng đã nhập: {formatVN(totalPaid)} đ — Còn phải thu:{' '}
                  {formatVN(outstandingAmount)} đ
                </p>
              </div>
            </>
          )}

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
          {totalPaid > 0 && (
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
              disabled={isProcessing || totalPaid <= 0}
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
