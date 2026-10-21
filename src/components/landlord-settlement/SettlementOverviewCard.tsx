// Tổng quyết toán từ tháng bắt đầu áp dụng: từng tháng ai trả ai bao nhiêu, hai bên
// đã trả nhau bao nhiêu, và số còn lại. Mọi tổng do server cộng.
import { Ban } from 'lucide-react';
import { badgeVariants } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn, formatVND } from '@/lib/utils';
import {
  NET_DIRECTION_LABEL,
  PAYMENT_DIRECTION_LABEL,
  describeNet,
  monthKey,
  monthLabel,
  type SettlementOverview,
  type SettlementPayment,
} from '@/lib/landlordSettlement';

function NetText({ value, className = '' }: { value: number; className?: string }) {
  const net = describeNet(value);
  if (net.direction === 'EVEN') return <span className={`text-muted-foreground ${className}`}>0 đ</span>;
  return (
    <span className={`tabular-nums ${className}`}>
      <span className={net.direction === 'LANDLORD_PAYS' ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-400'}>
        {net.direction === 'LANDLORD_PAYS' ? 'Chủ nhà trả ' : 'Quản lý trả '}
      </span>
      {formatVND(net.amount)}
    </span>
  );
}

const fmtDay = (iso: string) => {
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
};

/** Nhãn trạng thái tháng — <span> để đặt được trong nút (thẻ tháng trên điện thoại). */
function MonthStatus({ month }: { month: SettlementOverview['months'][number] }) {
  if (month.status === 'CLOSED' && month.is_stale) {
    return <span className={badgeVariants({ variant: 'destructive' })}>Đổi sau khi chốt</span>;
  }
  if (month.status === 'CLOSED') {
    return <span className={cn(badgeVariants(), 'bg-emerald-600 hover:bg-emerald-600')}>Đã chốt</span>;
  }
  return <span className={badgeVariants({ variant: 'secondary' })}>{month.is_current_month ? 'Đang chạy' : 'Tạm tính'}</span>;
}

export function SettlementOverviewCard({
  overview,
  selectedMonth,
  onSelectMonth,
  onVoidPayment,
}: {
  overview: SettlementOverview;
  /** 'YYYY-MM' */
  selectedMonth: string | null;
  onSelectMonth?: (month: string) => void;
  /** Chỉ màn quản trị truyền vào. */
  onVoidPayment?: (payment: SettlementPayment) => void;
}) {
  const t = overview.totals;
  const balance = describeNet(t.balance_closed);
  const balanceAll = describeNet(t.balance_with_open);
  const hasOpen = overview.months.some((m) => m.status === 'OPEN');

  return (
    <Card data-testid="settlement-overview">
      <CardHeader>
        <CardTitle className="text-base">Tổng quyết toán</CardTitle>
        <CardDescription>
          Từ {monthLabel(overview.effective_from).toLowerCase()} · số dương là chủ nhà trả quản lý, số âm là quản lý trả lại chủ nhà.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="rounded-lg border-2 border-primary/30 bg-primary/5 p-3" data-testid="settlement-balance">
            <p className="text-xs text-muted-foreground">Còn lại (các tháng đã chốt, trừ phần đã trả)</p>
            <p className="mt-1 font-semibold">{NET_DIRECTION_LABEL[balance.direction]}</p>
            <p className="text-xl font-bold tabular-nums">{formatVND(balance.amount)}</p>
          </div>
          <div className="rounded-lg border p-3">
            <p className="text-xs text-muted-foreground">Nếu tính cả tháng tạm tính</p>
            <p className="mt-1 font-semibold">{NET_DIRECTION_LABEL[balanceAll.direction]}</p>
            <p className="text-xl font-bold tabular-nums">{formatVND(balanceAll.amount)}</p>
            {!hasOpen && <p className="text-[11px] text-muted-foreground">Mọi tháng đều đã chốt.</p>}
          </div>
        </div>

        {/* Điện thoại (chủ nhà mở link): mỗi tháng một thẻ, không cuộn ngang. */}
        <div className="divide-y rounded-lg border sm:hidden">
          {[...overview.months].reverse().map((m) => {
            const key = monthKey(m.period_month);
            return (
              <button
                key={key}
                type="button"
                disabled={!onSelectMonth}
                onClick={onSelectMonth ? () => onSelectMonth(key) : undefined}
                className={`block w-full px-3 py-2 text-left text-sm ${key === selectedMonth ? 'bg-primary/5' : ''}`}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="font-medium">{monthLabel(m.period_month)}</span>
                  <MonthStatus month={m} />
                </span>
                <span className="mt-1 flex justify-between gap-2 text-xs text-muted-foreground">
                  <span>Lợi nhuận {formatVND(m.profit)}</span>
                  <span>Phần quản lý {formatVND(m.manager_share)}</span>
                </span>
                <span className="mt-0.5 flex justify-end"><NetText value={m.landlord_owes_manager} className="font-medium" /></span>
              </button>
            );
          })}
        </div>

        <div className="hidden overflow-x-auto rounded-lg border sm:block">
          <table className="w-full min-w-[600px] text-sm [&_td]:whitespace-nowrap">
            <thead className="bg-muted/50 text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Tháng</th>
                <th className="px-3 py-2 text-right font-medium">Lợi nhuận</th>
                <th className="px-3 py-2 text-right font-medium">Phần quản lý</th>
                <th className="px-3 py-2 text-right font-medium">Quyết toán tháng</th>
                <th className="px-3 py-2 text-left font-medium">Trạng thái</th>
              </tr>
            </thead>
            <tbody>
              {[...overview.months].reverse().map((m) => {
                const key = monthKey(m.period_month);
                const selected = key === selectedMonth;
                return (
                  <tr
                    key={key}
                    className={`border-t ${onSelectMonth ? 'cursor-pointer hover:bg-muted/40' : ''} ${selected ? 'bg-primary/5' : ''}`}
                    onClick={onSelectMonth ? () => onSelectMonth(key) : undefined}
                  >
                    <td className="px-3 py-2 font-medium">{monthLabel(m.period_month)}</td>
                    <td className={`px-3 py-2 text-right tabular-nums ${m.profit < 0 ? 'text-destructive' : ''}`}>{formatVND(m.profit)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatVND(m.manager_share)}</td>
                    <td className="px-3 py-2 text-right"><NetText value={m.landlord_owes_manager} /></td>
                    <td className="px-3 py-2">
                      <MonthStatus month={m} />
                      {m.pending_count > 0 && <span className="ml-1 text-xs text-amber-700 dark:text-amber-400">{m.pending_count} phiếu chờ</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div>
          <div className="mb-2 flex flex-col gap-0.5 sm:flex-row sm:items-center sm:justify-between sm:gap-2">
            <p className="text-sm font-medium">Hai bên đã trả nhau</p>
            <p className="text-xs text-muted-foreground">
              Chủ nhà đã trả {formatVND(t.paid_by_landlord)} · Quản lý đã trả {formatVND(t.paid_by_manager)}
            </p>
          </div>
          {overview.payments.length === 0 ? (
            <p className="rounded-md border border-dashed p-3 text-center text-sm text-muted-foreground">Chưa ghi nhận khoản thanh toán nào.</p>
          ) : (
            <div className="divide-y rounded-lg border">
              {overview.payments.map((p, i) => (
                <div key={p.id ?? `${p.paid_on}-${i}`} className={`flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm ${p.voided ? 'opacity-60' : ''}`}>
                  <div className="min-w-0">
                    <p className={p.voided ? 'line-through' : ''}>
                      {fmtDay(p.paid_on)} · {PAYMENT_DIRECTION_LABEL[p.direction]}
                    </p>
                    {(p.note || p.voided) && (
                      <p className="text-xs text-muted-foreground">
                        {p.note}{p.voided ? ` · Đã huỷ: ${p.void_reason ?? ''}` : ''}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`font-medium tabular-nums ${p.voided ? 'line-through' : ''}`}>{formatVND(p.amount)}</span>
                    {onVoidPayment && !p.voided && p.id && (
                      <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-muted-foreground" onClick={() => onVoidPayment(p)}>
                        <Ban className="mr-1 h-3.5 w-3.5" />Huỷ
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
