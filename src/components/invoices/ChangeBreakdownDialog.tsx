import { useMemo } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { useChangeBreakdown } from '@/hooks/useStatBreakdowns';
import type { InvoiceStatisticsFilters } from '@/hooks/useInvoices';
import { RotateCcw } from 'lucide-react';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  filters?: InvoiceStatisticsFilters;
}

const fmtVND = (n: number) =>
  new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(n || 0);

const fmtMonth = (ym: string) => {
  const [y, m] = (ym || '').split('-');
  return y && m ? `Th${Number(m)}/${y}` : ym || '—';
};

const fmtDay = (iso?: string | null) => {
  if (!iso) return '—';
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  return y && m && d ? `${d}/${m}/${y}` : '—';
};

/** Modal thống kê TIỀN THỐI theo sổ quỹ (sổ "Thối") × kỳ hoá đơn. */
const ChangeBreakdownDialog = ({ open, onOpenChange, filters }: Props) => {
  const { data: rows = [], isLoading } = useChangeBreakdown(filters, open);

  // Gộp theo sổ quỹ → từng kỳ (số phiếu, tổng) + subtotal mỗi sổ.
  const groups = useMemo(() => {
    const byAcc = new Map<
      string,
      { account: string; periods: Map<string, { count: number; total: number }>; total: number }
    >();
    for (const r of rows) {
      const a =
        byAcc.get(r.account_name) ??
        { account: r.account_name, periods: new Map(), total: 0 };
      const p = a.periods.get(r.billing_month) ?? { count: 0, total: 0 };
      p.count += 1;
      p.total += r.change_amount;
      a.periods.set(r.billing_month, p);
      a.total += r.change_amount;
      byAcc.set(r.account_name, a);
    }
    return [...byAcc.values()]
      .map((a) => ({
        ...a,
        periodList: [...a.periods.entries()]
          .map(([ky, v]) => ({ ky, ...v }))
          .sort((x, y) => x.ky.localeCompare(y.ky)),
      }))
      .sort((x, y) => y.total - x.total);
  }, [rows]);

  const grand = useMemo(() => rows.reduce((s, r) => s + r.change_amount, 0), [rows]);
  const grandCount = rows.length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <RotateCcw className="h-5 w-5 text-zinc-500" />
            Tiền thối theo sổ quỹ
          </DialogTitle>
          <DialogDescription>
            Thống kê tiền thối (trả lại khách) theo từng sổ quỹ "Thối" và kỳ hoá đơn, trong phạm vi đang lọc.
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            Không có khoản thối nào trong phạm vi này.
          </p>
        ) : (
          <div className="space-y-4">
            {groups.map((g) => (
              <div key={g.account} className="rounded-lg border overflow-hidden">
                <div className="flex items-center justify-between bg-zinc-50 px-3 py-2">
                  <span className="font-semibold text-sm text-zinc-800">{g.account}</span>
                  <span className="font-bold tabular-nums text-zinc-900">{fmtVND(g.total)}</span>
                </div>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-muted-foreground border-b">
                      <th className="text-left font-medium px-3 py-1.5">Kỳ</th>
                      <th className="text-right font-medium px-3 py-1.5">Số phiếu</th>
                      <th className="text-right font-medium px-3 py-1.5">Tổng thối</th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.periodList.map((p) => (
                      <tr key={p.ky} className="border-b last:border-0">
                        <td className="px-3 py-1.5">{fmtMonth(p.ky)}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{p.count}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{fmtVND(p.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}

            {/* Chi tiết từng phiếu thối */}
            <details className="rounded-lg border">
              <summary className="cursor-pointer select-none px-3 py-2 text-sm font-medium text-zinc-700">
                Chi tiết {grandCount} phiếu thối
              </summary>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-muted-foreground border-y bg-zinc-50/50">
                      <th className="text-left font-medium px-3 py-1.5">Sổ</th>
                      <th className="text-left font-medium px-3 py-1.5">Kỳ</th>
                      <th className="text-left font-medium px-3 py-1.5">Toà / Phòng</th>
                      <th className="text-left font-medium px-3 py-1.5">Ngày</th>
                      <th className="text-right font-medium px-3 py-1.5">Thối</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={`${r.code}-${i}`} className="border-b last:border-0">
                        <td className="px-3 py-1.5">{r.account_name}</td>
                        <td className="px-3 py-1.5">{fmtMonth(r.billing_month)}</td>
                        <td className="px-3 py-1.5">
                          {(r.building_name ?? '—')}{r.room_name ? ` / ${r.room_name}` : ''}
                        </td>
                        <td className="px-3 py-1.5">{fmtDay(r.voucher_date)}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{fmtVND(r.change_amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>

            <div className="flex items-center justify-between rounded-lg bg-zinc-900 px-3 py-2.5 text-white">
              <span className="text-sm font-medium">Tổng tiền thối ({grandCount} phiếu)</span>
              <span className="text-lg font-bold tabular-nums">{fmtVND(grand)}</span>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};

export default ChangeBreakdownDialog;
