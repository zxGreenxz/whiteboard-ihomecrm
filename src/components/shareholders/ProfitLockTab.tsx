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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Lock, Unlock, RefreshCw, Briefcase } from "lucide-react";
import { formatCurrency } from "@/lib/utils";
import {
  useMonthlyBuildingProfit,
  useProfitMonthly,
  useLockProfitMonth,
  useUnlockProfitMonth,
  useResyncLockedMonths,
} from "@/hooks/useShareholderProfit";
import { useShareholders, useBuildingShareholders } from "@/hooks/useShareholders";
import { useProfitManagers, useManagerSalaries } from "@/hooks/useProfitManagers";
import { computeManagementSalaries, type SalaryRule } from "@/lib/managementSalary";
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
  const { data: managers = [] } = useProfitManagers();
  const { data: salaryRules = [] } = useManagerSalaries();
  const lockMut = useLockProfitMonth();
  const unlockMut = useUnlockProfitMonth();
  const resyncMut = useResyncLockedMonths();
  // Phân biệt spinner: chốt lại 1 tháng (có variables) vs chốt lại tất cả (undefined).
  const resyncingPeriod = resyncMut.isPending && resyncMut.variables === period;
  const resyncingAll = resyncMut.isPending && !resyncMut.variables;

  // Số tháng đang LOCKED (để hiện nút "Chốt lại theo số mới").
  const lockedMonthCount = useMemo(() => {
    const s = new Set<string>();
    for (const p of profitMonthly) if (p.status === "LOCKED") s.add(p.period_month);
    return s.size;
  }, [profitMonthly]);

  // Tháng đang lọc đã chốt chưa (để hiện nút "Chốt lại tháng MM/YYYY").
  const isPeriodLocked = useMemo(
    () => profitMonthly.some((p) => p.period_month === period && p.status === "LOCKED"),
    [profitMonthly, period]
  );

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

  // Lương điều hành (xem trước, theo LN sau điều chỉnh hiện tại + quy tắc còn hiệu lực).
  const activeMgrIds = useMemo(() => new Set(managers.map((m) => m.id)), [managers]);
  const mgmt = useMemo(() => {
    const buildingBase = rpc.map((r) => ({
      building_id: r.building_id,
      base: adjusted[r.building_id] ?? r.net_profit,
    }));
    const rules: SalaryRule[] = salaryRules
      .filter((r) => r.is_active && activeMgrIds.has(r.manager_id))
      .map((r) => ({
        manager_id: r.manager_id,
        form: r.form,
        basis: r.basis,
        amount: r.amount,
        percent: r.percent,
        building_ids: r.building_ids,
      }));
    return computeManagementSalaries(buildingBase, rules);
  }, [rpc, adjusted, salaryRules, activeMgrIds]);

  const salaryOf = (buildingId: string) => mgmt.perBuilding.get(buildingId) ?? 0;
  const totalSalary = useMemo(
    () => [...mgmt.perBuilding.values()].reduce((s, x) => s + x, 0),
    [mgmt]
  );
  const managerTotals = useMemo(() => {
    const byMgr = new Map<string, number>();
    for (const e of mgmt.perManager) byMgr.set(e.manager_id, (byMgr.get(e.manager_id) ?? 0) + e.amount);
    return managers
      .map((m) => ({ name: m.name, total: byMgr.get(m.id) ?? 0 }))
      .filter((x) => x.total !== 0);
  }, [mgmt, managers]);

  // Cổ đông chia trên distributable = LN sau điều chỉnh − lương điều hành.
  const preview = useMemo(() => {
    return shareholders
      .map((s) => {
        let total = 0;
        for (const r of rpc) {
          const pct = bsMap.get(`${r.building_id}:${s.id}`) ?? 0;
          const base = (adjusted[r.building_id] ?? r.net_profit) - salaryOf(r.building_id);
          total += (base * pct) / 100;
        }
        return { name: s.name, total: Math.round(total) };
      })
      .filter((x) => x.total !== 0);
  }, [shareholders, rpc, bsMap, adjusted, mgmt]);

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
        <div className="ml-auto flex items-center gap-2">
          {isPeriodLocked && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" disabled={resyncMut.isPending}>
                  <RefreshCw className={`h-4 w-4 mr-2 ${resyncingPeriod ? "animate-spin" : ""}`} />
                  {resyncingPeriod ? "Đang chốt lại..." : `Chốt lại tháng ${periodToLabel(period)}`}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Chốt lại tháng {periodToLabel(period)}?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Chỉ cập nhật <strong>riêng tháng {periodToLabel(period)}</strong> theo số dồn tích
                    (accrual) mới nhất — các tháng đã chốt khác giữ nguyên. Giữ nguyên các giá trị
                    "LN sau điều chỉnh" bạn đã sửa tay. Thao tác ghi đè số đã chốt và{" "}
                    <strong>không hoàn tác được</strong>.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Huỷ</AlertDialogCancel>
                  <AlertDialogAction onClick={() => resyncMut.mutate(period)}>
                    Chốt lại tháng này
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
          {lockedMonthCount > 0 && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" disabled={resyncMut.isPending}>
                  <RefreshCw className={`h-4 w-4 mr-2 ${resyncingAll ? "animate-spin" : ""}`} />
                  {resyncingAll ? "Đang chốt lại..." : `Chốt lại ${lockedMonthCount} tháng đã chốt`}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Chốt lại theo số mới (phân bổ)?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Cập nhật {lockedMonthCount} tháng đã chốt sang cách tính dồn tích (accrual) — khớp
                    báo cáo Phân bổ lợi nhuận. Giữ nguyên các giá trị "LN sau điều chỉnh" bạn đã sửa tay.
                    Thao tác ghi đè số đã chốt và <strong>không hoàn tác được</strong>.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Huỷ</AlertDialogCancel>
                  <AlertDialogAction onClick={() => resyncMut.mutate(undefined)}>
                    Chốt lại
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
          <Button onClick={handleLock} disabled={lockMut.isPending || rpc.length === 0}>
            <Lock className="h-4 w-4 mr-2" />
            {lockMut.isPending ? "Đang chốt..." : `Chốt tháng ${periodToLabel(period)}`}
          </Button>
        </div>
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
                  <TableHead className="text-right">Lương điều hành</TableHead>
                  <TableHead className="text-right">LN chia cổ đông</TableHead>
                  <TableHead className="text-center">Trạng thái</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading && (
                  <TableRow><TableCell colSpan={8} className="text-center text-muted-foreground">Đang tải...</TableCell></TableRow>
                )}
                {!isLoading && rpc.length === 0 && (
                  <TableRow><TableCell colSpan={8} className="text-center text-muted-foreground">Chưa có dữ liệu thu/chi tháng này</TableCell></TableRow>
                )}
                {rpc.map((r) => {
                  const locked = lockedByBuilding.get(r.building_id);
                  const salary = salaryOf(r.building_id);
                  const distributable = (adjusted[r.building_id] ?? r.net_profit) - salary;
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
                      <TableCell className="text-right tabular-nums text-orange-600">
                        {salary > 0 ? formatCurrency(salary) : "—"}
                      </TableCell>
                      <TableCell className={`text-right tabular-nums font-medium ${distributable < 0 ? "text-red-600" : ""}`}>
                        {formatCurrency(distributable)}
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

      {managerTotals.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Briefcase className="h-4 w-4 text-orange-600" />
              Lương điều hành tháng này
              <span className="ml-auto text-sm font-semibold text-orange-600">{formatCurrency(totalSalary)}</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
              {managerTotals.map((m) => (
                <div key={m.name} className="rounded-lg border p-3">
                  <p className="text-xs text-muted-foreground truncate">{m.name}</p>
                  <p className="text-base font-semibold tabular-nums text-orange-600">{formatCurrency(m.total)}</p>
                </div>
              ))}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Trừ khỏi LN từng nhà trước khi chia cổ đông. Số chốt được snapshot khi bấm "Chốt tháng".
            </p>
          </CardContent>
        </Card>
      )}

      {preview.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Xem trước chia cho cổ đông (sau khi trừ lương điều hành)</CardTitle>
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
