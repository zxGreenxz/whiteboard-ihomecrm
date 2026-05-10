import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Ban, FileText, X, Eye, Layers } from 'lucide-react';
import type {
  IncomeExpenseBatchSummary,
  IncomeExpenseWithRelations,
} from '@/hooks/useIncomeExpenses';
import { format } from 'date-fns';
import { useIsMobile } from '@/hooks/use-mobile';
import IncomeExpenseDetailDialog from './IncomeExpenseDetailDialog';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  batch: IncomeExpenseBatchSummary | null;
  onCancel?: (batchId: string) => void;
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
}: Props) {
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const [childVoucher, setChildVoucher] =
    useState<IncomeExpenseWithRelations | null>(null);
  const isMobile = useIsMobile();

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
            <Row label="Sổ quỹ" value={batch.account_name} />
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
                batch.business_result_accounting
                  ? 'Có hạch toán'
                  : 'Không hạch toán'
              }
            />
            {batch.notes && <Row label="Ghi chú" value={batch.notes} />}
          </div>

          {/* Đính kèm chung */}
          {batch.attachments && batch.attachments.length > 0 && (
            <>
              <SectionTitle>Đính kèm (dùng chung)</SectionTitle>
              <div className="flex flex-wrap gap-3">
                {batch.attachments.map((url) => (
                  <button
                    type="button"
                    key={url}
                    onClick={() => setLightboxUrl(url)}
                    className="group relative w-24 h-24 rounded-md border border-zinc-200 overflow-hidden bg-zinc-50 hover:border-primary hover:shadow-md transition-all cursor-zoom-in"
                  >
                    {isPdf(url) ? (
                      <div className="flex items-center justify-center w-full h-full">
                        <FileText className="h-10 w-10 text-muted-foreground" />
                      </div>
                    ) : (
                      <img
                        src={url}
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
            <div className="grid grid-cols-[110px_1fr_120px_140px_60px] bg-zinc-50 text-xs font-medium text-muted-foreground">
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
              <div className="px-3 py-2 text-center">Xem</div>
            </div>
            {batch.vouchers.map((v) => {
              const isCancelled = v.approval_status === 'CANCELLED';
              const itemName = v.items[0]?.type_name ?? '';
              return (
                <div
                  key={v.id}
                  className={`grid grid-cols-[110px_1fr_120px_140px_60px] border-t border-zinc-200 text-sm ${
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
                  <div className="px-3 py-2 text-center">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => setChildVoucher(v)}
                      title="Xem chi tiết phiếu"
                    >
                      <Eye className="h-4 w-4" />
                    </Button>
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
      />

      {/* Lightbox */}
      {lightboxUrl && (
        <div
          className="fixed inset-0 z-[60] bg-black/85 flex items-center justify-center p-6"
          onClick={() => setLightboxUrl(null)}
        >
          <button
            type="button"
            className="absolute top-4 right-4 text-white bg-white/10 hover:bg-white/20 rounded-full p-2"
            onClick={(e) => {
              e.stopPropagation();
              setLightboxUrl(null);
            }}
          >
            <X className="h-5 w-5" />
          </button>
          {isPdf(lightboxUrl) ? (
            <iframe
              src={lightboxUrl}
              className="w-full h-full max-w-5xl max-h-[90vh] bg-white rounded-md"
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <img
              src={lightboxUrl}
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
