import { useMemo, useState } from 'react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { VoucherStatusBadge, InternalBadge } from '@/components/income-expenses/VoucherStatusBadge';
import { voucherLayer } from '@/lib/voucherSources';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { DataTablePagination } from '@/components/ui/data-table-pagination';
import EmptyState from '@/components/ui/EmptyState';
import { StorageImage } from '@/components/ui/storage-image';
import { AttachmentLightbox } from '@/components/ui/attachment-lightbox';
import { openStoredFile } from '@/lib/storage';
import {
  calculatePaginationInfo,
  type PaginationState,
} from '@/hooks/usePagination';
import type { IncomeExpenseWithRelations } from '@/hooks/useIncomeExpenses';
import { useIsAdmin, useIsSuperAdmin } from '@/hooks/useIsAdmin';
import { useAuth } from '@/hooks/useAuth';
import { useMyPermissions } from '@/hooks/useMyPermissions';
import { canUse } from '@/lib/permissionPages';
import { canShowAnnotateAction } from '@/lib/voucherAnnotate';
import { useFinanceV2Routes, isCanonicalRead } from '@/lib/financeV2Route';
import {
  Eye,
  Ban,
  Receipt,
  Pencil,
  CheckCircle2,
  BadgeCheck,
  FileText as FileIcon,
  Repeat,
  CalendarX,
  Undo2,
  Banknote,
  RotateCcw,
  CopyPlus,
  History,
  ChevronDown,
  ChevronRight,
  CornerDownRight,
} from 'lucide-react';
import {
  flexCancelGate,
  type FlexCancelEligibility,
} from '@/hooks/income-expenses/flexMutations';
import {
  voucherCancelDecision,
  type IncomeCancelEligibility,
} from '@/hooks/income-expenses/incomeVoucherCancel';
import {
  groupReversalVouchers,
  groupNetAmount,
} from '@/lib/voucherReversalGrouping';
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '@/components/ui/hover-card';
import { format } from 'date-fns';
import { vi } from 'date-fns/locale';

interface IncomeExpenseListProps {
  vouchers: IncomeExpenseWithRelations[];
  isLoading: boolean;
  onView: (voucher: IncomeExpenseWithRelations) => void;
  onCancel: (id: string) => void;
  /** Khôi phục phiếu đã huỷ (chỉ super admin). */
  onRestore?: (id: string) => void;
  /** Dừng lặp lại cho 1 phiếu gốc (repeat_cycle != NONE, không phải phiếu con). */
  onStopRecurring?: (id: string) => void;
  onEdit?: (voucher: IncomeExpenseWithRelations) => void;
  /** Sửa nhanh 3 field (sổ quỹ + đính kèm + ghi chú) — cho người tạo phiếu
   *  trên phiếu đã ghi nhận/đã huỷ, không cần super admin. */
  onQuickEdit?: (voucher: IncomeExpenseWithRelations) => void;
  onApprove?: (voucher: IncomeExpenseWithRelations) => void;
  /** Finance V2 §12.3: CUSTODIAN Thu/Chi phiếu ĐÃ DUYỆT-CHƯA GHI SỔ (không cần
   *  quyền duyệt). Chỉ hiện khi org CANONICAL read + phiếu APPROVED+UNPOSTED,
   *  và cả phiếu ĐÃ HOÀN TÁC (chi lại — thế hệ bút toán mới). */
  onPostApproved?: (voucher: IncomeExpenseWithRelations) => void;
  /** Mô hình 2 nút: HOÀN TÁC phiếu ĐÃ GHI SỔ (tiền về sổ, phiếu chờ chi lại/huỷ). */
  onReversePosting?: (voucher: IncomeExpenseWithRelations) => void;
  /** Huỷ duyệt: đưa phiếu đã ghi nhận về Nháp (chỉ super admin). */
  onUnapprove?: (id: string) => void;
  onVerify?: (voucher: IncomeExpenseWithRelations) => void;
  /** Tạo bản sao từ phiếu đã HUỶ: mở form tạo mới prefill toàn bộ (kể cả ảnh). */
  onCopy?: (voucher: IncomeExpenseWithRelations) => void;
  /** Đợt 4: mở màn lịch sử (mốc lập/duyệt/huỷ + nhật ký trước/sau). */
  onHistory?: (voucher: IncomeExpenseWithRelations) => void;
  /** Đợt 4: kết quả can_flex_cancel_v1 theo id — mờ nút Huỷ kèm lý do thay vì
   *  bày nút rồi mới bắn toast lỗi. Thiếu (undefined) = chưa biết, giữ nút bật. */
  cancelEligibility?: Record<string, FlexCancelEligibility>;
  /** ĐỢT A: kết quả can_cancel_income_voucher_v1 — chỉ dùng cho phiếu THU. */
  incomeCancelEligibility?: Record<string, IncomeCancelEligibility>;
  pagination: PaginationState;
  totalCount: number;
}

const formatVND = (amount: number): string => {
  return amount.toLocaleString('vi-VN') + ' đ';
};

const isImageUrl = (url: string): boolean =>
  /\.(jpe?g|png|gif|webp|bmp|avif)(\?|#|$)/i.test(url);

interface AttachmentPreviewProps {
  urls: string[];
}

// Thumbnail nhỏ ảnh đính kèm + hover hiện kích thước thật. Nếu có nhiều file,
// chỉ hiện cái đầu — chi tiết đầy đủ vẫn xem được trong dialog chi tiết.
const AttachmentPreview = ({ urls }: AttachmentPreviewProps) => {
  // Xem ảnh ngay trên trang (overlay lightbox), KHÔNG mở tab mới làm mất trang.
  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);

  if (!urls || urls.length === 0) return null;
  const first = urls[0];
  const isImg = isImageUrl(first);
  const extra = urls.length - 1;

  if (!isImg) {
    return (
      <button
        type="button"
        className="ml-1 inline-flex items-center gap-0.5 text-zinc-500 hover:text-zinc-700"
        title="Mở file đính kèm"
        onClick={(e) => {
          e.stopPropagation();
          openStoredFile(first);
        }}
      >
        <FileIcon className="h-4 w-4" />
        {extra > 0 && <span className="text-[10px]">+{extra}</span>}
      </button>
    );
  }

  return (
    <>
      <HoverCard openDelay={120} closeDelay={80}>
        <HoverCardTrigger asChild>
          <button
            type="button"
            className="ml-1 inline-flex items-center"
            title="Bấm để xem lớn"
            onClick={(e) => {
              e.stopPropagation();
              setLightboxIdx(0);
            }}
          >
            <StorageImage
              value={first}
              alt="Đính kèm"
              className="h-7 w-7 rounded border border-zinc-200 object-cover hover:ring-2 hover:ring-blue-300"
              loading="lazy"
            />
            {extra > 0 && (
              <span className="ml-0.5 text-[10px] text-muted-foreground">
                +{extra}
              </span>
            )}
          </button>
        </HoverCardTrigger>
        <HoverCardContent
          side="left"
          align="center"
          className="p-1 w-auto max-w-[480px]"
        >
          <StorageImage
            value={first}
            alt="Đính kèm full-size"
            className="max-h-[420px] max-w-[460px] object-contain rounded"
          />
        </HoverCardContent>
      </HoverCard>

      <AttachmentLightbox
        attachments={urls}
        index={lightboxIdx}
        onIndexChange={setLightboxIdx}
      />
    </>
  );
};

const IncomeExpenseList = ({
  vouchers,
  isLoading,
  onView,
  onCancel,
  onRestore,
  onStopRecurring,
  onEdit,
  onQuickEdit,
  onApprove,
  onPostApproved,
  onReversePosting,
  onUnapprove,
  onVerify,
  onCopy,
  onHistory,
  cancelEligibility,
  incomeCancelEligibility,
  pagination,
  totalCount,
}: IncomeExpenseListProps) => {
  const paginationInfo = useMemo(
    () => calculatePaginationInfo(pagination.page, pagination.pageSize, totalCount),
    [pagination.page, pagination.pageSize, totalCount],
  );
  const { data: isAdmin = false } = useIsAdmin();
  const { data: isSuperAdmin = false } = useIsSuperAdmin();
  const { data: authUser } = useAuth();
  const { data: perms } = useMyPermissions();
  const currentUserId = authUser?.id ?? null;
  // Finance V2 §12.1: org CANONICAL read → badge composite 4 trục (Đã Duyệt -
  // Chưa Chi / Đã Chi / Đã hoàn tác…); org LEGACY giữ nhãn cũ.
  const v2Routes = useFinanceV2Routes();
  // Quyền chi tiết: duyệt / huỷ phiếu thu chi (fallback legacy: approve cũ,
  // cancel rơi về edit).
  const canApproveVoucher = canUse(perms, 'income_expenses', 'approve');
  const canCancelVoucher = canUse(perms, 'income_expenses', 'cancel');
  const canEditVoucher = canUse(perms, 'income_expenses', 'edit');

  // --- Gộp ẩn phiếu đối ứng DI SẢN vào dòng phiếu gốc (plan Đợt 5) ---
  // Trước Đợt 5 mỗi lần hoàn tác khoản thu là sinh thêm một phiếu chi riêng, nên
  // lịch sử cũ có hai dòng rời rạc cho cùng một nghiệp vụ. Phiếu đã sinh thì
  // KHÔNG xoá được (flow-owned, bất biến), nên chỉ gom được ở đây.
  const [openReversals, setOpenReversals] = useState<Record<string, boolean>>({});
  const displayRows = useMemo(() => {
    const rows: Array<{
      voucher: IncomeExpenseWithRelations;
      /** Số phiếu đối ứng đang gộp ẩn dưới dòng này (0 = dòng thường). */
      reversalCount: number;
      /** Tiền ròng của cả cụm sau bù trừ — chỉ tính khi có gộp. */
      netAmount: number;
      /** Dòng con: chính là phiếu đối ứng đang được mở ra xem. */
      nested: boolean;
    }> = [];
    for (const group of groupReversalVouchers(vouchers)) {
      const reversalCount = group.reversals.length;
      rows.push({
        voucher: group.anchor,
        reversalCount,
        netAmount: reversalCount > 0 ? groupNetAmount(group) : 0,
        nested: false,
      });
      if (reversalCount > 0 && openReversals[group.anchor.id]) {
        for (const reversal of group.reversals) {
          rows.push({
            voucher: reversal,
            reversalCount: 0,
            netAmount: 0,
            nested: true,
          });
        }
      }
    }
    return rows;
  }, [vouchers, openReversals]);

  if (isLoading) {
    return (
      <div className="space-y-2">
        {[1, 2, 3, 4, 5].map((i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  }

  if (vouchers.length === 0) {
    return (
      <EmptyState
        icon={Receipt}
        title="Chưa có phiếu thu/chi nào"
        description="Hãy thêm phiếu đầu tiên để bắt đầu quản lý thu chi"
      />
    );
  }

  return (
    <div className="bg-white rounded-lg border border-zinc-200 overflow-hidden">
      <Table className="[&_th]:border-r [&_th]:border-b [&_th]:border-zinc-200 [&_td]:border-r [&_td]:border-b [&_td]:border-zinc-200 [&_tr>*:last-child]:border-r-0 [&_tbody_tr:last-child>td]:border-b-0">
        <TableHeader>
          <TableRow>
            <TableHead>Thao tác</TableHead>
            <TableHead>Tên</TableHead>
            <TableHead className="text-right">Số tiền</TableHead>
            <TableHead>Tòa nhà</TableHead>
            <TableHead>Ngày thu/chi</TableHead>
            <TableHead>Người nhận/trả</TableHead>
            <TableHead>Người tạo</TableHead>
            <TableHead>Sổ quỹ</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {displayRows.map(({ voucher, reversalCount, netAmount, nested }) => {
            const isCancelled = voucher.approval_status === 'CANCELLED';
            const isUnapproved = voucher.approval_status === 'UNAPPROVED';
            const isCreator =
              !!currentUserId && voucher.user_id === currentUserId;
            const isVerified = !!voucher.verified_at;
            // Đợt 4 / ĐỢT A: server đã nói trước phiếu này huỷ được hay không.
            // Phiếu THU hỏi reader riêng (biết LIFO + tiền thừa đã cấn đi đâu).
            const cancelGate = voucherCancelDecision({
              type: voucher.type,
              income: incomeCancelEligibility?.[voucher.id],
              flexGate: flexCancelGate(cancelEligibility?.[voucher.id]),
            });
            // B4: lớp phiếu — Nội bộ (bút toán) hiển thị trung tính.
            const layer = voucherLayer({
              approval_status: voucher.approval_status,
              account_id: voucher.account_id,
              system_source: (voucher as any).system_source,
              account_is_virtual: (voucher as any).account_is_virtual,
            });
            const isInternal = layer === 'INTERNAL';
            // Nháp: cây bút mở full form (giữ nguyên flow cũ).
            // Đã ghi nhận/đã huỷ: super admin vẫn mở full form; creator
            // (không phải admin) mở dialog sửa nhanh 3 field.
            const showFullEdit = !!onEdit && (isUnapproved || isAdmin);
            // Đợt 2: không còn giới hạn ở NGƯỜI TẠO — kế toán/quản lý có quyền
            // sửa thu chi cũng đính hộ được chứng từ (server là nơi chốt).
            const showQuickEdit = canShowAnnotateAction({
              hasHandler: !!onQuickEdit,
              isUnapproved,
              isAdmin,
              isCreator,
              canEdit: canEditVoucher,
            });

            const rowClass = [
              isCancelled ? 'opacity-60' : '',
              isInternal && !isCancelled ? 'bg-muted/40' : '',
              isVerified && !isCancelled && !isInternal ? 'bg-emerald-50/70 hover:bg-emerald-50' : '',
              // Dòng con (phiếu đối ứng đang mở ra xem) — lùi vào, nền xám nhạt.
              nested ? 'bg-zinc-50/80' : '',
            ]
              .filter(Boolean)
              .join(' ');

            return (
              <TableRow key={voucher.id} className={rowClass}>
                {/* Thao tác */}
                <TableCell>
                  <div className="flex items-center gap-1">
                    {/* Xem chi tiết */}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-blue-500 hover:text-blue-600 hover:bg-blue-50"
                      onClick={() => onView(voucher)}
                      title="Xem chi tiết"
                    >
                      <Eye className="h-4 w-4" />
                    </Button>

                    {/* Đánh dấu đã kiểm */}
                    {onVerify && !isCancelled && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className={
                          isVerified
                            ? 'h-8 w-8 text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50'
                            : 'h-8 w-8 text-zinc-400 hover:text-emerald-600 hover:bg-emerald-50'
                        }
                        onClick={() => onVerify(voucher)}
                        title={
                          isVerified
                            ? `Đã kiểm bởi ${voucher.verified_by_name ?? ''}${voucher.verified_note ? ' — ' + voucher.verified_note : ''}`
                            : 'Đánh dấu đã kiểm tra'
                        }
                      >
                        <BadgeCheck className="h-4 w-4" />
                      </Button>
                    )}

                    {/* Sửa: nháp -> mọi nhân viên; đã ghi nhận/đã huỷ -> chỉ super admin */}
                    {showFullEdit && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-amber-600 hover:text-amber-700 hover:bg-amber-50"
                        onClick={() => onEdit!(voucher)}
                        title={isUnapproved ? 'Sửa phiếu chờ duyệt' : 'Sửa phiếu (Super Admin)'}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                    )}

                    {/* Sửa nhanh (3 field) — cho creator của phiếu đã ghi nhận/đã huỷ */}
                    {showQuickEdit && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-amber-600 hover:text-amber-700 hover:bg-amber-50"
                        onClick={() => onQuickEdit!(voucher)}
                        // ĐỢT C: sổ quỹ chỉ sửa được ở phiếu THU; câu cũ ghi
                        // "Sửa sổ quỹ" cho cả phiếu chi là hứa hão.
                        title={
                          voucher.type === 'INCOME'
                            ? 'Sửa sổ quỹ / hình ảnh / ghi chú'
                            : 'Sửa hình ảnh / ghi chú'
                        }
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                    )}

                    {/* Duyệt (chỉ khi nháp) */}
                    {canApproveVoucher && isUnapproved && onApprove && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-green-600 hover:text-green-700 hover:bg-green-50"
                        onClick={() => onApprove(voucher)}
                        title="Duyệt phiếu (đã thanh toán)"
                      >
                        <CheckCircle2 className="h-4 w-4" />
                      </Button>
                    )}

                    {/* Finance V2 §12.3: Thu/Chi phiếu ĐÃ DUYỆT - CHƯA GHI SỔ
                        (CUSTODIAN, không cần quyền duyệt) — chỉ org CANONICAL.
                        Phiếu ĐÃ HOÀN TÁC cũng chi lại được (thế hệ mới, 7x). */}
                    {onPostApproved &&
                      !isCancelled &&
                      voucher.approval_status === 'APPROVED' &&
                      voucher.posting_status !== 'POSTED' &&
                      voucher.posting_status !== 'NOT_APPLICABLE' &&
                      isCanonicalRead(v2Routes.getOrg(voucher.organization_id ?? null)) && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-blue-600 hover:text-blue-700 hover:bg-blue-50"
                          onClick={() => onPostApproved(voucher)}
                          title={
                            voucher.posting_status === 'REVERSED'
                              ? (voucher.type === 'INCOME'
                                  ? 'Thu LẠI vào sổ (bút toán mới sau hoàn tác)'
                                  : 'Chi LẠI từ sổ (bút toán mới sau hoàn tác)')
                              : voucher.type === 'INCOME'
                                ? 'Thu tiền vào sổ (phiếu đã duyệt)'
                                : 'Chi tiền từ sổ (phiếu đã duyệt)'
                          }
                        >
                          <Banknote className="h-4 w-4" />
                        </Button>
                      )}

                    {/* Mô hình 2 nút: HOÀN TÁC phiếu ĐÃ GHI SỔ (tiền về sổ,
                        phiếu nằm chờ Chi lại hoặc Huỷ). CUSTODIAN đúng sổ. */}
                    {onReversePosting &&
                      !isCancelled &&
                      voucher.posting_status === 'POSTED' &&
                      isCanonicalRead(v2Routes.getOrg(voucher.organization_id ?? null)) && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-violet-600 hover:text-violet-700 hover:bg-violet-50"
                          onClick={() => onReversePosting(voucher)}
                          title={
                            // Đợt 4: đây CHÍNH LÀ nút "Mở lại" của chủ. Nó gọi
                            // reverse_posted_income_expense_v2 sẵn có: tiền quay
                            // về sổ, phiếu ở trạng thái Đã duyệt - chưa chi nên
                            // sửa được và chi lại được.
                            //
                            // CỐ Ý KHÔNG đưa phiếu về "Chờ duyệt":
                            // unapprove_voucher không reset review_state, mà cả
                            // hai writer duyệt đều đòi review_state PENDING/
                            // CHANGES_REQUESTED ⇒ tiền ra khỏi sổ rồi kẹt ở đó
                            // vĩnh viễn, không ai duyệt lại được.
                            voucher.type === 'INCOME'
                              ? 'Mở lại (tiền rời sổ, sửa được rồi thu lại)'
                              : 'Mở lại (tiền về sổ, sửa được rồi chi lại)'
                          }
                        >
                          <RotateCcw className="h-4 w-4" />
                        </Button>
                      )}

                    {/* Huỷ duyệt: phiếu đã ghi nhận -> Nháp (chỉ super admin) */}
                    {isAdmin && !isUnapproved && !isCancelled && onUnapprove && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-amber-600 hover:text-amber-700 hover:bg-amber-50"
                        onClick={() => onUnapprove(voucher.id)}
                        title="Huỷ duyệt (chuyển về Chờ duyệt) — Super Admin"
                      >
                        <Undo2 className="h-4 w-4" />
                      </Button>
                    )}

                    {/* Huỷ phiếu (chỉ khi chưa huỷ). Đợt 4: can_flex_cancel_v1
                        đã trả lời trước — không bấm được thì mờ nút và NÓI RÕ
                        vì sao, thay vì để người dùng bấm rồi ăn toast lỗi. */}
                    {canCancelVoucher && !isCancelled && (
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={!cancelGate.canCancel}
                        className={
                          cancelGate.canCancel
                            ? 'h-8 w-8 text-red-500 hover:text-red-600 hover:bg-red-50'
                            : 'h-8 w-8 text-zinc-300'
                        }
                        onClick={() => onCancel(voucher.id)}
                        title={
                          cancelGate.reason
                            ? `Huỷ phiếu — ${cancelGate.reason}`
                            : 'Huỷ phiếu'
                        }
                      >
                        <Ban className="h-4 w-4" />
                      </Button>
                    )}

                    {/* Lịch sử phiếu: mốc lập/duyệt/huỷ + lý do + nhật ký
                        trước/sau. Với phiếu đã huỷ đây là chỗ đối soát duy nhất
                        (Đợt 4 không sinh phiếu đối ứng để mà nhìn). */}
                    {onHistory && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-slate-500 hover:text-slate-700 hover:bg-slate-100"
                        onClick={() => onHistory(voucher)}
                        title="Xem lịch sử phiếu (mốc lập/duyệt/huỷ + thay đổi)"
                      >
                        <History className="h-4 w-4" />
                      </Button>
                    )}

                    {/* Tạo bản sao từ phiếu đã huỷ: mở form tạo mới prefill
                        toàn bộ thông tin (kể cả hình ảnh) — sửa nhanh chỗ sai
                        rồi lưu thành phiếu mới. Thay cho "sửa" phiếu canonical
                        (bất biến sau khi tạo). */}
                    {isCancelled && onCopy && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-blue-600 hover:text-blue-700 hover:bg-blue-50"
                        onClick={() => onCopy(voucher)}
                        title="Tạo bản sao (phiếu mới với thông tin phiếu này)"
                      >
                        <CopyPlus className="h-4 w-4" />
                      </Button>
                    )}

                    {/* Khôi phục phiếu đã huỷ — chỉ super admin */}
                    {isCancelled && isSuperAdmin && onRestore && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-green-600 hover:text-green-700 hover:bg-green-50"
                        onClick={() => onRestore(voucher.id)}
                        title="Khôi phục phiếu (Super Admin)"
                      >
                        <RotateCcw className="h-4 w-4" />
                      </Button>
                    )}

                    {/* Dừng lặp lại — chỉ phiếu GỐC đang lặp, chưa huỷ */}
                    {onStopRecurring &&
                      voucher.repeat_cycle &&
                      voucher.repeat_cycle !== 'NONE' &&
                      !voucher.repeat_parent_id &&
                      !isCancelled && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-orange-500 hover:text-orange-600 hover:bg-orange-50"
                          onClick={() => onStopRecurring(voucher.id)}
                          title="Dừng lặp lại (giữ phiếu + các phiếu đã sinh)"
                        >
                          <CalendarX className="h-4 w-4" />
                        </Button>
                      )}

                    {/* Ảnh đính kèm — thumbnail + hover xem full-size */}
                    <AttachmentPreview urls={voucher.attachments ?? []} />

                    {/* Tên người kiểm — hiện ở cuối ô thao tác khi đã kiểm */}
                    {isVerified && voucher.verified_by_name && (
                      <span
                        className="ml-1 inline-flex items-center gap-1 text-xs text-emerald-700 whitespace-nowrap"
                        title={
                          voucher.verified_note
                            ? `Ghi chú: ${voucher.verified_note}`
                            : 'Đã kiểm'
                        }
                      >
                        <BadgeCheck className="h-3.5 w-3.5" />
                        {voucher.verified_by_name}
                      </span>
                    )}
                  </div>
                </TableCell>

                {/* Tên + Badge trạng thái */}
                <TableCell className="max-w-[260px]">
                  <div className="flex items-center gap-2 min-w-0">
                    {/* Dòng con: mũi tên lùi vào cho thấy nó thuộc dòng trên */}
                    {nested && (
                      <CornerDownRight
                        className="h-3.5 w-3.5 shrink-0 ml-3 text-zinc-400"
                        aria-hidden
                      />
                    )}
                    <span
                      className={`truncate ${isCancelled ? 'line-through' : ''}`}
                    >
                      {voucher.name}
                    </span>
                    {/* Nhãn cho chính phiếu đối ứng khi mở ra xem */}
                    {nested && (
                      <Badge
                        variant="secondary"
                        className="shrink-0 bg-zinc-200 text-zinc-700 hover:bg-zinc-200"
                      >
                        Phiếu đối ứng
                      </Badge>
                    )}
                    {/* Gộp ẩn: nút thu gọn/mở phiếu đối ứng di sản của dòng này */}
                    {reversalCount > 0 && (
                      <button
                        type="button"
                        className="shrink-0 inline-flex items-center gap-1 rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-xs font-medium text-amber-700 hover:bg-amber-100"
                        aria-expanded={!!openReversals[voucher.id]}
                        title={
                          openReversals[voucher.id]
                            ? 'Thu gọn phiếu đối ứng'
                            : `Xem ${reversalCount} phiếu đối ứng đã hoàn tác phiếu này`
                        }
                        onClick={(e) => {
                          e.stopPropagation();
                          setOpenReversals((prev) => ({
                            ...prev,
                            [voucher.id]: !prev[voucher.id],
                          }));
                        }}
                      >
                        {openReversals[voucher.id] ? (
                          <ChevronDown className="h-3 w-3" />
                        ) : (
                          <ChevronRight className="h-3 w-3" />
                        )}
                        Đã hoàn tác
                        {reversalCount > 1 ? ` (${reversalCount})` : ''}
                      </button>
                    )}
                    {/* B4: badge trạng thái DÙNG CHUNG desktop=mobile */}
                    <span className="shrink-0">
                      <VoucherStatusBadge
                        status={voucher.approval_status}
                        verifiedAt={voucher.verified_at}
                        v2={
                          isCanonicalRead(v2Routes.getOrg(voucher.organization_id ?? null))
                            ? {
                                review_state: voucher.review_state,
                                posting_mode: voucher.posting_mode,
                                posting_status: voucher.posting_status,
                                type: voucher.type,
                              }
                            : null
                        }
                      />
                    </span>
                    {isInternal && !isCancelled && (
                      <span className="shrink-0"><InternalBadge /></span>
                    )}
                    {/* Phiếu gốc đang lặp */}
                    {voucher.repeat_cycle &&
                      voucher.repeat_cycle !== 'NONE' &&
                      !voucher.repeat_parent_id && (
                        <Badge
                          variant="secondary"
                          className="shrink-0 gap-1 bg-blue-100 text-blue-700 hover:bg-blue-100"
                        >
                          <Repeat className="h-3 w-3" />
                          Lặp lại
                        </Badge>
                      )}
                    {/* Phiếu con tự động sinh */}
                    {voucher.repeat_parent_id && (
                      <Badge
                        variant="secondary"
                        className="shrink-0 bg-sky-100 text-sky-700 hover:bg-sky-100"
                      >
                        Tự động
                      </Badge>
                    )}
                  </div>
                </TableCell>

                {/* Số tiền (có dấu + màu) */}
                <TableCell className="text-right">
                  {/* B4: bút toán nội bộ hiển thị trung tính (không +/- xanh đỏ) */}
                  {isInternal && !isCancelled ? (
                    <span className="text-slate-500 font-medium">
                      {formatVND(voucher.total_amount)}
                    </span>
                  ) : (
                    <span
                      className={
                        voucher.type === 'INCOME'
                          ? 'text-green-600 font-medium'
                          : 'text-red-600 font-medium'
                      }
                    >
                      {voucher.type === 'INCOME' ? '+' : '-'}
                      {formatVND(voucher.total_amount)}
                    </span>
                  )}
                  {/* Có gộp phiếu đối ứng: nói rõ còn lại BAO NHIÊU sau bù trừ.
                      Số gốc ở trên KHÔNG bị sửa — ba thẻ tổng của trang lấy từ
                      RPC server nên vẫn cộng đủ cả hai phiếu như trước. */}
                  {reversalCount > 0 && (
                    <div
                      className="text-[11px] text-muted-foreground"
                      title="Số tiền còn lại sau khi trừ phiếu đối ứng"
                    >
                      ròng {netAmount >= 0 ? '+' : '-'}
                      {formatVND(Math.abs(netAmount))}
                    </div>
                  )}
                </TableCell>

                {/* Tòa nhà + Phòng (sub-line) */}
                <TableCell>
                  {voucher.building_name ? (
                    <div className="flex flex-col leading-tight">
                      <span>{voucher.building_name}</span>
                      {voucher.room_name && (
                        <span className="text-xs text-muted-foreground">
                          {voucher.room_name}
                        </span>
                      )}
                    </div>
                  ) : (
                    '—'
                  )}
                </TableCell>

                {/* Ngày thu/chi */}
                <TableCell>
                  {voucher.voucher_date
                    ? format(new Date(voucher.voucher_date), 'dd/MM/yyyy', { locale: vi })
                    : '—'}
                </TableCell>

                {/* Người nhận/trả */}
                <TableCell>{voucher.payer_name || '—'}</TableCell>

                {/* Người tạo */}
                <TableCell>{voucher.creator_name || '—'}</TableCell>

                {/* Tài khoản */}
                <TableCell>{voucher.account_name || '—'}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>

      {/* Phân trang */}
      <DataTablePagination
        paginationInfo={paginationInfo}
        onPageChange={pagination.setPage}
        onPageSizeChange={pagination.setPageSize}
        showPageSizeSelector
        showItemCount
      />
    </div>
  );
};

export default IncomeExpenseList;
