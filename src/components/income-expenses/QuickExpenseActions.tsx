import { LoaderCircle, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { IncomeExpenseFilters, IncomeExpenseWithRelations } from '@/hooks/income-expenses/types';
import type { QuickExpenseActions } from '@/hooks/income-expenses/useQuickExpense';
import { formatVND } from '@/lib/utils';

const quickButtonClass = 'shrink-0 rounded-[9px] border-orange-200 bg-orange-50 p-0 text-orange-600 hover:border-orange-300 hover:bg-orange-100 hover:text-orange-700 disabled:opacity-40';

export function QuickExpenseButton({ voucher, quick }: { voucher: IncomeExpenseWithRelations; quick?: QuickExpenseActions }) {
  if (!quick || voucher.type !== 'EXPENSE' || voucher.approval_status !== 'UNAPPROVED') return null;
  const reason = quick.reason(voucher);
  return <span className="inline-flex shrink-0 items-center" onClick={e => e.stopPropagation()} title={reason ?? 'Chi nhanh: duyệt và chi ngay bằng sổ quỹ, chứng từ đã lưu'}>
    <Button type="button" size="icon" variant="outline" className={`h-7 w-7 ${quickButtonClass}`}
      disabled={!!reason || quick.busy || quick.collecting} aria-label="Chi nhanh" aria-busy={quick.activeId === voucher.id}
      onClick={e => { e.stopPropagation(); void quick.run([voucher]); }}>
      {quick.activeId === voucher.id ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Zap className="h-4 w-4" aria-hidden="true" />}
    </Button>
  </span>;
}

export function QuickExpenseFeedback({ quick }: { quick: QuickExpenseActions }) {
  const success = quick.results.filter(r => r.status === 'success').length;
  return <div className="space-y-2 text-sm" aria-live="polite">
    {quick.busy && <p role="status">Đang xử lý {quick.progress.done}/{quick.progress.total} phiếu…</p>}
    {quick.error && <p role="alert" className="text-destructive">{quick.error}</p>}
    {quick.checksError && <Button size="sm" variant="outline" disabled={quick.busy || quick.collecting} onClick={() => void quick.retryChecks()}>Thử lại kiểm tra</Button>}
    {!!quick.results.length && <div className="rounded-md border p-3">
      <p>Đã duyệt và chi: {success} phiếu · Chưa hoàn tất: {quick.results.length - success} phiếu.</p>
      {quick.results.some(r => r.status !== 'success') && <ul className="mt-2 max-h-48 overflow-y-auto space-y-1">
        {quick.results.filter(r => r.status !== 'success').map(r => <li key={r.id}>{r.label}: {r.message}</li>)}
      </ul>}
    </div>}
  </div>;
}

export function QuickExpenseToolbar({ quick, filters, search }: { quick: QuickExpenseActions; filters: IncomeExpenseFilters; search?: string }) {
  return <div className="space-y-2 rounded-lg border bg-white p-3">
    <div className="flex flex-wrap items-center gap-2">
      <span>Đã chọn {quick.selected.length} phiếu · Tổng tiền {formatVND(quick.selected.reduce((sum, v) => sum + v.total_amount, 0))}</span>
      <Button size="icon" variant="outline" className={`h-8 w-8 ${quickButtonClass}`}
        aria-label={`Duyệt và chi nhanh (${quick.selected.length})`} title={`Duyệt và chi nhanh ${quick.selected.length} phiếu đã chọn`}
        disabled={!quick.selected.length || !quick.ready || quick.busy || quick.collecting}
        onClick={() => void quick.run(quick.selected)}>
        {quick.busy ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Zap className="h-4 w-4" aria-hidden="true" />}
      </Button>
      <Button size="sm" variant="outline" disabled={!quick.ready || quick.busy || quick.collecting}
        onClick={() => void quick.selectAll(filters, search)}>{quick.collecting ? 'Đang chọn…' : 'Chọn tất cả phiếu đủ điều kiện theo bộ lọc'}</Button>
      <Button size="sm" variant="ghost" disabled={!quick.selected.length || quick.busy || quick.collecting} onClick={quick.clear}>Bỏ chọn</Button>
    </div>
    <QuickExpenseFeedback quick={quick} />
  </div>;
}
