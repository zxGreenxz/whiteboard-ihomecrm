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
  RotateCcw,
} from 'lucide-react';
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
  onApprove?: (id: string) => void;
  /** Huỷ duyệt: đưa phiếu đã ghi nhận về Nháp (chỉ super admin). */
  onUnapprove?: (id: string) => void;
  onVerify?: (voucher: IncomeExpenseWithRelations) => void;
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
  onUnapprove,
  onVerify,
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
  // Quyền chi tiết: duyệt / huỷ phiếu thu chi (fallback legacy: approve cũ,
  // cancel rơi về edit).
  const canApproveVoucher = canUse(perms, 'income_expenses', 'approve');
  const canCancelVoucher = canUse(perms, 'income_expenses', 'cancel');

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
          {vouchers.map((voucher) => {
            const isCancelled = voucher.approval_status === 'CANCELLED';
            const isUnapproved = voucher.approval_status === 'UNAPPROVED';
            const isCreator =
              !!currentUserId && voucher.user_id === currentUserId;
            const isVerified = !!voucher.verified_at;
            // Nháp: cây bút mở full form (giữ nguyên flow cũ).
            // Đã ghi nhận/đã huỷ: super admin vẫn mở full form; creator
            // (không phải admin) mở dialog sửa nhanh 3 field.
            const showFullEdit = !!onEdit && (isUnapproved || isAdmin);
            const showQuickEdit =
              !!onQuickEdit && !isUnapproved && !isAdmin && isCreator;

            const rowClass = [
              isCancelled ? 'opacity-60' : '',
              isVerified && !isCancelled ? 'bg-emerald-50/70 hover:bg-emerald-50' : '',
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
                        title={isUnapproved ? 'Sửa phiếu nháp' : 'Sửa phiếu (Super Admin)'}
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
                        title="Sửa sổ quỹ / hình ảnh / ghi chú"
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
                        onClick={() => onApprove(voucher.id)}
                        title="Duyệt phiếu (đã thanh toán)"
                      >
                        <CheckCircle2 className="h-4 w-4" />
                      </Button>
                    )}

                    {/* Huỷ duyệt: phiếu đã ghi nhận -> Nháp (chỉ super admin) */}
                    {isAdmin && !isUnapproved && !isCancelled && onUnapprove && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-amber-600 hover:text-amber-700 hover:bg-amber-50"
                        onClick={() => onUnapprove(voucher.id)}
                        title="Huỷ duyệt (chuyển về Nháp) — Super Admin"
                      >
                        <Undo2 className="h-4 w-4" />
                      </Button>
                    )}

                    {/* Huỷ phiếu (chỉ khi chưa huỷ) */}
                    {canCancelVoucher && !isCancelled && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-red-500 hover:text-red-600 hover:bg-red-50"
                        onClick={() => onCancel(voucher.id)}
                        title="Huỷ phiếu"
                      >
                        <Ban className="h-4 w-4" />
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
                    <span
                      className={`truncate ${isCancelled ? 'line-through' : ''}`}
                    >
                      {voucher.name}
                    </span>
                    {isCancelled ? (
                      <Badge
                        variant="secondary"
                        className="shrink-0 bg-red-100 text-red-700 hover:bg-red-100"
                      >
                        Đã huỷ
                      </Badge>
                    ) : isUnapproved ? (
                      <Badge
                        variant="secondary"
                        className="shrink-0 bg-amber-100 text-amber-700 hover:bg-amber-100"
                      >
                        Nháp
                      </Badge>
                    ) : (
                      <Badge
                        variant="default"
                        className="shrink-0 bg-green-100 text-green-800 hover:bg-green-100"
                      >
                        Đã ghi nhận
                      </Badge>
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
