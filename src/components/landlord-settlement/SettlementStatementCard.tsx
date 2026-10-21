// Bảng quyết toán MỘT tháng của toà vận hành cho chủ nhà — dùng chung cho màn quản
// trị và link chỉ đọc của chủ nhà. Chỉ hiển thị: mọi con số lấy nguyên từ server.
import { AlertTriangle, ArrowRight, CheckCircle2, Clock, Lock } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { formatVND } from '@/lib/utils';
import {
  CLOSE_BLOCKER_LABEL,
  NET_DIRECTION_LABEL,
  describeNet,
  monthLabel,
  type SettlementMonth,
} from '@/lib/landlordSettlement';
import { VoucherBreakdown } from './VoucherBreakdown';

function StatusBadge({ month }: { month: SettlementMonth }) {
  if (month.status === 'CLOSED' && month.is_stale) {
    return <Badge variant="destructive" className="gap-1"><AlertTriangle className="h-3 w-3" />Phiếu đã đổi sau khi chốt</Badge>;
  }
  if (month.status === 'CLOSED') {
    return <Badge className="gap-1 bg-emerald-600 hover:bg-emerald-600"><Lock className="h-3 w-3" />Đã chốt</Badge>;
  }
  if (month.status === 'OPEN') {
    return <Badge variant="secondary" className="gap-1"><Clock className="h-3 w-3" />{month.is_current_month ? 'Tạm tính — tháng đang chạy' : 'Tạm tính — chưa chốt'}</Badge>;
  }
  return <Badge variant="outline">Chưa áp dụng</Badge>;
}

function Kpi({ label, value, hint, tone }: { label: string; value: number; hint?: string; tone?: 'pos' | 'neg' | 'muted' }) {
  const color = tone === 'neg' ? 'text-destructive' : tone === 'pos' ? 'text-emerald-700 dark:text-emerald-400' : 'text-foreground';
  return (
    <div className="rounded-lg border bg-card p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`mt-1 whitespace-nowrap text-base font-semibold tabular-nums sm:text-lg ${color}`}>{formatVND(value)}</p>
      {hint && <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function SettlementStatementCard({ month, mode }: { month: SettlementMonth; mode: 'admin' | 'public' }) {
  const st = month.statement;

  if (month.status === 'NOT_APPLICABLE' || !st) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{monthLabel(month.period_month)}</CardTitle>
          <CardDescription>
            Tháng này chưa thuộc thời gian áp dụng (bắt đầu từ {monthLabel(month.effective_from).toLowerCase()}).
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const t = st.totals;
  const net = describeNet(t.landlord_owes_manager);
  const pct = st.manager_percent.toLocaleString('vi-VN');
  const closedAt = month.closed ? new Date(month.closed.closed_at).toLocaleString('vi-VN') : null;

  return (
    <Card data-testid="settlement-statement">
      <CardHeader className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-base">{monthLabel(month.period_month)}</CardTitle>
          <StatusBadge month={month} />
        </div>
        <CardDescription>
          {month.building_name} · Chủ nhà: {month.landlord_name} · Quản lý nhận {pct}% lợi nhuận tháng (lỗ thì không tính)
          {closedAt && <> · Chốt lúc {closedAt}{month.closed?.closed_by_name ? ` bởi ${month.closed.closed_by_name}` : ''}</>}
        </CardDescription>
        {month.status === 'CLOSED' && month.is_stale && mode === 'admin' && (
          <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm text-destructive">
            Có phiếu của tháng này được sửa/thêm/huỷ sau khi chốt. Số dưới đây là số lúc chốt — mở chốt rồi chốt lại để cập nhật.
          </p>
        )}
        {st.pending.voucher_count > 0 && (
          <p className="flex items-start gap-2 rounded-md border border-amber-400 bg-amber-50 p-2 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              Còn {st.pending.voucher_count} phiếu chờ duyệt (thu {formatVND(st.pending.income)}, chi {formatVND(st.pending.expense)}) — chưa tính vào quyết toán.
            </span>
          </p>
        )}
        {mode === 'admin' && month.status === 'OPEN' && month.close_blockers.length > 0 && (
          <ul className="list-disc pl-5 text-xs text-muted-foreground">
            {month.close_blockers.map((b) => <li key={b}>Chưa chốt được: {CLOSE_BLOCKER_LABEL[b]}</li>)}
          </ul>
        )}
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          <Kpi label="Doanh thu" value={t.revenue} />
          <Kpi label="Chi phí" value={t.expense} />
          <Kpi label="Lợi nhuận" value={t.profit} tone={t.profit < 0 ? 'neg' : 'pos'} />
          <Kpi label={`Phần quản lý (${pct}%)`} value={t.manager_share} hint={t.profit <= 0 ? 'Lỗ hoặc hoà — không tính' : undefined} />
          <Kpi label="Phần chủ nhà" value={t.landlord_share} tone={t.landlord_share < 0 ? 'neg' : undefined} />
        </div>

        <div>
          <p className="mb-2 text-sm font-medium">Ai đang giữ tiền</p>
          <div className="overflow-hidden rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium" />
                  <th className="px-3 py-2 text-right font-medium">Thu (doanh thu)</th>
                  <th className="px-3 py-2 text-right font-medium">Chi (chi phí)</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-t">
                  <td className="px-3 py-2">Sổ chủ nhà</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatVND(t.landlord_collected)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatVND(t.landlord_paid)}</td>
                </tr>
                <tr className="border-t">
                  <td className="px-3 py-2">Sổ quản lý</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatVND(t.manager_collected)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatVND(t.manager_paid)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div className="rounded-lg border-2 border-primary/30 bg-primary/5 p-4" data-testid="settlement-net">
          <p className="mb-2 text-sm font-medium">Quyết toán tháng</p>
          <dl className="space-y-1 text-sm">
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">Phần quản lý ({pct}% lợi nhuận)</dt>
              <dd className="whitespace-nowrap tabular-nums">{formatVND(t.manager_share)}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">+ Quản lý đã chi hộ</dt>
              <dd className="whitespace-nowrap tabular-nums">{formatVND(t.manager_paid)}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">− Quản lý đã thu hộ (tiền lọt vào sổ quản lý)</dt>
              <dd className="whitespace-nowrap tabular-nums">{formatVND(t.manager_collected)}</dd>
            </div>
          </dl>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t pt-3">
            <span className="flex items-center gap-1.5 font-semibold">
              {net.direction === 'EVEN' ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <ArrowRight className="h-4 w-4" />}
              {NET_DIRECTION_LABEL[net.direction]}
            </span>
            <span className="text-xl font-bold tabular-nums">{formatVND(net.amount)}</span>
          </div>
        </div>

        {(st.deposits.received > 0 || st.deposits.paid_out > 0) && (
          <p className="text-xs text-muted-foreground">
            Cọc trong tháng (quản lý giữ, không tính vào quyết toán): thu {formatVND(st.deposits.received)} · chi/cấn cọc {formatVND(st.deposits.paid_out)}.
          </p>
        )}

        <VoucherBreakdown vouchers={st.vouchers} totals={t} />
      </CardContent>
    </Card>
  );
}
