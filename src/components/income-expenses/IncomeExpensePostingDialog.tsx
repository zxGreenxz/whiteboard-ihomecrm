import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Upload, X, FileText } from 'lucide-react';
import { toast } from 'sonner';
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
import { usePostingAttachmentDraft } from '@/hooks/income-expenses/financeV2Mutations';

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
   * Có truyền = chế độ ĐÍNH ẢNH LÊN PHIẾU (đường chính từ 27/08/2026): ảnh dán
   * vào hộp thoại là ảnh đính kèm của phiếu và chính nó thành chứng từ. Không
   * truyền thì rơi về `onUploadEvidence`, lúc đó ảnh chỉ nằm ở kho chứng từ và
   * KHÔNG hiện ở dòng thu chi.
   *
   * TỪ 25/09/2026 (E2) hộp thoại KHÔNG gọi hàm này nữa, chỉ dùng nó làm công tắc:
   * ảnh dán chỉ được tải lên kho và gom lại, bấm xác nhận mới ghi lên phiếu
   * (`usePostingAttachmentDraft`); bấm Huỷ bỏ / đóng hộp thì file vừa tải bị xoá
   * và phiếu giữ nguyên.
   */
  onAttachEvidence?: (file: File) => Promise<{
    url: string | null;
    evidenceIds: string[];
    skipped: { url: string; reason: string }[];
    attachedToVoucher: boolean;
  } | null>;
  /**
   * Có truyền = cho gỡ ảnh đang có trên phiếu. TỪ 25/09/2026 (E2) hộp thoại không
   * gọi hàm này nữa: bấm X chỉ ẩn ảnh, việc gỡ thật đi chung lệnh ghi ảnh lúc bấm
   * xác nhận (server chỉ cho người có quyền sửa thu chi gỡ).
   */
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
 *
 * Từ 25/09/2026 (E2) ảnh vừa thêm / ảnh cũ vừa gỡ CHƯA ghi lên phiếu: chúng chỉ
 * được ghi khi bấm nút xác nhận, nên ô này nói rõ điều đó thay vì "đã đính".
 */
function PostingEvidenceUpload({
  items,
  onFiles,
  onRemove,
  canRemove,
  busy,
  adopting,
  disabled,
  fallbackCount,
  pendingChanges,
  confirmLabel,
}: {
  items: PostingEvidenceItem[];
  onFiles: (files: FileList | File[] | null) => Promise<void>;
  /** Không truyền → không cho gỡ (vd hộp thoại mở cho subject không phải phiếu). */
  onRemove?: (url: string) => Promise<void>;
  /** Ảnh nào hiện nút X; không truyền = mọi ảnh (khi có `onRemove`). */
  canRemove?: (item: PostingEvidenceItem) => boolean;
  busy: boolean;
  adopting: boolean;
  disabled?: boolean;
  /** Số chứng từ chỉ nằm ở kho chứng từ, không đính được lên phiếu (đường lùi). */
  fallbackCount: number;
  /** Còn ảnh vừa thêm / vừa gỡ chưa ghi lên phiếu. */
  pendingChanges: boolean;
  /** Chữ trên nút xác nhận ("Chi", "Duyệt và Thu"…) — để câu nhắc nói đúng nút. */
  confirmLabel: string;
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
                    ? `Ảnh vừa thêm — sẽ đính lên phiếu khi bấm “${confirmLabel}”`
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
              {onRemove && !disabled && (canRemove ? canRemove(item) : true) && (
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

      {pendingChanges && (
        <p className="text-xs text-muted-foreground">
          Ảnh vừa thêm/gỡ chỉ ghi lên phiếu khi bấm “{confirmLabel}”. Bấm Huỷ bỏ thì
          phiếu giữ nguyên và ảnh vừa tải bị xoá.
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
 * remaining. KHÔNG gọi API ghi sổ — assemble `PostFinanceExecutionInput` rồi
 * `onSubmit`. Riêng ảnh đi qua `usePostingAttachmentDraft` (tải lên kho, ghi lên
 * phiếu lúc xác nhận, xoá khi huỷ — E2). Tuyệt đối không có chữ "Nháp".
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
   * ẢNH/CHỨNG TỪ GOM TỚI LÚC XÁC NHẬN (E2, chủ chốt 25/09/2026).
   *
   * Trước đây dán ảnh là ghi lên phiếu ngay, bấm X là gỡ khỏi phiếu ngay — bấm
   * Huỷ bỏ thì phiếu đã đổi. Giờ trong lúc hộp mở, phiếu KHÔNG bị đụng tới:
   *   - ảnh dán/chọn chỉ được tải lên kho (`stagedUrls`), hiện xem trước;
   *   - X trên ảnh vừa thêm xoá luôn file đó; X trên ảnh cũ chỉ ẩn nó (`removedUrls`);
   *   - bấm xác nhận: một lệnh ghi ảnh (thêm + gỡ) → adopt → rồi mới ghi sổ;
   *   - Huỷ bỏ / đóng hộp / unmount: xoá đúng các file tải lên trong lần mở này.
   */
  const isVoucher = voucher.subjectKind === 'VOUCHER';
  /** Ảnh mới gom lại rồi đính lên phiếu lúc xác nhận (đường chính, thay cho đính khi dán). */
  const stageUploads = isVoucher && !!onAttachEvidence;
  /** Cho gỡ ảnh đang có trên phiếu (gỡ thật lúc xác nhận). */
  const canRemoveExisting = isVoucher && !!onRemoveAttachment;
  const {
    upload: uploadDraft,
    commit: commitDraft,
    discard: discardDraft,
  } = usePostingAttachmentDraft();

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
  /** Ảnh vừa tải lên kho trong lần mở này, CHƯA nằm trên phiếu. Huỷ/đóng hộp ⇒ xoá file. */
  const [stagedUrls, setStagedUrls] = useState<string[]>([]);
  /** Ảnh đang có trên phiếu mà người dùng bấm X — CHƯA gỡ khỏi phiếu. */
  const [removedUrls, setRemovedUrls] = useState<string[]>([]);
  /**
   * Thay đổi ảnh ĐÃ ghi lên phiếu ở một lần xác nhận trước trong lần mở này (ghi
   * ảnh xong nhưng lệnh ghi sổ lỗi). `voucher.attachments` là ảnh chụp lúc mở nên
   * không tự cập nhật — giữ ở đây để danh sách hiển thị đúng phiếu hiện tại.
   */
  const [appliedAdds, setAppliedAdds] = useState<string[]>([]);
  const [appliedRemovals, setAppliedRemovals] = useState<string[]>([]);
  /** Chứng từ đi ĐƯỜNG LÙI: có trong kho chứng từ nhưng không đính được lên phiếu. */
  const [fallbackIds, setFallbackIds] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  /** Đang ghi ảnh lên phiếu (bước đầu của xác nhận) — khoá Huỷ bỏ/đóng hộp. */
  const [committing, setCommitting] = useState(false);

  /**
   * Việc bất đồng bộ + dọn dẹp cần giá trị MỚI NHẤT, closure của render cũ không
   * có. `sessionRef` tăng mỗi lần mở/đóng: kết quả về muộn của lần mở cũ tự dọn
   * thay vì chen vào lần mở mới.
   */
  const sessionRef = useRef(0);
  const stagedRef = useRef<string[]>([]);
  /** File gốc của ảnh đang chờ — cần khi phải đi đường lùi (tải lại vào kho chứng từ). */
  const stagedFilesRef = useRef(new Map<string, File>());
  const committingRef = useRef(false);

  const setStaged = useCallback((next: string[]) => {
    stagedRef.current = next;
    setStagedUrls(next);
  }, []);

  /**
   * Xoá khỏi kho mọi file tải lên trong lần mở này mà chưa ghi lên phiếu. Đang
   * ghi ảnh dở dang thì KHÔNG xoá ở đây — file có thể vừa nằm trên phiếu; bước
   * ghi tự dọn nếu nó hỏng (xem `applyAttachmentChanges`).
   */
  const discardStaged = useCallback(() => {
    const urls = stagedRef.current;
    stagedRef.current = [];
    stagedFilesRef.current.clear();
    if (committingRef.current || urls.length === 0) return;
    void discardDraft(urls);
  }, [discardDraft]);

  // Một lần mở = một phiếu + một chế độ. Hết lần mở (đóng hộp, đổi phiếu, unmount)
  // mà chưa xác nhận ⇒ file vừa tải thành rác: xoá. Phiếu không bị đụng tới.
  useEffect(() => {
    if (!open) return;
    sessionRef.current += 1;
    return () => {
      sessionRef.current += 1;
      discardStaged();
      setStagedUrls([]);
      setRemovedUrls([]);
      setAppliedAdds([]);
      setAppliedRemovals([]);
    };
  }, [open, voucher.subjectId, mode, discardStaged]);

  useEffect(() => {
    if (!open) {
      setAdoptedIds([]);
      setAdoptSkipped([]);
      setStagedUrls([]);
      setRemovedUrls([]);
      setAppliedAdds([]);
      setAppliedRemovals([]);
      setFallbackIds([]);
      setUploading(false);
      setCommitting(false);
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

  /** Danh sách đang hiện = ảnh của phiếu (trừ ảnh đã/đang gỡ) + ảnh vừa thêm chờ ghi. */
  const evidenceItems = useMemo(
    () =>
      buildPostingEvidenceItems({
        attachments: [...attachments, ...appliedAdds].filter(
          (u) => !removedUrls.includes(u) && !appliedRemovals.includes(u),
        ),
        sessionUploaded: stagedUrls,
        skipped: adoptSkipped,
      }),
    [attachments, appliedAdds, removedUrls, appliedRemovals, stagedUrls, adoptSkipped],
  );

  const hasPendingAttachmentChanges = stagedUrls.length > 0 || removedUrls.length > 0;

  /**
   * `evidenceIds` của form LUÔN được suy ra, không bao giờ sửa tay. Không còn thay
   * đổi ảnh chờ ghi: đúng mã chứng từ server đã nhận (adopt) + chứng từ đi đường
   * lùi. Còn thay đổi chờ ghi: mã thật chỉ có sau khi xác nhận ghi ảnh lên phiếu,
   * nên tạm đếm theo danh sách đang hiện (ảnh dùng được + ảnh vừa thêm) — chỉ để
   * kiểm "ít nhất một chứng từ"; lúc gửi luôn dùng mã thật (xem `submit`).
   */
  const plannedEvidence = useMemo(
    () =>
      hasPendingAttachmentChanges
        ? [
            ...evidenceItems.filter((i) => i.usable).map((i) => `cho-ghi:${i.url}`),
            ...fallbackIds,
          ]
        : [...adoptedIds, ...fallbackIds],
    [hasPendingAttachmentChanges, evidenceItems, adoptedIds, fallbackIds],
  );

  useEffect(() => {
    const next = plannedEvidence;
    const current = form.getValues('evidenceIds') ?? [];
    if (current.length === next.length && current.every((v, i) => v === next[i])) return;
    form.setValue('evidenceIds', next, { shouldValidate: next.length > 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plannedEvidence]);

  const handleEvidenceFiles = useCallback(
    async (files: FileList | File[] | null) => {
      const list = files ? Array.from(files as ArrayLike<File>) : [];
      if (list.length === 0) return;
      const session = sessionRef.current;
      setUploading(true);
      try {
        for (const file of list) {
          if (stageUploads) {
            // Chỉ tải lên kho — phiếu chưa đổi gì cho tới khi bấm xác nhận.
            const url = await uploadDraft(file);
            if (sessionRef.current !== session) {
              // Hộp đã đóng trong lúc tải: file này không còn thuộc lần mở nào.
              if (url) void discardDraft([url]);
              return;
            }
            if (!url) continue;
            stagedFilesRef.current.set(url, file);
            setStaged([...stagedRef.current, url]);
            continue;
          }
          if (onUploadEvidence) {
            const id = await onUploadEvidence(file);
            if (sessionRef.current !== session) return;
            if (id) setFallbackIds((prev) => [...prev, id]);
          }
        }
      } finally {
        if (sessionRef.current === session) setUploading(false);
      }
    },
    [stageUploads, uploadDraft, discardDraft, onUploadEvidence, setStaged],
  );

  const handleEvidenceRemove = useCallback(
    async (url: string) => {
      if (stagedRef.current.includes(url)) {
        // Ảnh vừa thêm trong lần mở này, chưa từng nằm trên phiếu: xoá file luôn.
        setStaged(stagedRef.current.filter((u) => u !== url));
        stagedFilesRef.current.delete(url);
        await discardDraft([url]);
        return;
      }
      if (!canRemoveExisting) return;
      // Ảnh đang có trên phiếu: chỉ ẩn đi, KHÔNG xoá file — gỡ thật lúc xác nhận.
      setRemovedUrls((prev) => (prev.includes(url) ? prev : [...prev, url]));
    },
    [canRemoveExisting, discardDraft, setStaged],
  );

  const canRemoveItem = useCallback(
    (item: PostingEvidenceItem) => item.addedNow || canRemoveExisting,
    [canRemoveExisting],
  );

  /**
   * ĐƯỜNG LÙI (giữ tinh thần 27/08/2026): server không cho đính ảnh lên phiếu (vd
   * thủ quỹ giữ sổ khác sổ ghi trên phiếu, không phải người lập) — thà ảnh không
   * hiện ở dòng thu chi còn hơn chặn người ta chi tiền. Ảnh vừa thêm đi kho chứng
   * từ riêng; bản trong kho ảnh đính kèm bị xoá cho khỏi rác.
   */
  const fallbackToEvidenceStore = async (
    urls: string[],
    reason: string,
    session: number,
  ): Promise<string[] | null> => {
    if (!onUploadEvidence) {
      toast.error(reason);
      return null;
    }
    const ids: string[] = [];
    const moved: string[] = [];
    for (const url of urls) {
      const file = stagedFilesRef.current.get(url);
      const id = file ? await onUploadEvidence(file) : null;
      if (!id) break; // uploadFinanceEvidence đã báo lý do
      ids.push(id);
      moved.push(url);
    }
    if (sessionRef.current !== session) {
      void discardDraft(urls);
      return null;
    }
    if (moved.length > 0) {
      setStaged(stagedRef.current.filter((u) => !moved.includes(u)));
      for (const u of moved) stagedFilesRef.current.delete(u);
      void discardDraft(moved);
      setFallbackIds((prev) => [...prev, ...ids]);
    }
    if (moved.length < urls.length) return null;
    toast.warning(
      'Ảnh đã lưu làm chứng từ, nhưng chưa đính được lên phiếu (thiếu quyền sửa) — nó sẽ không hiện ở dòng thu chi.',
    );
    return [...adoptedIds, ...fallbackIds, ...ids];
  };

  /**
   * Bước đầu của nút xác nhận: ghi thay đổi ảnh đã gom lên phiếu rồi lấy mã
   * chứng từ thật cho lệnh ghi sổ. Trả null khi phải dừng (lỗi đã được báo).
   *
   * Phải ghi ảnh TRƯỚC lệnh ghi sổ: lệnh đó đòi mã chứng từ, mà chứng từ chỉ lập
   * được từ file đang nằm trên phiếu. Hệ quả chấp nhận: ghi ảnh xong mà ghi sổ lỗi
   * thì ảnh đã ở trên phiếu (người dùng đã bấm xác nhận) — chúng chuyển sang
   * `applied*` và không bị xoá khi đóng hộp.
   */
  const applyAttachmentChanges = async (): Promise<string[] | null> => {
    const add = [...stagedRef.current];
    const remove = [...removedUrls];
    const session = sessionRef.current;
    committingRef.current = true;
    setCommitting(true);
    try {
      const res = await commitDraft(voucher.subjectId, { add, remove });
      if (sessionRef.current !== session) {
        // Hộp bị đóng giữa chừng: ghi được thì file đã thuộc phiếu — giữ; không
        // ghi được thì chúng là rác.
        if (!res.ok) void discardDraft(add);
        return null;
      }
      if (res.ok) {
        // Từ đây ảnh vừa thêm đã nằm trên phiếu — KHÔNG còn là rác.
        setStaged(stagedRef.current.filter((u) => !add.includes(u)));
        for (const u of add) stagedFilesRef.current.delete(u);
        setRemovedUrls((prev) => prev.filter((u) => !remove.includes(u)));
        setAppliedAdds((prev) => [...prev, ...add]);
        setAppliedRemovals((prev) => [...prev, ...remove]);
        setAdoptedIds(res.evidenceIds);
        setAdoptSkipped(res.skipped);
        return [...res.evidenceIds, ...fallbackIds];
      }
      const loi = res.message ?? 'Không ghi được ảnh lên phiếu';
      if (res.periodBlocked) {
        toast.error(loi);
        return null;
      }
      if (remove.length > 0) {
        // Thêm và gỡ đi chung một lệnh nên phiếu CHƯA đổi gì. Hay gặp nhất: người
        // chi không có quyền sửa thu chi nên không được gỡ ảnh — trả ảnh về chỗ cũ.
        setRemovedUrls([]);
        toast.error(
          `${loi} — ảnh định gỡ đã được trả lại; bấm “${title}” lần nữa để tiếp tục mà không gỡ ảnh.`,
        );
        return null;
      }
      return await fallbackToEvidenceStore(add, loi, session);
    } finally {
      committingRef.current = false;
      if (sessionRef.current === session) setCommitting(false);
    }
  };

  const submit = form.handleSubmit(async (values) => {
    let evidenceIds = values.evidenceIds;
    if (hasPendingAttachmentChanges) {
      const applied = await applyAttachmentChanges();
      if (!applied) return; // hộp giữ nguyên để thử lại hoặc Huỷ bỏ
      evidenceIds = applied;
      if (requireEvidence && evidenceIds.length === 0) {
        form.setError('evidenceIds', {
          type: 'manual',
          message: 'Chưa có ảnh nào tính là chứng từ cho lần ghi sổ này — hãy thêm ảnh mới.',
        });
        return;
      }
    }
    const input: PostFinanceExecutionInput = {
      subjectKind: voucher.subjectKind,
      subjectId: voucher.subjectId,
      cashbookId: values.cashbookId,
      postedOn: values.postedOn,
      evidenceIds,
      amount: allowAmount ? values.amount : undefined,
      expectedExecutionRevision,
      expectedApprovalVersion,
      expectedPostingVersion,
      idempotencyKey: generatedKey,
    };
    await onSubmit(input);
  });

  /** Đang ghi ảnh lên phiếu thì không cho đóng: không biết phiếu đã đổi hay chưa. */
  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next && committingRef.current) return;
      onOpenChange(next);
    },
    [onOpenChange],
  );

  const remaining = voucher.remainingAmount;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
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
                      onRemove={
                        stageUploads || canRemoveExisting ? handleEvidenceRemove : undefined
                      }
                      canRemove={canRemoveItem}
                      busy={uploading}
                      adopting={adopting}
                      disabled={committing}
                      fallbackCount={fallbackIds.length}
                      pendingChanges={hasPendingAttachmentChanges}
                      confirmLabel={title}
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
                disabled={committing}
                onClick={() => handleOpenChange(false)}
              >
                Huỷ bỏ
              </Button>
              <Button
                type="submit"
                disabled={isSubmitting || committing || uploading || !capabilityOk}
              >
                {isSubmitting || committing ? 'Đang xử lý...' : title}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
