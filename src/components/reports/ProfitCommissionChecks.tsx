import { lazy, Suspense, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useProfitCommissionChecks, type ProfitCommissionScope } from '@/hooks/useProfitCommissionChecks';
import { commissionCheckLabel, commissionMonthLabel, commissionPaymentLabel, type ProfitCommissionCheck } from '@/lib/profitCommissionChecks';
import { formatCurrency } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { LoadingState } from '@/components/loading/LoadingState';

const VoucherDetail = lazy(() => import('@/components/income-expenses/IncomeExpenseDetailDialog'));
const needsReview = (row: ProfitCommissionCheck) => row.state === 'MISSING' || row.state === 'DUPLICATE' || row.state === 'UNVERIFIED'
  || row.vouchers.some(v => v.conflict || v.status === 'unknown' || v.status === 'reversed' || (v.status === 'paid' && !v.postedOn));

function reviewSummary(issues: ProfitCommissionCheck[], missing: number, orphans: number, completeVisibility: boolean) {
  const vouchers = issues.reduce((count, row) => count + row.vouchers.length, orphans);
  const unverified = issues.filter(row => row.state === 'UNVERIFIED' && !row.vouchers.length).length;
  const labels = [];
  if (vouchers) labels.push(`${vouchers} phiếu cần đối chiếu`);
  if (missing) labels.push(`${missing} hợp đồng thiếu phiếu`);
  if (unverified) labels.push(`${unverified} hợp đồng chưa xác minh`);
  if (!completeVisibility) labels.push('Giới hạn quyền xem');
  return labels.join(' · ') || '0 phiếu cần đối chiếu';
}

export function CommissionCheckRows({ rows, onVoucher }: {
  rows: readonly ProfitCommissionCheck[]; onVoucher: (id: string) => void;
}) {
  return <ul className="divide-y">
    {rows.map(row => <li key={row.contract.id} className="py-3 space-y-1.5 text-sm">
      <div className="flex flex-wrap gap-x-3 gap-y-1 font-medium">
        <span>{row.contract.room.building?.name ?? 'Tòa nhà'} · Phòng {row.contract.room.name}</span>
        <Link className="underline underline-offset-2" to={`/contracts/${row.contract.id}`}>{row.contract.contract_number ?? 'Xem hợp đồng'}</Link>
        <span className="font-normal text-muted-foreground">Bắt đầu {row.contract.start_date.split('-').reverse().join('/')}</span>
      </div>
      <p className={needsReview(row) ? 'font-medium text-amber-800' : 'text-muted-foreground'}>{commissionCheckLabel(row)}</p>
      {row.state === 'MISSING' && <p className="text-xs text-amber-800">Có thể đã chi nhưng chưa nhập hoặc chưa gắn phiếu với hợp đồng. Đối chiếu chứng từ trước khi chi thêm.</p>}
      {row.state === 'DUPLICATE' && <p className="text-xs text-amber-800">Đếm các phiếu còn hiệu lực ở mọi kỳ, chưa kể phiếu đã hủy. Kiểm tra từng phiếu trước khi chi tiếp.</p>}
      {row.state === 'UNVERIFIED' && <p className="text-xs text-muted-foreground">Quyền xem, liên kết hoặc phân loại phiếu chưa đủ để xác nhận không thiếu/trùng.</p>}
      {row.reason && <p className="text-xs">Lý do: {row.reason}</p>}
      {row.vouchers.map(v => <div key={v.voucher.id} className="rounded-md border bg-muted/25 px-3 py-2 text-xs space-y-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <button type="button" className="font-semibold underline underline-offset-2" onClick={() => onVoucher(v.voucher.id)}>{v.voucher.code ?? 'Xem phiếu chi'}</button>
          <span>{formatCurrency(v.voucher.total_amount)}</span>
          <span>{commissionPaymentLabel[v.status]}</span>
        </div>
        <p>Kỳ phiếu: {commissionMonthLabel(v.voucher.voucher_date)} · Kỳ phân bổ khai trên phiếu: {v.periods.join(', ')}</p>
        {v.status === 'paid' && <p>Kỳ chi theo ghi sổ: {commissionMonthLabel(v.postedOn)}</p>}
        {v.conflict && <p className="text-amber-800">Cần đối chiếu: phân loại hoặc tòa nhà trên phiếu khác hợp đồng.</p>}
      </div>)}
    </li>)}
  </ul>;
}

/** Shared read-only report block. Details open the same voucher viewer used by Thu/Chi. */
export default function ProfitCommissionChecks(scope: ProfitCommissionScope) {
  const query = useProfitCommissionChecks(scope);
  const [showAll, setShowAll] = useState(false);
  const [voucherId, setVoucherId] = useState<string | null>(null);
  if (scope.enabled === false || !scope.organizationId || !scope.buildingIds.length) return null;
  const rows = query.data?.rows ?? [];
  const issues = rows.filter(needsReview);
  const missing = rows.filter(row => row.state === 'MISSING').length;
  const duplicate = rows.filter(row => row.state === 'DUPLICATE').length;
  const shown = showAll ? rows : issues;
  const summary = query.isError ? 'Chưa tải được kết quả' : query.isPending || !query.data ? 'Đang tải…'
    : reviewSummary(issues, missing, query.data.orphans.length, query.data.completeVisibility);
  return <section aria-label="Đối chiếu hoa hồng hợp đồng" className="rounded-xl border bg-background">
    <Collapsible>
      <h3>
        <CollapsibleTrigger className="group flex min-h-11 w-full items-center gap-2 rounded-xl px-3 py-2 text-left hover:bg-muted/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring sm:px-4">
          <span className="flex flex-1 flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <span className="text-sm font-semibold">Hoa hồng theo hợp đồng{scope.contractId ? '' : ` bắt đầu kỳ ${commissionMonthLabel(scope.month)}`}</span>
            <span className="text-xs text-muted-foreground">{summary}</span>
          </span>
          <ChevronDown aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground group-data-[state=open]:rotate-180" />
        </CollapsibleTrigger>
      </h3>
      <CollapsibleContent className="space-y-2 border-t p-3 sm:px-4">
        <div className="flex justify-end">
          <Button type="button" size="sm" variant="ghost" disabled={query.isFetching} onClick={() => void query.refetch()}>Đối chiếu lại</Button>
        </div>
        {query.isError ? <div role="alert" className="text-sm text-destructive">Chưa tải đủ dữ liệu đối chiếu hoa hồng. Chưa thể kết luận thiếu hoặc trùng phiếu.</div>
          : query.isPending ? <LoadingState label="đối chiếu hoa hồng" variant="lines" rows={2} /> : <>
            {!query.data?.completeVisibility && <p role="alert" className="text-xs text-amber-800">Chưa đủ quyền đối chiếu toàn bộ hợp đồng và phiếu của công ty. Danh sách chỉ gồm dữ liệu được phép xem.</p>}
            {query.data?.postingReadFailed && <p role="alert" className="text-xs text-amber-800">Chưa tải được ngày ghi sổ của một số phiếu. Kỳ chi tương ứng chưa xác minh.</p>}
            {query.isFetching && <p role="status" className="text-xs text-muted-foreground">Đang cập nhật kết quả đối chiếu…</p>}
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span>{rows.length} hợp đồng{query.data?.completeVisibility ? '' : ' đọc được'}</span>
              {missing > 0 && <span className="rounded bg-amber-100 px-2 py-1 text-amber-900">{missing} chưa có phiếu</span>}
              {duplicate > 0 && <span className="rounded bg-red-100 px-2 py-1 text-red-900">{duplicate} có nhiều phiếu</span>}
              {rows.length > 0 && <button type="button" className="inline-flex items-center gap-1 underline" aria-expanded={showAll}
                onClick={() => setShowAll(value => !value)}>{showAll ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                {showAll ? 'Chỉ xem cảnh báo' : 'Xem từng hợp đồng và kỳ phiếu'}</button>}
            </div>
            {rows.length === 0 && query.data?.completeVisibility && <p className="text-xs text-muted-foreground">Không có hợp đồng bắt đầu trong kỳ và phạm vi đang chọn.</p>}
            <CommissionCheckRows rows={shown} onVoucher={setVoucherId} />
            {(query.data?.orphans.length ?? 0) > 0 && <div role="alert" className="rounded-md border border-amber-300 p-2 text-xs text-amber-900">
              <p className="font-medium">Có phiếu hoa hồng của các phòng này chưa gắn hợp đồng — cần đối chiếu trước khi chi thêm:</p>
              {query.data?.orphans.map(v => <button type="button" key={v.id} className="mr-3 mt-1 underline" onClick={() => setVoucherId(v.id)}>
                {v.code ?? 'Xem phiếu'} · kỳ {commissionMonthLabel(v.voucher_date)} · {formatCurrency(v.total_amount)}</button>)}
            </div>}
            <p className="text-xs text-muted-foreground">Đối chiếu hoa hồng môi giới trên mọi kỳ theo đúng hợp đồng; thưởng Sale là khoản riêng. Kỳ phân bổ khai trên phiếu có thể khác kỳ đã chốt lợi nhuận. Phần đối chiếu không cộng thêm vào tổng báo cáo.</p>
          </>}
      </CollapsibleContent>
    </Collapsible>
    {voucherId && <Suspense fallback={<LoadingState label="chi tiết phiếu" variant="lines" rows={2} />}>
      <VoucherDetail open voucher={null} voucherId={voucherId} organizationIdHint={scope.organizationId} onOpenChange={open => { if (!open) setVoucherId(null); }} />
    </Suspense>}
  </section>;
}
