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
import {
  useRecordPaymentRPC,
  type RecordPaymentRPCData,
} from '@/hooks/useInvoicePayments';
import { useAccounts } from '@/hooks/useAccounts';
import { changeAccountOptions, findOwnChangeAccount } from '@/lib/changeAccounts';
import { ownCashAccountId } from '@/lib/cashAccount';
import { useAuth } from '@/hooks/useAuth';
import type { InvoiceWithRelations } from '@/types/invoice';
import { DollarSign, CheckCircle, Upload, X, Image, Loader2, Plus, Minus } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { getSessionUser } from "@/lib/authSession";
import { Checkbox } from '@/components/ui/checkbox';
import { useClipboardImagePaste } from '@/hooks/useClipboardImagePaste';
import { toast } from 'sonner';
import { deriveInvoiceDepositDue } from '@/lib/paymentRecordRpc';
import { deriveOverpayPolicy } from '@/lib/collectPlan';

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
});

type PaymentFormData = z.infer<typeof paymentSchema>;

const formatVN = (n: number) => (n > 0 ? n.toLocaleString('vi-VN') : '');
const parseVN = (s: string): number => {
  const digits = s.replace(/\D/g, '');
  return digits ? parseInt(digits, 10) : 0;
};

// Storage trả 409 (hoặc message "already exists"/"duplicate") khi object đã tồn
// tại. Với uploadKey ổn định, đây chính là dấu hiệu retry an toàn: lần trước đã
// tải ảnh lên nhưng response timeout → coi như thành công, tái dùng URL cũ.
const isExistingStorageObjectError = (error: unknown): boolean => {
  const storageError = error as { statusCode?: string | number; message?: string } | null;
  const message = storageError?.message?.toLowerCase() ?? '';
  return String(storageError?.statusCode ?? '') === '409'
    || message.includes('already exists')
    || message.includes('duplicate');
};

type PaymentMethod = 'TM' | 'TT' | 'TK';

const RecordPaymentDialog = ({ open, onOpenChange, invoice }: RecordPaymentDialogProps) => {
  const recordMutation = useRecordPaymentRPC();
  const { data: accounts = [] } = useAccounts();
  const { data: currentUser } = useAuth();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [receiptImage, setReceiptImage] = useState<File | null>(null);
  const [receiptPreview, setReceiptPreview] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [changeUserEdited, setChangeUserEdited] = useState(false);
  const [creditUserEdited, setCreditUserEdited] = useState(false);
  const collectionAttemptRef = useRef<{
    fingerprint: string;
    request: RecordPaymentRPCData | null;
    // uploadKey ổn định để retry sau timeout tái dùng đúng object Storage.
    uploadKey: string;
    // started = đã gọi RPC ghi tiền ít nhất 1 lần cho attempt này.
    started: boolean;
  } | null>(null);

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

  // Chỉ dùng sổ quỹ cùng tổ chức với hóa đơn — tránh chọn nhầm sổ tenant khác.
  const organizationAccounts = useMemo(
    () =>
      (accounts as any[]).filter(
        (account) =>
          !invoice?.organization_id ||
          account.organization_id === invoice.organization_id,
      ),
    [accounts, invoice?.organization_id],
  );
  const realAccounts = useMemo(
    () => organizationAccounts.filter((account) => account.is_virtual === false),
    [organizationAccounts],
  );
  const virtualAccounts = useMemo(
    () => organizationAccounts.filter((account) => account.is_virtual === true),
    [organizationAccounts],
  );
  const accountVirtuality = useMemo(
    () => new Map(organizationAccounts.map((account) => [account.id, account.is_virtual])),
    [organizationAccounts],
  );

  const totalPaid = (watchedLines ?? []).reduce(
    (s, l) => s + (Number((l as any)?.amount) || 0),
    0,
  );

  const outstandingAmount = invoice
    ? Math.max((invoice.total_amount || 0) - (invoice.paid_amount || 0), 0)
    : 0;

  // ID sổ quỹ trùng tên tòa nhà của hoá đơn — fallback cho TT/TK khi
  // toà nhà chưa cấu hình default_account_id_tt/tk trong Cài đặt toà nhà.
  const defaultAccountIdByName = useMemo(() => {
    if (!invoice || !realAccounts.length) return '';
    const buildingName = invoice.building?.name?.trim();
    if (!buildingName) return '';
    return realAccounts.find((a) => a.name?.trim() === buildingName)?.id ?? '';
  }, [invoice, realAccounts]);

  // Sổ quỹ mặc định lấy từ cài đặt toà nhà (mọi user dùng chung).
  const rawBuildingDefaultTT = (invoice?.building as any)?.default_account_id_tt ?? '';
  const rawBuildingDefaultTK = (invoice?.building as any)?.default_account_id_tk ?? '';
  const buildingDefaultTT = realAccounts.some((account) => account.id === rawBuildingDefaultTT)
    ? rawBuildingDefaultTT
    : '';
  const buildingDefaultTK = realAccounts.some((account) => account.id === rawBuildingDefaultTK)
    ? rawBuildingDefaultTK
    : '';
  // Toà nhà có cấu hình default sổ quỹ cho TT/TK chưa? Quyết định xem phương
  // thức tương ứng có xuất hiện trong dropdown và có cần lock TK thành "+".
  const hasBuildingTT = !!buildingDefaultTT;
  const hasBuildingTK = !!buildingDefaultTK;

  // Sổ Thu của user đăng nhập — nếu user có nhiều sổ "…Thu" thì ưu tiên sổ
  // đánh dấu is_default (xem lib/cashAccount), tránh phụ thuộc thứ tự A→Z.
  const myCashAccountId = useMemo(
    () => ownCashAccountId(realAccounts, currentUser?.id),
    [currentUser, realAccounts],
  );

  // Sổ quỹ "Chung" — fallback cho TM khi user đăng nhập không phải joey/nathan
  // (và không sở hữu sổ "Thu" riêng).
  const chungAccountId = useMemo(() => {
    if (!realAccounts.length) return '';
    return realAccounts.find(
      (a) => typeof a.name === 'string' && a.name.trim().toLowerCase() === 'chung',
    )?.id ?? '';
  }, [realAccounts]);

  // Sổ quỹ "Làm tròn tiền thiếu" — dùng cho audit khi residual < 10K
  // được làm tròn. Chỉ là ledger metadata, không trừ số dư.
  const roundingAccountId = useMemo(() => {
    if (!virtualAccounts.length) return '';
    return virtualAccounts.find(
      (a) => typeof a.name === 'string' && a.name.trim() === 'Làm tròn tiền thiếu',
    )?.id ?? '';
  }, [virtualAccounts]);

  const renderAccountItems = () =>
    realAccounts.map((a: any) => (
      <SelectItem key={a.id} value={a.id}>
        {a.name}
        {a.bank_name ? ` — ${a.bank_name}` : ''}
      </SelectItem>
    ));

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

  const overpayPolicy = deriveOverpayPolicy({
    total: totalPaid,
    amountTm: tmTotal,
    remaining: outstandingAmount,
    hasContract: !!invoice?.contract_id,
  });

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
  // QUAN TRỌNG: chỉ áp dụng cơ chế khoá-thành-"+" khi cả TT và TK đều
  // có default account; nếu thiếu một trong hai thì phương thức tương
  // ứng bị ẩn hẳn (xem isTtVisible / isTkVisibleForRow).
  const shouldLockTkForRow = (idx: number): boolean => {
    if (!hasBuildingTT || !hasBuildingTK) return false;
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
  // TT chỉ hiện trong dropdown khi toà nhà có default account TT.
  // Ngoại lệ: nếu dòng hiện tại đang là TT (state cũ) thì vẫn giữ option.
  const isTtVisibleForRow = (currentMethod: PaymentMethod | undefined): boolean => {
    if (currentMethod === 'TT') return true;
    return hasBuildingTT;
  };
  // TK xuất hiện trong 3 trạng thái:
  //   - Đang chọn TK: luôn hiện (tránh mất option khi state cũ)
  //   - Toà nhà thiếu default TK: ẩn hẳn, không kể có TM/TT trước hay không
  //   - Toà nhà có default TK: hiện như bình thường; chỉ khi cả TT cũng có
  //     default (đầy đủ 2 phương thức) thì mới áp dụng cơ chế khoá-thành-"+"
  const isTkVisibleForRow = (
    idx: number,
    fieldId: string,
    currentMethod: PaymentMethod | undefined,
  ): boolean => {
    if (currentMethod === 'TK') return true;
    if (!hasBuildingTK) return false;
    if (!shouldLockTkForRow(idx)) return true;
    return unlockedTkFieldIds.has(fieldId);
  };
  // Có nên hiển thị nút "+" để mở khoá TK ở vị trí option thứ 3 không?
  // Chỉ khi TK đang bị khoá (cần unlock) — không kể trường hợp TK đã bị
  // ẩn hẳn vì thiếu default.
  const showTkPlusForRow = (
    idx: number,
    fieldId: string,
    currentMethod: PaymentMethod | undefined,
  ): boolean => {
    if (currentMethod === 'TK') return false;
    if (!hasBuildingTK) return false;
    if (!shouldLockTkForRow(idx)) return false;
    return !unlockedTkFieldIds.has(fieldId);
  };

  // Method mặc định khi thêm dòng mới: ưu tiên alternate (TM ↔ TT),
  // nhưng phải có default account cho method đó. Nếu không có default
  // nào khả dụng thì fallback TM.
  const defaultMethodForNewRow = (
    lines: Array<{ payment_method?: PaymentMethod } | undefined>,
  ): PaymentMethod => {
    const first = lines[0]?.payment_method;
    if (first === 'TT' || first === 'TK') return 'TM';
    // Dòng đầu là TM (hoặc chưa có) → ưu tiên TT nếu có default,
    // sau đó TK, cuối cùng TM (thêm dòng TM thứ 2).
    if (hasBuildingTT) return 'TT';
    if (hasBuildingTK) return 'TK';
    return 'TM';
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

  // Auto-compute phần dư cho mọi phương thức. TT/TK không đủ TM để hoàn sẽ được
  // giữ thành credit bắt buộc; TM vẫn giữ mặc định hoàn như trước.
  useEffect(() => {
    if (changeUserEdited) return;
    setValue('change_amount', overpayPolicy.overpay);
  }, [overpayPolicy.overpay, changeUserEdited, setValue]);

  useEffect(() => {
    if (overpayPolicy.overpay === 0) {
      setValue('keep_as_credit', false);
      setCreditUserEdited(false);
      return;
    }
    if (overpayPolicy.mustKeepAsCredit) {
      setValue('keep_as_credit', true);
      return;
    }
    if (!creditUserEdited) setValue('keep_as_credit', false);
  }, [overpayPolicy.overpay, overpayPolicy.mustKeepAsCredit, creditUserEdited, setValue]);

  // Pre-select sổ ghi nhận thối theo user: Hiển→Hiển Thối, Hiệp→Hiệp Thối
  // (user khác: sổ "Thối" đầu tiên — giữ hành vi cũ).
  useEffect(() => {
    if (!watchedChangeAmount || watchedChangeAccountId || !virtualAccounts.length) return;
    const target = findOwnChangeAccount(virtualAccounts, currentUser?.id);
    if (target) setValue('change_account_id', target.id);
  }, [watchedChangeAmount, watchedChangeAccountId, virtualAccounts, currentUser?.id, setValue]);

  const handleClose = () => {
    reset();
    setReceiptImage(null);
    setReceiptPreview(null);
    setChangeUserEdited(false);
    setCreditUserEdited(false);
    setUnlockedTkFieldIds(new Set());
    collectionAttemptRef.current = null;
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

  const uploadReceiptImage = async (uploadKey: string): Promise<string | null> => {
    if (!receiptImage) return null;

    const user = await getSessionUser();
    if (!user) throw new Error('Not authenticated');

    const fileExt = receiptImage.name.split('.').pop();
    // Đường dẫn ổn định (uploadKey) để retry sau timeout an toàn: nếu lần trước
    // đã tới Storage nhưng response mất, lần sau gặp 409 → coi như thành công.
    const fileName = `${user.id}/${uploadKey}_receipt.${fileExt}`;

    const { error } = await supabase.storage
      .from('payment-receipts')
      .upload(fileName, receiptImage, {
        cacheControl: '3600',
        upsert: false,
      });

    if (error && !isExistingStorageObjectError(error)) {
      console.error('Upload error:', error);
      // If bucket doesn't exist, try documents bucket
      const { error: fallbackError } = await supabase.storage
        .from('documents')
        .upload(`receipts/${fileName}`, receiptImage, {
          cacheControl: '3600',
          upsert: false,
        });

      if (fallbackError && !isExistingStorageObjectError(fallbackError)) {
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
      const totalAcrossLines = data.payment_lines.reduce(
        (s, l) => s + (Number(l.amount) || 0),
        0,
      );
      const overpay = Math.max(totalAcrossLines - outstandingAmount, 0);
      const submittedChange = data.change_amount || 0;
      if (Math.abs(submittedChange - overpay) >= 0.01) {
        toast.error('Tiền dư phải đúng bằng phần khách đưa vượt số còn phải thu', {
          description: `Phần dư thực tế là ${formatVN(overpay)}đ.`,
        });
        return;
      }
      const submitPolicy = deriveOverpayPolicy({
        total: totalAcrossLines,
        amountTm: tmTotal,
        remaining: outstandingAmount,
        hasContract: !!invoice.contract_id,
      });
      const keepAsCredit = overpay > 0
        && (submitPolicy.mustKeepAsCredit || !!data.keep_as_credit);
      if (overpay > 0 && !keepAsCredit && tmTotal < overpay) {
        toast.error('Tiền mặt TM của lần thu này không đủ để hoàn phần tiền dư');
        return;
      }
      if (keepAsCredit && !invoice.contract_id) {
        toast.error('Hóa đơn không gắn hợp đồng nên không thể giữ tiền dư làm credit');
        return;
      }
      if (overpay > 0 && !keepAsCredit && !data.change_account_id) {
        toast.error('Vui lòng chọn sổ ghi nhận tiền thối');
        return;
      }
      const invalidReceivingLine = data.payment_lines.find(
        (line) => accountVirtuality.get(line.account_id) !== false,
      );
      if (invalidReceivingLine) {
        toast.error(`Sổ nhận ${invalidReceivingLine.payment_method} phải là sổ quỹ thật`);
        return;
      }
      if (
        overpay > 0
        && !keepAsCredit
        && accountVirtuality.get(data.change_account_id ?? '') !== true
      ) {
        toast.error('Sổ ghi nhận tiền thối phải là sổ ảo');
        return;
      }

      const depositDue = deriveInvoiceDepositDue(invoice as any);
      const appliedAmount = Math.min(totalAcrossLines, outstandingAmount);
      const residualAfter = outstandingAmount - appliedAmount;
      const revenueDue = Math.max((invoice.total_amount || 0) - depositDue, 0);
      const depositAfter = Math.max(
        Math.min(
          depositDue,
          (invoice.paid_amount || 0) + appliedAmount - revenueDue,
        ),
        0,
      );
      const roundingWouldSkipDeposit =
        residualAfter > 0 &&
        residualAfter < ROUNDING_THRESHOLD &&
        depositDue - depositAfter >= 0.01;
      const applyRounding =
        residualAfter > 0 &&
        residualAfter < ROUNDING_THRESHOLD &&
        totalAcrossLines > 0 &&
        !roundingWouldSkipDeposit;
      if (applyRounding && !roundingAccountId) {
        toast.error('Thiếu sổ quỹ "Làm tròn tiền thiếu"');
        return;
      }
      if (applyRounding && accountVirtuality.get(roundingAccountId) !== true) {
        toast.error('Sổ quỹ "Làm tròn tiền thiếu" phải là sổ ảo');
        return;
      }

      const fileFingerprint = receiptImage
        ? `${receiptImage.name}:${receiptImage.size}:${receiptImage.type}:${receiptImage.lastModified}`
        : null;
      const fingerprint = JSON.stringify({
        invoice_id: invoice.id,
        payment_lines: data.payment_lines,
        payment_date: data.payment_date,
        keep_as_credit: keepAsCredit,
        change_account_id: data.change_account_id ?? null,
        rounding_account_id: roundingAccountId || null,
        notes: data.notes?.trim() || null,
        file: fileFingerprint,
      });

      const previousAttempt = collectionAttemptRef.current;
      // Fail-closed: nếu attempt trước đã gọi RPC (server có thể đã commit dù
      // client báo lỗi) mà lần này số tiền/nội dung đã khác → chặn, buộc tải
      // lại hóa đơn rồi thao tác theo số còn lại mới, tránh thu trùng.
      if (previousAttempt && previousAttempt.started && previousAttempt.fingerprint !== fingerprint) {
        toast.error('Lần thu trước có thể đã được ghi. Vui lòng đóng và tải lại hóa đơn rồi thao tác theo số còn lại mới.');
        return;
      }
      if (!previousAttempt || previousAttempt.fingerprint !== fingerprint) {
        collectionAttemptRef.current = {
          fingerprint,
          request: null,
          uploadKey: `collect-receipt-${crypto.randomUUID()}`,
          started: false,
        };
      }
      const attempt = collectionAttemptRef.current!;
      if (!attempt.request) {
        let receiptImageUrl: string | null = null;
        if (receiptImage) receiptImageUrl = await uploadReceiptImage(attempt.uploadKey);
        const lastLineIndex = data.payment_lines.length - 1;
        attempt.request = {
          invoice_id: invoice.id,
          collection_date: data.payment_date,
          tenders: data.payment_lines.map((line, index) => ({
            payment_method: line.payment_method,
            gross_amount: line.amount,
            account_id: line.account_id,
            account_is_virtual: accountVirtuality.get(line.account_id) ?? null,
            change_account_id:
              overpay > 0 && !keepAsCredit && line.payment_method === 'TM'
                ? (data.change_account_id ?? null)
                : null,
            change_account_is_virtual:
              overpay > 0 && !keepAsCredit && line.payment_method === 'TM'
                ? accountVirtuality.get(data.change_account_id ?? '') ?? null
                : null,
            rounding_account_id:
              applyRounding && index === lastLineIndex ? roundingAccountId : null,
            rounding_account_is_virtual:
              applyRounding && index === lastLineIndex
                ? accountVirtuality.get(roundingAccountId) ?? null
                : null,
          })),
          overpay_action: overpay > 0
            ? (keepAsCredit ? 'CREDIT' : 'REFUND')
            : 'REJECT',
          allow_rounding: applyRounding,
          notes: data.notes?.trim() || null,
          receipt_image_url: receiptImageUrl,
          expected_paid_amount: invoice.paid_amount || 0,
          invoice_total_amount: invoice.total_amount || 0,
          deposit_due: depositDue,
          has_contract: !!invoice.contract_id,
          idempotency_key: `collect-${crypto.randomUUID()}`,
        };
      }

      const request = attempt.request!;
      // Đánh dấu started TRƯỚC RPC đầu tiên: timeout vẫn có thể là server đã
      // commit, nên mọi lần retry phải tái dùng đúng request + idempotency_key.
      attempt.started = true;
      await recordMutation.mutateAsync(request);
      collectionAttemptRef.current = null;
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

  const overpayAmount = Math.max(totalPaid - outstandingAmount, 0);
  const previewAppliedAmount = Math.min(totalPaid, outstandingAmount);
  const newPaidAmount = (invoice.paid_amount || 0) + previewAppliedAmount;
  const newOutstanding = (invoice.total_amount || 0) - newPaidAmount;
  // Áp dụng làm tròn tự động: residual > 0 và < 10K → coi như đã thanh toán
  // đủ; phần thiếu được ghi nhận vào sổ "Làm tròn tiền thiếu" (metadata).
  const ROUNDING_THRESHOLD = 10000;
  const previewDepositDue = deriveInvoiceDepositDue(invoice as any);
  const previewRevenueDue = Math.max((invoice.total_amount || 0) - previewDepositDue, 0);
  const previewDepositAfter = Math.max(
    Math.min(
      previewDepositDue,
      (invoice.paid_amount || 0) + previewAppliedAmount - previewRevenueDue,
    ),
    0,
  );
  const roundingBlockedByDeposit =
    newOutstanding > 0 &&
    newOutstanding < ROUNDING_THRESHOLD &&
    previewDepositDue - previewDepositAfter >= 0.01;
  const willRound =
    newOutstanding > 0 &&
    newOutstanding < ROUNDING_THRESHOLD &&
    totalPaid > 0 &&
    !roundingBlockedByDeposit;
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
                  <Label htmlFor="amount">Tiền khách đưa *</Label>
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
                      disabled={!overpayPolicy.canKeepAsCredit || overpayPolicy.mustKeepAsCredit}
                      onCheckedChange={(checked) => {
                        if (overpayPolicy.mustKeepAsCredit) return;
                        setCreditUserEdited(true);
                        setValue('keep_as_credit', checked === true, { shouldValidate: true });
                      }}
                    />
                    {overpayPolicy.mustKeepAsCredit
                      ? 'Nợ khách — bắt buộc trừ kỳ sau'
                      : 'Nợ khách (trừ kỳ sau)'}
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

              {/* Phương thức thanh toán — khi TK thì kèm ô Sổ quỹ cùng dòng
                  để quản lý đổi sang sổ khác ngay lúc thu. */}
              <div className="flex gap-4 items-start">
                <div
                  className={
                    watchedLines?.[0]?.payment_method === 'TK'
                      ? 'w-28 shrink-0 space-y-2'
                      : 'flex-1 space-y-2'
                  }
                >
                  <Label>
                    {watchedLines?.[0]?.payment_method === 'TK'
                      ? 'Phương thức *'
                      : 'Phương thức thanh toán *'}
                  </Label>
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
                      {isTtVisibleForRow(
                        watchedLines?.[0]?.payment_method as PaymentMethod | undefined,
                      ) && <SelectItem value="TT">TT</SelectItem>}
                      {isTkVisibleForRow(
                        0,
                        fields[0]?.id ?? '',
                        watchedLines?.[0]?.payment_method as PaymentMethod | undefined,
                      ) && <SelectItem value="TK">TK</SelectItem>}
                      {showTkPlusForRow(
                        0,
                        fields[0]?.id ?? '',
                        watchedLines?.[0]?.payment_method as PaymentMethod | undefined,
                      ) && (
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
                {watchedLines?.[0]?.payment_method === 'TK' && (
                  <div className="flex-1 space-y-2 min-w-0">
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
                      <SelectContent>{renderAccountItems()}</SelectContent>
                    </Select>
                    {errors.payment_lines?.[0]?.account_id && (
                      <p className="text-sm text-red-500">
                        {errors.payment_lines[0]?.account_id?.message}
                      </p>
                    )}
                  </div>
                )}
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

              {/* Sổ quỹ nhận — TM/TT chỉ hiện khi auto-pick chưa ra (accounts
                  chưa load xong hoặc tòa nhà chưa cấu hình default cho
                  phương thức này). TK đã có ô riêng cạnh phương thức. */}
              {!watchedLines?.[0]?.account_id
                && watchedLines?.[0]?.payment_method !== 'TK' && (
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
                    <SelectContent>{renderAccountItems()}</SelectContent>
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
                      <Label>Tiền khách đưa *</Label>
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
                          {isTtVisibleForRow(
                            watchedLines?.[idx]?.payment_method as
                              | PaymentMethod
                              | undefined,
                          ) && <SelectItem value="TT">TT</SelectItem>}
                          {isTkVisibleForRow(
                            idx,
                            field.id,
                            watchedLines?.[idx]?.payment_method as
                              | PaymentMethod
                              | undefined,
                          ) && <SelectItem value="TK">TK</SelectItem>}
                          {showTkPlusForRow(
                            idx,
                            field.id,
                            watchedLines?.[idx]?.payment_method as
                              | PaymentMethod
                              | undefined,
                          ) && (
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
                  {/* Sổ quỹ nhận — luôn hiện với dòng TK (cho đổi sổ tại chỗ);
                      TM/TT chỉ hiện khi auto-pick chưa ra (toà nhà chưa cấu
                      hình default cho phương thức này). */}
                  {(watchedLines?.[idx]?.payment_method === 'TK'
                    || !watchedLines?.[idx]?.account_id) && (
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
                        <SelectContent>{renderAccountItems()}</SelectContent>
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
                    disabled={!overpayPolicy.canKeepAsCredit || overpayPolicy.mustKeepAsCredit}
                    onCheckedChange={(checked) => {
                      if (overpayPolicy.mustKeepAsCredit) return;
                      setCreditUserEdited(true);
                      setValue('keep_as_credit', checked === true, { shouldValidate: true });
                    }}
                  />
                  {overpayPolicy.mustKeepAsCredit
                    ? 'Nợ khách — bắt buộc trừ kỳ sau'
                    : 'Nợ khách (trừ kỳ sau)'}
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
                  {changeAccountOptions(virtualAccounts, currentUser?.id).map((a: any) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name}
                      {a.bank_name ? ` — ${a.bank_name}` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Dùng khi hoàn phần dư bằng TM. Số tiền thối được ghi vào sổ này để audit — không trừ số dư sổ.
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
                {overpayAmount > 0 && (
                  <div className="flex justify-between">
                    <span className="text-gray-700">Tiền thừa:</span>
                    <span className="font-medium text-blue-600">{formatCurrency(overpayAmount)}</span>
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
                      : overpayAmount > 0
                        ? watchedKeepAsCredit
                          ? `Hóa đơn sẽ được thanh toán đủ và giữ ${formatCurrency(overpayAmount)} làm credit trừ kỳ sau.`
                          : `Hóa đơn sẽ được thanh toán đủ và thối lại ${formatCurrency(overpayAmount)} qua sổ đã chọn.`
                        : 'Hóa đơn sẽ được đánh dấu là đã thanh toán đầy đủ'}
                  </AlertDescription>
                </Alert>
              )}

              {roundingBlockedByDeposit && (
                <Alert className="bg-amber-50 border-amber-200">
                  <AlertDescription className="text-amber-800 text-sm">
                    Còn thiếu {formatCurrency(newOutstanding)} thuộc phần tiền cọc nên hệ thống không làm tròn; hóa đơn sẽ giữ trạng thái trả một phần.
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
