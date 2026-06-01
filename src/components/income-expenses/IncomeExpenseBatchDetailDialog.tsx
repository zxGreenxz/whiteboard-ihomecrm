import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Ban,
  FileText,
  X,
  Eye,
  Layers,
  ChevronLeft,
  ChevronRight,
  Pencil,
} from 'lucide-react';
import { useIsAdmin } from '@/hooks/useIsAdmin';
import { useSignedUrl } from '@/hooks/useSignedUrl';
import { StorageImage } from '@/components/ui/storage-image';
import type {
  IncomeExpenseBatchSummary,
  IncomeExpenseWithRelations,
} from '@/hooks/useIncomeExpenses';
import { useUpdateBatchAccount } from '@/hooks/useIncomeExpenses';
import { useAccounts } from '@/hooks/useAccounts';
import { format } from 'date-fns';
import { useIsMobile } from '@/hooks/use-mobile';
import IncomeExpenseDetailDialog from './IncomeExpenseDetailDialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  batch: IncomeExpenseBatchSummary | null;
  onCancel?: (batchId: string) => void;
  /** Mở form sửa cho 1 phiếu con trong đợt (Super Admin). */
  onEditVoucher?: (voucher: IncomeExpenseWithRelations) => void;
  /** Huỷ 1 phiếu con riêng lẻ (khác với huỷ cả đợt). */
  onCancelVoucher?: (voucherId: string) => void;
  /** Duyệt 1 phiếu con (nếu còn nháp). */
  onApproveVoucher?: (voucherId: string) => void;
}

const formatVND = (n: number) => `${n.toLocaleString('vi-VN')} đ`;
const isPdf = (url: string) =>
  url.toLowerCase().endsWith('.pdf') || url.includes('.pdf');

const Row = ({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) => (
  <div className="grid grid-cols-[180px_1fr] border-b border-zinc-200 last:border-b-0">
    <div className="px-4 py-2.5 bg-zinc-50 text-sm text-muted-foreground border-r border-zinc-200">
      {label}
    </div>
    <div className="px-4 py-2.5 text-sm">{value || '—'}</div>
  </div>
);

const SectionTitle = ({ children }: { children: React.ReactNode }) => (
  <h3 className="text-sm font-semibold text-foreground mb-2 mt-4 first:mt-0">
    {children}
  </h3>
);

export function IncomeExpenseBatchDetailDialog({
  open,
  onOpenChange,
  batch,
  onCancel,
  onEditVoucher,
  onCancelVoucher,
  onApproveVoucher,
}: Props) {
  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);
  const [childVoucher, setChildVoucher] =
    useState<IncomeExpenseWithRelations | null>(null);
  const isMobile = useIsMobile();
  const { data: isAdmin = false } = useIsAdmin();
  const { data: accounts = [] } = useAccounts();
  const updateBatchAccount = useUpdateBatchAccount();

  // Tất cả phiếu con cùng sổ quỹ? Nếu có, admin được đổi sổ quỹ cả đợt.
  const allSameAccount =
    !!batch &&
    batch.vouchers.length > 0 &&
    batch.vouchers.every((v) => v.account_id === batch.vouchers[0].account_id);
  const sharedAccountId = allSameAccount ? batch?.vouchers[0]?.account_id ?? null : null;
  const canEditAccount = isAdmin && allSameAccount && !!batch && !batch.all_cancelled;

  const attachments = batch?.attachments ?? [];
  const lightboxUrl =
    lightboxIdx !== null ? attachments[lightboxIdx] ?? null : null;
  const lightboxSignedUrl = useSignedUrl(lightboxUrl);
  const hasMultiple = attachments.length > 1;
  const isLightboxOpen = lightboxIdx !== null;

  const closeLightbox = () => setLightboxIdx(null);
  const goPrev = () =>
    setLightboxIdx((i) =>
      i === null || attachments.length === 0
        ? i
        : (i - 1 + attachments.length) % attachments.length
    );
  const goNext = () =>
    setLightboxIdx((i) =>
      i === null || attachments.length === 0 ? i : (i + 1) % attachments.length
    );

  useEffect(() => {
    if (!open) setLightboxIdx(null);
  }, [open]);

  useEffect(() => {
    if (!isLightboxOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        e.preventDefault();
        closeLightbox();
      } else if (e.key === 'ArrowLeft' && hasMultiple) {
        e.preventDefault();
        goPrev();
      } else if (e.key === 'ArrowRight' && hasMultiple) {
        e.preventDefault();
        goNext();
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [isLightboxOpen, hasMultiple]);

  if (!batch) return null;

  const isExpense = batch.type === 'EXPENSE';

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          className={
            isMobile
              ? 'max-w-full w-full h-[95vh] !top-auto !bottom-0 !left-0 !translate-x-0 !translate-y-0 rounded-t-2xl rounded-b-none p-4 overflow-y-auto'
              : 'sm:max-w-[820px] max-h-[90vh] overflow-y-auto'
          }
          onPointerDownOutside={(e) => {
            if (isLightboxOpen) e.preventDefault();
          }}
          onInteractOutside={(e) => {
            if (isLightboxOpen) e.preventDefault();
          }}
          onEscapeKeyDown={(e) => {
            if (isLightboxOpen) e.preventDefault();
          }}
        >
          {isMobile && (
            <div className="absolute top-2 left-1/2 -translate-x-1/2 w-10 h-1 bg-zinc-300 rounded-full" />
          )}
          <DialogHeader
            className={`flex flex-row items-center justify-between border-b pb-3 ${
              isMobile ? 'pt-3' : ''
            }`}
          >
            <DialogTitle className="text-primary uppercase tracking-wide flex items-center gap-2">
              <Layers className="h-4 w-4" />
              Chi tiết phiếu tổng
            </DialogTitle>
          </DialogHeader>

          <div className="flex items-center justify-between mt-1">
            <SectionTitle>Thông tin chung</SectionTitle>
            {batch.has_approved && onCancel && (
              <Button
                size="sm"
                variant="default"
                className="h-8 bg-orange-500 hover:bg-orange-600 text-white"
                title="Huỷ cả đợt"
                onClick={() => {
                  onCancel(batch.id);
                  onOpenChange(false);
                }}
              >
                <Ban className="h-4 w-4 mr-1" />
                Huỷ cả đợt
              </Button>
            )}
          </div>

          <div className="rounded-md border border-zinc-200 overflow-hidden">
            <Row
              label="Tên đợt"
              value={
                <div className="flex items-center gap-2">
                  <span className="font-medium">{batch.name}</span>
                  {batch.all_cancelled && (
                    <Badge
                      variant="secondary"
                      className="bg-red-100 text-red-700"
                    >
                      Đã huỷ toàn bộ
                    </Badge>
                  )}
                </div>
              }
            />
            <Row
              label="Tổng tiền"
              value={
                <span
                  className={
                    batch.type === 'INCOME'
                      ? 'text-green-600 font-medium'
                      : 'text-red-600 font-medium'
                  }
                >
                  {batch.type === 'INCOME' ? '+' : '-'}
                  {formatVND(batch.total_amount)}
                </span>
              }
            />
            <Row
              label="Số phiếu trong đợt"
              value={`${batch.voucher_count} phiếu (${batch.building_names.length} tòa nhà)`}
            />
            <Row
              label="Sổ quỹ"
              value={
                canEditAccount && sharedAccountId ? (
                  <Select
                    value={sharedAccountId}
                    onValueChange={(value) => {
                      if (value && value !== sharedAccountId) {
                        updateBatchAccount.mutate({
                          batchId: batch.id,
                          accountId: value,
                        });
                      }
                    }}
                    disabled={updateBatchAccount.isPending}
                  >
                    <SelectTrigger className="h-8 w-[280px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {accounts.map((a) => (
                        <SelectItem key={a.id} value={a.id}>
                          {a.name}
                          {a.bank_name ? ` (${a.bank_name})` : ''}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  batch.account_name
                )
              }
            />
            <Row
              label={isExpense ? 'Người nhận' : 'Người nộp'}
              value={batch.payer_name}
            />
            <Row
              label="Ngày"
              value={
                batch.voucher_date
                  ? format(new Date(batch.voucher_date), 'dd-MM-yyyy')
                  : '—'
              }
            />
            <Row
              label="Ngày tạo"
              value={
                batch.created_at
                  ? format(new Date(batch.created_at), 'dd-MM-yyyy HH:mm')
                  : '—'
              }
            />
            <Row label="Người tạo" value={batch.creator_name} />
            <Row
              label="Hạch toán KQKD"
              value={
                ((batch.vouchers?.[0]?.counts_in_business_result ?? true)
                  ? 'Có hạch toán'
                  : 'Không hạch toán') +
                (batch.business_result_accounting == null ? ' (tự động)' : ' (override)')
              }
            />
            {batch.notes && <Row label="Ghi chú" value={batch.notes} />}
          </div>

          {/* Đính kèm chung */}
          {batch.attachments && batch.attachments.length > 0 && (
            <>
              <SectionTitle>Đính kèm (dùng chung)</SectionTitle>
              <div className="flex flex-wrap gap-3">
                {batch.attachments.map((url, idx) => (
                  <button
                    type="button"
                    key={url}
                    onClick={() => setLightboxIdx(idx)}
                    className="group relative w-24 h-24 rounded-md border border-zinc-200 overflow-hidden bg-zinc-50 hover:border-primary hover:shadow-md transition-all cursor-zoom-in"
                  >
                    {isPdf(url) ? (
                      <div className="flex items-center justify-center w-full h-full">
                        <FileText className="h-10 w-10 text-muted-foreground" />
                      </div>
                    ) : (
                      <StorageImage
                        value={url}
                        alt="Đính kèm"
                        className="w-full h-full object-cover transition-transform duration-200 group-hover:scale-110"
                      />
                    )}
                  </button>
                ))}
              </div>
            </>
          )}

          {/* Danh sách phiếu con */}
          <SectionTitle>Các phiếu trong đợt ({batch.voucher_count})</SectionTitle>
          <div className="rounded-md border border-zinc-200 overflow-hidden">
            <div className="grid grid-cols-[110px_1fr_120px_140px_100px] bg-zinc-50 text-xs font-medium text-muted-foreground">
              <div className="px-3 py-2 border-r border-zinc-200">Mã</div>
              <div className="px-3 py-2 border-r border-zinc-200">
                Tòa / Phòng / Loại
              </div>
              <div className="px-3 py-2 border-r border-zinc-200 text-right">
                Số tiền
              </div>
              <div className="px-3 py-2 border-r border-zinc-200">
                Trạng thái
              </div>
              <div className="px-3 py-2 text-center">Thao tác</div>
            </div>
            {batch.vouchers.map((v) => {
              const isCancelled = v.approval_status === 'CANCELLED';
              const isUnapproved = v.approval_status === 'UNAPPROVED';
              const canEditInline = (isUnapproved || isAdmin) && !!onEditVoucher;
              const itemName = v.items[0]?.type_name ?? '';
              return (
                <div
                  key={v.id}
                  className={`grid grid-cols-[110px_1fr_120px_140px_100px] border-t border-zinc-200 text-sm ${
                    isCancelled ? 'opacity-60' : ''
                  }`}
                >
                  <div
                    className={`px-3 py-2 border-r border-zinc-200 font-medium ${
                      isCancelled ? 'line-through' : ''
                    }`}
                  >
                    {v.code}
                  </div>
                  <div className="px-3 py-2 border-r border-zinc-200">
                    <div className="leading-tight">
                      <div>
                        {v.building_name}
                        {v.room_name ? ` / ${v.room_name}` : ''}
                      </div>
                      {itemName && (
                        <div className="text-xs text-muted-foreground">
                          {itemName}
                        </div>
                      )}
                    </div>
                  </div>
                  <div
                    className={`px-3 py-2 border-r border-zinc-200 text-right ${
                      v.type === 'INCOME'
                        ? 'text-green-600'
                        : 'text-red-600'
                    } font-medium`}
                  >
                    {v.type === 'INCOME' ? '+' : '-'}
                    {formatVND(v.total_amount)}
                  </div>
                  <div className="px-3 py-2 border-r border-zinc-200">
                    {isCancelled ? (
                      <Badge
                        variant="secondary"
                        className="bg-red-100 text-red-700"
                      >
                        Đã huỷ
                      </Badge>
                    ) : (
                      <Badge
                        variant="default"
                        className="bg-green-100 text-green-800"
                      >
                        Đã ghi nhận
                      </Badge>
                    )}
                  </div>
                  <div className="px-3 py-2 flex items-center justify-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-blue-500 hover:text-blue-600 hover:bg-blue-50"
                      onClick={() => setChildVoucher(v)}
                      title="Xem chi tiết phiếu"
                    >
                      <Eye className="h-4 w-4" />
                    </Button>
                    {canEditInline && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-amber-600 hover:text-amber-700 hover:bg-amber-50"
                        onClick={() => {
                          onOpenChange(false);
                          onEditVoucher?.(v);
                        }}
                        title={
                          isUnapproved
                            ? 'Sửa phiếu nháp'
                            : 'Sửa phiếu (Super Admin)'
                        }
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </DialogContent>
      </Dialog>

      {/* Detail dialog cho phiếu con */}
      <IncomeExpenseDetailDialog
        open={!!childVoucher}
        onOpenChange={(o) => {
          if (!o) setChildVoucher(null);
        }}
        voucher={childVoucher}
        onEdit={
          onEditVoucher
            ? (v) => {
                setChildVoucher(null);
                onOpenChange(false);
                onEditVoucher(v);
              }
            : undefined
        }
        onCancel={
          onCancelVoucher
            ? (id) => {
                setChildVoucher(null);
                onCancelVoucher(id);
              }
            : undefined
        }
        onApprove={
          onApproveVoucher
            ? (id) => {
                setChildVoucher(null);
                onApproveVoucher(id);
              }
            : undefined
        }
      />

      {/* Lightbox */}
      {lightboxUrl && (
        <div
          className="fixed inset-0 z-[60] bg-black/85 flex items-center justify-center p-6 pointer-events-auto"
          onClick={closeLightbox}
        >
          <button
            type="button"
            className="absolute top-4 right-4 text-white bg-white/10 hover:bg-white/20 rounded-full p-2"
            onClick={(e) => {
              e.stopPropagation();
              closeLightbox();
            }}
            title="Đóng (Esc)"
          >
            <X className="h-5 w-5" />
          </button>
          {hasMultiple && (
            <>
              <button
                type="button"
                className="absolute left-4 top-1/2 -translate-y-1/2 text-white bg-white/10 hover:bg-white/20 rounded-full p-2"
                onClick={(e) => {
                  e.stopPropagation();
                  goPrev();
                }}
                title="Ảnh trước (←)"
              >
                <ChevronLeft className="h-6 w-6" />
              </button>
              <button
                type="button"
                className="absolute right-4 top-1/2 -translate-y-1/2 text-white bg-white/10 hover:bg-white/20 rounded-full p-2"
                onClick={(e) => {
                  e.stopPropagation();
                  goNext();
                }}
                title="Ảnh sau (→)"
              >
                <ChevronRight className="h-6 w-6" />
              </button>
              <div className="absolute bottom-4 left-1/2 -translate-x-1/2 text-white/90 text-sm bg-black/40 rounded-full px-3 py-1">
                {(lightboxIdx ?? 0) + 1} / {attachments.length}
              </div>
            </>
          )}
          {isPdf(lightboxUrl) ? (
            <iframe
              src={lightboxSignedUrl}
              className="w-full h-full max-w-5xl max-h-[90vh] bg-white rounded-md"
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <StorageImage
              value={lightboxUrl}
              alt="Đính kèm phóng lớn"
              className="max-w-[95vw] max-h-[90vh] object-contain rounded-md shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            />
          )}
        </div>
      )}
    </>
  );
}

export default IncomeExpenseBatchDetailDialog;
