// =============================================
// VoucherDetailPage — trang chi tiết 1 phiếu thu/chi (mở tab mới từ link
// "phiếu thu"). Nếu phiếu nằm trong 1 đợt (phiếu tổng) thì chia đôi khung:
// trái = chi tiết phiếu, phải = chi tiết phiếu tổng (kèm danh sách phiếu con).
// Read-only — chỉ hiển thị + in; sửa/huỷ làm ở trang /income-expense.
// =============================================

import { useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { ArrowLeft, Printer, FileText, Layers } from 'lucide-react';
import { format } from 'date-fns';
import { useVoucherWithBatch } from '@/hooks/useVoucherDetail';
import { StorageImage } from '@/components/ui/storage-image';
import { AttachmentLightbox } from '@/components/ui/attachment-lightbox';
import { formatPeriod } from '@/lib/monthPeriod';
import { kqkdStatusLabel } from '@/lib/kqkd';
import { Skeleton } from '@/components/ui/skeleton';
import type { IncomeExpenseWithRelations, IncomeExpenseBatchSummary } from '@/hooks/useIncomeExpenses';
// Finance V2 (route-aware §9.6/§12.1): badge composite khi org CANONICAL read-semantics.
import { useFinanceV2Routes, isCanonicalRead } from '@/lib/financeV2Route';
import { VoucherStatusBadge } from '@/components/income-expenses/VoucherStatusBadge';
import {
  CommissionVoucherNote,
  laPhieuHoaHong,
} from '@/components/income-expenses/CommissionVoucherNote';
import type { VoucherDisplayInput } from '@/lib/financeV2VoucherState';

const formatVND = (n: number) => `${n.toLocaleString('vi-VN')} đ`;
const isPdf = (url: string) =>
  url.toLowerCase().endsWith('.pdf') || url.includes('.pdf');
const fmtAmount = (type: 'INCOME' | 'EXPENSE', n: number) =>
  `${type === 'INCOME' ? '+' : '-'}${formatVND(n)}`;
const amountCls = (type: 'INCOME' | 'EXPENSE') =>
  type === 'INCOME' ? 'text-green-600 font-medium' : 'text-red-600 font-medium';

const Row = ({ label, value }: { label: string; value: React.ReactNode }) => (
  <div className="grid grid-cols-[150px_1fr] border-b border-zinc-200 last:border-b-0">
    <div className="px-4 py-2.5 bg-zinc-50 text-sm text-muted-foreground border-r border-zinc-200">
      {label}
    </div>
    <div className="px-4 py-2.5 text-sm break-words">{value || '—'}</div>
  </div>
);

const SectionTitle = ({ children }: { children: React.ReactNode }) => (
  <h3 className="text-sm font-semibold text-foreground mb-2 mt-4 first:mt-0">
    {children}
  </h3>
);

const StatusBadge = ({ status }: { status: IncomeExpenseWithRelations['approval_status'] }) => {
  if (status === 'CANCELLED')
    return <span className="px-2 py-0.5 text-xs rounded bg-red-100 text-red-700">Đã huỷ</span>;
  if (status === 'UNAPPROVED')
    return <span className="px-2 py-0.5 text-xs rounded bg-amber-100 text-amber-700">Chờ duyệt</span>;
  return <span className="px-2 py-0.5 text-xs rounded bg-green-100 text-green-800">Đã ghi nhận</span>;
};

// Finance V2 (route-aware §9.6/§12.1): khi org của phiếu đã CANONICAL read-semantics
// VÀ row có posting_status (cột V2 — cast vì chưa vào generated types), render badge
// composite dùng chung (VoucherStatusBadge + v2). Ngược lại giữ NGUYÊN StatusBadge
// legacy ở trên — mọi chuỗi/lối rẽ hiện tại không đổi.
const RouteAwareStatusBadge = ({
  v,
}: {
  v: Pick<IncomeExpenseWithRelations, 'approval_status' | 'type'>;
}) => {
  const v2Routes = useFinanceV2Routes();
  const row = v as {
    organization_id?: string | null;
    review_state?: string | null;
    posting_mode?: string | null;
    posting_status?: string | null;
  };
  const orgRoutes = v2Routes.getOrg(row.organization_id ?? null);
  if (isCanonicalRead(orgRoutes) && row.posting_status) {
    return (
      <VoucherStatusBadge
        status={v.approval_status}
        v2={{
          type: v.type,
          review_state: (row.review_state ?? null) as VoucherDisplayInput['review_state'],
          posting_mode: (row.posting_mode ?? null) as VoucherDisplayInput['posting_mode'],
          posting_status: row.posting_status as VoucherDisplayInput['posting_status'],
        }}
      />
    );
  }
  return <StatusBadge status={v.approval_status} />;
};

// Lưới ảnh đính kèm — click mở lightbox.
const Attachments = ({
  urls,
  onOpen,
}: {
  urls: string[];
  onOpen: (urls: string[], idx: number) => void;
}) => (
  <div className="flex flex-wrap gap-3">
    {urls.map((url, idx) => (
      <button
        type="button"
        key={url}
        onClick={() => onOpen(urls, idx)}
        className="group relative w-24 h-24 rounded-md border border-zinc-200 overflow-hidden bg-zinc-50 hover:border-primary hover:shadow-md transition-all cursor-zoom-in"
        title="Click để xem lớn"
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
);

// ── Khung CHI TIẾT PHIẾU (image 1) ──
function VoucherCard({
  v,
  onOpenLightbox,
}: {
  v: IncomeExpenseWithRelations;
  onOpenLightbox: (urls: string[], idx: number) => void;
}) {
  const isExpense = v.type === 'EXPENSE';
  return (
    <div className="rounded-lg border bg-card p-4">
      <h2 className="text-primary uppercase tracking-wide font-semibold border-b pb-3">
        Thông tin thu/chi
      </h2>
      <SectionTitle>Thông tin chung</SectionTitle>
      <div className="rounded-md border border-zinc-200 overflow-hidden">
        <Row
          label="Mã phiếu"
          value={
            <span className="inline-flex items-center gap-2">
              <span className="font-medium">{v.code}</span>
              <RouteAwareStatusBadge v={v} />
            </span>
          }
        />
        <Row label="Tên" value={v.name} />
        <Row
          label="Số tiền"
          value={<span className={amountCls(v.type)}>{fmtAmount(v.type, v.total_amount)}</span>}
        />
        <Row label="Sổ quỹ" value={v.account_name} />
        <Row
          label="Tòa nhà"
          value={
            v.building_name
              ? `${v.building_name}${v.room_name ? ' / ' + v.room_name : ''}`
              : '—'
          }
        />
        {v.invoice_id && (
          <Row
            label="Hoá đơn liên quan"
            value={
              <Link
                to={`/invoices/${v.invoice_id}`}
                className="text-blue-600 hover:text-blue-700 hover:underline font-medium"
              >
                Xem hoá đơn
              </Link>
            }
          />
        )}
        <Row label={isExpense ? 'Người nhận' : 'Người nộp'} value={v.payer_name} />
        <Row
          label="Thời gian"
          value={v.voucher_date ? format(new Date(v.voucher_date), 'dd-MM-yyyy') : '—'}
        />
        <Row
          label="Ngày tạo"
          value={v.created_at ? format(new Date(v.created_at), 'dd-MM-yyyy HH:mm') : '—'}
        />
        <Row label="Người tạo" value={v.creator_name} />
        <Row label="Hạch toán kết quả kinh doanh" value={kqkdStatusLabel(v)} />
        {(v.notes || laPhieuHoaHong(v)) && (
          <Row
            label="Ghi chú"
            value={<CommissionVoucherNote voucher={v} fallbackNotes={v.notes} />}
          />
        )}
      </div>

      {v.items && v.items.length > 0 && (
        <>
          <SectionTitle>Hạng mục</SectionTitle>
          <div className="rounded-md border border-zinc-200 overflow-hidden">
            {v.items.map((item, idx) => (
              <div
                key={item.id}
                className={`grid grid-cols-[1fr_150px] ${idx > 0 ? 'border-t border-zinc-200' : ''}`}
              >
                <div className="px-4 py-2.5 text-sm border-r border-zinc-200">
                  {item.type_name}
                  {item.description ? (
                    <span className="text-muted-foreground ml-1">— {item.description}</span>
                  ) : null}
                  {formatPeriod(item.start_date, item.end_date) ? (
                    <div className="text-xs text-muted-foreground mt-0.5">
                      Kỳ: {formatPeriod(item.start_date, item.end_date)}
                    </div>
                  ) : null}
                </div>
                <div className="px-4 py-2.5 text-sm text-right">
                  {formatVND(Number(item.amount))}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {v.attachments && v.attachments.length > 0 && (
        <>
          <SectionTitle>Đính kèm</SectionTitle>
          <Attachments urls={v.attachments} onOpen={onOpenLightbox} />
        </>
      )}
    </div>
  );
}

// ── Khung CHI TIẾT PHIẾU TỔNG (image 2) ──
function BatchCard({
  batch,
  currentVoucherId,
  onOpenLightbox,
}: {
  batch: IncomeExpenseBatchSummary;
  currentVoucherId: string;
  onOpenLightbox: (urls: string[], idx: number) => void;
}) {
  const isExpense = batch.type === 'EXPENSE';
  return (
    <div className="rounded-lg border bg-card p-4">
      <h2 className="text-primary uppercase tracking-wide font-semibold border-b pb-3 flex items-center gap-2">
        <Layers className="h-4 w-4" />
        Chi tiết phiếu tổng
      </h2>
      <SectionTitle>Thông tin chung</SectionTitle>
      <div className="rounded-md border border-zinc-200 overflow-hidden">
        <Row label="Tên đợt" value={<span className="font-medium">{batch.name}</span>} />
        <Row
          label="Tổng tiền"
          value={<span className={amountCls(batch.type)}>{fmtAmount(batch.type, batch.total_amount)}</span>}
        />
        <Row
          label="Số phiếu trong đợt"
          value={`${batch.voucher_count} phiếu (${batch.building_names.length} tòa nhà)`}
        />
        <Row label="Sổ quỹ" value={batch.account_name} />
        <Row label={isExpense ? 'Người nhận' : 'Người nộp'} value={batch.payer_name} />
        <Row
          label="Ngày"
          value={batch.voucher_date ? format(new Date(batch.voucher_date), 'dd-MM-yyyy') : '—'}
        />
        <Row
          label="Ngày tạo"
          value={batch.created_at ? format(new Date(batch.created_at), 'dd-MM-yyyy HH:mm') : '—'}
        />
        <Row label="Người tạo" value={batch.creator_name} />
        {batch.notes && <Row label="Ghi chú" value={batch.notes} />}
      </div>

      {batch.attachments && batch.attachments.length > 0 && (
        <>
          <SectionTitle>Đính kèm (dùng chung)</SectionTitle>
          <Attachments urls={batch.attachments} onOpen={onOpenLightbox} />
        </>
      )}

      <SectionTitle>Các phiếu trong đợt ({batch.voucher_count})</SectionTitle>
      <div className="rounded-md border border-zinc-200 overflow-hidden">
        <div className="grid grid-cols-[100px_1fr_120px_110px] bg-zinc-50 text-xs font-medium text-muted-foreground">
          <div className="px-3 py-2 border-r border-zinc-200">Mã</div>
          <div className="px-3 py-2 border-r border-zinc-200">Tòa / Phòng / Loại</div>
          <div className="px-3 py-2 border-r border-zinc-200 text-right">Số tiền</div>
          <div className="px-3 py-2">Trạng thái</div>
        </div>
        {batch.vouchers.map((v) => {
          const isCurrent = v.id === currentVoucherId;
          const isCancelled = v.approval_status === 'CANCELLED';
          const itemName = v.items[0]?.type_name ?? '';
          const itemPeriod = formatPeriod(v.items[0]?.start_date, v.items[0]?.end_date);
          return (
            <div
              key={v.id}
              className={`grid grid-cols-[100px_1fr_120px_110px] border-t border-zinc-200 text-sm ${
                isCancelled ? 'opacity-60' : ''
              } ${isCurrent ? 'bg-violet-50' : ''}`}
            >
              <div className={`px-3 py-2 border-r border-zinc-200 font-medium ${isCancelled ? 'line-through' : ''}`}>
                {isCurrent ? (
                  <span className="text-violet-700">{v.code}</span>
                ) : (
                  <Link
                    to={`/income-expense/voucher/${v.id}`}
                    className="text-blue-600 hover:text-blue-700 hover:underline"
                    title="Mở chi tiết phiếu này"
                  >
                    {v.code}
                  </Link>
                )}
              </div>
              <div className="px-3 py-2 border-r border-zinc-200">
                <div className="leading-tight">
                  <div>
                    {v.building_name}
                    {v.room_name ? ` / ${v.room_name}` : ''}
                  </div>
                  {itemName && <div className="text-xs text-muted-foreground">{itemName}</div>}
                  {itemPeriod && (
                    <div className="text-xs text-muted-foreground">Kỳ: {itemPeriod}</div>
                  )}
                </div>
              </div>
              <div className={`px-3 py-2 border-r border-zinc-200 text-right ${amountCls(v.type)}`}>
                {fmtAmount(v.type, v.total_amount)}
              </div>
              <div className="px-3 py-2 flex items-center gap-1.5">
                <RouteAwareStatusBadge v={v} />
                {isCurrent && <span className="text-[10px] text-violet-600 font-medium">đang xem</span>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function VoucherDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data, isLoading } = useVoucherWithBatch(id);
  const voucher = data?.voucher ?? null;
  const batch = data?.batch ?? null;

  // Lightbox dùng chung cho cả 2 khung — set danh sách + index khi click.
  const [lightbox, setLightbox] = useState<{ urls: string[]; index: number | null }>({
    urls: [],
    index: null,
  });
  const openLightbox = (urls: string[], idx: number) => setLightbox({ urls, index: idx });

  return (
    <div className="min-h-screen bg-zinc-50">
      <div className="sticky top-0 z-10 bg-white border-b">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <button
              type="button"
              onClick={() => navigate(-1)}
              className="h-8 w-8 grid place-items-center rounded-md hover:bg-muted text-muted-foreground"
              title="Quay lại"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
            <h1 className="text-base font-semibold truncate">
              Chi tiết phiếu thu {voucher?.code ? `— ${voucher.code}` : ''}
            </h1>
          </div>
          {voucher && (
            <button
              type="button"
              onClick={() =>
                window.open(
                  `/income-expense/print/${voucher.id}`,
                  '_blank',
                  'noopener,width=900,height=1000',
                )
              }
              className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-blue-500 hover:bg-blue-600 text-white text-sm"
              title="In phiếu"
            >
              <Printer className="h-4 w-4" />
              In phiếu
            </button>
          )}
        </div>
      </div>

      <div className="max-w-6xl mx-auto p-4">
        {isLoading ? (
          <div className="max-w-2xl mx-auto space-y-3">
            <Skeleton className="h-8 w-48" />
            <Skeleton className="h-64 w-full" />
          </div>
        ) : !voucher ? (
          <div className="text-center py-16 text-muted-foreground">
            Không tìm thấy phiếu thu này (có thể đã bị xoá hoặc bạn không có quyền xem).
          </div>
        ) : (
          <div
            className={
              batch
                ? 'grid grid-cols-1 lg:grid-cols-2 gap-4 items-start'
                : 'max-w-2xl mx-auto'
            }
          >
            <VoucherCard v={voucher} onOpenLightbox={openLightbox} />
            {batch && (
              <BatchCard
                batch={batch}
                currentVoucherId={voucher.id}
                onOpenLightbox={openLightbox}
              />
            )}
          </div>
        )}
      </div>

      <AttachmentLightbox
        attachments={lightbox.urls}
        index={lightbox.index}
        onIndexChange={(idx) => setLightbox((s) => ({ ...s, index: idx }))}
      />
    </div>
  );
}
