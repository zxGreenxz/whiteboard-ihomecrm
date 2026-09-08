import { useId, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { ChevronLeft, ChevronRight, RefreshCw, X } from 'lucide-react';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useBuildings } from '@/hooks/useBuildings';
import { useMyPermissions } from '@/hooks/useMyPermissions';
import { useInvoiceRoundingReport } from '@/hooks/useInvoiceRoundingReport';
import { canUse } from '@/lib/permissionPages';
import { currentMonthVN, fmtBillingMonth } from '@/lib/collect';
import { ROUNDING_REASON_LABELS, RoundingReportError } from '@/lib/invoiceRoundingReport';

const filtersSchema = z.object({
  billingMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  collectorId: z.union([z.literal(''), z.string().uuid()]),
  buildingId: z.union([z.literal(''), z.string().uuid()]),
});
interface FilterValues { billingMonth: string; collectorId: string; buildingId: string }
const PAGE_SIZE = 50;
const money = (value: number | null) => value === null ? 'Không rõ' : `${value.toLocaleString('vi-VN')} đ`;
const date = (value: string) => value.split('-').reverse().join('/');

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  billingMonth?: string;
  buildingId?: string;
}

/** Mount on open so each entry inherits the currently selected invoice period/building. */
export default function InvoiceRoundingReportDialog({ open, onOpenChange, billingMonth, buildingId }: Props) {
  const id = useId();
  const { data: permissions } = useMyPermissions();
  const allowed = canUse(permissions, 'thu_tien', 'report');
  const { data: buildings = [], isError: buildingsError } = useBuildings({ enabled: open && allowed });
  const { control, watch } = useForm<FilterValues>({
    resolver: zodResolver(filtersSchema),
    defaultValues: { billingMonth: billingMonth?.slice(0, 7) || currentMonthVN(), collectorId: '', buildingId: buildingId || '' },
  });
  const filters = watch();
  const [page, setPage] = useState(0);
  const report = useInvoiceRoundingReport({ ...filters, offset: page * PAGE_SIZE, limit: PAGE_SIZE }, open && allowed);
  const validPeriod = /^\d{4}-(0[1-9]|1[0-2])$/.test(filters.billingMonth);
  const data = allowed ? report.data : undefined;
  const pages = Math.max(1, Math.ceil((data?.total_count ?? 0) / PAGE_SIZE));
  const summaries = data?.by_collector.filter((item) => !filters.collectorId || item.collector_id === filters.collectorId) ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent hideClose className="flex max-h-[94dvh] w-[calc(100%-1rem)] max-w-5xl flex-col gap-4 overflow-hidden rounded-xl p-4 sm:p-6" onEscapeKeyDown={() => onOpenChange(false)}>
        <DialogHeader className="pr-10 text-left">
          <DialogTitle>Khoản bỏ qua</DialogTitle>
          <DialogDescription>Khoản thiếu dưới 10.000đ đã được tính đóng đủ, gồm khách đóng thiếu và thối thêm.</DialogDescription>
        </DialogHeader>
        <DialogClose asChild><Button variant="ghost" size="icon" className="absolute right-3 top-3" aria-label="Đóng báo cáo"><X className="h-5 w-5" /></Button></DialogClose>
        {!allowed ? <p role="alert">Bạn không có quyền xem báo cáo khoản bỏ qua.</p> : <>
          <div className="grid shrink-0 grid-cols-2 gap-3 sm:grid-cols-3">
            <label htmlFor={`${id}-month`} className="col-span-2 grid gap-1 text-sm font-medium sm:col-span-1">Kỳ hóa đơn
              <Controller name="billingMonth" control={control} render={({ field }) => <Input {...field} id={`${id}-month`} type="month" onChange={(event) => { field.onChange(event); setPage(0); }} />} />
            </label>
            <label htmlFor={`${id}-building`} className="grid gap-1 text-sm font-medium">Tòa
              <Controller name="buildingId" control={control} render={({ field }) => <select {...field} id={`${id}-building`} className="h-10 min-w-0 rounded-md border bg-background px-3" onChange={(event) => { field.onChange(event); setPage(0); }}>
                <option value="">Tất cả tòa</option>
                {buildings.map((building) => <option key={building.id} value={building.id}>{building.name}</option>)}
              </select>} />
            </label>
            <label htmlFor={`${id}-collector`} className="grid gap-1 text-sm font-medium">Người thu
              <Controller name="collectorId" control={control} render={({ field }) => <select {...field} id={`${id}-collector`} className="h-10 min-w-0 rounded-md border bg-background px-3" onChange={(event) => { field.onChange(event); setPage(0); }}>
                <option value="">Tất cả người thu</option>
                {data?.by_collector.filter((collector) => collector.collector_id !== null).map((collector) => <option key={collector.collector_id} value={collector.collector_id}>{collector.collector_name || 'Chưa rõ tên'}</option>)}
              </select>} />
            </label>
          </div>
          {buildingsError && <p role="alert" className="text-sm text-destructive">Chưa tải được danh sách tòa. Vui lòng đóng và mở lại báo cáo.</p>}
          {!validPeriod ? <p role="alert">Vui lòng chọn kỳ hóa đơn hợp lệ.</p> : report.isError ? <div role="alert" className="space-y-3 rounded-lg border p-4 text-sm">
            <p>{report.error instanceof RoundingReportError ? report.error.message : 'Chưa tải được báo cáo khoản bỏ qua. Vui lòng thử lại.'}</p>
            <Button variant="outline" onClick={() => void report.refetch()}><RefreshCw className="mr-2 h-4 w-4" />Thử lại</Button>
          </div> : report.isPending ? <p role="status">Đang tải báo cáo…</p> : data && <>
            <div className="grid shrink-0 grid-cols-2 gap-3" aria-live="polite">
              <div aria-label="Tổng khoản bỏ qua" className="rounded-lg border bg-amber-50 p-3"><p className="text-sm text-muted-foreground">Tổng khoản bỏ qua</p><p className="break-words text-xl font-semibold text-amber-800">{money(data.total_amount)}</p></div>
              <div aria-label="Số hóa đơn có khoản bỏ qua" className="rounded-lg border p-3"><p className="text-sm text-muted-foreground">Số hóa đơn</p><p className="text-xl font-semibold">{data.invoice_count.toLocaleString('vi-VN')}</p><p className="text-xs text-muted-foreground">{data.total_count.toLocaleString('vi-VN')} lần bỏ qua</p></div>
            </div>
            <div className="min-h-0 flex-1 space-y-5 overflow-y-auto pr-1" aria-busy={report.isFetching}>
              {data.total_count === 0 ? <p className="py-6 text-center text-muted-foreground">Không có khoản bỏ qua trong phạm vi đã chọn.</p> : <>
                <section aria-label="Theo người thu" className="space-y-2">
                  <h3 className="font-semibold">Theo người thu</h3>
                  {summaries.map((collector) => <div key={collector.collector_id ?? 'unknown'} className="flex justify-between gap-3 rounded-md bg-muted/50 px-3 py-2 text-sm">
                    <div>{collector.collector_name || 'Chưa rõ người thu'}<p className="text-xs text-muted-foreground">{collector.invoice_count} hóa đơn · {collector.total_count} lần</p></div><strong className="shrink-0">{money(collector.total_amount)}</strong>
                  </div>)}
                </section>
                <section aria-label="Chi tiết khoản bỏ qua" className="space-y-3">
                  <h3 className="font-semibold">Chi tiết</h3>
                  {data.rows.map((row) => <article key={`${row.collection_id ?? row.payment_id ?? row.invoice_id}-${row.collection_date}`} className="rounded-lg border p-3 text-sm">
                    <div className="flex flex-wrap items-start justify-between gap-2"><div><strong>{row.building_name || 'Chưa rõ tòa'} · {row.room_name || 'Chưa rõ phòng'}</strong><p>{row.invoice_number || row.invoice_id}</p></div><span className="rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-900">{ROUNDING_REASON_LABELS[row.reason]}</span></div>
                    <p className="mt-1 text-xs text-muted-foreground">Kỳ {fmtBillingMonth(row.billing_month)} · Thu {date(row.collection_date)} · {row.collector_name || 'Chưa rõ người thu'}</p>
                    <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
                      <div><dt className="text-xs text-muted-foreground">Khách đưa</dt><dd className="font-medium">{money(row.gross_amount)}</dd></div>
                      <div><dt className="text-xs text-muted-foreground">Thực thối</dt><dd className="font-medium">{money(row.change_amount)}</dd></div>
                      <div><dt className="text-xs text-muted-foreground">Thực thu vào hóa đơn</dt><dd className="font-medium">{money(row.applied_amount)}</dd></div>
                      <div><dt className="text-xs text-muted-foreground">Bỏ qua</dt><dd className="font-semibold text-amber-800">{money(row.rounding_amount)}</dd></div>
                    </dl>
                  </article>)}
                  {data.rows.length === 0 && <p>Trang này không còn giao dịch. Hãy quay về trang trước.</p>}
                </section>
                <p className="text-xs text-muted-foreground">Khoản bỏ qua không phải tiền thực thu. Giao dịch đã hoàn tác hoặc hủy không tính vào tổng. Dữ liệu cũ: chưa đủ dấu vết để xác định lý do hoặc tiền khách đưa, tiền thối; số bỏ qua vẫn lấy từ giao dịch đã lưu.</p>
              </>}
            </div>
            <nav aria-label="Phân trang khoản bỏ qua" className="flex shrink-0 items-center justify-between gap-2 border-t pt-3">
              <Button variant="outline" size="sm" aria-label="Trang trước" disabled={page === 0 || report.isFetching} onClick={() => setPage((value) => Math.max(0, value - 1))}><ChevronLeft className="h-4 w-4" /><span className="hidden sm:inline">Trang trước</span></Button>
              <span className="text-sm" aria-live="polite">Trang {page + 1} / {pages}</span>
              <Button variant="outline" size="sm" aria-label="Trang sau" disabled={page + 1 >= pages || report.isFetching} onClick={() => setPage((value) => value + 1)}><span className="hidden sm:inline">Trang sau</span><ChevronRight className="h-4 w-4" /></Button>
            </nav>
          </>}
        </>}
      </DialogContent>
    </Dialog>
  );
}
