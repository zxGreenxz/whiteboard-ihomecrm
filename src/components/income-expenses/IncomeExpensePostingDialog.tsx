import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { StorageImage } from '@/components/ui/storage-image';
import { useClipboardImagePaste } from '@/hooks/useClipboardImagePaste';
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
  /**
   * Sổ quỹ đang ghi trên phiếu — dùng để CHỌN SẴN ô "Sổ quỹ" khi mở hộp thoại.
   * Chỉ là gợi ý: người chi vẫn đổi được, và tiền đi theo sổ tại thời điểm bấm
   * lưu. Nếu sổ này không nằm trong `cashbookOptions` (actor không giữ sổ đó)
   * thì ô để trống — chọn sẵn một sổ không được phép chỉ dẫn tới 42501.
   */
  defaultCashbookId?: string | null;
  /**
   * Ảnh đính kèm sẵn trên phiếu (income_expenses.attachments) — hiển thị để đối
   * chiếu ngay trong hộp thoại.
   *
   * LƯU Ý: đây KHÔNG phải chứng từ chi. Chứng từ chi là bản ghi evidence riêng
   * (intent → upload → finalize) mà server kiểm FINALIZED theo tenant; ảnh đính
   * kèm chỉ là file trong bucket của phiếu. Vì vậy chúng chỉ xem được, không tự
   * động thoả điều kiện "phải có chứng từ".
   */
  attachments?: string[] | null;
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
  /**
   * 7ai: biến ảnh ĐÃ đính kèm trên phiếu thành chứng từ hợp lệ (không tải lại).
   * Gọi 1 lần khi mở hộp thoại nếu phiếu có ảnh và chưa chọn chứng từ nào —
   * nhờ vậy người chi bấm lưu được ngay, chỉ thêm ảnh khi cần bổ sung.
   */
  onAdoptAttachments?: (
    voucherId: string,
  ) => Promise<{ evidenceIds: string[]; skipped: { url: string; reason: string }[] }>;
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
  existingAttachments = [],
  adoptedCount = 0,
  adopting = false,
  adoptSkipped = [],
}: {
  value: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
  onUpload?: (file: File) => Promise<string | null>;
  /** Ảnh đã đính kèm từ lúc tạo phiếu. */
  existingAttachments?: string[];
  /** Bao nhiêu ảnh trong số đó đã được nhận làm chứng từ (7ai). */
  adoptedCount?: number;
  adopting?: boolean;
  adoptSkipped?: { url: string; reason: string }[];
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const handleFiles = useCallback(
    async (files: FileList | File[] | null) => {
      const list = files ? Array.from(files as ArrayLike<File>) : [];
      if (list.length === 0) return;
      setBusy(true);
      try {
        const added: string[] = [];
        for (const file of list) {
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
    },
    [onChange, onUpload, value],
  );

  // Ctrl+V dán ảnh ngay trong ô chứng từ (đối xứng AttachmentUpload lúc tạo phiếu).
  const pasteHandlers = useClipboardImagePaste({
    onFiles: handleFiles,
    enabled: !disabled && !busy,
    multiple: true,
  });

  const removeAt = (idx: number) => {
    onChange(value.filter((_, i) => i !== idx));
  };

  return (
    <div className="space-y-2" {...pasteHandlers}>
      {existingAttachments.length > 0 && (
        <div className="space-y-1 rounded-md border border-dashed bg-muted/30 p-2">
          <p className="text-xs text-muted-foreground">
            {adopting
              ? `Đang nhận ${existingAttachments.length} ảnh đính kèm làm chứng từ…`
              : adoptedCount > 0
                ? `Dùng ${adoptedCount}/${existingAttachments.length} ảnh đính kèm sẵn làm chứng từ — bấm lưu được ngay, cần bổ sung thì thêm ở dưới.`
                : `Ảnh đính kèm từ lúc tạo phiếu (${existingAttachments.length}) — chưa dùng làm chứng từ được, hãy thêm chứng từ ở dưới.`}
          </p>
          {adoptSkipped.length > 0 && (
            <p className="text-xs text-amber-700">
              {adoptSkipped.length} ảnh không dùng lại được
              {adoptSkipped.some((s) => s.reason === 'ATTACHED')
                ? ' (đã dùng cho lần ghi sổ trước — mỗi lần chi cần chứng từ riêng)'
                : ''}
              .
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {existingAttachments.map((url, idx) => (
              <div
                key={`${url}-${idx}`}
                className="h-16 w-16 overflow-hidden rounded border bg-background"
                title={`Ảnh đính kèm ${idx + 1}`}
              >
                <StorageImage
                  value={url}
                  alt={`Ảnh đính kèm ${idx + 1}`}
                  className="h-full w-full object-cover"
                />
              </div>
            ))}
          </div>
        </div>
      )}

      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,application/pdf"
        multiple
        className="hidden"
        onChange={(e) => handleFiles(e.target.files)}
        disabled={disabled || busy}
      />
      <div className="flex items-center gap-2">
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
        <span className="text-xs text-muted-foreground">
          hoặc đưa chuột vào đây rồi bấm Ctrl+V để dán ảnh
        </span>
      </div>

      {value.length > 0 && (
        <ul className="space-y-1">
          {value.map((id, idx) => (
            <li
              key={`${id}-${idx}`}
              className="flex items-center justify-between gap-2 rounded-md border px-2 py-1 text-sm"
            >
              <span className="flex items-center gap-2 truncate">
                <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="truncate" title={id}>
                  Chứng từ {idx + 1}
                  {idx < adoptedCount && ' — ảnh đính kèm sẵn'}
                </span>
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
  onAdoptAttachments,
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

  /**
   * Sổ chọn sẵn: ưu tiên sổ đang ghi trên phiếu (nếu actor thật sự giữ sổ đó),
   * sau đó mới tới quy tắc cũ "chỉ có đúng 1 sổ thì chọn luôn".
   * KHÔNG chọn sẵn sổ nằm ngoài quyền giữ sổ — server sẽ từ chối 42501.
   */
  const defaultCashbookId = voucher.defaultCashbookId ?? null;
  const cashbookOnVoucherAllowed =
    !!defaultCashbookId && cashbookOptions.some((c) => c.id === defaultCashbookId);
  const resolvedCashbookId = useMemo(() => {
    if (cashbookOnVoucherAllowed) return defaultCashbookId as string;
    if (cashbookOptions.length === 1) return cashbookOptions[0].id;
    return '';
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cashbookOnVoucherAllowed, defaultCashbookId, cashbookOptions]);

  const form = useForm<IncomeExpensePostingFormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      postedOn: todayIso(),
      cashbookId: resolvedCashbookId,
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
      cashbookId: resolvedCashbookId,
      evidenceIds: [],
      amount: allowAmount ? voucher.remainingAmount : undefined,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, voucher.subjectId, mode]);

  /**
   * Danh sách sổ nạp BẤT ĐỒNG BỘ (query chỉ bật khi dialog mở) nên lúc reset ở
   * trên `cashbookOptions` thường còn rỗng ⇒ mọi giá trị chọn sẵn đều rơi mất.
   * Khi danh sách về, điền lại — nhưng CHỈ khi ô còn trống, để không bao giờ
   * đè lên sổ người dùng vừa tự chọn.
   */
  useEffect(() => {
    if (!open || !resolvedCashbookId) return;
    if (form.getValues('cashbookId')) return;
    form.setValue('cashbookId', resolvedCashbookId, { shouldValidate: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, resolvedCashbookId]);

  /**
   * 7ai: ảnh đã đính kèm trên phiếu ĐƯỢC DÙNG LUÔN làm chứng từ. Chạy 1 lần mỗi
   * lần mở, chỉ khi phiếu có ảnh và chưa có chứng từ nào được chọn — người chi
   * mở lên là bấm lưu được ngay, muốn bổ sung thì thêm ảnh mới.
   */
  const attachments = useMemo(
    () => voucher.attachments ?? [],
    [voucher.attachments],
  );
  const [adoptedIds, setAdoptedIds] = useState<string[]>([]);
  const [adoptSkipped, setAdoptSkipped] = useState<
    { url: string; reason: string }[]
  >([]);
  const [adopting, setAdopting] = useState(false);

  useEffect(() => {
    if (!open) {
      setAdoptedIds([]);
      setAdoptSkipped([]);
      return;
    }
    if (attachments.length === 0 || !onAdoptAttachments) return;
    if ((form.getValues('evidenceIds') ?? []).length > 0) return;

    let cancelled = false;
    setAdopting(true);
    onAdoptAttachments(voucher.subjectId)
      .then((res) => {
        if (cancelled) return;
        setAdoptedIds(res.evidenceIds);
        setAdoptSkipped(res.skipped ?? []);
        if (
          res.evidenceIds.length > 0 &&
          (form.getValues('evidenceIds') ?? []).length === 0
        ) {
          form.setValue('evidenceIds', res.evidenceIds, { shouldValidate: true });
        }
      })
      .finally(() => {
        if (!cancelled) setAdopting(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, voucher.subjectId, mode, attachments.length]);

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
                  {defaultCashbookId && !cashbookOnVoucherAllowed && (
                    <p className="text-xs text-amber-700">
                      Sổ quỹ ghi trên phiếu không nằm trong các sổ bạn đang giữ —
                      hãy chọn đúng sổ bạn thực {baseWord.toLowerCase()}.
                    </p>
                  )}
                  {cashbookOnVoucherAllowed && (
                    <p className="text-xs text-muted-foreground">
                      Đang chọn sẵn sổ ghi trên phiếu. Đổi sổ khác cũng được —
                      tiền đi theo sổ tại thời điểm bấm “{title}”.
                    </p>
                  )}
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
                      existingAttachments={attachments}
                      adoptedCount={adoptedIds.length}
                      adopting={adopting}
                      adoptSkipped={adoptSkipped}
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
