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
import { useIsSuperAdmin } from '@/hooks/useIsAdmin';
import { decideIncomeExpenseActions, pendingIncomeExpenseActionContext, type IncomeExpenseActionContext, type IncomeExpenseAction } from '@/lib/incomeExpenseActionPolicy';
import { getVoucherDisplayAttachments } from '@/lib/incomeExpenseSupplement';
import { useFinanceV2Routes, isCanonicalRead } from '@/lib/financeV2Route';
import {
  Eye,
  Ban,
  Receipt,
  Pencil,
  FilePlus2,
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
import type {
  FlexCancelEligibility,
} from '@/hooks/income-expenses/flexMutations';
import type {
  IncomeCancelEligibility,
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
  /** Kèm `type` để trang cha biết đi cửa THU hay đường CHI mà không phải tra ngược. */
  onCancel: (id: string, type?: string | null) => void;
  /** Khôi phục phiếu đã huỷ (chỉ super admin). */
  onRestore?: (id: string) => void;
  /** Dừng lặp lại cho 1 phiếu gốc (repeat_cycle != NONE, không phải phiếu con). */
  onStopRecurring?: (id: string) => void;
  onEdit?: (voucher: IncomeExpenseWithRelations) => void;
  /** Append-only narrative/evidence; available independently of financial edits. */
  onQuickEdit?: (voucher: IncomeExpenseWithRelations) => void;
  /** Legacy approval may also change cash; never relabel it approve-only. */
  onApprove?: (voucher: IncomeExpenseWithRelations) => void;
  onApproveOnly?: (voucher: IncomeExpenseWithRelations) => void;
  onApproveAndPost?: (voucher: IncomeExpenseWithRelations) => void;
  onRequestChanges?: (voucher: IncomeExpenseWithRelations) => void;
  onResubmitReview?: (voucher: IncomeExpenseWithRelations) => void;
  /** Same trusted snapshot/policy context as the shared host controller. Missing rows stay disabled. */
  actionContexts?: Record<string, IncomeExpenseActionContext>;
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
  /** @deprecated Compatibility prop. Supply strict cancellation readiness in actionContexts. */
  cancelEligibility?: Record<string, FlexCancelEligibility>;
  /** @deprecated Compatibility prop. Supply strict cancellation readiness in actionContexts. */
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
  onApproveOnly,
  onApproveAndPost,
  onRequestChanges,
  onResubmitReview,
  actionContexts,
  onPostApproved,
  onReversePosting,
  onUnapprove,
  onVerify,
  onCopy,
  onHistory,
  pagination,
  totalCount,
}: IncomeExpenseListProps) => {
  const paginationInfo = useMemo(
    () => calculatePaginationInfo(pagination.page, pagination.pageSize, totalCount),
    [pagination.page, pagination.pageSize, totalCount],
  );
  const { data: isSuperAdmin = false } = useIsSuperAdmin();
  // Finance V2 §12.1: org CANONICAL read → badge composite 4 trục (Đã Duyệt -
  // Chưa Chi / Đã Chi / Đã hoàn tác…); org LEGACY giữ nhãn cũ.
  const v2Routes = useFinanceV2Routes();
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
            const isVerified = !!voucher.verified_at;
            const handlers: IncomeExpenseActionContext['handlers'] = {
              approveOnly: !!onApproveOnly, legacyApprove: !!onApprove, approveAndPost: !!onApproveAndPost,
              post: !!onPostApproved, reverse: !!onReversePosting, unapprove: !!onUnapprove, cancel: !!onCancel,
              edit: !!onEdit, supplement: !!onQuickEdit, requestChanges: !!onRequestChanges, resubmitReview: !!onResubmitReview,
            };
            const supplied = actionContexts?.[voucher.id];
            const context = supplied && (supplied.voucher.state !== 'ready' || supplied.voucher.value.id === voucher.id)
              ? { ...supplied, handlers: Object.fromEntries(Object.entries(handlers).map(([name, present]) => [name, present && supplied.handlers[name as IncomeExpenseAction]])) }
              : pendingIncomeExpenseActionContext(handlers, { approvalStatus: voucher.approval_status, postingStatus: voucher.posting_status, reviewState: voucher.review_state });
            const availability = decideIncomeExpenseActions(context);
            const actionButtons = [
              { name: 'edit', label: isUnapproved ? 'Sửa phiếu chờ duyệt' : 'Sửa phiếu (Super Admin)', Icon: Pencil, run: () => onEdit?.(voucher) },
              { name: 'supplement', label: 'Bổ sung chứng từ / ghi chú', Icon: FilePlus2, run: () => onQuickEdit?.(voucher) },
              { name: 'approveOnly', label: 'Duyệt phiếu', Icon: CheckCircle2, run: () => onApproveOnly?.(voucher) },
              { name: 'legacyApprove', label: 'Duyệt phiếu (đã thanh toán)', Icon: CheckCircle2, run: () => onApprove?.(voucher) },
              { name: 'approveAndPost', label: voucher.type === 'INCOME' ? 'Duyệt và thu' : 'Duyệt và chi', Icon: Banknote, run: () => onApproveAndPost?.(voucher) },
              { name: 'post', label: voucher.type === 'INCOME' ? 'Thu tiền vào sổ (phiếu đã duyệt)' : 'Chi tiền từ sổ (phiếu đã duyệt)', Icon: Banknote, run: () => onPostApproved?.(voucher) },
              { name: 'reverse', label: voucher.type === 'INCOME' ? 'Mở lại (tiền rời sổ, sửa được rồi thu lại)' : 'Mở lại (tiền về sổ, sửa được rồi chi lại)', Icon: RotateCcw, run: () => onReversePosting?.(voucher) },
              { name: 'unapprove', label: 'Huỷ duyệt (chuyển về Chờ duyệt) — Super Admin', Icon: Undo2, run: () => onUnapprove?.(voucher.id) },
              { name: 'cancel', label: 'Huỷ phiếu', Icon: Ban, run: () => onCancel(voucher.id, voucher.type) },
              { name: 'requestChanges', label: 'Yêu cầu sửa', Icon: Pencil, run: () => onRequestChanges?.(voucher) },
              { name: 'resubmitReview', label: 'Chuyển chờ duyệt', Icon: Undo2, run: () => onResubmitReview?.(voucher) },
            ] as const;
            // B4: lớp phiếu — Nội bộ (bút toán) hiển thị trung tính.
            const layer = voucherLayer({
              approval_status: voucher.approval_status,
              account_id: voucher.account_id,
              system_source: (voucher as any).system_source,
              account_is_virtual: (voucher as any).account_is_virtual,
            });
            const isInternal = layer === 'INTERNAL';
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

                    {actionButtons.map(({ name, label, Icon, run }) => {
                      const action = availability[name];
                      return action.visible && <Button key={name} variant="ghost" size="icon"
                        className="h-8 w-8 text-slate-600 hover:text-slate-800"
                        disabled={!action.enabled} aria-label={label} aria-busy={action.loading}
                        title={action.reason ? label + ' — ' + action.reason : label}
                        onClick={run}><Icon className="h-4 w-4" /></Button>;
                    })}

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
                    <AttachmentPreview urls={getVoucherDisplayAttachments(voucher)} />

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
