import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
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
  BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend, CartesianGrid,
} from "recharts";
import { TrendingUp, Wallet, HandCoins, Scale, Plus } from "lucide-react";
import { formatCurrency } from "@/lib/utils";
import { StatCard } from "./StatCard";
import { colorAt, currentYear } from "./shareholderUtils";
import { useShareholders } from "@/hooks/useShareholders";
import { useBuildings } from "@/hooks/useBuildings";
import {
  useProfitMonthly,
  useProfitAllocations,
  useShareholderDistributions,
  computeShareholderSummary,
} from "@/hooks/useShareholderProfit";
import ProfitDistributeDialog from "./ProfitDistributeDialog";

export default function ProfitOverviewTab() {
  const [year, setYear] = useState(currentYear());
  const [distOpen, setDistOpen] = useState(false);
  const [distShareholder, setDistShareholder] = useState<string | null>(null);

  const { data: shareholders = [] } = useShareholders();
  const { data: buildings = [] } = useBuildings();
  const { data: profitMonthly = [] } = useProfitMonthly();
  const { data: allocations = [] } = useProfitAllocations();
  const { data: distributions = [] } = useShareholderDistributions();

  const buildingName = (id: string) => buildings.find((b: any) => b.id === id)?.name ?? "—";

  // ---- Year-scoped profit_monthly (đã chốt) ----
  const pmYear = useMemo(
    () => profitMonthly.filter((p) => p.status === "LOCKED" && p.period_month.startsWith(String(year))),
    [profitMonthly, year]
  );

  const buildingIdsInYear = useMemo(
    () => Array.from(new Set(pmYear.map((p) => p.building_id))),
    [pmYear]
  );

  const cell = (bid: string, m: number) =>
    pmYear.find((p) => p.building_id === bid && Number(p.period_month.slice(5, 7)) === m)?.adjusted_profit;

  // ---- Charts ----
  const monthlyChart = useMemo(
    () =>
      Array.from({ length: 12 }, (_, i) => {
        const m = i + 1;
        const profit = pmYear
          .filter((p) => Number(p.period_month.slice(5, 7)) === m)
          .reduce((s, p) => s + p.adjusted_profit, 0);
        return { month: `T${m}`, profit };
      }),
    [pmYear]
  );

  const byBuildingChart = useMemo(
    () =>
      buildingIdsInYear
        .map((bid) => ({
          name: buildingName(bid),
          value: pmYear.filter((p) => p.building_id === bid).reduce((s, p) => s + p.adjusted_profit, 0),
        }))
        .filter((x) => x.value !== 0),
    [buildingIdsInYear, pmYear]
  );

  // ---- Shareholder summary (luỹ kế) ----
  const summary = useMemo(
    () => computeShareholderSummary(shareholders.map((s) => s.id), allocations, distributions),
    [shareholders, allocations, distributions]
  );

  const totals = useMemo(() => {
    const lockedProfit = profitMonthly
      .filter((p) => p.status === "LOCKED")
      .reduce((s, p) => s + p.adjusted_profit, 0);
    const accrued = allocations.reduce((s, a) => s + a.amount, 0);
    const paid = distributions.reduce((s, d) => s + d.total_amount, 0);
    return { lockedProfit, accrued, paid, remaining: accrued - paid };
  }, [profitMonthly, allocations, distributions]);

  const remainingChart = useMemo(
    () =>
      shareholders
        .map((s) => ({ name: s.name, value: summary[s.id]?.remaining ?? 0 }))
        .filter((x) => x.value !== 0),
    [shareholders, summary]
  );

  const years = [currentYear() + 1, currentYear(), currentYear() - 1, currentYear() - 2];

  return (
    <div className="space-y-4">
      {/* KPI */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="Tổng LN đã chốt (luỹ kế)" value={formatCurrency(totals.lockedProfit)} icon={TrendingUp} tone="blue" />
        <StatCard label="Tổng được chia cổ đông" value={formatCurrency(totals.accrued)} icon={Wallet} tone="green" />
        <StatCard label="Đã ứng / đã chia" value={formatCurrency(totals.paid)} icon={HandCoins} tone="amber" />
        <StatCard label="Còn phải trả" value={formatCurrency(totals.remaining)} icon={Scale} tone={totals.remaining >= 0 ? "default" : "red"} />
      </div>

      <div className="flex items-center gap-2">
        <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
          <SelectTrigger className="w-[120px]"><SelectValue /></SelectTrigger>
          <SelectContent>{years.map((y) => <SelectItem key={y} value={String(y)}>Năm {y}</SelectItem>)}</SelectContent>
        </Select>
        <Button className="ml-auto" onClick={() => { setDistShareholder(null); setDistOpen(true); }}>
          <Plus className="h-4 w-4 mr-2" /> Chi lợi nhuận
        </Button>
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Lợi nhuận theo tháng — {year}</CardTitle></CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={monthlyChart}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="month" tick={{ fontSize: 12 }} />
                <YAxis tick={{ fontSize: 12 }} tickFormatter={(v) => `${(v / 1_000_000).toFixed(0)}M`} />
                <Tooltip formatter={(v: number) => formatCurrency(v)} />
                <Bar dataKey="profit" fill="#3b82f6" name="Lợi nhuận" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Cơ cấu LN theo nhà — {year}</CardTitle></CardHeader>
          <CardContent>
            {byBuildingChart.length === 0 ? (
              <div className="h-[260px] grid place-items-center text-muted-foreground text-sm">Chưa có dữ liệu</div>
            ) : (
              <ResponsiveContainer width="100%" height={260}>
                <PieChart>
                  <Pie data={byBuildingChart} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={90} label={(e: any) => e.name}>
                    {byBuildingChart.map((_, i) => <Cell key={i} fill={colorAt(i)} />)}
                  </Pie>
                  <Tooltip formatter={(v: number) => formatCurrency(v)} />
                </PieChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Ma trận Nhà × Tháng */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Bảng lợi nhuận Nhà × Tháng — {year}</CardTitle></CardHeader>
        <CardContent>
          {buildingIdsInYear.length === 0 ? (
            <p className="text-sm text-muted-foreground">Chưa chốt lợi nhuận tháng nào trong năm {year}.</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="sticky left-0 bg-background z-10">Tháng</TableHead>
                    {buildingIdsInYear.map((bid) => (
                      <TableHead key={bid} className="text-right min-w-[110px]">{buildingName(bid)}</TableHead>
                    ))}
                    <TableHead className="text-right font-semibold">Tổng LN</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => {
                    const rowTotal = buildingIdsInYear.reduce((s, bid) => s + (cell(bid, m) ?? 0), 0);
                    if (rowTotal === 0 && !buildingIdsInYear.some((bid) => cell(bid, m) != null)) return null;
                    return (
                      <TableRow key={m}>
                        <TableCell className="font-medium sticky left-0 bg-background z-10">T{m}</TableCell>
                        {buildingIdsInYear.map((bid) => {
                          const v = cell(bid, m);
                          return (
                            <TableCell key={bid} className="text-right tabular-nums">
                              {v == null ? <span className="text-muted-foreground">—</span> : formatCurrency(v)}
                            </TableCell>
                          );
                        })}
                        <TableCell className="text-right font-semibold tabular-nums">{formatCurrency(rowTotal)}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Theo cổ đông */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Theo cổ đông (luỹ kế)</CardTitle></CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Cổ đông</TableHead>
                    <TableHead className="text-right">Được chia</TableHead>
                    <TableHead className="text-right">Đã ứng</TableHead>
                    <TableHead className="text-right">Còn lại</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {shareholders.length === 0 && (
                    <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground">Chưa có cổ đông</TableCell></TableRow>
                  )}
                  {shareholders.map((s) => {
                    const r = summary[s.id] ?? { accrued: 0, paid: 0, remaining: 0 };
                    return (
                      <TableRow key={s.id}>
                        <TableCell className="font-medium">{s.name}</TableCell>
                        <TableCell className="text-right tabular-nums text-emerald-600">{formatCurrency(r.accrued)}</TableCell>
                        <TableCell className="text-right tabular-nums text-amber-600">{formatCurrency(r.paid)}</TableCell>
                        <TableCell className={`text-right tabular-nums font-semibold ${r.remaining < 0 ? "text-red-600" : ""}`}>{formatCurrency(r.remaining)}</TableCell>
                        <TableCell className="text-right">
                          <Button variant="outline" size="sm" onClick={() => { setDistShareholder(s.id); setDistOpen(true); }}>Chi</Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Còn lại theo cổ đông</CardTitle></CardHeader>
          <CardContent>
            {remainingChart.length === 0 ? (
              <div className="h-[260px] grid place-items-center text-muted-foreground text-sm">Chưa có dữ liệu</div>
            ) : (
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={remainingChart} layout="vertical">
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis type="number" tick={{ fontSize: 12 }} tickFormatter={(v) => `${(v / 1_000_000).toFixed(0)}M`} />
                  <YAxis type="category" dataKey="name" tick={{ fontSize: 12 }} width={80} />
                  <Tooltip formatter={(v: number) => formatCurrency(v)} />
                  <Bar dataKey="value" fill="#10b981" name="Còn lại" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>

      <ProfitDistributeDialog
        open={distOpen}
        onOpenChange={setDistOpen}
        shareholders={shareholders}
        defaultShareholderId={distShareholder}
      />
    </div>
  );
}
