import { useEffect, useMemo, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Upload, X, FileText } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Button } from '@/components/ui/button';
import { CurrencyInput } from '@/components/ui/currency-input';
import { DateSegmentInput } from '@/components/ui/date-segment-input';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { formatVND } from '@/lib/utils';
import {
  buildIncomeExpensePostingSchema,
  type IncomeExpensePostingFormValues,
  type PostFinanceExecutionInput,
  type PostingSubjectKind,
} from '@/lib/incomeExpensePostingValidation';

/** Chế độ mở dialog (§12.3/§12.4). */
export type IncomeExpensePostingMode = 'POST_APPROVED' | 'APPROVE_AND_POST';

/** Sổ quỹ actor đang là CUSTODIAN — nguồn duy nhất cho ô "Sổ quỹ" (§12.6). */
export interface PostingCashbookOption {
  id: string;
  name: string;
  bankName?: string | null;
}

/** Tóm tắt phiếu/đối tượng để dựng tiêu đề + quy tắc số tiền/chứng từ. */
export interface PostingVoucherSummary {
  subjectKind: PostingSubjectKind;
  subjectId: string;
  /** Chọn cặp nhãn Chi/Thu. */
  type: 'INCOME' | 'EXPENSE';
  /** Tổng đã duyệt — số tiền read-only cho phiếu VOUCHER. */
  approvedTotal: number;
  /** Tên phiếu (hiển thị phụ, tùy chọn). */
  name?: string;
  /**
   * MULTI_TRANCHE salary: số còn được phép chi (ceiling - đã chi). Chỉ dùng khi
   * subjectKind='SALARY_AUTHORIZATION'.
   */
  remainingAmount?: number;
  /**
   * Manual Thu/Chi bắt buộc >= 1 chứng từ (mặc định true). System writer đã có
   * SYSTEM_REFERENCE thì truyền false.
   */
  requiresEvidence?: boolean;
}

/** Capability server trả cho actor trên phiếu/sổ đang xét. */
export interface PostingCapability {
  isCustodian: boolean;
  canApprove: boolean;
}

export interface IncomeExpensePostingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: IncomeExpensePostingMode;
  voucher: PostingVoucherSummary;
  capability: PostingCapability;
  /** Chỉ sổ actor đang là CUSTODIAN (§12.6). */
  cashbookOptions: PostingCashbookOption[];
  expectedExecutionRevision: number;
  expectedApprovalVersion: number;
  expectedPostingVersion: number;
  /** Idempotency key do server cấp; thiếu thì dialog tự sinh 1 lần mỗi lần mở. */
  idempotencyKey?: string;
  /**
   * Nối luồng upload chứng từ thật (create intent → upload → finalize) và trả
   * evidenceId đã finalize. Không truyền → placeholder chỉ dựng giao diện.
   */
  onUploadEvidence?: (file: File) => Promise<string | null>;
  /** Không gọi API trực tiếp — assemble input rồi trả về caller. */
  onSubmit: (input: PostFinanceExecutionInput) => void | Promise<void>;
  isSubmitting?: boolean;
}

/** Sinh idempotency key khi server không cấp (chống double-post lúc retry UI). */
function genIdempotencyKey(): string {
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return crypto.randomUUID();
  }
  return `post-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function todayIso(): string {
  return new Date().toISOString().split('T')[0];
}

/**
 * Placeholder thu thập evidenceIds cho §12.3. Nếu caller nối `onUpload` thật thì
 * dùng id đã finalize; nếu không, tạo id tạm chỉ để dựng UI (báo rõ chưa nối).
 */
function EvidencePlaceholderUpload({
  value,
  onChange,
  disabled,
  onUpload,
}: {
  value: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
  onUpload?: (file: File) => Promise<string | null>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setBusy(true);
    try {
      const added: string[] = [];
      for (const file of Array.from(files)) {
        if (onUpload) {
          const id = await onUpload(file);
          if (id) added.push(id);
        } else {
          // Chưa nối luồng thật — id tạm chỉ để dựng giao diện.
          added.push(`local:${genIdempotencyKey()}`);
        }
      }
      if (added.length > 0) onChange([...value, ...added]);
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const removeAt = (idx: number) => {
    onChange(value.filter((_, i) => i !== idx));
  };

  return (
    <div className="space-y-2">
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,application/pdf"
        multiple
        className="hidden"
        onChange={(e) => handleFiles(e.target.files)}
        disabled={disabled || busy}
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled || busy}
        onClick={() => inputRef.current?.click()}
      >
        <Upload className="h-4 w-4 mr-1" />
        {busy ? 'Đang tải...' : 'Thêm chứng từ'}
      </Button>

      {value.length > 0 && (
        <ul className="space-y-1">
          {value.map((id, idx) => (
            <li
              key={`${id}-${idx}`}
              className="flex items-center justify-between gap-2 rounded-md border px-2 py-1 text-sm"
            >
              <span className="flex items-center gap-2 truncate">
                <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{id}</span>
              </span>
              {!disabled && (
                <button
                  type="button"
                  className="text-destructive hover:opacity-70"
                  onClick={() => removeAt(idx)}
                  aria-label="Gỡ chứng từ"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {!onUpload && (
        <p className="text-xs text-amber-600">
          Chưa nối luồng tải chứng từ — id tạm thời chỉ để dựng giao diện.
        </p>
      )}
    </div>
  );
}

/**
 * Posting dialog dùng chung (plan §12.3) cho page Thu Chi và Approval inbox.
 *
 * Chỉ ba trường người dùng nhập: Ngày Thu/Chi, Sổ quỹ, Hình ảnh/chứng từ. Số
 * tiền read-only = tổng đã duyệt, ngoại trừ MULTI_TRANCHE salary cho nhập tối đa
 * remaining. KHÔNG gọi API — assemble `PostFinanceExecutionInput` rồi
 * `onSubmit`. Tuyệt đối không có chữ "Nháp".
 */
export default function IncomeExpensePostingDialog({
  open,
  onOpenChange,
  mode,
  voucher,
  capability,
  cashbookOptions,
  expectedExecutionRevision,
  expectedApprovalVersion,
  expectedPostingVersion,
  idempotencyKey,
  onUploadEvidence,
  onSubmit,
  isSubmitting = false,
}: IncomeExpensePostingDialogProps) {
  const isExpense = voucher.type === 'EXPENSE';
  const allowAmount = voucher.subjectKind === 'SALARY_AUTHORIZATION';
  const requireEvidence = voucher.requiresEvidence ?? true;

  // Tiêu đề: "Chi"/"Thu" theo loại phiếu; mode Duyệt-và-Chi/Thu thêm tiền tố.
  const baseWord = isExpense ? 'Chi' : 'Thu';
  const title = mode === 'APPROVE_AND_POST' ? `Duyệt và ${baseWord}` : baseWord;
  const dateLabel = isExpense ? 'Ngày Chi' : 'Ngày Thu';

  // Capability gate: POST cần CUSTODIAN; APPROVE_AND_POST cần cả hai (§12.4).
  const capabilityOk =
    mode === 'APPROVE_AND_POST'
      ? capability.canApprove && capability.isCustodian
      : capability.isCustodian;

  const schema = useMemo(
    () =>
      buildIncomeExpensePostingSchema({
        requireEvidence,
        allowAmount,
        remainingAmount: voucher.remainingAmount,
      }),
    [requireEvidence, allowAmount, voucher.remainingAmount],
  );

  const form = useForm<IncomeExpensePostingFormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      postedOn: todayIso(),
      cashbookId: cashbookOptions.length === 1 ? cashbookOptions[0].id : '',
      evidenceIds: [],
      amount: allowAmount ? voucher.remainingAmount : undefined,
    },
  });

  // Idempotency key: dùng key server cấp; thiếu thì sinh 1 lần mỗi lần MỞ để
  // retry cùng phiên không tạo posting mới.
  const generatedKey = useMemo(
    () => idempotencyKey ?? genIdempotencyKey(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [idempotencyKey, open, voucher.subjectId, mode],
  );

  // Reset form khi mở lại (đổi phiếu/mode).
  useEffect(() => {
    if (!open) return;
    form.reset({
      postedOn: todayIso(),
      cashbookId: cashbookOptions.length === 1 ? cashbookOptions[0].id : '',
      evidenceIds: [],
      amount: allowAmount ? voucher.remainingAmount : undefined,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, voucher.subjectId, mode]);

  const submit = form.handleSubmit(async (values) => {
    const input: PostFinanceExecutionInput = {
      subjectKind: voucher.subjectKind,
      subjectId: voucher.subjectId,
      cashbookId: values.cashbookId,
      postedOn: values.postedOn,
      evidenceIds: values.evidenceIds,
      amount: allowAmount ? values.amount : undefined,
      expectedExecutionRevision,
      expectedApprovalVersion,
      expectedPostingVersion,
      idempotencyKey: generatedKey,
    };
    await onSubmit(input);
  });

  const remaining = voucher.remainingAmount;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {voucher.name && (
            <DialogDescription className="truncate">
              {voucher.name}
            </DialogDescription>
          )}
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={submit} className="space-y-4">
            {/* Ngày Thu/Chi */}
            <FormField
              control={form.control}
              name="postedOn"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{dateLabel} *</FormLabel>
                  <FormControl>
                    <DateSegmentInput
                      value={field.value || ''}
                      onChange={field.onChange}
                      onBlur={field.onBlur}
                      name={field.name}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Sổ quỹ — chỉ sổ actor đang là CUSTODIAN */}
            <FormField
              control={form.control}
              name="cashbookId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Sổ quỹ *</FormLabel>
                  <FormControl>
                    <SearchableSelect
                      value={field.value || undefined}
                      onValueChange={field.onChange}
                      placeholder="Chọn sổ quỹ"
                      searchPlaceholder="Tìm sổ quỹ..."
                      options={cashbookOptions.map((c) => ({
                        value: c.id,
                        label: c.bankName ? `${c.name} (${c.bankName})` : c.name,
                      }))}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Số tiền: read-only = tổng đã duyệt, ngoại trừ MULTI_TRANCHE salary */}
            {allowAmount ? (
              <FormField
                control={form.control}
                name="amount"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Số tiền đợt chi *</FormLabel>
                    <FormControl>
                      <CurrencyInput
                        value={field.value ?? null}
                        onChange={field.onChange}
                        onBlur={field.onBlur}
                        placeholder="Nhập số tiền đợt này"
                      />
                    </FormControl>
                    {remaining != null && (
                      <p className="text-xs text-muted-foreground">
                        Tối đa còn lại: <b>{formatVND(remaining)}</b>
                      </p>
                    )}
                    <FormMessage />
                  </FormItem>
                )}
              />
            ) : (
              <FormItem>
                <FormLabel>Số tiền</FormLabel>
                <div className="flex h-10 items-center rounded-md border bg-muted/40 px-3 text-sm font-semibold tabular-nums">
                  {formatVND(voucher.approvedTotal)}
                </div>
                <p className="text-xs text-muted-foreground">
                  Số tiền cố định bằng tổng đã duyệt.
                </p>
              </FormItem>
            )}

            {/* Hình ảnh / chứng từ */}
            <FormField
              control={form.control}
              name="evidenceIds"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    Hình ảnh/chứng từ {requireEvidence ? '*' : '(tuỳ chọn)'}
                  </FormLabel>
                  <FormControl>
                    <EvidencePlaceholderUpload
                      value={field.value ?? []}
                      onChange={field.onChange}
                      onUpload={onUploadEvidence}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {!capabilityOk && (
              <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700">
                {mode === 'APPROVE_AND_POST'
                  ? 'Cần đồng thời quyền Duyệt và là Người giữ sổ quỹ để Duyệt và ' +
                    baseWord.toLowerCase() +
                    '.'
                  : 'Chỉ Người giữ sổ quỹ mới ghi ' +
                    baseWord.toLowerCase() +
                    ' được.'}
              </p>
            )}

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                Huỷ bỏ
              </Button>
              <Button type="submit" disabled={isSubmitting || !capabilityOk}>
                {isSubmitting ? 'Đang xử lý...' : title}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
