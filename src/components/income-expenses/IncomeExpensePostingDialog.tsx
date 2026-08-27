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
import { cn, formatVND } from '@/lib/utils';
import { todayISO } from '@/lib/collect';
import {
  buildPostingEvidenceItems,
  countUsableEvidence,
  isPdfAttachment,
  type PostingEvidenceItem,
} from '@/lib/postingEvidenceItems';
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
   * Ảnh đính kèm của phiếu (`income_expenses.attachments`) — TỪ 27/08/2026 đây
   * CHÍNH LÀ danh sách chứng từ của hộp thoại này.
   *
   * Chứng từ vẫn là bản ghi riêng trong `finance_evidence_objects` (server kiểm
   * FINALIZED theo tenant), nhưng nó trỏ vào đúng file đã đính kèm — một tấm
   * ảnh, một file trong kho. Ảnh đã dùng cho lần ghi sổ trước sẽ hiện mờ kèm lý
   * do, vì luật one-shot bắt mỗi lần ghi sổ phải có chứng từ riêng.
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
  /**
   * Dán ảnh = đính ảnh LÊN PHIẾU rồi nhận chính nó làm chứng từ (đường chính từ
   * 27/08/2026 — xem `useAttachPostingEvidence`). Không truyền thì rơi về
   * `onUploadEvidence`, lúc đó ảnh chỉ nằm ở kho chứng từ và KHÔNG hiện ở dòng
   * thu chi.
   */
  onAttachEvidence?: (file: File) => Promise<{
    url: string | null;
    evidenceIds: string[];
    skipped: { url: string; reason: string }[];
    attachedToVoucher: boolean;
  } | null>;
  /** Gỡ một ảnh khỏi phiếu (server chỉ cho người có quyền sửa thu chi). */
  onRemoveAttachment?: (
    url: string,
  ) => Promise<{ evidenceIds: string[]; skipped: { url: string; reason: string }[] } | null>;
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
  return todayISO();
}

/**
 * Ô "Hình ảnh/chứng từ" — MỘT lưới ảnh duy nhất của phiếu.
 *
 * Trước 27/08/2026 chỗ này vẽ hai khối tách nhau: khối thumbnail "ảnh đính kèm
 * sẵn" (chỉ để xem) và một danh sách CHỮ "Chứng từ 1, Chứng từ 2" cho ảnh vừa
 * dán — vì ảnh vừa dán chỉ trả về `evidenceId` (uuid), component không có URL
 * nào để vẽ. Chủ báo đúng hai triệu chứng của kiến trúc đó: dán ảnh xong không
 * thấy ảnh thu nhỏ, và chi xong ảnh không hiện ở dòng thu chi.
 *
 * Giờ ảnh chứng từ CHÍNH LÀ ảnh đính kèm của phiếu, nên chỉ còn một danh sách.
 * Ảnh không dùng được cho lần ghi sổ này (vd đã dùng cho lần chi trước) vẫn hiện
 * nhưng mờ đi và nói rõ lý do — im lặng bỏ qua là cách chắc chắn làm người dùng
 * tưởng hệ thống nuốt mất ảnh.
 */
function PostingEvidenceUpload({
  items,
  onFiles,
  onRemove,
  busy,
  adopting,
  disabled,
  fallbackCount,
}: {
  items: PostingEvidenceItem[];
  onFiles: (files: FileList | File[] | null) => Promise<void>;
  /** Không truyền → không cho gỡ (vd hộp thoại mở cho subject không phải phiếu). */
  onRemove?: (url: string) => Promise<void>;
  busy: boolean;
  adopting: boolean;
  disabled?: boolean;
  /** Số chứng từ chỉ nằm ở kho chứng từ, không đính được lên phiếu (đường lùi). */
  fallbackCount: number;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFiles = useCallback(
    async (files: FileList | File[] | null) => {
      await onFiles(files);
      if (inputRef.current) inputRef.current.value = '';
    },
    [onFiles],
  );

  // Ctrl+V dán ảnh ngay trong ô chứng từ (đối xứng AttachmentUpload lúc tạo phiếu).
  const pasteHandlers = useClipboardImagePaste({
    onFiles: handleFiles,
    enabled: !disabled && !busy,
    multiple: true,
  });

  const usable = countUsableEvidence(items);

  return (
    <div className="space-y-2" {...pasteHandlers}>
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

      {adopting && (
        <p className="text-xs text-muted-foreground">Đang kiểm ảnh của phiếu…</p>
      )}

      {items.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {items.map((item) => (
            <div
              key={item.url}
              className={cn(
                'relative group h-20 w-20 overflow-hidden rounded-lg border bg-muted/40',
                !item.usable && 'opacity-40 grayscale',
              )}
              title={
                item.usable
                  ? item.addedNow
                    ? 'Ảnh vừa thêm — đã đính lên phiếu'
                    : 'Ảnh đính kèm của phiếu, dùng làm chứng từ'
                  : item.reasonText
              }
            >
              {isPdfAttachment(item.url) ? (
                <div className="flex h-full w-full items-center justify-center">
                  <FileText className="h-8 w-8 text-muted-foreground" />
                </div>
              ) : (
                <StorageImage
                  value={item.url}
                  alt="Chứng từ"
                  className="h-full w-full object-cover"
                />
              )}
              {onRemove && !disabled && (
                <button
                  type="button"
                  className="absolute right-0.5 top-0.5 rounded-full bg-red-500 p-0.5 text-white opacity-0 transition-opacity group-hover:opacity-100"
                  onClick={() => onRemove(item.url)}
                  aria-label="Gỡ chứng từ"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {items.some((i) => !i.usable) && (
        <p className="text-xs text-amber-700">
          {items.filter((i) => !i.usable).length} ảnh mờ:{' '}
          {items.find((i) => !i.usable)?.reasonText}. Hãy thêm ảnh mới cho lần này.
        </p>
      )}

      {items.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {usable > 0
            ? `${usable} ảnh tính là chứng từ cho lần ghi sổ này — cũng chính là ảnh đính kèm của phiếu.`
            : 'Chưa có ảnh nào tính là chứng từ cho lần ghi sổ này.'}
        </p>
      )}

      {fallbackCount > 0 && (
        <p className="text-xs text-amber-700">
          {fallbackCount} chứng từ chỉ lưu ở kho chứng từ (không đính được lên
          phiếu) — sẽ không hiện ở dòng thu chi.
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
  onAttachEvidence,
  onRemoveAttachment,
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
  /** URL vừa dán trong phiên này — `voucher.attachments` là ảnh chụp lúc mở nên không tự cập nhật. */
  const [sessionUrls, setSessionUrls] = useState<string[]>([]);
  /** URL vừa gỡ khỏi phiếu — loại khỏi danh sách hiển thị mà không cần mở lại. */
  const [removedUrls, setRemovedUrls] = useState<string[]>([]);
  /** Chứng từ đi ĐƯỜNG LÙI: có trong kho chứng từ nhưng không đính được lên phiếu. */
  const [fallbackIds, setFallbackIds] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    if (!open) {
      setAdoptedIds([]);
      setAdoptSkipped([]);
      setSessionUrls([]);
      setRemovedUrls([]);
      setFallbackIds([]);
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
      })
      .finally(() => {
        if (!cancelled) setAdopting(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, voucher.subjectId, mode, attachments.length]);

  /**
   * `evidenceIds` của form LUÔN được suy ra, không bao giờ sửa tay: chứng từ hợp
   * lệ = ảnh của phiếu mà server nhận (adopt) + chứng từ đi đường lùi. Suy ra
   * thay vì tích luỹ để ảnh vừa gỡ biến mất khỏi lần ghi sổ ngay lập tức.
   */
  useEffect(() => {
    const next = [...adoptedIds, ...fallbackIds];
    const current = form.getValues('evidenceIds') ?? [];
    if (current.length === next.length && current.every((v, i) => v === next[i])) return;
    form.setValue('evidenceIds', next, { shouldValidate: next.length > 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adoptedIds, fallbackIds]);

  const evidenceItems = useMemo(
    () =>
      buildPostingEvidenceItems({
        attachments: attachments.filter((u) => !removedUrls.includes(u)),
        sessionUploaded: sessionUrls,
        skipped: adoptSkipped,
      }),
    [attachments, removedUrls, sessionUrls, adoptSkipped],
  );

  const handleEvidenceFiles = useCallback(
    async (files: FileList | File[] | null) => {
      const list = files ? Array.from(files as ArrayLike<File>) : [];
      if (list.length === 0) return;
      setUploading(true);
      try {
        for (const file of list) {
          if (onAttachEvidence) {
            const res = await onAttachEvidence(file);
            if (!res) continue;
            if (res.attachedToVoucher) {
              if (res.url) setSessionUrls((prev) => [...prev, res.url as string]);
              setAdoptedIds(res.evidenceIds);
              setAdoptSkipped(res.skipped ?? []);
            } else {
              setFallbackIds((prev) => [...prev, ...res.evidenceIds]);
            }
            continue;
          }
          if (onUploadEvidence) {
            const id = await onUploadEvidence(file);
            if (id) setFallbackIds((prev) => [...prev, id]);
          }
        }
      } finally {
        setUploading(false);
      }
    },
    [onAttachEvidence, onUploadEvidence],
  );

  const handleEvidenceRemove = useCallback(
    async (url: string) => {
      if (!onRemoveAttachment) return;
      const res = await onRemoveAttachment(url);
      if (!res) return; // server từ chối (thiếu quyền sửa) — không giả vờ đã gỡ
      setRemovedUrls((prev) => [...prev, url]);
      setSessionUrls((prev) => prev.filter((u) => u !== url));
      setAdoptedIds(res.evidenceIds);
      setAdoptSkipped(res.skipped ?? []);
    },
    [onRemoveAttachment],
  );

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
              render={() => (
                <FormItem>
                  <FormLabel>
                    Hình ảnh/chứng từ {requireEvidence ? '*' : '(tuỳ chọn)'}
                  </FormLabel>
                  <FormControl>
                    <PostingEvidenceUpload
                      items={evidenceItems}
                      onFiles={handleEvidenceFiles}
                      onRemove={onRemoveAttachment ? handleEvidenceRemove : undefined}
                      busy={uploading}
                      adopting={adopting}
                      fallbackCount={fallbackIds.length}
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
