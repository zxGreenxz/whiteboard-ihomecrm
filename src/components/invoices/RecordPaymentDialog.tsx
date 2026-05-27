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
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useRecordPaymentRPC } from '@/hooks/useInvoicePayments';
import { useAccounts } from '@/hooks/useAccounts';
import { useAuth } from '@/hooks/useAuth';
import { useMyContext } from '@/hooks/useMyContext';
import type { InvoiceWithRelations } from '@/types/invoice';
import { DollarSign, CheckCircle, Upload, X, Image, Loader2, Plus, Minus } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { Checkbox } from '@/components/ui/checkbox';
import { useClipboardImagePaste } from '@/hooks/useClipboardImagePaste';
import { toast } from 'sonner';

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
  keep_as_credit: z.boolean().default(false),
  notes: z.string().optional(),
}).refine(
  (data) => data.change_amount === 0 || data.keep_as_credit || !!data.change_account_id,
  { message: 'Vui lòng chọn sổ ghi nhận tiền thối', path: ['change_account_id'] },
).refine(
  (data) => {
    if (data.change_amount === 0) return true;
    if (data.keep_as_credit) return true;
    const tmTotal = data.payment_lines
      .filter((l) => l.payment_method === 'TM')
      .reduce((s, l) => s + (Number(l.amount) || 0), 0);
    return tmTotal >= data.change_amount;
  },
  { message: 'Tiền thối chỉ áp dụng với phương thức TM và phải ≤ tổng tiền TM', path: ['change_amount'] },
);

type PaymentFormData = z.infer<typeof paymentSchema>;

const formatVN = (n: number) => (n > 0 ? n.toLocaleString('vi-VN') : '');
const parseVN = (s: string): number => {
  const digits = s.replace(/\D/g, '');
  return digits ? parseInt(digits, 10) : 0;
};

type PaymentMethod = 'TM' | 'TT' | 'TK';
const METHOD_ORDER: PaymentMethod[] = ['TM', 'TT', 'TK'];
const METHOD_ORDER_NO_TK: PaymentMethod[] = ['TM', 'TT'];

const defaultMethodForNewRow = (
  lines: Array<{ payment_method?: PaymentMethod } | undefined>,
): PaymentMethod => {
  const first = lines[0]?.payment_method;
  if (first === 'TT') return 'TM';
  if (first === 'TK') return 'TM';
  return 'TT';
};

const RecordPaymentDialog = ({ open, onOpenChange, invoice }: RecordPaymentDialogProps) => {
  const recordMutation = useRecordPaymentRPC();
  const { data: accounts = [] } = useAccounts();
  const { data: currentUser } = useAuth();
  const { data: ctx } = useMyContext();
  const isSuper = !!ctx?.isSuper;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [receiptImage, setReceiptImage] = useState<File | null>(null);
  const [receiptPreview, setReceiptPreview] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [changeUserEdited, setChangeUserEdited] = useState(false);

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
      keep_as_credit: false,
    },
  });

  const { fields, append, remove } = useFieldArray({ control, name: 'payment_lines' });

  const watchedLines = watch('payment_lines');
  const watchedChangeAmount = watch('change_amount');
  const watchedChangeAccountId = watch('change_account_id');
  const watchedKeepAsCredit = watch('keep_as_credit');

  const totalPaid = (watchedLines ?? []).reduce(
    (s, l) => s + (Number((l as any)?.amount) || 0),
    0,
  );

  const outstandingAmount = invoice ? (invoice.total_amount || 0) - (invoice.paid_amount || 0) : 0;

  // ID sổ quỹ trùng tên tòa nhà của hoá đơn — fallback cho TT/TK khi
  // toà nhà chưa cấu hình default_account_id_tt/tk trong Cài đặt toà nhà.
  const defaultAccountIdByName = useMemo(() => {
    if (!invoice || !accounts.length) return '';
    const buildingName = invoice.building?.name?.trim();
    if (!buildingName) return '';
    return (accounts as any[]).find((a) => a.name?.trim() === buildingName)?.id ?? '';
  }, [invoice, accounts]);

  // Sổ quỹ mặc định lấy từ cài đặt toà nhà (mọi user dùng chung).
  const buildingDefaultTT = (invoice?.building as any)?.default_account_id_tt ?? '';
  const buildingDefaultTK = (invoice?.building as any)?.default_account_id_tk ?? '';

  const myCashAccountId = useMemo(() => {
    if (!currentUser?.id || !accounts.length) return '';
    return (accounts as any[]).find(
      (a) =>
        a.user_id === currentUser.id &&
        typeof a.name === 'string' &&
        a.name.trim().endsWith('Thu'),
    )?.id ?? '';
  }, [currentUser, accounts]);

  // Sổ quỹ "Chung" — fallback cho TM khi user đăng nhập không phải joey/nathan
  // (và không sở hữu sổ "Thu" riêng).
  const chungAccountId = useMemo(() => {
    if (!accounts.length) return '';
    return (accounts as any[]).find(
      (a) => typeof a.name === 'string' && a.name.trim().toLowerCase() === 'chung',
    )?.id ?? '';
  }, [accounts]);

  // Sổ quỹ "Làm tròn tiền thiếu" — dùng cho audit khi residual < 10K
  // được làm tròn. Chỉ là ledger metadata, không trừ số dư.
  const roundingAccountId = useMemo(() => {
    if (!accounts.length) return '';
    return (accounts as any[]).find(
      (a) => typeof a.name === 'string' && a.name.trim() === 'Làm tròn tiền thiếu',
    )?.id ?? '';
  }, [accounts]);

  const accountIdForMethod = (method: PaymentMethod): string => {
    // TM: sổ Thu của chính nhân viên đang đăng nhập (joey → Hiển Thu,
    // nathan → Hiệp Thu, v.v. — match qua accounts.user_id). User khác
    // (không sở hữu sổ Thu) → fallback sổ "Chung".
    if (method === 'TM') {
      if (myCashAccountId) return myCashAccountId;
      if (chungAccountId) return chungAccountId;
      return defaultAccountIdByName;
    }
    // TT/TK: ưu tiên cài đặt sổ quỹ mặc định của toà nhà, sau đó fallback
    // match theo tên (logic cũ).
    if (method === 'TT' && buildingDefaultTT) return buildingDefaultTT;
    if (method === 'TK' && buildingDefaultTK) return buildingDefaultTK;
    return defaultAccountIdByName;
  };

  // Auto-fill số tiền của dòng đầu = outstanding khi mở dialog
  useEffect(() => {
    if (invoice && outstandingAmount > 0) {
      setValue('payment_lines.0.amount', outstandingAmount);
    }
  }, [invoice, outstandingAmount, setValue]);

  useEffect(() => {
    if (!defaultAccountIdByName && !myCashAccountId && !chungAccountId && !buildingDefaultTT && !buildingDefaultTK) return;
    const firstMethod = (watchedLines?.[0]?.payment_method ?? 'TM') as PaymentMethod;
    const target = accountIdForMethod(firstMethod);
    if (target) setValue('payment_lines.0.account_id', target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultAccountIdByName, myCashAccountId, chungAccountId, buildingDefaultTT, buildingDefaultTK, setValue]);

  const tmTotal = (watchedLines ?? [])
    .filter((l: any) => l?.payment_method === 'TM')
    .reduce((s, l: any) => s + (Number(l?.amount) || 0), 0);

  // Có phiếu thanh toán cũ (đã lưu) nào dùng TM hoặc TT chưa?
  const priorHasTmTt = useMemo(
    () =>
      (invoice?.payments ?? []).some(
        (p) => p.payment_method === 'TM' || p.payment_method === 'TT',
      ),
    [invoice?.payments],
  );

  // Khoá TK trên dropdown khi state hiện tại đã có TM/TT (phiếu cũ
  // hoặc dòng hiện tại khác `idx`). Khi bị khoá, dropdown chỉ hiển
  // thị TM/TT + 1 nút "+" ở vị trí thứ 3 (xem JSX dưới). Người dùng
  // bấm "+" để mở khoá TK cho riêng dòng đó (state `unlockedTkFieldIds`)
  // — sau đó mở lại dropdown sẽ thấy TK như option bình thường.
  const shouldLockTkForRow = (idx: number): boolean => {
    if (priorHasTmTt) return true;
    return (watchedLines ?? []).some(
      (l: any, i) =>
        i !== idx && (l?.payment_method === 'TM' || l?.payment_method === 'TT'),
    );
  };

  // Mỗi field react-hook-form có `id` ổn định qua reorder/remove. Track
  // các field đã được người dùng bấm "+" để mở khoá TK.
  const [unlockedTkFieldIds, setUnlockedTkFieldIds] = useState<Set<string>>(
    () => new Set(),
  );
  const unlockTkForField = (fieldId: string) => {
    setUnlockedTkFieldIds((prev) => {
      if (prev.has(fieldId)) return prev;
      const next = new Set(prev);
      next.add(fieldId);
      return next;
    });
  };
  const isTkVisibleForRow = (
    idx: number,
    fieldId: string,
    currentMethod: PaymentMethod | undefined,
  ): boolean => {
    if (currentMethod === 'TK') return true; // luôn giữ option khi đang chọn TK
    if (!shouldLockTkForRow(idx)) return true;
    return unlockedTkFieldIds.has(fieldId);
  };

  // Click "+ Thêm dòng thanh toán" để thêm dòng mới. Method mặc định
  // là alternate (TM ↔ TT) — KHÔNG auto chọn TK. Muốn TK, người dùng
  // mở dropdown dòng mới, bấm dấu "+" ở vị trí thứ 3 để hiện TK.
  const handleAppendPaymentRow = () => {
    const method = defaultMethodForNewRow(watchedLines as any);
    append({
      amount: 0,
      payment_method: method,
      account_id: accountIdForMethod(method),
    });
  };

  // Auto-compute tiền thối: chỉ tính khi có line TM. Cap theo tmTotal để không khấu trừ âm.
  useEffect(() => {
    if (changeUserEdited) return;
    if (tmTotal === 0) {
      setValue('change_amount', 0);
      return;
    }
    const overpaid = Math.max(0, totalPaid - outstandingAmount);
    setValue('change_amount', Math.min(overpaid, tmTotal));
  }, [totalPaid, outstandingAmount, tmTotal, changeUserEdited, setValue]);

  // Pre-select sổ ghi nhận thối: tìm account thuộc user có name kết thúc "Thối"
  useEffect(() => {
    if (!watchedChangeAmount || watchedChangeAccountId || !accounts.length) return;
    const target = (accounts as any[]).find(
      (a) => typeof a.name === 'string' && a.name.trim().endsWith('Thối'),
    );
    if (target) setValue('change_account_id', target.id);
  }, [watchedChangeAmount, watchedChangeAccountId, accounts, setValue]);

  const handleClose = () => {
    reset();
    setReceiptImage(null);
    setReceiptPreview(null);
    setChangeUserEdited(false);
    setUnlockedTkFieldIds(new Set());
    onOpenChange(false);
  };

  const acceptReceiptFile = (file: File) => {
    if (!file.type.startsWith('image/')) {
      alert('Vui lòng chọn file ảnh (jpg, png, gif...)');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      alert('Kích thước file không được vượt quá 5MB');
      return;
    }
    setReceiptImage(file);
    if (receiptPreview) URL.revokeObjectURL(receiptPreview);
    setReceiptPreview(URL.createObjectURL(file));
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) acceptReceiptFile(file);
  };

  const receiptPasteHandlers = useClipboardImagePaste({
    onFiles: (files) => acceptReceiptFile(files[0]),
    enabled: !receiptPreview,
  });

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

      const change = data.change_amount || 0;
      const keepAsCredit = !!data.keep_as_credit && change > 0;

      // Tiền thối CHỈ áp dụng line TM. Khấu trừ vào line TM CUỐI CÙNG:
      //   - phiếu thu line đó: amount = line.amount - change_amount (số thực thu)
      //   - metadata change_amount / change_account_id gắn lên phiếu thu này
      // Các line khác (TM trước đó, TK, TT): giữ nguyên amount, không metadata thối.
      // KHI keep_as_credit: KHÔNG khấu trừ, line TM giữ nguyên amount; tiền thối
      // sẽ được lưu thành excess_amounts row sau khi tạo phiếu thu xong (mutation
      // useRecordPaymentRPC tự xử lý phần này dựa trên flag keep_as_credit).
      const tmDeductIdx = change > 0 && !keepAsCredit
        ? (() => {
            for (let i = data.payment_lines.length - 1; i >= 0; i--) {
              if (data.payment_lines[i].payment_method === 'TM') return i;
            }
            return -1;
          })()
        : -1;

      const tmLastIdx = (() => {
        for (let i = data.payment_lines.length - 1; i >= 0; i--) {
          if (data.payment_lines[i].payment_method === 'TM') return i;
        }
        return -1;
      })();

      // Làm tròn tiền thiếu: residual sau khi thu line < 10K → đính kèm
      // rounding metadata vào line CUỐI để tạo 1 audit entry duy nhất.
      const totalAcrossLines = data.payment_lines.reduce(
        (s, l) => s + (Number(l.amount) || 0),
        0,
      );
      const residualAfter =
        (invoice.total_amount || 0) - (invoice.paid_amount || 0) - totalAcrossLines;
      const applyRounding =
        residualAfter > 0 &&
        residualAfter < ROUNDING_THRESHOLD &&
        totalAcrossLines > 0;
      const lastLineIdx = data.payment_lines.length - 1;

      for (let i = 0; i < data.payment_lines.length; i++) {
        const line = data.payment_lines[i];
        const isDeductLine = i === tmDeductIdx;
        const deducted = isDeductLine ? change : 0;
        const effectiveAmount = line.amount - deducted;
        if (effectiveAmount <= 0) {
          // Line bị khấu trừ hết → không tạo phiếu. (Hiếm — đã chặn ở zod.)
          continue;
        }
        // Khi keep_as_credit, gắn credit metadata lên line TM cuối để hook tạo
        // excess_amounts row link đúng payment.
        const isCreditLine = keepAsCredit && i === tmLastIdx;
        const isRoundingLine = applyRounding && i === lastLineIdx;
        await recordMutation.mutateAsync({
          invoice_id: invoice.id,
          amount: effectiveAmount,
          payment_method: line.payment_method,
          payment_date: data.payment_date,
          notes: data.notes,
          receipt_image_url: i === 0 ? receiptImageUrl : undefined,
          account_id: line.account_id,
          change_amount: deducted,
          change_account_id: isDeductLine ? (data.change_account_id ?? null) : null,
          credit_amount: isCreditLine ? change : 0,
          rounding_amount: isRoundingLine ? residualAfter : 0,
          rounding_account_id:
            isRoundingLine && roundingAccountId ? roundingAccountId : null,
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
  // Áp dụng làm tròn tự động: residual > 0 và < 10K → coi như đã thanh toán
  // đủ; phần thiếu được ghi nhận vào sổ "Làm tròn tiền thiếu" (metadata).
  const ROUNDING_THRESHOLD = 10000;
  const willRound =
    newOutstanding > 0 && newOutstanding < ROUNDING_THRESHOLD && totalPaid > 0;
  const roundingAmount = willRound ? newOutstanding : 0;
  const willBePaid = newOutstanding <= 0 || willRound;
  const willBePartialPaid = newPaidAmount > 0 && newOutstanding > 0 && !willRound;

  const isProcessing = recordMutation.isPending || isUploading;

  // Hiển thị toast khi zod validation fail — trước đây handleSubmit nuốt lỗi
  // âm thầm, người dùng bấm "Ghi nhận thanh toán" mà không thấy gì xảy ra
  // (lúc được lúc không tuỳ account_id đã auto-fill kịp hay chưa).
  const onInvalid = (formErrors: Record<string, any>) => {
    const lines: string[] = [];
    const pl = formErrors.payment_lines;
    if (Array.isArray(pl)) {
      pl.forEach((lineErr, idx) => {
        if (!lineErr) return;
        if (lineErr.amount?.message)
          lines.push(`• Dòng ${idx + 1} — Số tiền: ${lineErr.amount.message}`);
        if (lineErr.account_id?.message)
          lines.push(`• Dòng ${idx + 1} — Sổ quỹ nhận: ${lineErr.account_id.message}`);
        if (lineErr.payment_method?.message)
          lines.push(`• Dòng ${idx + 1} — Phương thức: ${lineErr.payment_method.message}`);
      });
    }
    if (formErrors.payment_date?.message)
      lines.push(`• Ngày thanh toán: ${formErrors.payment_date.message}`);
    if (formErrors.change_amount?.message)
      lines.push(`• Tiền thối: ${formErrors.change_amount.message}`);
    if (formErrors.change_account_id?.message)
      lines.push(`• Sổ ghi nhận thối: ${formErrors.change_account_id.message}`);
    toast.error('Không thể ghi nhận thanh toán', {
      description: lines.length > 0 ? lines.join('\n') : 'Vui lòng kiểm tra lại thông tin.',
    });
  };

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

        <form onSubmit={handleSubmit(onSubmit, onInvalid)} className="space-y-4">
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
                  <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
                    <Checkbox
                      checked={watchedKeepAsCredit}
                      onCheckedChange={(v) =>
                        setValue('keep_as_credit', !!v, { shouldValidate: true })
                      }
                    />
                    Nợ khách (trừ kỳ sau)
                  </label>
                </div>
                <div className="pt-7">
                  <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    title="Thêm dòng thanh toán"
                    onClick={handleAppendPaymentRow}
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
                  onValueChange={(value) => {
                    const method = value as PaymentMethod;
                    setValue('payment_lines.0.payment_method', method, {
                      shouldValidate: true,
                    });
                    const next = accountIdForMethod(method);
                    if (next) {
                      setValue('payment_lines.0.account_id', next, {
                        shouldValidate: true,
                      });
                    }
                  }}
                >
                  <SelectTrigger>
                    <SelectValue>
                      {watchedLines?.[0]?.payment_method ?? 'TM'}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="TM">TM</SelectItem>
                    <SelectItem value="TT">TT</SelectItem>
                    {isTkVisibleForRow(
                      0,
                      fields[0]?.id ?? '',
                      watchedLines?.[0]?.payment_method as PaymentMethod | undefined,
                    ) ? (
                      <SelectItem value="TK">TK</SelectItem>
                    ) : (
                      <div
                        role="button"
                        tabIndex={0}
                        title="Bấm để hiện phương thức TK"
                        className="relative flex w-full cursor-pointer select-none items-center justify-center rounded-sm py-1.5 px-2 text-sm outline-none hover:bg-accent hover:text-accent-foreground"
                        onPointerDown={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          unlockTkForField(fields[0]?.id ?? '');
                        }}
                      >
                        <Plus className="h-4 w-4" />
                      </div>
                    )}
                  </SelectContent>
                </Select>
              </div>

              {/* Ngày thanh toán */}
              <div className="space-y-2">
                <Label htmlFor="payment_date">Ngày thanh toán *</Label>
                <DateInput
                  value={watch('payment_date') || ''}
                  onChange={(v) => setValue('payment_date', v, { shouldValidate: true, shouldDirty: true })}
                />
                {errors.payment_date && (
                  <p className="text-sm text-red-500">{errors.payment_date.message}</p>
                )}
              </div>

              {/* Sổ quỹ nhận — super admin luôn thấy. User thường chỉ thấy
                  khi auto-pick chưa ra (accounts chưa load xong hoặc tòa nhà
                  chưa có default cho phương thức này) — để họ có chỗ chọn
                  thay vì bấm "Ghi nhận thanh toán" không có phản hồi. */}
              {(isSuper || !watchedLines?.[0]?.account_id) && (
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
              )}
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
                        onValueChange={(v) => {
                          const method = v as PaymentMethod;
                          setValue(
                            `payment_lines.${idx}.payment_method` as const,
                            method,
                            { shouldValidate: true },
                          );
                          const next = accountIdForMethod(method);
                          if (next) {
                            setValue(
                              `payment_lines.${idx}.account_id` as const,
                              next,
                              { shouldValidate: true },
                            );
                          }
                        }}
                      >
                        <SelectTrigger>
                          <SelectValue>
                            {watchedLines?.[idx]?.payment_method ?? 'TM'}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="TM">TM</SelectItem>
                          <SelectItem value="TT">TT</SelectItem>
                          {isTkVisibleForRow(
                            idx,
                            field.id,
                            watchedLines?.[idx]?.payment_method as
                              | PaymentMethod
                              | undefined,
                          ) ? (
                            <SelectItem value="TK">TK</SelectItem>
                          ) : (
                            <div
                              role="button"
                              tabIndex={0}
                              title="Bấm để hiện phương thức TK"
                              className="relative flex w-full cursor-pointer select-none items-center justify-center rounded-sm py-1.5 px-2 text-sm outline-none hover:bg-accent hover:text-accent-foreground"
                              onPointerDown={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                unlockTkForField(field.id);
                              }}
                            >
                              <Plus className="h-4 w-4" />
                            </div>
                          )}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  {/* Sổ quỹ nhận — super admin luôn thấy; user thường thấy
                      khi auto-pick chưa ra để có chỗ chọn. */}
                  {(isSuper || !watchedLines?.[idx]?.account_id) && (
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
                  )}
                </div>
              ))}

              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-full"
                onClick={handleAppendPaymentRow}
              >
                <Plus className="h-4 w-4 mr-2" />
                Thêm dòng thanh toán
              </Button>

              {/* Ngày thanh toán */}
              <div className="space-y-2">
                <Label htmlFor="payment_date">Ngày thanh toán *</Label>
                <DateInput
                  value={watch('payment_date') || ''}
                  onChange={(v) => setValue('payment_date', v, { shouldValidate: true, shouldDirty: true })}
                />
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
                <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
                  <Checkbox
                    checked={watchedKeepAsCredit}
                    onCheckedChange={(v) =>
                      setValue('keep_as_credit', !!v, { shouldValidate: true })
                    }
                  />
                  Nợ khách (trừ kỳ sau)
                </label>
                <p className="text-xs text-muted-foreground">
                  Tổng đã nhập: {formatVN(totalPaid)} đ — Còn phải thu:{' '}
                  {formatVN(outstandingAmount)} đ
                </p>
              </div>
            </>
          )}

          {/* Sổ ghi nhận tiền thối — bắt buộc nếu Tiền thối > 0 và KHÔNG giữ làm credit */}
          {(watchedChangeAmount ?? 0) > 0 && !watchedKeepAsCredit && (
            <div className="space-y-2">
              <Label>Sổ ghi nhận tiền thối *</Label>
              <Select
                value={watchedChangeAccountId ?? ''}
                onValueChange={(v) => setValue('change_account_id', v, { shouldValidate: true })}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Chọn sổ ghi nhận tiền thối" />
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
              <p className="text-xs text-muted-foreground">
                Chỉ áp dụng cho TM. Số tiền thối được ghi vào sổ này để audit — không trừ số dư sổ.
              </p>
              {errors.change_account_id && (
                <p className="text-sm text-red-500">{errors.change_account_id.message}</p>
              )}
            </div>
          )}

          {/* Info khi tick "Nợ khách" */}
          {(watchedChangeAmount ?? 0) > 0 && watchedKeepAsCredit && (
            <Alert className="bg-blue-50 border-blue-200">
              <AlertDescription className="text-blue-800 text-sm">
                Sẽ giữ {formatVN(watchedChangeAmount ?? 0)}đ làm tiền nợ khách của hợp đồng,
                trừ vào HĐ kỳ sau. Phiếu thu được tạo đầy đủ theo số tiền khách trả, không
                tạo phiếu chi thối.
              </AlertDescription>
            </Alert>
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
                {...receiptPasteHandlers}
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
                  Click để chọn ảnh, kéo thả hoặc Ctrl+V để dán
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
                    {willRound
                      ? `Còn thiếu ${formatCurrency(roundingAmount)} (< 10.000 ₫) — hệ thống tự làm tròn, ghi nhận vào sổ "Làm tròn tiền thiếu" và đánh dấu hoá đơn Đã thanh toán đủ.`
                      : newOutstanding < 0
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
