import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CurrencyInput } from "@/components/ui/currency-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Lock, Unlock } from "lucide-react";
import { formatCurrency } from "@/lib/utils";
import {
  useMonthlyBuildingProfit,
  useProfitMonthly,
  useLockProfitMonth,
  useUnlockProfitMonth,
} from "@/hooks/useShareholderProfit";
import { useShareholders, useBuildingShareholders } from "@/hooks/useShareholders";
import {
  periodOf,
  monthDateRange,
  periodToLabel,
  currentYear,
} from "./shareholderUtils";

export default function ProfitLockTab() {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const period = periodOf(year, month);
  const { start, end } = monthDateRange(period);

  const { data: rpc = [], isLoading } = useMonthlyBuildingProfit(start, end);
  const { data: profitMonthly = [] } = useProfitMonthly();
  const { data: shareholders = [] } = useShareholders();
  const { data: shares = [] } = useBuildingShareholders();
  const lockMut = useLockProfitMonth();
  const unlockMut = useUnlockProfitMonth();

  const lockedByBuilding = useMemo(() => {
    const m = new Map<string, { id: string; status: string; adjusted_profit: number }>();
    for (const p of profitMonthly) {
      if (p.period_month === period) m.set(p.building_id, p);
    }
    return m;
  }, [profitMonthly, period]);

  const [adjusted, setAdjusted] = useState<Record<string, number>>({});
  useEffect(() => {
    const next: Record<string, number> = {};
    for (const r of rpc) {
      const locked = lockedByBuilding.get(r.building_id);
      next[r.building_id] = locked ? locked.adjusted_profit : r.net_profit;
    }
    setAdjusted(next);
  }, [rpc, lockedByBuilding]);

  const bsMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of shares) m.set(`${s.building_id}:${s.shareholder_id}`, s.percent);
    return m;
  }, [shares]);

  const preview = useMemo(() => {
    return shareholders
      .map((s) => {
        let total = 0;
        for (const r of rpc) {
          const pct = bsMap.get(`${r.building_id}:${s.id}`) ?? 0;
          total += ((adjusted[r.building_id] ?? r.net_profit) * pct) / 100;
        }
        return { name: s.name, total: Math.round(total) };
      })
      .filter((x) => x.total !== 0);
  }, [shareholders, rpc, bsMap, adjusted]);

  const handleLock = async () => {
    await lockMut.mutateAsync({
      period_month: period,
      rows: rpc.map((r) => ({
        building_id: r.building_id,
        computed_profit: r.net_profit,
        adjusted_profit: adjusted[r.building_id] ?? r.net_profit,
      })),
    });
  };

  const years = [currentYear() + 1, currentYear(), currentYear() - 1, currentYear() - 2];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={String(month)} onValueChange={(v) => setMonth(Number(v))}>
          <SelectTrigger className="w-[120px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
              <SelectItem key={m} value={String(m)}>Tháng {m}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
          <SelectTrigger className="w-[110px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            {years.map((y) => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}
          </SelectContent>
        </Select>
        <Button className="ml-auto" onClick={handleLock} disabled={lockMut.isPending || rpc.length === 0}>
          <Lock className="h-4 w-4 mr-2" />
          {lockMut.isPending ? "Đang chốt..." : `Chốt tháng ${periodToLabel(period)}`}
        </Button>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Lợi nhuận theo nhà — {periodToLabel(period)}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nhà</TableHead>
                  <TableHead className="text-right">Doanh thu</TableHead>
                  <TableHead className="text-right">Chi phí</TableHead>
                  <TableHead className="text-right">LN tự tính</TableHead>
                  <TableHead className="text-right">LN sau điều chỉnh</TableHead>
                  <TableHead className="text-center">Trạng thái</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading && (
                  <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground">Đang tải...</TableCell></TableRow>
                )}
                {!isLoading && rpc.length === 0 && (
                  <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground">Chưa có dữ liệu thu/chi tháng này</TableCell></TableRow>
                )}
                {rpc.map((r) => {
                  const locked = lockedByBuilding.get(r.building_id);
                  return (
                    <TableRow key={r.building_id}>
                      <TableCell className="font-medium">{r.building_name}</TableCell>
                      <TableCell className="text-right tabular-nums text-emerald-600">{formatCurrency(r.total_income)}</TableCell>
                      <TableCell className="text-right tabular-nums text-red-600">{formatCurrency(r.total_expense)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatCurrency(r.net_profit)}</TableCell>
                      <TableCell className="text-right w-[160px]">
                        <CurrencyInput
                          value={adjusted[r.building_id] ?? r.net_profit}
                          onChange={(v) => setAdjusted((p) => ({ ...p, [r.building_id]: v }))}
                          suffix={false}
                          className="text-right"
                        />
                      </TableCell>
                      <TableCell className="text-center">
                        {locked?.status === "LOCKED" ? (
                          <div className="flex items-center justify-center gap-1">
                            <Badge className="bg-emerald-600">Đã chốt</Badge>
                            <button
                              type="button"
                              title="Mở khoá"
                              className="text-muted-foreground hover:text-red-600"
                              onClick={() => unlockMut.mutate(locked.id)}
                            >
                              <Unlock className="h-4 w-4" />
                            </button>
                          </div>
                        ) : (
                          <Badge variant="outline">Nháp</Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {preview.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Xem trước chia cho cổ đông (theo tỷ lệ hiện tại)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
              {preview.map((p) => (
                <div key={p.name} className="rounded-lg border p-3">
                  <p className="text-xs text-muted-foreground truncate">{p.name}</p>
                  <p className="text-base font-semibold tabular-nums">{formatCurrency(p.total)}</p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
